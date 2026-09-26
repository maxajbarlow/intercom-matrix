// lib/customer-scope.js — derive what a customer group may see, and filter to it.
//
// A customer group is defined by its SOURCE PANELS (per system), never by a list
// of conferences. Its visible conferences are DERIVED on every request from the
// current snapshot: every conference/group any source panel is a member of or
// holds a key to. So when a new conference is added to an FIA panel, the next
// print/refresh shows it to FIA automatically — there is nothing to sync.
//
// Visible panels (ports) are ONLY the group's own source panels. Other customers'
// ports never appear — not as matrix rows, not in a conference's member list or
// member count, not in print diffs or change requests — even on a conference
// they share with the customer.
//
// Pure functions only: no I/O, no mutation of the snapshot passed in.

const SEP = '\u0000';
const destKey = (kind, name) => (kind || 'conference') + SEP + name;

// Locate a source panel in the snapshot: address first, then name (print-backed
// systems use the panel name as its address, so either matches).
function findPanel(byAddr, byName, src) {
  return (src.addr && byAddr.get(src.addr)) || (src.name && byName.get(src.name)) || null;
}

function emptyScope(sources) {
  return { destKeys: new Set(), confNames: new Set(), panelAddrs: new Set(), panelKeys: new Set(), matchedSources: [], missingSources: [...(sources || [])] };
}

// snapshot + [{addr, name}] → the derived scope for that system.
function resolveScope(snapshot, sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (!snapshot || !Array.isArray(snapshot.panels)) return emptyScope(list);
  const byAddr = new Map(), byName = new Map();
  for (const p of snapshot.panels) { if (p.addr) byAddr.set(p.addr, p); if (p.name) byName.set(p.name, p); }

  const scope = emptyScope([]);
  for (const src of list) {
    const p = findPanel(byAddr, byName, src);
    if (!p) { scope.missingSources.push(src); continue; }
    scope.matchedSources.push({ ...src, addr: p.addr, name: p.name });
    for (const m of p.memberships || []) { scope.destKeys.add(destKey(m.kind, m.name)); scope.confNames.add(m.name); }
  }
  // Ports: the customer's own source panels, nothing else.
  for (const src of scope.matchedSources) {
    scope.panelAddrs.add(src.addr);
    scope.panelKeys.add(src.addr); if (src.name) scope.panelKeys.add(src.name);
  }
  return scope;
}

function filterMatrix(matrix, scope) {
  const colMap = new Map(), rowMap = new Map();
  const cols = [], rows = [];
  (matrix.cols || []).forEach((c, i) => { if (scope.destKeys.has(destKey(c.kind, c.name))) { colMap.set(i, cols.length); cols.push({ ...c }); } });
  (matrix.rows || []).forEach((r, i) => { if (scope.panelAddrs.has(r.addr)) { rowMap.set(i, rows.length); rows.push({ ...r }); } });
  const cells = [];
  for (const cell of matrix.cells || []) {
    if (colMap.has(cell.c) && rowMap.has(cell.r)) cells.push({ ...cell, r: rowMap.get(cell.r), c: colMap.get(cell.c) });
  }
  // A column's member count covers only the customer's own ports.
  const perCol = new Array(cols.length).fill(0);
  for (const cell of cells) if (!cell.k) perCol[cell.c]++;
  return { rows, cols: cols.map((c, i) => ({ ...c, memberCount: perCol[i] })), cells };
}

