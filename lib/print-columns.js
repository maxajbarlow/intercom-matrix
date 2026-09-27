// lib/print-columns.js — split conference header rows into their name columns.
//
// A "Group & Conference List" header row reads Long Name | Local 8 | Alias |
// Grp/Conf | … and any of the name cells may contain spaces ("CNF #001",
// "Car 1"). `pdftotext -raw` collapses every gap to one space, so the columns
// can't be told apart from the text alone. `pdftotext -bbox` gives each word's
// position; the column edges come from each page's own "Long Name  Local 8
// Alias  Grp/Conf" header, so page scale and margins don't matter.
//
// markHeaderColumns then rewrites the matching -raw lines as
//   Long Name \t Local 8 \t Alias \t Conference <rest of the row>
// which lib/print-parser reads directly. Everything else in the text is left
// as it was, so a row that can't be matched simply parses the old way.
//
// Pure functions only: no I/O.

const EDGE = 1;   // pt of slack either side of a column edge

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

function pageWords(page) {
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g;
  return [...page.matchAll(re)].map((m) => ({ x: +m[1], y: +m[2], x2: +m[3], t: decode(m[4]) }));
}

// The conference-list column header on a page, or null (e.g. a Port List page,
// whose header has Local 8 / Alias but no Grp/Conf column).
function findHeader(words) {
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].t !== 'Long' || words[i + 1].t !== 'Name') continue;
    const row = words.filter((w) => Math.abs(w.y - words[i].y) < EDGE);
    const at = (t) => (row.find((w) => w.t === t) || {}).x;
    const h = { y: words[i].y, local: at('Local'), alias: at('Alias'), kind: at('Grp/Conf') };
    if (h.local != null && h.alias != null && h.kind != null) return h;
  }
  return null;
}

// A word the extractor glued across a column edge ("MANAGERVan") is cut where
// the edge falls, in proportion to its width.
function splitAtEdge(w, edge) {
  if (!(w.x < edge - EDGE && w.x2 > edge + EDGE) || w.t.length < 2) return [w];
  const k = Math.min(w.t.length - 1, Math.max(1, Math.round(((edge - w.x) / (w.x2 - w.x)) * w.t.length)));
  return [{ ...w, x2: edge, t: w.t.slice(0, k) }, { ...w, x: edge, t: w.t.slice(k) }];
}

function splitRow(line, h) {
  const words = line.flatMap((w) => splitAtEdge(w, h.local)).flatMap((w) => splitAtEdge(w, h.alias));
  const cell = (lo, hi) => words.filter((w) => w.x >= lo - EDGE && w.x < hi - EDGE).map((w) => w.t).join(' ');
  return { name: cell(-Infinity, h.local), local8: cell(h.local, h.alias), alias: cell(h.alias, h.kind) };
}

// poppler -bbox HTML → [{ name, local8, alias, kind }] for every header row, in page order.
function headerRowsFromBbox(html) {
  const rows = [];
  for (const page of String(html).split('<page').slice(1)) {
    const words = pageWords(page);
    const h = findHeader(words);
    if (!h) continue;
    const kinds = words.filter((w) => (w.t === 'Conference' || w.t === 'Group') && Math.abs(w.x - h.kind) < 3 && w.y > h.y + EDGE);
    for (const k of kinds.sort((a, b) => a.y - b.y)) {
      const line = words.filter((w) => Math.abs(w.y - k.y) < EDGE && w.x < h.kind - EDGE).sort((a, b) => a.x - b.x);
      rows.push({ ...splitRow(line, h), kind: k.t });
    }
  }
  return rows;
}

const squash = (s) => s.replace(/\s+/g, '');

// Rewrite each header row's -raw line with tab-separated name columns. Rows are
// matched in order by their text with whitespace ignored (the raw line may have
// glued words the bbox split); an unmatched row leaves its line untouched.
function markHeaderColumns(text, rows) {
  const lines = String(text).split('\n');
  const flat = lines.map(squash);
  let from = 0;
  for (const r of rows) {
    const key = squash(r.name + r.local8 + r.alias + r.kind);
    if (!key) continue;
    let j = from;
    while (j < lines.length && !flat[j].startsWith(key)) j++;
    if (j === lines.length) continue;
    let pos = 0;
    for (let seen = 0; seen < key.length; pos++) if (!/\s/.test(lines[j][pos])) seen++;
    const rest = lines[j].slice(pos).trim();
    lines[j] = `${r.name}\t${r.local8}\t${r.alias}\t${r.kind}${rest ? ' ' + rest : ''}`;
    from = j + 1;
  }
  return lines.join('\n');
}

module.exports = { headerRowsFromBbox, markHeaderColumns };
