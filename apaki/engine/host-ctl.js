#!/usr/bin/env node
/**
 * host-ctl.js: asks Myrlin Apaki's background engine host (host.js) how it is
 * doing, or to exit.
 *
 * WHY (2026-10-10): the engine now outlives the Apaki window, so closing the
 * window no longer means nothing runs from the install folder. An installer
 * must not replace files under a running host; it asks the host to exit once
 * its work is done and waits for that:
 *
 *   node apaki/engine/host-ctl.js quit --when-idle --wait 43200
 *
 * Usage:
 *   host-ctl.js status                      the host's state (one JSON line)
 *   host-ctl.js quit [--when-idle]          exit once no window is connected and no
 *                                           turn, background task or question is left
 *                                           (idle Claude Code processes close at once;
 *                                           phone access does not keep it up)
 *   host-ctl.js quit --now                  stop everything now (running turns are interrupted)
 *   host-ctl.js start                       start a host from this folder's engine.js unless one
 *                                           answers (after an update, when one ran before: phone
 *                                           access keeps it up with the window closed)
 *   --wait <seconds>                        after quit: wait up to this long for the host to exit
 *   --app <id>                              another app id (default io.myrlin.apaki, the installed app)
 *   --file <path>                           the host file itself (overrides --app)
 *
 * Prints one JSON line on stdout; progress goes to stderr. Exit codes:
 *   0  no host is running (any more), or status was printed
 *   2  the host is still running when --wait ran out (or quit was asked without --wait)
 *   1  something went wrong (the host did not answer, bad arguments)
 *
 * Only reads the host file (~/.claude/latch/apaki-host.json) to find and
 * authenticate with the host; never prints the token. Imports nothing but
 * host.js, so it starts nothing else.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_APP_ID, connectHost, hostFile, pidAlive, readHostInfo } from './host.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/**
 * Starts `node engine.js --host` from this folder like the Apaki shell does
 * (main.rs): no window, not tied to this process, stderr appended to the
 * engine log. Resolves with the pid once the host file names it.
 */
async function startHost(o, file) {
  const index = path.join(ROOT, 'index', 'target', 'release', process.platform === 'win32' ? 'latch-index.exe' : 'latch-index');
  const env = { ...process.env, APAKI_APP_ID: o.app, APAKI_HOST_FILE: file, APAKI_SHELL_FEATURES: process.platform === 'win32' ? 'browser' : '' };
  if (fs.existsSync(index) && !env.LATCH_INDEX_BIN) env.LATCH_INDEX_BIN = index;
  const logDir = path.join(os.homedir(), '.claude', 'latch');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'apaki-engine.log'), 'a');
  // detached: on Windows Node puts every other child in a job that ends it when this script exits
  // (seen 2026-10-10); detached breaks away. Its own children (Claude Code, Whisper, Glass) are all
  // started with windowsHide, so no console window appears for them.
  const child = spawn(process.execPath, [path.join(HERE, 'engine.js'), '--host'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', log], windowsHide: true, detached: true });
  child.unref();
  fs.closeSync(log);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(200);
    const info = readHostInfo(file);
    if (info && pidAlive(info.pid)) {
      const c = await connectHost({ file, role: 'control', timeoutMs: 3000 }).catch(() => null);
      if (c) { c.close(); return info.pid; }
    }
    if (child.exitCode !== null && !readHostInfo(file)) throw new Error(`the engine stopped as it started (exit ${child.exitCode}); see ~/.claude/latch/apaki-engine.log`);
  }
  throw new Error('the engine did not start in time; see ~/.claude/latch/apaki-engine.log');
}

function parseArgs(argv) {
  const o = { cmd: argv[0] || 'status', whenIdle: false, now: false, wait: null, app: DEFAULT_APP_ID, file: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--when-idle') o.whenIdle = true;
    else if (a === '--now') o.now = true;
    else if (a === '--wait') o.wait = Number(argv[++i]);
    else if (a === '--app') o.app = String(argv[++i] || DEFAULT_APP_ID);
    else if (a === '--file') o.file = String(argv[++i] || '');
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.wait !== null && !(o.wait >= 0)) throw new Error('--wait needs a number of seconds');
  if (o.now && o.whenIdle) throw new Error('--now and --when-idle do not go together');
  return o;
}

function out(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exitCode = code;
}

/** True while the host named in `file` with this pid is still there. */
function stillRunning(file, pid) {
  if (pidAlive(pid)) return true;
  const now = readHostInfo(file);
  return Boolean(now && now.pid === pid && pidAlive(now.pid));
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { out({ ok: false, error: e.message }, 1); return; }
  // APAKI_HOST_FILE is what the shell gives the host it starts; here the app id decides unless --file says.
  const file = o.file || hostFile(o.app, { ...process.env, APAKI_HOST_FILE: '' });
  const info = readHostInfo(file);
  if (o.cmd === 'start') {
    const live = info && pidAlive(info.pid) ? await connectHost({ file, role: 'control', timeoutMs: 3000 }).catch(() => null) : null;
    if (live) { live.close(); out({ ok: true, running: true, started: false, pid: info.pid }, 0); return; }
    try { out({ ok: true, running: true, started: true, pid: await startHost(o, file) }, 0); } catch (e) { out({ ok: false, running: false, error: e.message }, 1); }
    return;
  }
  if (!info || !pidAlive(info.pid)) { out({ ok: true, running: false, file }, 0); return; }

  let client;
  try {
    client = await connectHost({ file, role: 'control', timeoutMs: 5000 });
  } catch (e) {
    out({ ok: false, running: true, pid: info.pid, error: e.message }, 1);
    return;
  }

  if (o.cmd === 'status') {
    client.send({ op: 'hostStatus', reqId: 'ctl' });
    const st = await client.next((m) => m.ev === 'host', 5000).catch(() => null);
    client.close();
    out(st ? { ...st, running: true } : { ok: false, running: true, pid: info.pid, error: 'no answer' }, st ? 0 : 1);
    return;
  }
  if (o.cmd !== 'quit') { client.close(); out({ ok: false, error: `unknown command ${o.cmd}` }, 1); return; }

  client.send({ op: 'hostQuit', reqId: 'ctl', ...(o.now ? { now: true } : { whenIdle: true }), by: 'host-ctl (an installer or update)' });
  const ack = await client.next((m) => m.ev === 'hostQuit', 5000).catch(() => null);
  client.close();
  if (!ack?.ok) { out({ ok: false, running: true, pid: info.pid, error: ack?.message || 'no answer' }, 1); return; }
  if (ack.waiting?.length) process.stderr.write(`apaki host ${info.pid} exits once idle; waiting for: ${ack.waiting.map((w) => w.why).join(', ')}\n`);

  const deadline = Date.now() + (o.wait ?? 0) * 1000;
  let said = Date.now();
  while (stillRunning(file, info.pid) && Date.now() < deadline) {
    await sleep(500);
    if (Date.now() - said > 60000) { said = Date.now(); process.stderr.write(`still waiting for the Apaki engine host (pid ${info.pid}) to finish its work\n`); }
  }
  const running = stillRunning(file, info.pid);
  out({ ok: true, running, pid: info.pid, asked: o.now ? 'now' : 'when idle' }, running ? 2 : 0);
}

main().catch((e) => out({ ok: false, error: e.message || String(e) }, 1));
