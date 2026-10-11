/**
 * Phone access that lasts (2026-10-10, Arthur: "when pairing a phone, the
 * paired phone should be good to go foreeever"; and "the user should be
 * allowed to choose how long till expiry of that phone connection being
 * valid"). The engine side never drops a phone by accident:
 *   - remote-store.js keeps a .bak of each file and falls back to it when a
 *     file is damaged; a secret.json that cannot be opened is an error, never
 *     "no keys";
 *   - remote.js rebuilds a state.json that does not match the keys from
 *     secret.json (same room, same phones) instead of making new keys, and
 *     two engines sharing the folder merge instead of overwriting;
 *   - a pairing lasts forever unless the user picks 1, 7 or 30 days at Allow
 *     (or later); then it ends like Remove, with an encrypted "expired".
 * And the phone's link (apaki/web/src/link.js, from a real web build) keeps
 * its pairing on the PC's plaintext "unknown device" and gives up only on an
 * encrypted close or its own expiry.
 *
 * The in-memory relay and phone helpers follow apaki-remote-bridge.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PhoneSession, createDeviceIdentity, decodePcFrame, encodePcFrame, parsePairingUrl, roomIdForToken, b64urlEncode, randomBytes,
} from '../apaki/remote/protocol.js';
import { Inbox, Outbox } from '../apaki/remote/wire.js';
import { parsePhoneId } from '../apaki/engine/remote-policy.js';
import * as store from '../apaki/engine/remote-store.js';
import { RemoteBridge, expiryFor, mergeState, mergePhoneLists, LIFETIME_DAYS } from '../apaki/engine/remote.js';
import { build } from '../apaki/scripts/build-web.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-durable-test-'));
const until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };
const DAY = 24 * 60 * 60_000;

/** Runs fn with secrets in a plain user-only file (no PowerShell), in a fresh folder that is removed after. */
async function withDir(fn) {
  const dir = tmp();
  const before = process.env.APAKI_REMOTE_PROTECT;
  process.env.APAKI_REMOTE_PROTECT = 'file';
  try {
    await fn(dir);
  } finally {
    if (before === undefined) delete process.env.APAKI_REMOTE_PROTECT; else process.env.APAKI_REMOTE_PROTECT = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------- relay, phone and bridge helpers */

function fakeRelay() {
  const relay = { pc: null, phones: new Map(), nextConn: 1 };
  const emitTo = (sock, type, data) => { for (const f of sock.listeners[type] || []) f(data); };
  class WS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.listeners = {};
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
  ph.send(await session.start());
  return c;
}

function bridgeFor(relay, dir, extra = {}) {
  const desktop = [];
  const panes = new Map();
  const b = new RemoteBridge({
    emit: (e) => desktop.push(e),
    dispatch: (c) => { if (c.op === 'open' || c.op === 'attach') panes.set(c.paneId, { sessionId: c.sessionId, running: true, busy: false }); if (c.op === 'close') panes.delete(c.paneId); },
    readyEvent: () => ({ ev: 'ready' }),
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
    ...extra,
  });
  return { b, desktop, last: () => desktop[desktop.length - 1] };
}

/** Pairs a new phone through an online bridge; returns the phone and what it saved. */
async function pairPhone({ b, last }, relay, { name = 'Phone', lifetime } = {}) {
  await b.op({ op: 'remotePairStart' });
  const ph = relay.phone();
  await until(() => b.conns.has(ph.conn));
  const device = await createDeviceIdentity();
  const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(last().pairing.url), name }));
  await phone.pump(() => phone.sas);
  await until(() => last().request);
  await b.op({ op: 'remotePairDecision', approve: true, ...(lifetime !== undefined ? { lifetime } : {}) });
  await phone.pump(() => phone.pairing && phone.events.some((e) => e.ev === 'ready'));
  const pairing = JSON.parse(JSON.stringify(phone.pairing));
  return { ph, device, phone, pairing, hello: phone.events.find((e) => e.wire?.t === 'hello').wire };
}

/** A saved phone connecting again: it opens (ready) or gets an alert. */
async function reconnect(b, relay, device, pairing) {
  const ph = relay.phone();
  await until(() => b.conns.has(ph.conn));
  const c = await phoneClient(ph, new PhoneSession({ device, pairing }));
  await c.pump(() => c.events.some((e) => e.ev === 'ready') || c.alerts.length);
  return c;
}

const opened = (c) => c.events.some((e) => e.ev === 'ready');
const files = (dir) => fs.readdirSync(dir).sort();

/* ------------------------------------------------------------------ store */

