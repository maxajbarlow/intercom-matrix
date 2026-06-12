// lib/auth-routes.js — login / logout / me, mounted at /api/auth.
//
// Three credential paths, tried in order:
//   1. LOCAL_ADMIN_USER / LOCAL_ADMIN_PASS  — a bootstrap admin from env, so
//      there's always a way in before any accounts exist.
//   2. local accounts            — username/password created in Settings → Users
//      (scrypt-hashed in the auth DB), each with its own role.
//   3. LDAP / Active Directory   — when LDAP_URL is configured; the user binds,
//      group membership maps to a role via LDAP_GROUP_* (lib/auth-helpers).
//
// SAML is a fourth path in lib/saml-routes.js. All paths converge on one session
// row (auth-db) and one cookie shape, so the rest of the app sees them alike.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const authDb = require('./auth-db');
const localUsers = require('./local-users');
const settings = require('./settings');
const authConfig = require('./auth-config');
const { resolveRole, classifyTlsError } = require('./auth-helpers');

const COOKIE = 'imx_session';

// --- LDAP login (connection config resolved by lib/auth-config: in-app over env)
async function ldapAuth(username, password) {
  const eff = authConfig.effective('ldap');
  const client = await authConfig.makeLdapClient(eff);
  try {
    if (eff.bindDn) await client.bind(eff.bindDn, eff.bindPassword);
    const escapeLdap = (s) => s.replace(/[\\*()\x00/]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    const filter = (eff.userFilter || '(sAMAccountName={{username}})').replace(/\{\{username\}\}/g, escapeLdap(username));
    const searchBase = (eff.userSearchBase || eff.baseDn || '').trim();
    const { searchEntries } = await client.search(searchBase, { scope: 'sub', filter, attributes: ['dn', 'cn', 'displayName', 'memberOf', 'sAMAccountName'] });
    if (!searchEntries.length) return { ok: false, error: 'Invalid credentials' };   // don't reveal which arm failed
    const user = searchEntries[0];
    const userClient = await authConfig.makeLdapClient(eff);
    try { await userClient.bind(user.dn, password); }
    catch { return { ok: false, error: 'Invalid credentials' }; }
    finally { await userClient.unbind().catch(() => {}); }
    const groups = (Array.isArray(user.memberOf) ? user.memberOf : [user.memberOf]).filter(Boolean).map((g) => String(g).toLowerCase());
    const role = resolveRole(groups, { admin: eff.groupAdmin, editor: eff.groupEditor, viewer: eff.groupViewer });
    if (!role) return { ok: false, error: 'Not authorized: not a member of any allowed group' };
    return { ok: true, username: user.sAMAccountName || username, displayName: user.displayName || user.cn || username, role };
  } catch (e) {
    const { code, label } = classifyTlsError(e);
    console.error(`[auth][ldap] failure label=${label} code=${code || 'n/a'} msg=${e && e.message ? e.message : e}`);
    return { ok: false, error: 'Authentication failed' };
  } finally { await client.unbind().catch(() => {}); }
}

// --- cookie -------------------------------------------------------------------
function shouldSecure(req) {
  if (req && req.secure) return true;
  const force = (process.env.COOKIE_SECURE || '').toLowerCase();
  return force === '1' || force === 'true';
}
function sessionCookie(token, maxAge, req) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (shouldSecure(req)) parts.push('Secure');
  return parts.join('; ');
}
function parseToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (cookie) return cookie.split('=').slice(1).join('=');
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// --- local credential paths ---------------------------------------------------
const LOCAL_ADMIN_USER = process.env.LOCAL_ADMIN_USER || '';
const LOCAL_ADMIN_PASS = process.env.LOCAL_ADMIN_PASS || '';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function localAdminAuth(username, password) {
  if (!LOCAL_ADMIN_USER || !LOCAL_ADMIN_PASS) return null;
  if (safeEqual(username, LOCAL_ADMIN_USER) && safeEqual(password, LOCAL_ADMIN_PASS)) {
    return { ok: true, username, displayName: username, role: 'admin' };
  }
  return null;
}
function dbLocalUserAuth(username, password) {
  const user = localUsers.getLocalUser(authDb.getDb(), username);
  if (!user) return null;
  if (localUsers.isDisabled(user)) return { ok: false, error: 'Account disabled' };
  if (!localUsers.verifyPassword(password, user.password_salt, user.password_hash)) return null;
  return { ok: true, username: user.username, displayName: user.display_name || user.username, role: user.role || 'viewer' };
}

