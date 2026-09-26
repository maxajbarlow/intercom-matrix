// lib/system-service.js — the intercom systems the viewer switches between.
//
// Each system (e.g. F1, F2/F3) is fed by CONFIG PRINTS: a PDF or extracted-text
// "Group and Conference List" uploaded by an engineer. Every upload is stored as
// a version (lib/print-store) and the latest is the active matrix source; an
// optional topology tree adds node/card placement. There is no live controller
// connection — the viewer never talks to the intercom system at all.
//
// Systems are defined in systems.json (or SYSTEMS_FILE). Legacy fields from the
// removed live-RRCS / key-access / VSP integrations (host, port, config, vsp)
// are ignored on load and dropped the next time the file is written.

const fs = require('fs');
const path = require('path');
const { parseTopology } = require('./topology');
const { toText, parsePrintText } = require('./print-parser');
const store = require('./print-store');
const { diffPrints } = require('./print-diff');
const { buildPrintModel, emptySnapshot } = require('./print-model');

const NO_PRINT = 'no config print loaded — upload one in Settings → Systems';
const SYS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

const systems = new Map();   // id -> { def, snapshot, topology, print }
let defaultId = null;
let systemsFilePath = null;  // set when defs came from a file (for persistence)

// ---------- system definitions ----------
function normalizeDef(d) {
  return {
    id: String(d.id), name: String(d.name || d.id),
    topologyPath: String(d.topology || d.topologyPath || ''),
    printPath: String(d.print || d.printPath || ''),
  };
}
function loadDefs() {
  const file = process.env.SYSTEMS_FILE || path.join(__dirname, '..', 'systems.json');
  systemsFilePath = file;
  if (!fs.existsSync(file)) return [];
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a.map(normalizeDef) : [];
  } catch (e) { console.warn(`[systems] bad ${file}: ${e.message}`); return []; }
}
function persistDefs() {
  if (!systemsFilePath) return;
  const arr = [...systems.values()].map(({ def }) => {
    const o = { id: def.id, name: def.name };
    if (def.topologyPath) o.topology = def.topologyPath;
    if (def.printPath) o.print = def.printPath;
    return o;
  });
  try { fs.writeFileSync(systemsFilePath, JSON.stringify(arr, null, 2) + '\n'); }
  catch (e) { console.warn(`[systems] persist failed: ${e.message}`); }
}

const makeSysEntry = (def) => ({ def, snapshot: emptySnapshot(def, NO_PRINT), topology: null, print: null });

// Load the sources a def points at: the topology tree, then the latest stored
// print version (or a seed print path, imported as v1). Best-effort — logs,
// never throws, so one bad file can't stop the others loading.
function loadSystemSources(sys) {
  const def = sys.def;
  const uploaded = store.loadTopology(def.id);   // the latest upload wins over a configured path
  if (uploaded) {
    try { applyTopology(sys, uploaded.text, uploaded.name, uploaded.uploadedAt); console.log(`[${def.id}] topology: ${uploaded.name} (uploaded)`); }
    catch (e) { console.warn(`[${def.id}] topology load failed: ${e.message}`); }
  } else if (def.topologyPath) {
    try { applyTopology(sys, fs.readFileSync(def.topologyPath, 'utf8'), path.basename(def.topologyPath)); console.log(`[${def.id}] topology: ${path.basename(def.topologyPath)}`); }
    catch (e) { console.warn(`[${def.id}] topology load failed: ${e.message}`); }
  }
  const stored = store.latest(def.id);
  if (stored) {
    try { activateVersion(sys, stored.id); console.log(`[${def.id}] print: ${stored.name} v${stored.id} (${sys.print.stats.conferences} conferences, ${sys.print.stats.keyAssignments} keys)`); }
    catch (e) { console.warn(`[${def.id}] print load failed: ${e.message}`); }
  } else if (def.printPath) {
    try { const info = loadPrintBuffer(def.id, fs.readFileSync(def.printPath), path.basename(def.printPath)); console.log(`[${def.id}] print: ${path.basename(def.printPath)} (${info.conferences} conferences, ${info.keyAssignments} keys, imported as v1)`); }
    catch (e) { console.warn(`[${def.id}] print load failed: ${e.message}`); }
  }
}

// ---------- systems CRUD (gated at the route layer) ----------
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

// Edit name / topology path. The id is permanent (it keys prints + requests).
function updateSystem(id, patch) {
  const sys = sysOf(id);
  if (!sys || sys.def.id !== id) throw new Error('unknown system');
  const p = patch || {};
  if (p.id != null && String(p.id).trim() !== id) throw new Error('system id cannot be changed once created');
  if (p.name != null) sys.def.name = String(p.name).trim() || sys.def.name;
  if (p.topology != null) {
    // A newly configured path is newer than any upload — it replaces it.
    sys.def.topologyPath = String(p.topology).trim(); sys.topology = null; store.clearTopology(id);
    loadSystemSources(sys); rebuild(sys);
  }
  persistDefs();
  return listSystems().find((s) => s.id === id);
}

function deleteSystem(id) {
  if (!systems.has(id)) throw new Error('unknown system');
  systems.delete(id);
  // Stored prints + topology are deliberately KEPT (the UI says so): removing a
  // system only drops it from the switcher; re-adding the id restores its data.
  if (defaultId === id) defaultId = systems.keys().next().value || null;
  persistDefs();
  return { id, default: defaultId, systems: listSystems() };
}

