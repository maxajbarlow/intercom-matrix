// xlsx-export.js — render a snapshot to a professional 3-sheet workbook that
// mirrors the web UI: Matrix (panel × conference grid), Conferences (each
// conference with its members), Panels (each panel with its memberships).
//
// The matrix is sparse — only the relationship edges (snapshot.matrix.cells)
// are styled, never the full rows×cols grid — so even a 718×464 system stays
// fast and small. Direction glyphs match the UI: ● Talk · ○ Listen · ⊗ both ·
// · via key.

const ExcelJS = require('exceljs');

// ---- palette (ARGB) ---------------------------------------------------------
const C = {
  ink: 'FF111827', sub: 'FF6B7280', line: 'FFD1D5DB',
  band: 'FF1F2937', bandText: 'FFFFFFFF',
  head: 'FFE5E7EB', headText: 'FF111827', zebra: 'FFF9FAFB',
  talkF: 'FF1D4ED8', talkBg: 'FFEFF6FF',
  listenF: 'FF0F766E', listenBg: 'FFF0FDFA',
  bothF: 'FF6D28D9', bothBg: 'FFF5F3FF',
  keyF: 'FF6B7280', keyBg: 'FFF3F4F6',
};
const FONT = 'Calibri';
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: C.line } };
const boxThin = { top: thin, left: thin, bottom: thin, right: thin };

// ---- direction helpers (mirror the UI symbol/colour scheme) -----------------
const dirText = (t, l) => (t && l ? 'Talk + Listen' : t ? 'Talk' : l ? 'Listen' : '—');
function dirStyle(t, l) {
  if (t && l) return { font: C.bothF, bg: C.bothBg };
  if (t) return { font: C.talkF, bg: C.talkBg };
  if (l) return { font: C.listenF, bg: C.listenBg };
  return { font: C.sub, bg: null };
}
function dirSym(t, l, k) {
  if (k) return { s: '·', font: C.keyF, bg: C.keyBg };
  if (t && l) return { s: '⊗', font: C.bothF, bg: C.bothBg };
  if (t) return { s: '●', font: C.talkF, bg: C.talkBg };
  if (l) return { s: '○', font: C.listenF, bg: C.listenBg };
  return null;
}

// ---- small cell helpers -----------------------------------------------------
function put(ws, r, c, value, opt = {}) {
  const cell = ws.getCell(r, c);
  cell.value = value;
  cell.font = { name: FONT, size: opt.size || 10, bold: !!opt.bold, color: { argb: opt.font || C.ink } };
  if (opt.bg) cell.fill = fill(opt.bg);
  cell.alignment = { vertical: 'middle', horizontal: opt.center ? 'center' : 'left', indent: opt.indent || 0, wrapText: !!opt.wrap };
  if (opt.border) cell.border = boxThin;
  return cell;
}
function headCell(ws, r, c, label) {
  return put(ws, r, c, label, { bold: true, font: C.headText, bg: C.head, border: true, size: 10 });
}
function metaLine(snap) {
  const cnt = snap.counts || {};
  const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
  const parts = [
    `Source: ${snap.source === 'print' ? 'config print (offline)' : 'live RRCS'}`,
    `${cnt.panels || snap.matrix.rows.length} panels`,
    `${(snap.conferences || []).length + (snap.groups || []).length} conferences`,
    `${cnt.cells != null ? cnt.cells : snap.matrix.cells.length} memberships`,
  ];
  if (snap.fetchedAt) parts.push(`data ${when(snap.fetchedAt)}`);
  parts.push(`exported ${new Date().toLocaleString()}`);
  return parts.join('  ·  ');
}
function titleBlock(ws, lastColLetter, title, meta, legend) {
  ws.mergeCells(`A1:${lastColLetter}1`);
  const t = ws.getCell('A1');
  t.value = title;
  t.font = { name: FONT, size: 16, bold: true, color: { argb: C.ink } };
  t.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;
  ws.mergeCells(`A2:${lastColLetter}2`);
  const m = ws.getCell('A2');
  m.value = meta;
  m.font = { name: FONT, size: 10, color: { argb: C.sub } };
  if (legend) {
    ws.mergeCells(`A3:${lastColLetter}3`);
    const lg = ws.getCell('A3');
    lg.value = legend;
    lg.font = { name: FONT, size: 10, color: { argb: C.sub } };
  }
}

// ---- Sheet 1: Matrix (panel rows × conference columns) ----------------------
function addMatrixSheet(wb, snap) {
  const { rows, cols, cells } = snap.matrix;
  const COL0 = 3;   // first conference column (C)
  const HDR = 5;    // rotated conference-header row
  const DATA0 = 6;  // first data row
  const ws = wb.addWorksheet('Matrix', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: HDR }],
    pageSetup: { orientation: 'landscape', paperSize: 8, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }, // 8 = A3
  });

  const lastCol = COL0 + cols.length - 1;
  const lastColLetter = ws.getColumn(Math.max(lastCol, 4)).letter;
  titleBlock(ws, lastColLetter,
    `Intercom Matrix — ${snap.system && snap.system.name ? snap.system.name : ''}`,
    metaLine(snap),
    'Legend:   ● Talk    ○ Listen    ⊗ Talk + Listen    · via key');

  // leading frozen columns
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 22;
  headCell(ws, HDR, 1, 'Panel');
  headCell(ws, HDR, 2, 'Port');

  // rotated conference headers; size the header row to the longest name
  let maxLen = 8;
  cols.forEach((c, j) => {
    const label = c.name + (c.label ? ` (${c.label})` : '');
    maxLen = Math.max(maxLen, label.length);
    const cell = ws.getCell(HDR, COL0 + j);
    cell.value = label;
    cell.font = { name: FONT, size: 9, bold: true, color: { argb: c.kind === 'group' ? C.bothF : C.headText } };
    cell.alignment = { textRotation: 90, vertical: 'bottom', horizontal: 'center' };
    cell.fill = fill(C.head);
    cell.border = boxThin;
    ws.getColumn(COL0 + j).width = 3.4;
  });
  ws.getRow(HDR).height = Math.min(240, Math.max(64, Math.round(maxLen * 5.1)));

  // panel row labels
  rows.forEach((r, i) => {
    const er = DATA0 + i;
    put(ws, er, 1, r.name, { size: 9 }).border = { bottom: thin };
    put(ws, er, 2, r.addr, { size: 9, font: C.sub }).border = { bottom: thin };
    ws.getRow(er).height = 13.5;
  });

  // sparse relationship cells only
  for (const cell of cells) {
    const sym = dirSym(cell.t, cell.l, cell.k);
    if (!sym) continue;
    const xc = ws.getCell(DATA0 + cell.r, COL0 + cell.c);
    xc.value = sym.s;
    xc.font = { name: FONT, size: 11, bold: true, color: { argb: sym.font } };
    xc.alignment = { horizontal: 'center', vertical: 'middle' };
    xc.fill = fill(sym.bg);
  }
  return ws;
}

