/**
 * The Apaki app's device key lives in the Secure Enclave, so protocol.js
 * signs through the device's own sign(bytes) (deviceSign, 2026-10-10). Here a
 * signer that keeps its key to itself, as the Secure Enclave does, pairs
 * with a PC and reconnects; a signer that answers in the wrong format fails
 * cleanly. The PC side is protocol.js's own PcSession, unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PcSession, PhoneSession, createPairingOffer, createPcIdentity, createRoom, parsePairingUrl } from '../../remote/protocol.js';

const subtle = globalThis.crypto.subtle;

/** A device whose private key never leaves it: only pub and sign(bytes), like ApakiKeys on iOS. */
async function enclaveLike() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  let calls = 0;
  return {
    pub,
    keyId: 'se-1',
    get calls() { return calls; },
    sign: async (bytes) => { calls += 1; return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, bytes)); },
  };
}

async function feed(session, frames) {
  const out = { send: [], events: [] };
  for (const f of frames) {
    const step = await session.receive(f);
    out.send.push(...step.send);
    out.events.push(...step.events);
  }
  return out;
}

async function makePc() {
  const identity = await createPcIdentity();
  const room = await createRoom();
  const devices = new Map();
  const offer = createPairingOffer({ identity, relay: 'wss://apaki.myrlin.io', roomId: room.roomId, name: 'Studio PC' });
  const session = () => new PcSession({ identity, roomId: room.roomId, getOffer: () => offer, getDevice: (id) => devices.get(id) ?? null });
  return { identity, room, devices, offer, session };
}

test('a device that signs by itself pairs, and reconnects with its saved pairing', async () => {
  const pc = await makePc();
  const device = await enclaveLike();
  assert.equal(device.privateKey, undefined, 'no WebCrypto key on the device object');

  const phone = new PhoneSession({ device, offer: parsePairingUrl(pc.offer.url), name: 'iPhone (Apaki app)' });
  const pcs = pc.session();
  const s1 = await feed(pcs, [await phone.start()]);
  const s2 = await feed(phone, s1.send);
  assert.equal(s2.events[0].type, 'sas');
  const s3 = await feed(pcs, s2.send);
  assert.equal(s3.events[0].type, 'pair-request');
  assert.equal(s3.events[0].sas, s2.events[0].sas);
  const approved = await pcs.approve();
  pc.devices.set(approved.device.id, approved.device);
  const s4 = await feed(phone, approved.send);
  assert.equal(s4.events[0].type, 'paired');
  assert.equal(device.calls, 1);

  const again = new PhoneSession({ device, pairing: s4.events[0].pairing });
  const pcs2 = pc.session();
  const r1 = await feed(pcs2, [await again.start()]);
  const r2 = await feed(again, r1.send);
  assert.equal(r2.events[0].type, 'open');
  const r3 = await feed(pcs2, r2.send);
  assert.ok(again.isOpen && pcs2.isOpen, 'both ends open after the reconnect');
  assert.ok(r3.events.some((e) => e.type === 'open'));
  assert.equal(device.calls, 2);

  const toPc = await feed(pcs2, [await again.sendJson({ op: 'sessions' })]);
  assert.deepEqual(toPc.events, [{ type: 'json', value: { op: 'sessions' } }]);
});

test('a signer that answers in the wrong form (DER, not 64 bytes) is an error, not a broken frame', async () => {
  const pc = await makePc();
  const good = await enclaveLike();
  const device = { pub: good.pub, sign: async () => new Uint8Array(71) };
  const phone = new PhoneSession({ device, offer: parsePairingUrl(pc.offer.url) });
  const s1 = await feed(pc.session(), [await phone.start()]);
  // receive() never throws: it closes the session and reports the error (and an alert to send).
  const s2 = await feed(phone, s1.send);
  const err = s2.events.find((e) => e.type === 'error');
  assert.ok(err, 'an error event');
  assert.equal(err.code, 'internal');
  assert.match(err.message, /71-byte signature, not 64/);
  assert.ok(!phone.isOpen);
});

test('a device needs a key or a signer, and its public key', async () => {
  const pc = await makePc();
  const offer = parsePairingUrl(pc.offer.url);
  assert.throws(() => new PhoneSession({ device: { pub: new Uint8Array(65) }, offer }), /device identity/);
  assert.throws(() => new PhoneSession({ device: { sign: async () => new Uint8Array(64) }, offer }), /device identity/);
});
