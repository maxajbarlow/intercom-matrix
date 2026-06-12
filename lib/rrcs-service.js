// lib/rrcs-service.js — multi-system intercom model service (read-only RRCS).
//
// Supports several intercom systems (e.g. Studio A, Studio B, Control Room), each with its
// own RRCS controller + optional controller config (.Art/.ash) for key-access.
// Each system keeps an independent cached snapshot, refresh lock, and config, so
// they never interfere and an unreachable controller doesn't affect the others.
//
// Systems are defined in systems.json (or SYSTEMS_FILE), falling back to a single
// system from RRCS_HOST for backward compatibility.

const fs = require('fs');
const path = require('path');
const client = require('./rrcs-client');
const { parseKeyLabels } = require('./art-parser');
const { buildConfMatcher } = require('./name-match');
const { parseTopology, locate } = require('./topology');
const { toText, parsePrintText } = require('./print-parser');
const store = require('./print-store');
const { diffPrints } = require('./print-diff');
const { buildVspModel, loadVspExport } = require('./vsp-model');
const settings = require('./settings');

const MIN_REFRESH_MS = 3000;  // hard floor; the effective interval comes from settings.
// Global RRCS kill-switch + min-refresh interval now live in settings.json
// (seeded from the RRCS_ENABLED env var on first run) so an engineer can flip
// them from the Settings panel without redeploying. The RRCS code stays intact
// but makes no network calls while disabled.
const rrcsOn = () => settings.rrcsEnabled();
const minRefreshMs = () => Math.max(MIN_REFRESH_MS, settings.minRefreshMs());
const extractPorts = (r) => (Array.isArray(r) ? (r.find(Array.isArray) || []) : (r && Array.isArray(r.Ports) ? r.Ports : []));
const listOf = (r) => (Array.isArray(r) ? (r.find(Array.isArray) || []) : (r && Array.isArray(r.ObjectList) ? r.ObjectList : []));

const systems = new Map();   // id -> { def, snapshot, config, lastRaw, fetching, lastFetchStart }
let defaultId = null;
let systemsFilePath = null;  // set when defs came from a file (for persistence)

// ---------- system definitions ----------
function normalizeDef(d) {
  return { id: String(d.id), name: String(d.name || d.id), host: String(d.host || ''), port: Number(d.port) || 8193, configPath: String(d.config || d.configPath || ''), topologyPath: String(d.topology || d.topologyPath || ''), printPath: String(d.print || d.printPath || ''), vspPath: String(d.vsp || d.vspPath || '') };
}
function loadDefs() {
  const file = process.env.SYSTEMS_FILE || path.join(__dirname, '..', 'systems.json');
  if (fs.existsSync(file)) {
    try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(a) && a.length) { systemsFilePath = file; return a.map(normalizeDef); } }
    catch (e) { console.warn(`[systems] bad ${file}: ${e.message}`); }
  }
  if (process.env.RRCS_HOST) return [normalizeDef({ id: 'default', name: process.env.SYSTEM_NAME || 'System', host: process.env.RRCS_HOST, port: process.env.RRCS_PORT, config: process.env.ART_CONFIG })];
  return [];
}

// Persist current system defs back to systems.json (so UI host edits survive a
// restart). No-op when running from RRCS_HOST fallback (no file).
function persistDefs() {
  if (!systemsFilePath) return;
  const arr = [...systems.values()].map((s) => {
    const o = { id: s.def.id, name: s.def.name, host: s.def.host, port: s.def.port, config: s.def.configPath };
    if (s.def.topologyPath) o.topology = s.def.topologyPath;
    if (s.def.printPath) o.print = s.def.printPath;
    if (s.def.vspPath) o.vsp = s.def.vspPath;       // preserve the VSP source across host edits
    return o;
  });
  try { fs.writeFileSync(systemsFilePath, JSON.stringify(arr, null, 2) + '\n'); }
  catch (e) { console.warn(`[systems] persist failed: ${e.message}`); }
}

// Point a system at a (new) controller from the UI. Persisted; the caller
// usually triggers a refresh afterward.
function setSystemHost(id, host, port) {
  const sys = sysOf(id);
  if (!sys) throw new Error('unknown system');
  if (host != null) sys.def.host = String(host).trim();
  if (port) sys.def.port = Number(port) || sys.def.port;
  persistDefs();
  return { id: sys.def.id, host: sys.def.host, port: sys.def.port };
}

