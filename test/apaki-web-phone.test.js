/**
 * The phone side of phone keys and enrollment (2026-10-11, apaki/remote/ENROLL.md,
 * version 2): the pieces of apaki/web/src that can run in Node, from a real web
 * build, with a fake IndexedDB, a fake socket, a fake account server and, for
 * boot.js, a fake DOM that keeps each screen's markup so it can be read back.
 *
 *   store.getPhoneKey    made once, kept, non-extractable, one key for two racing tabs
 *   link.js via          version 2 bytes and signature (checked with the public key
 *                        and the contract's own byte layout), the older via for a PC
 *                        without 'phone-key', phone-wait then phone-ok, BLOCKED close
 *   account.link enroll  the enrolling account-link, its proof, Private PCs, fallbacks
 *   phonekey.js          what to do after a scan, "Not now" per PC, connecting by
 *                        itself, no auto-connect after a disconnect
 *   boot.js              the real page code: connects to the only online PC by itself,
 *                        enrolls quietly when signed in, shows the sheet when not,
 *                        remembers Not now per PC, shows and remembers a block
 *
 * Not testable here (needs a real browser, WebAuthn and a screen): how the screens
 * look, the passkey prompt itself (the sheet's buttons are driven up to the call
 * for it), and the iOS app's real Secure Enclave (apaki/mobile/test/phone-key.test.js
 * covers the app's JS with a fake plugin).
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from '../apaki/scripts/build-web.mjs';
import { b64urlDecode, b64urlEncode, concat, createDeviceIdentity, deviceIdFor, randomBytes } from '../apaki/remote/protocol.js';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(5);
  }
  throw new Error('timed out waiting');
}

/* fakes */

/** Just enough IndexedDB for store.js: open with upgrade, object stores by keyPath, get/getAll/put/delete, one writer at a time per store. */
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

/** A Storage that remembers in memory, or throws on every call (a browser that refuses storage). */
function memStorage(broken = false) {
  const m = new Map();
  const no = () => { throw new Error('storage refused'); };
  return {
    getItem: broken ? no : (k) => (m.has(k) ? m.get(k) : null),
    setItem: broken ? no : (k, v) => { m.set(k, String(v)); },
    removeItem: broken ? no : (k) => { m.delete(k); },
    get size() { return m.size; },
  };
}

/* the build */

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-web-phone-'));
let sockets = 0;
const saved = {
  document: globalThis.document, window: globalThis.window, WebSocket: globalThis.WebSocket, location: globalThis.location, indexedDB: globalThis.indexedDB, fetch: globalThis.fetch,
  localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, history: globalThis.history, CSS: globalThis.CSS, matchMedia: globalThis.matchMedia,
  addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener, requestAnimationFrame: globalThis.requestAnimationFrame,
};
let ready = null;

/**
 * Just enough browser for boot.js to start and for its screens to be read back: elements are plain objects that
 * keep their innerHTML; querySelectorAll('[data-k]') finds the buttons the markup has (so a click can be sent).
 */
function fakeBrowser() {
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
  const local = memory();
  const session = memory();
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
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  globalThis.history = { replaceState() {} };
  globalThis.CSS = { escape: (x) => x };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.location = { host: 'apaki.myrlin.io', hash: '', search: '', pathname: '/', href: 'https://apaki.myrlin.io/', replace(u) { globalThis.__replaced = u; } };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/130 Safari/537', vibrate() {} }, configurable: true, writable: true });
  return { el, local, session, toast: () => created.find((e) => e.className === 'toast') };
}

/** Builds the page once and sets the few browser globals these modules touch; returns the module loader. */
function web() {
  ready ||= (async () => {
    // The relay's own address, so the page's presence questions (same host as the site) are asked, like on apaki.myrlin.io.
    build({ relay: 'wss://apaki.myrlin.io', out });
    const dom = fakeBrowser();
    globalThis.WebSocket = class { constructor() { sockets += 1; this.readyState = 0; } send() {} close() {} };
    globalThis.indexedDB = fakeIndexedDB();
    const imp = (name, tag = '') => import(`${pathToFileURL(path.join(out, name)).href}${tag}`);
    imp.dom = dom;
    return imp;
  })();
  return ready;
}

after(() => {
  Object.assign(globalThis, saved);
  for (const k of Object.keys(saved)) if (saved[k] === undefined) delete globalThis[k];
  fs.rmSync(out, { recursive: true, force: true });
});

const PAIRING_BASE = { v: 1, roomId: 'CCCCCCCCCCCCCCCCCCCCCC', relay: 'wss://apaki.myrlin.io', pcName: 'Desk', deviceId: 'DDDDDDDDDDDDDDDDDDDDDD', pairedAt: new Date().toISOString() };

async function makePairing() {
  const pc = await createDeviceIdentity();
  return { ...PAIRING_BASE, pcPub: b64urlEncode(pc.pub), psk: b64urlEncode(randomBytes(32)) };
}

/** A Link in the state right after the channel opened: a fake socket that records what the page sends, and a session that seals nothing. */
async function openLink(imp, { phone, viaAccount, name = 'iPhone (Safari)' }) {
  const { Link } = await imp('link.js');
  const seen = { states: [], open: [], phone: [], fatal: null, hello: [] };
  const link = new Link({
    device: await createDeviceIdentity(),
    pairing: await makePairing(),
    name,
    phone,
    viaAccount,
    on: {
      state: (s, info) => seen.states.push([s, info]),
      open: (first) => seen.open.push(first),
      phone: (e) => seen.phone.push(e),
      fatal: (code, message) => { seen.fatal = { code, message }; },
      hello: (m) => seen.hello.push(m),
    },
  });
  const sent = [];
  link.ws = { readyState: 1, send: (f) => sent.push(f), close() {} };
  const session = { sendJsonText: async (text) => text, sendChunk: async () => { throw new Error('no chunks here'); } };
  link.session = session;
  link.setState('handshake');
  link.opened(session);
  const sentJson = () => sent.map((f) => JSON.parse(f));
  return { link, seen, sent, sentJson };
}

const helloFor = (extra = {}) => ({ t: 'hello', v: 1, pcName: 'Desk', ops: [], ...extra });

