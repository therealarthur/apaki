/**
 * webauthn.js: the WebAuthn checks behind Apaki accounts (apaki/remote/ACCOUNTS.md),
 * with no dependencies: WebCrypto only, so the same file runs in workerd (the
 * Account Durable Object) and in Node (tests/accounts.spec.mjs imports it).
 *
 * What is here:
 *   - base64url (strict: canonical, no padding), the encoding of every binary value on the wire;
 *   - a small CBOR decoder (RFC 8949 subset: unsigned and negative ints, byte and
 *     text strings, arrays, maps, false/true/null/undefined). It refuses
 *     indefinite lengths, tags, floats, duplicate map keys, trailing bytes, and
 *     caps nesting and item counts, because its input comes from the network;
 *   - authenticator data parsing (RP id hash, flags, signature counter, attested
 *     credential data with its COSE key, extensions);
 *   - COSE key import for ES256 (-7, EC2 P-256), RS256 (-257, RSA 2048 to 4096
 *     bits) and EdDSA (-8, OKP Ed25519), stored afterwards as a public JWK + alg;
 *   - DER to IEEE P1363 for ES256 signatures (WebCrypto verifies P1363 only);
 *   - verifyRegistration (navigator.credentials.create) and verifyAssertion
 *     (navigator.credentials.get).
 *
 * Attestation is requested as "none" and its statement is not checked: the
 * account trusts the passkey the user made, not a vendor certificate.
 */

/** COSE algorithm ids the accounts accept. */
export const COSE_ALG = Object.freeze({ ES256: -7, EDDSA: -8, RS256: -257 });

/** Authenticator data flag bits (WebAuthn Level 3, 6.1). */
export const FLAG = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 });

/** Largest WebAuthn credential id (WebAuthn: at most 1023 bytes). */
export const MAX_CREDENTIAL_ID = 1023;

/** A WebAuthn check failed. The message is safe to show: it never contains key material or client data. */
export class WebAuthnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

const te = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/* ===== bytes ===== */

/** base64url without padding. */
export function b64uEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url decode: only the url alphabet, no padding, and canonical
 * (the unused low bits of the last character are zero), so every value has
 * exactly one spelling. Returns null for anything else.
 */
export function b64uDecode(s) {
  if (typeof s !== 'string' || !B64U_RE.test(s) || s.length % 4 === 1) return null;
  let bin;
  try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return b64uEncode(out) === s ? out : null;
}

