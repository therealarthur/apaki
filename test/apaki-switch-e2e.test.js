/**
 * Switching a conversation between Claude Code and Codex, end to end (apaki/engine/switch.js), 2026-10-12.
 *
 * The real engine.js in host mode in a temp world: a synthetic Claude transcript (test-fixtures/switch), a throwaway
 * git repository as the folder, and the fake `codex app-server` (test-fixtures/fake-codex-app-server.mjs) writing
 * rollout files. A Claude pane switches to Codex (the handoff goes in with thread/inject_items, no turn starts), Codex
 * answers one message, and the pane switches back to Claude (the handoff waits for the next message; no Claude Code
 * process is started, nothing is billed anywhere).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectHost, readHostInfo } from '../apaki/engine/host.js';
import { HANDOFF_MARK } from '../apaki/engine/ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const FAKE = path.join(ROOT, 'test-fixtures', 'fake-codex-app-server.mjs');
const TRANSCRIPT = path.join(ROOT, 'test-fixtures', 'switch', 'claude-session.jsonl');
const SID = '5e55a0c0-0000-4000-8000-000000000001';
const APP = 'apaki-dev-switch-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', windowsHide: true });

async function until(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(step);
  }
}

/** The engine in a temp world with a Claude transcript, a git repository and the fake Codex server writing rollouts. */
async function startHost(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-switch-test-'));
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects', 'C--proj'), { recursive: true });
  fs.copyFileSync(TRANSCRIPT, path.join(claude, 'projects', 'C--proj', `${SID}.jsonl`));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.ts'), 'const a = foo;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const log = path.join(dir, 'codex-log.jsonl');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: '', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000', APAKI_NO_ARCHIVE: '1',
    APAKI_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, FAKE_CODEX_CWD: work, CODEX_HOME: path.join(dir, 'codex-home'), FAKE_CODEX_ROLLOUTS: path.join(dir, 'rollouts'),
    // No real API key may reach a Claude Code process from this test, even by accident.
    ANTHROPIC_API_KEY: '', ...extraEnv,
  };
  const child = spawn(process.execPath, [ENGINE, '--host'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    rm(dir);
  });
  await until(() => readHostInfo(file)?.pid === child.pid || child.exitCode !== null, 30000);
  assert.equal(child.exitCode, null, `the host did not start:\n${stderr}`);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const links = () => { const d = path.join(claude, 'latch', 'switch'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : []; };
  return { dir, work, claude, file, stderr: () => stderr, calls, requests: (method) => calls().filter((c) => c.in?.method === method).map((c) => c.in.params), links };
}

async function windowOf(h) {
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  return w;
}

async function waitFor(w, label, pred, ms = 15000, from = 0) {
  try { return await w.next(pred, ms, from); } catch (e) {
    throw new Error(`timed out waiting for ${label}; events since: ${w.events.slice(from).map((m) => `${m.ev}${m.paneId ? `@${m.paneId}` : ''}${m.message ? `(${m.message})` : ''}${m.text ? `(${m.text})` : ''}`).join(', ')}`, { cause: e });
  }
}

