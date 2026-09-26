// lib/auth-db.js — session + local-account store for authentication.
//
// Built on Node's built-in node:sqlite (DatabaseSync), like request-db.js — no
// native build, no extra dependency. One file at data/auth.db (data/ is
// gitignored). Holds login sessions (cookie token → user + role) and locally
// created username/password accounts (scrypt-hashed in lib/local-users.js).
//
// Sessions are the single source of identity once auth is in play: lib/identity
// currentUser() resolves a request's user by looking up its session cookie here,
// replacing the old self-claimed X-Imx-* header trust.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.REQUESTS_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.AUTH_DB || path.join(DATA_DIR, 'auth.db');
const SESSION_TTL_SEC = Number(process.env.SESSION_TTL) || 7776000; // 90 days

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'viewer',
  auth_method   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS local_users (
  username      TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT,
  disabled_at   TEXT
);
-- Customer groups (lib/customer-db): a group is defined by its SOURCE PANELS per
-- system; its visible conferences are derived live (lib/customer-scope).
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description   TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customer_sources (
  customer_id   INTEGER NOT NULL,
  system_id     TEXT NOT NULL,
  panel_addr    TEXT NOT NULL,
  panel_name    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (customer_id, system_id, panel_addr)
);
CREATE TABLE IF NOT EXISTS customer_users (
  customer_id   INTEGER NOT NULL,
  username      TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (customer_id, username)
);
CREATE TABLE IF NOT EXISTS customer_dir_groups (
  customer_id   INTEGER NOT NULL,
  dir_group     TEXT NOT NULL,
  PRIMARY KEY (customer_id, dir_group)
);
`;

// Additive column migrations for DBs created before the column existed.
function migrate(d) {
  const cols = new Set(d.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  // Directory (LDAP/SAML) group memberships captured at login, JSON array of
  // lowercased identifiers — lets customer groups map to directory groups.
  if (!cols.has('dir_groups')) d.exec("ALTER TABLE sessions ADD COLUMN dir_groups TEXT DEFAULT '[]'");
  // An admin's "view as" preview target (lib/view-as), JSON or NULL. Lives on the
  // session so it can't be forged client-side and ends with the session.
  if (!cols.has('view_as')) d.exec('ALTER TABLE sessions ADD COLUMN view_as TEXT');
}

let db = null;
function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function createSession(username, displayName, role, authMethod, dirGroups) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  const groups = JSON.stringify(Array.isArray(dirGroups) ? dirGroups.map((g) => String(g).toLowerCase()) : []);
  getDb().prepare('INSERT INTO sessions (token, username, display_name, role, auth_method, expires_at, dir_groups) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(token, username, displayName || '', role, authMethod || null, expires, groups);
  return { token, expires, ttl: SESSION_TTL_SEC };
}

function getSession(token) {
  if (!token) return null;
  const row = getDb().prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!row) return null;
  let dirGroups = [];
  try { const v = JSON.parse(row.dir_groups || '[]'); if (Array.isArray(v)) dirGroups = v.map(String); } catch { /* legacy/blank → none */ }
  let viewAs = null;
  try { const v = JSON.parse(row.view_as || 'null'); if (v && typeof v === 'object') viewAs = v; } catch { /* blank → none */ }
  return { ...row, dirGroups, viewAs };
}

function setViewAs(token, target) {
  if (token) getDb().prepare('UPDATE sessions SET view_as = ? WHERE token = ?').run(target ? JSON.stringify(target) : null, token);
}

function deleteSession(token) { if (token) getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function deleteSessionsForUser(username) { getDb().prepare('DELETE FROM sessions WHERE username = ? COLLATE NOCASE').run(username); }
function cleanSessions() { try { getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); } catch { /* table may not exist yet */ } }

module.exports = { SCHEMA, getDb, createSession, getSession, setViewAs, deleteSession, deleteSessionsForUser, cleanSessions, SESSION_TTL_SEC, DB_PATH };
