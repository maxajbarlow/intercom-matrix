'use strict';
// Unit tests for public/cust-model.js — the pure model behind Settings →
// Customers (search-to-add panels across systems, member rows + suggestions).

const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../public/cust-model.js');

const P = (name, { addr = name, type = '', confs = 1 } = {}) =>
  ({ name, addr, type, memberships: Array.from({ length: confs }, (_, i) => ({ name: 'c' + i })) });
const SYSTEMS = [{ id: 'f1', name: 'F1' }, { id: 'roc', name: 'ROC Geneva' }];
const PANELS = {
  f1: [P('Ferrari Car 2'), P('Ferrari Car 10'), P('Ferrari Pit', { type: 'Bolero Wireless Beltpack' }), P('Mercedes Car 1'), P('FIA RC', { addr: '1.2.1' })],
  roc: [P('[FiA] Bolero 1', { type: 'Bolero Wireless Beltpack' }), P('[FiA] Desk')],
};
const src = (system, name, addr = name) => ({ system, addr, name });

test('matches: every token must appear in name, address, type or system name', () => {
  const item = { ...P('Ferrari Pit', { type: 'Bolero Wireless Beltpack' }), sysName: 'F1' };
  assert.ok(M.matches(item, ''));
  assert.ok(M.matches(item, 'ferrari'));
  assert.ok(M.matches(item, 'bolero ferrari'), 'type is searchable');
  assert.ok(M.matches(item, 'f1 pit'), 'system name is searchable');
  assert.ok(!M.matches(item, 'ferrari mercedes'));
  assert.ok(M.matches({ ...P('FIA RC', { addr: '1.2.1' }) }, '1.2.1'), 'address is searchable');
});

test('resolveSources: groups sources by system in system order, matched address-first then by name', () => {
  const groups = M.resolveSources(PANELS, SYSTEMS, [src('roc', '[FiA] Desk'), src('f1', 'renamed', '1.2.1'), src('f1', 'Ferrari Car 2', 'old-addr')]);
  assert.deepStrictEqual(groups.map((g) => g.system), ['f1', 'roc']);
  assert.deepStrictEqual(groups[0].items.map((i) => i.name), ['Ferrari Car 2', 'FIA RC'], 'natural sort; current names shown');
  assert.equal(groups[0].sysName, 'F1');
  assert.ok(groups[0].items.every((i) => i.key && i.source));
});

test('resolveSources: a source no longer in the print stays listed, flagged missing', () => {
  const [g] = M.resolveSources(PANELS, SYSTEMS, [src('f1', 'Old Desk')]);
  assert.equal(g.items.length, 1);
  assert.equal(g.items[0].missing, true);
  assert.equal(g.items[0].name, 'Old Desk');
});

test('resolveSources: a source on an unknown system is kept under its system id', () => {
  const groups = M.resolveSources(PANELS, SYSTEMS, [src('gone', 'Desk')]);
  assert.equal(groups[0].system, 'gone');
  assert.equal(groups[0].sysName, 'gone');
  assert.equal(groups[0].items[0].missing, true);
});

test('search: empty query returns nothing', () => {
  const r = M.search(PANELS, SYSTEMS, [], '  ');
  assert.equal(r.total, 0);
  assert.deepStrictEqual(r.groups, []);
});

test('search: matches across every system, grouped, with already-added panels flagged', () => {
  const r = M.search(PANELS, SYSTEMS, [src('f1', 'Ferrari Car 2')], 'ferrari');
  assert.equal(r.total, 3);
  assert.deepStrictEqual(r.fresh.map((i) => i.name), ['Ferrari Car 10', 'Ferrari Pit'], 'fresh = matches not yet added');
  assert.deepStrictEqual(r.groups.map((g) => g.system), ['f1']);
  assert.deepStrictEqual(r.groups[0].items.map((i) => [i.name, i.added]), [['Ferrari Car 2', true], ['Ferrari Car 10', false], ['Ferrari Pit', false]]);
  const fia = M.search(PANELS, SYSTEMS, [], 'fia');
  assert.deepStrictEqual(fia.groups.map((g) => g.system), ['f1', 'roc']);
});

test('search: an added panel carries the stored source key, even when matched by name', () => {
  const r = M.search(PANELS, SYSTEMS, [src('f1', 'FIA RC', 'old-addr')], 'fia rc');
  const hit = r.groups[0].items[0];
  assert.equal(hit.added, true);
  assert.equal(hit.sourceKey, M.sourceKey('f1', 'old-addr'));
  assert.deepStrictEqual(M.removeSources([src('f1', 'FIA RC', 'old-addr')], [hit.sourceKey]), []);
});

