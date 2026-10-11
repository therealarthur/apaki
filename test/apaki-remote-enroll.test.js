/**
 * Phone keys, enrollment and Private as of version 2 (2026-10-11, apaki/remote/ENROLL.md), PC side:
 *   - hello carries a per-connection nonce and the phone-key and enroll features;
 *   - an Apaki account connection is HELD after hello (no ready event, no cached events, no ops) until a valid
 *     version 2 via (the phone's own key, signed over the nonce) and this PC's rule for that phone let it in;
 *   - the rule table: blocked, enrolled, allowed, auto, new, in Connected and in Private; the Private question
 *     (Allow, Block, timeout); the grace fallback for an older page; the 20 phones cap;
 *   - enrollment: account-link with enroll right after an in-person pairing adds the account with no card;
 *   - auto phones are asked again after a switch to Private;
 *   - the window ops remotePhoneDecision and remoteNoticeDismiss, and that a phone cannot send them.
 * Store and merge tests for the phone records are in apaki-remote-durable.test.js. The in-memory relay and phone
 * helpers follow apaki-remote-caps.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PhoneSession, createDeviceIdentity, decodePcFrame, encodePcFrame, parsePairingUrl, b64urlDecode, b64urlEncode, deviceIdFor, randomBytes,
} from '../apaki/remote/protocol.js';
import { Inbox, Outbox } from '../apaki/remote/wire.js';
import { PHONE_OPS, checkPhoneCommand, parsePhoneId } from '../apaki/engine/remote-policy.js';
import * as store from '../apaki/engine/remote-store.js';
import { RemoteBridge } from '../apaki/engine/remote.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };
const te = new TextEncoder();
const BLOCKED = /was blocked on Test PC\. Ask the person at the PC to allow it in its Phone sheet\./;
const MIN = 60_000;

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-enroll-test-'));
  const before = process.env.APAKI_REMOTE_PROTECT;
  process.env.APAKI_REMOTE_PROTECT = 'file';
  try { await fn(dir); } finally {
    if (before === undefined) delete process.env.APAKI_REMOTE_PROTECT; else process.env.APAKI_REMOTE_PROTECT = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ===== relay, phone, bridge helpers ===== */

function fakeRelay() {
  const relay = { pc: null, phones: new Map(), nextConn: 1 };
  const emitTo = (sock, type, data) => { for (const f of sock.listeners[type] || []) f(data); };
  class WS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0; this.listeners = {};
      queueMicrotask(() => {
        if (relay.pc) relay.pc.close();
        relay.pc = this;
        this.readyState = 1;
        emitTo(this, 'open', {});
        emitTo(this, 'message', { data: JSON.stringify({ t: 'ready', role: 'pc', phones: [...relay.phones.keys()], limits: {} }) });
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
  relay.phone = () => {
    const conn = relay.nextConn++;
    const ph = {
      conn, inbox: [], waiters: [], gone: false,
      deliver(bytes) { ph.inbox.push(bytes); ph.wake(); },
      kicked() { ph.gone = true; relay.phones.delete(conn); ph.wake(); if (relay.pc) emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'leave', conn }) }); },
      leave() { relay.phones.delete(conn); if (relay.pc) emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'leave', conn }) }); },
      wake() { for (const w of ph.waiters.splice(0)) w(); },
      send(frame) { if (relay.pc) emitTo(relay.pc, 'message', { data: encodePcFrame(conn, frame).buffer }); },
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

async function phoneClient(ph, session) {
  const inbox = new Inbox();
  const c = { session, events: [], sas: null, pairing: null, alerts: [] };
  c.pump = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('phone gave up waiting');
      let frame;
      try { frame = await ph.next(Math.max(50, end - Date.now())); } catch { continue; }
      const step = await session.receive(frame);
      for (const f of step.send) ph.send(f);
      for (const ev of step.events) {
        let m = null;
        if (ev.type === 'sas') c.sas = ev.sas;
        else if (ev.type === 'paired') c.pairing = ev.pairing;
        else if (ev.type === 'json') m = inbox.json(ev.value);
        else if (ev.type === 'chunk') m = inbox.chunk(ev);
        else if (ev.type === 'alert' || ev.type === 'close' || ev.type === 'error') c.alerts.push(ev);
        if (m?.t === 'evs') c.events.push(...m.list);
        else if (m) c.events.push({ wire: m });
      }
    }
  };
  c.out = new Outbox({ session, write: (f) => ph.send(f), flushMs: 1 });
  c.cmd = (cmd) => c.out.send({ t: 'cmd', cmd });
  c.wire = (t) => c.events.filter((e) => e.wire?.t === t).map((e) => e.wire);
  c.ready = () => c.events.some((e) => e.ev === 'ready');
  c.closeReason = () => c.alerts.find((a) => a.type === 'close')?.reason;
  ph.send(await session.start());
  return c;
}

function bridgeFor(relay, dir, extra = {}) {
  const desktop = [];
  const dispatched = [];
  const panes = new Map();
  const b = new RemoteBridge({
    emit: (e) => desktop.push(e),
    dispatch: (c) => { dispatched.push(c); if (c.op === 'open' || c.op === 'attach') panes.set(c.paneId, { sessionId: c.sessionId, running: true, busy: false }); if (c.op === 'close') panes.delete(c.paneId); },
    readyEvent: () => ({ ev: 'ready', model: 'claude-opus-5-5', mode: 'bypassPermissions' }),
    engine: {
      paneExists: (id) => panes.has(id),
      paneCount: (dev) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev).length,
      phonePanes: (dev) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev),
      paneInfo: (id) => panes.get(id) || null,
      askPane: () => null,
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
    pageCheck: false,
    recheckFirstMs: 3_600_000,
    viaGraceMs: 60_000, // the fallback for an older page has its own tests
    ...extra,
  });
  return { b, desktop, dispatched, panes, last: () => desktop[desktop.length - 1] };
}

/** Pairs a direct phone through Allow on the PC, like the real thing; returns what the phone saved and its hello. */
async function pairPhone({ b, last }, relay, { name = 'Pairing phone', cap, lifetime } = {}) {
  await b.op({ op: 'remotePairStart' });
  const ph = relay.phone();
  await until(() => b.conns.has(ph.conn));
  const device = await createDeviceIdentity();
  const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(last().pairing.url), name }));
  await phone.pump(() => phone.sas);
  await until(() => last().request);
  await b.op({ op: 'remotePairDecision', approve: true, ...(cap ? { cap } : {}), ...(lifetime !== undefined ? { lifetime } : {}) });
  await phone.pump(() => phone.pairing && phone.events.some((e) => e.ev === 'ready'));
  return { ph, device, phone, pairing: JSON.parse(JSON.stringify(phone.pairing)), hello: phone.wire('hello')[0] };
}

