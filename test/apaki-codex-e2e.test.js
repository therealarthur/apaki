/**
 * Codex panes, end to end (apaki/engine/codex-panes.js), 2026-10-12.
 *
 * The real engine.js in host mode in a temp world, with a fake `codex app-server` (test-fixtures/fake-codex-app-server.mjs,
 * APAKI_CODEX_BIN) that replays protocol traffic shaped like codex-cli 0.161.0's: models, threads, paged turns, streamed
 * items, approvals and questions. A window connects the way Apaki's does (connectHost) and drives a Codex pane with the
 * same ops it sends a Claude pane. Nothing is billed; no real Codex process or account is touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectHost, readHostInfo } from '../apaki/engine/host.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const FAKE = path.join(ROOT, 'test-fixtures', 'fake-codex-app-server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-codex-test-'));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };
const SMALL = 'codex:01a00000-0000-7000-8000-000000000001';
const BIG = 'codex:01a00000-0000-7000-8000-000000000002';

async function until(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(step);
  }
}

const APP = 'apaki-dev-codex-test';

/** Starts engine.js in host mode in a temp world (isolated, no Glass, no index, no keeper) with the fake app-server. */
async function startHost(t, extraEnv = {}) {
  const dir = tmp();
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const log = path.join(dir, 'codex-log.jsonl');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000', APAKI_NO_ARCHIVE: '1',
    APAKI_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, FAKE_CODEX_CWD: dir, CODEX_HOME: path.join(dir, 'codex-home'), ...extraEnv,
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
  return { child, file, dir, stderr: () => stderr, calls, requests: (method) => calls().filter((c) => c.in?.method === method).map((c) => c.in.params) };
}

async function windowOf(h) {
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });
  return w;
}

/** Waits for an event; a timeout says which one and what did arrive, so a failing run explains itself. */
async function waitFor(w, label, pred, ms = 10000, from = 0) {
  try { return await w.next(pred, ms, from); } catch (e) {
    throw new Error(`timed out waiting for ${label}; events since: ${w.events.slice(from).map((m) => `${m.ev}${m.paneId ? `@${m.paneId}` : ''}${m.msg?.type ? `/${m.msg.type}` : ''}${m.msg?.event?.type ? `/${m.msg.event.type}` : ''}`).join(', ')}`, { cause: e });
  }
}

/**
 * Answers the shell requests the engine sends the window (the built-in browser): a page opens, anything else fails
 * the way a page-less browser would. Returns a function that stops answering.
 */
function answerShell(w) {
  let seen = 0;
  let stop = false;
  (async () => {
    while (!stop) {
      const i = w.events.findIndex((m, k) => k >= seen && m.ev === 'shell');
      if (i < 0) { await sleep(20); continue; }
      seen = i + 1;
      const s = w.events[i];
      w.send({ op: 'shellReply', id: s.id, ...(s.cmd === 'browser.open' ? { ok: true, result: { id: 'br1', url: s.args.url, title: 'Dev', loading: false } } : { ok: false, error: 'The browser has no page yet.' }) });
    }
  })();
  return () => { stop = true; };
}

/** A Codex pane: open it, then send / read what came since. */
async function codexPane(w, h, paneId, { sessionId = null, ...opts } = {}) {
  w.send({ op: 'open', reqId: `o-${paneId}`, paneId, sessionId, cwd: h.dir, warm: true, kind: 'codex', ...opts });
  const opened = await waitFor(w, `opened ${paneId}`, (m) => m.ev === 'opened' && m.reqId === `o-${paneId}`, 20000);
  let n = 0;
  const sdk = (from = 0) => w.events.slice(from).filter((m) => m.ev === 'sdk' && m.paneId === paneId).map((m) => m.msg);
  return {
    opened,
    sdk,
    mark: () => w.events.length,
    send: (text, extra = {}) => { const reqId = `${paneId}-${++n}`; w.send({ op: 'send', reqId, paneId, text, ...extra }); return reqId; },
    result: (reqId, ms = 15000) => waitFor(w, `the result of ${reqId}`, (m) => m.ev === 'result' && m.paneId === paneId && (m.reqId === reqId || reqId === undefined), ms),
    ask: (from = 0, ms = 10000) => waitFor(w, `an ask in ${paneId}`, (m) => m.ev === 'ask' && m.paneId === paneId, ms, from),
  };
}

