'use strict';
// Unit tests for lib/local-users.js — scrypt hashing + account CRUD on an
// in-memory node:sqlite DB (no files, no native deps).

const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const lu = require('../lib/local-users');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE local_users (username TEXT PRIMARY KEY COLLATE NOCASE, password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL, display_name TEXT, role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT DEFAULT (datetime('now')), created_by TEXT, disabled_at TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT, role TEXT, auth_method TEXT, created_at TEXT, expires_at TEXT);
  `);
  return db;
}

test('hashPassword + verifyPassword round-trip', () => {
  const { salt, hash } = lu.hashPassword('hunter2');
  assert.ok(salt && hash);
  assert.equal(lu.verifyPassword('hunter2', salt, hash), true);
  assert.equal(lu.verifyPassword('wrong', salt, hash), false);
  assert.equal(lu.verifyPassword('', salt, hash), false);
});

test('createLocalUser stores a user with a normalized role', () => {
  const db = freshDb();
  const u = lu.createLocalUser(db, { username: 'jdoe', password: 'secret1', displayName: 'Jane', role: 'editor', createdBy: 'admin' });
  assert.equal(u.username, 'jdoe');
  assert.equal(u.role, 'editor');
  assert.equal(u.display_name, 'Jane');
  // a bogus role degrades to viewer
  assert.equal(lu.createLocalUser(db, { username: 'kk', password: 'secret1', role: 'wizard' }).role, 'viewer');
});

test('createLocalUser enforces username format, password length, and uniqueness', () => {
  const db = freshDb();
  assert.throws(() => lu.createLocalUser(db, { username: 'a b', password: 'secret1' }), /2-64 chars/);
  assert.throws(() => lu.createLocalUser(db, { username: 'short', password: '123' }), /at least 6/);
  lu.createLocalUser(db, { username: 'dup', password: 'secret1' });
  assert.throws(() => lu.createLocalUser(db, { username: 'DUP', password: 'secret1' }), /already exists/);  // case-insensitive
});

test('verifyPassword via stored hash authenticates the right password', () => {
  const db = freshDb();
  lu.createLocalUser(db, { username: 'amy', password: 'correct-horse' });
  const row = lu.getLocalUser(db, 'amy');
  assert.equal(lu.verifyPassword('correct-horse', row.password_salt, row.password_hash), true);
  assert.equal(lu.verifyPassword('nope', row.password_salt, row.password_hash), false);
});

test('updateLocalUser changes role, password, and disabled flag', () => {
  const db = freshDb();
  lu.createLocalUser(db, { username: 'bob', password: 'secret1', role: 'viewer' });
  assert.equal(lu.updateLocalUser(db, 'bob', { role: 'admin' }).role, 'admin');
  const upd = lu.updateLocalUser(db, 'bob', { password: 'newsecret' });
  assert.equal(lu.verifyPassword('newsecret', upd.password_salt, upd.password_hash), true);
  assert.ok(lu.isDisabled(lu.updateLocalUser(db, 'bob', { disabled: true })));
  assert.equal(lu.isDisabled(lu.updateLocalUser(db, 'bob', { disabled: false })), false);
});

test('deleteLocalUser removes the user and their sessions', () => {
  const db = freshDb();
  lu.createLocalUser(db, { username: 'carol', password: 'secret1' });
  db.prepare('INSERT INTO sessions (token, username) VALUES (?, ?)').run('tok', 'carol');
  assert.equal(lu.deleteLocalUser(db, 'carol'), true);
  assert.equal(lu.getLocalUser(db, 'carol'), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE username = ?').get('carol').c, 0);
  assert.equal(lu.deleteLocalUser(db, 'ghost'), false);
});

test('listLocalUsers returns accounts without secrets', () => {
  const db = freshDb();
  lu.createLocalUser(db, { username: 'zz', password: 'secret1' });
  const list = lu.listLocalUsers(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].password_hash, undefined);
  assert.ok('role' in list[0]);
});