/** A bridge that is online with one paired phone (kept, as `p`), in the given mode. */
async function setup(dir, { mode = 'connected', bridge = {}, pair = {} } = {}) {
  const relay = fakeRelay();
  const br = bridgeFor(relay, dir, bridge);
  await br.b.op({ op: 'remoteEnable' });
  await until(() => br.b.status === 'online');
  if (mode !== 'connected') await br.b.op({ op: 'remoteMode', mode });
  const p = await pairPhone(br, relay, pair);
  return { ...br, relay, p };
}

/** A phone record as the state keeps it. */
async function phoneRecord(key, state, extra = {}) {
  return { id: await deviceIdFor(key.pub), pub: b64urlEncode(key.pub), name: 'Some phone', state, firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-02T00:00:00.000Z', ...extra };
}

/** Adds an account device (as an enrolled or allowed link would have) with these phone records; returns what a phone needs to connect as it. */
async function addAccount(env, { name = 'Arthur', phones = [] } = {}) {
  const acct = await createDeviceIdentity({ extractable: true });
  const id = await deviceIdFor(acct.pub);
  const psk = b64urlEncode(randomBytes(32));
  await env.b.addDevice({ id, pub: b64urlEncode(acct.pub), name: `Apaki account (${name})`, kind: 'account', account: name, by: 'Pairing phone', psk, pairedAt: new Date().toISOString(), cap: 'full', phones });
  return { acct, id, pairing: { ...env.p.pairing, deviceId: id, psk } };
}

const sign = async (key, ...parts) => new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new Uint8Array(parts.flatMap((x) => [...x]))));

/**
 * The version 2 via of ENROLL.md. tamper: { nonce, pub, name, junkPub, flip } changes what is signed or sent, to make it wrong.
 */
async function viaMessage(key, nonceB64, name = 'Phone', tamper = {}) {
  const nonce = tamper.nonce || b64urlDecode(nonceB64);
  const sig = await sign(key, te.encode('apaki/v1 via'), nonce, key.pub, te.encode(tamper.signedName ?? name));
  if (tamper.flip) sig[7] ^= 0xff;
  let pub = key.pub;
  if (tamper.pub) pub = tamper.pub;
  if (tamper.junkPub) pub = new Uint8Array([4, ...randomBytes(64)]);
  return { t: 'via', name, pub: b64urlEncode(pub), sig: b64urlEncode(sig) };
}

/** The enrollment account-link of ENROLL.md. tamper: { nonce, signedAccountPub, flag } makes it wrong. */
async function enrollMessage(phoneKey, nonceB64, accountPub, { reqId = 'e1', name = 'Arthur', tamper = {} } = {}) {
  const sig = await sign(phoneKey, te.encode('apaki/v1 enroll'), tamper.nonce || b64urlDecode(nonceB64), phoneKey.pub, tamper.signedAccountPub || accountPub);
  return { t: 'account-link', reqId, pub: b64urlEncode(accountPub), name, wait: true, enroll: tamper.flag === false ? undefined : true, phone: { pub: b64urlEncode(phoneKey.pub), sig: b64urlEncode(sig) } };
}

/** Connects as the account and, unless via is false, sends a version 2 via once hello arrives. */
async function connectAs(env, a, key, { name = 'Phone', via = true, tamper } = {}) {
  const ph = env.relay.phone();
  await until(() => env.b.conns.has(ph.conn));
  const c = await phoneClient(ph, new PhoneSession({ device: a.acct, pairing: a.pairing }));
  await c.pump(() => c.wire('hello').length || c.alerts.length);
  if (via && c.wire('hello')[0]) await c.out.send(await viaMessage(key, c.wire('hello')[0].nonce, name, tamper));
  return { ph, c };
}

/** Waits for what a connection ends at: let in (ready), waiting (phone-wait), or closed. */
const settled = (c, ms) => c.pump(() => c.ready() || c.wire('phone-wait').length || c.alerts.length, ms);

const acctOf = (env, id) => env.b.state.devices.find((d) => d.id === id);
const savedPhones = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).devices.find((d) => d.id === id)?.phones || [];

/* ===== hello, via, held ===== */

test('hello: every connection gets a fresh 16 byte nonce and the phone-key and enroll features, in Private and Connected', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const h1 = env.p.hello;
      assert.equal(b64urlDecode(h1.nonce).length, 16);
      assert.ok(h1.features.includes('phone-key') && h1.features.includes('enroll'));
      assert.ok(h1.features.includes('account-ask'), 'Connected still offers the held link');
      const a = await addAccount(env);
      const one = await connectAs(env, a, await createDeviceIdentity(), { via: false });
      const two = await connectAs(env, a, await createDeviceIdentity(), { via: false });
      const n1 = one.c.wire('hello')[0].nonce;
      const n2 = two.c.wire('hello')[0].nonce;
      assert.notEqual(n1, n2, 'a new nonce for each connection');
      assert.notEqual(n1, h1.nonce);
      assert.equal(one.c.wire('hello')[0].asAccount, true);
      await env.b.op({ op: 'remoteMode', mode: 'private' });
      await env.p.phone.pump(() => env.p.phone.wire('mode').length);
      const m = env.p.phone.wire('mode')[0];
      assert.ok(m.features.includes('phone-key') && m.features.includes('enroll'), 'and in Private');
      assert.ok(!m.features.includes('account-ask'));
      const priv = await connectAs(env, a, await createDeviceIdentity(), { via: false });
      assert.ok(priv.c.wire('hello')[0].features.includes('phone-key'));
    } finally { env.b.stop(); }
  });
});