/** Concatenates byte arrays. */
export function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Constant-time equality of two byte arrays (the lengths are public). */
export function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** A 16-byte AAGUID as the usual 8-4-4-4-12 hex string. */
export function uuidString(bytes) {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ===== CBOR ===== */

/** Nesting limit: an attestation object is three levels deep (map, attStmt map, x5c array). */
const CBOR_MAX_DEPTH = 8;
/** Entries in one array or map. A COSE key has about 5, an attestation statement a handful. */
const CBOR_MAX_ITEMS = 64;

function readUint(buf, pos, n) {
  if (pos + n > buf.length) throw new WebAuthnError('cbor: truncated');
  if (n === 1) return buf[pos];
  if (n === 2) return (buf[pos] << 8) | buf[pos + 1];
  const dv = new DataView(buf.buffer, buf.byteOffset + pos, n);
  if (n === 4) return dv.getUint32(0);
  const hi = dv.getUint32(0);
  // Beyond 2^53 a JS number would round; nothing in WebAuthn needs such values.
  if (hi >= 0x200000) throw new WebAuthnError('cbor: integer too large');
  return hi * 0x100000000 + dv.getUint32(4);
}

/** Decodes one CBOR item at `pos`: { value, pos } (the position after it). Maps come back as Map. */
function cborItem(buf, pos, depth) {
  if (pos >= buf.length) throw new WebAuthnError('cbor: truncated');
  const ib = buf[pos++];
  const major = ib >> 5;
  const ai = ib & 31;
  let arg;
  if (ai < 24) arg = ai;
  else if (ai <= 27) {
    const n = 1 << (ai - 24);
    arg = readUint(buf, pos, n);
    pos += n;
  } else {
    throw new WebAuthnError(ai === 31 ? 'cbor: indefinite lengths are not accepted' : 'cbor: reserved additional information');
  }
  switch (major) {
    case 0: return { value: arg, pos };
    case 1: return { value: -1 - arg, pos };
    case 2:
    case 3: {
      if (arg > buf.length - pos) throw new WebAuthnError('cbor: truncated');
      const bytes = buf.slice(pos, pos + arg);
      pos += arg;
      if (major === 2) return { value: bytes, pos };
      try { return { value: utf8Strict.decode(bytes), pos }; } catch { throw new WebAuthnError('cbor: text is not UTF-8'); }
    }
    case 4: {
      if (depth >= CBOR_MAX_DEPTH) throw new WebAuthnError('cbor: nested too deeply');
      if (arg > CBOR_MAX_ITEMS) throw new WebAuthnError('cbor: array too long');
      const arr = [];
      for (let i = 0; i < arg; i++) {
        const r = cborItem(buf, pos, depth + 1);
        arr.push(r.value);
        pos = r.pos;
      }
      return { value: arr, pos };
    }
    case 5: {
      if (depth >= CBOR_MAX_DEPTH) throw new WebAuthnError('cbor: nested too deeply');
      if (arg > CBOR_MAX_ITEMS) throw new WebAuthnError('cbor: map too long');
      const map = new Map();
      for (let i = 0; i < arg; i++) {
        const k = cborItem(buf, pos, depth + 1);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new WebAuthnError('cbor: map keys must be integers or text');
        if (map.has(k.value)) throw new WebAuthnError('cbor: duplicate map key');
        const v = cborItem(buf, k.pos, depth + 1);
        map.set(k.value, v.value);
        pos = v.pos;
      }
      return { value: map, pos };
    }
    case 6: throw new WebAuthnError('cbor: tags are not accepted');
    default: // 7: simple values and floats
      if (ai === 20) return { value: false, pos };
      if (ai === 21) return { value: true, pos };
      if (ai === 22) return { value: null, pos };
      if (ai === 23) return { value: undefined, pos };
      throw new WebAuthnError('cbor: floats and other simple values are not accepted');
  }
}

/** Decodes a whole CBOR document; trailing bytes are an error. */
export function decodeCbor(buf) {
  if (!(buf instanceof Uint8Array)) throw new WebAuthnError('cbor: not bytes');
  const r = cborItem(buf, 0, 0);
  if (r.pos !== buf.length) throw new WebAuthnError('cbor: trailing bytes');
  return r.value;
}

/** Decodes the CBOR item that starts at `pos` and says where it ends (authenticator data embeds CBOR mid-buffer). */
export function decodeCborAt(buf, pos) {
  return cborItem(buf, pos, 0);
}

/* ===== authenticator data ===== */

/**
 * Parses authenticator data (WebAuthn 6.1): rpIdHash(32) flags(1) signCount(4),
 * then attested credential data when AT is set (aaguid(16) idLen(2) id COSEkey)
 * and an extensions map when ED is set. Every byte must be accounted for.
 */
export function parseAuthData(ad) {
  if (!(ad instanceof Uint8Array) || ad.length < 37) throw new WebAuthnError('authenticator data too short');
  const flags = ad[32];
  const out = {
    rpIdHash: ad.subarray(0, 32),
    flags,
    signCount: new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0),
    up: Boolean(flags & FLAG.UP),
    uv: Boolean(flags & FLAG.UV),
    be: Boolean(flags & FLAG.BE),
    bs: Boolean(flags & FLAG.BS),
    at: Boolean(flags & FLAG.AT),
    ed: Boolean(flags & FLAG.ED),
  };
  // A credential that is not backup eligible cannot be backed up (WebAuthn 6.1.3).
  if (out.bs && !out.be) throw new WebAuthnError('authenticator data flags are inconsistent (backed up but not backup eligible)');
  let pos = 37;
  if (out.at) {
    if (pos + 18 > ad.length) throw new WebAuthnError('attested credential data truncated');
    out.aaguid = ad.slice(pos, pos + 16);
    pos += 16;
    const len = (ad[pos] << 8) | ad[pos + 1];
    pos += 2;
    if (len < 1 || len > MAX_CREDENTIAL_ID || pos + len > ad.length) throw new WebAuthnError('credential id length out of range');
    out.credentialId = ad.slice(pos, pos + len);
    pos += len;
    const key = decodeCborAt(ad, pos);
    out.coseKey = key.value;
    pos = key.pos;
  }
  if (out.ed) {
    const ext = decodeCborAt(ad, pos);
    if (!(ext.value instanceof Map)) throw new WebAuthnError('authenticator extensions are not a map');
    out.extensions = ext.value;
    pos = ext.pos;
  }
  if (pos !== ad.length) throw new WebAuthnError('authenticator data has trailing bytes');
  return out;
}

/* ===== COSE keys ===== */

function bytesOf(map, label, min, max = min) {
  const v = map.get(label);
  if (!(v instanceof Uint8Array) || v.length < min || v.length > max) throw new WebAuthnError('passkey public key is malformed');
  return v;
}

