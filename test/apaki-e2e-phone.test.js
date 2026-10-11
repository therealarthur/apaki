/**
 * Phone enrollment and phone keys, end to end (2026-10-11, apaki/remote/ENROLL.md): the REAL phone code talking
 * to the REAL PC code. Two agents built the halves apart and each half was tested against a stand-in for the other:
 * test/apaki-remote-bridge.test.js and test/apaki-remote-enroll.test.js drive the PC with a scripted phone, and
 * test/apaki-web-phone.test.js drives the page with a fake socket and a fake PC. Nothing ran one against the other.
 * This file takes both stand-ins away.
 *
 * Real, phone side: a web build (apaki/scripts/build-web.mjs, the build the web-phone test loads) and in it
 * boot.js (the first phone, which scans the QR address), link.js, account.js, store.js, phonekey.js and the
 * protocol.js and wire.js copies. Each phone is its own build in its own folder, so each has its own store.js
 * (its own IndexedDB and its own phone key), like two browsers.
 * Real, PC side: engine/remote.js RemoteBridge with engine/remote-store.js on a temp folder, and
 * remote/protocol.js and wire.js.
 *
 * Pretend:
 *   - the relay: in memory, after relay/src/index.js. Frames in order, a text control for join and leave, and,
 *     like the real relay's closeWith, a { t: 'bye' } text right after the PC's kick, with the PC's encrypted
 *     close frame ahead of it (so a close the PC sends before it kicks reaches the phone first, then the bye);
 *   - the browser: IndexedDB, DOM, storages and fetch (the Apaki account server), copied from
 *     test/apaki-web-phone.test.js;
 *   - the passkey sign-in itself (WebAuthn, PRF): each phone is handed what a real sign-in leaves it with, the
 *     account's vault key and device key. Everything after that (the vault on the server, account.link,
 *     account.refresh, the account PC in the phone's list) is the page's own code;
 *   - the PC's engine: dispatch answers a session list and an open, the way the engine would.
 *
 * Why the relay hands over the PC's close frame and the bye behind it back to back (2026-10-11): the PC closes a
 * phone by sending the encrypted close and then a kick, and the real relay answers the kick with a bye text and a
 * close. Run against that, the page lost the PC's reason (BLOCKED, "switched to Private", the update message) to
 * the bye that followed it, and a blocked phone dialed again. Link.afterFrames in apaki/web/src/link.js is the fix;
 * steps 3 and 4 fail without it.
 *
 * Timers: the PC's VIA_GRACE_MS is shortened through the bridge's viaGraceMs option (the product default stays
 * 8 s). The page's own timers are not touched; the one wait that depends on them is the 0.8 s first backoff.
 *
 * What each step proves, with assertions on both sides:
 *   1. QR pairing through Allow on the PC, then a phone that is already signed in sends the enrolling
 *      account-link by itself: the PC adds the account device with NO approval card, the phone's vault holds the
 *      PC with the device id and psk the PC keeps, and the phone's key is recorded under the account as enrolled.
 *   2. A second phone of the same account (its own phone key) connects through the account in Connected: it is
 *      held until its signed via is checked (no ready event, no cached or live events, not "connected" on the PC),
 *      then phone-ok, the PC shows a new-phone notice and the record is auto, and a session list and an open work.
 *   3. Switched to Private, that phone is closed, reconnects, hears phone-wait while the PC shows the request;
 *      Allow lets it in (phone-ok); Block ends its Link with the BLOCKED close and it does not dial again.
 *   4. A page without the phone key feature (it sends the older { t: 'via', name }) is held in Private, its
 *      commands are ignored, and it is closed with the update message after the grace time.
 *
 * Not covered here (needs a real browser): how any screen looks, the passkey prompt, the iOS app's Secure
 * Enclave key. boot.js runs with appStarted already true, so a pairing that opens does not try to load app.js
 * (the app's own window code needs a real DOM); everything before that point is the page's real flow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from '../apaki/scripts/build-web.mjs';
import {
  b64urlDecode, b64urlEncode, concat, createDeviceIdentity, decodePcFrame, deviceIdFor, encodePcFrame, randomBytes,
} from '../apaki/remote/protocol.js';
import { parsePhoneId } from '../apaki/engine/remote-policy.js';
import { RemoteBridge } from '../apaki/engine/remote.js';

const subtle = globalThis.crypto.subtle;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 4000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/* ===== the relay ===== */

/**
 * An in-memory relay with the behaviour of relay/src/index.js that both halves rely on. `PcWS` is the WebSocket
 * class handed to the bridge (as in test/apaki-remote-bridge.test.js); `PhoneWS` is the page's global WebSocket,
 * with the API link.js uses (onopen, onmessage, onclose, binaryType, send, close, readyState). Messages to a phone
 * are delivered one event-loop turn after they are sent, in order, so a close frame and the bye after it arrive
 * back to back, as they do from the real relay.
 */