async function verify(pubRaw, sigB64, bytes) {
  const key = await subtle.importKey('raw', pubRaw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(sigB64), bytes);
}

/* the phone key */

test('phone key: made once, kept in the existing account store, non-extractable, signs; two tabs end up with one key', async () => {
  const imp = await web();
  globalThis.indexedDB = fakeIndexedDB();
  const store = await imp('store.js', '?key-a');
  const k1 = await store.getPhoneKey();
  const k2 = await store.getPhoneKey();
  assert.equal(k1.pub.length, 65);
  assert.equal(k1.pub[0], 4, 'a raw uncompressed P-256 point');
  assert.deepEqual(k1.pub, k2.pub, 'the same key every time');

  // What is stored: one record in the account store (the database version is not raised), private key non-extractable.
  const db = globalThis.indexedDB.dbs.get('apaki-phone');
  assert.equal(db.version, 2, 'DB_VERSION stays 2');
  const rec = db.stores.get('account').rows.get('phone');
  assert.equal(rec.privateKey.extractable, false);
  assert.equal(rec.privateKey.type, 'private');
  assert.deepEqual(rec.pub, k1.pub);
  await assert.rejects(subtle.exportKey('jwk', rec.privateKey), 'the private key cannot be read out');
  assert.equal(db.stores.get('account').rows.has('me'), false, 'it is not the account record');

  // It signs: the 64-byte r||s signature verifies with the public key.
  const sig = await k1.sign(utf8.encode('hello'));
  assert.equal(sig.length, 64);
  assert.ok(await verify(k1.pub, b64urlEncode(sig), utf8.encode('hello')));

  // A new page load (a fresh module instance over the same storage) finds the same key instead of making another.
  const store2 = await imp('store.js', '?key-b');
  const again = await store2.getPhoneKey();
  assert.deepEqual(again.pub, k1.pub);
  assert.equal(db.stores.get('account').rows.size, 1);

  // Signing out of an account never touches it.
  await store2.forgetAccount();
  assert.deepEqual((await (await imp('store.js', '?key-c')).getPhoneKey()).pub, k1.pub);

  // Two tabs asking at the same moment on a phone with no key yet: one key wins, both use it.
  globalThis.indexedDB = fakeIndexedDB();
  const [a, b] = await Promise.all([(await imp('store.js', '?race-a')).getPhoneKey(), (await imp('store.js', '?race-b')).getPhoneKey()]);
  assert.deepEqual(a.pub, b.pub);
  const raced = globalThis.indexedDB.dbs.get('apaki-phone').stores.get('account').rows;
  assert.equal(raced.size, 1);
  assert.deepEqual(raced.get('phone').pub, a.pub, 'what is kept is the key both tabs use (the loser did not overwrite it)');

  // A damaged record (no usable private key) is the only thing that gets replaced.
  globalThis.indexedDB = fakeIndexedDB();
  const fixer = await imp('store.js', '?damaged-a');
  await fixer.saveAccount({ accountId: 'x', name: 'x' });
  globalThis.indexedDB.dbs.get('apaki-phone').stores.get('account').rows.set('phone', { key: 'phone', pub: new Uint8Array(3) });
  const healed = await (await imp('store.js', '?damaged-b')).getPhoneKey();
  assert.equal(healed.pub.length, 65);
  assert.equal((await (await imp('store.js', '?damaged-c')).getAccount()).accountId, 'x', 'the account record is left alone');
});

/* via */

test('via version 2: held until phone-ok; name, pub and sig follow the contract and verify with the phone public key', async () => {
  const imp = await web();
  globalThis.indexedDB = fakeIndexedDB();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const { link, seen, sent, sentJson } = await openLink(imp, { phone, viaAccount: true });
  try {
    // The channel is open but the PC holds an account connection: nothing is announced yet.
    assert.equal(link.state, 'handshake');
    assert.deepEqual(seen.open, []);
    assert.equal(link.phoneGate, 'check');

    const nonce = randomBytes(16);
    link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(nonce), features: ['account-ask', 'phone-key', 'enroll'] }));
    await until(() => sent.length === 1);
    const via = sentJson()[0];
    assert.deepEqual(Object.keys(via).sort(), ['name', 'pub', 'sig', 't']);
    assert.equal(via.t, 'via');
    assert.equal(via.name, 'iPhone (Safari)');
    assert.equal(via.pub, b64urlEncode(phone.pub));
    assert.equal(b64urlDecode(via.sig).length, 64);
    // The contract's own layout, built here by hand: UTF8("apaki/v1 via") || nonce || pub || UTF8(name).
    const bytes = concat(utf8.encode('apaki/v1 via'), nonce, phone.pub, utf8.encode('iPhone (Safari)'));
    assert.ok(await verify(phone.pub, via.sig, bytes), 'the signature verifies over the contract bytes');
    // Another nonce, another name or another label does not verify.
    assert.equal(await verify(phone.pub, via.sig, concat(utf8.encode('apaki/v1 via'), randomBytes(16), phone.pub, utf8.encode('iPhone (Safari)'))), false);
    assert.equal(await verify(phone.pub, via.sig, concat(utf8.encode('apaki/v1 via'), nonce, phone.pub, utf8.encode('Other'))), false);
    assert.equal(await verify(phone.pub, via.sig, concat(utf8.encode('apaki/v1 enroll'), nonce, phone.pub, utf8.encode('iPhone (Safari)'))), false);
    assert.deepEqual(seen.open, [], 'still held: the PC has not said phone-ok');
    assert.equal(seen.hello.length, 1, 'the page still hears hello');
  } finally { link.stop(); }
});

test('via: a long name is cut to 64 characters before it is signed, and the signature covers what was sent', async () => {
  const imp = await web();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const long = `${'x'.repeat(63)}\u{1F4F1}tail`;
  const { link, sent, sentJson } = await openLink(imp, { phone, viaAccount: true, name: long });
  try {
    const nonce = randomBytes(16);
    link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(nonce), features: ['phone-key'] }));
    await until(() => sent.length === 1);
    const via = sentJson()[0];
    assert.ok(via.name.length <= 64);
    assert.equal(via.name, 'x'.repeat(63), 'the emoji (two UTF-16 units) did not fit and was dropped whole');
    assert.ok(await verify(phone.pub, via.sig, concat(utf8.encode('apaki/v1 via'), nonce, phone.pub, utf8.encode(via.name))));
  } finally { link.stop(); }
});