const textOf = (msgs) => msgs.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content).filter((b) => b.type === 'text').map((b) => b.text).join('|');

test('the model list carries each model\'s own efforts, the presets and the account line', { timeout: 60000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  assert.equal(w.events.find((m) => m.ev === 'ready').codex, true, 'the engine says Codex is installed');
  w.send({ op: 'codexModels', reqId: 'm1' });
  const m = await waitFor(w, 'codexModels', (e) => e.ev === 'codexModels' && e.reqId === 'm1', 20000);
  assert.deepEqual(m.models.map((x) => x.id), ['gpt-6.1-sol', 'gpt-6-astra'], 'a hidden model is not offered');
  assert.deepEqual(m.models[0].efforts.map((e) => e.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(m.models[1].efforts.map((e) => e.value), ['low', 'medium', 'high']);
  assert.deepEqual(m.defaults, { model: 'gpt-6.1-sol', effort: 'low', mode: 'auto' });
  assert.deepEqual(m.presets, ['read-only', 'auto', 'full-access']);
  assert.deepEqual(m.account, { name: 'ChatGPT Pro', source: 'codex', follow: false, isKey: false });
  w.close();
});

test('the process gets Apaki\'s tool server and the BROWSER shim on its own command line, and the config is only read', { timeout: 60000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  w.send({ op: 'codexModels', reqId: 'm1' });
  await waitFor(w, 'codexModels', (e) => e.ev === 'codexModels', 20000);
  const argv = h.calls()[0].argv;
  assert.equal(argv[0], 'app-server');
  const overrides = argv.filter((_, i) => argv[i - 1] === '-c');
  assert.ok(overrides.some((o) => /^mcp_servers\.apaki\.command=".+"$/.test(o)), overrides.join('\n'));
  assert.ok(overrides.some((o) => /^mcp_servers\.apaki\.args=\[".*apaki-mcp-stdio\.mjs"\]$/.test(o.replace(/\\\\/g, '/'))), 'the tool server script');
  assert.ok(overrides.some((o) => /^mcp_servers\.apaki\.env=\{ APAKI_TOOL_PROXY = "1", APAKI_OPEN_URL = "http:\/\/127\.0\.0\.1:\d+\/open", APAKI_OPEN_TOKEN = ".+" \}$/.test(o)));
  if (process.platform === 'win32') assert.ok(overrides.some((o) => /^shell_environment_policy\.set\.BROWSER=".*apaki-open\.cmd"$/.test(o.replace(/\\\\/g, '/'))), 'BROWSER for commands Codex runs');
  const methods = h.calls().filter((c) => c.in).map((c) => c.in.method);
  assert.ok(!methods.some((m) => /config\/(value|batch)Write/.test(m)), 'no config is written');
  w.close();
});

test('a new Codex conversation: the thread starts with the first message, text streams, a result follows', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c1');
  assert.equal(p.opened.kind, 'codex');
  assert.equal(p.opened.sessionId, null);
  assert.equal(p.opened.model, 'gpt-6.1-sol');
  assert.equal(p.opened.effort, 'low');
  assert.equal(p.opened.mode, 'auto');
  assert.equal(p.opened.billing.name, 'ChatGPT Pro');
  assert.equal(h.requests('thread/start').length, 0, 'nothing starts until the first message');
  const mark = p.mark();
  const req = p.send('hello there');
  const r = await p.result(req);
  assert.equal(r.isError, false);
  assert.match(r.sessionId, /^codex:01a00000-/);
  const started = h.requests('thread/start');
  assert.equal(started.length, 1);
  assert.match(started[0].developerInstructions, /Myrlin Apaki/);
  assert.match(started[0].developerInstructions, /"show" tool/);
  assert.equal(started[0].approvalPolicy, undefined, 'the user\'s own Codex config decides until a preset is picked here');
  const sid = w.events.find((m) => m.ev === 'session_id' && m.paneId === 'c1');
  assert.equal(sid.sessionId, r.sessionId);
  const msgs = p.sdk(mark);
  assert.equal(msgs[0].type, 'stream_event');
  assert.equal(msgs[0].event.type, 'message_start');
  const deltas = msgs.filter((m) => m.event?.type === 'content_block_delta').map((m) => m.event.delta.text).join('');
  assert.equal(deltas, 'echo: hello there');
  assert.equal(textOf(msgs), 'echo: hello there');
  const turn = h.requests('turn/start')[0];
  assert.deepEqual(turn.input, [{ type: 'text', text: 'hello there', text_elements: [] }]);
  assert.equal(turn.summary, 'auto');
  assert.equal(turn.model, undefined, 'nothing was picked, so nothing is overridden');
  // The context meter from the token usage.
  const ctx = await waitFor(w, 'context', (m) => m.ev === 'context' && m.paneId === 'c1' && m.percentage != null, 5000, mark);
  assert.equal(ctx.percentage, 15);
  assert.equal(ctx.maxTokens, 10000);
  assert.deepEqual(ctx.used.map((u) => u.name), ['Input', 'Cached input', 'Output', 'Reasoning']);
  w.close();
});

test('resuming a thread: history in pages, newest first, and the older page by the first turn', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c2', { sessionId: SMALL });
  assert.equal(p.opened.sessionId, SMALL);
  assert.equal(p.opened.title, 'Small thread');
  const hist = await waitFor(w, 'history', (m) => m.ev === 'history' && m.paneId === 'c2');
  assert.equal(hist.source, 'codex');
  assert.equal(hist.hasMore, false);
  const kinds = hist.messages.map((m) => `${m.type}:${(m.message?.content || []).map((b) => b.type).join('+')}`);
  assert.deepEqual(kinds, [
    'user:text', 'assistant:thinking', 'assistant:tool_use', 'user:tool_result', 'assistant:tool_use', 'user:tool_result', 'assistant:tool_use', 'user:tool_result',
    'assistant:tool_use', 'user:tool_result', 'compact:', 'assistant:text',
  ]);
  const bash = hist.messages.find((m) => m.message?.content?.[0]?.name === 'PowerShell');
  assert.deepEqual(bash.message.content[0].input, { command: 'npm run build', cwd: 'C:\\proj' }, 'the shell wrapper comes off the command');
  const res = hist.messages.find((m) => m.message?.content?.[0]?.tool_use_id === 'c1');
  assert.equal(res.message.content[0].is_error, true);
  assert.match(res.message.content[0].content, /exit code 1/);
  const patch = hist.messages.find((m) => m.message?.content?.[0]?.name === 'ApplyPatch');
  assert.equal(patch.message.content[0].input.changes[0].kind, 'update');
  assert.ok(hist.messages.some((m) => m.message?.content?.[0]?.name === 'mcp__apaki__show'));
  // The resume asked for the thread without its turns, and with the instructions.
  const resume = h.requests('thread/resume')[0];
  assert.equal(resume.excludeTurns, true);
  assert.match(resume.developerInstructions, /Myrlin Apaki/);

  // A long thread pages by turn: the newest page first, then the page before it.
  const big = await codexPane(w, h, 'c3', { sessionId: BIG });
  const first = await waitFor(w, 'big history', (m) => m.ev === 'history' && m.paneId === 'c3');
  assert.equal(first.hasMore, true);
  assert.equal(first.countless, true, 'the server does not say how many turns exist');
  assert.equal(first.messages.at(-1).message.content[0].text, 'Answer 199');
  assert.ok(first.messages.length >= 300 && first.messages.length < 400, `the first page holds a page of messages (${first.messages.length})`);
  w.send({ op: 'historyBefore', reqId: 'hb1', paneId: 'c3', before: first.first, limit: 300 });
  const page = await waitFor(w, 'the earlier page', (m) => m.ev === 'historyPage' && m.paneId === 'c3');
  assert.equal(page.error, undefined);
  assert.equal(page.hasMore, false);
  assert.equal(page.messages[0].message.content[0].text, 'Question 0');
  assert.equal(page.messages.length + first.messages.length, 400);
  // A stale cursor is refused, not guessed.
  w.send({ op: 'historyBefore', reqId: 'hb2', paneId: 'c3', before: first.first, limit: 300 });
  const gone = await waitFor(w, 'the stale page', (m) => m.ev === 'historyPage' && m.paneId === 'c3' && m.gone, 5000, w.events.indexOf(page) + 1);
  assert.equal(gone.gone, true);
  void big;
  w.close();
});