test('via: a valid signed via is accepted; a bad signature, a wrong nonce, a swapped key, a changed name, a junk key and a replay are refused and store nothing', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const a = await addAccount(env);
      const good = await createDeviceIdentity();
      const ok = await connectAs(env, a, good, { name: 'iPhone (Safari)' });
      await settled(ok.c);
      assert.ok(ok.c.ready());
      assert.equal(ok.c.wire('phone-ok').length, 1);
      const rec = acctOf(env, a.id).phones.find((x) => x.pub === b64urlEncode(good.pub));
      assert.equal(rec.name, 'iPhone (Safari)');
      assert.equal(rec.id, await deviceIdFor(good.pub));

      const refused = async (key, tamper, label) => {
        const bad = await connectAs(env, a, key, { name: 'Bad phone', tamper });
        await bad.c.pump(() => bad.c.alerts.length);
        assert.match(bad.c.closeReason(), /could not prove its key/, label);
        assert.doesNotMatch(bad.c.closeReason(), /removed|expired|blocked/, `${label}: the phone keeps the PC`);
        assert.ok(!bad.c.ready(), label);
        await until(() => bad.ph.gone);
        assert.ok(!acctOf(env, a.id).phones.some((x) => x.pub === b64urlEncode(key.pub)), `${label}: nothing stored`);
      };
      await refused(await createDeviceIdentity(), { flip: true }, 'bad signature');
      await refused(await createDeviceIdentity(), { nonce: randomBytes(16) }, 'wrong nonce');
      await refused(await createDeviceIdentity(), { pub: (await createDeviceIdentity()).pub }, 'swapped public key');
      await refused(await createDeviceIdentity(), { signedName: 'Another name' }, 'changed name');
      await refused(await createDeviceIdentity(), { junkPub: true }, 'a key that is not a P-256 point');

      // A via recorded on one connection, replayed on another: that connection has its own nonce.
      const first = await connectAs(env, a, await createDeviceIdentity(), { via: false });
      const replayKey = await createDeviceIdentity();
      const recorded = await viaMessage(replayKey, first.c.wire('hello')[0].nonce, 'Recorded');
      const second = await connectAs(env, a, await createDeviceIdentity(), { via: false });
      await second.c.out.send(recorded);
      await second.c.pump(() => second.c.alerts.length);
      assert.match(second.c.closeReason(), /could not prove its key/);
      assert.ok(!acctOf(env, a.id).phones.some((x) => x.pub === b64urlEncode(replayKey.pub)));

      // A second via with another key on a connection that is in: closed. The same key again changes nothing.
      await ok.c.out.send(await viaMessage(good, ok.c.wire('hello')[0].nonce, 'iPhone (Safari)'));
      await sleep(60);
      assert.ok(ok.c.alerts.length === 0, 'the same key again is nothing new');
      await ok.c.out.send(await viaMessage(await createDeviceIdentity(), ok.c.wire('hello')[0].nonce, 'Second phone'));
      await ok.c.pump(() => ok.c.alerts.length);
      assert.match(ok.c.closeReason(), /could not prove its key/);
      assert.equal(acctOf(env, a.id).phones.length, 1, 'only the first phone is on record');
    } finally { env.b.stop(); }
  });
});

test('held: an account connection gets no ready event, no cached events and no ops until phone-ok', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const a = await addAccount(env);
      const key = await createDeviceIdentity();
      const held = await connectAs(env, a, key, { via: false });
      env.b.route({ ev: 'folders', folders: [{ id: 'f1', name: 'Work' }] });
      env.b.route({ ev: 'opened', reqId: `phone:${a.id}:r0`, paneId: `phone:${a.id}:p1`, sessionId: 's-1' });
      await held.c.cmd({ op: 'sessions', reqId: 'r1' });
      await held.c.out.send({ t: 'account-unlink', reqId: 'u1', deviceId: a.id });
      await sleep(120);
      assert.deepEqual(held.c.events.map((e) => e.wire?.t), ['hello'], 'only hello reached the held connection');
      assert.equal(env.dispatched.length, 0, 'no op ran');
      assert.ok(acctOf(env, a.id), 'and it could not unlink the account either');
      const st = env.last().devices.find((d) => d.id === a.id);
      assert.equal(st.connected, false);

      await held.c.out.send(await viaMessage(key, held.c.wire('hello')[0].nonce, 'iPhone'));
      await held.c.pump(() => held.c.ready());
      assert.equal(held.c.events.findIndex((e) => e.wire?.t === 'phone-ok') >= 0, true);
      assert.ok(held.c.events.findIndex((e) => e.wire?.t === 'phone-ok') < held.c.events.findIndex((e) => e.ev === 'ready'), 'phone-ok comes before the ready event');
      assert.ok(held.c.events.some((e) => e.ev === 'folders'), 'the cached broadcasts follow the ready event');
      assert.ok(!held.c.events.some((e) => e.ev === 'opened'), 'an event about the account\'s panes made while it was held never reached it');
      await held.c.cmd({ op: 'sessions', reqId: 'r2' });
      await until(() => env.dispatched.length === 1);
      assert.equal(env.dispatched[0].reqId, `phone:${a.id}:r2`);
      assert.equal(env.last().devices.find((d) => d.id === a.id).connected, true);
    } finally { env.b.stop(); }
  });
});

/* ===== the table ===== */

async function tableCase(mode, expectations) {
  await withDir(async (dir) => {
    const env = await setup(dir, { mode, bridge: { linkApprovalMs: 5000 } });
    try {
      const keys = { blocked: await createDeviceIdentity(), enrolled: await createDeviceIdentity(), allowed: await createDeviceIdentity(), auto: await createDeviceIdentity(), none: await createDeviceIdentity() };
      const a = await addAccount(env, { phones: [await phoneRecord(keys.blocked, 'blocked'), await phoneRecord(keys.enrolled, 'enrolled'), await phoneRecord(keys.allowed, 'allowed'), await phoneRecord(keys.auto, 'auto')] });
      const results = {};
      for (const [state, key] of Object.entries(keys)) {
        const k = await connectAs(env, a, key, { name: `${state} phone` });
        await settled(k.c);
        results[state] = { c: k.c, ph: k.ph };
      }
      expectations({ env, a, keys, results, dir });
    } finally { env.b.stop(); }
  });
}

test('table, Connected: blocked is closed; enrolled, allowed and auto are let in; a new phone is let in with a notice', async () => {
  await tableCase('connected', ({ env, a, keys, results, dir }) => {
    assert.match(results.blocked.c.closeReason(), BLOCKED);
    assert.ok(!results.blocked.c.ready() && !results.blocked.c.wire('phone-ok').length);
    for (const s of ['enrolled', 'allowed', 'auto', 'none']) {
      assert.ok(results[s].c.ready(), s);
      assert.equal(results[s].c.wire('phone-ok').length, 1, s);
      assert.equal(results[s].c.wire('phone-wait').length, 0, s);
    }
    const phones = acctOf(env, a.id).phones;
    assert.equal(phones.find((x) => x.pub === b64urlEncode(keys.none.pub)).state, 'auto', 'a new phone is recorded as auto');
    assert.equal(phones.find((x) => x.pub === b64urlEncode(keys.enrolled.pub)).state, 'enrolled', 'a known one keeps its state');
    assert.equal(phones.find((x) => x.pub === b64urlEncode(keys.auto.pub)).state, 'auto');
    const notices = env.last().notices;
    assert.equal(notices.length, 1, 'only the new phone gets a notice');
    assert.equal(notices[0].kind, 'new-phone');
    assert.equal(notices[0].name, 'none phone');
    assert.equal(notices[0].account, 'Arthur');
    assert.equal(notices[0].accountDeviceId, a.id);
    assert.equal(notices[0].phoneId, phones.find((x) => x.pub === b64urlEncode(keys.none.pub)).id);
    assert.equal(typeof notices[0].id, 'string');
    assert.ok(Date.parse(notices[0].at));
    assert.equal(env.last().phoneRequest, null, 'nobody is asked in Connected');
    assert.equal(savedPhones(dir, a.id).find((x) => x.pub === b64urlEncode(keys.none.pub)).state, 'auto', 'and it is saved');
    assert.ok(phones.find((x) => x.name === 'enrolled phone'), 'the name the phone sent replaces the one on record');
  });
});

