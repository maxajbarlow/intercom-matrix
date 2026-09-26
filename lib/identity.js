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
//
// CUSTOMER SCOPING: user.customers is null (sees everything) or the list of
// customer groups whose data the user is confined to (lib/customer-db). Rules:
//   • admin / editor         → null — Riedel engineers always see the whole system
//   • no groups defined yet  → null — deployments without customers behave as before
//   • viewer                 → the groups matching their username or directory
//                              groups; [] = scoped to nothing (sees no data)
// Once any customer group exists, loginRequired() turns the login wall on, since
// an anonymous viewer couldn't be scoped.

const authDb = require('./auth-db');
const customerDb = require('./customer-db');
const localUsers = require('./local-users');
const settings = require('./settings');
const { parseToken } = require('./auth-routes');

const ANON = Object.freeze({ id: null, name: 'anonymous', role: 'viewer', source: 'anon', customers: null });

const UNSCOPED_ROLES = new Set(['admin', 'editor']);

function customersFor(username, role, dirGroups) {
  if (UNSCOPED_ROLES.has(role)) return null;
  const db = authDb.getDb();
  if (!customerDb.hasCustomers(db)) return null;
  return username ? customerDb.customersForUser(db, username, dirGroups) : [];
}

// "View as" (lib/view-as): an admin session previewing a viewer or one customer
// group resolves to THAT identity, re-derived on every request so a deleted
// target simply sees nothing. `viewAs` marks it; server.js makes it read-only.
function viewAsUser(session) {
  const db = authDb.getDb();
  const t = session.viewAs;
  const realUser = session.username;
  if (t.kind === 'group') {
    const c = customerDb.getCustomer(db, t.customerId);
    return {
      id: null, name: c ? c.name : 'deleted group', username: null, role: 'viewer', source: 'session',
      customers: c ? [{ id: c.id, name: c.name }] : [],
      viewAs: { kind: 'group', customerId: t.customerId, label: c ? c.name : 'deleted group', realUser },
    };
  }
  const local = localUsers.getLocalUser(db, t.username);
  const name = (local && local.display_name) || t.username;
  return {
    id: t.username, name, username: t.username, role: 'viewer', source: 'session',
    customers: customersFor(t.username, 'viewer', []),
    viewAs: { kind: 'user', username: t.username, label: name, realUser },
  };
}

function currentUser(req) {
  const session = authDb.getSession(parseToken(req));
  if (!session) return customerDb.hasCustomers(authDb.getDb()) ? { ...ANON, customers: [] } : ANON;
  if (session.viewAs && session.role === 'admin') return viewAsUser(session);
  const role = session.role || 'viewer';
  return {
    id: session.username,
    name: session.display_name || session.username,
    username: session.username,
    role,
    source: 'session',
    customers: customersFor(session.username, role, session.dirGroups),
  };
}

// The effective login wall: the admin toggle, or forced on by customer groups.
function loginRequired() {
  return settings.requireLogin() || customerDb.hasCustomers(authDb.getDb());
}

// Actions that change shared deployment configuration — admin only.
const ADMIN_ACTIONS = new Set([
  'settings:write',
  'system:create', 'system:update', 'system:delete', 'system:reorder',
  'user:read', 'user:create', 'user:update', 'user:delete',
  'authconfig:read', 'authconfig:write',
  'customer:read', 'customer:write',
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

module.exports = { currentUser, can, loginRequired, ADMIN_ACTIONS, EDITOR_ACTIONS };
