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
/**
 * Headers the Worker sets for the Room object next to the role (2026-10-10,
 * budget fairness): the client's address key (clientKey below) and the id of
 * the socket lease its Gate object handed out. The Worker always overwrites
 * or deletes them, so a client cannot choose either.
 */
export const ADDR_HEADER = 'X-Apaki-Addr';
export const LEASE_HEADER = 'X-Apaki-Lease';

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
  // The relay reached its daily budget (DAILY_BUDGET_USD); it takes connections again after 00:00 UTC.
  BUDGET: 4503,
  // Budget fairness (2026-10-10), also in apaki/remote/protocol.js RELAY_CLOSE. Older clients treat
  // them as an ordinary close and reconnect with their usual backoff, which the Worker then refuses
  // cheaply (HTTP 429) until 00:00 UTC.
  // A phone in a room without its PC: closed after NO_PC_MS, or at once when it sends a frame.
  NO_PC: 4404,
  // This address (IPv4, or IPv6 /64) has used its share of the day (IP_SHARE_USD).
  IP_SHARE: 4504,
  // This room has used its share of the day (ROOM_SHARE_USD).
  ROOM_SHARE: 4505,
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
 *   DAILY_BUDGET_USD, REPORT_FRAMES, REPORT_BUSY_MS     the daily budget guard (below)
 *   MAX_SOCKETS_PER_IP, IP_SHARE_USD, ROOM_SHARE_USD,
 *   NO_PC_MS, LEASE_MS   budget fairness (below)
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
  // The daily budget guard (2026-10-10): what all rooms together may cost per UTC day, in USD, at
  // Cloudflare's overage prices (PRICES), before new connections are refused until the next day.
  DAILY_BUDGET_USD: 3,
  // A room reports its usage to the budget after this many frames or this much busy time.
  REPORT_FRAMES: 1000,
  REPORT_BUSY_MS: 60 * 1000,
  // Budget fairness (2026-10-10, apaki/SECURITY.md hardening item 5), so one abuser cannot spend the
  // whole day's budget and switch the relay off for everyone:
  // WebSockets one address (an IPv4 address, or an IPv6 /64) may hold open at once, over all rooms.
  MAX_SOCKETS_PER_IP: 32,
  // What one address may cost per UTC day (10% of the default budget); past it only that address is
  // refused until 00:00 UTC. A heavy day for one person is about $0.014 (README, Cost).
  IP_SHARE_USD: 0.3,
  // What one room may cost per UTC day. Larger than IP_SHARE_USD on purpose: usage is charged to the
  // address that caused it, so a stranger who knows a room id runs out of its own share before it
  // can use up the room's.
  ROOM_SHARE_USD: 0.5,
  // A phone in a room without its PC is closed after this long (and at once when it sends a frame),
  // so a room with no PC costs nothing beyond the connection itself.
  NO_PC_MS: 60 * 1000,
  // How long the per-address Gate counts an open socket that its room has not renewed (the idle
  // check renews it). Covers sockets whose room never reported their close (a deploy resets rooms).
  LEASE_MS: 30 * 60 * 1000,
});

/**
 * What the budget guard counts, at Cloudflare Workers Paid overage prices
 * (2026): a Durable Object request ($0.15 per million; 20 incoming WebSocket
 * messages bill as one), Durable Object duration ($12.50 per million GB-s at
 * 128 MB while the object is awake), and a Worker request ($0.30 per million)
 * for each new connection. It ignores the plan's included amounts, so it
 * overcounts on purpose.
 *
 * Accounts (2026-10-10): one account request is a Worker request, a request
 * to its Account object plus one to the Budget object, and up to two SQLite
 * rows written ($1.00 per million rows, ROW_WRITE).
 *
 * Budget fairness (2026-10-10) made the counted operations more complete, so
 * the guard sees what an abuser can make the relay spend:
 *   - a new connection: a Worker request; Durable Object requests to the
 *     Budget, the client's Gate (open), the Room, and the Gate again when the
 *     socket closes (release); four rows written (Budget, Gate twice, the
 *     room's share); and three wakes of the room (one when it opens, one when
 *     it closes or is closed for having no PC, and the one at 00:00 UTC that
 *     deletes the room's share of the day once the room is empty). A phone in
 *     a room without its PC is not metered after that (see Room in index.js),
 *     so this price is all such a room can cost. For most connections it
 *     overcounts (the room is often awake already);
 *   - a presence question: a Worker request, the Budget, the Gate and the Room
 *     (the question wakes it), two rows written;
 *   - an account request: as above, plus the Gate request and its row and the
 *     Budget's own row;
 *   - a room's usage report: the Budget, about two Gates, and four rows written
 *     (Budget, room share, two Gates).
 */
export const PRICES = Object.freeze({ DO_REQUEST: 0.15e-6, WS_PER_REQUEST: 20, GB_S: 12.5e-6, DO_GB: 0.128, WORKER_REQUEST: 0.3e-6, ROW_WRITE: 1e-6 });

