/**
 * Tests for apaki/mobile/src/codec.js: how the Apaki app keeps pairings and
 * the account in the Keychain, which links it accepts, where it may connect,
 * and the small mappings (haptics, status bar, module exports).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  b64d, b64e, decodeAccount, decodeDevice, decodePc, encodeAccount, encodeDevice, encodePc,
  exportNames, hapticStyle, isDark, kbInset, pairingPayloadFrom, relaySocketAllowed, siteRequestAllowed,
} from '../src/codec.js';
import { createDeviceIdentity, createPairingOffer, createPcIdentity, createRoom } from '../../remote/protocol.js';

const subtle = globalThis.crypto.subtle;

test('base64url round trip, no padding, binary safe', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33, 65, 70000]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
    const text = b64e(bytes);
    assert.doesNotMatch(text, /[+/=]/);
    assert.deepEqual(b64d(text), bytes);
  }
});

test('a PC paired with a native (Secure Enclave) key: stored as its id and public key, signs through the signer', async () => {
  const pub = new Uint8Array(65).fill(9); pub[0] = 4;
  const signed = [];
  const signerFor = (keyId) => async (bytes) => { signed.push([keyId, bytes]); return new Uint8Array(64).fill(1); };
  const rec = { roomId: 'r'.repeat(22), pcName: 'Studio PC', relay: 'wss://apaki.myrlin.io', pairing: { v: 1, roomId: 'r'.repeat(22), psk: 'secret' }, device: { keyId: 'k1', pub, secureEnclave: true, sign: () => {} }, pairedAt: '2026-10-10T00:00:00.000Z', lastUsed: '2026-10-10T01:00:00.000Z' };
  const json = JSON.parse(JSON.stringify(await encodePc(rec)));
  assert.deepEqual(json.device, { kind: 'native', keyId: 'k1', pub: b64e(pub), se: true });
  assert.equal(json.v, 1);
  const back = await decodePc(json, signerFor);
  assert.equal(back.pcName, 'Studio PC');
  assert.deepEqual(back.pairing, rec.pairing);
  assert.deepEqual(back.device.pub, pub);
  assert.equal(back.device.keyId, 'k1');
  assert.equal(back.v, undefined);
  await back.device.sign(new Uint8Array([1, 2, 3]));
  assert.deepEqual(signed, [['k1', new Uint8Array([1, 2, 3])]]);
});

test('an account PC with an extractable WebCrypto device: stored as JWK, comes back able to sign the same way', async () => {
  const device = await createDeviceIdentity({ extractable: true });
  const json = JSON.parse(JSON.stringify(await encodePc({ roomId: 'a'.repeat(22), device, via: 'account' })));
  assert.equal(json.device.kind, 'jwk');
  const back = await decodePc(json);
  assert.equal(back.via, 'account');
  assert.deepEqual(back.device.pub, device.pub);
  const msg = new TextEncoder().encode('apaki');
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, back.device.privateKey, msg);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, device.publicKey, sig, msg));
  // Exportable again, so the next save works too.
  assert.equal(back.device.privateKey.extractable, true);
});

test('a non-extractable WebCrypto key is refused with a clear message (it could not be kept)', async () => {
  const device = await createDeviceIdentity({ extractable: false });
  await assert.rejects(encodeDevice(device), /cannot be kept in the keychain/);
  await assert.rejects(decodeDevice({ kind: 'native', keyId: 'x', pub: b64e(new Uint8Array(65)) }), /needs a signer/);
  await assert.rejects(decodePc({ roomId: 'x', v: 2 }), /version 2/);
});

test('the account: vault key and account device survive the Keychain round trip', async () => {
  const vk = await subtle.importKey('raw', new Uint8Array(32).fill(5), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const device = await createDeviceIdentity({ extractable: true });
  const acct = { key: 'me', accountId: 'acc', name: 'Arthur', session: 'tok', sessionExp: 1, ver: 3, vaultKey: vk, device: { privateKey: device.privateKey, pub: device.pub }, devicePub: b64e(device.pub), rpId: 'apaki.myrlin.io', rooms: ['r1'] };
  const stored = JSON.parse(JSON.stringify(await encodeAccount(acct)));
  assert.equal(typeof stored.vaultKey, 'string');
  const back = await decodeAccount(stored);
  assert.deepEqual({ ...back, vaultKey: null, device: null }, { ...acct, vaultKey: null, device: null });
  const iv = new Uint8Array(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, vk, new TextEncoder().encode('vault'));
  assert.equal(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, back.vaultKey, ct)), 'vault');
  assert.equal(await decodeAccount(null), null);
  const locked = await subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, ['encrypt']);
  await assert.rejects(encodeAccount({ ...acct, vaultKey: locked }), /not exportable/);
});

test('pairing links: the PC QR as a Universal Link, older QRs, the app scheme; nothing else', async () => {
  const room = await createRoom();
  const offer = createPairingOffer({ identity: await createPcIdentity(), relay: 'wss://apaki.myrlin.io', roomId: room.roomId, name: 'PC' });
  const payload = offer.url.split('#p=')[1];
  assert.equal(pairingPayloadFrom(`https://apaki.myrlin.io/v/cab37e8659c3/#p=${payload}`), payload);
  assert.equal(pairingPayloadFrom(`https://apaki.myrlin.io/#p=${payload}`), payload);
  assert.equal(pairingPayloadFrom(`apaki://pair#p=${payload}`), payload);
  assert.equal(pairingPayloadFrom(`https://apaki.myrlin.io/v/x/#a=1&p=${payload}`), payload);
  assert.equal(pairingPayloadFrom(`https://evil.example/v/x/#p=${payload}`), null);
  assert.equal(pairingPayloadFrom(`http://apaki.myrlin.io/#p=${payload}`), null);
  assert.equal(pairingPayloadFrom('https://apaki.myrlin.io/v/x/'), null);
  assert.equal(pairingPayloadFrom('https://apaki.myrlin.io/#p=short'), null);
  assert.equal(pairingPayloadFrom('not a url'), null);
});

test('where the app may connect: the relay phone socket and the site API, exactly', () => {
  const room = 'A'.repeat(22);
  assert.ok(relaySocketAllowed(`wss://apaki.myrlin.io/v1/rooms/${room}/phone`));
  assert.ok(!relaySocketAllowed(`wss://apaki.myrlin.io/v1/rooms/${room}/pc`), 'never the PC side');
  assert.ok(!relaySocketAllowed(`ws://apaki.myrlin.io/v1/rooms/${room}/phone`));
  assert.ok(!relaySocketAllowed(`wss://apaki.myrlin.io.evil.example/v1/rooms/${room}/phone`));
  assert.ok(!relaySocketAllowed(`wss://user:pw@apaki.myrlin.io/v1/rooms/${room}/phone`));
  assert.ok(!relaySocketAllowed(`wss://apaki.myrlin.io/v1/rooms/${room}/phone?x=1`));
  assert.ok(!relaySocketAllowed('wss://relay.apaki.invalid/v1/rooms/x/phone'));
  assert.ok(siteRequestAllowed('https://apaki.myrlin.io/v1/account'));
  assert.ok(siteRequestAllowed(`https://apaki.myrlin.io/v1/rooms/${room}/presence`));
  assert.ok(!siteRequestAllowed('https://apaki.myrlin.io/v/cab37e8659c3/index.html'));
  assert.ok(!siteRequestAllowed('http://apaki.myrlin.io/v1/account'));
  assert.ok(!siteRequestAllowed('https://example.com/v1/account'));
});

test('haptics: native.js durations map to impact styles', () => {
  assert.equal(hapticStyle(7), 'LIGHT');
  assert.equal(hapticStyle(11), 'MEDIUM');
  assert.equal(hapticStyle(16), 'HEAVY');
  assert.equal(hapticStyle([11, 30, 11]), 'MEDIUM');
  assert.equal(hapticStyle(0), null);
  assert.equal(hapticStyle('x'), null);
});

test('status bar: Apaki grounds read as light or dark', () => {
  assert.equal(isDark('#FDFDFF'), false);
  assert.equal(isDark('#121120'), true);
  assert.equal(isDark('#fff'), false);
  assert.equal(isDark('#000'), true);
  assert.equal(isDark('rgb(18, 17, 32)'), true);
  assert.equal(isDark('rgba(253, 253, 255, 1)'), false);
  assert.equal(isDark('teal'), false);
});

test('keyboard: the page moves up by what the visual viewport has not already given up (2026-10-11)', () => {
  // iOS with resize none: WebKit keeps the viewport, the page moves by the whole keyboard.
  assert.equal(kbInset(336, 844, 844), 336);
  // A WebKit that shrinks the viewport for the keyboard too: nothing is moved twice.
  assert.equal(kbInset(336, 844, 508), 0);
  assert.equal(kbInset(336, 844, 600), 92);
  // Closed, nonsense and unknown viewports.
  assert.equal(kbInset(0, 844, 844), 0);
  assert.equal(kbInset(-20, 844, 844), 0);
  assert.equal(kbInset('x', 844, 844), 0);
  assert.equal(kbInset(301.6, 844, NaN), 302);
});

test('exportNames reads declarations and export lists', () => {
  const src = `/* export const hidden = 1; */
// export function alsoHidden() {}
export const a = 1;
export async function b() {}
export function c() {}
export class D {}
export let e;
const f = 1, g = 2;
export { f, g as h };
export { x, y as z } from './other.js';
`;
  assert.deepEqual(exportNames(src), ['D', 'a', 'b', 'c', 'e', 'f', 'h', 'x', 'z']);
});