test('store (durable): a damaged state.json falls back to its .bak; a missing one is missing; no temp files are left', async () => {
  await withDir(async (dir) => {
    assert.equal(store.readState(dir).status, 'missing');
    const s = { v: 1, enabled: true, roomId: 'room-1', pcPub: 'pub', createdAt: 'then', devices: [{ id: 'dev-1', pub: 'p1', name: 'A', pairedAt: 'x', expiresAt: '2030-01-01T00:00:00.000Z', kind: 'account', account: 'Arthur', by: 'iPhone' }] };
    store.saveState(s, dir);
    store.saveState({ ...s, devices: [...s.devices, { id: 'dev-2', pub: 'p2', name: 'B', pairedAt: 'y' }] }, dir);
    assert.ok(fs.existsSync(path.join(dir, 'state.json.bak')), 'the previous copy is kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.bak'), 'utf8')).devices.length, 1);
    const saved = store.readState(dir);
    assert.equal(saved.status, 'ok');
    assert.deepEqual(saved.state.devices[0], { id: 'dev-1', pub: 'p1', name: 'A', pairedAt: 'x', lastSeen: null, kind: 'account', account: 'Arthur', by: 'iPhone', expiresAt: '2030-01-01T00:00:00.000Z' }, 'account and expiry fields survive a save');
    assert.ok(!files(dir).some((f) => f.endsWith('.tmp')));
    // Damaged (a torn write, a bad disk): the last good copy.
    fs.writeFileSync(path.join(dir, 'state.json'), '{"v":1,"enabled":tru');
    const back = store.readState(dir);
    assert.equal(back.status, 'backup');
    assert.equal(back.state.roomId, 'room-1');
    // The next save does not copy the damaged file over the good backup.
    store.saveState(back.state, dir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json.bak'), 'utf8')).roomId, 'room-1');
    // Both damaged: a fresh state, and it says so.
    fs.writeFileSync(path.join(dir, 'state.json'), 'garbage');
    fs.writeFileSync(path.join(dir, 'state.json.bak'), 'garbage');
    assert.equal(store.readState(dir).status, 'corrupt');
    // Deleted on purpose: missing, even with a .bak beside it (deleting the files is how a person resets).
    fs.rmSync(path.join(dir, 'state.json'));
    assert.equal(store.readState(dir).status, 'missing');
    assert.match(fs.readFileSync(path.join(dir, '_WHY_THIS_IS_HERE.md'), 'utf8'), /state\.json\.bak/);
  });
});

test('store (durable): a damaged secret.json falls back to secret.json.bak; with no good copy it throws, never "no keys"', async () => {
  await withDir(async (dir) => {
    assert.equal(await store.loadSecret(dir), null, 'nothing there yet is the only "no keys"');
    await store.saveSecret({ identity: { pub: 'P', jwk: { d: 'D1' } }, token: 'T1', psks: { a: 'psk-a' }, devices: [{ id: 'a', pub: 'pa', name: 'A', pairedAt: 'x', lastSeen: 'y' }] }, dir);
    await store.saveSecret({ identity: { pub: 'P', jwk: { d: 'D1' } }, token: 'T1', psks: { a: 'psk-a', b: 'psk-b' } }, dir);
    const s = await store.loadSecret(dir);
    assert.deepEqual(Object.keys(s.psks), ['a', 'b']);
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"v":1,"scheme":"file","data":"bm90IGpzb24="}');
    const bak = await store.loadSecret(dir);
    assert.equal(bak.fromBackup, true);
    assert.equal(bak.token, 'T1');
    assert.deepEqual(bak.devices.map((d) => d.id), ['a'], 'the list of phones rides along (without last seen)');
    assert.equal(bak.devices[0].lastSeen, undefined);
    fs.writeFileSync(path.join(dir, 'secret.json.bak'), 'not json at all');
    await assert.rejects(store.loadSecret(dir), (e) => e instanceof store.SecretError && e.code === 'unreadable');
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"v":1,"scheme":"rot13","data":"x"}');
    await assert.rejects(store.loadSecret(dir), (e) => e.code === 'unreadable');
  });
});

