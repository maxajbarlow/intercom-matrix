// Conference header rows carry three name columns — Long Name, Local 8, Alias —
// and -raw text collapses the gaps between them to single spaces, so a Local 8
// with a space ("CNF #001") was read as part of the long name. These pin the
// word-position split (lib/print-columns) and the parser's reading of it.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { headerRowsFromBbox, markHeaderColumns } = require('../lib/print-columns');
const { toText, parsePrintText } = require('../lib/print-parser');

// poppler -bbox output for one page: a column header and the given rows.
// Column starts: Long Name 13, Local 8 136, Alias 193, Grp/Conf 250.
function bboxPage(rows) {
  const w = (x, y, t, width = t.length * 5) => `<word xMin="${x}" yMin="${y}" xMax="${x + width}" yMax="${y + 9}">${t}</word>`;
  const hdr = [w(13, 24, 'Long'), w(40, 24, 'Name'), w(136, 24, 'Local'), w(165, 24, '8'), w(193, 24, 'Alias'), w(250, 24, 'Grp/Conf'), w(307, 24, 'GPIO')];
  const body = rows.map((r, i) => r.map(([x, t, width]) => w(x, 45 + i * 27, t, width)).join('\n'));
  return `<page width="842" height="595">\n${hdr.join('\n')}\n${body.join('\n')}\n</page>`;
}

test('headerRowsFromBbox splits Long Name / Local 8 / Alias by column position', () => {
  const html = bboxPage([
    [[13, 'ChrisB/Jakob'], [136, 'CNF'], [156, '#001'], [250, 'Conference'], [300, '&lt;not'], [320, 'assigned&gt;']],
    [[13, 'Alpine'], [45, 'Juggler'], [85, '01'], [136, 'ALP'], [156, 'Jug1'], [193, 'Car'], [213, '1'], [250, 'Conference']],
    [[13, 'Jo'], [25, 'Bauer'], [136, 'Jo_Test'], [193, '&lt;not'], [213, 'available&gt;'], [250, 'Group']],
  ]);
  assert.deepStrictEqual(headerRowsFromBbox(html), [
    { name: 'ChrisB/Jakob', local8: 'CNF #001', alias: '', kind: 'Conference' },
    { name: 'Alpine Juggler 01', local8: 'ALP Jug1', alias: 'Car 1', kind: 'Conference' },
    { name: 'Jo Bauer', local8: 'Jo_Test', alias: '<not available>', kind: 'Group' },
  ]);
});

test('headerRowsFromBbox splits a word the extractor glued across a column edge', () => {
  // "MANAGERVan": a long name running into the Local 8 cell, one word in the bbox
  const html = bboxPage([[[13, 'TEAM'], [70, 'MANAGERVan', 100], [175, 'Amer', 15], [250, 'Conference']]]);
  assert.deepStrictEqual(headerRowsFromBbox(html), [{ name: 'TEAM MANAGER', local8: 'Van Amer', alias: '', kind: 'Conference' }]);
});

test('headerRowsFromBbox ignores pages without the conference-list header', () => {
  assert.deepStrictEqual(headerRowsFromBbox('<page><word xMin="1" yMin="1" xMax="9" yMax="9">Port</word></page>'), []);
});

test('markHeaderColumns tab-separates the name columns of each matched header line', () => {
  const raw = [
    'ChrisB/Jakob CNF #001 Conference <not assigned> 6 202 Conf-Cmd Key 4 on Panel \'P1\' (type DSP), Priority=Standard',
    'Destination (talk, listen)',
    'IM-F2 Van Amersfoort TEAM MANAGERVan Amer Conference <not assigned> 8 536',
  ].join('\n');
  const rows = [
    { name: 'ChrisB/Jakob', local8: 'CNF #001', alias: '', kind: 'Conference' },
    { name: 'IM-F2 Van Amersfoort TEAM MANAGER', local8: 'Van Amer', alias: '', kind: 'Conference' },
  ];
  assert.deepStrictEqual(markHeaderColumns(raw, rows).split('\n'), [
    'ChrisB/Jakob\tCNF #001\t\tConference <not assigned> 6 202 Conf-Cmd Key 4 on Panel \'P1\' (type DSP), Priority=Standard',
    'Destination (talk, listen)',
    'IM-F2 Van Amersfoort TEAM MANAGER\tVan Amer\t\tConference <not assigned> 8 536',
  ]);
});

