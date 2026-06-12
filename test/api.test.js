'use strict';
// Integration tests for the auth + settings + systems-CRUD HTTP API. Boots a
// real server on an ephemeral port against ISOLATED temp config/db files, then
// drives it over HTTP — proving session login, the admin gate, the require-login
// wall, and on-disk persistence end to end.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imx-api-'));
const SYSTEMS_FILE = path.join(tmpDir, 'systems.json');
const SETTINGS_FILE = path.join(tmpDir, 'settings.json');
const AUTH_DB = path.join(tmpDir, 'auth.db');
const AUTH_CONFIG_FILE = path.join(tmpDir, 'auth-config.json');
const SECRET_KEY_FILE = path.join(tmpDir, '.secret-key');

let child;

function waitForReady(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early: ' + code)); });
  });
}

const J = { 'Content-Type': 'application/json' };
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username, password }) });
  const setCookie = r.headers.get('set-cookie') || '';
  return { status: r.status, cookie: setCookie.split(';')[0], body: await r.json().catch(() => ({})) };
}
const withCookie = (cookie) => ({ ...J, Cookie: cookie });

let adminCookie;

before(async () => {
  fs.writeFileSync(SYSTEMS_FILE, JSON.stringify([{ id: 'f1', name: 'Studio A', host: '', port: 8193 }], null, 2));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SYSTEMS_FILE, SETTINGS_FILE, AUTH_DB, AUTH_CONFIG_FILE, SECRET_KEY_FILE, RRCS_ENABLED: 'off', NODE_ENV: 'test', LOCAL_ADMIN_USER: 'root', LOCAL_ADMIN_PASS: 'rootpass' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForReady(child);
  const r = await login('root', 'rootpass');
  adminCookie = r.cookie;
});

after(() => { if (child) child.kill('SIGKILL'); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('anonymous /api/auth/me reports unauthenticated + capabilities', async () => {
  const me = await (await fetch(`${BASE}/api/auth/me`)).json();
  assert.equal(me.authenticated, false);
  assert.equal(me.ldapEnabled, false);
  assert.equal(me.samlEnabled, false);
  assert.equal(me.requireLogin, false);
});

test('login rejects bad credentials and accepts the bootstrap admin', async () => {
  assert.equal((await login('root', 'wrong')).status, 401);
  const ok = await login('root', 'rootpass');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'admin');
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: ok.cookie } })).json();
  assert.equal(me.authenticated, true);
  assert.equal(me.role, 'admin');
  assert.equal(me.authMethod, 'local-admin');
});

test('settings writes are admin-gated (anon 403, admin 200, persisted)', async () => {
  assert.equal((await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: J, body: JSON.stringify({ branding: { siteName: 'X' } }) })).status, 403);
  const r = await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ branding: { siteName: 'Acme NOC' } }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).branding.siteName, 'Acme NOC');
  assert.equal(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).branding.siteName, 'Acme NOC');
});

test('local user lifecycle: admin creates → user logs in with their role → editor cannot administer', async () => {
  // anon cannot create
  assert.equal((await fetch(`${BASE}/api/users`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'x', password: 'secret1' }) })).status, 403);
  // admin creates an editor
  const created = await fetch(`${BASE}/api/users`, { method: 'POST', headers: withCookie(adminCookie), body: JSON.stringify({ username: 'pat', password: 'secret1', displayName: 'Pat', role: 'editor' }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).role, 'editor');
  // that user can log in and gets their role
  const pat = await login('pat', 'secret1');
  assert.equal(pat.status, 200);
  assert.equal(pat.body.role, 'editor');
  // editor is NOT admin → cannot create users or edit settings
  assert.equal((await fetch(`${BASE}/api/users`, { method: 'POST', headers: withCookie(pat.cookie), body: JSON.stringify({ username: 'y', password: 'secret1' }) })).status, 403);
  assert.equal((await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(pat.cookie), body: JSON.stringify({ branding: { siteName: 'Z' } }) })).status, 403);
  // admin lists, disables, then deletes
  assert.ok((await (await fetch(`${BASE}/api/users`, { headers: { Cookie: adminCookie } })).json()).users.some((u) => u.username === 'pat'));
  await fetch(`${BASE}/api/users/pat`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ disabled: true }) });
  assert.equal((await login('pat', 'secret1')).status, 401);   // disabled can't log in
  assert.equal((await fetch(`${BASE}/api/users/pat`, { method: 'DELETE', headers: { Cookie: adminCookie } })).status, 200);
});

test('logout clears the session', async () => {
  const s = await login('root', 'rootpass');
  assert.equal((await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: s.cookie } })).json()).authenticated, true);
  await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: s.cookie } });
  assert.equal((await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: s.cookie } })).json()).authenticated, false);
});

test('system CRUD is admin-gated and round-trips', async () => {
  assert.equal((await fetch(`${BASE}/api/systems`, { method: 'POST', headers: J, body: JSON.stringify({ id: 'x', name: 'X' }) })).status, 403);
  assert.equal((await fetch(`${BASE}/api/systems`, { method: 'POST', headers: withCookie(adminCookie), body: JSON.stringify({ id: 'f4', name: 'F4' }) })).status, 201);
  let ids = (await (await fetch(`${BASE}/api/systems`)).json()).systems.map((s) => s.id);
  assert.deepEqual(ids, ['f1', 'f4']);
  assert.equal((await fetch(`${BASE}/api/systems/f4`, { method: 'DELETE', headers: { Cookie: adminCookie } })).status, 200);
  ids = (await (await fetch(`${BASE}/api/systems`)).json()).systems.map((s) => s.id);
  assert.deepEqual(ids, ['f1']);
});

