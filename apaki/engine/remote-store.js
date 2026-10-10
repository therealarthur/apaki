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
const ENTROPY = 'myrlin-apaki/remote/v1';
const PS_TIMEOUT_MS = 30_000;

const WHY = `# Myrlin Apaki: phone access

What this is: the files Myrlin Apaki keeps so phones you paired can reach this
PC through the Apaki relay. Apaki's engine (apaki/engine/remote.js in the
claude-latch repo) creates this folder the first time phone access is turned
on (the Phone button at the bottom of Apaki's sidebar).

- state.json: not secret. Whether phone access is on, this PC's room id and
  public key, and the paired phones (their public keys, names, when they were
  paired and last seen).
- secret.json: secret. This PC's private key, the room token and each phone's
  pairing secret, sealed with Windows DPAPI for your Windows account (only you,
  on this PC, can open it). Never share or sync it.

Safe to delete? Yes, with Apaki closed. Every paired phone stops working and
has to be paired again with a new QR code; nothing else breaks. To regenerate:
open Apaki, Phone, turn phone access on, pair again.

Written by Myrlin Apaki when phone access was first turned on. The feature
was built by Claude Code (Opus 5.5) for Arthur on 2026-10-09 (Track B, phone
access).
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

function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
  if (mode && process.platform !== 'win32') fs.chmodSync(file, mode);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Creates the folder with its note (once). */
export function ensureDir(dir = remoteDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const why = path.join(dir, '_WHY_THIS_IS_HERE.md');
  if (!fs.existsSync(why)) fs.writeFileSync(why, WHY);
  return dir;
}

/** The public state, or a fresh one: { v, enabled, roomId, pcPub, createdAt, devices: [{ id, pub, name, pairedAt, lastSeen }] }. */
export function loadState(dir = remoteDir()) {
  const s = readJson(path.join(dir, STATE));
  if (!s || s.v !== 1) return { v: 1, enabled: false, roomId: null, pcPub: null, createdAt: null, devices: [] };
  return { v: 1, enabled: Boolean(s.enabled), roomId: s.roomId || null, pcPub: s.pcPub || null, createdAt: s.createdAt || null, devices: Array.isArray(s.devices) ? s.devices : [] };
}

export function saveState(state, dir = remoteDir()) {
  ensureDir(dir);
  const devices = state.devices.map(({ id, pub, name, pairedAt, lastSeen }) => ({ id, pub, name, pairedAt, lastSeen: lastSeen || null }));
  writeAtomic(path.join(dir, STATE), `${JSON.stringify({ v: 1, enabled: state.enabled, roomId: state.roomId, pcPub: state.pcPub, createdAt: state.createdAt, devices }, null, 2)}\n`);
}

/**
 * The secrets: { identity, token, psks: { [deviceId]: psk } }, or null when
 * there are none yet. Throws when the file is there but cannot be opened
 * (another Windows account, a copied folder).
 */
export async function loadSecret(dir = remoteDir()) {
  const f = readJson(path.join(dir, SECRET));
  if (!f) return null;
  let bytes;
  if (f.scheme === 'dpapi-user') bytes = await unprotectBytes(Buffer.from(String(f.data || ''), 'base64'));
  else if (f.scheme === 'file') bytes = Buffer.from(String(f.data || ''), 'base64');
  else throw new Error(`unknown secret scheme ${f.scheme}`);
  const s = JSON.parse(bytes.toString('utf8'));
  return { identity: s.identity, token: s.token, psks: s.psks || {}, scheme: f.scheme };
}

/** Saves the secrets, sealed with DPAPI where possible. Returns the scheme used. */
export async function saveSecret(secret, dir = remoteDir()) {
  ensureDir(dir);
  const plain = Buffer.from(JSON.stringify({ identity: secret.identity, token: secret.token, psks: secret.psks || {} }), 'utf8');
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
  writeAtomic(path.join(dir, SECRET), `${JSON.stringify({ v: 1, scheme, data })}\n`, 0o600);
  return scheme;
}

/** Removes everything phone access saved (used by "forget all"). The note stays with the folder. */
export function wipe(dir = remoteDir()) {
  for (const f of [STATE, SECRET]) fs.rmSync(path.join(dir, f), { force: true });
}
