'use strict';
// Uploaded source data (config prints + topology) must survive restarts and
// redeploys: it is kept until a newer successful upload replaces it, or it is
// explicitly cleared. These tests restart the server
// against the same data directory to prove it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8845;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-persist-'));
const J = { 'Content-Type': 'application/json' };

function printText(confs) {
  const out = ['Group and Conference List'];
  for (const [name, alias, panels] of confs) {
    out.push(`${name} ${alias} Conference <not assigned> ${panels.length} ${panels.length}`);
    panels.forEach((p, i) => { out.push(`Conf-Cmd Key ${i + 1} on Panel '${p}' (type Panel-1024)`); out.push('Destination (talk, listen)'); });
  }
  return out.join('\n') + '\n';
}
const topoText = (node, ports) => ['Net', `${node} (ID: 1)`, 'Card A (Bay 1)', ...ports].join('\n') + '\n';

let child, admin;
async function start() {
  const env = {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test',
    SYSTEMS_FILE: path.join(tmpDir, 'systems.json'), SETTINGS_FILE: path.join(tmpDir, 'settings.json'),
    AUTH_DB: path.join(tmpDir, 'auth.db'), AUTH_CONFIG_FILE: path.join(tmpDir, 'auth-config.json'),
    SECRET_KEY_FILE: path.join(tmpDir, '.secret-key'), PRINTS_DIR: path.join(tmpDir, 'prints'), REQUESTS_DIR: tmpDir,
    LOCAL_ADMIN_USER: 'root', LOCAL_ADMIN_PASS: 'rootpass',
  };
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early: ' + code)); });
  });
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'root', password: 'rootpass' }) });
  admin = (r.headers.get('set-cookie') || '').split(';')[0];
}
async function stop() {
  if (!child) return;
  child.removeAllListeners('exit');   // drop start()'s "exited early" handler first
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
  child = null;
}
const restart = async () => { await stop(); await start(); };

const upload = (kind, sys, text) => fetch(`${BASE}/api/${kind}-file?system=${sys}&name=${kind}.txt`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: text });
const del = (p) => fetch(BASE + p, { method: 'DELETE', headers: { Cookie: admin } });
const getJson = async (p) => (await fetch(BASE + p, { headers: { Cookie: admin } })).json();
const confs = async (sys) => (await getJson(`/api/snapshot?system=${sys}`)).conferences.map((c) => c.name).sort();
const topo = (sys) => getJson(`/api/topology-file?system=${sys}`);

before(async () => {
  fs.writeFileSync(path.join(tmpDir, 'systems.json'), JSON.stringify([{ id: 'f1', name: 'F1' }, { id: 'f2', name: 'F2' }]));
  await start();
});
after(async () => { await stop(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('a config print survives a restart', async () => {
  assert.equal((await upload('print', 'f1', printText([['RaceControl', 'RC', ['RC-1']]]))).status, 200);
  await restart();
  assert.deepStrictEqual(await confs('f1'), ['RaceControl']);
});

test('an uploaded topology survives a restart', async () => {
  assert.equal((await upload('topology', 'f1', topoText('Node One', ['RC-1', 'RC-2']))).status, 200);
  await restart();
  const t = await topo('f1');
  assert.equal(t.loaded, true);
  assert.equal(t.ports, 2);
  assert.equal(t.name, 'topology.txt');
});

test('a failed upload keeps the previous data', async () => {
  assert.equal((await upload('print', 'f1', 'not a print')).status, 400);
  assert.equal((await upload('topology', 'f1', 'no ports here')).status, 400);
  await restart();
  assert.deepStrictEqual(await confs('f1'), ['RaceControl']);
  assert.equal((await topo('f1')).ports, 2);
});

test('a newer upload replaces the stored data', async () => {
  assert.equal((await upload('print', 'f1', printText([['Stewards', 'STW', ['RC-1']]]))).status, 200);
  assert.equal((await upload('topology', 'f1', topoText('Node Two', ['RC-1', 'RC-2', 'RC-3']))).status, 200);
  await restart();
  assert.deepStrictEqual(await confs('f1'), ['Stewards']);
  assert.equal((await topo('f1')).ports, 3);
  assert.equal((await getJson('/api/print-versions?system=f1')).versions.length, 2, 'print history kept');
});

test('saving a system (e.g. a rename) keeps its uploaded topology and print', async () => {
  // the Systems form always sends its (empty) topology-path field along
  const r = await fetch(`${BASE}/api/systems/f1`, { method: 'PATCH', headers: { ...J, Cookie: admin }, body: JSON.stringify({ name: 'Formula 1', topology: '' }) });
  assert.equal(r.status, 200);
  assert.equal((await topo('f1')).ports, 3);
  await restart();
  assert.equal((await topo('f1')).ports, 3);
  assert.deepStrictEqual(await confs('f1'), ['Stewards']);
});

test('clearing deletes the stored data for good', async () => {
  assert.equal((await del('/api/topology-file?system=f1')).status, 200);
  await restart();
  assert.equal((await topo('f1')).loaded, false);
  assert.deepStrictEqual(await confs('f1'), ['Stewards'], 'clearing topology leaves the print');
  assert.equal((await del('/api/print-file?system=f1')).status, 200);
  await restart();
  assert.deepStrictEqual(await confs('f1'), []);
});

test('removing a system keeps its data; re-adding the id restores it', async () => {
  assert.equal((await upload('print', 'f2', printText([['SysOps', 'SYS', ['SYS-1']]]))).status, 200);
  assert.equal((await upload('topology', 'f2', topoText('Node', ['SYS-1']))).status, 200);
  assert.equal((await del('/api/systems/f2')).status, 200);
  await restart();
  const created = await fetch(`${BASE}/api/systems`, { method: 'POST', headers: { ...J, Cookie: admin }, body: JSON.stringify({ id: 'f2', name: 'F2' }) });
  assert.equal(created.status, 201);
  assert.deepStrictEqual(await confs('f2'), ['SysOps']);
  assert.equal((await topo('f2')).ports, 1);
});

test('the Docker image and deploy compose keep uploads on the persistent /data volume', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /PRINTS_DIR=\/data\/prints/, 'Dockerfile must point PRINTS_DIR into the /data volume');
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.deploy.yml'), 'utf8');
  assert.match(compose, /PRINTS_DIR=\/data\/prints/);
  assert.match(compose, /:\/data\b/, 'the deploy compose mounts /data');
});
