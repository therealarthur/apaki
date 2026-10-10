/**
 * Tests for apaki/remote/protocol.js: the zero-knowledge pairing and
 * transport protocol between Apaki on a PC and the Apaki web client on a
 * phone. Everything runs in memory (frames are handed from one session to
 * the other directly), so these tests need no relay and no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION, LIMITS, MAX_JSON_BYTES, MAX_CHUNK_BYTES, FRAME, RELAY_SUBPROTOCOL,
  ProtocolError, PcSession, PhoneSession,
  createPcIdentity, createDeviceIdentity, exportIdentity, importIdentity, deviceIdFor,
  createRoom, createRoomToken, roomIdForToken, roomUrl, relaySubprotocols, checkRelayUrl,
  encodePcFrame, decodePcFrame, parseRelayControl,
  createPairingOffer, encodePairingPayload, decodePairingPayload, pairingUrl, parsePairingUrl,
  encodeAlert, decodeAlert, frameType, b64urlEncode, b64urlDecode, randomBytes,
} from '../apaki/remote/protocol.js';

const RELAY = 'wss://relay.example.test';

/** Feeds frames to a session one by one and gathers what it sends and reports. */
async function feed(session, frames) {
  const out = { send: [], events: [] };
  for (const f of frames) {
    const step = await session.receive(f);
    out.send.push(...step.send);
    out.events.push(...step.events);
  }
  return out;
}

/** A PC with an identity, a room, a device store and a fresh QR offer. */
async function makePc({ now, ttlMs, name = 'Arthur PC' } = {}) {
  const identity = await createPcIdentity();
  const room = await createRoom();
  const devices = new Map();
  const pc = {
    identity, room, devices, offer: null,
    newOffer() {
      this.offer = createPairingOffer({ identity, relay: RELAY, roomId: room.roomId, name, ttlMs, now: now ? now() : undefined });
      return this.offer;
    },
    session(extra = {}) {
      return new PcSession({
        identity: this.identity, roomId: this.room.roomId,
        getOffer: () => this.offer,
        getDevice: (id) => this.devices.get(id) ?? null,
        now, ...extra,
      });
    },
  };
  pc.newOffer();
  return pc;
}

/** Runs the whole pairing; returns both sessions, the SAS each side shows and the saved records. */
async function pair(pc, { deviceName = 'Pixel 9', now } = {}) {
  const device = await createDeviceIdentity({ extractable: false });
  const offer = parsePairingUrl(pc.offer.url);
  const phone = new PhoneSession({ device, offer, name: deviceName, now });
  const pcs = pc.session();
  const f1 = await phone.start();
  const s1 = await feed(pcs, [f1]);
  assert.equal(s1.send.length, 1, 'PC answers PAIR1 with PAIR2');
  const s2 = await feed(phone, s1.send);
  assert.equal(s2.events[0]?.type, 'sas', 'phone shows a SAS after PAIR2');
  const s3 = await feed(pcs, s2.send);
  assert.equal(s3.events[0]?.type, 'pair-request', 'PC asks its user to approve');
  const approved = await pcs.approve();
  pc.devices.set(approved.device.id, approved.device);
  const s4 = await feed(phone, approved.send);
  assert.equal(s4.events[0]?.type, 'paired', 'phone learns it is paired');
  return { device, phone, pcs, phoneSas: s2.events[0].sas, pcSas: s3.events[0].sas, request: s3.events[0], record: approved.device, pairing: s4.events[0].pairing };
}

/** Reconnects a paired phone; returns both open sessions. */
async function reconnect(pc, device, pairing) {
  const phone = new PhoneSession({ device, pairing });
  const pcs = pc.session();
  const h1 = await phone.start();
  const r1 = await feed(pcs, [h1]);
  const r2 = await feed(phone, r1.send);
  const r3 = await feed(pcs, r2.send);
  return { phone, pcs, frames: [h1, ...r1.send, ...r2.send], events: { phone: r2.events, pc: r3.events, pcFirst: r1.events } };
}

test('pairing happy path: both sides show the same 6-digit SAS, then talk JSON and chunks both ways', async () => {
  const pc = await makePc();
  const { phone, pcs, phoneSas, pcSas, request, record, pairing } = await pair(pc);

  assert.match(phoneSas, /^\d{6}$/);
  assert.equal(phoneSas, pcSas, 'SAS equal on both sides');
  assert.equal(request.device.name, 'Pixel 9');
  assert.equal(record.id, await deviceIdFor(record.pub));
  assert.equal(pairing.deviceId, record.id);
  assert.equal(pairing.psk, record.psk, 'both sides derived the same device secret');
  assert.equal(pairing.pcPub, b64urlEncode(pc.identity.pub));
  assert.equal(pairing.roomId, pc.room.roomId);
  assert.equal(pairing.relay, RELAY);
  assert.equal(pairing.pcName, 'Arthur PC');
  assert.ok(phone.isOpen && pcs.isOpen);
  assert.equal(phone.sessionId, pcs.sessionId);
  assert.ok(pc.offer.used, 'the QR is spent');

  const toPc = await feed(pcs, [await phone.sendJson({ op: 'send', text: 'hello from the phone' })]);
  assert.deepEqual(toPc.events, [{ type: 'json', value: { op: 'send', text: 'hello from the phone' } }]);
  const toPhone = await feed(phone, [await pcs.sendJson({ ev: 'text', text: 'hi' }), await pcs.sendJson({ ev: 'done' })]);
  assert.deepEqual(toPhone.events.map((e) => e.value), [{ ev: 'text', text: 'hi' }, { ev: 'done' }]);

  const data = randomBytes(5000);
  const chunk = await feed(phone, [await pcs.sendChunk({ stream: 7, seq: 0, data }), await pcs.sendChunk({ stream: 7, seq: 1, last: true, data: new Uint8Array(0) })]);
  assert.equal(chunk.events[0].type, 'chunk');
  assert.equal(chunk.events[0].stream, 7);
  assert.equal(chunk.events[0].last, false);
  assert.deepEqual(chunk.events[0].data, data);
  assert.equal(chunk.events[1].last, true);
});

test('a pairing frame from a phone with a wrong secret (no QR) is rejected and the QR stays usable', async () => {
  const pc = await makePc();
  const guess = { ...decodePairingPayload(pc.offer.payload), secret: b64urlEncode(randomBytes(16)) };
  const phone = new PhoneSession({ device: await createDeviceIdentity(), offer: guess });
  const pcs = pc.session();
  const s1 = await feed(pcs, [await phone.start()]);
  assert.equal(s1.events[0].type, 'error');
  assert.equal(s1.events[0].code, 'bad-mac');
  assert.equal(decodeAlert(s1.send[0]), 'bad-mac');
  assert.equal(pc.offer.used, false, 'a failed guess does not burn the real QR');
  const back = await feed(phone, s1.send);
  assert.deepEqual(back.events, [{ type: 'alert', code: 'bad-mac' }]);
  assert.equal(phone.state, 'closed');
  // The real phone can still pair.
  const ok = await pair(pc);
  assert.equal(ok.phoneSas, ok.pcSas);
});

test('an expired QR is rejected by the PC (and by the phone well past expiry)', async () => {
  let t = 1_800_000_000_000;
  const now = () => t;
  const pc = await makePc({ now, ttlMs: 120_000 });
  const offer = parsePairingUrl(pc.offer.url);
  t += 121_000;
  const phone = new PhoneSession({ device: await createDeviceIdentity(), offer, now });
  const s1 = await feed(pc.session(), [await phone.start()]);
  assert.equal(s1.events[0].code, 'expired');
  assert.equal(decodeAlert(s1.send[0]), 'expired');

  t += LIMITS.PAIR_CLOCK_SKEW_MS + 1000;
  const late = new PhoneSession({ device: await createDeviceIdentity(), offer, now });
  await assert.rejects(late.start(), (e) => e instanceof ProtocolError && e.code === 'expired');
});

test('a QR pairs exactly one phone, even when two race with it', async () => {
  const pc = await makePc();
  const offer = parsePairingUrl(pc.offer.url);
  const a = new PhoneSession({ device: await createDeviceIdentity(), offer, name: 'a' });
  const b = new PhoneSession({ device: await createDeviceIdentity(), offer, name: 'b' });
  const [fa, fb] = await Promise.all([a.start(), b.start()]);
  const [sa, sb] = await Promise.all([pc.session().receive(fa), pc.session().receive(fb)]);
  const outcomes = [sa, sb].map((s) => (s.events[0]?.type === 'error' ? s.events[0].code : 'ok')).sort();
  assert.deepEqual(outcomes, ['ok', 'used']);
  // And a third, later attempt is refused too.
  const c = new PhoneSession({ device: await createDeviceIdentity(), offer });
  const sc = await pc.session().receive(await c.start());
  assert.equal(sc.events[0].code, 'used');
});

test('without an active offer the PC refuses to pair', async () => {
  const pc = await makePc();
  const offer = parsePairingUrl(pc.offer.url);
  pc.offer = null; // the QR was closed on the PC
  const phone = new PhoneSession({ device: await createDeviceIdentity(), offer });
  const s1 = await pc.session().receive(await phone.start());
  assert.equal(s1.events[0].code, 'no-offer');
});

test('someone who saw the QR but lacks the PC key cannot pose as the PC (phone rejects PAIR2)', async () => {
  const pc = await makePc();
  const offer = parsePairingUrl(pc.offer.url);
  // The impostor knows the room and the secret, but has its own key pair.
  // The PC key is bound into the handshake keys, so its PAIR2 does not even decrypt.
  {
    const impostor = new PcSession({ identity: await createPcIdentity(), roomId: pc.room.roomId, getOffer: () => ({ ...pc.offer, used: false }) });
    const phone = new PhoneSession({ device: await createDeviceIdentity(), offer });
    const s1 = await feed(impostor, [await phone.start()]);
    const s2 = await feed(phone, s1.send);
    assert.equal(s2.events[0].type, 'error');
    assert.equal(s2.events[0].code, 'bad-mac');
    assert.equal(phone.state, 'closed');
  }
  // Even claiming the real PC public key, it cannot sign as the PC.
  {
    const own = await createPcIdentity();
    const impostor = new PcSession({ identity: { privateKey: own.privateKey, pub: pc.identity.pub }, roomId: pc.room.roomId, getOffer: () => ({ ...pc.offer, used: false }) });
    const phone = new PhoneSession({ device: await createDeviceIdentity(), offer });
    const s1 = await feed(impostor, [await phone.start()]);
    const s2 = await feed(phone, s1.send);
    assert.equal(s2.events[0].code, 'bad-signature');
    assert.equal(phone.state, 'closed');
  }
});

test('tampered handshake frames are rejected', async () => {
  // PAIR1 with a flipped byte in the ephemeral key: MAC fails.
  {
    const pc = await makePc();
    const phone = new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(pc.offer.url) });
    const f1 = await phone.start();
    f1[10] ^= 1;
    const s = await pc.session().receive(f1);
    assert.equal(s.events[0].type, 'error');
  }
  // PAIR2 with a flipped byte in the PC's nonce: the transcript changes, decryption fails.
  {
    const pc = await makePc();
    const phone = new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(pc.offer.url) });
    const s1 = await pc.session().receive(await phone.start());
    s1.send[0][1 + 65 + 3] ^= 0x40;
    const s2 = await phone.receive(s1.send[0]);
    assert.equal(s2.events[0].code, 'bad-mac');
  }
  // PAIR3 with a flipped byte: AES-GCM fails.
  {
    const pc = await makePc();
    const phone = new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(pc.offer.url) });
    const pcs = pc.session();
    const s1 = await pcs.receive(await phone.start());
    const s2 = await phone.receive(s1.send[0]);
    s2.send[0][20] ^= 1;
    const s3 = await pcs.receive(s2.send[0]);
    assert.equal(s3.events[0].code, 'bad-mac');
  }
});

test('the PC user can reject a pairing; nothing is stored and the phone hears about it', async () => {
  const pc = await makePc();
  const phone = new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(pc.offer.url) });
  const pcs = pc.session();
  const s1 = await feed(pcs, [await phone.start()]);
  const s2 = await feed(phone, s1.send);
  await feed(pcs, s2.send);
  const r = await pcs.reject();
  assert.equal(pcs.device, null);
  assert.equal(pc.devices.size, 0);
  const back = await feed(phone, r.send);
  assert.deepEqual(back.events, [{ type: 'alert', code: 'rejected' }]);
  await assert.rejects(phone.sendJson({ x: 1 }), (e) => e.code === 'closed');
});

test('an approval that comes too late is refused', async () => {
  let t = 1_800_000_000_000;
  const now = () => t;
  const pc = await makePc({ now });
  const phone = new PhoneSession({ device: await createDeviceIdentity(), offer: parsePairingUrl(pc.offer.url), now });
  const pcs = pc.session();
  const s1 = await feed(pcs, [await phone.start()]);
  const s2 = await feed(phone, s1.send);
  await feed(pcs, s2.send);
  t += LIMITS.PAIR_APPROVE_MS + 1;
  const a = await pcs.approve();
  assert.equal(a.device, null);
  assert.equal(a.events[0].code, 'timeout');
});

test('a tampered record is rejected and closes the channel', async () => {
  const pc = await makePc();
  const { phone, pcs } = await pair(pc);
  const frame = await phone.sendJson({ op: 'send', text: 'rm -rf nothing' });
  frame[frame.length - 1] ^= 1;
  const s = await pcs.receive(frame);
  assert.equal(s.events[0].type, 'error');
  assert.equal(s.events[0].code, 'bad-record');
  assert.equal(pcs.state, 'closed');
  // A closed session ignores everything after.
  const after = await pcs.receive(await phone.sendJson({ ok: true }));
  assert.deepEqual(after, { send: [], events: [] });
});

test('a replayed record is rejected', async () => {
  const pc = await makePc();
  const { phone, pcs } = await pair(pc);
  const frame = await phone.sendJson({ op: 'interrupt' });
  const first = await pcs.receive(frame.slice());
  assert.equal(first.events[0].type, 'json');
  const again = await pcs.receive(frame.slice());
  assert.equal(again.events[0].code, 'bad-record');
});

test('reordered records are rejected', async () => {
  const pc = await makePc();
  const { phone, pcs } = await pair(pc);
  const a = await pcs.sendJson({ n: 1 });
  const b = await pcs.sendJson({ n: 2 });
  const s = await feed(phone, [b, a]);
  assert.equal(s.events[0].code, 'bad-record');
});

test('reconnect after a restart of both sides, with only the stored keys, gives fresh keys every time', async () => {
  const pc = await makePc();
  const { device, pairing } = await pair(pc);

  // Both sides save and restart: the PC writes its identity, room and devices
  // as JSON; the phone keeps its CryptoKeys (IndexedDB stores them by
  // structured clone) and its pairing record as JSON.
  const savedPc = JSON.stringify({ identity: await exportIdentity(pc.identity), room: pc.room, devices: [...pc.devices.values()] });
  const savedPairing = JSON.stringify(pairing);
  const savedDevice = { privateKey: structuredClone(device.privateKey), publicKey: structuredClone(device.publicKey), pub: device.pub.slice() };

  const restored = JSON.parse(savedPc);
  const pc2 = await makePc();
  pc2.identity = await importIdentity(restored.identity);
  pc2.room = restored.room;
  pc2.devices = new Map(restored.devices.map((d) => [d.id, d]));
  pc2.offer = null; // no QR on screen: reconnects do not need one

  const one = await reconnect(pc2, savedDevice, JSON.parse(savedPairing));
  assert.deepEqual(one.events.phone, [{ type: 'open' }]);
  assert.equal(one.events.pc[0].type, 'open');
  assert.equal(one.events.pc[0].device.id, pairing.deviceId);
  const msg = await feed(one.pcs, [await one.phone.sendJson({ op: 'sessions' })]);
  assert.deepEqual(msg.events[0].value, { op: 'sessions' });
  const reply = await feed(one.phone, [await one.pcs.sendJson({ ev: 'sessions', items: [] })]);
  assert.deepEqual(reply.events[0].value, { ev: 'sessions', items: [] });

  const two = await reconnect(pc2, savedDevice, JSON.parse(savedPairing));
  assert.ok(two.phone.isOpen && two.pcs.isOpen);
  assert.notEqual(one.pcs.sessionId, two.pcs.sessionId, 'every connection has its own keys (fresh ephemerals)');
});

test('a revoked device can no longer connect', async () => {
  const pc = await makePc();
  const { device, pairing, record } = await pair(pc);
  pc.devices.delete(record.id); // the PC user removed this phone
  const phone = new PhoneSession({ device, pairing });
  const s1 = await feed(pc.session(), [await phone.start()]);
  assert.equal(s1.events[0].code, 'unknown-device');
  const back = await feed(phone, s1.send);
  assert.deepEqual(back.events, [{ type: 'alert', code: 'unknown-device' }]);
});

