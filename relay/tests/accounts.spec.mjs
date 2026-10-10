/**
 * Account tests (apaki/remote/ACCOUNTS.md): start the Worker locally
 * (wrangler's unstable_dev = workerd, the real wrangler.jsonc with the Account
 * Durable Object migration) and drive every account route over HTTP from Node.
 *
 * A software authenticator below (Node WebCrypto) makes real passkeys: CBOR
 * attestation objects (fmt "none") for navigator.credentials.create and
 * signed assertions for navigator.credentials.get, with ES256 (DER
 * signatures), RS256 and EdDSA keys. Options on it break one thing at a time
 * (origin, challenge, flags, RP id hash, counter, signature) for the refusals.
 *
 * Relays: one with ACCOUNT_KEY (random per run) and ACCOUNT_ORIGIN
 * http://localhost (so the RP id is "localhost"), one without the key, and a
 * short-lived one with the per-IP limit on.
 *
 * Run from relay/: npm test
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unstable_dev } from 'wrangler';

import { createRoom, roomUrl, relaySubprotocols } from '../../apaki/remote/protocol.js';
import { decodeCbor, parseAuthData, derToP1363, b64uEncode, b64uDecode, counterOk, coseToJwk, checkClientData, FLAG } from '../src/webauthn.js';
import {
  cleanName, signToken, readToken, readSessionToken, readChallengeToken, loadKey, checkVault, checkCredential, accountConfig,
  sessionClaims, challengeClaims, LIMITS, RP_NAME,
} from '../src/account-lib.js';
import { costOf } from '../src/lib.js';

process.env.WRANGLER_SEND_METRICS = 'false';
const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, '..');

const ORIGIN = 'http://localhost';
const RP_ID = 'localhost';
const ACCOUNT_KEY = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
const OTHER_KEY = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));

async function startRelay(vars = {}) {
  const worker = await unstable_dev(path.join(relayDir, 'src/index.js'), {
    config: path.join(relayDir, 'wrangler.jsonc'),
    ip: '127.0.0.1',
    local: true,
    persist: false,
    logLevel: 'error',
    // IP_LIMIT off: every test request comes from 127.0.0.1. ALLOWED_ORIGINS empty: Node sockets send no Origin.
    vars: { ALLOWED_ORIGINS: '', IP_LIMIT: 'off', ACCOUNT_KEY, ACCOUNT_ORIGIN: ORIGIN, ...vars },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
  return { worker, base: `ws://127.0.0.1:${worker.port}`, port: worker.port };
}

let relay;
let nokey;
before(async () => {
  // ACCOUNT_KEY '' (not just absent) so a local .dev.vars could never supply one.
  [relay, nokey] = await Promise.all([startRelay(), startRelay({ ACCOUNT_KEY: '' })]);
});
after(async () => {
  await Promise.allSettled([relay?.worker.stop(), nokey?.worker.stop()]);
});

/* ===== helpers ===== */

const te = new TextEncoder();
const subtle = crypto.subtle;
const sha = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));
const cat = (...parts) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of arrs) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

/** A minimal CBOR encoder (what authenticators emit): ints, byte and text strings, arrays, Maps, booleans, null. */
function cbor(v) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
    else out.push((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  };
  const enc = (x) => {
    if (typeof x === 'number') { if (x >= 0) head(0, x); else head(1, -1 - x); } else if (typeof x === 'string') {
      const b = te.encode(x);
      head(3, b.length);
      for (const y of b) out.push(y);
    } else if (x instanceof Uint8Array) {
      head(2, x.length);
      for (const y of x) out.push(y);
    } else if (Array.isArray(x)) { head(4, x.length); x.forEach(enc); } else if (x instanceof Map) {
      head(5, x.size);
      for (const [k, val] of x) { enc(k); enc(val); }
    } else if (x === false) out.push(0xf4);
    else if (x === true) out.push(0xf5);
    else if (x === null) out.push(0xf6);
    else throw new Error(`cbor: cannot encode ${x}`);
  };
  enc(v);
  return new Uint8Array(out);
}

/** WebCrypto gives ECDSA signatures as r || s; authenticators send DER. */
function p1363ToDer(sig) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b[i] & 0x80 ? cat([0], b.subarray(i)) : b.subarray(i);
    return cat([0x02, v.length], v);
  };
  const r = int(sig.subarray(0, 32));
  const s = int(sig.subarray(32));
  return cat([0x30, r.length + s.length], r, s);
}

