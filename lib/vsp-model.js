// vsp-model.js — turn a VSP export JSON into the same snapshot shape the rest of
// the app consumes (matrix / conferences / panels), exactly like buildPrintModel
// does for config prints. Bring your own export at the path named by a system's
// `vsp` field in systems.json (see the README "Virtual system" section).
//
// VSP export shape:
//   { source:'vsp', system, generatedAt,
//     ports:   [{ uuid, label, longName, trunk, systemId }],          // rows
//     targets: [{ uuid, label, kind:'conference'|'member'|'group'|'ifb' }], // columns
//     cells:   [{ portUuid, targetUuid, talk, listen }] }                   // Talk/Listen
//
// A key talks and/or monitors (= listens) a target intercom member or
// conference; that is the comm matrix.

function buildVspModel(def, exp) {
  const ports = Array.isArray(exp.ports) ? exp.ports : [];
  const targets = Array.isArray(exp.targets) ? exp.targets : [];
  const cells = Array.isArray(exp.cells) ? exp.cells : [];

  const rowIdx = new Map(ports.map((p, i) => [p.uuid, i]));
  const colIdx = new Map(targets.map((t, i) => [t.uuid, i]));
  const portName = (p) => p.label || p.longName || p.uuid;

  // A panel usually has several keys to the same target (a Talk-only key, a
  // Listen-only key, or the same target programmed across pages). Each is a
  // separate cell in the export, but the comm relationship is the UNION: the
  // panel talks to the target if ANY key talks, listens if ANY key listens.
  // Merge per (port, target) before building the matrix — otherwise duplicate
  // cells stack at the same grid position (last-painted wins, so a Talk+Listen
  // pair can show as Listen-only) and conference member counts double-count.
  const merged = new Map(); // "r:ci" -> { r, ci, talk, listen }
  for (const c of cells) {
    const r = rowIdx.get(c.portUuid), ci = colIdx.get(c.targetUuid);
    if (r == null || ci == null) continue;
    const k = r + ':' + ci;
    const m = merged.get(k);
    if (m) { m.talk = m.talk || !!c.talk; m.listen = m.listen || !!c.listen; }
    else merged.set(k, { r, ci, talk: !!c.talk, listen: !!c.listen });
  }

  // sparse matrix cells
  const mcells = [];
  // reverse indexes for the conference/panel detail views
  const byTarget = new Map(targets.map((t) => [t.uuid, []])); // members of a target
  const byPort = new Map(ports.map((p) => [p.uuid, []]));      // a port's memberships
  for (const { r, ci, talk, listen } of merged.values()) {
    mcells.push({ r, c: ci, t: talk ? 1 : 0, l: listen ? 1 : 0, k: 0 });
    const p = ports[r], t = targets[ci];
    byTarget.get(t.uuid).push({ addr: p.longName || portName(p), name: portName(p), type: p.trunk ? 'trunked' : '', talk, listen });
    byPort.get(p.uuid).push({ name: t.label || t.uuid, label: '', kind: t.kind === 'conference' ? 'conference' : t.kind, access: 'member', talk, listen });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);

  const conferences = targets.map((t, i) => {
    const members = (byTarget.get(t.uuid) || []).sort(byName);
    return { idx: i, kind: t.kind === 'conference' ? 'conference' : 'conference', name: t.label || t.uuid, label: t.kind === 'member' ? 'direct' : '', memberCount: members.length, members };
  });

  const panels = ports.map((p) => ({
    addr: p.longName || portName(p), name: portName(p), type: p.trunk ? 'trunked' : '', isPanel: true, twoWire: false,
    node: null, nodeId: null, card: null, bay: null,
    memberships: (byPort.get(p.uuid) || []).sort(byName),
  }));

  return {
    ok: true, error: null, source: 'vsp', system: { id: def.id, name: def.name }, host: null, port: null,
    fetchedAt: exp.generatedAt || new Date().toISOString(),
    config: { loaded: false },
    topology: { loaded: false, name: null, loadedAt: null, nodeCount: 0, cardCount: 0, ports: 0, nodes: [] },
    counts: { ports: ports.length, panels: ports.length, conferences: targets.length, groups: 0, memberEdges: mcells.length, keyEdges: 0, keyUnresolved: 0, cells: mcells.length },
    conferences,
    groups: [],
    panels,
    matrix: {
      rows: ports.map((p) => ({ addr: p.longName || portName(p), name: portName(p), type: p.trunk ? 'trunked' : '', isPanel: true, twoWire: false, nodeId: null, node: null, card: null, bay: null })),
      cols: targets.map((t) => ({ name: t.label || t.uuid, label: t.kind === 'member' ? 'direct' : '', kind: t.kind === 'conference' ? 'conference' : 'conference', memberCount: (byTarget.get(t.uuid) || []).length })),
      cells: mcells,
    },
  };
}

// Read + validate a VSP export file.
function loadVspExport(text) {
  const exp = typeof text === 'string' ? JSON.parse(text) : text;
  if (!exp || exp.source !== 'vsp' || !Array.isArray(exp.ports)) throw new Error('not a VSP export (expected { source:"vsp", ports:[...] })');
  return exp;
}

module.exports = { buildVspModel, loadVspExport };
