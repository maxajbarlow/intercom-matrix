// lib/view-as.js — an admin previews what a customer viewer (or a whole
// customer group) sees.
//
// The target is stored on the admin's SESSION (auth-db view_as) and applied in
// lib/identity currentUser(), so every data route scopes through the same seam a
// real viewer's request does — the preview can't drift from the real thing.
// server.js makes the preview read-only (no writes as someone else).
//
// Targets:
//   { kind: 'user',  username }    a local VIEWER account, or a directory user
//                                   named in a customer group (their directory-
//                                   group memberships can't be known offline)
//   { kind: 'group', customerId }  exactly one customer group — covers members
//                                   who get in through a directory group

const localUsers = require('./local-users');
const customerDb = require('./customer-db');

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// Request body → a stored target, or throw { status } for a bad one.
function validateTarget(db, body) {
  const b = body || {};
  if (b.customerId != null) {
    const c = customerDb.getCustomer(db, b.customerId);
    if (!c) throw httpError(404, 'Customer group not found');
    return { kind: 'group', customerId: c.id };
  }
  const username = String(b.username || '').trim();
  if (!username) throw httpError(400, 'username or customerId is required');
  const local = localUsers.getLocalUser(db, username);
  if (local) {
    if (local.role !== 'viewer') throw httpError(400, `${local.username} is ${local.role === 'admin' ? 'an admin' : 'an editor'} and already sees everything`);
    return { kind: 'user', username: local.username };
  }
  if (!customerDb.customersForUser(db, username, []).length) throw httpError(404, `No viewer account or customer-group member named "${username}"`);
  return { kind: 'user', username };
}

module.exports = { validateTarget };