test('phone-wait then phone-ok: the page shows the waiting state, sends nothing to the app, and opens on phone-ok', async () => {
  const imp = await web();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const { link, seen, sent, sentJson } = await openLink(imp, { phone, viaAccount: true });
  try {
    link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => sent.length === 1);

    link.message(() => ({ t: 'phone-wait', timeoutMs: 180_000 }));
    assert.equal(link.state, 'phone-wait');
    assert.deepEqual(seen.states.at(-1), ['phone-wait', { timeoutMs: 180_000 }]);
    assert.deepEqual(seen.phone, [{ kind: 'wait', timeoutMs: 180_000 }]);
    assert.deepEqual(seen.open, [], 'the app does not start while the PC asks its person');
    await assert.rejects(link.send({ op: 'sessions' }), /Not connected/);

    link.message(() => ({ t: 'phone-ok' }));
    assert.equal(link.state, 'open');
    assert.deepEqual(seen.open, [true], 'the first open of this Link');
    assert.deepEqual(seen.phone.map((e) => e.kind), ['wait', 'ok']);
    await link.send({ op: 'sessions', reqId: 'r1' });
    assert.deepEqual(sentJson().at(-1), { t: 'cmd', cmd: { op: 'sessions', reqId: 'r1' } });

    // A phone-ok that arrives again changes nothing.
    link.message(() => ({ t: 'phone-ok' }));
    assert.deepEqual(seen.open, [true]);
  } finally { link.stop(); }
});

test('a Connected PC lets a new phone in at once: phone-ok without any phone-wait opens it', async () => {
  const imp = await web();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const { link, seen, sent } = await openLink(imp, { phone, viaAccount: true });
  try {
    link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => sent.length === 1);
    link.message(() => ({ t: 'phone-ok' }));
    assert.equal(link.state, 'open');
    assert.deepEqual(seen.open, [true]);
  } finally { link.stop(); }
});

test('via for a PC without phone-key: the older { t: "via", name }, nothing held; the same without a phone key on this page', async () => {
  const imp = await web();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();

  // An older PC (hello lists account features, not phone-key): the old form, and the app opens at hello.
  let t = await openLink(imp, { phone, viaAccount: true });
  try {
    assert.equal(t.link.phoneGate, 'check');
    t.link.message(() => helloFor({ asAccount: true, features: ['account-ask'] }));
    await until(() => t.sent.length === 1);
    assert.deepEqual(t.sentJson()[0], { t: 'via', name: 'iPhone (Safari)' });
    assert.equal(t.link.state, 'open');
    assert.deepEqual(t.seen.open, [true]);
    assert.equal(t.link.phoneGate, null);
  } finally { t.link.stop(); }

  // A PC with phone-key but this page has no phone key (storage failed): old form, nothing held, and nothing in the old via is secret.
  t = await openLink(imp, { phone: null, viaAccount: true });
  try {
    assert.equal(t.link.viaAccount, false, 'no key, nothing to wait for');
    assert.equal(t.link.state, 'open');
    t.link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => t.sent.length === 1);
    assert.deepEqual(t.sentJson()[0], { t: 'via', name: 'iPhone (Safari)' });
    assert.equal(t.link.state, 'open');
  } finally { t.link.stop(); }

  // A PC with phone-key but a hello without a nonce cannot be answered with a signature: old form.
  t = await openLink(imp, { phone, viaAccount: true });
  try {
    t.link.message(() => helloFor({ asAccount: true, features: ['phone-key'] }));
    await until(() => t.sent.length === 1);
    assert.deepEqual(t.sentJson()[0], { t: 'via', name: 'iPhone (Safari)' });
    assert.equal(t.link.state, 'open');
  } finally { t.link.stop(); }

  // A direct pairing (no asAccount) sends no via at all, and a held link opens at its hello.
  t = await openLink(imp, { phone, viaAccount: true });
  try {
    t.link.message(() => helloFor({ features: ['phone-key', 'enroll'], nonce: b64urlEncode(randomBytes(16)) }));
    await sleep(30);
    assert.equal(t.sent.length, 0);
    assert.equal(t.link.state, 'open');
  } finally { t.link.stop(); }
});

test('a key that cannot sign falls back to the older via instead of hanging the connection', async () => {
  const imp = await web();
  const broken = { pub: new Uint8Array(65).fill(4), sign: async () => { throw new Error('the key is gone'); } };
  const warn = console.warn;
  console.warn = () => {};
  const t = await openLink(imp, { phone: broken, viaAccount: true });
  try {
    t.link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => t.sent.length === 1);
    assert.deepEqual(t.sentJson()[0], { t: 'via', name: 'iPhone (Safari)' });
    assert.equal(t.link.state, 'open');
  } finally { console.warn = warn; t.link.stop(); }
});

/* BLOCKED close */

test('BLOCKED close: shown, final for this link, no reconnecting through the account; other closes are not', async () => {
  const imp = await web();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const reason = 'This phone was blocked on Desk. Ask the person at the PC to allow it in its Phone sheet.';
  const t = await openLink(imp, { phone, viaAccount: true });
  const before = sockets;
  try {
    t.link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => t.sent.length === 1);
    t.link.closedByPc(reason);
    assert.deepEqual(t.seen.fatal, { code: 'phone-blocked', message: reason }, 'the page gets the PC\'s own words');
    assert.equal(t.link.state, 'failed');
    assert.equal(t.link.stopped, true);
    // Whatever wakes the link up now (page back in front, network back, a dropped socket) must not dial again.
    t.link.wake();
    t.link.dial();
    t.link.retry();
    t.link.restart();
    t.link.gone(t.link.ws, 1006);
    await sleep(20);
    assert.equal(sockets, before, 'no new WebSocket was opened');
    assert.equal(t.link.ws, null);
  } finally { t.link.stop(); }

  // Other closes keep their old meaning: phone access turned off is a wait, not a block.
  const other = await openLink(imp, { phone, viaAccount: false });
  try {
    other.link.closedByPc('Phone access was turned off on the PC.');
    assert.equal(other.seen.fatal, null);
    assert.equal(other.link.state, 'waiting');
  } finally { other.link.stop(); }

  // A PC with "blocked" in its name cannot make a different close look blocked, nor the reverse.
  const named = await openLink(imp, { phone, viaAccount: false });
  try {
    named.link.closedByPc('This phone was removed on the PC, which is called "This phone was blocked on X".');
    assert.equal(named.seen.fatal.code, 'removed');
  } finally { named.link.stop(); }
});

