/**
 * protocol.js: the zero-knowledge pairing and transport protocol between
 * Myrlin Apaki on a PC and the Apaki web client on a phone.
 *
 * Arthur, 2026-10-09: "scan this QR code" connects a phone to the Apaki on
 * your PC. The website is only Apaki's UI; the PC does all the work with its
 * own Claude and Codex logins; our servers never see credentials or content.
 * No accounts in v1: the pairing is the identity.
 *
 * Isomorphic ESM with no dependencies: only WebCrypto (globalThis.crypto
 * .subtle), TextEncoder/TextDecoder and URL, so the same file runs in Node 20+
 * (the Apaki engine) and in mobile Safari and Chrome (the web client).
 * P-256 everywhere (ECDH for key agreement, ECDSA for identities) because it
 * is the curve every mobile WebCrypto supports.
 *
 * The full design (frames, key schedule, relay framing, saved state) is in
 * PROTOCOL.md next to this file; the threat model is in relay/README.md.
 * In short:
 *   - The QR is a URL whose FRAGMENT (never sent to any server) carries the
 *     relay, a 128-bit room id, the PC's static public key, a one-time 128-bit
 *     pairing secret and an expiry.
 *   - Pairing: 3 frames. The phone proves it saw the QR (HMAC under the
 *     secret, and the secret is mixed into every key), the PC signs the
 *     transcript with its static key, the phone registers a fresh device key
 *     and signs too. Both sides show the same 6-digit code (SAS, committed so
 *     an attacker who learned the QR cannot steer it) and the PC user
 *     approves. Afterwards both sides hold a per-device secret (psk).
 *   - Reconnect: 3 frames, mutual signatures with the static keys over fresh
 *     ephemeral ECDH (forward secrecy), psk mixed in, device looked up by id
 *     (a revoked device is simply gone, so it cannot connect).
 *   - Records: AES-256-GCM, one key and IV per direction, implicit counters
 *     (a replayed, dropped or reordered frame fails to decrypt), JSON
 *     messages and binary chunks, size limits.
 *
 * This file is transport agnostic: sessions take frames (Uint8Array) in and
 * hand frames out. The engine bridge and the web client move them over the
 * relay (see roomUrl, relaySubprotocols, encodePcFrame/decodePcFrame).
 */

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error('apaki protocol: WebCrypto (crypto.subtle) is not available; a secure context (https) is required');

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const PROTOCOL_VERSION = 1;
/** WebSocket subprotocol every relay client offers (the relay echoes it). */
export const RELAY_SUBPROTOCOL = 'apaki.v1';
/** The PC sends its room token as a second subprotocol: apaki-token.<token>. */
export const RELAY_TOKEN_PREFIX = 'apaki-token.';
/** Where the QR points by default (the static web client). */
export const DEFAULT_WEB = 'https://apaki.myrlin.io/';

export const LIMITS = Object.freeze({
  /** How long a QR stays valid. */
  PAIR_TTL_MS: 120_000,
  /** Phone-side tolerance for its own clock when checking a QR's expiry (the PC's check is the real one). */
  PAIR_CLOCK_SKEW_MS: 120_000,
  /** How long the PC user has to approve after the phone sent its first frame. */
  PAIR_APPROVE_MS: 180_000,
  /** Largest handshake frame either side accepts. */
  MAX_HANDSHAKE_FRAME: 512,
  /** Largest record plaintext (content type byte + body). */
  MAX_RECORD_PLAINTEXT: 128 * 1024,
  /** Largest frame on the wire (record header + plaintext + GCM tag). */
  MAX_FRAME: 1 + 128 * 1024 + 16,
  /** Records per direction per session; a session that reaches it must reconnect (fresh keys). */
  MAX_RECORDS: 2 ** 31 - 1,
  /** UTF-8 bytes of a PC or device name. */
  MAX_NAME_BYTES: 64,
  /** UTF-8 bytes of the relay URL inside a QR. */
  MAX_RELAY_URL_BYTES: 200,
});

/** Largest JSON body (UTF-8 bytes) one record carries. */
export const MAX_JSON_BYTES = LIMITS.MAX_RECORD_PLAINTEXT - 1;
/** Largest data part of one binary chunk. */
export const MAX_CHUNK_BYTES = LIMITS.MAX_RECORD_PLAINTEXT - 10;

/** First byte of every frame. */
export const FRAME = Object.freeze({
  PAIR1: 0x01, PAIR2: 0x02, PAIR3: 0x03,
  HELLO1: 0x11, HELLO2: 0x12, HELLO3: 0x13,
  RECORD: 0x20,
  ALERT: 0x7f,
});

/** First byte of a record's plaintext. */
const CONTENT = Object.freeze({ JSON: 0x01, CHUNK: 0x02, CONTROL: 0x03 });

/** Alert codes (plaintext, unauthenticated: a hint for the UI, never trusted for anything else). */
export const ALERT = Object.freeze({
  'bad-frame': 1,
  version: 2,
  expired: 3,
  used: 4,
  'no-offer': 5,
  'bad-mac': 6,
  'unknown-device': 7,
  'bad-signature': 8,
  rejected: 9,
  timeout: 10,
  closed: 11,
  'bad-record': 12,
  'bad-commit': 13,
  internal: 14,
});
const ALERT_NAME = Object.fromEntries(Object.entries(ALERT).map(([k, v]) => [v, k]));

/** Lengths of the fixed parts. */
const PUB_LEN = 65; // uncompressed P-256 point
const SIG_LEN = 64; // ECDSA P-256 in IEEE P1363 (r || s), what WebCrypto produces
const NONCE_LEN = 16;
const HASH_LEN = 32;
const TAG_LEN = 16;
const ID_LEN = 16;
const ZERO_IV = new Uint8Array(12);

/** Domain separation labels (every hash, MAC, signature and key has its own). */
const L = Object.freeze({
  pairPsk: 'apaki/v1 pair psk',
  pairMac: 'apaki/v1 pair mac',
  commit: 'apaki/v1 pair commit',
  pairTh: 'apaki/v1 pair transcript',
  pairHsPc: 'apaki/v1 pair hs pc',
  pairHsPhone: 'apaki/v1 pair hs phone',
  pairSigPc: 'apaki/v1 pair pc sig',
  pairSigPhone: 'apaki/v1 pair phone sig',
  sas: 'apaki/v1 pair sas',
  devicePsk: 'apaki/v1 device psk',
  helloMac: 'apaki/v1 hello mac',
  helloTh: 'apaki/v1 hello transcript',
  helloHsPc: 'apaki/v1 hello hs pc',
  helloHsPhone: 'apaki/v1 hello hs phone',
  helloSigPc: 'apaki/v1 hello pc sig',
  helloSigPhone: 'apaki/v1 hello phone sig',
  deviceId: 'apaki/v1 device id',
});