const ALGS = {
  ES256: { gen: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { gen: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  EdDSA: { gen: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
};

async function coseKeyOf(alg, publicKey) {
  const jwk = await subtle.exportKey('jwk', publicKey);
  if (alg === 'ES256') return new Map([[1, 2], [3, -7], [-1, 1], [-2, b64uDecode(jwk.x)], [-3, b64uDecode(jwk.y)]]);
  if (alg === 'RS256') return new Map([[1, 3], [3, -257], [-1, b64uDecode(jwk.n)], [-2, b64uDecode(jwk.e)]]);
  return new Map([[1, 1], [3, -8], [-1, 6], [-2, b64uDecode(jwk.x)]]);
}

/**
 * One passkey on a software authenticator. attest() is what the page sends
 * after navigator.credentials.create, assert() after navigator.credentials.get.
 * `o` breaks one thing: origin, challenge, type, crossOrigin, rpId, flags,
 * counter, attestedId, userHandle, tamper.
 */
class SoftPasskey {
  static async make(alg = 'ES256', { counter = 0 } = {}) {
    const p = new SoftPasskey();
    p.alg = alg;
    p.keys = await subtle.generateKey(ALGS[alg].gen, true, ['sign', 'verify']);
    p.rawId = crypto.getRandomValues(new Uint8Array(32));
    p.id = b64uEncode(p.rawId);
    p.counter = counter;
    p.counting = counter > 0;
    return p;
  }

  clientData(type, challenge, o) {
    const cd = { type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? ORIGIN, crossOrigin: o.crossOrigin ?? false };
    return te.encode(JSON.stringify(cd));
  }

  async attest(challenge, o = {}) {
    const flags = o.flags ?? (FLAG.UP | FLAG.UV | FLAG.AT);
    const attested = o.attestedId ?? this.rawId;
    const authData = cat(
      await sha(te.encode(o.rpId ?? RP_ID)), [flags], u32(this.counter),
      new Uint8Array(16), [attested.length >> 8, attested.length & 255], attested,
      cbor(await coseKeyOf(this.alg, this.keys.publicKey)),
    );
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      clientDataJSON: b64uEncode(this.clientData('webauthn.create', challenge, o)),
      attestationObject: b64uEncode(attestationObject),
      transports: o.transports ?? ['internal', 'hybrid'],
    };
  }

  async assert(challenge, userHandle, o = {}) {
    if (this.counting) this.counter += 1;
    const authData = cat(await sha(te.encode(o.rpId ?? RP_ID)), [o.flags ?? (FLAG.UP | FLAG.UV)], u32(o.counter ?? this.counter));
    const clientDataJSON = this.clientData('webauthn.get', challenge, o);
    let sig = new Uint8Array(await subtle.sign(ALGS[this.alg].sign, this.keys.privateKey, cat(authData, await sha(clientDataJSON))));
    if (this.alg === 'ES256') sig = p1363ToDer(sig);
    if (o.tamper) sig[sig.length - 1] ^= 1;
    return {
      id: this.id,
      clientDataJSON: b64uEncode(clientDataJSON),
      authenticatorData: b64uEncode(authData),
      signature: b64uEncode(sig),
      userHandle: o.userHandle ?? userHandle,
    };
  }
}

/** One HTTP request to the relay: { status, json, headers }. */
async function api(r, method, urlPath, { body, session, headers = {}, raw } = {}) {
  const h = { ...headers };
  if ((body !== undefined || raw !== undefined) && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
  if (session) h.authorization = `Bearer ${session}`;
  const res = await r.worker.fetch(`http://127.0.0.1${urlPath}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const challengeFor = (r, purpose, session) => api(r, 'POST', '/v1/account/challenge', { body: { purpose }, session });

/** Registers a new account with `passkey`; o breaks the attestation. */
async function registerWith(r, passkey, { name = 'Arthur', o = {} } = {}) {
  const ch = await challengeFor(r, 'register');
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const body = { token: ch.json.token, name, credential: await passkey.attest(ch.json.challenge, o) };
  return { ch: ch.json, body, res: await api(r, 'POST', '/v1/account/register', { body }) };
}

/** A registered account: { id, session, passkey }. */
async function newAccount(r, alg = 'ES256', opts = {}) {
  const passkey = await SoftPasskey.make(alg, opts);
  const { res, ch } = await registerWith(r, passkey);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { id: ch.accountId, session: res.json.session, passkey, account: res.json.account };
}

async function signInWith(r, passkey, accountId, o = {}) {
  const ch = await challengeFor(r, 'signin');
  assert.equal(ch.status, 200);
  const body = { token: ch.json.token, credential: await passkey.assert(ch.json.challenge, accountId, o) };
  return { ch: ch.json, body, res: await api(r, 'POST', '/v1/account/signin', { body }) };
}

async function addWith(r, session, passkey, o = {}) {
  const ch = await challengeFor(r, 'add', session);
  if (ch.status !== 200) return { ch: ch.json, res: ch };
  const body = { token: ch.json.token, credential: await passkey.attest(ch.json.challenge, o) };
  return { ch: ch.json, body, res: await api(r, 'POST', '/v1/account/passkeys', { body, session }) };
}

const randomB64u = (n) => b64uEncode(crypto.getRandomValues(new Uint8Array(n)));
const vaultFor = (...credIds) => ({ iv: randomB64u(12), ct: randomB64u(200), wraps: Object.fromEntries(credIds.map((id) => [id, { iv: randomB64u(12), ct: randomB64u(48) }])) });

function expectError(res, status, code, what = '') {
  assert.equal(res.status, status, `${what} ${JSON.stringify(res.json)}`);
  assert.equal(res.json?.code, code, `${what} ${JSON.stringify(res.json)}`);
  assert.equal(typeof res.json.error, 'string');
  assert.equal(res.headers.get('cache-control'), 'no-store');
}

/* ===== tests ===== */

test('lib: CBOR decoder refusals, DER, authenticator data, counters', async () => {
  const doc = decodeCbor(cbor(new Map([[1, 2], [-3, new Uint8Array([9])], ['t', 'text'], ['a', [true, false, null]]])));
  assert.equal(doc.get(1), 2);
  assert.deepEqual(doc.get(-3), new Uint8Array([9]));
  assert.equal(doc.get('t'), 'text');
  assert.deepEqual(doc.get('a'), [true, false, null]);
  assert.equal(decodeCbor(new Uint8Array([0x38, 0x18])), -25);
  assert.equal(decodeCbor(new Uint8Array([0x39, 0x01, 0x00])), -257);
  assert.equal(decodeCbor(new Uint8Array([0x1b, 0, 0, 0, 1, 0, 0, 0, 0])), 2 ** 32);
  const bad = {
    'indefinite array': [0x9f, 0x01, 0xff],
    'indefinite bytes': [0x5f, 0x41, 0x00, 0xff],
    'trailing bytes': [0x01, 0x02],
    tag: [0xc0, 0x01],
    'half float': [0xf9, 0x00, 0x00],
    'simple value 24': [0xf8, 0x20],
    'duplicate key': [0xa2, 0x01, 0x01, 0x01, 0x02],
    'byte string key': [0xa1, 0x41, 0x00, 0x01],
    truncated: [0x42, 0x01],
    'huge length': [0x5a, 0xff, 0xff, 0xff, 0xff],
    'huge array': [0x9a, 0x00, 0x01, 0x00, 0x00],
    'not UTF-8': [0x61, 0xff],
    reserved: [0x1c],
    'too large int': [0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    'nested too deeply': [0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x01],
    empty: [],
  };
  for (const [what, bytes] of Object.entries(bad)) assert.throws(() => decodeCbor(new Uint8Array(bytes)), /cbor/, what);

  // DER signatures: round trip with high-bit and short integers; strictness.
  for (let i = 0; i < 20; i++) {
    const p = crypto.getRandomValues(new Uint8Array(64));
    if (i === 0) p[0] = 0x80;
    if (i === 1) { p[0] = 0; p[1] = 0; p[32] = 0; }
    assert.deepEqual(derToP1363(p1363ToDer(p)), p);
  }
  const good = p1363ToDer(crypto.getRandomValues(new Uint8Array(64)));
  assert.throws(() => derToP1363(cat(good, [0])), /DER/);
  assert.throws(() => derToP1363(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01])), /negative/);
  assert.throws(() => derToP1363(new Uint8Array([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01])), /minimal/);

  // Authenticator data: every byte accounted for; BS needs BE.
  const base = cat(new Uint8Array(32), [FLAG.UP | FLAG.UV], u32(7));
  assert.equal(parseAuthData(base).signCount, 7);
  assert.throws(() => parseAuthData(cat(base, [0])), /trailing/);
  assert.throws(() => parseAuthData(cat(new Uint8Array(32), [FLAG.UP | FLAG.BS], u32(0))), /inconsistent/);
  assert.throws(() => parseAuthData(new Uint8Array(36)), /short/);

  // clientDataJSON: crossOrigin must be absent or false, topOrigin absent.
  const cd = (o) => te.encode(JSON.stringify({ type: 'webauthn.get', challenge: 'c', origin: ORIGIN, ...o }));
  assert.ok(checkClientData(cd({}), { type: 'webauthn.get', challenge: 'c', origin: ORIGIN }));
  assert.throws(() => checkClientData(cd({ crossOrigin: 'yes' }), { type: 'webauthn.get', challenge: 'c', origin: ORIGIN }), /cross-origin/);
  assert.throws(() => checkClientData(cd({ topOrigin: 'https://x.test' }), { type: 'webauthn.get', challenge: 'c', origin: ORIGIN }), /cross-origin/);

  // COSE keys of all three algorithms import; unknown ones do not.
  for (const alg of ['ES256', 'RS256', 'EdDSA']) {
    const p = await SoftPasskey.make(alg);
    const { jwk } = await coseToJwk(await coseKeyOf(alg, p.keys.publicKey));
    assert.ok(jwk.kty);
  }
  await assert.rejects(coseToJwk(new Map([[1, 2], [3, -35]])), /not supported/);
  await assert.rejects(coseToJwk(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]])), /not usable/, 'a point off the curve');

  assert.equal(counterOk(0, 0), true);
  assert.equal(counterOk(0, 1), true);
  assert.equal(counterOk(5, 6), true);
  assert.equal(counterOk(5, 5), false);
  assert.equal(counterOk(5, 0), false);
  assert.equal(costOf({ accountOps: 1 }) > costOf({ connects: 1 }), true);
});

test('lib: tokens, names, vault and credential shapes, ACCOUNT_ORIGIN', async () => {
  const key = await loadKey({ ACCOUNT_KEY });
  const other = await loadKey({ ACCOUNT_KEY: OTHER_KEY });
  assert.ok(key && other);
  assert.equal(await loadKey({}), null);
  assert.equal(await loadKey({ ACCOUNT_KEY: 'short' }), null);
  assert.equal(await loadKey({ ACCOUNT_KEY: b64uEncode(new Uint8Array(31)) }), null);
  assert.ok(await loadKey({ ACCOUNT_KEY: `${Buffer.from(nodeRandomBytes(32)).toString('base64url')}=` }), 'padding is tolerated');

  const s = await signToken(key, sessionClaims('A'.repeat(21) + 'A', 3));
  assert.deepEqual((await readSessionToken(key, s)).g, 3);
  assert.equal(await readSessionToken(other, s), null, 'another key');
  const [p1, p2] = s.split('.');
  /** The string with the character at i changed (always to a different one). */
  const flip = (str, i) => `${str.slice(0, i)}${str[i] === 'A' ? 'B' : 'A'}${str.slice(i + 1)}`;
  assert.equal(await readToken(key, `${flip(p1, 5)}.${p2}`), null, 'tampered payload');
  assert.equal(await readToken(key, `${p1}.${flip(p2, 10)}`), null, 'tampered MAC');
  assert.equal(await readToken(key, `${p1}.${p2}.x`), null);
  assert.equal(await readToken(key, 'x'.repeat(2000)), null);
  assert.equal(await readSessionToken(key, await signToken(key, { ...sessionClaims('A'.repeat(22), 0), exp: 1 })), null, 'expired');
  const c = await signToken(key, challengeClaims('signin', 'c'.repeat(43)));
  assert.ok(await readChallengeToken(key, c, 'signin'));
  assert.equal(await readChallengeToken(key, c, 'register'), null, 'wrong purpose');
  assert.equal(await readSessionToken(key, c), null, 'a challenge token is not a session');

  assert.equal(cleanName('  Arthur \t  M  '), 'Arthur M');
  assert.equal(cleanName('a'.repeat(48)), 'a'.repeat(48));
  assert.equal(cleanName('a'.repeat(49)), null);
  assert.equal(cleanName('é'.repeat(48)), 'é'.repeat(48), 'characters, not bytes');
  assert.equal(cleanName('\u{1F468}‍\u{1F469}‍\u{1F467} family'), '\u{1F468}‍\u{1F469}‍\u{1F467} family', 'emoji sequences keep their ZWJ');
  for (const bad of ['', '   ', 'x\u0000y', 'x\u0007', '‮evil', 'a​b', '\uD800', 42, null]) assert.equal(cleanName(bad), null, JSON.stringify(bad));

  const id = randomB64u(32);
  assert.ok(checkVault(vaultFor(id)));
  assert.equal(checkVault({ ...vaultFor(id), iv: randomB64u(16) }), null, 'iv must be 12 bytes');
  assert.equal(checkVault({ ...vaultFor(id), ct: randomB64u(8) }), null, 'ct at least a tag');
  assert.equal(checkVault({ ...vaultFor(id), wraps: {} }), null, 'at least one wrap');
  assert.equal(checkVault(vaultFor(...Array.from({ length: 11 }, () => randomB64u(16)))), null, 'at most 10 wraps');
  assert.equal(checkVault(JSON.parse(`{"iv":"${randomB64u(12)}","ct":"${randomB64u(32)}","wraps":{"__proto__":{"iv":"${randomB64u(12)}","ct":"${randomB64u(48)}"}}}`)), null, '__proto__ is not a credential id');
  assert.equal(checkVault({ ...vaultFor(id), iv: `${randomB64u(12)}=` }), null, 'no padding');
  const extra = checkVault({ ...vaultFor(id), note: 'x' });
  assert.deepEqual(Object.keys(extra), ['iv', 'ct', 'wraps'], 'only known fields are kept');

  const p = await SoftPasskey.make();
  const att = await p.attest('c');
  assert.ok(checkCredential(att, 'create'));
  assert.deepEqual(checkCredential({ ...att, transports: ['usb', 'bogus', 'usb'] }, 'create').transports, ['usb']);
  assert.equal(checkCredential({ ...att, attestationObject: undefined }, 'create'), null);
  assert.equal(checkCredential({ ...att, transports: 'usb' }, 'create'), null);
  const asr = await p.assert('c', randomB64u(16));
  assert.ok(checkCredential(asr, 'get'));
  assert.equal(checkCredential({ ...asr, userHandle: randomB64u(15) }, 'get'), null, 'userHandle is the 16-byte account id');

  assert.deepEqual(accountConfig({}), { origin: 'https://apaki.myrlin.io', rpId: 'apaki.myrlin.io', rpName: RP_NAME });
  assert.equal(accountConfig({ ACCOUNT_ORIGIN: ORIGIN }).rpId, 'localhost');
  assert.equal(accountConfig({ ACCOUNT_ORIGIN: 'https://x.test/path' }), null);
  assert.equal(accountConfig({ ACCOUNT_ORIGIN: 'ftp://x.test' }), null);
});

test('register, then sign in, then read the account (ES256)', async () => {
  const passkey = await SoftPasskey.make('ES256');
  const { ch, res } = await registerWith(relay, passkey);
  assert.equal(ch.rpId, RP_ID);
  assert.equal(ch.rpName, RP_NAME);
  assert.match(ch.accountId, /^[A-Za-z0-9_-]{22}$/);
  assert.match(ch.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { session, account } = res.json;
  assert.equal(account.id, ch.accountId);
  assert.equal(account.name, 'Arthur');
  assert.equal(account.ver, 0);
  assert.equal(account.passkeys.length, 1);
  assert.deepEqual({ ...account.passkeys[0], created: 0, lastUsed: 0 }, { id: passkey.id, label: 'Passkey', created: 0, lastUsed: 0, transports: ['internal', 'hybrid'] });
  assert.ok(!Number.isNaN(Date.parse(account.created)));
  const claims = claimsOf(session);
  assert.equal(claims.k, 's');
  assert.equal(claims.a, ch.accountId);
  assert.equal(claims.g, 0);
  assert.ok(Math.abs(claims.exp - (Date.now() / 1000 + 30 * 86400)) < 120, 'sessions last 30 days (exp in unix seconds)');

  const got = await api(relay, 'GET', '/v1/account', { session });
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, { account, vault: null });

  const signed = await signInWith(relay, passkey, ch.accountId);
  assert.equal(signed.res.status, 200, JSON.stringify(signed.res.json));
  assert.equal(signed.res.json.vault, null);
  assert.equal(signed.res.json.account.id, ch.accountId);
  // A session is { k, a, g, exp } and nothing else, so one issued in the same second as another is the same string.
  assert.deepEqual(Object.keys(claimsOf(signed.res.json.session)), ['k', 'a', 'g', 'exp']);
  assert.equal(claimsOf(signed.res.json.session).a, ch.accountId);
  const again = await api(relay, 'GET', '/v1/account', { session: signed.res.json.session });
  assert.equal(again.status, 200);
  assert.equal(again.json.account.name, 'Arthur');
});

test('vault: PUT, GET, 409 stale with the current vault, wraps only for the account\'s passkeys', async () => {
  const { session, passkey, id } = await newAccount(relay);
  const v1 = vaultFor(passkey.id);
  const put1 = await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 0, vault: v1 } });
  assert.equal(put1.status, 200, JSON.stringify(put1.json));
  assert.deepEqual(put1.json, { ver: 1 });
  const got = await api(relay, 'GET', '/v1/account', { session });
  assert.deepEqual(got.json.vault, { ver: 1, ...v1 });
  assert.equal(got.json.account.ver, 1);

  // A phone that read version 0 is behind: it gets the current vault to merge.
  const stale = await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 0, vault: vaultFor(passkey.id) } });
  expectError(stale, 409, 'stale');
  assert.equal(stale.json.ver, 1);
  assert.deepEqual(stale.json.vault, { ver: 1, ...v1 });
  const ahead = await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 5, vault: vaultFor(passkey.id) } });
  expectError(ahead, 409, 'stale');

  const v2 = vaultFor(passkey.id);
  assert.deepEqual((await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 1, vault: v2 } })).json, { ver: 2 });
  const signed = await signInWith(relay, passkey, id);
  assert.deepEqual(signed.res.json.vault, { ver: 2, ...v2 }, 'sign-in answers with the vault');

  expectError(await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 2, vault: vaultFor(randomB64u(32)) } }), 400, 'bad-vault');
  expectError(await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 2, vault: { ...v2, iv: randomB64u(16) } } }), 400, 'bad-vault');
  expectError(await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: -1, vault: v2 } }), 400, 'bad-vault');
  expectError(await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 2, vault: { ...v2, ct: randomB64u(64 * 1024) } } }), 413, 'too-large');
  // Just under the cap is fine.
  const big = { ...vaultFor(passkey.id), ct: randomB64u(47 * 1024) };
  assert.deepEqual((await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 2, vault: big } })).json, { ver: 3 });
  assert.equal((await api(relay, 'GET', '/v1/account', { session })).json.vault.ct, big.ct);
});

test('more passkeys: an RS256 and an EdDSA passkey are added and sign in; exclusions, duplicates, wrong tokens', async () => {
  const { session, passkey: first, id } = await newAccount(relay, 'ES256');
  const rsa = await SoftPasskey.make('RS256');
  const added = await addWith(relay, session, rsa, { transports: ['usb'] });
  assert.deepEqual(added.ch.exclude, [first.id]);
  assert.equal(added.ch.accountId, id);
  assert.equal(added.res.status, 200, JSON.stringify(added.res.json));
  assert.deepEqual(added.res.json.account.passkeys.map((p) => p.id), [first.id, rsa.id]);
  assert.equal(added.res.json.account.passkeys[1].label, 'Security key');

  const rsaIn = await signInWith(relay, rsa, id);
  assert.equal(rsaIn.res.status, 200, JSON.stringify(rsaIn.res.json));

  const ed = await SoftPasskey.make('EdDSA');
  const edAdded = await addWith(relay, rsaIn.res.json.session, ed);
  assert.equal(edAdded.res.status, 200, JSON.stringify(edAdded.res.json));
  assert.deepEqual(edAdded.ch.exclude, [first.id, rsa.id]);
  const edIn = await signInWith(relay, ed, id);
  assert.equal(edIn.res.status, 200, JSON.stringify(edIn.res.json));

  // The same passkey twice.
  expectError((await addWith(relay, session, rsa)).res, 409, 'exists');
  // Adding needs a session, and the add token must be for this account and this purpose.
  expectError(await challengeFor(relay, 'add'), 401, 'bad-session');
  const other = await newAccount(relay);
  const otherCh = await challengeFor(relay, 'add', other.session);
  const stray = await SoftPasskey.make();
  const body = { token: otherCh.json.token, credential: await stray.attest(otherCh.json.challenge) };
  expectError(await api(relay, 'POST', '/v1/account/passkeys', { session, body }), 401, 'bad-token', 'another account\'s add token');
  const reg = await challengeFor(relay, 'register');
  expectError(await api(relay, 'POST', '/v1/account/passkeys', { session, body: { token: reg.json.token, credential: await stray.attest(reg.json.challenge) } }), 401, 'bad-token', 'a register token');
});

test('removing a passkey: its wrap leaves the vault (new version), it can no longer sign in, the last one stays', async () => {
  const { session, passkey: first, id } = await newAccount(relay);
  const second = await SoftPasskey.make();
  assert.equal((await addWith(relay, session, second)).res.status, 200);
  assert.deepEqual((await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 0, vault: vaultFor(first.id, second.id) } })).json, { ver: 1 });

  const removed = await api(relay, 'DELETE', `/v1/account/passkeys/${second.id}`, { session });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.deepEqual(removed.json.account.passkeys.map((p) => p.id), [first.id]);
  assert.equal(removed.json.account.ver, 2);
  const got = await api(relay, 'GET', '/v1/account', { session });
  assert.deepEqual(Object.keys(got.json.vault.wraps), [first.id]);
  assert.equal(got.json.vault.ver, 2);

  expectError((await signInWith(relay, second, id)).res, 401, 'unknown-credential');
  expectError(await api(relay, 'DELETE', `/v1/account/passkeys/${first.id}`, { session }), 409, 'last-passkey');
  expectError(await api(relay, 'DELETE', `/v1/account/passkeys/${randomB64u(32)}`, { session }), 404, 'unknown-credential');
  expectError(await api(relay, 'DELETE', '/v1/account/passkeys/abcde', { session }), 400, 'bad-credential');
  assert.equal((await signInWith(relay, first, id)).res.status, 200);
});

test('rename', async () => {
  const { session } = await newAccount(relay);
  const r = await api(relay, 'POST', '/v1/account/rename', { session, body: { name: '  Work   phone\tuser ' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.account.name, 'Work phone user');
  assert.equal((await api(relay, 'GET', '/v1/account', { session })).json.account.name, 'Work phone user');
  for (const name of ['', ' ', 'n'.repeat(49), 'a\u0001b', 7]) expectError(await api(relay, 'POST', '/v1/account/rename', { session, body: { name } }), 400, 'bad-name', JSON.stringify(name));
  expectError(await api(relay, 'POST', '/v1/account/rename', { body: { name: 'x' } }), 401, 'bad-session');
});

test('signout-all ends every session of the account, and only that account', async () => {
  const { session: s1, passkey, id } = await newAccount(relay);
  const s2 = (await signInWith(relay, passkey, id)).res.json.session;
  const bystander = await newAccount(relay);
  assert.deepEqual((await api(relay, 'POST', '/v1/account/signout-all', { session: s1 })).json, { ok: true });
  expectError(await api(relay, 'GET', '/v1/account', { session: s1 }), 401, 'signed-out');
  expectError(await api(relay, 'GET', '/v1/account', { session: s2 }), 401, 'signed-out');
  expectError(await api(relay, 'POST', '/v1/account/signout-all', { session: s2 }), 401, 'signed-out');
  assert.equal((await api(relay, 'GET', '/v1/account', { session: bystander.session })).status, 200);
  const fresh = await signInWith(relay, passkey, id);
  assert.equal(fresh.res.status, 200);
  assert.equal(claimsOf(fresh.res.json.session).g, 1);
  assert.equal((await api(relay, 'GET', '/v1/account', { session: fresh.res.json.session })).status, 200);
});

test('deleting the account: everything goes, and a recorded registration cannot bring it back', async () => {
  const passkey = await SoftPasskey.make();
  const { body, res, ch } = await registerWith(relay, passkey);
  const { session } = res.json;
  assert.equal((await api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 0, vault: vaultFor(passkey.id) } })).status, 200);
  assert.deepEqual((await api(relay, 'DELETE', '/v1/account', { session })).json, { ok: true });
  expectError(await api(relay, 'GET', '/v1/account', { session }), 401, 'no-account');
  expectError(await api(relay, 'DELETE', '/v1/account', { session }), 401, 'no-account');
  expectError((await signInWith(relay, passkey, ch.accountId)).res, 404, 'no-account');
  expectError(await api(relay, 'POST', '/v1/account/register', { body }), 401, 'challenge-used', 'the same registration again');
});

test('WebAuthn refusals on registration; a refused attempt does not spend the challenge', async () => {
  const cases = {
    'wrong origin': { origin: 'https://evil.test' },
    'wrong challenge': { challenge: randomB64u(32) },
    'wrong type': { type: 'webauthn.get' },
    'cross-origin': { crossOrigin: true },
    'wrong RP id hash': { rpId: 'evil.test' },
    'no user verification': { flags: FLAG.UP | FLAG.AT },
    'no user presence': { flags: FLAG.UV | FLAG.AT },
    'no attested data': { flags: FLAG.UP | FLAG.UV },
    'attested id differs': { attestedId: crypto.getRandomValues(new Uint8Array(32)) },
  };
  for (const [what, o] of Object.entries(cases)) {
    const passkey = await SoftPasskey.make();
    const { res, body, ch } = await registerWith(relay, passkey, { o });
    expectError(res, 401, 'webauthn', what);
    if (what === 'wrong origin') {
      // The same token with a good credential still works: only a success spends a challenge.
      const fixed = await api(relay, 'POST', '/v1/account/register', { body: { ...body, credential: await passkey.attest(ch.challenge) } });
      assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
      expectError(await api(relay, 'POST', '/v1/account/register', { body: { ...body, credential: await passkey.attest(ch.challenge) } }), 409, 'exists');
    }
  }
});

test('WebAuthn refusals on sign-in: origin, challenge, UV, RP id, signature, counter, replay', async () => {
  const { passkey, id } = await newAccount(relay);
  const cases = {
    'wrong origin': { origin: 'https://evil.test' },
    'wrong challenge': { challenge: randomB64u(32) },
    'wrong type': { type: 'webauthn.create' },
    'no user verification': { flags: FLAG.UP },
    'wrong RP id hash': { rpId: 'evil.test' },
    'bad signature': { tamper: true },
    'attested data in an assertion': { flags: FLAG.UP | FLAG.UV | FLAG.AT },
  };
  for (const [what, o] of Object.entries(cases)) expectError((await signInWith(relay, passkey, id, o)).res, 401, 'webauthn', what);

  // Replay: the same signed answer twice.
  const once = await signInWith(relay, passkey, id);
  assert.equal(once.res.status, 200);
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: once.body }), 401, 'challenge-used', 'replayed');

  // A passkey the account does not have, and an account that does not exist.
  const stranger = await SoftPasskey.make();
  expectError((await signInWith(relay, stranger, id)).res, 401, 'unknown-credential');
  expectError((await signInWith(relay, passkey, randomB64u(16))).res, 404, 'no-account');
  expectError((await signInWith(relay, passkey, id, { userHandle: randomB64u(15) })).res, 400, 'bad-credential');

  // Counters: a counting authenticator must keep counting up.
  const counting = await newAccount(relay, 'ES256', { counter: 5 });
  assert.equal((await signInWith(relay, counting.passkey, counting.id)).res.status, 200, 'counter 6');
  expectError((await signInWith(relay, counting.passkey, counting.id, { counter: 3 })).res, 401, 'webauthn', 'counter went backwards');
  expectError((await signInWith(relay, counting.passkey, counting.id, { counter: 6 })).res, 401, 'webauthn', 'counter repeated');
  expectError((await signInWith(relay, counting.passkey, counting.id, { counter: 0 })).res, 401, 'webauthn', 'counter reset to 0');
  assert.equal((await signInWith(relay, counting.passkey, counting.id, { counter: 100 })).res.status, 200, 'a jump forward is fine');
});

test('tokens: tampered, forged, expired, wrong purpose, wrong generation', async () => {
  const { session, passkey, id } = await newAccount(relay);
  const key = await loadKey({ ACCOUNT_KEY });
  const forgedKey = await loadKey({ ACCOUNT_KEY: OTHER_KEY });

  // Challenge tokens.
  const ch = await challengeFor(relay, 'signin');
  const credential = await passkey.assert(ch.json.challenge, id);
  const [p1, p2] = ch.json.token.split('.');
  const tampered = `${b64uEncode(te.encode(JSON.stringify({ ...claimsOf(ch.json.token), exp: claimsOf(ch.json.token).exp + 3600 })))}.${p2}`;
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: { token: tampered, credential } }), 401, 'bad-token', 'tampered');
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: { token: await signToken(forgedKey, claimsOf(ch.json.token)), credential } }), 401, 'bad-token', 'forged');
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: { token: await signToken(key, { ...claimsOf(ch.json.token), exp: Math.floor(Date.now() / 1000) - 1 }), credential } }), 401, 'bad-token', 'expired');
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: { token: `${p1}.${p2}x`, credential } }), 401, 'bad-token', 'malformed');
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: { credential } }), 401, 'bad-token', 'missing');
  const reg = await challengeFor(relay, 'register');
  expectError(await api(relay, 'POST', '/v1/account/signin', { body: { token: reg.json.token, credential: await passkey.assert(reg.json.challenge, id) } }), 401, 'bad-token', 'a register token');
  // The untouched token still works.
  assert.equal((await api(relay, 'POST', '/v1/account/signin', { body: { token: ch.json.token, credential } })).status, 200);

  // Sessions.
  const [s1, s2] = session.split('.');
  const bumped = `${b64uEncode(te.encode(JSON.stringify({ ...claimsOf(session), g: 7 })))}.${s2}`;
  expectError(await api(relay, 'GET', '/v1/account', { session: bumped }), 401, 'bad-session', 'tampered');
  expectError(await api(relay, 'GET', '/v1/account', { session: `${s1}.${s2.slice(0, 10)}${s2[10] === 'A' ? 'B' : 'A'}${s2.slice(11)}` }), 401, 'bad-session', 'tampered MAC');
  expectError(await api(relay, 'GET', '/v1/account', { session: await signToken(forgedKey, claimsOf(session)) }), 401, 'bad-session', 'forged');
  expectError(await api(relay, 'GET', '/v1/account', { session: await signToken(key, { ...claimsOf(session), exp: Math.floor(Date.now() / 1000) - 1 }) }), 401, 'bad-session', 'expired');
  expectError(await api(relay, 'GET', '/v1/account', { session: ch.json.token }), 401, 'bad-session', 'a challenge token');
  expectError(await api(relay, 'GET', '/v1/account', {}), 401, 'bad-session', 'none');
  expectError(await api(relay, 'GET', '/v1/account', { session: await signToken(key, { ...claimsOf(session), g: 1 }) }), 401, 'signed-out', 'a generation the account is not at');
  const res = await api(relay, 'GET', '/v1/account', {});
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
});

test('without ACCOUNT_KEY every account route answers 503 no-key', async () => {
  expectError(await challengeFor(nokey, 'register'), 503, 'no-key');
  expectError(await api(nokey, 'GET', '/v1/account', { session: 'x.y' }), 503, 'no-key');
  expectError(await api(nokey, 'POST', '/v1/account/signin', { body: {} }), 503, 'no-key');
  // Presence does not need the key.
  const { roomId } = await createRoom();
  const p = await api(nokey, 'GET', `/v1/rooms/${roomId}/presence`);
  assert.equal(p.status, 200);
  assert.deepEqual(p.json, { pc: false });
});

test('Origin header: a foreign one is refused, the account origin is accepted', async () => {
  expectError(await api(relay, 'POST', '/v1/account/challenge', { body: { purpose: 'signin' }, headers: { Origin: 'https://evil.test' } }), 403, 'origin');
  expectError(await api(relay, 'POST', '/v1/account/challenge', { body: { purpose: 'signin' }, headers: { Origin: 'null' } }), 403, 'origin');
  expectError(await api(relay, 'POST', '/v1/account/challenge', { body: { purpose: 'signin' }, headers: { Origin: `${ORIGIN}:8080` } }), 403, 'origin');
  assert.equal((await api(relay, 'POST', '/v1/account/challenge', { body: { purpose: 'signin' }, headers: { Origin: ORIGIN } })).status, 200);
  const { roomId } = await createRoom();
  expectError(await api(relay, 'GET', `/v1/rooms/${roomId}/presence`, { headers: { Origin: 'https://evil.test' } }), 403, 'origin');
  assert.equal((await api(relay, 'GET', `/v1/rooms/${roomId}/presence`, { headers: { Origin: ORIGIN } })).status, 200);
});

test('hardening: JSON only, body caps, unknown routes and methods, at most 10 passkeys', async () => {
  expectError(await api(relay, 'POST', '/v1/account/challenge', { raw: '{"purpose":"signin"}', headers: { 'content-type': 'text/plain' } }), 415, 'content-type');
  expectError(await api(relay, 'POST', '/v1/account/challenge', { raw: '{"purpose":' }), 400, 'bad-json');
  expectError(await api(relay, 'POST', '/v1/account/challenge', { raw: '["signin"]' }), 400, 'bad-json');
  expectError(await api(relay, 'POST', '/v1/account/challenge', { raw: '' }), 400, 'bad-json');
  expectError(await api(relay, 'POST', '/v1/account/challenge', { body: { purpose: 'bogus' } }), 400, 'bad-purpose');
  expectError(await api(relay, 'POST', '/v1/account/register', { body: { pad: 'x'.repeat(LIMITS.BODY_MAX) } }), 413, 'too-large');
  // Streamed without a content-length: the cap still holds.
  const chunks = [te.encode('{"pad":"'), te.encode('x'.repeat(LIMITS.BODY_MAX)), te.encode('"}')];
  const stream = new ReadableStream({ pull(c) { const n = chunks.shift(); if (n) c.enqueue(n); else c.close(); } });
  const streamed = await relay.worker.fetch('http://127.0.0.1/v1/account/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal(streamed.status, 413);
  await streamed.text();

  const nf = await api(relay, 'GET', '/v1/account/nope');
  expectError(nf, 404, 'not-found');
  const m = await api(relay, 'GET', '/v1/account/challenge');
  expectError(m, 405, 'method');
  assert.equal(m.headers.get('allow'), 'POST');
  expectError(await api(relay, 'PUT', '/v1/account'), 405, 'method');

  const register = await challengeFor(relay, 'register');
  const pk = await SoftPasskey.make();
  const att = await pk.attest(register.json.challenge);
  expectError(await api(relay, 'POST', '/v1/account/register', { body: { token: register.json.token, name: 'x', credential: { ...att, attestationObject: 'not base64url!' } } }), 400, 'bad-credential');
  expectError(await api(relay, 'POST', '/v1/account/register', { body: { token: register.json.token, name: '‮', credential: att } }), 400, 'bad-name');
  expectError(await api(relay, 'POST', '/v1/account/register', { body: { token: register.json.token, credential: att } }), 400, 'bad-name');

  // Ten passkeys at most: the add challenge itself says so (before a passkey is made on the device).
  const { session } = await newAccount(relay);
  for (let i = 0; i < 9; i++) assert.equal((await addWith(relay, session, await SoftPasskey.make())).res.status, 200, `passkey ${i + 2}`);
  assert.equal((await api(relay, 'GET', '/v1/account', { session })).json.account.passkeys.length, 10);
  expectError(await challengeFor(relay, 'add', session), 409, 'too-many');
});

test('one at a time: the same sign-in raced four times succeeds once; three PUTs on one version, one wins', async () => {
  const { passkey, id, session } = await newAccount(relay);
  const ch = await challengeFor(relay, 'signin');
  const body = { token: ch.json.token, credential: await passkey.assert(ch.json.challenge, id) };
  const raced = await Promise.all(Array.from({ length: 4 }, () => api(relay, 'POST', '/v1/account/signin', { body })));
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 401, 401, 401]);
  assert.ok(raced.filter((r) => r.status === 401).every((r) => r.json.code === 'challenge-used'));
  const puts = await Promise.all(Array.from({ length: 3 }, () => api(relay, 'PUT', '/v1/account/vault', { session, body: { ver: 0, vault: vaultFor(passkey.id) } })));
  assert.deepEqual(puts.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await api(relay, 'GET', '/v1/account', { session })).json.vault.ver, 1);
});

test('budget: account requests and presence count toward the daily budget and are refused past it', async () => {
  // One account request is about $0.0000026 (lib.js costOf accountOps): the first fits, the second crosses $0.000005.
  const broke = await startRelay({ DAILY_BUDGET_USD: '0.000005' });
  try {
    assert.equal((await challengeFor(broke, 'signin')).status, 200);
    const over = await challengeFor(broke, 'signin');
    expectError(over, 503, 'budget', 'second challenge');
    assert.equal(over.headers.get('retry-after'), '1800');
    const { roomId } = await createRoom();
    expectError(await api(broke, 'GET', `/v1/rooms/${roomId}/presence`), 503, 'budget');
  } finally { await broke.worker.stop(); }
});

/** A PC socket on a room (sends ping right after open, like the real PC); resolves once the relay says ready. */
function pcSocket(r, room) {
  const ws = new WebSocket(roomUrl(r.base, room.roomId, 'pc'), relaySubprotocols('pc', room.token));
  ws.binaryType = 'arraybuffer';
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => ws.send('ping'), { once: true });
    ws.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.includes('"ready"')) resolve(); });
    ws.addEventListener('error', () => reject(new Error('the PC socket failed')), { once: true });
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
  return { ws, ready, closed };
}

test('presence: false, then true while the PC socket is connected, then false again', async () => {
  const room = await createRoom();
  const url = `/v1/rooms/${room.roomId}/presence`;
  const first = await api(relay, 'GET', url);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { pc: false });
  assert.equal(first.headers.get('cache-control'), 'no-store');

  const pc = pcSocket(relay, room);
  await pc.ready;
  assert.deepEqual((await api(relay, 'GET', url)).json, { pc: true });
  // Asking does not disturb the socket.
  assert.deepEqual((await api(relay, 'GET', url)).json, { pc: true });
  assert.equal(pc.ws.readyState, WebSocket.OPEN);

  pc.ws.close();
  await pc.closed;
  let now = (await api(relay, 'GET', url)).json;
  for (let i = 0; i < 50 && now.pc; i++) {
    await new Promise((r) => setTimeout(r, 100));
    now = (await api(relay, 'GET', url)).json;
  }
  assert.deepEqual(now, { pc: false });

  expectError(await api(relay, 'POST', url, { body: {} }), 405, 'method');
  assert.equal((await api(relay, 'GET', '/v1/rooms/short/presence')).status, 404);
});

/** The HTTP status of a raw WebSocket upgrade request (101 when it upgrades). */
function upgradeStatus(r, urlPath, protocols) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': nodeRandomBytes(16).toString('base64') };
    if (protocols) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    const req = http.request({ host: '127.0.0.1', port: r.port, path: urlPath, headers });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

test('ip limit: account requests have their own per-IP budget, apart from sockets and presence', async () => {
  const limited = await startRelay({ IP_LIMIT: 'on' });
  try {
    const statuses = [];
    for (let i = 0; i < 24; i++) statuses.push((await challengeFor(limited, 'signin')).status);
    assert.ok(statuses.slice(0, 20).every((s) => s === 200 || s === 429), String(statuses));
    assert.ok(statuses.includes(429), `no 429 in ${statuses}`);
    const limitedAnswer = await challengeFor(limited, 'signin');
    expectError(limitedAnswer, 429, 'rate');
    assert.equal(limitedAnswer.headers.get('retry-after'), '60');
    // Sockets and presence from the same address are counted separately.
    const { roomId } = await createRoom();
    assert.equal(await upgradeStatus(limited, `/v1/rooms/${roomId}/phone`, ['apaki.v1']), 101);
    assert.equal((await api(limited, 'GET', `/v1/rooms/${roomId}/presence`)).status, 200);
  } finally { await limited.worker.stop(); }
});
