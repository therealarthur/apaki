/**
 * demo-store.js: store.js for the Apaki app's debug demo mode (apaki/mobile,
 * 2026-10-10). Everything in memory: a demo never reads or writes the
 * Keychain, so it cannot disturb a real pairing on the same Simulator.
 * Seeded by demo-setup.js (one paired PC, or none for the pairing screen).
 */

const pcs = new Map();
let account = null;

const fakeDevice = () => ({ keyId: 'demo', pub: new Uint8Array(65).fill(4, 0, 1), sign: async () => new Uint8Array(64) });

export async function listPcs() {
  return [...pcs.values()].sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
}

export const getPc = async (roomId) => pcs.get(roomId);

export async function savePc(rec) { pcs.set(rec.roomId, { ...rec }); }

export async function forgetPc(roomId) { pcs.delete(roomId); }

export async function touchPc(roomId) {
  const rec = pcs.get(roomId);
  if (rec) pcs.set(roomId, { ...rec, lastUsed: new Date().toISOString() });
}

export const newDevice = async () => fakeDevice();

/* The rest of the web store.js's surface (storage errors, waiting on another tab, persist, updatePc): nothing to fail or wait on in memory. */
export class StorageError extends Error {
  constructor(message, cause = null) { super(message); this.name = 'StorageError'; this.code = 'storage'; this.cause = cause; }
}
export const isStorageError = (e) => e instanceof StorageError || e?.code === 'storage';
export const onWait = () => () => {};
export const persist = async () => true;
export async function updatePc(roomId, fields) {
  const rec = pcs.get(roomId);
  if (!rec) return null;
  pcs.set(roomId, { ...rec, ...fields });
  return pcs.get(roomId);
}

/** The phone key (apaki/remote/ENROLL.md): the demo has no PC to prove it to, so a fake like the device key above. */
export const getPhoneKey = async () => ({ ...fakeDevice(), keyId: 'demo-phone' });

export const getAccount = async () => account;

export async function saveAccount(rec) { account = { ...rec, key: 'me' }; }

export async function forgetAccount() {
  account = null;
  for (const [id, pc] of pcs) if (pc.via === 'account') pcs.delete(id);
}

/** demo-setup.js: one paired PC, as if this phone had scanned its code a week ago. */
export function seedPc({ roomId, pcName, relay }) {
  const pairedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const pairing = { v: 1, roomId, relay, pcPub: 'demo', pcName, deviceId: 'demo', psk: 'demo', pairedAt };
  pcs.set(roomId, { roomId, pcName, relay, pairing, device: fakeDevice(), pairedAt, lastUsed: new Date().toISOString() });
}