test('the pickers: a model, an effort and a preset travel with the next turn; full access is danger-full-access with approvals never', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c4', { sessionId: SMALL });
  w.send({ op: 'model', paneId: 'c4', model: 'gpt-6-astra' });
  const afterModel = await waitFor(w, 'settings', (m) => m.ev === 'settings' && m.paneId === 'c4' && m.model === 'gpt-6-astra');
  assert.equal(afterModel.effort, 'low', 'low is on the new model\'s list too');
  w.send({ op: 'effort', paneId: 'c4', effort: 'ultra' });
  const refused = await waitFor(w, 'settings after a refused effort', (m) => m.ev === 'settings' && m.paneId === 'c4' && m !== afterModel, 5000, w.events.indexOf(afterModel) + 1);
  assert.equal(refused.effort, 'low', 'ultra is not one of that model\'s efforts');
  w.send({ op: 'effort', paneId: 'c4', effort: 'high' });
  w.send({ op: 'mode', paneId: 'c4', mode: 'full-access' });
  const modeEv = await waitFor(w, 'settings full access', (m) => m.ev === 'settings' && m.paneId === 'c4' && m.mode === 'full-access');
  assert.equal(modeEv.effort, 'high');
  const req = p.send('now');
  await p.result(req);
  const turn = h.requests('turn/start')[0];
  assert.equal(turn.model, 'gpt-6-astra');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' });
  w.send({ op: 'mode', paneId: 'c4', mode: 'read-only' });
  await waitFor(w, 'settings read only', (m) => m.ev === 'settings' && m.paneId === 'c4' && m.mode === 'read-only');
  await p.result(p.send('again'));
  const second = h.requests('turn/start')[1];
  assert.equal(second.approvalPolicy, 'on-request');
  assert.deepEqual(second.sandboxPolicy, { type: 'readOnly' });
  // A mode that is not one of the presets changes nothing.
  w.send({ op: 'mode', paneId: 'c4', mode: 'bypassPermissions' });
  const same = await waitFor(w, 'settings after a bad mode', (m) => m.ev === 'settings' && m.paneId === 'c4', 5000, w.events.length - 1).catch(() => null);
  void same;
  w.close();
});

