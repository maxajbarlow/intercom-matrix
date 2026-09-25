'use strict';
// Unit tests for lib/customer-db — customer groups, their source panels, and
// which users / directory groups belong to them. Runs on an in-memory DB.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA } = require('../lib/auth-db');
const cdb = require('../lib/customer-db');

let db;
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec(SCHEMA); });

test('create + list a customer group', () => {
  assert.equal(cdb.hasCustomers(db), false);
  const c = cdb.createCustomer(db, { name: 'FIA Race Control', description: 'FIA' });
  assert.equal(c.name, 'FIA Race Control');
  assert.deepStrictEqual(c.sources, []);
  assert.equal(cdb.hasCustomers(db), true);
  assert.equal(cdb.listCustomers(db).length, 1);
});

test('names are required and unique (case-insensitive)', () => {
  assert.throws(() => cdb.createCustomer(db, { name: '  ' }), /name is required/);
  cdb.createCustomer(db, { name: 'FIA' });
  assert.throws(() => cdb.createCustomer(db, { name: 'fia' }), /already exists/);
});

test('update replaces sources, users and directory groups', () => {
  const c = cdb.createCustomer(db, { name: 'FIA' });
  const u = cdb.updateCustomer(db, c.id, {
    sources: [{ system: 'f1', addr: '1.1.1', name: 'RC-1' }, { system: 'f1', addr: '1.1.2', name: 'RC-2' }, { system: 'f2', addr: 'RC-A', name: 'RC-A' }],
    users: ['fia1', 'FIA2'],
    dirGroups: ['CN=FIA,OU=Groups,DC=corp'],
  });
  assert.equal(u.sources.length, 3);
  assert.deepStrictEqual(u.users, ['fia1', 'FIA2']);   // case-insensitive order
  assert.deepStrictEqual(u.dirGroups, ['cn=fia,ou=groups,dc=corp']);
  const again = cdb.updateCustomer(db, c.id, { sources: [{ system: 'f1', addr: '1.1.1', name: 'RC-1' }] });
  assert.equal(again.sources.length, 1);
  assert.equal(again.users.length, 2, 'omitted fields are left alone');
});

test('update rejects malformed input', () => {
  const c = cdb.createCustomer(db, { name: 'FIA' });
  assert.throws(() => cdb.updateCustomer(db, c.id, { sources: [{ system: '', addr: 'x' }] }), /system/);
  assert.throws(() => cdb.updateCustomer(db, c.id, { sources: [{ system: 'f1' }] }), /panel/);
  assert.throws(() => cdb.updateCustomer(db, c.id, { users: ['bad user!'] }), /username/);
  assert.throws(() => cdb.updateCustomer(db, 999, { name: 'x' }), /not found/);
});

test('sourcesFor returns the union of source panels for the given customers on one system', () => {
  const a = cdb.createCustomer(db, { name: 'FIA' });
  const b = cdb.createCustomer(db, { name: 'SysOps' });
  cdb.updateCustomer(db, a.id, { sources: [{ system: 'f1', addr: '1.1.1', name: 'RC-1' }, { system: 'f2', addr: 'X', name: 'X' }] });
  cdb.updateCustomer(db, b.id, { sources: [{ system: 'f1', addr: '1.2.1', name: 'SYS-1' }] });
  assert.deepStrictEqual(cdb.sourcesFor(db, [a.id], 'f1').map((s) => s.name), ['RC-1']);
  assert.deepStrictEqual(cdb.sourcesFor(db, [a.id, b.id], 'f1').map((s) => s.name).sort(), ['RC-1', 'SYS-1']);
  assert.deepStrictEqual(cdb.sourcesFor(db, [], 'f1'), []);
  assert.deepStrictEqual(cdb.systemsFor(db, [a.id]).sort(), ['f1', 'f2']);
});

test('customersForUser matches by username and by directory group', () => {
  const a = cdb.createCustomer(db, { name: 'FIA' });
  const b = cdb.createCustomer(db, { name: 'SysOps' });
  cdb.updateCustomer(db, a.id, { users: ['fia1'] });
  cdb.updateCustomer(db, b.id, { dirGroups: ['cn=sysops,dc=corp'] });
  assert.deepStrictEqual(cdb.customersForUser(db, 'FIA1', []).map((c) => c.name), ['FIA']);
  assert.deepStrictEqual(cdb.customersForUser(db, 'someone', ['cn=sysops,dc=corp']).map((c) => c.name), ['SysOps']);
  assert.deepStrictEqual(cdb.customersForUser(db, 'fia1', ['CN=SysOps,DC=corp']).map((c) => c.name).sort(), ['FIA', 'SysOps']);
  assert.deepStrictEqual(cdb.customersForUser(db, 'nobody', []), []);
  assert.equal(cdb.matchesDirGroup(db, ['cn=sysops,dc=corp']), true);
  assert.equal(cdb.matchesDirGroup(db, ['cn=other']), false);
});

test('delete removes the group and all its links; removeUser detaches a username', () => {
  const a = cdb.createCustomer(db, { name: 'FIA' });
  cdb.updateCustomer(db, a.id, { users: ['fia1'], sources: [{ system: 'f1', addr: '1', name: 'P' }], dirGroups: ['g'] });
  cdb.removeUser(db, 'fia1');
  assert.deepStrictEqual(cdb.getCustomer(db, a.id).users, []);
  assert.equal(cdb.deleteCustomer(db, a.id), true);
  assert.equal(cdb.getCustomer(db, a.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_sources').get().n, 0);
  assert.equal(cdb.deleteCustomer(db, a.id), false);
});
