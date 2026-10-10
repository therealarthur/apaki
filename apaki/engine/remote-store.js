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
 * a command line. If DPAPI is unavailable (or on macOS/Linux) the file is
 * written readable by this user only (mode 600; on Windows the profile
 * folder's own permissions) and the status says protection: 'file'.
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
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
/** The optional fields a device record may carry into state.json (and the secret's copy of the list). */
const DEVICE_EXTRA = ['kind', 'account', 'by', 'expiresAt'];

const WHY = `# Myrlin Apaki: phone access

What this is: the files Myrlin Apaki keeps so phones you paired can reach this
PC through the Apaki relay. Apaki's engine (apaki/engine/remote.js in the
claude-latch repo) creates this folder the first time phone access is turned
on (the Phone button at the bottom of Apaki's sidebar).

- state.json: not secret. Whether phone access is on, this PC's room id and
  public key, and the paired phones (their public keys, names, when they were
  paired and last seen, when a pairing expires if you chose a limit).
- secret.json: secret. This PC's private key, the room token and each phone's
  pairing secret, sealed with Windows DPAPI for your Windows account (only you,
  on this PC, can open it). Never share or sync it.
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
access); backups and recovery added 2026-10-10.
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

export const protectBytes = (bytes) => dpapi('Protect', bytes);
export const unprotectBytes = (bytes) => dpapi('Unprotect', bytes);

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
  if (cur === null || (cur !== WHY && cur.startsWith('# Myrlin Apaki: phone access') && !cur.includes('state.json.bak'))) fs.writeFileSync(why, WHY);
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

const FRESH = () => ({ v: 1, enabled: false, roomId: null, pcPub: null, createdAt: null, devices: [], removed: [] });

/** One device record as it is saved: the known fields only, optional ones when set. */
function cleanDevice(d) {
  const out = { id: d.id, pub: d.pub, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen || null };
  for (const k of DEVICE_EXTRA) if (d[k] != null && d[k] !== '') out[k] = d[k];
  return out;
}

function normalState(s) {
  if (!s || s.v !== 1) return null;
  const removed = Array.isArray(s.removed) ? s.removed.filter((r) => r && typeof r.id === 'string').slice(-MAX_REMOVED) : [];
  return { v: 1, enabled: Boolean(s.enabled), roomId: s.roomId || null, pcPub: s.pcPub || null, createdAt: s.createdAt || null, devices: Array.isArray(s.devices) ? s.devices.filter((d) => d && typeof d.id === 'string') : [], removed };
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

/** The public state, or a fresh one: { v, enabled, roomId, pcPub, createdAt, devices: [{ id, pub, name, pairedAt, lastSeen, kind?, account?, by?, expiresAt? }], removed: [{ id, at }] }. */
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
  writeAtomic(path.join(dir, STATE), `${JSON.stringify({ v: 1, enabled: state.enabled, roomId: state.roomId, pcPub: state.pcPub, createdAt: state.createdAt, devices, ...(removed.length ? { removed } : {}) }, null, 2)}\n`);
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
  } else if (f.scheme === 'file') {
    bytes = Buffer.from(String(f.data || ''), 'base64');
  } else {
    throw new SecretError('unreadable', `unknown secret scheme ${f.scheme}`);
  }
  let s;
  try { s = JSON.parse(bytes.toString('utf8')); } catch { throw new SecretError('unreadable', `${path.basename(file)} does not open to valid data`); }
  if (!s || typeof s !== 'object' || !s.identity || typeof s.token !== 'string') throw new SecretError('unreadable', `${path.basename(file)} has no keys in it`);
  return { identity: s.identity, token: s.token, psks: s.psks || {}, devices: Array.isArray(s.devices) ? s.devices.filter((d) => d && typeof d.id === 'string') : [], createdAt: s.createdAt || null, scheme: f.scheme };
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
export async function saveSecret(secret, dir = remoteDir(), { backup = true } = {}) {
  ensureDir(dir);
  const body = { identity: secret.identity, token: secret.token, psks: secret.psks || {} };
  if (Array.isArray(secret.devices)) body.devices = secret.devices.map(cleanDevice).map(({ lastSeen: _seen, ...d }) => d);
  if (secret.createdAt) body.createdAt = secret.createdAt;
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  let scheme = 'file';
  let data = plain.toString('base64');
  if (dpapiAvailable()) {
    try {
      data = (await protectBytes(plain)).toString('base64');
      scheme = 'dpapi-user';
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
  for (const f of [STATE, SECRET, STATE + BAK, SECRET + BAK]) fs.rmSync(path.join(dir, f), { force: true });
}
