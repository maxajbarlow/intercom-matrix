'use strict';
// Unit tests for lib/combined-model — merging per-system snapshots into one
// "All systems" snapshot: rows from every system, conference columns merged
// across systems (lib/conference-match), everything tagged with its system.

const { test } = require('node:test');
const assert = require('node:assert');
const { combine, ALL_ID } = require('../lib/combined-model');

// A per-system snapshot in the shape lib/print-model builds.
function snap(id, name, dests, panels, extra = {}) {
  const cols = dests.map(([n, label, kind = 'conference']) => ({ name: n, label, kind, memberCount: 0 }));
  const rows = panels.map(([p]) => ({ addr: p, name: p, type: '', isPanel: true, twoWire: false, nodeId: extra.nodeId || null, node: extra.node || null, card: null, bay: null }));
  const cells = [];
  const members = new Map(cols.map((c) => [c.name, []]));
  panels.forEach(([p, confs], r) => confs.forEach((cn) => {
    const c = cols.findIndex((x) => x.name === cn);
    cells.push({ r, c, t: 1, l: 1, k: 0 }); cols[c].memberCount++;
    members.get(cn).push({ addr: p, name: p, type: '', talk: true, listen: true });
  }));
  const mk = (kind) => cols.map((c, idx) => ({ ...c, idx })).filter((c) => c.kind === kind).map((c) => ({ idx: c.idx, kind, name: c.name, label: c.label, memberCount: c.memberCount, members: members.get(c.name) }));
  return {
    ok: true, error: null, source: 'print', system: { id, name }, fetchedAt: extra.fetchedAt || '2026-09-01T00:00:00.000Z',
    topology: { loaded: !!extra.nodeId, nodes: extra.nodeId ? [{ id: extra.nodeId, name: extra.node, cards: [] }] : [] },
    counts: { ports: rows.length, panels: rows.length, conferences: mk('conference').length, groups: mk('group').length, memberEdges: cells.length, keyEdges: 0, cells: cells.length },
    conferences: mk('conference'), groups: mk('group'),
    panels: panels.map(([p, confs]) => ({ addr: p, name: p, type: '', isPanel: true, nodeId: extra.nodeId || null, node: extra.node || null, memberships: confs.map((cn) => ({ name: cn, label: '', kind: 'conference', access: 'member', talk: true, listen: true })) })),
    matrix: { rows, cols, cells },
  };
}

const SYSTEMS = [{ id: 'f1', name: 'F1' }, { id: 'f2f3', name: 'F2 / F3' }, { id: 'roc', name: 'ROC Geneva' }];
const F1 = snap('f1', 'F1', [['Race Control', 'RC'], ['F1 Only', 'X']], [['RC-1', ['Race Control', 'F1 Only']], ['RC-2', ['Race Control']]], { nodeId: '1', node: 'Core', fetchedAt: '2026-09-02T00:00:00.000Z' });
const F2 = snap('f2f3', 'F2 / F3', [['IM-Race Control', 'RC'], ['F2 Only', 'Y']], [['F2-RC', ['IM-Race Control', 'F2 Only']]], { nodeId: '1', node: 'Core' });
const ROC = snap('roc', 'ROC Geneva', [['[FIA] RACE CONTROL', 'RC']], [['ROC-1', ['[FIA] RACE CONTROL']]]);
const all = () => combine(SYSTEMS, { f1: F1, f2f3: F2, roc: ROC });

test('combine: identifies itself as the All systems view', () => {
  const s = all();
  assert.equal(ALL_ID, 'all');
  assert.deepStrictEqual(s.system, { id: 'all', name: 'All systems' });
  assert.equal(s.ok, true);
  assert.deepStrictEqual(s.systems, SYSTEMS);
  assert.equal(s.fetchedAt, '2026-09-02T00:00:00.000Z', 'newest print wins');
});

test('combine: rows are every system\'s panels, in system order, tagged and uniquely keyed', () => {
  const s = all();
  assert.deepStrictEqual(s.matrix.rows.map((r) => [r.system, r.name]), [['f1', 'RC-1'], ['f1', 'RC-2'], ['f2f3', 'F2-RC'], ['roc', 'ROC-1']]);
  assert.equal(new Set(s.matrix.rows.map((r) => r.addr)).size, 4);
  assert.equal(s.matrix.rows[0].port, 'RC-1', 'the real port name is kept');
  assert.equal(s.matrix.rows[0].sysName, 'F1');
});

