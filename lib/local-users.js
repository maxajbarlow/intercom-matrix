// lib/local-users.js — local username/password accounts + password hashing.
//
// Ported from the intercom_manager auth stack onto node:sqlite. Passwords use
// Node's built-in scrypt — no npm dep, NIST-approved, memory-hard. Stored as
// separate salt + hash hex strings so a future KDF migration can keep both.
//
// Each account carries a role (viewer | editor | admin); admin is the tier the
// authorization gate (lib/identity can()) lets manage deployment config.

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ROLES = ['viewer', 'editor', 'admin'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,64}$/;
const MAX_PASSWORD_LEN = 1024;   // scrypt is CPU-heavy — bound untrusted input

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password || ''), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, saltHex, hashHex) {
  if (!password || !saltHex || !hashHex) return false;
  let salt, expected;
  try { salt = Buffer.from(saltHex, 'hex'); expected = Buffer.from(hashHex, 'hex'); }
  catch { return false; }
  const candidate = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

const normRole = (r) => (ROLES.includes(r) ? r : 'viewer');

function getLocalUser(db, username) {
  if (!username) return null;
  return db.prepare('SELECT * FROM local_users WHERE username = ? COLLATE NOCASE').get(username) || null;
}

function isDisabled(user) { return !!(user && user.disabled_at); }

function listLocalUsers(db) {
  return db.prepare(`
    SELECT username, display_name, role, created_at, created_by, disabled_at
    FROM local_users ORDER BY username COLLATE NOCASE
  `).all();
}

// Count active (non-disabled) admin accounts. Drives the first-run wizard's
// bootstrap gate: the open admin-creation endpoint is locked the instant this
// is > 0, so it can only ever mint the FIRST admin.
function countAdmins(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM local_users WHERE role = 'admin' AND disabled_at IS NULL
  `).get();
  return row ? row.n : 0;
}

function createLocalUser(db, { username, password, displayName, role, createdBy }) {
  if (!username || !password) throw new Error('Username and password required');
  if (!USERNAME_RE.test(username)) throw new Error('Username must be 2-64 chars: letters, digits, dot, underscore, hyphen');
  if (String(password).length < 6) throw new Error('Password must be at least 6 characters');
  // Upper bound the input to scrypt: it's deliberately CPU-heavy, and the
  // first-run admin endpoint is unauthenticated, so an unbounded password is a
  // cheap event-loop DoS.
  if (String(password).length > MAX_PASSWORD_LEN) throw new Error(`Password must be ${MAX_PASSWORD_LEN} characters or fewer`);
  if (getLocalUser(db, username)) throw new Error('Username already exists');
  const { salt, hash } = hashPassword(password);
  db.prepare(`
    INSERT INTO local_users (username, password_hash, password_salt, display_name, role, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(username, hash, salt, displayName || null, normRole(role), createdBy || null);
  return getLocalUser(db, username);
}

function updateLocalUser(db, username, updates) {
  const user = getLocalUser(db, username);
  if (!user) throw new Error('User not found');
  const sets = [], params = [];
  if (typeof updates.displayName === 'string') { sets.push('display_name = ?'); params.push(updates.displayName); }
  if (typeof updates.role === 'string') { sets.push('role = ?'); params.push(normRole(updates.role)); }
  if (typeof updates.password === 'string' && updates.password) {
    if (updates.password.length < 6) throw new Error('Password must be at least 6 characters');
    if (updates.password.length > MAX_PASSWORD_LEN) throw new Error(`Password must be ${MAX_PASSWORD_LEN} characters or fewer`);
    const { salt, hash } = hashPassword(updates.password);
    sets.push('password_hash = ?', 'password_salt = ?'); params.push(hash, salt);
  }
  if (typeof updates.disabled === 'boolean') { sets.push('disabled_at = ?'); params.push(updates.disabled ? new Date().toISOString() : null); }
  if (!sets.length) return user;
  params.push(user.username);
  db.prepare(`UPDATE local_users SET ${sets.join(', ')} WHERE username = ? COLLATE NOCASE`).run(...params);
  return getLocalUser(db, user.username);
}

function deleteLocalUser(db, username) {
  const user = getLocalUser(db, username);
  if (!user) return false;
  // Drop active sessions so the account is logged out immediately.
  db.prepare('DELETE FROM sessions WHERE username = ? COLLATE NOCASE').run(user.username);
  db.prepare('DELETE FROM local_users WHERE username = ? COLLATE NOCASE').run(user.username);
  return true;
}

module.exports = {
  hashPassword, verifyPassword, getLocalUser, isDisabled,
  listLocalUsers, countAdmins, createLocalUser, updateLocalUser, deleteLocalUser,
  ROLES, USERNAME_RE,
};
