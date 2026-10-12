/**
 * console.js: a pane's conversation in its real terminal UI, inside the pane or in a terminal window (2026-10-12).
 *
 * WHY (Arthur, 2026-10-12): "we want a toggle console that transitions a pane to console for either claude or codex
 * SEAMLESSLY like super cleanly, as if our ui was right on top of it. should be toggleable/reversable. should be the
 * authentic tui experience." And: "users should also have no issue running any of the claude code commands like codex,
 * to then see the expected ui/ux experience that they normally can interact with to set settings, etc." And: "there
 * should also be an "open in terminal" button to just open the exact session with all settings/effort/models/etc in a
 * terminal window".
 *
 * So a pane can flip to `claude --resume <id>` or `codex resume <id>` running in a pseudo-terminal (node-pty, ConPTY on
 * Windows) that the window draws with xterm.js, and flip back with nothing lost. The same command opens in an outside
 * terminal window too (Windows Terminal, else PowerShell), through apaki/bin/apaki-terminal.mjs.
 *
 * One writer per conversation, always. Before the TUI starts, the pane's own Claude Code process (or its Codex thread)
 * is idle and let go; while the TUI runs, the engine holds the session's lock for it (src/sessions.js, app
 * 'apaki-console'), so another window or a phone sees the conversation in use. When the TUI ends (its own quit: Ctrl+C
 * twice; ended by PID only if it does not exit), the pane takes the conversation back and reads the transcript again,
 * so everything typed in the TUI is there.
 *
 * Billing (Arthur's notes, 2026-10-09): interactive Claude Code on Platform (API key) credits is refused with
 * billing_error while headless runs work. A pane billed to a key therefore runs the TUI on the live login with the
 * prompt-relay hook (hooks/prompt-relay.js), exactly like `latch <id> --relay`: each message typed there runs headless
 * on the pane's key and its reply shows in the TUI. Without the hook the console says so plainly.
 *
 * Pieces, each testable with fakes (test/apaki-console.test.js):
 *   claudeCommand, codexCommand   the one command builder the console and "Open in terminal" share
 *   terminalLaunch                how an outside terminal window is started on this platform
 *   createConsoles                the running TUIs: pty, output batching, replay for a window that reloads, quit
 *   createConsoleControl          the ownership handoff around them (engine.js gives it the real pane functions)
 *
 * Events (engine.js header has the op list):
 *   ev console     { paneId, sessionId, kind, state, reqId?, pid?, cols?, rows?, display?, note?, tone?, relay?, seq?, replay?, exitCode?, command? }
 *                  state: 'turn' (a turn runs in the pane: wait or stop?), 'waiting', 'starting', 'running',
 *                  'busy' (asked to close while the TUI works: wait or stop?), 'closing', 'closed', 'error'
 *   ev consoleData { paneId, data, seq }   the TUI's output, batched (about one event per frame)
 *   ev consoleView { paneId, sessionId, state, text, at }   a plain-text look at a console (the phone's read-only view)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { claudeArgs } from '../../src/launch.js';
import { PRESETS } from './codex-map.js';

const require = createRequire(import.meta.url);

/** Terminal size limits (cells): what a pane can be, and nothing a bad message could use to make a huge buffer. */
export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 4;
export const MAX_ROWS = 200;
/** Raw output kept for a window that reloads, when @xterm/headless is not installed (characters). */
export const REPLAY_CHARS = 2 * 1024 * 1024;
/** One input message's most characters (a large paste is fine; a runaway one is not). */
export const MAX_INPUT = 1024 * 1024;
/** Output is sent at most this often per console, and in pieces of at most this many characters. */
export const FLUSH_MS = 8;
export const FLUSH_CHARS = 64 * 1024;
/** A TUI is working when it drew within this long and its screen says "esc to interrupt" (both Claude Code and Codex). */
export const BUSY_QUIET_MS = 1500;

/**
 * Claude Code commands that only work in its terminal UI (the SDK answers "isn't available in this environment"),
 * so a pane opens the console for them instead (pane.js). `model` and friends only without an argument: with one,
 * Apaki sets it itself.
 */
export const CLAUDE_TUI_COMMANDS = Object.freeze([
  'config', 'settings', 'permissions', 'allowed-tools', 'mcp', 'agents', 'hooks', 'memory', 'login', 'logout', 'status',
  'doctor', 'ide', 'terminal-setup', 'theme', 'vim', 'statusline', 'plugin', 'plugins', 'help', 'usage', 'stats',
  'rewind', 'checkpoint', 'export', 'bashes', 'tasks', 'privacy-settings', 'install-github-app', 'upgrade',
  'release-notes', 'feedback', 'bug', 'output-style', 'keybindings', 'extra-usage', 'todos', 'add-dir', 'cost',
]);
/** The same, only when typed without an argument (Apaki handles them with one). */
export const CLAUDE_TUI_BARE = Object.freeze(['model', 'effort']);
/** Codex's interactive commands (its pickers and settings screens). */
export const CODEX_TUI_COMMANDS = Object.freeze([
  'experimental', 'skills', 'statusline', 'theme', 'personality', 'logout', 'apps', 'feedback', 'ps', 'debug-config',
  'setup-elevated-sandbox', 'agent', 'collab', 'rollout', 'settings',
]);
export const CODEX_TUI_BARE = Object.freeze(['model', 'approvals', 'permissions']);