test('store (phones): the phone keys behind an account device are saved and read back, in both files; pending and damaged records are never kept', async () => {
  await withDir(async (dir) => {
    const acct = {
      id: 'acct-1', pub: 'ap', name: 'Apaki account (Arthur)', pairedAt: 'x', kind: 'account', account: 'Arthur', by: 'iPhone',
      phones: [
        { id: 'p1', pub: 'k1', name: 'One', state: 'enrolled', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-02T00:00:00.000Z', decidedAt: '2026-10-01T00:00:00.000Z', extra: 'dropped' },
        { id: 'p2', pub: 'k2', name: 'Two', state: 'pending', firstSeen: 't', lastSeen: 't', prev: 'auto' },
        { id: 'p3', pub: 'k3', name: 'Three', state: 'blocked', firstSeen: 't', lastSeen: null },
        { id: 'p4', pub: 'k4', name: 'Four', state: 'not-a-state' },
        { id: 'p1', pub: 'k1', name: 'One again', state: 'auto' },
        { nope: true },
      ],
      phonesForgot: [{ id: 'gone', at: '2026-10-03T00:00:00.000Z' }, { at: 'no id' }],
    };
    store.saveState({ v: 1, enabled: true, roomId: 'r', pcPub: 'p', createdAt: 'then', devices: [acct, { id: 'dev-2', pub: 'p2', name: 'Plain phone', pairedAt: 'y' }] }, dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.deepEqual(raw.devices[0].phones.map((x) => x.id), ['p1', 'p3'], 'pending, damaged and repeated records are not written');
    assert.deepEqual(Object.keys(raw.devices[0].phones[0]).sort(), ['decidedAt', 'firstSeen', 'id', 'lastSeen', 'name', 'pub', 'state'], 'known fields only');
    assert.equal(raw.devices[0].phones[0].name, 'One', 'the first record of an id wins');
    assert.deepEqual(raw.devices[0].phonesForgot, [{ id: 'gone', at: '2026-10-03T00:00:00.000Z' }]);
    assert.equal(raw.devices[1].phones, undefined, 'a device with no phone keys carries none');
    assert.equal(raw.devices[1].phonesForgot, undefined);
    const back = store.readState(dir).state.devices[0];
    assert.deepEqual(back.phones.map((x) => [x.id, x.state]), [['p1', 'enrolled'], ['p3', 'blocked']]);
    assert.equal(back.phones[1].lastSeen, null);
    // A state.json an older Apaki wrote has none; a hand-damaged list is cleaned on the way in.
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ v: 1, enabled: true, roomId: 'r', devices: [{ id: 'a', pub: 'p', name: 'n', phones: 'garbage', phonesForgot: [1, null] }, { id: 'b', pub: 'p', name: 'm', phones: [{ id: 'z', pub: 'k', state: 'pending' }, { id: 'y', pub: 'k', state: 'auto' }] }] }));
    const cleaned = store.readState(dir).state.devices;
    assert.equal(cleaned[0].phones, undefined);
    assert.equal(cleaned[0].phonesForgot, undefined);
    assert.deepEqual(cleaned[1].phones.map((x) => x.id), ['y']);

    // secret.json carries the same list (so a rebuilt state.json keeps a Block), without the device's own lastSeen.
    await store.saveSecret({ identity: { pub: 'P', jwk: { d: 'D1' } }, token: 'T1', psks: { 'acct-1': 'psk' }, devices: [acct] }, dir);
    const sec = await store.loadSecret(dir);
    assert.deepEqual(sec.devices[0].phones.map((x) => [x.id, x.state, x.lastSeen]), [['p1', 'enrolled', '2026-10-02T00:00:00.000Z'], ['p3', 'blocked', null]]);
    assert.deepEqual(sec.devices[0].phonesForgot.map((r) => r.id), ['gone']);
    assert.equal(sec.devices[0].lastSeen, undefined);
    assert.match(fs.readFileSync(path.join(dir, '_WHY_THIS_IS_HERE.md'), 'utf8'), /phone keys/);
  });
});

/* ------------------------------------------------- keys and state recovery */

test('bridge (durable): a state.json from another room is rebuilt from secret.json, never new keys; the phone reconnects', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    let br = bridgeFor(relay, dir);
    try {
      await br.b.op({ op: 'remoteEnable' });
      await until(() => br.b.status === 'online');
      const { device, pairing } = await pairPhone(br, relay, { name: 'iPhone (Safari)' });
      const roomId = br.b.state.roomId;
      const pcPub = br.b.state.pcPub;
      br.b.stop();

      // 1. At start, with phone access on: the old file is kept, the state is rebuilt, the phone gets in.
      const stale = { v: 1, enabled: true, roomId: 'AAAAAAAAAAAAAAAAAAAAAA', pcPub: 'old', createdAt: '2026-01-01T00:00:00.000Z', devices: [] };
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(stale));
      br = bridgeFor(relay, dir);
      await br.b.ready;
      await until(() => br.b.status === 'online');
      assert.equal(br.b.state.roomId, roomId, 'the room the phones know');
      assert.equal(br.b.state.pcPub, pcPub, 'the same PC identity');
      assert.equal(br.b.state.devices.length, 1);
      assert.equal(br.b.state.devices[0].name, 'iPhone (Safari)');
      assert.deepEqual(br.last().recovered && { devices: br.last().recovered.devices, lost: br.last().recovered.lost }, { devices: 1, lost: 0 });
      const copy = files(dir).find((f) => f.startsWith('state.json.') && f.endsWith('.before-recovery.bak'));
      assert.ok(copy, files(dir).join(', '));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, copy), 'utf8')).roomId, stale.roomId);
      assert.ok(opened(await reconnect(br.b, relay, device, pairing)), 'the paired phone connects as before');
      br.b.stop();

      // 2. Turning phone access on with a mismatched state (the path that used to make new keys): the same room again.
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...stale, enabled: false }));
      br = bridgeFor(relay, dir);
      await br.b.ready;
      assert.equal(br.b.status, 'off');
      await br.b.op({ op: 'remoteEnable' });
      assert.equal(br.last().opError, undefined);
      assert.equal(br.b.state.roomId, roomId);
      assert.equal(await roomIdForToken((await store.loadSecret(dir)).token), roomId, 'secret.json still holds the original room');
      await until(() => br.b.status === 'online');
      assert.ok(opened(await reconnect(br.b, relay, device, pairing)));
    } finally {
      br.b.stop();
    }
  });
});

