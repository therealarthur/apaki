#!/usr/bin/env node
/**
 * mac-smoke.mjs: drives a scratch Apaki engine (no window) through the core ops and prints what the window would get.
 * Written for the macOS port (2026-10-12) to check a build on a Mac without a person clicking; works anywhere.
 *
 *   node apaki/scripts/mac-smoke.mjs [--root <engine root>] [--phone] [--session <id>]
 *
 *   --root     the folder that holds apaki/engine/engine.js (default: this checkout; in a built app:
 *              "Myrlin Apaki.app/Contents/Resources/engine", run with the node next to it)
 *   --phone    also turns phone access on and off against the real relay, with its own scratch keys: checks the
 *              phone page (the PC page check), how the keys are sealed (Keychain on a Mac) and a pairing offer
 *   --session  the Claude Code session to open for the history check (default: the newest with a transcript)
 *
 * Never sends a prompt: panes are opened with warm:false (no Claude Code process starts, nothing is billed), the
 * phone steps send nothing to Claude. Scratch state: APAKI_REMOTE_DIR and the Keychain item
 * (APAKI_KEYCHAIN_SERVICE) are private to this run and removed at the end; the engine runs under its own app id.
 * It does what the engine always does at start: reads the sessions under ~/.claude and ~/.codex (read only) and
 * updates the search index in ~/.claude/latch.
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1] ?? true; };
const root = path.resolve(arg('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const wantPhone = process.argv.includes('--phone');
const script = path.join(root, 'apaki', 'engine', 'engine.js');
if (!fs.existsSync(script)) { console.error(`no engine at ${script}`); process.exit(2); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-smoke-'));
const service = `io.myrlin.apaki.remote.smoke-${process.pid}`;
const env = {
  ...process.env,
  APAKI_APP_ID: 'io.myrlin.apaki.smoke',
  APAKI_REMOTE_DIR: path.join(scratch, 'remote'),
  APAKI_KEYCHAIN_SERVICE: service,
  LATCH_WARM_NO_KEEPER: '1',
};
delete env.PROMPT_RELAY_CHILD;
// On a Mac the phone steps seal their scratch keys in a throwaway keychain file (made and unlocked here, deleted at the
// end), so the login Keychain is never touched and a locked login keychain (an ssh session) does not matter.
// --login-keychain uses the real one instead (what the app does).
let tempKeychain = null;
if (wantPhone && process.platform === 'darwin' && !process.env.APAKI_KEYCHAIN_FILE && !process.argv.includes('--login-keychain')) {
  tempKeychain = path.join(scratch, 'smoke.keychain-db');
  const pw = crypto.randomBytes(12).toString('hex');
  execFileSync('/usr/bin/security', ['create-keychain', '-p', pw, tempKeychain], { stdio: 'ignore' });
  execFileSync('/usr/bin/security', ['unlock-keychain', '-p', pw, tempKeychain], { stdio: 'ignore' });
  env.APAKI_KEYCHAIN_FILE = tempKeychain;
}
const indexBin = path.join(root, 'index', 'target', 'release', process.platform === 'win32' ? 'latch-index.exe' : 'latch-index');
if (fs.existsSync(indexBin) && !env.LATCH_INDEX_BIN) env.LATCH_INDEX_BIN = indexBin;

const engine = spawn(process.execPath, [script], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
engine.stderr.on('data', (d) => { stderr += d; });
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`[${at()}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const waiters = [];
readline.createInterface({ input: engine.stdout }).on('line', (line) => {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(e)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(e); }
});
/** The next event that satisfies `match`, or null after `ms`. Register before sending the op that causes it. */
const next = (match, ms = 30000) => new Promise((resolve) => {
  const w = { match, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); resolve(null); }, ms) };
  waiters.push(w);
});
const send = (o) => engine.stdin.write(`${JSON.stringify(o)}\n`);
const ask = async (op, match, ms) => { const p = next(match, ms); send(op); return p; };

function deleteKeychainItem() {
  if (process.platform !== 'darwin') return;
  if (tempKeychain) { try { execFileSync('/usr/bin/security', ['delete-keychain', tempKeychain], { stdio: 'ignore' }); } catch { /* already gone */ } return; }
  try { execFileSync('/usr/bin/security', ['delete-generic-password', '-a', 'secret-key-v1', '-s', service, ...(env.APAKI_KEYCHAIN_FILE ? [env.APAKI_KEYCHAIN_FILE] : [])], { stdio: 'ignore' }); } catch { /* none was made */ }
}