function fakeRelay() {
  const relay = { pc: null, roomId: null, phones: new Map(), nextConn: 1, phoneSockets: [] };
  const emitTo = (sock, type, data) => { for (const f of sock.listeners[type] || []) f(data); };
  const toPc = (data) => { if (relay.pc) emitTo(relay.pc, 'message', { data }); };

  class PcWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.listeners = {};
      relay.roomId = /\/rooms\/([^/]+)\/pc$/.exec(url)?.[1] ?? null;
      queueMicrotask(() => {
        if (relay.pc) relay.pc.close();
        relay.pc = this;
        this.readyState = 1;
        emitTo(this, 'open', {});
        emitTo(this, 'message', { data: JSON.stringify({ t: 'ready', role: 'pc', phones: [...relay.phones.keys()], limits: {} }) });
        for (const ph of relay.phones.values()) ph.recv(JSON.stringify({ t: 'pc', up: true }));
      });
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(data) {
      if (this.readyState !== 1) return;
      if (typeof data === 'string') {
        if (data === 'ping') { queueMicrotask(() => emitTo(this, 'message', { data: 'pong' })); return; }
        const m = JSON.parse(data);
        if (m.t === 'kick') relay.phones.get(m.conn)?.byeAndClose(4003, 'closed by the PC');
        return;
      }
      const { connId, payload } = decodePcFrame(new Uint8Array(data));
      const phone = relay.phones.get(connId);
      if (phone) phone.recv(payload.slice().buffer);
      else queueMicrotask(() => toPc(JSON.stringify({ t: 'leave', conn: connId })));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (relay.pc === this) relay.pc = null;
      queueMicrotask(() => emitTo(this, 'close', { code: 1000 }));
    }
  }

  class PhoneWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.binaryType = 'blob';
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.conn = 0;
      this.room = /\/rooms\/([^/]+)\/phone$/.exec(url)?.[1] ?? null;
      relay.phoneSockets.push(this);
      setImmediate(() => this.open());
    }
    open() {
      if (this.readyState !== 0) return;
      this.conn = relay.nextConn++;
      this.readyState = 1;
      relay.phones.set(this.conn, this);
      this.onopen?.({});
      this.recv(JSON.stringify({ t: 'ready', role: 'phone', conn: this.conn, pc: Boolean(relay.pc), limits: {} }));
      if (relay.pc) toPc(JSON.stringify({ t: 'join', conn: this.conn }));
    }
    /** The relay hands the phone a message (a string control or an ArrayBuffer frame), one turn from now, in order. */
    recv(data) {
      setImmediate(() => { if (this.readyState === 1) this.onmessage?.({ data }); });
    }
    send(data) {
      if (this.readyState !== 1) return;
      if (typeof data === 'string') {
        if (data === 'ping') this.recv('pong');
        else this.byeAndClose(4010, 'phones send binary frames only');
        return;
      }
      if (!relay.pc) { this.byeAndClose(4404, 'no PC in this room'); return; }
      const frame = encodePcFrame(this.conn, data instanceof Uint8Array ? data : new Uint8Array(data)).buffer;
      setImmediate(() => toPc(frame));
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      setImmediate(() => this.finish(1000));
    }
    /** The relay's closeWith: the bye text first, then the close. */
    byeAndClose(code, reason) {
      this.recv(JSON.stringify({ t: 'bye', code, reason }));
      setImmediate(() => this.finish(code));
    }
    finish(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (relay.phones.get(this.conn) === this) {
        relay.phones.delete(this.conn);
        toPc(JSON.stringify({ t: 'leave', conn: this.conn }));
      }
      this.onclose?.({ code });
    }
  }

  relay.PcWS = PcWS;
  relay.PhoneWS = PhoneWS;
  return relay;
}

/* ===== browser fakes ===== */