// --- effective enablement -----------------------------------------------------
// "Configured" = connection params exist in env (fixed at boot). A method is
// "active" only when configured AND its Settings → Users toggle is on. The
// env-configured bootstrap admin (LOCAL_ADMIN_*) is always accepted as a
// break-glass path, independent of the localEnabled toggle.
const ldapConfigured = () => authConfig.ldapConfigured();   // in-app OR env
const ldapActive = () => ldapConfigured() && !!settings.authConfig().ldapEnabled;
const localActive = () => !!settings.authConfig().localEnabled;
const samlRoutes = require('./saml-routes');

// --- router -------------------------------------------------------------------
module.exports = function buildAuthRouter() {
  const router = express.Router();

  authDb.cleanSessions();
  setInterval(() => authDb.cleanSessions(), 3600000).unref();

  const skipLimit = process.env.NODE_ENV === 'test' && process.env.LOGIN_RATE_LIMIT_FORCE !== '1';
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => skipLimit,
    handler: (req, res) => res.status(429).json({ error: 'Too many login attempts; try again later' }),
  });

  function issue(res, req, u) {
    const session = authDb.createSession(u.username, u.displayName, u.role, u.method || 'local');
    res.setHeader('Set-Cookie', sessionCookie(session.token, session.ttl, req));
    return res.json({ username: u.username, displayName: u.displayName, role: u.role });
  }

  router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    // Bootstrap admin is always accepted (break-glass), even if the local toggle
    // is off — so an admin can't lock themselves out by disabling every method.
    const admin = localAdminAuth(username, password);
    if (admin) return issue(res, req, { ...admin, method: 'local-admin' });

    if (localActive()) {
      const dbLocal = dbLocalUserAuth(username, password);
      if (dbLocal && dbLocal.ok) return issue(res, req, { ...dbLocal, method: 'local' });
      if (dbLocal && dbLocal.ok === false) return res.status(401).json({ error: dbLocal.error || 'Invalid credentials' });
    }

    if (!ldapActive()) return res.status(401).json({ error: 'Invalid credentials' });
    const result = await ldapAuth(username, password);
    if (!result.ok) return res.status(401).json({ error: result.error });
    return issue(res, req, { ...result, method: 'ldap' });
  });

  router.post('/logout', (req, res) => {
    authDb.deleteSession(parseToken(req));
    res.setHeader('Set-Cookie', sessionCookie('', 0, req));
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const session = authDb.getSession(parseToken(req));
    // Effective (active) flags drive the login screen; authMethods carries the
    // richer configured-vs-enabled detail the admin Users panel renders.
    const local = localActive(), ldap = ldapActive(), saml = samlRoutes.samlActive();
    const base = {
      requireLogin: settings.requireLogin(),
      localEnabled: local, ldapEnabled: ldap, samlEnabled: saml,
      authMethods: {
        local: { configured: true, enabled: local },
        ldap: { configured: ldapConfigured(), enabled: ldap },
        saml: { configured: samlRoutes.samlConfiguredFromEnv(), enabled: saml },
      },
    };
    if (!session) return res.json({ authenticated: false, ...base });
    res.json({ authenticated: true, username: session.username, displayName: session.display_name, role: session.role, authMethod: session.auth_method, ...base });
  });

  // Shared with server.js (request gating) and lib/saml-routes.js.
  router._parseToken = parseToken;
  router._sessionCookie = sessionCookie;
  router._ldapActive = ldapActive;
  return router;
};

module.exports.parseToken = parseToken;
module.exports.sessionCookie = sessionCookie;
