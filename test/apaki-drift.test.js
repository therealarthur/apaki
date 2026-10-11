/**
 * No drift (Arthur, 2026-10-11: "when taking over session from another open tab, we need to make sure that when
 * that tab takes over back or is reopened or reloaded that it automatically refreshes to make sure it has the
 * most recent transcript/session data/etc - we need to make sure there is no drift always. Reliably.").
 *
 * History carries the transcript's revision; historyCheck sends the conversation again when the transcript moved
 * on since (another app, another pane, a phone wrote it), and says fresh otherwise. End to end against
 * engine.js --host with a stand-in Agent SDK (as in apaki-queue.test.js) and a real transcript file that this
 * test changes behind the engine's back; plus the phone rule for the new op.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectHost, readHostInfo } from '../apaki/engine/host.js';
import { checkPhoneCommand } from '../apaki/engine/remote-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-drift-test-'));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };
async function until(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(step);
  }
}

// The stand-in SDK: the engine's open path only needs query() to exist; this test never sends a turn.
const REAL_SDK = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
const FAKE_SDK = `export * from ${JSON.stringify(REAL_SDK)};
export function query() { const it = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } };
  return Object.assign(it, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, supportedCommands: async () => [], getContextUsage: async () => ({ percentage: 1, categories: [] }) }); }
export async function getSessionInfo(id) { return { sessionId: id, summary: 'Drift test', cwd: process.cwd() }; }
export async function getSessionMessages() { return []; }
export async function listSessions() { return []; }
export async function renameSession() {}
export function createSdkMcpServer(o = {}) { return { type: 'sdk', name: o.name, instance: {} }; }
export function tool(name, description, inputSchema, handler) { return { name, description, inputSchema, handler }; }
`;
const HOOKS = `export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: new URL('./fake-agent-sdk.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`;
const LOADER = `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`;
const APP = 'apaki-dev-drift-test';
const SID = '0e7f4b4e-aaaa-4bbb-8ccc-0000000000d1';
const line = (o) => `${JSON.stringify(o)}\n`;
const msg = (uuid, parentUuid, role, text) => ({ type: role, uuid, parentUuid, sessionId: SID, timestamp: new Date().toISOString(), message: role === 'user' ? { role, content: text } : { id: `m-${uuid}`, role, content: [{ type: 'text', text }] } });

async function startHost(t) {
  const dir = tmp();
  const claude = path.join(dir, 'claude');
  const fake = path.join(dir, 'fake');
  const project = path.join(claude, 'projects', 'C--drift-test');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-agent-sdk.mjs'), FAKE_SDK);
  fs.writeFileSync(path.join(fake, 'hooks.mjs'), HOOKS);
  fs.writeFileSync(path.join(fake, 'loader.mjs'), LOADER);
  const transcript = path.join(project, `${SID}.jsonl`);
  fs.writeFileSync(transcript, line(msg('00000000-0000-4000-8000-000000000001', null, 'user', 'first question')) + line(msg('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'assistant', 'first answer')));
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(fake, 'loader.mjs')).href, ENGINE, '--host'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    rm(dir);
  });
  await until(() => readHostInfo(file)?.pid === child.pid || child.exitCode !== null, 30000);
  assert.equal(child.exitCode, null, `the host did not start:\n${log}`);
  return { dir, file, transcript, log: () => log };
}

const textsOf = (hist) => hist.messages.map((m) => (typeof m.message?.content === 'string' ? m.message.content : (m.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')));

test('end to end: history carries the revision; historyCheck refreshes only when the transcript moved on elsewhere', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });

  // A pane opens the conversation (as a restored pane does): its history carries the transcript's revision.
  const from = w.events.length;
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: SID, cwd: h.dir, warm: false });
  const first = await w.next((m) => m.ev === 'history' && m.paneId === 'p1', 15000, from);
  assert.match(first.rev, /^\d+:\d+$/, 'history names the transcript revision');
  assert.deepEqual(textsOf(first), ['first question', 'first answer']);
  assert.ok(!first.refresh);

  // Nothing changed: fresh, and no second history.
  let mark = w.events.length;
  w.send({ op: 'historyCheck', reqId: 'c1', paneId: 'p1', sessionId: SID, rev: first.rev });
  const same = await w.next((m) => m.ev === 'historyChecked' && m.reqId === 'c1', 10000, mark);
  assert.equal(same.fresh, true);
  assert.equal(w.events.slice(mark).filter((m) => m.ev === 'history').length, 0, 'no history when nothing changed');

  // Another app (a terminal, another pane, a phone) went on with the conversation behind this pane's back.
  await sleep(30); // a different modified time even on coarse clocks
  fs.appendFileSync(h.transcript, line(msg('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'user', 'asked elsewhere')) + line(msg('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'assistant', 'answered elsewhere')));
  mark = w.events.length;
  w.send({ op: 'historyCheck', reqId: 'c2', paneId: 'p1', sessionId: SID, rev: first.rev });
  const again = await w.next((m) => m.ev === 'history' && m.paneId === 'p1', 10000, mark);
  assert.equal(again.refresh, true, 'sent again as a refresh');
  assert.notEqual(again.rev, first.rev);
  assert.deepEqual(textsOf(again), ['first question', 'first answer', 'asked elsewhere', 'answered elsewhere'], 'the whole newer conversation, nothing lost or doubled');
  const moved = await w.next((m) => m.ev === 'historyChecked' && m.reqId === 'c2', 10000, mark);
  assert.equal(moved.fresh, false);

  // With the new revision it is fresh again; a check for a session the pane does not have says fresh and sends nothing.
  mark = w.events.length;
  w.send({ op: 'historyCheck', reqId: 'c3', paneId: 'p1', sessionId: SID, rev: again.rev });
  assert.equal((await w.next((m) => m.ev === 'historyChecked' && m.reqId === 'c3', 10000, mark)).fresh, true);
  w.send({ op: 'historyCheck', reqId: 'c4', paneId: 'p1', sessionId: '0e7f4b4e-9999-4bbb-8ccc-0000000000d9', rev: 'x' });
  assert.equal((await w.next((m) => m.ev === 'historyChecked' && m.reqId === 'c4', 10000, mark)).fresh, true);
  w.send({ op: 'historyCheck', reqId: 'c5', paneId: 'nope', sessionId: SID, rev: first.rev });
  assert.equal((await w.next((m) => m.ev === 'historyChecked' && m.reqId === 'c5', 10000, mark)).fresh, true);
  assert.equal(w.events.slice(mark).filter((m) => m.ev === 'history').length, 0, 'no history for a pane or session that does not match');
  w.close();
});

test('policy: a phone may check its own open conversation for drift; the revision is validated', () => {
  const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
  const ctx = { deviceId: DEV, paneExists: (id) => id === `phone:${DEV}:p1`, paneCount: () => 1, phoneSessions: () => [SID] };
  const ok = checkPhoneCommand({ op: 'historyCheck', reqId: 'r1', paneId: 'p1', sessionId: SID, rev: '1234:1791700000000', extra: 'dropped' }, ctx);
  assert.deepEqual(ok, { ok: true, cmd: { op: 'historyCheck', reqId: `phone:${DEV}:r1`, paneId: `phone:${DEV}:p1`, sessionId: SID, rev: '1234:1791700000000' } });
  assert.equal(checkPhoneCommand({ op: 'historyCheck', paneId: 'p2', sessionId: SID }, ctx).ok, false, 'not its pane');
  assert.equal(checkPhoneCommand({ op: 'historyCheck', paneId: 'p1', sessionId: '0e7f4b4e-9999-4bbb-8ccc-0000000000d9' }, ctx).ok, false, 'a session it does not have open');
  for (const rev of ['../x', '12', 'a:b', 42]) assert.equal(checkPhoneCommand({ op: 'historyCheck', paneId: 'p1', rev }, ctx).ok, false, String(rev));
  assert.equal(checkPhoneCommand({ op: 'historyCheck', paneId: 'p1' }, ctx).ok, true, 'a pane that has no revision yet may ask');
});