/** Just enough IndexedDB for store.js (copied from test/apaki-web-phone.test.js): open with upgrade, stores by keyPath, one writer at a time. */
function fakeIndexedDB() {
  const dbs = new Map();
  const makeDb = (rec) => ({
    objectStoreNames: { contains: (n) => rec.stores.has(n) },
    createObjectStore(name, { keyPath }) { rec.stores.set(name, { keyPath, rows: new Map(), lock: Promise.resolve() }); },
    onversionchange: null,
    onclose: null,
    close() {},
    transaction(name, mode) {
      const st = rec.stores.get(name);
      if (!st) throw new DOMException('no such store', 'NotFoundError');
      const prev = st.lock;
      let release = () => {};
      if (mode === 'readwrite') st.lock = new Promise((r) => { release = r; });
      const started = mode === 'readwrite' ? prev : Promise.resolve();
      const t = { error: null, oncomplete: null, onerror: null, onabort: null };
      let pending = 0;
      let done = false;
      const finish = () => { if (pending === 0 && !done) { done = true; release(); t.oncomplete?.(); } };
      const req = (fn) => {
        pending += 1;
        const r = { result: undefined, onsuccess: null };
        started.then(() => setTimeout(() => {
          r.result = fn();
          r.onsuccess?.({ target: r });
          pending -= 1;
          setTimeout(finish, 0);
        }, 0));
        return r;
      };
      const clone = (v) => (v === undefined ? undefined : structuredClone(v));
      const api = {
        get: (k) => req(() => clone(st.rows.get(k))),
        getAll: () => req(() => [...st.rows.values()].map(clone)),
        put: (v) => req(() => { st.rows.set(v[st.keyPath], clone(v)); }),
        delete: (k) => req(() => { st.rows.delete(k); }),
      };
      t.objectStore = () => api;
      return t;
    },
  });
  return {
    dbs,
    open(name, version) {
      const r = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        let rec = dbs.get(name);
        if (!rec) { rec = { version: 0, stores: new Map() }; dbs.set(name, rec); }
        const want = version || rec.version || 1;
        if (want < rec.version) { r.error = new DOMException('older', 'VersionError'); r.onerror?.({ preventDefault() {} }); return; }
        r.result = makeDb(rec);
        if (want > rec.version) { rec.version = want; r.onupgradeneeded?.({}); }
        r.onsuccess?.({});
      }, 0);
      return r;
    },
  };
}

/**
 * Just enough browser for boot.js to start (copied from test/apaki-web-phone.test.js, with the user agent and the
 * address as parameters): elements keep their innerHTML, a toast can be read back, location carries the QR address.
 */
function fakeBrowser({ ua }) {
  const els = new Map();
  const created = [];
  const makeEl = (id = '') => ({
    id, hidden: false, _html: '', dataset: {}, style: { setProperty() {} }, textContent: '', value: '', className: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    set innerHTML(h) { this._html = h; },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      if (sel !== '[data-k]') return [];
      return [...this._html.matchAll(/data-k="([^"]+)"(?: data-id="([^"]*)")?/g)].map((m) => ({ dataset: { k: m[1], id: m[2] }, onclick: null, disabled: false }));
    },
    querySelector() { return makeEl(); },
    addEventListener() {}, removeEventListener() {}, append() {}, setAttribute() {}, focus() {}, closest() { return null; },
  });
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
  const location = { host: 'apaki.myrlin.io', hash: '', search: '', pathname: '/', href: 'https://apaki.myrlin.io/', replace() {} };
  globalThis.document = {
    getElementById: el, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    querySelector: (sel) => (sel === '.toast' ? created.find((e) => e.className === 'toast') || null : null),
    createElement: () => { const e = makeEl(); created.push(e); return e; },
    body: makeEl('body'), documentElement: makeEl('html'),
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  globalThis.localStorage = memory();
  globalThis.sessionStorage = memory();
  globalThis.history = { replaceState() {} };
  globalThis.CSS = { escape: (x) => x };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.location = location;
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua, vibrate() {} }, configurable: true, writable: true });
  return { el, location, toast: () => created.find((e) => e.className === 'toast') };
}

/** A fake apaki.myrlin.io (copied from test/apaki-web-phone.test.js): GET /v1/account and PUT /v1/account/vault, keeping the opaque vault like the real server. */
function fakeAccountServer() {
  const server = { vault: null, puts: [], calls: [], online: new Set() };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    server.calls.push(`${method} ${url}`);
    const room = /^\/v1\/rooms\/([^/]+)\/presence$/.exec(url);
    if (room) return reply(200, { pc: server.online.has(room[1]) });
    if (url === '/v1/account' && method === 'GET') return reply(200, { account: { name: 'Arthur' }, vault: server.vault });
    if (url === '/v1/account/vault' && method === 'PUT') {
      const body = JSON.parse(init.body);
      server.puts.push(body);
      server.vault = { ver: (server.vault?.ver ?? 0) + 1, ...body.vault };
      return reply(200, { ver: server.vault.ver });
    }
    return reply(404, { error: 'no such route', code: 'not-found' });
  };
  return server;
}

/* ===== phones and account ===== */

const BUILD_RELAY = 'wss://apaki.myrlin.io';

/**
 * One phone: its own web build, so its own store.js, account.js, link.js and protocol.js, and its own IndexedDB
 * (store.js opens the database on first use and keeps it, so the global is pointed at this phone's before that).
 * The phone key is made here, once, the way the page makes it on first use.
 */
async function loadWorld(label, outs) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `apaki-e2e-${label}-`));
  outs.push(out);
  build({ relay: BUILD_RELAY, out });
  // A built page is plain ES modules; saying so keeps Node from parsing each file twice and warning about it.
  fs.writeFileSync(path.join(out, 'package.json'), '{ "type": "module" }\n');
  globalThis.indexedDB = fakeIndexedDB();
  const imp = (name) => import(pathToFileURL(path.join(out, name)).href);
  const store = await imp('store.js');
  const account = await imp('account.js');
  const { Link } = await imp('link.js');
  const phoneKey = await store.getPhoneKey();
  return { label, out, store, account, Link, phoneKey };
}