/** True when a slash command typed in a pane belongs in the console: '/config', '/model' without an argument, and so on. */
export function tuiCommand(kind, text) {
  const m = /^\/([A-Za-z][\w-]*)(?:\s+(.*))?$/s.exec(String(text || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  const [always, bare] = kind === 'codex' ? [CODEX_TUI_COMMANDS, CODEX_TUI_BARE] : [CLAUDE_TUI_COMMANDS, CLAUDE_TUI_BARE];
  if (always.includes(name) || (!arg && bare.includes(name))) return `/${name}${arg ? ` ${arg}` : ''}`;
  return null;
}

/* ---------- the command (shared by the console and Open in terminal) ---------- */

const SAFE_VALUE_RE = /^[A-Za-z0-9._:[\]/-]{1,80}$/;

/**
 * The prompt-relay hook as Claude Code settings (UserPromptSubmit and SessionStart), the same shape latch's
 * relayHookSettings passes with --settings (bin/latch.js), for a hook script at `file`.
 */
export function relayHooks(file) {
  const command = `node "${String(file).replace(/\\/g, '/')}"`;
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 3600 }] }],
    SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command, timeout: 10 }] }],
  };
}

/** Whether the user's own Claude Code settings already run a prompt-relay hook (then it is not added twice). Read only. */
export function userHasRelayHook(file) {
  try { return /prompt-relay/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

/**
 * A settings JSON for --settings, written once under `dir` and named by its content, so the same settings reuse one
 * file and a file in use is never rewritten. Holds no secrets (hooks and Apaki's own settings only).
 */
export function settingsFile(dir, settings) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const name = `settings-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`;
  const file = path.join(dir, name);
  ensureDir(dir);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text);
  return file;
}

/** The folder for the console's files, with its note (Arthur's provenance rule: every folder Apaki makes says why). */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const why = path.join(dir, '_WHY_THIS_IS_HERE.md');
  if (!fs.existsSync(why)) {
    try {
      fs.writeFileSync(why, [
        '# console',
        '',
        'Made by Myrlin Apaki\'s engine (apaki/engine/console.js) for its console and "Open in terminal".',
        '',
        '- settings-<hash>.json: Claude Code settings passed with --settings to a console or terminal window (Apaki\'s',
        '  auto-compact choice, and the prompt-relay hook for a pane billed to an API key). Named by content; no secrets.',
        '- terminal-<id>.json: what one "Open in terminal" window runs; apaki/bin/apaki-terminal.mjs reads and deletes it.',
        '- held-<id>.json: a terminal window that has a conversation open (its pid), so Apaki does not write over it.',
        '',
        'Safe to delete when Apaki is closed; it is made again as needed.',
        '',
      ].join('\n'));
    } catch { /* the note is best effort */ }
  }
  return dir;
}

/**
 * The real Claude Code TUI on a pane's conversation.
 * @param {object} o
 * @param {string|null} o.bin           claude.exe (src/launch.js claudeBinary)
 * @param {string|null} o.sessionId     the conversation; null for a new one (then newSessionId names it)
 * @param {string|null} [o.newSessionId]
 * @param {string} [o.model] @param {string} [o.effort] @param {string} [o.mode]   the pane's picks
 * @param {object|null} [o.flagSettings] Apaki's per-process settings (prefs.js compactSettings), as for the SDK
 * @param {{ name, key, source }} o.credential  the pane's billing
 * @param {string|null} [o.hookFile]    the packaged prompt-relay hook, if there is one
 * @param {boolean} [o.userHook]        the user's settings already run a prompt-relay hook
 * @param {number|null} [o.holderPid]   the process that holds the session's lock (the relay hook checks it)
 * @param {string} [o.nodeDir]          the folder of the Node to put first on PATH (the hook runs `node`)
 * @param {string} o.settingsDir        where settings files go
 * @param {string} [o.defaultKeyWords]  a vault key's words when the credential has no name
 * @returns {{ kind, file, args, envSet, envUnset, pathPrepend, relay, note, tone, display } | { error }}
 */
