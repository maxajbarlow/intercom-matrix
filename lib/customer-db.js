// lib/customer-db.js — customer groups: their source panels and their members.
//
// A customer group (e.g. "FIA Race Control", "SysOps") is defined by the panels
// it owns on each system. It stores NO conference list — lib/customer-scope
// derives the visible conferences from the current snapshot on every request.
//
// Membership comes from two places, unioned:
//   • usernames (local accounts, or a directory user named explicitly), and
//   • directory groups (LDAP memberOf DN / SAML group claim, lowercased), so a
//     whole AD group of FIA staff is scoped with no per-user setup.
//
// Same conventions as lib/local-users: node:sqlite, db handle passed in, tables
// declared in lib/auth-db SCHEMA. Admin/editor scoping rules live in identity.js.

const NAME_MAX = 80;
const DESC_MAX = 400;
const GROUP_MAX = 512;
const SOURCES_MAX = 5000;
const USERNAME_RE = /^[a-zA-Z0-9._@\\-]{2,128}$/;   // local + AD (DOMAIN\\user, UPN) forms

const str = (v) => String(v == null ? '' : v).trim();

function tx(db, fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- validation (throw on bad write) ----------
function cleanName(v) {
  const s = str(v);
  if (!s) throw new Error('name is required');
  if (s.length > NAME_MAX) throw new Error(`name must be ≤ ${NAME_MAX} characters`);
  return s;
}
function cleanSources(list) {
  if (!Array.isArray(list)) throw new Error('sources must be an array');
  if (list.length > SOURCES_MAX) throw new Error(`too many source panels (max ${SOURCES_MAX})`);
  const seen = new Map();
  for (const x of list) {
    const system = str(x && x.system);
    const addr = str(x && (x.addr || x.name));
    const name = str(x && (x.name || x.addr));
    if (!system) throw new Error('each source panel needs a system');
    if (!addr) throw new Error('each source panel needs a panel address or name');
    seen.set(system + '\u0000' + addr, { system, addr, name });
  }
  return [...seen.values()];
}
function cleanUsers(list) {
  if (!Array.isArray(list)) throw new Error('users must be an array');
  const out = new Map();
  for (const u of list) {
    const s = str(u);
    if (!USERNAME_RE.test(s)) throw new Error(`invalid username "${s}"`);
    out.set(s.toLowerCase(), s);
  }
  return [...out.values()];
}
function cleanDirGroups(list) {
  if (!Array.isArray(list)) throw new Error('dirGroups must be an array');
  const out = new Set();
  for (const g of list) {
    const s = str(g).toLowerCase();
    if (!s) continue;
    if (s.length > GROUP_MAX) throw new Error(`directory group must be ≤ ${GROUP_MAX} characters`);
    out.add(s);
  }
  return [...out];
}

// ---------- reads ----------
function hydrate(db, row) {
  if (!row) return null;
  const sources = db.prepare('SELECT system_id AS system, panel_addr AS addr, panel_name AS name FROM customer_sources WHERE customer_id = ? ORDER BY system_id, panel_name COLLATE NOCASE').all(row.id)
    .map((s) => ({ system: s.system, addr: s.addr, name: s.name || s.addr }));
  const users = db.prepare('SELECT username FROM customer_users WHERE customer_id = ? ORDER BY username COLLATE NOCASE').all(row.id).map((u) => u.username);
  const dirGroups = db.prepare('SELECT dir_group FROM customer_dir_groups WHERE customer_id = ? ORDER BY dir_group').all(row.id).map((g) => g.dir_group);
  return { id: row.id, name: row.name, description: row.description || '', createdAt: row.created_at, updatedAt: row.updated_at, sources, users, dirGroups };
}

function getCustomer(db, id) {
  return hydrate(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id)));
}
function listCustomers(db) {
  return db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE').all().map((r) => hydrate(db, r));
}
function hasCustomers(db) {
  return !!db.prepare('SELECT 1 FROM customers LIMIT 1').get();
}

// Customer groups a signed-in identity belongs to (by username or dir group).
function customersForUser(db, username, dirGroups) {
  const groups = (dirGroups || []).map((g) => String(g).toLowerCase());
  const ph = groups.map(() => '?').join(',');
  const sql = `SELECT DISTINCT c.id, c.name FROM customers c
    WHERE c.id IN (SELECT customer_id FROM customer_users WHERE username = ? COLLATE NOCASE)
    ${groups.length ? `OR c.id IN (SELECT customer_id FROM customer_dir_groups WHERE dir_group IN (${ph}))` : ''}
    ORDER BY c.name COLLATE NOCASE`;
  return db.prepare(sql).all(String(username || ''), ...groups).map((r) => ({ id: r.id, name: r.name }));
}

