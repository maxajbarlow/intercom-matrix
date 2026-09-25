// lib/print-model.js — build the viewer's matrix model from a parsed config print.
//
// A config print ("Group and Conference List") is the matrix source: each
// conference/group lists the panel keys assigned to it with their Talk/Listen
// direction. This turns that into the shared snapshot shape every view reads
// (conferences, groups, panels with memberships, and a sparse matrix), merged
// with the optional topology tree for node/card placement and for resolving
// panel names the print truncated.

const { locate } = require('./topology');

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
    ok: true, error: null, source: 'print', system: { id: def.id, name: def.name }, fetchedAt: print.loadedAt || new Date().toISOString(),
    topology,
    counts: { ports: panels.length, panels: panels.length, conferences: conferences.length, groups: groups.length, memberEdges: cells.length, keyEdges: 0, cells: cells.length, keyAssignments: print.stats.keyAssignments },
    conferences: conferences.map((d) => ({ idx: idxOf.get(d), kind: 'conference', name: d.name, label: d.label, memberCount: d.members.size, members: mkMembers(d) })),
    groups: groups.map((d) => ({ idx: idxOf.get(d), kind: 'group', name: d.name, label: d.label, memberCount: d.members.size, members: mkMembers(d) })),
    panels,
    matrix: { rows: panels.map((pn) => ({ addr: pn.addr, name: pn.name, type: pn.type, isPanel: pn.isPanel, twoWire: false, nodeId: pn.nodeId, node: pn.node, card: pn.card, bay: pn.bay })), cols: destList.map((d) => ({ name: d.name, label: d.label, kind: d.kind, memberCount: d.members.size })), cells },
  };
}

// The placeholder snapshot for a system with no print loaded yet.
function emptySnapshot(def, error) {
  return {
    ok: false, error: error || null, source: 'none', system: { id: def.id, name: def.name }, fetchedAt: null,
    topology: { loaded: false, nodes: [] },
    counts: { ports: 0, panels: 0, conferences: 0, groups: 0, memberEdges: 0, keyEdges: 0, cells: 0 },
    conferences: [], groups: [], panels: [], matrix: { rows: [], cols: [], cells: [] },
  };
}

module.exports = { buildPrintModel, emptySnapshot };
