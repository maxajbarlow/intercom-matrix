// public/names.js — which name a conference or panel shows.
//
// A conference has a long name and an 8-character alias (the print's "Local 8
// Alias", carried as `label`). The alias is what the panels' key displays show,
// so it is the display name wherever one exists, with the long name one hover
// away (public/tooltip.js reads data-tip). Panels only have a long name.
//
// No DOM and no mutation. Loaded in the browser as the `Names` global and
// required directly by the unit tests.

(function (root) {
  'use strict';

  const SEP = '\u0000';
  const str = (s) => (s == null ? '' : String(s)).trim();

  // The name to show: the alias when there is one, else the long name.
  function short(d) { return str(d && d.label) || str(d && d.name); }

  // Hover text: the long name first, then any extra detail lines.
  function tip(d, ...extra) { return [str(d && d.name), ...extra.map(str)].filter(Boolean).join('\n'); }

  // Long name -> alias over a snapshot, for places that only carry a conference's
  // name (requests, the work order, the composer). All systems: each variant is
  // also keyed by its system, so a system's real name resolves to its own alias.
  function aliasIndex(data) {
    const idx = new Map();
    const dests = [...((data && data.conferences) || []), ...((data && data.groups) || [])];
    for (const d of dests) {
      if (str(d.label) && !idx.has(d.name)) idx.set(d.name, str(d.label));
      for (const v of d.variants || []) if (str(v.label)) idx.set(v.system + SEP + v.name, str(v.label));
    }
    return idx;
  }
  function aliasOf(idx, name, system) { return (system && idx.get(system + SEP + name)) || idx.get(name) || ''; }

  const api = { short, tip, aliasIndex, aliasOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Names = api;
})(typeof window !== 'undefined' ? window : globalThis);
