// lib/combined-model.js — the "All systems" snapshot: every system's panels in
// one matrix, with conferences that are the same channel on several systems
// merged into one column (lib/conference-match).
//
// Input snapshots are the per-system ones the caller may already have filtered to
// a customer's scope (lib/customer-access), so scoping carries through unchanged.
// The output has the per-system snapshot shape every view reads, plus:
//   rows / panels / members: system, sysName, port (the real port name); addr is
//                            re-keyed "<system>:<addr>" so it stays unique
//   cols / conferences:       matched, variants [{ system, sysName, name, label }],
//                            systems [ids]
//   panel memberships:        name = merged column name, realName = this system's name
//
// Uploads, versions and change requests stay per system; this view is read-only
// composition. Pure functions only — inputs are never mutated.

const { clusterDests } = require('./conference-match');

const ALL_ID = 'all';
const ALL_NAME = 'All systems';
const SEP = '\u0000';
const destRef = (sys, kind, name) => sys + SEP + (kind || 'conference') + SEP + name;
const rowKey = (sys, addr) => sys + ':' + addr;

function combine(systems, snapshots) {
  const live = (systems || []).filter((s) => snapshots[s.id] && snapshots[s.id].ok);
  const listed = live.map((s) => ({ id: s.id, name: s.name }));
  if (!live.length) return emptyCombined(listed);

  // ---- columns: cluster each system's destinations ----
  const merged = clusterDests(live, Object.fromEntries(live.map((s) => [s.id, snapshots[s.id].matrix.cols])));
  const colOf = new Map();   // destRef(sys, kind, realName) -> merged index
  merged.forEach((m, i) => { for (const v of m.variants) colOf.set(destRef(v.system, m.kind, v.name), i); });
  const colCount = new Array(merged.length).fill(0);

  // ---- rows, panels, cells, topology ----
  const rows = [], panels = [], cells = [], nodes = [];
  const counts = { ports: 0, panels: 0, memberEdges: 0, keyEdges: 0, cells: 0 };
  for (const s of live) {
    const snap = snapshots[s.id];
    const offset = rows.length;
    const nodeId = (id) => (id == null ? null : s.id + ':' + id);
    for (const r of snap.matrix.rows) rows.push({ ...r, addr: rowKey(s.id, r.addr), port: r.addr, system: s.id, sysName: s.name, nodeId: nodeId(r.nodeId) });
    for (const cell of snap.matrix.cells) {
      const src = snap.matrix.cols[cell.c];
      const c = colOf.get(destRef(s.id, src.kind, src.name));
      if (c == null) continue;
      cells.push({ ...cell, r: cell.r + offset, c });
      if (!cell.k) colCount[c]++;
    }
    for (const p of snap.panels || []) {
      panels.push({
        ...p, addr: rowKey(s.id, p.addr), port: p.addr, system: s.id, sysName: s.name, nodeId: nodeId(p.nodeId),
        memberships: (p.memberships || []).map((m) => {
          const c = colOf.get(destRef(s.id, m.kind, m.name));
          return { ...m, name: c == null ? m.name : merged[c].name, realName: m.name, system: s.id };
        }),
      });
    }
    for (const n of (snap.topology && snap.topology.nodes) || []) nodes.push({ ...n, id: nodeId(n.id), name: `${s.name} · ${n.name}` });
    for (const k of Object.keys(counts)) counts[k] += (snap.counts && snap.counts[k]) || 0;
  }

  // ---- conference / group lists with system-tagged members ----
  const sysName = new Map(live.map((s) => [s.id, s.name]));
  const destIn = (sys, kind, name) => [...(snapshots[sys].conferences || []), ...(snapshots[sys].groups || [])].find((d) => d.kind === kind && d.name === name);
  const dests = merged.map((m, idx) => ({
    idx, kind: m.kind, name: m.name, label: m.label, matched: m.matched, variants: m.variants,
    systems: m.variants.map((v) => v.system),
    members: m.variants.flatMap((v) => ((destIn(v.system, m.kind, v.name) || {}).members || [])
      .map((mm) => ({ ...mm, addr: rowKey(v.system, mm.addr), port: mm.addr, system: v.system, sysName: sysName.get(v.system) }))),
    memberCount: colCount[idx],
  }));
  const conferences = dests.filter((d) => d.kind !== 'group');
  const groups = dests.filter((d) => d.kind === 'group');

  const cols = merged.map((m, i) => ({ name: m.name, label: m.label, kind: m.kind, memberCount: colCount[i], matched: m.matched, variants: m.variants }));
  const newest = live.map((s) => snapshots[s.id].fetchedAt).filter(Boolean).sort().pop() || null;
  const scopes = live.map((s) => snapshots[s.id].scope).filter(Boolean);

  return {
    ok: true, error: null, source: 'combined', system: { id: ALL_ID, name: ALL_NAME }, systems: listed, fetchedAt: newest,
    topology: { loaded: nodes.length > 0, nodes },
    counts: { ...counts, conferences: conferences.length, groups: groups.length, matchedConferences: merged.filter((m) => m.matched).length },
    conferences, groups, panels,
    matrix: { rows, cols, cells },
    print: { loaded: true, combined: true, history: [] },
    scope: scopes.length ? { customers: scopes[0].customers } : null,
  };
}

function emptyCombined(listed) {
  return {
    ok: false, error: 'no config print loaded on any system — upload one in Settings → Systems', source: 'combined',
    system: { id: ALL_ID, name: ALL_NAME }, systems: listed, fetchedAt: null,
    topology: { loaded: false, nodes: [] },
    counts: { ports: 0, panels: 0, conferences: 0, groups: 0, memberEdges: 0, keyEdges: 0, cells: 0, matchedConferences: 0 },
    conferences: [], groups: [], panels: [], matrix: { rows: [], cols: [], cells: [] },
    print: { loaded: false, combined: true, history: [] }, scope: null,
  };
}

module.exports = { combine, ALL_ID, ALL_NAME };
