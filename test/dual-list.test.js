'use strict';
// Unit tests for public/dual-list.js — the pure model behind the customer-group
// panel picker (Available ⇄ Active group transfer list). No DOM here.

const { test } = require('node:test');
const assert = require('node:assert');
const DL = require('../public/dual-list.js');

const P = (name, addr = name, confs = 1) => ({ name, addr, memberships: Array.from({ length: confs }, (_, i) => ({ name: 'c' + i })) });
const panels = [P('RC-10'), P('RC-2'), P('RC-1'), P('SYS-1', '1.2.1'), P('TV Gallery', '1.9.1')];

test('matches: every whitespace token must appear in name or address (case-insensitive)', () => {
  assert.ok(DL.matches(P('RC-1'), ''));
  assert.ok(DL.matches(P('RC-1'), 'rc'));
  assert.ok(DL.matches(P('TV Gallery', '1.9.1'), 'tv 1.9'));
  assert.ok(!DL.matches(P('TV Gallery', '1.9.1'), 'tv sys'));
  assert.ok(DL.matches(P('SYS-1', '1.2.1'), '1.2.1'));
});

test('splitSources: chosen = sources matched to panels (address first, then name); rest available', () => {
  const { available, chosen } = DL.splitSources(panels, [{ addr: '1.2.1', name: 'renamed' }, { addr: 'x', name: 'RC-2' }]);
  assert.deepStrictEqual(chosen.map((c) => c.name), ['RC-2', 'SYS-1']);
  assert.deepStrictEqual(available.map((a) => a.name), ['RC-1', 'RC-10', 'TV Gallery'], 'natural sort: RC-1 < RC-10');
  assert.ok(chosen.every((c) => c.source), 'chosen items keep their stored source');
});

test('splitSources: a source missing from the current data is kept (flagged) on the chosen side', () => {
  const { chosen } = DL.splitSources(panels, [{ addr: 'gone', name: 'Old Desk' }]);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].missing, true);
  assert.equal(chosen[0].name, 'Old Desk');
});

test('splitSources: duplicate sources for the same panel collapse to one chosen row', () => {
  const { chosen } = DL.splitSources(panels, [{ addr: 'RC-1', name: 'RC-1' }, { addr: 'zz', name: 'RC-1' }]);
  assert.equal(chosen.length, 1);
});

test('toggle returns a NEW set and never mutates the input', () => {
  const a = new Set(['x']);
  const b = DL.toggle(a, 'y');
  const c = DL.toggle(b, 'x');
  assert.deepStrictEqual([...a], ['x']);
  assert.deepStrictEqual([...b].sort(), ['x', 'y']);
  assert.deepStrictEqual([...c], ['y']);
});

test('range: shift-click selects the inclusive run between anchor and target in visible order', () => {
  const visible = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(DL.range(visible, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepStrictEqual(DL.range(visible, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepStrictEqual(DL.range(visible, 'zz', 'c'), ['c'], 'anchor filtered out → just the target');
});

test('visibleSelected: only selected keys that pass the current filter act on a move', () => {
  const items = [P('RC-1'), P('RC-2'), P('SYS-1')].map((p) => ({ ...p, key: p.addr }));
  const sel = new Set(['RC-1', 'SYS-1']);
  assert.deepStrictEqual(DL.visibleSelected(items, sel, 'rc').map((i) => i.key), ['RC-1']);
  assert.deepStrictEqual(DL.visibleSelected(items, sel, '').map((i) => i.key), ['RC-1', 'SYS-1']);
});