export function claudeCommand(o) {
  if (!o.bin) return { error: 'Claude Code was not found on this PC (no claude.exe), so there is no terminal UI to open.' };
  let args;
  try {
    args = claudeArgs({ sessionId: o.sessionId || null, model: o.model, effort: o.effort, permissionMode: o.mode });
  } catch (e) {
    return { error: e.message };
  }
  if (!o.sessionId && o.newSessionId) args.push('--session-id', o.newSessionId);
  const credential = o.credential || {};
  // The live login is a subscription unless Glass made a key live; any key is relayed (interactive refuses it).
  const relayed = Boolean(credential.source) && credential.source !== 'subscription';
  const envSet = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // The TUI is an interactive window: the relay hook must run there (childEnv sets PROMPT_RELAY_CHILD for SDK children).
  const envUnset = ['PROMPT_RELAY_CHILD', 'CLAUDE_AGENT_SDK_CLIENT_APP'];
  if (o.holderPid) envSet.LATCH_LOCK_PID = String(o.holderPid);
  const settings = { ...(o.flagSettings && typeof o.flagSettings === 'object' ? o.flagSettings : {}) };
  let via = null;
  let pathPrepend = null;
  if (relayed) {
    envSet.PROMPT_RELAY_FORCE = '1';
    // '' = the live Glass key; a vault key by its heading words.
    envSet.PROMPT_RELAY_KEY_WORDS = credential.source === 'glass' ? '' : (credential.name || o.defaultKeyWords || '');
    if (o.userHook) via = 'user';
    else if (o.hookFile) {
      settings.hooks = relayHooks(o.hookFile);
      via = 'hook';
      envSet.PROMPT_RELAY_CLAUDE_BIN = o.bin;
      pathPrepend = o.nodeDir || null;
    }
  }
  if (Object.keys(settings).length) args.push('--settings', settingsFile(o.settingsDir, settings));
  const name = credential.name || 'an API key';
  const note = !relayed ? null
    : via ? `This pane bills ${name}. Interactive Claude Code needs a subscription login, so each message you type here runs headless on ${name} through the prompt-relay hook, and its reply shows here. Commands like /config run in the console itself.`
      : `This pane bills ${name}, an API key, and interactive Claude Code refuses API-key credits. Commands like /config work here; to chat in the console, switch this pane's billing to a subscription.`;
  return {
    kind: 'claude', file: o.bin, args, envSet, envUnset, pathPrepend,
    relay: relayed ? { name, via } : null, note, tone: relayed && !via ? 'warn' : 'info',
    display: ['claude', ...args.map((a, i) => (args[i - 1] === '--settings' ? '<settings>' : a))].join(' '),
  };
}

/**
 * The real Codex TUI on a pane's thread: `codex resume <id>` (or `codex` for a new one) with the pane's model, effort,
 * and permission preset (codex-map.js PRESETS: -a approvals, -s sandbox).
 * @param {object} o
 * @param {{ command: string, args: string[] }|null} o.codex   codex-client.js findCodex()
 * @param {string|null} o.threadId @param {string} [o.model] @param {string} [o.effort] @param {string} [o.mode] @param {string} [o.cwd]
 */
export function codexCommand(o) {
  if (!o.codex) return { error: 'Codex is not installed on this PC (no codex command was found). Install it with npm install -g @openai/codex.' };
  const args = [...(o.codex.args || [])];
  if (o.threadId) {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(o.threadId)) return { error: 'That is not a Codex thread id.' };
    args.push('resume', o.threadId);
  }
  if (o.model) {
    if (!SAFE_VALUE_RE.test(o.model)) return { error: `refusing an unexpected model: ${o.model}` };
    args.push('-m', o.model);
  }
  if (o.effort) {
    if (!/^[a-z0-9_-]{1,24}$/.test(o.effort)) return { error: `refusing an unexpected effort: ${o.effort}` };
    args.push('-c', `model_reasoning_effort="${o.effort}"`);
  }
  const preset = o.mode && Object.prototype.hasOwnProperty.call(PRESETS, o.mode) ? PRESETS[o.mode] : null;
  if (preset) args.push('-a', preset.approvalPolicy, '-s', preset.sandbox);
  if (o.cwd) args.push('-C', o.cwd);
  return {
    kind: 'codex', file: o.codex.command, args, envSet: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, envUnset: [], pathPrepend: null,
    relay: null, note: null, tone: 'info', display: ['codex', ...args.slice((o.codex.args || []).length)].join(' '),
  };
}

/** An environment for the TUI: `base` (already stripped of auth sources, src/auth.js childEnv) with the command's changes. */
export function applyEnv(base, { envSet = {}, envUnset = [], pathPrepend = null } = {}) {
  const env = { ...base };
  for (const k of envUnset) delete env[k];
  Object.assign(env, envSet);
  if (pathPrepend) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = `${pathPrepend}${path.delimiter}${env[key] || ''}`;
  }
  return env;
}

/* ---------- an outside terminal window ---------- */

/** A PowerShell single-quoted string. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * How to open a terminal window that runs `file args` in `cwd` on this platform: Windows Terminal when it is there,
 * else PowerShell in its own console window; Terminal on a Mac; x-terminal-emulator elsewhere.
 * @returns {{ cmd, args, cwd?, fallback? } | null}
 */
