/**
 * Relay tests: start the Worker locally (wrangler's unstable_dev = workerd,
 * the real wrangler.jsonc with its SQLite Durable Object migration) and talk
 * to it over real WebSockets from Node.
 *
 * Two relays run: one with the default limits (routing, room token, PC
 * restart, kick, and a full pairing + reconnect with apaki/remote/protocol.js
 * through the relay), one with tiny limits (frame size, rate, room full,
 * connections per minute, idle timeout).
 *
 * Run from relay/: npm test
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unstable_dev } from 'wrangler';

import {
  createRoom, createPcIdentity, createDeviceIdentity, createPairingOffer, parsePairingUrl,
  PcSession, PhoneSession, roomUrl, relaySubprotocols, encodePcFrame, decodePcFrame, parseRelayControl, RELAY_CLOSE,
} from '../../apaki/remote/protocol.js';
import {
  CLOSE, DEFAULT_LIMITS, Bucket, readLimits, splitConn, prefixConn, originAllowed, parseProtocols, tokenFrom, roomIdForToken as relayRoomId, costOf, busyAdd, utcDay,
  clientKey, relayOnly, leaseMsOf, hoursToMidnight, nextUtcMidnight, NO_ORIGIN, PRICES, AWAKE_MS,
} from '../src/lib.js';
import { MEDIA_PATH, parseRange } from '../src/media.js';

process.env.WRANGLER_SEND_METRICS = 'false';
const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, '..');

const TIGHT = { MAX_FRAME_BYTES: '1024', MAX_PHONES: '2', PHONE_FPS: '5', CONNECTS_PER_MINUTE: '6', IDLE_MS: '2500' };

/**
 * Starts a local relay. `env` picks a wrangler.jsonc environment ('private'
 * for the Private relay); `vars` override that environment's vars.
 */
async function startRelay(vars = {}, env = undefined) {
  const worker = await unstable_dev(path.join(relayDir, 'src/index.js'), {
    config: path.join(relayDir, 'wrangler.jsonc'),
    ...(env ? { env } : {}),
    ip: '127.0.0.1',
    local: true,
    persist: false,
    logLevel: 'error',
    // These clients are Node sockets with no Origin; the deployed relay allows only the phone page's
    // own (wrangler.jsonc ALLOWED_ORIGINS, checked by originAllowed's tests above).
    // IP_LIMIT off: every test client comes from 127.0.0.1, far over 20 connections a minute.
    vars: { ALLOWED_ORIGINS: '', IP_LIMIT: 'off', ...vars },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
  return { worker, base: `ws://127.0.0.1:${worker.port}`, port: worker.port };
}

/**
 * Test addresses (TEST-NET-2). A client sends one as CF-Connecting-IP: local
 * workerd passes it through, while Cloudflare overwrites it with the real
 * address, so only tests can pick one.
 */
const IP = (n) => `198.51.100.${n}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Resolves like `p`, or rejects after `ms`. */
const within = (p, ms = 5000, what = 'an answer') => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no ${what} within ${ms} ms`)), ms))]);

let normal;
let tight;
before(async () => {
  [normal, tight] = await Promise.all([startRelay(), startRelay(TIGHT)]);
});
after(async () => {
  await Promise.allSettled([normal?.worker.stop(), tight?.worker.stop()]);
});

/**
 * A WebSocket client with a message queue: next(pred) waits for the next
 * matching message. Like the real clients it sends "ping" right after open
 * (see closeWith in src/index.js for why) and exposes the relay's
 * { t: 'bye' } notice as `bye`.
 */
function client(url, protocols, ip = null) {
  // Node's WebSocket (undici) takes extra headers in its options object.
  const ws = ip ? new WebSocket(url, { protocols, headers: { 'CF-Connecting-IP': ip } }) : new WebSocket(url, protocols);
  ws.binaryType = 'arraybuffer';
  const queue = [];
  const waiters = [];
  let byeResolve;
  const bye = new Promise((resolve) => { byeResolve = resolve; });
  ws.addEventListener('open', () => ws.send('ping'), { once: true });
  ws.addEventListener('message', (e) => {
    let m;
    if (typeof e.data === 'string') {
      let json = null;
      try { json = JSON.parse(e.data); } catch { /* plain text */ }
      m = { text: e.data, json };
      if (json?.t === 'bye') byeResolve(json);
    } else {
      m = { bin: new Uint8Array(e.data) };
    }
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
  });
  opened.catch(() => {}); // awaited where it matters; never an unhandled rejection
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true }));
  return {
    ws, opened, closed, bye,
    next(pred = () => true, ms = 5000) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m) => { clearTimeout(timer); resolve(m); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timed out waiting for a message')); }, ms);
        waiters.push(w);
      });
    },
    send(x) { ws.send(x); },
    close() { try { ws.close(); } catch { /* closed */ } },
  };
}

const isJson = (t) => (m) => m.json?.t === t;
const isBin = (m) => Boolean(m.bin);

async function pcClient(relay, room, ip = null) {
  const c = client(roomUrl(relay.base, room.roomId, 'pc'), relaySubprotocols('pc', room.token), ip);
  await c.opened;
  c.ready = (await c.next(isJson('ready'))).json;
  return c;
}

async function phoneClient(relay, roomId, ip = null) {
  const c = client(roomUrl(relay.base, roomId, 'phone'), relaySubprotocols('phone'), ip);
  await c.opened;
  c.ready = (await c.next(isJson('ready'))).json;
  return c;
}

