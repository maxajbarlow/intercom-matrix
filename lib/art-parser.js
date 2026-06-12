// lib/art-parser.js — extract per-panel key labels from a controller config.
//
// Accepts BOTH .Art (saved config) and .ash (system snapshot) — they are the
// same MFC CArchive format, detected by the shared magic bytes so the extension
// doesn't matter. We only need: panel ObjectID -> set of key labels, which the
// service later resolves to conference names to add "key-access" edges.
//
// Labelled key record, anchored on marker `c0 fe 00 00`:
//   <kind><len><label><trailer> c0fe0000 <flags=0x0001:2> <selfUID:4> <panelUID:4>
// panelUID read as a little-endian uint32 IS the RRCS ObjectID (verified).

const MARKER = Buffer.from([0xc0, 0xfe, 0x00, 0x00]);
const PRINT = (c) => c >= 0x20 && c <= 0x7e;

// Magic-byte check so a renamed file (or unexpected extension) still loads.
function isArtBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 16 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0xff;
}

function recoverLabel(buf, M) {
  if (buf[M - 2] === 0x00) return ''; // empty label
  for (let len = 32; len >= 1; len--) {
    const S = M - 1 - len;
    if (S - 1 < 0) continue;
    if (buf[S - 1] !== len) continue;
    let ok = true;
    for (let j = S; j < M - 1; j++) if (!PRINT(buf[j])) { ok = false; break; }
    if (ok) return buf.toString('latin1', S, M - 1);
  }
  return null;
}

// Returns { byObjectId: Map<objectId, Set<label>>, stats }.
function parseKeyLabels(buf) {
  if (!isArtBuffer(buf)) throw new Error('Not a controller config file (.Art/.ash) — bad header.');
  const byObjectId = new Map();
  let markers = 0, labelled = 0;
  for (let i = 0; (i = buf.indexOf(MARKER, i)) !== -1; i++) {
    markers++;
    const M = i;
    if (M + 14 > buf.length) continue;
    if (buf.readUInt16LE(M + 4) !== 0x0001) continue; // labelled keys carry selfUID + panelUID
    const label = recoverLabel(buf, M);
    if (!label) continue;
    const panelOid = buf.readUInt32LE(M + 10) >>> 0;
    let set = byObjectId.get(panelOid);
    if (!set) { set = new Set(); byObjectId.set(panelOid, set); }
    set.add(label);
    labelled++;
  }
  return { byObjectId, stats: { markers, labelledKeys: labelled, panels: byObjectId.size } };
}

module.exports = { parseKeyLabels, isArtBuffer };