export function terminalLaunch(platform, { cwd, title = 'Claude Code', file, args = [] }) {
  if (platform === 'win32') {
    const ps = { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}; & ${[file, ...args].map(psQuote).join(' ')}`], cwd };
    // Windows Terminal splits its command line at ';' (a new tab): such a path goes through PowerShell instead.
    if ([cwd, title, file, ...args].some((a) => String(a).includes(';'))) return ps;
    return { cmd: 'wt.exe', args: ['-w', 'new', 'new-tab', '-d', cwd, '--title', title, '--', file, ...args], fallback: ps };
  }
  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const line = `cd ${sh(cwd)} && ${[file, ...args].map(sh).join(' ')}`;
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'] };
  return { cmd: 'x-terminal-emulator', args: ['-e', 'sh', '-c', line], cwd };
}

/* ---------- a terminal window that holds a conversation (Open in terminal) ---------- */

/** True while process `pid` runs (EPERM: it runs as someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The file that says a terminal window has this conversation open: held-<id>.json (a Codex id's colon made safe). */
export const heldFile = (dir, sessionId) => path.join(dir, `held-${String(sessionId).replace(/[^A-Za-z0-9-]/g, '-')}.json`);

/**
 * The terminal window (apaki/bin/apaki-terminal.mjs) that has this conversation open, as a lock holder the pane's
 * "in use" and "taken over" cards can show, or null when none is alive. A record left by a window that is gone is removed.
 */
export function readHeld(dir, sessionId, alive = pidAlive) {
  if (!sessionId) return null;
  const file = heldFile(dir, sessionId);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!rec || rec.sessionId !== sessionId || !alive(rec.pid)) {
    try { fs.unlinkSync(file); } catch { /* gone */ }
    return null;
  }
  return { ...rec, alive: true, name: 'a terminal window (Open in terminal)', app: 'apaki-terminal' };
}

/** Records that process `pid` (the terminal window's runner) has the conversation open. */
export function writeHeld(dir, { sessionId, kind, pid, cwd = '' }) {
  ensureDir(dir);
  fs.writeFileSync(heldFile(dir, sessionId), JSON.stringify({ sessionId, kind, pid, cwd, at: new Date().toISOString() }));
}

/** Removes the record, if it is still this process's. */
export function clearHeld(dir, sessionId, pid) {
  try {
    const file = heldFile(dir, sessionId);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rec.pid === pid) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

/**
 * Apaki takes the conversation back from a terminal window (Take it back): the record says so, and the window's
 * runner, which checks every second, stops its TUI with a note before it can write again. Resolves true once the
 * window let go (or was already gone), false after waitMs.
 */
export async function takeBackHeld(dir, sessionId, { by = process.pid, waitMs = 5000, alive = pidAlive } = {}) {
  const file = heldFile(dir, sessionId);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return true; }
  if (!alive(rec.pid)) { try { fs.unlinkSync(file); } catch { /* gone */ } return true; }
  try { fs.writeFileSync(file, JSON.stringify({ ...rec, takenBy: { pid: by, at: new Date().toISOString() } })); } catch { /* it just went */ }
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(200);
    if (!fs.existsSync(file) || !alive(rec.pid)) return true;
  }
  return false;
}

/** The node-pty module, or { error } when it is not installed (npm install in the repo). */
export function loadNodePty() {
  try {
    return require('node-pty');
  } catch (e) {
    return { error: `The console needs node-pty, which is not installed with this copy of Apaki (${e.code || e.message}). Run npm install in the Apaki folder.` };
  }
}

/** @xterm/headless with its serializer, when installed: an exact screen for a window that reloads and for the phone. */
function loadHeadless() {
  try {
    const { Terminal } = require('@xterm/headless');
    const { SerializeAddon } = require('@xterm/addon-serialize');
    return { Terminal, SerializeAddon };
  } catch {
    return null;
  }
}

/* ---------- the running TUIs ---------- */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Plain text from raw terminal output: escape sequences gone, each line as its last carriage return left it. */
export function plainText(raw, maxLines = 60) {
  const lines = String(raw || '').replace(ANSI_RE, (m) => (m === '\r' ? '\r' : '')).split('\n').map((l) => {
    const parts = l.split('\r');
    return parts.reverse().find((x) => x.trim()) || '';
  });
  return lines.slice(-maxLines).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

export const clampCols = (n) => Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(Number(n)) || 100));
export const clampRows = (n) => Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(Number(n)) || 30));

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The TUIs running in panes, one per pane at most.
 * @param {object} o
 * @param {(ev: object) => void} o.emit
 * @param {() => object} [o.loadPty]     node-pty, or { error } (tests give a fake)
 * @param {() => object|null} [o.headless]  @xterm/headless and its serializer, or null
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {object} [o.timing]  { flushMs, quitStepMs, quitWaitMs, killWaitMs, readyQuietMs, readyMaxMs } (tests shorten them)
 */
export function createConsoles({ emit, loadPty = loadNodePty, headless = loadHeadless, log = () => {}, now = Date.now, timing = {} } = {}) {
  const t = { flushMs: FLUSH_MS, quitStepMs: 150, quitWaitMs: 1800, killWaitMs: 2500, readyQuietMs: 500, readyMaxMs: 10000, ...timing };
  /** paneId -> console */
  const live = new Map();
  let ptyMod = null;
  let headlessMod;

  function pty() {
    if (!ptyMod || ptyMod.error) ptyMod = loadPty();
    return ptyMod;
  }

  /** The base fields of every event about a console. */
  const base = (con) => ({ ev: 'console', paneId: con.paneId, sessionId: con.sessionId, kind: con.kind });

  function flush(con) {
    con.timer = null;
    while (con.pending) {
      const data = con.pending.slice(0, FLUSH_CHARS);
      con.pending = con.pending.slice(data.length);
      con.seq += 1;
      emit({ ev: 'consoleData', paneId: con.paneId, data, seq: con.seq });
    }
  }

  function onData(con, data) {
    const s = String(data);
    con.lastOutputAt = now();
    con.sawOutput = true;
    if (con.term) con.term.write(s);
    else {
      con.raw += s;
      if (con.raw.length > REPLAY_CHARS * 1.25) con.raw = con.raw.slice(con.raw.length - REPLAY_CHARS);
    }
    con.tail = (con.tail + s).slice(-8000);
    con.pending += s;
    if (con.pending.length >= FLUSH_CHARS) { if (con.timer) clearTimeout(con.timer); flush(con); return; }
    if (!con.timer) con.timer = setTimeout(() => flush(con), t.flushMs);
  }

  /** What the TUI's screen says now, as plain text. */
  function screen(con, lines = 60) {
    if (con.term) {
      const b = con.term.buffer.active;
      const out = [];
      const end = b.baseY + con.term.rows;
      for (let y = Math.max(0, end - lines); y < end; y++) out.push(b.getLine(y)?.translateToString(true) || '');
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    }
    return plainText(con.tail, lines);
  }

  /** A turn is running in the TUI: it drew a moment ago and its screen says "esc to interrupt". */
  function busy(paneId) {
    const con = live.get(paneId);
    if (!con || con.exited) return false;
    if (now() - con.lastOutputAt > BUSY_QUIET_MS) return false;
    const text = con.term ? screen(con, 12) : plainText(con.tail.slice(-2500), 12);
    return /esc to interrupt/i.test(text);
  }

  /**
   * Starts a TUI for a pane. Throws when it cannot start (no node-pty, the program would not run).
   * @param {string} paneId
   * @param {object} o  { sessionId, kind, spec (claudeCommand / codexCommand), env, cwd, cols, rows, reqId, type (text to type once it is ready), onExit(info) }
   */
  function start(paneId, o) {
    const mod = pty();
    if (mod.error) throw new Error(mod.error);
    const cols = clampCols(o.cols);
    const rows = clampRows(o.rows);
    const proc = mod.spawn(o.spec.file, o.spec.args, { name: 'xterm-256color', cols, rows, cwd: o.cwd, env: o.env });
    const con = {
      paneId, sessionId: o.sessionId || null, kind: o.kind, pty: proc, pid: proc.pid, cols, rows, seq: 0, pending: '', timer: null,
      raw: '', tail: '', term: null, serializer: null, lastOutputAt: 0, sawOutput: false, startedAt: now(), exited: false, exitInfo: null,
      exitWaiters: [], closing: false, display: o.spec.display, note: o.spec.note || null, tone: o.spec.tone || 'info', relay: o.spec.relay || null,
      newSessionId: o.newSessionId || null, cwd: o.cwd,
    };
    if (headlessMod === undefined) headlessMod = headless();
    if (headlessMod) {
      try {
        con.term = new headlessMod.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
        con.serializer = new headlessMod.SerializeAddon();
        con.term.loadAddon(con.serializer);
      } catch (e) { log(`console: headless terminal unavailable (${e.message})`); con.term = null; con.serializer = null; }
    }
    live.set(paneId, con);
    proc.onData((d) => onData(con, d));
    proc.onExit(({ exitCode, signal } = {}) => {
      if (con.timer) { clearTimeout(con.timer); flush(con); }
      con.exited = true;
      con.exitInfo = { exitCode: exitCode ?? null, signal: signal ?? null };
      if (live.get(paneId) === con) live.delete(paneId);
      try { con.term?.dispose(); } catch { /* gone */ }
      for (const w of con.exitWaiters.splice(0)) w(con.exitInfo);
      log(`console: ${con.kind} TUI for pane ${paneId} (pid ${con.pid}) exited ${exitCode}`);
      Promise.resolve(o.onExit?.(con.exitInfo, con)).catch((e) => log(`console: after exit: ${e.message}`));
    });
    emit({ ...base(con), state: 'running', reqId: o.reqId || null, pid: con.pid, cols, rows, display: con.display, note: con.note, tone: con.tone, relay: con.relay, seq: 0, fresh: true });
    if (o.type) typeWhenReady(con, String(o.type));
    return con;
  }

  /** Types a command once the TUI has drawn and gone quiet (its prompt is up), e.g. '/config' from the pane. */
  async function typeWhenReady(con, text) {
    const t0 = now();
    while (!con.exited && now() - t0 < t.readyMaxMs) {
      if (con.sawOutput && now() - con.lastOutputAt >= t.readyQuietMs) break;
      await sleep(Math.min(100, t.readyQuietMs));
    }
    if (con.exited) return;
    con.pty.write(text);
    await sleep(60);
    if (!con.exited) con.pty.write('\r');
  }

  function input(paneId, data) {
    const con = live.get(paneId);
    if (!con || con.exited || typeof data !== 'string' || !data) return false;
    con.pty.write(data.length > MAX_INPUT ? data.slice(0, MAX_INPUT) : data);
    return true;
  }

  function resize(paneId, cols, rows) {
    const con = live.get(paneId);
    if (!con || con.exited) return false;
    const c = clampCols(cols);
    const r = clampRows(rows);
    if (c === con.cols && r === con.rows) return true;
    con.cols = c; con.rows = r;
    try { con.pty.resize(c, r); } catch (e) { log(`console: resize: ${e.message}`); }
    try { con.term?.resize(c, r); } catch { /* the replay copy only */ }
    return true;
  }

  /**
   * A window that came back (a reload, a reconnect): the console's state and its screen, so the terminal draws
   * where it was. With @xterm/headless the screen is exact; without it the raw output is replayed and the TUI is
   * asked to draw again (a resize nudge).
   */
  function replay(paneId, { reqId = null, cols, rows } = {}) {
    const con = live.get(paneId);
    if (!con) return false;
    if (con.timer) { clearTimeout(con.timer); flush(con); }
    let text = '';
    if (con.serializer) {
      try { text = con.serializer.serialize({ scrollback: 2000 }); } catch { text = ''; }
    } else {
      text = con.raw;
    }
    emit({
      ...base(con), state: con.closing ? 'closing' : 'running', reqId, pid: con.pid, cols: con.cols, rows: con.rows, display: con.display, note: con.note,
      tone: con.tone, relay: con.relay, seq: con.seq, replay: text, exact: Boolean(con.serializer),
    });
    if (cols && rows) resize(paneId, cols, rows);
    if (!con.serializer && !con.exited) {
      // Without an exact copy, make the TUI draw its screen again: one row less, then back.
      try { con.pty.resize(con.cols, Math.max(MIN_ROWS, con.rows - 1)); } catch { /* exited */ }
      setTimeout(() => { if (!con.exited) { try { con.pty.resize(con.cols, con.rows); } catch { /* exited */ } } }, 80);
    }
    return true;
  }

  /** Waits for a console's process to end, up to ms; resolves with its exit, or null. */
  function waitExit(con, ms) {
    if (con.exited) return Promise.resolve(con.exitInfo);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { con.exitWaiters.splice(con.exitWaiters.indexOf(done), 1); resolve(null); }, ms);
      const done = (info) => { clearTimeout(timer); resolve(info); };
      con.exitWaiters.push(done);
    });
  }

  /**
   * Ends a pane's TUI the way a person would: its own quit (Ctrl+C twice; once more in case the first cleared a draft
   * or closed a dialog), then a wait, and only if it is still there, an end by PID (node-pty ends every process in
   * that console, which this engine started). stopTurn: Esc first, which stops a running turn in both TUIs.
   */
  async function quit(paneId, { stopTurn = false } = {}) {
    const con = live.get(paneId);
    if (!con) return null;
    if (con.closing) return waitExit(con, t.quitWaitMs * 2 + t.killWaitMs + 1000);
    con.closing = true;
    emit({ ...base(con), state: 'closing', pid: con.pid });
    const write = (s) => { if (!con.exited) { try { con.pty.write(s); } catch { /* exited */ } } };
    if (stopTurn) { write('\x1b'); await sleep(t.quitStepMs * 4); }
    for (let round = 0; round < 2 && !con.exited; round++) {
      write('\x03');
      await sleep(t.quitStepMs);
      write('\x03');
      const info = await waitExit(con, t.quitWaitMs);
      if (info) return info;
    }
    if (!con.exited) {
      log(`console: ${con.kind} TUI (pid ${con.pid}) did not quit; ending it by pid`);
      try { con.pty.kill(); } catch (e) { log(`console: kill: ${e.message}`); }
      const info = await waitExit(con, t.killWaitMs);
      if (info) return info;
      // Still no exit event: the pane cannot wait forever for it.
      con.exited = true;
      con.exitInfo = { exitCode: null, signal: null, forced: true };
      if (live.get(paneId) === con) live.delete(paneId);
      for (const w of con.exitWaiters.splice(0)) w(con.exitInfo);
    }
    return con.exitInfo;
  }

  /** A console's plain text, for a look from elsewhere (the phone's read-only view). */
  function view(paneId, lines = 60) {
    const con = live.get(paneId);
    return con ? { state: con.closing ? 'closing' : 'running', text: screen(con, lines), cols: con.cols, rows: con.rows } : null;
  }

  return {
    start, input, resize, replay, quit, busy, view, waitExit,
    has: (paneId) => live.has(paneId),
    get: (paneId) => live.get(paneId) || null,
    bySession: (sessionId) => [...live.values()].find((c) => sessionId && c.sessionId === sessionId) || null,
    list: () => [...live.values()],
    /** Every console ends (the engine is exiting). */
    async shutdown() { await Promise.all([...live.keys()].map((id) => quit(id).catch(() => null))); },
  };
}

/* ---------- ownership: one writer per conversation ---------- */

/**
 * The handoff between a pane's own process and its console. engine.js gives it the real pane functions; the tests
 * give fakes (a fake runner, a fake pty).
 * @param {object} d
 * @param {(ev) => void} d.emit
 * @param {ReturnType<typeof createConsoles>} d.consoles
 * @param {(paneId) => object} d.getPane
 * @param {(p) => 'claude'|'codex'} d.kindOf
 * @param {(p) => boolean} d.turnBusy            a turn runs in the pane's own process
 * @param {(p) => Promise} d.interrupt          stops that turn
 * @param {(p) => Promise} d.release            closes the pane's own process (closeRunner; codex close) so it is not a writer
 * @param {(p, o: { kind, sessionId, cwd }) => Promise} d.reopen   the pane takes the conversation back and reads it again
 * @param {(p) => string|null} d.cwdOf
 * @param {{ take(sessionId, kind): object|null, release(sessionId, kind) }} d.lock   who else has it (null = this engine has it now)
 * @param {(p, o: { kind, sessionId, newSessionId, cwd }) => object} d.command   claudeCommand or codexCommand for this pane
 * @param {(spec) => object} d.envFor           the environment for a command
 * @param {(fn) => Promise} d.serial            runs fn in the pane's queue (no interleaving with an open or a send)
 * @param {(id) => boolean} [d.sessionExists]   a transcript exists for this session id (a new conversation made in the TUI)
 * @param {(p, id) => void} [d.adopt]           the pane takes that new session id
 * @param {(line) => void} [d.log]
 * @param {object} [d.timing]  { idlePollMs, stopWaitMs, waitMaxMs }
 */
export function createConsoleControl(d) {
  const t = { idlePollMs: 300, stopWaitMs: 20000, waitMaxMs: 30 * 60 * 1000, ...(d.timing || {}) };
  const log = d.log || (() => {});
  /** paneId -> { cancelled } while a console waits for the pane's turn to end */
  const waiting = new Map();
  /** paneId -> true while a console is being set up (released, not started yet) */
  const starting = new Set();

  async function waitIdle(p, maxMs, w) {
    const t0 = Date.now();
    while (d.turnBusy(p)) {
      if (w?.cancelled || Date.now() - t0 > maxMs) return false;
      await sleep(t.idlePollMs);
    }
    return !w?.cancelled;
  }

  /**
   * consoleOpen { paneId, cols, rows, command?, wait?, stop? }: the pane's conversation in its TUI.
   * A turn running in the pane: says so (state 'turn') unless asked to wait for it or to stop it.
   */
  async function open(c) {
    const p = d.getPane(c.paneId);
    const kind = d.kindOf(p);
    const ev = { ev: 'console', paneId: p.id, sessionId: p.sessionId || null, kind, reqId: c.reqId || null };
    if (d.consoles.has(p.id)) {
      d.consoles.replay(p.id, { reqId: c.reqId || null, cols: c.cols, rows: c.rows });
      if (c.command) d.consoles.input(p.id, `${c.command}\r`);
      return;
    }
    if (waiting.has(p.id) || starting.has(p.id)) { emit({ ...ev, state: 'waiting' }); return; }
    if (d.turnBusy(p)) {
      if (!c.wait && !c.stop) { emit({ ...ev, state: 'turn', command: c.command || null }); return; }
      const w = { cancelled: false };
      waiting.set(p.id, w);
      emit({ ...ev, state: 'waiting', stop: Boolean(c.stop) });
      try {
        if (c.stop) await d.interrupt(p);
        const ok = await waitIdle(p, c.stop ? t.stopWaitMs : t.waitMaxMs, w);
        if (!ok) { emit({ ...ev, state: 'closed', note: w.cancelled ? null : 'The turn did not end, so the console did not open.', tone: 'warn' }); return; }
      } finally {
        waiting.delete(p.id);
      }
    }
    starting.add(p.id);
    try {
      await d.serial(p, () => begin(p, kind, c));
    } finally {
      starting.delete(p.id);
    }
  }

  function emit(ev) { d.emit(ev); }

  async function begin(p, kind, c) {
    const sessionId = p.sessionId || null;
    const cwd = d.cwdOf(p) || c.cwd || os.homedir();
    const ev = { ev: 'console', paneId: p.id, sessionId, kind, reqId: c.reqId || null };
    // A turn started while this waited its turn in the queue: ask again rather than cut it off.
    if (d.turnBusy(p)) { emit({ ...ev, state: 'turn', command: c.command || null }); return; }
    emit({ ...ev, state: 'starting' });
    // One writer: the pane's own process lets go first (it resumes from the transcript afterwards).
    await d.release(p);
    if (sessionId) {
      const holder = d.lock.take(sessionId, kind);
      if (holder) {
        emit({ ...ev, state: 'error', note: `${holder.name || 'Another window'} has this conversation open${holder.pid ? ` (pid ${holder.pid})` : ''}, so the console did not open. Close it there first.`, tone: 'warn' });
        await d.reopen(p, { kind, sessionId, cwd });
        return;
      }
    }
    const newSessionId = kind === 'claude' && !sessionId ? crypto.randomUUID() : null;
    const spec = d.command(p, { kind, sessionId, newSessionId, cwd });
    const fail = async (note) => {
      if (sessionId) d.lock.release(sessionId, kind);
      emit({ ...ev, state: 'error', note, tone: 'warn' });
      await d.reopen(p, { kind, sessionId, cwd });
    };
    if (spec.error) { await fail(spec.error); return; }
    try {
      d.consoles.start(p.id, {
        sessionId, kind, spec, env: d.envFor(spec), cwd, cols: c.cols, rows: c.rows, reqId: c.reqId || null, type: c.command || null, newSessionId,
        onExit: (info, con) => ended(p, { kind, sessionId, newSessionId, cwd, info, con }),
      });
      log(`console: pane ${p.id} opened ${spec.display}`);
    } catch (e) {
      await fail(`The console could not start: ${e.message || e}`);
    }
  }

  /** The TUI ended (its own quit, the person typed /exit, or a crash): the pane takes the conversation back. */
  async function ended(p, { kind, sessionId, newSessionId, cwd, info, con }) {
    if (sessionId) d.lock.release(sessionId, kind);
    let sid = sessionId;
    // A new conversation started in the TUI: the pane adopts it once Claude Code has written it.
    if (!sid && newSessionId && d.sessionExists?.(newSessionId)) { sid = newSessionId; d.adopt?.(p, sid); }
    if (!con?.noReopen) await d.serial(p, () => d.reopen(p, { kind, sessionId: sid, cwd })).catch((e) => log(`console: reopen: ${e.message}`));
    emit({ ev: 'console', paneId: p.id, sessionId: sid, kind, state: 'closed', exitCode: info?.exitCode ?? null, forced: Boolean(info?.forced) });
  }

  /**
   * consoleClose { paneId, wait?, stop? }: back to Apaki's view. A turn running in the TUI: says so (state 'busy')
   * unless asked to wait for it or to stop it. Without a console it says closed (a window that lost track).
   */
  async function close(c) {
    const p = d.getPane(c.paneId);
    const w = waiting.get(p.id);
    if (w) { w.cancelled = true; return; }
    const con = d.consoles.get(p.id);
    if (!con) { emit({ ev: 'console', paneId: p.id, sessionId: p.sessionId || null, kind: d.kindOf(p), state: 'closed', reqId: c.reqId || null }); return; }
    if (d.consoles.busy(p.id) && !c.wait && !c.stop) { emit({ ev: 'console', paneId: p.id, sessionId: con.sessionId, kind: con.kind, state: 'busy', reqId: c.reqId || null }); return; }
    if (c.wait) {
      emit({ ev: 'console', paneId: p.id, sessionId: con.sessionId, kind: con.kind, state: 'waiting', closing: true });
      const t0 = Date.now();
      while (d.consoles.busy(p.id) && Date.now() - t0 < t.waitMaxMs && !con.exited) await sleep(t.idlePollMs * 2);
    }
    await d.consoles.quit(p.id, { stopTurn: Boolean(c.stop) });
  }

  /**
   * The pane is going (closed, or opening another conversation), or another window takes the conversation: its
   * console ends at once (a running turn is stopped). reopen false: the pane does not take the conversation back.
   */
  async function shut(p, { reopen = true } = {}) {
    const w = waiting.get(p.id);
    if (w) w.cancelled = true;
    const con = d.consoles.get(p.id);
    if (!con) return;
    if (!reopen) con.noReopen = true;
    await d.consoles.quit(p.id, { stopTurn: true });
  }

  return {
    open, close, shut,
    input: (c) => d.consoles.input(String(c.paneId), c.data),
    resize: (c) => d.consoles.resize(String(c.paneId), c.cols, c.rows),
    /** The pane has a console (running, starting or waiting to start): it is not the pane's own process that writes. */
    active: (paneId) => d.consoles.has(paneId) || starting.has(paneId),
    waiting: (paneId) => waiting.has(paneId),
  };
}
