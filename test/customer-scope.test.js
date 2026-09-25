'use strict';
// Unit tests for lib/customer-scope — deriving a customer's visible conferences
// from its SOURCE PANELS, and filtering a snapshot down to that scope.

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveScope, filterSnapshot, filterPrintDiff, requestVisible, assertItemsInScope } = require('../lib/customer-scope');

// A tiny snapshot in the shape rrcs-service produces. Two customers share a
// system: FIA panels (RC-1, RC-2) and SysOps panels (SYS-1). "Shared Mon" is a
// SysOps conference that RC-2 merely has a KEY to.
function snap() {
  const cols = [
    { name: 'Race Control', label: 'RC', kind: 'conference', memberCount: 3 },
    { name: 'Stewards', label: 'STW', kind: 'conference', memberCount: 1 },
    { name: 'SysOps', label: 'SYS', kind: 'conference', memberCount: 1 },
    { name: 'Shared Mon', label: 'MON', kind: 'conference', memberCount: 1 },
    { name: 'All Call', label: 'ALL', kind: 'group', memberCount: 1 },
  ];
  const panel = (addr, name, memberships) => ({ addr, name, type: 'DCP', isPanel: true, twoWire: false, node: null, nodeId: null, card: null, bay: null, memberships });
  const m = (name, kind = 'conference', access = 'member') => ({ name, label: '', kind, access, talk: access === 'member', listen: access === 'member' });
  const panels = [
    panel('1.1.1', 'RC-1', [m('Race Control'), m('Stewards')]),
    panel('1.1.2', 'RC-2', [m('Race Control'), m('Shared Mon', 'conference', 'key')]),
    panel('1.2.1', 'SYS-1', [m('SysOps'), m('Shared Mon'), m('All Call', 'group')]),
    panel('1.3.1', 'Guest', [m('Race Control')]),
  ];
  const mem = (addr, name) => ({ addr, name, type: 'DCP', talk: true, listen: true });
  return {
    ok: true, source: 'rrcs', system: { id: 'f1', name: 'F1' },
    counts: { ports: 4, panels: 4, conferences: 4, groups: 1, memberEdges: 7, keyEdges: 1, keyUnresolved: 0, cells: 8 },
    topology: { loaded: true, nodes: [{ id: '1', name: 'N1', cards: [] }, { id: '2', name: 'N2', cards: [] }] },
    conferences: [
      { idx: 0, kind: 'conference', name: 'Race Control', label: 'RC', memberCount: 3, members: [mem('1.1.1', 'RC-1'), mem('1.1.2', 'RC-2'), mem('1.3.1', 'Guest')] },
      { idx: 1, kind: 'conference', name: 'Stewards', label: 'STW', memberCount: 1, members: [mem('1.1.1', 'RC-1')] },
      { idx: 2, kind: 'conference', name: 'SysOps', label: 'SYS', memberCount: 1, members: [mem('1.2.1', 'SYS-1')] },
      { idx: 3, kind: 'conference', name: 'Shared Mon', label: 'MON', memberCount: 1, members: [mem('1.2.1', 'SYS-1')] },
    ],
    groups: [{ idx: 4, kind: 'group', name: 'All Call', label: 'ALL', memberCount: 1, members: [mem('1.2.1', 'SYS-1')] }],
    panels,
    matrix: {
      rows: panels.map((p) => ({ addr: p.addr, name: p.name, type: p.type, isPanel: true, twoWire: false, nodeId: p.addr.split('.')[1], node: null, card: null, bay: null })),
      cols,
      cells: [
        { r: 0, c: 0, t: 1, l: 1, k: 0 }, { r: 0, c: 1, t: 1, l: 1, k: 0 },
        { r: 1, c: 0, t: 1, l: 1, k: 0 }, { r: 1, c: 3, t: 0, l: 0, k: 1 },
        { r: 2, c: 2, t: 1, l: 1, k: 0 }, { r: 2, c: 3, t: 1, l: 1, k: 0 }, { r: 2, c: 4, t: 1, l: 1, k: 0 },
        { r: 3, c: 0, t: 1, l: 1, k: 0 },
      ],
    },
  };
}
const FIA = [{ addr: '1.1.1', name: 'RC-1' }, { addr: '1.1.2', name: 'RC-2' }];

