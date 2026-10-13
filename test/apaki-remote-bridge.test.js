/**
 * Phone access, engine side (Track B part 2): what a phone may send
 * (remote-policy.js), how messages move inside the channel (wire.js), what is
 * saved and how (remote-store.js), and the bridge itself (remote.js) against
 * an in-memory relay that behaves like relay/src/index.js: pairing with the
 * PC's approval, commands rewritten into the phone's namespace, events routed
 * to the right phone only, big messages, reconnect, revocation and the
 * handshake timeout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PhoneSession, createDeviceIdentity, decodePcFrame, encodePcFrame, parsePairingUrl, MAX_JSON_BYTES, b64urlDecode, b64urlEncode, deviceIdFor,
} from '../apaki/remote/protocol.js';
import { Inbox, Outbox, WireError, utf8Length } from '../apaki/remote/wire.js';
import {
  MAX_PHONE_PANES, PHONE_OPS, checkPhoneCommand, hashText, parsePhoneId, phonePaneId, phoneView, routeEvent, windowOf,
} from '../apaki/engine/remote-policy.js';
import * as store from '../apaki/engine/remote-store.js';
import { RemoteBridge, isPlaceholder, relayUrl, webUrl, RELAY_PLACEHOLDER } from '../apaki/engine/remote.js';
import { APP_VERSION } from '../apaki/engine/app-version.js';
import { MIN_PHONE_APP } from '../apaki/remote/compat.js';

const DEV = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars, like a device id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-remote-test-'));

/* ---------------------------------------------------------------- policy */

test('policy: only allowlisted ops pass; billing, remote*, voice, Dig deeper and shell-ish ops are refused', () => {
  const ctx = { deviceId: DEV, paneExists: () => true, paneCount: () => 0 };
  // folder and askSearch left this list on 2026-10-12: a phone may move a session to a folder and ask Claude
  // (test/apaki-phone-parity.test.js holds those, with their access levels).
  for (const op of ['billing', 'billingOptions', 'remoteEnable', 'remotePairStart', 'remoteRevoke', 'remoteStatus', 'transcribe', 'digPrompt', 'warm', 'exec', 'readFile', 'stopSession', 'revealFolder', 'openExternal', '__proto__', 'constructor']) {
    const r = checkPhoneCommand({ op, reqId: 'r1', paneId: 'p1' }, ctx);
    assert.equal(r.ok, false, op);
    assert.equal(r.reqId, 'r1');
  }
  assert.equal(checkPhoneCommand(null, ctx).ok, false);
  assert.equal(checkPhoneCommand([1], ctx).ok, false);
  assert.ok(!PHONE_OPS.includes('billing') && !PHONE_OPS.some((op) => op.startsWith('remote')));
  // artifactGet only when the engine has it, and only for a session the phone has open.
  assert.equal(checkPhoneCommand({ op: 'artifactGet', id: 'a1', sessionId: 's-11111111' }, ctx).ok, false);
  const art = { ...ctx, hasOp: (op) => op === 'artifactGet', phoneSessions: () => ['s-11111111'] };
  assert.equal(checkPhoneCommand({ op: 'artifactGet', id: 'a1', sessionId: 's-22222222' }, art).ok, false);
  const ok = checkPhoneCommand({ op: 'artifactGet', id: 'a1', sessionId: 's-11111111', rev: 2, path: 'C:/Windows/x' }, art);
  assert.deepEqual(ok, { ok: true, cmd: { op: 'artifactGet', id: 'a1', sessionId: 's-11111111', rev: 2 } });
});

test('policy: pane and request ids are put in the phone namespace; unknown fields are dropped', () => {
  const ctx = { deviceId: DEV, paneExists: () => false, paneCount: () => 0, knownCwd: (c) => c === 'C:\\Users\\a\\proj' };
  const r = checkPhoneCommand({ op: 'open', reqId: 'r7', paneId: 'p1', sessionId: '0e7f4b4e-1111-2222-3333-444455556666', cwd: 'C:\\Windows\\System32', warm: false, model: 'claude-haiku-5-5', images: ['x'], billing: 'sub', exec: 'calc' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cmd, { op: 'open', reqId: `phone:${DEV}:r7`, paneId: `phone:${DEV}:p1`, sessionId: '0e7f4b4e-1111-2222-3333-444455556666', cwd: null, warm: false, model: 'claude-haiku-5-5' });
  // A folder some listed session uses is fine for a new conversation.
  assert.equal(checkPhoneCommand({ op: 'open', paneId: 'p2', cwd: 'C:\\Users\\a\\proj' }, ctx).cmd.cwd, 'C:\\Users\\a\\proj');
  // Bad ids are refused, not cleaned up.
  assert.equal(checkPhoneCommand({ op: 'open', paneId: '../desk' }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'open', paneId: `phone:${DEV}:p1` }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'open', paneId: 'p1', sessionId: 'x; rm -rf /' }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'open', paneId: 'p1', mode: 'yolo' }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'search', reqId: 'r1 r2', query: 'x' }, ctx).ok, false);
  // Settings take only known values.
  const live = { ...ctx, paneExists: () => true };
  assert.equal(checkPhoneCommand({ op: 'effort', paneId: 'p1', effort: 'max' }, live).ok, true);
  assert.equal(checkPhoneCommand({ op: 'effort', paneId: 'p1', effort: 'ultra' }, live).ok, false);
  assert.equal(checkPhoneCommand({ op: 'model', paneId: 'p1', model: 'gpt-5' }, live).ok, false);
  assert.equal(checkPhoneCommand({ op: 'mode', paneId: 'p1', mode: 'plan' }, live).cmd.mode, 'plan');
});

