/** Kimi provider tests use invented storage and a fake ACP child, never a login. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KimiClient, findKimi, kimiHome, kimiEnv, kimiSessionId } from '../apaki/engine/kimi-client.js';
import { createKimiList, kimiExcluded } from '../apaki/engine/kimi-list.js';
import { KimiTranscript, permissionAsk, elicitationAsk, kimiBilling } from '../apaki/engine/kimi-map.js';
import { createKimi } from '../apaki/engine/kimi-panes.js';
import { kimiChoices, isKimiRow } from '../apaki/ui/kimi.js';
import { leadOf, sessionMenuItems, sessionFacts } from '../apaki/ui/sessionlist.js';
import { questionAnswers, questionsModel } from '../apaki/ui/askcard.js';
import { checkPhoneCommand } from '../apaki/engine/remote-policy.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test-fixtures', 'fake-kimi-acp.mjs');
const SID = '00000000-0000-4000-8000-000000000001';
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-kimi-'));
  const cleanup = [];
  t.after(async () => { for (const stop of cleanup) await stop(); fs.rmSync(dir, { force: true, recursive: true }); });
  const home = path.join(dir, 'kimi-home');
  fs.mkdirSync(home);
  const log = path.join(dir, 'rpc.jsonl');
  return { dir, home, log, cleanup, env: { ...process.env, KIMI_CODE_HOME: home, APAKI_KIMI_BIN: FAKE, APAKI_KIMI_NODE: process.execPath, FAKE_KIMI_LOG: log }, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
function stored(w, id = SID, meta = {}, journal = []) {
  const dir = path.join(w.home, 'sessions', 'fixture-workspace', id);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ cwd: w.dir, title: 'Invented session', updatedAt: 1700000000000, ...meta }));
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), journal.map(JSON.stringify).join('\n'));
  return dir;
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const result = fn(); if (result) return result; if (Date.now() > end) throw new Error('Expected fake ACP event did not arrive'); await new Promise((r) => setTimeout(r, 10)); }
}
async function harness(t, extra = {}) {
  const w = world(t), events = [], asks = new Map(), panes = new Map();
  const list = createKimiList({ home: w.home, ttlMs: 0 });
  let ended = 0;
  const kimi = createKimi({ emit: (e) => events.push(e), asks, panes, list, cancelMs: 70, turnEnded: () => { ended += 1; }, clientFactory: (opts) => new KimiClient({ ...opts, env: { ...w.env, ...extra }, timeoutMs: 1000 }) });
  w.cleanup.push(() => kimi.shutdown());
  const p = { id: 'p1' }; panes.set(p.id, p);
  return { ...w, kimi, list, p, events, asks, panes, ended: () => ended };
}

test('portable discovery uses Node directly and sets both helper rules', () => {
  const home = 'C:\\Users\\Fixture';
  const state = `${home}\\Projects\\kimi-kit-20261023\\state`;
  const cli = `${state}\\npm\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs`;
  const node = `${state}\\node-v22.22.1-win-x64\\node.exe`;
  const env = { USERPROFILE: home, PATH: '' };
  assert.deepEqual(findKimi({ env, platform: 'win32', exists: (f) => [cli, node].includes(f) }), { command: node, args: [cli] });
  assert.equal(kimiHome(env, 'win32', () => true), `${state}\\kimi-home`);
  assert.equal(findKimi({ env: { APAKI_KIMI_BIN: 'x.cmd' }, exists: () => true }), null);
  assert.deepEqual(findKimi({ env: { APAKI_KIMI_BIN: '/fixture/cli.mjs', APAKI_KIMI_NODE: '/fixture/node' }, exists: () => true }), { command: '/fixture/node', args: ['/fixture/cli.mjs'] });
  assert.equal(kimiEnv({ KIMI_CODE_HOME: '/fixture', KIMI_SECONDARY_EFFORT: 'low' }).KIMI_SECONDARY_EFFORT, 'high');
  assert.equal(kimiEnv({ KIMI_CODE_HOME: '/fixture' }).KIMI_SECONDARY_MODEL, 'kimi-code/k3.1-pro');
  assert.throws(() => kimiSessionId('kimi:../escape'));
});

test('metadata listing and streamed keyword search find older main-agent content and ignore malformed lines', async (t) => {
  const w = world(t);
  const dir = stored(w, SID, {}, [
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'A rare sapphire lantern' }] } },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Older quartz reply' } } },
    { type: 'context.append_loop_event', event: { type: 'tool.result', result: { output: 'Tool fossil output' } } },
  ]);
  fs.appendFileSync(path.join(dir, 'agents/main/wire.jsonl'), '\n{partial');
  stored(w, 'excluded-session', { cwd: 'C:\\Users\\Fixture\\Pictures' });
  const list = createKimiList({ home: w.home, ttlMs: 0 });
  assert.equal((await list.refresh()).length, 1);
  assert.equal((await list.search('sapphire lantern'))[0].item.id, `kimi:${SID}`);
  assert.match((await list.search('quartz'))[0].snippet, /Older quartz/);
  assert.equal((await list.search('fossil'))[0].sources[0], 'words');
  assert.equal((await list.search('invented session')).length, 1);
  assert.equal((await list.search('absent')).length, 0);
  fs.appendFileSync(path.join(dir, 'agents/main/wire.jsonl'), '\n' + JSON.stringify({ type: 'context.append_message', message: { content: 'fresh opal' } }));
  assert.equal((await list.search('opal')).length, 1);
});

test('legacy metadata is readable and session symlinks are not followed', async (t) => {
  const w = world(t), dir = stored(w);
  fs.mkdirSync(path.join(dir, 'session-meta'));
  fs.renameSync(path.join(dir, 'state.json'), path.join(dir, 'session-meta/state.json'));
  const root = path.join(w.home, 'sessions');
  try { fs.symlinkSync(dir, path.join(root, 'fixture-workspace', 'linked'), 'junction'); } catch (e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
  const list = createKimiList({ home: w.home });
  assert.equal((await list.refresh()).length, 1);
  assert.equal(kimiExcluded('C:/Users/Fixture/Documents/ChatGPT/child'), true);
  assert.equal(kimiExcluded('/fixture/user_test.md'), true);
  assert.equal(kimiExcluded(w.dir), false);
});

test('permission options preserve opaque IDs and reject unoffered persistent approvals', () => {
  const a = permissionAsk({ toolCall: { title: 'Bash' }, options: [{ name: 'Allow', optionId: 'a9', kind: 'allow_once' }, { name: 'No', optionId: 'r8', kind: 'reject_once' }] });
  assert.equal(a.permission.always, null);
  assert.equal(a.reply({ behavior: 'allow' }).outcome.optionId, 'a9');
  assert.throws(() => a.reply({ behavior: 'allow', always: true }));
  assert.equal(a.reply({ behavior: 'deny' }).outcome.optionId, 'r8');
  const plan = permissionAsk({ toolCall: { title: 'Review plan' }, options: [{ name: 'Approve', optionId: 'plan_opt_1', kind: 'allow_once' }, { name: 'Revise', optionId: 'plan_revise', kind: 'reject_once' }] });
  const q = plan.input.questions[0];
  assert.equal(q.other, false);
  assert.equal(plan.reply({ behavior: 'allow', updatedInput: { answers: { [q.question]: 'Revise' } } }).outcome.optionId, 'plan_revise');
});

test('question forms preserve multiple questions and multi-select without accepting invented answers', () => {
  const a = elicitationAsk({ mode: 'form', requestedSchema: { type: 'object', properties: { q0: { type: 'string', title: 'Color', oneOf: [{ const: 'Blue' }] }, q1: { type: 'array', title: 'Parts', items: { anyOf: [{ const: 'A' }, { const: 'B' }] } } } } });
  const r = a.reply({ behavior: 'allow', updatedInput: { answers: { Color: 'Blue', Parts: 'A, B' } } });
  assert.deepEqual(r, { action: 'accept', content: { q0: 'Blue', q1: ['A', 'B'] } });
  assert.throws(() => a.reply({ behavior: 'allow', updatedInput: { answers: { Color: 'made up' } } }));
  assert.equal(a.reply(null).action, 'decline');
  const comma = elicitationAsk({ mode: 'form', requestedSchema: { type: 'object', properties: { q0: { type: 'array', title: 'Parts', items: { anyOf: [{ const: 'B, C' }, { const: 'A' }] } } } } });
  const answers = questionAnswers(questionsModel(comma), { picks: [[1, 0]], other: [''] }, true);
  assert.deepEqual(comma.reply({ behavior: 'allow', updatedInput: { answers } }).content.q0, ['A', 'B, C']);
});

test('new Kimi pane streams, pins model and max before every prompt, and reports usage', async (t) => {
  const h = await harness(t);
  await h.kimi.open('o', h.p, null, h.dir);
  assert.equal(h.calls().length, 0, 'a blank pane does not start the CLI');
  await h.kimi.send('s', h.p, 'hello');
  const result = await until(() => h.events.find((e) => e.ev === 'result'));
  assert.equal(result.isError, false);
  assert.ok(h.events.some((e) => e.ev === 'sdk' && e.msg.event?.type === 'content_block_delta'));
  assert.ok(h.events.some((e) => e.ev === 'context' && e.totalTokens === 1200));
  const calls = h.calls();
  assert.deepEqual(calls[0].argv, ['-m', 'kimi-code/k3.1-pro', 'acp']);
  assert.equal(calls[0].effort, 'high');
  const prompts = calls.filter((c) => c.in?.method === 'session/prompt');
  assert.equal(prompts.length, 1);
  assert.ok(calls.filter((c) => c.in?.method === 'session/set_config_option').some((c) => c.in.params.configId === 'thinking' && c.in.params.value === 'max'));
  await h.kimi.send('s2', h.p, 'plan');
  await until(() => h.events.find((e) => e.ev === 'result' && e.reqId === 's2'));
  assert.ok(h.events.some((e) => e.msg?.message?.content?.some((b) => b.name === 'TodoWrite')));
  assert.equal(h.ended(), 2);
});

test('resume replays before live output and uses metadata cwd over a caller override', async (t) => {
  const h = await harness(t); stored(h);
  await h.kimi.open('o', h.p, `kimi:${SID}`, '/wrong/cwd');
  assert.equal(h.p.kimi.cwd, h.dir);
  assert.equal(h.events.filter((e) => e.ev === 'sdk').length, 0);
  assert.equal(h.events.find((e) => e.ev === 'history').messages.length, 2);
  assert.deepEqual(h.calls().find((c) => c.in?.method === 'session/load').in.params, { sessionId: SID, cwd: h.dir, mcpServers: [] });
  await h.kimi.send('s', h.p, 'hello');
  await until(() => h.events.find((e) => e.ev === 'result'));
  assert.equal(h.p.sessionId, `kimi:${SID}`);
  assert.equal(h.calls().filter((c) => c.in?.method === 'session/new').length, 0);
});

test('permission and form answers settle once, and reconnect replays a pending ask', async (t) => {
  const h = await harness(t);
  await h.kimi.open('o', h.p, null, h.dir);
  await h.kimi.send('s', h.p, 'approve');
  const ask = await until(() => h.events.find((e) => e.ev === 'ask'));
  await h.kimi.attach('a', h.p);
  assert.equal(h.events.filter((e) => e.askId === ask.askId && e.ev === 'ask').length, 2);
  const entry = h.asks.get(ask.askId);
  entry.answer({ behavior: 'allow', always: true }); entry.answer({ behavior: 'deny' });
  await until(() => h.events.find((e) => e.ev === 'result' && e.reqId === 's'));
  assert.equal(h.calls().filter((c) => c.in?.result?.outcome?.optionId === 'opaque-always').length, 1);
  await h.kimi.send('s2', h.p, 'question');
  const q = await until(() => h.events.find((e) => e.ev === 'ask' && e.toolName === 'AskUserQuestion'));
  h.asks.get(q.askId).answer({ behavior: 'allow', updatedInput: { answers: { Color: 'Blue', Parts: 'A, B' } } });
  await until(() => h.events.find((e) => e.ev === 'result' && e.reqId === 's2'));
  assert.equal(h.asks.size, 0);
  assert.ok(h.calls().some((c) => c.in?.result?.content?.q1?.length === 2));
});

for (const body of ['hang', 'ignore-cancel', 'crash']) test(`Kimi ${body} settles and clears busy without retrying the prompt`, async (t) => {
  const h = await harness(t); await h.kimi.open('o', h.p, null, h.dir);
  await h.kimi.send('s', h.p, body);
  if (body !== 'crash') { await until(() => h.events.some((e) => e.ev === 'sdk')); await h.kimi.interrupt(h.p); }
  await until(() => h.events.find((e) => e.ev === 'result'));
  assert.equal(h.p.busy, false); assert.equal(h.asks.size, 0);
  assert.equal(h.calls().filter((c) => c.in?.method === 'session/prompt').length, 1);
});

test('failed effort confirmation sends no prompt and unsupported reverse methods are refused', async (t) => {
  const h = await harness(t, { FAKE_KIMI_START: 'wrong-effort' });
  await h.kimi.open('o', h.p, null, h.dir); await h.kimi.send('s', h.p, 'hello');
  assert.equal(h.events.find((e) => e.ev === 'result').isError, true);
  assert.equal(h.calls().filter((c) => c.in?.method === 'session/prompt').length, 0);
  const good = await harness(t);
  await good.kimi.open('o', good.p, null, good.dir); await good.kimi.send('s', good.p, 'reverse');
  await until(() => good.events.find((e) => e.ev === 'result'));
  assert.ok(good.calls().some((c) => c.in?.error?.code === -32601));
});

test('OAuth and occupied-session errors stay in Kimi without retry or takeover', async (t) => {
  const auth = await harness(t, { FAKE_KIMI_START: 'auth' }); stored(auth);
  await auth.kimi.open('o', auth.p, `kimi:${SID}`, auth.dir);
  assert.equal(auth.p.kind, 'kimi');
  assert.match(auth.events.find((e) => e.ev === 'error' && e.reqId === 'o').message, /OAuth login/);
  assert.equal(auth.calls().filter((c) => c.in?.method === 'session/prompt').length, 0);
  const held = await harness(t);
  await held.kimi.open('o', held.p, null, held.dir);
  await held.kimi.send('s', held.p, 'occupied');
  const result = await until(() => held.events.find((e) => e.ev === 'result'));
  assert.equal(result.isError, true); assert.match(result.result, /occupied/);
  assert.equal(held.calls().filter((c) => c.in?.method === 'session/prompt').length, 1);
});

test('closing while a question waits cancels that request once and stops only its child', async (t) => {
  const h = await harness(t);
  await h.kimi.open('o', h.p, null, h.dir);
  await h.kimi.send('s', h.p, 'question');
  const ask = await until(() => h.events.find((e) => e.ev === 'ask'));
  const entry = h.asks.get(ask.askId);
  await h.kimi.close(h.p);
  entry.answer({ behavior: 'allow' });
  assert.equal(h.asks.size, 0); assert.equal(h.p.busy, false);
  assert.equal(h.ended(), 0, 'closing cannot release another queued turn');
  assert.equal(h.calls().filter((c) => c.in?.result?.action === 'cancel').length, 1);
});

for (const mode of ['timeout', 'bad']) test(`ACP ${mode} startup fails without hanging`, async (t) => {
  const w = world(t), c = new KimiClient({ env: { ...w.env, FAKE_KIMI_START: mode }, cwd: w.dir, timeoutMs: 80 });
  w.cleanup.push(() => c.stop());
  await assert.rejects(c.start());
  assert.equal(c.closed, true); assert.equal(c.pending.size, 0);
});

test('history pages, Glass fallback and UI values remain provider specific', () => {
  const transcript = new KimiTranscript();
  for (let i = 0; i < 305; i += 1) transcript.user([{ type: 'text', text: `Prompt ${i}` }]);
  const page = transcript.page(); assert.equal(page.messages.length, 300); assert.equal(page.prompts.before, 5);
  assert.equal(transcript.page({ before: page.first }).messages.length, 5);
  assert.equal(kimiBilling({ accounts: [{ provider: 'claude', active: true, label: 'Wrong' }] }).name, 'Kimi OAuth');
  assert.equal(kimiBilling({ accounts: [{ provider: 'kimi', active: true, label: 'Fixture', headroom: 74 }] }).headroom, 74);
  assert.equal(kimiChoices('model').length, 1); assert.equal(kimiChoices('effort')[0].value, 'max');
  const row = { id: `kimi:${SID}`, title: 'Fixture' };
  assert.equal(isKimiRow(row), true); assert.equal(leadOf(row).label, 'Kimi');
  assert.ok(sessionMenuItems(row).filter((i) => i.label === 'Open in a terminal')[0].disabled);
  assert.match(sessionFacts(row, {}).sub, /Kimi/);
});

test('all phone capabilities refuse Kimi open, follow and driving an old follower', () => {
  for (const cap of ['full', 'chat', 'noshell']) {
    const ctx = { deviceId: 'phone1', cap, paneKind: (id) => id === 'desktop-kimi' ? 'kimi' : 'claude', followOf: () => 'desktop-kimi' };
    for (const cmd of [{ op: 'open', paneId: 'p1', kind: 'kimi' }, { op: 'open', paneId: 'p1', sessionId: `kimi:${SID}` }, { op: 'follow', paneId: 'p1', desktopPaneId: 'desktop-kimi' }, { op: 'send', paneId: 'p1', text: 'hello' }]) assert.equal(checkPhoneCommand(cmd, ctx).ok, false);
    assert.equal(checkPhoneCommand({ op: 'answer', askId: 'kimi-ask', result: { behavior: 'allow' } }, { ...ctx, followOf: () => null, askPane: () => 'desktop-kimi' }).ok, false);
  }
});