test('bridge (durable): state.json lost while the keys are there: phone access comes back on by itself, with every phone', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    let br = bridgeFor(relay, dir);
    try {
      await br.b.op({ op: 'remoteEnable' });
      await until(() => br.b.status === 'online');
      const one = await pairPhone(br, relay, { name: 'Phone one' });
      const two = await pairPhone(br, relay, { name: 'Phone two', lifetime: 30 });
      const roomId = br.b.state.roomId;
      br.b.stop();
      fs.rmSync(path.join(dir, 'state.json'));
      br = bridgeFor(relay, dir);
      await br.b.ready;
      await until(() => br.b.status === 'online');
      assert.equal(br.b.state.enabled, true);
      assert.equal(br.b.state.roomId, roomId);
      assert.deepEqual(br.b.state.devices.map((d) => d.name).sort(), ['Phone one', 'Phone two']);
      assert.ok(br.b.state.devices.find((d) => d.name === 'Phone two').expiresAt, 'its lifetime came back too');
      assert.ok(opened(await reconnect(br.b, relay, one.device, one.pairing)));
      assert.ok(opened(await reconnect(br.b, relay, two.device, two.pairing)));
      assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'and state.json is written again');
    } finally {
      br.b.stop();
    }
  });
});

test('bridge (durable): a secret.json that cannot be opened is an error, never new keys; Start over sets the files aside', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    let br = bridgeFor(relay, dir);
    try {
      await br.b.op({ op: 'remoteEnable' });
      await until(() => br.b.status === 'online');
      await pairPhone(br, relay);
      const roomId = br.b.state.roomId;
      br.b.stop();
      const broken = '{"v":1,"scheme":"file","data":"bm90IGpzb24="}\n';
      fs.writeFileSync(path.join(dir, 'secret.json'), broken);
      fs.writeFileSync(path.join(dir, 'secret.json.bak'), broken);
      const stateBefore = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');

      br = bridgeFor(relay, dir);
      await br.b.ready;
      assert.equal(br.b.status, 'error');
      assert.match(br.b.error, /could not read its saved keys/);
      assert.equal(br.last().keysProblem, 'unreadable');
      await br.b.op({ op: 'remoteEnable', reqId: 'e1' });
      assert.match(br.last().opError, /nothing was replaced/);
      assert.equal(fs.readFileSync(path.join(dir, 'secret.json'), 'utf8'), broken, 'secret.json untouched');
      assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), stateBefore, 'state.json untouched');
      assert.equal(br.b.state.roomId, roomId);
      assert.equal(br.b.identity, null);

      // Start over (the person's choice): renamed aside, never deleted; then new keys.
      await br.b.op({ op: 'remoteReset' });
      assert.equal(br.last().state, 'off');
      assert.equal(br.last().keysProblem, null);
      const aside = files(dir).filter((f) => f.includes('.set-aside-'));
      assert.ok(aside.some((f) => f.startsWith('secret.json.set-aside-')) && aside.some((f) => f.startsWith('state.json.set-aside-')), aside.join(', '));
      assert.ok(fs.existsSync(path.join(dir, '_WHY_THIS_IS_HERE.md')), 'the note stays');
      await br.b.op({ op: 'remoteEnable' });
      assert.notEqual(br.b.state.roomId, roomId);
      await until(() => br.b.status === 'online');
      // Start over is refused while the keys open fine.
      await br.b.op({ op: 'remoteReset', reqId: 'r2' });
      assert.match(br.last().opError, /nothing to start over/);
    } finally {
      br.b.stop();
    }
  });
});

