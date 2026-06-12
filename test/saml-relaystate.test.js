'use strict';
// Regression tests for SAML RelayState sanitization (open-redirect guard).
// RelayState / ?next is attacker-controlled and feeds res.redirect(), so it must
// only ever resolve to a same-origin local path.

const { test } = require('node:test');
const assert = require('node:assert');
const { safeRelayState } = require('../lib/saml-routes');

test('legitimate local paths are preserved', () => {
  assert.equal(safeRelayState('/'), '/');
  assert.equal(safeRelayState('/matrix'), '/matrix');
  assert.equal(safeRelayState('/requests?id=3#x'), '/requests?id=3#x');
});

test('external and protocol-relative targets are rejected', () => {
  for (const evil of [
    'https://evil.com',
    'http://evil.com',
    '//evil.com',
    '/\\evil.com',        // backslash bypass — browsers normalize \ to /
    '\\\\evil.com',
    '/\\/evil.com',
    'javascript:alert(1)',
    'not-a-path',
    '',
    null,
    undefined,
    123,
  ]) {
    assert.equal(safeRelayState(evil), '/', `must reject: ${JSON.stringify(evil)}`);
  }
});

test('a path containing a backslash anywhere is rejected', () => {
  assert.equal(safeRelayState('/ok/\\evil.com'), '/');
});