// ---------- systems CRUD (engineer-gated at the route layer) ------------------
// A fresh in-memory entry for a system definition (mirrors what init() builds).
function makeSysEntry(def) {
  return { def, snapshot: emptySnapshot(def, 'never fetched'), config: null, topology: null, print: null, vsp: null, lastRaw: null, fetching: null, lastFetchStart: 0, lastError: null, lastErrorAt: null, lastTryAt: null };
}

// Load whatever offline/config sources a def points at (VSP export, key-access
// config, topology tree, persisted-or-seed print). Shared by init() and
// createSystem() so a UI-added system loads its files the same way as a booted
// one. Each load is best-effort and logs (never throws the whole add).
function loadSystemSources(sys) {
  const def = sys.def;
  if (def.vspPath) {
    try {
      const exp = loadVspExport(fs.readFileSync(def.vspPath, 'utf8'));
      sys.vsp = { export: exp, name: path.basename(def.vspPath), loadedAt: exp.generatedAt || new Date().toISOString() };
      rebuild(sys);
      console.log(`[${def.id}] VSP source: ${path.basename(def.vspPath)} (${exp.ports.length} ports, ${exp.targets.length} targets, ${exp.cells.length} cells)`);
    } catch (e) { console.warn(`[${def.id}] VSP load failed: ${e.message}`); }
  }
  if (def.configPath) {
    try { loadConfigBuffer(def.id, fs.readFileSync(def.configPath), path.basename(def.configPath)); console.log(`[${def.id}] key-access config: ${path.basename(def.configPath)}`); }
    catch (e) { console.warn(`[${def.id}] config load failed: ${e.message}`); }
  }
  if (def.topologyPath) {
    try { loadTopologyBuffer(def.id, fs.readFileSync(def.topologyPath, 'utf8'), path.basename(def.topologyPath)); console.log(`[${def.id}] topology: ${path.basename(def.topologyPath)}`); }
    catch (e) { console.warn(`[${def.id}] topology load failed: ${e.message}`); }
  }
  const stored = store.latest(def.id);
  if (stored) {
    try { activateVersion(sys, stored.id); console.log(`[${def.id}] print source: ${stored.name} v${stored.id} (${sys.print.stats.conferences} conferences, ${sys.print.stats.keyAssignments} keys)`); }
    catch (e) { console.warn(`[${def.id}] print load failed: ${e.message}`); }
  } else if (def.printPath) {
    try { const info = loadPrintBuffer(def.id, fs.readFileSync(def.printPath), path.basename(def.printPath)); console.log(`[${def.id}] print source: ${path.basename(def.printPath)} (${info.conferences} conferences, ${info.keyAssignments} keys, imported as v1)`); }
    catch (e) { console.warn(`[${def.id}] print load failed: ${e.message}`); }
  }
}

const SYS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

// Add a new system. `def` accepts { id, name, host, port, config, topology, vsp }.
function createSystem(def) {
  const raw = def || {};
  const id = String(raw.id || '').trim();
  if (!id) throw new Error('id is required');
  if (!SYS_ID_RE.test(id)) throw new Error('id must be alphanumeric (dashes/underscores allowed, max 40 chars)');
  if (systems.has(id)) throw new Error(`system "${id}" already exists`);
  const sys = makeSysEntry(normalizeDef({ ...raw, id, name: raw.name || id }));
  systems.set(id, sys);
  if (!defaultId) defaultId = id;
  loadSystemSources(sys);
  persistDefs();
  return listSystems().find((s) => s.id === id);
}

// Edit an existing system's fields. Renaming the id is NOT allowed (it keys
// stored prints/requests); name/host/port/paths are editable.
function updateSystem(id, patch) {
  const sys = sysOf(id);
  if (!sys || sys.def.id !== id) throw new Error('unknown system');
  const p = patch || {};
  if (p.id != null && String(p.id).trim() !== id) throw new Error('system id cannot be changed once created');
  const d = sys.def;
  if (p.name != null) d.name = String(p.name).trim() || d.name;
  if (p.host != null) d.host = String(p.host).trim();
  if (p.port) d.port = Number(p.port) || d.port;
  // Path edits re-point a source; reload so the change takes effect immediately.
  let reload = false;
  for (const [k, prop] of [['config', 'configPath'], ['topology', 'topologyPath'], ['vsp', 'vspPath']]) {
    if (p[k] != null) { d[prop] = String(p[k]).trim(); reload = true; }
  }
  if (reload) { sys.config = null; sys.topology = null; sys.vsp = null; loadSystemSources(sys); }
  persistDefs();
  return listSystems().find((s) => s.id === id);
}

