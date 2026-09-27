// lib/print-parser.js — parse a controller "Print" (Group & Conference
// List) into conferences + their member keys (panel, direction). This is the
// resolved key programming — the offline matrix source.
//
// Extract the text with `pdftotext -raw` (poppler), which cleanly separates the
// otherwise-overlapping columns. A PDF buffer is written to a temp file and run
// through pdftotext; a text buffer (already-extracted -raw output) is parsed
// directly. A second -bbox pass splits each conference header row into Long
// Name / Local 8 / Alias by word position (lib/print-columns), since those
// cells can hold spaces that -raw text can't place.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { headerRowsFromBbox, markHeaderColumns } = require('./print-columns');

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
//
// The crop box is widened far past the page: pdftotext drops text outside the
// page by default, and config-tool prints (on A4) overflow the Port/Info column,
// so panel names were cut ('Race Cont…') though the PDF holds them in full.
const NO_CROP = ['-x', '0', '-y', '0', '-W', '100000', '-H', '100000'];

// Word positions (-bbox) mark where each header row's name columns split (see
// lib/print-columns). Best effort: if that pass fails, the -raw text is still
// returned and those rows parse the old way.
function markColumns(bin, inPath, text) {
  const bboxPath = inPath.replace(/\.pdf$/, '.bbox.html');
  try {
    execFileSync(bin, ['-bbox', ...NO_CROP, inPath, bboxPath], { maxBuffer: 128 * 1024 * 1024 });
    return markHeaderColumns(text, headerRowsFromBbox(fs.readFileSync(bboxPath, 'utf8')));
  } catch (e) {
    console.warn('print: column split skipped —', e.message || e);
    return text;
  } finally {
    try { fs.unlinkSync(bboxPath); } catch { /* ignore */ }
  }
}

function pdfToText(buf) {
  const stamp = process.pid + '-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
  const inPath = path.join(os.tmpdir(), 'imx-' + stamp + '.pdf');
  const outPath = path.join(os.tmpdir(), 'imx-' + stamp + '.txt');
  try {
    fs.writeFileSync(inPath, buf);
    execFileSync(resolvePdftotext(), ['-raw', ...NO_CROP, inPath, outPath], { maxBuffer: 128 * 1024 * 1024 });
    return markColumns(resolvePdftotext(), inPath, fs.readFileSync(outPath, 'utf8'));
  } catch (e) {
    const bin = resolvePdftotext();
    // On Windows the bundled pdftotext.exe needs the Microsoft Visual C++ runtime.
    // When it's absent the OS can't load the .exe (STATUS_DLL_NOT_FOUND, 0xC0000135),
    // which surfaces as that exit status — or even ENOENT despite the .exe existing.
    const dllLoadFail = e.status === 3221225781 || e.status === -1073741515;
    const bundledExeExists = bin !== 'pdftotext' && fs.existsSync(bin);
    if (process.platform === 'win32' && bundledExeExists && (dllLoadFail || e.code === 'ENOENT')) {
      throw new Error('The bundled PDF tool could not start — the Microsoft Visual C++ runtime is missing. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and restart, or upload the pre-extracted text (run: pdftotext -raw print.pdf print.txt).');
    }
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
// Legacy (untabbed) text only — its single-token alias misreads a Local 8 with a space.
const HEADER = /^(.+?)\s+(\S+)\s+(Conference|Group)\s+(<[^>]*>|\S+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/;
// A header row whose name columns lib/print-columns split by position:
// Long Name \t Local 8 \t Alias \t Conference|Group <rest of the row>.
const TAB_HEADER = /^([^\t]+)\t([^\t]*)\t([^\t]*)\t(Conference|Group)\b\s*(.*)$/;
const CMD = /^\s*(?:Conf|Grp|Group|IFB)[- ]?Cmd\b/i;
const CMD_ANY = /(?:Conf|Grp|Group|IFB)[- ]?Cmd\b/i;
const ON_PANEL = /\bon (Panel|panel|Bolero|[A-Z]+-\d)/;
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
  // Start a conference/group; `keyText` is the row's trailing first key, if any.
  const open = (name, alias, printAlias, kind, keyText) => {
    flush(null);
    const cell = (s) => (/^<[^>]*>$/.test(s.trim()) ? '' : s.trim());   // "<not available>" is no alias
    cur = { name: name.trim(), alias: cell(alias), printAlias: cell(printAlias), kind: kind.toLowerCase(), keys: [] };
    conferences.push(cur);
    if (keyText && (CMD.test(keyText) || ON_PANEL.test(keyText))) {
      pending = parseKeyInfo(keyText);
      const di = keyText.match(DEST_INLINE); if (di) flush(di[1]); // inline directive on header line
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t || SKIP.test(t)) continue;
    const th = t.match(TAB_HEADER);
    if (th) {
      // the columns after the kind vary (a named GPIO, "<none>" …): find the key by its command
      const at = th[5].search(CMD_ANY);
      open(th[1], th[2], th[3], th[4], at >= 0 ? th[5].slice(at) : th[5]);
      continue;
    }
    const h = t.match(HEADER);
    if (h) {
      open(h[1], h[2], '', h[3], h[7] || ''); // h[7] is empty for a conference/group with no keys
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
