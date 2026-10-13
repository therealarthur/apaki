/**
 * remote-store.js: what the Apaki engine keeps on disk for phone access.
 *
 * Folder: ~/.claude/latch/remote (APAKI_REMOTE_DIR overrides; tests use a
 * temp folder). Two files and a note:
 *   state.json         not secret: on/off, the room id, the PC's PUBLIC key,
 *                      and the paired phones (id, public key, name, when
 *                      paired, last seen). Nothing in it lets anyone connect.
 *   secret.json        the secrets, protected: the PC's private key (JWK),
 *                      the room token (proves to the relay that this is the
 *                      PC of the room) and each phone's pairing secret (psk).
 *   _WHY_THIS_IS_HERE.md  what this folder is, for a person cleaning up.
 *
 * Protection (2026-10-09): on Windows the secrets are sealed with DPAPI for
 * the current user (System.Security.Cryptography.ProtectedData, CurrentUser
 * scope, with an Apaki-specific entropy), through Windows PowerShell, which
 * every Windows has; no native module. Only this Windows account on this PC
 * can open the file, so a copied folder, a backup or another account gets
 * nothing. PowerShell runs only when phone access starts, when a phone is
 * paired and when one is removed; the secret goes in through stdin, never on
 * a command line. If DPAPI is unavailable (or on Linux) the file is
 * written readable by this user only (mode 600; on Windows the profile
 * folder's own permissions) and the status says protection: 'file'.
 *
 * macOS (2026-10-12, keychain.js): a random key in the login Keychain seals the
 * file (AES-256-GCM, scheme "keychain-aes", status protection: 'keychain'); the
 * `security` command line is the only helper, and the key goes through its
 * stdin, never a command line. Same durability as DPAPI: the sealed file, its
 * .bak copies and the retry when the Keychain is locked all work the same way.
 *
 * Durability (2026-10-10, Arthur: "the paired phone should be good to go
 * foreeever"): a paired phone must never be dropped by accident.
 *   - Every write goes to a temp file that is flushed to disk (fsync) and
 *     then renamed over the old one, so a crash or power cut leaves the old
 *     file or the new one, never half of one.
 *   - Before each write the previous good copy is kept as state.json.bak and
 *     secret.json.bak (the secret one stays sealed). A file that is there but
 *     cannot be read falls back to its .bak; a file that is missing is
 *     missing (deleting the files is how a person resets phone access).
 *   - secret.json also carries the list of paired phones (public data, kept
 *     there so a lost or damaged state.json can be rebuilt from it: see
 *     remote.js loadKeys).
 *   - state.json keeps the ids of phones removed on this PC (removed), so two
 *     Apaki engines sharing this folder (a second window, a dev build) can
 *     merge their views without bringing a removed phone back or dropping a
 *     phone the other one paired.
 *   - Timestamped copies (<file>.<time>.<why>.bak) are made before anything
 *     replaces the files wholesale: a rebuilt state, new keys, a reset.
 *
 * Private and Connected (2026-10-10, apaki/SECURITY.md 4.4; Arthur: "its
 * important that we have that secure and private option"):
 *   - state.json `mode`: 'private' (only phones paired with this PC's code;
 *     Apaki accounts refused) or 'connected' (accounts may be linked, each
 *     one allowed on the PC). Connected is the default, for new installs
 *     and for a state.json from before this (Arthur, 2026-10-10: "make sure
 *     users can login on apaki to see their connected machines!"); Private
 *     is the opt-in switch in the Phone sheet. secret.json carries the mode
 *     too, so a rebuilt state.json keeps a Private choice.
 *   - state.json `pageAlarm`: set when the hourly re-check found the phone
 *     page changed and turned phone access off (remote.js recheckPages);
 *     the Phone sheet shows it until phone access is turned on again.
 *   - each device may carry `cap` ('full', 'noshell', 'chat';
 *     remote-policy.js); none means 'full'. Kept in secret.json's list too,
 *     so a rebuilt state.json never widens a phone's access.
 *   - pages.json: the phone page versions this PC verified (their file
 *     hashes), re-checked every hour while phone access is on. Not secret.
 *
 * Phone keys behind an account device (2026-10-11, ../remote/ENROLL.md;
 * Arthur: "scanning the desktop phone pairing code should add that phone as
 * a passkey as well"): an account device record may carry
 *   phones: [{ id, pub, name, state, firstSeen, lastSeen, decidedAt? }]
 * one per phone key (remote.js) that connected through the account, state
 * enrolled, allowed, auto or blocked; and phonesForgot: [{ id, at }], the
 * phones the PC user forgot (so another engine's older view cannot bring one
 * back, the way removed does for devices). Kept in secret.json's copy of the
 * list too, so a rebuilt state.json never forgets a Block (that would let a
 * blocked phone in again in Connected). 'pending' (a phone waiting for an
 * Allow in Private) lives only as long as the connection that asks, so it is
 * never written.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECURITY_BIN, createKeychain } from './keychain.js';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Where phone access keeps its files. */
