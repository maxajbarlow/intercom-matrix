// server.js — host the live multi-system intercom-matrix viewer.
//
// Serves a single-page app (public/) and a read-only REST API backed by a
// per-system cached RRCS snapshot. Systems (Studio A, Studio B, Control Room, …) are
// defined in systems.json; every API call takes a ?system=<id> selector.
//
// Env:
//   PORT          HTTP port (default 8080)
//   SYSTEMS_FILE  path to systems.json (default ./systems.json)
//   REFRESH_SEC   server-side auto-refresh interval per system (0 = off)
//   RRCS_HOST     fallback single system if no systems.json

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const svc = require('./lib/rrcs-service');
const requests = require('./lib/request-service');
const settings = require('./lib/settings');
const authDb = require('./lib/auth-db');
const localUsers = require('./lib/local-users');
const authConfig = require('./lib/auth-config');
const buildAuthRouter = require('./lib/auth-routes');
const buildSamlRouter = require('./lib/saml-routes');
require('./lib/crypto-vault').ensureKey();   // mint/load the at-rest secret key at boot
const { buildWorkbookBuffer } = require('./lib/xlsx-export');
const { currentUser, can } = require('./lib/identity');

const PORT = Number(process.env.PORT) || 8080;
const REFRESH_SEC = process.env.REFRESH_SEC != null ? Number(process.env.REFRESH_SEC) : 0;
// Kill-switch for the unauthenticated first-run admin-creation endpoint. On by
// default; set ONBOARDING_OPEN=0 to force the env bootstrap admin (LOCAL_ADMIN_*)
// as the only way to mint the first admin (e.g. on an untrusted network).
const ONBOARDING_OPEN = !/^(0|false|off|no)$/i.test(String(process.env.ONBOARDING_OPEN ?? ''));

const app = express();
// NB: we intentionally do NOT `trust proxy` — it would let clients spoof
// X-Forwarded-For to bypass the login rate limiter. Behind a TLS-terminating
// reverse proxy, set COOKIE_SECURE=1 to force the Secure flag on session cookies.
app.use(express.json({ limit: '1mb' }));   // settings logo data-URIs can be a few hundred KB

// --- Authentication ----------------------------------------------------------
// Three local/LDAP paths in auth-routes; SAML SP in saml-routes. All converge on
// one session cookie that lib/identity currentUser() reads. Mounted before the
// require-login gate so /api/auth/* is always reachable (even when login is on).
const authRouter = buildAuthRouter();
app.use('/api/auth', authRouter);
app.use('/api/auth/saml/acs', express.urlencoded({ extended: false, limit: '512kb' })); // IdP posts form-encoded
app.use('/api/auth/saml', buildSamlRouter({
  createSession: authDb.createSession,
  sessionCookie: authRouter._sessionCookie,
  sessionTtl: authDb.SESSION_TTL_SEC,
}));

// Optional login wall. When safety.requireLogin is on, every /api route except
// /api/auth/* needs a valid session; otherwise anonymous = read-only viewer.
app.use('/api', (req, res, next) => {
  if (!settings.requireLogin()) return next();
  // Always-open even behind the wall: auth endpoints, and the read-only settings
  // GET (so the login screen can render the deployment's branding & theme).
  if (req.path.startsWith('/auth/')) return next();
  if (req.method === 'GET' && req.path === '/settings') return next();
  // First-run onboarding is reachable even behind a pre-set login wall: it's how
  // the first admin gets created. The endpoints self-lock once an admin exists.
  if (req.path === '/onboarding' || req.path.startsWith('/onboarding/')) return next();
  const u = currentUser(req);
  if (u.source === 'session') return next();
  res.status(401).json({ error: 'Authentication required' });
});

const sysId = (req) => (req.query.system || req.body?.system || svc.defaultSystem());

// Authorization gate — 403s unless the session identity may perform `action`.
// Deployment-config writes (settings, system CRUD, users) require the admin
// role; everything else is open (see lib/identity.js can()).
const gate = (action) => (req, res, next) =>
  can(currentUser(req), action) ? next() : res.status(403).json({ error: `"${action}" requires the admin role` });

// --- Systems -----------------------------------------------------------------
app.get('/api/systems', (req, res) => res.json({ default: svc.defaultSystem(), systems: svc.listSystems(), autoRefreshSec: REFRESH_SEC, rrcsEnabled: svc.rrcsEnabled() }));