test('"Nobody allowed this phone" is a state the person can retry, not a final failure', async () => {
  const imp = await web();
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const t = await openLink(imp, { phone, viaAccount: true });
  try {
    t.link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => t.sent.length === 1);
    t.link.message(() => ({ t: 'phone-wait', timeoutMs: 120_000 }));
    t.link.closedByPc('Nobody allowed this phone on Desk in time.');
    assert.equal(t.link.state, 'phone-timeout');
    assert.equal(t.seen.fatal, null);
    assert.equal(t.link.stopped, false);
    assert.deepEqual(t.seen.phone.at(-1), { kind: 'timeout', reason: 'Nobody allowed this phone on Desk in time.' });
    t.link.ws = { readyState: 1, send() {}, close() {} };
    t.link.retryNow();
    assert.equal(t.link.state, 'offline', 'it connects again by itself, shortly');
    assert.ok(t.link.timers.retry);
  } finally { t.link.stop(); }
});

/* enrollment */

/** A fake apaki.myrlin.io: GET /v1/account and PUT /v1/account/vault, keeping the opaque vault like the real server. */
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

let baseReady = null;

/**
 * The page's own storage and account module (account.js imports './store.js', so they share one instance and one
 * fake IndexedDB). Every call starts from a phone with no account and no PCs; the phone key stays, as it would.
 */
function baseWorld(imp) {
  baseReady ||= (async () => {
    globalThis.indexedDB = fakeIndexedDB();
    return { store: await imp('store.js'), account: await imp('account.js') };
  })();
  return baseReady.then(async (w) => {
    for (const pc of await w.store.listPcs()) await w.store.forgetPc(pc.roomId);
    await w.store.forgetAccount();
    return w;
  });
}

/** Signs this phone in to a pretend account: its device key, vault key and an empty vault on the fake server. */
async function signIn(store) {
  const device = await createDeviceIdentity({ extractable: true });
  const vaultKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const acct = {
    accountId: b64urlEncode(randomBytes(16)), name: 'Arthur', session: 'a.b', sessionExp: Math.floor(Date.now() / 1000) + 86_400, ver: 0,
    vaultKey, device: { privateKey: device.privateKey, pub: device.pub }, devicePub: b64urlEncode(device.pub), rooms: [],
  };
  await store.saveAccount(acct);
  return { device, acct };
}

test('enroll link: signed in, a Private PC that offers it takes the account at once; the proof is the phone key over nonce, phone pub and account pub', async () => {
  const imp = await web();
  const { store, account } = await baseWorld(imp);
  const server = fakeAccountServer();
  const { device } = await signIn(store);
  const phone = await store.getPhoneKey();

  const { link, sent } = await openLink(imp, { phone, viaAccount: false });
  const roomId = link.roomId;
  // The direct pairing this phone just made: it must stay as it is.
  await store.savePc({ roomId, pcName: 'Desk', relay: link.relay, pairing: link.pairing, device: link.device, pairedAt: new Date().toISOString(), lastUsed: new Date().toISOString() });
  const nonce = randomBytes(16);
  link.message(() => helloFor({ mode: 'private', nonce: b64urlEncode(nonce), features: ['account-ask', 'phone-key', 'enroll'] }));
  let pendings = 0;
  try {
    // First the PC answers for some other device: refused, and the vault is not touched.
    const bad = account.link(link, { enroll: true, onPending: () => { pendings += 1; } });
    await until(() => sent.length === 1);
    const msg = JSON.parse(sent[0]);
    assert.equal(msg.t, 'account-link');
    assert.equal(msg.enroll, true);
    assert.equal(msg.wait, true);
    assert.equal(msg.pub, b64urlEncode(device.pub), 'the account device');
    assert.match(msg.reqId, /^q\d+$/);
    assert.deepEqual(Object.keys(msg.phone).sort(), ['pub', 'sig']);
    assert.equal(msg.phone.pub, b64urlEncode(phone.pub));
    const proof = concat(utf8.encode('apaki/v1 enroll'), nonce, phone.pub, device.pub);
    assert.ok(await verify(phone.pub, msg.phone.sig, proof), 'the enroll signature verifies over the contract bytes');
    // It is not a via signature and not for another nonce.
    assert.equal(await verify(phone.pub, msg.phone.sig, concat(utf8.encode('apaki/v1 via'), nonce, phone.pub, device.pub)), false);
    assert.equal(await verify(phone.pub, msg.phone.sig, concat(utf8.encode('apaki/v1 enroll'), randomBytes(16), phone.pub, device.pub)), false);
    link.message(() => ({ t: 'account-linked', reqId: msg.reqId, deviceId: 'someone-else', psk: 'p', pcName: 'Desk' }));
    await assert.rejects(bad, /answered for another device/);
    assert.equal(server.puts.length, 0);

    // The real answer: the account device's id.
    const deviceId = await deviceIdFor(device.pub);
    const good = account.link(link, { enroll: true, onPending: () => { pendings += 1; } });
    await until(() => sent.length === 2);
    link.message(() => ({ t: 'account-linked', reqId: JSON.parse(sent[1]).reqId, deviceId, psk: 'psk-from-pc', pcName: 'Desk' }));
    const r = await good;
    assert.equal(pendings, 0, 'quiet: the PC never asked, so nothing said "allow it on the PC"');
    assert.equal(server.puts.length, 1, 'the vault was updated once');
    assert.ok(r.acct.rooms.includes(roomId));
    const mine = await store.getPc(roomId);
    assert.equal(mine.via, undefined, 'the phone keeps its own pairing for this PC');
    assert.equal((await store.getAccount()).rooms.includes(roomId), true);
  } finally { link.stop(); }
});

