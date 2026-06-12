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
`;

let db = null;
function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function createSession(username, displayName, role, authMethod) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  getDb().prepare('INSERT INTO sessions (token, username, display_name, role, auth_method, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, username, displayName || '', role, authMethod || null, expires);
  return { token, expires, ttl: SESSION_TTL_SEC };
}

function getSession(token) {
  if (!token) return null;
  return getDb().prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token) || null;
}

function deleteSession(token) { if (token) getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function deleteSessionsForUser(username) { getDb().prepare('DELETE FROM sessions WHERE username = ? COLLATE NOCASE').run(username); }
function cleanSessions() { try { getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(); } catch { /* table may not exist yet */ } }

module.exports = { getDb, createSession, getSession, deleteSession, deleteSessionsForUser, cleanSessions, SESSION_TTL_SEC, DB_PATH };