test('policy: a phone acts only on its own panes, within a pane limit', () => {
  const mine = new Set([phonePaneId(DEV, 'p1')]);
  const ctx = { deviceId: DEV, paneExists: (id) => mine.has(id), paneCount: () => mine.size };
  assert.equal(checkPhoneCommand({ op: 'send', paneId: 'p1', text: 'hi' }, ctx).ok, true);
  assert.equal(checkPhoneCommand({ op: 'send', paneId: 'p9', text: 'hi' }, ctx).ok, false, 'no pane p9 yet');
  assert.equal(checkPhoneCommand({ op: 'interrupt', paneId: 'p9' }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'close', paneId: 'p9' }, ctx).ok, true, 'closing a pane that is gone is harmless');
  const full = { ...ctx, paneExists: () => false, paneCount: () => MAX_PHONE_PANES };
  assert.equal(checkPhoneCommand({ op: 'open', paneId: 'p7' }, full).ok, false);
  assert.equal(checkPhoneCommand({ op: 'attach', paneId: 'p7' }, full).ok, false);
  // Messages: text and images only, in limits.
  assert.equal(checkPhoneCommand({ op: 'send', paneId: 'p1', text: '' }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'send', paneId: 'p1', text: 'x', images: [{ media_type: 'image/svg+xml', data: 'AAAA' }] }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'send', paneId: 'p1', text: 'x', images: [{ media_type: 'image/png', data: 'AA<script>' }] }, ctx).ok, false);
  const img = checkPhoneCommand({ op: 'send', paneId: 'p1', text: '', images: [{ media_type: 'image/jpeg', data: 'QUJD', url: 'data:...' }] }, ctx);
  assert.deepEqual(img.cmd.images, [{ media_type: 'image/jpeg', data: 'QUJD' }]);
});

test('policy: a phone may only answer questions asked in its own panes', () => {
  const asks = new Map([['ask-1', phonePaneId(DEV, 'p1')], ['ask-2', 'pdesk'], ['ask-3', phonePaneId('ZZZZZZZZZZZZZZZZZZZZZZ', 'p1')]]);
  const ctx = { deviceId: DEV, askPane: (id) => asks.get(id) ?? null };
  const ok = checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'allow', updatedInput: { answers: { q: 'a' } }, extra: 1 } }, ctx);
  assert.deepEqual(ok.cmd, { op: 'answer', askId: 'ask-1', result: { behavior: 'allow', updatedInput: { answers: { q: 'a' } } } });
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-2', result: { behavior: 'allow' } }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-3', result: { behavior: 'allow' } }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-9', result: { behavior: 'allow' } }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'run' } }, ctx).ok, false);
});

test('policy: events about a phone pane or request go to that phone with its own ids back; others stay on the desktop', () => {
  const r = routeEvent({ ev: 'opened', reqId: `phone:${DEV}:r3`, paneId: `phone:${DEV}:p1`, sessionId: 's' });
  assert.equal(r.deviceId, DEV);
  assert.deepEqual(r.ev, { ev: 'opened', reqId: 'r3', paneId: 'p1', sessionId: 's' });
  assert.equal(routeEvent({ ev: 'sessions', reqId: `phone:${DEV}:r4` }).ev.reqId, 'r4');
  assert.equal(routeEvent({ ev: 'opened', paneId: 'p1' }), null);
  assert.equal(routeEvent({ ev: 'sessions', reqId: 'r4' }), null);
  assert.equal(routeEvent({ ev: 'glass' }), null);
  // Another window's pane id never leaks into a phone event.
  assert.equal(routeEvent({ ev: 'open_elsewhere', paneId: `phone:${DEV}:p1`, otherPane: 'pdesk' }).ev.otherPane, null);
  assert.equal(routeEvent({ ev: 'open_elsewhere', paneId: `phone:${DEV}:p1`, otherPane: `phone:${DEV}:p2` }).ev.otherPane, 'p2');
  assert.deepEqual(parsePhoneId(`phone:${DEV}:p1`), { deviceId: DEV, local: 'p1' });
  assert.equal(parsePhoneId('phone:short:p1'), null);
  assert.equal(windowOf('p1'), 'desktop');
  assert.equal(windowOf(`phone:${DEV}:p1`), `phone:${DEV}`);
  // What a phone sees: the PC's voice as it is (the phone's mic uses the PC's Whisper, 2026-10-12), trimmed list.
  const v = phoneView({ ev: 'sessions', voice: true, items: [{ id: 'a', firstPrompt: 'x'.repeat(5000) }] });
  assert.equal(v.voice, true);
  assert.equal(v.items[0].firstPrompt.length, 200);
  assert.notEqual(hashText('abc'), hashText('abd'));
});

/* ------------------------------------------------------------------ wire */

/** A stand-in for an open protocol session: frames are the JSON or chunk itself. */
function fakeSession() {
  return {
    sendJsonText: (text) => Promise.resolve({ json: JSON.parse(text) }),
    sendChunk: (c) => Promise.resolve({ chunk: { ...c, data: c.data.slice() } }),
  };
}