test('enroll link: without the PC\'s enroll feature, without a phone key, or without enroll: true, version 1 rules apply (Private refuses, old PC says update)', async () => {
  const imp = await web();
  const { store, account } = await baseWorld(imp);
  fakeAccountServer();
  await signIn(store);
  const phone = await store.getPhoneKey();

  const cases = [
    // [label, link options, hello, enroll flag, expected error code]
    ['Private PC with enroll but the caller did not ask for it', { phone }, { mode: 'private', features: ['account-ask', 'phone-key', 'enroll'], nonce: b64urlEncode(randomBytes(16)) }, false, 'private'],
    ['Private PC without the enroll feature', { phone }, { mode: 'private', features: ['account-ask'] }, true, 'private'],
    ['Private PC with enroll but this page has no phone key', { phone: null }, { mode: 'private', features: ['account-ask', 'enroll'], nonce: b64urlEncode(randomBytes(16)) }, true, 'private'],
    ['Private PC with enroll but a hello without a nonce', { phone }, { mode: 'private', features: ['account-ask', 'enroll'] }, true, 'private'],
    ['an older PC', { phone }, { mode: 'connected', features: [] }, true, 'old-pc'],
  ];
  for (const [label, opts, hello, enroll, code] of cases) {
    const { link, sent } = await openLink(imp, { ...opts, viaAccount: false });
    try {
      link.message(() => helloFor(hello));
      await assert.rejects(account.link(link, { enroll }), (e) => e.code === code, label);
      assert.equal(sent.length, 0, `${label}: nothing was sent`);
    } finally { link.stop(); }
  }

  // A Connected PC without enroll still takes the version 1 request (no enroll fields), held for its person.
  const { link, sent } = await openLink(imp, { phone, viaAccount: false });
  try {
    link.message(() => helloFor({ mode: 'connected', features: ['account-ask'] }));
    const p = account.link(link, { enroll: true });
    await until(() => sent.length === 1);
    const msg = JSON.parse(sent[0]);
    assert.equal(msg.enroll, undefined);
    assert.equal(msg.phone, undefined);
    assert.equal(msg.wait, true);
    link.message(() => ({ t: 'account-linked', reqId: msg.reqId, error: 'Denied on the PC.' }));
    await assert.rejects(p, /Denied on the PC/);
  } finally { link.stop(); }
});

/* what the page decides */

test('enrollPlan: signed in is quiet (Private too), not signed in gets the sheet, "Not now" is remembered per PC', async () => {
  const imp = await web();
  const { enrollPlan, rememberNotNow, wasNotNow, notNowKey } = await imp('phonekey.js');
  const base = { offered: true, hasPhoneKey: true };
  assert.equal(enrollPlan({ ...base, signedIn: true }), 'quiet', 'signed in: the PC is added by itself, no question');
  assert.equal(enrollPlan({ ...base, signedIn: false }), 'sheet', 'not signed in: "Next time, sign in with Face ID"');
  assert.equal(enrollPlan({ ...base, signedIn: false, notNow: true }), 'none');
  assert.equal(enrollPlan({ ...base, signedIn: true, notNow: true }), 'quiet', 'a signed-in phone is never asked, so Not now does not apply');
  // There is no PC mode among the inputs: a Private PC that offers 'enroll' is treated exactly like a Connected one.
  // Nothing to do.
  assert.equal(enrollPlan({ ...base, offered: false, signedIn: true }), 'none', 'the PC does not offer enroll: version 1 behavior');
  assert.equal(enrollPlan({ ...base, hasPhoneKey: false, signedIn: true }), 'none', 'no phone key on this page');
  assert.equal(enrollPlan({ ...base, signedIn: true, inAccount: true }), 'none', 'already in the account');
  assert.equal(enrollPlan({ ...base, signedIn: true, asAccount: true }), 'none', 'this connection is the account already');

  const ls = memStorage();
  assert.equal(wasNotNow(ls, 'roomA'), false);
  assert.equal(rememberNotNow(ls, 'roomA', new Date('2026-10-11T10:00:00Z')), true);
  assert.equal(ls.getItem(notNowKey('roomA')), '2026-10-11T10:00:00.000Z');
  assert.equal(wasNotNow(ls, 'roomA'), true);
  assert.equal(wasNotNow(ls, 'roomB'), false, 'per PC');
  // A browser that refuses storage: nothing is remembered and nothing throws.
  const refused = memStorage(true);
  assert.equal(rememberNotNow(refused, 'roomA'), false);
  assert.equal(wasNotNow(refused, 'roomA'), false);
  assert.equal(wasNotNow(null, 'roomA'), false);
});

test('autoConnectChoice: one online PC and nothing else to choose connects; not when choosing, disconnected, blocked or unsure', async () => {
  const imp = await web();
  const { autoConnectChoice, markHome, takeHome, markBlocked, clearBlocked, isBlocked } = await imp('phonekey.js');
  const A = { roomId: 'A' };
  const B = { roomId: 'B' };
  const C = { roomId: 'C' };
  const on = (o) => new Map(Object.entries(o));
  const go = (o) => autoConnectChoice({ signedIn: true, ...o });

  assert.equal(go({ pcs: [A], presence: on({ A: true }) }), 'A', 'one PC, online');
  assert.equal(go({ pcs: [A, B], presence: on({ A: false, B: true }) }), 'B', 'the other one is offline: nothing to choose');
  assert.equal(go({ pcs: [A, B], presence: on({ A: true, B: true }) }), null, 'two online: the person chooses');
  assert.equal(go({ pcs: [A, B], presence: on({ A: false, B: false }) }), null, 'none online');
  assert.equal(go({ pcs: [A, B], presence: on({ A: true }) }), null, 'the other PC\'s state is not known: it may be the one they want');
  assert.equal(go({ pcs: [A], presence: on({}) }), null, 'nothing known yet');
  assert.equal(autoConnectChoice({ signedIn: false, pcs: [A], presence: on({ A: true }) }), null, 'not signed in: no presence is asked, no auto connect');
  assert.equal(go({ pcs: [A], presence: on({ A: true }), overlay: true }), null, 'the PC list is open: they came to choose');
  assert.equal(go({ pcs: [A], presence: on({ A: true }), linked: true }), null, 'connected or connecting already');

  // After a manual disconnect (and after a blocked close) the next home shows the list: the one-shot flag.
  const session = memStorage();
  assert.equal(takeHome(session), false);
  markHome(session);
  const noAuto = takeHome(session);
  assert.equal(noAuto, true);
  assert.equal(takeHome(session), false, 'one visit only');
  assert.equal(go({ pcs: [A], presence: on({ A: true }), noAuto }), null, 'just disconnected: it does not connect again by itself');
  assert.equal(go({ pcs: [A], presence: on({ A: true }), noAuto: false }), 'A');

  // A PC that blocked this phone is not a choice and is never picked; the others still count.
  const local = memStorage();
  markBlocked(local, 'A');
  assert.equal(isBlocked(local, 'A'), true);
  const blocked = (id) => isBlocked(local, id);
  assert.equal(go({ pcs: [A, B], presence: on({ A: true, B: false }), isBlocked: blocked }), null, 'the only online PC is the blocked one');
  assert.equal(go({ pcs: [A, B], presence: on({ A: true, B: true }), isBlocked: blocked }), 'B');
  assert.equal(go({ pcs: [A, B, C], presence: on({ A: true, B: true, C: false }), isBlocked: blocked }), 'B');
  clearBlocked(local, 'A');
  assert.equal(isBlocked(local, 'A'), false);
  assert.equal(go({ pcs: [A, B], presence: on({ A: true, B: false }), isBlocked: blocked }), 'A', 'allowed again: back to normal');
});

