/**
 * Myrlin Apaki relay: a Cloudflare Worker plus one Durable Object per room.
 *
 * A room is one PC running Myrlin Apaki and the phones paired with it. The
 * relay only moves opaque, end-to-end encrypted frames between the PC socket
 * and the phone sockets of a room (apaki/remote/protocol.js does the crypto
 * on both ends). It never parses a payload, stores nothing, and has no keys.
 *
 *   GET /v1/rooms/<roomId>/pc     WebSocket, the PC (needs the room token)
 *   GET /v1/rooms/<roomId>/phone  WebSocket, a phone
 *   GET /                         a one-line description
 *
 * Idle rooms cost nothing: sockets are accepted with the WebSocket
 * Hibernation API, and "ping" is answered by the runtime without waking the
 * object. The DO class is SQLite backed (new_sqlite_classes), so it runs on
 * the Workers free plan; it writes nothing but its idle alarm.
 *
 * Threat model and wire format: ../README.md.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  SUBPROTOCOL, ROLE_HEADER, ROOM_PATH, CLOSE,
  readLimits, publicLimits, parseProtocols, tokenFrom, roomIdForToken, sameString, originAllowed,
  Bucket, prefixConn, splitConn, newConnId,
} from './lib.js';

const ABOUT_TEXT = 'Myrlin Apaki relay. It forwards end-to-end encrypted frames between a PC and its paired phones and cannot read them.\n';

function text(status, body, headers = {}) {
  return new Response(body.endsWith('\n') ? body : `${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return text(200, ABOUT_TEXT);
    const m = ROOM_PATH.exec(url.pathname);
    if (!m) return text(404, 'not found');
    if (request.method !== 'GET') return text(405, 'method not allowed', { allow: 'GET' });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return text(426, 'expected a WebSocket upgrade', { upgrade: 'websocket' });
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

    // The DO only ever sees the role, never the token.
    const headers = new Headers(request.headers);
    headers.set(ROLE_HEADER, role);
    headers.set('Sec-WebSocket-Protocol', SUBPROTOCOL);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return stub.fetch(new Request(url.toString(), { method: 'GET', headers }));
  },
};

/** What each accepted socket carries through hibernation (structured clone, tiny). */
// { role: 'pc'|'phone', conn: number, at: ms, seen: ms, closing?: true, full?: true }

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
    if (role !== 'pc' && role !== 'phone') return text(400, 'bad role');
    const now = Date.now();
    this.sweep(now);

    this.connects = this.connects.filter((t) => now - t < 60_000);
    if (this.connects.length >= this.limits.CONNECTS_PER_MINUTE) return text(429, 'too many connections to this room; try again in a minute', { 'retry-after': '60' });
    this.connects.push(now);

    const phones = this.live('phone');
    const { 0: client, 1: server } = new WebSocketPair();
    const conn = role === 'phone' ? newConnId(new Set(phones.map((p) => attachment(p).conn))) : 0;
    const full = role === 'phone' && phones.length >= this.limits.MAX_PHONES;
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, conn, at: now, seen: now, ...(full ? { full: true } : {}) });

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
    }

    await this.ensureAlarm(now);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
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

  async webSocketMessage(ws, message) {
    const a = attachment(ws);
    if (!a || a.closing || a.full) return;
    const now = Date.now();
    a.seen = now;
    ws.serializeAttachment(a);
    const size = typeof message === 'string' ? message.length : message.byteLength;

    if (size > this.limits.MAX_FRAME_BYTES) return closeWith(ws, CLOSE.TOO_LARGE, 'frame too large');
    if (!this.allow(ws, a.role, size, now)) return closeWith(ws, CLOSE.RATE, 'too many frames per second');

    if (typeof message === 'string') {
      if (message === 'ping') { try { ws.send('pong'); } catch { /* closing */ } return; } // normally answered by the runtime
      if (a.role === 'pc') return this.pcControl(message);
      return closeWith(ws, CLOSE.TEXT, 'phones send binary frames only');
    }

    if (a.role === 'phone') {
      // Without a PC the frame is dropped; the phone was told { t: 'pc', up: false }.
      const pc = this.live('pc')[0];
      if (pc) sendBinary(pc, prefixConn(a.conn, message));
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
    this.gone(ws, code);
  }

  async webSocketError(ws) {
    this.gone(ws, CLOSE.NORMAL);
  }

  /** A socket went away: tell the other side of the room. */
  gone(ws, code) {
    this.rates.delete(ws);
    const a = attachment(ws);
    // Finish the close handshake (newer runtimes do it themselves; then this throws and is ignored).
    try { ws.close(code === 1005 || code === 1006 || !code ? CLOSE.NORMAL : code, 'bye'); } catch { /* already closed */ }
    if (!a || a.full) return;
    if (a.role === 'phone') {
      const pc = this.live('pc', ws)[0];
      if (pc) sendText(pc, { t: 'leave', conn: a.conn });
    } else if (!this.live('pc', ws).length) {
      for (const p of this.live('phone')) sendText(p, { t: 'pc', up: false });
    }
  }

  /** Closes sockets that sent nothing (not even a ping) for IDLE_MS; returns the next deadline. */
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
    return next;
  }

  async ensureAlarm(now) {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(now + this.limits.IDLE_MS);
  }

  /** The idle check. Scheduled only while the room has sockets, at most once per IDLE_MS per socket. */
  async alarm() {
    const now = Date.now();
    const next = this.sweep(now);
    if (next !== Infinity) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }
}