test('search: limit caps the rows shown but not total/fresh', () => {
  const r = M.search(PANELS, SYSTEMS, [], 'a', 2);
  assert.ok(r.total > 2);
  assert.equal(r.shown, 2);
  assert.equal(r.groups.reduce((n, g) => n + g.items.length, 0), 2);
  assert.equal(r.fresh.length, r.total);
});

test('addSources / removeSources return new arrays and dedupe by system + address', () => {
  const start = [src('f1', 'Ferrari Car 2')];
  const added = M.addSources(start, [{ system: 'f1', addr: 'Ferrari Car 2', name: 'Ferrari Car 2' }, { system: 'roc', addr: '[FiA] Desk', name: '[FiA] Desk' }]);
  assert.equal(start.length, 1, 'input untouched');
  assert.deepStrictEqual(added.map((s) => s.name), ['Ferrari Car 2', '[FiA] Desk']);
  const removed = M.removeSources(added, [M.sourceKey('f1', 'Ferrari Car 2')]);
  assert.deepStrictEqual(removed.map((s) => s.name), ['[FiA] Desk']);
  assert.equal(added.length, 2, 'input untouched');
});

const USERS = [
  { username: 'ferrari.eng', display_name: 'Ferrari Engineer', role: 'viewer' },
  { username: 'fia.steward', display_name: null, role: 'viewer' },
  { username: 'ops', display_name: null, role: 'editor' },
];

test('memberRows: local accounts, directory users and directory groups, each tagged', () => {
  const rows = M.memberRows({ users: ['FERRARI.ENG', 'jsmith', 'ops'], dirGroups: ['cn=fia,dc=corp'] }, USERS);
  assert.deepStrictEqual(rows.map((r) => [r.kind, r.value, r.label]), [
    ['local', 'FERRARI.ENG', 'Ferrari Engineer'],
    ['local', 'ops', 'ops'],
    ['user', 'jsmith', 'jsmith'],
    ['group', 'cn=fia,dc=corp', 'cn=fia,dc=corp'],
  ]);
  assert.equal(rows[1].unscoped, true, 'an editor is never scoped');
  assert.ok(!rows[0].unscoped);
});

test('memberSuggestions: viewer accounts not yet in the group; everything on an empty query', () => {
  const cust = { users: ['fia.steward'], dirGroups: [] };
  assert.deepStrictEqual(M.memberSuggestions('', cust, USERS, false).map((s) => s.value), ['ferrari.eng'], 'editors and existing members excluded');
  assert.deepStrictEqual(M.memberSuggestions('engineer', cust, USERS, false).map((s) => s.value), ['ferrari.eng'], 'display name searchable');
  assert.deepStrictEqual(M.memberSuggestions('nobody', cust, USERS, false), []);
});

test('memberSuggestions: with a directory enabled, offers the typed text as a user and/or group', () => {
  const cust = { users: [], dirGroups: [] };
  const s = M.memberSuggestions('jsmith', cust, USERS, true);
  assert.deepStrictEqual(s.map((x) => [x.kind, x.value]), [['user', 'jsmith'], ['group', 'jsmith']]);
  const dn = M.memberSuggestions('CN=FIA RC,OU=Groups', cust, USERS, true);
  assert.deepStrictEqual(dn.map((x) => x.kind), ['group'], 'a DN is not a valid username');
  const exact = M.memberSuggestions('ferrari.eng', cust, USERS, true);
  assert.deepStrictEqual(exact.map((x) => x.kind), ['local', 'group'], 'no duplicate "directory user" for an existing account');
  const has = M.memberSuggestions('cn=x', { users: [], dirGroups: ['cn=x'] }, USERS, true);
  assert.deepStrictEqual(has, [], 'no suggestion for a group already present');
});

test('addMember / removeMember return new customer member lists', () => {
  const cust = { users: ['a1'], dirGroups: [] };
  const u = M.addMember(cust, { kind: 'user', value: 'b2' });
  assert.deepStrictEqual(u, { users: ['a1', 'b2'], dirGroups: [] });
  const g = M.addMember(cust, { kind: 'group', value: 'CN=X' });
  assert.deepStrictEqual(g.dirGroups, ['cn=x'], 'directory groups are stored lowercased');
  assert.deepStrictEqual(M.addMember(u, { kind: 'local', value: 'B2' }).users, ['a1', 'b2'], 'case-insensitive dedupe');
  assert.deepStrictEqual(M.removeMember(u, { kind: 'user', value: 'B2' }).users, ['a1']);
  assert.deepStrictEqual(M.removeMember(g, { kind: 'group', value: 'cn=x' }).dirGroups, []);
  assert.deepStrictEqual(cust, { users: ['a1'], dirGroups: [] }, 'input untouched');
});
