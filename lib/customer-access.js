// lib/customer-access.js — apply a user's customer scope to live data.
//
// The glue between identity (who, which customer groups), customer-db (their
// source panels) and customer-scope (pure derivation/filtering). server.js calls
// ONLY these helpers on every read path, so there's one place scoping happens.
//
// Convention: a scope of null means UNSCOPED (admin/editor, or no customer
// groups defined) — callers pass data through untouched.

const svc = require('./rrcs-service');
const authDb = require('./auth-db');
const customerDb = require('./customer-db');
const { resolveScope, filterSnapshot } = require('./customer-scope');

const idsOf = (user) => (user.customers || []).map((c) => c.id);

// The derived scope for `user` on a system, or null when unscoped. Sources are
// looked up by the snapshot's REAL system id (getSnapshot falls back to the
// default system for an unknown id — the scope must follow the data returned).
function scopeFor(user, systemId) {
  if (!user || !user.customers) return null;
  const snap = svc.getSnapshot(systemId);
  const realId = snap && snap.system ? snap.system.id : systemId;
  const sources = customerDb.sourcesFor(authDb.getDb(), idsOf(user), realId);
  const scope = resolveScope(snap, sources);
  scope.meta = {
    customers: user.customers.map((c) => c.name),
    sourcePanels: sources.length,
    missingSources: scope.missingSources.length,
  };
  return scope;
}

// The snapshot `user` may see for a system (null = unknown system).
function scopedSnapshot(user, systemId) {
  const snap = svc.getSnapshot(systemId);
  if (!snap) return null;
  const scope = scopeFor(user, systemId);
  return scope ? filterSnapshot(snap, scope, scope.meta) : snap;
}

// Systems list for `user`: unscoped → everything; scoped → only systems where
// their customer groups have source panels, with connection details stripped
// and counts reflecting what they'll actually see.
function visibleSystems(user) {
  const all = svc.listSystems();
  if (!user || !user.customers) return all;
  const allowed = new Set(customerDb.systemsFor(authDb.getDb(), idsOf(user)));
  return all.filter((s) => allowed.has(s.id)).map((s) => {
    const snap = scopedSnapshot(user, s.id);
    return {
      id: s.id, name: s.name, configured: s.configured, source: s.source,
      ok: s.ok, stale: s.stale, error: s.error, fetchedAt: s.fetchedAt, lastErrorAt: s.lastErrorAt,
      config: { loaded: false }, topology: { loaded: false }, print: { loaded: !!(s.print && s.print.loaded), history: [] },
      vsp: { loaded: false }, counts: snap ? snap.counts : null,
    };
  });
}

module.exports = { scopeFor, scopedSnapshot, visibleSystems };
