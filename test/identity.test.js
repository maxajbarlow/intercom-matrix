'use strict';
// Unit tests for lib/identity.js — session-based currentUser() and the admin
// authorization gate. Uses a throwaway AUTH_DB so the real one is untouched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AUTH_DB = path.join(os.tmpdir(), `imx-identity-test-${process.pid}.db`);
const authDb = require('../lib/auth-db');
const { currentUser, can, ADMIN_ACTIONS, EDITOR_ACTIONS } = require('../lib/identity');

test.after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.AUTH_DB + ext); } catch { /* ignore */ } } });

const reqWith = (token) => ({ headers: token ? { cookie: `imx_session=${token}` } : {}, get() { return undefined; } });

test('no cookie → anonymous viewer (read-only)', () => {
  const u = currentUser(reqWith(null));
  assert.equal(u.role, 'viewer');
  assert.equal(u.source, 'anon');
  assert.equal(u.name, 'anonymous');
});

test('valid session cookie → that user and role', () => {
  const { token } = authDb.createSession('maya', 'Maya Chen', 'admin', 'local');
  const u = currentUser(reqWith(token));
  assert.equal(u.username, 'maya');
  assert.equal(u.name, 'Maya Chen');
  assert.equal(u.role, 'admin');
  assert.equal(u.source, 'session');
});

test('an unknown/expired token falls back to anonymous', () => {
  assert.equal(currentUser(reqWith('deadbeef')).source, 'anon');
});

test('non-admin actions are open to everyone', () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    assert.equal(can({ role }, 'snapshot:read'), true);
    assert.equal(can({ role }, 'request:create'), true);
  }
  assert.equal(can(null, 'snapshot:read'), true);
});

test('every admin-gated action requires the admin role', () => {
  for (const action of ADMIN_ACTIONS) {
    assert.equal(can({ role: 'admin' }, action), true, `admin allowed: ${action}`);
    assert.equal(can({ role: 'editor' }, action), false, `editor denied: ${action}`);
    assert.equal(can({ role: 'viewer' }, action), false, `viewer denied: ${action}`);
    assert.equal(can(null, action), false, `anon denied: ${action}`);
  }
});

test('settings, system, and user mutations are the gated set', () => {
  for (const a of ['settings:write', 'system:create', 'system:update', 'system:delete', 'user:create', 'user:delete']) {
    assert.ok(ADMIN_ACTIONS.has(a), `${a} is gated`);
  }
});

test('editor-tier actions (source:write) allow editor OR admin, deny viewer/anon', () => {
  for (const action of EDITOR_ACTIONS) {
    assert.equal(can({ role: 'admin' }, action), true, `admin allowed: ${action}`);
    assert.equal(can({ role: 'editor' }, action), true, `editor allowed: ${action}`);
    assert.equal(can({ role: 'viewer' }, action), false, `viewer denied: ${action}`);
    assert.equal(can(null, action), false, `anon denied: ${action}`);
  }
  assert.ok(EDITOR_ACTIONS.has('source:write'));
});