test('table, Private: blocked is closed; enrolled and allowed are let in; auto and a new phone wait for an answer on the PC', async () => {
  await tableCase('private', ({ env, a, keys, results, dir }) => {
    assert.match(results.blocked.c.closeReason(), BLOCKED);
    for (const s of ['enrolled', 'allowed']) {
      assert.ok(results[s].c.ready() && results[s].c.wire('phone-ok').length === 1, s);
    }
    for (const s of ['auto', 'none']) {
      assert.ok(!results[s].c.ready(), `${s}: held`);
      assert.equal(results[s].c.wire('phone-ok').length, 0, s);
      assert.equal(results[s].c.wire('phone-wait').length, 1, s);
      // The time left, so a busy run can read 4999 (it failed once that way under the full parallel suite, 2026-10-11).
      const left = results[s].c.wire('phone-wait')[0].timeoutMs;
      assert.ok(left > 4000 && left <= 5000, `${s}: the phone is told how long it waits (${left} ms)`);
    }
    const st = env.last();
    assert.equal(st.phoneRequest.accountDeviceId, a.id);
    assert.equal(st.phoneRequest.account, 'Arthur');
    assert.ok(st.phoneRequest.exp > Date.now());
    const rows = st.devices.find((d) => d.id === a.id).phones;
    assert.equal(rows.find((x) => x.pub === b64urlEncode(keys.none.pub)).state, 'pending');
    assert.equal(rows.find((x) => x.pub === b64urlEncode(keys.auto.pub)).state, 'pending');
    assert.equal(rows.find((x) => x.pub === b64urlEncode(keys.enrolled.pub)).online, true);
    assert.equal(rows.find((x) => x.pub === b64urlEncode(keys.none.pub)).online, false, 'a waiting phone is not online');
    assert.deepEqual(env.last().notices, [], 'no notices in Private: the card asks instead');
    assert.ok(!savedPhones(dir, a.id).some((x) => x.state === 'pending'), 'a question is never written to disk');
  });
});

/* ===== the Private question ===== */

test('Private question: Allow lets the waiting phone in and it is never asked again', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir, { mode: 'private' });
    try {
      const a = await addAccount(env);
      const key = await createDeviceIdentity();
      const k = await connectAs(env, a, key, { name: 'New iPhone' });
      await settled(k.c);
      assert.equal(k.c.wire('phone-wait').length, 1);
      await until(() => env.last().phoneRequest);
      const { phoneId } = env.last().phoneRequest;
      assert.equal(env.last().phoneRequest.name, 'New iPhone');
      env.b.route({ ev: 'folders', folders: [] });
      await sleep(50);
      assert.ok(!k.c.events.some((e) => e.ev === 'folders'), 'nothing leaks while it waits');

      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId, action: 'allow' });
      await k.c.pump(() => k.c.ready());
      assert.equal(k.c.wire('phone-ok').length, 1);
      assert.equal(env.last().phoneRequest, null);
      const rec = acctOf(env, a.id).phones[0];
      assert.equal(rec.state, 'allowed');
      assert.equal(savedPhones(dir, a.id)[0].state, 'allowed');
      assert.equal((await store.loadSecret(dir)).devices.find((d) => d.id === a.id).phones[0].state, 'allowed', 'secret.json carries it too');
      // Next time: straight in.
      const again = await connectAs(env, a, key, { name: 'New iPhone' });
      await settled(again.c);
      assert.ok(again.c.ready());
      assert.equal(again.c.wire('phone-wait').length, 0);
    } finally { env.b.stop(); }
  });
});

test('Private question: Block closes the waiting phone with BLOCKED and it stays blocked', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir, { mode: 'private' });
    try {
      const a = await addAccount(env);
      const key = await createDeviceIdentity();
      const k = await connectAs(env, a, key);
      const other = await connectAs(env, a, key);
      await settled(k.c);
      await settled(other.c);
      await until(() => env.last().phoneRequest);
      assert.equal(env.b.asks.length, 1, 'two connections of one phone share one question');
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: env.last().phoneRequest.phoneId, action: 'block' });
      for (const c of [k.c, other.c]) {
        await c.pump(() => c.alerts.length);
        assert.match(c.closeReason(), BLOCKED);
        assert.ok(!c.ready());
      }
      assert.equal(env.last().phoneRequest, null);
      assert.equal(acctOf(env, a.id).phones[0].state, 'blocked');
      assert.equal(savedPhones(dir, a.id)[0].state, 'blocked');
      const again = await connectAs(env, a, key);
      await again.c.pump(() => again.c.alerts.length);
      assert.match(again.c.closeReason(), BLOCKED, 'closed at once, not asked');
      assert.equal(again.c.wire('phone-wait').length, 0);
    } finally { env.b.stop(); }
  });
});

test('Private question: nobody answering closes the phone, drops the pending record, and the next try asks again; an auto phone goes back to auto', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir, { mode: 'private', bridge: { linkApprovalMs: 250 } });
    try {
      const autoKey = await createDeviceIdentity();
      const a = await addAccount(env, { phones: [await phoneRecord(autoKey, 'auto')] });
      const key = await createDeviceIdentity();
      const k = await connectAs(env, a, key);
      await settled(k.c);
      await k.c.pump(() => k.c.alerts.length);
      assert.equal(k.c.closeReason(), 'Nobody allowed this phone on Test PC in time.');
      assert.doesNotMatch(k.c.closeReason(), /removed|expired|blocked/);
      await until(() => env.last().phoneRequest === null);
      assert.ok(!acctOf(env, a.id).phones.some((x) => x.pub === b64urlEncode(key.pub)), 'the pending record is dropped');
      const retry = await connectAs(env, a, key);
      await settled(retry.c);
      assert.equal(retry.c.wire('phone-wait').length, 1, 'asked again');

      const auto = await connectAs(env, a, autoKey);
      await settled(auto.c);
      assert.equal(auto.c.wire('phone-wait').length, 1);
      await auto.c.pump(() => auto.c.alerts.length);
      assert.equal(acctOf(env, a.id).phones.find((x) => x.pub === b64urlEncode(autoKey.pub)).state, 'auto', 'it was auto before the question and still is');
      assert.equal(savedPhones(dir, a.id).find((x) => x.pub === b64urlEncode(autoKey.pub)).state, 'auto');
    } finally { env.b.stop(); }
  });
});

test('Private question: a phone that goes away while asked takes its question with it', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir, { mode: 'private' });
    try {
      const a = await addAccount(env);
      const key = await createDeviceIdentity();
      const k = await connectAs(env, a, key);
      await settled(k.c);
      await until(() => env.last().phoneRequest);
      k.ph.leave();
      await until(() => env.last().phoneRequest === null);
      assert.deepEqual(acctOf(env, a.id).phones || [], []);
      assert.equal(env.b.asks.length, 0);
    } finally { env.b.stop(); }
  });
});

