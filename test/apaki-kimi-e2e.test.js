/** The real Apaki host and a fake Kimi ACP child, in an isolated invented home. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectHost, readHostInfo } from '../apaki/engine/host.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki/engine/engine.js');
const FAKE = path.join(ROOT, 'test-fixtures/fake-kimi-acp.mjs');
const SID = '00000000-0000-4000-8000-000000000001';
const ID = `kimi:${SID}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const value = fn(); if (value) return value; if (Date.now() > end) throw new Error('Timed out waiting for isolated engine'); await delay(20); }
}
async function host(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-kimi-engine-'));
  const claude = path.join(dir, 'claude');
  const home = path.join(dir, 'kimi');
  const session = path.join(home, 'sessions', 'fixture-workspace', SID);
  fs.mkdirSync(path.join(session, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(session, 'state.json'), JSON.stringify({ title: 'Invented Kimi session', cwd: dir, updatedAt: 1700000000000 }));
  fs.writeFileSync(path.join(session, 'agents/main/wire.jsonl'), JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'Rare amber seahorse fixture' }] } }) + '\n');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  const file = path.join(claude, 'latch', 'host.json');
  const log = path.join(dir, 'fake-rpc.jsonl');
  const child = spawn(process.execPath, [ENGINE, '--host'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: {
    ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'),
    APAKI_APP_ID: 'apaki-dev-kimi-test', APAKI_HOST_FILE: file, APAKI_REMOTE_DIR: path.join(dir, 'remote'),
    LATCH_GLASS_CLI: path.join(dir, 'no-glass'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login'), CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials'),
    APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1', APAKI_NO_ARCHIVE: '1',
    APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
    APAKI_KIMI_BIN: FAKE, APAKI_KIMI_NODE: process.execPath, KIMI_CODE_HOME: home, FAKE_KIMI_LOG: log,
    APAKI_CODEX_BIN: path.join(dir, 'no-codex'), CODEX_HOME: path.join(dir, 'codex'),
  } });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.once('exit', r));
  const connections = [];
  t.after(async () => {
    for (const w of connections) w.close();
    if (child.exitCode === null) { child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => readHostInfo(file)?.pid === child.pid || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr);
  const connect = async () => { const w = await connectHost({ file, role: 'window' }); connections.push(w); await w.next((e) => e.ev === 'ready'); return w; };
  return { child, dir, home, connect, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
const next = async (w, ev, reqId, from = 0) => {
  try { return await w.next((e) => e.ev === ev && (!reqId || e.reqId === reqId), 15000, from); }
  catch (e) { throw new Error(`Waiting for ${ev}/${reqId}: ${w.events.slice(from).map((m) => `${m.ev}/${m.reqId || ''}/${m.paneId || ''}/${m.message || ''}`).join(', ')}`, { cause: e }); }
};

test('engine lists, searches, opens and continues Kimi in existing panes and retains it across reconnects', { timeout: 60000 }, async (t) => {
  const h = await host(t), w = await h.connect();
  assert.equal(w.events.find((e) => e.ev === 'ready').kimi, true);
  w.send({ op: 'sessions', reqId: 'list' });
  const row = (await next(w, 'sessions', 'list')).items.find((r) => r.id === ID);
  assert.equal(row.kimi, true); assert.equal(row.title, 'Invented Kimi session');
  w.send({ op: 'search', reqId: 'search', query: 'amber seahorse' });
  const hit = (await next(w, 'search', 'search')).results.find((r) => r.item.id === ID);
  assert.match(hit.snippet, /amber seahorse/);
  assert.equal(h.calls().length, 0, 'list and search never start Kimi');
  w.send({ op: 'open', paneId: 'k1', reqId: 'open', sessionId: ID });
  w.send({ op: 'open', paneId: 'concurrent', reqId: 'concurrent', sessionId: ID });
  const opened = await next(w, 'opened', 'open');
  assert.equal(opened.kind, 'kimi'); assert.equal(opened.model, 'kimi-code/k3.1-pro'); assert.equal(opened.effort, 'max');
  assert.equal(opened.billing.name, 'Kimi OAuth');
  assert.equal((await next(w, 'history', 'open')).messages.length, 2);
  assert.equal((await next(w, 'open_elsewhere', 'concurrent')).otherPane, 'k1');
  w.send({ op: 'open', paneId: 'duplicate', reqId: 'dup', sessionId: ID });
  assert.equal((await next(w, 'open_elsewhere', 'dup')).otherPane, 'k1');
  assert.equal(h.calls().filter((c) => c.in?.method === 'session/load').length, 1);
  w.send({ op: 'send', paneId: 'k1', reqId: 'send', text: 'approve' });
  const ask = await next(w, 'ask');
  w.close();
  const w2 = await h.connect();
  w2.send({ op: 'attach', reqId: 'attach', paneId: 'k1', sessionId: ID });
  const attached = await next(w2, 'opened', 'attach');
  assert.equal(attached.kind, 'kimi'); assert.equal(attached.busy, true);
  assert.ok((await next(w2, 'history', 'attach')).messages.some((m) => m.message.content.some((b) => b.text === 'Hello from Kimi.')));
  await w2.next((e) => e.ev === 'ask' && e.askId === ask.askId);
  w2.send({ op: 'answer', paneId: 'k1', askId: ask.askId, result: { behavior: 'allow' } });
  assert.equal((await next(w2, 'result', 'send')).isError, false);
  w2.send({ op: 'answer', paneId: 'k1', askId: ask.askId, result: { behavior: 'allow' } });
  w2.send({ op: 'effort', paneId: 'k1', reqId: 'wrong', effort: 'low' });
  assert.match((await next(w2, 'error', 'wrong')).message, /max effort/);
  w2.send({ op: 'billing', paneId: 'k1', reqId: 'bill', value: 'sub' });
  assert.match((await next(w2, 'error', 'bill')).message, /not supported for Kimi/);
  w2.send({ op: 'consoleOpen', paneId: 'k1', reqId: 'console' });
  assert.match((await next(w2, 'error', 'console')).message, /not supported for Kimi/);
  w2.send({ op: 'pin', reqId: 'pin', sessionId: ID, pinned: true });
  assert.ok((await next(w2, 'sessions', 'pin')).items.find((r) => r.id === ID).pinned);
  w2.send({ op: 'sessionInfo', reqId: 'info', sessionId: ID });
  assert.equal((await next(w2, 'sessionInfo', 'info')).info.provider, 'kimi');
  w2.send({ op: 'historyPrompts', paneId: 'k1', reqId: 'prompts' });
  assert.equal((await next(w2, 'historyPrompts', 'prompts')).total, 2);
  w2.send({ op: 'open', paneId: 'c1', reqId: 'claude', warm: false });
  const claude = await next(w2, 'opened', 'claude');
  assert.equal(claude.model.startsWith('claude-'), true, 'Kimi picks did not change Claude defaults');
  w2.send({ op: 'send', paneId: 'k1', reqId: 'hang', text: 'hang' });
  await w2.next((e) => e.ev === 'sdk' && e.paneId === 'k1', 10000, w2.events.length);
  w2.send({ op: 'interrupt', paneId: 'k1' });
  assert.equal((await next(w2, 'result', 'hang')).stopReason, 'cancelled');
  w2.send({ op: 'close', paneId: 'k1', reqId: 'close' });
  await next(w2, 'closed', 'close');
  assert.equal(h.calls().filter((c) => c.in?.method === 'session/new').length, 0);
});

test('engine creates independent Kimi panes and refuses sends after a failed open without invoking Claude', { timeout: 60000 }, async (t) => {
  const h = await host(t), w = await h.connect();
  for (const id of ['a', 'b']) {
    w.send({ op: 'open', kind: 'kimi', paneId: id, reqId: `open-${id}`, cwd: h.dir });
    assert.equal((await next(w, 'opened', `open-${id}`)).kind, 'kimi');
  }
  w.send({ op: 'send', paneId: 'a', reqId: 'a', text: 'hang' });
  w.send({ op: 'send', paneId: 'b', reqId: 'b', text: 'question' });
  const ask = await next(w, 'ask');
  assert.equal(ask.paneId, 'b');
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', updatedInput: { answers: { Color: 'Green', Parts: 'B' } } } });
  assert.equal((await next(w, 'result', 'b')).isError, false);
  assert.equal(w.events.some((e) => e.ev === 'result' && e.reqId === 'a'), false);
  const aId = (await w.next((e) => e.ev === 'session_id' && e.paneId === 'a')).sessionId;
  const bId = (await w.next((e) => e.ev === 'session_id' && e.paneId === 'b')).sessionId;
  assert.notEqual(aId, bId);
  w.send({ op: 'open', kind: 'kimi', paneId: 'a', reqId: 'restore-new', sessionId: null, warm: false });
  const restored = await next(w, 'opened', 'restore-new');
  assert.equal(restored.sessionId, aId, 'a workspace saved before the first session ID reattaches to its running turn');
  assert.equal(restored.busy, true);
  w.send({ op: 'close', paneId: 'a', reqId: 'close-a' }); await next(w, 'closed', 'close-a');
  w.send({ op: 'open', kind: 'kimi', paneId: 'bad', sessionId: 'kimi:missing-session', reqId: 'bad', cwd: h.dir });
  await next(w, 'error', 'bad');
  w.send({ op: 'send', paneId: 'bad', reqId: 'bad-send', text: 'must not run' });
  assert.equal((await next(w, 'result', 'bad-send')).isError, true);
  assert.equal(h.calls().filter((c) => c.in?.method === 'session/prompt').length, 2);
});
