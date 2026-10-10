/**
 * lib.js: the pure parts of the Myrlin Apaki relay (no Cloudflare imports),
 * so the Worker and the Node tests share them.
 *
 * The relay forwards opaque frames between the PC and the phones of a room.
 * It never parses a payload; the only bytes it reads are the 4-byte phone
 * connection id the relay itself puts in front of frames on the PC socket.
 * Wire format and control messages: see ../README.md.
 */

/** The WebSocket subprotocol every client offers and the relay selects. */
export const SUBPROTOCOL = 'apaki.v1';
/** The PC offers its room token as a second subprotocol: apaki-token.<token>. */
export const TOKEN_PREFIX = 'apaki-token.';
/** Header the Worker sets for the Durable Object (clients cannot reach the DO directly). */
export const ROLE_HEADER = 'X-Apaki-Role';

/** /v1/rooms/<22 base64url chars>/<pc|phone> */
export const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/(pc|phone)$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Close codes (mirrored in apaki/remote/protocol.js RELAY_CLOSE). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  TEXT: 1003,
  REPLACED: 4000,
  KICKED: 4003,
  RATE: 4008,
  TOO_LARGE: 4009,
  ROOM_FULL: 4029,
  IDLE: 4408,
});

/**
 * Default limits. Every one can be overridden with a Worker var of the same
 * name (the tests use small values).
 *   MAX_FRAME_BYTES      largest binary frame (protocol records are at most 128 KiB + 17 bytes, plus 4 on the PC socket)
 *   MAX_PHONES           phone connections per room at once
 *   CONNECTS_PER_MINUTE  new connections per room per minute (both roles)
 *   PHONE_FPS / PC_FPS   frames per second per socket (token bucket, burst = 2 s worth)
 *   PHONE_BPS / PC_BPS   bytes per second per socket (token bucket, burst = 2 s worth)
 *   IDLE_MS              a socket that sends nothing at all (not even "ping") for this long is closed
 */
export const DEFAULT_LIMITS = Object.freeze({
  MAX_FRAME_BYTES: 132 * 1024,
  MAX_PHONES: 8,
  CONNECTS_PER_MINUTE: 60,
  PHONE_FPS: 60,
  PC_FPS: 600,
  PHONE_BPS: 2 * 1024 * 1024,
  PC_BPS: 8 * 1024 * 1024,
  IDLE_MS: 10 * 60 * 1000,
});

/** The limits in force: defaults, overridden by positive numeric Worker vars. */
export function readLimits(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_LIMITS)) {
    const n = Number(env[k]);
    out[k] = Number.isFinite(n) && n > 0 ? n : v;
  }
  return out;
}

/** The parts of the limits a client of a given role needs to pace itself. */
export function publicLimits(limits, role) {
  return {
    maxFrame: limits.MAX_FRAME_BYTES,
    maxPhones: limits.MAX_PHONES,
    framesPerSec: role === 'pc' ? limits.PC_FPS : limits.PHONE_FPS,
    bytesPerSec: role === 'pc' ? limits.PC_BPS : limits.PHONE_BPS,
    idleMs: limits.IDLE_MS,
  };
}

/** Splits a Sec-WebSocket-Protocol header into its values. */
export function parseProtocols(header) {
  return String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The room token a PC offered, or null. */
export function tokenFrom(protocols) {
  const p = protocols.find((x) => x.startsWith(TOKEN_PREFIX));
  if (!p) return null;
  const t = p.slice(TOKEN_PREFIX.length);
  return TOKEN_RE.test(t) ? t : null;
}

function b64urlDecode(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The room id of a token: first 16 bytes of SHA-256("apaki/v1 room" || token
 * bytes), base64url. Same function as roomIdForToken in protocol.js; the
 * relay recomputes it to check that a PC socket holds the room's token.
 */
export async function roomIdForToken(token) {
  const label = new TextEncoder().encode('apaki/v1 room');
  const raw = b64urlDecode(token);
  const data = new Uint8Array(label.length + raw.length);
  data.set(label, 0);
  data.set(raw, label.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return b64urlEncode(h.subarray(0, 16));
}

/** Constant-time comparison of two short ASCII strings. */
export function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Whether a phone's Origin is allowed (ALLOWED_ORIGINS empty = any origin; the crypto does not depend on it). */
export function originAllowed(origin, allowed) {
  const list = String(allowed || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.includes(String(origin || ''));
}

/**
 * A token bucket: `rate` units per second, holding at most `burst`.
 * take(n, now) spends n units and says whether there were enough.
 */
export class Bucket {
  constructor(rate, burst = rate * 2, now = Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  take(n, now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Puts the phone connection id (u32, big endian) in front of a phone frame for the PC socket. */
export function prefixConn(conn, payload) {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(4 + p.length);
  new DataView(out.buffer).setUint32(0, conn >>> 0);
  out.set(p, 4);
  return out;
}

/** Reads the phone connection id in front of a PC frame: { conn, payload } or null if too short. */
export function splitConn(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 4) return null;
  return { conn: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0), payload: b.subarray(4) };
}

/** A fresh random phone connection id (1 .. 2^32-1) not in `used`. */
export function newConnId(used) {
  const u = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(u);
    if (u[0] !== 0 && !used.has(u[0])) return u[0];
  }
}
