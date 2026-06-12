'use strict';
// Unit tests for lib/auth-helpers.js — group→role resolution and TLS error
// classification.

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRole, classifyTlsError, unwrapCode } = require('../lib/auth-helpers');

test('no group mapping configured → everyone is a viewer', () => {
  assert.equal(resolveRole(['cn=anything'], {}), 'viewer');
});

test('admin group wins over editor/viewer (highest privilege)', () => {
  const map = { admin: 'cn=admins', editor: 'cn=eds', viewer: 'cn=staff' };
  assert.equal(resolveRole(['cn=staff', 'cn=eds', 'cn=admins'], map), 'admin');
  assert.equal(resolveRole(['cn=staff', 'cn=eds'], map), 'editor');
  assert.equal(resolveRole(['cn=staff'], map), 'viewer');
});

test('a user in no mapped group when mapping IS configured → null (denied)', () => {
  assert.equal(resolveRole(['cn=outsiders'], { admin: 'cn=admins' }), null);
});

test('matching is case-insensitive', () => {
  assert.equal(resolveRole(['cn=admins'], { admin: 'CN=Admins' }), 'admin');
});

test('classifyTlsError unwraps wrapped cause chains', () => {
  const wrapped = new Error('bind failed'); wrapped.cause = Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' });
  assert.deepEqual(classifyTlsError(wrapped), { code: 'CERT_HAS_EXPIRED', label: 'tls_cert_expired' });
  assert.equal(unwrapCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  assert.equal(classifyTlsError(new Error('no code')).label, 'unknown');
});
