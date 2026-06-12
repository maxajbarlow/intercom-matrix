'use strict';
// Unit tests for lib/settings.js — validation, clamping, immutable merge, and
// atomic persistence. Uses a throwaway SETTINGS_FILE so the real deployment
// config is never touched. Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the module at a temp file BEFORE requiring it (it reads the env once).
const TMP = path.join(os.tmpdir(), `imx-settings-test-${process.pid}.json`);
process.env.SETTINGS_FILE = TMP;
const settings = require('../lib/settings');

test.after(() => { try { fs.unlinkSync(TMP); } catch { /* ignore */ } });

test('defaults are well-formed when no file exists', () => {
  const s = settings.getSettings();
  assert.equal(s.branding.siteName, 'Intercom Matrix');
  assert.equal(s.display.theme, 'dark');
  assert.equal(s.display.autoRefreshSec, 30);
  assert.equal(s.safety.minRefreshSec, 3);
  assert.equal(s.safety.requireLogin, false);
});

test('requireLogin is a coerced boolean', () => {
  assert.equal(settings.updateSettings({ safety: { requireLogin: true } }).safety.requireLogin, true);
  assert.equal(settings.updateSettings({ safety: { requireLogin: 0 } }).safety.requireLogin, false);
  assert.equal(settings.requireLogin(), false);
});

test('auth method toggles default sensibly and coerce to booleans', () => {
  const a = settings.defaults().auth;
  assert.equal(a.localEnabled, true);
  assert.equal(typeof a.ldapEnabled, 'boolean');
  assert.equal(typeof a.samlEnabled, 'boolean');
  const next = settings.updateSettings({ auth: { localEnabled: false, samlEnabled: 1 } });
  assert.equal(next.auth.localEnabled, false);
  assert.equal(next.auth.samlEnabled, true);
  assert.deepEqual(settings.authConfig(), next.auth);
});

test('getSettings returns a clone (cache is not mutable by callers)', () => {
  const a = settings.getSettings();
  a.branding.siteName = 'mutated';
  assert.equal(settings.getSettings().branding.siteName, 'Intercom Matrix');
});

test('updateSettings merges a partial patch and persists', () => {
  const next = settings.updateSettings({ branding: { siteName: 'Acme' } });
  assert.equal(next.branding.siteName, 'Acme');
  assert.equal(next.display.theme, 'dark', 'untouched sections keep their values');
  assert.ok(fs.existsSync(TMP), 'file is written');
  const onDisk = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.equal(onDisk.branding.siteName, 'Acme');
});

test('minRefreshSec is clamped to the 3s floor', () => {
  assert.equal(settings.updateSettings({ safety: { minRefreshSec: 1 } }).safety.minRefreshSec, 3);
  assert.equal(settings.updateSettings({ safety: { minRefreshSec: 9000 } }).safety.minRefreshSec, 3600);
});

test('invalid enums fall back to defaults', () => {
  const s = settings.updateSettings({ display: { theme: 'neon', autoRefreshSec: 7, dateFormat: 'epoch' } });
  assert.equal(s.display.theme, 'dark');
  assert.equal(s.display.autoRefreshSec, 30);
  assert.equal(s.display.dateFormat, 'medium');
});

test('a valid auto-refresh choice is accepted', () => {
  assert.equal(settings.updateSettings({ display: { autoRefreshSec: 60 } }).display.autoRefreshSec, 60);
});

test('a non-image logo data-URI is rejected', () => {
  assert.throws(() => settings.updateSettings({ branding: { logoDataUri: 'data:text/html,<script>' } }), /image data-URI/);
});

test('an oversized logo is rejected', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(520 * 1024);
  assert.throws(() => settings.updateSettings({ branding: { logoDataUri: big } }), /exceeds/);
});

test('a small valid logo data-URI is accepted', () => {
  const ok = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
    s = settings.updateSettings({ branding: { logoDataUri: ok } });
  assert.equal(s.branding.logoDataUri, ok);
});