function stripZeros(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

/**
 * Turns a COSE_Key (a Map from the attested credential data) into the public
 * JWK + COSE alg the account stores, after checking WebCrypto accepts it (for
 * EC2 that includes the point being on the curve).
 */
export async function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new WebAuthnError('passkey public key is not a COSE key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (alg === COSE_ALG.ES256) {
    if (kty !== 2 || cose.get(-1) !== 1) throw new WebAuthnError('ES256 needs an EC2 P-256 key');
    jwk = { kty: 'EC', crv: 'P-256', x: b64uEncode(bytesOf(cose, -2, 32)), y: b64uEncode(bytesOf(cose, -3, 32)) };
  } else if (alg === COSE_ALG.RS256) {
    if (kty !== 3) throw new WebAuthnError('RS256 needs an RSA key');
    const n = stripZeros(bytesOf(cose, -1, 1, 513));
    const e = stripZeros(bytesOf(cose, -2, 1, 8));
    // 2048 to 4096 bit moduli; an odd public exponent of at least 3.
    if (n.length < 256 || n.length > 512) throw new WebAuthnError('RSA key size must be 2048 to 4096 bits');
    if (e.length > 4 || (e[e.length - 1] & 1) === 0 || (e.length === 1 && e[0] < 3)) throw new WebAuthnError('RSA public exponent is not acceptable');
    jwk = { kty: 'RSA', n: b64uEncode(n), e: b64uEncode(e) };
  } else if (alg === COSE_ALG.EDDSA) {
    if (kty !== 1 || cose.get(-1) !== 6) throw new WebAuthnError('EdDSA needs an OKP Ed25519 key');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64uEncode(bytesOf(cose, -2, 32)) };
  } else {
    throw new WebAuthnError('passkey algorithm is not supported (use ES256, RS256 or EdDSA)');
  }
  await importPublicKey(alg, jwk); // throws when the runtime refuses the key
  return { alg, jwk };
}

/**
 * Imports a stored public JWK for verifying: { key, params } where params is
 * what crypto.subtle.verify takes. Ed25519 goes by its standard name, with
 * workerd's older NODE-ED25519 name as a fallback; a runtime with neither
 * refuses EdDSA passkeys cleanly.
 */
