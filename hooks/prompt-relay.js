#!/usr/bin/env node
/**
 * prompt-relay.js
 *
 * PACKAGED COPY (2026-10-10, fresh-install audit): this file is copied from
 * ~/.claude/hooks/prompt-relay.js on Arthur's PC so Myrlin Apaki's package
 * carries it (engine\hooks\prompt-relay.js). `latch --relay` hands it to the
 * Claude Code window it opens with `--settings`, so it works on a PC whose
 * Claude settings never registered it, and nothing writes ~/.claude/settings.json.
 * The one change from the original: claudeBinary() also accepts
 * PROMPT_RELAY_CLAUDE_BIN (latch sets it) and the Claude Code binary bundled
 * with the Agent SDK next to it, for PCs without a global npm Claude Code.
 * Keep the two copies in step when either changes.
 *
 * Claude Code hook (UserPromptSubmit + SessionStart). Global relay switch: while
 * it is ON, whatever you type in ANY interactive window is answered by a
 * headless `claude -p --resume <that window's own session>` run, billed to an
 * Anthropic API key from credentials.md, and the reply is shown in the window.
 *
 * WHAT:
 *   - Each relayed message resumes the window's own session, so it sees the
 *     whole conversation, and its turns are appended to the same transcript.
 *     Consecutive relayed turns read the conversation from prompt cache.
 *   - The window itself never sees the prompt (the hook blocks it), so it does
 *     not spend subscription quota while relay is on.
 *   - An interactive window keeps its conversation in memory and never re-reads
 *     its transcript. After relay is turned off, each window that relayed must
 *     run `/resume <id>` once to load the relayed turns. Until it does, this
 *     hook blocks typing there, because a reply from the stale in-memory copy
 *     would fork the transcript and drop the relayed work from history.
 *
 * MYRLIN GLASS (added 2026-10-09): Glass switches Claude Code to an API key by
 *   writing it into ~/.claude/.credentials.json as the live login, and back to
 *   a subscription with a normal login. This hook remembers which login was
 *   live and flips relay on every CHANGE: a swap to a key turns relay on with
 *   exactly that key, a swap to a subscription turns it off. The flip happens
 *   on the first prompt any session sends after the swap, and applies to every
 *   interactive window, open or opened later. Glass itself is unchanged.
 *
 * CONTROL (type as the whole prompt; the leading slash is optional):
 *   relay on [key words]   turn relay on for every interactive window. Key words
 *                          pick an "Anthropic API Key (...)" section of
 *                          credentials.md by heading text; without them the live
 *                          Glass key is used, or "Arthur's Org" when no key is live
 *   relay off              turn it off and list the windows that must /resume
 *   relay status | relay   show state, key, live login, this window's sync status
 *   relay ignore           drop this window's "must /resume" flag (its relayed
 *                          turns then fall out of its history)
 *   relay render ansi|plain|raw   how replies are drawn (default ansi: styled
 *                          markdown; plain: same layout, no escape codes)
 *   Manual on/off holds until the next Glass swap, which sets it again.
 *
 * WHY:  Arthur, 2026-10-08: "turn relay on and it gets turned on for all
 *       sessions ... messages should use this entire session's context ...
 *       continue off cache ... when relay is turned off all the work that was
 *       done with it on should still be a part of the conversation."
 *       Verified on 2026-10-08: -p --resume loads the full session; follow-up
 *       turns read ~116k tokens from cache and cost ~$0.03; resume follows the
 *       relayed branch even with the window's blocked-prompt notices beside it.
 *
 * SAFETY:
 *   - Only interactive windows relay. `claude -p` workers (entrypoint sdk-cli)
 *     and unattended sessions are left alone, so automation never moves onto
 *     an API key because relay is on.
 *   - The child gets ANTHROPIC_API_KEY set to the chosen vault key and loses
 *     the parent's session identity vars and any other auth source. The
 *     Machine-scope corporate key on this PC is therefore never used.
 *   - PROMPT_RELAY_CHILD=1 on the child makes this hook a no-op there.
 *   - While relay is on, local slash commands other than /resume, /clear and
 *     /exit are blocked: they write to the window's out-of-date branch and can
 *     win the "latest message" race that decides what /resume loads.
 *   - Fails open while relay is OFF (except the must-/resume guard). While ON,
 *     a failed relay blocks the prompt and shows the error.
 *   - Key values are never printed or written anywhere; state stores only the
 *     heading words used to pick the key.
 *
 * IO:   Hook JSON on stdin. Prints {"decision":"block","reason":...} to stop a
 *       prompt; otherwise prints nothing (SessionStart output would become
 *       context, so that path stays silent).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CRED_FILE = process.env.CLAUDE_CREDENTIALS_FILE || path.join(CLAUDE_DIR, 'credentials.md');
// Override only for tests, so a test "relay on" cannot switch real windows.
const STATE_DIR = process.env.PROMPT_RELAY_STATE_DIR || path.join(CLAUDE_DIR, 'prompt-relay');
const GLOBAL_FILE = path.join(STATE_DIR, 'relay.json');
const LOG_FILE = path.join(STATE_DIR, 'relay.log');

// The live Claude Code login Glass writes; the override exists only for tests.
const LIVE_LOGIN_FILE = process.env.PROMPT_RELAY_LIVE_LOGIN_FILE || path.join(CLAUDE_DIR, '.credentials.json');
// Glass's swap audit log, read only for the display name of the live key.
const GLASS_SWAP_LOG = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Quota', 'logs', 'swaps.jsonl');
// Same prefixes Glass's api_switch.rs uses to tell a usage key from a login token.
const API_KEY_PREFIXES = ['sk-ant-usr-', 'sk-ant-api'];
// Glass link: a swap to an API key turns relay on, a swap back turns it off.
// Briefly off on 2026-10-09, back on the same day once it was clear that
// interactive Claude Code is refused on these credits (billing_error) while
// headless runs are accepted, so on a key every window has to relay.
const FOLLOW_GLASS = true;

const DEFAULT_KEY_LABEL = "Arthur's Org";
// Relayed runs use Opus 5.5 at xhigh unless the session or window says otherwise.
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'xhigh';
// Appended to a relayed run's system prompt: nobody can answer it mid-run.
const RELAY_NOTE = 'This turn runs headless through a relay from the user\'s Claude Code window. The user cannot answer questions or approve anything until the turn ends, so if you need a decision, finish the turn by asking it plainly in your reply.';
// Stay under the hook "timeout" in settings.json (3600s) so a slow run is
// reported here instead of being killed silently by the harness.
const CHILD_TIMEOUT_MS = 58 * 60 * 1000;

const CONTROL_RE = /^\/?relay(?:\s+(on|off|status|ignore|render|warm)(?:\s+(.+?))?)?\s*$/i;
// Local commands that are safe while relay is on: they reload, leave, or
// start a new session instead of writing to the stale branch.
// While relay is on these stay in the window (they show or change the window
// itself); every other slash command, such as custom commands, skills and
// /compact, goes to the relayed run like a normal message.
const SAFE_LOCAL_COMMANDS = new Set([
  '/resume', '/clear', '/exit', '/quit', '/status', '/config', '/model', '/effort', '/help', '/cost', '/usage',
  '/mcp', '/hooks', '/permissions', '/memory', '/login', '/logout', '/doctor', '/ide', '/agents', '/vim', '/theme',
  '/export', '/add-dir', '/context', '/rewind', '/todos', '/bashes', '/statusline', '/output-style', '/plugin',
  '/release-notes', '/terminal-setup', '/privacy-settings', '/feedback', '/upgrade',
]);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SAFE_ARG_RE = /^[A-Za-z0-9._-]+$/;

// Env vars that tie a process to the parent session or pick an auth source.
// The child gets exactly one auth source: ANTHROPIC_API_KEY from the vault.
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

// Set once a relay starts, so a crash after that point blocks the prompt
// instead of letting it fall through to the stale local session.
let relayActive = false;

/* ---------- small helpers ---------- */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function block(reason) {
  // suppressOriginalPrompt (Claude Code 2.1.295 UserPromptSubmit output) drops
  // the "Original prompt: ..." echo from the notice. It does not stop Claude
  // Code putting a blocked prompt back into the input box; no hook field does,
  // which is why latch's own app (no blocking) is the default (2026-10-09).
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
  }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function appendLog(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* logging is best effort */ }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function kTokens(n) {
  return `${((n || 0) / 1000).toFixed(1)}k`;
}

