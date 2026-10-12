/**
 * Myrlin Apaki relay: a Cloudflare Worker plus one Durable Object per room.
 *
 * A room is one PC running Myrlin Apaki and the phones paired with it. The
 * relay only moves opaque, end-to-end encrypted frames between the PC socket
 * and the phone sockets of a room (apaki/remote/protocol.js does the crypto
 * on both ends). It never parses a payload, stores nothing about rooms, and
 * holds no key that opens anything (ACCOUNT_KEY only signs account tokens).
 *
 *   GET /v1/rooms/<roomId>/pc        WebSocket, the PC (needs the room token)
 *   GET /v1/rooms/<roomId>/phone     WebSocket, a phone
 *   GET /v1/rooms/<roomId>/presence  { pc: boolean }: is that room's PC connected now
 *   GET /health                      a one-line description
 *
 * Apaki accounts (2026-10-10, account.js; contract apaki/remote/ACCOUNTS.md),
 * passkey only, JSON, one Account Durable Object per account:
 *
 *   POST   /v1/account/challenge          { purpose: register | signin | add }  (add needs a session)
 *   POST   /v1/account/register           { token, name, credential }  -> { session, account }
 *   POST   /v1/account/signin             { token, credential }        -> { session, account, vault }
 *   GET    /v1/account                    (session)                    -> { account, vault }
 *   PUT    /v1/account/vault              { ver, vault } (session)     -> { ver } or 409 stale
 *   POST   /v1/account/passkeys           { token, credential } (session) -> { account }
 *   DELETE /v1/account/passkeys/<credId>  (session)                    -> { account }
 *   POST   /v1/account/rename             { name } (session)           -> { account }
 *   POST   /v1/account/signout-all        (session)                    -> { ok: true }
 *   DELETE /v1/account                    (session)                    -> { ok: true }
 *
 *   everything else               the static site (../site: the front page and
 *                                 /v/<version>/, the phone pages), served by
 *                                 Workers static assets before this runs;
 *                                 GET / falls back to the line when there is no site
 *                                 (/.well-known/security.txt is one of those files)
 *   GET /assets/media/<file>      the home page's recordings, the one part of the site
 *                                 that runs this Worker first (wrangler.jsonc
 *                                 run_worker_first, 2026-10-12): media.js answers
 *                                 Range requests, which Safari needs to play an MP4
 *
 * Idle rooms cost nothing: sockets are accepted with the WebSocket
 * Hibernation API, and "ping" is answered by the runtime without waking the
 * object. The DO class is SQLite backed (new_sqlite_classes), so it runs on
 * the Workers free plan; it writes nothing but its idle alarm and (since
 * 2026-10-10) its cost for the current UTC day ('share' { day, usd }), which
 * it deletes at 00:00 UTC once the room is empty.
 *
 * Cost (2026-10-10): the relay is open to anyone's Apaki, on a Workers Paid
 * account with no spend cap, so it guards its own budget. Every room counts
 * the frames it receives and the time it stays awake, and reports them about
 * every 1000 frames or minute awake to one Budget object, which prices them
 * at Cloudflare's overage rates (lib.js PRICES) per UTC day. Past
 * DAILY_BUDGET_USD ($3 by default) rooms close their sockets with BUDGET and
 * new connections get HTTP 503 until 00:00 UTC. New connections are also
 * limited per IP address (the CONNECTS rate limit binding). Account requests
 * and presence questions count toward the same budget and the same per-IP
 * limit, under their own keys ("acct:<ip>", "pres:<ip>").
 *
 * Budget fairness (2026-10-10, apaki/SECURITY.md hardening item 5), so one
 * abuser cannot spend the whole day and switch the relay off for everyone:
 *   - per address (clientKey in lib.js: an IPv4 address or an IPv6 /64) one
 *     small Gate object counts its open WebSockets (at most MAX_SOCKETS_PER_IP,
 *     32) and what it cost today (at most IP_SHARE_USD, $0.30); past either,
 *     only that address is refused (HTTP 429; its sockets close with 4504
 *     when its share is used);
 *   - each room keeps its own day's cost (at most ROOM_SHARE_USD, $0.50);
 *     past it only that room is closed (4505) and refused (HTTP 429) until
 *     00:00 UTC;
 *   - frames and awake time are metered only while a room has its PC, and
 *     charged to the address of the socket that caused them. A phone in a room
 *     without its PC is closed after NO_PC_MS (a minute) or at once when it
 *     sends a frame (4404), so a room with no PC costs only its connections,
 *     which are priced in full (lib.js costOf);
 *   - the daily budget above stays the last line for everyone together.
 * No Durable Object request is added per frame: usage waits on each socket's
 * attachment (it survives hibernation) and goes out with the room's reports.
 *
 * Private relay (2026-10-10, hardening item 12): with RELAY_ONLY set (the
 * "private" environment in wrangler.jsonc) the same Worker answers only the
 * relay (rooms and presence, plus / and /health as one line): the account
 * routes are 404 and, because that environment uploads no static assets,
 * there are no pages either.
 *
 * Threat model and wire format: ../README.md.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  SUBPROTOCOL, ROLE_HEADER, ADDR_HEADER, LEASE_HEADER, ROOM_PATH, CLOSE,
  readLimits, publicLimits, parseProtocols, tokenFrom, roomIdForToken, sameString, originAllowed, relayOnly, clientKey,
  Bucket, prefixConn, splitConn, newConnId, newLeaseId,
  costOf, busyAdd, utcDay, nextUtcMidnight, hoursToMidnight, leaseMsOf,
} from './lib.js';
import { ACCOUNT_PATH, PRESENCE_PATH } from './account-lib.js';
import { handleAccount, handlePresence } from './account.js';
import { MEDIA_PATH, serveMedia } from './media.js';

// The Account Durable Object class (wrangler.jsonc binding ACCOUNTS) must be exported by the main module.
export { Account } from './account.js';

const ABOUT_TEXT = 'Myrlin Apaki relay. It forwards end-to-end encrypted frames between a PC and its paired phones and cannot read them.\n';
const PRIVATE_ABOUT_TEXT = 'Myrlin Apaki private relay. It forwards end-to-end encrypted frames between a PC and its paired phones and cannot read them. It serves no pages and keeps no accounts.\n';

/** Seconds until the next 00:00 UTC, for retry-after when a share of the day is used up. */
const secondsToMidnight = (now = Date.now()) => String(Math.max(60, Math.ceil((nextUtcMidnight(now) - now) / 1000)));

