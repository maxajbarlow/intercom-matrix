'use strict';
// Integration tests for customer groups: a group is defined by SOURCE PANELS and
// its users only ever see the conferences hosted on those panels — across every
// data route, the XLSX export, print diffs and change requests. New conferences
// on a source panel appear automatically with the next print.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ExcelJS = require('exceljs');

const PORT = 8841;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-cust-'));
const J = { 'Content-Type': 'application/json' };

// Print lines: "<Name> <Alias> Conference <not assigned> n n" then per key
// "Conf-Cmd Key k on Panel '<panel>' ..." + "Destination (talk, listen)".
function printText(confs) {
  const out = ['Group and Conference List'];
  for (const [name, alias, panels] of confs) {
    out.push(`${name} ${alias} Conference <not assigned> ${panels.length} ${panels.length}`);
    panels.forEach((p, i) => { out.push(`Conf-Cmd Key ${i + 1} on Panel '${p}' (type Panel-1024)`); out.push('Destination (talk, listen)'); });
  }
  return out.join('\n') + '\n';
}
const V1 = [
  ['RaceControl', 'RC', ['RC-1', 'RC-2', 'Guest']],
  ['Stewards', 'STW', ['RC-1']],
  ['SysOps', 'SYS', ['SYS-1']],
  ['SharedMon', 'MON', ['SYS-1', 'RC-2']],
];
const V2 = [...V1, ['NewFIA', 'NEW', ['RC-1']], ['NewSysOps', 'NSY', ['SYS-1']]];