test('resolveScope: conferences come from source panels, including key access', () => {
  const s = resolveScope(snap(), FIA);
  assert.deepStrictEqual([...s.confNames].sort(), ['Race Control', 'Shared Mon', 'Stewards']);
  assert.ok(!s.confNames.has('SysOps'));
});

test('resolveScope: visible panels are every participant of the visible conferences', () => {
  const s = resolveScope(snap(), FIA);
  // Guest is on Race Control; SYS-1 is on Shared Mon — both participants
  assert.deepStrictEqual([...s.panelAddrs].sort(), ['1.1.1', '1.1.2', '1.2.1', '1.3.1']);
});

test('resolveScope: matches by address first, falls back to name (renamed panel still resolves)', () => {
  const byName = resolveScope(snap(), [{ addr: '9.9.9', name: 'RC-1' }]);
  assert.ok(byName.confNames.has('Stewards'));
  const byAddr = resolveScope(snap(), [{ addr: '1.1.1', name: 'renamed in Director' }]);
  assert.ok(byAddr.confNames.has('Stewards'));
});

test('resolveScope: reports source panels not found in the current snapshot', () => {
  const s = resolveScope(snap(), [...FIA, { addr: '7.7.7', name: 'Gone' }]);
  assert.deepStrictEqual(s.missingSources.map((x) => x.name), ['Gone']);
  assert.equal(s.matchedSources.length, 2);
});

test('resolveScope: a conference newly added to a source panel appears automatically', () => {
  const next = snap();
  next.panels[0].memberships.push({ name: 'New FIA Channel', label: '', kind: 'conference', access: 'member', talk: true, listen: true });
  assert.ok(resolveScope(next, FIA).confNames.has('New FIA Channel'));
});

test('resolveScope: empty / missing sources give an empty scope', () => {
  const s = resolveScope(snap(), []);
  assert.equal(s.confNames.size, 0);
  assert.equal(s.panelAddrs.size, 0);
  assert.equal(resolveScope(null, FIA).confNames.size, 0);
});

test('filterSnapshot: keeps only in-scope columns, rows and remapped cells', () => {
  const src = snap();
  const out = filterSnapshot(src, resolveScope(src, FIA));
  assert.deepStrictEqual(out.matrix.cols.map((c) => c.name), ['Race Control', 'Stewards', 'Shared Mon']);
  assert.deepStrictEqual(out.matrix.rows.map((r) => r.name), ['RC-1', 'RC-2', 'SYS-1', 'Guest']);
  // every cell points inside the new bounds
  for (const c of out.matrix.cells) {
    assert.ok(c.r >= 0 && c.r < out.matrix.rows.length);
    assert.ok(c.c >= 0 && c.c < out.matrix.cols.length);
  }
  // SYS-1 keeps only its Shared Mon cell (its SysOps + All Call cells are dropped)
  const sysRow = out.matrix.rows.findIndex((r) => r.name === 'SYS-1');
  const sysCells = out.matrix.cells.filter((c) => c.r === sysRow).map((c) => out.matrix.cols[c.c].name);
  assert.deepStrictEqual(sysCells, ['Shared Mon']);
});

test('filterSnapshot: conference/group lists, panel memberships and counts are scoped', () => {
  const src = snap();
  const out = filterSnapshot(src, resolveScope(src, FIA));
  assert.deepStrictEqual(out.conferences.map((c) => c.name), ['Race Control', 'Stewards', 'Shared Mon']);
  assert.deepStrictEqual(out.groups, []);
  // idx points at the conference's new column
  for (const c of out.conferences) assert.equal(out.matrix.cols[c.idx].name, c.name);
  const sys = out.panels.find((p) => p.name === 'SYS-1');
  assert.deepStrictEqual(sys.memberships.map((m) => m.name), ['Shared Mon']);
  assert.equal(out.counts.conferences, 3);
  assert.equal(out.counts.groups, 0);
  assert.equal(out.counts.panels, 4);
  assert.equal(out.counts.cells, out.matrix.cells.length);
  assert.equal(out.counts.keyEdges, 1);
});

