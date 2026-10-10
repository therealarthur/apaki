/**
 * account-lib.js: the pure parts of Apaki accounts (no Cloudflare imports), so
 * the Worker, the Account Durable Object and the Node tests share them.
 * Contract: apaki/remote/ACCOUNTS.md.
 *
 *   - tokens: base64url(JSON) "." base64url(HMAC-SHA-256(ACCOUNT_KEY, "apaki/v1 account token" || first part)),
 *     where "first part" is the ASCII of the base64url text before the dot;
 *     challenge tokens { k: 'c', p, c, a?, exp } live 5 minutes, sessions
 *     { k: 's', a, g, exp } 30 days (exp is unix seconds);
 *   - input checks: names, WebAuthn credential shapes, the vault blob;
 *   - what the server answers about an account (accountView, vaultView).
 *
 * The relay never sees anything that opens the vault: it stores the iv, ct and
 * wraps it is given and checks only their shape and size.
 */

import { b64uEncode, b64uDecode, MAX_CREDENTIAL_ID } from './webauthn.js';

/** /v1/account and everything under it. */
export const ACCOUNT_PATH = /^\/v1\/account(?:\/.*)?$/;
/** GET /v1/rooms/<roomId>/presence */
export const PRESENCE_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/presence$/;

export const DEFAULT_ACCOUNT_ORIGIN = 'https://apaki.myrlin.io';
/** The WebAuthn relying party name the page shows in passkey prompts. */
export const RP_NAME = 'Myrlin Apaki';
export const TOKEN_LABEL = 'apaki/v1 account token';

export const CHALLENGE_TTL_S = 5 * 60;
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
export const PURPOSES = Object.freeze(['register', 'signin', 'add']);

export const LIMITS = Object.freeze({
  MAX_PASSKEYS: 10,
  NAME_MAX: 48,
  /** PUT /v1/account/vault body. */
  VAULT_BODY_MAX: 64 * 1024,
  /** Every other body (a registration with an RSA key and transports is about 2 KiB). */
  BODY_MAX: 16 * 1024,
  TOKEN_MAX: 1024,
  CLIENT_DATA_MAX: 4096,
  ATTESTATION_MAX: 8192,
  AUTH_DATA_MAX: 1024,
  SIGNATURE_MAX: 1024,
  /** AES-GCM iv: 96 bits. */
  IV_BYTES: 12,
  /** AES-GCM output is at least its 16-byte tag. */
  CT_MIN: 16,
  /** A wrap holds a 32-byte vault key (48 bytes with the tag); a little room for later formats. */
  WRAP_CT_MAX: 256,
  /** Unexpired spent challenges one account remembers (each one is a successful passkey ceremony). */
  SPENT_MAX: 1000,
});

/** Transports a passkey may report (WebAuthn AuthenticatorTransport). Anything else is dropped. */
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal']);

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const nowSeconds = (now = Date.now()) => Math.floor(now / 1000);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** An error answer: { status, body: { error, code, ...extra } }. */
export function fail(status, code, error, extra = {}) {
  return { status, body: { error, code, ...extra } };
}

/** A success answer. */
export function ok(body) {
  return { status: 200, body };
}

function randomB64u(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b64uEncode(b);
}

/** A new account id: 16 random bytes, which is also the WebAuthn user.id. */
export const newAccountId = () => randomB64u(16);
/** A new WebAuthn challenge: 32 random bytes. */
export const newChallenge = () => randomB64u(32);

/** An account id as the server spells it (22 base64url characters for 16 bytes), or null. */
export function accountIdOf(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) return null;
  const b = b64uDecode(value);
  return b && b.length === 16 ? value : null;
}

/**
 * The origin and RP id accounts work with: ACCOUNT_ORIGIN (default
 * https://apaki.myrlin.io) must be a bare origin; its host name is the RP id.
 * Returns null when the var is set to something else, so the routes fail closed.
 */
export function accountConfig(env = {}) {
  const raw = String(env.ACCOUNT_ORIGIN || DEFAULT_ACCOUNT_ORIGIN).trim().replace(/\/$/, '');
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.origin !== raw || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  return { origin: u.origin, rpId: u.hostname, rpName: RP_NAME };
}

/* ===== tokens ===== */

let keyCache = { raw: null, key: null };

/**
 * The HMAC key from ACCOUNT_KEY (base64url of 32 random bytes; trailing "="
 * padding is tolerated), or null when it is missing or malformed, in which
 * case the account routes answer 503 no-key.
 */
