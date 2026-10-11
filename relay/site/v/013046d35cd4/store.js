/**
 * store.js: what the Apaki phone client remembers, in this browser's
 * IndexedDB (Track B part 2, 2026-10-09).
 *
 * One record per paired PC, keyed by its room id:
 *   { roomId, pcName, relay, pairing, device, pairedAt, lastUsed, via?, expiresAt? }
 * pairing is protocol.js's pairing record (room, relay, the PC's public key,
 * this phone's device id and its pairing secret). device holds this phone's
 * key pair as CryptoKey objects: IndexedDB keeps them by structured clone,
 * and the private key is non-extractable, so page scripts can use it but
 * never read it out. via: 'account' for a PC that came from the Apaki
 * account's vault (2026-10-10, apaki/remote/ACCOUNTS.md); its device is the
 * account's device, imported non-extractable. expiresAt: when the PC said
 * this pairing runs out (its hello; absent or null: never).
 *
 * The signed-in account (version 2 of the database, 2026-10-10), one record
 * keyed 'me': { key, accountId, name, session, sessionExp, ver, vaultKey,
 * device, devicePub }. vaultKey is the vault's AES key as a non-extractable
 * CryptoKey, so this phone can read and update the vault without a passkey
 * prompt, and the server never sees it.
 *
 * Forgetting a PC deletes its record here; the PC still lists this phone
 * until it is removed there.
 *
 * Staying paired (2026-10-10, Arthur: "the paired phone should be good to go
 * foreeever"). The page of cab37e8659c3 bumped the database to version 2
 * while a tab of an earlier page still held version 1 open: the open was
 * 'blocked', this file gave up, and the phone showed "Connect to your PC" as
 * if nothing were saved. Now:
 *   - an open that waits on another tab keeps waiting (onWait tells the page
 *     after BLOCKED_NOTE_MS, so it can say "Close the other Apaki tab");
 *   - every connection closes itself when a newer page upgrades the database
 *     (versionchange), so this page never holds up the next version;
 *   - a page older than the database opens it at its current version
 *     (versions only ever add stores);
 *   - a lost connection is opened again, once per call;
 *   - a failure is a StorageError, so the page can tell "could not read"
 *     from "nothing saved" and offer a retry instead of the pairing screen;
 *   - persist() asks the browser not to evict this site's storage.
 *
 * Never raise DB_VERSION again. Published pages never change, and pages
 * ac45f97a9b01 and 0a64d8514a08 open version 1 and turn the VersionError a
 * higher version gives them into an empty list: on a phone where a version
 * 2 page has run, those pages show "Connect to your PC" for good, though the
 * pairing is still saved (any version 2 page reads it). New data goes into
 * the existing stores (records are free-form) or into a new database.
 */

const DB_NAME = 'apaki-phone';
const DB_VERSION = 2;
const PCS = 'pcs';
const ACCOUNT = 'account';
/** How long an open may wait (on another tab, or slow storage) before the page is told. */
const BLOCKED_NOTE_MS = 2000;

let dbp = null;
let conn = null;
const waiters = new Set();

/** Storage that could not be read or written, as opposed to "nothing saved". */
export class StorageError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'StorageError';
    this.code = 'storage';
    this.cause = cause;
  }
}

export const isStorageError = (e) => e instanceof StorageError || e?.code === 'storage';

const asStorageError = (e) => (isStorageError(e) ? e : new StorageError(`This phone's storage could not be used (${e?.name || 'Error'}: ${e?.message || e}).`, e));

/**
 * fn(state) hears how opening goes: 'blocked' (still waiting after
 * BLOCKED_NOTE_MS, usually an older Apaki page open in another tab), 'ready'
 * (open after such a wait), 'versionchange' (a newer page upgraded; this
 * page opens again by itself). Returns a function that stops it.
 */
export function onWait(fn) {
  waiters.add(fn);
  return () => waiters.delete(fn);
}

function tell(state) {
  for (const fn of [...waiters]) { try { fn(state); } catch { /* a listener's problem */ } }
}

function createStores(d) {
  if (!d.objectStoreNames.contains(PCS)) d.createObjectStore(PCS, { keyPath: 'roomId' });
  if (!d.objectStoreNames.contains(ACCOUNT)) d.createObjectStore(ACCOUNT, { keyPath: 'key' });
}