/** A protocol failure with a stable code (one of the ALERT names). */
export class ProtocolError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ bytes */

/** Concatenates byte arrays (and strings, as UTF-8). */
export function concat(...parts) {
  const arrs = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p));
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** Cryptographically random bytes. */
export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** base64url without padding. */
export function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url (padding optional); throws ProtocolError('bad-frame') on junk. */
export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(str)) throw new ProtocolError('bad-frame', 'not base64url');
  const s = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  let bin;
  try { bin = atob(s + '==='.slice((s.length + 3) % 4)); } catch { throw new ProtocolError('bad-frame', 'not base64url'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time equality of two byte arrays of public length. */
function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function toBytes(frame) {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  if (ArrayBuffer.isView(frame)) return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  throw new ProtocolError('bad-frame', 'frames are binary');
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function readU32(b, off) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off);
}

function nameBytes(name) {
  const b = te.encode(String(name ?? ''));
  if (b.length > LIMITS.MAX_NAME_BYTES) throw new ProtocolError('bad-frame', `name longer than ${LIMITS.MAX_NAME_BYTES} bytes`);
  return b;
}

function decodeName(b) {
  try { return td.decode(b); } catch { throw new ProtocolError('bad-frame', 'name is not UTF-8'); }
}

/* ----------------------------------------------------------------- crypto */

async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
}

/** HKDF-SHA-256 (extract with salt, expand with info). */
async function hkdf(ikm, salt, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, key, len * 8));
}

async function hmacKey(raw) {
  return subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmacSign(raw, data) {
  return new Uint8Array(await subtle.sign('HMAC', await hmacKey(raw), data));
}

/** HMAC check through WebCrypto (constant time in every engine we target). */
async function hmacVerify(raw, data, mac) {
  return subtle.verify('HMAC', await hmacKey(raw), mac, data);
}

function checkPoint(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== PUB_LEN || raw[0] !== 0x04) throw new ProtocolError('bad-frame', 'not an uncompressed P-256 point');
}

async function ephemeral() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: kp.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) };
}

/** ECDH with a peer's raw public key; importKey rejects points that are not on the curve. */
async function ecdh(privateKey, peerRaw) {
  checkPoint(peerRaw);
  let pub;
  try { pub = await subtle.importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []); } catch { throw new ProtocolError('bad-frame', 'invalid P-256 point'); }
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
}

async function importVerifyKey(raw) {
  checkPoint(raw);
  try { return await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']); } catch { throw new ProtocolError('bad-frame', 'invalid P-256 public key'); }
}

async function sign(privateKey, label, th) {
  return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, concat(label, th)));
}

async function verifySig(pubRaw, sig, label, th) {
  const key = await importVerifyKey(pubRaw);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, concat(label, th));
}

async function aesKey(raw, usage) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

async function aesSeal(key, iv, aad, pt) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, pt));
}

/** AES-GCM decrypt; any failure becomes ProtocolError(code). */
async function aesOpen(key, iv, aad, ct, code) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct));
  } catch {
    throw new ProtocolError(code, 'decryption failed');
  }
}

/** One-shot handshake encryption (each handshake key encrypts exactly one message). */
async function hsSeal(rawKey, aad, pt) {
  return aesSeal(await aesKey(rawKey, 'encrypt'), ZERO_IV, aad, pt);
}

async function hsOpen(rawKey, aad, ct) {
  return aesOpen(await aesKey(rawKey, 'decrypt'), ZERO_IV, aad, ct, 'bad-mac');
}

/* -------------------------------------------------------------- identities */

/**
 * Creates a static identity (ECDSA P-256 key pair). The PC's identity must
 * be extractable so the engine can save it to disk (exportIdentity); a
 * phone's device identity should not be (the browser keeps the private key
 * out of reach of page scripts; store the CryptoKey objects in IndexedDB).
 *
 * @param {{extractable?: boolean}} [o]
 * @returns {Promise<{privateKey: CryptoKey, publicKey: CryptoKey, pub: Uint8Array}>}
 */
export async function createIdentity({ extractable = false } = {}) {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, ['sign', 'verify']);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, pub: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) };
}

/** The PC's identity: extractable so it can be saved. */
export const createPcIdentity = () => createIdentity({ extractable: true });

/** A phone's device identity: non-extractable unless asked (tests, Node clients). */
export const createDeviceIdentity = ({ extractable = false } = {}) => createIdentity({ extractable });