/**
 * A raw WebSocket upgrade request: { status, body } (101 when it upgrades; the
 * socket is then dropped at once). `ip` is sent as CF-Connecting-IP.
 */
function upgradeAnswer(relay, urlPath, protocols, ip = null, extra = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': nodeRandomBytes(16).toString('base64'), ...extra };
    if (protocols) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    if (ip) headers['CF-Connecting-IP'] = ip;
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: urlPath, headers });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, body: '', headers: res.headers }); });
    req.on('error', reject);
    req.end();
  });
}

/** The HTTP status of a raw WebSocket upgrade request (101 when it upgrades). */
async function upgradeStatus(relay, urlPath, protocols, ip = null, extra = {}) {
  return (await upgradeAnswer(relay, urlPath, protocols, ip, extra)).status;
}

test('lib: room ids match protocol.js, buckets, conn framing, limits', async () => {
  const room = await createRoom();
  assert.equal(await relayRoomId(room.token), room.roomId, 'relay and protocol derive the same room id');
  const b = new Bucket(5, 10, 0);
  let ok = 0;
  for (let i = 0; i < 20; i++) if (b.take(1, 0)) ok++;
  assert.equal(ok, 10, 'burst');
  assert.equal(b.take(1, 1000), true, 'refills over time');
  assert.deepEqual(splitConn(prefixConn(42, new Uint8Array([7]))), { conn: 42, payload: new Uint8Array([7]) });
  assert.deepEqual(decodePcFrame(prefixConn(42, new Uint8Array([7]))), { connId: 42, payload: new Uint8Array([7]) });
  assert.equal(readLimits({ MAX_PHONES: '3', IDLE_MS: 'junk' }).MAX_PHONES, 3);
  assert.equal(readLimits({ IDLE_MS: 'junk' }).IDLE_MS, DEFAULT_LIMITS.IDLE_MS);
  assert.ok(DEFAULT_LIMITS.MAX_FRAME_BYTES >= 4 + 1 + 128 * 1024 + 16, 'the biggest protocol record fits, with the PC header');
  assert.equal(originAllowed(undefined, ''), true, 'no list: any origin');
  assert.equal(originAllowed('https://apaki.myrlin.io', 'https://apaki.myrlin.io, http://localhost:5173'), true);
  assert.equal(originAllowed('https://evil.test', 'https://apaki.myrlin.io'), false);
  assert.equal(originAllowed(null, 'https://apaki.myrlin.io'), false);
  assert.deepEqual(parseProtocols(' apaki.v1 , apaki-token.abc '), ['apaki.v1', 'apaki-token.abc']);
  assert.equal(tokenFrom(['apaki.v1', `apaki-token.${room.token}`]), room.token);
  assert.equal(tokenFrom(['apaki.v1', 'apaki-token.short']), null);
  assert.deepEqual(RELAY_CLOSE, { REPLACED: CLOSE.REPLACED, KICKED: CLOSE.KICKED, RATE: CLOSE.RATE, TOO_LARGE: CLOSE.TOO_LARGE, ROOM_FULL: CLOSE.ROOM_FULL, IDLE: CLOSE.IDLE, BUDGET: CLOSE.BUDGET, NO_PC: CLOSE.NO_PC, IP_SHARE: CLOSE.IP_SHARE, ROOM_SHARE: CLOSE.ROOM_SHARE });
});

test('http: health, unknown paths, non-upgrade requests, missing subprotocol', async () => {
  const res = await normal.worker.fetch('http://127.0.0.1/health');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /cannot read them/);
  // The front page is the static site (site/index.html).
  const front = await normal.worker.fetch('http://127.0.0.1/');
  assert.equal(front.status, 200);
  assert.match(await front.text(), /Myrlin Apaki/);
  assert.equal((await normal.worker.fetch('http://127.0.0.1/v1/rooms/x/pc')).status, 404);
  const { roomId } = await createRoom();
  assert.equal((await normal.worker.fetch(`http://127.0.0.1/v1/rooms/${roomId}/phone`)).status, 426);
  assert.equal(await upgradeStatus(normal, `/v1/rooms/${roomId}/phone`, null), 400);
  assert.equal(await upgradeStatus(normal, `/v1/rooms/${roomId}/phone`, ['apaki.v1']), 101);
});

test('the PC side needs the room token: no token, a wrong token or another room\'s token are refused', async () => {
  const room = await createRoom();
  const other = await createRoom();
  const p = `/v1/rooms/${room.roomId}/pc`;
  assert.equal(await upgradeStatus(normal, p, ['apaki.v1']), 403);
  assert.equal(await upgradeStatus(normal, p, ['apaki.v1', `apaki-token.${other.token}`]), 403);
  assert.equal(await upgradeStatus(normal, p, ['apaki.v1', 'apaki-token.short']), 403);
  assert.equal(await upgradeStatus(normal, p, ['apaki.v1', `apaki-token.${room.token}`]), 101);
});