// Full snapshot → the same shape restricted to `scope`. Counts are recomputed
// from what survives so the header never leaks the size of the whole system.
function filterSnapshot(snapshot, scope, meta) {
  if (!snapshot) return snapshot;
  const matrix = filterMatrix(snapshot.matrix || {}, scope);
  const colIdx = new Map(matrix.cols.map((c, i) => [destKey(c.kind, c.name), i]));
  const keepDest = (d) => scope.destKeys.has(destKey(d.kind, d.name));
  const ownMember = (m) => scope.panelKeys.has(m.addr) || scope.panelKeys.has(m.name);
  const reindex = (d) => {
    const members = (d.members || []).filter(ownMember);
    return { ...d, idx: colIdx.has(destKey(d.kind, d.name)) ? colIdx.get(destKey(d.kind, d.name)) : d.idx, members, memberCount: members.length };
  };
  const conferences = (snapshot.conferences || []).filter(keepDest).map(reindex);
  const groups = (snapshot.groups || []).filter(keepDest).map(reindex);
  const panels = (snapshot.panels || []).filter((p) => scope.panelAddrs.has(p.addr))
    .map((p) => ({ ...p, memberships: (p.memberships || []).filter(keepDest) }));

  const nodeIds = new Set(matrix.rows.map((r) => r.nodeId).filter(Boolean));
  const topology = snapshot.topology
    ? { ...snapshot.topology, nodes: (snapshot.topology.nodes || []).filter((n) => nodeIds.has(n.id)) }
    : snapshot.topology;

  const keyEdges = matrix.cells.filter((c) => c.k).length;
  const counts = {
    ...(snapshot.counts || {}),
    ports: panels.length, panels: panels.length, conferences: conferences.length, groups: groups.length,
    memberEdges: matrix.cells.length - keyEdges, keyEdges, cells: matrix.cells.length,
  };
  return { ...snapshot, counts, topology, conferences, groups, panels, matrix, scope: meta || null };
}

// A print diff restricted to the customer's own ports: member changes on other
// ports are dropped, and a conference is kept only if one of its changes is theirs
// (or it was added/removed wholesale and is one of theirs). Summary recounted.
function filterPrintDiff(diff, scope) {
  const conferences = (diff.conferences || [])
    .map((c) => ({ ...c, members: (c.members || []).filter((m) => scope.panelKeys.has(m.panel)) }))
    .filter((c) => c.members.length > 0 || (c.status !== 'changed' && scope.confNames.has(c.name)));
  const summary = { confAdded: 0, confRemoved: 0, membersAdded: 0, membersRemoved: 0, dirChanged: 0, changedConferences: conferences.length };
  for (const c of conferences) {
    if (c.status === 'added') summary.confAdded++;
    if (c.status === 'removed') summary.confRemoved++;
    for (const m of c.members || []) {
      if (m.status === 'added') summary.membersAdded++;
      else if (m.status === 'removed') summary.membersRemoved++;
      else if (m.status === 'changed') summary.dirChanged++;
    }
  }
  return { ...diff, summary, conferences };
}

// Is one normalized change item (a change_items row) inside the scope?
// New conferences are the customer's own; everything else must name a visible
// conference, and member ops must name a visible panel.
function itemInScope(scope, it) {
  // A viewer in no customer group (or whose panels are all gone) may request nothing.
  if (!scope.matchedSources.length) return false;
  const panelOk = () => scope.panelKeys.has(it.panel_addr) || scope.panelKeys.has(it.panel_name);
  if (it.type === 'create_conference') return true;
  const confOk = !!it.is_new_conference || scope.confNames.has(it.conference_name);
  if (!confOk) return false;
  if (it.type === 'rename_conference' || it.type === 'delete_conference') return true;
  return panelOk();
}

// A request is visible to a scoped user when they raised it, or when every item
// targets one of their conferences AND names only their own ports (a colleague's
// request on the same channels). New conferences are private to their requester.
function requestVisible(scope, userId, req) {
  if (userId && req.requesterId === userId) return true;
  const items = req.items || [];
  if (!items.length) return false;
  const portOk = (it) => (!it.panel_addr && !it.panel_name) || scope.panelKeys.has(it.panel_addr) || scope.panelKeys.has(it.panel_name);
  return items.every((it) => it.type !== 'create_conference' && !it.is_new_conference && scope.confNames.has(it.conference_name) && portOk(it));
}

function assertItemsInScope(scope, items) {
  const bad = (items || []).find((it) => !itemInScope(scope, it));
  if (bad) {
    const what = bad.panel_name ? `${bad.panel_name} on ${bad.conference_name}` : bad.conference_name;
    const err = new Error(`"${what}" is outside your customer group`);
    err.status = 403;
    throw err;
  }
}

module.exports = { resolveScope, filterSnapshot, filterPrintDiff, requestVisible, assertItemsInScope, itemInScope, destKey };
