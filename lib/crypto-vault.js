// lib/crypto-vault.js — AES-256-GCM symmetric vault for small secrets stored
// in-app (the LDAP bind password and SAML SP private key configured via the
// admin panel). Ported from intercom_manager.
//
// Master key resolution (in order):
//   1. process.env.IMX_SECRET_KEY — 32 bytes, base64. The most secure option:
//      the key lives in the environment, separate from the on-disk ciphertext,
//      so a leaked config/disk backup yields only ciphertext.
//   2. data/.secret-key — auto-generated (0600, gitignored) on first run if no
//      env key is set, so secrets survive restarts without operator setup. Less
//      ideal (key sits next to the data) but still far better than plaintext.
// Losing the key orphans stored secrets — re-enter them via the admin UI.
//
// Ciphertext format: `v1:<iv-b64>:<ct-b64>:<tag-b64>`  (iv 12B, GCM tag 16B)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_BYTES = 32, IV_BYTES = 12, TAG_BYTES = 16, PREFIX = 'v1';
const DATA_DIR = process.env.REQUESTS_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE = process.env.SECRET_KEY_FILE || path.join(DATA_DIR, '.secret-key');

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

let KEY = null;   // active 32-byte key buffer (set by ensureKey)

function fromBase64(raw) {
  if (!raw) return null;
  let buf; try { buf = unb64(raw); } catch { return null; }
  return buf.length === KEY_BYTES ? buf : null;
}

// Resolve (or mint) the master key. Call once at startup.
function ensureKey() {
  if (KEY) return KEY;
  const envKey = fromBase64(process.env.IMX_SECRET_KEY);
  if (envKey) { KEY = envKey; return KEY; }
  // Try the persisted key file.
  try {
    if (fs.existsSync(KEY_FILE)) {
      const fileKey = fromBase64(fs.readFileSync(KEY_FILE, 'utf8').trim());
      if (fileKey) { KEY = fileKey; return KEY; }
    }
  } catch { /* fall through to mint */ }
  // Mint a fresh key and persist it (0600).
  const fresh = b64(crypto.randomBytes(KEY_BYTES));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, fresh + '\n', { mode: 0o600 });
    fs.chmodSync(KEY_FILE, 0o600);
    console.warn(`[crypto-vault] No IMX_SECRET_KEY — generated one at ${KEY_FILE} (0600). Back it up; set IMX_SECRET_KEY in env for stronger at-rest protection.`);
  } catch (e) {
    console.warn(`[crypto-vault] Could not persist a key (${e.message}) — using an in-memory key; stored secrets won't survive a restart.`);
  }
  KEY = unb64(fresh);
  return KEY;
}

function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const k = KEY || ensureKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${PREFIX}:${b64(iv)}:${b64(ct)}:${b64(cipher.getAuthTag())}`;
}

function decryptSecret(ciphertext) {
  if (!ciphertext) return null;
  const parts = String(ciphertext).split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const k = KEY || ensureKey();
  let iv, ct, tag;
  try { iv = unb64(parts[1]); ct = unb64(parts[2]); tag = unb64(parts[3]); } catch { return null; }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch { return null; }   // tampered or wrong key
}

// True for a value already in vault-ciphertext form.
const isCiphertext = (v) => typeof v === 'string' && v.startsWith(PREFIX + ':') && v.split(':').length === 4;

module.exports = { ensureKey, encryptSecret, decryptSecret, isCiphertext, KEY_FILE };
