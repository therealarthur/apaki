/**
 * codec.js: pure helpers for the Apaki iOS and Android app (apaki/mobile,
 * 2026-10-10). No Capacitor and no DOM here, so node --test can check every
 * function (apaki/mobile/test/codec.test.js).
 *
 *   b64e(bytes) / b64d(text)        base64url without padding, as protocol.js
 *   encodePc(rec) / decodePc(obj)   a paired PC record <-> JSON for the Keychain
 *   encodeAccount / decodeAccount   the signed-in account <-> JSON for the Keychain
 *   pairingPayloadFrom(url)         the #p=... payload of a pairing link, if it is one
 *   relaySocketAllowed(url)         the one relay the app may open a socket to
 *   siteRequestAllowed(url)         the one API the app may call
 *   hapticStyle(ms)                 navigator.vibrate(ms) -> a native impact style
 *   isDark(color)                   does a CSS colour want light status bar text?
 *   exportNames(source)             the names an ES module exports (build check)
 *
 * Why the records are encoded by hand: the web client keeps them in
 * IndexedDB as structured clones holding CryptoKey objects, which the iOS
 * Keychain cannot store. In the app the phone's own device key is a Secure
 * Enclave key referenced by id (it never leaves the chip), and the keys that
 * must travel (the account device and the vault key, both of which the
 * account's vault already shares between phones) are stored as JWK or raw
 * bytes, inside the Keychain only.
 */

const subtle = globalThis.crypto.subtle;

/** The site and relay this app talks to: one origin, as in the web page's CSP. */
export const SITE = 'https://apaki.myrlin.io';
export const SITE_HOST = 'apaki.myrlin.io';
export const RELAY = 'wss://apaki.myrlin.io';

/* ---------- base64url ---------- */