function text(status, body, headers = {}) {
  return new Response(body.endsWith('\n') ? body : `${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const only = relayOnly(env);
    // The home page's recordings, with byte ranges (media.js). Only where the site's assets are bound (not the Private relay).
    if (env.ASSETS && MEDIA_PATH.test(url.pathname)) return serveMedia(request, env);
    if (url.pathname === '/' || url.pathname === '/health') return text(200, only ? PRIVATE_ABOUT_TEXT : ABOUT_TEXT);
    // Accounts and presence answer JSON (account.js); everything below is the WebSocket relay.
    // A relay-only Worker (the Private relay) has no account routes at all.
    if (ACCOUNT_PATH.test(url.pathname)) return only ? text(404, 'not found') : handleAccount(request, env, url, { spend, gate });
    const pm = PRESENCE_PATH.exec(url.pathname);
    if (pm) return handlePresence(request, env, pm[1], { spend, gate });
    const m = ROOM_PATH.exec(url.pathname);
    if (!m) return text(404, 'not found');
    if (request.method !== 'GET') return text(405, 'method not allowed', { allow: 'GET' });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return text(426, 'expected a WebSocket upgrade', { upgrade: 'websocket' });
    // The key this client is counted under (an IPv4 address, or an IPv6 /64; lib.js clientKey).
    const addr = clientKey(request.headers.get('CF-Connecting-IP'));
    // At most a few new connections a minute from one address (absent in local tests without the binding).
    if (env.CONNECTS && env.IP_LIMIT !== 'off') {
      const { success } = await env.CONNECTS.limit({ key: addr });
      if (!success) return text(429, 'too many connections from this address; try again in a minute', { 'retry-after': '60' });
    }
    const offered = parseProtocols(request.headers.get('Sec-WebSocket-Protocol'));
    if (!offered.includes(SUBPROTOCOL)) return text(400, `offer the ${SUBPROTOCOL} subprotocol`);
    const [, roomId, role] = m;

    if (role === 'pc') {
      // Only the holder of the room token may be the PC: the room id is a
      // hash of the token, so this needs no stored state and no account.
      const token = tokenFrom(offered);
      if (!token || !sameString(await roomIdForToken(token), roomId)) return text(403, 'not the PC of this room');
    } else if (!originAllowed(request.headers.get('Origin'), env.ALLOWED_ORIGINS)) {
      return text(403, 'origin not allowed');
    }

    // Today's budget: this connection is counted, and refused when the day's budget is spent.
    // In the same step (two requests in parallel) this address's Gate counts it toward the address's
    // share of the day and hands out a lease for the socket, or refuses when the address already holds
    // MAX_SOCKETS_PER_IP sockets or has used its share. A refused attempt is still counted: it cost.
    const price = costOf({ connects: 1 });
    const [budget, mine] = await Promise.all([spend(env, price), gate(env, addr, { add: price, open: true })]);
    if (budget.over) {
      if (mine.lease) ctx?.waitUntil?.(gate(env, addr, { release: [mine.lease] }));
      return text(503, `The Apaki relay has used today's budget; it takes new connections again after 00:00 UTC (in about ${Math.ceil((Date.parse(`${budget.day}T00:00:00Z`) + 86_400_000 - Date.now()) / 3_600_000)} h).`, { 'retry-after': '1800' });
    }
    if (mine.refused === 'share') {
      return text(429, `This address has used its share of today's Apaki relay budget; it can connect again after 00:00 UTC (in about ${hoursToMidnight()} h). Other addresses are not affected.`, { 'retry-after': secondsToMidnight() });
    }
    if (mine.refused === 'sockets') {
      return text(429, `Too many open connections from this address (at most ${readLimits(env).MAX_SOCKETS_PER_IP}); close one and try again.`, { 'retry-after': '60' });
    }

    // The DO only ever sees the role, never the token; plus the address key and the socket's lease,
    // which the Worker always sets or removes itself (a client cannot pick them).
    const headers = new Headers(request.headers);
    headers.set(ROLE_HEADER, role);
    headers.set(ADDR_HEADER, addr);
    if (mine.lease) headers.set(LEASE_HEADER, mine.lease);
    else headers.delete(LEASE_HEADER);
    headers.set('Sec-WebSocket-Protocol', SUBPROTOCOL);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return stub.fetch(new Request(url.toString(), { method: 'GET', headers }));
  },
};