// Point a system at a controller from the UI (persisted to systems.json).
app.post('/api/system-config', (req, res) => {
  try { res.json(svc.setSystemHost(req.body?.system, req.body?.host, req.body?.port)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Systems CRUD — engineer-gated (viewers get read-only via GET /api/systems).
app.post('/api/systems', gate('system:create'), (req, res) => {
  try { res.status(201).json(svc.createSystem(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/systems/reorder', gate('system:reorder'), (req, res) => {
  try { res.json({ systems: svc.reorderSystems(req.body?.order) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/systems/:id', gate('system:update'), (req, res) => {
  try { res.json(svc.updateSystem(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/systems/:id', gate('system:delete'), (req, res) => {
  try { res.json(svc.deleteSystem(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Shared deployment settings (branding / display / safety) ----------------
app.get('/api/settings', (req, res) => res.json(settings.getSettings()));
app.patch('/api/settings', gate('settings:write'), (req, res) => {
  try { res.json(settings.updateSettings(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- First-run onboarding ----------------------------------------------------
// The setup wizard mostly orchestrates the already-gated endpoints above; the
// only new surface is a status probe and a bootstrap-locked first-admin creator.
//
// "Fresh" = setup not yet marked complete (settings.meta.onboardedAt) AND
// something essential is still missing (no admin, or no system fed any data).
// Already-configured deployments are auto-stamped at boot (see app.listen) so
// the wizard never re-ambushes a live install.
function onboardingState() {
  const adminCount = localUsers.countAdmins(authDb.getDb());
  const steps = {
    admin: adminCount > 0,
    system: svc.listSystems().some((s) => s.configured),
  };
  const onboarded = settings.isOnboarded();
  return {
    active: !onboarded && (!steps.admin || !steps.system),
    onboarded,
    steps,
    // Whether the open admin-creation path is still available (locks at 1 admin,
    // or once setup is marked complete — mirrors the endpoint's own guards).
    canCreateAdmin: adminCount === 0 && ONBOARDING_OPEN && !onboarded,
  };
}

// At boot, a deployment that already has an admin, a configured system, or the
// login wall on was clearly set up before the wizard existed — stamp it so the
// wizard stays dormant.
function deploymentLooksConfigured() {
  return localUsers.countAdmins(authDb.getDb()) > 0
    || svc.listSystems().some((s) => s.configured)
    || settings.requireLogin();
}

const onboardingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test' && process.env.LOGIN_RATE_LIMIT_FORCE !== '1',
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts; try again later' }),
});

// Public status probe — drives whether the SPA launches the wizard on load.
app.get('/api/onboarding', (req, res) => res.json(onboardingState()));

// Create the FIRST admin and open a session, in one un-authenticated step.
// SECURITY: this is the only account-creating path that doesn't require a prior
// session, so it MUST self-lock. node:sqlite is synchronous and Node is
// single-threaded, so the COUNT→INSERT below runs with no await between — two
// racing requests are serialised, and the second sees the admin and 409s.
app.post('/api/onboarding/admin', onboardingLimiter, (req, res) => {
  try {
    if (!ONBOARDING_OPEN) return res.status(403).json({ error: 'First-run admin creation is disabled (ONBOARDING_OPEN=0) — use the bootstrap admin' });
    // A stamped onboardedAt is the definitive "bootstrap window closed" signal —
    // it covers LDAP/SAML-only deployments (no local-admin row to count) and a
    // setup where every local admin was later deleted/disabled.
    if (settings.isOnboarded()) return res.status(409).json({ error: 'Setup is already complete — sign in instead' });
    const db = authDb.getDb();
    if (localUsers.countAdmins(db) > 0) return res.status(409).json({ error: 'An admin already exists — sign in instead' });
    const { username, password, displayName } = req.body || {};
    const u = localUsers.createLocalUser(db, { username, password, displayName, role: 'admin', createdBy: 'first-run setup' });
    const session = authDb.createSession(u.username, u.display_name || u.username, 'admin', 'local');
    res.setHeader('Set-Cookie', authRouter._sessionCookie(session.token, session.ttl, req));
    res.status(201).json({ username: u.username, displayName: u.display_name, role: u.role });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Local users (username/password accounts) — admin-gated ------------------
// LDAP/SAML users are not stored here; this is the locally-managed roster.
app.get('/api/users', gate('user:read'), (req, res) => res.json({ users: localUsers.listLocalUsers(authDb.getDb()) }));
app.post('/api/users', gate('user:create'), (req, res) => {
  try {
    const { username, password, displayName, role } = req.body || {};
    const u = localUsers.createLocalUser(authDb.getDb(), { username, password, displayName, role, createdBy: currentUser(req).name });
    res.status(201).json({ username: u.username, display_name: u.display_name, role: u.role, created_at: u.created_at });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/users/:username', gate('user:update'), (req, res) => {
  try {
    const updates = {};
    if (typeof req.body?.displayName === 'string') updates.displayName = req.body.displayName.trim();
    if (typeof req.body?.role === 'string') updates.role = req.body.role;
    if (typeof req.body?.password === 'string' && req.body.password) updates.password = req.body.password;
    if (typeof req.body?.disabled === 'boolean') updates.disabled = req.body.disabled;
    const u = localUsers.updateLocalUser(authDb.getDb(), req.params.username, updates);
    res.json({ username: u.username, display_name: u.display_name, role: u.role, disabled_at: u.disabled_at });
  } catch (e) { res.status(e.message === 'User not found' ? 404 : 400).json({ error: e.message }); }
});
app.delete('/api/users/:username', gate('user:delete'), (req, res) => {
  const ok = localUsers.deleteLocalUser(authDb.getDb(), req.params.username);
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'User not found' });
});

// --- LDAP / SAML connection config (admin-only; secrets masked on read) -------
// Secrets are encrypted at rest (lib/crypto-vault). This endpoint NEVER returns
// a secret value — the public GET /api/settings stays secret-free too.
app.get('/api/auth-config', gate('authconfig:read'), (req, res) => {
  res.json({ ldap: authConfig.redacted('ldap'), saml: authConfig.redacted('saml') });
});
app.patch('/api/auth-config/ldap', gate('authconfig:write'), (req, res) => {
  try { res.json({ ldap: authConfig.update('ldap', req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/auth-config/saml', gate('authconfig:write'), (req, res) => {
  try { res.json({ saml: authConfig.update('saml', req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/auth-config/ldap/test', gate('authconfig:write'), async (req, res) => {
  try { res.json(await authConfig.testLdap(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Per-system data (read-only) ---------------------------------------------
app.get('/api/status', (req, res) => {
  const s = svc.getSnapshot(sysId(req));
  if (!s) return res.status(404).json({ error: 'unknown system' });
  res.json({ ok: s.ok, error: s.error, stale: s.stale, lastError: s.lastError, lastErrorAt: s.lastErrorAt, system: s.system, host: s.host, port: s.port, fetchedAt: s.fetchedAt, counts: s.counts, config: s.config, autoRefreshSec: REFRESH_SEC });
});
app.get('/api/snapshot', (req, res) => { const s = svc.getSnapshot(sysId(req)); s ? res.json(s) : res.status(404).json({ error: 'unknown system' }); });
app.get('/api/matrix', (req, res) => { const s = svc.getSnapshot(sysId(req)); s ? res.json({ ok: s.ok, system: s.system, fetchedAt: s.fetchedAt, matrix: s.matrix }) : res.status(404).json({ error: 'unknown system' }); });
app.get('/api/conferences', (req, res) => { const s = svc.getSnapshot(sysId(req)); s ? res.json({ ok: s.ok, fetchedAt: s.fetchedAt, conferences: s.conferences, groups: s.groups }) : res.status(404).json({ error: 'unknown system' }); });
app.get('/api/panels', (req, res) => { const s = svc.getSnapshot(sysId(req)); s ? res.json({ ok: s.ok, fetchedAt: s.fetchedAt, panels: s.panels }) : res.status(404).json({ error: 'unknown system' }); });

// Export the current snapshot to a 3-sheet .xlsx (Matrix / Conferences / Panels).
app.get('/api/export.xlsx', async (req, res) => {
  const s = svc.getSnapshot(sysId(req));
  if (!s) return res.status(404).json({ error: 'unknown system' });
  if (!s.ok) return res.status(409).json({ error: 'no data to export yet for this system' });
  try {
    const buf = await buildWorkbookBuffer(s);
    const slug = String((s.system && s.system.name) || 'system').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'system';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="intercom-matrix_${slug}_${stamp}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: 'export failed: ' + e.message }); }
});

// Trigger a read-only re-pull for one system.
app.post('/api/refresh', async (req, res) => {
  try {
    const s = await svc.refresh(sysId(req), { force: true });
    res.json({ ok: s.ok, error: s.error, stale: s.stale, lastError: s.lastError, system: s.system, host: s.host, fetchedAt: s.fetchedAt, counts: s.counts });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- controller config (.Art/.ash) for key-access, per system ------------------
app.get('/api/config-file', (req, res) => res.json(svc.configInfoFor(sysId(req))));
app.post('/api/config-file', gate('source:write'), express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
    const name = (req.query.name || 'uploaded config').toString();
    res.json(svc.loadConfigBuffer(sysId(req), req.body, name));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/config-file', gate('source:write'), (req, res) => { try { res.json(svc.clearConfig(sysId(req))); } catch (e) { res.status(400).json({ error: e.message }); } });

// --- Node topology (Net→Node→Card→Port tree) for grouping/filtering ---------
app.get('/api/topology-file', (req, res) => res.json(svc.topologyInfoFor(sysId(req))));
app.post('/api/topology-file', gate('source:write'), express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
    const name = (req.query.name || 'topology.txt').toString();
    res.json(svc.loadTopologyBuffer(sysId(req), req.body, name));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/topology-file', gate('source:write'), (req, res) => { try { res.json(svc.clearTopology(sysId(req))); } catch (e) { res.status(400).json({ error: e.message }); } });

// --- config print (PDF/text) as an offline matrix source -------------------
app.get('/api/print-file', (req, res) => res.json(svc.printInfoFor(sysId(req))));
app.post('/api/print-file', gate('source:write'), express.raw({ type: () => true, limit: '64mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
    const name = (req.query.name || 'print.pdf').toString();
    const sys = sysId(req);
    const out = svc.loadPrintBuffer(sys, req.body, name);
    // a fresh print is the verification signal — reconcile open requests against it
    let reconciliation = null;
    try { reconciliation = requests.reconcile(sys); } catch (e) { reconciliation = { ok: false, reason: e.message }; }
    res.json({ ...out, reconciliation });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/print-file', gate('source:write'), (req, res) => { try { res.json(svc.clearPrint(sysId(req))); } catch (e) { res.status(400).json({ error: e.message }); } });

// Version history + GitHub-style diff between two stored print versions.
app.get('/api/print-versions', (req, res) => res.json({ versions: svc.printVersions(sysId(req)) }));
app.get('/api/print-diff', (req, res) => { try { res.json(svc.printDiff(sysId(req), req.query.from, req.query.to)); } catch (e) { res.status(400).json({ error: e.message }); } });

// --- Change-request platform -------------------------------------------------
// Requests capture change INTENT (no live writes); an engineer applies them in
// the config tool and the next print reconciles them. Identity is claimed (no auth yet).
app.get('/api/requests', (req, res) => {
  try { res.json({ requests: requests.listRequests({ system: sysId(req), status: req.query.status }), stats: requests.stats(sysId(req)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/requests', (req, res) => {
  try { res.status(201).json(requests.createRequest({ ...req.body, system: sysId(req) }, currentUser(req))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/requests/:id', (req, res) => {
  const r = requests.getRequest(Number(req.params.id));
  r ? res.json(r) : res.status(404).json({ error: 'unknown request' });
});
app.post('/api/requests/:id/transition', (req, res) => {
  try { res.json(requests.transition(Number(req.params.id), req.body?.to, currentUser(req), req.body?.note)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/requests/:id/comments', (req, res) => {
  try { res.json(requests.addComment(Number(req.params.id), currentUser(req), req.body?.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/pending', (req, res) => { try { res.json(requests.pendingChanges(sysId(req))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/work-order', gate('workorder:read'), (req, res) => { try { res.json(requests.workOrder(sysId(req))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/requests-reconcile', (req, res) => { try { res.json(requests.reconcile(sysId(req))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/requests-backup', (req, res) => { try { res.json(requests.backup()); } catch (e) { res.status(400).json({ error: e.message }); } });

// --- Static SPA --------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  const defs = svc.init();
  // Suppress the first-run wizard for deployments that were configured before it
  // existed (admin present, a system fed, or the login wall on). A truly fresh
  // install matches none of these and gets the wizard on first browser load.
  if (!settings.isOnboarded() && deploymentLooksConfigured()) settings.markOnboarded();
  console.log(`Intercom Matrix → http://localhost:${PORT}`);
  console.log(`  Systems: ${defs.map((d) => `${d.name}${d.host ? ' (' + d.host + ')' : ' (unconfigured)'}`).join(', ') || '(none — set systems.json or RRCS_HOST)'}`);
  if (onboardingState().active) console.log('  Setup: first-run wizard will launch on first browser visit');
  console.log(`  Auto-refresh: ${REFRESH_SEC > 0 ? REFRESH_SEC + 's' : 'off'}`);
  if (!svc.rrcsEnabled()) {
    console.log('  RRCS: DISABLED (print/offline only) — set RRCS_ENABLED=1 to turn live RRCS back on');
    return;
  }
  for (const d of defs) {
    if (!d.host) continue;
    svc.refresh(d.id, { force: true }).then((s) => console.log(`  [${d.id}] ${s.ok ? 'ok — ' + JSON.stringify(s.counts) : 'failed — ' + s.error}`)).catch(() => {});
    if (REFRESH_SEC > 0) setInterval(() => svc.refresh(d.id, { force: true }).catch(() => {}), REFRESH_SEC * 1000);
  }
});