test('two clients exchange frames through a room; a third without the token cannot claim the PC side', async () => {
  const room = await createRoom();
  const pc = await pcClient(normal, room);
  assert.deepEqual(pc.ready.phones, []);
  assert.equal(pc.ready.limits.maxFrame, DEFAULT_LIMITS.MAX_FRAME_BYTES);

  const phone = await phoneClient(normal, room.roomId);
  assert.equal(phone.ready.pc, true);
  const conn = phone.ready.conn;
  assert.ok(Number.isInteger(conn) && conn > 0);
  assert.deepEqual((await pc.next(isJson('join'))).json, { t: 'join', conn });

  // Phone to PC: the relay adds the connection id in front.
  phone.send(new Uint8Array([1, 2, 3]));
  const got = await pc.next(isBin);
  assert.deepEqual(decodePcFrame(got.bin), { connId: conn, payload: new Uint8Array([1, 2, 3]) });
  // PC to phone: the relay strips it.
  pc.send(encodePcFrame(conn, new Uint8Array([9, 8, 7, 6])));
  assert.deepEqual((await phone.next(isBin)).bin, new Uint8Array([9, 8, 7, 6]));

  // The third party knows the room id (it saw the QR) but not the token.
  assert.equal(await upgradeStatus(normal, `/v1/rooms/${room.roomId}/pc`, ['apaki.v1', `apaki-token.${(await createRoom()).token}`]), 403);
  // As a phone it gets in, but it only ever reaches the PC, never another phone.
  const intruder = await phoneClient(normal, room.roomId);
  await pc.next(isJson('join'));
  intruder.send(new Uint8Array([0xee]));
  const fromIntruder = await pc.next(isBin);
  assert.equal(decodePcFrame(fromIntruder.bin).connId, intruder.ready.conn);
  phone.send(new Uint8Array([4]));
  assert.deepEqual(decodePcFrame((await pc.next(isBin)).bin), { connId: conn, payload: new Uint8Array([4]) });
  await assert.rejects(intruder.next(isBin, 300), /timed out/, 'phones never see each other\'s frames');

  // A frame for a connection that is gone gets a leave back.
  pc.send(encodePcFrame(12345, new Uint8Array([1])));
  assert.deepEqual((await pc.next(isJson('leave'))).json, { t: 'leave', conn: 12345 });

  // ping is answered.
  phone.send('ping');
  assert.equal((await phone.next((m) => m.text === 'pong')).text, 'pong');

  // The PC kicks the intruder.
  pc.send(JSON.stringify({ t: 'kick', conn: intruder.ready.conn }));
  assert.equal((await intruder.closed).code, RELAY_CLOSE.KICKED);
  assert.deepEqual((await pc.next(isJson('leave'))).json, { t: 'leave', conn: intruder.ready.conn });

  // Phone leaves: the PC hears it. PC leaves: phones hear it.
  const phone2 = await phoneClient(normal, room.roomId);
  await pc.next(isJson('join'));
  phone.close();
  assert.deepEqual((await pc.next(isJson('leave'))).json, { t: 'leave', conn });
  pc.close();
  assert.deepEqual((await phone2.next(isJson('pc'))).json, { t: 'pc', up: false });
  // A frame sent while no PC is connected goes nowhere. Until 2026-10-10 it was dropped; now the
  // phone is closed (4404), so a room without its PC cannot be kept awake. A phone that only waits
  // stays (until NO_PC_MS) and hears the PC come back.
  phone2.send(new Uint8Array([5]));
  assert.equal((await within(phone2.bye, 5000, 'bye')).code, CLOSE.NO_PC);
  const phone3 = await phoneClient(normal, room.roomId);
  assert.equal(phone3.ready.pc, false);
  const back = await pcClient(normal, room);
  assert.deepEqual(back.ready.phones, [phone3.ready.conn]);
  assert.deepEqual((await phone3.next(isJson('pc'))).json, { t: 'pc', up: true });
  await assert.rejects(back.next(isBin, 300), /timed out/, 'the frame sent while the PC was away was not delivered');
  phone3.close();
  back.close();
});

test('a restarted PC takes over the room; the old PC socket is closed as replaced', async () => {
  const room = await createRoom();
  const pc1 = await pcClient(normal, room);
  const phone = await phoneClient(normal, room.roomId);
  await pc1.next(isJson('join'));
  const pc2 = await pcClient(normal, room);
  assert.equal((await pc1.closed).code, RELAY_CLOSE.REPLACED);
  assert.deepEqual(pc2.ready.phones, [phone.ready.conn]);
  assert.deepEqual((await phone.next(isJson('pc'))).json, { t: 'pc', up: true });
  phone.send(new Uint8Array([1]));
  assert.equal(decodePcFrame((await pc2.next(isBin)).bin).connId, phone.ready.conn);
  await assert.rejects(phone.next(isJson('pc'), 300), /timed out/, 'no pc-down when the old socket closes after the takeover');
  phone.close();
  pc2.close();
});

test('phones may only send binary frames', async () => {
  const { roomId } = await createRoom();
  const phone = await phoneClient(normal, roomId);
  phone.send('{"t":"kick","conn":1}');
  assert.equal((await phone.closed).code, CLOSE.TEXT);
});

