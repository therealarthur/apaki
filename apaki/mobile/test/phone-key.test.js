/**
 * The Apaki app's phone key (2026-10-11, apaki/remote/ENROLL.md): the same
 * getPhoneKey the web store has, kept in the Secure Enclave through the
 * existing ApakiKeys plugin (no new Swift). Here the app's own native-store.js
 * runs from a real app build against a stand-in for ApakiKeys that keeps its
 * private keys to itself, like the Secure Enclave: the key is made once, found
 * again after a restart, signs in the 64-byte r||s form the PC verifies, and
 * the start-up prune of unused device keys leaves it alone.
 *
 * Not testable here: the real Secure Enclave (needs an iPhone and Xcode).
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildApp } from '../scripts/build-app.mjs';
import { b64d, b64e } from '../src/codec.js';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-app-phonekey-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A stand-in for the ApakiKeys plugin: keys that only sign, and a Keychain of strings. */
function fakeKeys() {
  const keys = new Map();
  const keychain = new Map();
  const calls = { createKey: 0 };
  return {
    keys,
    keychain,
    calls,
    createKey: async () => {
      calls.createKey += 1;
      const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const keyId = globalThis.crypto.randomUUID();
      keys.set(keyId, kp.privateKey);
      return { keyId, pub: b64e(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))), secureEnclave: true };
    },
    sign: async ({ keyId, data }) => ({ sig: b64e(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.get(keyId), b64d(data)))) }),
    deleteKey: async ({ keyId }) => { keys.delete(keyId); },
    pruneKeys: async ({ keep = [] }) => {
      let removed = 0;
      for (const id of [...keys.keys()]) if (!keep.includes(id)) { keys.delete(id); removed += 1; }
      return { removed };
    },
    vaultGet: async ({ key }) => (keychain.has(key) ? { value: keychain.get(key) } : {}),
    vaultSet: async ({ key, value }) => { keychain.set(key, value); },
    vaultRemove: async ({ key }) => { keychain.delete(key); },
    vaultList: async ({ prefix = '' }) => ({ items: [...keychain].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
  };
}

test('the app\'s phone key: one Secure Enclave key, made once, found again, signs for the PC, and the start-up prune keeps it', async () => {
  const Keys = fakeKeys();
  globalThis.__apakiPlugins = { ApakiKeys: Keys };
  try {
    const core = path.join(tmp, 'capacitor-core.js');
    fs.writeFileSync(core, "export const Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true };\nexport const registerPlugin = (name) => globalThis.__apakiPlugins[name];\n");
    const out = path.join(tmp, 'www');
    buildApp({ out, core });
    const imp = (tag) => import(`${pathToFileURL(path.join(out, 'app', 'native-store.js')).href}?${tag}`);

    const store = await imp('a');
    const k1 = await store.getPhoneKey();
    const k2 = await store.getPhoneKey();
    assert.equal(Keys.calls.createKey, 1, 'made once');
    assert.deepEqual(k1.pub, k2.pub);
    assert.equal(k1.pub.length, 65);
    assert.equal(k1.secureEnclave, true);
    assert.equal(k1.privateKey, undefined, 'the page never holds a private key');

    // What is kept in the Keychain record "phone": the key id and the public key, nothing secret.
    const record = JSON.parse(Keys.keychain.get('phone'));
    assert.deepEqual(Object.keys(record).sort(), ['created', 'keyId', 'pub', 'se', 'v']);
    assert.equal(record.pub, b64e(k1.pub));

    // It signs in the form the PC verifies with the public key.
    const sig = await k1.sign(utf8.encode('apaki/v1 via'));
    assert.equal(sig.length, 64);
    const verifyKey = await subtle.importKey('raw', k1.pub, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, utf8.encode('apaki/v1 via')));

    // The app is restarted: a fresh module finds the same key in the Keychain instead of making another.
    const again = await (await imp('b')).getPhoneKey();
    assert.deepEqual(again.pub, k1.pub);
    assert.equal(Keys.calls.createKey, 1);

    // Start-up prune: a pairing that never finished left a device key; the phone key is not one, and must stay.
    const orphan = await store.newDevice();
    assert.equal(Keys.keys.size, 2);
    const pruned = await store.pruneKeys();
    assert.equal(pruned.removed, 1);
    assert.equal(Keys.keys.has(orphan.keyId), false);
    assert.equal(Keys.keys.has(record.keyId), true, 'the phone key survived the prune');
    assert.equal((await (await imp('c')).getPhoneKey()).pub.length, 65);
    assert.equal(Keys.calls.createKey, 2, 'only newDevice made the second key; the phone key was not remade');

    // It is not a paired PC: the PC list does not see it, and signing out of an account leaves it.
    assert.deepEqual(await store.listPcs(), []);
    await store.forgetAccount();
    assert.ok(Keys.keychain.has('phone'));
  } finally {
    delete globalThis.__apakiPlugins;
  }
});

test('a Keychain that cannot be read is a StorageError, and the phone key is made again on the next try (not cached as a failure)', async () => {
  const Keys = fakeKeys();
  let broken = true;
  const vaultGet = Keys.vaultGet;
  Keys.vaultGet = async (o) => { if (broken) throw new Error('keychain locked'); return vaultGet(o); };
  globalThis.__apakiPlugins = { ApakiKeys: Keys };
  try {
    const out = path.join(tmp, 'www2');
    buildApp({ out, core: path.join(tmp, 'capacitor-core.js') });
    const store = await import(`${pathToFileURL(path.join(out, 'app', 'native-store.js')).href}?locked`);
    await assert.rejects(store.getPhoneKey(), (e) => store.isStorageError(e));
    assert.equal(Keys.calls.createKey, 0, 'no key is made while the Keychain cannot say whether one exists');
    broken = false;
    const key = await store.getPhoneKey();
    assert.equal(key.pub.length, 65);
    assert.equal(Keys.calls.createKey, 1);
  } finally {
    delete globalThis.__apakiPlugins;
  }
});