/* ---------- state ---------- */

function loadGlobal() {
  return readJson(GLOBAL_FILE) || { on: false };
}

function sessionFile(sid) {
  return path.join(STATE_DIR, `session-${sid.replace(/[^\w.-]/g, '_')}.json`);
}

function loadSession(sid) {
  return readJson(sessionFile(sid));
}

function saveSession(sid, state) {
  writeJson(sessionFile(sid), state);
}

function allSessions() {
  return safeReaddir(STATE_DIR)
    .filter((n) => n.startsWith('session-') && n.endsWith('.json'))
    .map((n) => readJson(path.join(STATE_DIR, n)))
    .filter(Boolean);
}

/** The id a window must /resume to load its relayed turns. */
function reloadId(sess) {
  return sess.target || sess.sid;
}

/** Clears the must-/resume flag for every window that reloads `id`. */
function markSynced(id) {
  for (const sess of allSessions()) {
    if (sess.pending && (sess.sid === id || sess.target === id)) {
      sess.pending = false;
      sess.relays = []; // a resume loads the relayed turns from disk
      sess.syncedAt = new Date().toISOString();
      saveSession(sess.sid, sess);
    }
  }
}

/* ---------- environment checks ---------- */

/**
 * True for a person typing in a window. `claude -p` runs report entrypoint
 * sdk-cli (seen in transcripts); interactive windows report cli and
 * CLAUDE_CODE_SESSION_ATTENDED=1. Unset values are treated as interactive so a
 * build that drops the vars does not silently disable relay.
 */
function isInteractive() {
  // Tests drive the window side through `claude -p`, which is not interactive.
  if (process.env.PROMPT_RELAY_FORCE_INTERACTIVE === '1') return true;
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT;
  const attended = process.env.CLAUDE_CODE_SESSION_ATTENDED;
  if (ep && ep !== 'cli') return false;
  if (attended !== undefined && attended !== '1') return false;
  return true;
}

/* ---------- session locks (latch and Myrlin Apaki) ---------- */

const LOCK_DIR = path.join(CLAUDE_DIR, 'latch', 'locks');
const LOCK_APP_NAMES = { apaki: 'Myrlin Apaki', latch: 'latch', 'latch-relay': 'a latch terminal window' };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * The live lock holder of `sid` when it is not this window, else null. A
 * window latch opened knows its latch's pid (LATCH_LOCK_PID); any other
 * window only treats locks that name their app (written since 2026-10-09
 * evening) as held elsewhere, so an old latch's own window is never blocked.
 */
function heldElsewhere(sid) {
  let held;
  try { held = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, `${sid}.json`), 'utf8')); } catch { return null; }
  if (!held || !pidAlive(held.pid)) return null;
  const mine = Number(process.env.LATCH_LOCK_PID || 0);
  if (mine) return held.pid === mine ? null : held;
  return held.app ? held : null;
}

