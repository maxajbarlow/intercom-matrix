// lib/auth-helpers.js — shared helpers for the LDAP and SAML login flows.
//
// resolveRole maps a flat list of group identifiers (already lowercased) to a
// session role (viewer | editor | admin) using LDAP_GROUP_* / SAML_GROUP_* env
// vars. The caller flattens — LDAP gives memberOf DNs, SAML gives claim values
// (GUIDs, names, or URIs) — so we don't assume a format.
//
// classifyTlsError peels common TLS / connection errors out of a thrown error
// (including ldapts wrappers) for a useful one-line diagnostic without leaking
// detail to end users.

// `map` is { admin, editor, viewer } group identifiers (from the effective LDAP
// or SAML config). Highest matched privilege wins. No map configured at all →
// every authenticated directory user is a viewer (trusted-network default).
function resolveRole(groupsLower, map = {}) {
  const ag = String(map.admin || '').toLowerCase();
  const eg = String(map.editor || '').toLowerCase();
  const vg = String(map.viewer || '').toLowerCase();
  const anyConfigured = !!(ag || eg || vg);
  let role = null;
  if (vg && groupsLower.includes(vg)) role = 'viewer';
  if (eg && groupsLower.includes(eg)) role = 'editor';
  if (ag && groupsLower.includes(ag)) role = 'admin';
  if (!anyConfigured) return 'viewer';
  return role;
}

// Walk the `cause` chain on a thrown error and return the first node-tls / net
// error code found. ldapts wraps low-level errors, so the surface .code is
// often unhelpful.
function unwrapCode(err) {
  let cur = err;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.code) return cur.code;
    if (cur.reason) return cur.reason;
    cur = cur.cause;
  }
  return null;
}

const TLS_ERROR_LABELS = {
  CERT_HAS_EXPIRED: 'tls_cert_expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_self_signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_self_signed_in_chain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_unknown_ca',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls_unknown_ca',
  CERT_UNTRUSTED: 'tls_untrusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname_mismatch',
  ECONNREFUSED: 'connect_refused',
  ECONNRESET: 'connect_reset',
  ENOTFOUND: 'dns_not_found',
  ETIMEDOUT: 'connect_timeout',
};

function classifyTlsError(err) {
  const code = unwrapCode(err);
  if (!code) return { code: null, label: 'unknown' };
  return { code, label: TLS_ERROR_LABELS[code] || 'other' };
}

module.exports = { resolveRole, classifyTlsError, unwrapCode };
