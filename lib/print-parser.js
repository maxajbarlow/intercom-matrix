// lib/print-parser.js — parse a controller "Print" (Group & Conference
// List) into conferences + their member keys (panel, direction). This is the
// resolved key programming — the offline matrix source.
//
// Extract the text with `pdftotext -raw` (poppler), which cleanly separates the
// otherwise-overlapping columns. A PDF buffer is written to a temp file and run
// through pdftotext; a text buffer (already-extracted -raw output) is parsed
// directly. Print to A3 / wide so panel names aren't truncated.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isPdf(buf) { return Buffer.isBuffer(buf) && buf.length > 4 && buf.toString('latin1', 0, 5) === '%PDF-'; }

// Resolve the pdftotext executable. Order: explicit PDFTOTEXT_BIN env override,
// then a binary vendored for this platform (Windows has no package manager, so
// vendor/poppler/win-x64 ships with the app), then a bare `pdftotext` resolved
// from PATH (macOS via brew, Linux/Docker via poppler-utils). The bundled .exe
// loads the DLLs sitting next to it, so we point at the full path, not the dir.
function resolvePdftotext() {
  const override = process.env.PDFTOTEXT_BIN;
  if (override && fs.existsSync(override)) return override;
  if (process.platform === 'win32') {
    const bundled = path.join(__dirname, '..', 'vendor', 'poppler', 'win-x64', 'pdftotext.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'pdftotext';  // PATH lookup
}

// PDF buffer -> raw text. Uses a vendored or PATH-resolved pdftotext (see
// resolvePdftotext). Throws a helpful error if absent.
// pdftotext must read the PDF from a real file (PDF parsing seeks to the xref at
// the end of the file, which a stdin pipe can't do — that fails with an EOF
// error), so write the upload to a temp file and extract to a temp .txt.
function pdfToText(buf) {
  const stamp = process.pid + '-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
  const inPath = path.join(os.tmpdir(), 'imx-' + stamp + '.pdf');
  const outPath = path.join(os.tmpdir(), 'imx-' + stamp + '.txt');
  try {
    fs.writeFileSync(inPath, buf);
    execFileSync(resolvePdftotext(), ['-raw', inPath, outPath], { maxBuffer: 128 * 1024 * 1024 });
    return fs.readFileSync(outPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && /pdftotext/.test(String(e.path || e.message || ''))) {
      throw new Error('pdftotext (poppler) not found on the server. Either install it, or upload the extracted text (run: pdftotext -raw print.pdf print.txt).');
    }
    throw new Error('pdftotext failed: ' + (e.stderr ? e.stderr.toString().trim() : (e.message || e)));
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* ignore */ }
    try { fs.unlinkSync(outPath); } catch { /* ignore */ }
  }
}

function toText(buf) { return isPdf(buf) ? pdfToText(buf) : buf.toString('utf8'); }

// --- key-info parsing (which key, on which panel) ----------------------------
function parseKeyInfo(s) {
  s = s.replace(/^\s*(?:Conf|Grp|Group|IFB)[- ]?Cmd\s*/i, '').trim();
  let panel = null, panelType = null, truncated = false, m;
  if ((m = s.match(/on Panel '([^']+)' \(type ([^)]+)\)/))) { panel = m[1]; panelType = m[2]; }
  else if ((m = s.match(/on Bolero Wireless Beltpack '([^']+)'/))) { panel = m[1]; panelType = 'Bolero Wireless Beltpack'; }
  else if ((m = s.match(/on panel '([^']+)'/))) { panel = m[1]; }
  else if ((m = s.match(/on ([A-Za-z0-9-]+) \([^)]*\) '([^']+)'/))) { panelType = m[1]; panel = m[2]; }
  else if ((m = s.match(/on ([A-Za-z0-9-]+) \([^)]*\) '([^']*)$/))) { panelType = m[1]; panel = m[2]; truncated = true; }
  let key = null;
  const km = s.match(/(?:\[\s*Display\s*\d+\s*\]\s*)?(Virtual Key \d+|Key \d+|Virtual Function '[^']+')/);
  if (km) {
    key = km[1];
    const bank = s.match(/\(Key Bank \d+\)/); if (bank) key += ' ' + bank[0];
    const exp = s.match(/\(Exp \d+\)/); if (exp) key += ' ' + exp[0];
  }
  return { panel: panel ? panel.trim() : null, panelType, truncated, key };
}

// Trailing key info is optional: a conference/group with no keys ends right
// after the two counts (e.g. "Name Alias Conference <not assigned> 0 0").
const HEADER = /^(.+?)\s+(\S+)\s+(Conference|Group)\s+(<[^>]*>|\S+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/;
const CMD = /^\s*(?:Conf|Grp|Group|IFB)[- ]?Cmd\b/i;
const DEST = /^Destination \(([^)]*)\)/;
// pdftotext -raw sometimes merges a key's "Destination (talk, listen)" directive
// onto the end of the Conf-Cmd (or header) line; catch it inline so the
// direction isn't lost.
const DEST_INLINE = /Destination \(([^)]*)\)\s*$/;
const SKIP = /^(Port List|Node Configuration|Group and Conference List|Long Name\b|Net:|Page \d+ of)/;

// Parse raw print text into conferences with member keys.
function parsePrintText(text) {
  const lines = text.split(/\r?\n/);
  const conferences = [];
  let cur = null, pending = null;
  const flush = (dir) => {
    if (cur && pending) cur.keys.push({ ...pending, talk: /talk/i.test(dir || ''), listen: /listen/i.test(dir || '') });
    pending = null;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t || SKIP.test(t)) continue;
    const h = t.match(HEADER);
    if (h && (h[3] === 'Conference' || h[3] === 'Group')) {
      flush(null);
      cur = { name: h[1].trim(), alias: h[2].trim(), kind: h[3].toLowerCase(), keys: [] };
      conferences.push(cur);
      const col7 = h[7] || ''; // empty for a conference/group with no keys
      if (CMD.test(col7) || /\bon (Panel|panel|Bolero|[A-Z]+-\d)/.test(col7)) {
        pending = parseKeyInfo(col7);
        const di = col7.match(DEST_INLINE); if (di) flush(di[1]); // inline directive on header line
      }
      continue;
    }
    const dm = t.match(DEST);
    if (dm) { flush(dm[1]); continue; }
    if (CMD.test(t)) {
      flush(null); pending = parseKeyInfo(t);
      const di = t.match(DEST_INLINE); if (di) flush(di[1]); // inline directive on cmd line
      continue;
    }
    if (pending && pending.panel == null) { const k = parseKeyInfo('Conf-Cmd ' + t); if (k.panel) pending = { ...pending, ...k }; }
  }
  flush(null);

  const keyAssignments = conferences.reduce((a, c) => a + c.keys.length, 0);
  const truncated = conferences.reduce((a, c) => a + c.keys.filter((k) => k.truncated).length, 0);
  const unattributed = conferences.reduce((a, c) => a + c.keys.filter((k) => !k.panel).length, 0);
  return { conferences, stats: { conferences: conferences.length, keyAssignments, truncated, unattributed } };
}

module.exports = { toText, parsePrintText, parseKeyInfo, isPdf };
