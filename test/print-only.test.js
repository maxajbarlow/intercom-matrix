'use strict';
// The viewer is PRINT-ONLY: config prints (PDF / extracted text) are the sole
// matrix source, with an optional topology tree. The live RRCS connection,
// .Art/.ash key-access overlay and VSP export source were removed. These tests
// pin that contract — including that a legacy deployment's systems.json and
// settings.json (still carrying host/rrcs fields) keep loading cleanly.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8851;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-print-'));
const SYSTEMS_FILE = path.join(tmpDir, 'systems.json');
const SETTINGS_FILE = path.join(tmpDir, 'settings.json');
const J = { 'Content-Type': 'application/json' };

const PRINT = [
  'Group and Conference List',
  'RaceControl RC Conference <not assigned> 2 2',
  "Conf-Cmd Key 1 on Panel 'RC-1' (type Panel-1024)", 'Destination (talk, listen)',
  "Conf-Cmd Key 2 on Panel 'RC-2' (type Panel-1024)", 'Destination (talk)',
  '',
].join('\n');

let child, admin;
before(async () => {
  // A LEGACY systems.json — live-controller + key-access + VSP fields included.
  fs.writeFileSync(SYSTEMS_FILE, JSON.stringify([
    { id: 'f1', name: 'F1', host: '10.1.2.3', port: 8193, config: '/nope/f1.Art', topology: '' },
    { id: 'virtual', name: 'Virtual', host: '', port: 8193, config: '', topology: '', vsp: '/nope/vsp-export.json' },
  ]));
  // A LEGACY settings.json — RRCS polling + key-access display fields included.
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    display: { autoRefreshSec: 60, theme: 'light', matrixKeyAccess: true },
    safety: { rrcsEnabled: true, minRefreshSec: 10, requireLogin: false },
  }));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), NODE_ENV: 'test', SYSTEMS_FILE, SETTINGS_FILE,
      AUTH_DB: path.join(tmpDir, 'auth.db'), AUTH_CONFIG_FILE: path.join(tmpDir, 'ac.json'), SECRET_KEY_FILE: path.join(tmpDir, '.k'),
      PRINTS_DIR: path.join(tmpDir, 'prints'), REQUESTS_DIR: tmpDir, LOCAL_ADMIN_USER: 'root', LOCAL_ADMIN_PASS: 'rootpass',
      RRCS_ENABLED: 'on', RRCS_HOST: '10.9.9.9',   // legacy env must be ignored
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early: ' + code)); });
  });
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: 'rootpass' }) });
  admin = (r.headers.get('set-cookie') || '').split(';')[0];
});
after(() => { if (child) child.kill('SIGKILL'); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const adminH = () => ({ ...J, Cookie: admin });

test('a legacy systems.json loads; systems carry no controller/RRCS fields', async () => {
  const s = await (await fetch(`${BASE}/api/systems`)).json();
  assert.deepStrictEqual(s.systems.map((x) => x.id), ['f1', 'virtual']);
  assert.equal(s.rrcsEnabled, undefined);
  assert.equal(s.autoRefreshSec, undefined);
  for (const sys of s.systems) {
    for (const k of ['host', 'port', 'config', 'configPath', 'vsp', 'vspPath', 'stale']) assert.equal(sys[k], undefined, `${sys.id}.${k} should be gone`);
    assert.equal(sys.configured, false, 'no print yet → not configured (a host no longer counts)');
  }
});

test('the live-connection and key-access endpoints are gone', async () => {
  for (const [method, p] of [['POST', '/api/refresh'], ['POST', '/api/system-config'], ['GET', '/api/config-file'], ['POST', '/api/config-file'], ['DELETE', '/api/config-file']]) {
    const r = await fetch(`${BASE}${p}?system=f1`, { method, headers: adminH(), body: method === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 404, `${method} ${p} should be 404`);
  }
});

test('a legacy settings.json loads; polling and key-access settings are dropped', async () => {
  const s = await (await fetch(`${BASE}/api/settings`)).json();
  assert.equal(s.display.theme, 'light', 'real settings survive');
  assert.equal(s.display.autoRefreshSec, undefined);
  assert.equal(s.display.matrixKeyAccess, undefined);
  assert.equal(s.safety.rrcsEnabled, undefined);
  assert.equal(s.safety.minRefreshSec, undefined);
  assert.equal(s.safety.requireLogin, false);
});

test('before a print, a system snapshot is empty and says to load a print', async () => {
  const s = await (await fetch(`${BASE}/api/snapshot?system=f1`)).json();
  assert.equal(s.ok, false);
  assert.match(s.error, /print/i);
  assert.equal(s.host, undefined);
});

test('a print upload is the matrix source', async () => {
  const up = await fetch(`${BASE}/api/print-file?system=f1&name=v1.txt`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: PRINT });
  assert.equal(up.status, 200);
  const s = await (await fetch(`${BASE}/api/snapshot?system=f1`)).json();
  assert.equal(s.ok, true);
  assert.equal(s.source, 'print');
  assert.deepStrictEqual(s.conferences.map((c) => c.name), ['RaceControl']);
  assert.deepStrictEqual(s.matrix.cells.map((c) => [c.t, c.l]).sort(), [[1, 0], [1, 1]]);
  const sys = (await (await fetch(`${BASE}/api/systems`)).json()).systems.find((x) => x.id === 'f1');
  assert.equal(sys.configured, true);
  assert.equal(sys.source, 'print');
  assert.equal((await (await fetch(`${BASE}/api/status?system=f1`)).json()).ok, true);
});

test('saving systems rewrites systems.json without the legacy fields', async () => {
  const r = await fetch(`${BASE}/api/systems/f1`, { method: 'PATCH', headers: adminH(), body: JSON.stringify({ name: 'F1 Paddock', host: '10.0.0.1' }) });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(SYSTEMS_FILE, 'utf8'));
  assert.equal(onDisk[0].name, 'F1 Paddock');
  for (const d of onDisk) for (const k of ['host', 'port', 'config', 'vsp']) assert.equal(d[k], undefined, `systems.json still has ${k}`);
});

test('topology upload remains available (editor-gated)', async () => {
  assert.equal((await fetch(`${BASE}/api/topology-file?system=f1`, { method: 'POST', body: 'x' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/topology-file?system=f1`)).status, 200);
});