async function main() {
  // The index event comes when the first update ends, usually before the later steps ask: listen from the start.
  const indexed = next((e) => e.ev === 'index', 180000);
  const ready = await next((e) => e.ev === 'ready', 60000);
  check('engine started and said ready', Boolean(ready), ready ? `pid ${ready.pid}, voice ${ready.voice}, codex ${ready.codex}, artifacts ${ready.artifacts}` : stderr.split('\n').slice(-3).join(' | '));
  if (!ready) return;

  const sess = await ask({ op: 'sessions', reqId: 's1' }, (e) => e.ev === 'sessions', 60000);
  const items = sess?.items || [];
  const claude = items.filter((s) => !s.codex);
  const codex = items.filter((s) => s.codex);
  check('session list', items.length > 0, `${items.length} sessions: ${claude.length} Claude Code, ${codex.length} Codex`);

  const pick = (typeof arg('--session') === 'string' ? claude.find((s) => s.id === arg('--session')) : null) || claude.find((s) => s.cwd && fs.existsSync(s.cwd)) || claude[0];
  if (pick) {
    const opened = next((e) => e.ev === 'opened' && e.paneId === 'smoke', 30000);
    const hist = next((e) => e.ev === 'history' && e.paneId === 'smoke', 60000);
    send({ op: 'open', reqId: 'o1', paneId: 'smoke', sessionId: pick.id, cwd: pick.cwd || null, warm: false });
    const o = await opened;
    const h = await hist;
    check('a pane opens a session', Boolean(o), o ? `${String(o.title).slice(0, 50)} in ${o.cwd}` : 'no opened event');
    check('its history loads', Boolean(h) && (h.messages?.length || 0) > 0, h ? `${h.messages?.length || 0} messages of ${h.total}, ${h.ms ?? '?'} ms` : 'no history event');
    send({ op: 'close', reqId: 'c1', paneId: 'smoke' });
  } else check('a pane opens a session', false, 'no Claude Code session to open');

  const idx = await indexed;
  check('the search index updated', Boolean(idx?.ok), idx ? `${idx.ms} ms` : 'no index event');
  const query = pick ? String(pick.title || pick.firstPrompt || 'session').split(/\s+/).slice(0, 4).join(' ') : 'session';
  const found = await ask({ op: 'search', reqId: 'q1', query }, (e) => e.ev === 'search' && e.reqId === 'q1' && e.deep, 60000);
  check('search by words and meaning', Boolean(found) && found.results.length > 0, found ? `"${query}": ${found.results.length} results in ${found.elapsed} ms, semantic ${found.semantic}` : 'no deep search answer');

  const wt = await ask({ op: 'worktrees', reqId: 'w1' }, (e) => e.ev === 'worktrees', 30000);
  check('worktrees answer', Boolean(wt), wt ? `${wt.repos?.length ?? 0} repositories` : 'no event');

  if (wantPhone) await phone();
}

async function phone() {
  const status = (m) => next((e) => e.ev === 'remote' && m(e), 90000);
  let s = await ask({ op: 'remoteStatus', reqId: 'r1' }, (e) => e.ev === 'remote', 30000);
  check('phone access reports its status', Boolean(s), s ? `state ${s.state}, relay ${s.relay || 'none'}, web ${s.web || 'none'}` : 'no remote event');
  if (!s) return;
  const on = status((e) => e.state === 'online' || e.state === 'offline' || Boolean(e.error));
  send({ op: 'remoteEnable', reqId: 'r2' });
  s = await on;
  check('phone access turns on and reaches the relay', s?.state === 'online', s ? `state ${s.state}${s.error ? `, ${s.error}` : ''}` : 'no answer');
  check('the secrets are sealed by the platform store', process.platform === 'darwin' ? s?.protection === 'keychain' : s?.protection != null, `protection: ${s?.protection}`);
  if (s?.protection === 'file' && process.platform === 'darwin') console.log(stderr.split('\n').filter((l) => /apaki remote/.test(l)).join('\n'));
  const rawFile = path.join(scratch, 'remote', 'secret.json');
  if (fs.existsSync(rawFile)) {
    const f = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    check('secret.json holds no readable key', !/"(d|token)"\s*:/.test(Buffer.from(f.data || '', 'base64').toString('utf8')), `scheme ${f.scheme}`);
  } else check('secret.json was written', false);
  const pairing = status((e) => Boolean(e.pairing) || e.page?.state === 'differs' || e.page?.state === 'missing' || e.page?.state === 'unreachable');
  send({ op: 'remotePairStart', reqId: 'r3' });
  s = await pairing;
  check('the PC page check passes and a pairing offer is made', Boolean(s?.pairing), s ? `page ${s.page?.state} (${s.page?.version || '?'}): ${s.page?.text || ''}` : 'no answer');
  send({ op: 'remotePairCancel', reqId: 'r4' });
  send({ op: 'remoteDisable', reqId: 'r5' });
  await next((e) => e.ev === 'remote' && e.state === 'off', 15000);
}

const watchdog = setTimeout(() => { console.log('timed out'); finish(1); }, 420000);
function finish(code) {
  clearTimeout(watchdog);
  try { send({ op: 'remoteDisable', reqId: 'end' }); } catch { /* gone */ }
  setTimeout(() => {
    engine.kill();
    deleteKeychainItem();
    fs.rmSync(scratch, { recursive: true, force: true });
    const bad = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - bad} passed, ${bad} failed`);
    process.exit(code || (bad ? 1 : 0));
  }, 1200);
}
main().then(() => finish(0), (e) => { console.log(`error: ${e.stack || e}`); finish(1); });