test('filterSnapshot: never mutates the source snapshot', () => {
  const src = snap();
  const before = JSON.stringify(src);
  filterSnapshot(src, resolveScope(src, FIA));
  assert.equal(JSON.stringify(src), before);
});

test('filterSnapshot: an empty scope yields an empty (but well-formed) snapshot', () => {
  const src = snap();
  const out = filterSnapshot(src, resolveScope(src, []));
  assert.equal(out.ok, true);
  assert.deepStrictEqual(out.matrix, { rows: [], cols: [], cells: [] });
  assert.deepStrictEqual(out.panels, []);
  assert.deepStrictEqual(out.conferences, []);
});

test('filterSnapshot: topology nodes are limited to nodes with visible rows', () => {
  const src = snap();
  const out = filterSnapshot(src, resolveScope(src, [{ addr: '1.1.1', name: 'RC-1' }]));
  // RC-1 → Race Control + Stewards → participants on nodes 1 and 3 only
  assert.deepStrictEqual(out.topology.nodes.map((n) => n.id), ['1']);
});

test('filterPrintDiff: only conferences in scope, summary recomputed', () => {
  const diff = {
    summary: { confAdded: 1, confRemoved: 0, membersAdded: 2, membersRemoved: 1, dirChanged: 0, changedConferences: 2 },
    conferences: [
      { name: 'Race Control', status: 'changed', members: [{ panel: 'X', status: 'added' }, { panel: 'Y', status: 'removed' }] },
      { name: 'SysOps', status: 'added', members: [{ panel: 'SYS-1', status: 'added' }] },
    ],
  };
  const out = filterPrintDiff(diff, resolveScope(snap(), FIA));
  assert.deepStrictEqual(out.conferences.map((c) => c.name), ['Race Control']);
  assert.deepStrictEqual(out.summary, { confAdded: 0, confRemoved: 0, membersAdded: 1, membersRemoved: 1, dirChanged: 0, changedConferences: 1 });
});

test('requestVisible: own requests always; others only when every item is in scope', () => {
  const scope = resolveScope(snap(), FIA);
  const mine = { requesterId: 'fia1', items: [{ type: 'create_conference', conference_name: 'Brand new' }] };
  assert.ok(requestVisible(scope, 'fia1', mine));
  assert.ok(!requestVisible(scope, 'someone', mine));
  const inScope = { requesterId: 'x', items: [{ type: 'add_member', conference_name: 'Race Control' }] };
  assert.ok(requestVisible(scope, 'fia1', inScope));
  const mixed = { requesterId: 'x', items: [{ type: 'add_member', conference_name: 'Race Control' }, { type: 'remove_member', conference_name: 'SysOps' }] };
  assert.ok(!requestVisible(scope, 'fia1', mixed));
});

test('assertItemsInScope: rejects changes to out-of-scope conferences or panels', () => {
  const scope = resolveScope(snap(), FIA);
  const ok = (items) => assert.doesNotThrow(() => assertItemsInScope(scope, items));
  const bad = (items) => assert.throws(() => assertItemsInScope(scope, items), /outside your customer group/);
  ok([{ type: 'add_member', conference_name: 'Race Control', panel_addr: '1.1.2', panel_name: 'RC-2' }]);
  ok([{ type: 'create_conference', conference_name: 'FIA new', is_new_conference: true }]);
  ok([{ type: 'add_member', conference_name: 'FIA new', is_new_conference: true, panel_addr: 'RC-1', panel_name: 'RC-1' }]);
  bad([{ type: 'remove_member', conference_name: 'SysOps', panel_addr: '1.2.1', panel_name: 'SYS-1' }]);
  bad([{ type: 'delete_conference', conference_name: 'SysOps' }]);
  bad([{ type: 'add_member', conference_name: 'Race Control', panel_addr: '5.5.5', panel_name: 'Elsewhere' }]);
});

test('assertItemsInScope: an empty scope may not even create a conference', () => {
  const empty = resolveScope(snap(), []);
  assert.throws(() => assertItemsInScope(empty, [{ type: 'create_conference', conference_name: 'Spam', is_new_conference: true }]), /outside your customer group/);
});
