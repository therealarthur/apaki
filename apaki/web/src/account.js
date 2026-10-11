/**
 * account.js: the Apaki account on the phone (2026-10-10).
 *
 * Arthur: "if a user has a login with us they can login to their account to
 * see connections and just connect that way". A passkey (Face ID, a
 * fingerprint) signs in on apaki.myrlin.io; the account's vault holds the
 * user's PCs and the account's device key, encrypted with a key that only
 * the passkey can produce (WebAuthn PRF). The server keeps public keys and
 * ciphertext; it can never open the vault or connect to a PC. Contract and
 * key schedule: apaki/remote/ACCOUNTS.md.
 *
 * What a phone keeps after signing in (store.js 'me'): the session, the
 * vault key as a non-extractable CryptoKey, the vault version, and the
 * account device as non-extractable keys. It then connects to the account's
 * PCs with no server in the loop (the relay only forwards sealed frames) and
 * updates the vault without another passkey prompt.
 *
 *   support()                  can this browser hold an account (passkeys with PRF)?
 *   create(name)               a new account with a new passkey
 *   signIn()                   a passkey this person already has
 *   refresh()                  fetch the vault, take in PCs other phones added
 *   link(link, { onPending, enroll })  save the PC behind an open Link to the account (the PC asks its person first;
 *                              enroll: right after a scan, with this phone's key as the proof, no asking)
 *   unlink(roomId, link?)      take a PC out of the account (and off the PC when connected)
 *   addPasskey(), removePasskey(id), rename(name), signOut(), signOutEverywhere(), remove()
 *   presence(pc)               is that PC connected to the relay right now?
 */

import { b64urlDecode, b64urlEncode, concat, createDeviceIdentity, deviceIdFor, exportIdentity, randomBytes } from './protocol.js';
import * as store from './store.js';
import { signEnroll } from './phonekey.js';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const API = '/v1/account';
const CREATE_TIMEOUT_MS = 120_000;
// In the iOS app (apaki/mobile) the Keychain keeps the account, so its keys must be exportable there; the
// app's page is its own bundled copy, which no server can change. In a browser they stay non-extractable.
const KEEP_KEYS = Boolean(globalThis.apakiApp?.keysInKeychain);
// The site whose API this page uses: its own origin on the web, apaki.myrlin.io in the app.
const SITE_HOST = globalThis.apakiApp?.siteHost || location.host;

/** An account step that did not work: code is the server's, or a WebAuthn one (cancelled, no-prf, ...). */
export class AccountError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ---------- small crypto ---------- */

const sha256 = async (...parts) => new Uint8Array(await subtle.digest('SHA-256', concat(...parts.map((p) => (typeof p === 'string' ? utf8.encode(p) : p)))));

async function hkdf(ikm, salt, info, len = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, key, len * 8));
}

const aesKey = (raw, usages = ['encrypt', 'decrypt']) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, KEEP_KEYS, usages);

async function seal(key, aad, bytes) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, bytes));
  return { iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
}

async function unseal(key, aad, box, what) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(box.iv), additionalData: aad }, key, b64urlDecode(box.ct)));
  } catch {
    throw new AccountError('bad-vault', `This passkey could not open ${what}.`);
  }
}

const wrapAad = (credId) => concat(utf8.encode('apaki/v1 vault wrap'), b64urlDecode(credId));
const vaultAad = (accountId) => concat(utf8.encode('apaki/v1 vault'), b64urlDecode(accountId));

let saltP = null;
/** The PRF input every create and get evaluates: SHA-256("apaki/v1 vault prf"). */
const prfSalt = () => (saltP ||= sha256('apaki/v1 vault prf'));

/** The key that wraps the vault key for one passkey, from that passkey's PRF output. */
async function kekFor(prf, accountId) {
  return aesKey(await hkdf(prf, b64urlDecode(accountId), 'apaki/v1 vault kek'));
}

/** The account device as non-extractable keys (what this phone keeps), from the vault's exported identity. */
async function importDevice(saved) {
  const { kty, crv, x, y, d } = saved.jwk;
  const privateKey = await subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, KEEP_KEYS, ['sign']);
  return { privateKey, pub: b64urlDecode(saved.pub) };
}

/* ---------- the server ---------- */

async function api(method, path, body = null, session = null) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new AccountError('offline', 'No connection to apaki.myrlin.io. Check the network and try again.');
  }
  let j = null;
  try { j = await res.json(); } catch { j = null; }
  if (!res.ok) throw new AccountError(j?.code || `http-${res.status}`, j?.error || `apaki.myrlin.io answered ${res.status}.`, { status: res.status, body: j });
  return j || {};
}

/** When a session token stops working (its own exp; the server may end it sooner). */
function sessionExp(session) {
  try { return Number(JSON.parse(new TextDecoder().decode(b64urlDecode(session.split('.')[0]))).exp) || 0; } catch { return 0; }
}

/* ---------- WebAuthn ---------- */

const b64 = (buf) => b64urlEncode(new Uint8Array(buf));
const prfOf = (cred) => {
  const r = cred?.getClientExtensionResults?.()?.prf?.results?.first;
  return r ? new Uint8Array(r) : null;
};

function webauthnError(e, step) {
  if (e instanceof AccountError) return e;
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return new AccountError('cancelled', `${step} was cancelled.`);
  if (e?.name === 'InvalidStateError') return new AccountError('exists', 'This device already has a passkey for that account.');
  if (e?.name === 'SecurityError') return new AccountError('security', 'Passkeys only work on apaki.myrlin.io itself.');
  return new AccountError('webauthn', `${step} did not work: ${e?.message || e}`);
}

/** The PRF output of a passkey this person picks (or one of `ids`), with a local challenge: nothing goes to the server. */
async function prfFromGet(ids, rpId) {
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId,
        userVerification: 'required',
        timeout: CREATE_TIMEOUT_MS,
        allowCredentials: ids.map((id) => ({ type: 'public-key', id: b64urlDecode(id) })),
        extensions: { prf: { eval: { first: await prfSalt() } } },
      },
    });
  } catch (e) { throw webauthnError(e, 'Unlocking'); }
  const prf = prfOf(cred);
  if (!prf) throw noPrf();
  return { prf, id: cred.id };
}

const noPrf = () => new AccountError('no-prf', 'This passkey cannot unlock Apaki connections in this browser. iOS 18 or later, Android with Chrome, and current desktop browsers can. You can still pair this phone with the code on your PC.');

/** True when this browser can hold an account; { ok, why } with why 'no-webauthn' or 'no-prf'. */
export async function support() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return { ok: false, why: 'no-webauthn' };
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && caps['extension:prf'] === false) return { ok: false, why: 'no-prf' };
  } catch { /* older browsers: try it */ }
  return { ok: true };
}

/* ---------- the vault ---------- */

/** The vault's contents, opened with this phone's vault key. */
async function openVault(acct, vault) {
  if (!vault) return { v: 1, name: acct.name, device: null, pcs: [] };
  return JSON.parse(new TextDecoder().decode(await unseal(acct.vaultKey, vaultAad(acct.accountId), vault, 'your connections')));
}

/**
 * Changes the vault: fetch it, open it, let `change(json, vault)` edit the
 * contents (and the wraps), seal it, put it back. Another phone writing at
 * the same time makes the server answer stale; then it runs again.
 */
async function updateVault(acct, change) {
  for (let i = 0; i < 4; i++) {
    const { account, vault } = await api('GET', API, null, acct.session);
    const json = await openVault(acct, vault);
    const wraps = { ...(vault?.wraps || {}) };
    await change(json, wraps);
    const sealed = await seal(acct.vaultKey, vaultAad(acct.accountId), utf8.encode(JSON.stringify(json)));
    try {
      const r = await api('PUT', `${API}/vault`, { ver: vault?.ver ?? 0, vault: { ...sealed, wraps } }, acct.session);
      const next = { ...acct, ver: r.ver, name: account?.name || acct.name };
      await store.saveAccount(next);
      await mergePcs(next, json);
      return { acct: next, json };
    } catch (e) {
      if (e.code !== 'stale') throw e;
    }
  }
  throw new AccountError('stale', 'Another phone kept changing the account. Try again.');
}

/**
 * Puts the vault's PCs in this phone's list. A PC this phone paired itself
 * keeps its own pairing; PCs that left the vault leave the list.
 */
async function mergePcs(acct, json) {
  // Which rooms the vault holds, so the PC screen knows what is saved without opening it again.
  const rooms = (json.pcs || []).map((p) => p.roomId);
  if (String(rooms) !== String(acct.rooms || [])) await store.saveAccount({ ...acct, rooms });
  acct.rooms = rooms;
  if (!acct.device) return;
  const mine = await store.listPcs();
  const byRoom = new Map(mine.map((p) => [p.roomId, p]));
  const inVault = new Set();
  for (const p of json.pcs || []) {
    inVault.add(p.roomId);
    const have = byRoom.get(p.roomId);
    if (have && have.via !== 'account') continue;
    const pairing = { v: 1, roomId: p.roomId, relay: p.relay, pcPub: p.pcPub, pcName: p.pcName || 'PC', deviceId: p.deviceId, psk: p.psk, pairedAt: p.addedAt };
    await store.savePc({ roomId: p.roomId, pcName: p.pcName || 'PC', relay: p.relay, pairing, device: acct.device, pairedAt: p.addedAt, lastUsed: have?.lastUsed || p.addedAt, via: 'account' });
  }
  for (const p of mine) if (p.via === 'account' && !inVault.has(p.roomId)) await store.forgetPc(p.roomId);
}

/* ---------- create, sign in ---------- */

/**
 * A new account with a new passkey. The passkey must have PRF (it makes the
 * key that locks the vault); without it nothing is registered.
 */
export async function create(name) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!name) throw new AccountError('bad-name', 'Give the account a name.');
  const sup = await support();
  if (!sup.ok) throw sup.why === 'no-prf' ? noPrf() : new AccountError('no-webauthn', 'This browser has no passkeys.');
  const ch = await api('POST', `${API}/challenge`, { purpose: 'register' });
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: ch.rpId, name: ch.rpName || 'Myrlin Apaki' },
        user: { id: b64urlDecode(ch.accountId), name, displayName: name },
        challenge: b64urlDecode(ch.challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none',
        timeout: CREATE_TIMEOUT_MS,
        extensions: { prf: { eval: { first: await prfSalt() } } },
      },
    });
  } catch (e) { throw webauthnError(e, 'Making the passkey'); }
  const ext = cred.getClientExtensionResults?.() || {};
  if (!ext.prf) throw noPrf();
  const reg = await api('POST', `${API}/register`, {
    token: ch.token,
    name,
    credential: { id: cred.id, clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject), transports: cred.response.getTransports?.() || [] },
  });
  // Some browsers give the PRF output only on a get: ask the new passkey once more (locally).
  const prf = prfOf(cred) || (await prfFromGet([cred.id], ch.rpId)).prf;

  const vk = randomBytes(32);
  const identity = await createDeviceIdentity({ extractable: true });
  const saved = await exportIdentity(identity);
  const acct = {
    accountId: ch.accountId, name: reg.account?.name || name, session: reg.session, sessionExp: sessionExp(reg.session), ver: 0,
    vaultKey: await aesKey(vk), device: await importDevice(saved), devicePub: saved.pub, rpId: ch.rpId,
  };
  const json = { v: 1, name: acct.name, device: saved, pcs: [] };
  const sealed = await seal(acct.vaultKey, vaultAad(acct.accountId), utf8.encode(JSON.stringify(json)));
  const wraps = { [cred.id]: await seal(await kekFor(prf, acct.accountId), wrapAad(cred.id), vk) };
  vk.fill(0);
  const put = await api('PUT', `${API}/vault`, { ver: 0, vault: { ...sealed, wraps } }, acct.session);
  acct.ver = put.ver;
  await store.saveAccount(acct);
  return { account: reg.account, acct };
}

/** Signs in with a passkey this person already has (any synced device), opens the vault, lists its PCs here. */
export async function signIn() {
  const sup = await support();
  if (!sup.ok && sup.why === 'no-webauthn') throw new AccountError('no-webauthn', 'This browser has no passkeys.');
  const ch = await api('POST', `${API}/challenge`, { purpose: 'signin' });
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlDecode(ch.challenge),
        rpId: ch.rpId,
        userVerification: 'required',
        timeout: CREATE_TIMEOUT_MS,
        extensions: { prf: { eval: { first: await prfSalt() } } },
      },
    });
  } catch (e) { throw webauthnError(e, 'Signing in'); }
  const r = await api('POST', `${API}/signin`, {
    token: ch.token,
    credential: {
      id: cred.id,
      clientDataJSON: b64(cred.response.clientDataJSON),
      authenticatorData: b64(cred.response.authenticatorData),
      signature: b64(cred.response.signature),
      userHandle: cred.response.userHandle ? b64(cred.response.userHandle) : '',
    },
  });
  const prf = prfOf(cred);
  if (!prf) throw noPrf();
  const accountId = r.account.id;
  const wrap = r.vault?.wraps?.[cred.id];
  if (!wrap) throw new AccountError('no-wrap', 'This passkey was added to the account but never set up to unlock it. Sign in with another of its passkeys and add this one again.');
  const vk = await unseal(await kekFor(prf, accountId), wrapAad(cred.id), wrap, 'the account');
  const acct = { accountId, name: r.account.name, session: r.session, sessionExp: sessionExp(r.session), ver: r.vault.ver, vaultKey: await aesKey(vk), rpId: ch.rpId };
  vk.fill(0);
  const json = await openVault(acct, r.vault);
  if (!json.device) throw new AccountError('bad-vault', 'The account has no device key yet.');
  acct.device = await importDevice(json.device);
  acct.devicePub = json.device.pub;
  await store.saveAccount(acct);
  await mergePcs(acct, json);
  return { account: r.account, acct, pcs: json.pcs || [] };
}

/**
 * The account as the server has it now, and the PCs other phones added.
 * Signed out everywhere or deleted (the person did that, on some phone):
 * forgets it here. A session that merely ran out (30 days), or any other
 * answer, keeps everything (2026-10-10: nothing transient forgets a PC);
 * the PCs connect without the server, and the PC screen offers Sign in again.
 */
export async function refresh() {
  const acct = await store.getAccount();
  if (!acct) return null;
  if (acct.sessionEnded) return { account: null, acct, sessionEnded: true };
  try {
    const { account, vault } = await api('GET', API, null, acct.session);
    let next = { ...acct, name: account?.name || acct.name };
    if (vault && vault.ver !== acct.ver) {
      const json = await openVault(acct, vault);
      next = { ...next, ver: vault.ver };
      await mergePcs(next, json);
    }
    await store.saveAccount(next);
    return { account, acct: next };
  } catch (e) {
    // relay/src/account.js: 'signed-out' (Sign out everywhere) and 'no-account' (deleted) are the person's own doing.
    if (e.status === 401 && (e.code === 'signed-out' || e.code === 'no-account')) { await store.forgetAccount(); return { signedOut: true }; }
    // 'bad-session' (ran out, or not valid any more): keep the account and its PCs; only a new sign-in is needed.
    if (e.status === 401) {
      const next = { ...acct, sessionEnded: true };
      await store.saveAccount(next).catch(() => {});
      return { account: null, acct: next, sessionEnded: true, error: e };
    }
    return { account: null, acct, error: e };
  }
}

export const current = () => store.getAccount();

/* ---------- PCs ---------- */