/* ===== an older page: the grace ===== */

test('older page: after VIA_GRACE_MS Connected lets it in as before (no phone-ok, marked older page), Private closes it', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir, { bridge: { viaGraceMs: 150 } });
    try {
      const a = await addAccount(env);
      const old = await connectAs(env, a, null, { via: false });
      await old.c.out.send({ t: 'via', name: 'Pixel (Chrome)' });
      await sleep(60);
      assert.ok(!old.c.ready(), 'still held inside the grace');
      await old.c.pump(() => old.c.ready());
      assert.equal(old.c.wire('phone-ok').length, 0, 'an older page is not told something it cannot read');
      await until(() => env.last().devices.find((d) => d.id === a.id).via.includes('Pixel (Chrome) (older page)'));
      assert.equal(env.last().devices.find((d) => d.id === a.id).connected, true);
      assert.deepEqual(acctOf(env, a.id).phones || [], [], 'no phone key, no record');

      // A proof that comes late (a slow phone) still counts.
      const key = await createDeviceIdentity();
      await old.c.out.send(await viaMessage(key, old.c.wire('hello')[0].nonce, 'Pixel (Chrome)'));
      await old.c.pump(() => old.c.wire('phone-ok').length);
      assert.equal(acctOf(env, a.id).phones[0].state, 'auto');
      await until(() => env.last().devices.find((d) => d.id === a.id).via.includes('Pixel (Chrome)'));

      // Private: the same silence is closed with the instruction.
      await env.b.op({ op: 'remoteMode', mode: 'private' });
      await old.c.pump(() => old.c.alerts.length);
      assert.match(old.c.closeReason(), /Private mode/);
      const priv = await connectAs(env, a, null, { via: false });
      await priv.c.pump(() => priv.c.alerts.length);
      assert.equal(priv.c.closeReason(), 'Update the page: this PC asks about each phone.');
      assert.ok(!priv.c.ready());
    } finally { env.b.stop(); }
  });
});

/* ===== enrollment ===== */

async function enrollRun(mode) {
  await withDir(async (dir) => {
    const env = await setup(dir, { mode, pair: { name: 'iPhone (Safari)', cap: 'noshell', lifetime: 7 } });
    try {
      const { phone, hello } = env.p;
      const accountKey = await createDeviceIdentity({ extractable: true });
      const phoneKey = await createDeviceIdentity();
      await phone.out.send(await enrollMessage(phoneKey, hello.nonce, accountKey.pub));
      await phone.pump(() => phone.wire('account-linked').length);
      const linked = phone.wire('account-linked')[0];
      assert.equal(linked.error, undefined, `${mode}: no card, no error`);
      assert.equal(linked.deviceId, await deviceIdFor(accountKey.pub));
      assert.equal(b64urlDecode(linked.psk).length, 32);
      assert.equal(linked.pcName, 'Test PC');
      assert.equal(phone.wire('pending').length, 0, 'it was not held for an Allow');
      assert.equal(env.last().linkRequest, null);
      const acct = env.last().devices.find((d) => d.kind === 'account');
      assert.equal(acct.cap, 'noshell', 'the pairing phone\'s access');
      assert.equal(acct.expiresAt, env.last().devices.find((d) => d.id === env.p.pairing.deviceId).expiresAt, 'and its lifetime');
      assert.ok(acct.expiresAt);
      assert.equal(acct.phones.length, 1);
      assert.equal(acct.phones[0].state, 'enrolled');
      assert.equal(acct.phones[0].name, 'iPhone (Safari)');
      assert.equal(acct.phones[0].id, await deviceIdFor(phoneKey.pub));
      assert.ok(!fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(linked.psk), 'the psk stays out of the public state');

      // That phone, signed in with the account on its own key, is never asked: let in at once, in the mode the PC is in.
      const a = { acct: accountKey, id: linked.deviceId, pairing: { ...env.p.pairing, deviceId: linked.deviceId, psk: linked.psk } };
      const k = await connectAs(env, a, phoneKey, { name: 'iPhone (Safari)' });
      await settled(k.c);
      assert.ok(k.c.ready(), `${mode}: enrolled`);
      assert.equal(k.c.wire('phone-ok').length, 1);
      assert.equal(env.last().notices.length, 0, 'no "new phone" line for the phone that was scanned');
      assert.equal(k.c.wire('hello')[0].cap, 'noshell');
      // A second, unscanned phone behind the same account follows the mode.
      const other = await connectAs(env, a, await createDeviceIdentity(), { name: 'Pixel' });
      await settled(other.c);
      assert.equal(other.c.ready(), mode === 'connected');
      assert.equal(other.c.wire('phone-wait').length, mode === 'connected' ? 0 : 1);
    } finally { env.b.stop(); }
  });
}

test('enrollment, Connected: a phone paired in person adds its account with no card, gets its access and lifetime, and is enrolled', async () => enrollRun('connected'));
test('enrollment, Private: the same, and Private still asks about every other phone', async () => enrollRun('private'));

test('enrollment: outside the 15 minute window, with a bad phone signature, from an account connection or without the flag, account-link is version 1', async () => {
  await withDir(async (dir) => {
    // The PC's clock, moved forward by `later` (the pairing itself is stamped by the real clock, so it is never in the future).
    let later = 0;
    const env = await setup(dir, { bridge: { now: () => Date.now() + later, linkApprovalMs: 400 } });
    try {
      const { phone, hello } = env.p;
      const accountKey = await createDeviceIdentity({ extractable: true });
      const phoneKey = await createDeviceIdentity();
      const asked = async (msg) => {
        await phone.out.send(msg);
        await phone.pump(() => phone.wire('account-linked').some((m) => m.reqId === msg.reqId) || phone.wire('pending').some((m) => m.reqId === msg.reqId));
        return phone.wire('pending').some((m) => m.reqId === msg.reqId);
      };
      const denyAll = async (reqId) => { await until(() => env.last().linkRequest); await env.b.op({ op: 'remoteLinkDecision', approve: false }); await phone.pump(() => phone.wire('account-linked').some((m) => m.reqId === reqId)); };

      // Bad signatures: over another nonce, over another account key, no flag. Connected holds each for an Allow.
      assert.equal(await asked(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'b1', tamper: { nonce: randomBytes(16) } })), true);
      await denyAll('b1');
      assert.equal(await asked(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'b2', tamper: { signedAccountPub: (await createDeviceIdentity()).pub } })), true);
      await denyAll('b2');
      assert.equal(await asked(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'b3', tamper: { flag: false } })), true);
      await denyAll('b3');
      assert.equal(env.last().devices.filter((d) => d.kind === 'account').length, 0, 'nothing was added');

      // Outside the window: a pairing 16 minutes old.
      later = 16 * MIN;
      assert.equal(await asked(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'w1' })), true);
      await denyAll('w1');
      assert.equal(env.last().devices.filter((d) => d.kind === 'account').length, 0);

      // Inside the window again (the clock back): it works, so the earlier refusals were the window and the signature.
      later = 6 * MIN;
      await phone.out.send(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'w2' }));
      await phone.pump(() => phone.wire('account-linked').some((m) => m.reqId === 'w2'));
      assert.ok(phone.wire('account-linked').find((m) => m.reqId === 'w2').psk);

      // An account connection is not a direct pairing: it cannot enroll another account.
      const a = { acct: accountKey, id: await deviceIdFor(accountKey.pub), pairing: { ...env.p.pairing, deviceId: await deviceIdFor(accountKey.pub), psk: phone.wire('account-linked').find((m) => m.reqId === 'w2').psk } };
      const k = await connectAs(env, a, phoneKey, { name: 'iPhone' });
      await settled(k.c);
      const second = await createDeviceIdentity({ extractable: true });
      await k.c.out.send(await enrollMessage(phoneKey, k.c.wire('hello')[0].nonce, second.pub, { reqId: 'x1' }));
      await k.c.pump(() => k.c.wire('pending').length || k.c.wire('account-linked').length);
      assert.equal(k.c.wire('pending').length, 1, 'held for an Allow like any other link');
      assert.equal(env.last().devices.filter((d) => d.kind === 'account').length, 1);
    } finally { env.b.stop(); }
  });
});