/** Saves an extractable identity as JSON-safe data. Keep the result secret (it holds the private key). */
export async function exportIdentity(identity) {
  const jwk = await subtle.exportKey('jwk', identity.privateKey);
  return { v: PROTOCOL_VERSION, kind: 'apaki-identity', pub: b64urlEncode(identity.pub), jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** Restores an identity saved by exportIdentity (the private key comes back extractable so it can be saved again). */
export async function importIdentity(saved) {
  if (!saved || saved.kind !== 'apaki-identity' || !saved.jwk) throw new ProtocolError('bad-frame', 'not an apaki identity');
  const { kty, crv, x, y, d } = saved.jwk;
  const privateKey = await subtle.importKey('jwk', { kty, crv, x, y, d, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicKey = await subtle.importKey('jwk', { kty, crv, x, y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', publicKey));
  if (saved.pub && saved.pub !== b64urlEncode(pub)) throw new ProtocolError('bad-frame', 'identity public key does not match its private key');
  return { privateKey, publicKey, pub };
}

/** A device's id: the first 16 bytes of SHA-256 over its public key, base64url (22 chars). */
export async function deviceIdFor(pub) {
  const raw = typeof pub === 'string' ? b64urlDecode(pub) : pub;
  return b64urlEncode((await sha256(L.deviceId, raw)).subarray(0, ID_LEN));
}

/* ------------------------------------------------------------------- rooms */

/** A fresh room token (256 bits, base64url, 43 chars). Only the PC holds it; it is never in the QR. */
export const createRoomToken = () => b64urlEncode(randomBytes(32));

const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The room id that belongs to a room token: the first 128 bits of
 * SHA-256("apaki/v1 room" || token bytes), base64url (22 chars).
 *
 * Binding the id to the token is what stops room squatting: the relay
 * recomputes this hash and only lets a socket that presents the token claim
 * the PC side of the room, without storing anything. Phones only ever learn
 * the id (from the QR), never the token, so they cannot pose as the PC to
 * the relay (and could not decrypt anything if they did).
 */
export async function roomIdForToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ProtocolError('bad-frame', 'room token must be 43 base64url chars');
  return b64urlEncode((await sha256('apaki/v1 room', b64urlDecode(token))).subarray(0, 16));
}

/** A fresh room for a PC: { roomId, token }. Save both with the PC identity (the token is a secret). */
export async function createRoom() {
  const token = createRoomToken();
  return { roomId: await roomIdForToken(token), token };
}

function roomBytes(roomId) {
  if (typeof roomId !== 'string' || !ROOM_RE.test(roomId)) throw new ProtocolError('bad-frame', 'room id must be 22 base64url chars');
  return b64urlDecode(roomId);
}

/**
 * Checks a relay base URL: wss:// for anything real; ws:// only for a
 * loopback host (local relay in tests and development).
 */
export function checkRelayUrl(relay) {
  let u;
  try { u = new URL(relay); } catch { throw new ProtocolError('bad-frame', 'relay is not a URL'); }
  const loop = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'wss:' || (u.protocol === 'ws:' && loop))) throw new ProtocolError('bad-frame', 'relay must be wss:// (ws:// only on loopback)');
  if (u.username || u.password || u.search || u.hash) throw new ProtocolError('bad-frame', 'relay URL must not carry credentials, a query or a fragment');
  if (te.encode(relay).length > LIMITS.MAX_RELAY_URL_BYTES) throw new ProtocolError('bad-frame', 'relay URL too long');
  return relay.replace(/\/+$/, '');
}

/**
 * The WebSocket URL of one side of a room:
 *   <relay>/v1/rooms/<roomId>/pc     the PC (one per room; needs the room token)
 *   <relay>/v1/rooms/<roomId>/phone  a phone (up to the relay's limit)
 */
export function roomUrl(relay, roomId, role) {
  if (role !== 'pc' && role !== 'phone') throw new Error('role must be pc or phone');
  roomBytes(roomId);
  return `${checkRelayUrl(relay)}/v1/rooms/${roomId}/${role}`;
}

/** The WebSocket subprotocols to offer: the PC adds its room token (headers are not available to browsers, URLs get logged). */
export function relaySubprotocols(role, token) {
  if (role === 'pc') {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error('pc needs its room token');
    return [RELAY_SUBPROTOCOL, RELAY_TOKEN_PREFIX + token];
  }
  return [RELAY_SUBPROTOCOL];
}

/**
 * Close codes the relay uses (CloseEvent.code), so clients can tell the user
 * what happened. 1000-1015 are the standard ones.
 */
export const RELAY_CLOSE = Object.freeze({
  /** The PC side was taken over by a newer PC connection with the same token (a restart). */
  REPLACED: 4000,
  /** The PC asked the relay to drop this phone connection (for example a removed device). */
  KICKED: 4003,
  /** Too many frames or bytes per second. */
  RATE: 4008,
  /** A frame larger than the relay's limit. */
  TOO_LARGE: 4009,
  /** The room already has its maximum number of phone connections. */
  ROOM_FULL: 4029,
  /** Nothing (not even a ping) for the relay's idle timeout. */
  IDLE: 4408,
  /** The relay reached its daily budget; it takes connections again after 00:00 UTC. */
  BUDGET: 4503,
  /** A phone in a room whose PC is not connected (2026-10-10): wait, then try again; nothing is wrong. */
  NO_PC: 4404,
  /** This address used its share of the relay's day (2026-10-10): try again after 00:00 UTC. */
  IP_SHARE: 4504,
  /** This room used its share of the relay's day (2026-10-10): try again after 00:00 UTC. */
  ROOM_SHARE: 4505,
});

/** PC side of the relay: every binary frame carries the phone connection id (u32) in front. */
export function encodePcFrame(connId, payload) {
  const p = toBytes(payload);
  const out = new Uint8Array(4 + p.length);
  new DataView(out.buffer).setUint32(0, connId >>> 0);
  out.set(p, 4);
  return out;
}

/** Splits a frame the PC received from the relay into { connId, payload }. */
export function decodePcFrame(frame) {
  const b = toBytes(frame);
  if (b.length < 4) throw new ProtocolError('bad-frame', 'relay frame too short');
  return { connId: readU32(b, 0), payload: b.subarray(4) };
}

/**
 * Parses a relay control message (a text frame). Returns null for anything
 * that is not one. The relay sends:
 *   to the PC:    { t: 'ready', role: 'pc', phones: [connId...], limits }
 *                 { t: 'join', conn }   a phone connected (expect its PAIR1 or HELLO1)
 *                 { t: 'leave', conn }  a phone went away (or a frame named a conn that is gone)
 *   to a phone:   { t: 'ready', role: 'phone', conn, pc: boolean, limits }
 *                 { t: 'pc', up: true|false }  the PC (re)connected or left; on up, start a new handshake
 *   to anyone:    { t: 'bye', code, reason }  the relay is closing this socket (code = RELAY_CLOSE.*); close it
 *                 'pong' (parsed as { t: 'pong' })  the answer to 'ping'
 * limits = { maxFrame, maxPhones, framesPerSec, bytesPerSec, idleMs }.
 * The PC may send { t: 'kick', conn } to drop a phone connection.
 * Every client sends 'ping' right after open and then at least every 30 s
 * (answered by the relay runtime without waking the room).
 */
export function parseRelayControl(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  if (text === 'pong') return { t: 'pong' };
  try {
    const m = JSON.parse(text);
    return m && typeof m.t === 'string' ? m : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ offers */

/**
 * The binary QR payload (version 1), base64url in the URL fragment:
 *   v(1) exp(u32 seconds) roomId(16) secret(16) pcPub(65)
 *   relayLen(1) relay(utf8) nameLen(1) name(utf8)
 */
export function encodePairingPayload(offer) {
  const relay = te.encode(checkRelayUrl(offer.relay));
  const name = nameBytes(offer.name);
  const pcPub = b64urlDecode(offer.pcPub);
  checkPoint(pcPub);
  const secret = b64urlDecode(offer.secret);
  if (secret.length !== 16) throw new ProtocolError('bad-frame', 'pairing secret must be 16 bytes');
  return b64urlEncode(concat(new Uint8Array([PROTOCOL_VERSION]), u32(offer.exp), roomBytes(offer.roomId), secret, pcPub,
    new Uint8Array([relay.length]), relay, new Uint8Array([name.length]), name));
}

/** Reads a QR payload back into an offer { v, relay, roomId, pcPub, secret, exp, name }. */
export function decodePairingPayload(payload) {
  const b = b64urlDecode(payload);
  if (b.length < 1 + 4 + 16 + 16 + PUB_LEN + 2) throw new ProtocolError('bad-frame', 'pairing payload too short');
  if (b[0] !== PROTOCOL_VERSION) throw new ProtocolError('version', `pairing payload version ${b[0]}`);
  let o = 1;
  const exp = readU32(b, o); o += 4;
  const roomId = b64urlEncode(b.subarray(o, o + 16)); o += 16;
  const secret = b64urlEncode(b.subarray(o, o + 16)); o += 16;
  const pcPubRaw = b.subarray(o, o + PUB_LEN); o += PUB_LEN;
  checkPoint(pcPubRaw);
  const rl = b[o++];
  if (o + rl + 1 > b.length) throw new ProtocolError('bad-frame', 'pairing payload truncated');
  const relay = checkRelayUrl(decodeName(b.subarray(o, o + rl))); o += rl;
  const nl = b[o++];
  if (o + nl !== b.length) throw new ProtocolError('bad-frame', 'pairing payload has the wrong length');
  const name = decodeName(b.subarray(o, o + nl));
  if (nl > LIMITS.MAX_NAME_BYTES) throw new ProtocolError('bad-frame', 'name too long');
  return { v: PROTOCOL_VERSION, relay, roomId, pcPub: b64urlEncode(pcPubRaw), secret, exp, name };
}

/** The QR URL: <web>#p=<payload>. The fragment never leaves the phone. */
export function pairingUrl(web, payload) {
  const base = String(web || DEFAULT_WEB).split('#')[0];
  return `${base}#p=${payload}`;
}

/**
 * Reads an offer from a scanned URL (or its fragment). The web client should
 * call history.replaceState right after, so the secret leaves the address bar.
 */
export function parsePairingUrl(url) {
  const s = String(url);
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
  const m = /(?:^|&)p=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) throw new ProtocolError('bad-frame', 'no pairing payload in this URL');
  return decodePairingPayload(m[1]);
}

/**
 * PC side: a fresh one-time pairing offer for the QR. Keep the returned
 * object in memory only (it holds the secret) and hand it to PcSession via
 * getOffer; the session marks it used on the first valid attempt.
 *
 * @param {object} o
 * @param {{pub: Uint8Array}} o.identity  the PC identity
 * @param {string} o.relay  relay base URL (wss://...)
 * @param {string} o.roomId  the PC's room
 * @param {string} [o.name]  shown on the phone (for example the PC's name)
 * @param {number} [o.ttlMs]
 * @param {string} [o.web]  web client URL the QR opens
 * @param {number} [o.now]
 */
export function createPairingOffer({ identity, relay, roomId, name = '', ttlMs = LIMITS.PAIR_TTL_MS, web = DEFAULT_WEB, now = Date.now() }) {
  const offer = {
    v: PROTOCOL_VERSION,
    relay: checkRelayUrl(relay),
    roomId,
    pcPub: b64urlEncode(identity.pub),
    secret: b64urlEncode(randomBytes(16)),
    exp: Math.floor((now + ttlMs) / 1000),
    name: String(name ?? ''),
  };
  const payload = encodePairingPayload(offer);
  return { ...offer, used: false, payload, url: pairingUrl(web, payload) };
}

/* ------------------------------------------------------------------ frames */

/** A plaintext alert frame. */
export function encodeAlert(code) {
  return new Uint8Array([FRAME.ALERT, ALERT[code] ?? ALERT.internal]);
}

/** The alert name in an alert frame, or null if the frame is not an alert. */
export function decodeAlert(frame) {
  const b = toBytes(frame);
  if (b[0] !== FRAME.ALERT || b.length !== 2) return null;
  return ALERT_NAME[b[1]] || 'internal';
}

/** The frame type name of a frame (for logs). */
export function frameType(frame) {
  const b = toBytes(frame);
  const hit = Object.entries(FRAME).find(([, v]) => v === b[0]);
  return hit ? hit[0].toLowerCase() : 'unknown';
}

/* ---------------------------------------------------------------- records */

/**
 * The encrypted channel after a handshake: AES-256-GCM with one key and one
 * IV per direction. The nonce is the IV XOR the record counter (TLS 1.3
 * style); counters are implicit and strict, so a replayed, dropped or
 * reordered frame fails to decrypt and the channel is dead.
 */
class Channel {
  constructor({ sendKey, sendIv, recvKey, recvIv, sessionId }) {
    this.sendKey = sendKey;
    this.sendIv = sendIv;
    this.recvKey = recvKey;
    this.recvIv = recvIv;
    this.sessionId = sessionId;
    this.sendCtr = 0;
    this.recvCtr = 0;
  }

  static nonce(iv, ctr) {
    const n = iv.slice();
    n[8] ^= (ctr >>> 24) & 0xff;
    n[9] ^= (ctr >>> 16) & 0xff;
    n[10] ^= (ctr >>> 8) & 0xff;
    n[11] ^= ctr & 0xff;
    return n;
  }

  async seal(plaintext) {
    if (plaintext.length > LIMITS.MAX_RECORD_PLAINTEXT) throw new ProtocolError('bad-record', 'record too large');
    if (this.sendCtr >= LIMITS.MAX_RECORDS) throw new ProtocolError('bad-record', 'record limit reached; reconnect');
    const ctr = this.sendCtr++;
    const header = new Uint8Array([FRAME.RECORD]);
    return concat(header, await aesSeal(this.sendKey, Channel.nonce(this.sendIv, ctr), header, plaintext));
  }

  async open(frame) {
    if (frame.length > LIMITS.MAX_FRAME || frame.length < 1 + 1 + TAG_LEN) throw new ProtocolError('bad-record', 'record size out of range');
    if (this.recvCtr >= LIMITS.MAX_RECORDS) throw new ProtocolError('bad-record', 'record limit reached; reconnect');
    const header = frame.subarray(0, 1);
    const pt = await aesOpen(this.recvKey, Channel.nonce(this.recvIv, this.recvCtr), header, frame.subarray(1), 'bad-record');
    this.recvCtr++;
    return pt;
  }
}

/** Derives the traffic channel from the handshake secret and the final transcript hash. */
async function deriveChannel(ikm, thFinal, kind, role) {
  const base = `apaki/v1 ${kind} traffic`;
  const [kPc, ivPc, kPhone, ivPhone, sid] = await Promise.all([
    hkdf(ikm, thFinal, `${base} pc key`, 32),
    hkdf(ikm, thFinal, `${base} pc iv`, 12),
    hkdf(ikm, thFinal, `${base} phone key`, 32),
    hkdf(ikm, thFinal, `${base} phone iv`, 12),
    hkdf(ikm, thFinal, `${base} session id`, 16),
  ]);
  const pc = role === 'pc';
  return new Channel({
    sendKey: await aesKey(pc ? kPc : kPhone, 'encrypt'),
    sendIv: pc ? ivPc : ivPhone,
    recvKey: await aesKey(pc ? kPhone : kPc, 'decrypt'),
    recvIv: pc ? ivPhone : ivPc,
    sessionId: b64urlEncode(sid),
  });
}

/** The 6-digit short authentication string both screens show. */
async function computeSas(th2, nPhone) {
  const b = await hkdf(nPhone, th2, L.sas, 4);
  return String(readU32(b, 0) % 1_000_000).padStart(6, '0');
}

function wipe(...arrs) {
  for (const a of arrs) if (a instanceof Uint8Array) a.fill(0);
}

/* --------------------------------------------------------------- sessions */

/**
 * What a session hands back from receive(), approve() and reject():
 *   send:   frames to write to the peer, in order
 *   events: what happened, in order. Types:
 *     { type: 'pair-request', sas, device: { id, name, pub } }  (PC: show the SAS, then approve() or reject())
 *     { type: 'sas', sas }                                      (phone: show the SAS while the PC user compares)
 *     { type: 'paired', device }   (PC: save device)  /  { type: 'paired', pairing }  (phone: save pairing)
 *     { type: 'open', device? }    the channel is ready (reconnect)
 *     { type: 'json', value }      a JSON message
 *     { type: 'chunk', stream, seq, last, data }  a binary chunk
 *     { type: 'close', reason }    the peer closed the channel (authenticated)
 *     { type: 'alert', code }      the peer sent a plaintext alert (unauthenticated hint)
 *     { type: 'error', code, message }  this side rejected a frame; the session is closed
 * @typedef {{send: Uint8Array[], events: object[]}} Step
 */

class BaseSession {
  constructor(now) {
    this.now = now || (() => Date.now());
    this.state = 'new';
    this.channel = null;
    this._recvQ = Promise.resolve();
    this._sendQ = Promise.resolve();
  }

  /** True while JSON and chunks can flow. */
  get isOpen() { return this.state === 'open'; }

  /** The channel's session id (differs on every connection; useful in logs). */
  get sessionId() { return this.channel?.sessionId ?? null; }

  /**
   * Feeds one frame from the peer. Frames are processed strictly in order,
   * even if receive() is called again before the previous call settled.
   * Never throws for a bad frame: it closes the session and returns an
   * 'error' event plus an alert frame to send.
   * @returns {Promise<Step>}
   */
  receive(frame) {
    const run = this._recvQ.then(() => this._guard(() => this._receive(toBytes(frame))));
    this._recvQ = run.catch(() => {});
    return run;
  }

  /** Encrypts one JSON message; resolves to the frame to send. Calls resolve in call order. */
  sendJson(value) {
    return this.sendJsonText(JSON.stringify(value));
  }

  /**
   * Like sendJson, for a message that is already JSON text (wire.js builds
   * event batches as text, so it saves a parse and a stringify). The peer
   * parses it and closes the session if it is not JSON.
   */
  sendJsonText(text) {
    const body = te.encode(String(text));
    if (body.length > MAX_JSON_BYTES) return Promise.reject(new ProtocolError('bad-record', `JSON message larger than ${MAX_JSON_BYTES} bytes`));
    return this._seal(concat(new Uint8Array([CONTENT.JSON]), body));
  }

  /**
   * Encrypts one binary chunk: stream (u32) and seq (u32) say where it
   * belongs, last marks the end of a stream; data is at most MAX_CHUNK_BYTES.
   */
  sendChunk({ stream, seq, last = false, data }) {
    const d = toBytes(data);
    if (d.length > MAX_CHUNK_BYTES) return Promise.reject(new ProtocolError('bad-record', `chunk larger than ${MAX_CHUNK_BYTES} bytes`));
    return this._seal(concat(new Uint8Array([CONTENT.CHUNK]), u32(stream), u32(seq), new Uint8Array([last ? 1 : 0]), d));
  }

  /**
   * Closes the session. With an open channel the close is encrypted (the
   * peer can trust it); otherwise it is a plaintext alert. Resolves to the
   * frame to send.
   */
  async close(reason = 'closed') {
    if (this.state === 'open') {
      const frame = await this._seal(concat(new Uint8Array([CONTENT.CONTROL]), te.encode(JSON.stringify({ t: 'close', reason: String(reason).slice(0, 200) }))));
      this.state = 'closed';
      return frame;
    }
    this.state = 'closed';
    return encodeAlert('closed');
  }

  _seal(plaintext, { allowPending = false } = {}) {
    const run = this._sendQ.then(() => {
      if (!this.channel || !(this.state === 'open' || allowPending)) throw new ProtocolError('closed', 'the channel is not open');
      return this.channel.seal(plaintext);
    });
    this._sendQ = run.catch(() => {});
    return run;
  }

  async _guard(fn) {
    if (this.state === 'closed') return { send: [], events: [] };
    try {
      return await fn();
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : 'internal';
      this.state = 'closed';
      this._drop();
      return { send: [encodeAlert(code)], events: [{ type: 'error', code, message: e?.message || String(e) }] };
    }
  }

  _drop() { this._hs = null; }

  /** An alert from the peer closes the session; never answer an alert with an alert. */
  _alert(frame) {
    this.state = 'closed';
    this._drop();
    return { send: [], events: [{ type: 'alert', code: decodeAlert(frame) || 'bad-frame' }] };
  }

  /** Decrypts a record and turns it into events. */
  async _record(frame) {
    const pt = await this.channel.open(frame);
    const kind = pt[0];
    const body = pt.subarray(1);
    if (kind === CONTENT.JSON) {
      let value;
      try { value = JSON.parse(td.decode(body)); } catch { throw new ProtocolError('bad-record', 'JSON record does not parse'); }
      return { type: 'json', value };
    }
    if (kind === CONTENT.CHUNK) {
      if (body.length < 9) throw new ProtocolError('bad-record', 'chunk header too short');
      return { type: 'chunk', stream: readU32(body, 0), seq: readU32(body, 4), last: (body[8] & 1) === 1, data: body.slice(9) };
    }
    if (kind === CONTENT.CONTROL) {
      let value;
      try { value = JSON.parse(td.decode(body)); } catch { throw new ProtocolError('bad-record', 'control record does not parse'); }
      return { type: 'control', value };
    }
    throw new ProtocolError('bad-record', `unknown content type ${kind}`);
  }

  /** Records on an open channel. */
  async _openRecord(frame) {
    const ev = await this._record(frame);
    if (ev.type !== 'control') return { send: [], events: [ev] };
    if (ev.value?.t === 'close') {
      this.state = 'closed';
      return { send: [], events: [{ type: 'close', reason: String(ev.value.reason ?? 'closed') }] };
    }
    throw new ProtocolError('bad-record', 'unexpected control record');
  }
}

function expectLen(frame, min, max = min) {
  if (frame.length < min || frame.length > max) throw new ProtocolError('bad-frame', `frame length ${frame.length} outside ${min}..${max}`);
}

/**
 * The PC side of one phone connection (one per relay connection id).
 *
 * @param {object} o
 * @param {{privateKey: CryptoKey, pub: Uint8Array}} o.identity  the PC's static identity
 * @param {string} o.roomId  the PC's room
 * @param {() => object|null} [o.getOffer]  the current pairing offer (createPairingOffer), or null when no QR is shown
 * @param {(id: string) => (object|null|Promise<object|null>)} [o.getDevice]  a paired device record { id, pub, psk, name, pairedAt } or null (unknown or revoked)
 * @param {() => number} [o.now]
 */
export class PcSession extends BaseSession {
  constructor({ identity, roomId, getOffer = () => null, getDevice = () => null, now }) {
    super(now);
    this.identity = identity;
    this.roomId = roomId;
    this.room = roomBytes(roomId);
    this.getOffer = getOffer;
    this.getDevice = getDevice;
    /** The device on the other end once open (or pending approval). */
    this.device = null;
    /** The SAS while a pairing waits for approval. */
    this.sas = null;
    this._hs = null;
  }

  async _receive(frame) {
    if (frame.length === 0) throw new ProtocolError('bad-frame', 'empty frame');
    const type = frame[0];
    if (type === FRAME.ALERT) return this._alert(frame);
    if (this.state === 'open' && type === FRAME.RECORD) return this._openRecord(frame);
    if (frame.length > LIMITS.MAX_HANDSHAKE_FRAME) throw new ProtocolError('bad-frame', 'handshake frame too large');
    if (this.state === 'new' && type === FRAME.PAIR1) return this._pair1(frame);
    if (this.state === 'new' && type === FRAME.HELLO1) return this._hello1(frame);
    if (this.state === 'pair-wait3' && type === FRAME.PAIR3) return this._pair3(frame);
    if (this.state === 'hello-wait3' && type === FRAME.HELLO3) return this._hello3(frame);
    throw new ProtocolError('bad-frame', `unexpected ${frameType(frame)} frame in state ${this.state}`);
  }

  /* pairing */

  async _pair1(frame) {
    expectLen(frame, 1 + PUB_LEN + HASH_LEN + HASH_LEN);
    const offer = this.getOffer();
    if (!offer || offer.roomId !== this.roomId) throw new ProtocolError('no-offer', 'no pairing offer is active');
    if (this.now() > offer.exp * 1000) throw new ProtocolError('expired', 'the pairing QR expired');
    if (offer.used) throw new ProtocolError('used', 'the pairing QR was already used');
    const secret = b64urlDecode(offer.secret);
    const body = frame.subarray(0, 1 + PUB_LEN + HASH_LEN);
    const mac = frame.subarray(1 + PUB_LEN + HASH_LEN);
    const macKey = await hkdf(secret, this.room, L.pairMac, 32);
    if (!(await hmacVerify(macKey, body, mac))) throw new ProtocolError('bad-mac', 'the phone does not hold this QR\'s secret');
    // Check again after the awaits: two connections can race through the
    // checks above with the same QR, and only the first may spend it. The
    // check and the mark run in one synchronous step, so exactly one wins.
    if (offer.used) throw new ProtocolError('used', 'the pairing QR was already used');
    // Valid proof of the QR: the offer is spent now, whatever happens next.
    offer.used = true;
    const ePhone = frame.slice(1, 1 + PUB_LEN);
    const commit = frame.slice(1 + PUB_LEN, 1 + PUB_LEN + HASH_LEN);
    const psk = await hkdf(secret, this.room, L.pairPsk, 32);
    const eph = await ephemeral();
    const nPc = randomBytes(NONCE_LEN);
    const dh = await ecdh(eph.privateKey, ePhone);
    const th2 = await sha256(L.pairTh, this.room, this.identity.pub, frame, eph.pub, nPc);
    const ikm = concat(dh, psk);
    const [khPc, khPhone] = await Promise.all([hkdf(ikm, th2, L.pairHsPc, 32), hkdf(ikm, th2, L.pairHsPhone, 32)]);
    const sig = await sign(this.identity.privateKey, L.pairSigPc, th2);
    const header = concat(new Uint8Array([FRAME.PAIR2]), eph.pub, nPc);
    const frame2 = concat(header, await hsSeal(khPc, header, sig));
    wipe(dh, psk, khPc);
    this._hs = { offer, ePhone, commit, ikm, th2, frame2, khPhone, startedAt: this.now() };
    this.state = 'pair-wait3';
    return { send: [frame2], events: [] };
  }

  async _pair3(frame) {
    const fixed = NONCE_LEN + PUB_LEN + SIG_LEN + 1;
    expectLen(frame, 1 + fixed + TAG_LEN, 1 + fixed + LIMITS.MAX_NAME_BYTES + TAG_LEN);
    const hs = this._hs;
    const pt = await hsOpen(hs.khPhone, frame.subarray(0, 1), frame.subarray(1));
    let o = 0;
    const nPhone = pt.slice(o, o += NONCE_LEN);
    const devPub = pt.slice(o, o += PUB_LEN);
    const sigPhone = pt.slice(o, o += SIG_LEN);
    const nl = pt[o++];
    if (o + nl !== pt.length) throw new ProtocolError('bad-frame', 'pair3 has the wrong length');
    const nameRaw = pt.slice(o, o + nl);
    const name = decodeName(nameRaw);
    if (!ctEqual(await sha256(L.commit, nPhone, hs.ePhone), hs.commit)) throw new ProtocolError('bad-commit', 'the phone\'s nonce does not match its commitment');
    const th3 = await sha256(hs.th2, hs.frame2, nPhone, devPub, nameRaw);
    if (!(await verifySig(devPub, sigPhone, L.pairSigPhone, th3))) throw new ProtocolError('bad-signature', 'the device signature is invalid');
    const sas = await computeSas(hs.th2, nPhone);
    const thFinal = await sha256(th3, sigPhone);
    this.channel = await deriveChannel(hs.ikm, thFinal, 'pair', 'pc');
    const devicePsk = await hkdf(hs.ikm, thFinal, L.devicePsk, 32);
    const id = await deviceIdFor(devPub);
    wipe(hs.ikm, hs.khPhone);
    this.device = { id, pub: b64urlEncode(devPub), psk: b64urlEncode(devicePsk), name, pairedAt: new Date(this.now()).toISOString() };
    wipe(devicePsk);
    this.sas = sas;
    this._hs = { offer: hs.offer, startedAt: hs.startedAt };
    this.state = 'pair-approval';
    return { send: [], events: [{ type: 'pair-request', sas, device: { id, name, pub: this.device.pub } }] };
  }

  /**
   * The PC user confirmed the phone shows the same code. Sends the
   * encrypted acceptance and opens the channel. Save result.device (it holds
   * the device's psk: keep it with the PC identity, private).
   * @returns {Promise<Step & {device: object}>}
   */
  async approve() {
    if (this.state !== 'pair-approval') throw new Error(`approve() in state ${this.state}`);
    if (this.now() - this._hs.startedAt > LIMITS.PAIR_APPROVE_MS) {
      this.state = 'closed';
      return { send: [encodeAlert('timeout')], events: [{ type: 'error', code: 'timeout', message: 'approval came too late' }], device: null };
    }
    const accept = { t: 'paired', deviceId: this.device.id, pcName: this._hs.offer.name || '' };
    const frame = await this._seal(concat(new Uint8Array([CONTENT.CONTROL]), te.encode(JSON.stringify(accept))), { allowPending: true });
    this.state = 'open';
    this._hs = null;
    this.sas = null;
    return { send: [frame], events: [{ type: 'paired', device: this.device }], device: this.device };
  }

  /** The PC user said no (codes differ, or not their phone). Nothing is stored. */
  async reject() {
    if (this.state !== 'pair-approval') throw new Error(`reject() in state ${this.state}`);
    this.state = 'closed';
    this.channel = null;
    this.device = null;
    this._hs = null;
    return { send: [encodeAlert('rejected')], events: [] };
  }

  /* reconnect */

  async _hello1(frame) {
    expectLen(frame, 1 + ID_LEN + PUB_LEN + NONCE_LEN + HASH_LEN);
    const id = b64urlEncode(frame.subarray(1, 1 + ID_LEN));
    const rec = await this.getDevice(id);
    if (!rec) throw new ProtocolError('unknown-device', 'this device is not paired (or was removed)');
    const psk = b64urlDecode(rec.psk);
    const devPub = b64urlDecode(rec.pub);
    const bodyLen = 1 + ID_LEN + PUB_LEN + NONCE_LEN;
    const macKey = await hkdf(psk, this.room, L.helloMac, 32);
    if (!(await hmacVerify(macKey, frame.subarray(0, bodyLen), frame.subarray(bodyLen)))) throw new ProtocolError('bad-mac', 'hello MAC does not verify');
    const ePhone = frame.slice(1 + ID_LEN, 1 + ID_LEN + PUB_LEN);
    const eph = await ephemeral();
    const nPc = randomBytes(NONCE_LEN);
    const dh = await ecdh(eph.privateKey, ePhone);
    const th2 = await sha256(L.helloTh, this.room, this.identity.pub, devPub, frame, eph.pub, nPc);
    const ikm = concat(dh, psk);
    const [khPc, khPhone] = await Promise.all([hkdf(ikm, th2, L.helloHsPc, 32), hkdf(ikm, th2, L.helloHsPhone, 32)]);
    const sig = await sign(this.identity.privateKey, L.helloSigPc, th2);
    const header = concat(new Uint8Array([FRAME.HELLO2]), eph.pub, nPc);
    const frame2 = concat(header, await hsSeal(khPc, header, sig));
    wipe(dh, psk, khPc);
    this._hs = { id, devPub, ikm, th2, frame2, khPhone };
    this.state = 'hello-wait3';
    return { send: [frame2], events: [] };
  }

  async _hello3(frame) {
    expectLen(frame, 1 + SIG_LEN + TAG_LEN);
    const hs = this._hs;
    const sigPhone = await hsOpen(hs.khPhone, frame.subarray(0, 1), frame.subarray(1));
    const th3 = await sha256(hs.th2, hs.frame2);
    if (!(await verifySig(hs.devPub, sigPhone, L.helloSigPhone, th3))) throw new ProtocolError('bad-signature', 'the device signature is invalid');
    // Revoked while the handshake was in flight?
    const rec = await this.getDevice(hs.id);
    if (!rec || rec.pub !== b64urlEncode(hs.devPub)) throw new ProtocolError('unknown-device', 'this device was removed');
    this.channel = await deriveChannel(hs.ikm, await sha256(th3, sigPhone), 'hello', 'pc');
    wipe(hs.ikm, hs.khPhone);
    this._hs = null;
    this.device = rec;
    this.state = 'open';
    return { send: [], events: [{ type: 'open', device: rec }] };
  }
}

/**
 * The phone side. Pairing: new PhoneSession({ device, offer, name }).
 * Reconnect: new PhoneSession({ device, pairing }). Then start() gives the
 * first frame; feed every frame from the PC to receive().
 *
 * @param {object} o
 * @param {{privateKey: CryptoKey, pub: Uint8Array}} o.device  this phone's device identity
 * @param {object} [o.offer]  from parsePairingUrl (pairing)
 * @param {object} [o.pairing]  the record saved after pairing (reconnect)
 * @param {string} [o.name]  this device's name, shown on the PC during pairing
 * @param {() => number} [o.now]
 */
export class PhoneSession extends BaseSession {
  constructor({ device, offer = null, pairing = null, name = '', now }) {
    super(now);
    if (!device?.privateKey || !device?.pub) throw new Error('PhoneSession needs a device identity');
    if (!offer === !pairing) throw new Error('PhoneSession needs either an offer (pairing) or a pairing (reconnect)');
    this.device = device;
    this.offer = offer;
    this.pairing = pairing;
    this.name = name;
    this.nameRaw = nameBytes(name);
    this.mode = offer ? 'pair' : 'hello';
    this.room = roomBytes((offer || pairing).roomId);
    this.pcPub = b64urlDecode((offer || pairing).pcPub);
    checkPoint(this.pcPub);
    /** The SAS once the PC answered (pairing). */
    this.sas = null;
    this._hs = null;
  }

  /** The first frame to send. */
  async start() {
    if (this.state !== 'new') throw new Error('start() was already called');
    return this.mode === 'pair' ? this._startPair() : this._startHello();
  }

  async _startPair() {
    const offer = this.offer;
    if (this.now() > offer.exp * 1000 + LIMITS.PAIR_CLOCK_SKEW_MS) throw new ProtocolError('expired', 'this pairing QR expired; show a new one on the PC');
    const secret = b64urlDecode(offer.secret);
    const eph = await ephemeral();
    const nPhone = randomBytes(NONCE_LEN);
    const commit = await sha256(L.commit, nPhone, eph.pub);
    const body = concat(new Uint8Array([FRAME.PAIR1]), eph.pub, commit);
    const macKey = await hkdf(secret, this.room, L.pairMac, 32);
    const frame1 = concat(body, await hmacSign(macKey, body));
    const psk = await hkdf(secret, this.room, L.pairPsk, 32);
    this._hs = { eph, nPhone, frame1, psk };
    this.state = 'pair-wait2';
    return frame1;
  }

  async _startHello() {
    const p = this.pairing;
    const psk = b64urlDecode(p.psk);
    const id = b64urlDecode(p.deviceId);
    if (id.length !== ID_LEN) throw new ProtocolError('bad-frame', 'pairing record has a bad device id');
    const eph = await ephemeral();
    const nPhone = randomBytes(NONCE_LEN);
    const body = concat(new Uint8Array([FRAME.HELLO1]), id, eph.pub, nPhone);
    const macKey = await hkdf(psk, this.room, L.helloMac, 32);
    const frame1 = concat(body, await hmacSign(macKey, body));
    this._hs = { eph, frame1, psk };
    this.state = 'hello-wait2';
    return frame1;
  }

  async _receive(frame) {
    if (frame.length === 0) throw new ProtocolError('bad-frame', 'empty frame');
    const type = frame[0];
    if (type === FRAME.ALERT) return this._alert(frame);
    if (this.state === 'open' && type === FRAME.RECORD) return this._openRecord(frame);
    if (this.state === 'pair-approval' && type === FRAME.RECORD) return this._paired(frame);
    if (frame.length > LIMITS.MAX_HANDSHAKE_FRAME) throw new ProtocolError('bad-frame', 'handshake frame too large');
    if (this.state === 'pair-wait2' && type === FRAME.PAIR2) return this._pair2(frame);
    if (this.state === 'hello-wait2' && type === FRAME.HELLO2) return this._hello2(frame);
    throw new ProtocolError('bad-frame', `unexpected ${frameType(frame)} frame in state ${this.state}`);
  }

  async _pair2(frame) {
    expectLen(frame, 1 + PUB_LEN + NONCE_LEN + SIG_LEN + TAG_LEN);
    const hs = this._hs;
    const ePc = frame.slice(1, 1 + PUB_LEN);
    const nPc = frame.slice(1 + PUB_LEN, 1 + PUB_LEN + NONCE_LEN);
    const header = frame.subarray(0, 1 + PUB_LEN + NONCE_LEN);
    const dh = await ecdh(hs.eph.privateKey, ePc);
    const th2 = await sha256(L.pairTh, this.room, this.pcPub, hs.frame1, ePc, nPc);
    const ikm = concat(dh, hs.psk);
    const [khPc, khPhone] = await Promise.all([hkdf(ikm, th2, L.pairHsPc, 32), hkdf(ikm, th2, L.pairHsPhone, 32)]);
    const sigPc = await hsOpen(khPc, header, frame.subarray(header.length));
    if (!(await verifySig(this.pcPub, sigPc, L.pairSigPc, th2))) throw new ProtocolError('bad-signature', 'the PC signature is invalid (not the PC in the QR)');
    const sas = await computeSas(th2, hs.nPhone);
    const th3 = await sha256(th2, frame, hs.nPhone, this.device.pub, this.nameRaw);
    const sigPhone = await sign(this.device.privateKey, L.pairSigPhone, th3);
    const pt3 = concat(hs.nPhone, this.device.pub, sigPhone, new Uint8Array([this.nameRaw.length]), this.nameRaw);
    const frame3 = concat(new Uint8Array([FRAME.PAIR3]), await hsSeal(khPhone, new Uint8Array([FRAME.PAIR3]), pt3));
    const thFinal = await sha256(th3, sigPhone);
    this.channel = await deriveChannel(ikm, thFinal, 'pair', 'phone');
    const devicePsk = await hkdf(ikm, thFinal, L.devicePsk, 32);
    this._hs = { devicePsk, deviceId: await deviceIdFor(this.device.pub) };
    wipe(dh, ikm, khPc, khPhone, hs.psk);
    this.sas = sas;
    this.state = 'pair-approval';
    return { send: [frame3], events: [{ type: 'sas', sas }] };
  }

  /** The PC's encrypted acceptance: the pairing is done. */
  async _paired(frame) {
    const ev = await this._record(frame);
    const v = ev.value;
    if (ev.type !== 'control' || v?.t !== 'paired') throw new ProtocolError('bad-record', 'expected the pairing acceptance');
    if (v.deviceId !== this._hs.deviceId) throw new ProtocolError('bad-record', 'acceptance names another device');
    const pairing = {
      v: PROTOCOL_VERSION,
      roomId: this.offer.roomId,
      relay: this.offer.relay,
      pcPub: this.offer.pcPub,
      pcName: String(v.pcName || this.offer.name || ''),
      deviceId: this._hs.deviceId,
      psk: b64urlEncode(this._hs.devicePsk),
      pairedAt: new Date(this.now()).toISOString(),
    };
    wipe(this._hs.devicePsk);
    this._hs = null;
    this.pairing = pairing;
    this.offer = null;
    this.state = 'open';
    return { send: [], events: [{ type: 'paired', pairing }] };
  }

  async _hello2(frame) {
    expectLen(frame, 1 + PUB_LEN + NONCE_LEN + SIG_LEN + TAG_LEN);
    const hs = this._hs;
    const ePc = frame.slice(1, 1 + PUB_LEN);
    const nPc = frame.slice(1 + PUB_LEN, 1 + PUB_LEN + NONCE_LEN);
    const header = frame.subarray(0, 1 + PUB_LEN + NONCE_LEN);
    const dh = await ecdh(hs.eph.privateKey, ePc);
    const th2 = await sha256(L.helloTh, this.room, this.pcPub, this.device.pub, hs.frame1, ePc, nPc);
    const ikm = concat(dh, hs.psk);
    const [khPc, khPhone] = await Promise.all([hkdf(ikm, th2, L.helloHsPc, 32), hkdf(ikm, th2, L.helloHsPhone, 32)]);
    const sigPc = await hsOpen(khPc, header, frame.subarray(header.length));
    if (!(await verifySig(this.pcPub, sigPc, L.helloSigPc, th2))) throw new ProtocolError('bad-signature', 'the PC signature is invalid');
    const th3 = await sha256(th2, frame);
    const sigPhone = await sign(this.device.privateKey, L.helloSigPhone, th3);
    const frame3 = concat(new Uint8Array([FRAME.HELLO3]), await hsSeal(khPhone, new Uint8Array([FRAME.HELLO3]), sigPhone));
    this.channel = await deriveChannel(ikm, await sha256(th3, sigPhone), 'hello', 'phone');
    wipe(dh, ikm, khPc, khPhone, hs.psk);
    this._hs = null;
    this.state = 'open';
    return { send: [frame3], events: [{ type: 'open' }] };
  }
}
