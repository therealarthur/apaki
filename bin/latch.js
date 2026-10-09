#!/usr/bin/env node
/**
 * latch: continue a Claude Code session on Platform (API) credits.
 *
 * Default (in a terminal): a full-screen app. A searchable session picker,
 * then Claude Code's layout over the Agent SDK: streamed replies, tool lines
 * and diffs, question / permission / plan dialogs, Shift+Tab modes, and the
 * `/` menu with every command, skill and plugin Claude Code has here. Opus
 * 5.5, xhigh effort, permissions skipped unless told otherwise.
 * --relay opens the real Claude Code TUI instead, with each message relayed
 * headless by the prompt-relay hook (interactive Claude Code is refused on
 * Platform credits). --lite is the line-based UI, also used for piped input.
 *
 * Usage:
 *   latch                 searchable picker of all sessions (type to filter,
 *                         Ctrl+F searches inside conversations, Tab open only)
 *   latch <words>         the picker, already searching for those words
 *   latch <id-prefix>     continue that session
 *   latch -c              continue the latest session started in this folder
 *   latch -n              start a new session in this folder (or --cwd)
 *   latch -l              list recent sessions and exit
 * Options:
 *   --key <words>   bill a credentials.md key whose heading has these words
 *   --sub           use the live Claude Code login (subscription) instead of a key
 *   -m, --model     model (default: claude-opus-5-5)
 *   -e, --effort    low | medium | high | xhigh | max (default: xhigh)
 *   --mode          permission mode: bypassPermissions (default, like
 *                   --dangerously-skip-permissions) | acceptEdits | default | plan
 *   --yolo          same as the default; kept for old habits
 *   --cwd <dir>     folder for tools (default: the session's own folder)
 *   --force         take over a session another latch holds
 *   --relay         the real Claude Code TUI, messages relayed headless by the hook
 *   --lite          the line-based UI (Agent SDK)
 *   --dry-run       print the Claude Code command, folder and billing, then stop
 *
 * Billing default: the live login when Myrlin Glass has switched it to an API
 * key, otherwise the default vault key (see src/auth.js). The first time a key
 * is used, Claude Code asks once whether to use it: choose Yes.
 *
 * Hand back: the conversation stays one Claude Code session; `claude --resume
 * <id>` opens it on your subscription again.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { CLAUDE_DIR, DEFAULT_KEY_WORDS, chooseCredential, childEnv, keySections } from '../src/auth.js';
import { claudeArgs, launchClaude } from '../src/launch.js';
import { styler, useColor } from '../src/render.js';
import { SessionRunner } from '../src/runner.js';
import {
  ago, findSessionFiles, getSessionInfo, idleMs, listSessions, releaseLock, sessionIdOf, takeLock,
} from '../src/sessions.js';
import { Tui } from '../src/tui.js';
import { runApp } from '../src/ui/app.js';
import { pickSession as pickInteractive } from '../src/picker.js';

const st = styler(useColor());
const LOG_FILE = path.join(CLAUDE_DIR, 'latch', 'latch.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
// A session touched more recently than this may still be open elsewhere.
const RECENT_MS = 2 * 60 * 1000;
// Defaults Arthur asked for (2026-10-09): Opus 5.5 at xhigh effort.
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'xhigh';

function fail(message) {
  process.stderr.write(`${st.red('latch:')} ${message}\n`);
  process.exit(1);
}

/** Child stderr goes to a small rolling log instead of the screen. */
function stderrLogger() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  try { if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.truncateSync(LOG_FILE, 0); } catch { /* new log */ }
  return (data) => {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${String(data).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')}`); } catch { /* best effort */ }
  };
}

/**
 * Environment for a latch-opened Claude Code window: no inherited auth source
 * (the window uses the live login), and, when `keyWords` is not null, the
 * switches that make the prompt-relay hook relay every message of this window
 * on that key ('' = the live Glass key, or the default when none is live).
 */
