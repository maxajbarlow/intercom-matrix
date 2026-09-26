'use strict';
// Integration tests for the "All systems" view (system=all): one combined
// snapshot across systems with cross-system conference matching, requests and
// pending changes merged per system, customer scoping preserved, and per-system
// actions (uploads, versions, new requests) refused for "all".

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8847;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-all-'));
const J = { 'Content-Type': 'application/json' };

function printText(confs) {
  const out = ['Group and Conference List'];
  for (const [name, alias, panels] of confs) {
    out.push(`${name} ${alias} Conference <not assigned> ${panels.length} ${panels.length}`);
    panels.forEach((p, i) => { out.push(`Conf-Cmd Key ${i + 1} on Panel '${p}' (type Panel-1024)`); out.push('Destination (talk, listen)'); });
  }
  return out.join('\n') + '\n';
}
const F1 = [['RaceControl', 'RC', ['RC-1', 'RC-2']], ['F1Only', 'F1O', ['RC-1']]];
const F2 = [['IM-RaceControl', 'RC', ['F2-RC']], ['F2Only', 'F2O', ['F2-RC', 'F2-X']]];

let child, admin, fia;
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, 200, `login ${username}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const as = (cookie) => ({ ...J, Cookie: cookie });
const get = (p, cookie) => fetch(BASE + p, { headers: as(cookie) });
const getJson = async (p, cookie) => (await get(p, cookie)).json();
const send = (p, method, body, cookie) => fetch(BASE + p, { method, headers: as(cookie), body: body == null ? undefined : JSON.stringify(body) });
const upload = (sys, text) => fetch(`${BASE}/api/print-file?system=${sys}&name=p.txt`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: text });

before(async () => {
  fs.writeFileSync(path.join(tmpDir, 'systems.json'), JSON.stringify([{ id: 'f1', name: 'F1' }, { id: 'f2', name: 'F2' }, { id: 'empty', name: 'Empty' }]));
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
  assert.equal((await upload('f1', printText(F1))).status, 200);
  assert.equal((await upload('f2', printText(F2))).status, 200);
});
after(() => { if (child) child.kill('SIGKILL'); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('/api/systems lists the real systems only ("all" is a view, not a system)', async () => {
  const s = await getJson('/api/systems', admin);
  assert.deepStrictEqual(s.systems.map((x) => x.id), ['f1', 'f2', 'empty']);
});

test('the combined snapshot has every system\'s panels and merges matched conferences', async () => {
  const s = await getJson('/api/snapshot?system=all', admin);
  assert.equal(s.ok, true);
  assert.equal(s.system.id, 'all');
  assert.deepStrictEqual(s.systems.map((x) => x.id), ['f1', 'f2'], 'systems without a print are left out');
  assert.deepStrictEqual(s.matrix.rows.map((r) => `${r.system}:${r.name}`), ['f1:RC-1', 'f1:RC-2', 'f2:F2-RC', 'f2:F2-X']);
  const rc = s.matrix.cols.find((c) => c.name === 'RaceControl');
  assert.equal(rc.matched, true);
  assert.deepStrictEqual(rc.variants.map((v) => v.name), ['RaceControl', 'IM-RaceControl']);
  assert.equal(s.matrix.cols.length, 3);
  assert.equal(s.counts.matchedConferences, 1);
});

test('the other data routes answer for "all" too', async () => {
  const st = await getJson('/api/status?system=all', admin);
  assert.equal(st.ok, true);
  assert.equal(st.system.id, 'all');
  assert.equal((await getJson('/api/conferences?system=all', admin)).conferences.length, 3);
  assert.equal((await getJson('/api/panels?system=all', admin)).panels.length, 4);
  assert.equal((await getJson('/api/matrix?system=all', admin)).matrix.rows.length, 4);
});

test('per-system actions refuse "all"', async () => {
  for (const [method, p] of [['POST', '/api/print-file?system=all'], ['DELETE', '/api/print-file?system=all'], ['GET', '/api/print-diff?system=all'], ['GET', '/api/print-versions?system=all'], ['POST', '/api/topology-file?system=all']]) {
    const r = await fetch(BASE + p, { method, headers: { Cookie: admin, 'Content-Type': 'text/plain' }, body: method === 'POST' ? 'x' : undefined });
    assert.equal(r.status, 400, `${method} ${p}`);
    assert.match((await r.json()).error, /pick a system/i);
  }
  const r = await send('/api/requests?system=all', 'POST', { changes: [{ type: 'delete_conference', conference: { name: 'F1Only' } }] }, admin);
  assert.equal(r.status, 400);
});

test('requests and pending changes from every system are listed together, tagged with their system', async () => {
  assert.equal((await send('/api/requests?system=f1', 'POST', { title: 'f1 req', changes: [{ type: 'remove_member', conference: { name: 'F1Only' }, panel: { addr: 'RC-1', name: 'RC-1' } }] }, admin)).status, 201);
  assert.equal((await send('/api/requests?system=f2', 'POST', { title: 'f2 req', changes: [{ type: 'remove_member', conference: { name: 'F2Only' }, panel: { addr: 'F2-X', name: 'F2-X' } }] }, admin)).status, 201);
  const list = await getJson('/api/requests?system=all', admin);
  assert.deepStrictEqual(list.requests.map((r) => r.system).sort(), ['f1', 'f2']);
  assert.equal(list.stats.total, 2);
  const pend = await getJson('/api/pending?system=all', admin);
  assert.deepStrictEqual(pend.changes.map((c) => `${c.system}:${c.conference}`).sort(), ['f1:F1Only', 'f2:F2Only']);
  const wo = await getJson('/api/work-order?system=all', admin);
  assert.deepStrictEqual(wo.groups.map((g) => `${g.system}:${g.conference}`).sort(), ['f1:F1Only', 'f2:F2Only']);
  assert.equal(wo.changeCount, 2);
});

test('a customer\'s "all" view holds only their systems and never another system\'s names', async () => {
  assert.equal((await send('/api/users', 'POST', { username: 'fia1', password: 'secret123', role: 'viewer' }, admin)).status, 201);
  assert.equal((await send('/api/customers', 'POST', { name: 'FIA', sources: [{ system: 'f1', addr: 'RC-1', name: 'RC-1' }], users: ['fia1'] }, admin)).status, 201);
  fia = await login('fia1', 'secret123');
  const s = await getJson('/api/snapshot?system=all', fia);
  assert.deepStrictEqual(s.systems.map((x) => x.id), ['f1']);
  const body = JSON.stringify(s);
  for (const leak of ['IM-RaceControl', 'F2-RC', 'F2Only', 'f2 req']) assert.ok(!body.includes(leak), `leaked ${leak}`);
  const reqs = await getJson('/api/requests?system=all', fia);
  assert.ok(reqs.requests.every((r) => r.system === 'f1'));
  const pend = await getJson('/api/pending?system=all', fia);
  assert.ok(pend.changes.every((c) => c.system === 'f1'));
});

test('the "all" export has a System column and per-system names on matched conferences', async () => {
  const ExcelJS = require('exceljs');
  const r = await get('/api/export.xlsx?system=all', admin);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('Matrix');
  const headRow = ws.getRow(5).values.map((v) => (v && v.richText ? v.richText.map((t) => t.text).join('') : v));
  assert.deepStrictEqual(headRow.slice(1, 4), ['Panel', 'System', 'Port']);
  const rcCell = ws.getRow(5).values.findIndex((v) => typeof v === 'string' && v.startsWith('RaceControl'));
  const note = ws.getCell(5, rcCell).note;
  const noteText = typeof note === 'string' ? note : (note && note.texts ? note.texts.map((t) => t.text).join('') : '');
  assert.match(noteText, /F1: RaceControl/);
  assert.match(noteText, /F2: IM-RaceControl/);
  assert.equal(ws.getCell(6, 2).value, 'F1');
  const conf = wb.getWorksheet('Conferences');
  const texts = [];
  conf.eachRow((row) => row.eachCell((c) => texts.push(String(c.value))));
  assert.ok(texts.some((t) => t.includes('F2 · F2-RC')), 'members carry their system');
});