test('wire: events are batched, sent in order, and big messages are chunked and put back together', async () => {
  const frames = [];
  const out = new Outbox({ session: fakeSession(), write: (f) => frames.push(f), flushMs: 5 });
  out.push({ ev: 'sdk', n: 1 });
  out.push({ ev: 'sdk', n: 2 });
  out.push({ ev: 'sdk', n: 3 });
  await sleep(20);
  await out.chain;
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].json, { t: 'evs', list: [{ ev: 'sdk', n: 1 }, { ev: 'sdk', n: 2 }, { ev: 'sdk', n: 3 }] });
  // A message too big for a record, between two small ones, keeps its place.
  frames.length = 0;
  const huge = { ev: 'history', text: 'é'.repeat(300_000) };
  out.push({ ev: 'a' });
  out.push(huge);
  await out.send({ t: 'after' });
  const inbox = new Inbox();
  const got = [];
  for (const f of frames) {
    const m = f.json ? inbox.json(f.json) : inbox.chunk(f.chunk);
    if (m) got.push(m);
  }
  assert.ok(frames.length > 4, 'the big one went as several chunks');
  assert.deepEqual(got[0], { t: 'evs', list: [{ ev: 'a' }] });
  assert.deepEqual(got[1], { t: 'evs', list: [huge] });
  assert.deepEqual(got[2], { t: 'after' });
  assert.equal(utf8Length('é€😀a'), 2 + 3 + 4 + 1);
});

test('wire: the inbox refuses chunks out of line', () => {
  const inbox = new Inbox({ maxBytes: 1000, maxStreams: 1 });
  assert.throws(() => inbox.chunk({ stream: 1, seq: 0, last: true, data: new Uint8Array(1) }), WireError);
  assert.throws(() => inbox.json({ t: 'big', stream: 1, bytes: 5000 }), WireError);
  inbox.json({ t: 'big', stream: 1, bytes: 4 });
  assert.throws(() => inbox.json({ t: 'big', stream: 2, bytes: 4 }), WireError, 'one stream at a time here');
  assert.throws(() => inbox.chunk({ stream: 1, seq: 1, last: false, data: new Uint8Array(2) }), WireError);
  const b = new Inbox();
  b.json({ t: 'big', stream: 3, bytes: 2 });
  assert.throws(() => b.chunk({ stream: 3, seq: 0, last: true, data: new TextEncoder().encode('{') }), WireError);
  assert.equal(new Inbox().json({ t: 'evs', list: [] }).t, 'evs');
});

/* ----------------------------------------------------------------- store */

test('store: secrets are kept apart from the public state, which holds public keys only', async () => {
  const dir = tmp();
  const before = process.env.APAKI_REMOTE_PROTECT;
  process.env.APAKI_REMOTE_PROTECT = 'file';
  try {
    assert.equal(store.loadState(dir).enabled, false);
    assert.equal(await store.loadSecret(dir), null);
    const scheme = await store.saveSecret({ identity: { jwk: { d: 'PRIVATE-D' } }, token: 'TOKEN-123', psks: { [DEV]: 'PSK-XYZ' } }, dir);
    assert.equal(scheme, 'file');
    store.saveState({ v: 1, enabled: true, roomId: 'room', pcPub: 'pub', createdAt: 'now', devices: [{ id: DEV, pub: 'devpub', name: 'Pixel', pairedAt: 'then', psk: 'PSK-XYZ', extra: 1 }] }, dir);
    const pub = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.ok(!pub.includes('PSK-XYZ') && !pub.includes('PRIVATE-D') && !pub.includes('TOKEN-123'));
    assert.deepEqual(Object.keys(JSON.parse(pub).devices[0]).sort(), ['id', 'lastSeen', 'name', 'pairedAt', 'pub']);
    const s = await store.loadSecret(dir);
    assert.equal(s.psks[DEV], 'PSK-XYZ');
    assert.ok(fs.existsSync(path.join(dir, '_WHY_THIS_IS_HERE.md')));
  } finally {
    if (before === undefined) delete process.env.APAKI_REMOTE_PROTECT; else process.env.APAKI_REMOTE_PROTECT = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: on Windows the secrets are sealed with DPAPI and open again', { skip: !store.dpapiAvailable() }, async () => {
  const dir = tmp();
  try {
    const scheme = await store.saveSecret({ identity: { jwk: { d: 'PRIVATE-D' } }, token: 'TOKEN-456', psks: {} }, dir);
    assert.equal(scheme, 'dpapi-user');
    const raw = fs.readFileSync(path.join(dir, 'secret.json'), 'utf8');
    assert.ok(!raw.includes('PRIVATE-D') && !Buffer.from(JSON.parse(raw).data, 'base64').toString('latin1').includes('TOKEN-456'));
    assert.equal((await store.loadSecret(dir)).token, 'TOKEN-456');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the relay and web addresses: the hosted ones by default, yours when set; placeholders say not set up', () => {
  assert.equal(relayUrl({}), 'wss://apaki.myrlin.io');
  assert.equal(webUrl({}), 'https://apaki.myrlin.io/');
  assert.equal(isPlaceholder(relayUrl({})), false);
  assert.equal(isPlaceholder(RELAY_PLACEHOLDER), true);
  assert.equal(webUrl({ APAKI_WEB_URL: 'https://mine.example/' }), 'https://mine.example/');
  assert.equal(relayUrl({ APAKI_RELAY_URL: 'wss://relay.example' }), 'wss://relay.example');
  assert.equal(isPlaceholder('ws://127.0.0.1:8787'), false);
  assert.equal(store.remoteDir().replace(/\\/g, '/').endsWith(process.env.APAKI_REMOTE_DIR ? process.env.APAKI_REMOTE_DIR.replace(/\\/g, '/') : '.claude/latch/remote'), true);
});

/* ------------------------------------------------- the bridge, end to end */

/**
 * An in-memory relay with the behaviour of relay/src/index.js that the bridge
 * relies on: ready/join/leave/bye control texts, connection-id framing on the
 * PC socket, ping/pong, kick. `WS` is the WebSocket class handed to the bridge.
 */
function fakeRelay() {
  const relay = { pc: null, phones: new Map(), nextConn: 1, pcSockets: 0, frames: [] };
  const emitTo = (sock, type, data) => { for (const f of sock.listeners[type] || []) f(data); };
  class WS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.listeners = {};
      relay.pcSockets += 1;
      queueMicrotask(() => {
        if (relay.pc) relay.pc.close();
        relay.pc = this;
        this.readyState = 1;
        emitTo(this, 'open', {});
        emitTo(this, 'message', { data: JSON.stringify({ t: 'ready', role: 'pc', phones: [...relay.phones.keys()], limits: {} }) });
        for (const ph of relay.phones.values()) ph.control({ t: 'pc', up: true });
      });
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(data) {
      if (this.readyState !== 1) return;
      if (typeof data === 'string') {
        if (data === 'ping') { queueMicrotask(() => emitTo(this, 'message', { data: 'pong' })); return; }
        const m = JSON.parse(data);
        if (m.t === 'kick') relay.phones.get(m.conn)?.kicked();
        return;
      }
      const { connId, payload } = decodePcFrame(new Uint8Array(data));
      relay.frames.push({ dir: 'to-phone', bytes: payload.slice() });
      relay.phones.get(connId)?.deliver(payload.slice());
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (relay.pc === this) relay.pc = null;
      queueMicrotask(() => emitTo(this, 'close', { code: 1000 }));
    }
  }
  relay.WS = WS;
  /** A phone socket: frames in, plus what the relay told it. */
  relay.phone = () => {
    const conn = relay.nextConn++;
    const ph = {
      conn, inbox: [], controls: [], waiters: [], gone: false,
      deliver(bytes) { ph.inbox.push(bytes); ph.wake(); },
      control(m) { ph.controls.push(m); ph.wake(); },
      kicked() { ph.gone = true; relay.phones.delete(conn); ph.control({ t: 'bye', code: 4003 }); relay.pc && emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'leave', conn }) }); },
      wake() { for (const w of ph.waiters.splice(0)) w(); },
      send(frame) {
        relay.frames.push({ dir: 'to-pc', bytes: frame.slice() });
        if (relay.pc) emitTo(relay.pc, 'message', { data: encodePcFrame(conn, frame).buffer });
      },
      async next(ms = 4000) {
        const end = Date.now() + ms;
        while (!ph.inbox.length) {
          if (Date.now() > end) throw new Error('no frame for the phone');
          await new Promise((r) => { ph.waiters.push(r); setTimeout(r, 50); });
        }
        return ph.inbox.shift();
      },
    };
    relay.phones.set(conn, ph);
    if (relay.pc) emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'join', conn }) });
    return ph;
  };
  return relay;
}

