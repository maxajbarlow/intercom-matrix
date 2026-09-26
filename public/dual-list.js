// public/dual-list.js — pure model for the two-pane "transfer list" picker used
// by Settings → Customers (Available panels ⇄ the group's source panels).
//
// No DOM and no mutation: every function returns new values, so the UI in
// public/customers.js stays a thin render/paint layer over this. Loaded in the
// browser as the `DualList` global and required directly by the unit tests.

(function (root) {
  'use strict';

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });

  // Every whitespace-separated token must appear in the name or address.
  function matches(item, query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const hay = `${item.name || ''} ${item.addr || ''}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  // Split a system's panels into the group's CHOSEN source panels and the rest.
  // A stored source matches a panel by address first, then by name (so a panel
  // renamed in the config tool still resolves). A source with no matching panel
  // stays on the chosen side flagged `missing`, so it can be seen and removed.
  // Items carry `key` (stable per row) and chosen ones their stored `source`.
  function splitSources(panels, sources) {
    const byAddr = new Map(), byNm = new Map();
    for (const p of panels || []) { if (p.addr) byAddr.set(p.addr, p); if (p.name) byNm.set(p.name, p); }
    const chosen = new Map();
    for (const s of sources || []) {
      const p = byAddr.get(s.addr) || byNm.get(s.name);
      if (p) { if (!chosen.has(p.addr)) chosen.set(p.addr, { ...p, key: p.addr, source: s }); }
      else { const key = 'missing:' + s.addr; if (!chosen.has(key)) chosen.set(key, { name: s.name || s.addr, addr: s.addr, key, missing: true, source: s }); }
    }
    const available = (panels || []).filter((p) => !chosen.has(p.addr)).map((p) => ({ ...p, key: p.addr }));
    return { available: available.sort(byName), chosen: [...chosen.values()].sort(byName) };
  }

  function toggle(set, key) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }

  // Inclusive run of keys between anchor and target, in visible order.
  function range(visibleKeys, anchorKey, targetKey) {
    const a = visibleKeys.indexOf(anchorKey), b = visibleKeys.indexOf(targetKey);
    if (b < 0) return [];
    if (a < 0) return [targetKey];
    return visibleKeys.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  // Selected items that are also visible under the filter (what a move acts on).
  function visibleSelected(items, selected, query) {
    return items.filter((i) => selected.has(i.key) && matches(i, query));
  }

  const api = { matches, splitSources, toggle, range, visibleSelected };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DualList = api;
})(typeof window !== 'undefined' ? window : globalThis);
