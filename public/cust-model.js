// public/cust-model.js — pure model for Settings → Customers: search-to-add
// panels across every system, the group's panels grouped by system, and the
// member list (local accounts, directory users, directory groups).
//
// No DOM and no mutation: every function returns new values, so the UI in
// public/customers.js stays a thin render layer over this. Loaded in the
// browser as the `CustModel` global and required directly by the unit tests.

(function (root) {
  'use strict';

  const SEP = '\u0000';
  const USERNAME_RE = /^[a-zA-Z0-9._@\\-]{2,128}$/;   // mirrors lib/customer-db
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const sourceKey = (system, addr) => system + SEP + addr;
  const lc = (s) => String(s || '').toLowerCase();
  const tokens = (q) => lc(q).split(/\s+/).filter(Boolean);

  // Every whitespace-separated token must appear in the name, address, type or system name.
  function matches(item, query) {
    const ts = tokens(query);
    if (!ts.length) return true;
    const hay = lc(`${item.name || ''} ${item.addr || ''} ${item.type || ''} ${item.sysName || ''}`);
    return ts.every((t) => hay.includes(t));
  }

  const sysNameOf = (systems, id) => ((systems || []).find((s) => s.id === id) || {}).name || id;
  const sysOrder = (systems, id) => { const i = (systems || []).findIndex((s) => s.id === id); return i < 0 ? Infinity : i; };

  // The one panel whose name starts with `name`, or null when none or several
  // do — re-finds a source saved from a print that truncated its name. Names
  // only, never addresses. Mirrors lib/customer-scope.js (uniquePrefixMatch).
  function uniquePrefixMatch(panels, name) {
    if (!name) return null;
    const hits = panels.filter((p) => p.name && p.name.startsWith(name));
    return hits.length === 1 ? hits[0] : null;
  }

  // Look a stored source up in a system's panels: address first, then name (so
  // a panel renamed in the config tool still resolves), then a unique name prefix.
  function indexPanels(panels) {
    const list = panels || [];
    const byAddr = new Map(), byNm = new Map();
    for (const p of list) { if (p.addr) byAddr.set(p.addr, p); if (p.name) byNm.set(p.name, p); }
    return (s) => byAddr.get(s.addr) || byNm.get(s.name) || uniquePrefixMatch(list, s.name);
  }

  // The group's sources as [{system, sysName, items}] in system order. Items are
  // the live panel (current name/type/memberships) plus `key` and the stored
  // `source`; a source the current print no longer has stays, flagged `missing`.
  function resolveSources(panelsBySys, systems, sources) {
    const bySys = new Map();
    for (const s of sources || []) {
      if (!bySys.has(s.system)) bySys.set(s.system, []);
      bySys.get(s.system).push(s);
    }
    return [...bySys.entries()]
      .sort(([a], [b]) => sysOrder(systems, a) - sysOrder(systems, b))
      .map(([system, list]) => {
        const find = indexPanels((panelsBySys || {})[system]);
        const seen = new Map();
        for (const s of list) {
          const p = find(s);
          const key = sourceKey(system, s.addr);
          if (seen.has(key)) continue;
          seen.set(key, p ? { ...p, system, key, source: s } : { name: s.name || s.addr, addr: s.addr, system, key, source: s, missing: true, memberships: [] });
        }
        return { system, sysName: sysNameOf(systems, system), items: [...seen.values()].sort(byName) };
      });
  }

  // Panels matching `query` on every system, grouped by system. `added` marks
  // those already in the group (with the stored `sourceKey` to remove); `fresh` is every match not yet added (what "Add
  // all" acts on). `limit` caps only the rows returned for display.
  function search(panelsBySys, systems, sources, query, limit = Infinity) {
    const empty = { total: 0, shown: 0, fresh: [], groups: [] };
    if (!tokens(query).length) return empty;
    // live panel key → the stored source's key (they differ once a panel's address changed)
    const have = new Map();
    for (const s of sources || []) {
      const p = indexPanels((panelsBySys || {})[s.system])(s);
      have.set(sourceKey(s.system, p ? p.addr : s.addr), sourceKey(s.system, s.addr));
    }
    const out = { ...empty, groups: [] };
    for (const sys of systems || []) {
      const hits = ((panelsBySys || {})[sys.id] || [])
        .map((p) => ({ ...p, system: sys.id, sysName: sys.name, key: sourceKey(sys.id, p.addr) }))
        .filter((p) => matches(p, query))
        .sort(byName)
        .map((p) => (have.has(p.key) ? { ...p, added: true, sourceKey: have.get(p.key) } : { ...p, added: false }));
      if (!hits.length) continue;
      out.total += hits.length;
      out.fresh = [...out.fresh, ...hits.filter((h) => !h.added)];
      const room = Math.max(0, limit - out.shown);
      if (room) { out.groups = [...out.groups, { system: sys.id, sysName: sys.name, items: hits.slice(0, room) }]; out.shown += Math.min(room, hits.length); }
    }
    return out;
  }

  // Source lists are replaced, never edited in place.
  function addSources(sources, panels) {
    const out = new Map((sources || []).map((s) => [sourceKey(s.system, s.addr), s]));
    for (const p of panels || []) {
      const k = sourceKey(p.system, p.addr);
      if (!out.has(k)) out.set(k, { system: p.system, addr: p.addr, name: p.name });
    }
    return [...out.values()];
  }
  function removeSources(sources, keys) {
    const drop = new Set(keys || []);
    return (sources || []).filter((s) => !drop.has(sourceKey(s.system, s.addr)));
  }

  // ---------- members ----------
  const findLocal = (locals, name) => (locals || []).find((u) => lc(u.username) === lc(name)) || null;

  // One row per member: local accounts (in the group's order), then directory
  // users, then directory groups. `unscoped` = an admin/editor, who always sees everything.
  function memberRows(cust, locals) {
    const users = (cust && cust.users) || [];
    const local = [], dir = [];
    for (const u of users) {
      const acct = findLocal(locals, u);
      if (acct) local.push({ kind: 'local', value: u, label: acct.display_name || acct.username, sub: acct.display_name ? acct.username : acct.role, role: acct.role, unscoped: acct.role !== 'viewer' });
      else dir.push({ kind: 'user', value: u, label: u });
    }
    const groups = ((cust && cust.dirGroups) || []).map((g) => ({ kind: 'group', value: g, label: g }));
    return [...local, ...dir, ...groups];
  }

  // What the "Add member" field offers for `query`: viewer accounts not yet in
  // the group, then — when a directory (LDAP/SAML) is on — the typed text as a
  // directory user (if it's a valid username) and as a directory group.
  function memberSuggestions(query, cust, locals, directory) {
    const q = String(query || '').trim();
    const inGroup = new Set(((cust && cust.users) || []).map(lc));
    const viewers = (locals || [])
      .filter((u) => u.role === 'viewer' && !inGroup.has(lc(u.username)))
      .filter((u) => matches({ name: u.display_name || '', addr: u.username }, q))
      .map((u) => ({ kind: 'local', value: u.username, label: u.display_name || u.username, sub: u.display_name ? u.username : '' }));
    if (!directory || !q) return viewers;
    const extra = [];
    if (USERNAME_RE.test(q) && !findLocal(locals, q) && !inGroup.has(lc(q))) extra.push({ kind: 'user', value: q, label: q });
    if (!((cust && cust.dirGroups) || []).includes(lc(q))) extra.push({ kind: 'group', value: q, label: q });
    return [...viewers, ...extra];
  }

  function addMember(cust, m) {
    const users = (cust && cust.users) || [], dirGroups = (cust && cust.dirGroups) || [];
    if (m.kind === 'group') {
      const g = lc(m.value).trim();
      return { users, dirGroups: dirGroups.includes(g) ? dirGroups : [...dirGroups, g] };
    }
    return { users: users.some((u) => lc(u) === lc(m.value)) ? users : [...users, m.value], dirGroups };
  }
  function removeMember(cust, m) {
    const users = (cust && cust.users) || [], dirGroups = (cust && cust.dirGroups) || [];
    if (m.kind === 'group') return { users, dirGroups: dirGroups.filter((g) => g !== lc(m.value)) };
    return { users: users.filter((u) => lc(u) !== lc(m.value)), dirGroups };
  }

  const api = { sourceKey, matches, resolveSources, search, addSources, removeSources, memberRows, memberSuggestions, addMember, removeMember };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CustModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