/** Adds `usd` to today's spending and returns { day, usd, over } (never throws: a failed check lets traffic through). */
async function spend(env, usd) {
  try {
    if (!env.BUDGET) return { day: utcDay(), usd: 0, over: false };
    const limit = readLimits(env).DAILY_BUDGET_USD;
    const stub = env.BUDGET.get(env.BUDGET.idFromName('global'));
    const res = await stub.fetch(`https://budget/add?usd=${encodeURIComponent(usd)}&limit=${encodeURIComponent(limit)}`);
    return await res.json();
  } catch { return { day: utcDay(), usd: 0, over: false }; }
}

/**
 * One request to the Gate of address key `addr` (see Gate below): adds `add`
 * USD to the address's day, and opens, releases or renews socket leases.
 * Returns { day, usd, over, lease, refused, open }. Never throws: like
 * spend(), a failed check lets traffic through (and gives no lease, so there
 * is nothing to release later).
 * @param {{ add?: number, open?: boolean, release?: string[], renew?: string[] }} op
 */
export async function gate(env, addr, op) {
  const pass = { day: utcDay(), usd: 0, over: false, lease: null, refused: null, open: 0 };
  try {
    if (!env.GATES) return pass;
    const limits = readLimits(env);
    const stub = env.GATES.get(env.GATES.idFromName(`addr:${addr}`));
    return await stub.tally({ ...op, cap: limits.MAX_SOCKETS_PER_IP, share: limits.IP_SHARE_USD, leaseMs: leaseMsOf(limits) });
  } catch { return pass; }
}

/**
 * The relay's spending for the current UTC day, across every room: one small
 * SQLite-backed object, a few bytes of storage, one write per report.
 */
export class Budget extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const day = utcDay();
    let st = this.st || (await this.ctx.storage.get('st')) || { day, usd: 0 };
    if (st.day !== day) st = { day, usd: 0 };
    const add = Number(url.searchParams.get('usd'));
    if (url.pathname === '/add' && Number.isFinite(add) && add > 0) {
      st = { day, usd: st.usd + add };
      await this.ctx.storage.put('st', st);
    }
    this.st = st;
    const limit = Number(url.searchParams.get('limit')) || 3;
    return new Response(JSON.stringify({ day, usd: st.usd, over: st.usd >= limit }), { headers: { 'content-type': 'application/json' } });
  }
}

/** When a Gate (and an empty room) clears yesterday: one minute after 00:00 UTC. */
const dayEndAlarm = (now) => nextUtcMidnight(now) + 60_000;

/**
 * One client address's day (budget fairness, 2026-10-10): what it has cost
 * today, against IP_SHARE_USD, and its open WebSockets, against
 * MAX_SOCKETS_PER_IP. One small SQLite-backed object per address key
 * (lib.js clientKey: an IPv4 address or an IPv6 /64), named by that key.
 *
 * It stores no address and no room id: only today's dollar count and random
 * lease ids with their expiry ('st' { day, usd, leases: { id: expiresAt } }).
 * An open socket is a lease: the Worker opens it, the room releases it when
 * the socket closes and renews it from its idle check; a lease nobody renews
 * (a room reset by a deploy, say) runs out after LEASE_MS. A minute after
 * 00:00 UTC an alarm deletes the object if no lease is left, so an address's
 * day leaves nothing behind (that one wake per address per day is not
 * counted; it is about $16 per million addresses).
 *
 * Every step is storage only (no other awaits), so calls never interleave.
 */
