// lib/saml-routes.js — SAML 2.0 Service Provider, mounted at /api/auth/saml/*.
//
//   GET  /login     — build an AuthnRequest, redirect to the IdP
//   POST /acs        — Assertion Consumer Service: validate the IdP response,
//                      create a session, redirect to RelayState
//   GET  /metadata  — SP metadata XML for IdP-side configuration
//   POST /logout    — initiate SAML Single Logout (when configured)
//
// Sessions go through the same auth-db createSession + cookie shape as the
// local/LDAP paths, so SAML users are indistinguishable to the app's RBAC.

const express = require('express');
const rateLimit = require('express-rate-limit');
const settings = require('./settings');
const authConfig = require('./auth-config');
const { resolveRole } = require('./auth-helpers');

// "Configured" = the IdP connection (entry/issuer/callback + cert) is resolvable
// from in-app config OR env. "Active" = configured AND the admin's Settings →
// Users toggle is on.
const samlConfiguredFromEnv = () => authConfig.samlConfigured();   // name kept for callers
const samlActive = () => authConfig.samlConfigured() && !!settings.authConfig().samlEnabled;

// Build a SAML instance from the effective config (in-app over env). Returns null
// if not configured — route handlers check samlActive() first for the toggle.
function buildSamlInstance() {
  const s = authConfig.effective('saml');
  if (!s.entryPoint || !s.issuer || !s.callbackUrl || !s.idpCert) return null;
  const { SAML } = require('@node-saml/node-saml');
  const opts = {
    entryPoint: s.entryPoint,
    issuer: s.issuer,
    callbackUrl: s.callbackUrl,
    idpCert: s.idpCert,
    wantAssertionsSigned: s.wantAssertionsSigned !== false,
    wantAuthnResponseSigned: s.wantAuthnResponseSigned !== false,
    signatureAlgorithm: s.signatureAlgorithm || 'sha256',
    identifierFormat: s.nameIdFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    acceptedClockSkewMs: 30_000,
    disableRequestedAuthnContext: true,
  };
  if (s.spPrivateKey) opts.privateKey = s.spPrivateKey;
  if (s.spCert) opts.publicCert = s.spCert;
  if (s.logoutUrl) opts.logoutUrl = s.logoutUrl;
  return new SAML(opts);
}

// Same-origin sanitization for RelayState — accept only local path values so a
// post-login redirect can't be coerced to an external site. Must reject not just
// protocol-relative `//host` but also the backslash bypass `/\host` and `\\host`
// (browsers normalize `\` to `/`), and anything carrying a scheme. We resolve
// against a throwaway origin and require the result stay on it.
function safeRelayState(raw) {
  if (typeof raw !== 'string' || !raw) return '/';
  if (!raw.startsWith('/')) return '/';                 // must be an absolute path
  if (raw.startsWith('//') || raw.includes('\\')) return '/';   // no protocol-relative / backslash tricks
  try {
    const u = new URL(raw, 'http://placeholder.invalid');
    if (u.origin !== 'http://placeholder.invalid') return '/';  // escaped same-origin → reject
    return u.pathname + u.search + u.hash;
  } catch { return '/'; }
}

function pickAttr(profile, attrName, fallbacks) {
  const a = profile.attributes || {};
  const attr = (attrName || '').trim();
  if (attr && a[attr]) { const v = a[attr]; return Array.isArray(v) ? v[0] : v; }
  for (const f of fallbacks || []) if (a[f]) return Array.isArray(a[f]) ? a[f][0] : a[f];
  return null;
}
const pickUsername = (p, cfg) => pickAttr(p, cfg.usernameAttribute, []) || p.nameID;
const pickDisplayName = (p, cfg, fb) => pickAttr(p, cfg.displayNameAttribute, ['displayName', 'cn', 'name']) || fb;
function pickGroups(profile, cfg) {
  const attr = (cfg.groupsAttribute || '').trim();
  if (!attr) return [];
  const v = profile.attributes ? profile.attributes[attr] : null;
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean).map(String).map((s) => s.toLowerCase());
}

