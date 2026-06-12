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
  fs.writeFileSync(manifestPath(sysId), JSON.stringify(m, null, 2));
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

// Remove a system's entire print store (all versions). Used by the "clear"
// action — explicit and destructive; re-upload to start a fresh history.
function clear(sysId) {
  try { fs.rmSync(dirFor(sysId), { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = { listVersions, latest, getVersion, getVersionText, addVersion, clear, dirFor };