test('bridge (durable): keys DPAPI will not unseal are retried by themselves and never replaced', { skip: !store.dpapiAvailable() }, async () => {
  const dir = tmp();
  try {
    store.saveState({ v: 1, enabled: true, roomId: 'BBBBBBBBBBBBBBBBBBBBBB', pcPub: 'pub', createdAt: null, devices: [] }, dir);
    const sealed = `${JSON.stringify({ v: 1, scheme: 'dpapi-user', data: Buffer.from('not sealed by this user').toString('base64') })}\n`;
    fs.writeFileSync(path.join(dir, 'secret.json'), sealed);
    const relay = fakeRelay();
    const br = bridgeFor(relay, dir, { initRetryMs: [100, 60_000] });
    try {
      await br.b.ready;
      assert.equal(br.b.keysProblem, 'locked');
      assert.match(br.b.error, /tries again by itself/);
      await until(() => br.b.initAttempt >= 2, 30_000);
      assert.equal(fs.readFileSync(path.join(dir, 'secret.json'), 'utf8'), sealed);
      assert.equal(br.b.state.roomId, 'BBBBBBBBBBBBBBBBBBBBBB');
    } finally {
      br.b.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge (durable): an older secret.json gets the list of phones; an account device is still one after a restart', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    let br = bridgeFor(relay, dir);
    try {
      await br.b.op({ op: 'remoteEnable' });
      await until(() => br.b.status === 'online');
      const { device, pairing } = await pairPhone(br, relay, { name: 'Pixel (Chrome)' });
      const acct = await createDeviceIdentity({ extractable: true });
      await br.b.addDevice({ id: 'AcctAcctAcctAcctAcctAc', pub: b64urlEncode(acct.pub), name: 'Apaki account (Arthur)', kind: 'account', account: 'Arthur', by: 'Pixel (Chrome)', psk: b64urlEncode(randomBytes(32)), pairedAt: new Date().toISOString() });
      br.b.stop();
      // As an Apaki from before 2026-10-10 wrote it: no list of phones beside the secrets.
      const s = await store.loadSecret(dir);
      await store.saveSecret({ identity: s.identity, token: s.token, psks: s.psks }, dir);
      assert.equal((await store.loadSecret(dir)).devices.length, 0);

      br = bridgeFor(relay, dir);
      await br.b.ready;
      await until(() => br.b.status === 'online');
      assert.deepEqual((await store.loadSecret(dir)).devices.map((d) => d.name).sort(), ['Apaki account (Arthur)', 'Pixel (Chrome)']);
      const a = br.last().devices.find((d) => d.id === 'AcctAcctAcctAcctAcctAc');
      assert.equal(a.kind, 'account');
      assert.equal(a.account, 'Arthur');
      assert.ok(opened(await reconnect(br.b, relay, device, pairing)));
    } finally {
      br.b.stop();
    }
  });
});

/* --------------------------------------------------------------- lifetimes */

test('lifetimes: forever, 30, 7 or 1 days; anything else is refused', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  assert.deepEqual([...LIFETIME_DAYS].sort((a, b) => a - b), [1, 7, 30]);
  for (const v of [undefined, null, '', 'forever', 0, '0']) assert.equal(expiryFor(v, now), null, String(v));
  assert.equal(expiryFor(1, now), '2026-10-11T12:00:00.000Z');
  assert.equal(expiryFor('7', now), '2026-10-17T12:00:00.000Z');
  assert.equal(expiryFor(30, now), '2026-11-09T12:00:00.000Z');
  for (const v of [2, -1, 1.5, 'week', 365, {}]) assert.throws(() => expiryFor(v, now), /forever or for 1, 7, 30 days/, String(v));
});

test('bridge (lifetime): forever by default; a limit at Allow; it ends like Remove with an encrypted "expired"; changes reach the phone', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    let clock = Date.now();
    const br = bridgeFor(relay, dir, { now: () => clock });
    const { b, last } = br;
    try {
      await b.op({ op: 'remoteEnable' });
      await until(() => b.status === 'online');

      // No lifetime (an older window, or Forever): never expires.
      const forever = await pairPhone(br, relay, { name: 'Forever phone' });
      assert.equal(forever.hello.expiresAt, null);
      assert.equal(last().devices.find((d) => d.name === 'Forever phone').expiresAt, null);
      assert.deepEqual(last().lifetimes, [30, 7, 1]);

      // One day, chosen at Allow.
      const day = await pairPhone(br, relay, { name: 'Day phone', lifetime: 1 });
      const exp = Date.parse(day.hello.expiresAt);
      assert.ok(Math.abs(exp - (clock + DAY)) < 2000, day.hello.expiresAt);
      assert.equal(last().devices.find((d) => d.name === 'Day phone').expiresAt, day.hello.expiresAt);
      assert.ok(fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(day.hello.expiresAt), 'kept on disk');

      // A lifetime Apaki does not offer: refused, and the phone keeps waiting for a real answer.
      await b.op({ op: 'remotePairStart' });
      const ph = relay.phone();
      await until(() => b.conns.has(ph.conn));
      const odd = await phoneClient(ph, new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(last().pairing.url), name: 'Odd phone' }));
      await odd.pump(() => odd.sas);
      await until(() => last().request);
      await b.op({ op: 'remotePairDecision', approve: true, lifetime: 3, reqId: 'x' });
      assert.match(last().opError, /forever or for 1, 7, 30 days/);
      assert.ok(last().request, 'still waiting for Allow or Deny');
      await b.op({ op: 'remotePairDecision', approve: true, lifetime: 'forever' });
      await odd.pump(() => odd.pairing && odd.events.some((e) => e.ev === 'ready'));
      assert.equal(last().devices.find((d) => d.name === 'Odd phone').expiresAt, null);

      // Changed later from the device row: counted from now, and the connected phone hears it.
      const fid = forever.pairing.deviceId;
      await b.op({ op: 'remoteDeviceLifetime', deviceId: fid, lifetime: 7 });
      const seven = last().devices.find((d) => d.id === fid).expiresAt;
      assert.ok(Math.abs(Date.parse(seven) - (clock + 7 * DAY)) < 2000);
      await forever.phone.pump(() => forever.phone.events.some((e) => e.wire?.t === 'lifetime'));
      assert.equal(forever.phone.events.find((e) => e.wire?.t === 'lifetime').wire.expiresAt, seven);
      await b.op({ op: 'remoteDeviceLifetime', deviceId: fid, lifetime: null });
      assert.equal(last().devices.find((d) => d.id === fid).expiresAt, null);
      await b.op({ op: 'remoteDeviceLifetime', deviceId: 'NoSuchDeviceNoSuchDevi', lifetime: 7, reqId: 'n' });
      assert.match(last().opError, /not paired/);

      // Two days on: the day phone is removed while connected, with an encrypted close that says it expired.
      clock += 2 * DAY;
      await b.expireDue();
      assert.ok(!last().devices.some((d) => d.name === 'Day phone'));
      assert.ok(br.desktop.some((e) => e.expired?.some((x) => x.name === 'Day phone')), 'the desktop is told which pairing expired');
      await day.phone.pump(() => day.phone.alerts.some((a) => a.type === 'close'));
      const close = day.phone.alerts.find((a) => a.type === 'close');
      assert.match(close.reason, /expired/);
      assert.match(close.reason, /removed/, 'older phone pages, which only know "removed", still stop');
      assert.ok(day.ph.gone, 'and its relay connection was dropped');
      const again = await reconnect(b, relay, day.device, day.pairing);
      assert.equal(again.alerts[0]?.code, 'unknown-device');
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.ok(saved.removed.some((r) => r.id === day.pairing.deviceId), 'remembered as removed');

      // A phone that expires while away is refused when it comes back, and removed then.
      await b.op({ op: 'remoteDeviceLifetime', deviceId: fid, lifetime: 1 });
      clock += 2 * DAY;
      const late = await reconnect(b, relay, forever.device, forever.pairing);
      assert.equal(late.alerts[0]?.code, 'unknown-device');
      await until(() => !last().devices.some((d) => d.id === fid));
      assert.ok(last().devices.some((d) => d.name === 'Odd phone'), 'a forever phone stays');
    } finally {
      b.stop();
    }
  });
});