/**
 * Saves the PC behind an open Link to the account: the PC accepts the
 * account device (ACCOUNTS.md, account-link) and the vault gets its record.
 *
 * Since 2026-10-10 the PC asks its person first (SECURITY.md 4.4): the
 * request says it can wait (wait: true), the PC answers { t: 'pending' }
 * (onPending, so the page can say "allow it on the PC"), and the answer
 * comes when the person allows or denies it there. A PC in Private mode
 * refuses (code 'private'); a PC from before this never offers it.
 *
 * Enrollment (2026-10-11, ENROLL.md): with `enroll: true`, a PC that lists
 * 'enroll' in its hello and a Link that has this phone's key, the request also
 * carries { enroll: true, phone: { pub, sig } }, the phone key signing the
 * connection's nonce, this phone's key and the account device. Sent right after
 * a pairing completed, the PC adds the account device at once with no card, in
 * Private mode too. If its conditions do not hold (the pairing is older than
 * its window, say) the PC treats it as the request above: a Connected PC
 * answers pending and waits for Allow, a Private one refuses.
 */
export async function link(lnk, { onPending = null, enroll = false } = {}) {
  const acct = await store.getAccount();
  if (!acct) throw new AccountError('signed-out', 'Sign in to your Apaki account first.');
  if (!lnk || lnk.state !== 'open') throw new AccountError('offline', 'Connect to the PC first.');
  const enrolling = Boolean(enroll && lnk.supports('enroll') && lnk.phone && typeof lnk.hello?.nonce === 'string');
  if (!enrolling && lnk.hello?.mode === 'private') throw new AccountError('private', `${lnk.pcName} is in Private mode: it only accepts phones paired with its code.`);
  if (!enrolling && !lnk.supports('account-ask')) throw new AccountError('old-pc', `${lnk.pcName} runs an older Apaki. Update it there, then save it to your account.`);
  if (lnk.hello?.asAccount) throw new AccountError('already', `${lnk.pcName} is already in your account.`);
  const pairing = lnk.pairing;
  const msg = { t: 'account-link', pub: acct.devicePub, name: acct.name, wait: true };
  if (enrolling) {
    msg.enroll = true;
    msg.phone = await signEnroll(lnk.phone, b64urlDecode(lnk.hello.nonce), b64urlDecode(acct.devicePub));
  }
  const answer = await lnk.request(msg, 'account-linked', 15_000, { onPending });
  if (answer.error) throw new AccountError(answer.code === 'private' ? 'private' : 'pc-refused', `${lnk.pcName} said: ${answer.error}`);
  if (answer.deviceId !== (await deviceIdFor(acct.devicePub))) throw new AccountError('bad-pc', 'The PC answered for another device.');
  return updateVault(acct, (json) => {
    json.pcs = (json.pcs || []).filter((p) => p.roomId !== pairing.roomId);
    json.pcs.push({ roomId: pairing.roomId, relay: pairing.relay, pcPub: pairing.pcPub, pcName: answer.pcName || lnk.pcName, deviceId: answer.deviceId, psk: answer.psk, addedAt: new Date().toISOString() });
  });
}

/** True when the account's vault lists this room (as far as this phone last saw). */
export async function hasPc(roomId) {
  const acct = await store.getAccount();
  if (!acct) return false;
  const { vault } = await api('GET', API, null, acct.session);
  return ((await openVault(acct, vault)).pcs || []).some((p) => p.roomId === roomId);
}

/**
 * Takes a PC out of the account. With an open Link to it, the PC also drops
 * the account device, so no phone signed in to the account reaches it.
 */
export async function unlink(roomId, lnk = null) {
  const acct = await store.getAccount();
  if (!acct) throw new AccountError('signed-out', 'Not signed in.');
  let offPc = false;
  // 'account-ask' since 2026-10-10 ('account' before): either PC takes account-unlink.
  if (lnk?.state === 'open' && lnk.roomId === roomId && (lnk.supports('account-ask') || lnk.supports('account'))) {
    const r = await lnk.request({ t: 'account-unlink', deviceId: await deviceIdFor(acct.devicePub) }, 'account-unlinked').catch(() => null);
    offPc = Boolean(r?.ok);
  }
  await updateVault(acct, (json) => { json.pcs = (json.pcs || []).filter((p) => p.roomId !== roomId); });
  return { offPc };
}

