'use strict';
// Integration tests for "view as": an admin previews exactly what a customer
// viewer (or a whole customer group) sees. The target lives on the admin's
// SESSION, so every data route scopes through the one currentUser() seam; the
// preview is read-only and only a real admin session can start it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8843;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-viewas-'));
const J = { 'Content-Type': 'application/json' };

function printText(confs) {
  const out = ['Group and Conference List'];
  for (const [name, alias, panels] of confs) {
    out.push(`${name} ${alias} Conference <not assigned> ${panels.length} ${panels.length}`);
    panels.forEach((p, i) => { out.push(`Conf-Cmd Key ${i + 1} on Panel '${p}' (type Panel-1024)`); out.push('Destination (talk, listen)'); });
  }
  return out.join('\n') + '\n';
}
const PRINT = [
  ['RaceControl', 'RC', ['RC-1', 'RC-2']],
  ['SysOps', 'SYS', ['SYS-1']],
];

let child, admin, fiaId, sysId;
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200, `login ${username}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const as = (cookie) => ({ ...J, Cookie: cookie });
const get = (p, cookie) => fetch(BASE + p, { headers: as(cookie) });
const getJson = async (p, cookie) => (await get(p, cookie)).json();
const send = (p, method, body, cookie) => fetch(BASE + p, { method, headers: as(cookie), body: body == null ? undefined : JSON.stringify(body) });
const confNames = async (cookie) => (await getJson('/api/snapshot?system=f1', cookie)).conferences.map((c) => c.name).sort();

before(async () => {
  fs.writeFileSync(path.join(tmpDir, 'systems.json'), JSON.stringify([{ id: 'f1', name: 'F1' }]));
  const env = {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test',
    SYSTEMS_FILE: path.join(tmpDir, 'systems.json'), SETTINGS_FILE: path.join(tmpDir, 'settings.json'),
    AUTH_DB: path.join(tmpDir, 'auth.db'), AUTH_CONFIG_FILE: path.join(tmpDir, 'auth-config.json'),
    SECRET_KEY_FILE: path.join(tmpDir, '.secret-key'), PRINTS_DIR: path.join(tmpDir, 'prints'), REQUESTS_DIR: tmpDir,
    LOCAL_ADMIN_USER: 'root', LOCAL_ADMIN_PASS: 'rootpass',
  };
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early: ' + code)); });
  });
  admin = await login('root', 'rootpass');
  const up = await fetch(`${BASE}/api/print-file?system=f1&name=p.txt`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: printText(PRINT) });
  assert.equal(up.status, 200);
  for (const [u, role] of [['fia1', 'viewer'], ['ops', 'editor']]) {
    assert.equal((await send('/api/users', 'POST', { username: u, password: 'secret123', role }, admin)).status, 201);
  }
  const fia = await (await send('/api/customers', 'POST', { name: 'FIA', sources: [{ system: 'f1', addr: 'RC-1', name: 'RC-1' }], users: ['fia1', 'jsmith'] }, admin)).json();
  const sys = await (await send('/api/customers', 'POST', { name: 'SysOps', sources: [{ system: 'f1', addr: 'SYS-1', name: 'SYS-1' }] }, admin)).json();
  fiaId = fia.id; sysId = sys.id;
});
after(() => { if (child) child.kill('SIGKILL'); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('only an admin can start viewing as someone', async () => {
  const fia = await login('fia1', 'secret123');
  assert.equal((await send('/api/view-as', 'POST', { username: 'fia1' }, fia)).status, 403);
  const editor = await login('ops', 'secret123');
  assert.equal((await send('/api/view-as', 'POST', { customerId: fiaId }, editor)).status, 403);
});

test('rejects targets that are unknown or never scoped', async () => {
  assert.equal((await send('/api/view-as', 'POST', { username: 'nobody' }, admin)).status, 404);
  assert.equal((await send('/api/view-as', 'POST', { customerId: 9999 }, admin)).status, 404);
  assert.equal((await send('/api/view-as', 'POST', { username: 'ops' }, admin)).status, 400, 'an editor sees everything');
  assert.equal((await send('/api/view-as', 'POST', {}, admin)).status, 400);
});

test('view as a viewer: data is scoped exactly like their own session', async () => {
  const fia = await login('fia1', 'secret123');
  const r = await send('/api/view-as', 'POST', { username: 'fia1' }, admin);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(await confNames(admin), await confNames(fia));
  assert.deepStrictEqual(await confNames(admin), ['RaceControl']);
  const me = await getJson('/api/auth/me', admin);
  assert.equal(me.role, 'viewer');
  assert.deepStrictEqual(me.customers, ['FIA']);
  assert.deepStrictEqual(me.viewAs, { kind: 'user', username: 'fia1', label: 'fia1', realUser: 'root' });
});

test('view as a directory user named in a group', async () => {
  assert.equal((await send('/api/view-as', 'POST', { username: 'jsmith' }, admin)).status, 200);
  assert.deepStrictEqual(await confNames(admin), ['RaceControl']);
});

test('while viewing as, the preview is read-only and admin endpoints behave as for the viewer', async () => {
  await send('/api/view-as', 'POST', { username: 'fia1' }, admin);
  const w = await send('/api/customers', 'POST', { name: 'Nope' }, admin);
  assert.equal(w.status, 403);
  assert.match((await w.json()).error, /view/i);
  assert.equal((await send('/api/requests?system=f1', 'POST', { items: [] }, admin)).status, 403);
  assert.equal((await get('/api/users', admin)).status, 403);
});

test('view as a whole customer group', async () => {
  assert.equal((await send('/api/view-as', 'POST', { customerId: sysId }, admin)).status, 200);
  assert.deepStrictEqual(await confNames(admin), ['SysOps']);
  const me = await getJson('/api/auth/me', admin);
  assert.deepStrictEqual(me.viewAs, { kind: 'group', customerId: sysId, label: 'SysOps', realUser: 'root' });
  assert.deepStrictEqual(me.customers, ['SysOps']);
});

test('exiting restores the admin session in full', async () => {
  await send('/api/view-as', 'POST', { username: 'fia1' }, admin);
  assert.equal((await send('/api/view-as', 'DELETE', null, admin)).status, 200);
  const me = await getJson('/api/auth/me', admin);
  assert.equal(me.role, 'admin');
  assert.equal(me.viewAs, null);
  assert.deepStrictEqual(await confNames(admin), ['RaceControl', 'SysOps']);
  assert.equal((await get('/api/users', admin)).status, 200);
});

test('a deleted target leaves the preview seeing nothing, and exit still works', async () => {
  const tmp = await (await send('/api/customers', 'POST', { name: 'Temp', sources: [{ system: 'f1', addr: 'RC-2', name: 'RC-2' }] }, admin)).json();
  await send('/api/view-as', 'POST', { customerId: tmp.id }, admin);
  await send('/api/view-as', 'DELETE', null, admin);
  await send('/api/customers/' + tmp.id, 'DELETE', null, admin);
  await send('/api/view-as', 'POST', { username: 'fia1' }, admin);
  assert.equal((await send('/api/users/fia1', 'DELETE', null, admin)).status, 403, 'blocked while previewing');
  await send('/api/view-as', 'DELETE', null, admin);
  assert.equal((await send('/api/users/fia1', 'DELETE', null, admin)).status, 200);
  await send('/api/view-as', 'POST', { customerId: fiaId }, admin);
  assert.deepStrictEqual(await confNames(admin), ['RaceControl']);
  const other = await login('root', 'rootpass');   // a second admin session deletes it mid-preview
  assert.equal((await send('/api/customers/' + fiaId, 'DELETE', null, other)).status, 200);
  assert.deepStrictEqual(await confNames(admin), [], 'group gone → sees nothing');
  assert.equal((await send('/api/view-as', 'DELETE', null, admin)).status, 200);
  assert.equal((await getJson('/api/auth/me', admin)).role, 'admin');
});

test('logging out ends the preview with the session', async () => {
  const again = await login('root', 'rootpass');
  await send('/api/view-as', 'POST', { customerId: sysId }, again);
  await send('/api/auth/logout', 'POST', null, again);
  const fresh = await login('root', 'rootpass');
  assert.equal((await getJson('/api/auth/me', fresh)).viewAs, null);
});