/** One open request, at `version` (0: whatever version the database has). Waits through 'blocked'. */
function openDb(version) {
  return new Promise((resolve, reject) => {
    let r;
    try {
      r = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    } catch (e) {
      reject(e);
      return;
    }
    let waited = false;
    // A queued open behind another tab may get no 'blocked' event at all (Chromium): a timer covers both.
    const note = setTimeout(() => { waited = true; tell('blocked'); }, BLOCKED_NOTE_MS);
    r.onupgradeneeded = () => createStores(r.result);
    r.onblocked = () => { /* keep waiting: the other tab closes, reloads, or its page closes on versionchange */ };
    r.onsuccess = () => {
      clearTimeout(note);
      const d = r.result;
      // Never hold up a newer Apaki page: close for its upgrade; the next call here opens again.
      d.onversionchange = () => {
        try { d.close(); } catch { /* closed */ }
        if (conn === d) { conn = null; dbp = null; }
        tell('versionchange');
      };
      // Closed by the browser (storage cleared, the storage process restarted): open again next time.
      d.onclose = () => { if (conn === d) { conn = null; dbp = null; } };
      if (waited) tell('ready');
      resolve(d);
    };
    r.onerror = (ev) => {
      clearTimeout(note);
      ev?.preventDefault?.();
      reject(r.error || new DOMException('could not open', 'UnknownError'));
    };
  });
}

function db() {
  if (!dbp) {
    dbp = (async () => {
      let d;
      try {
        d = await openDb(DB_VERSION);
      } catch (e) {
        if (e?.name !== 'VersionError') throw asStorageError(e);
        // A newer Apaki page upgraded the database: use it as it is (versions only ever add stores).
        try { d = await openDb(0); } catch (e2) { throw asStorageError(e2); }
      }
      if (![PCS, ACCOUNT].every((s) => d.objectStoreNames.contains(s))) {
        try { d.close(); } catch { /* closed */ }
        throw new StorageError('This phone\'s storage is missing a part Apaki needs. Reload the page.');
      }
      conn = d;
      return d;
    })();
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

/** The connection went away under a call (closed for a newer page, lost by the browser): worth one more try. */
const connectionGone = (e) => ['InvalidStateError', 'UnknownError', 'TransactionInactiveError'].includes(e?.name) || (e?.name === 'AbortError' && !e?.message?.includes('Quota'));

async function run(mode, fn, store = PCS) {
  for (let attempt = 0; ; attempt++) {
    const d = await db();
    try {
      return await new Promise((resolve, reject) => {
        let t;
        try { t = d.transaction(store, mode); } catch (e) { reject(e); return; }
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new DOMException('storage aborted', 'AbortError'));
      });
    } catch (e) {
      if (attempt === 0 && connectionGone(e)) {
        if (conn === d) { conn = null; dbp = null; try { d.close(); } catch { /* closed */ } }
        continue;
      }
      throw asStorageError(e);
    }
  }
}

/** Every paired PC, most recently used first. Throws a StorageError when storage cannot be read (never [] for that). */
export async function listPcs() {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
}

export const getPc = (roomId) => run('readonly', (s) => s.get(roomId));

export const savePc = (rec) => run('readwrite', (s) => s.put(rec));

/** Forgets a PC. Only the person (Forget), or an account change they made, calls this. */
export const forgetPc = (roomId) => run('readwrite', (s) => s.delete(roomId));

export async function touchPc(roomId) {
  const rec = await getPc(roomId);
  if (rec) await savePc({ ...rec, lastUsed: new Date().toISOString() });
}

/** Changes some fields of a saved PC (its expiry, say); nothing when it is not saved. */
export async function updatePc(roomId, fields) {
  const rec = await getPc(roomId);
  if (rec) await savePc({ ...rec, ...fields });
  return rec ? { ...rec, ...fields } : null;
}

/**
 * Asks the browser to keep this site's storage under storage pressure
 * (navigator.storage.persist). True when it is persistent now. Safari and
 * Chrome decide by themselves (a Home Screen app, an often used site);
 * Firefox may ask the person once.
 */
export async function persist() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return Boolean(await navigator.storage.persist());
  } catch {
    return false;
  }
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