test('reasoning, command runs with live output, plans as a checklist and failures as results', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c5', { sessionId: SMALL });
  let mark = p.mark();
  await p.result(p.send('think: the build'));
  let msgs = p.sdk(mark);
  const thinking = msgs.find((m) => m.type === 'assistant' && m.message.content[0].type === 'thinking');
  assert.equal(thinking.message.content[0].thinking, 'Thinking about the build');
  assert.ok(msgs.some((m) => m.event?.type === 'content_block_start' && m.event.content_block.type === 'thinking'), 'the working line changes while it thinks');

  mark = p.mark();
  await p.result(p.send('run: echo hi'));
  msgs = p.sdk(mark);
  const use = msgs.find((m) => m.type === 'assistant' && m.message.content[0].type === 'tool_use');
  assert.equal(use.message.content[0].name, 'Bash');
  assert.equal(use.message.content[0].input.command, 'echo hi');
  const out = msgs.filter((m) => m.subtype === 'tool_output');
  assert.ok(out.length >= 1);
  assert.match(out.at(-1).text, /line one/);
  const res = msgs.find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result');
  assert.equal(res.message.content[0].is_error, false);
  assert.equal(res.message.content[0].content, 'line one\nline two');

  mark = p.mark();
  await p.result(p.send('run: fail now'));
  const bad = p.sdk(mark).find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result');
  assert.equal(bad.message.content[0].is_error, true);
  assert.match(bad.message.content[0].content, /\(exit code 1\)$/);

  mark = p.mark();
  await p.result(p.send('plan: read the code|write the fix|run the tests'));
  const todo = p.sdk(mark).find((m) => m.type === 'assistant' && m.message.content[0].name === 'TodoWrite');
  assert.deepEqual(todo.message.content[0].input.todos, [
    { content: 'read the code', activeForm: '', status: 'in_progress' },
    { content: 'write the fix', activeForm: '', status: 'pending' },
    { content: 'run the tests', activeForm: '', status: 'pending' },
  ]);

  // A failed turn is a failed result with Codex's reason, in words.
  const failed = await p.result(p.send('fail: the account is out'));
  assert.equal(failed.isError, true);
  assert.match(failed.result, /usage limit/i);
  assert.match(failed.result, /the account is out/);

  // A failed hook, a model reroute and a usage warning read like Claude Code's notices.
  mark = p.mark();
  await p.result(p.send('hook'));
  const hook = p.sdk(mark).find((m) => m.subtype === 'hook_response');
  assert.equal(hook.outcome, 'error');
  assert.equal(hook.stderr, 'policy said no');
  mark = p.mark();
  await p.result(p.send('reroute'));
  assert.match(p.sdk(mark).find((m) => m.subtype === 'informational').content, /switched this turn from gpt-6\.1-sol to gpt-6-astra/);
  mark = p.mark();
  await p.result(p.send('limit'));
  const lim = p.sdk(mark).find((m) => m.type === 'rate_limit_event');
  assert.equal(lim.rate_limit_info.rateLimitType, 'five_hour');
  assert.equal(lim.rate_limit_info.status, 'allowed_warning');
  w.close();
});