// ---- shared grouped-section sheet (Conferences / Panels) --------------------
// sections: [{ title, kind, members: [{a,b,c,d, dir:{t,l}, plain?:bool}] }]
function addSectionSheet(wb, snap, sheetName, titleText, colHeads, sections) {
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }, // 9 = A4
  });
  const widths = [46, 26, 30, 16];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  titleBlock(ws, 'D', titleText, metaLine(snap), null);
  // column-header row (frozen)
  colHeads.forEach((h, i) => headCell(ws, 4, i + 1, h));

  let row = 5;
  for (const sec of sections) {
    ws.mergeCells(row, 1, row, 4);
    const band = ws.getCell(row, 1);
    const mark = sec.kind === 'group' ? '▣' : '●';
    band.value = `${mark}  ${sec.title}`;
    band.font = { name: FONT, size: 11, bold: true, color: { argb: C.bandText } };
    band.fill = fill(C.band);
    band.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(row).height = 20;
    row++;

    if (!sec.members.length) {
      ws.mergeCells(row, 1, row, 4);
      put(ws, row, 1, sec.empty || 'No members.', { font: C.sub, size: 10, indent: 1 });
      row++;
    }
    sec.members.forEach((m, idx) => {
      const z = idx % 2 ? C.zebra : null;
      put(ws, row, 1, m.a, { font: C.ink, size: 10, bg: z });
      put(ws, row, 2, m.b || '', { font: C.sub, size: 10, bg: z });
      put(ws, row, 3, m.c || '', { font: C.sub, size: 10, bg: z });
      if (m.plain) {
        put(ws, row, 4, m.d || '—', { font: C.sub, size: 10, bg: z, center: true });
      } else {
        const ds = dirStyle(m.dir.t, m.dir.l);
        put(ws, row, 4, dirText(m.dir.t, m.dir.l), { font: ds.font, bg: ds.bg || z, bold: true, size: 10, center: true });
      }
      row++;
    });
    row++; // spacer between sections
  }
  return ws;
}

function addConferenceSheet(wb, snap) {
  const dests = [...(snap.conferences || []), ...(snap.groups || [])];
  const sections = dests.map((d) => ({
    title: `${d.name}${d.label ? '  ·  ' + d.label : ''}    —    ${d.kind}  ·  ${d.memberCount} member${d.memberCount === 1 ? '' : 's'}`,
    kind: d.kind,
    empty: 'No members.',
    members: (d.members || []).map((m) => ({ a: m.name, b: m.type || '', c: m.addr || '', dir: { t: m.talk, l: m.listen } })),
  }));
  return addSectionSheet(wb, snap, 'Conferences', `Conferences — ${snap.system && snap.system.name ? snap.system.name : ''}`,
    ['Member', 'Type', 'Port', 'Direction'], sections);
}

function addPanelSheet(wb, snap) {
  const sections = (snap.panels || []).map((p) => {
    const memberCount = (p.memberships || []).filter((m) => m.access !== 'key').length;
    const keyCount = (p.memberships || []).filter((m) => m.access === 'key').length;
    const bits = [p.isPanel ? 'panel' : 'port'];
    if (p.type) bits.push(p.type);
    if (p.node) bits.push(`${p.node}${p.bay ? ' · ' + p.bay : ''}`);
    bits.push(`${memberCount} member${memberCount === 1 ? '' : 's'}${keyCount ? ' · +' + keyCount + ' via key' : ''}`);
    return {
      title: `${p.name}    —    ${bits.join('  ·  ')}`,
      kind: 'panel',
      empty: 'Not a member of any conference.',
      members: (p.memberships || []).map((m) =>
        m.access === 'key'
          ? { a: m.name, b: m.kind, c: 'Via key', d: '—', plain: true }
          : { a: m.name, b: m.kind, c: 'Member', dir: { t: m.talk, l: m.listen } }),
    };
  });
  return addSectionSheet(wb, snap, 'Panels', `Panels — ${snap.system && snap.system.name ? snap.system.name : ''}`,
    ['Conference / Group', 'Kind', 'Access', 'Direction'], sections);
}

// ---- public API -------------------------------------------------------------
async function buildWorkbookBuffer(snap) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Intercom Matrix';
  wb.created = new Date();
  addMatrixSheet(wb, snap);
  addConferenceSheet(wb, snap);
  addPanelSheet(wb, snap);
  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbookBuffer };
