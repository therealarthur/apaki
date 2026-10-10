/**
 * store.js: what the Apaki phone client remembers, in this browser's
 * IndexedDB (Track B part 2, 2026-10-09).
 *
 * One record per paired PC, keyed by its room id:
 *   { roomId, pcName, relay, pairing, device, pairedAt, lastUsed }
 * pairing is protocol.js's pairing record (room, relay, the PC's public key,
 * this phone's device id and its pairing secret). device holds this phone's
 * key pair as CryptoKey objects: IndexedDB keeps them by structured clone,
 * and the private key is non-extractable, so page scripts can use it but
 * never read it out.
 *
 * Forgetting a PC deletes its record here; the PC still lists this phone
 * until it is removed there.
 */

const DB_NAME = 'apaki-phone';
const DB_VERSION = 1;
const PCS = 'pcs';

let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(PCS)) r.result.createObjectStore(PCS, { keyPath: 'roomId' }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('The phone storage is busy in another tab.'));
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(PCS, mode);
    const req = fn(t.objectStore(PCS));
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