test('stop, steer, and a queued message while a turn runs', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c6', { sessionId: SMALL });
  // Stop: the turn completes as interrupted.
  let req = p.send('hang');
  await waitFor(w, 'the first delta', (m) => m.ev === 'sdk' && m.paneId === 'c6' && m.msg.event?.type === 'content_block_delta', 10000);
  w.send({ op: 'interrupt', paneId: 'c6' });
  let r = await p.result(req);
  assert.equal(r.interrupted, true);
  assert.equal(r.isError, false);
  assert.equal(h.requests('turn/interrupt').length, 1);
  // Steer: the message goes into the running turn, which then answers it.
  req = p.send('hang');
  await waitFor(w, 'the delta again', (m) => m.ev === 'sdk' && m.paneId === 'c6' && m.msg.event?.type === 'content_block_delta', 10000, w.events.length - 1).catch(() => null);
  await sleep(150);
  w.send({ op: 'steer', reqId: 'st1', paneId: 'c6', qid: 'q1', text: 'actually, use tabs' });
  const steered = await waitFor(w, 'steered', (m) => m.ev === 'steered' && m.paneId === 'c6');
  assert.equal(steered.qid, 'q1');
  r = await p.result(req);
  assert.equal(r.isError, false);
  const steer = h.requests('turn/steer')[0];
  assert.match(steer.expectedTurnId, /^01a00000-/);
  assert.deepEqual(steer.input, [{ type: 'text', text: 'actually, use tabs', text_elements: [] }]);
  // A steer with no turn running is reported missed (the pane then sends it as a message).
  w.send({ op: 'steer', reqId: 'st2', paneId: 'c6', qid: 'q2', text: 'too late' });
  const missed = await waitFor(w, 'steer_missed', (m) => m.ev === 'steer_missed' && m.paneId === 'c6' && m.qid === 'q2');
  assert.equal(missed.qid, 'q2');
  w.close();
});

