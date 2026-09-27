// lib/all-systems.js — change requests, pending changes and the work order for
// the "All systems" view. Requests stay per system (each is raised against one
// system's print), so every system is asked on its own — scoped to the viewer on
// THAT system — and the answers are merged, each item tagged with its system.

const requests = require('./request-service');
const access = require('./customer-access');

// [{ id, name, v }] — the viewer's systems with their per-system visibility filter.
function systemsFor(user) {
  return access.visibleSystems(user).map((s) => {
    const scope = access.scopeFor(user, s.id);
    return { id: s.id, name: s.name, v: scope ? { scope, userId: user.id } : null };
  });
}

function listAll(user, status) {
  const list = [];
  const byStatus = {};
  for (const s of systemsFor(user)) {
    list.push(...requests.listRequests({ system: s.id, status }, s.v));
    const st = requests.stats(s.id, s.v);
    for (const [k, n] of Object.entries(st.byStatus || {})) byStatus[k] = (byStatus[k] || 0) + n;
  }
  list.sort((a, b) => b.id - a.id);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { requests: list, stats: { total, byStatus, open: byStatus.open || 0 } };
}

function pendingAll(user) {
  const out = { changes: [], newConferences: [], deletedConferences: [] };
  for (const s of systemsFor(user)) {
    const p = requests.pendingChanges(s.id, s.v);
    out.changes.push(...p.changes.map((c) => ({ ...c, system: s.id, sysName: s.name })));
    out.newConferences.push(...p.newConferences);
    out.deletedConferences.push(...p.deletedConferences);
  }
  return out;
}

// Engineers only (gated at the route) — never customer-scoped.
function workOrderAll(user) {
  const out = { system: 'all', groups: [], conferenceCount: 0, changeCount: 0, requestCount: 0 };
  for (const s of systemsFor(user)) {
    const wo = requests.workOrder(s.id);
    out.groups.push(...wo.groups.map((g) => ({ ...g, system: s.id, sysName: s.name })));
    out.conferenceCount += wo.conferenceCount; out.changeCount += wo.changeCount; out.requestCount += wo.requestCount;
  }
  return out;
}

module.exports = { listAll, pendingAll, workOrderAll };