/** Drives a PhoneSession over a fake phone socket and collects the PC's messages. */
async function phoneClient(ph, session) {
  const inbox = new Inbox();
  const c = { session, messages: [], events: [], sas: null, pairing: null, alerts: [] };
  c.pump = async (until, ms = 4000) => {
    const end = Date.now() + ms;
    while (!until()) {
      if (Date.now() > end) throw new Error('phone gave up waiting');
      let frame;
      try { frame = await ph.next(Math.max(50, end - Date.now())); } catch { continue; }
      const step = await session.receive(frame);
      for (const f of step.send) ph.send(f);
      for (const ev of step.events) {
        if (ev.type === 'sas') c.sas = ev.sas;
        else if (ev.type === 'paired') c.pairing = ev.pairing;
        else if (ev.type === 'json') { const m = inbox.json(ev.value); if (m) c.messages.push(m); }
        else if (ev.type === 'chunk') { const m = inbox.chunk(ev); if (m) c.messages.push(m); }
        else if (ev.type === 'alert' || ev.type === 'close' || ev.type === 'error') c.alerts.push(ev);
      }
      for (const m of c.messages.splice(0)) {
        if (m.t === 'evs') c.events.push(...m.list);
        else c.events.push({ wire: m });
      }
    }
  };
  c.out = new Outbox({ session, write: (f) => ph.send(f), flushMs: 1 });
  c.cmd = (cmd) => c.out.send({ t: 'cmd', cmd });
  ph.send(await session.start());
  return c;
}

function bridgeFor(relay, dir, extra = {}) {
  const desktop = [];
  const dispatched = [];
  const panes = new Map();
  const asks = new Map();
  const b = new RemoteBridge({
    emit: (e) => desktop.push(e),
    dispatch: (c) => { dispatched.push(c); if (c.op === 'open' || c.op === 'attach') panes.set(c.paneId, { sessionId: c.sessionId, running: true, busy: false }); if (c.op === 'close') panes.delete(c.paneId); },
    readyEvent: () => ({ ev: 'ready', model: 'claude-opus-5-5', voice: true }),
    engine: {
      paneExists: (id) => panes.has(id),
      paneCount: (dev) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev).length,
      phonePanes: (dev) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev),
      paneInfo: (id) => panes.get(id) || null,
      askPane: (id) => asks.get(id) || null,
      knownCwd: () => false,
      phoneSessions: () => [],
      hasOp: () => false,
    },
    dir,
    WebSocket: relay.WS,
    relay: 'ws://127.0.0.1:9',
    web: 'http://127.0.0.1:9/',
    pcName: 'Test PC',
    log: () => {},
    pageCheck: false, // the page check has its own tests below
    ...extra,
  });
  return { b, desktop, dispatched, panes, asks, last: () => desktop[desktop.length - 1] };
}