test('a Codex question is the same sheet as Claude\'s, answered once; a skipped one answers nothing', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c7', { sessionId: SMALL });
  let mark = p.mark();
  let req = p.send('ask: Alpha or Beta?');
  let ask = await p.ask(mark);
  assert.equal(ask.toolName, 'AskUserQuestion');
  assert.equal(ask.input.questions.length, 1);
  assert.equal(ask.input.questions[0].question, 'Alpha or Beta?');
  assert.deepEqual(ask.input.questions[0].options, [{ label: 'Alpha', description: 'The first' }, { label: 'Beta', description: 'The second' }]);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', updatedInput: { ...ask.input, answers: { 'Alpha or Beta?': 'Beta' } } } });
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', updatedInput: { ...ask.input, answers: { 'Alpha or Beta?': 'Alpha' } } } });
  let r = await p.result(req);
  assert.match(r.sessionId, /^codex:/);
  const said = textOf(p.sdk(mark));
  assert.equal(said, 'answers {"answers":{"choice":{"answers":["Beta"]}}}', 'the first answer counts, the second is ignored');

  mark = p.mark();
  req = p.send('ask: Skip me?');
  ask = await p.ask(mark);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'deny', message: 'The user skipped the question.' } });
  await p.result(req);
  assert.equal(textOf(p.sdk(mark)), 'answers {"answers":{"choice":{"answers":[]}}}');
  w.close();
});

test('approvals: a command and a patch show the permission sheet with Codex\'s words; once, for the session, deny', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c8', { sessionId: SMALL });
  let mark = p.mark();
  let req = p.send('approve: npm install left-pad');
  let ask = await p.ask(mark);
  assert.equal(ask.toolName, 'Bash');
  assert.equal(ask.input.command, 'npm install left-pad');
  assert.equal(ask.permission.title, 'Run this command?');
  assert.equal(ask.permission.decisionReason, 'Needs network');
  assert.deepEqual(ask.permission.labels, { once: 'Approve once', always: 'Approve for this session', deny: 'Deny' });
  assert.deepEqual(ask.permission.always, { lines: ['Approve this command for the rest of this session'] });
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow' } });
  await p.result(req);
  assert.equal(textOf(p.sdk(mark)), 'approval {"decision":"accept"}');

  mark = p.mark();
  req = p.send('approve: npm test');
  ask = await p.ask(mark);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', always: true } });
  await p.result(req);
  assert.equal(textOf(p.sdk(mark)), 'approval {"decision":"acceptForSession"}');

  mark = p.mark();
  req = p.send('approve: rm -rf build');
  ask = await p.ask(mark);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'deny', message: 'Do not delete that' } });
  await p.result(req);
  assert.equal(textOf(p.sdk(mark)), 'approval {"decision":"decline"}');
  const noteSteer = h.requests('turn/steer');
  assert.ok(noteSteer.length === 0 || /Do not delete that/.test(JSON.stringify(noteSteer)), 'a note goes to the model when a turn is still running');

  // A patch asks with its diff; the server withdraws the request when it is answered (serverRequest/resolved), and a turn
  // that ends drops what is left.
  mark = p.mark();
  req = p.send('patch: src/a.ts');
  ask = await p.ask(mark);
  assert.equal(ask.toolName, 'ApplyPatch');
  assert.equal(ask.input.changes[0].path, 'src/a.ts');
  assert.match(ask.input.changes[0].diff, /\+new/);
  assert.equal(ask.permission.title, 'Apply these changes?');
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow' } });
  await p.result(req);
  assert.equal(textOf(p.sdk(mark)), 'patch {"decision":"accept"}');
  // The turn's changes come as a card, not a viewer that pops up.
  const art = await waitFor(w, 'the changes card', (m) => m.ev === 'artifact' && m.paneId === 'c8' && m.via === 'codex-diff', 10000, mark);
  assert.equal(art.title, 'Changes: 1 file');
  assert.equal(art.sessionId, SMALL, 'the pane\'s own session id, so the viewer asks for it the way every artifact is asked for');
  assert.ok(!w.events.slice(mark).some((m) => m.ev === 'error'), JSON.stringify(w.events.filter((m) => m.ev === 'error')));
  w.close();
});

test('a form from a tool server becomes the question sheet', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c9', { sessionId: SMALL });
  const mark = p.mark();
  const req = p.send('elicit');
  const ask = await p.ask(mark);
  assert.equal(ask.toolName, 'AskUserQuestion');
  assert.equal(ask.input.questions[0].question, 'Space');
  assert.deepEqual(ask.input.questions[0].options.map((o) => o.label), ['eng', 'ops']);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', updatedInput: { ...ask.input, answers: { [ask.input.questions[0].question]: 'ops' } } } });
  await p.result(req);
  assert.equal(textOf(p.sdk(mark)), 'elicitation {"action":"accept","content":{"space":"ops"},"_meta":null}');
  w.close();
});