export function b64e(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64d(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- device identities ---------- */

/**
 * A device identity as JSON. Two kinds:
 *   native  a key held by the app's native side (Secure Enclave on a
 *           device, a Keychain key in the Simulator): only its id and public key
 *   jwk     an extractable WebCrypto key (the Apaki account's device, which
 *           the account's vault holds anyway)
 */
export async function encodeDevice(device) {
  if (!device) return null;
  if (device.keyId) return { kind: 'native', keyId: String(device.keyId), pub: b64e(device.pub), se: Boolean(device.secureEnclave) };
  const key = device.privateKey;
  if (key && key.extractable) {
    const { kty, crv, x, y, d } = await subtle.exportKey('jwk', key);
    return { kind: 'jwk', pub: b64e(device.pub), jwk: { kty, crv, x, y, d } };
  }
  throw new Error('This device key cannot be kept in the keychain: it is not exportable and not a native key.');
}

/**
 * The identity back from JSON. A native key signs through `signerFor(keyId)`
 * (protocol.js PhoneSession calls device.sign(bytes)); a JWK one comes back
 * as an extractable WebCrypto key, so the next save can store it again.
 */
export async function decodeDevice(saved, signerFor = null) {
  if (!saved) return null;
  if (saved.kind === 'native') {
    if (!signerFor) throw new Error('A native device key needs a signer.');
    return { keyId: saved.keyId, pub: b64d(saved.pub), secureEnclave: Boolean(saved.se), sign: signerFor(saved.keyId) };
  }
  if (saved.kind === 'jwk') {
    const { kty, crv, x, y, d } = saved.jwk;
    const privateKey = await subtle.importKey('jwk', { kty, crv, x, y, d, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    return { privateKey, pub: b64d(saved.pub) };
  }
  throw new Error(`Unknown device key kind ${saved.kind}`);
}

/* ---------- PC records (store.js shape) ---------- */

/** { roomId, pcName, relay, pairing, device, pairedAt, lastUsed, via? } -> JSON-safe. */
export async function encodePc(rec) {
  if (!rec?.roomId) throw new Error('A PC record needs a room id.');
  const { device, ...rest } = rec;
  return { ...rest, v: 1, device: await encodeDevice(device) };
}

export async function decodePc(obj, signerFor = null) {
  if (!obj?.roomId) throw new Error('Not a PC record.');
  const { v, device, ...rest } = obj;
  if (v !== 1) throw new Error(`PC record version ${v}`);
  return { ...rest, device: await decodeDevice(device, signerFor) };
}

/* ---------- the account record (store.js 'me') ---------- */

/** The account with its vault key (raw) and account device (JWK) in the clear: only ever written to the Keychain. */
export async function encodeAccount(acct) {
  const { vaultKey, device, ...rest } = acct;
  if (vaultKey && !vaultKey.extractable) throw new Error('The vault key cannot be kept in the keychain: it is not exportable.');
  return {
    ...rest,
    v: 1,
    vaultKey: vaultKey ? b64e(new Uint8Array(await subtle.exportKey('raw', vaultKey))) : null,
    device: await encodeDevice(device),
  };
}

export async function decodeAccount(obj) {
  if (!obj) return null;
  const { v, vaultKey, device, ...rest } = obj;
  if (v !== 1) throw new Error(`account record version ${v}`);
  return {
    ...rest,
    vaultKey: vaultKey ? await subtle.importKey('raw', b64d(vaultKey), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']) : null,
    device: await decodeDevice(device),
  };
}

/* ---------- links and allowlists ---------- */

/**
 * The pairing payload in a link the app was opened with, or null. Accepted:
 * https://apaki.myrlin.io/v/<version>/#p=... (what the PC's QR encodes, as
 * a Universal Link), https://apaki.myrlin.io/#p=... (older QRs), and
 * apaki://pair#p=... (the app's own scheme, for testing). The payload is in
 * the fragment, which never reaches a server.
 */
export function pairingPayloadFrom(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const ours = (u.protocol === 'https:' && u.host === SITE_HOST) || u.protocol === 'apaki:';
  if (!ours) return null;
  const m = /(?:^|&)p=([A-Za-z0-9_-]{40,600})(?:&|$)/.exec(u.hash.replace(/^#/, ''));
  return m ? m[1] : null;
}

/** Room ids are 22 base64url characters (PROTOCOL.md). */
const ROOM_PATH = /^\/v1\/rooms\/[A-Za-z0-9_-]{22}\/phone$/;

/** The app opens sockets only to a phone side of a room on the Apaki relay (the native side checks the same). */
export function relaySocketAllowed(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'wss:' && u.host === SITE_HOST && ROOM_PATH.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}

/** The app calls only the account and presence API on the site (the native side checks the same). */
export function siteRequestAllowed(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.host === SITE_HOST && u.pathname.startsWith('/v1/') && !u.pathname.includes('..') && !u.username && !u.password;
  } catch { return false; }
}

/* ---------- small mappings ---------- */

/** native.js ticks with navigator.vibrate(7 | 11 | 16); the app plays the matching impact instead. */
export function hapticStyle(ms) {
  const n = Array.isArray(ms) ? Number(ms[0]) : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 16) return 'HEAVY';
  if (n >= 11) return 'MEDIUM';
  return 'LIGHT';
}

/** True for a dark colour (#rgb, #rrggbb or rgb()/rgba()), which wants light status bar text. */
export function isDark(color) {
  const s = String(color || '').trim();
  let r; let g; let b;
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
  else if ((m = /^#([0-9a-f]{6})/i.exec(s))) [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  else if ((m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s))) [r, g, b] = m.slice(1, 4).map(Number);
  else return false;
  // Relative luminance (sRGB, WCAG); below the middle is dark.
  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.2;
}

/**
 * The names an ES module exports, read from its source: export function /
 * class / const / let / var NAME and export { a, b as c }. The app build
 * swaps a few web modules for app ones (store.js, scan.js) and checks with
 * this that the app's module still exports everything the web one does, so a
 * new export added to the web client cannot leave the app with a page that
 * fails to load.
 */
export function exportNames(source) {
  const names = new Set();
  const src = String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      names.add(as ? as[1] : t.split(/\s+/)[0]);
    }
  }
  return [...names].sort();
}