test('enrollment, Private: outside the window or with a bad signature the account is refused (an account is only added in person)', async () => {
  await withDir(async (dir) => {
    let later = 0;
    const env = await setup(dir, { mode: 'private', bridge: { now: () => Date.now() + later } });
    try {
      const { phone, hello } = env.p;
      const accountKey = await createDeviceIdentity({ extractable: true });
      const phoneKey = await createDeviceIdentity();
      const refused = async (msg) => {
        await phone.out.send(msg);
        await phone.pump(() => phone.wire('account-linked').some((m) => m.reqId === msg.reqId));
        const m = phone.wire('account-linked').find((x) => x.reqId === msg.reqId);
        assert.equal(m.code, 'private');
        assert.equal(m.error, 'This PC only accepts phones paired with its code.');
        assert.equal(m.psk, undefined);
      };
      await refused(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'p1', tamper: { nonce: randomBytes(16) } }));
      later = 16 * MIN;
      await refused(await enrollMessage(phoneKey, hello.nonce, accountKey.pub, { reqId: 'p2' }));
      assert.equal(env.last().devices.filter((d) => d.kind === 'account').length, 0);
    } finally { env.b.stop(); }
  });
});

test('enrollment: an account already linked keeps its secret and its phones; the new pairing adds its own phone', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir, { pair: { name: 'First phone' } });
    try {
      const accountKey = await createDeviceIdentity({ extractable: true });
      const key1 = await createDeviceIdentity();
      await env.p.phone.out.send(await enrollMessage(key1, env.p.hello.nonce, accountKey.pub, { reqId: 'e1' }));
      await env.p.phone.pump(() => env.p.phone.wire('account-linked').length);
      const first = env.p.phone.wire('account-linked')[0];
      const second = await pairPhone(env, env.relay, { name: 'Second phone' });
      const key2 = await createDeviceIdentity();
      await second.phone.out.send(await enrollMessage(key2, second.hello.nonce, accountKey.pub, { reqId: 'e2' }));
      await second.phone.pump(() => second.phone.wire('account-linked').length);
      const again = second.phone.wire('account-linked')[0];
      assert.equal(again.psk, first.psk, 'phones that already hold the account\'s secret keep working');
      const phones = env.b.state.devices.find((d) => d.kind === 'account').phones;
      assert.deepEqual(phones.map((x) => [x.name, x.state]).sort(), [['First phone', 'enrolled'], ['Second phone', 'enrolled']]);
      assert.equal(env.b.state.devices.filter((d) => d.kind === 'account').length, 1);
    } finally { env.b.stop(); }
  });
});

/* ===== the switch to Private ===== */

test('switching to Private: phones Connected let in by themselves are asked again; enrolled and allowed stay; removeAccounts still removes', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const enrolledKey = await createDeviceIdentity();
      const a = await addAccount(env, { phones: [await phoneRecord(enrolledKey, 'enrolled')] });
      const autoKey = await createDeviceIdentity();
      const keep = await connectAs(env, a, enrolledKey, { name: 'Scanned phone' });
      const auto = await connectAs(env, a, autoKey, { name: 'Synced iPhone' });
      await settled(keep.c);
      await settled(auto.c);
      assert.ok(keep.c.ready() && auto.c.ready());
      assert.equal(acctOf(env, a.id).phones.find((x) => x.pub === b64urlEncode(autoKey.pub)).state, 'auto');

      await env.b.op({ op: 'remoteMode', mode: 'private' });
      await auto.c.pump(() => auto.c.alerts.length);
      assert.match(auto.c.closeReason(), /Private mode/);
      assert.doesNotMatch(auto.c.closeReason(), /removed|expired|blocked/);
      await sleep(80);
      assert.equal(keep.c.alerts.length, 0, 'the scanned phone stays connected');
      assert.equal(env.last().devices.find((d) => d.id === a.id).connected, true);

      const back = await connectAs(env, a, autoKey, { name: 'Synced iPhone' });
      await settled(back.c);
      assert.equal(back.c.wire('phone-wait').length, 1, 'asked again');
      assert.ok(!back.c.ready());
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: env.last().phoneRequest.phoneId, action: 'allow' });
      await back.c.pump(() => back.c.ready());

      await env.b.op({ op: 'remoteMode', mode: 'private', removeAccounts: true });
      assert.ok(!env.last().devices.some((d) => d.kind === 'account'), 'removeAccounts removes the account devices');
      await keep.c.pump(() => keep.c.alerts.length);
      assert.match(keep.c.closeReason(), /removed/);
    } finally { env.b.stop(); }
  });
});

/* ===== the 20 phones cap ===== */