/* --------------------------------------------------- two engines, one folder */

test('mergeState: phones either engine knows stay, removals win over older pairings, lastSeen is the later one', () => {
  const mine = { v: 1, enabled: true, roomId: 'r', devices: [{ id: 'a', pairedAt: '2026-10-01', lastSeen: '2026-10-09' }, { id: 'b', pairedAt: '2026-10-01', lastSeen: null }], removed: [] };
  const disk = { v: 1, enabled: false, roomId: 'r', devices: [{ id: 'a', pairedAt: '2026-10-01', lastSeen: '2026-10-08', expiresAt: '2026-11-01' }, { id: 'c', pairedAt: '2026-10-05' }], removed: [{ id: 'b', at: '2026-10-07' }] };
  const m = mergeState(mine, disk);
  assert.deepEqual(m.devices.map((d) => d.id).sort(), ['a', 'c']);
  const a = m.devices.find((d) => d.id === 'a');
  assert.equal(a.lastSeen, '2026-10-09');
  assert.equal(a.expiresAt, '2026-11-01', 'the file is the newest view of other fields');
  assert.equal(m.enabled, false);
  // Paired again after the removal (an account linked again): it stays.
  const re = mergeState({ ...mine, devices: [{ id: 'b', pairedAt: '2026-10-08' }] }, disk);
  assert.ok(re.devices.some((d) => d.id === 'b'));
});