test('combine: matched conferences become one column with per-system real names', () => {
  const s = all();
  assert.deepStrictEqual(s.matrix.cols.map((c) => c.name), ['Race Control', 'F1 Only', 'F2 Only']);
  const rc = s.matrix.cols[0];
  assert.equal(rc.matched, true);
  assert.deepStrictEqual(rc.variants.map((v) => `${v.sysName}: ${v.name}`), ['F1: Race Control', 'F2 / F3: IM-Race Control', 'ROC Geneva: [FIA] RACE CONTROL']);
  assert.equal(rc.memberCount, 4);
});

test('combine: cells land on the merged column for every system', () => {
  const s = all();
  const at = (row, col) => s.matrix.cells.some((c) => s.matrix.rows[c.r].name === row && s.matrix.cols[c.c].name === col);
  assert.ok(at('RC-1', 'Race Control') && at('F2-RC', 'Race Control') && at('ROC-1', 'Race Control'));
  assert.ok(at('RC-1', 'F1 Only') && at('F2-RC', 'F2 Only'));
  assert.equal(s.matrix.cells.length, 6);
  for (const c of s.matrix.cells) assert.ok(c.r < s.matrix.rows.length && c.c < s.matrix.cols.length);
});

test('combine: conference lists carry systems, variants and system-tagged members', () => {
  const s = all();
  const rc = s.conferences.find((c) => c.name === 'Race Control');
  assert.equal(s.matrix.cols[rc.idx].name, 'Race Control');
  assert.deepStrictEqual(rc.systems, ['f1', 'f2f3', 'roc']);
  assert.deepStrictEqual(rc.members.map((m) => `${m.sysName}/${m.port}`), ['F1/RC-1', 'F1/RC-2', 'F2 / F3/F2-RC', 'ROC Geneva/ROC-1']);
  assert.equal(rc.memberCount, 4);
  assert.deepStrictEqual(s.conferences.find((c) => c.name === 'F2 Only').systems, ['f2f3']);
});

test('combine: panel memberships use the merged name and keep the real one', () => {
  const s = all();
  const f2 = s.panels.find((p) => p.name === 'F2-RC');
  const m = f2.memberships.find((x) => x.name === 'Race Control');
  assert.equal(m.realName, 'IM-Race Control');
  assert.equal(s.matrix.cols[m.col].name, 'Race Control', 'links by column index, not name');
  assert.equal(f2.system, 'f2f3');
  assert.equal(f2.addr, s.matrix.rows.find((r) => r.name === 'F2-RC').addr);
});

test('combine: topology nodes are kept apart per system', () => {
  const s = all();
  assert.deepStrictEqual(s.topology.nodes.map((n) => n.name), ['F1 · Core', 'F2 / F3 · Core']);
  assert.equal(new Set(s.topology.nodes.map((n) => n.id)).size, 2);
  const row = s.matrix.rows.find((r) => r.name === 'F2-RC');
  assert.ok(s.topology.nodes.some((n) => n.id === row.nodeId));
});

test('combine: counts are recomputed for the merged view', () => {
  const c = all().counts;
  assert.equal(c.panels, 4);
  assert.equal(c.conferences, 3);
  assert.equal(c.matchedConferences, 1);
  assert.equal(c.memberEdges, 6);
});

test('combine: systems without a loaded print are skipped; none at all is not ok', () => {
  const empty = { ok: false, error: 'no config print', system: { id: 'roc', name: 'ROC Geneva' }, counts: {}, conferences: [], groups: [], panels: [], matrix: { rows: [], cols: [], cells: [] } };
  const s = combine(SYSTEMS, { f1: F1, roc: empty });
  assert.deepStrictEqual([...new Set(s.matrix.rows.map((r) => r.system))], ['f1']);
  assert.deepStrictEqual(s.systems.map((x) => x.id), ['f1']);
  const none = combine(SYSTEMS, { roc: empty });
  assert.equal(none.ok, false);
  assert.match(none.error, /no config print/i);
});

test('combine: never mutates the input snapshots', () => {
  const before = JSON.stringify([F1, F2, ROC]);
  all();
  assert.equal(JSON.stringify([F1, F2, ROC]), before);
});