test('end to end: pairing, then a reconnect, with protocol.js on both sides of the relay', async () => {
  const room = await createRoom();
  const identity = await createPcIdentity();
  let offer = createPairingOffer({ identity, relay: normal.base, roomId: room.roomId, name: 'Test PC' });
  const devices = new Map();
  const sessions = new Map();
  const pcEvents = [];

  // A minimal PC bridge: one PcSession per relay connection id.
  const pc = await pcClient(normal, room);
  const pcSend = (conn, frames) => { for (const f of frames) pc.send(encodePcFrame(conn, f)); };
  pc.ws.addEventListener('message', async (e) => {
    if (typeof e.data === 'string') {
      const m = parseRelayControl(e.data);
      if (!m) return;
      if (m.t === 'join') sessions.set(m.conn, new PcSession({ identity, roomId: room.roomId, getOffer: () => offer, getDevice: (id) => devices.get(id) ?? null }));
      if (m.t === 'leave') sessions.delete(m.conn);
      return;
    }
    const { connId, payload } = decodePcFrame(new Uint8Array(e.data));
    const s = sessions.get(connId);
    if (!s) return;
    const step = await s.receive(payload);
    pcSend(connId, step.send);
    for (const ev of step.events) {
      pcEvents.push(ev);
      if (ev.type === 'pair-request') {
        const ok = await s.approve();
        devices.set(ok.device.id, ok.device);
        pcSend(connId, ok.send);
      }
      if (ev.type === 'json') pcSend(connId, [await s.sendJson({ echo: ev.value })]);
    }
  });

  /** Phone side: drive a PhoneSession over a relay socket until it opens. */
  async function phoneRun(session) {
    const ph = await phoneClient(normal, room.roomId);
    assert.equal(ph.ready.pc, true);
    ph.send(await session.start());
    const events = [];
    while (!session.isOpen) {
      const m = await ph.next(isBin);
      const step = await session.receive(m.bin);
      for (const f of step.send) ph.send(f);
      events.push(...step.events);
      if (session.state === 'closed') throw new Error(`phone session closed: ${JSON.stringify(step.events)}`);
    }
    return { ph, events };
  }

  const device = await createDeviceIdentity();
  const first = new PhoneSession({ device, offer: parsePairingUrl(offer.url), name: 'Test phone' });
  const paired = await phoneRun(first);
  const sas = paired.events.find((e) => e.type === 'sas').sas;
  assert.equal(pcEvents.find((e) => e.type === 'pair-request').sas, sas, 'same SAS on both sides, through the relay');
  const pairing = paired.events.find((e) => e.type === 'paired').pairing;
  assert.equal(pairing.relay, normal.base);

  paired.ph.send(await first.sendJson({ op: 'sessions' }));
  const echo = await first.receive((await paired.ph.next(isBin)).bin);
  assert.deepEqual(echo.events[0].value, { echo: { op: 'sessions' } });
  paired.ph.close();
  offer = null; // the QR is gone from the PC screen

  // Reconnect with the stored pairing (fresh ephemerals, no QR).
  const again = new PhoneSession({ device, pairing: JSON.parse(JSON.stringify(pairing)) });
  const re = await phoneRun(again);
  assert.deepEqual(re.events, [{ type: 'open' }]);
  re.ph.send(await again.sendJson({ op: 'search', q: 'relay' }));
  const echo2 = await again.receive((await re.ph.next(isBin)).bin);
  assert.deepEqual(echo2.events[0].value, { echo: { op: 'search', q: 'relay' } });
  assert.ok(pcEvents.some((e) => e.type === 'open' && e.device.id === pairing.deviceId));
  re.ph.close();
  pc.close();
});

test('limits: a frame over the size limit closes the socket', async () => {
  const { roomId } = await createRoom();
  const phone = await phoneClient(tight, roomId);
  assert.equal(phone.ready.limits.maxFrame, 1024);
  phone.send(new Uint8Array(1025));
  assert.equal((await phone.closed).code, RELAY_CLOSE.TOO_LARGE);
});

test('limits: too many frames per second close the socket', async () => {
  // With its PC there (since 2026-10-10 a phone without one is closed at its first frame instead).
  const room = await createRoom();
  const pc = await pcClient(tight, room);
  const phone = await phoneClient(tight, room.roomId);
  assert.equal(phone.ready.limits.framesPerSec, 5);
  for (let i = 0; i < 30; i++) phone.send(new Uint8Array([i]));
  assert.equal((await phone.closed).code, RELAY_CLOSE.RATE);
  pc.close();
});

test('limits: a room takes at most MAX_PHONES phones', async () => {
  const room = await createRoom();
  const pc = await pcClient(tight, room);
  const a = await phoneClient(tight, room.roomId);
  const b = await phoneClient(tight, room.roomId);
  const c = client(roomUrl(tight.base, room.roomId, 'phone'), relaySubprotocols('phone'));
  // The socket is accepted and told why at once; the close frame itself may lag (see closeWith).
  assert.deepEqual(await c.bye, { t: 'bye', code: RELAY_CLOSE.ROOM_FULL, reason: 'room full' });
  c.close();
  // The PC was told about a and b only.
  const joins = [(await pc.next(isJson('join'))).json.conn, (await pc.next(isJson('join'))).json.conn].sort();
  assert.deepEqual(joins, [a.ready.conn, b.ready.conn].sort());
  await assert.rejects(pc.next(isJson('join'), 300), /timed out/);
  // When one leaves, there is room again.
  a.close();
  await pc.next(isJson('leave'));
  const d = await phoneClient(tight, room.roomId);
  assert.ok(d.ready.conn);
  for (const x of [b, d, pc]) x.close();
});

test('limits: connections per room per minute', async () => {
  const { roomId } = await createRoom();
  const p = `/v1/rooms/${roomId}/phone`;
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push(await upgradeStatus(tight, p, ['apaki.v1']));
  assert.deepEqual(statuses, [101, 101, 101, 101, 101, 101, 429]);
});

