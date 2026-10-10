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
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unstable_dev } from 'wrangler';

import {
  createRoom, createPcIdentity, createDeviceIdentity, createPairingOffer, parsePairingUrl,
  PcSession, PhoneSession, roomUrl, relaySubprotocols, encodePcFrame, decodePcFrame, parseRelayControl, RELAY_CLOSE,
} from '../../apaki/remote/protocol.js';
import { CLOSE, DEFAULT_LIMITS, Bucket, readLimits, splitConn, prefixConn, originAllowed, parseProtocols, tokenFrom, roomIdForToken as relayRoomId, costOf, busyAdd, utcDay } from '../src/lib.js';

process.env.WRANGLER_SEND_METRICS = 'false';
const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, '..');

const TIGHT = { MAX_FRAME_BYTES: '1024', MAX_PHONES: '2', PHONE_FPS: '5', CONNECTS_PER_MINUTE: '6', IDLE_MS: '2500' };

async function startRelay(vars = {}) {
  const worker = await unstable_dev(path.join(relayDir, 'src/index.js'), {
    config: path.join(relayDir, 'wrangler.jsonc'),
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
function client(url, protocols) {
  const ws = new WebSocket(url, protocols);
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

async function pcClient(relay, room) {
  const c = client(roomUrl(relay.base, room.roomId, 'pc'), relaySubprotocols('pc', room.token));
  await c.opened;
  c.ready = (await c.next(isJson('ready'))).json;
  return c;
}

async function phoneClient(relay, roomId) {
  const c = client(roomUrl(relay.base, roomId, 'phone'), relaySubprotocols('phone'));
  await c.opened;
  c.ready = (await c.next(isJson('ready'))).json;
  return c;
}

/** The HTTP status of a raw WebSocket upgrade request (101 when it upgrades). */
function upgradeStatus(relay, urlPath, protocols) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': nodeRandomBytes(16).toString('base64') };
    if (protocols) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    const req = http.request({ host: '127.0.0.1', port: relay.port, path: urlPath, headers });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
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
  assert.deepEqual(RELAY_CLOSE, { REPLACED: CLOSE.REPLACED, KICKED: CLOSE.KICKED, RATE: CLOSE.RATE, TOO_LARGE: CLOSE.TOO_LARGE, ROOM_FULL: CLOSE.ROOM_FULL, IDLE: CLOSE.IDLE, BUDGET: CLOSE.BUDGET });
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
  // Frames without a PC are dropped, and the PC coming back is announced.
  phone2.send(new Uint8Array([5]));
  const back = await pcClient(normal, room);
  assert.deepEqual(back.ready.phones, [phone2.ready.conn]);
  assert.deepEqual((await phone2.next(isJson('pc'))).json, { t: 'pc', up: true });
  await assert.rejects(back.next(isBin, 300), /timed out/, 'the frame sent while the PC was away was dropped');
  phone2.close();
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
  const { roomId } = await createRoom();
  const phone = await phoneClient(tight, roomId);
  assert.equal(phone.ready.limits.framesPerSec, 5);
  for (let i = 0; i < 30; i++) phone.send(new Uint8Array([i]));
  assert.equal((await phone.closed).code, RELAY_CLOSE.RATE);
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
  // Two connections fit (about $0.45 per million each); the first report (10 s awake, about $0.000016) does not.
  const broke = await startRelay({ DAILY_BUDGET_USD: '0.000005', REPORT_FRAMES: '3' });
  try {
    const room = await createRoom();
    const pc = await pcClient(broke, room);
    const phone = await phoneClient(broke, room.roomId);
    for (let i = 0; i < 4; i++) phone.send(new Uint8Array([1, 2, 3]));
    const bye = await Promise.race([phone.bye, new Promise((_, rej) => setTimeout(() => rej(new Error('no bye')), 5000))]);
    assert.equal(bye.code, CLOSE.BUDGET);
    assert.equal((await pc.bye).code, CLOSE.BUDGET);
    assert.equal(await upgradeStatus(broke, `/v1/rooms/${room.roomId}/phone`, ['apaki.v1']), 503);
  } finally { await broke.worker.stop(); }
});

test('cost: what the guard counts', () => {
  assert.ok(Math.abs(costOf({ frames: 20e6 }) - 0.15) < 1e-9, '20 million frames are a million requests');
  assert.ok(Math.abs(costOf({ busyMs: 86_400_000 }) - 0.128 * 86_400 * 12.5e-6) < 1e-9, 'a room awake all day');
  assert.equal(busyAdd(0, 5000), 10_000);
  assert.equal(busyAdd(1000, 4000), 3000);
  assert.equal(busyAdd(1000, 60_000), 10_000);
  assert.equal(utcDay(Date.parse('2026-10-10T23:59:59Z')), '2026-10-10');
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