// Remove a system. If it was the default, the first remaining system becomes
// the new default (or null when none remain).
function deleteSystem(id) {
  if (!systems.has(id)) throw new Error('unknown system');
  systems.delete(id);
  if (defaultId === id) defaultId = systems.keys().next().value || null;
  persistDefs();
  return { id, default: defaultId, systems: listSystems() };
}

// Reorder the systems map to match the given id order (unknown ids ignored,
// missing ids kept in their current relative position at the end).
function reorderSystems(order) {
  const ids = Array.isArray(order) ? order.filter((x) => systems.has(x)) : [];
  const seen = new Set(ids);
  const entries = [...systems.entries()];
  const sorted = [
    ...ids.map((id) => [id, systems.get(id)]),
    ...entries.filter(([id]) => !seen.has(id)),
  ];
  systems.clear();
  for (const [id, sys] of sorted) systems.set(id, sys);
  persistDefs();
  return listSystems();
}

function emptySnapshot(def, error) {
  return {
    ok: false, error: error || null, system: { id: def.id, name: def.name }, host: def.host, port: def.port, fetchedAt: null,
    config: { loaded: false }, topology: { loaded: false, nodes: [] },
    counts: { ports: 0, panels: 0, conferences: 0, groups: 0, memberEdges: 0, keyEdges: 0, cells: 0 },
    conferences: [], groups: [], panels: [], matrix: { rows: [], cols: [], cells: [] },
  };
}
function configInfo(cfg) {
  return cfg ? { loaded: true, name: cfg.name, loadedAt: cfg.loadedAt, panels: cfg.stats.panels, keys: cfg.stats.labelledKeys } : { loaded: false };
}
function topologyInfo(t) {
  return t ? { loaded: true, name: t.name, loadedAt: t.loadedAt, nodes: t.stats.nodes, cards: t.stats.cards, ports: t.stats.ports } : { loaded: false };
}

