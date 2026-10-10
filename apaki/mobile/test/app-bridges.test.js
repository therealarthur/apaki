/**
 * Tests for the Apaki app's bridges between the page and the native side
 * (apaki/mobile/src): the relay WebSocket (native-socket.js), the account
 * API fetch (native-http.js), passkeys (passkeys.js), and the debug demo's
 * pretend PC (demo/demo-engine.js). The native plugins are stand-ins that
 * record what the page asked for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSocketClass } from '../src/native-socket.js';
import { makeFetch } from '../src/native-http.js';
import { makeCredentials } from '../src/passkeys.js';
import { createDemoEngine } from '../src/demo/demo-engine.js';
import { b64d, b64e, relaySocketAllowed } from '../src/codec.js';

const ROOM_URL = `wss://apaki.myrlin.io/v1/rooms/${'A'.repeat(22)}/phone`;
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeNet() {
  const calls = [];
  let listener = null;
  return {
    calls,
    emit: (ev) => listener?.(ev),
    addListener: async (name, fn) => { assert.equal(name, 'socket'); listener = fn; return { remove: async () => {} }; },
    socketOpen: async (o) => { calls.push(['open', o]); },
    socketSend: async (o) => { calls.push(['send', o]); },
    socketClose: async (o) => { calls.push(['close', o]); },
    http: async (o) => { calls.push(['http', o]); return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }; },
  };
}

test('relay socket: opens natively, delivers text and binary, sends base64, closes once', async () => {
  const net = fakeNet();
  const WS = makeSocketClass(net, relaySocketAllowed);
  const ws = new WS(ROOM_URL, ['apaki.v1']);
  ws.binaryType = 'arraybuffer';
  const seen = [];
  ws.onopen = () => seen.push('open');
  ws.onmessage = (e) => seen.push(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  ws.onclose = (e) => seen.push(`close ${e.code}`);
  assert.equal(ws.readyState, WS.CONNECTING);
  assert.throws(() => ws.send('early'), { name: 'InvalidStateError' });
  await tick();
  assert.deepEqual(net.calls[0], ['open', { id: ws._id, url: ROOM_URL, protocols: ['apaki.v1'] }]);

  net.emit({ id: ws._id, type: 'open', protocol: 'apaki.v1' });
  assert.equal(ws.readyState, WS.OPEN);
  assert.equal(ws.protocol, 'apaki.v1');
  net.emit({ id: ws._id, type: 'message', text: '{"t":"ready","pc":true}' });
  net.emit({ id: ws._id, type: 'message', data: b64e(new Uint8Array([0x11, 2, 3])) });
  net.emit({ id: 'other', type: 'message', text: 'not mine' });

  ws.send('ping');
  ws.send(new Uint8Array([0x20, 9, 9]).subarray(1));
  assert.deepEqual(net.calls.slice(1), [['send', { id: ws._id, text: 'ping' }], ['send', { id: ws._id, data: b64e(new Uint8Array([9, 9])) }]]);

  ws.close();
  ws.close();
  assert.equal(net.calls.filter((c) => c[0] === 'close').length, 1);
  net.emit({ id: ws._id, type: 'close', code: 1000, reason: '' });
  net.emit({ id: ws._id, type: 'close', code: 1000, reason: '' });
  assert.deepEqual(seen, ['open', '{"t":"ready","pc":true}', new Uint8Array([0x11, 2, 3]), 'close 1000']);
  assert.equal(ws.readyState, WS.CLOSED);
});

test('relay socket: anywhere but the Apaki relay is refused at once, like a CSP block', () => {
  const WS = makeSocketClass(fakeNet(), relaySocketAllowed);
  assert.throws(() => new WS('wss://relay.example.test/v1/rooms/x/phone', ['apaki.v1']), { name: 'SecurityError' });
  assert.throws(() => new WS(`wss://apaki.myrlin.io/v1/rooms/${'A'.repeat(22)}/pc`, ['apaki.v1']), { name: 'SecurityError' });
});

test('relay socket: a native open that fails becomes error then close 1006', async () => {
  const net = fakeNet();
  net.socketOpen = async () => { throw new Error('offline'); };
  const WS = makeSocketClass(net, relaySocketAllowed);
  const ws = new WS(ROOM_URL);
  const seen = [];
  ws.onerror = () => seen.push('error');
  ws.onclose = (e) => seen.push(`close ${e.code}`);
  await tick(); await tick();
  assert.deepEqual(seen, ['error', 'close 1006']);
});

test('account API: /v1/ on the page origin goes to the site natively, everything else stays local', async () => {
  const net = fakeNet();
  const local = [];
  const base = async (input) => { local.push(String(input)); return new Response('file'); };
  {
    const f = makeFetch(net, base, 'https://apaki.myrlin.io', 'capacitor://localhost/');
    const r = await f('/v1/account/challenge', { method: 'post', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: '{"purpose":"signin"}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(net.calls[0], ['http', { url: 'https://apaki.myrlin.io/v1/account/challenge', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: '{"purpose":"signin"}' }]);
    await f('/v1/rooms/abc/presence?x=1');
    assert.equal(net.calls[1][1].url, 'https://apaki.myrlin.io/v1/rooms/abc/presence?x=1');
    await f('app.css');
    await f('https://elsewhere.example/v1/account');
    assert.deepEqual(local, ['app.css', 'https://elsewhere.example/v1/account']);
    net.http = async () => ({ status: 204, headers: {}, body: '' });
    assert.equal((await f('/v1/account', { method: 'DELETE' })).status, 204);
    net.http = async () => { throw new Error('no network'); };
    await assert.rejects(f('/v1/account'), TypeError);
    // Another custom-scheme page address works the same (URL.origin would be "null" there).
    const g = makeFetch(fakeNet(), base, 'https://apaki.myrlin.io', 'capacitor://localhost/?link=1#x');
    assert.equal((await g('/v1/account')).status, 200);
  }
});

test('passkeys: WebAuthn options go native as base64url; results come back as a browser shapes them', async () => {
  const asked = [];
  const out = (o) => ({ id: 'Y3JlZA', clientDataJSON: b64e(new TextEncoder().encode('{"type":"webauthn.create"}')), attestationObject: b64e(new Uint8Array([1, 2])), authenticatorData: b64e(new Uint8Array([3])), signature: b64e(new Uint8Array([4])), userHandle: b64e(new Uint8Array([5])), prfSupported: true, prf: o.prfSalt ? b64e(new Uint8Array(32).fill(8)) : null });
  const native = {
    create: async (o) => { asked.push(['create', o]); return out(o); },
    get: async (o) => { asked.push(['get', o]); return out(o); },
  };
  const creds = makeCredentials(native);
  const salt = new Uint8Array(32).fill(1);
  const c = await creds.create({ publicKey: { rp: { id: 'apaki.myrlin.io', name: 'Myrlin Apaki' }, user: { id: new Uint8Array([7, 7]), name: 'Arthur', displayName: 'Arthur' }, challenge: new Uint8Array([1, 2, 3]), excludeCredentials: [{ type: 'public-key', id: new Uint8Array([9]) }], extensions: { prf: { eval: { first: salt } } } } });
  assert.deepEqual(asked[0], ['create', { rpId: 'apaki.myrlin.io', challenge: b64e(new Uint8Array([1, 2, 3])), userId: b64e(new Uint8Array([7, 7])), name: 'Arthur', prfSalt: b64e(salt), exclude: [b64e(new Uint8Array([9]))] }]);
  assert.equal(c.id, 'Y3JlZA');
  assert.ok(c.response.clientDataJSON instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(c.response.attestationObject), new Uint8Array([1, 2]));
  assert.deepEqual(new Uint8Array(c.getClientExtensionResults().prf.results.first), new Uint8Array(32).fill(8));
  assert.deepEqual(c.response.getTransports(), ['hybrid', 'internal']);

  const g = await creds.get({ publicKey: { challenge: new Uint8Array([4]), rpId: 'apaki.myrlin.io', allowCredentials: [{ type: 'public-key', id: new Uint8Array([6]) }], extensions: { prf: { eval: { first: salt } } } } });
  assert.deepEqual(asked[1], ['get', { rpId: 'apaki.myrlin.io', challenge: b64e(new Uint8Array([4])), allow: [b64e(new Uint8Array([6]))], prfSalt: b64e(salt) }]);
  assert.deepEqual(new Uint8Array(g.response.signature), new Uint8Array([4]));
  assert.deepEqual(new Uint8Array(g.response.userHandle), new Uint8Array([5]));
  assert.equal(g.getClientExtensionResults().prf.enabled, true);

  for (const [code, name] of [['cancelled', 'NotAllowedError'], ['exists', 'InvalidStateError'], ['domain', 'SecurityError'], ['unsupported', 'NotSupportedError'], ['weird', 'UnknownError']]) {
    const failing = makeCredentials({ create: async () => { const e = new Error('no'); e.code = code; throw e; } });
    await assert.rejects(failing.create({ publicKey: { rp: {}, user: { id: new Uint8Array(1) }, challenge: new Uint8Array(1) } }), { name });
  }
  assert.deepEqual(b64d(b64e(new Uint8Array([250, 251]))), new Uint8Array([250, 251]));
});

test('demo engine: sessions, a conversation with history, a streamed reply that ends in a result', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const engine = createDemoEngine({ now: () => now });
  const [list] = engine.handle({ op: 'sessions', reqId: 'r1' });
  assert.equal(list.ev.ev, 'sessions');
  assert.equal(list.ev.reqId, 'r1');
  assert.ok(list.ev.items.length >= 5);
  for (const s of list.ev.items) {
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof s.title, 'string');
    assert.ok(s.lastModified <= now);
  }
  assert.ok(list.ev.items[0].lastModified >= list.ev.items[1].lastModified, 'newest first');

  const first = list.ev.items[0];
  const opened = engine.handle({ op: 'open', reqId: 'r2', paneId: 'p1', sessionId: first.id });
  assert.deepEqual(opened.map((x) => x.ev.ev), ['opened', 'history']);
  assert.equal(opened[0].ev.sessionId, first.id);
  assert.equal(opened[0].ev.paneId, 'p1');
  assert.ok(opened[1].delay > opened[0].delay, 'history after opened');
  const msgs = opened[1].ev.messages;
  assert.ok(msgs.some((m) => m.type === 'user') && msgs.some((m) => m.type === 'assistant'));
  assert.equal(opened[1].ev.total, msgs.length);

  const attached = engine.handle({ op: 'attach', reqId: 'r3', paneId: 'p1', sessionId: first.id });
  assert.equal(attached[0].ev.attached, true);

  const reply = engine.handle({ op: 'send', reqId: 'r4', paneId: 'p1', text: 'next?' });
  const kinds = reply.map((x) => x.ev.ev);
  assert.equal(kinds.at(-1), 'result');
  assert.ok(kinds.includes('sdk'));
  const delays = reply.map((x) => x.delay);
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b), 'events in time order');
  const text = reply.filter((x) => x.ev.msg?.event?.delta?.text).map((x) => x.ev.msg.event.delta.text).join('');
  const final = reply.find((x) => x.ev.msg?.type === 'assistant').ev.msg.message.content[0].text;
  assert.equal(text, final, 'the streamed pieces add up to the final message');

  const fresh = engine.handle({ op: 'send', paneId: 'p2', text: 'new chat' });
  assert.equal(fresh[0].ev.ev, 'session_id');
  assert.deepEqual(engine.handle({ op: 'billing' }), []);
  assert.deepEqual(engine.handle(null), []);
  assert.equal(engine.handle({ op: 'search', reqId: 'r5', query: 'relay' })[0].ev.results.length, 1);
  assert.equal(engine.ready().ev, 'ready');
});
