/**
 * native-store.js: store.js for the Apaki app (apaki/mobile, 2026-10-10).
 *
 * Arthur: "when pairing a phone, the paired phone should be good to go
 * forever." A browser keeps paired PCs in IndexedDB, which iOS may clear
 * when the phone runs low on space or the app is unused for a while. The app
 * keeps them in the Keychain instead (ApakiKeys, accessible after the first
 * unlock, this device only, never synced), and each PC's device key is made
 * in the Secure Enclave: the private key cannot leave the chip, the app only
 * asks it to sign (protocol.js deviceSign).
 *
 * Same API as apaki/web/src/store.js (build-app.mjs puts a store.js that
 * re-exports this one into the app and checks every export is here), plus
 * newDevice(), which boot.js uses for a new pairing when the store has it.
 *
 * Keychain items (service io.myrlin.apaki.store): "pc:<roomId>" per paired PC
 * and "account" for the signed-in Apaki account, each a JSON record from
 * codec.js. Device keys live under their own service (io.myrlin.apaki.keys).
 */

import { Keys } from './cap.js';
import { b64d, b64e, decodeAccount, decodePc, encodeAccount, encodePc } from './codec.js';

const PC = 'pc:';
const ACCOUNT = 'account';

/** device.sign for a native key: ECDSA P-256 / SHA-256, 64-byte P1363 signature. */
const signerFor = (keyId) => async (bytes) => b64d((await Keys.sign({ keyId, data: b64e(bytes) })).sig);

async function readJson(key) {
  const { value } = await Keys.vaultGet({ key });
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

const writeJson = (key, obj) => Keys.vaultSet({ key, value: JSON.stringify(obj) });

/* ---------- paired PCs ---------- */

/** Every paired PC, most recently used first. A record that cannot be read is skipped (and logged), not fatal. */
export async function listPcs() {
  const { items = [] } = await Keys.vaultList({ prefix: PC });
  const out = [];
  for (const it of items) {
    try { out.push(await decodePc(JSON.parse(it.value), signerFor)); } catch (e) { console.warn('apaki store: skipped a record', it.key, e.message); }
  }
  return out.sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
}

export async function getPc(roomId) {
  const obj = await readJson(PC + roomId);
  return obj ? decodePc(obj, signerFor) : undefined;
}

export async function savePc(rec) {
  await writeJson(PC + rec.roomId, await encodePc(rec));
}

/** Forgets a PC; its own Secure Enclave key goes with it (an account PC shares the account's key, which stays). */
export async function forgetPc(roomId) {
  const obj = await readJson(PC + roomId);
  await Keys.vaultRemove({ key: PC + roomId });
  if (obj?.device?.kind === 'native') await Keys.deleteKey({ keyId: obj.device.keyId }).catch(() => {});
}

export async function touchPc(roomId) {
  const rec = await getPc(roomId);
  if (rec) await savePc({ ...rec, lastUsed: new Date().toISOString() });
}

/* ---------- the device key for a new pairing ---------- */

/**
 * A fresh device identity for one PC: a P-256 key in the Secure Enclave
 * (in the Simulator, which has none, a key kept in the Keychain). The
 * protocol only ever asks it to sign.
 */
export async function newDevice() {
  const { keyId, pub, secureEnclave } = await Keys.createKey();
  return { keyId, pub: b64d(pub), secureEnclave: Boolean(secureEnclave), sign: signerFor(keyId) };
}

/**
 * Deletes device keys no saved PC uses (a pairing that was started and never
 * finished leaves one). Called once at start, when no pairing can be running.
 */
export async function pruneKeys() {
  const { items = [] } = await Keys.vaultList({ prefix: PC });
  const keep = [];
  for (const it of items) {
    try { const d = JSON.parse(it.value)?.device; if (d?.kind === 'native') keep.push(d.keyId); } catch { /* unreadable: keep nothing for it */ }
  }
  return Keys.pruneKeys({ keep });
}

/* ---------- the Apaki account ---------- */

export async function getAccount() {
  const obj = await readJson(ACCOUNT);
  return obj ? decodeAccount(obj) : null;
}

export async function saveAccount(rec) {
  await writeJson(ACCOUNT, await encodeAccount({ ...rec, key: 'me' }));
}

/** Signs this phone out: the account record goes, and so do the PCs that came only from the account. */
export async function forgetAccount() {
  await Keys.vaultRemove({ key: ACCOUNT });
  for (const pc of await listPcs()) if (pc.via === 'account') await forgetPc(pc.roomId);
}