test('a device revoked while its reconnect is in flight is refused at the last step', async () => {
  const pc = await makePc();
  const { device, pairing, record } = await pair(pc);
  const phone = new PhoneSession({ device, pairing });
  const pcs = pc.session();
  const r1 = await feed(pcs, [await phone.start()]);
  const r2 = await feed(phone, r1.send);
  pc.devices.delete(record.id);
  const r3 = await feed(pcs, r2.send);
  assert.equal(r3.events[0].code, 'unknown-device');
  assert.equal(pcs.isOpen, false);
});

test('a captured reconnect cannot be replayed into a new channel', async () => {
  const pc = await makePc();
  const { device, pairing } = await pair(pc);
  const captured = await reconnect(pc, device, pairing);
  const [hello1, , hello3] = captured.frames;
  // An attacker replays HELLO1 (the PC answers, it cannot tell yet) and then the old HELLO3.
  const pcs = pc.session();
  const r1 = await feed(pcs, [hello1]);
  assert.equal(r1.send.length, 1);
  const r3 = await feed(pcs, [hello3]);
  assert.equal(r3.events[0].type, 'error');
  assert.equal(pcs.isOpen, false);
});

test('another phone key cannot reconnect with a stolen pairing record alone', async () => {
  const pc = await makePc();
  const { pairing, device } = await pair(pc);
  // With its own key the device public key in the transcript is wrong: the PC's answer does not decrypt.
  {
    const thief = new PhoneSession({ device: await createDeviceIdentity(), pairing });
    const pcs = pc.session();
    const r1 = await feed(pcs, [await thief.start()]);
    const r2 = await feed(thief, r1.send);
    assert.equal(r2.events[0].code, 'bad-mac');
    const r3 = await feed(pcs, r2.send);
    assert.equal(pcs.isOpen, false);
    assert.equal(r3.events[0].type, 'alert');
  }
  // Claiming the real device public key, it still cannot sign as the device.
  {
    const own = await createDeviceIdentity();
    const thief = new PhoneSession({ device: { privateKey: own.privateKey, pub: device.pub }, pairing });
    const pcs = pc.session();
    const r1 = await feed(pcs, [await thief.start()]);
    const r2 = await feed(thief, r1.send);
    assert.equal(thief.isOpen, true, 'the thief side thinks it is open');
    const r3 = await feed(pcs, r2.send);
    assert.equal(r3.events[0].code, 'bad-signature');
    assert.equal(pcs.isOpen, false, 'but the PC never opens');
  }
});

test('size limits: big JSON and big chunks are refused before sending; oversized frames are refused on receive', async () => {
  const pc = await makePc();
  const { phone, pcs } = await pair(pc);
  await assert.rejects(phone.sendJson({ s: 'x'.repeat(MAX_JSON_BYTES) }), (e) => e.code === 'bad-record');
  await assert.rejects(pcs.sendChunk({ stream: 1, seq: 0, data: new Uint8Array(MAX_CHUNK_BYTES + 1) }), (e) => e.code === 'bad-record');
  const big = await pcs.sendChunk({ stream: 1, seq: 0, last: true, data: new Uint8Array(MAX_CHUNK_BYTES) });
  assert.ok(big.length <= LIMITS.MAX_FRAME);
  const got = await feed(phone, [big]);
  assert.equal(got.events[0].data.length, MAX_CHUNK_BYTES);
  const tooBig = new Uint8Array(LIMITS.MAX_FRAME + 1);
  tooBig[0] = FRAME.RECORD;
  const s = await phone.receive(tooBig);
  assert.equal(s.events[0].code, 'bad-record');
  // Handshake frames have their own small limit.
  const pc2 = await makePc();
  const hs = new Uint8Array(LIMITS.MAX_HANDSHAKE_FRAME + 1);
  hs[0] = FRAME.PAIR1;
  const r = await pc2.session().receive(hs);
  assert.equal(r.events[0].code, 'bad-frame');
});

test('an authenticated close reaches the other side', async () => {
  const pc = await makePc();
  const { phone, pcs } = await pair(pc);
  const s = await feed(phone, [await pcs.close('PC is shutting down')]);
  assert.deepEqual(s.events, [{ type: 'close', reason: 'PC is shutting down' }]);
  assert.equal(phone.state, 'closed');
  await assert.rejects(pcs.sendJson({}), (e) => e.code === 'closed');
});

test('frames arriving out of state are rejected', async () => {
  const pc = await makePc();
  const { phone } = await pair(pc);
  // A fresh PC session gets a record before any handshake.
  const s = await pc.session().receive(await phone.sendJson({ hi: 1 }));
  assert.equal(s.events[0].code, 'bad-frame');
  const e = await pc.session().receive(new Uint8Array(0));
  assert.equal(e.events[0].code, 'bad-frame');
});