test('mergePhoneLists: by id; a Block wins (unless a later explicit Allow), else the newer lastSeen; a forgotten phone stays forgotten unless seen again after', () => {
  const ph = (id, state, lastSeen, extra = {}) => ({ id, pub: `pub-${id}`, name: id, state, firstSeen: '2026-10-01T00:00:00.000Z', lastSeen, ...extra });
  const mine = {
    phones: [
      ph('block-vs-newer', 'auto', '2026-10-09T00:00:00.000Z'),
      ph('allow-after-block', 'allowed', '2026-10-08T00:00:00.000Z', { decidedAt: '2026-10-08T00:00:00.000Z' }),
      ph('allow-no-stamp', 'allowed', '2026-10-09T00:00:00.000Z'),
      ph('newer-mine', 'allowed', '2026-10-09T00:00:00.000Z'),
      ph('newer-disk', 'auto', '2026-10-02T00:00:00.000Z'),
      ph('only-mine', 'enrolled', '2026-10-03T00:00:00.000Z'),
      ph('forgotten-old', 'auto', '2026-10-04T00:00:00.000Z'),
      ph('forgotten-then-back', 'auto', '2026-10-09T00:00:00.000Z', { firstSeen: '2026-10-07T00:00:00.000Z' }),
    ],
  };
  const disk = {
    phones: [
      ph('block-vs-newer', 'blocked', '2026-10-01T00:00:00.000Z'),
      ph('allow-after-block', 'blocked', '2026-10-09T00:00:00.000Z', { decidedAt: '2026-10-05T00:00:00.000Z' }),
      ph('allow-no-stamp', 'blocked', '2026-10-01T00:00:00.000Z'),
      ph('newer-mine', 'auto', '2026-10-03T00:00:00.000Z'),
      ph('newer-disk', 'allowed', '2026-10-06T00:00:00.000Z'),
      ph('only-disk', 'auto', '2026-10-03T00:00:00.000Z'),
    ],
    phonesForgot: [{ id: 'forgotten-old', at: '2026-10-06T00:00:00.000Z' }, { id: 'forgotten-then-back', at: '2026-10-06T00:00:00.000Z' }],
  };
  const m = mergePhoneLists(mine, disk);
  const by = Object.fromEntries(m.phones.map((p) => [p.id, p]));
  assert.equal(by['block-vs-newer'].state, 'blocked', 'a Block wins even over a record seen later');
  assert.equal(by['block-vs-newer'].lastSeen, '2026-10-09T00:00:00.000Z', 'lastSeen is still the later one');
  assert.equal(by['allow-after-block'].state, 'allowed', 'an Allow decided after the Block beats it');
  assert.equal(by['allow-no-stamp'].state, 'blocked', 'an Allow with no decision stamp does not undo a Block');
  assert.equal(by['newer-mine'].state, 'allowed');
  assert.equal(by['newer-disk'].state, 'allowed');
  assert.equal(by['only-mine'].state, 'enrolled');
  assert.equal(by['only-disk'].state, 'auto');
  assert.equal(by['forgotten-old'], undefined, 'forgotten after it was last decided: gone');
  assert.equal(by['forgotten-then-back'].state, 'auto', 'first seen again after it was forgotten: stays');
  assert.deepEqual(m.phonesForgot.map((r) => r.id).sort(), ['forgotten-old', 'forgotten-then-back']);
  // Either side alone, or neither, merges to itself.
  assert.deepEqual(mergePhoneLists({}, {}), { phones: [], phonesForgot: [] });
  assert.equal(mergePhoneLists({ phones: mine.phones.slice(0, 1) }, {}).phones[0].state, 'auto');
});

test('mergeState: the phone keys behind an account device merge by id instead of one list replacing the other', () => {
  const ph = (id, state, lastSeen) => ({ id, pub: `pub-${id}`, name: id, state, firstSeen: '2026-10-01T00:00:00.000Z', lastSeen });
  const mine = { v: 1, roomId: 'r', devices: [{ id: 'acct', kind: 'account', pairedAt: '2026-10-01', phones: [ph('a', 'auto', '2026-10-05T00:00:00.000Z'), ph('b', 'auto', '2026-10-05T00:00:00.000Z')] }, { id: 'plain', pairedAt: '2026-10-01' }], removed: [] };
  const disk = { v: 1, roomId: 'r', devices: [{ id: 'acct', kind: 'account', pairedAt: '2026-10-01', phones: [ph('a', 'blocked', '2026-10-02T00:00:00.000Z'), ph('c', 'allowed', '2026-10-06T00:00:00.000Z')], phonesForgot: [{ id: 'b', at: '2026-10-06T00:00:00.000Z' }] }, { id: 'plain', pairedAt: '2026-10-01' }], removed: [] };
  const m = mergeState(mine, disk);
  const acct = m.devices.find((d) => d.id === 'acct');
  assert.deepEqual(acct.phones.map((p) => [p.id, p.state]).sort(), [['a', 'blocked'], ['c', 'allowed']], 'a was blocked in the file, b was forgotten there, c is new there');
  assert.deepEqual(acct.phonesForgot, [{ id: 'b', at: '2026-10-06T00:00:00.000Z' }]);
  const plain = m.devices.find((d) => d.id === 'plain');
  assert.equal('phones' in plain, false, 'a device without phone keys gets no empty list');
  assert.equal('phonesForgot' in plain, false);
  // A file written by an Apaki from before phone keys has none: mine stand.
  const old = mergeState(mine, { v: 1, roomId: 'r', devices: [{ id: 'acct', kind: 'account', pairedAt: '2026-10-01' }], removed: [] });
  assert.deepEqual(old.devices.find((d) => d.id === 'acct').phones.map((p) => p.id), ['a', 'b']);
});