function heldMessage(holder, sid) {
  const who = LOCK_APP_NAMES[holder.app] || 'another latch';
  const when = holder.at ? new Date(holder.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const took = holder.takenFrom ? `took this session over${when ? ` at ${when}` : ''}` : `has this session open${when ? ` (since ${when})` : ''}`;
  return `[relay] ${who} ${took}. This window's copy stops here: typing on would fork the conversation, so nothing was sent.\n` +
    `Continue in ${who}, or close it there and run /resume ${sid} here to load everything it did.`;
}

/* ---------- transcripts ---------- */

/** Top-level session transcripts whose id starts with `prefix`, across all projects. */
function findSessionFiles(prefix) {
  const want = prefix.toLowerCase();
  const hits = [];
  for (const project of safeReaddir(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, project);
    for (const name of safeReaddir(dir)) {
      if (name.endsWith('.jsonl') && name.toLowerCase().startsWith(want)) {
        hits.push(path.join(dir, name));
      }
    }
  }
  return hits;
}

function readText(file) {
  try { return file ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

/** True when the transcript holds at least one real user or assistant message. */
function hasConversation(text) {
  return /"type":"(user|assistant)"/.test(text);
}

/** Model of the last assistant message, so relayed turns keep the window's model. */
function lastModel(text) {
  const all = [...text.slice(-1024 * 1024).matchAll(/"model":"(claude-[^"]+)"/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * The session's running cost from its last cost-state entry. A resumed run
 * restores that total and reports total_cost_usd on top of it, so the turn's
 * own cost is the difference.
 */
function lastCostTotal(text) {
  const all = [...text.matchAll(/"type":"cost-state"[^\n]*?"totalCostUSD":([0-9.eE+-]+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : 0;
}

/* ---------- API key from the vault ---------- */

/** "Anthropic API Key (...)" sections of credentials.md, admin keys excluded. */
function keySections() {
  const sections = [];
  let current = null;
  for (const line of fs.readFileSync(CRED_FILE, 'utf8').split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      current = { heading: line.replace(/^#+\s*/, '').trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections.filter((s) => /anthropic/i.test(s.heading) && /api key/i.test(s.heading) && !/admin/i.test(s.heading));
}

/** Resolves heading words to one key. Returns { heading, key } or { error }. */
function resolveKey(label) {
  let candidates;
  try {
    candidates = keySections();
  } catch (e) {
    return { error: `cannot read credentials.md: ${e.message}` };
  }
  const want = label.toLowerCase();
  const hits = candidates.filter((s) => s.heading.toLowerCase().includes(want));
  const list = candidates.map((s) => `  - ${s.heading}`).join('\n');
  if (hits.length === 0) return { error: `No Anthropic API key heading in credentials.md contains "${label}". Available:\n${list}` };
  if (hits.length > 1) return { error: `"${label}" matches ${hits.length} keys, use more words:\n${hits.map((s) => `  - ${s.heading}`).join('\n')}` };
  const m = hits[0].body.join('\n').match(/sk-ant-[A-Za-z0-9_-]{20,}/);
  if (!m) return { error: `Section "${hits[0].heading}" has no sk-ant- key in it.` };
  return { heading: hits[0].heading.replace(/\s+-\s+added\s+\S+\s*$/i, ''), key: m[0] };
}

/* ---------- the live login (Myrlin Glass) ---------- */

/**
 * What Claude Code is logged in with right now. A usage key (Glass's API
 * credit switch) gives kind "key" and the key; anything else counts as a
 * subscription. `id` changes only when the login changes kind or key, never on
 * a subscription token refresh, and holds a short hash, never the key.
 */
function liveLogin() {
  let token = '';
  try {
    const creds = JSON.parse(fs.readFileSync(LIVE_LOGIN_FILE, 'utf8'));
    token = String((creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || '');
  } catch { /* unreadable: treat as no key */ }
  if (API_KEY_PREFIXES.some((p) => token.startsWith(p))) {
    const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    return { kind: 'key', key: token, id: `key:${hash}` };
  }
  return { kind: 'subscription', key: null, id: 'subscription' };
}

/**
 * Name of the live key. Glass knows it (it matches the live login against its
 * linked keys), so ask `glass status` first; Glass's swap log is not used
 * because a failed or out-of-band switch leaves it naming the wrong key. Falls
 * back to the credentials.md heading whose key matches, then a generic name.
 */
function liveKeyName(key) {
  const glass = process.env.PROMPT_RELAY_GLASS_CLI
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Myrlin Glass', 'glass.exe');
  try {
    const r = spawnSync(glass, ['status', '--provider', 'claude', '--json'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const accounts = (JSON.parse(r.stdout || '{}').accounts) || [];
    const live = accounts.find((a) => a.provider === 'claude' && a.active && /api credits/i.test(a.plan || ''));
    if (live && live.label) return `${live.label} (Glass API credits)`;
  } catch { /* Glass not installed or not running */ }
  try {
    const hit = keySections().find((s) => s.body.join('\n').includes(key));
    if (hit) return hit.heading.replace(/\s+-\s+added\s+\S+\s*$/i, '');
  } catch { /* no vault */ }
  return 'live API key';
}

/**
 * Flips relay when the live login changed since the last prompt: on with the
 * live key after a swap to a key, off after a swap to a subscription. The
 * first run only records the current login, so installing this never flips
 * windows by itself. Returns the (possibly updated) global state.
 */
function syncWithGlass(global, live) {
  if (global.lastLiveId === live.id) return global;
  let next = { ...global, lastLiveId: live.id };
  if (global.lastLiveId !== undefined) {
    const at = new Date().toISOString();
    next = live.kind === 'key'
      ? { ...next, on: true, keyLabel: null, keyHeading: liveKeyName(live.key), source: 'glass', since: at }
      : { ...next, on: false, source: 'glass', offAt: at };
    appendLog({ ts: at, event: 'glass-swap', to: live.kind, relay: next.on ? 'on' : 'off', key: next.on ? next.keyHeading : null });
  }
  writeJson(GLOBAL_FILE, next);
  return next;
}

/** The key a relayed turn uses: chosen vault key, else the live Glass key, else the default. */
function relayKey(global, live) {
  if (global.keyLabel) return resolveKey(global.keyLabel);
  if (live.kind === 'key') return { heading: global.keyHeading || liveKeyName(live.key), key: live.key };
  return resolveKey(DEFAULT_KEY_LABEL);
}

/* ---------- the headless run ---------- */

function childEnv(apiKey) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIP_FROM_CHILD.has(key.toUpperCase())) env[key] = value;
  }
  env.ANTHROPIC_API_KEY = apiKey;
  env.PROMPT_RELAY_CHILD = '1';
  return env;
}

function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * The native Claude Code binary from the global npm install. Starting it
 * directly avoids cmd.exe, so arguments with spaces (the appended system
 * prompt) pass safely. Null means fall back to the `claude` shim via a shell.
 */
function claudeBinary() {
  // Packaged copy: latch says which binary its window runs (PROMPT_RELAY_CLAUDE_BIN).
  const given = process.env.PROMPT_RELAY_CLAUDE_BIN;
  if (given && fs.existsSync(given)) return given;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const exe = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(exe)) return exe;
  // Packaged copy: the binary the Agent SDK ships, in the package's node_modules
  // (engine\hooks\ sits next to engine\node_modules\).
  const sdk = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(sdk) ? sdk : null;
}

/** One-line description of a tool call, like the transcript lines Claude Code prints. */
function describeTool(input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? input.prompt ?? input.skill ?? '';
  return String(pick).replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** First meaningful line of a tool result, plus how many more lines there were. */
function summarizeResult(content) {
  const text = Array.isArray(content)
    ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
    : String(content ?? '');
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return '(no output)';
  const first = lines[0].replace(/\s+/g, ' ').trim().slice(0, 100);
  return lines.length > 1 ? `${first} … +${lines.length - 1} lines` : first;
}

/**
 * Runs one headless turn and resolves with the parsed outcome. Streams JSON
 * events so the tool calls of the main thread (not subagents) can be shown
 * the way Claude Code shows them.
 */
function runClaude(prompt, { args, cwd, apiKey }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let buf = '';
    let err = '';
    let final = null;
    const activity = [];
    const byId = new Map();
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, activity, ms: Date.now() - started });
    };
    const onEvent = (ev) => {
      if (ev.type === 'result') { final = ev; return; }
      if (ev.parent_tool_use_id) return; // subagent traffic
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const b of content) {
        if (ev.type === 'assistant' && b.type === 'tool_use') {
          const item = { name: b.name, detail: describeTool(b.input), result: null, isError: false };
          activity.push(item);
          byId.set(b.id, item);
        } else if (ev.type === 'user' && b.type === 'tool_result' && byId.has(b.tool_use_id)) {
          Object.assign(byId.get(b.tool_use_id), { result: summarizeResult(b.content), isError: Boolean(b.is_error) });
        }
      }
    };

    const fullArgs = ['-p', '--output-format', 'stream-json', '--verbose', ...args];
    const bin = claudeBinary();
    // Without the native binary, `claude` is an npm .cmd shim that needs a
    // shell; every arg is then a fixed flag or checked against SAFE_ARG_RE, and
    // the message always goes over stdin, never through cmd.exe.
    const child = bin
      ? spawn(bin, fullArgs, { cwd, env: childEnv(apiKey), windowsHide: true })
      : spawn('claude', fullArgs.filter((a) => a.startsWith('-') || SAFE_ARG_RE.test(a)), { cwd, env: childEnv(apiKey), windowsHide: true, shell: process.platform === 'win32' });
    timer = setTimeout(() => { timedOut = true; killTree(child); }, CHILD_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try { onEvent(JSON.parse(line)); } catch { /* not an event line */ }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `could not start claude: ${e.message}` }));
    child.on('close', (code) => {
      if (buf.trim().startsWith('{')) { try { onEvent(JSON.parse(buf.trim())); } catch { /* partial */ } }
      if (timedOut) {
        finish({ ok: false, error: `timed out after ${Math.round(CHILD_TIMEOUT_MS / 60000)} min, run killed` });
        return;
      }
      if (!final) {
        const detail = err.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***').trim().slice(-2000);
        finish({ ok: false, error: `claude exited ${code}: ${detail || 'no output'}` });
        return;
      }
      finish({
        ok: !final.is_error,
        sessionId: final.session_id || null,
        result: typeof final.result === 'string' ? final.result : '',
        error: final.is_error ? (final.result || final.subtype || 'unknown error') : null,
        usage: final.usage || {},
        cumulativeCost: typeof final.total_cost_usd === 'number' ? final.total_cost_usd : null,
        denials: Array.isArray(final.permission_denials) ? final.permission_denials : [],
      });
    });

    child.stdin.on('error', () => { /* child died early; close handler reports it */ });
    child.stdin.end(prompt);
  });
}

/* ---------- the record of relayed turns ---------- */

// Arthur, 2026-10-09: "is there no way to avoid that step [/resume]? can we
// just make sure that all responses are added to this conversation". Each
// relayed exchange is kept in the window's state until a reader that lacks it
// has been given it:
//   - the window, on its first prompt after relay turns off: the record goes
//     in as hook additionalContext, so the window continues without /resume;
//   - a relayed run, when the window wrote to its own copy in the meantime
//     (/compact, /status...): that copy is then the newest branch, the run
//     resumes it, and the record is put in front of the prompt.
const RECORD_MAX_CHARS = 60000;
const REPLY_MAX_CHARS = 12000;

function parseEntries(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

/** One-line descriptions of the tools relayed runs used between two ISO times. */
function toolsBetween(entries, fromIso, toIso) {
  const tools = [];
  for (const e of entries) {
    if (e.type !== 'assistant' || e.entrypoint === 'cli' || !e.timestamp) continue;
    if (e.timestamp < fromIso || e.timestamp > toIso) continue;
    const blocks = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      const i = b.input || {};
      const what = String(i.description || i.command || i.file_path || i.pattern || i.url || i.prompt || '').replace(/\s+/g, ' ').slice(0, 110);
      tools.push(what ? `${b.name}: ${what}` : b.name);
    }
  }
  return tools;
}

/** True when the window wrote turns (or a compaction) after `iso`, making its copy the newest branch. */
function windowWroteSince(entries, iso) {
  return entries.some((e) => e.entrypoint === 'cli' && e.timestamp && e.timestamp > iso
    && (e.type === 'user' || e.type === 'assistant' || (e.type === 'system' && e.subtype === 'compact_boundary')));
}

/** A window entry that only records a local slash command (/effort, /model, /status...) and its output. */
function isLocalCommandEntry(e) {
  if (e.type !== 'user' || !e.message) return false;
  const c = e.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : '';
  return /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(text);
}

/**
 * What the window wrote to its own copy after `iso`: 'none', 'local' (only
 * slash-command records, so the relayed branch can simply be resumed at its
 * last entry), or 'conversation' (real turns or a compaction, so the relayed
 * turns have to be carried over as a record).
 */
function windowWritesSince(entries, iso) {
  let kind = 'none';
  for (const e of entries) {
    if (e.entrypoint !== 'cli' || !e.timestamp || e.timestamp <= iso) continue;
    if (e.type === 'system' && e.subtype === 'compact_boundary') return 'conversation';
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (isLocalCommandEntry(e)) kind = 'local';
    else return 'conversation';
  }
  return kind;
}

/** Model id for a display name from /model output, e.g. "Opus 5.5" -> claude-opus-5-5. */
function modelIdFromDisplay(name) {
  const m = String(name).match(/\b(Opus|Sonnet|Haiku|Fable)\s+(\d+)(?:\.(\d+))?/i);
  return m ? `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? `-${m[3]}` : ''}` : null;
}

/**
 * The model and effort picked in the window with /model and /effort, read from
 * the command output the window records in its transcript (the window never
 * tells the hook directly). Each comes with the time it was picked.
 */
function windowChoices(entries) {
  const out = { model: null, modelAt: '', effort: null, effortAt: '' };
  for (const e of entries) {
    if (e.entrypoint !== 'cli' || e.type !== 'user' || !e.message) continue;
    const c = e.message.content;
    const text = typeof c === 'string' ? c : '';
    if (!text.includes('<local-command-stdout>')) continue;
    const effort = text.match(/effort(?: level)? (?:to|stays) (low|medium|high|xhigh|max)\b/i);
    if (effort) Object.assign(out, { effort: effort[1].toLowerCase(), effortAt: e.timestamp || '' });
    const model = text.match(/Set model to [`*]*([A-Za-z]+(?:\s+\d+(?:\.\d+)?)?)/i);
    if (model) {
      const id = modelIdFromDisplay(model[1]);
      if (id) Object.assign(out, { model: id, modelAt: e.timestamp || '' });
    }
  }
  return out;
}

/** Last model used by an assistant message, with its time. */
function lastAssistantModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && e.message && /^claude-/.test(e.message.model || '')) return { model: e.message.model, at: e.timestamp || '' };
  }
  return { model: null, at: '' };
}

/** UUID of the last main-chain entry a relayed run wrote at or after `iso`. */
function relayLeafUuid(entries, iso) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.uuid || e.isSidechain || e.entrypoint === 'cli') continue;
    if (e.timestamp && e.timestamp < iso) break;
    return e.uuid;
  }
  return null;
}

/** The relayed turns as text a model can read as part of its conversation. */
function relayRecord(relays, text, reader, transcriptPath) {
  const entries = parseEntries(text);
  const build = (limit) => relays.map((r, n) => {
    const tools = toolsBetween(entries, r.startedAt, r.endedAt);
    const toolText = tools.length
      ? `Tools used (${tools.length}):\n${tools.slice(0, 15).map((t) => `  - ${t}`).join('\n')}${tools.length > 15 ? `\n  - and ${tools.length - 15} more` : ''}\n`
      : '';
    const last = n === relays.length - 1;
    const reply = !last && r.reply.length > limit ? `${r.reply.slice(0, limit)}\n[shortened; the full reply is in the session transcript]` : r.reply;
    return `--- relayed turn ${n + 1} of ${relays.length} (${r.startedAt}) ---\nUser: ${r.prompt}\n${toolText}Assistant reply:\n${reply}`;
  }).join('\n\n');
  // Over budget: shorten older replies first; the transcript keeps them whole.
  let limit = REPLY_MAX_CHARS;
  let body = build(limit);
  while (body.length > RECORD_MAX_CHARS && limit > 400) { limit = Math.floor(limit / 2); body = build(limit); }

  const head = reader === 'window'
    ? 'While relay was on, the turns below ran in this same conversation through a headless claude -p run (billed to an API key) instead of in this window, so this window\'s copy did not have them. They are part of this conversation, in order, before the user\'s new message: treat them as your own earlier turns and continue from them.'
    : 'This window\'s copy of the conversation was changed while relay was on (for example by /compact or another local command), so the turns below are not on the branch this run resumed. They are part of this conversation, in order, before the new message: treat them as your own earlier turns.';
  const where = transcriptPath ? ` Tool results are not repeated here; read ${transcriptPath} if you need them.` : '';
  return `${head}${where}\n\n${body}`;
}

/** Hands the window extra context with its prompt (documented UserPromptSubmit output). */
function addContext(context, notice) {
  process.stdout.write(JSON.stringify({
    systemMessage: notice,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

/* ---------- terminal rendering of the relayed reply ---------- */

// The window shows a relayed reply as a hook notice, which Claude Code prints
// as plain text, so markdown arrived raw (Arthur, 2026-10-09). The hook renders
// it instead: ANSI styles in "ansi" mode, the same layout without escape codes
// in "plain" mode, untouched in "raw" mode. Display only; the transcript keeps
// the model's markdown.
const RENDER_MODES = new Set(['ansi', 'plain', 'raw']);
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function styler(ansi) {
  const wrap = (open, close) => (s) => (ansi && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), under: wrap(4, 24), code: wrap(36, 39),
    red: wrap(31, 39), green: wrap(32, 39),
  };
}

function visibleLength(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Inline markdown: `code`, **bold**, __bold__, *italic*, [text](url). Code spans are left alone inside. */
function renderInline(text, st) {
  return text.split(/(`[^`\n]+`)/).map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return st.code(part.slice(1, -1));
    return part
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `${st.under(t)} ${st.dim(`(${u})`)}`)
      .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => st.bold(t))
      .replace(/__([^_\n]+)__/g, (_, t) => st.bold(t))
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?=[^*\w]|$)/g, (_, pre, t) => pre + st.italic(t));
  }).join('');
}