export async function importPublicKey(alg, jwk) {
  const subtle = crypto.subtle;
  try {
    if (alg === COSE_ALG.ES256) {
      return { key: await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']), params: { name: 'ECDSA', hash: 'SHA-256' } };
    }
    if (alg === COSE_ALG.RS256) {
      return { key: await subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']), params: { name: 'RSASSA-PKCS1-v1_5' } };
    }
    if (alg === COSE_ALG.EDDSA) {
      try {
        return { key: await subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']), params: { name: 'Ed25519' } };
      } catch {
        return { key: await subtle.importKey('jwk', jwk, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']), params: { name: 'NODE-ED25519' } };
      }
    }
  } catch {
    throw new WebAuthnError('passkey public key is not usable');
  }
  throw new WebAuthnError('passkey algorithm is not supported');
}

/* ===== signatures ===== */

/**
 * ES256 signatures arrive DER encoded (SEQUENCE { INTEGER r, INTEGER s });
 * WebCrypto wants r || s, 32 bytes each. Strict DER: short lengths, minimal
 * positive integers, nothing after the sequence.
 */
export function derToP1363(der, size = 32) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 6 + 2 * (size + 1) || der[0] !== 0x30 || der[1] !== der.length - 2) {
    throw new WebAuthnError('ES256 signature is not DER');
  }
  const out = new Uint8Array(size * 2);
  let pos = 2;
  for (let i = 0; i < 2; i++) {
    if (der[pos] !== 0x02) throw new WebAuthnError('ES256 signature is not DER');
    const len = der[pos + 1];
    pos += 2;
    if (len < 1 || len > size + 1 || pos + len > der.length) throw new WebAuthnError('ES256 signature is not DER');
    let v = der.subarray(pos, pos + len);
    pos += len;
    if (v[0] & 0x80) throw new WebAuthnError('ES256 signature has a negative integer');
    if (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) throw new WebAuthnError('ES256 signature integer is not minimal');
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new WebAuthnError('ES256 signature integer too large');
    out.set(v, i * size + size - v.length);
  }
  if (pos !== der.length) throw new WebAuthnError('ES256 signature has trailing bytes');
  return out;
}

/* ===== ceremonies ===== */

/**
 * The clientDataJSON checks shared by both ceremonies: the right type, the
 * challenge the relay issued, the one accepted origin, and not made inside a
 * cross-origin frame.
 */
export function checkClientData(bytes, { type, challenge, origin }) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4096) throw new WebAuthnError('clientDataJSON too large');
  let cd;
  try { cd = JSON.parse(utf8Strict.decode(bytes)); } catch { throw new WebAuthnError('clientDataJSON is not JSON'); }
  if (!cd || typeof cd !== 'object' || Array.isArray(cd)) throw new WebAuthnError('clientDataJSON is not an object');
  if (cd.type !== type) throw new WebAuthnError(`clientDataJSON type is not ${type}`);
  if (typeof cd.challenge !== 'string' || typeof challenge !== 'string' || !equalBytes(te.encode(cd.challenge), te.encode(challenge))) {
    throw new WebAuthnError('the challenge does not match');
  }
  if (cd.origin !== origin) throw new WebAuthnError('the origin does not match');
  // Only absent or false is accepted; topOrigin only exists for cross-origin calls.
  if (cd.crossOrigin !== undefined && cd.crossOrigin !== false) throw new WebAuthnError('cross-origin ceremonies are not accepted');
  if (cd.topOrigin !== undefined) throw new WebAuthnError('cross-origin ceremonies are not accepted');
  return cd;
}

async function checkRp(ad, rpId) {
  if (!equalBytes(ad.rpIdHash, await sha256(te.encode(rpId)))) throw new WebAuthnError('the RP id hash does not match');
  if (!ad.up) throw new WebAuthnError('user presence is required');
  if (!ad.uv) throw new WebAuthnError('user verification is required (a screen lock, fingerprint or face)');
}

function needBytes(value, what, max) {
  const b = b64uDecode(value);
  if (!b || b.length === 0 || b.length > max) throw new WebAuthnError(`${what} is not valid base64url`);
  return b;
}

/**
 * Checks a navigator.credentials.create() result.
 * @param {{ id: string, clientDataJSON: string, attestationObject: string }} credential  base64url fields
 * @param {{ challenge: string, origin: string, rpId: string }} expect
 * @returns {Promise<{ alg: number, jwk: object, signCount: number, aaguid: string, be: boolean, bs: boolean }>}
 */
export async function verifyRegistration(credential, { challenge, origin, rpId }) {
  const id = needBytes(credential.id, 'credential id', MAX_CREDENTIAL_ID);
  checkClientData(needBytes(credential.clientDataJSON, 'clientDataJSON', 4096), { type: 'webauthn.create', challenge, origin });
  const att = decodeCbor(needBytes(credential.attestationObject, 'attestationObject', 16384));
  if (!(att instanceof Map)) throw new WebAuthnError('attestationObject is not a map');
  const fmt = att.get('fmt');
  const authData = att.get('authData');
  if (typeof fmt !== 'string' || !(att.get('attStmt') instanceof Map) || !(authData instanceof Uint8Array)) {
    throw new WebAuthnError('attestationObject lacks fmt, attStmt or authData');
  }
  const ad = parseAuthData(authData);
  await checkRp(ad, rpId);
  if (!ad.at) throw new WebAuthnError('no attested credential data');
  if (!equalBytes(ad.credentialId, id)) throw new WebAuthnError('the credential id does not match the attested one');
  const { alg, jwk } = await coseToJwk(ad.coseKey);
  return { alg, jwk, signCount: ad.signCount, aaguid: uuidString(ad.aaguid), be: ad.be, bs: ad.bs };
}

/**
 * Checks a navigator.credentials.get() result against a stored passkey.
 * The signature covers authenticatorData || SHA-256(clientDataJSON).
 * @param {{ clientDataJSON: string, authenticatorData: string, signature: string }} credential  base64url fields
 * @param {{ alg: number, jwk: object }} stored
 * @param {{ challenge: string, origin: string, rpId: string }} expect
 * @returns {Promise<{ signCount: number, be: boolean, bs: boolean }>}
 */
export async function verifyAssertion(credential, stored, { challenge, origin, rpId }) {
  const clientData = needBytes(credential.clientDataJSON, 'clientDataJSON', 4096);
  checkClientData(clientData, { type: 'webauthn.get', challenge, origin });
  const authData = needBytes(credential.authenticatorData, 'authenticatorData', 4096);
  const ad = parseAuthData(authData);
  await checkRp(ad, rpId);
  if (ad.at) throw new WebAuthnError('an assertion carries no attested credential data');
  let sig = needBytes(credential.signature, 'signature', 1024);
  if (stored.alg === COSE_ALG.ES256) sig = derToP1363(sig);
  else if (stored.alg === COSE_ALG.EDDSA && sig.length !== 64) throw new WebAuthnError('EdDSA signature must be 64 bytes');
  const { key, params } = await importPublicKey(stored.alg, stored.jwk);
  const signed = concatBytes(authData, await sha256(clientData));
  let ok = false;
  try { ok = await crypto.subtle.verify(params, key, sig, signed); } catch { ok = false; }
  if (!ok) throw new WebAuthnError('the signature does not verify');
  return { signCount: ad.signCount, be: ad.be, bs: ad.bs };
}

/**
 * The signature counter rule: authenticators that do not count report 0
 * forever; once either side is nonzero the counter must grow, or the passkey
 * may have been copied.
 */
export function counterOk(stored, next) {
  if (stored === 0 && next === 0) return true;
  return next > stored;
}