// Does any customer group map one of these directory groups? (Lets a directory
// user whose only relevant group is a customer group sign in as a viewer.)
function matchesDirGroup(db, dirGroups) {
  const groups = (dirGroups || []).map((g) => String(g).toLowerCase());
  if (!groups.length) return false;
  return !!db.prepare(`SELECT 1 FROM customer_dir_groups WHERE dir_group IN (${groups.map(() => '?').join(',')}) LIMIT 1`).get(...groups);
}

// Union of source panels for these customers on one system.
function sourcesFor(db, customerIds, systemId) {
  const ids = (customerIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT DISTINCT panel_addr AS addr, panel_name AS name FROM customer_sources
    WHERE system_id = ? AND customer_id IN (${ids.map(() => '?').join(',')})`).all(String(systemId || ''), ...ids);
  return rows.map((r) => ({ addr: r.addr, name: r.name || r.addr }));
}
// Systems on which these customers have at least one source panel.
function systemsFor(db, customerIds) {
  const ids = (customerIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  return db.prepare(`SELECT DISTINCT system_id FROM customer_sources WHERE customer_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.system_id);
}

// ---------- writes ----------
function assertUniqueName(db, name, exceptId) {
  const clash = db.prepare('SELECT id FROM customers WHERE name = ? COLLATE NOCASE').get(name);
  if (clash && clash.id !== exceptId) throw new Error(`a customer group named "${name}" already exists`);
}

function createCustomer(db, { name, description } = {}) {
  const n = cleanName(name);
  assertUniqueName(db, n, null);
  const r = db.prepare('INSERT INTO customers (name, description) VALUES (?, ?)').run(n, str(description).slice(0, DESC_MAX));
  return getCustomer(db, Number(r.lastInsertRowid));
}

// Patch a customer. `sources`, `users` and `dirGroups` REPLACE the whole set
// when present; omitted fields are left untouched.
function updateCustomer(db, id, patch = {}) {
  const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
  if (!cur) throw new Error('Customer group not found');
  const name = patch.name !== undefined ? cleanName(patch.name) : null;
  if (name) assertUniqueName(db, name, cur.id);
  const sources = patch.sources !== undefined ? cleanSources(patch.sources) : null;
  const users = patch.users !== undefined ? cleanUsers(patch.users) : null;
  const dirGroups = patch.dirGroups !== undefined ? cleanDirGroups(patch.dirGroups) : null;

  tx(db, () => {
    if (name || patch.description !== undefined) {
      db.prepare("UPDATE customers SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name || cur.name, patch.description !== undefined ? str(patch.description).slice(0, DESC_MAX) : cur.description, cur.id);
    }
    if (sources) {
      db.prepare('DELETE FROM customer_sources WHERE customer_id = ?').run(cur.id);
      const ins = db.prepare('INSERT INTO customer_sources (customer_id, system_id, panel_addr, panel_name) VALUES (?, ?, ?, ?)');
      for (const s of sources) ins.run(cur.id, s.system, s.addr, s.name);
    }
    if (users) {
      db.prepare('DELETE FROM customer_users WHERE customer_id = ?').run(cur.id);
      const ins = db.prepare('INSERT INTO customer_users (customer_id, username) VALUES (?, ?)');
      for (const u of users) ins.run(cur.id, u);
    }
    if (dirGroups) {
      db.prepare('DELETE FROM customer_dir_groups WHERE customer_id = ?').run(cur.id);
      const ins = db.prepare('INSERT INTO customer_dir_groups (customer_id, dir_group) VALUES (?, ?)');
      for (const g of dirGroups) ins.run(cur.id, g);
    }
    if (sources || users || dirGroups) db.prepare("UPDATE customers SET updated_at = datetime('now') WHERE id = ?").run(cur.id);
  });
  return getCustomer(db, cur.id);
}

function deleteCustomer(db, id) {
  const cid = Number(id);
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(cid)) return false;
  tx(db, () => {
    for (const t of ['customer_sources', 'customer_users', 'customer_dir_groups']) db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(cid);
    db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
  });
  return true;
}

// Detach a username from every customer group (called when an account is deleted).
function removeUser(db, username) {
  db.prepare('DELETE FROM customer_users WHERE username = ? COLLATE NOCASE').run(String(username || ''));
}

module.exports = {
  listCustomers, getCustomer, hasCustomers, customersForUser, matchesDirGroup, sourcesFor, systemsFor,
  createCustomer, updateCustomer, deleteCustomer, removeUser,
};
