/**
 * store.js: what the Apaki phone client remembers, in this browser's
 * IndexedDB (Track B part 2, 2026-10-09).
 *
 * One record per paired PC, keyed by its room id:
 *   { roomId, pcName, relay, pairing, device, pairedAt, lastUsed, via? }
 * pairing is protocol.js's pairing record (room, relay, the PC's public key,
 * this phone's device id and its pairing secret). device holds this phone's
 * key pair as CryptoKey objects: IndexedDB keeps them by structured clone,
 * and the private key is non-extractable, so page scripts can use it but
 * never read it out. via: 'account' for a PC that came from the Apaki
 * account's vault (2026-10-10, apaki/remote/ACCOUNTS.md); its device is the
 * account's device, imported non-extractable.
 *
 * The signed-in account (version 2 of the database, 2026-10-10), one record
 * keyed 'me': { key, accountId, name, session, sessionExp, ver, vaultKey,
 * device, devicePub }. vaultKey is the vault's AES key as a non-extractable
 * CryptoKey, so this phone can read and update the vault without a passkey
 * prompt, and the server never sees it.
 *
 * Forgetting a PC deletes its record here; the PC still lists this phone
 * until it is removed there.
 */

const DB_NAME = 'apaki-phone';
const DB_VERSION = 2;
const PCS = 'pcs';
const ACCOUNT = 'account';

let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(PCS)) r.result.createObjectStore(PCS, { keyPath: 'roomId' });
        if (!r.result.objectStoreNames.contains(ACCOUNT)) r.result.createObjectStore(ACCOUNT, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('The phone storage is busy in another tab.'));
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

async function run(mode, fn, store = PCS) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage aborted'));
  });
}

/** Every paired PC, most recently used first. */
export async function listPcs() {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
}

export const getPc = (roomId) => run('readonly', (s) => s.get(roomId));

export const savePc = (rec) => run('readwrite', (s) => s.put(rec));

export const forgetPc = (roomId) => run('readwrite', (s) => s.delete(roomId));

export async function touchPc(roomId) {
  const rec = await getPc(roomId);
  if (rec) await savePc({ ...rec, lastUsed: new Date().toISOString() });
}

/* ---------- the Apaki account (2026-10-10) ---------- */

/** The signed-in account on this phone, or null. */
export const getAccount = async () => (await run('readonly', (s) => s.get('me'), ACCOUNT)) || null;

export const saveAccount = (rec) => run('readwrite', (s) => s.put({ ...rec, key: 'me' }), ACCOUNT);

/** Signs this phone out: the account record goes, and so do the PCs that came only from the account. */
export async function forgetAccount() {
  await run('readwrite', (s) => s.delete('me'), ACCOUNT);
  for (const pc of await listPcs()) if (pc.via === 'account') await forgetPc(pc.roomId);
}