/** A Durable Object stays in memory about this long after its last event before it can hibernate. */
export const AWAKE_MS = 10_000;

/** One wake of a room from hibernation: AWAKE_MS of Durable Object duration (about $0.000016). */
const WAKE_USD = (AWAKE_MS / 1000) * PRICES.DO_GB * PRICES.GB_S;

/** USD for some relay activity: frames received, milliseconds awake, new connections, account requests, presence questions, usage reports. */
export function costOf({ frames = 0, busyMs = 0, connects = 0, accountOps = 0, presence = 0, reports = 0 } = {}) {
  return (frames / PRICES.WS_PER_REQUEST) * PRICES.DO_REQUEST
    + (busyMs / 1000) * PRICES.DO_GB * PRICES.GB_S
    + connects * (PRICES.WORKER_REQUEST + 4 * PRICES.DO_REQUEST + 4 * PRICES.ROW_WRITE + 3 * WAKE_USD)
    + accountOps * (PRICES.WORKER_REQUEST + 3 * PRICES.DO_REQUEST + 4 * PRICES.ROW_WRITE)
    + presence * (PRICES.WORKER_REQUEST + 3 * PRICES.DO_REQUEST + 2 * PRICES.ROW_WRITE + WAKE_USD)
    + reports * (3 * PRICES.DO_REQUEST + 4 * PRICES.ROW_WRITE);
}

/** Busy time one event adds: the gap since the last one, or a full AWAKE_MS when the room had gone quiet. */
export function busyAdd(last, now) {
  if (!last) return AWAKE_MS;
  const gap = Math.max(0, now - last);
  return gap >= AWAKE_MS ? AWAKE_MS : gap;
}

/** The UTC day a timestamp falls on, "YYYY-MM-DD": the budget's period. */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** The next 00:00 UTC after `now`, in ms: when every daily budget and share starts again. */
export const nextUtcMidnight = (now = Date.now()) => Date.parse(`${utcDay(now)}T00:00:00Z`) + 86_400_000;

/** Whole hours (at least 1) until the next 00:00 UTC, for messages. */
export const hoursToMidnight = (now = Date.now()) => Math.max(1, Math.ceil((nextUtcMidnight(now) - now) / 3_600_000));

/**
 * How long the Gate counts a socket lease: LEASE_MS, but never less than three
 * idle checks (the room renews leases from its idle check, every IDLE_MS).
 */
export const leaseMsOf = (limits) => Math.max(limits.LEASE_MS, 3 * limits.IDLE_MS);

/**
 * The key one client is counted under for per-address limits (the per-minute
 * connection limit, open sockets, the daily share): its IPv4 address as is,
 * or the /64 network of its IPv6 address ("2001:db8:1:2::/64"), because one
 * home network or one phone gets a whole /64 and can use any address in it.
 * An IPv4-mapped IPv6 address counts as its IPv4 address. Anything that does
 * not parse is used as is (Cloudflare always sets CF-Connecting-IP); nothing
 * at all is "local" (local tests).
 */
export function clientKey(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  if (!s) return 'local';
  if (!s.includes(':')) return s;
  // A dotted quad at the end (IPv4-mapped, NAT64 and similar) stands for the last two groups.
  let text = s;
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return s;
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill < 1) || (halves.length === 1 && head.length !== 8)) return s;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s;
  const n = groups.map((g) => parseInt(g, 16));
  // ::ffff:a.b.c.d is an IPv4 client seen through IPv6: count it as that IPv4 address.
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.');
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

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

/**
 * In ALLOWED_ORIGINS, this entry admits clients that send no Origin header at
 * all (2026-10-10, for the Private relay). Browsers always send one on a
 * WebSocket handshake, so "(none)" alone admits native apps and refuses every
 * web page; a script outside a browser can send any Origin anyway.
 */
export const NO_ORIGIN = '(none)';

/** Whether a phone's Origin is allowed (ALLOWED_ORIGINS empty = any origin; the crypto does not depend on it). */
export function originAllowed(origin, allowed) {
  const list = String(allowed || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  if ((origin === null || origin === undefined || origin === '') && list.includes(NO_ORIGIN)) return true;
  return list.includes(String(origin || ''));
}

/**
 * Whether this Worker is a relay only (RELAY_ONLY, 2026-10-10, the Private
 * relay): rooms and presence, no account routes, no pages. Any value other
 * than empty, "0", "false", "off" or "no" turns it on, so a typo errs toward
 * serving less.
 */
export function relayOnly(env = {}) {
  const v = String(env.RELAY_ONLY ?? '').trim().toLowerCase();
  return v !== '' && !['0', 'false', 'off', 'no'].includes(v);
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

/** A fresh socket lease id for a Gate: 16 random bytes, base64url (22 characters). Says nothing about the socket. */
export function newLeaseId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b64urlEncode(b);
}

/** A fresh random phone connection id (1 .. 2^32-1) not in `used`. */
export function newConnId(used) {
  const u = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(u);
    if (u[0] !== 0 && !used.has(u[0])) return u[0];
  }
}