/** A markdown table as aligned columns: bold header, a rule, then the rows. */
function renderTable(rows, st) {
  const cells = rows
    .filter((r, i) => i !== 1 || !TABLE_SEP_RE.test(r))
    .map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => renderInline(c.trim(), st)));
  const widths = [];
  for (const row of cells) row.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, visibleLength(c)); });
  const line = (row) => row.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - visibleLength(c)))).join('   ').trimEnd();
  const total = widths.reduce((a, w) => a + w, 0) + 3 * Math.max(0, widths.length - 1);
  return [st.bold(line(cells[0])), st.dim('─'.repeat(total)), ...cells.slice(1).map(line)];
}

/** Renders a markdown reply for the terminal. See RENDER_MODES. */
function renderMarkdown(text, mode) {
  if (mode === 'raw') return text;
  const st = styler(mode !== 'plain');
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(```|~~~)/))) {
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) out.push(`  ${st.code(lines[i])}`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      out.push(...renderTable(rows, st));
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const title = renderInline(m[2], st);
      out.push(m[1].length <= 2 ? st.bold(st.under(title)) : st.bold(title));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(st.dim('─'.repeat(40))); continue; }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { out.push(`${m[1]}  • ${renderInline(m[2], st)}`); continue; }
    if ((m = line.match(/^(\s*)>\s?(.*)$/))) { out.push(`${m[1]}${st.dim('│')} ${renderInline(m[2], st)}`); continue; }
    out.push(renderInline(line, st));
  }
  return out.join('\n');
}

/** Short key name for the footer: the quoted org name in a vault heading, else the Glass label. */
function shortKeyName(heading) {
  const quoted = heading.match(/"([^"]+)"/);
  if (quoted) return quoted[1];
  return heading.replace(/^Anthropic API Key\s*/i, '').replace(/^\((.*)\)$/, '$1').replace(/\s*\(.*$/, '').replace(/,.*$/, '').slice(0, 30);
}

/**
 * A relayed turn laid out like Claude Code's transcript: one line per tool
 * call with its result under it, the reply after a ⏺, and a dim footer.
 */
function formatTurn(r, meta, mode) {
  const st = styler(mode === 'ansi');
  const out = [];
  for (const a of r.activity || []) {
    const dot = a.result === null ? st.dim('⏺') : a.isError ? st.red('⏺') : st.green('⏺');
    out.push(`${dot} ${st.bold(a.name)}${a.detail ? `(${a.detail})` : ''}`);
    if (a.result !== null) out.push(`  ⎿  ${a.isError ? st.red(a.result) : st.dim(a.result)}`);
  }
  if (out.length) out.push('');
  const text = r.ok ? (r.result || '(empty reply)') : `Relay failed: ${r.error}\nThis window did not answer the message either. Type "relay off" to answer locally.`;
  const body = (mode === 'raw' ? text : renderMarkdown(text, mode)).split('\n');
  out.push(`${r.ok ? '⏺' : st.red('⏺')} ${body[0]}`, ...body.slice(1).map((l) => (l ? `  ${l}` : l)));
  if (r.ok && r.denials && r.denials.length) {
    out.push('', st.dim(`  (${r.denials.length} tool call(s) denied: ${[...new Set(r.denials.map((d) => d.tool_name))].join(', ')})`));
  }
  out.push('', st.dim(`✻ ${meta}`));
  return out.join('\n');
}

/* ---------- keep-warm (shared with latch's src/warm.js) ---------- */

// After each relayed turn, record how it ran so latch's keeper can ping the
// session before its prompt cache expires. Same file format as warm.js
// noteUse(); only a hash of the key is stored. Does nothing unless keep-warm
// was turned on ("relay warm on", /warm on, or latch warm on).
const WARM_DIR = path.join(process.env.LATCH_DIR || path.join(CLAUDE_DIR, 'latch'), 'warm');

/** latch's bin/latch.js, but only a copy that has keep-warm (src/warm.js). */
function latchScript() {
  const homes = [
    process.env.LATCH_HOME,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Myrlin Apaki', 'engine'),
    path.join(os.homedir(), 'Projects', 'claude-latch'),
  ].filter(Boolean);
  for (const h of homes) {
    if (fs.existsSync(path.join(h, 'src', 'warm.js')) && fs.existsSync(path.join(h, 'bin', 'latch.js'))) return path.join(h, 'bin', 'latch.js');
  }
  return null;
}

function noteWarmUse({ sessionId, args, cwd, key, usage }) {
  const settings = { on: false, ...(readJson(path.join(WARM_DIR, 'settings.json')) || {}) };
  if (!settings.on || !sessionId || !key || !SAFE_ARG_RE.test(sessionId)) return;
  // The next relayed run resumes the latest point of this session, so the ping does too.
  const pingArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' || args[i] === '--resume-session-at') { i++; continue; }
    pingArgs.push(args[i]);
  }
  const u = usage || {};
  const file = path.join(WARM_DIR, 'use', `${sessionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    sessionId, mode: 'cli', cwd, options: null, args: ['--resume', sessionId, ...pingArgs],
    keyFp: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
    contextTokens: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0),
    lastUseAt: Date.now(),
  }, null, 2));
  fs.renameSync(tmp, file);
  // Start latch's keeper unless it is running.
  const k = readJson(path.join(WARM_DIR, 'keeper.json')) || {};
  let alive = false;
  if (k.pid) { try { process.kill(k.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
  const script = latchScript();
  if (alive || !script || process.env.LATCH_WARM_NO_KEEPER === '1') return;
  const child = spawn(process.execPath, [script, 'warm', 'run'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PROMPT_RELAY_CHILD: '1' } });
  child.unref();
}

/* ---------- messages ---------- */

function pendingLines(sessions) {
  return sessions
    .map((s) => `  /resume ${reloadId(s)}   (${s.cwd || '?'}, ${s.turns || 0} relayed turn${s.turns === 1 ? '' : 's'})`)
    .join('\n');
}

function behindMessage(sess, global) {
  const why = global && global.source === 'glass' ? 'Glass switched Claude back to a subscription, so relay is off. ' : '';
  return `[relay] ${why}This window is behind: ${sess.turns || 0} turn(s) ran through relay since it last loaded the conversation. Load them first:\n` +
    `  /resume ${reloadId(sess)}\n` +
    '(or /resume and pick it). Typing here before that would reply from the old copy and fork the conversation.\n' +
    'To skip anyway, type "relay ignore"; the relayed turns then drop out of this window\'s history.';
}

/** Handles relay on|off|status|ignore and returns the text to show. */
function handleControl(sid, verb, arg, global, live) {
  const sess = loadSession(sid);

  if (verb === 'on') {
    // No words: the live Glass key when one is live, else the default vault key.
    const label = arg || (live.kind === 'key' ? null : DEFAULT_KEY_LABEL);
    const key = label ? resolveKey(label) : { heading: liveKeyName(live.key), key: live.key };
    if (key.error) return `[relay] Not turned on. ${key.error}`;
    writeJson(GLOBAL_FILE, { on: true, keyLabel: label, keyHeading: key.heading, source: 'manual', since: new Date().toISOString(), lastLiveId: live.id });
    return `[relay] ON for every interactive window.\nKey: ${key.heading}\n` +
      'Each message resumes its own window\'s session through claude -p, so it has the full conversation. ' +
      'The first message per window writes the conversation to cache on this key; later ones read from it.\n' +
      'Window commands (/status, /model, /resume...) stay local; other commands and skills are relayed. Type "relay off" to stop.' +
      (isInteractive() ? '' : '\nNote: this window does not look interactive, so it will not relay itself.');
  }

  if (verb === 'off') {
    const wasOn = global.on;
    writeJson(GLOBAL_FILE, { ...global, on: false, source: 'manual', offAt: new Date().toISOString(), lastLiveId: live.id });
    const pending = allSessions().filter((s) => s.pending);
    const head = wasOn ? '[relay] OFF. Windows answer locally again.' : '[relay] Was already off.';
    if (!pending.length) return `${head}\nNo window has unloaded relayed turns.`;
    return `${head}\n${pending.length} window(s) relayed while it was on. Each one gets its relayed turns added to its context with its next message, so just keep typing; no /resume needed.`;
  }

  if (verb === 'warm') {
    // Keep-warm lives in latch (src/warm.js); this runs its command and shows the result.
    const script = latchScript();
    if (!script) return '[relay] Keep-warm needs latch with src/warm.js (C:\Users\Arthur\Projects\claude-latch, or a current Myrlin Apaki install).';
    const v = (arg || 'status').toLowerCase().split(/s+/);
    const r = spawnSync(process.execPath, [script, 'warm', ...v], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, PROMPT_RELAY_CHILD: '1' } });
    return `[relay] ${(r.stdout || r.stderr || 'no output').trim()}`;
  }

  if (verb === 'render') {
    const mode = (arg || '').toLowerCase();
    if (!RENDER_MODES.has(mode)) return `[relay] Reply rendering is "${global.render || 'ansi'}". Use "relay render ansi" (styled), "relay render plain" (layout, no escape codes) or "relay render raw" (markdown as written).`;
    writeJson(GLOBAL_FILE, { ...global, render: mode });
    return `[relay] Replies now render as ${mode}. ${renderMarkdown('**Bold**, `code`, and\n- a bullet', mode)}`;
  }

  if (verb === 'ignore') {
    if (!sess || !sess.pending) return '[relay] This window has nothing to ignore.';
    sess.pending = false;
    sess.relays = [];
    sess.ignoredAt = new Date().toISOString();
    saveSession(sid, sess);
    return '[relay] OK. This window continues from its own copy; the relayed turns are no longer in its history.';
  }

  // status
  const how = global.source === 'latch' ? 'this window was opened by latch and always relays'
    : global.source === 'glass' ? 'set by a Glass swap' : global.source === 'manual' ? 'set by hand, until the next Glass swap' : 'no Glass swap seen yet';
  const lines = [global.on ? `[relay] ON (${how}${global.since ? `, since ${global.since}` : ''}). Key: ${global.keyHeading || global.keyLabel}` : `[relay] OFF (${how}). Turn on: "relay on" (live Glass key or default) or "relay on <words from the key heading>".`];
  lines.push(`Live Claude login: ${live.kind === 'key' ? `API key (${liveKeyName(live.key)})` : 'subscription'}. ${FOLLOW_GLASS ? 'A Glass swap to a key turns relay on; a swap to a subscription turns it off.' : 'Glass swaps do not change relay (link off); use relay on/off.'}`);
  lines.push(`This window: ${isInteractive() ? 'interactive' : 'not interactive, never relays'} (entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT || 'unset'}, attended=${process.env.CLAUDE_CODE_SESSION_ATTENDED || 'unset'}).`);
  if (sess && sess.pending) lines.push(`This window holds ${(sess.relays || []).length} relayed turn(s) that its own copy lacks; they are added to its context with its first message after relay is off.`);
  const others = allSessions().filter((s) => s.pending && s.sid !== sid);
  if (others.length) lines.push(`Other windows with relayed turns to pick up:\n${pendingLines(others)}`);
  return lines.join('\n');
}