let child, admin;
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200, `login ${username}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const as = (cookie) => ({ ...J, Cookie: cookie });
const get = (p, cookie) => fetch(BASE + p, { headers: cookie ? as(cookie) : {} });
const getJson = async (p, cookie) => (await get(p, cookie)).json();
const send = (p, method, body, cookie) => fetch(BASE + p, { method, headers: as(cookie), body: body == null ? undefined : JSON.stringify(body) });
const uploadPrint = (text, name) => fetch(`${BASE}/api/print-file?system=f1&name=${name}`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: text });

before(async () => {
  fs.writeFileSync(path.join(tmpDir, 'systems.json'), JSON.stringify([{ id: 'f1', name: 'F1' }, { id: 'f2', name: 'F2' }]));
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
  assert.equal((await uploadPrint(printText(V1), 'v1.txt')).status, 200);
  for (const u of ['fia1', 'fia2', 'loner']) {
    assert.equal((await send('/api/users', 'POST', { username: u, password: 'secret123', role: 'viewer' }, admin)).status, 201);
  }
});
after(() => { if (child) child.kill('SIGKILL'); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

let fia, fiaId;

test('with no customer groups, anonymous viewers still see everything (unchanged behaviour)', async () => {
  const r = await get('/api/snapshot?system=f1');
  assert.equal(r.status, 200);
  assert.ok((await r.json()).conferences.some((c) => c.name === 'SysOps'));
});

test('customer-group admin endpoints are admin-only', async () => {
  const viewer = await login('fia1', 'secret123');
  assert.equal((await get('/api/customers', viewer)).status, 403);
  assert.equal((await send('/api/customers', 'POST', { name: 'x' }, viewer)).status, 403);
  assert.equal((await send('/api/customers/preview?system=f1', 'POST', { sources: [] }, viewer)).status, 403);
});

test('preview resolves source panels to conferences before saving', async () => {
  const r = await send('/api/customers/preview?system=f1', 'POST', { sources: [{ addr: 'RC-1', name: 'RC-1' }, { addr: 'RC-2', name: 'RC-2' }, { addr: 'Gone', name: 'Gone' }] }, admin);
  const p = await r.json();
  assert.deepStrictEqual(p.conferences.map((c) => c.name).sort(), ['RaceControl', 'SharedMon', 'Stewards']);
  assert.deepStrictEqual(p.missing, ['Gone']);
});

test('admin creates the FIA group from its source panels', async () => {
  const r = await send('/api/customers', 'POST', {
    name: 'FIA Race Control',
    sources: [{ system: 'f1', addr: 'RC-1', name: 'RC-1' }, { system: 'f1', addr: 'RC-2', name: 'RC-2' }],
    users: ['fia1', 'fia2'],
  }, admin);
  assert.equal(r.status, 201);
  const c = await r.json();
  fiaId = c.id;
  assert.equal(c.sources.length, 2);
  fia = await login('fia1', 'secret123');
});

test('once a customer group exists the login wall is forced on', async () => {
  assert.equal((await get('/api/snapshot?system=f1')).status, 401);
  assert.equal((await getJson('/api/auth/me')).requireLogin, true);
});

test('/api/auth/me reports the user\'s customer groups', async () => {
  assert.deepStrictEqual((await getJson('/api/auth/me', fia)).customers, ['FIA Race Control']);
  assert.equal((await getJson('/api/auth/me', admin)).customers, null);
});

test('FIA sees only the conferences hosted on its panels', async () => {
  const s = await getJson('/api/snapshot?system=f1', fia);
  assert.deepStrictEqual(s.conferences.map((c) => c.name).sort(), ['RaceControl', 'SharedMon', 'Stewards']);
  assert.deepStrictEqual(s.matrix.cols.map((c) => c.name).sort(), ['RaceControl', 'SharedMon', 'Stewards']);
  assert.equal(s.counts.conferences, 3);
  assert.deepStrictEqual(s.scope.customers, ['FIA Race Control']);
  // SYS-1 is a participant (on SharedMon) but its SysOps membership is hidden
  const sys = s.panels.find((p) => p.name === 'SYS-1');
  assert.deepStrictEqual(sys.memberships.map((m) => m.name), ['SharedMon']);
});

test('no data route leaks an out-of-scope conference', async () => {
  for (const p of ['/api/snapshot', '/api/matrix', '/api/conferences', '/api/panels', '/api/status', '/api/systems', '/api/requests', '/api/pending']) {
    const body = await (await get(p + '?system=f1', fia)).text();
    assert.ok(!body.includes('"SysOps"'), `${p} leaked SysOps`);
  }
});

test('the XLSX export is scoped too', async () => {
  const r = await get('/api/export.xlsx?system=f1', fia);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const text = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => text.push(String(c.value)))));
  assert.ok(text.some((t) => t.includes('RaceControl')));
  assert.ok(!text.some((t) => t === 'SysOps'), 'export leaked SysOps');
});

test('/api/systems lists only systems with FIA source panels, without source file details', async () => {
  const s = await getJson('/api/systems', fia);
  assert.deepStrictEqual(s.systems.map((x) => x.id), ['f1']);
  assert.equal(s.default, 'f1');
  assert.equal(s.systems[0].host, undefined);
  assert.equal((await getJson('/api/systems', admin)).systems.length, 2);
});

test('a system with no FIA source panels shows FIA nothing', async () => {
  const s = await getJson('/api/snapshot?system=f2', fia);
  assert.deepStrictEqual(s.conferences, []);
  assert.deepStrictEqual(s.matrix.rows, []);
});

test('admins and editors are never scoped', async () => {
  const s = await getJson('/api/snapshot?system=f1', admin);
  assert.ok(s.conferences.some((c) => c.name === 'SysOps'));
  assert.equal(s.scope, undefined);
});

test('a viewer in no customer group sees no data once groups exist', async () => {
  const loner = await login('loner', 'secret123');
  const s = await getJson('/api/snapshot?system=f1', loner);
  assert.deepStrictEqual(s.conferences, []);
  assert.deepStrictEqual((await getJson('/api/systems', loner)).systems, []);
});

test('a new conference on an FIA panel appears automatically with the next print', async () => {
  assert.equal((await uploadPrint(printText(V2), 'v2.txt')).status, 200);
  const names = (await getJson('/api/snapshot?system=f1', fia)).conferences.map((c) => c.name);
  assert.ok(names.includes('NewFIA'), 'NewFIA should auto-appear');
  assert.ok(!names.includes('NewSysOps'), 'NewSysOps is on a SysOps panel only');
});

test('print diff is filtered to the customer\'s conferences', async () => {
  const versions = (await getJson('/api/print-versions?system=f1', admin)).versions;
  const [to, from] = [versions[0].id, versions[1].id];
  const d = await getJson(`/api/print-diff?system=f1&from=${from}&to=${to}`, fia);
  assert.deepStrictEqual(d.conferences.map((c) => c.name), ['NewFIA']);
  assert.equal(d.summary.confAdded, 1);
  const full = await getJson(`/api/print-diff?system=f1&from=${from}&to=${to}`, admin);
  assert.equal(full.summary.confAdded, 2);
});

test('FIA can request changes on its own channels only', async () => {
  const ok = await send('/api/requests?system=f1', 'POST', { title: 'add RC-2 to stewards', changes: [{ type: 'add_member', conference: { name: 'Stewards' }, panel: { addr: 'RC-2', name: 'RC-2' } }] }, fia);
  assert.equal(ok.status, 201);
  const bad = await send('/api/requests?system=f1', 'POST', { changes: [{ type: 'remove_member', conference: { name: 'SysOps' }, panel: { addr: 'SYS-1', name: 'SYS-1' } }] }, fia);
  assert.equal(bad.status, 403);
  assert.match((await bad.json()).error, /outside your customer group/);
});

test('SysOps requests are invisible to FIA; FIA colleagues see each other\'s', async () => {
  const r = await send('/api/requests?system=f1', 'POST', { changes: [{ type: 'delete_conference', conference: { name: 'SysOps' } }] }, admin);
  const sysReq = await r.json();
  const list = (await getJson('/api/requests?system=f1', fia)).requests;
  assert.ok(!list.some((x) => x.id === sysReq.id));
  assert.equal((await get(`/api/requests/${sysReq.id}`, fia)).status, 404);
  assert.equal((await send(`/api/requests/${sysReq.id}/comments`, 'POST', { body: 'hi' }, fia)).status, 404);
  assert.equal((await send(`/api/requests/${sysReq.id}/transition`, 'POST', { to: 'cancelled' }, fia)).status, 404);
  const fia2 = await login('fia2', 'secret123');
  const theirs = (await getJson('/api/requests?system=f1', fia2)).requests;
  assert.equal(theirs.length, 1, 'fia2 sees fia1\'s Stewards request');
  assert.equal((await getJson('/api/requests?system=f1', fia2)).stats.total, 1);
});

test('removing a user from the group and deleting the group take effect immediately', async () => {
  assert.equal((await send(`/api/customers/${fiaId}`, 'PATCH', { users: ['fia2'] }, admin)).status, 200);
  assert.deepStrictEqual((await getJson('/api/snapshot?system=f1', fia)).conferences, []);
  assert.equal((await send(`/api/customers/${fiaId}`, 'DELETE', null, admin)).status, 200);
  // no groups left → back to unscoped behaviour
  assert.ok((await getJson('/api/snapshot?system=f1', fia)).conferences.some((c) => c.name === 'SysOps'));
});