/** Whether a PC is connected to the relay right now (only for a relay on this page's own address); null when unknown. */
export async function presence(pc) {
  try {
    if (new URL(pc.relay).host !== SITE_HOST) return null;
    const res = await fetch(`/v1/rooms/${encodeURIComponent(pc.roomId)}/presence`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    return Boolean((await res.json()).pc);
  } catch { return null; }
}

/* ---------- the account itself ---------- */

/** Adds another passkey (for a phone outside this one's keychain): unlock with a current one, make the new one, wrap the vault key for it. */
export async function addPasskey() {
  const acct = await store.getAccount();
  if (!acct) throw new AccountError('signed-out', 'Not signed in.');
  const { account, vault } = await api('GET', API, null, acct.session);
  const ids = (account.passkeys || []).map((p) => p.id).filter((id) => vault?.wraps?.[id]);
  const rpId = acct.rpId || location.hostname;
  const cur = await prfFromGet(ids, rpId);
  const vk = await unseal(await kekFor(cur.prf, acct.accountId), wrapAad(cur.id), vault.wraps[cur.id], 'the account');
  try {
    const ch = await api('POST', `${API}/challenge`, { purpose: 'add' }, acct.session);
    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          rp: { id: ch.rpId, name: ch.rpName || 'Myrlin Apaki' },
          user: { id: b64urlDecode(acct.accountId), name: acct.name, displayName: acct.name },
          challenge: b64urlDecode(ch.challenge),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          excludeCredentials: (ch.exclude || []).map((id) => ({ type: 'public-key', id: b64urlDecode(id) })),
          attestation: 'none',
          timeout: CREATE_TIMEOUT_MS,
          extensions: { prf: { eval: { first: await prfSalt() } } },
        },
      });
    } catch (e) { throw webauthnError(e, 'Making the passkey'); }
    if (!cred.getClientExtensionResults?.()?.prf) throw noPrf();
    const added = await api('POST', `${API}/passkeys`, {
      token: ch.token,
      credential: { id: cred.id, clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject), transports: cred.response.getTransports?.() || [] },
    }, acct.session);
    const prf = prfOf(cred) || (await prfFromGet([cred.id], ch.rpId)).prf;
    const wrap = await seal(await kekFor(prf, acct.accountId), wrapAad(cred.id), vk);
    await updateVault(acct, (_json, wraps) => { wraps[cred.id] = wrap; });
    return added.account;
  } finally {
    vk.fill(0);
  }
}

export async function removePasskey(id) {
  const acct = await store.getAccount();
  return (await api('DELETE', `${API}/passkeys/${encodeURIComponent(id)}`, null, acct?.session)).account;
}

export async function rename(name) {
  const acct = await store.getAccount();
  const r = await api('POST', `${API}/rename`, { name }, acct?.session);
  await store.saveAccount({ ...acct, name: r.account?.name || name });
  return r.account;
}

/** Signs this phone out; the PCs it paired itself stay. */
export const signOut = () => store.forgetAccount();

/** Ends every session of the account (every phone signs in again), and signs this one out. */
export async function signOutEverywhere() {
  const acct = await store.getAccount();
  if (acct) await api('POST', `${API}/signout-all`, {}, acct.session).catch((e) => { if (e.status !== 401) throw e; });
  await store.forgetAccount();
}

/** Deletes the account on the server (its passkeys stay in the keychain, unused). PCs keep the account device until removed there. */
export async function remove() {
  const acct = await store.getAccount();
  if (acct) await api('DELETE', API, null, acct.session).catch((e) => { if (e.status !== 401 && e.status !== 404) throw e; });
  await store.forgetAccount();
}

/** The account's server view (passkeys and so on), or null. */
export async function details() {
  const acct = await store.getAccount();
  if (!acct) return null;
  return (await api('GET', API, null, acct.session)).account;
}