test('switch: Claude to Codex with the handoff injected, one Codex turn, then back to Claude with the handoff waiting', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  // The Claude pane on the session, not started (no Claude Code process at any point in this test).
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: SID, cwd: h.work, warm: false });
  await waitFor(w, 'opened', (m) => m.ev === 'opened' && m.reqId === 'o1');
  const h0 = await waitFor(w, 'history', (m) => m.ev === 'history' && m.paneId === 'p1');
  assert.ok(!h0.link, 'not linked yet');
  // Work in progress on disk: the handoff's diff must show it.
  fs.writeFileSync(path.join(h.work, 'a.ts'), 'import { foo } from \'./foo\';\nconst a = foo;\n');
  fs.writeFileSync(path.join(h.work, 'foo.test.ts'), 'test(\'foo\', () => {});\n');
  const statusBefore = git(h.work, 'status', '--porcelain');

  // Claude to Codex.
  let from = w.events.length;
  w.send({ op: 'switchAgent', reqId: 's1', paneId: 'p1', to: 'codex' });
  await waitFor(w, 'switching', (m) => m.ev === 'switching' && m.paneId === 'p1' && m.to === 'codex', 15000, from);
  const opened = await waitFor(w, 'opened as Codex', (m) => m.ev === 'opened' && m.paneId === 'p1' && m.kind === 'codex', 30000, from);
  assert.deepEqual({ from: opened.switch.from, to: opened.switch.to, n: opened.switch.n }, { from: 'claude', to: 'codex', n: 1 });
  assert.equal(opened.mode, 'full-access', 'the Claude pane\'s bypassPermissions maps to Codex\'s full access');
  const sid = await waitFor(w, 'the thread', (m) => m.ev === 'session_id' && m.paneId === 'p1', 15000, from);
  assert.match(sid.sessionId, /^codex:/);
  const done = await waitFor(w, 'switched', (m) => m.ev === 'switched' && m.paneId === 'p1', 30000, from);
  assert.equal(done.to, 'codex');
  assert.equal(done.injected, true);
  assert.equal(done.pending, null);
  assert.equal(done.checkpoint, 'refs/apaki/handoff/1');
  assert.equal(done.counts.prompts, 4);
  assert.match(done.text, /^Switched to Codex: it has read the handoff \(\d+ turns from Claude, code checkpoint #1\)\.$/);
  // No turn started, the thread knows it is a switched one, and the handoff went in as an item.
  assert.equal(h.requests('turn/start').length, 0, 'the switch itself bills nothing');
  const start = h.requests('thread/start')[0];
  assert.match(start.developerInstructions, /moves between Claude Code and you inside Myrlin Apaki/);
  const inj = h.requests('thread/inject_items');
  assert.equal(inj.length, 1);
  assert.equal(inj[0].threadId, sid.sessionId.slice('codex:'.length));
  const packet = inj[0].items[0].content[0].text;
  assert.equal(inj[0].items[0].role, 'user');
  assert.ok(packet.startsWith(`${HANDOFF_MARK} Switch 1`));
  for (const s of ['Make the build pass', 'ran `npm run build`: failed', 'I hit my usage limit', 'foo.test.ts', 'refs/apaki/handoff/1', "+import { foo } from './foo';", 'apaki_ledger']) assert.ok(packet.includes(s), `the handoff has ${s}`);
  // The checkpoint is a ref; the folder, index and branch are as they were.
  assert.equal(git(h.work, 'status', '--porcelain'), statusBefore);
  assert.match(git(h.work, 'show', 'refs/apaki/handoff/1:a.ts'), /import \{ foo \}/);
  const [link] = h.links();
  assert.equal(link.claude.sessionId, SID);
  assert.equal(link.codex.threadId, sid.sessionId.slice('codex:'.length));
  assert.equal(link.seen.codex, fs.statSync(path.join(h.claude, 'projects', 'C--proj', `${SID}.jsonl`)).size);
  assert.equal(link.active, 'codex');
  assert.equal(link.claude.settings.mode, 'bypassPermissions', 'Claude\'s own picks are kept for the way back');

  // One Codex turn: it runs a command.
  from = w.events.length;
  w.send({ op: 'send', reqId: 'c1', paneId: 'p1', text: 'run: npm test' });
  await waitFor(w, 'the Codex turn', (m) => m.ev === 'result' && m.paneId === 'p1' && m.reqId === 'c1', 20000, from);
  assert.equal(h.requests('turn/start').length, 1);
  assert.ok(!h.requests('turn/start')[0].input.some((i) => String(i.text || '').includes(HANDOFF_MARK)), 'the injected handoff is not sent again');

  // Back to Claude.
  from = w.events.length;
  w.send({ op: 'switchAgent', reqId: 's2', paneId: 'p1', to: 'claude' });
  const back = await waitFor(w, 'opened as Claude', (m) => m.ev === 'opened' && m.paneId === 'p1' && m.kind === 'claude', 30000, from);
  assert.equal(back.sessionId, SID);
  assert.equal(back.switch.to, 'claude');
  assert.equal(back.mode, 'bypassPermissions');
  const done2 = await waitFor(w, 'switched back', (m) => m.ev === 'switched' && m.paneId === 'p1' && m.to === 'claude', 30000, from);
  assert.equal(done2.pending, 'claude');
  assert.equal(done2.checkpoint, 'refs/apaki/handoff/2');
  const link2 = h.links()[0];
  assert.equal(link2.active, 'claude');
  const waiting = link2.pending.claude.text;
  assert.ok(waiting.startsWith(`${HANDOFF_MARK} Switch 2`));
  for (const s of ['coming back to you (Claude Code) from Codex', 'run: npm test', 'ran `npm test` (exit 0)', 'echo: run: npm test']) assert.ok(waiting.includes(s), `the way back has ${s}`);
  assert.ok(!waiting.includes('Make the build pass'), 'Claude is not told its own turns again');
  assert.equal(link2.seen.claude, 0, 'the bookmark moves only when the handoff goes out');

  // The pane's one conversation: Claude's turns, the switch lines, Codex's turn; the old handoff shows as the words only.
  const hist = await waitFor(w, 'the merged history', (m) => m.ev === 'history' && m.paneId === 'p1' && m.sessionId === SID, 15000, from);
  assert.equal(hist.link.linkId, link2.id);
  const notices = hist.messages.filter((m) => m.type === 'notice' && m.switch);
  assert.deepEqual(notices.map((m) => m.switch.to), ['codex', 'claude']);
  const codexMsgs = hist.messages.filter((m) => m.agent === 'codex');
  assert.ok(codexMsgs.some((m) => m.type === 'user' && m.message.content.some((b) => b.text === 'run: npm test')));
  assert.ok(codexMsgs.some((m) => m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use' && /npm test/.test(b.input?.command || ''))));
  assert.ok(hist.messages.filter((m) => m.agent === 'claude').length > 5);
  const words = hist.messages.filter((m) => m.type === 'user').flatMap((m) => (typeof m.message.content === 'string' ? [m.message.content] : m.message.content.filter((b) => b.type === 'text').map((b) => b.text)));
  assert.ok(words.includes('Carry on with the tests'));
  assert.ok(!words.some((x) => x.includes(HANDOFF_MARK)), 'no handoff text is drawn as a message');
  // Codex's turn sits after the first switch line, the second switch line after it.
  const idx = (pred) => hist.messages.findIndex(pred);
  assert.ok(idx((m) => m.switch?.to === 'codex') < idx((m) => m.agent === 'codex'));
  assert.ok(idx((m) => m.agent === 'codex') < idx((m) => m.switch?.to === 'claude'));

  // Switching to Codex again resumes the same thread; Claude said nothing new, and its waiting handoff stays for later.
  from = w.events.length;
  w.send({ op: 'switchAgent', reqId: 's3', paneId: 'p1', to: 'codex' });
  const done3 = await waitFor(w, 'switched again', (m) => m.ev === 'switched' && m.paneId === 'p1' && m.to === 'codex' && m.n === 3, 30000, from);
  assert.equal(done3.injected, true);
  assert.equal(h.requests('thread/start').length, 1, 'no second thread');
  assert.ok(h.requests('thread/resume').some((r) => r.threadId === link2.codex.threadId));
  const again = h.requests('thread/inject_items')[1].items[0].content[0].text;
  assert.match(again, /Nothing new happened in Claude Code since Codex last saw this conversation\./);
  assert.ok(h.links()[0].pending.claude, 'Claude has not been told yet');
  w.close();
});

test('switch: a server without thread/inject_items gets the handoff in front of the next message instead', { timeout: 90000 }, async (t) => {
  const h = await startHost(t, { FAKE_CODEX_NO_INJECT: '1' });
  const w = await windowOf(h);
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: SID, cwd: h.work, warm: false });
  await waitFor(w, 'opened', (m) => m.ev === 'opened' && m.reqId === 'o1');
  w.send({ op: 'switchAgent', reqId: 's1', paneId: 'p1', to: 'codex' });
  const done = await waitFor(w, 'switched', (m) => m.ev === 'switched' && m.paneId === 'p1', 30000);
  assert.equal(done.injected, false);
  assert.equal(done.pending, 'codex');
  assert.match(done.text, /it reads the handoff with your next message/);
  assert.equal(h.links()[0].seen.codex, 0);
  w.send({ op: 'send', reqId: 'c1', paneId: 'p1', text: 'go on' });
  await waitFor(w, 'the Codex turn', (m) => m.ev === 'result' && m.paneId === 'p1' && m.reqId === 'c1', 20000);
  const input = h.requests('turn/start')[0].input.map((i) => i.text || '').join('\n');
  assert.ok(input.startsWith(`${HANDOFF_MARK} Switch 1`));
  assert.ok(input.trimEnd().endsWith('go on'));
  // Sent once: the bookmark moved, nothing waits.
  const link = h.links()[0];
  assert.equal(link.pending.codex, null);
  assert.ok(link.seen.codex > 0);
  w.send({ op: 'send', reqId: 'c2', paneId: 'p1', text: 'and again' });
  await waitFor(w, 'the second turn', (m) => m.ev === 'result' && m.paneId === 'p1' && m.reqId === 'c2', 20000);
  assert.ok(!h.requests('turn/start')[1].input.some((i) => String(i.text || '').includes(HANDOFF_MARK)));
  w.close();
});