test('markHeaderColumns leaves the text alone when a row cannot be found', () => {
  const raw = 'Something else entirely\nDestination (talk)';
  assert.strictEqual(markHeaderColumns(raw, [{ name: 'Nope', local8: 'N', alias: '', kind: 'Conference' }]), raw);
});

test('parsePrintText reads tab-marked headers, whatever sits in the GPIO column', () => {
  const text = [
    'ChrisB/Jakob\tCNF #001\t\tConference <not assigned> 6 202 Conf-Cmd Key 4 on Panel \'FIA SysOps 03\' (type DSP-1216HL), Priority=Standard Destination (talk, listen)',
    'Alpine Juggler 01\tALP Jug1\tCar 1\tConference <not assigned> 2 0',
    'RiedelF2/3\tRdl/F2T\t\tConference Teams Calling 6 0 Conf-Cmd Key 11 (Key Bank 1) on Panel \'Remote Kit 04\' (type DSP-2312 Plus), Priority=Standard',
    'Destination (listen)',
    'Jo Bauer Test\tJo_Test\t<not available>\tGroup <not assigned> 10 <none> 0 4-Wire (AES67) Audi Jo B 1st',
  ].join('\n');
  const confs = parsePrintText(text).conferences;
  assert.deepStrictEqual(confs.map((c) => [c.name, c.alias, c.printAlias, c.kind, c.keys.length]), [
    ['ChrisB/Jakob', 'CNF #001', '', 'conference', 1],
    ['Alpine Juggler 01', 'ALP Jug1', 'Car 1', 'conference', 0],
    ['RiedelF2/3', 'Rdl/F2T', '', 'conference', 1],
    ['Jo Bauer Test', 'Jo_Test', '', 'group', 0],
  ]);
  assert.deepStrictEqual(confs[0].keys[0], { panel: 'FIA SysOps 03', panelType: 'DSP-1216HL', truncated: false, key: 'Key 4', talk: true, listen: true });
  assert.strictEqual(confs[2].keys[0].panel, 'Remote Kit 04');
  assert.strictEqual(confs[2].keys[0].listen, true);
});

test('parsePrintText still reads untabbed text (prints stored before the column split)', () => {
  const confs = parsePrintText('Williams TEAM MANAGER Williams Conference <not assigned> 15 28').conferences;
  assert.deepStrictEqual(confs.map((c) => [c.name, c.alias, c.printAlias]), [['Williams TEAM MANAGER', 'Williams', '']]);
});

// --- end to end through the real pdftotext ----------------------------------
const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// One A4-landscape page with text placed at [x, y, string] (PDF y runs up).
function pdfWithText(items) {
  const esc = (s) => s.replace(/[()\\]/g, '\\$&');
  const stream = items.map(([x, y, s]) => `BT /F1 9 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = body.length; body += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('toText + parsePrintText: a real PDF keeps a spaced Local 8 out of the long name', { skip: !hasPdftotext && 'pdftotext not installed' }, () => {
  const pdf = pdfWithText([
    [13, 560, 'Long Name'], [136, 560, 'Local 8'], [193, 560, 'Alias'], [250, 560, 'Grp/Conf'], [307, 560, 'GPIO'],
    [13, 530, 'ChrisB/Jakob'], [136, 530, 'CNF #001'], [250, 530, 'Conference'], [307, 530, '<not assigned>'], [420, 530, '6'], [450, 530, '202'],
    [480, 530, "Conf-Cmd Key 4 on Panel 'FIA SysOps 03' (type DSP-1216HL), Priority=Standard"],
    [480, 518, 'Destination (talk, listen)'],
    [13, 500, 'Alpine Juggler 01'], [136, 500, 'ALP Jug1'], [193, 500, 'Car 1'], [250, 500, 'Conference'], [307, 500, '<not assigned>'], [420, 500, '2'], [450, 500, '0'],
  ]);
  const confs = parsePrintText(toText(pdf)).conferences;
  assert.deepStrictEqual(confs.map((c) => [c.name, c.alias, c.printAlias]), [['ChrisB/Jakob', 'CNF #001', ''], ['Alpine Juggler 01', 'ALP Jug1', 'Car 1']]);
  assert.strictEqual(confs[0].keys[0].panel, 'FIA SysOps 03');
});