// ---------- model build (member + key-access, 2-wire merge) ----------
function buildModel(def, cfg, topo, portsRaw, confsRaw, groupsRaw) {
  const ports = portsRaw.map((x) => ({
    addr: `${x.Net}.${x.Node}.${x.Port}`, objectId: Number(x.ObjectID) >>> 0,
    name: String(x.LongName || x.Label || `${x.Net}.${x.Node}.${x.Port}`),
    label: String(x.Label || ''), type: String(x.PortType || ''),
    isPanel: Number(x.PortExType) > 3 && Number(x.KeyCount) > 0,
  }));
  // 2-wire ports appear as two objects (input + output) at the same address;
  // merge per address, preferring the operator-given name over an auto "In./Out.".
  const portsAtAddr = new Map();
  for (const x of ports) { const l = portsAtAddr.get(x.addr) || []; l.push(x); portsAtAddr.set(x.addr, l); }
  const isAutoName = (n) => /^\s*(in|out)\.\s/i.test(n || '');
  function bestName(list) {
    if (list.length === 1) return list[0].name;
    const human = list.filter((p) => !isAutoName(p.name));
    return (human.length ? human : list).slice().sort((a, b) => (b.name || '').length - (a.name || '').length)[0].name;
  }
  const addrInfo = new Map();
  for (const [a, list] of portsAtAddr) {
    addrInfo.set(a, { name: bestName(list), type: (list.find((p) => p.isPanel) || list[0]).type, isPanel: list.some((p) => p.isPanel), twoWire: list.length > 1 });
  }
  const addrByOid = new Map(ports.map((x) => [x.objectId, x.addr]));
  const nameOf = (a) => (addrInfo.get(a) ? addrInfo.get(a).name : a);
  const typeOf = (a) => (addrInfo.get(a) ? addrInfo.get(a).type : '');
  const twoWireOf = (a) => !!(addrInfo.get(a) && addrInfo.get(a).twoWire);

  function mkDest(c, kind) {
    const directed = kind === 'conference';
    const members = (c.MemberList || []).map((m) => {
      const addr = `1.${m.Node}.${m.Port}`;
      return { addr, name: nameOf(addr), type: typeOf(addr), talk: directed ? !!m.Talk : true, listen: directed ? !!m.Listen : true };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { kind, label: String(c.Label || ''), name: String(c.LongName || c.Label || ''), objectId: Number(c.ObjectID) >>> 0, members };
  }
  const conferences = confsRaw.map((c) => mkDest(c, 'conference')).sort((a, b) => a.name.localeCompare(b.name));
  const groups = groupsRaw.map((c) => mkDest(c, 'group')).sort((a, b) => a.name.localeCompare(b.name));
  const dests = [...conferences, ...groups];

  const edges = new Map();
  function edge(addr, di) {
    let m = edges.get(addr); if (!m) { m = new Map(); edges.set(addr, m); }
    let e = m.get(di); if (!e) { e = { member: false, talk: false, listen: false, key: false }; m.set(di, e); }
    return e;
  }
  let memberEdges = 0;
  dests.forEach((d, di) => { for (const mem of d.members) { const e = edge(mem.addr, di); e.member = true; e.talk = e.talk || mem.talk; e.listen = e.listen || mem.listen; memberEdges++; } });

  let keyEdges = 0, keyUnresolved = 0;
  if (cfg) {
    const matcher = buildConfMatcher(dests.map((d, idx) => ({ name: d.name, label: d.label, kind: d.kind, idx })));
    for (const [oid, labels] of cfg.byObjectId) {
      const addr = addrByOid.get(oid); if (!addr) continue;
      for (const label of labels) {
        const hit = matcher.resolve(label);
        if (!hit) { keyUnresolved++; continue; }
        const e = edge(addr, hit.idx);
        if (!e.member) { if (!e.key) keyEdges++; e.key = true; }
      }
    }
  }

  const panels = [...edges.keys()].map((addr) => {
    const m = edges.get(addr);
    const memberships = [...m.entries()].map(([di, e]) => ({
      name: dests[di].name, label: dests[di].label, kind: dests[di].kind,
      access: e.member ? 'member' : 'key', talk: e.talk, listen: e.listen,
    })).sort((a, b) => a.name.localeCompare(b.name));
    const loc = topo ? locate(topo, nameOf(addr)) : null;
    return {
      addr, name: nameOf(addr), type: typeOf(addr), isPanel: !!(addrInfo.get(addr) && addrInfo.get(addr).isPanel), twoWire: twoWireOf(addr),
      node: loc ? loc.node : null, nodeId: loc ? loc.nodeId : null, card: loc ? loc.card : null, bay: loc ? loc.bay : null,
      memberships,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Topology summary — only the nodes/cards that actually have rows, for filters.
  const topoNodes = new Map();
  if (topo) {
    for (const pn of panels) {
      if (!pn.nodeId) continue;
      let n = topoNodes.get(pn.nodeId);
      if (!n) { n = { id: pn.nodeId, name: pn.node, cards: new Set() }; topoNodes.set(pn.nodeId, n); }
      if (pn.bay) n.cards.add(pn.bay + ' · ' + (pn.card || ''));
    }
  }
  const topology = {
    loaded: !!topo,
    name: topo ? topo.name : null, loadedAt: topo ? topo.loadedAt : null,
    nodeCount: topo ? topo.stats.nodes : 0, cardCount: topo ? topo.stats.cards : 0, ports: topo ? topo.stats.ports : 0,
    nodes: [...topoNodes.values()].sort((a, b) => Number(a.id) - Number(b.id)).map((n) => ({ id: n.id, name: n.name, cards: [...n.cards].sort() })),
  };

  const rowIdx = new Map(panels.map((pn, i) => [pn.addr, i]));
  const cells = [];
  for (const [addr, m] of edges) {
    const r = rowIdx.get(addr);
    for (const [di, e] of m) {
      if (e.member) cells.push({ r, c: di, t: e.talk ? 1 : 0, l: e.listen ? 1 : 0, k: 0 });
      else cells.push({ r, c: di, t: 0, l: 0, k: 1 });
    }
  }

  return {
    ok: true, error: null, source: 'rrcs', system: { id: def.id, name: def.name }, host: def.host, port: def.port, fetchedAt: new Date().toISOString(),
    config: configInfo(cfg),
    counts: { ports: ports.length, panels: panels.length, conferences: conferences.length, groups: groups.length, memberEdges, keyEdges, keyUnresolved, cells: cells.length },
    topology,
    conferences: conferences.map((d, i) => ({ idx: i, kind: 'conference', name: d.name, label: d.label, memberCount: d.members.length, members: d.members })),
    groups: groups.map((d, i) => ({ idx: i, kind: 'group', name: d.name, label: d.label, memberCount: d.members.length, members: d.members })),
    panels,
    matrix: {
      rows: panels.map((pn) => ({ addr: pn.addr, name: pn.name, type: pn.type, isPanel: pn.isPanel, twoWire: pn.twoWire, nodeId: pn.nodeId, node: pn.node, card: pn.card, bay: pn.bay })),
      cols: dests.map((d) => ({ name: d.name, label: d.label, kind: d.kind, memberCount: d.members.length })),
      cells,
    },
  };
}

// ---------- model build from a config print (offline, key-level) ----------
function buildPrintModel(def, print, topo) {
  // resolve truncated panel names against topology + untruncated print names
  const known = new Set((topo && topo.names) || []);
  for (const c of print.conferences) for (const k of c.keys) if (k.panel && !k.truncated) known.add(k.panel);
  const knownList = [...known].filter((n) => n && n.length > 2);
  const resolveTrunc = (prefix) => { if (!prefix) return null; const u = [...new Set(knownList.filter((n) => n.startsWith(prefix)))]; return u.length === 1 ? u[0] : null; };

  const destList = []; const conferences = []; const groups = [];
  const typeOf = new Map();
  for (const c of print.conferences) {
    const members = new Map();
    for (const k of c.keys) {
      let panel = k.panel; if (!panel) continue;
      if (k.truncated) panel = resolveTrunc(panel) || panel;
      if (k.panelType && !typeOf.has(panel)) typeOf.set(panel, k.panelType);
      const e = members.get(panel) || { talk: false, listen: false };
      e.talk = e.talk || k.talk; e.listen = e.listen || k.listen; members.set(panel, e);
    }
    const d = { name: c.name, label: c.alias, kind: c.kind, members };
    destList.push(d); (c.kind === 'group' ? groups : conferences).push(d);
  }

  const edges = new Map(); // panel -> Map(destIdx -> {talk,listen})
  destList.forEach((d, di) => { for (const [panel, dir] of d.members) { let m = edges.get(panel); if (!m) { m = new Map(); edges.set(panel, m); } const e = m.get(di) || { talk: false, listen: false }; e.talk = e.talk || dir.talk; e.listen = e.listen || dir.listen; m.set(di, e); } });

  const panels = [...edges.keys()].sort((a, b) => a.localeCompare(b)).map((name) => {
    const m = edges.get(name); const loc = topo ? locate(topo, name) : null;
    const memberships = [...m.entries()].map(([di, e]) => ({ name: destList[di].name, label: destList[di].label, kind: destList[di].kind, access: 'member', talk: e.talk, listen: e.listen })).sort((a, b) => a.name.localeCompare(b.name));
    return { addr: name, name, type: typeOf.get(name) || '', isPanel: true, twoWire: false, node: loc ? loc.node : null, nodeId: loc ? loc.nodeId : null, card: loc ? loc.card : null, bay: loc ? loc.bay : null, memberships };
  });

  const topoNodes = new Map();
  if (topo) for (const pn of panels) { if (!pn.nodeId) continue; let n = topoNodes.get(pn.nodeId); if (!n) { n = { id: pn.nodeId, name: pn.node, cards: new Set() }; topoNodes.set(pn.nodeId, n); } if (pn.bay) n.cards.add(pn.bay + ' · ' + (pn.card || '')); }
  const topology = { loaded: !!topo, name: topo ? topo.name : null, loadedAt: topo ? topo.loadedAt : null, nodeCount: topo ? topo.stats.nodes : 0, cardCount: topo ? topo.stats.cards : 0, ports: topo ? topo.stats.ports : 0, nodes: [...topoNodes.values()].sort((a, b) => Number(a.id) - Number(b.id)).map((n) => ({ id: n.id, name: n.name, cards: [...n.cards].sort() })) };

  const rowIdx = new Map(panels.map((p, i) => [p.addr, i]));
  const cells = [];
  for (const [panel, m] of edges) { const r = rowIdx.get(panel); for (const [di, e] of m) cells.push({ r, c: di, t: e.talk ? 1 : 0, l: e.listen ? 1 : 0, k: 0 }); }

  const idxOf = new Map(destList.map((d, i) => [d, i]));
  const mkMembers = (d) => [...d.members].map(([p, dir]) => ({ addr: p, name: p, type: typeOf.get(p) || '', talk: dir.talk, listen: dir.listen })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true, error: null, source: 'print', system: { id: def.id, name: def.name }, host: null, port: null, fetchedAt: print.loadedAt || new Date().toISOString(),
    config: { loaded: false }, topology,
    counts: { ports: panels.length, panels: panels.length, conferences: conferences.length, groups: groups.length, memberEdges: cells.length, keyEdges: 0, cells: cells.length, keyAssignments: print.stats.keyAssignments },
    conferences: conferences.map((d) => ({ idx: idxOf.get(d), kind: 'conference', name: d.name, label: d.label, memberCount: d.members.size, members: mkMembers(d) })),
    groups: groups.map((d) => ({ idx: idxOf.get(d), kind: 'group', name: d.name, label: d.label, memberCount: d.members.size, members: mkMembers(d) })),
    panels,
    matrix: { rows: panels.map((pn) => ({ addr: pn.addr, name: pn.name, type: pn.type, isPanel: pn.isPanel, twoWire: false, nodeId: pn.nodeId, node: pn.node, card: pn.card, bay: pn.bay })), cols: destList.map((d) => ({ name: d.name, label: d.label, kind: d.kind, memberCount: d.members.size })), cells },
  };
}
function printInfo(p, history) {
  const base = p
    ? { loaded: true, name: p.name, loadedAt: p.loadedAt, versionId: p.versionId || null, conferences: p.stats.conferences, keyAssignments: p.stats.keyAssignments, truncated: p.stats.truncated }
    : { loaded: false };
  base.history = history || [];
  return base;
}
const countPanels = (parsed) => { const s = new Set(); for (const c of parsed.conferences) for (const k of c.keys) if (k.panel) s.add(k.panel); return s.size; };
const statsOf = (parsed) => ({ conferences: parsed.stats.conferences, keyAssignments: parsed.stats.keyAssignments, truncated: parsed.stats.truncated, panels: countPanels(parsed) });
// Store version list mapped for the UI (most-recent first).
function versionsFor(sysId) {
  return store.listVersions(sysId).map((v) => ({ id: v.id, name: v.name, uploadedAt: v.uploadedAt, loadedAt: v.uploadedAt, conferences: v.stats.conferences, keyAssignments: v.stats.keyAssignments, truncated: v.stats.truncated, panels: v.stats.panels })).reverse();
}
// Make a stored version the active print source for a system.
function activateVersion(sys, versionId) {
  const text = store.getVersionText(sys.def.id, versionId);
  if (text == null) return false;
  const parsed = parsePrintText(text);
  const v = store.getVersion(sys.def.id, versionId);
  sys.print = { ...parsed, name: v ? v.name : 'print', loadedAt: v ? v.uploadedAt : new Date().toISOString(), versionId };
  rebuild(sys);
  return true;
}

// ---------- per-system operations ----------
function sysOf(id) { return systems.get(id || defaultId) || systems.get(defaultId) || null; }
function rebuild(sys) {
  if (!sys) return null;
  if (sys.vsp) sys.snapshot = buildVspModel(sys.def, sys.vsp.export);                   // VSP export (offline) takes precedence
  else if (sys.print) sys.snapshot = buildPrintModel(sys.def, sys.print, sys.topology); // print-backed (offline)
  else if (sys.lastRaw) sys.snapshot = buildModel(sys.def, sys.config, sys.topology, sys.lastRaw.portsRaw, sys.lastRaw.confsRaw, sys.lastRaw.groupsRaw);
  return sys.snapshot;
}

// Return the cached snapshot augmented with liveness info. The snapshot itself
// is the LAST SUCCESSFUL model — preserved across failed refreshes (stale=true).
function readSnapshot(sys) {
  if (!sys) return null;
  const s = sys.snapshot;
  return {
    ...s,
    ok: s.ok,
    error: s.ok ? null : (sys.lastError || s.error),
    stale: !!(s.ok && sys.lastError),
    lastError: sys.lastError || null,
    lastErrorAt: sys.lastErrorAt || null,
    lastTryAt: sys.lastTryAt || null,
    print: printInfo(sys.print, versionsFor(sys.def.id)),
  };
}

function init() {
  const defs = loadDefs();
  for (const def of defs) {
    const sys = makeSysEntry(def);
    systems.set(def.id, sys);
    if (!defaultId) defaultId = def.id;
    loadSystemSources(sys);   // VSP export, key-access config, topology, print
  }
  return defs;
}

async function refresh(id, { force = false } = {}) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const def = sys.def;
  if (sys.vsp || sys.print) { sys.lastError = null; rebuild(sys); return readSnapshot(sys); } // offline (VSP / print): static, no network
  if (!rrcsOn()) { sys.lastError = sys.snapshot.ok ? null : 'RRCS disabled — load a config print for this system'; rebuild(sys); return readSnapshot(sys); }
  if (!def.host) { sys.lastError = 'no controller configured for this system'; sys.lastErrorAt = new Date().toISOString(); return readSnapshot(sys); }
  if (sys.fetching) return sys.fetching;
  if (!force && sys.snapshot.ok && Date.now() - sys.lastFetchStart < minRefreshMs()) return readSnapshot(sys);
  sys.lastFetchStart = Date.now();
  sys.lastTryAt = new Date().toISOString();
  sys.fetching = (async () => {
    try {
      const portsRaw = extractPorts(await client.call(def.host, def.port, 'GetAllPorts', []));
      const confsRaw = listOf(await client.call(def.host, def.port, 'GetAllConferences', []));
      let groupsRaw = [];
      try { groupsRaw = listOf(await client.call(def.host, def.port, 'GetAllGroups', [])); } catch { /* optional */ }
      sys.lastRaw = { portsRaw, confsRaw, groupsRaw };
      sys.snapshot = buildModel(def, sys.config, sys.topology, portsRaw, confsRaw, groupsRaw);
      sys.lastError = null; sys.lastErrorAt = null;
    } catch (e) {
      // KEEP the last successful snapshot — serve it (stale) until a refresh
      // succeeds again. Only record the failure.
      sys.lastError = e.message; sys.lastErrorAt = new Date().toISOString();
    } finally { sys.fetching = null; }
    return readSnapshot(sys);
  })();
  return sys.fetching;
}

function getSnapshot(id) { return readSnapshot(sysOf(id)); }
function listSystems() {
  return [...systems.values()].map((s) => ({
    id: s.def.id, name: s.def.name, host: s.def.host, port: s.def.port, configPath: s.def.configPath, topologyPath: s.def.topologyPath, vspPath: s.def.vspPath, configured: !!s.vsp || !!s.print || (rrcsOn() && !!s.def.host),
    source: s.print ? 'print' : (rrcsOn() ? 'rrcs' : 'offline'),
    ok: s.snapshot.ok, stale: !!(s.snapshot.ok && s.lastError), error: s.lastError || (s.snapshot.ok ? null : s.snapshot.error),
    fetchedAt: s.snapshot.fetchedAt, lastErrorAt: s.lastErrorAt || null,
    config: configInfo(s.config), topology: topologyInfo(s.topology), print: printInfo(s.print, versionsFor(s.def.id)),
    vsp: s.vsp ? { loaded: true, name: s.vsp.name } : { loaded: false },
    counts: s.snapshot.counts,
  }));
}
function loadConfigBuffer(id, buffer, name) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const parsed = parseKeyLabels(buffer);
  sys.config = { byObjectId: parsed.byObjectId, name: name || 'config', loadedAt: new Date().toISOString(), stats: parsed.stats };
  rebuild(sys);
  return configInfo(sys.config);
}
function clearConfig(id) { const sys = sysOf(id); if (!sys) throw new Error('unknown system'); sys.config = null; rebuild(sys); return configInfo(sys.config); }
function configInfoFor(id) { const s = sysOf(id); return s ? configInfo(s.config) : { loaded: false }; }

// Load a node-tree text (.txt) for node/card grouping; re-merge immediately.
function loadTopologyBuffer(id, text, name) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const parsed = parseTopology(Buffer.isBuffer(text) ? text.toString('utf8') : String(text));
  if (!parsed.stats.ports) throw new Error('no ports found — is this a controller node tree?');
  sys.topology = { ...parsed, name: name || 'topology', loadedAt: new Date().toISOString() };
  rebuild(sys);
  return topologyInfo(sys.topology);
}
function clearTopology(id) { const sys = sysOf(id); if (!sys) throw new Error('unknown system'); sys.topology = null; rebuild(sys); return topologyInfo(sys.topology); }
function topologyInfoFor(id) { const s = sysOf(id); return s ? topologyInfo(s.topology) : { loaded: false }; }

// Load a config print (PDF or extracted -raw text) as an OFFLINE matrix
// source. The upload is persisted as a new VERSION (the active source) and
// auto-loads on restart. Re-uploading identical text is a no-op.
function loadPrintBuffer(id, buffer, name) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const text = toText(buffer);
  const parsed = parsePrintText(text);
  if (!parsed.stats.keyAssignments) throw new Error('no conference key assignments found — is this a "Group and Conference List" print?');
  const prevLatest = store.latest(sys.def.id);
  const version = store.addVersion(sys.def.id, text, name || 'print', statsOf(parsed));
  activateVersion(sys, version.id);
  // diff this upload against the version it superseded (null on first upload)
  let diff = null;
  if (!version.unchanged && prevLatest) {
    try { diff = diffPrints(parsePrintText(store.getVersionText(sys.def.id, prevLatest.id)), parsed).summary; } catch { /* ignore */ }
  }
  return { ...printInfo(sys.print, versionsFor(sys.def.id)), version: { id: version.id, name: version.name, uploadedAt: version.uploadedAt, unchanged: !!version.unchanged }, diff };
}
function clearPrint(id) { const sys = sysOf(id); if (!sys) throw new Error('unknown system'); sys.print = null; store.clear(sys.def.id); rebuild(sys); return printInfo(sys.print, versionsFor(sys.def.id)); }
function printInfoFor(id) { const s = sysOf(id); return s ? printInfo(s.print, versionsFor(s.def.id)) : { loaded: false, history: [] }; }
function printVersions(id) { const s = sysOf(id); return s ? versionsFor(s.def.id) : []; }
// Structured diff between two stored versions. Defaults: to=latest, from=its predecessor.
function printDiff(id, fromId, toId) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const versions = store.listVersions(sys.def.id);
  if (!versions.length) return { summary: {}, conferences: [], from: null, to: null };
  const to = toId ? versions.find((v) => v.id === Number(toId)) : versions[versions.length - 1];
  if (!to) throw new Error('unknown to-version');
  let from = null;
  if (fromId) from = versions.find((v) => v.id === Number(fromId)) || null;
  else { const i = versions.findIndex((v) => v.id === to.id); from = i > 0 ? versions[i - 1] : null; }
  const newParsed = parsePrintText(store.getVersionText(sys.def.id, to.id));
  const oldParsed = from ? parsePrintText(store.getVersionText(sys.def.id, from.id)) : { conferences: [] };
  const d = diffPrints(oldParsed, newParsed);
  const meta = (v) => (v ? { id: v.id, name: v.name, uploadedAt: v.uploadedAt } : null);
  return { ...d, from: meta(from), to: meta(to) };
}
function defaultSystem() { return defaultId; }
function systemIds() { return [...systems.keys()]; }
function rrcsEnabled() { return rrcsOn(); }

module.exports = { init, refresh, getSnapshot, listSystems, loadConfigBuffer, clearConfig, configInfoFor, loadTopologyBuffer, clearTopology, topologyInfoFor, loadPrintBuffer, clearPrint, printInfoFor, printVersions, printDiff, setSystemHost, createSystem, updateSystem, deleteSystem, reorderSystems, defaultSystem, systemIds, rrcsEnabled, MIN_REFRESH_MS };