test('cap: at most 20 phone records per account device; the oldest that is not blocked is dropped; all blocked refuses a new phone', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const keys = [];
      const phones = [];
      for (let i = 0; i < 20; i++) {
        const k = await createDeviceIdentity();
        keys.push(k);
        phones.push(await phoneRecord(k, i === 1 ? 'blocked' : 'auto', { name: `Phone ${i}`, lastSeen: `2026-10-${String(1 + i).padStart(2, '0')}T00:00:00.000Z` }));
      }
      const a = await addAccount(env, { phones });
      const fresh = await createDeviceIdentity();
      const k = await connectAs(env, a, fresh, { name: 'Phone 20' });
      await settled(k.c);
      assert.ok(k.c.ready());
      const list = acctOf(env, a.id).phones;
      assert.equal(list.length, 20);
      assert.ok(list.some((x) => x.name === 'Phone 20'));
      assert.ok(!list.some((x) => x.name === 'Phone 0'), 'the oldest was dropped');
      assert.ok(list.some((x) => x.name === 'Phone 1' && x.state === 'blocked'), 'a blocked one is never the one dropped');
      assert.ok(acctOf(env, a.id).phonesForgot.some((r) => r.id === phones[0].id), 'and it is remembered as forgotten');
      assert.equal(savedPhones(dir, a.id).length, 20);

      // Every record blocked: nothing can be dropped, so the new phone is closed and nothing is stored.
      const b2 = await addAccount(env, { name: 'Full', phones: await Promise.all(Array.from({ length: 20 }, async (_, i) => phoneRecord(await createDeviceIdentity(), 'blocked', { name: `Blocked ${i}` }))) });
      const newcomer = await createDeviceIdentity();
      const closed = await connectAs(env, b2, newcomer, { name: 'Newcomer' });
      await closed.c.pump(() => closed.c.alerts.length);
      assert.match(closed.c.closeReason(), /20 phones/);
      assert.equal(acctOf(env, b2.id).phones.length, 20);
      assert.ok(!acctOf(env, b2.id).phones.some((x) => x.pub === b64urlEncode(newcomer.pub)));
    } finally { env.b.stop(); }
  });
});

/* ===== window ops, status ===== */

test('window ops: block closes a connected phone and stops its conversations; allow unblocks; forget makes it new again; unknown ones are refused with why', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const a = await addAccount(env);
      const keyA = await createDeviceIdentity();
      const keyB = await createDeviceIdentity();
      const ka = await connectAs(env, a, keyA, { name: 'Phone A' });
      const kb = await connectAs(env, a, keyB, { name: 'Phone B' });
      await settled(ka.c);
      await settled(kb.c);
      const idA = await deviceIdFor(keyA.pub);
      const idB = await deviceIdFor(keyB.pub);
      await ka.c.cmd({ op: 'open', reqId: 'r1', paneId: 'p1', sessionId: null, warm: true });
      await until(() => env.panes.has(`phone:${a.id}:p1`));
      assert.equal(env.last().notices.length, 2);

      // Block B (the other phone stays, so the account's conversations stay).
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: idB, action: 'block' });
      await kb.c.pump(() => kb.c.alerts.length);
      assert.match(kb.c.closeReason(), BLOCKED);
      assert.equal(env.last().devices.find((d) => d.id === a.id).phones.find((x) => x.id === idB).state, 'blocked');
      assert.deepEqual(env.last().notices.map((n) => n.phoneId), [idA], 'its notice is gone');
      assert.ok(env.panes.has(`phone:${a.id}:p1`), 'another phone of the account is still connected');
      assert.equal(ka.c.alerts.length, 0);

      // Block A as well: nobody is left, so the conversations stop now.
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: idA, action: 'block' });
      await ka.c.pump(() => ka.c.alerts.length);
      assert.ok(env.dispatched.some((c) => c.op === 'close' && c.paneId === `phone:${a.id}:p1`));

      // Allow unblocks (state allowed); the phone connects again and is not noticed as new.
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: idB, action: 'allow' });
      assert.equal(acctOf(env, a.id).phones.find((x) => x.id === idB).state, 'allowed');
      const back = await connectAs(env, a, keyB, { name: 'Phone B' });
      await settled(back.c);
      assert.ok(back.c.ready());
      assert.equal(env.last().notices.length, 0);

      // Forget: the record goes, the live connection closes, and it is a new phone next time (a notice again).
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: idB, action: 'forget' });
      await back.c.pump(() => back.c.alerts.length);
      assert.doesNotMatch(back.c.closeReason(), /removed|expired|blocked/);
      assert.ok(!acctOf(env, a.id).phones.some((x) => x.id === idB));
      assert.ok(!savedPhones(dir, a.id).some((x) => x.id === idB));
      const fresh = await connectAs(env, a, keyB, { name: 'Phone B' });
      await settled(fresh.c);
      assert.ok(fresh.c.ready());
      assert.equal(env.last().notices.length, 1, 'new again');
      assert.equal(env.last().devices.find((d) => d.id === a.id).phones.find((x) => x.id === idB).online, true);

      // Refused with why; nothing changes.
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: 'NoSuchPhoneNoSuchPhone', action: 'allow', reqId: 'x1' });
      assert.match(env.last().opError, /does not know that phone/);
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: 'NoSuchAccountNoSuchAc', phoneId: idA, action: 'allow', reqId: 'x2' });
      assert.match(env.last().opError, /not linked/);
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: idA, action: 'delete', reqId: 'x3' });
      assert.match(env.last().opError, /allowed, blocked or forgotten/);
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: env.p.pairing.deviceId, phoneId: idA, action: 'block', reqId: 'x4' });
      assert.match(env.last().opError, /not linked/, 'a directly paired phone is not an account');
      assert.equal(acctOf(env, a.id).phones.find((x) => x.id === idA).state, 'blocked');
    } finally { env.b.stop(); }
  });
});

test('window ops: remoteNoticeDismiss drops the line only; status carries phones, online, phoneRequest and at most 5 notices, newest first', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const a = await addAccount(env);
      const keys = [];
      for (let i = 0; i < 7; i++) {
        const key = await createDeviceIdentity();
        keys.push(key);
        const k = await connectAs(env, a, key, { name: `Phone ${i}` });
        await settled(k.c);
        assert.ok(k.c.ready());
      }
      const st = env.last();
      assert.equal(st.notices.length, 5);
      assert.deepEqual(st.notices.map((n) => n.name), ['Phone 6', 'Phone 5', 'Phone 4', 'Phone 3', 'Phone 2'], 'newest first');
      assert.equal(st.devices.find((d) => d.id === a.id).phones.length, 7);
      assert.ok(st.devices.find((d) => d.id === a.id).phones.every((x) => x.online && x.state === 'auto' && x.pub && x.firstSeen && x.lastSeen));
      assert.equal(st.devices.find((d) => d.id === env.p.pairing.deviceId).phones, undefined, 'a direct phone has no phone keys');
      const id = st.notices[0].id;
      await env.b.op({ op: 'remoteNoticeDismiss', id });
      assert.ok(!env.last().notices.some((n) => n.id === id));
      assert.equal(env.last().devices.find((d) => d.id === a.id).phones.find((x) => x.name === 'Phone 6').state, 'auto', 'the phone itself is untouched');
      await env.b.op({ op: 'remoteNoticeDismiss', id: 'nope', reqId: 'n1' });
      assert.equal(env.last().opError, undefined, 'dismissing a line that is gone is harmless');
      assert.equal(env.last().notices.length, 4);
    } finally { env.b.stop(); }
  });
});