// Reorder to match `order` (unknown ids ignored; missing ids kept at the end).
function reorderSystems(order) {
  const ids = Array.isArray(order) ? order.filter((x) => systems.has(x)) : [];
  const seen = new Set(ids);
  const sorted = [...ids.map((id) => [id, systems.get(id)]), ...[...systems.entries()].filter(([id]) => !seen.has(id))];
  systems.clear();
  for (const [id, sys] of sorted) systems.set(id, sys);
  persistDefs();
  return listSystems();
}

// ---------- info shapes ----------
function topologyInfo(t) {
  return t ? { loaded: true, name: t.name, loadedAt: t.loadedAt, nodes: t.stats.nodes, cards: t.stats.cards, ports: t.stats.ports } : { loaded: false };
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
// Stored version list for the UI (most-recent first).
function versionsFor(sysId) {
  return store.listVersions(sysId).map((v) => ({ id: v.id, name: v.name, uploadedAt: v.uploadedAt, loadedAt: v.uploadedAt, conferences: v.stats.conferences, keyAssignments: v.stats.keyAssignments, truncated: v.stats.truncated, panels: v.stats.panels })).reverse();
}

// ---------- snapshot ----------
function sysOf(id) { return systems.get(id || defaultId) || systems.get(defaultId) || null; }
function rebuild(sys) {
  if (!sys) return null;
  sys.snapshot = sys.print ? buildPrintModel(sys.def, sys.print, sys.topology) : emptySnapshot(sys.def, NO_PRINT);
  return sys.snapshot;
}
function activateVersion(sys, versionId) {
  const text = store.getVersionText(sys.def.id, versionId);
  if (text == null) return false;
  const parsed = parsePrintText(text);
  const v = store.getVersion(sys.def.id, versionId);
  sys.print = { ...parsed, name: v ? v.name : 'print', loadedAt: v ? v.uploadedAt : new Date().toISOString(), versionId };
  rebuild(sys);
  return true;
}
function readSnapshot(sys) {
  if (!sys) return null;
  return { ...sys.snapshot, print: printInfo(sys.print, versionsFor(sys.def.id)) };
}

function init() {
  const defs = loadDefs();
  for (const def of defs) {
    const sys = makeSysEntry(def);
    systems.set(def.id, sys);
    if (!defaultId) defaultId = def.id;
    loadSystemSources(sys);
  }
  return defs;
}

function getSnapshot(id) { return readSnapshot(sysOf(id)); }
function listSystems() {
  return [...systems.values()].map((s) => ({
    id: s.def.id, name: s.def.name, topologyPath: s.def.topologyPath,
    configured: !!s.print, source: s.print ? 'print' : 'none',
    ok: s.snapshot.ok, error: s.snapshot.ok ? null : s.snapshot.error, fetchedAt: s.snapshot.fetchedAt,
    topology: topologyInfo(s.topology), print: printInfo(s.print, versionsFor(s.def.id)),
    counts: s.snapshot.counts,
  }));
}

// ---------- topology (node → card → port tree) ----------
// Parse + activate a topology tree. Throws (changing nothing) if it has no ports.
function applyTopology(sys, text, name, loadedAt) {
  const parsed = parseTopology(text);
  if (!parsed.stats.ports) throw new Error('no ports found — is this a controller node tree?');
  sys.topology = { ...parsed, name: name || 'topology', loadedAt: loadedAt || new Date().toISOString() };
  rebuild(sys);
}
// An upload: validated first, then persisted (lib/print-store) so it survives
// restarts until a newer upload replaces it or it's cleared.
function loadTopologyBuffer(id, text, name) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const str = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  applyTopology(sys, str, name);
  const meta = store.saveTopology(sys.def.id, str, sys.topology.name);
  sys.topology.loadedAt = meta.uploadedAt;
  return topologyInfo(sys.topology);
}
// Clearing is for good: the stored upload AND any configured path are dropped.
function clearTopology(id) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  sys.topology = null; store.clearTopology(sys.def.id);
  if (sys.def.topologyPath) { sys.def.topologyPath = ''; persistDefs(); }
  rebuild(sys);
  return topologyInfo(sys.topology);
}
function topologyInfoFor(id) { const s = sysOf(id); return s ? topologyInfo(s.topology) : { loaded: false }; }

// ---------- config prints ----------
// Load a print (PDF or extracted -raw text). Persisted as a new VERSION (the
// active source) that auto-loads on restart; identical re-uploads are a no-op.
function loadPrintBuffer(id, buffer, name) {
  const sys = sysOf(id); if (!sys) throw new Error('unknown system');
  const text = toText(buffer);
  const parsed = parsePrintText(text);
  if (!parsed.stats.keyAssignments) throw new Error('no conference key assignments found — is this a "Group and Conference List" print?');
  const prevLatest = store.latest(sys.def.id);
  const version = store.addVersion(sys.def.id, text, name || 'print', statsOf(parsed));
  activateVersion(sys, version.id);
  let diff = null;   // this upload vs the version it superseded (null on first upload)
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
  const meta = (v) => (v ? { id: v.id, name: v.name, uploadedAt: v.uploadedAt } : null);
  return { ...diffPrints(oldParsed, newParsed), from: meta(from), to: meta(to) };
}

function defaultSystem() { return defaultId; }
function systemIds() { return [...systems.keys()]; }

module.exports = {
  init, getSnapshot, listSystems, defaultSystem, systemIds,
  createSystem, updateSystem, deleteSystem, reorderSystems,
  loadTopologyBuffer, clearTopology, topologyInfoFor,
  loadPrintBuffer, clearPrint, printInfoFor, printVersions, printDiff,
};
