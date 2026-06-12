// lib/name-match.js — resolve a panel key label to a conference / group.
//
// A key label is the 8-char alias the operator put on the button; for a key that
// joins a conference it is (usually) that conference's Label or LongName. Tiered
// match: exact alias -> compact -> listen-strip ("Lstn_RBR"->RBR) -> long name
// -> unique substring. Used to add "key-access" edges the membership lacks.

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const compact = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const stripListen = (s) => { const m = String(s || '').match(/^\s*(?:lstn|listen|lis)[_\s.-]+(.+)$/i); return m ? m[1] : null; };
const add = (map, k, v) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

// dests: [{ name, label, kind, idx }]  (conferences + groups, with their col idx)
function buildConfMatcher(dests) {
  const byLabel = new Map(), byLabelC = new Map(), byLong = new Map(), byLongC = new Map();
  const all = [];
  for (const d of dests) {
    const info = { name: d.name, label: d.label, kind: d.kind, idx: d.idx };
    all.push(info);
    add(byLabel, norm(d.label), info);
    add(byLabelC, compact(d.label), info);
    add(byLong, norm(d.name), info);
    add(byLongC, compact(d.name), info);
  }
  function resolve(text) {
    const n = norm(text), c = compact(text), ls = stripListen(text);
    if (byLabel.has(n)) return byLabel.get(n)[0];
    if (c && byLabelC.has(c)) return byLabelC.get(c)[0];
    if (ls) { const r = resolve(ls); if (r) return r; }
    if (byLong.has(n)) return byLong.get(n)[0];
    if (c && byLongC.has(c)) return byLongC.get(c)[0];
    if (c && c.length >= 4) {
      const hits = all.filter((d) => compact(d.name).includes(c));
      const uniq = [...new Set(hits.map((d) => d.name))];
      if (uniq.length === 1) return hits[0];
    }
    return null;
  }
  return { resolve };
}

module.exports = { buildConfMatcher };
