// lib/conference-match.js — decide when conferences on different systems are the
// same channel, for the combined "All systems" view.
//
// Deterministic and explainable (no scoring): two conferences match when, after
// normalising, they have the same KIND and the same SET of words.
//   1. strip the tags prints add per system: an "IM-" prefix, a leading "[FIA]"-style tag
//   2. strip a trailing copy of the conference's own label ("… Pitstand PRPStand")
//   3. lowercase, split on anything non-alphanumeric, compare as a set — so case,
//      punctuation, word order and repeated words don't matter
// Numbers are words, so "Driver 08" never matches "Driver 09". Default
// placeholders ("Conference #001", "DynaConf") never match: they share a name on
// every system without being the same channel.
//
// Pure functions only.

const PLACEHOLDER = /^(conference\s*#?\s*\d+|dynaconf)\b/i;
const SEP = '\u0000';

function cleanName(name, label) {
  let n = String(name || '').trim().replace(/^IM-/i, '').replace(/^\[[^\]]*\]\s*/, '');
  const l = String(label || '').trim();
  if (l && n.toLowerCase().endsWith(' ' + l.toLowerCase()) && n.length > l.length + 1) n = n.slice(0, -(l.length + 1)).trim();
  return n;
}

// Normalised identity of a conference/group, or null when it must never match.
function matchKey(dest) {
  const n = cleanName(dest && dest.name, dest && dest.label);
  if (!n || PLACEHOLDER.test(n)) return null;
  const words = [...new Set(n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))].sort();
  if (!words.length) return null;
  return (dest.kind || 'conference') + '|' + words.join(' ');
}

// systems: ordered [{ id, name }]; destsBySys: { sysId: [{ name, label, kind }] }.
// → ordered merged destinations: { id, name, label, kind, matched, variants: [{ system, sysName, name, label }] }.
// A column holds at most one conference per system; a key that occurs twice on
// one system is ambiguous and is not merged anywhere. The merged column takes the
// name/label of its first system in `systems` order.
function clusterDests(systems, destsBySys) {
  const order = (systems || []).filter((s) => (destsBySys || {})[s.id]);
  const keyed = order.map((s) => ({ s, items: destsBySys[s.id].map((d) => ({ d, key: matchKey(d) })) }));

  const ambiguous = new Set();
  for (const { items } of keyed) {
    const seen = new Set();
    for (const { key } of items) { if (!key) continue; if (seen.has(key)) ambiguous.add(key); seen.add(key); }
  }

  const out = [];
  const byKey = new Map();
  for (const { s, items } of keyed) {
    for (const { d, key } of items) {
      const variant = { system: s.id, sysName: s.name, name: d.name, label: d.label || '' };
      if (key && !ambiguous.has(key)) {
        const hit = byKey.get(key);
        if (hit) { hit.variants.push(variant); hit.matched = true; continue; }
        const col = { id: 'k' + SEP + key, name: d.name, label: d.label || '', kind: d.kind || 'conference', matched: false, variants: [variant] };
        byKey.set(key, col); out.push(col);
      } else {
        out.push({ id: 's' + SEP + s.id + SEP + (d.kind || 'conference') + SEP + d.name, name: d.name, label: d.label || '', kind: d.kind || 'conference', matched: false, variants: [variant] });
      }
    }
  }
  return out;
}

module.exports = { matchKey, clusterDests, cleanName };