test('limits: a socket that goes quiet (no frames, no pings) is closed as idle; a pinging one stays', async () => {
  const room = await createRoom();
  const quiet = await phoneClient(tight, room.roomId);
  const chatty = await phoneClient(tight, room.roomId);
  const timer = setInterval(() => { try { chatty.send('ping'); } catch { /* closed */ } }, 400);
  try {
    const t0 = Date.now();
    const res = await Promise.race([quiet.closed, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 10_000))]);
    assert.equal(res.code, RELAY_CLOSE.IDLE);
    assert.ok(Date.now() - t0 >= 1500, 'not before the idle time');
    assert.equal(chatty.ws.readyState, WebSocket.OPEN, 'pings (answered without waking the room) keep a socket alive');
  } finally {
    clearInterval(timer);
    chatty.close();
  }
});


test('budget: past the daily budget a room closes with BUDGET and new connections get 503', async () => {
  // Two connections fit (lib.js costOf connects, about $0.000053 each since 2026-10-10); the first
  // usage report (the frames plus the report's own requests, about $0.0000045) does not. The shares
  // per address and per room keep their defaults, far above this: the global guard trips first.
  const budget = 2 * costOf({ connects: 1 }) + costOf({ reports: 1 }) / 2;
  const broke = await startRelay({ DAILY_BUDGET_USD: String(budget), REPORT_FRAMES: '3' });
  try {
    const room = await createRoom();
    const pc = await pcClient(broke, room);
    const phone = await phoneClient(broke, room.roomId);
    for (let i = 0; i < 4; i++) phone.send(new Uint8Array([1, 2, 3]));
    const bye = await Promise.race([phone.bye, new Promise((_, rej) => setTimeout(() => rej(new Error('no bye')), 5000))]);
    assert.equal(bye.code, CLOSE.BUDGET);
    assert.equal((await pc.bye).code, CLOSE.BUDGET);
    assert.equal(await upgradeStatus(broke, `/v1/rooms/${room.roomId}/phone`, ['apaki.v1']), 503);
    // The whole relay is off: another address, another room, still 503 (the last line, for everyone).
    const other = await upgradeAnswer(broke, `/v1/rooms/${(await createRoom()).roomId}/phone`, ['apaki.v1'], IP(40));
    assert.equal(other.status, 503);
    assert.match(other.body, /used today's budget/);
  } finally { await broke.worker.stop(); }
});

test('cost: what the guard counts', () => {
  assert.ok(Math.abs(costOf({ frames: 20e6 }) - 0.15) < 1e-9, '20 million frames are a million requests');
  assert.ok(Math.abs(costOf({ busyMs: 86_400_000 }) - 0.128 * 86_400 * 12.5e-6) < 1e-9, 'a room awake all day');
  assert.equal(busyAdd(0, 5000), 10_000);
  assert.equal(busyAdd(1000, 4000), 3000);
  assert.equal(busyAdd(1000, 60_000), 10_000);
  assert.equal(utcDay(Date.parse('2026-10-10T23:59:59Z')), '2026-10-10');
  // Since 2026-10-10 a connection is priced in full: a Worker request, four Durable Object requests,
  // four rows written, and three wakes of its room (open, close, the day-end cleanup).
  const wake = (AWAKE_MS / 1000) * PRICES.DO_GB * PRICES.GB_S;
  assert.ok(Math.abs(costOf({ connects: 1 }) - (PRICES.WORKER_REQUEST + 4 * PRICES.DO_REQUEST + 4 * PRICES.ROW_WRITE + 3 * wake)) < 1e-15);
  assert.ok(Math.abs(costOf({ presence: 1 }) - (PRICES.WORKER_REQUEST + 3 * PRICES.DO_REQUEST + 2 * PRICES.ROW_WRITE + wake)) < 1e-15, 'a presence question wakes the room');
  assert.ok(costOf({ reports: 1 }) > 0);
  // The defaults make one address a tenth of the day and one room a sixth; a heavy day for one
  // person (README: about 14k requests and 900 GB-s) fits an address's share many times over.
  const L = readLimits({});
  assert.ok(L.IP_SHARE_USD <= L.DAILY_BUDGET_USD / 10 + 1e-12);
  assert.ok(L.ROOM_SHARE_USD > L.IP_SHARE_USD, 'a stranger in a room runs out of its own share first');
  assert.ok(costOf({ frames: 14_000 * 20, busyMs: (900 / 0.128) * 1000 }) * 10 < L.IP_SHARE_USD);
  assert.equal(nextUtcMidnight(Date.parse('2026-10-10T23:59:59Z')), Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(hoursToMidnight(Date.parse('2026-10-10T22:30:00Z')), 2);
  assert.equal(leaseMsOf(L), L.LEASE_MS);
  assert.equal(leaseMsOf(readLimits({ IDLE_MS: String(20 * 60 * 1000) })), 60 * 60 * 1000, 'a lease outlives three idle checks');
});

test('lib: address keys (IPv6 per /64), the "(none)" origin, the relay-only switch', () => {
  assert.equal(clientKey('203.0.113.5'), '203.0.113.5');
  assert.equal(clientKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64', 'any address in the /64');
  assert.equal(clientKey('2001:db8:1:3::1'), '2001:db8:1:3::/64', 'the next /64 is another key');
  assert.equal(clientKey('::ffff:198.51.100.7'), '198.51.100.7', 'IPv4-mapped counts as IPv4');
  assert.equal(clientKey('::ffff:c633:6407'), '198.51.100.7');
  assert.equal(clientKey(''), 'local');
  assert.equal(clientKey(null), 'local');
  assert.equal(clientKey('not an address'), 'not an address', 'unparsable: used as is');
  assert.equal(clientKey('1:2:3:4:5:6:7:8:9'), '1:2:3:4:5:6:7:8:9');
  assert.equal(NO_ORIGIN, '(none)');
  assert.equal(originAllowed(null, '(none)'), true, 'no Origin header: a native client');
  assert.equal(originAllowed(undefined, '(none)'), true);
  assert.equal(originAllowed('https://apaki.myrlin.io', '(none)'), false, 'every browser sends one');
  assert.equal(originAllowed('null', '(none)'), false, 'an opaque origin is still an origin');
  assert.equal(originAllowed(null, 'https://apaki.myrlin.io, (none)'), true);
  assert.equal(originAllowed(null, 'https://apaki.myrlin.io'), false, 'unchanged without "(none)"');
  assert.equal(relayOnly({}), false);
  for (const v of ['', '0', 'false', 'off', 'no', 'FALSE']) assert.equal(relayOnly({ RELAY_ONLY: v }), false, v);
  for (const v of ['1', 'true', 'on', 'yes', 'typo']) assert.equal(relayOnly({ RELAY_ONLY: v }), true, v);
});

test('security.txt is served from site/.well-known (RFC 9116)', async () => {
  const res = await normal.worker.fetch('http://127.0.0.1/.well-known/security.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^text\/plain/);
  const body = await res.text();
  assert.match(body, /^Contact: mailto:security@myrlin\.io$/m);
  const expires = /^Expires: (.+)$/m.exec(body);
  assert.ok(expires && Date.parse(expires[1]) > Date.now(), 'not expired');
  assert.ok(Date.parse(expires[1]) <= Date.now() + 366 * 86_400_000, 'at most a year out');
  assert.match(body, /^Preferred-Languages: en$/m);
  assert.match(body, /^Policy: https:\/\/github\.com\/therealarthur\/claude-latch\/blob\/master\/apaki\/SECURITY\.md$/m);
  assert.doesNotMatch(body, /\r/, 'LF line endings');
});

test('media: parseRange (one range; suffix and open ranges; several ranges send the whole file)', () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'an end past the file is cut to it');
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=0-1, 4-5', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.ok(MEDIA_PATH.test('/assets/media/split-light.mp4'));
  assert.ok(!MEDIA_PATH.test('/assets/media/../site.css') && !MEDIA_PATH.test('/assets/media/a/b.mp4') && !MEDIA_PATH.test('/v/x/index.html'));
});

test('media: the home page\'s recordings answer Range with 206 (Safari plays an MP4 only from such a server)', async () => {
  const dir = path.join(relayDir, 'site', 'assets', 'media');
  const mp4 = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.mp4')) : null;
  if (!mp4) return; // a site without the home page's media (a self-hosted copy that removed it)
  const size = fs.statSync(path.join(dir, mp4)).size;
  const get = (init) => normal.worker.fetch(`http://127.0.0.1/assets/media/${mp4}`, init);
  const two = await get({ headers: { Range: 'bytes=0-1' } });
  assert.equal(two.status, 206);
  assert.equal(two.headers.get('content-range'), `bytes 0-1/${size}`);
  assert.equal((await two.arrayBuffer()).byteLength, 2);
  const tail = await get({ headers: { Range: 'bytes=100-' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, size - 100);
  const whole = await get();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.match(whole.headers.get('content-type') || '', /^video\/mp4/);
  assert.equal((await whole.arrayBuffer()).byteLength, size);
  const past = await get({ headers: { Range: `bytes=${size}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${size}`);
  await past.arrayBuffer();
  const missing = await normal.worker.fetch('http://127.0.0.1/assets/media/no-such-clip.mp4');
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  // The rest of the site is untouched: the home page and a phone page are still plain files.
  const home = await normal.worker.fetch('http://127.0.0.1/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<html/i);
});

test('no PC: a phone in a room without its PC is closed after NO_PC_MS, and at once when it sends a frame', async () => {
  const r = await startRelay({ NO_PC_MS: '1500' });
  try {
    const waiting = await phoneClient(r, (await createRoom()).roomId);
    assert.equal(waiting.ready.pc, false);
    const t0 = Date.now();
    assert.equal((await within(waiting.bye, 10_000, 'bye')).code, CLOSE.NO_PC);
    assert.ok(Date.now() - t0 >= 1000, 'not before NO_PC_MS');

    const eager = await phoneClient(r, (await createRoom()).roomId);
    eager.send(new Uint8Array([1]));
    assert.equal((await within(eager.bye, 3000, 'bye')).code, CLOSE.NO_PC);

    // With its PC there a phone stays; when the PC leaves, the phone's clock starts then.
    const room = await createRoom();
    const pc = await pcClient(r, room);
    const phone = await phoneClient(r, room.roomId);
    await pc.next(isJson('join'));
    await sleep(2000);
    assert.equal(phone.ws.readyState, WebSocket.OPEN, 'a phone with its PC is not closed');
    pc.close();
    assert.deepEqual((await phone.next(isJson('pc'))).json, { t: 'pc', up: false });
    const t1 = Date.now();
    assert.equal((await within(phone.bye, 10_000, 'bye')).code, CLOSE.NO_PC);
    assert.ok(Date.now() - t1 >= 1000, 'counted from when the PC left');
  } finally { await r.worker.stop(); }
});

test('fairness: one address holds at most MAX_SOCKETS_PER_IP open sockets over all rooms; other addresses still connect', async () => {
  const capped = await startRelay({ MAX_SOCKETS_PER_IP: '3' });
  try {
    const a = IP(10);
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await pcClient(capped, await createRoom(), a));
    const elsewhere = `/v1/rooms/${(await createRoom()).roomId}/phone`;
    const refused = await upgradeAnswer(capped, elsewhere, ['apaki.v1'], a);
    assert.equal(refused.status, 429, 'a fourth socket from the same address, in yet another room');
    assert.match(refused.body, /Too many open connections from this address \(at most 3\)/);
    assert.equal(await upgradeStatus(capped, elsewhere, ['apaki.v1'], IP(11)), 101, 'another address is not affected');

    // An IPv6 /64 is one address: one home network, or one phone.
    const v6 = [];
    for (let i = 1; i <= 3; i++) v6.push(await pcClient(capped, await createRoom(), `2001:db8:5:6::${i}`));
    assert.equal(await upgradeStatus(capped, elsewhere, ['apaki.v1'], '2001:db8:5:6:ffff::9'), 429, 'the same /64');
    assert.equal(await upgradeStatus(capped, elsewhere, ['apaki.v1'], '2001:db8:5:7::1'), 101, 'the next /64');

    // Closing a socket hands its slot back (the room releases its lease when the socket closes).
    held[0].close();
    await held[0].closed;
    let status = 0;
    for (let i = 0; i < 50 && status !== 101; i++) {
      status = await upgradeStatus(capped, elsewhere, ['apaki.v1'], a);
      if (status !== 101) await sleep(100);
    }
    assert.equal(status, 101, 'a slot is free again');
    for (const c of [...held, ...v6]) c.close();
  } finally { await capped.worker.stop(); }
});

test('fairness: open sockets keep their slots past the lease time (the idle check renews them), and free them on close', async () => {
  // Leases of 4.5 s (three idle checks of 1.5 s); held well past that, they must still count.
  const r = await startRelay({ MAX_SOCKETS_PER_IP: '2', IDLE_MS: '1500', LEASE_MS: '1' });
  const a = IP(15);
  const held = [await pcClient(r, await createRoom(), a), await pcClient(r, await createRoom(), a)];
  const timer = setInterval(() => { for (const c of held) { try { c.send('ping'); } catch { /* closed */ } } }, 400);
  try {
    const elsewhere = `/v1/rooms/${(await createRoom()).roomId}/phone`;
    assert.equal(await upgradeStatus(r, elsewhere, ['apaki.v1'], a), 429);
    await sleep(8000);
    assert.ok(held.every((c) => c.ws.readyState === WebSocket.OPEN), 'pinging sockets stay open');
    assert.equal(await upgradeStatus(r, elsewhere, ['apaki.v1'], a), 429, 'renewed leases still count after 8 s');
    clearInterval(timer);
    for (const c of held) c.close();
    await Promise.all(held.map((c) => c.closed));
    let status = 0;
    for (let i = 0; i < 50 && status !== 101; i++) {
      status = await upgradeStatus(r, elsewhere, ['apaki.v1'], a);
      if (status !== 101) await sleep(100);
    }
    assert.equal(status, 101, 'closed sockets hand their slots back');
  } finally {
    clearInterval(timer);
    await r.worker.stop();
  }
});

test('fairness: an address past its share of the day is refused and loses its sockets (4504); other addresses keep working', async () => {
  // Three connections fit in this address's share, a fourth does not.
  const price = costOf({ connects: 1 });
  const r = await startRelay({ IP_SHARE_USD: String(price * 3.5), REPORT_FRAMES: '3' });
  try {
    const a = IP(20);
    const b = IP(21);
    const room = await createRoom();
    const pc = await pcClient(r, room, a);
    const phone = await phoneClient(r, room.roomId, b);
    await pc.next(isJson('join'));
    const more = [await pcClient(r, await createRoom(), a), await pcClient(r, await createRoom(), a)];

    const refused = await upgradeAnswer(r, `/v1/rooms/${(await createRoom()).roomId}/phone`, ['apaki.v1'], a);
    assert.equal(refused.status, 429, 'one address opening many rooms is cut off');
    assert.match(refused.body, /This address has used its share of today's Apaki relay budget/);
    assert.ok(Number(refused.headers['retry-after']) >= 60, 'retry-after: until 00:00 UTC');
    assert.equal(await upgradeStatus(r, `/v1/rooms/${(await createRoom()).roomId}/phone`, ['apaki.v1'], b), 101, 'another address still connects');

    // Its open sockets go at their room's next report: a's PC sends a few frames to b's phone.
    for (let i = 0; i < 3; i++) pc.send(encodePcFrame(phone.ready.conn, new Uint8Array([i])));
    assert.equal((await within(pc.bye, 5000, 'bye')).code, CLOSE.IP_SHARE);
    // b's phone stays: its room just lost its PC.
    assert.deepEqual((await phone.next(isJson('pc'))).json, { t: 'pc', up: false });
    assert.equal(phone.ws.readyState, WebSocket.OPEN);
    for (const c of [...more, phone]) c.close();
  } finally { await r.worker.stop(); }
});

test('fairness: a room past its share of the day is closed (4505) and refused; other rooms keep working', async () => {
  // Two connections fit in a room's share; the first usage report does not.
  const r = await startRelay({ ROOM_SHARE_USD: String(2 * costOf({ connects: 1 }) + costOf({ reports: 1 }) / 2), REPORT_FRAMES: '3' });
  try {
    const room = await createRoom();
    const pc = await pcClient(r, room, IP(30));
    const phone = await phoneClient(r, room.roomId, IP(31));
    await pc.next(isJson('join'));
    const other = await createRoom();
    const pc2 = await pcClient(r, other, IP(32));
    const phone2 = await phoneClient(r, other.roomId, IP(33));
    await pc2.next(isJson('join'));

    for (let i = 0; i < 3; i++) phone.send(new Uint8Array([i]));
    assert.equal((await within(phone.bye, 5000, 'bye')).code, CLOSE.ROOM_SHARE);
    assert.equal((await within(pc.bye, 5000, 'bye')).code, CLOSE.ROOM_SHARE);
    const refused = await upgradeAnswer(r, `/v1/rooms/${room.roomId}/phone`, ['apaki.v1'], IP(34));
    assert.equal(refused.status, 429, 'the room is refused for the rest of the day, from any address');
    assert.match(refused.body, /This room has used its share of today's Apaki relay budget/);
    assert.equal(await upgradeStatus(r, `/v1/rooms/${room.roomId}/pc`, ['apaki.v1', `apaki-token.${room.token}`], IP(30)), 429, 'its PC too');

    // The other room is untouched (two frames: under REPORT_FRAMES, so no report).
    phone2.send(new Uint8Array([7]));
    assert.deepEqual(decodePcFrame((await pc2.next(isBin)).bin), { connId: phone2.ready.conn, payload: new Uint8Array([7]) });
    pc2.send(encodePcFrame(phone2.ready.conn, new Uint8Array([8])));
    assert.deepEqual((await phone2.next(isBin)).bin, new Uint8Array([8]));
    assert.equal(phone2.ws.readyState, WebSocket.OPEN);
    assert.equal(pc2.ws.readyState, WebSocket.OPEN);
    for (const c of [phone2, pc2]) c.close();
  } finally { await r.worker.stop(); }
});

test('private relay (wrangler env "private", RELAY_ONLY): rooms and presence only, no pages, no accounts', async () => {
  // Keep the environment's own ALLOWED_ORIGINS ("(none)": native clients only); startRelay would clear it.
  const priv = await startRelay({ ALLOWED_ORIGINS: '(none)' }, 'private');
  try {
    const get = (p, init) => priv.worker.fetch(`http://127.0.0.1${p}`, init);
    const front = await get('/');
    assert.equal(front.status, 200);
    const line = await front.text();
    assert.match(line, /private relay/);
    assert.match(line, /serves no pages and keeps no accounts/);
    assert.doesNotMatch(line, /<html/i, 'not the site');
    assert.match(await (await get('/health')).text(), /private relay/);

    // No static files at all: no phone page of any version, no front page, no stylesheet, no security.txt.
    const versions = fs.readdirSync(path.join(relayDir, 'site', 'v'));
    assert.ok(versions.length > 0);
    const paths = ['/index.html', '/site.css', '/.well-known/security.txt'];
    for (const v of versions) paths.push(`/v/${v}/`, `/v/${v}/index.html`, `/v/${v}/manifest.json`);
    for (const p of paths) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      await res.text();
    }

    // No account routes: 404, not 503 no-key (the code never reaches them).
    const json = { 'content-type': 'application/json' };
    for (const [method, p, body] of [['POST', '/v1/account/challenge', '{"purpose":"signin"}'], ['GET', '/v1/account'], ['DELETE', '/v1/account'], ['PUT', '/v1/account/vault', '{}'], ['POST', '/v1/account/signin', '{}']]) {
      const res = await get(p, { method, ...(body ? { headers: json, body } : {}) });
      assert.equal(res.status, 404, `${method} ${p}`);
      await res.text();
    }

    // Rooms and presence work as on the public relay.
    const room = await createRoom();
    const pres = await get(`/v1/rooms/${room.roomId}/presence`);
    assert.equal(pres.status, 200);
    assert.deepEqual(await pres.json(), { pc: false });
    const pc = await pcClient(priv, room);
    const phone = await phoneClient(priv, room.roomId);
    assert.equal(phone.ready.pc, true);
    await pc.next(isJson('join'));
    phone.send(new Uint8Array([1, 2]));
    assert.deepEqual(decodePcFrame((await pc.next(isBin)).bin), { connId: phone.ready.conn, payload: new Uint8Array([1, 2]) });
    pc.send(encodePcFrame(phone.ready.conn, new Uint8Array([3])));
    assert.deepEqual((await phone.next(isBin)).bin, new Uint8Array([3]));
    assert.deepEqual(await (await get(`/v1/rooms/${room.roomId}/presence`)).json(), { pc: true });

    // A browser always sends an Origin, so no web page can open phone sockets here.
    assert.equal(await upgradeStatus(priv, `/v1/rooms/${room.roomId}/phone`, ['apaki.v1'], null, { Origin: 'https://apaki.myrlin.io' }), 403);
    assert.equal(await upgradeStatus(priv, `/v1/rooms/${room.roomId}/phone`, ['apaki.v1'], null, { Origin: 'https://evil.test' }), 403);
    phone.close();
    pc.close();
  } finally { await priv.worker.stop(); }
});

test('ip limit: new connections from one address are limited per minute', async () => {
  const limited = await startRelay({ IP_LIMIT: 'on' });
  try {
    const { roomId } = await createRoom();
    const codes = [];
    for (let i = 0; i < 24; i++) codes.push(await upgradeStatus(limited, `/v1/rooms/${roomId}/phone`, ['apaki.v1']));
    assert.ok(codes.slice(0, 20).every((c) => c === 101 || c === 429), String(codes));
    assert.ok(codes.includes(429), `no 429 in ${codes}`);
  } finally { await limited.worker.stop(); }
});
