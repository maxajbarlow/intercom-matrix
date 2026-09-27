'use strict';
// Unit tests for public/names.js — which name a conference shows (its 8-char
// alias when it has one, else the long name) and the hover text behind it.

const { test } = require('node:test');
const assert = require('node:assert');
const N = require('../public/names.js');

test('short shows the alias when a conference has one', () => {
  assert.strictEqual(N.short({ name: 'Red Bull Audio VERSTAPPEN', label: 'VER' }), 'VER');
});

test('short falls back to the long name when the alias is missing or blank', () => {
  assert.strictEqual(N.short({ name: 'FiA Tech Group' }), 'FiA Tech Group');
  assert.strictEqual(N.short({ name: 'FiA Tech Group', label: '  ' }), 'FiA Tech Group');
  assert.strictEqual(N.short(null), '');
});

test('tip leads with the long name, then any extra lines', () => {
  const d = { name: 'Stewards Radio Stew', label: 'RAD' };
  assert.strictEqual(N.tip(d), 'Stewards Radio Stew');
  assert.strictEqual(N.tip(d, '12 members', '', null, 'F1'), 'Stewards Radio Stew\n12 members\nF1');
});

test('aliasIndex resolves a conference known only by its long name', () => {
  const idx = N.aliasIndex({
    conferences: [{ name: 'Tim/Race Control', label: 'Tim/RC' }, { name: 'No Alias', label: '' }],
    groups: [{ name: 'FIA System Ops 1&2 SYS', label: 'OP12' }],
  });
  assert.strictEqual(N.aliasOf(idx, 'Tim/Race Control'), 'Tim/RC');
  assert.strictEqual(N.aliasOf(idx, 'FIA System Ops 1&2 SYS'), 'OP12');
  assert.strictEqual(N.aliasOf(idx, 'No Alias'), '');
  assert.strictEqual(N.aliasOf(idx, 'Unknown'), '');
});

test('aliasIndex keys All-systems variants by system, so real per-system names resolve', () => {
  const idx = N.aliasIndex({
    conferences: [{
      name: 'Race Control', label: 'RC',
      variants: [{ system: 'f1', name: 'Race Control', label: 'RC' }, { system: 'roc', name: 'Race Control ROC', label: 'RC-ROC' }],
    }],
  });
  assert.strictEqual(N.aliasOf(idx, 'Race Control ROC', 'roc'), 'RC-ROC');
  assert.strictEqual(N.aliasOf(idx, 'Race Control', 'f1'), 'RC');
  assert.strictEqual(N.aliasOf(idx, 'Race Control'), 'RC');
});

test('aliasIndex tolerates an empty or missing snapshot', () => {
  assert.strictEqual(N.aliasOf(N.aliasIndex(null), 'x'), '');
  assert.strictEqual(N.aliasOf(N.aliasIndex({}), 'x', 'f1'), '');
});