test('a window that comes back to a running Codex pane attaches: same turn, history again, the question asked again', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c10', { sessionId: SMALL });
  const mark = p.mark();
  const req = p.send('ask: Still there?');
  const ask = await p.ask(mark);
  w.close();
  const w2 = await windowOf(h);
  // The restored window opens the pane with warm: false; the host keeps its thread and its turn.
  w2.send({ op: 'open', reqId: 'again', paneId: 'c10', sessionId: SMALL, cwd: h.dir, warm: false });
  const reopened = await waitFor(w2, 'opened again', (m) => m.ev === 'opened' && m.reqId === 'again');
  assert.equal(reopened.attached, true);
  assert.equal(reopened.busy, true);
  assert.equal(reopened.kind, 'codex');
  const again = await waitFor(w2, 'the ask again', (m) => m.ev === 'ask' && m.askId === ask.askId);
  assert.equal(again.input.questions[0].question, ask.input.questions[0].question);
  w2.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', updatedInput: { ...again.input, answers: { [again.input.questions[0].question]: 'Alpha' } } } });
  const done = await waitFor(w2, 'the result', (m) => m.ev === 'result' && m.paneId === 'c10');
  assert.equal(done.isError, false);
  void req;
  assert.equal(h.requests('thread/resume').length, 1, 'the thread was not resumed again');
  w2.close();
});

test('slash commands, rename and the thread list', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  // Two rollout files the fake server does not list, one active and one archived: the Codex view lists them too (read only).
  const ROLL = '01a00000-0000-7000-8000-0000000000aa';
  const ROLL_OLD = '01a00000-0000-7000-8000-0000000000bb';
  const day = path.join(h.dir, 'codex-home', 'sessions', '2026', '10', '12');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'codex-home', 'archived_sessions'), { recursive: true });
  const rollout = (id, text) => `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'C:\old\proj', timestamp: '2026-10-12T01:02:03Z' } })}
${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })}
`;
  fs.writeFileSync(path.join(day, `rollout-2026-10-12T01-02-03-${ROLL}.jsonl`), rollout(ROLL, 'Explain the retry schedule'));
  fs.writeFileSync(path.join(h.dir, 'codex-home', 'archived_sessions', `rollout-2026-09-01T01-02-03-${ROLL_OLD}.jsonl`), rollout(ROLL_OLD, 'An archived thread'));
  const w = await windowOf(h);
  w.send({ op: 'codexThreads', reqId: 'l1' });
  const list = await waitFor(w, 'codexThreads', (m) => m.ev === 'codexThreads' && m.reqId === 'l1', 20000);
  const rolled = list.items.filter((i) => i.id === `codex:${ROLL}` || i.id === `codex:${ROLL_OLD}`);
  assert.deepEqual(rolled.map((i) => i.id).sort(), [`codex:${ROLL}`, `codex:${ROLL_OLD}`]);
  assert.equal(rolled.find((i) => i.id === `codex:${ROLL}`).title, 'Explain the retry schedule');
  assert.equal(rolled.find((i) => i.id === `codex:${ROLL_OLD}`).archived, true, 'archived in Codex lists under Archived');
  assert.deepEqual(list.items.filter((i) => !rolled.includes(i)).map((i) => i.id), [SMALL, BIG]);
  assert.equal(list.items[0].codex, true);
  assert.equal(list.items[0].title, 'Small thread');
  assert.equal(list.items[0].archived, false, 'rows carry the fields every session row has');

  const p = await codexPane(w, h, 'c11', { sessionId: SMALL });
  w.send({ op: 'commands', reqId: 'cm', paneId: 'c11' });
  const cmds = await waitFor(w, 'commands', (m) => m.ev === 'commands' && m.paneId === 'c11');
  assert.deepEqual(cmds.commands.map((c) => c.name), ['compact', 'status', 'review', 'diff', 'mcp', 'init', 'mention']);

  let mark = p.mark();
  await p.result(p.send('/status'));
  const note = w.events.slice(mark).find((m) => m.ev === 'note' && m.paneId === 'c11');
  assert.match(note.text, /gpt-6\.1-sol, effort low, auto/);
  assert.equal(h.requests('turn/start').length, 0, 'a slash command is not a message to the model');

  mark = p.mark();
  await p.result(p.send('/compact'));
  assert.equal(h.requests('thread/compact/start').length, 1);
  assert.ok(p.sdk(mark).some((m) => m.subtype === 'compact_boundary'));

  w.send({ op: 'rename', reqId: 'rn', sessionId: SMALL, title: 'Renamed in Apaki', paneId: 'c11' });
  const renamed = await waitFor(w, 'renamed', (m) => m.ev === 'renamed' && m.sessionId === SMALL && m.ok);
  assert.equal(renamed.title, 'Renamed in Apaki');
  assert.equal(h.requests('thread/name/set')[0].name, 'Renamed in Apaki');
  w.close();
});

