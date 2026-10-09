#!/usr/bin/env node
/**
 * latch: continue a Claude Code session in a terminal UI billed to an API key.
 *
 * Usage:
 *   latch                 pick from recent sessions
 *   latch <id-prefix>     continue that session
 *   latch -c              continue the latest session started in this folder
 *   latch -n              start a new session in this folder (or --cwd)
 *   latch -l              list recent sessions and exit
 * Options:
 *   --key <words>   bill a credentials.md key whose heading has these words
 *   --sub           use the live Claude Code login (subscription) instead of a key
 *   -m, --model     model (default: the session's last model)
 *   -e, --effort    low | medium | high | xhigh | max
 *   --mode          permission mode: default | acceptEdits | plan | bypassPermissions
 *   --yolo          same as --mode bypassPermissions
 *   --cwd <dir>     folder for tools (default: the session's own folder)
 *   --force         take over a session another latch holds
 *
 * Billing default: the live login when Myrlin Glass has switched it to an API
 * key, otherwise the default vault key (see src/auth.js).
 *
 * Hand back: on exit latch prints `claude --resume <id>`, which opens the same
 * conversation, latch's turns included, in regular Claude Code.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { CLAUDE_DIR, chooseCredential, childEnv } from '../src/auth.js';
import { styler, useColor } from '../src/render.js';
import { SessionRunner } from '../src/runner.js';
import {
  ago, findSessionFiles, getSessionInfo, idleMs, lastModel, listSessions, readTail, releaseLock, sessionIdOf, takeLock,
} from '../src/sessions.js';
import { Tui } from '../src/tui.js';

const st = styler(useColor());
const LOG_FILE = path.join(CLAUDE_DIR, 'latch', 'latch.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
// A session touched more recently than this may still be open elsewhere.
const RECENT_MS = 2 * 60 * 1000;

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

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function shortPath(p) {
  return p ? p.replace(/^C:\\Users\\[^\\]+/i, '~') : '?';
}

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
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    process.stdout.write(`${src.split('\n').slice(2, 24).map((l) => l.replace(/^ \* ?/, '')).join('\n')}\n`);
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
  } else {
    const wanted = positionals[0] || (await pickSession());
    const files = findSessionFiles(wanted);
    if (files.length === 0) fail(`no session id starts with "${wanted}".`);
    if (files.length > 1) fail(`"${wanted}" matches ${files.length} sessions; give more of the id.`);
    sessionId = sessionIdOf(files[0]);
  }

  const info = sessionId ? await getSessionInfo(sessionId) : null;
  const file = sessionId ? findSessionFiles(sessionId)[0] : null;
  const cwd = path.resolve(values.cwd || info?.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`folder does not exist: ${cwd}`);

  // Which credential.
  const credential = chooseCredential({ keyWords: values.key, subscription: values.sub });
  if (credential.error) fail(credential.error);

  if (sessionId) {
    const holder = takeLock(sessionId, { force: values.force });
    if (holder) fail(`another latch (pid ${holder}) is attached to this session. Use --force to take it over.`);
  }

  const tail = file ? readTail(file) : '';
  const model = values.model || lastModel(tail) || undefined;
  const effort = values.effort || process.env.LATCH_EFFORT || process.env.CLAUDE_EFFORT || undefined;
  const permissionMode = values.yolo ? 'bypassPermissions' : values.mode;

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
  if (file && (idleMs(file) ?? Infinity) < RECENT_MS) {
    process.stdout.write(st.yellow('  This session changed under 2 minutes ago. If a Claude Code window still has it open, stop typing there;\n  latch reloads from disk when it sees outside changes, but two writers at the same moment fork the conversation.\n'));
  }
  process.stdout.write('\n');

  // Start the process now so MCP servers warm up while you type.
  runner.start();
  tui.start();

  process.on('exit', () => { if (runner.sessionId) releaseLock(runner.sessionId); });
}

main().catch((e) => fail(e?.stack || String(e)));