/** What a real sign-in leaves on a phone, made once for the pretend account: the vault key and the account's device key. */
async function makeAccount() {
  const device = await createDeviceIdentity({ extractable: true });
  const vaultKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { accountId: b64urlEncode(randomBytes(16)), name: 'Arthur', device, vaultKey };
}

/** Signs a phone in to the account the way account.signIn would leave it (store.js 'me'), minus the passkey prompt. */
async function signIn(world, a) {
  await world.store.saveAccount({
    accountId: a.accountId, name: a.name, session: 'a.b', sessionExp: Math.floor(Date.now() / 1000) + 86_400, ver: 0,
    vaultKey: a.vaultKey, device: { privateKey: a.device.privateKey, pub: a.device.pub }, devicePub: b64urlEncode(a.device.pub), rooms: [],
  });
}

/** The vault the pretend server holds, opened with the account's vault key (ACCOUNTS.md: AES-GCM, aad "apaki/v1 vault" || account id). */
async function openServerVault(server, a) {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(server.vault.iv), additionalData: concat('apaki/v1 vault', b64urlDecode(a.accountId)) },
    a.vaultKey,
    b64urlDecode(server.vault.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Loads boot.js of a phone's build, with a hook appended that hands out its state. main() runs at import and finds
 * the QR address in location, so the page does its own pairing. appStarted is already true: the app's window code
 * (app.js) needs a real DOM, and a pairing that opens would otherwise load it.
 */
async function loadBoot(world) {
  let src = fs.readFileSync(path.join(world.out, 'boot.js'), 'utf8');
  src += '\nS.appStarted = true;\nS.appReady = true;\nglobalThis.__boot = { S, linkHandlers };\n';
  const file = path.join(world.out, 'boot-under-test.js');
  fs.writeFileSync(file, src);
  await import(pathToFileURL(file).href);
  return globalThis.__boot;
}

/** Callbacks for a Link, and a log of everything the page was told, in order. */
function tracer() {
  const t = { log: [], events: [], states: [], fatal: null, hello: null };
  t.on = {
    state: (s, info) => { t.states.push([s, info]); t.log.push(`state:${s}`); },
    open: (first) => t.log.push(`open:${first}`),
    hello: (m) => { t.hello = m; t.log.push('hello'); },
    phone: (e) => t.log.push(`phone:${e.kind}`),
    fatal: (code, message) => { t.fatal = { code, message }; t.log.push(`fatal:${code}`); },
  };
  t.attach = (link) => { link.onEvent = (ev) => { t.events.push(ev); t.log.push(`ev:${ev.ev}`); }; return link; };
  t.since = (mark) => t.log.slice(mark);
  return t;
}

/* ===== the PC ===== */

/** The bridge on a temp folder, wired to the relay's PC socket; its engine answers a session list and an open. */
function bridgeFor(relay, dir, extra = {}) {
  const desktop = [];
  const dispatched = [];
  const panes = new Map();
  const ref = { b: null };
  const dispatch = (c) => {
    dispatched.push(c);
    if (c.op === 'open' || c.op === 'attach') panes.set(c.paneId, { sessionId: c.sessionId, running: true, busy: false });
    if (c.op === 'close') panes.delete(c.paneId);
    // The engine's answers, routed back through the bridge (to the phone namespace the command came from).
    if (c.op === 'sessions') setImmediate(() => ref.b.route({ ev: 'sessions', reqId: c.reqId, items: [{ id: 's-0001', title: 'First chat' }], folders: [] }));
    if (c.op === 'open') setImmediate(() => ref.b.route({ ev: 'opened', reqId: c.reqId, paneId: c.paneId, sessionId: 's-0001' }));
  };
  const b = new RemoteBridge({
    emit: (e) => desktop.push(e),
    dispatch,
    readyEvent: () => ({ ev: 'ready', model: 'claude-opus-5-5', voice: false }),
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
    WebSocket: relay.PcWS,
    relay: 'ws://127.0.0.1:9',
    web: 'http://127.0.0.1:9/',
    pcName: 'Test PC',
    log: () => {},
    pageCheck: false,
    recheckFirstMs: 3_600_000,
    // An account connection waits this long for a signed via before it is taken for an older page (product default 8 s).
    viaGraceMs: 1200,
    ...extra,
  });
  ref.b = b;
  return { b, desktop, dispatched, panes, last: () => desktop[desktop.length - 1] };
}

/* ===== the test ===== */

test('phone enrollment and phone keys, end to end: the real web client against the real RemoteBridge', { timeout: 120_000 }, async (t) => {
  const outs = [];
  const links = [];
  const protectBefore = process.env.APAKI_REMOTE_PROTECT;
  process.env.APAKI_REMOTE_PROTECT = 'file';
  const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-e2e-pc-'));

  const dom = fakeBrowser({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const server = fakeAccountServer();
  const relay = fakeRelay();
  globalThis.WebSocket = relay.PhoneWS;
  const env = bridgeFor(relay, pcDir);
  const { b, desktop, dispatched, last } = env;
  const account = await makeAccount();
  const acctId = await deviceIdFor(account.device.pub);
  const acctOnPc = () => last().devices.find((d) => d.kind === 'account');
  const phonesOnPc = () => acctOnPc().phones;

  let world1 = null;
  let boot = null;
  let phone1Id = null;
  let world2 = null;
  let phone2Id = null;
  let accountPc = null;
  const two = tracer();
  let link2 = null;

  try {
    await b.op({ op: 'remoteEnable' });
    await until(() => b.status === 'online', 4000, 'the PC to reach the relay');
    const roomId = b.state.roomId;

    /* ===== step 1 ===== */
    await t.test('1. QR pairing, then a signed-in phone enrolls its account: no card on the PC, the vault gets the PC, the phone key is enrolled', async () => {
      await b.op({ op: 'remotePairStart' });
      const qr = last().pairing.url;
      assert.match(qr, /^http:\/\/127\.0\.0\.1:9\/#p=/);

      // Phone one is signed in to the account already, then opens the QR address: the page's own start (main -> pair).
      world1 = await loadWorld('phone1', outs);
      await signIn(world1, account);
      phone1Id = await deviceIdFor(world1.phoneKey.pub);
      dom.location.hash = qr.slice(qr.indexOf('#'));
      dom.location.href = qr;
      boot = await loadBoot(world1);

      // Both screens show the same code; the person at the PC clicks Allow.
      await until(() => boot.S.link && boot.S.sas, 5000, 'the phone to show the pairing code');
      await until(() => last().request, 4000, 'the PC to show the pairing request');
      assert.equal(last().request.sas, boot.S.sas, 'the same six digits on both screens');
      assert.equal(last().request.name, 'iPhone (Safari)', 'the PC shows the name the page chose');
      assert.equal(last().pairing, null, 'the QR is spent');
      const link1 = boot.S.link;
      links.push(link1);
      assert.equal(link1.phone.pub.length, 65, 'the page gave this Link its phone key');
      await b.op({ op: 'remotePairDecision', approve: true });
      await until(() => link1.state === 'open', 5000, 'the pairing to open');
      await until(() => link1.hello, 3000, 'hello on the scanned phone');
      assert.ok(link1.supports('enroll') && link1.supports('phone-key'), 'hello offers the version 2 features');
      assert.equal(b64urlDecode(link1.hello.nonce).length, 16);

      // The page now sends the enrolling account-link by itself (boot.js hello -> offerEnroll -> linkCurrent -> account.link).
      await until(() => dom.toast()?.textContent === 'Test PC was added to your account.', 6000, 'the page to say the PC was added');
      assert.equal(dom.toast().classList.contains('bad'), false);
      await until(() => acctOnPc(), 2000, 'the account device on the PC');

      // PC side: added at once, never asked.
      assert.ok(!desktop.some((e) => e.linkRequest || e.linkRequested), 'no approval card was ever shown');
      assert.equal(last().devices.length, 2, 'the pairing phone and the account device');
      const acctDev = acctOnPc();
      assert.equal(acctDev.id, acctId);
      assert.equal(acctDev.name, 'Apaki account (Arthur)');
      assert.equal(acctDev.account, 'Arthur');
      assert.equal(acctDev.by, 'iPhone (Safari)');
      assert.equal(acctDev.cap, 'full', 'the pairing phone\'s access');
      assert.deepEqual(
        phonesOnPc().map(({ id, pub, name, state, online }) => ({ id, pub, name, state, online })),
        [{ id: phone1Id, pub: b64urlEncode(world1.phoneKey.pub), name: 'iPhone (Safari)', state: 'enrolled', online: false }],
        'the pairing phone\'s own key is recorded under the account, enrolled',
      );
      const saved = fs.readFileSync(path.join(pcDir, 'state.json'), 'utf8');
      assert.ok(saved.includes(phone1Id));

      // Phone side: the vault on the server holds the PC with the id and psk the PC keeps.
      assert.equal(server.puts.length, 1, 'the vault was written once');
      const vault = await openServerVault(server, account);
      assert.equal(vault.pcs.length, 1);
      const rec = vault.pcs[0];
      assert.equal(rec.roomId, roomId);
      assert.equal(rec.relay, 'ws://127.0.0.1:9');
      assert.equal(rec.pcPub, b64urlEncode(b.identity.pub));
      assert.equal(rec.pcName, 'Test PC');
      assert.equal(rec.deviceId, acctId);
      assert.equal(b64urlDecode(rec.psk).length, 32);
      assert.equal(rec.psk, b.secret.psks[acctId], 'the psk in the phone\'s vault is the one the PC will check');
      assert.ok(!saved.includes(rec.psk), 'and it is not in the PC\'s public state');
      const acct1 = await world1.store.getAccount();
      assert.ok(acct1.rooms.includes(roomId));
      const mine = await world1.store.getPc(roomId);
      assert.equal(mine.via, undefined, 'the phone keeps its own direct pairing for this PC');
      assert.notEqual(mine.pairing.deviceId, acctId);
      assert.equal(boot.S.enrollOffer, false, 'once per pairing');
    });

    /* ===== step 2 ===== */
    await t.test('2. a second phone of the account connects in Connected: held, then phone-ok; notice and auto record; a command works', async () => {
      assert.equal(last().mode, 'connected');
      // The second phone: its own build and storage, its own phone key, signed in to the same account.
      world2 = await loadWorld('phone2', outs);
      await signIn(world2, account);
      phone2Id = await deviceIdFor(world2.phoneKey.pub);
      assert.notEqual(phone2Id, phone1Id, 'a different phone key');
      const synced = await world2.account.refresh();
      assert.ok(synced.acct.rooms.includes(roomId), 'the page took the account\'s PC in from the vault');
      const pcs = await world2.store.listPcs();
      assert.equal(pcs.length, 1);
      accountPc = pcs[0];
      assert.equal(accountPc.via, 'account');
      assert.equal(accountPc.pairing.deviceId, acctId);
      assert.equal(accountPc.pairing.psk, b.secret.psks[acctId]);

      // Something in the PC's cache, so "no cached events before phone-ok" means something.
      b.route({ ev: 'folders', folders: [{ path: 'C:\\old' }] });

      // The page's own phone key, with its signing held back: a phone whose via is not on its way yet.
      let release = null;
      const gate = new Promise((r) => { release = r; });
      const gated = { pub: world2.phoneKey.pub, sign: async (bytes) => { await gate; return world2.phoneKey.sign(bytes); } };
      link2 = two.attach(new world2.Link({ device: accountPc.device, pairing: accountPc.pairing, name: 'Pixel (Chrome)', phone: gated, viaAccount: true, on: two.on }));
      links.push(link2);
      link2.start();
      await until(() => two.hello, 5000, 'hello on the second phone');
      assert.equal(two.hello.asAccount, true);
      assert.equal(two.hello.mode, 'connected');
      assert.ok(two.hello.features.includes('phone-key'));
      assert.equal(b64urlDecode(two.hello.nonce).length, 16);

      // Held: the PC has sent hello and nothing else, and says nothing the phone could use.
      b.route({ ev: 'folders', folders: [{ path: 'C:\\new' }] });
      b.route({ ev: 'note', paneId: `phone:${acctId}:p9`, tone: '', text: 'for the account\'s other phone' });
      await sleep(200);
      const heldConn = [...b.conns.values()].find((c) => c.device?.id === acctId);
      assert.ok(heldConn && heldConn.held === true, 'the PC holds the connection');
      assert.equal(heldConn.phone, null, 'no phone key proven yet');
      assert.equal(acctOnPc().connected, false, 'a held connection is not a connected phone');
      assert.equal(link2.state, 'handshake', 'the page is not open either');
      assert.deepEqual(two.log, ['state:connecting', 'state:handshake', 'hello'], 'the page heard hello and nothing else');
      assert.deepEqual(two.events, []);
      assert.equal(last().notices.length, 0);

      // The via goes out (signed over the PC's nonce): the PC checks it, adds the phone as auto, lets it in.
      release();
      await until(() => link2.state === 'open', 5000, 'phone-ok on the second phone');
      await until(() => two.events.some((e) => e.ev === 'folders'), 3000, 'the cached broadcast');
      const log = two.log;
      const at = (what) => log.indexOf(what);
      assert.ok(at('hello') < at('open:true') && at('open:true') < at('ev:ready'), `hello, then open, then events: ${log.join(' ')}`);
      assert.ok(log.includes('phone:ok'));
      assert.ok(at('phone:ok') < at('ev:ready'), 'no event before phone-ok');
      const folders = two.events.filter((e) => e.ev === 'folders');
      assert.equal(folders.length, 1);
      assert.deepEqual(folders[0].folders, [{ path: 'C:\\new' }], 'the cache holds the newest one, delivered once it is in');
      assert.ok(!two.events.some((e) => e.ev === 'note'), 'the account\'s other conversations were not told to a held phone');

      // PC side: notice with Block, record auto, phone key proven.
      await until(() => acctOnPc().phones.some((p) => p.id === phone2Id && p.online), 3000, 'the phone online on the PC');
      const rec2 = phonesOnPc().find((p) => p.id === phone2Id);
      assert.equal(rec2.state, 'auto');
      assert.equal(rec2.name, 'Pixel (Chrome)');
      assert.equal(rec2.pub, b64urlEncode(world2.phoneKey.pub));
      assert.equal(phonesOnPc().find((p) => p.id === phone1Id).state, 'enrolled', 'the first phone is as it was');
      assert.equal(last().notices.length, 1);
      const notice = last().notices[0];
      assert.equal(notice.kind, 'new-phone');
      assert.equal(notice.name, 'Pixel (Chrome)');
      assert.equal(notice.account, 'Arthur');
      assert.equal(notice.accountDeviceId, acctId);
      assert.equal(notice.phoneId, phone2Id);
      assert.equal(acctOnPc().connected, true);
      assert.deepEqual(acctOnPc().via, ['Pixel (Chrome)']);
      assert.equal(last().phoneRequest, null, 'Connected asks nobody');

      // A command from the phone works end to end: checked, put in the account's namespace, answered, put back.
      await link2.send({ op: 'sessions', reqId: 'r1' });
      await until(() => two.events.some((e) => e.ev === 'sessions' && e.reqId === 'r1'), 3000, 'the session list');
      assert.deepEqual(two.events.find((e) => e.ev === 'sessions').items, [{ id: 's-0001', title: 'First chat' }]);
      await link2.send({ op: 'open', reqId: 'r2', paneId: 'p1', sessionId: null, warm: true, model: 'claude-haiku-5-5' });
      await until(() => two.events.some((e) => e.ev === 'opened' && e.reqId === 'r2'), 3000, 'the open answer');
      const opened = two.events.find((e) => e.ev === 'opened');
      assert.equal(opened.paneId, 'p1', 'the phone hears its own ids');
      assert.equal(opened.sessionId, 's-0001');
      const sent = dispatched.find((c) => c.op === 'open');
      assert.equal(sent.reqId, `phone:${acctId}:r2`);
      assert.equal(sent.paneId, `phone:${acctId}:p1`);
    });

    /* ===== step 3 ===== */
    await t.test('3. Private: the auto phone is asked again (phone-wait, card on the PC); Allow lets it in; Block ends its Link and it does not dial again', async () => {
      const blockedReason = 'This phone was blocked on Test PC. Ask the person at the PC to allow it in its Phone sheet.';
      const mark = two.log.length;
      await b.op({ op: 'remoteMode', mode: 'private' });
      assert.equal(last().mode, 'private');
      // The phone scanned in person (a direct pairing) is not touched, and hears the new mode.
      assert.equal(boot.S.link.state, 'open');
      await until(() => boot.S.link.hello.mode === 'private', 3000, 'the scanned phone to hear the mode');

      // The auto phone is closed (the PC says why), reconnects by itself, and now waits for an answer on the PC.
      await until(() => link2.state === 'phone-wait', 8000, 'the phone to be asked about');
      const during = two.since(mark);
      assert.ok(during.includes('state:waiting') || during.includes('state:offline'), 'it was dropped first');
      assert.ok(two.states.some(([s, info]) => s === 'waiting' && /switched to Private mode/.test(info.reason || '')), `and it read the PC's own words: ${JSON.stringify(two.states)}`);
      assert.ok(during.includes('phone:wait'));
      assert.ok(!during.some((x) => x.startsWith('ev:')), 'nothing reaches a phone that is waiting');
      await until(() => last().phoneRequest, 3000, 'the card on the PC');
      const req = last().phoneRequest;
      assert.equal(req.accountDeviceId, acctId);
      assert.equal(req.phoneId, phone2Id);
      assert.equal(req.name, 'Pixel (Chrome)');
      assert.equal(req.account, 'Arthur');
      assert.ok(req.exp > Date.now());
      assert.equal(phonesOnPc().find((p) => p.id === phone2Id).state, 'pending');
      assert.equal(phonesOnPc().find((p) => p.id === phone1Id).state, 'enrolled');
      assert.equal(acctOnPc().connected, false, 'waiting is not connected');
      assert.equal(two.states.find(([s]) => s === 'phone-wait')[1].timeoutMs > 10_000, true);

      // Allow.
      await b.op({ op: 'remotePhoneDecision', accountDeviceId: acctId, phoneId: phone2Id, action: 'allow' });
      await until(() => link2.state === 'open', 5000, 'phone-ok after Allow');
      await until(() => two.since(mark).some((x) => x === 'ev:ready'), 3000, 'the ready event');
      const after = two.since(mark);
      assert.ok(after.indexOf('phone:ok') > after.indexOf('phone:wait'));
      assert.ok(after.indexOf('ev:ready') > after.indexOf('phone:ok'), 'events only after phone-ok');
      assert.equal(last().phoneRequest, null);
      assert.equal(phonesOnPc().find((p) => p.id === phone2Id).state, 'allowed');
      assert.equal(link2.hello.mode, 'private');
      assert.equal(acctOnPc().connected, true);
      await link2.send({ op: 'sessions', reqId: 'r3' });
      await until(() => two.events.some((e) => e.ev === 'sessions' && e.reqId === 'r3'), 3000, 'a command once allowed');

      // Block: the encrypted close with the PC's words ends the Link for good.
      const dialed = relay.phoneSockets.length;
      await b.op({ op: 'remotePhoneDecision', accountDeviceId: acctId, phoneId: phone2Id, action: 'block' });
      await until(() => two.fatal, 5000, 'the BLOCKED close on the phone');
      assert.deepEqual(two.fatal, { code: 'phone-blocked', message: blockedReason });
      assert.equal(link2.state, 'failed');
      assert.equal(link2.stopped, true);
      assert.equal(phonesOnPc().find((p) => p.id === phone2Id).state, 'blocked');
      assert.ok(dispatched.some((c) => c.op === 'close' && c.paneId === `phone:${acctId}:p1`), 'no phone of the account is left, so its conversations stop');
      assert.equal([...b.conns.values()].filter((c) => c.device?.id === acctId).length, 0, 'the PC dropped the connection');
      // The first backoff is 0.8 s: wait it out, and more. Nothing dials, from the page or by wake.
      await sleep(1300);
      link2.wake();
      assert.equal(relay.phoneSockets.length, dialed, 'no new connection: the page does not reconnect through the account');
      assert.equal(link2.ws, null);
      assert.equal([...b.conns.values()].filter((c) => c.device?.id === acctId).length, 0);
      assert.ok(relay.phoneSockets.every((s) => s.room === roomId), 'every phone dialed this PC\'s room');
      const savedPhones = JSON.parse(fs.readFileSync(path.join(pcDir, 'state.json'), 'utf8')).devices.find((d) => d.id === acctId).phones;
      assert.equal(savedPhones.find((p) => p.id === phone2Id).state, 'blocked', 'and the block is saved');
    });

    /* ===== step 4 ===== */
    await t.test('4. a page without the phone key feature, in Private: held, its commands ignored, closed with the update message after the grace time', async () => {
      const old = tracer();
      const before = acctOnPc().phones.length;
      const sentBefore = dispatched.length;
      // Second phone's build, but without a phone key: the page then sends the older { t: 'via', name } and does not wait for phone-ok.
      const oldLink = old.attach(new world2.Link({ device: accountPc.device, pairing: accountPc.pairing, name: 'Old Android (Chrome)', phone: null, viaAccount: true, on: old.on }));
      links.push(oldLink);
      try {
        oldLink.start();
        await until(() => old.hello, 5000, 'hello on the older page');
        const t0 = Date.now();
        assert.equal(old.hello.asAccount, true);
        assert.ok(old.hello.features.includes('phone-key'), 'the PC offers phone keys; this page just has none');
        assert.equal(old.hello.mode, 'private');
        // The page thinks it is open at hello, and talks. The PC holds the connection and ignores every op.
        await until(() => oldLink.state === 'open', 3000, 'the older page to open on its side');
        await oldLink.send({ op: 'sessions', reqId: 'old1' });
        await sleep(300);
        const held = [...b.conns.values()].find((c) => c.device?.id === acctId);
        assert.ok(held && held.held === true, 'held on the PC');
        assert.equal(held.phone, null);
        assert.equal(held.via, 'Old Android (Chrome)', 'the older via named it');
        assert.equal(acctOnPc().connected, false);
        assert.equal(last().phoneRequest, null, 'no phone key, nothing to ask about');
        assert.deepEqual(old.events, [], 'no ready event, no cached events');

        // After VIA_GRACE_MS the PC closes it with the update message (the page reads it as the PC's own close).
        await until(() => old.states.some(([s, info]) => s === 'waiting' && info.reason === 'Update the page: this PC asks about each phone.'), 6000, 'the update close');
        assert.ok(Date.now() - t0 >= 900, 'not before the grace time');
        assert.equal([...b.conns.values()].filter((c) => c.device?.id === acctId && c.held).length, 0, 'the held connection is gone');
        assert.deepEqual(old.events, []);
        assert.equal(dispatched.length, sentBefore, 'its command never ran');
        assert.ok(!dispatched.some((c) => c.reqId === `phone:${acctId}:old1`));
        assert.equal(acctOnPc().phones.length, before, 'no phone record was made for it');
        assert.equal(last().notices.length, 0);
      } finally {
        oldLink.stop();
      }
    });
  } finally {
    for (const l of links) { try { l.stop(); } catch { /* already stopped */ } }
    b.stop();
    if (boot) clearTimeout(boot.S.toastTimer);
    if (protectBefore === undefined) delete process.env.APAKI_REMOTE_PROTECT; else process.env.APAKI_REMOTE_PROTECT = protectBefore;
    fs.rmSync(pcDir, { recursive: true, force: true });
    for (const o of outs) fs.rmSync(o, { recursive: true, force: true });
  }
});
