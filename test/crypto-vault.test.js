'use strict';
// Unit tests for lib/crypto-vault.js — AES-256-GCM encrypt/decrypt + tamper.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SECRET_KEY_FILE = path.join(os.tmpdir(), `imx-vault-test-${process.pid}.key`);
delete process.env.IMX_SECRET_KEY;   // force the key-file path
const vault = require('../lib/crypto-vault');

test.before(() => vault.ensureKey());
test.after(() => { try { fs.unlinkSync(process.env.SECRET_KEY_FILE); } catch { /* ignore */ } });

test('encrypt → decrypt round-trips', () => {
  const ct = vault.encryptSecret('bind-password-123');
  assert.ok(vault.isCiphertext(ct));
  assert.equal(vault.decryptSecret(ct), 'bind-password-123');
});

test('empty/null encrypts to null', () => {
  assert.equal(vault.encryptSecret(''), null);
  assert.equal(vault.encryptSecret(null), null);
});

test('two encryptions of the same plaintext differ (random IV)', () => {
  assert.notEqual(vault.encryptSecret('same'), vault.encryptSecret('same'));
});

test('tampered ciphertext fails authentication → null', () => {
  const ct = vault.encryptSecret('secret');
  assert.equal(vault.decryptSecret(ct.slice(0, -6) + 'AAAAAA'), null);
});

test('non-ciphertext input → null', () => {
  assert.equal(vault.decryptSecret('plain text'), null);
  assert.equal(vault.decryptSecret(null), null);
  assert.equal(vault.isCiphertext('nope'), false);
});

test('the key file is created with 0600 permissions', () => {
  const mode = fs.statSync(process.env.SECRET_KEY_FILE).mode & 0o777;
  assert.equal(mode, 0o600);
});