export class Gate extends DurableObject {
  /**
   * @param {{ add?: number, open?: boolean, release?: string[], renew?: string[], cap?: number, share?: number, leaseMs?: number }} op
   * @returns {Promise<{ day: string, usd: number, over: boolean, lease: string|null, refused: 'share'|'sockets'|null, open: number }>}
   */
  async tally({ add = 0, open = false, release = [], renew = [], cap = 32, share = 0.3, leaseMs = 1_800_000 } = {}) {
    const now = Date.now();
    const day = utcDay(now);
    const old = this.st || (await this.ctx.storage.get('st')) || null;
    let changed = false;
    let usd = old && old.day === day ? old.usd : 0;
    if (old && old.day !== day) changed = true;
    // Expired leases are sockets nobody vouches for any more.
    const leases = {};
    for (const [id, exp] of Object.entries(old?.leases || {})) {
      if (exp > now) leases[id] = exp;
      else changed = true;
    }
    for (const id of Array.isArray(release) ? release : []) {
      if (typeof id === 'string' && Object.hasOwn(leases, id)) { delete leases[id]; changed = true; }
    }
    // A renewed lease that had run out comes back: its socket is still open, so it counts.
    for (const id of Array.isArray(renew) ? renew : []) {
      if (typeof id === 'string' && id.length <= 64) { leases[id] = now + leaseMs; changed = true; }
    }
    const n = Number(add);
    if (Number.isFinite(n) && n > 0) { usd += n; changed = true; }
    const over = usd >= share;
    let lease = null;
    let refused = null;
    if (open) {
      if (over) refused = 'share';
      else if (Object.keys(leases).length >= cap) refused = 'sockets';
      else { lease = newLeaseId(); leases[lease] = now + leaseMs; changed = true; }
    }
    this.st = { day, usd, leases };
    if (changed) {
      await this.ctx.storage.put('st', this.st);
      if (!this.alarmSet) {
        if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(dayEndAlarm(now));
        this.alarmSet = true;
      }
    }
    return { day, usd, over, lease, refused, open: Object.keys(leases).length };
  }

  /** A minute after 00:00 UTC: gone if no socket is open, else a fresh day with the open leases kept. */
  async alarm() {
    const now = Date.now();
    const st = this.st || (await this.ctx.storage.get('st')) || null;
    const leases = {};
    for (const [id, exp] of Object.entries(st?.leases || {})) if (exp > now) leases[id] = exp;
    if (!Object.keys(leases).length) {
      this.st = null;
      this.alarmSet = false;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    const day = utcDay(now);
    this.st = { day, usd: st && st.day === day ? st.usd : 0, leases };
    await this.ctx.storage.put('st', this.st);
    await this.ctx.storage.setAlarm(dayEndAlarm(now));
    this.alarmSet = true;
  }
}

/** What each accepted socket carries through hibernation (structured clone, tiny). */
// { role: 'pc'|'phone', conn: number, at: ms, seen: ms, closing?: true, full?: true }
// Since 2026-10-10 (budget fairness), also:
// { addr: address key, lease?: Gate lease id, lx?: ms the lease runs out,
//   uf?: frames not yet reported, ub?: busy ms not yet reported,
//   np?: ms since when this phone has had no PC in the room }

function attachment(ws) {
  try { return ws.deserializeAttachment() || null; } catch { return null; }
}

function sendText(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* the socket is going away; its close handler cleans up */ }
}

function sendBinary(ws, bytes) {
  try { ws.send(bytes); } catch { /* same */ }
}

/**
 * Marks a socket as closing (so it is no longer routed to), tells the client
 * why in a text frame, and closes it.
 *
 * The "bye" text comes first because workerd does not finish a server-side
 * close on a hibernatable socket that has never sent a message (seen with
 * workerd 1.20261006 locally, with both undici and ws clients): the close
 * frame then only arrives much later. Clients therefore send "ping" right
 * after open, and treat { t: 'bye' } as the close.
 */