/* the page's own wiring */

test('boot.js wiring: the sheet copy and buttons, the phone key into every Link, enrollment once per pairing, the blocked and disconnect memory', async () => {
  const src = fs.readFileSync(new URL('../apaki/web/src/boot.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // The sheet (ENROLL.md): primary, secondary and "Not now".
  assert.match(src, /Next time, sign in with Face ID/);
  assert.match(src, /data-k="enroll-create"[^>]*>[^<]*Create a passkey/);
  assert.match(src, /data-k="enroll-signin"[^>]*>[^<]*I already have an Apaki passkey/);
  assert.match(src, /data-k="enroll-later"[^>]*>Not now/);
  assert.match(src, /class="pair-btn enroll-create"/);
  // The tap is the WebAuthn gesture: the handlers call the account functions straight from the click.
  assert.match(src, /account\.create\(/);
  assert.match(src, /account\.signIn\(\)/);
  // Both Link constructions carry the phone key; an account PC is held for the PC's decision.
  assert.equal((src.match(/store\.getPhoneKey\(\)/g) || []).length, 2);
  assert.match(src, /new Link\(\{ device, offer, name: await deviceName\(\), phone,/);
  assert.match(src, /phone, viaAccount: pc\.via === 'account'/);
  // Enrollment happens right after a pairing, once, only for a PC that offers 'enroll'.
  assert.match(src, /S\.enrollOffer = true;/);
  assert.match(src, /supports\('enroll'\)/);
  assert.match(src, /linkCurrent\(\{ quiet: true, enroll: true \}\)/);
  // Blocked and disconnect memory, and the screens for the new states.
  assert.match(src, /code === 'phone-blocked'/);
  assert.match(src, /markBlocked\(lstore\(\)/);
  assert.match(src, /'phone-wait':/);
  assert.match(src, /data-k="disconnect"/);
  assert.match(src, /takeHome\(sstore\(\)\)/);
  // No em dash or double hyphen in the copy this change added (house rule).
  for (const f of ['boot.js', 'link.js', 'account.js', 'store.js', 'phonekey.js']) {
    const text = fs.readFileSync(new URL(`../apaki/web/src/${f}`, import.meta.url), 'utf8');
    assert.equal(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2015)), false, `${f} has no em dash`);
  }
});

test('the web build ships phonekey.js (and the modules that import it resolve)', async () => {
  await web();
  assert.ok(fs.existsSync(path.join(out, 'phonekey.js')));
  const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
  assert.ok(JSON.parse(/const ASSETS = (\[.*\]);/.exec(sw)[1]).includes('./phonekey.js'), 'the service worker caches it');
});

/* boot.js itself, in a fake DOM (the real page code; only the browser around it is pretend) */

let bootReady = null;

/**
 * Loads boot.js once, with a hook appended that hands out its internals. main() runs at import: the home flag is set
 * first, so it shows the PC list and connects to nothing by itself. The account and two PCs are seeded before.
 */
async function bootPage(imp) {
  bootReady ||= (async () => {
    const { store } = await baseWorld(imp);
    const server = fakeAccountServer();
    const { acct } = await signIn(store);
    await store.saveAccount({ ...acct, rooms: [ROOM_A, ROOM_B] });
    for (const [roomId, name] of [[ROOM_A, 'Desk A'], [ROOM_B, 'Desk B']]) await store.savePc(await accountPc(roomId, name));
    server.online.add(ROOM_A);
    imp.dom.session.setItem('apaki.home', '1');
    let src = fs.readFileSync(path.join(out, 'boot.js'), 'utf8');
    src += '\nglobalThis.__boot = { S, act, goHome, enrollSheet, maybeAutoConnect, linkHandlers, connect, failedScreen };\n';
    fs.writeFileSync(path.join(out, 'boot-under-test.js'), src);
    await import(pathToFileURL(path.join(out, 'boot-under-test.js')).href);
    await until(() => imp.dom.el('pairBody').innerHTML.includes('Your PCs'));
    return { boot: globalThis.__boot, store, server, dom: imp.dom };
  })();
  return bootReady;
}

const ROOM_A = 'A'.repeat(22);
const ROOM_B = 'B'.repeat(22);

async function accountPc(roomId, pcName, extra = {}) {
  const device = await createDeviceIdentity();
  const pairing = { v: 1, roomId, relay: 'wss://apaki.myrlin.io', pcPub: b64urlEncode(device.pub), pcName, deviceId: 'D'.repeat(22), psk: b64urlEncode(randomBytes(32)), pairedAt: new Date().toISOString() };
  return { roomId, pcName, relay: pairing.relay, pairing, device, pairedAt: pairing.pairedAt, lastUsed: pairing.pairedAt, via: 'account', ...extra };
}

/** Puts a real Link, made by boot.js's own connect(), into the state right after its channel opened (no app to load). */
async function connectedLink(boot, dom, pc) {
  boot.S.appStarted = true;
  boot.S.appReady = true;
  boot.S.link = null;
  boot.connect(pc);
  await until(() => boot.S.link);
  const link = boot.S.link;
  const sent = [];
  link.ws = { readyState: 1, send: (f) => sent.push(f), close() {} };
  const session = { sendJsonText: async (text) => text, sendChunk: async () => { throw new Error('no chunks here'); } };
  link.session = session;
  link.setState('handshake');
  link.opened(session);
  return { link, sent };
}

test('home, signed in: the only online PC is connected by itself with the phone key; not after a disconnect; PCs with online and offline', async () => {
  const imp = await web();
  const { boot, store, dom } = await bootPage(imp);
  const S = boot.S;
  const before = sockets;
  const list = dom.el('pairBody').innerHTML;
  assert.ok(list.includes('Signed in as Arthur'));
  assert.equal(S.noAuto, true, 'the home flag was one visit of "do not connect by itself"');
  assert.equal(dom.session.getItem('apaki.home'), null, 'and it was taken');
  assert.equal(sockets, before, 'nothing connected yet');

  // Presence arrives: A online, B offline. Not while noAuto is on (just disconnected).
  S.presence.set(ROOM_A, true);
  S.presence.set(ROOM_B, false);
  boot.maybeAutoConnect(await store.listPcs());
  assert.equal(S.link, null, 'no connect after a disconnect');

  // A normal visit: it connects to the one online PC, as an account PC (held for the PC to decide) with the phone key.
  S.noAuto = false;
  boot.maybeAutoConnect(await store.listPcs());
  await until(() => S.link);
  assert.equal(S.link.roomId, ROOM_A);
  assert.equal(S.link.viaAccount, true);
  assert.equal(S.link.phone.pub.length, 65);
  assert.equal(S.noAuto, true, 'once per visit');
  S.link.stop();
  S.link = null;
  S.noAuto = false;

  // Two online: the person chooses. The PC list open over the app: the person is choosing.
  S.presence.set(ROOM_B, true);
  boot.maybeAutoConnect(await store.listPcs());
  assert.equal(S.link, null);
  S.presence.set(ROOM_B, false);
  S.overlay = true;
  boot.maybeAutoConnect(await store.listPcs());
  assert.equal(S.link, null);
  S.overlay = false;

  // The Disconnect button: the next start shows the PC list and connects to nothing.
  boot.S.appStarted = true;
  boot.S.pc = await accountPc(ROOM_A, 'Desk A');
  boot.S.link = { stop() {}, state: 'open', pcName: 'Desk A' };
  globalThis.__replaced = null;
  await boot.act('disconnect');
  assert.equal(S.noAuto, true);
  assert.equal(dom.session.getItem('apaki.home'), '1');
  assert.equal(globalThis.__replaced, '/');
  dom.session.removeItem('apaki.home');
  boot.S.appStarted = false;
  boot.S.link = null;
  boot.S.pc = null;
});

test('after a scan, signed in: a Private PC that offers enroll gets the enrolling account-link at once, quietly, and a toast says so', async () => {
  const imp = await web();
  const { boot, store, server, dom } = await bootPage(imp);
  const S = boot.S;
  const acct = await store.getAccount();
  const direct = await accountPc(ROOM_B, 'Desk B');
  delete direct.via;
  await store.savePc(direct);
  await store.saveAccount({ ...acct, rooms: [ROOM_A] });
  const { link, sent } = await connectedLink(boot, dom, direct);
  try {
    S.enrollOffer = true;
    const nonce = randomBytes(16);
    link.message(() => helloFor({ pcName: 'Desk B', mode: 'private', nonce: b64urlEncode(nonce), features: ['account-ask', 'phone-key', 'enroll'] }));
    await until(() => sent.length >= 1);
    const msg = JSON.parse(sent.at(-1));
    assert.equal(msg.t, 'account-link');
    assert.equal(msg.enroll, true);
    assert.equal(msg.phone.pub, b64urlEncode(link.phone.pub));
    assert.ok(await verify(link.phone.pub, msg.phone.sig, concat(utf8.encode('apaki/v1 enroll'), nonce, link.phone.pub, b64urlDecode(acct.devicePub))));
    assert.equal(dom.el('pairBody').innerHTML.includes('Next time, sign in with Face ID'), false, 'no sheet when signed in');
    const deviceId = await deviceIdFor(acct.devicePub);
    link.message(() => ({ t: 'account-linked', reqId: msg.reqId, deviceId, psk: 'psk', pcName: 'Desk B' }));
    await until(() => dom.toast()?.textContent === 'Desk B was added to your account.');
    assert.equal(S.enrollOffer, false, 'once per pairing');
    assert.equal(server.puts.length >= 1, true);
    assert.equal(dom.toast().classList.contains('bad'), false);
  } finally { link.stop(); }
});

test('after a scan, not signed in: the sheet (Face ID copy, create, "I already have an Apaki passkey", Not now); Not now is remembered for that PC only', async () => {
  const imp = await web();
  const { boot, store, dom } = await bootPage(imp);
  const S = boot.S;
  await store.forgetAccount();
  S.acct = null;
  const pcC = await accountPc('C'.repeat(22), 'Desk C');
  delete pcC.via;
  const hello = () => helloFor({ pcName: 'Desk C', mode: 'connected', nonce: b64urlEncode(randomBytes(16)), features: ['account-ask', 'phone-key', 'enroll'] });

  let t = await connectedLink(boot, dom, pcC);
  try {
    S.enrollOffer = true;
    t.link.message(hello);
    await until(() => dom.el('pairBody').innerHTML.includes('Next time, sign in with Face ID'));
    const html = dom.el('pairBody').innerHTML;
    for (const part of ['Create a passkey', 'I already have an Apaki passkey', 'Not now', 'Paired with Desk C', 'class="pair-btn enroll-create"', 'class="pair-btn quiet enroll-signin"', 'class="pair-btn quiet enroll-later"']) assert.ok(html.includes(part), part);
    assert.equal(t.sent.length, 0, 'nothing is sent to the PC until there is an account');

    // The secondary button signs in with an existing passkey; this pretend browser has none, so it says so and stays.
    await boot.act('enroll-signin');
    assert.ok(dom.el('pairBody').innerHTML.includes('This browser has no passkeys.'));
    assert.equal(/data-k="enroll-later" disabled/.test(dom.el('pairBody').innerHTML), false, 'buttons are usable again');
    assert.equal(t.sent.length, 0);

    // Not now: remembered for this PC, the sheet goes.
    await boot.act('enroll-later');
    assert.ok(dom.local.getItem(`apaki.enrollNotNow@${'C'.repeat(22)}`));
    assert.equal(dom.el('pairScreen').hidden, true);
  } finally { t.link.stop(); }

  // The same PC after the next pairing-like hello: not asked again. Another PC: asked.
  dom.el('pairBody').innerHTML = '';
  t = await connectedLink(boot, dom, pcC);
  try {
    S.enrollOffer = true;
    t.link.message(hello);
    await sleep(60);
    assert.equal(dom.el('pairBody').innerHTML.includes('Next time'), false, 'Not now holds for this PC');
  } finally { t.link.stop(); }
  const pcD = await accountPc('D'.repeat(22), 'Desk D');
  delete pcD.via;
  t = await connectedLink(boot, dom, pcD);
  try {
    S.enrollOffer = true;
    t.link.message(hello);
    await until(() => dom.el('pairBody').innerHTML.includes('Next time, sign in with Face ID'));
  } finally { t.link.stop(); }

  // A PC that does not offer enroll never shows the sheet (version 1 behavior).
  dom.el('pairBody').innerHTML = '';
  t = await connectedLink(boot, dom, pcC);
  try {
    S.enrollOffer = true;
    t.link.message(() => helloFor({ mode: 'connected', features: ['account-ask'] }));
    await sleep(60);
    assert.equal(dom.el('pairBody').innerHTML.includes('Next time'), false);
  } finally { t.link.stop(); }
});

test('a blocked phone: the PC\'s words on screen, remembered for that PC, shown in its row, never picked to connect by itself, and the next start lists PCs', async () => {
  const imp = await web();
  const { boot, store, dom } = await bootPage(imp);
  const S = boot.S;
  // The earlier tests changed what is saved: A and B are the account's PCs again.
  const acct = await store.getAccount();
  await store.saveAccount({ ...acct, rooms: [ROOM_A, ROOM_B] });
  for (const [roomId, name] of [[ROOM_A, 'Desk A'], [ROOM_B, 'Desk B']]) await store.savePc(await accountPc(roomId, name));
  S.acct = await store.getAccount();
  S.appStarted = false;
  S.noAuto = false;
  S.pc = await accountPc(ROOM_A, 'Desk A');
  S.link = { pcName: 'Desk A', state: 'failed' };
  const reason = 'This phone was blocked on Desk A. Ask the person at the PC to allow it in its Phone sheet.';
  boot.linkHandlers().fatal('phone-blocked', reason);
  const html = dom.el('pairBody').innerHTML;
  assert.ok(html.includes('This phone was blocked'));
  assert.ok(html.includes('Ask the person at the PC to allow it in its Phone sheet.'));
  assert.ok(html.includes('Other PCs'));
  assert.ok(dom.local.getItem(`apaki.blocked@${ROOM_A}`), 'remembered for this PC');
  assert.equal(dom.session.getItem('apaki.home'), '1', 'the next start shows the PC list');
  assert.equal(S.noAuto, true);

  S.link = null;
  S.pc = null;
  await boot.goHome();
  assert.ok(dom.el('pairBody').innerHTML.includes('Blocked on this PC'), 'the PC row says so');
  S.presence.set(ROOM_A, true);
  S.presence.set(ROOM_B, false);
  S.noAuto = false;
  boot.maybeAutoConnect(await store.listPcs());
  assert.equal(S.link, null, 'the only online PC blocked this phone: nothing to connect to');

  // A connection that works again clears it (the app is up already, so open() only has to say so).
  S.appStarted = true;
  S.pc = await accountPc(ROOM_A, 'Desk A');
  boot.linkHandlers().open();
  assert.equal(dom.local.getItem(`apaki.blocked@${ROOM_A}`), null);
  S.pc = null;
  S.appStarted = false;
  dom.session.removeItem('apaki.home');
});

test('the app tells the PC which app it is (client), only once the channel is in; the hello keeps its version fields for the page', async () => {
  const imp = await web();
  // A direct pairing: the channel is in as soon as it opens.
  const direct = await openLink(imp, { phone: null, viaAccount: false });
  try {
    assert.equal(direct.link.state, 'open');
    direct.link.sendClient({ kind: 'ios', version: '0.2.0', build: '9' });
    await until(() => direct.sent.length === 1);
    assert.deepEqual(direct.sentJson().at(-1), { t: 'client', kind: 'ios', version: '0.2.0', build: '9' });
    // The hello's version fields reach the page's handler untouched (boot.js checkAppVersion reads them).
    direct.link.message(() => helloFor({ appVersion: '0.3.0', minPhoneApp: '0.2.0' }));
    assert.equal(direct.seen.hello.at(-1).minPhoneApp, '0.2.0');
    assert.equal(direct.seen.hello.at(-1).appVersion, '0.3.0');
  } finally { direct.link.stop(); }

  // An account connection is held until the PC decides: nothing is sent before phone-ok.
  const phone = await (await imp('store.js', '?via-store')).getPhoneKey();
  const held = await openLink(imp, { phone, viaAccount: true });
  try {
    held.link.message(() => helloFor({ asAccount: true, nonce: b64urlEncode(randomBytes(16)), features: ['phone-key'] }));
    await until(() => held.sent.length === 1);
    const before = held.sent.length;
    held.link.sendClient({ kind: 'ios', version: '0.2.0' });
    await sleep(30);
    assert.equal(held.sent.length, before, 'a held connection says nothing but via');
    held.link.message(() => ({ t: 'phone-ok' }));
    held.link.sendClient({ kind: 'ios', version: '0.2.0' });
    await until(() => held.sent.length === before + 1);
    assert.deepEqual(held.sentJson().at(-1), { t: 'client', kind: 'ios', version: '0.2.0' });
  } finally { held.link.stop(); }
});