export function remoteDir() {
  return process.env.APAKI_REMOTE_DIR || path.join(CLAUDE_DIR, 'latch', 'remote');
}

const STATE = 'state.json';
const SECRET = 'secret.json';
const BAK = '.bak';
const ENTROPY = 'myrlin-apaki/remote/v1';
const PS_TIMEOUT_MS = 30_000;
/** At most this many removed phone ids are remembered (newest kept). */
const MAX_REMOVED = 100;
/** The optional fields a device record may carry into state.json (and the secret's copy of the list). cap: 2026-10-10. */
const DEVICE_EXTRA = ['kind', 'account', 'by', 'expiresAt', 'cap'];
/** What a phone key behind an account device may be (ENROLL.md): pending is in memory only (never saved). */
export const PHONE_STATES = Object.freeze(['enrolled', 'allowed', 'auto', 'pending', 'blocked']);
/** At most this many phone records per account device (past that the least recently seen one that is not blocked goes). */
export const MAX_PHONES = 20;
/** At most this many forgotten phone ids are remembered per account device (newest kept). */
const MAX_FORGOTTEN = 50;
const PAGES = 'pages.json';
/** At most this many verified phone page versions are kept for the hourly re-check (newest kept). */
const MAX_PAGES = 6;
/** The two phone access modes (state.json mode). */
export const PHONE_MODES = Object.freeze(['private', 'connected']);
/** The mode when none was chosen (Arthur, 2026-10-10: "make sure users can login on apaki to see their connected machines!"). */
export const DEFAULT_MODE = 'connected';
const validMode = (m) => (PHONE_MODES.includes(m) ? m : null);

const WHY = `# Myrlin Apaki: phone access

What this is: the files Myrlin Apaki keeps so phones you paired can reach this
PC through the Apaki relay. Apaki's engine (apaki/engine/remote.js in the
claude-latch repo) creates this folder the first time phone access is turned
on (the Phone button at the bottom of Apaki's sidebar).

- state.json: not secret. Whether phone access is on, Private or Connected,
  this PC's room id and public key, and the paired phones (their public keys,
  names, when they were paired and last seen, what each may make Claude do,
  when a pairing expires if you chose a limit). Under each Apaki account,
  the phone keys that connected through it (public keys, names, whether you
  allowed or blocked each one). If the hourly page check turned phone access
  off, why.
- secret.json: secret. This PC's private key, the room token and each phone's
  pairing secret, ${process.platform === 'darwin'
    ? 'sealed with a key in your macOS login Keychain (only you, on this Mac,\n  can open it)'
    : 'sealed with Windows DPAPI for your Windows account (only you,\n  on this PC, can open it)'}. Never share or sync it.
- pages.json: not secret. The phone page versions this PC checked on the
  site (file hashes), so it can check them again every hour. Safe to delete;
  it fills again at the next pairing.
- state.json.bak, secret.json.bak: the previous copy of each file, kept so a
  damaged file never unpairs your phones (secret.json.bak is sealed too).
- *.before-recovery.bak, *.before-new-keys.bak, *.set-aside-*: dated copies
  Apaki keeps before it rebuilds or replaces the files. Safe to delete once
  your phones work.

Safe to delete? Yes, with Apaki closed. Every paired phone stops working and
has to be paired again with a new QR code; nothing else breaks. To reset,
delete state.json and secret.json (and their .bak copies). To regenerate:
open Apaki, Phone, turn phone access on, pair again.

Written by Myrlin Apaki when phone access was first turned on. The feature
was built by Claude Code (Opus 5.5) for Arthur on 2026-10-09 (Track B, phone
access); backups and recovery added 2026-10-10; Private and Connected,
per-phone access and the hourly page check added 2026-10-10; phone keys under
Apaki accounts added 2026-10-11.
`;

/** The Windows PowerShell that ships with Windows (full path, so PATH cannot swap it). */
function powershell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Seals or opens bytes with DPAPI (CurrentUser). The data travels inside the
 * script on stdin, base64, so it never appears in a process list.
 */