test('QR payload: round trip through the URL fragment, junk rejected', async () => {
  const pc = await makePc({ name: 'Büro PC' });
  const url = pc.offer.url;
  assert.ok(url.startsWith('https://apaki.myrlin.io/#p='), url);
  assert.ok(!url.split('#')[0].includes(pc.offer.secret), 'the secret is only in the fragment');
  const back = parsePairingUrl(url);
  for (const k of ['v', 'relay', 'roomId', 'pcPub', 'secret', 'exp', 'name']) assert.deepEqual(back[k], pc.offer[k], k);
  assert.equal(back.v, PROTOCOL_VERSION);
  assert.deepEqual(parsePairingUrl('#p=' + pc.offer.payload), back);
  assert.equal(pairingUrl('https://x.test/app/#old', 'abc'), 'https://x.test/app/#p=abc');
  assert.ok(pc.offer.url.length < 300, 'short enough for a comfortable QR');
  assert.throws(() => parsePairingUrl('https://apaki.myrlin.io/'), ProtocolError);
  assert.throws(() => decodePairingPayload('AAAA'), ProtocolError);
  const bad = b64urlDecode(pc.offer.payload);
  bad[0] = 9;
  assert.throws(() => decodePairingPayload(b64urlEncode(bad)), (e) => e.code === 'version');
  assert.throws(() => encodePairingPayload({ ...pc.offer, relay: 'http://evil.test' }), ProtocolError);
});

test('rooms: the id is bound to the token; relay URLs and subprotocols', async () => {
  const { roomId, token } = await createRoom();
  assert.match(roomId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await roomIdForToken(token), roomId);
  assert.notEqual(await roomIdForToken(createRoomToken()), roomId);
  await assert.rejects(roomIdForToken('short'), ProtocolError);

  assert.equal(roomUrl('wss://relay.myrlin.io/', roomId, 'pc'), `wss://relay.myrlin.io/v1/rooms/${roomId}/pc`);
  assert.equal(roomUrl('ws://127.0.0.1:8787', roomId, 'phone'), `ws://127.0.0.1:8787/v1/rooms/${roomId}/phone`);
  assert.throws(() => roomUrl('ws://relay.myrlin.io', roomId, 'pc'), ProtocolError, 'plain ws only on loopback');
  assert.throws(() => roomUrl('wss://relay.myrlin.io', 'nope', 'pc'), ProtocolError);
  assert.throws(() => checkRelayUrl('wss://user:pw@relay.myrlin.io'), ProtocolError);
  assert.deepEqual(relaySubprotocols('phone'), [RELAY_SUBPROTOCOL]);
  assert.deepEqual(relaySubprotocols('pc', token), [RELAY_SUBPROTOCOL, `apaki-token.${token}`]);
  assert.throws(() => relaySubprotocols('pc'), Error);

  const framed = encodePcFrame(0xdeadbeef, new Uint8Array([1, 2, 3]));
  assert.deepEqual(decodePcFrame(framed), { connId: 0xdeadbeef, payload: new Uint8Array([1, 2, 3]) });
  assert.throws(() => decodePcFrame(new Uint8Array(3)), ProtocolError);
  assert.deepEqual(parseRelayControl('{"t":"join","conn":5}'), { t: 'join', conn: 5 });
  assert.deepEqual(parseRelayControl('pong'), { t: 'pong' });
  assert.equal(parseRelayControl('not json'), null);
});

test('identities: export and import keep the key; device ids are stable', async () => {
  const id = await createPcIdentity();
  const saved = await exportIdentity(id);
  const back = await importIdentity(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(back.pub, id.pub);
  await assert.rejects(importIdentity({ ...saved, pub: b64urlEncode((await createPcIdentity()).pub) }), ProtocolError);
  await assert.rejects(importIdentity({ kind: 'other' }), ProtocolError);
  const dev = await createDeviceIdentity();
  assert.equal(dev.privateKey.extractable, false, 'phone keys stay inside the browser');
  assert.equal(await deviceIdFor(dev.pub), await deviceIdFor(b64urlEncode(dev.pub)));
  assert.equal(frameType(encodeAlert('used')), 'alert');
  assert.equal(decodeAlert(encodeAlert('used')), 'used');
});