const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };

test('bridge: pair with approval, commands land in the phone namespace, events reach only that phone', async () => {
  const dir = tmp();
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const relay = fakeRelay();
  const { b, desktop, dispatched, last } = bridgeFor(relay, dir);
  try {
    await b.op({ op: 'remoteEnable', reqId: 'd1' });
    await until(() => b.status === 'online');
    assert.equal(relay.pc.protocols[1].startsWith('apaki-token.'), true, 'the PC proves the room with its token');
    await b.op({ op: 'remotePairStart', reqId: 'd2' });
    const { url } = last().pairing;
    assert.match(url, /^http:\/\/127\.0\.0\.1:9\/#p=/);

    const ph = relay.phone();
    await until(() => b.conns.has(ph.conn));
    const device = await createDeviceIdentity();
    const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(url), name: 'Test phone <b>' }));
    await phone.pump(() => phone.sas);
    await until(() => last().request);
    const req = last().request;
    assert.equal(req.sas, phone.sas, 'both screens show the same code');
    assert.equal(req.name, 'Test phone <b>');
    assert.equal(last().pairing, null, 'the QR is spent');

    await b.op({ op: 'remotePairDecision', approve: true });
    await phone.pump(() => phone.pairing && phone.events.some((e) => e.ev === 'ready'));
    const hello = phone.events.find((e) => e.wire?.t === 'hello');
    assert.equal(hello.wire.pcName, 'Test PC');
    assert.ok(!hello.wire.ops.includes('billing'));
    // The phone sees the PC's voice as it is and may send it audio (its mic goes to the PC's Whisper, 2026-10-12).
    assert.equal(phone.events.find((e) => e.ev === 'ready').voice, true);
    assert.ok(hello.wire.ops.includes('transcribe'));
    const st = last();
    assert.equal(st.devices.length, 1);
    assert.equal(st.devices[0].connected, true);
    assert.equal(st.devices[0].name, 'Test phone <b>');
    const deviceId = st.devices[0].id;
    assert.equal(phone.pairing.deviceId, deviceId);
    const saved = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.ok(saved.includes(deviceId) && !saved.includes(phone.pairing.psk), 'the device psk is not in the public state');

    // A command from the phone: checked, rewritten, dispatched.
    await phone.cmd({ op: 'open', reqId: 'r1', paneId: 'p1', sessionId: null, warm: true, model: 'claude-haiku-5-5' });
    await until(() => dispatched.length === 1);
    assert.deepEqual(dispatched[0], { op: 'open', reqId: `phone:${deviceId}:r1`, paneId: `phone:${deviceId}:p1`, sessionId: null, cwd: null, warm: true, model: 'claude-haiku-5-5' });
    // A refused one: the phone hears why, nothing runs.
    await phone.cmd({ op: 'billingOptions', reqId: 'r2', paneId: 'p1' });
    await phone.cmd({ op: 'remoteRevoke', reqId: 'r3', deviceId });
    await phone.cmd({ op: '__proto__', reqId: 'r4' });
    await phone.pump(() => phone.events.filter((e) => e.refused).length === 3);
    assert.equal(phone.events.find((e) => e.reqId === 'r2').message, 'Billing is chosen on the PC.');
    assert.equal(typeof phone.events.find((e) => e.reqId === 'r4').message, 'string');
    assert.equal(dispatched.length, 1);
    assert.equal(b.state.devices.length, 1, 'a phone cannot remove devices');

    // Routing: its own events come back with its ids; the desktop's do not go there.
    assert.equal(b.route({ ev: 'opened', reqId: `phone:${deviceId}:r1`, paneId: `phone:${deviceId}:p1`, sessionId: 'sess-0001' }), true);
    assert.equal(b.route({ ev: 'sdk', paneId: 'pdesk', msg: { secret: 'DESKTOP-ONLY' } }), false);
    assert.equal(b.route({ ev: 'folders', folders: [] }), false, 'broadcasts also reach the desktop');
    const big = 'z'.repeat(MAX_JSON_BYTES * 2);
    b.route({ ev: 'history', paneId: `phone:${deviceId}:p1`, messages: [{ text: big }] });
    await phone.pump(() => phone.events.some((e) => e.ev === 'history'));
    const opened = phone.events.find((e) => e.ev === 'opened');
    assert.equal(opened.paneId, 'p1');
    assert.equal(opened.reqId, 'r1');
    assert.equal(phone.events.find((e) => e.ev === 'history').messages[0].text.length, big.length);
    assert.ok(phone.events.some((e) => e.ev === 'folders'));
    assert.ok(!JSON.stringify(phone.events).includes('DESKTOP-ONLY'));
    assert.ok(desktop.every((e) => e.ev === 'remote'), 'the desktop got only status here');
    // Phone panes are named after the phone for the takeover cards.
    assert.equal(b.windowName(`phone:${deviceId}:p1`), 'Test phone <b>');
    assert.equal(b.windowName('pdesk'), null);

    // Same list twice: sent once.
    const list = { ev: 'sessions', reqId: `phone:${deviceId}:r9`, items: [{ id: 'a', title: 't' }], folders: [] };
    b.route(list);
    b.route({ ...list });
    await sleep(50);
    await phone.pump(() => phone.events.some((e) => e.ev === 'sessions'));
    await sleep(50);
    assert.equal(phone.events.filter((e) => e.ev === 'sessions').length, 1);

    // Reconnect: a fresh connection with the saved pairing opens without the QR.
    const ph2 = relay.phone();
    await until(() => b.conns.has(ph2.conn));
    const again = await phoneClient(ph2, new PhoneSession({ device, pairing: JSON.parse(JSON.stringify(phone.pairing)) }));
    await again.pump(() => again.events.some((e) => e.ev === 'ready'));
    assert.ok(again.events.some((e) => e.ev === 'folders'), 'a new connection gets the cached broadcasts');

    // A restored pane still open in the engine re-attaches instead of restarting.
    dispatched.length = 0;
    await again.cmd({ op: 'open', reqId: 'r5', paneId: 'p1', sessionId: 'sess-0001', warm: false });
    await until(() => dispatched.length === 1);
    // (the fake engine recorded p1 with sessionId null from the first open)
    assert.equal(dispatched[0].op, 'open');
    b.engine.paneInfo = () => ({ sessionId: 'sess-0001', running: true, busy: false });
    await again.cmd({ op: 'open', reqId: 'r6', paneId: 'p1', sessionId: 'sess-0001', warm: false });
    await until(() => dispatched.length === 2);
    assert.equal(dispatched[1].op, 'attach');

    // Revoke from the desktop: disconnected now, panes closed, and it cannot come back.
    dispatched.length = 0;
    await b.op({ op: 'remoteRevoke', deviceId });
    assert.equal(last().devices.length, 0);
    assert.ok(ph.gone && ph2.gone, 'both of its connections were kicked');
    assert.ok(dispatched.some((c) => c.op === 'close' && c.paneId === `phone:${deviceId}:p1`));
    const ph3 = relay.phone();
    await until(() => b.conns.has(ph3.conn));
    const banned = await phoneClient(ph3, new PhoneSession({ device, pairing: JSON.parse(JSON.stringify(phone.pairing)) }));
    await banned.pump(() => banned.alerts.length);
    assert.equal(banned.alerts[0].code, 'unknown-device');
  } finally {
    b.stop();
    delete process.env.APAKI_REMOTE_PROTECT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: deny, a silent phone timing out, and keys that survive a restart', async () => {
  const dir = tmp();
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const relay = fakeRelay();
  let { b, last } = bridgeFor(relay, dir, { handshakeMs: 120 });
  try {
    await b.op({ op: 'remoteEnable' });
    await until(() => b.status === 'online');
    const roomId = b.state.roomId;
    await b.op({ op: 'remotePairStart' });
    const ph = relay.phone();
    await until(() => b.conns.has(ph.conn));
    const phone = await phoneClient(ph, new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(last().pairing.url), name: 'Stranger' }));
    await phone.pump(() => phone.sas);
    await until(() => last().request);
    await b.op({ op: 'remotePairDecision', approve: false });
    await phone.pump(() => phone.alerts.length);
    assert.equal(phone.alerts[0].code, 'rejected');
    assert.equal(last().devices.length, 0);

    // Connects and never says anything: dropped after the handshake time.
    const quiet = relay.phone();
    await until(() => b.conns.has(quiet.conn));
    await until(() => quiet.gone, 2000);

    // A restart keeps the room and identity (so paired phones find the PC again).
    b.stop();
    ({ b, last } = bridgeFor(relay, dir));
    await b.ready;
    await until(() => b.status === 'online');
    assert.equal(b.state.roomId, roomId);
    await b.op({ op: 'remoteDisable' });
    assert.equal(last().state, 'off');
    assert.equal(last().enabled, false);
  } finally {
    b.stop();
    delete process.env.APAKI_REMOTE_PROTECT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: with the placeholder relay it says "not set up" and never dials out', async () => {
  const dir = tmp();
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const relay = fakeRelay();
  const { b, last } = bridgeFor(relay, dir, { relay: RELAY_PLACEHOLDER });
  try {
    await b.op({ op: 'remoteEnable' });
    assert.equal(last().state, 'unconfigured');
    assert.equal(last().relayConfigured, false);
    await b.op({ op: 'remotePairStart', reqId: 'x' });
    assert.match(last().opError, /not set up/);
    assert.equal(relay.pcSockets, 0);
  } finally {
    b.stop();
    delete process.env.APAKI_REMOTE_PROTECT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: no pairing code unless the phone page checks out, and the code opens that exact version', async () => {
  const dir = tmp();
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const relay = fakeRelay();
  const base = { version: 'abc123def456', url: 'http://127.0.0.1:9/v/abc123def456/', files: 40, missing: [], at: Date.now() };
  let page = { ...base, state: 'differs', differs: ['app.js'] };
  let checks = 0;
  const { b, last } = bridgeFor(relay, dir, { pageCheck: async () => { checks++; return page; } });
  try {
    await b.op({ op: 'remoteEnable' });
    await until(() => b.status === 'online');
    await b.op({ op: 'remotePairStart', reqId: 'p1' });
    assert.match(last().opError, /will not show a pairing code/);
    assert.equal(last().pairing, null, 'no code for a page that is not the one this Apaki builds');
    assert.equal(last().page.state, 'differs');
    page = { ...base, state: 'missing', differs: [] };
    await b.op({ op: 'remotePairStart', reqId: 'p2' });
    assert.match(last().opError, /not published/);
    page = { ...base, state: 'ok', differs: [] };
    await b.op({ op: 'remotePairStart', reqId: 'p3' });
    assert.match(last().pairing.url, /^http:\/\/127\.0\.0\.1:9\/v\/abc123def456\/#p=/);
    assert.match(last().page.text, /serves exactly/);
    // A fresh match is reused for the next code.
    const n = checks;
    await b.op({ op: 'remotePairStart', reqId: 'p4' });
    assert.equal(checks, n);
  } finally {
    b.stop();
    delete process.env.APAKI_REMOTE_PROTECT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: a paired phone links an Apaki account (allowed on the PC); any phone with the account key connects as it; unlink removes it', async () => {
  const dir = tmp();
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const relay = fakeRelay();
  const { b, last } = bridgeFor(relay, dir);
  try {
    await b.op({ op: 'remoteEnable' });
    await until(() => b.status === 'online');
    await b.op({ op: 'remotePairStart' });
    const ph = relay.phone();
    await until(() => b.conns.has(ph.conn));
    const device = await createDeviceIdentity();
    const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(last().pairing.url), name: 'iPhone (Safari)' }));
    await phone.pump(() => phone.sas);
    await until(() => last().request);
    await b.op({ op: 'remotePairDecision', approve: true });
    await phone.pump(() => phone.pairing && phone.events.some((e) => e.ev === 'ready'));
    const hello = phone.events.find((e) => e.wire?.t === 'hello').wire;
    // 2026-10-10: Connected by default; account-link is held for an Allow on the PC ('account-ask'), never added at once.
    assert.equal(hello.mode, 'connected');
    assert.equal(hello.cap, 'full');
    assert.ok(hello.features.includes('account-ask'), 'the PC says it asks before taking an account');
    assert.ok(!hello.features.includes('account'), 'the old at-once link is not offered, so an older page does not try it');
    assert.equal(hello.asAccount, undefined);

    // Bad keys and the phone's own key are refused.
    await phone.out.send({ t: 'account-link', reqId: 'q0', pub: 'not-a-key', name: 'Arthur', wait: true });
    await phone.out.send({ t: 'account-link', reqId: 'q1', pub: b64urlEncode(device.pub), name: 'Arthur', wait: true });
    await phone.pump(() => phone.events.filter((e) => e.wire?.t === 'account-linked').length === 2);
    const refused = phone.events.filter((e) => e.wire?.t === 'account-linked').map((e) => e.wire);
    assert.ok(refused.every((m) => m.error && !m.psk), JSON.stringify(refused));

    // The account's device key becomes one more paired device, with its own psk.
    const acct = await createDeviceIdentity({ extractable: true });
    await phone.out.send({ t: 'account-link', reqId: 'q2', pub: b64urlEncode(acct.pub), name: '  Arthur\u0007  ', wait: true });
    // Held: the phone hears pending, the PC shows who asks, and nothing is added before Allow.
    await phone.pump(() => phone.events.some((e) => e.wire?.t === 'pending' && e.wire.reqId === 'q2'));
    await until(() => last().linkRequest);
    assert.equal(last().linkRequest.account, 'Arthur');
    assert.equal(last().linkRequest.by, 'iPhone (Safari)');
    assert.equal(last().devices.length, 1, 'nothing added yet');
    await b.op({ op: 'remoteLinkDecision', approve: true, cap: 'noshell' });
    await phone.pump(() => phone.events.some((e) => e.wire?.t === 'account-linked' && e.wire.reqId === 'q2'));
    const linked = phone.events.find((e) => e.wire?.t === 'account-linked' && e.wire.reqId === 'q2').wire;
    assert.equal(linked.error, undefined);
    assert.equal(linked.deviceId, await deviceIdFor(acct.pub));
    assert.equal(linked.pcName, 'Test PC');
    assert.equal(b64urlDecode(linked.psk).length, 32);
    await until(() => last().devices.length === 2);
    const rec = last().devices.find((d) => d.kind === 'account');
    assert.equal(rec.name, 'Apaki account (Arthur)');
    assert.equal(rec.by, 'iPhone (Safari)');
    assert.equal(rec.cap, 'noshell', 'the access chosen at Allow');
    assert.equal(last().linkRequest, null);
    const saved = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.ok(!saved.includes(linked.psk), 'the account psk stays out of the public state');

    // Another phone, never paired, with the account's key and the vault's record: it reconnects as the account.
    const ph2 = relay.phone();
    await until(() => b.conns.has(ph2.conn));
    const pairing = { v: 1, roomId: phone.pairing.roomId, relay: phone.pairing.relay, pcPub: phone.pairing.pcPub, pcName: linked.pcName, deviceId: linked.deviceId, psk: linked.psk, pairedAt: new Date().toISOString() };
    const other = await phoneClient(ph2, new PhoneSession({ device: acct, pairing }));
    await other.pump(() => other.events.some((e) => e.wire?.t === 'hello'));
    const acctHello = other.events.find((e) => e.wire?.t === 'hello').wire;
    assert.equal(acctHello.asAccount, true);
    // 2026-10-11: held after hello, no ready event, until the phone behind the account proves its own key (ENROLL.md).
    assert.ok(acctHello.features.includes('phone-key') && acctHello.features.includes('enroll'));
    assert.equal(b64urlDecode(acctHello.nonce).length, 16);
    await sleep(60);
    assert.ok(!other.events.some((e) => e.ev === 'ready'), 'held: nothing before the phone key');
    assert.equal(last().devices.find((d) => d.kind === 'account').connected, false, 'a held connection is not a connected phone');
    const pixelKey = await createDeviceIdentity();
    const nonce = b64urlDecode(acctHello.nonce);
    const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pixelKey.privateKey, new Uint8Array([...new TextEncoder().encode('apaki/v1 via'), ...nonce, ...pixelKey.pub, ...new TextEncoder().encode('Pixel (Chrome)')])));
    await other.out.send({ t: 'via', name: 'Pixel (Chrome)', pub: b64urlEncode(pixelKey.pub), sig: b64urlEncode(sig) });
    await other.pump(() => other.events.some((e) => e.ev === 'ready'));
    assert.ok(other.events.some((e) => e.wire?.t === 'phone-ok'));
    await until(() => last().devices.find((d) => d.kind === 'account')?.via?.includes('Pixel (Chrome)'));
    assert.equal(last().devices.find((d) => d.kind === 'account').connected, true);

    // Unlink: only an account device can be removed this way, and then it cannot connect again.
    await other.out.send({ t: 'account-unlink', reqId: 'q3', deviceId: phone.pairing.deviceId });
    await other.pump(() => other.events.some((e) => e.wire?.t === 'account-unlinked'));
    assert.ok(other.events.find((e) => e.wire?.t === 'account-unlinked').wire.error, 'a phone is not an account');
    assert.equal(last().devices.length, 2);
    await other.out.send({ t: 'account-unlink', reqId: 'q4', deviceId: linked.deviceId });
    await until(() => last().devices.length === 1);
    assert.ok(ph2.gone, 'the account connection was dropped');
    assert.equal(last().devices[0].kind, undefined, 'the paired phone stays');
    const ph3 = relay.phone();
    await until(() => b.conns.has(ph3.conn));
    const banned = await phoneClient(ph3, new PhoneSession({ device: acct, pairing }));
    await banned.pump(() => banned.alerts.length);
    assert.equal(banned.alerts[0].code, 'unknown-device');
  } finally {
    b.stop();
    delete process.env.APAKI_REMOTE_PROTECT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('policy: a phone may steer its own running pane and ask for its context meter', () => {
  const ctx = { deviceId: DEV, paneExists: () => true };
  const ok = checkPhoneCommand({ op: 'steer', reqId: 'r1', paneId: 'p1', qid: 'q1abc', text: 'also check the tests', images: [] }, ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.cmd.paneId, phonePaneId(DEV, 'p1'));
  assert.equal(ok.cmd.qid, 'q1abc');
  assert.equal(ok.cmd.text, 'also check the tests');
  assert.equal(checkPhoneCommand({ op: 'steer', paneId: 'p1', qid: '../x', text: 'hi' }, ctx).ok, false, 'a bad message id');
  assert.equal(checkPhoneCommand({ op: 'steer', paneId: 'p1', qid: 'q2', text: '' }, ctx).ok, false, 'nothing to steer');
  const meter = checkPhoneCommand({ op: 'contextUsage', paneId: 'p1', extra: 'dropped' }, ctx);
  assert.equal(meter.ok, true);
  assert.deepEqual(meter.cmd, { op: 'contextUsage', paneId: phonePaneId(DEV, 'p1') });
  assert.equal(checkPhoneCommand({ op: 'contextUsage', paneId: 'p1' }, { ...ctx, paneExists: () => false }).ok, false, 'only its own open panes');
});

test('bridge: hello carries the PC\'s version and the oldest phone app; a phone app that says its version is checked against it', async () => {
  const dir = tmp();
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const relay = fakeRelay();
  const { b, last } = bridgeFor(relay, dir);
  try {
    await b.op({ op: 'remoteEnable' });
    await until(() => b.status === 'online');
    await b.op({ op: 'remotePairStart' });
    const ph = relay.phone();
    await until(() => b.conns.has(ph.conn));
    const device = await createDeviceIdentity();
    const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(last().pairing.url), name: 'Old app phone' }));
    await phone.pump(() => phone.sas);
    await until(() => last().request);
    await b.op({ op: 'remotePairDecision', approve: true });
    await phone.pump(() => phone.events.some((e) => e.ev === 'ready'));

    // The hello names this Apaki and the oldest phone app it works with (apaki/remote/compat.js).
    const hello = phone.events.find((e) => e.wire?.t === 'hello').wire;
    assert.equal(hello.appVersion, APP_VERSION);
    assert.equal(hello.minPhoneApp, MIN_PHONE_APP);
    assert.equal(last().devices[0].app, null, 'a phone that has not said which app it is shows nothing (the web page never does)');

    // Messages that make no sense are ignored: an unknown kind, something that is not a version.
    await phone.out.send({ t: 'client', kind: 'toaster', version: '1.0.0' });
    await phone.out.send({ t: 'client', kind: 'ios', version: 'not a version' });
    await phone.out.send({ t: 'client', kind: 'ios' });
    await sleep(80);
    assert.equal(last().devices[0].app, null);

    // An app under the minimum is marked old in the status the Phone sheet reads.
    await phone.out.send({ t: 'client', kind: 'ios', version: '0.0.1', build: '4' });
    await until(() => last().devices[0].app);
    assert.deepEqual(last().devices[0].app, { kind: 'ios', version: '0.0.1', min: MIN_PHONE_APP, state: 'old' });

    // The same phone after it updated: the sheet follows, without a reconnect.
    await phone.out.send({ t: 'client', kind: 'ios', version: MIN_PHONE_APP });
    await until(() => last().devices[0].app?.state === 'ok');
    assert.equal(last().devices[0].app.version, MIN_PHONE_APP);

    // Removing the phone forgets what it said.
    await b.op({ op: 'remoteRevoke', deviceId: last().devices[0].id });
    assert.equal(b.clientApps.size, 0);
  } finally {
    b.stop();
    delete process.env.APAKI_REMOTE_PROTECT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
