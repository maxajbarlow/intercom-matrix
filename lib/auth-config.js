// lib/auth-config.js — in-app LDAP + SAML connection configuration.
//
// Connection details an admin sets in the UI live here (data/auth-config.json,
// gitignored). Secrets (LDAP bind password, SAML SP private key) are encrypted
// at rest with lib/crypto-vault; everything else is plaintext. Env vars remain a
// FALLBACK, so existing env-based deployments keep working and in-app values
// simply override them per field.
//
// Three views:
//   effective(section) — fully resolved, secrets DECRYPTED + cert files read;
//                        consumed internally by the LDAP/SAML auth flows. Never
//                        sent to a client.
//   redacted(section)  — admin UI view: real values for non-secrets, secrets
//                        masked (value never leaves the server).
//   update(section, p) — write; a secret left as the MASK means "unchanged".

const fs = require('fs');
const path = require('path');
const vault = require('./crypto-vault');

const DATA_DIR = process.env.REQUESTS_DIR || path.join(__dirname, '..', 'data');
const FILE = process.env.AUTH_CONFIG_FILE || path.join(DATA_DIR, 'auth-config.json');
const MASK = '••••••••';

// type: str | bool | pemFile (env is a file path, app value is PEM text)
//     | secret (env is a plain value, stored encrypted)
//     | secretPemFile (env is a file path, app value is encrypted PEM)
const LDAP_SPEC = [
  { key: 'url', env: 'LDAP_URL', type: 'str' },
  { key: 'baseDn', env: 'LDAP_BASE_DN', type: 'str' },
  { key: 'userSearchBase', env: 'LDAP_USER_SEARCH_BASE', type: 'str' },
  { key: 'bindDn', env: 'LDAP_BIND_DN', type: 'str' },
  { key: 'bindPassword', env: 'LDAP_BIND_PASSWORD', type: 'secret' },
  { key: 'userFilter', env: 'LDAP_USER_FILTER', type: 'str', def: '(sAMAccountName={{username}})' },
  { key: 'groupAdmin', env: 'LDAP_GROUP_ADMIN', type: 'str' },
  { key: 'groupEditor', env: 'LDAP_GROUP_EDITOR', type: 'str' },
  { key: 'groupViewer', env: 'LDAP_GROUP_VIEWER', type: 'str' },
  { key: 'tlsVerify', env: 'LDAP_TLS_VERIFY', type: 'bool', def: true },
  { key: 'startTls', env: 'LDAP_STARTTLS', type: 'bool', def: false },
  { key: 'tlsCa', env: 'LDAP_TLS_CA_FILE', type: 'pemFile' },
  { key: 'fingerprint', env: 'LDAP_TLS_FINGERPRINT_SHA256', type: 'str' },
];
const SAML_SPEC = [
  { key: 'entryPoint', env: 'SAML_ENTRY_POINT', type: 'str' },
  { key: 'issuer', env: 'SAML_ISSUER', type: 'str', def: 'intercom-matrix' },
  { key: 'callbackUrl', env: 'SAML_CALLBACK_URL', type: 'str' },
  { key: 'idpCert', env: 'SAML_IDP_CERT_FILE', type: 'pemFile' },
  { key: 'spCert', env: 'SAML_SP_CERT_FILE', type: 'pemFile' },
  { key: 'spPrivateKey', env: 'SAML_SP_PRIVATE_KEY_FILE', type: 'secretPemFile' },
  { key: 'wantAssertionsSigned', env: 'SAML_WANT_ASSERTIONS_SIGNED', type: 'bool', def: true },
  { key: 'wantAuthnResponseSigned', env: 'SAML_WANT_AUTHN_RESPONSE_SIGNED', type: 'bool', def: true },
  { key: 'signatureAlgorithm', env: 'SAML_SIGNATURE_ALGORITHM', type: 'str', def: 'sha256' },
  { key: 'nameIdFormat', env: 'SAML_NAME_ID_FORMAT', type: 'str', def: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' },
  { key: 'usernameAttribute', env: 'SAML_USERNAME_ATTRIBUTE', type: 'str' },
  { key: 'displayNameAttribute', env: 'SAML_DISPLAY_NAME_ATTRIBUTE', type: 'str' },
  { key: 'groupsAttribute', env: 'SAML_GROUPS_ATTRIBUTE', type: 'str' },
  { key: 'groupAdmin', env: 'SAML_GROUP_ADMIN', type: 'str' },
  { key: 'groupEditor', env: 'SAML_GROUP_EDITOR', type: 'str' },
  { key: 'groupViewer', env: 'SAML_GROUP_VIEWER', type: 'str' },
  { key: 'logoutUrl', env: 'SAML_LOGOUT_URL', type: 'str' },
];
const SPEC = { ldap: LDAP_SPEC, saml: SAML_SPEC };
const SECRET_TYPES = new Set(['secret', 'secretPemFile']);

const truthy = (v) => /^(1|true|on|yes)$/i.test(String(v ?? ''));
function readFileSafe(p) { try { return p ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } }

// ---------- store IO ----------
let cache = null;
function load() {
  if (cache) return cache;
  let raw = {};
  if (fs.existsSync(FILE)) {
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
    catch (e) { console.warn(`[auth-config] bad ${FILE}: ${e.message} — ignoring`); }
  }
  cache = { ldap: raw.ldap && typeof raw.ldap === 'object' ? raw.ldap : {}, saml: raw.saml && typeof raw.saml === 'object' ? raw.saml : {} };
  return cache;
}
function persist(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = next;
}

const hasApp = (section, key) => {
  const v = load()[section][key];
  return v !== undefined && v !== null && v !== '';
};

// Fully-resolved value for one field (secrets decrypted, cert files read).
function resolveField(section, spec) {
  const store = load()[section];
  const appHas = hasApp(section, spec.key);
  switch (spec.type) {
    case 'bool': {
      if (typeof store[spec.key] === 'boolean') return store[spec.key];
      const e = process.env[spec.env];
      if (e !== undefined && e !== '') return truthy(e);
      return spec.def ?? false;
    }
    case 'secret':
      if (appHas) return vault.decryptSecret(store[spec.key]);
      return process.env[spec.env] || (spec.def ?? '');
    case 'secretPemFile':
      if (appHas) return vault.decryptSecret(store[spec.key]);
      return readFileSafe((process.env[spec.env] || '').trim());
    case 'pemFile':
      if (appHas) return String(store[spec.key]);
      return readFileSafe((process.env[spec.env] || '').trim());
    default: { // str
      if (appHas) return String(store[spec.key]);
      const e = process.env[spec.env];
      return (e !== undefined && e !== '') ? e : (spec.def ?? '');
    }
  }
}

function effective(section) {
  const out = {};
  for (const spec of SPEC[section]) out[spec.key] = resolveField(section, spec);
  return out;
}

// Admin view: never leaks a secret value. For non-secrets returns the effective
// value + where it came from; for secrets just whether one is set and its source.
function redacted(section) {
  const store = load()[section];
  const out = {};
  for (const spec of SPEC[section]) {
    const appHas = hasApp(section, spec.key);
    const envRaw = (process.env[spec.env] || '').trim();
    const source = appHas ? 'app' : (envRaw ? 'env' : 'unset');
    if (SECRET_TYPES.has(spec.type)) {
      out[spec.key] = { secret: true, hasValue: source !== 'unset', source };
    } else {
      out[spec.key] = { value: resolveField(section, spec), source };
    }
  }
  return out;
}

function validate(section, patch) {
  if (section === 'ldap' && patch.url) {
    let u; try { u = new URL(String(patch.url)); } catch { throw new Error('LDAP URL is not a valid URL'); }
    if (!/^ldaps?:$/.test(u.protocol)) throw new Error('LDAP URL must start with ldap:// or ldaps://');
  }
  for (const spec of SPEC[section]) {
    if (spec.type === 'pemFile' && patch[spec.key] && patch[spec.key] !== MASK && !/-----BEGIN /.test(patch[spec.key])) {
      throw new Error(`${spec.key}: expected PEM text (-----BEGIN …-----)`);
    }
  }
}

// Apply a partial patch. Per field: omitted → unchanged; '' → cleared (falls
// back to env); MASK on a secret → unchanged; any other value → set.
function update(section, patch) {
  if (!SPEC[section]) throw new Error('unknown section');
  validate(section, patch || {});
  const cur = load();
  const next = { ldap: { ...cur.ldap }, saml: { ...cur.saml } };
  const target = next[section];
  for (const spec of SPEC[section]) {
    if (!(spec.key in patch)) continue;
    let v = patch[spec.key];
    if (SECRET_TYPES.has(spec.type)) {
      if (v === MASK || v === undefined) continue;           // unchanged
      if (v === '' || v === null) { delete target[spec.key]; continue; }  // clear
      target[spec.key] = vault.encryptSecret(String(v));     // set (encrypted)
    } else if (spec.type === 'bool') {
      target[spec.key] = !!v;
    } else {
      v = v == null ? '' : String(v).trim();
      if (v === '') delete target[spec.key]; else target[spec.key] = v;
    }
  }
  persist(next);
  return redacted(section);
}

// "Configured" = enough resolved fields (app OR env) to actually attempt auth.
function ldapConfigured() {
  const url = (effective('ldap').url || '').trim();
  if (!url) return false;
  try { return /^ldaps?:$/.test(new URL(url).protocol); } catch { return false; }
}
function samlConfigured() {
  const s = effective('saml');
  return !!(s.entryPoint && s.issuer && s.callbackUrl && s.idpCert);
}

// ---------- LDAP client (shared by the login flow + the test button) ----------
function buildTlsOptions(eff) {
  const opts = { rejectUnauthorized: eff.tlsVerify !== false, minVersion: 'TLSv1.2' };
  if (eff.tlsCa) opts.ca = eff.tlsCa;   // PEM text directly (no file path)
  const pin = String(eff.fingerprint || '').replace(/[:\s]/g, '').toLowerCase();
  if (pin) {
    opts.checkServerIdentity = (host, cert) => {
      const fp = (cert.fingerprint256 || '').replace(/[:\s]/g, '').toLowerCase();
      return fp === pin ? undefined : new Error(`LDAP TLS fingerprint mismatch (got ${fp.slice(0, 16)}…)`);
    };
  }
  return opts;
}
async function makeLdapClient(eff) {
  const { Client } = require('ldapts');
  const client = new Client({ url: eff.url, tlsOptions: buildTlsOptions(eff) });
  if (eff.startTls) await client.startTLS(buildTlsOptions(eff));
  return client;
}

// Merge unsaved form overrides onto the effective config (MASK / absent secret
// = keep stored). Used so the admin can Test before Save.
function withOverrides(overrides) {
  const eff = effective('ldap');
  if (!overrides) return eff;
  for (const spec of LDAP_SPEC) {
    if (!(spec.key in overrides)) continue;
    const v = overrides[spec.key];
    if (SECRET_TYPES.has(spec.type) && (v === MASK || v === '' || v == null)) continue;  // keep stored secret
    eff[spec.key] = spec.type === 'bool' ? !!v : v;
  }
  return eff;
}

async function testLdap(overrides) {
  const { classifyTlsError } = require('./auth-helpers');
  const eff = withOverrides(overrides);
  if (!eff.url) return { ok: false, stage: 'config', error: 'LDAP URL not set' };
  let client;
  try { client = await makeLdapClient(eff); } catch (e) { return { ok: false, stage: 'connect', error: classifyTlsError(e).label }; }
  try {
    if (eff.bindDn) {
      try { await client.bind(eff.bindDn, eff.bindPassword); }
      catch (e) { return { ok: false, stage: 'bind', error: 'Service-account bind failed: ' + (e.message || e) }; }
    }
    const base = (eff.userSearchBase || eff.baseDn || '').trim();
    if (base) await client.search(base, { scope: 'sub', filter: '(objectClass=*)', sizeLimit: 1, attributes: ['dn'] });
    return { ok: true, stage: 'ok', detail: eff.bindDn ? 'Connected, bound, and searched.' : 'Connected (anonymous bind).' };
  } catch (e) {
    const { label } = classifyTlsError(e);
    return { ok: false, stage: 'search', error: label !== 'other' && label !== 'unknown' ? label : (e.message || String(e)) };
  } finally { try { await client.unbind(); } catch { /* ignore */ } }
}

module.exports = {
  effective, redacted, update, ldapConfigured, samlConfigured,
  buildTlsOptions, makeLdapClient, testLdap,
  LDAP_SPEC, SAML_SPEC, MASK,
};