export async function loadKey(env = {}) {
  const raw = typeof env.ACCOUNT_KEY === 'string' ? env.ACCOUNT_KEY.trim().replace(/=+$/, '') : '';
  if (!raw) return null;
  if (keyCache.raw === raw) return keyCache.key;
  const bytes = b64uDecode(raw);
  if (!bytes || bytes.length !== 32) return null;
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { raw, key };
  return key;
}

async function mac(key, first) {
  const label = te.encode(TOKEN_LABEL);
  const body = te.encode(first);
  const data = new Uint8Array(label.length + body.length);
  data.set(label, 0);
  data.set(body, label.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** Signs claims into a token. */
export async function signToken(key, claims) {
  const first = b64uEncode(te.encode(JSON.stringify(claims)));
  return `${first}.${b64uEncode(await mac(key, first))}`;
}

const TOKEN_RE = /^([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/;

/**
 * The claims of a token whose MAC is right (compared in constant time, before
 * the JSON is even parsed), or null. Kind and expiry are checked by the
 * callers below.
 */
export async function readToken(key, token) {
  if (typeof token !== 'string' || token.length > LIMITS.TOKEN_MAX) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const given = b64uDecode(m[2]);
  if (!given || given.length !== 32) return null;
  const want = await mac(key, m[1]);
  let d = 0;
  for (let i = 0; i < 32; i++) d |= want[i] ^ given[i];
  if (d !== 0) return null;
  const json = b64uDecode(m[1]);
  if (!json) return null;
  try {
    const claims = JSON.parse(td.decode(json));
    return isPlainObject(claims) ? claims : null;
  } catch { return null; }
}

/** A valid, unexpired challenge token for `purpose`: { p, c, a?, exp }, or null. */
export async function readChallengeToken(key, token, purpose, now = Date.now()) {
  const t = await readToken(key, token);
  if (!t || t.k !== 'c' || t.p !== purpose || !PURPOSES.includes(purpose)) return null;
  if (typeof t.c !== 'string' || !CHALLENGE_RE.test(t.c)) return null;
  if (!Number.isSafeInteger(t.exp) || t.exp <= nowSeconds(now)) return null;
  if (purpose === 'signin') {
    if (t.a !== undefined) return null;
  } else if (!accountIdOf(t.a)) {
    return null;
  }
  return { p: t.p, c: t.c, a: t.a, exp: t.exp };
}

/** A valid, unexpired session token: { a, g, exp }, or null. The generation is checked by the Account object. */
export async function readSessionToken(key, token, now = Date.now()) {
  const t = await readToken(key, token);
  if (!t || t.k !== 's' || !accountIdOf(t.a)) return null;
  if (!Number.isSafeInteger(t.g) || t.g < 0) return null;
  if (!Number.isSafeInteger(t.exp) || t.exp <= nowSeconds(now)) return null;
  return { a: t.a, g: t.g, exp: t.exp };
}

export function challengeClaims(purpose, challenge, accountId, now = Date.now()) {
  const claims = { k: 'c', p: purpose, c: challenge };
  if (accountId) claims.a = accountId;
  claims.exp = nowSeconds(now) + CHALLENGE_TTL_S;
  return claims;
}

export function sessionClaims(accountId, generation, now = Date.now()) {
  return { k: 's', a: accountId, g: generation, exp: nowSeconds(now) + SESSION_TTL_S };
}

/** The bearer token of a request, or null. */
export function bearerOf(request) {
  const m = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') || '');
  return m ? m[1] : null;
}

/* ===== inputs ===== */

/**
 * Bidi controls, zero-width spaces and the BOM: invisible characters that
 * would let a name look like another one (the PC shows "Apaki account (<name>)").
 * ZWJ and ZWNJ stay, emoji and several scripts need them.
 */
const INVISIBLE_RE = /[؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;

/**
 * A display name: NFC, whitespace runs collapsed to one space, trimmed, 1 to
 * 48 characters (code points), no control or invisible formatting characters
 * and no lone surrogates. Returns the clean name or null.
 */
export function cleanName(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  if (/\p{Cs}/u.test(raw)) return null;
  const s = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (/\p{Cc}/u.test(s) || INVISIBLE_RE.test(s)) return null;
  const n = [...s].length;
  return n >= 1 && n <= LIMITS.NAME_MAX ? s : null;
}

/** A base64url string whose bytes fit [min, max], or null (the text length is checked first, so junk costs nothing). */
export function b64uField(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil((max * 4) / 3)) return null;
  const b = b64uDecode(value);
  return b && b.length >= min && b.length <= max ? value : null;
}

/**
 * The fields of a WebAuthn credential the routes use, with their shapes and
 * sizes checked, or null. kind 'create': { id, clientDataJSON,
 * attestationObject, transports }; kind 'get': { id, clientDataJSON,
 * authenticatorData, signature, userHandle } (userHandle is the 16-byte
 * account id). Unknown transports are dropped; anything else extra is ignored.
 */
export function checkCredential(raw, kind) {
  if (!isPlainObject(raw)) return null;
  const id = b64uField(raw.id, 1, MAX_CREDENTIAL_ID);
  const clientDataJSON = b64uField(raw.clientDataJSON, 1, LIMITS.CLIENT_DATA_MAX);
  if (!id || !clientDataJSON) return null;
  if (kind === 'create') {
    const attestationObject = b64uField(raw.attestationObject, 1, LIMITS.ATTESTATION_MAX);
    if (!attestationObject) return null;
    let transports = [];
    if (raw.transports !== undefined) {
      if (!Array.isArray(raw.transports) || raw.transports.length > 8) return null;
      transports = [...new Set(raw.transports.filter((t) => typeof t === 'string' && TRANSPORTS.has(t)))];
    }
    return { id, clientDataJSON, attestationObject, transports };
  }
  const authenticatorData = b64uField(raw.authenticatorData, 37, LIMITS.AUTH_DATA_MAX);
  const signature = b64uField(raw.signature, 1, LIMITS.SIGNATURE_MAX);
  const userHandle = accountIdOf(raw.userHandle);
  if (!authenticatorData || !signature || !userHandle) return null;
  return { id, clientDataJSON, authenticatorData, signature, userHandle };
}

function checkSealed(raw, ctMax) {
  if (!isPlainObject(raw)) return null;
  const iv = b64uField(raw.iv, LIMITS.IV_BYTES, LIMITS.IV_BYTES);
  const ct = b64uField(raw.ct, LIMITS.CT_MIN, ctMax);
  return iv && ct ? { iv, ct } : null;
}

/**
 * The vault of a PUT: { iv, ct, wraps: { <credId>: { iv, ct } } }, with 12-byte
 * ivs, ciphertexts of at least a GCM tag, 1 to MAX_PASSKEYS wraps keyed by
 * canonical credential ids. Returns a clean copy (only those fields) or null.
 * Whether each wrap names a passkey of the account is checked by the Account
 * object, which knows them.
 */
export function checkVault(raw) {
  const sealed = checkSealed(raw, LIMITS.VAULT_BODY_MAX);
  if (!sealed || !isPlainObject(raw.wraps)) return null;
  const entries = Object.entries(raw.wraps);
  if (entries.length < 1 || entries.length > LIMITS.MAX_PASSKEYS) return null;
  const wraps = [];
  for (const [credId, w] of entries) {
    if (!b64uField(credId, 1, MAX_CREDENTIAL_ID)) return null;
    const sw = checkSealed(w, LIMITS.WRAP_CT_MAX);
    if (!sw) return null;
    wraps.push([credId, sw]);
  }
  // fromEntries defines own properties, so even an odd key cannot reach a prototype.
  return { iv: sealed.iv, ct: sealed.ct, wraps: Object.fromEntries(wraps) };
}

/* ===== views ===== */

/**
 * Names for common passkey providers by AAGUID (from the community list at
 * github.com/passkeydeveloper/passkey-authenticator-aaguids). Browsers may
 * send a zero AAGUID with attestation "none"; then the label comes from the
 * transports.
 */
const AAGUID_NAMES = Object.freeze({
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
});

/** The label a passkey is listed under. */
export function passkeyLabel(aaguid, transports = []) {
  if (Object.hasOwn(AAGUID_NAMES, aaguid)) return AAGUID_NAMES[aaguid];
  const removable = transports.some((t) => t === 'usb' || t === 'nfc' || t === 'ble' || t === 'smart-card');
  if (removable && !transports.includes('internal') && !transports.includes('hybrid')) return 'Security key';
  return 'Passkey';
}

/** The stored vault as the routes answer it: { ver, iv, ct, wraps } or null. */
export function vaultView(vault) {
  return vault ? { ver: vault.ver, iv: vault.iv, ct: vault.ct, wraps: { ...vault.wraps } } : null;
}

/** The account as the routes answer it: { id, name, created, ver, passkeys: [{ id, label, created, lastUsed, transports }] }. */
export function accountView(account, vault) {
  return {
    id: account.id,
    name: account.name,
    created: account.created,
    ver: vault ? vault.ver : 0,
    passkeys: account.creds.map((c) => ({ id: c.id, label: c.label, created: c.created, lastUsed: c.lastUsed, transports: [...c.transports] })),
  };
}
