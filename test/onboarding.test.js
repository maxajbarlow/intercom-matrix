'use strict';
// Integration tests for the first-run onboarding flow. Boots real servers on
// ephemeral ports against ISOLATED temp config/db files and drives them over
// HTTP — proving the bootstrap-locked admin creator, the onboarding status
// transitions (admin → system, via either a live host or an uploaded print),
// the boot auto-stamp for already-configured deployments, and the
// ONBOARDING_OPEN kill-switch.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const J = { 'Content-Type': 'application/json' };
const withCookie = (cookie) => ({ ...J, Cookie: cookie });

// A minimal "Group and Conference List" text print with exactly one
// key assignment (the parser rejects a print with zero keys).
const PRINT_TXT = [
  'Group and Conference List',
  'ALPHA AL Conference <not assigned> 1 1',
  "Conf-Cmd Key 1 on Panel 'PNL01' (type Panel-1024)",
  'Destination (talk, listen)',
  '',
].join('\n');

let portSeq = 8810;
function spawnServer(extraEnv) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-ob-'));
  const PORT = portSeq++;
  const systemsFile = path.join(tmpDir, 'systems.json');
  fs.writeFileSync(systemsFile, JSON.stringify(extraEnv._systems || [], null, 2));
  const env = {
    ...process.env,
    PORT: String(PORT),
    SYSTEMS_FILE: systemsFile,
    SETTINGS_FILE: path.join(tmpDir, 'settings.json'),
    AUTH_DB: path.join(tmpDir, 'auth.db'),
    AUTH_CONFIG_FILE: path.join(tmpDir, 'auth-config.json'),
    SECRET_KEY_FILE: path.join(tmpDir, '.secret-key'),
    PRINTS_DIR: path.join(tmpDir, 'prints'),     // isolate the print store from repo data
    REQUESTS_DIR: tmpDir,
    NODE_ENV: 'test',
  };
  // Strip inherited bootstrap-admin / RRCS env unless the case sets them.
  delete env.LOCAL_ADMIN_USER; delete env.LOCAL_ADMIN_PASS; delete env.RRCS_ENABLED; delete env.ONBOARDING_OPEN;
  for (const [k, v] of Object.entries(extraEnv)) { if (!k.startsWith('_')) env[k] = v; }

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${PORT}`;
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early: ' + code)); });
  });
  return { child, base, tmpDir, ready };
}

// ---- Case A: fresh deployment, full happy path ------------------------------
let A;
before(async () => { A = spawnServer({ _systems: [] }); await A.ready; });
after(() => { if (A) { A.child.kill('SIGKILL'); try { fs.rmSync(A.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } } });

test('fresh deployment reports onboarding active with open admin creation', async () => {
  const st = await (await fetch(`${A.base}/api/onboarding`)).json();
  assert.equal(st.active, true);
  assert.equal(st.onboarded, false);
  assert.equal(st.steps.admin, false);
  assert.equal(st.steps.system, false);
  assert.equal(st.canCreateAdmin, true);
});

test('anonymous cannot create a system before the first admin exists', async () => {
  const r = await fetch(`${A.base}/api/systems`, { method: 'POST', headers: J, body: JSON.stringify({ id: 'nope', name: 'Nope' }) });
  assert.equal(r.status, 403);   // system:create is admin-gated
});

let adminCookie;
test('POST /api/onboarding/admin mints the first admin and opens a session', async () => {
  const r = await fetch(`${A.base}/api/onboarding/admin`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'eng', password: 'sup3rsecret', displayName: 'Lead Eng' }) });
  assert.equal(r.status, 201);
  const setCookie = r.headers.get('set-cookie') || '';
  assert.match(setCookie, /imx_session=/);
  adminCookie = setCookie.split(';')[0];
  const body = await r.json();
  assert.equal(body.role, 'admin');

  // The session is real: an admin-gated endpoint accepts it.
  const users = await fetch(`${A.base}/api/users`, { headers: withCookie(adminCookie) });
  assert.equal(users.status, 200);
});

test('onboarding status flips admin → done after creation', async () => {
  const st = await (await fetch(`${A.base}/api/onboarding`)).json();
  assert.equal(st.steps.admin, true);
  assert.equal(st.canCreateAdmin, false);   // the open path self-locked
  assert.equal(st.active, true);             // still active — no system yet
});

test('the open admin creator self-locks once an admin exists', async () => {
  const r = await fetch(`${A.base}/api/onboarding/admin`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'sneaky', password: 'sneakypass' }) });
  assert.equal(r.status, 409);
});

test('print upload (no host) makes a system configured', async () => {
  // Create an offline system (RRCS stays off — the zero-config default).
  const c = await fetch(`${A.base}/api/systems`, { method: 'POST', headers: withCookie(adminCookie), body: JSON.stringify({ id: 'f1', name: 'Studio A' }) });
  assert.equal(c.status, 201);
  let st = await (await fetch(`${A.base}/api/onboarding`)).json();
  assert.equal(st.steps.system, false);   // created but unfed

  const up = await fetch(`${A.base}/api/print-file?system=f1&name=v1.txt`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: adminCookie }, body: Buffer.from(PRINT_TXT, 'utf8'),
  });
  assert.equal(up.status, 200, JSON.stringify(await up.clone().json().catch(() => ({}))));

  st = await (await fetch(`${A.base}/api/onboarding`)).json();
  assert.equal(st.steps.system, true);    // a print counts as configured
});

test('RRCS branch: setting a host + enabling polling configures a system', async () => {
  await fetch(`${A.base}/api/systems`, { method: 'POST', headers: withCookie(adminCookie), body: JSON.stringify({ id: 'f2', name: 'F2', host: '10.9.9.9' }) });
  await fetch(`${A.base}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ safety: { rrcsEnabled: true } }) });
  const sys = await (await fetch(`${A.base}/api/systems`)).json();
  const f2 = sys.systems.find((s) => s.id === 'f2');
  assert.equal(f2.configured, true);      // configured = rrcsOn && host (reachability not required)
});