function closeWith(ws, code, reason) {
  const a = attachment(ws);
  if (a && !a.closing) {
    a.closing = true;
    try { ws.serializeAttachment(a); } catch { /* ignore */ }
  }
  sendText(ws, { t: 'bye', code, reason });
  try { ws.close(code, reason); } catch { /* already closed */ }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limits = readLimits(env);
    /** Per-socket rate buckets; in memory only (they reset when the object hibernates, which only happens when the room is quiet). */
    this.rates = new Map();
    /** Connection times in the last minute; in memory only. */
    this.connects = [];
    /**
     * Usage not yet reported to the Budget object: frames received and time awake. Since
     * 2026-10-10 the amounts themselves wait on the attachment of the socket that caused them
     * (uf, ub), which survives hibernation; this is only their sum, rebuilt from the attachments
     * after a wake (pending()).
     */
    this.usage = null;
    this.lastEvent = 0;
    /** This room's share of today ({ day, usd }, storage key 'share'); undefined until loaded. */
    this.shareNow = undefined;
    /** Sockets whose going away was handled (a socket can see both a close and an error). */
    this.ended = new WeakSet();
    // Keepalives never wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Open, routable sockets of a role. */
  live(role, except = null) {
    return this.ctx.getWebSockets(role).filter((ws) => {
      if (ws === except) return false;
      const a = attachment(ws);
      return a && !a.closing && !a.full;
    });
  }

  async fetch(request) {
    const role = request.headers.get(ROLE_HEADER);
    // Presence (GET /v1/rooms/<id>/presence) only reads; it is not a connection.
    if (role === 'presence') return this.presence();
    const addr = request.headers.get(ADDR_HEADER) || 'local';
    const lease = request.headers.get(LEASE_HEADER) || null;
    // Every answer other than an accepted socket hands the Gate lease back at once.
    if (role !== 'pc' && role !== 'phone') { await this.release(addr, lease); return text(400, 'bad role'); }
    const now = Date.now();
    this.sweep(now);

    this.connects = this.connects.filter((t) => now - t < 60_000);
    if (this.connects.length >= this.limits.CONNECTS_PER_MINUTE) {
      await this.release(addr, lease);
      return text(429, 'too many connections to this room; try again in a minute', { 'retry-after': '60' });
    }
    this.connects.push(now);

    // This room's share of today's budget: refused once used up; otherwise this connection counts
    // toward it (its full price, as at the Worker). The one that uses it up closes the room.
    const share = await this.share(now);
    let over = share.usd >= this.limits.ROOM_SHARE_USD;
    if (!over) {
      await this.addShare(costOf({ connects: 1 }), now);
      over = share.usd >= this.limits.ROOM_SHARE_USD;
      if (over) this.closeAll(CLOSE.ROOM_SHARE, 'this room has used its share of today\'s budget');
    }
    if (over) {
      await this.release(addr, lease);
      return text(429, `This room has used its share of today's Apaki relay budget; it takes connections again after 00:00 UTC (in about ${hoursToMidnight(now)} h). Other rooms are not affected.`, { 'retry-after': secondsToMidnight(now) });
    }

    const phones = this.live('phone');
    const { 0: client, 1: server } = new WebSocketPair();
    const conn = role === 'phone' ? newConnId(new Set(phones.map((p) => attachment(p).conn))) : 0;
    const full = role === 'phone' && phones.length >= this.limits.MAX_PHONES;
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role, conn, at: now, seen: now, addr,
      ...(lease ? { lease, lx: now + leaseMsOf(this.limits) } : {}),
      ...(full ? { full: true } : {}),
    });
    // This connection's wake is in its price (lib.js costOf connects): the next event adds only the time since now.
    this.lastEvent = now;
    let noPcSince = 0;

    if (full) {
      // Accept and close at once, so a browser sees the reason (an HTTP error would only show as a failed connection).
      closeWith(server, CLOSE.ROOM_FULL, 'room full');
    } else if (role === 'pc') {
      // A newer PC connection with the token wins (the PC restarted or its old socket is half dead).
      for (const old of this.live('pc', server)) closeWith(old, CLOSE.REPLACED, 'replaced by a newer PC connection');
      sendText(server, { t: 'ready', role: 'pc', phones: phones.map((p) => attachment(p).conn), limits: publicLimits(this.limits, 'pc') });
      // Every PC connection is a fresh start: phones redo their handshake.
      for (const p of phones) sendText(p, { t: 'pc', up: true });
    } else {
      const pc = this.live('pc')[0];
      sendText(server, { t: 'ready', role: 'phone', conn, pc: Boolean(pc), limits: publicLimits(this.limits, 'phone') });
      if (pc) sendText(pc, { t: 'join', conn });
      // No PC: this phone waits at most NO_PC_MS (counted from `at`), then it is closed (sweep).
      else noPcSince = now;
    }

    // The idle check, or sooner for a phone without its PC (whichever deadline comes first).
    const idleAt = now + this.limits.IDLE_MS;
    await this.ensureAlarm(now, noPcSince ? Math.min(idleAt, noPcSince + this.limits.NO_PC_MS) : idleAt);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
  }

  /** Hands a Gate lease back (a connection the room did not take). */
  async release(addr, lease) {
    if (lease) await gate(this.env, addr, { release: [lease] });
  }

  /** This room's share of today ({ day, usd }), loaded from storage once; a new UTC day starts at 0. */
  async share(now = Date.now()) {
    if (this.shareNow === undefined) {
      const stored = (await this.ctx.storage.get('share')) || null;
      // Another call may have loaded it while this one waited.
      if (this.shareNow === undefined) this.shareNow = stored;
    }
    const day = utcDay(now);
    if (!this.shareNow || this.shareNow.day !== day) this.shareNow = { day, usd: 0 };
    return this.shareNow;
  }

  /** Adds `usd` to this room's day and stores it (one row write). */
  async addShare(usd, now = Date.now()) {
    const s = await this.share(now);
    s.usd += usd;
    await this.ctx.storage.put('share', s);
    return s;
  }

  /** Closes every open socket of the room with `code`. */
  closeAll(code, reason) {
    for (const ws of this.ctx.getWebSockets()) closeWith(ws, code, reason);
  }

  /** Closes this room's sockets from one address key (it has used its share of the day). */
  closeAddr(addr) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      if (a && !a.closing && a.addr === addr) closeWith(ws, CLOSE.IP_SHARE, 'this address has used its share of today\'s budget');
    }
  }

  /**
   * Whether a PC socket is connected now: { pc: boolean }. It only reads the
   * sockets (no sweep, no alarm, no connection count, no message to anyone),
   * so asking never wakes or changes a socket. A PC socket that has been
   * silent for IDLE_MS (about to be closed by the idle check) counts as gone.
   */
  presence() {
    const now = Date.now();
    const pc = this.live('pc').some((ws) => {
      const a = attachment(ws);
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      return now - Math.max(a.seen || 0, pinged) < this.limits.IDLE_MS;
    });
    return new Response(JSON.stringify({ pc }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  /** Frames per second and bytes per second for one socket. */
  allow(ws, role, bytes, now) {
    let r = this.rates.get(ws);
    if (!r) {
      const fps = role === 'pc' ? this.limits.PC_FPS : this.limits.PHONE_FPS;
      const bps = role === 'pc' ? this.limits.PC_BPS : this.limits.PHONE_BPS;
      r = { frames: new Bucket(fps, fps * 2, now), bytes: new Bucket(bps, bps * 2, now) };
      this.rates.set(ws, r);
    }
    return r.frames.take(1, now) && r.bytes.take(bytes, now);
  }

  /** The unreported usage of the room (the sum of the sockets' uf and ub), rebuilt from the attachments after a wake. */
  pending() {
    if (!this.usage) {
      this.usage = { frames: 0, busyMs: 0 };
      for (const ws of this.ctx.getWebSockets()) {
        const a = attachment(ws);
        if (a) { this.usage.frames += a.uf || 0; this.usage.busyMs += a.ub || 0; }
      }
    }
    return this.usage;
  }

  /**
   * Counts one event (a frame, an alarm) and says whether a report is due.
   *
   * Since 2026-10-10 (budget fairness) usage is metered only while the room
   * has its PC (`pc`): a phone in a room without one is closed instead
   * (NO_PC), so such a room costs only its connections, which were priced in
   * full. The usage is kept on the attachment of whoever caused it, `a` (the
   * sender's attachment, which the caller then serializes), or the PC's for
   * the idle check, so it survives hibernation and is charged to that
   * socket's address. The caller sends the report after serializing, so the
   * report never reads an attachment older than this count.
   */
  count(now, pc, a = null, frames = 1) {
    const busy = busyAdd(this.lastEvent, now);
    this.lastEvent = now;
    if (!pc) return false;
    // The sum first, so a rebuild from the attachments does not include this event twice.
    const total = this.pending();
    const owner = a || attachment(pc);
    if (!owner) return false;
    owner.uf = (owner.uf || 0) + frames;
    owner.ub = (owner.ub || 0) + busy;
    if (!a) { try { pc.serializeAttachment(owner); } catch { /* closing */ } }
    total.frames += frames;
    total.busyMs += busy;
    return total.frames >= this.limits.REPORT_FRAMES || total.busyMs >= this.limits.REPORT_BUSY_MS;
  }

  /**
   * Sends the unreported usage on its way: the whole of it to the Budget
   * object (the relay's day) and to this room's share, and each address's part
   * to that address's Gate. `closing` is a socket that is going away: its
   * usage goes too, and its lease is released in the same Gate request.
   *
   * The attachments are read and zeroed before the first await, so frames
   * that arrive meanwhile wait for the next report and nothing is sent twice.
   * Past the relay's budget every socket closes (BUDGET); past the room's
   * share every socket closes (ROOM_SHARE); an address past its share loses
   * its sockets in this room (IP_SHARE), and its other rooms' sockets at their
   * next report or idle check.
   */
  async report(closing = null) {
    const now = Date.now();
    const byAddr = new Map();
    const entry = (addr) => {
      if (!byAddr.has(addr)) byAddr.set(addr, { usd: 0, release: [] });
      return byAddr.get(addr);
    };
    let total = 0;
    const sockets = new Set(this.ctx.getWebSockets());
    if (closing) sockets.add(closing);
    for (const ws of sockets) {
      const a = attachment(ws);
      if (!a) continue;
      if (a.uf || a.ub) {
        const usd = costOf({ frames: a.uf || 0, busyMs: a.ub || 0 });
        entry(a.addr || 'local').usd += usd;
        total += usd;
        a.uf = 0;
        a.ub = 0;
        try { ws.serializeAttachment(a); } catch { /* closed: it is not listed again */ }
      }
      if (ws === closing && a.lease) entry(a.addr || 'local').release.push(a.lease);
    }
    this.usage = { frames: 0, busyMs: 0 };
    if (!byAddr.size) return;
    // The report's own requests and writes count too.
    if (total > 0) total += costOf({ reports: 1 });
    const addrs = [...byAddr.keys()];
    const [budget, share, ...gates] = await Promise.all([
      total > 0 ? spend(this.env, total) : null,
      total > 0 ? this.addShare(total, now) : null,
      ...addrs.map((addr) => gate(this.env, addr, { add: byAddr.get(addr).usd, release: byAddr.get(addr).release })),
    ]);
    if (budget?.over) { this.closeAll(CLOSE.BUDGET, 'the relay has used today\'s budget'); return; }
    if (share && share.usd >= this.limits.ROOM_SHARE_USD) { this.closeAll(CLOSE.ROOM_SHARE, 'this room has used its share of today\'s budget'); return; }
    addrs.forEach((addr, i) => { if (gates[i]?.over) this.closeAddr(addr); });
  }

  async webSocketMessage(ws, message) {
    const a = attachment(ws);
    if (!a || a.closing || a.full) return;
    const now = Date.now();
    const pc = this.live('pc')[0] || null;
    const due = this.count(now, pc, a);
    a.seen = now;
    ws.serializeAttachment(a);
    // Not awaited: frames keep flowing while the report is on its way.
    if (due) this.report().catch(() => {});
    const size = typeof message === 'string' ? message.length : message.byteLength;

    if (size > this.limits.MAX_FRAME_BYTES) return closeWith(ws, CLOSE.TOO_LARGE, 'frame too large');
    if (!this.allow(ws, a.role, size, now)) return closeWith(ws, CLOSE.RATE, 'too many frames per second');

    if (typeof message === 'string') {
      if (message === 'ping') { try { ws.send('pong'); } catch { /* closing */ } return; } // normally answered by the runtime
      if (a.role === 'pc') return this.pcControl(message);
      return closeWith(ws, CLOSE.TEXT, 'phones send binary frames only');
    }

    if (a.role === 'phone') {
      // Without a PC there is nobody to forward to; the phone was told { t: 'pc', up: false }.
      // Until 2026-10-10 the frame was dropped. Now the phone is closed (NO_PC): a room without its
      // PC is not metered, so it must not be kept awake by frames either. The phone reconnects and
      // waits for the PC like any phone without one.
      if (!pc) return closeWith(ws, CLOSE.NO_PC, 'no PC in this room');
      sendBinary(pc, prefixConn(a.conn, message));
      return;
    }

    const split = splitConn(message);
    if (!split) return;
    const phone = this.live('phone').find((p) => attachment(p).conn === split.conn);
    if (phone) sendBinary(phone, split.payload);
    else sendText(ws, { t: 'leave', conn: split.conn });
  }

  /** Text frames from the PC: { t: 'kick', conn } drops a phone connection. Unknown messages are ignored. */
  pcControl(message) {
    if (message.length > 4096) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (m?.t === 'kick' && Number.isInteger(m.conn)) {
      const phone = this.live('phone').find((p) => attachment(p).conn === m.conn);
      if (phone) closeWith(phone, CLOSE.KICKED, 'closed by the PC');
    }
  }

  async webSocketClose(ws, code) {
    await this.gone(ws, code);
  }

  async webSocketError(ws) {
    await this.gone(ws, CLOSE.NORMAL);
  }

  /**
   * A socket went away: tell the other side of the room, then send its last
   * usage and hand its Gate lease back (one report; the close's wake is in
   * the connection's price).
   */
  async gone(ws, code) {
    if (this.ended.has(ws)) return;
    this.ended.add(ws);
    this.rates.delete(ws);
    const a = attachment(ws);
    const now = Date.now();
    this.lastEvent = now;
    // Finish the close handshake (newer runtimes do it themselves; then this throws and is ignored).
    try { ws.close(code === 1005 || code === 1006 || !code ? CLOSE.NORMAL : code, 'bye'); } catch { /* already closed */ }
    if (a && !a.full) {
      if (a.role === 'phone') {
        const pc = this.live('pc', ws)[0];
        if (pc) sendText(pc, { t: 'leave', conn: a.conn });
      } else if (!this.live('pc', ws).length) {
        const phones = this.live('phone');
        for (const p of phones) {
          sendText(p, { t: 'pc', up: false });
          // From now on these phones have no PC: they are closed after NO_PC_MS unless it comes back.
          const pa = attachment(p);
          if (pa) { pa.np = now; try { p.serializeAttachment(pa); } catch { /* closing */ } }
        }
        if (phones.length) await this.ensureAlarm(now, now + this.limits.NO_PC_MS);
      }
    }
    if (a && (a.uf || a.ub || a.lease)) await this.report(ws).catch(() => {});
  }

  /**
   * Closes sockets that sent nothing (not even a ping) for IDLE_MS, and
   * (since 2026-10-10) phones that have had no PC in the room for NO_PC_MS;
   * returns the next deadline.
   */
  sweep(now) {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      if (!a || a.closing) continue;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const last = Math.max(a.seen || 0, pinged);
      if (now - last >= this.limits.IDLE_MS) closeWith(ws, CLOSE.IDLE, 'idle');
      else next = Math.min(next, last + this.limits.IDLE_MS);
    }
    // A phone waiting in a room without its PC costs nothing while it waits (pings are answered by
    // the runtime), but it holds a socket and a phone slot: it is closed after NO_PC_MS, and
    // reconnects to wait again.
    if (!this.live('pc').length) {
      for (const ws of this.live('phone')) {
        const a = attachment(ws);
        const since = a.np || a.at || now;
        if (now - since >= this.limits.NO_PC_MS) closeWith(ws, CLOSE.NO_PC, 'no PC in this room');
        else next = Math.min(next, since + this.limits.NO_PC_MS);
      }
    }
    return next;
  }

  /** Makes sure the alarm (the idle and no-PC check) fires by `at` (by default one IDLE_MS from now). */
  async ensureAlarm(now, at = now + this.limits.IDLE_MS) {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Renews the Gate leases of open sockets that run out within half a lease,
   * one request per address (with the default limits, every other idle
   * check). An address that has used its share loses its sockets here.
   */
  async renew(now) {
    const ms = leaseMsOf(this.limits);
    const due = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachment(ws);
      if (!a || a.closing || !a.lease || (a.lx || 0) - now > ms / 2) continue;
      if (!due.has(a.addr)) due.set(a.addr, []);
      due.get(a.addr).push(ws);
    }
    await Promise.all([...due].map(async ([addr, list]) => {
      const r = await gate(this.env, addr, { renew: list.map((ws) => attachment(ws)?.lease).filter(Boolean) });
      for (const ws of list) {
        // Read again: a frame may have changed the attachment while the request was out.
        const a = attachment(ws);
        if (a) { a.lx = now + ms; try { ws.serializeAttachment(a); } catch { /* closing */ } }
      }
      if (r.over) this.closeAddr(addr);
    }));
  }

  /**
   * The room is empty. Its share of today stays until 00:00 UTC (so closing
   * every socket does not start the day afresh) and is then deleted: an empty
   * room keeps nothing after its day.
   */
  async dayEnd(now) {
    const stored = await this.ctx.storage.get('share');
    if (!stored) return;
    if (stored.day !== utcDay(now)) {
      await this.ctx.storage.delete('share');
      this.shareNow = undefined;
      return;
    }
    await this.ctx.storage.setAlarm(dayEndAlarm(now));
  }

  /**
   * The idle check. Scheduled only while the room has sockets, at most once
   * per IDLE_MS per socket (sooner for a phone without a PC); once the room is
   * empty, one more at 00:00 UTC if it has a share of the day to clear.
   */
  async alarm() {
    const now = Date.now();
    const pc = this.live('pc')[0] || null;
    if (this.count(now, pc, null, 0)) await this.report().catch(() => {});
    const next = this.sweep(now);
    await this.renew(now);
    if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
    else await this.dayEnd(now);
  }
}