function windowEnv(keyWords) {
  const env = childEnv(null);
  delete env.PROMPT_RELAY_CHILD; // the hook must run in this window
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  // This latch process holds the session lock for the window; the hook blocks
  // the window if someone else (Myrlin Apaki) takes the session over.
  env.LATCH_LOCK_PID = String(process.pid);
  if (keyWords !== null) {
    env.PROMPT_RELAY_FORCE = '1';
    env.PROMPT_RELAY_KEY_WORDS = keyWords;
  }
  return env;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function shortPath(p) {
  return p ? p.replace(/^C:\\Users\\[^\\]+/i, '~') : '?';
}

/** True when a person is at a terminal, so the full-screen picker can run. */
function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Numbered list fallback for piped input. */
async function pickSession() {
  const sessions = await listSessions({ limit: 15 });
  if (!sessions.length) fail('no Claude Code sessions found. Start one with `latch -n`.');
  sessions.forEach((s, i) => {
    const title = (s.customTitle || s.summary || s.firstPrompt || '').replace(/\s+/g, ' ').slice(0, 70);
    process.stdout.write(`${st.bold(String(i + 1).padStart(2))}  ${st.dim(ago(Date.now() - s.lastModified).padEnd(8))} ${st.dim(shortPath(s.cwd).padEnd(28).slice(0, 28))} ${title}\n`);
  });
  const answer = (await prompt(`${st.bold('session')} [1]: `)).trim() || '1';
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return sessions[n - 1].sessionId;
  return answer; // treat as an id prefix
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      continue: { type: 'boolean', short: 'c' },
      new: { type: 'boolean', short: 'n' },
      list: { type: 'boolean', short: 'l' },
      key: { type: 'string' },
      sub: { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      effort: { type: 'string', short: 'e' },
      mode: { type: 'string' },
      yolo: { type: 'boolean' },
      cwd: { type: 'string' },
      force: { type: 'boolean' },
      lite: { type: 'boolean' },
      relay: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    const lines = src.split('\n');
    const end = lines.findIndex((l, i) => i > 1 && /^\s*\*\/\s*$/.test(l));
    process.stdout.write(`${lines.slice(2, end).map((l) => l.replace(/^ \* ?/, '')).join('\n')}\n`);
    return;
  }

  if (values.list) {
    for (const s of await listSessions({ limit: 25 })) {
      process.stdout.write(`${s.sessionId}  ${ago(Date.now() - s.lastModified).padEnd(8)} ${shortPath(s.cwd).padEnd(28).slice(0, 28)} ${(s.customTitle || s.summary || '').replace(/\s+/g, ' ').slice(0, 60)}\n`);
    }
    return;
  }

  // Which session.
  let sessionId = null;
  if (values.new) {
    sessionId = null;
  } else if (values.continue) {
    const [latest] = await listSessions({ dir: values.cwd || process.cwd(), limit: 1 });
    if (!latest) fail(`no session found for ${values.cwd || process.cwd()}. Use -n for a new one.`);
    sessionId = latest.sessionId;
  }

  // Which credential (chosen first so the picker can show it).
  const credential = chooseCredential({ keyWords: values.key, subscription: values.sub });
  if (credential.error) fail(credential.error);

  // Default with a terminal: latch's own full-screen app (picker, then
  // Claude Code's layout over the Agent SDK). --relay keeps the real Claude
  // Code TUI with the prompt-relay hook; --lite and piped input use the
  // line-based UI below.
  if (interactive() && !values.lite && !values.relay && !values['dry-run']) {
    const wanted = positionals.join(' ').trim();
    const files = wanted && /^[0-9a-f-]{4,36}$/i.test(wanted) ? findSessionFiles(wanted) : [];
    const directId = sessionId || (files.length === 1 ? sessionIdOf(files[0]) : null);
    const info = directId ? await getSessionInfo(directId) : null;
    const keys = [
      ...keySections().map((s) => {
        const label = s.heading.replace(/\s+-\s+added\s+\S+\s*$/i, '').replace(/^Anthropic API Key\s*\((.*)\)$/i, '$1');
        return { label, value: label };
      }),
      { label: 'Follow Myrlin Glass', description: 'whatever Glass has live, API key or subscription; follows every swap', value: 'glass' },
      { label: 'Subscription', description: 'the live Claude Code login, fixed', value: 'sub' },
    ];
    const last = await runApp({
      sessionId: directId,
      newSession: Boolean(values.new),
      query: directId ? '' : wanted,
      credential,
      keys,
      switchKey: (value) => {
        const next = chooseCredential(value === 'sub' ? { subscription: true } : value === 'glass' ? {} : { keyWords: value });
        return next.error ? next : { name: next.name, key: next.key, follow: Boolean(next.follow), env: childEnv(next.key) };
      },
      cwd: info?.cwd,
      cwdOverride: values.cwd ? path.resolve(values.cwd) : null,
      model: values.model || process.env.LATCH_MODEL || DEFAULT_MODEL,
      effort: values.effort || process.env.LATCH_EFFORT || DEFAULT_EFFORT,
      permissionMode: values.mode || 'bypassPermissions',
      force: values.force,
      onStderr: stderrLogger(),
    });
    if (last) {
      process.stdout.write(`${st.dim('Everything from latch is saved in session')} ${last}\n`
        + `  ${st.dim('on your subscription:')}           claude --resume ${last}\n`
        + `  ${st.dim('in a window that has it open:')}   /resume ${last}\n`
        + `  ${st.dim('back in latch:')}                  latch ${last}\n`);
    }
    process.exit(0);
  }

  if (!values.new && !values.continue) {
    const wanted = positionals.join(' ').trim();
    const files = wanted && /^[0-9a-f-]{4,36}$/i.test(wanted) ? findSessionFiles(wanted) : [];
    if (files.length === 1) {
      sessionId = sessionIdOf(files[0]);
    } else if (interactive()) {
      // No argument, or text that is not one session id: search for it.
      sessionId = await pickInteractive({ query: wanted, billing: `${credential.name} (${credential.source})` });
      if (!sessionId) process.exit(0);
    } else if (!wanted) {
      const picked = await pickSession();
      const matches = findSessionFiles(picked);
      if (matches.length !== 1) fail(`"${picked}" does not name exactly one session.`);
      sessionId = sessionIdOf(matches[0]);
    } else {
      fail(files.length > 1 ? `"${wanted}" matches ${files.length} sessions; give more of the id.` : `no session id starts with "${wanted}".`);
    }
  }

  const info = sessionId ? await getSessionInfo(sessionId) : null;
  const file = sessionId ? findSessionFiles(sessionId)[0] : null;
  const cwd = path.resolve(values.cwd || info?.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`folder does not exist: ${cwd}`);

  if (sessionId && !values['dry-run']) {
    const holder = takeLock(sessionId, { force: values.force });
    if (holder) fail(`another latch (pid ${holder}) is attached to this session. Use --force to take it over.`);
  }

  const model = values.model || process.env.LATCH_MODEL || DEFAULT_MODEL;
  const effort = values.effort || process.env.LATCH_EFFORT || DEFAULT_EFFORT;
  // Default is the equivalent of --dangerously-skip-permissions (Arthur, 2026-10-09).
  const permissionMode = values.mode || 'bypassPermissions';
  const recentlyActive = file && (idleMs(file) ?? Infinity) < RECENT_MS;

  if (!values.lite) {
    // Default: the real Claude Code TUI on this session. Interactive Claude Code
    // is refused on Platform credits (billing_error) while headless runs are
    // accepted, so the window stays on the live login and the prompt-relay hook
    // runs each message headless on the chosen key (PROMPT_RELAY_FORCE).
    let args;
    try {
      args = claudeArgs({ sessionId, model, effort, permissionMode });
    } catch (e) {
      fail(e.message);
    }
    const relayed = credential.source !== 'subscription';
    // The lock names this as a terminal window, so a blocked writer can say so.
    if (sessionId && !values['dry-run']) takeLock(sessionId, { force: true, app: 'latch-relay' });
    const env = windowEnv(relayed ? (credential.source === 'glass' ? '' : (values.key || DEFAULT_KEY_WORDS)) : null);
    process.stdout.write(`${st.bold('latch')} ${st.dim('→ Claude Code')}  ${sessionId || 'new session'}  ${st.dim('·')}  ${relayed ? `relays on ${credential.name}` : 'live login'}${st.dim(` (${credential.source})`)}\n`);
    if (recentlyActive) {
      process.stdout.write(st.yellow('  This session changed under 2 minutes ago. If another window has it open, close it there first.\n'));
    }
    if (values['dry-run']) {
      if (sessionId) releaseLock(sessionId);
      process.stdout.write(`  would run: claude ${args.join(' ')}\n  in:        ${cwd}\n  window:    live Claude Code login\n  messages:  ${relayed ? `relayed headless on ${credential.name} (PROMPT_RELAY_FORCE=1, key words "${env.PROMPT_RELAY_KEY_WORDS}")` : 'answered by the window itself'}\n`);
      return;
    }
    launchClaude({
      args,
      cwd,
      env,
      onExit: (code, error) => {
        if (sessionId) releaseLock(sessionId);
        if (error) fail(`could not start Claude Code: ${error.message}`);
        process.exit(code);
      },
    });
    return;
  }

  const ui = { credentialName: credential.name };
  let tui = null;
  const runner = new SessionRunner({
    sessionId,
    cwd,
    env: childEnv(credential.key),
    model,
    effort,
    permissionMode,
    canUseTool: (name, input, opts) => tui.canUseTool(name, input, opts),
    onMessage: (msg) => tui.onMessage(msg),
    onStderr: stderrLogger(),
  });

  tui = new Tui({
    runner,
    info: ui,
    switchKey: (arg) => {
      const next = chooseCredential(arg.toLowerCase() === 'sub' ? { subscription: true } : { keyWords: arg });
      return next.error ? next : { name: next.name, env: childEnv(next.key) };
    },
    onExit: async (r) => {
      await r.stop();
      if (r.sessionId) {
        releaseLock(r.sessionId);
        process.stdout.write(`${st.dim('Continue this conversation in Claude Code with:')}\n  claude --resume ${r.sessionId}\n`);
      }
    },
  });

  // Header.
  const title = (info?.customTitle || info?.summary || '').replace(/\s+/g, ' ').slice(0, 80);
  process.stdout.write(`${st.bold('latch')}${title ? `  ${title}` : ''}\n`);
  const row = (k, v) => process.stdout.write(`  ${st.dim(k.padEnd(8))} ${v}\n`);
  row('session', sessionId ? `${sessionId}${file ? st.dim(`  (last active ${ago(idleMs(file) ?? 0)})`) : ''}` : 'new');
  row('folder', cwd);
  row('model', `${model || 'default'}${effort ? ` · effort ${effort}` : ''}${permissionMode ? ` · ${permissionMode}` : ''}`);
  row('billing', `${credential.name}${st.dim(` (${credential.source})`)}`);
  process.stdout.write(st.dim('  Esc interrupts · /help · Ctrl+D exits\n'));
  if (recentlyActive) {
    process.stdout.write(st.yellow('  This session changed under 2 minutes ago. If a Claude Code window still has it open, stop typing there;\n  latch reloads from disk when it sees outside changes, but two writers at the same moment fork the conversation.\n'));
  }
  process.stdout.write('\n');

  // Start the process now so MCP servers warm up while you type.
  runner.start();
  tui.start();

  process.on('exit', () => { if (runner.sessionId) releaseLock(runner.sessionId); });
}

main().catch((e) => fail(e?.stack || String(e)));
