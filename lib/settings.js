// lib/settings.js — server-owned, shared deployment settings.
//
// Everything an engineer tailors when standing this viewer up at a customer
// site that ISN'T a system definition (those live in systems.json): branding,
// display defaults, the RRCS safety toggle, and the people roster. Persisted to
// settings.json (or SETTINGS_FILE) and shared by every connected client.
//
// This module is auth-agnostic on purpose — it validates and persists, nothing
// more. Authorization (who may write) is enforced at the route layer in
// server.js via lib/identity.js can(); rrcs-service and server.js read the
// effective values here. That mirrors how rrcs-service stays auth-free too.

const fs = require('fs');
const path = require('path');

const FILE = process.env.SETTINGS_FILE || path.join(__dirname, '..', 'settings.json');

// Env SEEDS — settings.json is the source of truth once written; the env vars
// only provide the FIRST value so existing deployments keep behaving.
const truthy = (v) => /^(1|true|on|yes)$/i.test(String(v ?? ''));
const ENV_RRCS = truthy(process.env.RRCS_ENABLED ?? 'off');
const ENV_LDAP = (() => { try { return !!new URL(String(process.env.LDAP_URL || '').trim()).hostname; } catch { return false; } })();
const ENV_SAML = truthy(process.env.SAML_ENABLED);

const MIN_REFRESH_SEC = 3;                       // floor — protects the controller
const AUTO_REFRESH_CHOICES = [0, 10, 30, 60, 300];
const THEMES = ['dark', 'light'];
const VIEWS = ['matrix', 'conferences', 'panels', 'requests', 'workorder', 'settings'];
const DATE_FORMATS = ['short', 'medium', 'long'];
const ROLES = ['viewer', 'editor', 'admin'];
const LOGO_MAX_BYTES = 512 * 1024;               // data-URI cap (keeps settings.json sane)
const LOGO_RE = /^data:image\/(png|jpe?g|svg\+xml|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const STR_MAX = 200;

function defaults() {
  return {
    branding: { siteName: 'Intercom Matrix', subtitle: 'Live intercom matrix', logoDataUri: '', defaultSystem: '', defaultView: 'matrix' },
    display: { autoRefreshSec: 30, theme: 'dark', matrixPanelsOnly: false, matrixKeyAccess: true, dateFormat: 'medium' },
    safety: { rrcsEnabled: ENV_RRCS, minRefreshSec: MIN_REFRESH_SEC, requireLogin: false },
    // Per-method sign-in switches. The env vars provide connection config; these
    // flags decide whether each method is OFFERED. A method is only usable when
    // BOTH enabled here AND configured in env (see lib/auth-routes me()).
    auth: { localEnabled: true, ldapEnabled: ENV_LDAP, samlEnabled: ENV_SAML },
    // First-run bookkeeping. onboardedAt is stamped (ISO) once the setup wizard
    // finishes — or auto-stamped at boot for deployments that were already
    // configured before the wizard existed — so the wizard never re-ambushes a
    // live install. Empty = the wizard may run.
    meta: { onboardedAt: '' },
  };
}

// ---------- validation helpers (fail SAFE on read, throw on bad write) --------
const str = (v, fallback, max = STR_MAX) => {
  const s = (v == null ? fallback : String(v)).trim();
  return s.length > max ? s.slice(0, max) : s;
};
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : (v == null ? fallback : !!v));
const clampInt = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

function sanitizeLogo(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!LOGO_RE.test(s)) throw new Error('logo must be an image data-URI (png/jpeg/svg/webp/gif)');
  if (Buffer.byteLength(s, 'utf8') > LOGO_MAX_BYTES) throw new Error(`logo exceeds ${Math.round(LOGO_MAX_BYTES / 1024)} KB`);
  return s;
}