module.exports = function buildSamlRouter({ createSession, sessionCookie, sessionTtl }) {
  const router = express.Router();

  const skipLimit = process.env.NODE_ENV === 'test' && process.env.LOGIN_RATE_LIMIT_FORCE !== '1';
  const acsLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: parseInt(process.env.SAML_ACS_RATE_LIMIT_MAX, 10) || 60,
    standardHeaders: true, legacyHeaders: false,
    skip: () => skipLimit,
    handler: (req, res) => res.status(429).send('Too many SSO requests'),
  });

  router.get('/login', async (req, res) => {
    if (!samlActive()) return res.status(503).json({ error: 'SAML sign-in is turned off' });
    const saml = buildSamlInstance();
    if (!saml) return res.status(503).json({ error: 'SAML is not configured' });
    try {
      const relayState = safeRelayState(req.query.next);
      res.redirect(await saml.getAuthorizeUrlAsync(relayState, req.headers.host, {}));
    } catch (e) { console.error('[auth][saml] /login error:', e.message); res.status(500).json({ error: 'Failed to initiate SSO' }); }
  });

  router.post('/acs', acsLimiter, async (req, res) => {
    if (!samlActive()) return res.status(503).send('SAML sign-in is turned off');
    const saml = buildSamlInstance();
    if (!saml) return res.status(503).send('SAML is not configured');
    try {
      const cfg = authConfig.effective('saml');
      const { profile, loggedOut } = await saml.validatePostResponseAsync(req.body);
      if (loggedOut || !profile) return res.status(400).send('Invalid SAML response');
      const username = pickUsername(profile, cfg);
      if (!username) return res.status(400).send('SAML response missing identifier');
      const role = resolveRole(pickGroups(profile, cfg), { admin: cfg.groupAdmin, editor: cfg.groupEditor, viewer: cfg.groupViewer });
      if (!role) { console.warn(`[auth][saml] user ${username} matched no allowed group`); return res.status(403).send('Not authorized: not a member of any allowed group'); }
      const displayName = pickDisplayName(profile, cfg, username);
      const session = createSession(username, displayName, role, 'saml');
      // SameSite=Lax: the ACS POST returns cross-site; Strict would drop the
      // cookie on the follow-up redirect. The token is unguessable, so Lax is OK.
      res.setHeader('Set-Cookie', sessionCookie(session.token, sessionTtl, req).replace('SameSite=Strict', 'SameSite=Lax'));
      res.redirect(safeRelayState(req.body && req.body.RelayState));
    } catch (e) { console.error('[auth][saml] /acs validation failed:', e.message); res.status(401).send('SAML assertion validation failed'); }
  });

  router.get('/metadata', (req, res) => {
    const saml = buildSamlInstance();
    if (!saml) return res.status(503).send('SAML is not configured');
    res.type('application/xml').send(saml.generateServiceProviderMetadata(authConfig.effective('saml').spCert || null));
  });

  router.post('/logout', async (req, res) => {
    const cfg = authConfig.effective('saml');
    const saml = buildSamlInstance();
    if (!saml || !cfg.logoutUrl) return res.status(503).json({ error: 'SAML logout not configured' });
    try {
      const url = await saml.getLogoutUrlAsync({ nameID: req.body && req.body.nameID, nameIDFormat: cfg.nameIdFormat }, '/', {});
      res.json({ url });
    } catch (e) { console.error('[auth][saml] /logout error:', e.message); res.status(500).json({ error: 'Failed to build logout URL' }); }
  });

  router._samlActive = samlActive;
  return router;
};

module.exports.samlConfiguredFromEnv = samlConfiguredFromEnv;
module.exports.samlActive = samlActive;
module.exports.safeRelayState = safeRelayState;