test('bridge (two engines): a phone paired in one is let in by the other; an older write cannot drop it; a removal sticks', async () => {
  await withDir(async (dir) => {
    const relayA = fakeRelay();
    const relayB = fakeRelay();
    const A = bridgeFor(relayA, dir);
    let B = null;
    try {
      await A.b.op({ op: 'remoteEnable' });
      await until(() => A.b.status === 'online');
      B = bridgeFor(relayB, dir);
      await B.b.ready;
      await until(() => B.b.status === 'online');
      assert.equal(B.b.state.roomId, A.b.state.roomId, 'one room, one PC');

      // Paired in B; A has never heard of it.
      const p = await pairPhone(B, relayB, { name: 'Shared phone' });
      const id = p.pairing.deviceId;
      assert.equal(A.b.state.devices.length, 0);
      // It reaches A (the relay went to A meanwhile): A reads the folder again and lets it in.
      assert.ok(opened(await reconnect(A.b, relayA, p.device, p.pairing)));
      assert.ok(A.b.state.devices.some((d) => d.id === id));
      assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).devices.some((d) => d.id === id));

      // An Apaki from before this fix writes its stale view (no such phone, no removals): A keeps the phone.
      const cur = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...cur, devices: [], removed: undefined }, null, 2));
      A.b.syncFromDisk();
      assert.ok(A.b.state.devices.some((d) => d.id === id), 'not dropped by an older write');
      A.b.saveStateNow();
      assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).devices.some((d) => d.id === id));

      // Removed in A: B's older view (it still has the phone) cannot bring it back.
      await A.b.op({ op: 'remoteRevoke', deviceId: id });
      assert.ok(B.b.state.devices.some((d) => d.id === id), 'B has not looked yet');
      await B.b.op({ op: 'remoteDisable' });
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.ok(!after.devices.some((d) => d.id === id), 'still removed after B wrote');
      assert.ok(!B.b.state.devices.some((d) => d.id === id));
      assert.equal(B.b.getDevice(id), null);
    } finally {
      A.b.stop();
      B?.b.stop();
    }
  });
});

/* ------------------------------------------------- the phone's link decisions */

test('phone link: "unknown device" keeps the pairing and retries; only an encrypted close or its own expiry ends it', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-durable-web-'));
  const saved = { document: globalThis.document, window: globalThis.window, WebSocket: globalThis.WebSocket };
  try {
    build({ relay: 'wss://relay.example', out });
    // Just enough of a browser for link.js: listeners, and a socket that never opens.
    globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
    const { Link } = await import(pathToFileURL(path.join(out, 'link.js')).href);
    const device = await createDeviceIdentity();
    const pc = await createDeviceIdentity();
    const pairing = { v: 1, roomId: 'CCCCCCCCCCCCCCCCCCCCCC', relay: 'wss://relay.example', pcPub: b64urlEncode(pc.pub), pcName: 'Desk', deviceId: 'DDDDDDDDDDDDDDDDDDDDDD', psk: b64urlEncode(randomBytes(32)), pairedAt: new Date().toISOString() };
    const make = (extra = {}) => {
      const seen = { states: [], fatal: null, unknown: null, lifetime: [] };
      const link = new Link({ device, pairing, ...extra, on: { state: (s) => seen.states.push(s), fatal: (code) => { seen.fatal = code; }, unknown: (info) => { seen.unknown = info; }, lifetime: (v) => seen.lifetime.push(v) } });
      return { link, seen };
    };

    // Plaintext "unknown device": not the end. The pairing stays, a slow retry is set, nothing is fatal.
    let { link, seen } = make();
    link.alert('unknown-device');
    assert.equal(link.state, 'unknown');
    assert.equal(seen.fatal, null);
    assert.equal(link.stopped, false);
    assert.ok(seen.unknown.retryInMs >= 60_000);
    assert.ok(link.timers.retry, 'it will try again');
    assert.equal(link.pairing, pairing);
    link.stop();

    // The expiry the PC gave it (hello, earlier) has passed: then "unknown device" is final, and says expired.
    ({ link, seen } = make({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    link.alert('unknown-device');
    assert.equal(seen.fatal, 'lapsed');
    link.stop();

    // Encrypted closes: expired, removed, or phone access turned off (just wait).
    ({ link, seen } = make());
    link.closedByPc('This phone\'s pairing expired, so it was removed on the PC.');
    assert.equal(seen.fatal, 'lapsed');
    link.stop();
    ({ link, seen } = make());
    link.closedByPc('This phone was removed on the PC.');
    assert.equal(seen.fatal, 'removed');
    link.stop();
    ({ link, seen } = make());
    link.closedByPc('Phone access was turned off on the PC.');
    assert.equal(seen.fatal, null);
    assert.equal(link.state, 'waiting');

    // hello and lifetime carry the expiry; an older PC's hello (no field) changes nothing.
    const when = new Date(Date.now() + 7 * DAY).toISOString();
    link.message(() => ({ t: 'hello', pcName: 'Desk', ops: [] }));
    assert.deepEqual(seen.lifetime, []);
    link.message(() => ({ t: 'hello', pcName: 'Desk', ops: [], expiresAt: when }));
    assert.equal(link.expiresAt, when);
    link.message(() => ({ t: 'lifetime', expiresAt: null }));
    assert.equal(link.expiresAt, null);
    assert.deepEqual(seen.lifetime, [when, null]);
    link.stop();
  } finally {
    Object.assign(globalThis, saved);
    for (const k of ['document', 'window', 'WebSocket']) if (saved[k] === undefined) delete globalThis[k];
    fs.rmSync(out, { recursive: true, force: true });
  }
});
