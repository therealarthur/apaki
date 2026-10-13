/**
 * auth.js
 *
 * Picks the credential a latch session bills to and builds the environment
 * for the Claude Code process the SDK spawns.
 *
 * Order (first match wins):
 *   1. --sub: the live Claude Code login, whatever it is (no key injected).
 *   2. --key <words>: the "Anthropic API Key (...)" section of credentials.md
 *      whose heading contains the words.
 *   3. The live login, when Myrlin Glass has switched it to an API key.
 *   4. The default vault key (DEFAULT_KEY_WORDS).
 *
 * WHY the env scrub: a Machine-scope corporate ANTHROPIC_API_KEY is set on
 * this PC, and Claude Code in print/SDK mode always uses an env key. The child
 * therefore gets exactly one auth source, the one chosen here.
 *
 * Key values never leave this module except inside the child env.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glassCli } from './platform.js';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CRED_FILE = process.env.CLAUDE_CREDENTIALS_FILE || path.join(CLAUDE_DIR, 'credentials.md');
const LIVE_LOGIN_FILE = process.env.LATCH_LIVE_LOGIN_FILE || path.join(CLAUDE_DIR, '.credentials.json');
// LATCH_GLASS_CLI, else Glass's install place on this platform (src/platform.js; the Windows path is unchanged).
const GLASS_CLI = glassCli();

export const DEFAULT_KEY_WORDS = process.env.LATCH_DEFAULT_KEY || "Arthur's Org";
// Same prefixes Myrlin Glass uses to tell a usage key from a login token.
const API_KEY_PREFIXES = ['sk-ant-usr-', 'sk-ant-api'];

// Auth sources and the parent's session identity. The child must not inherit
// any of them: it gets one auth source, and it is its own session.
const STRIP_FROM_CHILD = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
]);

/** The live Claude Code login: { kind: 'key', key } for a usage key, else { kind: 'subscription' }. */
export function liveLogin(file = LIVE_LOGIN_FILE) {
  let token = '';
  try {
    const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    token = String((creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || '');
  } catch { /* unreadable: no key */ }
  return API_KEY_PREFIXES.some((p) => token.startsWith(p)) ? { kind: 'key', key: token } : { kind: 'subscription', key: null };
}

/**
 * "Anthropic API Key (...)" sections of credentials.md, admin keys excluded.
 * No credentials.md (every PC but Arthur's, 2026-10-10 fresh-install audit)
 * means no vault keys, not an error: the billing menu, the latch picker and
 * keep-warm all call this and used to fail with ENOENT on a new install.
 * Any other read error still throws, so vaultKey reports it.
 */
export function keySections(file = CRED_FILE) {
  const sections = [];
  let current = null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return sections;
    throw e;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      current = { heading: line.replace(/^#+\s*/, '').trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections.filter((s) => /anthropic/i.test(s.heading) && /api key/i.test(s.heading) && !/admin/i.test(s.heading));
}

function cleanHeading(heading) {
  return heading.replace(/\s+-\s+added\s+\S+\s*$/i, '').replace(/^Anthropic API Key\s*\((.*)\)$/i, '$1');
}

/** One vault key by heading words. Returns { name, key } or { error }. */
export function vaultKey(words, file = CRED_FILE) {
  let candidates;
  try {
    candidates = keySections(file);
  } catch (e) {
    return { error: `cannot read credentials.md: ${e.message}` };
  }
  // A PC without the vault (a fresh install): say so plainly instead of "no heading matches".
  if (!candidates.length && !fs.existsSync(file)) {
    return { error: `There is no credentials.md on this PC, so there is no "${words}" key. Bill the live login (--sub), or add the key as API credits in Myrlin Glass and switch to it there.` };
  }
  const want = words.toLowerCase();
  const hits = candidates.filter((s) => s.heading.toLowerCase().includes(want));
  const list = (secs) => secs.map((s) => `  - ${cleanHeading(s.heading)}`).join('\n');
  if (hits.length === 0) return { error: `No API key heading in credentials.md contains "${words}". Available:\n${list(candidates)}` };
  if (hits.length > 1) return { error: `"${words}" matches ${hits.length} keys, add words:\n${list(hits)}` };
  const m = hits[0].body.join('\n').match(/sk-ant-[A-Za-z0-9_-]{20,}/);
  if (!m) return { error: `"${cleanHeading(hits[0].heading)}" has no sk-ant- key in it.` };
  return { name: cleanHeading(hits[0].heading), key: m[0] };
}

/** Glass's label for the live key, else the matching vault heading, else a generic name. */
export function liveKeyName(key) {
  try {
    const r = spawnSync(GLASS_CLI, ['status', '--provider', 'claude', '--json'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const accounts = JSON.parse(r.stdout || '{}').accounts || [];
    const live = accounts.find((a) => a.provider === 'claude' && a.active && /api credits/i.test(a.plan || ''));
    if (live && live.label) return `${live.label} (Glass)`;
  } catch { /* Glass not installed or not running */ }
  try {
    const hit = keySections().find((s) => s.body.join('\n').includes(key));
    if (hit) return cleanHeading(hit.heading);
  } catch { /* no vault */ }
  return 'live API key';
}

/**
 * Chooses the credential for this run. Returns { name, key, source } where key
 * is null for the live subscription login, or { error }.
 */
export function chooseCredential({ keyWords, subscription, glass } = {}) {
  if (subscription) return { name: 'live Claude Code login', key: null, source: 'subscription' };
  if (keyWords) {
    const v = vaultKey(keyWords);
    return v.error ? v : { ...v, source: 'vault' };
  }
  if (glass === false) {
    const v = vaultKey(DEFAULT_KEY_WORDS);
    return v.error ? v : { ...v, source: 'vault' };
  }
  return glassCredential();
}

/**
 * Billing that follows Myrlin Glass: the live API key when Glass has switched
 * Claude to one, otherwise the live subscription login. `follow` tells the app
 * to re-check before every message, so a Glass swap in either direction moves
 * the conversation with it (Arthur, 2026-10-09: when Glass switches to a
 * subscription, "it just continues on subscription").
 */
export function glassCredential() {
  const live = liveLogin();
  if (live.kind === 'key') return { name: liveKeyName(live.key), key: live.key, source: 'glass', follow: true };
  return { name: 'subscription (via Glass)', key: null, source: 'subscription', follow: true };
}

/**
 * Environment for the Claude Code child. The SDK's `env` option replaces the
 * child's environment, so this copies process.env minus STRIP_FROM_CHILD and
 * adds the chosen key. PROMPT_RELAY_CHILD keeps the prompt-relay hook out.
 */
export function childEnv(key, base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (!STRIP_FROM_CHILD.has(name.toUpperCase())) env[name] = value;
  }
  if (key) env.ANTHROPIC_API_KEY = key;
  env.PROMPT_RELAY_CHILD = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'claude-latch/0.1.0';
  return env;
}