// Merge a (partial) candidate over defaults and coerce every field to a valid
// value. Throws only on a structurally invalid logo (the one field a client can
// make too large). Everything else degrades to its default rather than failing.
function sanitize(candidate) {
  const d = defaults();
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const b = c.branding || {}, disp = c.display || {}, saf = c.safety || {};
  return {
    branding: {
      siteName: str(b.siteName, d.branding.siteName) || d.branding.siteName,
      subtitle: str(b.subtitle, d.branding.subtitle),
      logoDataUri: sanitizeLogo(b.logoDataUri),
      defaultSystem: str(b.defaultSystem, d.branding.defaultSystem, 80),
      defaultView: oneOf(b.defaultView, VIEWS, d.branding.defaultView),
    },
    display: {
      autoRefreshSec: oneOf(Number(disp.autoRefreshSec), AUTO_REFRESH_CHOICES, d.display.autoRefreshSec),
      theme: oneOf(disp.theme, THEMES, d.display.theme),
      matrixPanelsOnly: bool(disp.matrixPanelsOnly, d.display.matrixPanelsOnly),
      matrixKeyAccess: bool(disp.matrixKeyAccess, d.display.matrixKeyAccess),
      dateFormat: oneOf(disp.dateFormat, DATE_FORMATS, d.display.dateFormat),
    },
    safety: {
      rrcsEnabled: bool(saf.rrcsEnabled, d.safety.rrcsEnabled),
      minRefreshSec: clampInt(saf.minRefreshSec, MIN_REFRESH_SEC, 3600, d.safety.minRefreshSec),
      requireLogin: bool(saf.requireLogin, d.safety.requireLogin),
    },
    auth: {
      localEnabled: bool((c.auth || {}).localEnabled, d.auth.localEnabled),
      ldapEnabled: bool((c.auth || {}).ldapEnabled, d.auth.ldapEnabled),
      samlEnabled: bool((c.auth || {}).samlEnabled, d.auth.samlEnabled),
    },
    meta: {
      onboardedAt: str((c.meta || {}).onboardedAt, d.meta.onboardedAt, 40),
    },
  };
}

// ---------- IO with a read-through cache --------------------------------------
let cache = null;

function load() {
  if (cache) return cache;
  let raw = null;
  if (fs.existsSync(FILE)) {
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { console.warn(`[settings] bad ${FILE}: ${e.message} — using defaults`); }
  }
  // sanitize() can throw on a bad on-disk logo; fall back to defaults if so.
  try { cache = raw ? sanitize(raw) : defaults(); }
  catch (e) { console.warn(`[settings] ${e.message} — using defaults`); cache = defaults(); }
  return cache;
}

function getSettings() {
  // Return a deep clone so callers can't mutate the cache in place.
  return JSON.parse(JSON.stringify(load()));
}

function persist(next) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, FILE);              // atomic on POSIX — never a torn file
}

// Immutable, section-wise merge of a partial patch onto the current settings,
// then validate-and-persist. Returns the new settings. Authorization is the
// caller's responsibility (server.js gates with can()).
function updateSettings(patch) {
  const cur = load();
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = {
    branding: { ...cur.branding, ...(p.branding || {}) },
    display: { ...cur.display, ...(p.display || {}) },
    safety: { ...cur.safety, ...(p.safety || {}) },
    auth: { ...cur.auth, ...(p.auth || {}) },
    meta: { ...cur.meta, ...(p.meta || {}) },
  };
  const next = sanitize(merged);         // throws on an oversized/invalid logo
  persist(next);
  cache = next;
  return getSettings();
}

// Effective values consumed by the service/server (always valid).
function rrcsEnabled() { return load().safety.rrcsEnabled; }
function minRefreshMs() { return load().safety.minRefreshSec * 1000; }
function requireLogin() { return load().safety.requireLogin; }
function authConfig() { return load().auth; }   // { localEnabled, ldapEnabled, samlEnabled }

// First-run flag. True once the wizard (or the boot auto-stamp) has marked the
// deployment configured; the onboarding endpoints treat it as authoritative.
function isOnboarded() { return !!load().meta.onboardedAt; }
// Idempotently stamp completion. Returns the new settings (never throws on a
// re-stamp — the first timestamp wins so we don't churn settings.json).
function markOnboarded() {
  if (isOnboarded()) return getSettings();
  return updateSettings({ meta: { onboardedAt: new Date().toISOString() } });
}

module.exports = {
  getSettings, updateSettings, rrcsEnabled, minRefreshMs, requireLogin, authConfig,
  isOnboarded, markOnboarded,
  // exported for tests / UI option lists
  AUTO_REFRESH_CHOICES, THEMES, VIEWS, DATE_FORMATS, ROLES, MIN_REFRESH_SEC, defaults,
};