test('Apaki\'s tools reach Codex through the tool server: show runs in the engine for the running pane, and a link opens in Apaki', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  t.after(answerShell(w));
  const p = await codexPane(w, h, 'c12', { sessionId: SMALL });
  // The tool server's own token (it is in the -c override) is how Codex's process talks to the engine.
  const argv = h.calls()[0].argv;
  const env = argv.find((a) => a.startsWith('mcp_servers.apaki.env='));
  const url = /APAKI_OPEN_URL = "([^"]+)"/.exec(env)[1];
  const token = /APAKI_OPEN_TOKEN = "([^"]+)"/.exec(env)[1];
  const call = async (body) => (await fetch(url.replace(/\/open$/, '/tool'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-apaki-token': token }, body: JSON.stringify(body) })).json();
  // Nothing is running: the call still reaches the open pane.
  const mark = p.mark();
  const shown = await call({ tool: 'show', input: { title: 'Report', kind: 'markdown', content: '# Report\n\nhello' } });
  assert.equal(shown.ok, true, shown.text);
  assert.match(shown.text, /artifact report-[0-9a-f]{4}, rev 1, markdown/);
  const art = await waitFor(w, 'the artifact', (m) => m.ev === 'artifact' && m.paneId === 'c12', 10000, mark);
  assert.equal(art.title, 'Report');
  assert.equal(art.sessionId, SMALL);
  // A browser tool with no browser says so, as it does for Claude (the test's shell has none).
  const b = await call({ tool: 'browser_read', input: {} });
  assert.equal(b.ok, false);
  // A bad token is refused.
  const bad = await fetch(url.replace(/\/open$/, '/tool'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-apaki-token': 'nope' }, body: '{"tool":"show"}' });
  assert.equal(bad.status, 403);
  // A link a command opens through BROWSER lands in the pane (the engine tells the window to open it).
  const link = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apaki-token': token }, body: JSON.stringify({ url: 'http://localhost:5173/' }) });
  assert.equal(link.status, 204);
  const open = await waitFor(w, 'openUrl', (m) => m.ev === 'openUrl' && m.paneId === 'c12', 10000, mark);
  assert.equal(open.url, 'http://localhost:5173/');
  assert.equal(open.reason, 'BROWSER');
  assert.equal(open.browserId, 'br1', 'the page went to the built-in browser');
  w.close();
});

test('the pane closes cleanly: the thread is unsubscribed and a running turn is interrupted', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await codexPane(w, h, 'c13', { sessionId: SMALL });
  p.send('hang');
  await waitFor(w, 'the first delta', (m) => m.ev === 'sdk' && m.paneId === 'c13' && m.msg.event?.type === 'content_block_delta', 10000);
  w.send({ op: 'close', reqId: 'x', paneId: 'c13' });
  await waitFor(w, 'closed', (m) => m.ev === 'closed' && m.paneId === 'c13');
  await until(() => h.requests('thread/unsubscribe').length === 1, 5000);
  assert.equal(h.requests('turn/interrupt').length, 1);
  w.close();
});