/* ---------- main ---------- */

/* ---------- stale-window guard (latch) ---------- */

// Arthur, 2026-10-09: everything done in latch must stay in the session so the
// conversation continues on the subscription without missing any of it.
// latch (an Agent SDK app, entrypoint sdk-ts) appends to the same transcript,
// but a Claude Code window that already had the session open keeps its own
// in-memory copy. Typing there would continue that old copy, and the next
// resume could follow the window's branch and hide latch's turns. So a window
// whose session gained SDK-app turns after the window loaded it is blocked
// until it runs /resume, which loads everything from disk.
const SDK_APP_ENTRYPOINTS = new Set(['sdk-ts', 'sdk-py']);
const LOADS_FILE = path.join(STATE_DIR, 'loads.json');
const LIVE_RECORDS_DIR = path.join(CLAUDE_DIR, 'sessions');

function recordLoad(sid) {
  const loads = readJson(LOADS_FILE) || {};
  loads[sid] = new Date().toISOString();
  // Keep the file small: drop loads older than 30 days.
  const cutoff = Date.now() - 30 * 86400000;
  for (const [k, v] of Object.entries(loads)) if (Date.parse(v) < cutoff) delete loads[k];
  writeJson(LOADS_FILE, loads);
}

/**
 * When this window last loaded the session: its last SessionStart resume, or
 * else the start time Claude Code recorded for the interactive process that
 * has it open (~/.claude/sessions/<pid>.json). 0 when unknown.
 */
