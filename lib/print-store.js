// lib/print-store.js — per-system versioned storage for config prints.
//
// Each upload is kept as an immutable VERSION so the matrix has a history and
// any two versions can be diffed. The latest version is the active source and
// is auto-loaded on restart. There is no restore — the live intercom system is
// the source of truth, so a "rollback" is just changing the live system and
// uploading the resulting print as a new version.
//
// Layout:
//   prints/<systemId>/manifest.json   ordered [{ id, file, name, uploadedAt, stats }]
//   prints/<systemId>/v0001.txt       the extracted -raw text of each upload
//   prints/<systemId>/topology.txt    the latest uploaded topology tree (+ topology.json meta)
//
// Uploaded data is kept until a newer successful upload replaces it or it is
// explicitly cleared — never just because the process restarted or its system
// was removed from the switcher. In Docker PRINTS_DIR must sit on the /data volume (see Dockerfile).
//
// All of prints/* is gitignored (the port/conference inventory is sensitive).

const fs = require('fs');
const path = require('path');

// PRINTS_DIR lets a deployment (or an isolated test) relocate the store off the
// repo tree, mirroring the AUTH_DB / REQUESTS_DIR overrides elsewhere.
const ROOT = process.env.PRINTS_DIR || path.join(__dirname, '..', 'prints');

const dirFor = (sysId) => path.join(ROOT, String(sysId));
const manifestPath = (sysId) => path.join(dirFor(sysId), 'manifest.json');

function readManifest(sysId) {
  try { const m = JSON.parse(fs.readFileSync(manifestPath(sysId), 'utf8')); return Array.isArray(m.versions) ? m : { versions: [] }; }
  catch { return { versions: [] }; }
}
function writeManifest(sysId, m) {
  fs.mkdirSync(dirFor(sysId), { recursive: true });
  const tmp = manifestPath(sysId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, manifestPath(sysId));
}

function listVersions(sysId) { return readManifest(sysId).versions; }
function latest(sysId) { const v = readManifest(sysId).versions; return v.length ? v[v.length - 1] : null; }
function getVersion(sysId, versionId) { return readManifest(sysId).versions.find((v) => v.id === Number(versionId)) || null; }

function getVersionText(sysId, versionId) {
  const v = getVersion(sysId, versionId);
  if (!v) return null;
  try { return fs.readFileSync(path.join(dirFor(sysId), v.file), 'utf8'); }
  catch { return null; }
}

// Append a new version. If the text is byte-identical to the current latest,
// no version is created (re-uploading the same print is a no-op) — the existing
// latest is returned with { unchanged: true }.
function addVersion(sysId, text, name, stats) {
  const m = readManifest(sysId);
  const last = m.versions[m.versions.length - 1];
  if (last && getVersionText(sysId, last.id) === text) return { ...last, unchanged: true };
  const id = (last ? last.id : 0) + 1;
  const file = `v${String(id).padStart(4, '0')}.txt`;
  fs.mkdirSync(dirFor(sysId), { recursive: true });
  fs.writeFileSync(path.join(dirFor(sysId), file), text);
  const version = { id, file, name: name || `version ${id}`, uploadedAt: new Date().toISOString(), stats: stats || {} };
  m.versions.push(version);
  writeManifest(sysId, m);
  return version;
}

// Remove a system's print history (all versions). Used by the "clear" action —
// explicit and destructive; re-upload to start a fresh history. The topology stays.
function clear(sysId) {
  const m = readManifest(sysId);
  for (const v of m.versions) { try { fs.rmSync(path.join(dirFor(sysId), v.file), { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(manifestPath(sysId), { force: true }); } catch { /* ignore */ }
}

// ---------- topology (single current file per system; no history) ----------
const topoPath = (sysId) => path.join(dirFor(sysId), 'topology.txt');
const topoMetaPath = (sysId) => path.join(dirFor(sysId), 'topology.json');

// Write-then-rename so a crash mid-write can't leave a half file as "current".
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function saveTopology(sysId, text, name) {
  fs.mkdirSync(dirFor(sysId), { recursive: true });
  const meta = { name: name || 'topology', uploadedAt: new Date().toISOString() };
  writeAtomic(topoPath(sysId), text);
  writeAtomic(topoMetaPath(sysId), JSON.stringify(meta, null, 2));
  return meta;
}
function loadTopology(sysId) {
  let text;
  try { text = fs.readFileSync(topoPath(sysId), 'utf8'); } catch { return null; }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(topoMetaPath(sysId), 'utf8')) || {}; } catch { /* name/time unknown */ }
  return { text, name: meta.name || 'topology', uploadedAt: meta.uploadedAt || null };
}
function clearTopology(sysId) {
  for (const f of [topoPath(sysId), topoMetaPath(sysId)]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}

module.exports = { listVersions, latest, getVersion, getVersionText, addVersion, clear, dirFor, saveTopology, loadTopology, clearTopology };