function dpapi(action, bytes) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    `$in = [Convert]::FromBase64String('${Buffer.from(bytes).toString('base64')}')`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${action}($in, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
    'exit 0',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = execFile(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(new Error(`DPAPI ${action} failed: ${String(err.message).split('\n')[0]}`)); return; }
      const out = String(stdout).trim();
      if (!/^[A-Za-z0-9+/=]+$/.test(out)) { reject(new Error(`DPAPI ${action} gave no output`)); return; }
      resolve(Buffer.from(out, 'base64'));
    });
    child.stdin.end(`${script}\n`);
  });
}

/** True where DPAPI can be used. APAKI_REMOTE_PROTECT=file turns it off (tests, debugging). */
export function dpapiAvailable() {
  return process.platform === 'win32' && process.env.APAKI_REMOTE_PROTECT !== 'file' && fs.existsSync(powershell());
}

/** True where the macOS Keychain can be used (a Mac with /usr/bin/security). APAKI_REMOTE_PROTECT=file turns it off. */
export function keychainAvailable() {
  return secretStoreFor() === 'keychain';
}

/**
 * Which store seals secret.json: 'dpapi' on Windows, 'keychain' on a Mac, else (or when APAKI_REMOTE_PROTECT=file) a
 * user-only 'file'. Pure given its inputs, so the choice is tested on any OS (macOS port, 2026-10-12).
 */
export function secretStoreFor({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (env.APAKI_REMOTE_PROTECT === 'file') return 'file';
  if (platform === 'win32') return exists(powershell()) ? 'dpapi' : 'file';
  if (platform === 'darwin') return exists(SECURITY_BIN) ? 'keychain' : 'file';
  return 'file';
}

export const protectBytes = (bytes) => dpapi('Protect', bytes);
export const unprotectBytes = (bytes) => dpapi('Unprotect', bytes);

// The Mac's sealer (keychain.js): made on first use, so a PC never loads a Keychain it does not use.
let macKeychain = null;
const keychain = () => (macKeychain ||= createKeychain());
/** Swaps the Keychain sealer (tests give it a fake `security`); returns the one it replaces. */
export function setKeychain(kc) {
  const old = macKeychain;
  macKeychain = kc;
  return old;
}
export const keychainProtect = (bytes) => keychain().protect(bytes);
export const keychainUnprotect = (bytes) => keychain().unprotect(bytes);

/** Writes through a flushed temp file and a rename: the old file or the new one survives a crash, never a torn or empty one. */
function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, text);
    try { fs.fsyncSync(fd); } catch { /* a file system without fsync: the rename still helps */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (mode && process.platform !== 'win32') fs.chmodSync(file, mode);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 'missing', 'corrupt' (there but not JSON) or 'ok', and the parsed value. */
function readJsonStatus(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { status: e.code === 'ENOENT' ? 'missing' : 'corrupt', value: null }; }
  try { return { status: 'ok', value: JSON.parse(text) }; } catch { return { status: 'corrupt', value: null }; }
}

/** Creates the folder with its note (once; an older note of ours is brought up to date). */
export function ensureDir(dir = remoteDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const why = path.join(dir, '_WHY_THIS_IS_HERE.md');
  let cur = null;
  try { cur = fs.readFileSync(why, 'utf8'); } catch { /* none yet */ }
  // An older note of ours (written before pages.json or the phone keys existed) is brought up to date; anything else is left alone.
  if (cur === null || (cur !== WHY && cur.startsWith('# Myrlin Apaki: phone access') && (!cur.includes('pages.json') || !cur.includes('phone keys')))) fs.writeFileSync(why, WHY);
  return dir;
}