test('source uploads (print/config/topology) are gated to editor/admin', async () => {
  // anonymous is denied
  assert.equal((await fetch(`${BASE}/api/print-file?system=f1&name=x.txt`, { method: 'POST', body: 'x' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/config-file?system=f1`, { method: 'POST', body: 'x' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/topology-file?system=f1`, { method: 'POST', body: 'x' })).status, 403);
  // reads stay open
  assert.equal((await fetch(`${BASE}/api/print-file?system=f1`)).status, 200);

  // an editor passes the gate (400 = past auth, fails on the bogus body)
  await fetch(`${BASE}/api/users`, { method: 'POST', headers: withCookie(adminCookie), body: JSON.stringify({ username: 'eddy', password: 'secret1', role: 'editor' }) });
  const eddy = await login('eddy', 'secret1');
  const editorStatus = (await fetch(`${BASE}/api/print-file?system=f1&name=x.txt`, { method: 'POST', headers: { Cookie: eddy.cookie }, body: 'x' })).status;
  assert.notEqual(editorStatus, 403, 'editor passes the source gate');

  // work order is editor-gated too: anon 403, editor 200
  assert.equal((await fetch(`${BASE}/api/work-order?system=f1`)).status, 403, 'anon work-order denied');
  assert.equal((await fetch(`${BASE}/api/work-order?system=f1`, { headers: { Cookie: eddy.cookie } })).status, 200, 'editor work-order allowed');

  await fetch(`${BASE}/api/users/eddy`, { method: 'DELETE', headers: { Cookie: adminCookie } });
});

test('/me reports per-method auth status (local on, ldap/saml not configured)', async () => {
  const me = await (await fetch(`${BASE}/api/auth/me`)).json();
  assert.deepEqual(me.authMethods.local, { configured: true, enabled: true });
  assert.equal(me.authMethods.ldap.configured, false);
  assert.equal(me.authMethods.saml.configured, false);
});

test('sign-in toggles: unconfigured method can\'t activate; bootstrap admin is break-glass', async () => {
  // create a normal local user
  await fetch(`${BASE}/api/users`, { method: 'POST', headers: withCookie(adminCookie), body: JSON.stringify({ username: 'dana', password: 'secret1', role: 'editor' }) });
  assert.equal((await login('dana', 'secret1')).status, 200);

  // enabling LDAP without env config has no effect (effective stays off)
  await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ auth: { ldapEnabled: true } }) });
  assert.equal((await (await fetch(`${BASE}/api/auth/me`)).json()).authMethods.ldap.enabled, false);

  // disabling local blocks DB users but NOT the env bootstrap admin
  await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ auth: { localEnabled: false } }) });
  try {
    assert.equal((await login('dana', 'secret1')).status, 401, 'db local user blocked');
    assert.equal((await login('root', 'rootpass')).status, 200, 'bootstrap admin still in (break-glass)');
  } finally {
    await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ auth: { localEnabled: true } }) });
    await fetch(`${BASE}/api/users/dana`, { method: 'DELETE', headers: { Cookie: adminCookie } });
  }
});

test('in-app LDAP config is admin-only, masks the secret, and flips ldap.configured', async () => {
  // admin-only read/write
  assert.equal((await fetch(`${BASE}/api/auth-config`)).status, 403);
  assert.equal((await fetch(`${BASE}/api/auth-config/ldap`, { method: 'PATCH', headers: J, body: JSON.stringify({ url: 'ldaps://x:636' }) })).status, 403);

  // admin saves a connection incl. a secret
  const r = await fetch(`${BASE}/api/auth-config/ldap`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ url: 'ldaps://dc.corp.local:636', bindDn: 'cn=svc', bindPassword: 'NeverLeakMe', groupAdmin: 'cn=admins' }) });
  assert.equal(r.status, 200);
  const ldap = (await r.json()).ldap;
  assert.equal(ldap.url.value, 'ldaps://dc.corp.local:636');
  assert.equal(ldap.bindPassword.secret, true);
  assert.equal(ldap.bindPassword.value, undefined, 'secret never returned');

  // GET also masks it
  const got = (await (await fetch(`${BASE}/api/auth-config`, { headers: { Cookie: adminCookie } })).json()).ldap;
  assert.equal(got.bindPassword.hasValue, true);
  assert.equal(got.bindPassword.value, undefined);

  // /me now reports ldap configured (toggle can be enabled)
  assert.equal((await (await fetch(`${BASE}/api/auth/me`)).json()).authMethods.ldap.configured, true);

  // the secret is encrypted on disk
  const onDisk = fs.readFileSync(AUTH_CONFIG_FILE, 'utf8');
  assert.ok(!onDisk.includes('NeverLeakMe'));
  assert.ok(/v1:/.test(onDisk));
});

test('require-login wall: when on, anonymous is blocked except auth + settings GET', async () => {
  await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ safety: { requireLogin: true } }) });
  try {
    assert.equal((await fetch(`${BASE}/api/systems`)).status, 401, 'data blocked for anon');
    assert.equal((await fetch(`${BASE}/api/auth/me`)).status, 200, 'auth always open');
    assert.equal((await fetch(`${BASE}/api/settings`)).status, 200, 'settings GET open (for login-screen branding)');
    assert.equal((await fetch(`${BASE}/api/systems`, { headers: { Cookie: adminCookie } })).status, 200, 'admin passes');
  } finally {
    await fetch(`${BASE}/api/settings`, { method: 'PATCH', headers: withCookie(adminCookie), body: JSON.stringify({ safety: { requireLogin: false } }) });
  }
});
