/**
 * apaki-keychain.test.js: the macOS Keychain sealer (apaki/engine/keychain.js), against a fake `security` on any OS.
 *
 * The fake keeps generic passwords in a Map and answers find-generic-password and `security -i` the way the real tool
 * does (exit 44 when an item is missing, the password on stdout). What these tests pin: the key round-trips, the key is
 * never on a command line, a missing item or a locked keychain cannot open the file (and does not silently make a new
 * key), a lost creation race keeps the first key, and remote-store's file format works with the Keychain scheme.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKeychain, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, KeychainError } from '../apaki/engine/keychain.js';

/** A fake security tool. `calls` records every argv and stdin; `locked` makes every call fail like a locked keychain. */
function fakeSecurity({ locked = false } = {}) {
  const items = new Map();
  const calls = [];
  const run = async (args, stdin = null) => {
    calls.push({ args, stdin });
    if (locked) return { code: 36, stdout: '', stderr: 'security: User interaction is not allowed.\n' };
    if (args[0] === 'find-generic-password') {
      const a = args[args.indexOf('-a') + 1];
      const s = args[args.indexOf('-s') + 1];
      const f = args[args.indexOf('-w') + 1] || '';   // a keychain file named last, or none (the login Keychain)
      const v = items.get(`${f}${s}/${a}`);
      return v ? { code: 0, stdout: `${v}\n`, stderr: '' } : { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' };
    }
    if (args[0] === '-i') {
      // Interactive mode: commands on stdin. An add of an item that exists reports on stderr and still exits 0.
      const m = /^add-generic-password -a (\S+) -s (\S+) -w (\S+)(?: "?([^"\n]+)"?)?\n$/.exec(stdin || '');
      assert.ok(m, `unexpected interactive command: ${stdin}`);
      const k = `${m[4] || ''}${m[2]}/${m[1]}`;
      if (items.has(k)) return { code: 0, stdout: '', stderr: 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\n' };
      items.set(k, m[3]);
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { run, items, calls };
}

test('keychain: sealed bytes open again, are not the plain bytes, and the key is made once', async () => {
  const sec = fakeSecurity();
  const kc = createKeychain({ run: sec.run });
  const plain = Buffer.from('{"identity":{"d":"secret"},"token":"t"}');
  const sealed = await kc.protect(plain);
  assert.notDeepEqual(sealed, plain);
  assert.ok(!sealed.includes(Buffer.from('secret')));
  assert.deepEqual(await kc.unprotect(sealed), plain);
  assert.equal(sec.items.size, 1);
  assert.match(sec.items.get(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`), /^[0-9a-f]{64}$/);
  // The key is cached: later calls do not ask the Keychain again.
  const before = sec.calls.length;
  await kc.protect(plain);
  await kc.unprotect(sealed);
  assert.equal(sec.calls.length, before);
  // Two seals of the same bytes differ (a fresh IV each time).
  assert.notDeepEqual(await kc.protect(plain), await kc.protect(plain));
});

test('keychain: the key goes through stdin only, never an argument', async () => {
  const sec = fakeSecurity();
  const kc = createKeychain({ run: sec.run });
  await kc.protect(Buffer.from('x'));
  const key = sec.items.get(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`);
  for (const c of sec.calls) assert.ok(!c.args.join(' ').includes(key), `argv leaks the key: ${c.args.join(' ')}`);
  const add = sec.calls.find((c) => c.args[0] === '-i');
  assert.deepEqual(add.args, ['-i']);
  assert.ok(add.stdin.includes(key), 'the key is in the interactive stdin');
});

test('keychain: a second process reads the key the first made; a restart opens what was sealed', async () => {
  const sec = fakeSecurity();
  const sealed = await createKeychain({ run: sec.run }).protect(Buffer.from('hello'));
  const again = createKeychain({ run: sec.run });
  assert.equal((await again.unprotect(sealed)).toString(), 'hello');
});

test('keychain: a missing item cannot open sealed data and does NOT make a new key (the file is never replaced behind the person)', async () => {
  const sec = fakeSecurity();
  const sealed = await createKeychain({ run: sec.run }).protect(Buffer.from('hello'));
  sec.items.clear();
  const fresh = createKeychain({ run: sec.run });
  await assert.rejects(fresh.unprotect(sealed), (e) => e instanceof KeychainError && e.code === 'missing');
  assert.equal(sec.items.size, 0, 'unprotect never creates a key');
});

test('keychain: another key, or damaged data, is refused with a clear error', async () => {
  const sealed = await createKeychain({ run: fakeSecurity().run }).protect(Buffer.from('hello'));
  const other = createKeychain({ run: fakeSecurity().run });
  // Different Keychain (different key): make its key first by sealing something.
  await other.protect(Buffer.from('x'));
  await assert.rejects(other.unprotect(sealed), /does not open this file/);
  const kc = createKeychain({ run: fakeSecurity().run });
  await assert.rejects(kc.unprotect(Buffer.from('short')), /too short/);
});

test('keychain: a locked keychain says locked (so phone access retries) and nothing is made', async () => {
  const sec = fakeSecurity({ locked: true });
  const kc = createKeychain({ run: sec.run });
  await assert.rejects(kc.protect(Buffer.from('x')), (e) => e.code === 'locked' && /security exit 36/.test(e.message));
  await assert.rejects(kc.unprotect(Buffer.alloc(40)), (e) => e.code === 'locked');
  assert.equal(sec.items.size, 0);
});

test('keychain: two processes making the key at once end up with the same key', async () => {
  const sec = fakeSecurity();
  // The second process sees "not found" first, then the first one's item exists when it adds.
  let racing = true;
  const run = async (args, stdin) => {
    if (racing && args[0] === 'find-generic-password') { racing = false; return { code: 44, stdout: '', stderr: '' }; }
    return sec.run(args, stdin);
  };
  const first = createKeychain({ run: sec.run });
  await first.protect(Buffer.from('first'));
  const second = createKeychain({ run });
  const sealed = await second.protect(Buffer.from('second'));
  assert.equal((await first.unprotect(sealed)).toString(), 'second', 'the second process ended up on the first key');
  assert.equal(sec.items.size, 1, 'one key, not two');
});

test('keychain: a keychain file other than the login one (a test\'s own) is named on both commands, spaces quoted', async () => {
  const sec = fakeSecurity();
  const file = '/tmp/with space/apaki test.keychain-db';
  const kc = createKeychain({ run: sec.run, file });
  const sealed = await kc.protect(Buffer.from('x'));
  assert.deepEqual(await kc.unprotect(sealed), Buffer.from('x'));
  const add = sec.calls.find((c) => c.args[0] === '-i');
  assert.ok(add.stdin.trimEnd().endsWith(` "${file}"`), add.stdin);
  const find = sec.calls.find((c) => c.args[0] === 'find-generic-password');
  assert.equal(find.args.at(-1), file);
  assert.equal(sec.items.size, 1);
  assert.ok([...sec.items.keys()][0].startsWith(file), 'the item is in that keychain, not the default one');
});

test('keychain: a stored value that is not a key is refused', async () => {
  const sec = fakeSecurity();
  sec.items.set(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`, 'not-a-key');
  await assert.rejects(createKeychain({ run: sec.run }).protect(Buffer.from('x')), /other than Apaki/);
});

test('remote-store: saveSecret seals with the Keychain scheme, loadSecret opens it, a lost key reads as locked, a locked keychain falls back to a file on save', async () => {
  const store = await import('../apaki/engine/remote-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-kc-'));
  const secret = { identity: { kty: 'OKP', d: 'private-part' }, token: 'room-token', psks: { dev1: 'psk-1' }, devices: [], createdAt: '2026-10-12T00:00:00Z', mode: 'connected' };
  const sec = fakeSecurity();
  const before = store.setKeychain(createKeychain({ run: sec.run }));
  try {
    const scheme = await store.saveSecret(secret, dir, { store: 'keychain' });
    assert.equal(scheme, 'keychain-aes');
    const onDisk = fs.readFileSync(path.join(dir, 'secret.json'), 'utf8');
    assert.ok(!onDisk.includes('private-part') && !onDisk.includes('room-token'), 'nothing readable in the file');
    assert.equal(JSON.parse(onDisk).scheme, 'keychain-aes');
    const back = await store.loadSecret(dir);
    assert.equal(back.token, 'room-token');
    assert.equal(back.identity.d, 'private-part');
    assert.equal(back.psks.dev1, 'psk-1');
    assert.equal(back.scheme, 'keychain-aes');

    // The Keychain item is lost: the file cannot be opened. Locked (never "no keys"), so no new keys are made over it.
    sec.items.clear();
    store.setKeychain(createKeychain({ run: sec.run }));
    await assert.rejects(store.loadSecret(dir), (e) => e.name === 'SecretError' && e.code === 'locked');

    // Saving while the keychain is locked keeps the secrets in a user-only file instead (as DPAPI does when PowerShell fails).
    store.setKeychain(createKeychain({ run: fakeSecurity({ locked: true }).run }));
    const written = process.stderr.write;
    process.stderr.write = () => true;
    try { assert.equal(await store.saveSecret(secret, dir, { store: 'keychain', backup: false }), 'file'); } finally { process.stderr.write = written; }
  } finally {
    store.setKeychain(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