/** "mtime:size" of a file in the folder, or null: cheap to compare, to notice another engine's write. */
export function stamp(dir, name) {
  try { const s = fs.statSync(path.join(dir, name)); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
}

export const stateStamp = (dir = remoteDir()) => stamp(dir, STATE);
export const secretStamp = (dir = remoteDir()) => stamp(dir, SECRET);

/** True when secret.json is there (readable or not). */
export function hasSecretFile(dir = remoteDir()) {
  return fs.existsSync(path.join(dir, SECRET));
}

// A new install is Connected (Arthur, 2026-10-10: "make sure users can login on apaki to see their connected
// machines!"); Private is the opt-in switch in the Phone sheet. Account links still need an Allow on the PC.
const FRESH = () => ({ v: 1, enabled: false, mode: DEFAULT_MODE, pageAlarm: null, roomId: null, pcPub: null, createdAt: null, devices: [], removed: [] });

/**
 * The mode a saved state is in: its own when it has one; otherwise (a new
 * install, or a state.json from before 2026-10-10) the default, Connected.
 * (First written as "Private unless an account device is linked"; Arthur
 * chose Connected as the default on 2026-10-10.)
 */
export function modeOf(s) {
  return validMode(s?.mode) || DEFAULT_MODE;
}

/** A page alarm as it is kept: plain fields only (remote.js recheckPages makes it). */
function cleanAlarm(a) {
  if (!a || typeof a !== 'object' || !a.at) return null;
  return { at: String(a.at), version: a.version ? String(a.version) : null, url: a.url ? String(a.url) : null, files: Array.isArray(a.files) ? a.files.map(String).slice(0, 50) : [], of: Number(a.of) || 0, text: String(a.text || '').slice(0, 600) };
}

/**
 * One phone record as it is kept (ENROLL.md): the known fields only; null
 * when it is not one, or when it is 'pending' (that lives only as long as
 * the connection that asks, so it is never written or read back).
 */
export function cleanPhone(p) {
  if (!p || typeof p.id !== 'string' || !p.id || typeof p.pub !== 'string') return null;
  if (!PHONE_STATES.includes(p.state) || p.state === 'pending') return null;
  const out = { id: p.id, pub: p.pub, name: String(p.name || 'Phone').slice(0, 64), state: p.state, firstSeen: p.firstSeen || null, lastSeen: p.lastSeen || null };
  // When the PC user last decided about it (Allow, Block, a scan in person): a later Allow beats an older Block when two engines merge (remote.js mergeState).
  if (p.decidedAt) out.decidedAt = String(p.decidedAt);
  return out;
}

/** A device's phone records as they are saved or read back (one record per id, the first wins). */
export function cleanPhones(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const c = cleanPhone(p);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** The forgotten phone ids of an account device: [{ id, at }], newest kept. */
export function cleanForgotten(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r.id === 'string' && r.id).slice(-MAX_FORGOTTEN).map((r) => ({ id: r.id, at: r.at ? String(r.at) : null }));
}

/** One device record as it is saved: the known fields only, optional ones when set. */
function cleanDevice(d) {
  const out = { id: d.id, pub: d.pub, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen || null };
  for (const k of DEVICE_EXTRA) if (d[k] != null && d[k] !== '') out[k] = d[k];
  // 2026-10-11: the phone keys behind an account device, and the ones forgotten (only when there are any).
  const phones = cleanPhones(d.phones);
  if (phones.length) out.phones = phones;
  const forgot = cleanForgotten(d.phonesForgot);
  if (forgot.length) out.phonesForgot = forgot;
  return out;
}

/** A device as read back from state.json: phone records cleaned (a damaged one is dropped), everything else as it was. */
function readDevice(d) {
  if (!d.phones && !d.phonesForgot) return d;
  const { phones: _p, phonesForgot: _f, ...rest } = d;
  const phones = cleanPhones(d.phones);
  const forgot = cleanForgotten(d.phonesForgot);
  return { ...rest, ...(phones.length ? { phones } : {}), ...(forgot.length ? { phonesForgot: forgot } : {}) };
}

function normalState(s) {
  if (!s || s.v !== 1) return null;
  const removed = Array.isArray(s.removed) ? s.removed.filter((r) => r && typeof r.id === 'string').slice(-MAX_REMOVED) : [];
  const devices = Array.isArray(s.devices) ? s.devices.filter((d) => d && typeof d.id === 'string').map(readDevice) : [];
  return { v: 1, enabled: Boolean(s.enabled), mode: modeOf({ mode: s.mode, devices }), pageAlarm: cleanAlarm(s.pageAlarm), roomId: s.roomId || null, pcPub: s.pcPub || null, createdAt: s.createdAt || null, devices, removed };
}

/**
 * The public state and where it came from: status 'ok' (state.json),
 * 'backup' (state.json was there but damaged; state.json.bak was good),
 * 'corrupt' (neither could be read: a fresh state), 'missing' (no
 * state.json: a fresh state).
 */
export function readState(dir = remoteDir()) {
  const main = readJsonStatus(path.join(dir, STATE));
  const s = main.status === 'ok' ? normalState(main.value) : null;
  if (s) return { state: s, status: 'ok' };
  if (main.status === 'missing') return { state: FRESH(), status: 'missing' };
  const bak = normalState(readJson(path.join(dir, STATE + BAK)));
  if (bak) return { state: bak, status: 'backup' };
  return { state: FRESH(), status: 'corrupt' };
}

/** The public state, or a fresh one: { v, enabled, mode, pageAlarm, roomId, pcPub, createdAt, devices: [{ id, pub, name, pairedAt, lastSeen, kind?, account?, by?, expiresAt?, cap?, phones?, phonesForgot? }], removed: [{ id, at }] }. */
export function loadState(dir = remoteDir()) {
  return readState(dir).state;
}

/** Copies a file that reads as `valid` to its rolling .bak (the last good copy), before it is replaced. */
function rollBackup(dir, name, valid) {
  const file = path.join(dir, name);
  const cur = readJson(file);
  if (!cur || !valid(cur)) return;
  try { writeAtomic(path.join(dir, name + BAK), fs.readFileSync(file, 'utf8'), 0o600); } catch { /* the write itself matters more */ }
}

/** A dated copy of state.json and secret.json (those that exist), before they are rebuilt or replaced. Returns the copies' names. */
export function backupNow(dir = remoteDir(), why = 'backup') {
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  const made = [];
  for (const name of [STATE, SECRET]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const copy = `${name}.${at}.${why}${BAK}`;
    try { fs.copyFileSync(file, path.join(dir, copy)); made.push(copy); } catch { /* best effort */ }
  }
  return made;
}

export function saveState(state, dir = remoteDir()) {
  ensureDir(dir);
  const devices = state.devices.map(cleanDevice);
  const removed = (state.removed || []).filter((r) => r && r.id).slice(-MAX_REMOVED).map((r) => ({ id: r.id, at: r.at || null }));
  rollBackup(dir, STATE, (s) => s.v === 1);
  // mode is always written (a state.json without one is from before 2026-10-10, see modeOf); pageAlarm only while set.
  const alarm = cleanAlarm(state.pageAlarm);
  writeAtomic(path.join(dir, STATE), `${JSON.stringify({ v: 1, enabled: state.enabled, mode: modeOf(state), roomId: state.roomId, pcPub: state.pcPub, createdAt: state.createdAt, devices, ...(removed.length ? { removed } : {}), ...(alarm ? { pageAlarm: alarm } : {}) }, null, 2)}\n`);
}

/** Why a secret.json that is there could not be used: code 'unreadable' (damaged) or 'locked' (DPAPI would not open it). */
export class SecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

async function openSecretFile(file) {
  const r = readJsonStatus(file);
  if (r.status === 'missing') return null;
  const f = r.value;
  if (r.status !== 'ok' || !f || typeof f !== 'object') throw new SecretError('unreadable', `${path.basename(file)} is damaged`);
  let bytes;
  if (f.scheme === 'dpapi-user') {
    try { bytes = await unprotectBytes(Buffer.from(String(f.data || ''), 'base64')); } catch (e) { throw new SecretError('locked', e.message); }
  } else if (f.scheme === 'keychain-aes') {
    // Sealed with the key in the macOS login Keychain (keychain.js): a missing item or a locked keychain is 'locked' too.
    try { bytes = await keychainUnprotect(Buffer.from(String(f.data || ''), 'base64')); } catch (e) { throw new SecretError('locked', e.message); }
  } else if (f.scheme === 'file') {
    bytes = Buffer.from(String(f.data || ''), 'base64');
  } else {
    throw new SecretError('unreadable', `unknown secret scheme ${f.scheme}`);
  }
  let s;
  try { s = JSON.parse(bytes.toString('utf8')); } catch { throw new SecretError('unreadable', `${path.basename(file)} does not open to valid data`); }
  if (!s || typeof s !== 'object' || !s.identity || typeof s.token !== 'string') throw new SecretError('unreadable', `${path.basename(file)} has no keys in it`);
  return { identity: s.identity, token: s.token, psks: s.psks || {}, devices: Array.isArray(s.devices) ? s.devices.filter((d) => d && typeof d.id === 'string').map(readDevice) : [], createdAt: s.createdAt || null, mode: validMode(s.mode), scheme: f.scheme };
}

/**
 * The secrets: { identity, token, psks: { [deviceId]: psk }, devices, createdAt },
 * or null when there are none yet. A secret.json that is there but cannot
 * be opened falls back to secret.json.bak; when that fails too it throws a
 * SecretError (never null: the caller must not make new keys over it).
 */
export async function loadSecret(dir = remoteDir()) {
  try {
    return await openSecretFile(path.join(dir, SECRET));
  } catch (e) {
    const bak = await openSecretFile(path.join(dir, SECRET + BAK)).catch(() => null);
    if (bak) return { ...bak, fromBackup: true };
    throw e;
  }
}

/**
 * Saves the secrets (and the public list of paired phones beside them),
 * sealed with DPAPI where possible. Returns the scheme used. backup: false
 * skips the rolling .bak (when the file being replaced is the damaged one).
 */
export async function saveSecret(secret, dir = remoteDir(), { backup = true, store: sealWith = secretStoreFor() } = {}) {
  ensureDir(dir);
  const body = { identity: secret.identity, token: secret.token, psks: secret.psks || {} };
  if (Array.isArray(secret.devices)) body.devices = secret.devices.map(cleanDevice).map(({ lastSeen: _seen, ...d }) => d);
  if (secret.createdAt) body.createdAt = secret.createdAt;
  // Private or Connected, so a state.json rebuilt from this file keeps it (remote.js recoverState).
  if (validMode(secret.mode)) body.mode = secret.mode;
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  let scheme = 'file';
  let data = plain.toString('base64');
  const store = sealWith;
  if (store === 'dpapi') {
    try {
      data = (await protectBytes(plain)).toString('base64');
      scheme = 'dpapi-user';
    } catch (e) {
      process.stderr.write(`apaki remote: ${e.message}; keeping the secrets in a user-only file instead\n`);
    }
  } else if (store === 'keychain') {
    try {
      data = (await keychainProtect(plain)).toString('base64');
      scheme = 'keychain-aes';
    } catch (e) {
      process.stderr.write(`apaki remote: ${e.message}; keeping the secrets in a user-only file instead\n`);
    }
  }
  plain.fill(0);
  if (backup) rollBackup(dir, SECRET, (f) => typeof f.scheme === 'string' && typeof f.data === 'string');
  writeAtomic(path.join(dir, SECRET), `${JSON.stringify({ v: 1, scheme, data })}\n`, 0o600);
  return scheme;
}

/**
 * Moves state.json, secret.json and their .bak copies aside (renamed with
 * the time, never deleted), so phone access can start over with new keys.
 * Used only when the saved keys cannot be opened at all. The note stays.
 */
export function setAside(dir = remoteDir()) {
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  const moved = [];
  for (const name of [STATE, SECRET, STATE + BAK, SECRET + BAK]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const to = `${name}.set-aside-${at}`;
    fs.renameSync(file, path.join(dir, to));
    moved.push(to);
  }
  return moved;
}

/** Removes everything phone access saved (used by "forget all"). The note stays with the folder. */
export function wipe(dir = remoteDir()) {
  for (const f of [STATE, SECRET, STATE + BAK, SECRET + BAK, PAGES]) fs.rmSync(path.join(dir, f), { force: true });
}

/* ---------- verified phone page versions (pages.json, 2026-10-10) ---------- */

const HEX64 = /^[0-9a-f]{64}$/;

/** One verified version as it is kept: { version, web, url, files: { path: sha256 }, verifiedAt }, or null when it is not one. */
function cleanPage(p) {
  if (!p || typeof p.version !== 'string' || !/^[0-9a-f]{6,64}$/.test(p.version) || typeof p.url !== 'string') return null;
  const files = {};
  for (const [k, v] of Object.entries(p.files || {})) if (typeof k === 'string' && k.length < 200 && typeof v === 'string' && HEX64.test(v)) files[k] = v;
  if (!Object.keys(files).length) return null;
  return { version: p.version, web: typeof p.web === 'string' ? p.web : null, url: p.url, files, verifiedAt: p.verifiedAt || null };
}

/** The phone page versions this PC verified, newest first (a missing or damaged pages.json is none). */
export function loadPages(dir = remoteDir()) {
  const j = readJson(path.join(dir, PAGES));
  return Array.isArray(j?.versions) ? j.versions.map(cleanPage).filter(Boolean).slice(0, MAX_PAGES) : [];
}

/** Keeps a verified version (moved to the front when it is already there); the oldest beyond MAX_PAGES go. */
export function rememberPage(page, dir = remoteDir()) {
  const p = cleanPage(page);
  if (!p) return loadPages(dir);
  const versions = [p, ...loadPages(dir).filter((x) => !(x.version === p.version && x.url === p.url))].slice(0, MAX_PAGES);
  ensureDir(dir);
  writeAtomic(path.join(dir, PAGES), `${JSON.stringify({ v: 1, versions }, null, 1)}\n`);
  return versions;
}
