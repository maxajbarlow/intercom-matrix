// PDF extraction must keep text that runs past the page edge. Config-tool
// prints on A4 overflow the Port/Info column, and pdftotext crops to the page
// by default — that silently cut panel names ('Race Cont…'), splitting one
// panel's keys across fragment rows.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { toText, parsePrintText } = require('../lib/print-parser');

const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// A one-page PDF (200x100pt) whose single text line is far wider than the page.
function overflowingPdf(line) {
  const stream = `BT /F1 10 Tf 5 50 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
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

test('toText keeps panel names that run off the page edge', { skip: !hasPdftotext && 'pdftotext not installed' }, () => {
  const line = "Conf-Cmd [ Display 2 ] Key 9 (Drivers) on RSP-1232HL (32-key SmartPanel 19\" 2RU) 'Race Control F1 Race Director', Priority=Standard";
  const text = toText(overflowingPdf(line.replace(/[()\\]/g, '\\$&')));
  assert.match(text, /'Race Control F1 Race Director'/);

  const parsed = parsePrintText('Williams TEAM MANAGER Williams Conference <not assigned> 15 28 ' + text.trim() + '\nDestination (talk, listen)');
  assert.strictEqual(parsed.stats.truncated, 0);
  assert.strictEqual(parsed.conferences[0].keys[0].panel, 'Race Control F1 Race Director');
});