test('completing setup stamps onboardedAt and deactivates the wizard', async () => {
  const done = await fetch(`${A.base}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ meta: { onboardedAt: new Date().toISOString() } }) });
  assert.equal(done.status, 200);
  const st = await (await fetch(`${A.base}/api/onboarding`)).json();
  assert.equal(st.onboarded, true);
  assert.equal(st.active, false);
});

// ---- Case B: already-configured deployment is auto-stamped at boot ----------
test('a pre-configured deployment never activates the wizard', async () => {
  const B = spawnServer({ _systems: [{ id: 'f1', name: 'Studio A', host: '10.0.0.5', port: 8193 }], RRCS_ENABLED: 'on' });
  try {
    await B.ready;
    const st = await (await fetch(`${B.base}/api/onboarding`)).json();
    assert.equal(st.onboarded, true);   // boot auto-stamp fired (configured system present)
    assert.equal(st.active, false);
    assert.equal(st.canCreateAdmin, false);

    // The open admin creator must stay LOCKED here even though there are zero
    // local-admin rows (the LDAP/SAML-only case): the onboardedAt stamp is the
    // authoritative "bootstrap window closed" signal.
    const r = await fetch(`${B.base}/api/onboarding/admin`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'late', password: 'latepass1' }) });
    assert.equal(r.status, 409);
  } finally {
    B.child.kill('SIGKILL'); try { fs.rmSync(B.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---- Case C: ONBOARDING_OPEN=0 kill-switch ----------------------------------
test('ONBOARDING_OPEN=0 disables the open admin creator', async () => {
  const C = spawnServer({ _systems: [], ONBOARDING_OPEN: '0' });
  try {
    await C.ready;
    const st = await (await fetch(`${C.base}/api/onboarding`)).json();
    assert.equal(st.canCreateAdmin, false);
    const r = await fetch(`${C.base}/api/onboarding/admin`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'eng', password: 'sup3rsecret' }) });
    assert.equal(r.status, 403);
  } finally {
    C.child.kill('SIGKILL'); try { fs.rmSync(C.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