test('switch: refused while a turn runs, refused for a pane already on that side, and a folder outside git has no checkpoint', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const plain = path.join(h.dir, 'plain');
  fs.mkdirSync(plain);
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: SID, cwd: plain, warm: false });
  await waitFor(w, 'opened', (m) => m.ev === 'opened' && m.reqId === 'o1');
  w.send({ op: 'switchAgent', reqId: 's0', paneId: 'p1', to: 'claude' });
  await waitFor(w, 'already on Claude', (m) => m.ev === 'note' && m.paneId === 'p1' && /on Claude already/.test(m.text));
  w.send({ op: 'switchAgent', reqId: 's1', paneId: 'p1', to: 'codex' });
  const done = await waitFor(w, 'switched', (m) => m.ev === 'switched' && m.paneId === 'p1', 30000);
  assert.equal(done.checkpoint, null);
  assert.match(h.requests('thread/inject_items')[0].items[0].content[0].text, /No code diff: the folder is not in a git repository\./);
  // A turn that hangs: switching now is refused.
  w.send({ op: 'send', reqId: 'c1', paneId: 'p1', text: 'hang' });
  await until(() => h.requests('turn/start').length === 1, 10000);
  await sleep(200);
  const from = w.events.length;
  w.send({ op: 'switchAgent', reqId: 's2', paneId: 'p1', to: 'claude' });
  await waitFor(w, 'refused', (m) => m.ev === 'note' && m.paneId === 'p1' && /Codex is working here/.test(m.text), 10000, from);
  w.send({ op: 'interrupt', paneId: 'p1' });
  await waitFor(w, 'stopped', (m) => m.ev === 'result' && m.paneId === 'p1', 15000, from);
  w.close();
});