test('window ops: a phone cannot send them, direct or through an account; PHONE_OPS stays without them', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      for (const op of ['remotePhoneDecision', 'remoteNoticeDismiss']) {
        assert.ok(!PHONE_OPS.includes(op), op);
        assert.equal(checkPhoneCommand({ op, reqId: 'r1' }, { deviceId: 'AbCdEfGhIjKlMnOpQrStUv', paneExists: () => true, paneCount: () => 0 }).ok, false, op);
      }
      const keyA = await createDeviceIdentity();
      const a = await addAccount(env, { phones: [await phoneRecord(keyA, 'allowed', { name: 'Phone A' })] });
      const idA = await deviceIdFor(keyA.pub);
      const newKey = await createDeviceIdentity();
      const viaAcct = await connectAs(env, a, newKey, { name: 'New phone' });
      await settled(viaAcct.c);
      assert.equal(env.last().notices.length, 1);
      const noticeId = env.last().notices[0].id;
      const senders = [['an account phone', viaAcct.c], ['a direct phone', env.p.phone]];
      for (const [who, c] of senders) {
        const before = c.events.filter((e) => e.refused).length;
        await c.cmd({ op: 'remotePhoneDecision', reqId: `d-${who}`, accountDeviceId: a.id, phoneId: idA, action: 'block' });
        await c.cmd({ op: 'remotePhoneDecision', reqId: `f-${who}`, accountDeviceId: a.id, phoneId: await deviceIdFor(newKey.pub), action: 'forget' });
        await c.cmd({ op: 'remoteNoticeDismiss', reqId: `n-${who}`, id: noticeId });
        await c.pump(() => c.events.filter((e) => e.refused).length >= before + 3);
      }
      assert.equal(acctOf(env, a.id).phones.find((x) => x.id === idA).state, 'allowed', 'nothing was blocked');
      assert.ok(acctOf(env, a.id).phones.some((x) => x.pub === b64urlEncode(newKey.pub)), 'nothing was forgotten');
      assert.deepEqual(env.last().notices.map((n) => n.id), [noticeId], 'and the notice is still there');
      assert.equal(env.dispatched.length, 0, 'none of it reached the engine');
    } finally { env.b.stop(); }
  });
});

/* ===== persistence of phones ===== */

test('persistence: phones survive a restart; a rebuilt state.json keeps a Block (secret.json carries the list); a forgotten phone stays forgotten', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    let br = null;
    try {
      const blockedKey = await createDeviceIdentity();
      const enrolledKey = await createDeviceIdentity();
      const a = await addAccount(env, { phones: [await phoneRecord(blockedKey, 'blocked', { name: 'Stolen iPhone', decidedAt: '2026-10-05T00:00:00.000Z' }), await phoneRecord(enrolledKey, 'enrolled', { name: 'Scanned phone' })] });
      const forgetKey = await createDeviceIdentity();
      const k = await connectAs(env, a, forgetKey, { name: 'Forgotten phone' });
      await settled(k.c);
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: await deviceIdFor(forgetKey.pub), action: 'forget' });
      env.b.stop();

      // state.json lost while the keys are there: rebuilt from secret.json, with the phone records.
      fs.rmSync(path.join(dir, 'state.json'));
      fs.rmSync(path.join(dir, 'state.json.bak'), { force: true });
      br = bridgeFor(env.relay, dir);
      await br.b.ready;
      await until(() => br.b.status === 'online');
      const rec = br.b.state.devices.find((d) => d.id === a.id);
      assert.deepEqual(rec.phones.map((x) => [x.name, x.state]).sort(), [['Scanned phone', 'enrolled'], ['Stolen iPhone', 'blocked']], 'both records came back, the Block included');
      assert.equal(rec.phonesForgot.length, 1, 'and the forgotten id');
      assert.equal(rec.phones.find((x) => x.name === 'Stolen iPhone').decidedAt, '2026-10-05T00:00:00.000Z');
      const blocked = await connectAs({ ...br, relay: env.relay, b: br.b }, a, blockedKey, { name: 'Stolen iPhone' });
      await blocked.c.pump(() => blocked.c.alerts.length);
      assert.match(blocked.c.closeReason(), BLOCKED, 'still blocked after the rebuild');
      br.b.stop();

      // A plain restart keeps everything too.
      br = bridgeFor(env.relay, dir);
      await br.b.ready;
      await until(() => br.b.status === 'online');
      assert.equal(br.b.state.devices.find((d) => d.id === a.id).phones.length, 2);
      assert.equal(br.last().devices.find((d) => d.id === a.id).phones.find((x) => x.name === 'Scanned phone').online, false);
    } finally {
      env.b.stop();
      br?.b.stop();
    }
  });
});

test('two engines, one folder: a phone forgotten in one does not come back from the older view of the other, and an Allow after a Block sticks', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    let other = null;
    try {
      const forgetKey = await createDeviceIdentity();
      const unblockKey = await createDeviceIdentity();
      const a = await addAccount(env, { phones: [await phoneRecord(forgetKey, 'auto', { name: 'Old phone' }), await phoneRecord(unblockKey, 'blocked', { name: 'Blocked phone' })] });
      other = bridgeFor(fakeRelay(), dir);
      await other.b.ready;
      await until(() => other.b.status === 'online');
      assert.equal(acctOf(other, a.id).phones.length, 2, 'the second engine has read both');

      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: await deviceIdFor(forgetKey.pub), action: 'forget' });
      await env.b.op({ op: 'remotePhoneDecision', accountDeviceId: a.id, phoneId: await deviceIdFor(unblockKey.pub), action: 'allow' });
      assert.equal(acctOf(other, a.id).phones.length, 2, 'it has not looked yet');

      // Its next write takes in the folder first, so its older view cannot undo either decision.
      assert.equal(other.b.syncFromDisk(), true);
      other.b.saveStateNow();
      const saved = savedPhones(dir, a.id);
      assert.deepEqual(saved.map((x) => [x.name, x.state]), [['Blocked phone', 'allowed']], 'forgotten stays forgotten; the Allow stays');
      assert.ok(acctOf(other, a.id).phonesForgot.length === 1);
    } finally {
      env.b.stop();
      other?.b.stop();
    }
  });
});

test('removing an account takes its phone records and notices with it; linking it again starts clean', async () => {
  await withDir(async (dir) => {
    const env = await setup(dir);
    try {
      const a = await addAccount(env);
      const k = await connectAs(env, a, await createDeviceIdentity(), { name: 'Phone' });
      await settled(k.c);
      assert.equal(env.last().notices.length, 1);
      await env.b.op({ op: 'remoteRevoke', deviceId: a.id });
      assert.equal(env.last().notices.length, 0);
      assert.ok(!env.last().devices.some((d) => d.id === a.id));
      await k.c.pump(() => k.c.alerts.length);
      assert.match(k.c.closeReason(), /removed/);
      assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).devices).includes('"phones"'));
    } finally { env.b.stop(); }
  });
});
