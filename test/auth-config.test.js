'use strict';
// Unit tests for lib/auth-config.js — effective resolution (in-app over env),
// masked reads, secret encryption-at-rest, MASK=unchanged, and configured checks.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-ac-'));
process.env.SECRET_KEY_FILE = path.join(tmp, '.key');
process.env.AUTH_CONFIG_FILE = path.join(tmp, 'auth-config.json');
delete process.env.IMX_SECRET_KEY;
// a clean env baseline so env fallbacks are predictable
for (const k of Object.keys(process.env)) if (k.startsWith('LDAP_') || k.startsWith('SAML_')) delete process.env[k];

const ac = require('../lib/auth-config');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('empty config is not "configured"', () => {
  assert.equal(ac.ldapConfigured(), false);
  assert.equal(ac.samlConfigured(), false);
});

test('env provides a fallback value with source "env"', () => {
  process.env.LDAP_URL = 'ldaps://env-dc.example.com:636';
  assert.equal(ac.redacted('ldap').url.value, 'ldaps://env-dc.example.com:636');
  assert.equal(ac.redacted('ldap').url.source, 'env');
  assert.equal(ac.ldapConfigured(), true);
  delete process.env.LDAP_URL;
});

test('in-app value overrides env and is marked source "app"', () => {
  process.env.LDAP_URL = 'ldaps://env-dc:636';
  ac.update('ldap', { url: 'ldaps://app-dc:636' });
  assert.equal(ac.redacted('ldap').url.value, 'ldaps://app-dc:636');
  assert.equal(ac.redacted('ldap').url.source, 'app');
  assert.equal(ac.effective('ldap').url, 'ldaps://app-dc:636');
  delete process.env.LDAP_URL;
});

test('secrets are encrypted at rest, masked on read, decrypted in effective()', () => {
  ac.update('ldap', { bindPassword: 'topsecret' });
  const onDisk = fs.readFileSync(process.env.AUTH_CONFIG_FILE, 'utf8');
  assert.ok(!onDisk.includes('topsecret'), 'plaintext secret must not be on disk');
  assert.ok(/v1:/.test(onDisk), 'ciphertext present');
  const red = ac.redacted('ldap').bindPassword;
  assert.deepEqual({ secret: red.secret, hasValue: red.hasValue }, { secret: true, hasValue: true });
  assert.equal(red.value, undefined, 'secret value never returned');
  assert.equal(ac.effective('ldap').bindPassword, 'topsecret');
});

test('MASK / omitted leaves a secret unchanged; "" clears it', () => {
  ac.update('ldap', { bindPassword: 'keepme' });
  ac.update('ldap', { url: 'ldaps://x:636', bindPassword: ac.MASK });  // MASK = unchanged
  assert.equal(ac.effective('ldap').bindPassword, 'keepme');
  ac.update('ldap', { bindPassword: '' });                            // clear
  assert.equal(ac.effective('ldap').bindPassword, '');
});

test('booleans and defaults resolve correctly', () => {
  assert.equal(ac.effective('ldap').tlsVerify, true);   // default
  ac.update('ldap', { tlsVerify: false });
  assert.equal(ac.effective('ldap').tlsVerify, false);
});

test('update rejects a non-URL LDAP url and non-PEM cert', () => {
  assert.throws(() => ac.update('ldap', { url: 'not a url' }), /valid URL/);
  assert.throws(() => ac.update('saml', { idpCert: 'not pem' }), /PEM/);
});

test('samlConfigured requires entryPoint + issuer + callback + idpCert', () => {
  ac.update('saml', { entryPoint: 'https://idp/sso', callbackUrl: 'https://sp/acs' });
  assert.equal(ac.samlConfigured(), false);   // issuer default present, but no idpCert
  ac.update('saml', { idpCert: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' });
  assert.equal(ac.samlConfigured(), true);
});
