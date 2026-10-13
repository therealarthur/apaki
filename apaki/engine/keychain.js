/**
 * keychain.js: the macOS Keychain as the place Apaki's phone-access secrets are sealed (the Mac's answer to DPAPI).
 *
 * WHY (Arthur, 2026-10-12, "start working on the mac port"): on Windows remote-store.js seals secret.json with DPAPI
 * for the current user, so a copied folder or backup opens nowhere else. A Mac has no DPAPI; the equivalent is the login
 * Keychain, which only this macOS user (with the keychain unlocked) can read.
 *
 * How: one random 256-bit key lives in the login Keychain as a generic password
 * (service io.myrlin.apaki.remote, account secret-key-v1). secret.json holds the secrets sealed with that key
 * (AES-256-GCM, scheme "keychain-aes", the same Apaki-specific context string DPAPI uses as entropy). The file keeps
 * all of remote-store's durability (atomic writes, .bak copies, backups before replacing), and the Keychain is asked
 * once per process, not on every write. If the Keychain item is gone or the keychain is locked, the file cannot be
 * opened and the status says "locked" (the same path as a DPAPI that will not unseal): phone access retries by itself
 * and offers Start over, and the secrets are never replaced behind the person's back.
 *
 * No native module: the `security` command line that ships with macOS. The key never appears on a command line: it
 * goes in through `security -i` on stdin (a process list shows only "security -i") and comes out on stdout. The item
 * is created by /usr/bin/security, so security itself may read it without a prompt; nothing else is trusted.
 *
 * Everything that talks to the system goes through `run(args, stdin)`, so the tests (test/apaki-keychain.test.js) use
 * a fake Keychain on any OS. APAKI_KEYCHAIN_SERVICE names another item (a test or a second build that must not share
 * the installed app's key); the engine's own tests and APAKI_REMOTE_DIR use it the way they use a temp folder.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

export const SECURITY_BIN = '/usr/bin/security';
export const KEYCHAIN_SERVICE = 'io.myrlin.apaki.remote';
export const KEYCHAIN_ACCOUNT = 'secret-key-v1';
/** security's exit codes: item not found, item already exists. */
const NOT_FOUND = 44;
const EXISTS = 45;
const CONTEXT = 'myrlin-apaki/remote/v1';
const TIMEOUT_MS = 20_000;

/** A failure the caller can tell from a missing item: code 'locked' (keychain locked, no access) or 'missing'. */
export class KeychainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeychainError';
    this.code = code;
  }
}

/** The real runner: /usr/bin/security with these arguments, stdin written when given. Resolves { code, stdout, stderr }. */
export function runSecurity(args, stdin = null) {
  return new Promise((resolve) => {
    const child = execFile(SECURITY_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    child.stdin?.on('error', () => { /* the exit code tells */ });
    if (stdin !== null) child.stdin?.end(stdin); else child.stdin?.end();
  });
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * A Keychain-backed sealer. `run` is injectable; the key is cached in memory after the first successful read, so the
 * Keychain is asked once per process.
 */
export function createKeychain({ run = runSecurity, service = process.env.APAKI_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT } = {}) {
  let cached = null;

  const read = async () => {
    const r = await run(['find-generic-password', '-a', account, '-s', service, '-w']);
    if (r.code === 0) {
      const hex = r.stdout.trim().toLowerCase();
      if (!HEX_KEY.test(hex)) throw new KeychainError('missing', 'the Keychain item for phone access holds something other than Apaki\'s key');
      return Buffer.from(hex, 'hex');
    }
    if (r.code === NOT_FOUND) return null;
    throw new KeychainError('locked', `the Keychain would not open (security exit ${r.code}${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''})`);
  };

  /** Adds the key if there is none. Returns once an item exists; a lost race (item already there) is fine. */
  const create = async () => {
    const key = crypto.randomBytes(32);
    // security -i reads its commands from stdin: the key is on no command line. No -U: never overwrite a key another process just made.
    const r = await run(['-i'], `add-generic-password -a ${account} -s ${service} -w ${key.toString('hex')}\n`);
    key.fill(0);
    // In interactive mode security reports a failure on stderr and may still exit 0, so the read below is the check.
    if (r.code !== 0 && r.code !== EXISTS) throw new KeychainError('locked', `could not save the key to the Keychain (security exit ${r.code})`);
  };

  /** The 32-byte key; makes it when `make` and there is none. */
  const key = async ({ make = false } = {}) => {
    if (cached) return cached;
    let k = await read();
    if (!k && make) {
      await create();
      k = await read();
    }
    if (!k) throw new KeychainError('missing', make ? 'the key was not saved to the Keychain' : 'the Keychain item for phone access is gone');
    cached = k;
    return k;
  };

  return {
    /** Seals bytes: iv(12) | tag(16) | ciphertext. */
    async protect(bytes) {
      const k = await key({ make: true });
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', k, iv);
      c.setAAD(Buffer.from(CONTEXT));
      const ct = Buffer.concat([c.update(bytes), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    /** Opens what protect() sealed; throws when the key is gone or the data is not ours. */
    async unprotect(sealed) {
      const buf = Buffer.from(sealed);
      if (buf.length < 12 + 16 + 1) throw new KeychainError('missing', 'sealed data is too short');
      const k = await key({ make: false });
      const d = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
      d.setAAD(Buffer.from(CONTEXT));
      d.setAuthTag(buf.subarray(12, 28));
      try {
        return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
      } catch {
        throw new KeychainError('missing', 'the Keychain key does not open this file (it was sealed with another key)');
      }
    },
    /** Forgets the in-memory key (tests). */
    forget() { cached = null; },
  };
}