function windowLoadedAt(sid) {
  const loads = readJson(LOADS_FILE) || {};
  let t = loads[sid] ? Date.parse(loads[sid]) : 0;
  if (!t) {
    for (const name of safeReaddir(LIVE_RECORDS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const rec = readJson(path.join(LIVE_RECORDS_DIR, name));
      if (rec && rec.sessionId === sid && rec.entrypoint === 'cli' && rec.startedAt) t = Math.max(t, Number(rec.startedAt));
    }
  }
  return t;
}

/** User prompts an SDK app (latch) added to the transcript after `sinceMs`. */
function sdkTurnsSince(text, sinceMs) {
  let turns = 0;
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"entrypoint":"sdk-')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!SDK_APP_ENTRYPOINTS.has(e.entrypoint) || !e.timestamp || Date.parse(e.timestamp) <= sinceMs) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    last = e.timestamp;
    const c = e.message && e.message.content;
    if (e.type === 'user' && !e.isMeta && (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b && b.type === 'text')))) turns++;
  }
  return { turns, last };
}

async function onSessionStart(input) {
  // /resume, --resume and --continue all start with source "resume".
  if (input.source === 'resume' && input.session_id) {
    markSynced(String(input.session_id));
    recordLoad(String(input.session_id));
  }
}

async function onPrompt(input) {
  const sid = String(input.session_id || '');
  const prompt = String(input.prompt || '');
  if (!sid) return;

  // Any session's prompt picks up a Glass swap, so the flip lands on the first
  // message after it, whichever window or worker sends it.
  const live = liveLogin();
  let global = FOLLOW_GLASS ? syncWithGlass(loadGlobal(), live) : loadGlobal();
  // A window opened by latch relays on its own whatever the global switch says,
  // billed to the key latch chose (PROMPT_RELAY_KEY_WORDS; empty = live/default).
  if (process.env.PROMPT_RELAY_FORCE === '1') {
    global = { ...global, on: true, keyLabel: process.env.PROMPT_RELAY_KEY_WORDS || null, keyHeading: null, source: 'latch' };
  }

  const control = prompt.trim().match(CONTROL_RE);
  if (control) {
    block(handleControl(sid, (control[1] || 'status').toLowerCase(), control[2] && control[2].trim(), global, live));
    return;
  }
  if (!isInteractive()) return;

  const sess = loadSession(sid);
  const trimmed = prompt.trimStart();
  const command = trimmed.startsWith('/') ? trimmed.split(/\s+/)[0].toLowerCase() : null;

  // A typed /resume <id> is the reload itself (SessionStart also catches it).
  if (command === '/resume') {
    const id = trimmed.split(/\s+/)[1];
    if (id) markSynced(id);
    return;
  }

  // Takeover guard (2026-10-09): Myrlin Apaki or latch holds this session
  // somewhere else (opened there, or taken over with "Take over here").
  // Anything typed here would fork the conversation, so it is blocked; window
  // commands (/status, /exit, /resume...) still work.
  if (!(command && SAFE_LOCAL_COMMANDS.has(command))) {
    const holder = heldElsewhere(sid);
    if (holder) { block(heldMessage(holder, sid)); return; }
  }

  // Stale-window guard: latch wrote to this session after this window loaded it.
  if (command !== '/exit' && command !== '/quit' && command !== '/clear' && input.transcript_path) {
    const loadedAt = windowLoadedAt(sid);
    const { turns, last } = sdkTurnsSince(readText(input.transcript_path).slice(-8 * 1024 * 1024), loadedAt);
    if (last) {
      block(`[latch] This conversation continued in latch (${turns || 'some'} turn${turns === 1 ? '' : 's'}, last at ${new Date(last).toLocaleTimeString()}) after this window loaded it, so this window does not have that work yet.\n`
        + `Load it first, then send your message again:\n  /resume ${sid}\n`
        + 'Typing here before that would continue the old copy and could hide latch\'s work from later resumes.');
      return;
    }
  }

  if (!global.on) {
    if (sess && sess.pending && !command) {
      const relays = sess.relays || [];
      // State from before the record existed: fall back to asking for /resume.
      if (!relays.length) { block(behindMessage(sess, global)); return; }
      const file = sess.target ? findSessionFiles(sess.target)[0] : input.transcript_path;
      addContext(
        relayRecord(relays, readText(file), 'window', file),
        `[relay] Added ${relays.length} relayed turn(s) to this window's context with this message; no /resume needed.`,
      );
      Object.assign(sess, { pending: false, relays: [], syncedAt: new Date().toISOString(), syncedBy: 'context' });
      saveSession(sid, sess);
    }
    return;
  }

  // Window-only commands run locally. If one of them writes to the window's
  // copy, the record of relayed turns covers it (see relayRecord).
  if (command && SAFE_LOCAL_COMMANDS.has(command)) return;

  relayActive = true;
  const key = relayKey(global, live);
  if (key.error) {
    block(`[relay FAILED] ${key.error}\nNothing was sent. Type "relay off" to answer locally.`);
    return;
  }

  // Resume the window's own session when it has a conversation on disk. A
  // brand-new window has none yet, so its first message starts a fresh session
  // that later messages from this window resume.
  const state = sess || { sid, turns: 0 };
  const ownTranscript = input.transcript_path && fs.existsSync(input.transcript_path) ? input.transcript_path : null;
  let resumeId = null;
  let text = readText(ownTranscript);
  if (hasConversation(text)) {
    resumeId = sid;
    state.target = null;
  } else if (state.target) {
    resumeId = state.target;
    text = readText(findSessionFiles(state.target)[0]);
  } else {
    text = '';
  }

  const args = resumeId ? ['--resume', resumeId] : [];
  const entries = parseEntries(text);
  // /model and /effort typed in the window win over what the run used last.
  const picked = windowChoices(entries);
  const used = lastAssistantModel(entries);
  const model = (picked.model && picked.modelAt >= used.at ? picked.model : null) || used.model || lastModel(text) || DEFAULT_MODEL;
  const costBefore = lastCostTotal(text);
  if (SAFE_ARG_RE.test(model)) args.push('--model', model);
  const envEffort = (process.env.CLAUDE_EFFORT || '').toLowerCase();
  const effort = picked.effort || (EFFORTS.has(envEffort) ? envEffort : DEFAULT_EFFORT);
  args.push('--effort', effort);
  // A headless run cannot stop for approvals, so tools run without asking
  // (the PreToolUse guard hooks still apply); plan mode stays plan mode.
  if (input.permission_mode === 'plan') args.push('--permission-mode', 'plan');
  else args.push('--dangerously-skip-permissions');
  args.push('--disallowedTools', 'AskUserQuestion', '--append-system-prompt', RELAY_NOTE);

  // If the window wrote to its own copy since the last relayed turn, that copy
  // is the branch this run resumes and the relayed turns are not on it: put
  // the record in front of the prompt so the run still has them.
  let childPrompt = prompt;
  let absorbed = false;
  const pendingRelays = state.relays || [];
  const lastRelay = pendingRelays[pendingRelays.length - 1];
  const wrote = lastRelay ? windowWritesSince(entries, lastRelay.endedAt) : 'none';
  if (resumeId && wrote === 'local' && lastRelay.leafUuid && SAFE_ARG_RE.test(lastRelay.leafUuid)) {
    // Only command records (/effort, /model, /status...) landed on the
    // window's branch: continue the relayed branch exactly where it ended.
    args.push('--resume-session-at', lastRelay.leafUuid);
  } else if (pendingRelays.length && wrote !== 'none') {
    const file = resumeId === sid ? ownTranscript : findSessionFiles(resumeId || '')[0];
    childPrompt = `<relayed-turns>\n${relayRecord(pendingRelays, text, 'relay', file)}\n</relayed-turns>\n\n${prompt}`;
    absorbed = true;
  }

  const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : os.homedir();
  const startedAt = new Date().toISOString();
  const r = await runClaude(childPrompt, { args, cwd, apiKey: key.key });

  if (!resumeId && r.sessionId) state.target = r.sessionId;
  const costKey = reloadId(state);
  let turnCost = null;
  if (r.cumulativeCost !== null) {
    // Below the baseline means the run did not restore the old total.
    turnCost = r.cumulativeCost >= costBefore ? r.cumulativeCost - costBefore : r.cumulativeCost;
  }
  // Any run that started may have written turns, so the window is behind now.
  // Keep this exchange in the record until the window absorbs it.
  const runFile = resumeId === sid ? ownTranscript : findSessionFiles(state.target || resumeId || '')[0];
  const exchange = {
    startedAt,
    endedAt: new Date().toISOString(),
    prompt: prompt.slice(0, 8000),
    reply: (r.ok ? r.result || '(empty reply)' : `(relay failed: ${r.error})`).slice(0, REPLY_MAX_CHARS),
    // Where the relayed branch ends, so a later run can resume exactly there.
    leafUuid: relayLeafUuid(parseEntries(readText(runFile)), startedAt),
  };
  state.relays = [...(absorbed ? [] : pendingRelays), exchange];
  Object.assign(state, { sid, pending: true, turns: (state.turns || 0) + 1, cwd, lastRelayAt: exchange.endedAt });
  saveSession(sid, state);
  appendLog({ ts: state.lastRelayAt, from: sid, to: costKey, key: key.heading, model, effort, at: args.includes("--resume-session-at") ? "leaf" : absorbed ? "record" : "latest", ok: r.ok, ms: r.ms, chars: prompt.length, cost: turnCost });
  if (r.ok) {
    try { noteWarmUse({ sessionId: costKey, args, cwd, key: key.key, usage: r.usage }); } catch { /* never break a relay over keep-warm */ }
  }

  const u = r.usage || {};
  const meta = [
    `relayed in ${(r.ms / 1000).toFixed(1)}s`,
    shortKeyName(key.heading),
    model,
    r.usage ? `${kTokens(u.cache_read_input_tokens)} cached · ${kTokens(u.cache_creation_input_tokens)} new` : null,
    turnCost !== null ? `$${turnCost.toFixed(3)}` : null,
  ].filter(Boolean).join(' · ');

  const renderMode = RENDER_MODES.has(global.render) ? global.render : 'ansi';
  block(formatTurn(r, meta, renderMode));
}

async function main() {
  if (process.env.PROMPT_RELAY_CHILD === '1') return;
  const input = JSON.parse(await readStdin());
  if (input.hook_event_name === 'SessionStart') return onSessionStart(input);
  return onPrompt(input);
}

// Required (not run) by tests, which only want the renderer.
if (require.main === module) {
  main().catch((e) => {
    if (relayActive) {
      block(`[relay FAILED] ${e && e.message ? e.message : e}\nType "relay off" to answer locally.`);
    }
    // Otherwise fail open: the prompt goes through untouched.
  });
}

module.exports = { renderMarkdown };
