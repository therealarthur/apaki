#!/usr/bin/env node
/**
 * cdp-takeover.mjs: a real "Take over here" in a running Apaki window
 * (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>).
 *   node apaki/scripts/cdp-takeover.mjs <session-id> <out-prefix> [port]
 * Use a disposable session: a stand-in "latch terminal window" process takes
 * its lock, the window opens it (the card must appear), the script clicks
 * Take over here, and checks that the pane opened with the takeover note, the
 * lock is Apaki's with takenFrom set, and the relay hook now blocks the old
 * window. Then it closes the pane (the lock is released) and stops the stand-in.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockInfo } from '../../src/sessions.js';

const [sid, prefix = 'apaki-takeover', portArg] = process.argv.slice(2);
if (!sid) { console.error('usage: cdp-takeover.mjs <session-id> <out-prefix> [port]'); process.exit(2); }
const port = Number(portArg) || 9334;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = {};

const holderCode = `import(${JSON.stringify(`file:///${path.join(root, 'src', 'sessions.js').replace(/\\/g, '/')}`)}).then((s) => { s.setLockApp('latch-relay'); console.log(s.takeLock(${JSON.stringify(sid)}, { force: true }) === null ? 'held' : 'refused'); setTimeout(() => {}, 300000); });`;
const holder = spawn(process.execPath, ['-e', holderCode], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => holder.stdout.once('data', r));
R.heldBy = lockInfo(sid)?.app;

let ws;
for (let i = 0; i < 120 && !ws; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((t) => t.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { await sleep(250); }
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 60)}: ${r.result.exceptionDetails.exception?.description}`); return r.result?.result?.value; };
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };
const dpr = await ev('devicePixelRatio');
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 / dpr } }); fs.writeFileSync(`${prefix}-${name}.png`, Buffer.from(s.result.data, 'base64')); };

try {
  await waitFor('!!window.__apaki && !!window.__apaki.focusedPane()');
  await ev(`window.__apaki.focusedPane().open({ id: ${JSON.stringify(sid)}, cwd: '', title: 'takeover test' }, { warm: false })`);
  R.card = await waitFor(`!!document.querySelector('.pane.focused .takeover .tk-go')`);
  R.cardText = await ev(`document.querySelector('.pane.focused .takeover h3')?.textContent`);
  await shot('card');
  await ev(`document.querySelector('.pane.focused .takeover .tk-go').click()`);
  R.opened = await waitFor(`[...document.querySelectorAll('.pane.focused .note')].some((n) => /Taken over/.test(n.textContent))`);
  const lock = lockInfo(sid);
  R.lockNow = { app: lock?.app, takenFrom: lock?.takenFrom?.app, takenFromPid: lock?.takenFrom?.pid === holder.pid };
  await shot('after');
  // The old window is now blocked by the relay hook.
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: '', cwd: os.homedir(), prompt: 'still here?' });
  const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1', LATCH_LOCK_PID: String(holder.pid), PROMPT_RELAY_STATE_DIR: path.join(os.tmpdir(), `apaki-tk-${process.pid}`), PROMPT_RELAY_LIVE_LOGIN_FILE: path.join(os.tmpdir(), 'no-login.json') };
  for (const k of ['PROMPT_RELAY_CHILD', 'PROMPT_RELAY_FORCE', 'PROMPT_RELAY_KEY_WORDS', 'ANTHROPIC_API_KEY']) delete env[k];
  const h = spawnSync(process.execPath, [path.join(os.homedir(), '.claude', 'hooks', 'prompt-relay.js')], { input, env, encoding: 'utf8' });
  const out = JSON.parse(h.stdout || '{}');
  R.oldWindowBlocked = out.decision === 'block' ? out.reason.split('\n')[0] : false;
  fs.rmSync(env.PROMPT_RELAY_STATE_DIR, { recursive: true, force: true });
} finally {
  // Back to a new conversation (releases the lock), stop the stand-in.
  await ev(`window.__apaki.focusedPane().open(null, { warm: false })`).catch(() => {});
  await sleep(800);
  holder.kill();
  R.lockAfterClose = lockInfo(sid);
  console.log(JSON.stringify(R, null, 1));
  ws.close();
}
