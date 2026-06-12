// lib/request-db.js — SQLite store for the change-request platform.
//
// Uses Node's built-in node:sqlite (no native build, no extra dependency).
// One file DB at data/requests.db (data/ is gitignored). WAL mode so readers
// never block the single writer (this process). The schema is created on first
// open and is forward-only (CREATE TABLE IF NOT EXISTS).
//
// This is the ONLY durable, mutable state in the app — it cannot be re-derived
// from a print, so backupTo() exports a consistent copy for safekeeping.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.REQUESTS_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.REQUESTS_DB || path.join(DATA_DIR, 'requests.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  system        TEXT NOT NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- 'membership' | 'create_conference'
  requester_name TEXT NOT NULL,
  requester_role TEXT,
  requester_id  TEXT,                          -- null today; for a future SSO user id
  justification TEXT,
  needed_by     TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 0,
  type          TEXT NOT NULL,                 -- add_member | remove_member | create_conference | change_direction
  conference_name  TEXT,
  conference_label TEXT,
  is_new_conference INTEGER NOT NULL DEFAULT 0,
  panel_addr    TEXT,
  panel_name    TEXT,
  talk          INTEGER,
  listen        INTEGER,
  new_name      TEXT,                          -- rename_conference: the new name
  new_label     TEXT,                          -- rename_conference: the new alias
  reconcile_state TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | superseded
  verified_at   TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  at            TEXT NOT NULL,
  by_name       TEXT,
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_sys_status ON requests(system, status);
CREATE INDEX IF NOT EXISTS idx_items_request ON change_items(request_id);
CREATE INDEX IF NOT EXISTS idx_comments_request ON comments(request_id);
CREATE INDEX IF NOT EXISTS idx_history_request ON history(request_id);
`;

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Forward-only, idempotent migrations so an existing dev DB picks up new columns.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(change_items)').all().map((c) => c.name);
  if (!cols.includes('new_name')) db.exec('ALTER TABLE change_items ADD COLUMN new_name TEXT');
  if (!cols.includes('new_label')) db.exec('ALTER TABLE change_items ADD COLUMN new_label TEXT');
}

// Consistent on-disk backup of the DB (checkpoints WAL into the copy).
function backupTo(destPath) {
  const d = open();
  d.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  return destPath;
}

module.exports = { open, backupTo, DB_PATH, DATA_DIR };
