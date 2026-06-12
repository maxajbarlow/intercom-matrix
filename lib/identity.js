// lib/identity.js — the single identity/authorization seam.
//
// Identity now comes from an authenticated SESSION (lib/auth-db), not a
// self-claimed header. currentUser(req) resolves the session cookie to a user +
// role; with no valid session the request is an anonymous viewer (read-only).
// The pre-auth X-Imx-* header trust is gone — picking your own role is no longer
// possible. When the login wall (settings.requireLogin) is on, server.js blocks
// anonymous requests outright before they reach here.
//
// can() is the authorization gate: reads and change-requests stay open to all,
// but DEPLOYMENT-CONFIG mutations (settings, system list, user accounts) require
// the `admin` role.

const authDb = require('./auth-db');
const { parseToken } = require('./auth-routes');

const ANON = Object.freeze({ id: null, name: 'anonymous', role: 'viewer', source: 'anon' });

function currentUser(req) {
  const session = authDb.getSession(parseToken(req));
  if (!session) return ANON;
  return {
    id: session.username,
    name: session.display_name || session.username,
    username: session.username,
    role: session.role || 'viewer',
    source: 'session',
  };
}

// Actions that change shared deployment configuration — admin only.
const ADMIN_ACTIONS = new Set([
  'settings:write',
  'system:create', 'system:update', 'system:delete', 'system:reorder',
  'user:read', 'user:create', 'user:update', 'user:delete',
  'authconfig:read', 'authconfig:write',
]);

// Operational writes that change a system's data sources (uploading a config
// print / key-access config / topology). Require editor or admin. Everything
// NOT listed in either set (reads, refreshes, change-requests) stays open.
const EDITOR_ACTIONS = new Set([
  'source:write',
  'workorder:read',   // the consolidated implementation do-list — engineers only
]);

// eslint-disable-next-line no-unused-vars
function can(user, action, context) {
  if (ADMIN_ACTIONS.has(action)) return !!user && user.role === 'admin';
  if (EDITOR_ACTIONS.has(action)) return !!user && (user.role === 'admin' || user.role === 'editor');
  return true;
}

module.exports = { currentUser, can, ADMIN_ACTIONS, EDITOR_ACTIONS };
