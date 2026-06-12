// lib/rrcs-client.js — READ-ONLY RRCS XML-RPC client.
//
// RRCS is XML-RPC over HTTP on the controller (default tcp 8193). This
// client is hard-locked to read-only Get* methods: any other method is refused
// before a byte hits the network, so it can NEVER mutate the live system.

const http = require('http');

const READ_ONLY = new Set([
  'GetVersion', 'GetAlive', 'GetNetName',
  'GetAllPorts', 'GetAllCaps', 'GetPortAlias', 'GetPortLabel',
  'GetAllConferences', 'GetAllGroups', 'GetAllIFBs', 'GetTrunkIfbs', 'GetTrunkPorts',
  'GetAllActiveXps', 'GetActiveXpsRange', 'GetXpStatus', 'GetXpVolume',
  'GetAllDevices', 'GetAllLogicSources',
]);

function assertReadOnly(method) {
  if (!/^Get/.test(method) || !READ_ONLY.has(method)) {
    throw new Error(`REFUSED: '${method}' is not on the read-only allowlist; this client only issues Get* queries.`);
  }
}

function encVal(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `<i4>${v}</i4>` : `<double>${v}</double>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (Array.isArray(v)) return `<array><data>${v.map((x) => `<value>${encVal(x)}</value>`).join('')}</data></array>`;
  return `<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`;
}
function buildCall(method, params) {
  const p = (params || []).map((x) => `<param><value>${encVal(x)}</value></param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${p}</params></methodCall>`;
}

// Minimal XML-RPC response parser (struct / array / scalars).
function parseResponse(xml) {
  let i = 0; const s = xml;
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const tag = () => { skipWs(); if (s[i] !== '<') return null; const j = s.indexOf('>', i); const t = s.slice(i + 1, j); i = j + 1; return t; };
  const text = (u) => { const j = s.indexOf(u, i); const t = s.slice(i, j); i = j; return t; };
  function readValue() {
    skipWs();
    if (s[i] !== '<') return text('<');
    const t = tag();
    if (t === 'value') { const v = readValue(); tag(); return v; }
    if (t === 'struct') {
      const o = {};
      for (;;) { const m = tag(); if (m === '/struct') break; if (m !== 'member') continue;
        let name, val;
        for (;;) { const mm = tag(); if (mm === '/member') break;
          if (mm === 'name') { name = text('</name>'); tag(); }
          else if (mm === 'value') { val = readValue(); tag(); } }
        o[name] = val; }
      return o;
    }
    if (t === 'array') {
      const a = []; tag();
      for (;;) { skipWs(); if (s.startsWith('</data>', i)) { tag(); break; } const m = tag(); if (m !== 'value') break; a.push(readValue()); tag(); }
      tag(); return a;
    }
    const raw = text(`</${t}>`); tag();
    if (t === 'i4' || t === 'int') return parseInt(raw, 10);
    if (t === 'boolean') return raw === '1';
    if (t === 'double') return parseFloat(raw);
    return raw;
  }
  const idx = s.indexOf('<methodResponse'); if (idx >= 0) i = s.indexOf('>', idx) + 1;
  const vi = s.indexOf('<value>', i); if (vi >= 0) i = vi;
  try { return readValue(); } catch (e) { return { _parseError: e.message }; }
}

// Issue one read-only call; resolves to the parsed value (throws on transport error).
function call(host, port, method, params = []) {
  assertReadOnly(method);
  const body = buildCall(method, params);
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'POST', path: '/RPC2',
      headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'intercom-matrix/1.0 (read-only)' },
      timeout: 12000 }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve(parseResponse(d)));
    });
    req.on('timeout', () => req.destroy(new Error('RRCS connection timed out')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

module.exports = { call, parseResponse, READ_ONLY };
