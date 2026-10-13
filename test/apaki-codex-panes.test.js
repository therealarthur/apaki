/**
 * Codex panes with a scripted client in place of the process (apaki/engine/codex-panes.js), 2026-10-12.
 *
 * test/apaki-codex-e2e.test.js drives the whole engine against a fake app-server. These cover what that cannot show
 * without a phone or a clock: a restricted phone's pane (read-only whatever it asks for), a server that dies, a request
 * the server withdraws, attachments saved for Codex to read, the idle stop, the pane Apaki's tools answer for. The
 * client is an EventEmitter that records every request and answers from a table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CODEX_SHARED, createCodex, isCodexPane, reviewTarget, skillCall } from '../apaki/engine/codex-panes.js';

const THREAD = '01a00000-0000-7000-8000-000000000001';
const THREAD2 = '01a00000-0000-7000-8000-000000000002';
const PHONE = 'phone:AAAAAAAAAAAAAAAAAAAAAA:c1';

class MockClient extends EventEmitter {
  constructor(table = {}) {
    super();
    this.calls = [];
    this.responded = [];
    this.errors = [];
    this.stops = 0;
    this.ready = true;
    this.table = table;
  }
  async ensure() { this.ready = true; return {}; }
  async request(method, params) {
    this.calls.push({ method, params });
    const h = this.table[method];
    if (h instanceof Error) throw h;
    return typeof h === 'function' ? h(params) : (h ?? {});
  }
  respond(id, result) { this.responded.push({ id, result }); }
  respondError(id, code, message) { this.errors.push({ id, code, message }); }
  async stop() { this.stops += 1; this.ready = false; }
  of(method) { return this.calls.filter((c) => c.method === method).map((c) => c.params); }
}

const MODELS = { data: [
  { id: 'm1', model: 'm1', displayName: 'M1', isDefault: true, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
] };
const thread = (id = THREAD) => ({ id, name: 'A thread', preview: 'p', cwd: 'C:\\proj', updatedAt: 5, recencyAt: 6 });
const resumed = (id = THREAD) => ({ thread: thread(id), model: 'm1', reasoningEffort: 'low', cwd: 'C:\\proj', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });

/** A Codex module over a mock client, with the engine's side faked: events, asks, panes, Apaki's tools. */
function setup({ cap = null, table = {}, attachDir = null, rolloutRoots = [] } = {}) {
  const events = [];
  const asks = new Map();
  const panes = new Map();
  const shows = [];
  const browser = { calls: [], call: async (tool, input) => { browser.calls.push([tool, input]); return { ok: true, text: `did ${tool}` }; } };
  const client = new MockClient({
    'model/list': MODELS, 'config/read': { config: { model: 'm1', model_reasoning_effort: 'low', approval_policy: 'on-request', sandbox_mode: 'workspace-write' } },
    'account/read': { account: { type: 'chatgpt', planType: 'pro' } },
    'thread/resume': () => resumed(), 'thread/start': () => ({ ...resumed(THREAD2), approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }),
    'turn/start': () => ({ turn: { id: 'T1' } }), 'thread/turns/list': { data: [], nextCursor: null }, 'thread/read': { thread: thread() },
    ...table,
  });
  const turnsEnded = [];
  const activity = [];
  const codex = createCodex({
    emit: (ev) => events.push(ev), asks, panes,
    tools: (p) => ({ show: async (input, meta) => { shows.push({ paneId: p.id, input, meta }); return { ok: true, text: 'shown' }; }, browser }),
    openPage: (p, o) => events.push({ ev: 'openPage', paneId: p.id, ...o }),
    createClient: () => client, rolloutRoots,
    phoneCap: (id) => (id.startsWith('phone:') ? cap : null),
    attachDir: () => attachDir,
    activity: (p, msg) => activity.push(msg),
    turnEnded: (p, info) => turnsEnded.push({ paneId: p.id, ...info }),
    log: () => {},
  });
  const pane = (id) => { const p = { id }; panes.set(id, p); return p; };
  const of = (name) => events.filter((e) => e.ev === name);
  return { codex, client, events, asks, panes, pane, shows, browser, turnsEnded, activity, of };
}

test('a restricted phone\'s Codex pane is read-only and never asks, whatever the page picked; Full may pick', async () => {
  for (const cap of ['chat', 'noshell']) {
    const s = setup({ cap });
    const p = s.pane(PHONE);
    await s.codex.open('r1', p, `codex:${THREAD}`, null, { mode: 'full-access', model: 'm1' });
    const resume = s.client.of('thread/resume')[0];
    assert.equal(resume.approvalPolicy, 'never', `${cap}: no prompts nobody could answer`);
    assert.equal(resume.sandbox, 'read-only');
    assert.equal(p.mode, 'read-only', 'the server said full access; the phone\'s access wins');
    const opened = s.of('opened')[0];
    assert.equal(opened.mode, 'read-only');
    // A pick the access does not allow is refused, and the pane says what it really has.
    assert.equal(s.codex.setMode(p, 'full-access'), false);
    assert.equal(s.codex.setMode(p, 'auto'), false);
    assert.equal(p.mode, 'read-only');
    assert.deepEqual(s.of('settings').at(-1), { ev: 'settings', paneId: PHONE, model: 'm1', effort: 'low', mode: 'read-only', tune: { summary: null, speed: null } });
    await s.codex.send('r2', p, 'hello', []);
    const turn = s.client.of('turn/start')[0];
    assert.equal(turn.approvalPolicy, 'never');
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
  }
  const full = setup({ cap: 'full' });
  const p = full.pane(PHONE);
  await full.codex.open('r1', p, null, null, { mode: 'full-access' });
  assert.equal(p.mode, 'full-access');
  assert.equal(full.codex.setMode(p, 'auto'), true);
  await full.codex.send('r2', p, 'hello', []);
  assert.equal(full.client.of('thread/start')[0].sandbox, 'workspace-write');
  assert.equal(full.client.of('turn/start')[0].approvalPolicy, 'on-request');
});

test('a phone whose access is lowered while its pane is open drops to read-only at once', async () => {
  let cap = 'full';
  const events = [];
  const panes = new Map();
  const client = new MockClient({ 'model/list': MODELS, 'config/read': {}, 'account/read': {}, 'thread/resume': () => resumed(), 'thread/turns/list': { data: [] }, 'thread/read': { thread: thread() } });
  const codex = createCodex({ emit: (e) => events.push(e), asks: new Map(), panes, tools: () => ({}), openPage: () => {}, createClient: () => client, rolloutRoots: [], phoneCap: () => cap, log: () => {} });
  const p = { id: PHONE };
  panes.set(PHONE, p);
  await codex.open('r', p, `codex:${THREAD}`, null, {});
  assert.equal(p.mode, 'full-access');
  cap = 'chat';
  codex.recap(p);
  assert.equal(p.mode, 'read-only');
  assert.equal(events.filter((e) => e.ev === 'settings').at(-1).mode, 'read-only');
  await codex.send('r2', p, 'x', []);
  assert.equal(client.of('turn/start')[0].approvalPolicy, 'never');
});

test('Apaki\'s tools answer for the pane whose turn runs; a restricted phone\'s pane gets none; no pane, no tools', async () => {
  const s = setup({ cap: 'chat' });
  assert.deepEqual(await s.codex.runTool('show', { title: 'x' }), { ok: false, text: 'No Codex conversation is open in Apaki right now.' });

  const a = s.pane('pa');
  const b = s.pane('pb');
  await s.codex.open('r', a, `codex:${THREAD}`, null, {});
  await s.codex.open('r', b, `codex:${THREAD2}`, null, {});
  a.lastActiveAt = 100;
  b.lastActiveAt = 200;
  assert.equal(s.codex.pickPane().id, 'pb', 'nothing running: the one used last');
  a.busy = true;
  assert.equal(s.codex.pickPane().id, 'pa', 'a running turn wins');
  assert.equal(s.codex.pickPane(THREAD2).id, 'pb', 'a thread the call names wins over both');
  assert.equal(s.codex.pickPane('nope').id, 'pa');

  const r = await s.codex.runTool('show', { title: 'T', kind: 'markdown', content: '#' }, {});
  assert.equal(r.ok, true);
  assert.equal(s.shows[0].paneId, 'pa');
  assert.equal(s.shows[0].meta.via, 'show');
  await s.codex.runTool('browser_open', { url: 'http://localhost:3000/' });
  assert.deepEqual(s.browser.calls, [['browser_open', { url: 'http://localhost:3000/' }]]);
  // A thread id the tool server passes along (when the server sends one) picks its pane.
  await s.codex.runTool('show', { title: 'U' }, { 'x-codex-turn-metadata': { thread_id: THREAD2 } });
  assert.equal(s.shows[1].paneId, 'pb');
  // A link a command opened lands in the running pane.
  s.codex.openedLink('http://localhost:5173/');
  assert.deepEqual(s.events.find((e) => e.ev === 'openPage'), { ev: 'openPage', paneId: 'pa', url: 'http://localhost:5173/', title: null, reason: 'BROWSER', toolUseId: null });

  const phone = setup({ cap: 'chat' });
  const pp = phone.pane(PHONE);
  await phone.codex.open('r', pp, `codex:${THREAD}`, null, {});
  const refused = await phone.codex.runTool('browser_read', {});
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Chat only/);
  assert.equal(phone.shows.length + phone.browser.calls.length, 0);
});

test('a server that dies ends the turns it was running, drops what waited, and the next message resumes the thread', async () => {
  const s = setup();
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  await s.codex.send('r2', p, 'go', []);
  assert.equal(p.busy, true);
  s.client.emit('request', 41, 'item/commandExecution/requestApproval', { threadId: THREAD, itemId: 'i', command: 'npm i' });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.asks.size, 1);
  s.client.emit('exit', 1, null, { expected: false });
  assert.equal(p.busy, false);
  assert.equal(s.asks.size, 0);
  assert.deepEqual(s.of('ask_gone').length, 1);
  assert.equal(s.of('ask_gone')[0].why, 'stopped');
  const result = s.of('result').at(-1);
  assert.equal(result.isError, true);
  assert.match(result.result, /app-server stopped/);
  assert.equal(s.turnsEnded.length, 1, 'the host learns the turn ended');
  // The next message loads the thread again first.
  await s.codex.send('r3', p, 'again', []);
  assert.equal(s.client.of('thread/resume').length, 2);
  assert.equal(s.client.of('turn/start').length, 2);

  // A stop Apaki asked for is quiet.
  const q = setup();
  const qp = q.pane('p1');
  await q.codex.open('r', qp, `codex:${THREAD}`, null, {});
  await q.codex.send('r2', qp, 'go', []);
  q.client.emit('exit', null, null, { expected: true });
  assert.equal(q.of('result').length, 0);
});

test('a question the server withdraws drops its sheet and is never answered; one a turn leaves behind is dropped when the turn ends', async () => {
  const s = setup();
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  s.client.emit('request', 7, 'item/tool/requestUserInput', { threadId: THREAD, itemId: 'q', isBlocking: true, questions: [{ id: 'a', header: 'H', question: 'Which?', options: [{ label: 'X', description: '' }] }] });
  await new Promise((r) => setImmediate(r));
  const [askId, entry] = [...s.asks][0];
  assert.equal(entry.codexRequestId, 7);
  assert.equal(s.of('ask')[0].toolName, 'AskUserQuestion');
  s.client.emit('notification', 'serverRequest/resolved', { threadId: THREAD, requestId: 7 });
  assert.equal(s.asks.size, 0);
  assert.deepEqual(s.of('ask_gone').map((e) => e.askId), [askId]);
  // The pane's card says who settled it (askcard.js goneNote, 2026-10-12).
  assert.deepEqual([s.of('ask_gone')[0].why, s.of('ask_gone')[0].by], ['resolved', 'Codex']);
  entry.answer({ behavior: 'allow', updatedInput: { answers: { 'Which?': 'X' } } });
  assert.deepEqual(s.client.responded, [], 'a late answer is not sent');

  s.client.emit('request', 8, 'item/commandExecution/requestApproval', { threadId: THREAD, itemId: 'i', command: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.asks.size, 1);
  s.client.emit('notification', 'turn/completed', { threadId: THREAD, turn: { id: 'T9', status: 'completed' } });
  assert.equal(s.asks.size, 0, 'the turn is over, so nobody waits for the answer');
  assert.equal(s.of('ask_gone').length, 2);
  assert.equal(s.of('ask_gone')[1].why, 'turn');
  // Answered once: the second answer does nothing.
  s.client.emit('request', 9, 'item/commandExecution/requestApproval', { threadId: THREAD, itemId: 'i', command: 'x' });
  await new Promise((r) => setImmediate(r));
  const [, e2] = [...s.asks][0];
  e2.answer({ behavior: 'allow' });
  e2.answer({ behavior: 'deny' });
  e2.resolve();
  assert.deepEqual(s.client.responded, [{ id: 9, result: { decision: 'accept' } }]);
});

test('server requests nobody can answer are refused, never left waiting', async () => {
  const s = setup();
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const ask = async (id, method, params) => { s.client.emit('request', id, method, params); await new Promise((r) => setImmediate(r)); };
  // A thread no pane has open.
  await ask(1, 'item/commandExecution/requestApproval', { threadId: 'other', itemId: 'i', command: 'x' });
  await ask(2, 'item/fileChange/requestApproval', { threadId: 'other', itemId: 'i' });
  await ask(3, 'item/permissions/requestApproval', { threadId: 'other', itemId: 'i', permissions: {} });
  await ask(4, 'item/tool/requestUserInput', { threadId: 'other', questions: [] });
  await ask(5, 'mcpServer/elicitation/request', { threadId: 'other', serverName: 's', mode: 'form' });
  await ask(6, 'execCommandApproval', { conversationId: 'other', callId: 'c', command: ['x'] });
  // Asks that are Apaki's to refuse.
  await ask(7, 'mcpServer/elicitation/request', { threadId: THREAD, serverName: 's', mode: 'openai/userVerification', challenge: 'c' });
  await ask(8, 'item/tool/call', { threadId: THREAD, tool: 'shell_thing', callId: 'c' });
  await ask(9, 'account/chatgptAuthTokens/refresh', { reason: 'expired' });
  await ask(10, 'something/new', {});
  const by = Object.fromEntries(s.client.responded.map((r) => [r.id, r.result]));
  assert.deepEqual(by[1], { decision: 'decline' });
  assert.deepEqual(by[2], { decision: 'decline' });
  assert.deepEqual(by[3], { permissions: {}, scope: 'turn' });
  assert.deepEqual(by[4], { answers: {} });
  assert.equal(by[5].action, 'decline');
  assert.deepEqual(by[6], { decision: 'denied' });
  assert.equal(by[7].action, 'decline');
  assert.equal(by[8].success, false);
  assert.match(by[8].contentItems[0].text, /does not provide a tool named shell_thing/);
  assert.equal(s.client.errors.find((e) => e.id === 9).code, -32000);
  assert.equal(s.client.errors.find((e) => e.id === 10).code, -32601);
  assert.equal(s.asks.size, 0);
});

test('attachments: pictures go inline as data URLs, other files are saved where Codex can read them and mentioned by path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-codex-attach-'));
  try {
    const s = setup({ attachDir: dir });
    const p = s.pane('p1');
    await s.codex.open('r', p, `codex:${THREAD}`, null, {});
    const pdf = Buffer.from('%PDF-1.4 hello');
    await s.codex.send('r2', p, 'read these', [
      { media_type: 'image/png', data: 'AAAA' },
      { media_type: 'application/pdf', data: pdf.toString('base64'), name: '../../evil/..\\Report 1.pdf' },
      { media_type: 'application/octet-stream', data: '', name: 'empty.bin' },
    ]);
    const input = s.client.of('turn/start')[0].input;
    assert.deepEqual(input.map((i) => i.type), ['text', 'image', 'mention']);
    assert.equal(input[1].url, 'data:image/png;base64,AAAA');
    assert.equal(input[2].name, 'Report 1.pdf');
    assert.ok(input[2].path.startsWith(path.join(dir, THREAD)), 'one folder per thread, inside the attachments folder');
    assert.equal(fs.readFileSync(input[2].path, 'utf8'), '%PDF-1.4 hello');
    assert.ok(fs.readFileSync(path.join(dir, '_WHY_THIS_IS_HERE.md'), 'utf8').includes('codex-attachments'), 'the folder says what it is');
    // A message of only a file still goes (the mention is its content); one with nothing in it does not start a turn.
    await s.codex.send('r3', p, '', [{ media_type: 'text/plain', data: Buffer.from('hi').toString('base64'), name: 'a.txt' }]);
    assert.equal(s.client.of('turn/start').length, 2);
    await s.codex.send('r4', p, '   ', []);
    assert.equal(s.client.of('turn/start').length, 2);
    assert.equal(s.of('result').at(-1).reqId, 'r4');
    // Steer carries the same.
    p.busy = true;
    p.codex.turnId = 'T1';
    s.client.table['turn/steer'] = { turnId: 'T1' };
    await s.codex.steer({ reqId: 's1', qid: 'q', text: 'more', images: [{ media_type: 'text/plain', data: Buffer.from('b').toString('base64'), name: 'b.txt' }] }, p);
    const steer = s.client.of('turn/steer')[0];
    assert.equal(steer.expectedTurnId, 'T1');
    assert.deepEqual(steer.input.map((i) => i.type), ['text', 'mention']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/compact starts a compaction and frees the pane when the server reports it; a server that reports nothing frees it anyway', async (t) => {
  const s = setup();
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const sent = s.codex.send('r2', p, '/compact', []);
  await new Promise((r) => setImmediate(r));
  assert.equal(p.busy, true);
  assert.equal(s.client.of('thread/compact/start')[0].threadId, THREAD);
  s.client.emit('notification', 'item/started', { threadId: THREAD, turnId: 'T', item: { type: 'contextCompaction', id: 'cc' } });
  s.client.emit('notification', 'item/completed', { threadId: THREAD, turnId: 'T', item: { type: 'contextCompaction', id: 'cc' } });
  await sent;
  assert.equal(p.busy, false);
  assert.ok(s.activity.some((m) => m.subtype === 'compact_boundary'));
  const done = s.of('result').filter((e) => e.reqId === 'r2');
  assert.equal(done.length, 1);
  assert.equal(done[0].quiet, true, 'a slash command has no footer');
  assert.equal(s.turnsEnded.length, 1);
  void t;
});

test('the server stops when the last Codex pane has been gone a while, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  const a = s.pane('a');
  const b = s.pane('b');
  await s.codex.open('r', a, `codex:${THREAD}`, null, {});
  await s.codex.open('r', b, `codex:${THREAD2}`, null, {});
  await s.codex.close(a);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(s.client.stops, 0, 'another Codex pane is still open');
  assert.equal(isCodexPane(a), false);
  s.panes.delete('a');
  await s.codex.close(b);
  assert.deepEqual(s.client.of('thread/unsubscribe').map((x) => x.threadId), [THREAD, THREAD2]);
  t.mock.timers.tick(2 * 60 * 1000);
  assert.equal(s.client.stops, 0, 'not yet');
  s.panes.delete('b');
  t.mock.timers.tick(2 * 60 * 1000);
  assert.equal(s.client.stops, 1, 'three quiet minutes with no Codex pane');
});

test('settings: a model the list lacks is refused, the effort follows the model, and what the server says never undoes a pick', async () => {
  const s = setup({ table: { 'model/list': { data: [
    { id: 'm1', model: 'm1', displayName: 'M1', isDefault: true, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
    { id: 'm2', model: 'm2', displayName: 'M2', isDefault: false, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  ] } } });
  const p = s.pane('p1');
  await s.codex.open('r', p, null, null, {});
  assert.equal(p.model, 'm1');
  await s.codex.setModel(p, 'nope');
  assert.equal(p.model, 'm1');
  s.codex.setEffort(p, 'ultra');
  assert.equal(p.effort, 'ultra');
  s.codex.setEffort(p, 'high');
  assert.equal(p.effort, 'ultra', 'm1 does not offer high');
  await s.codex.setModel(p, 'm2');
  assert.equal(p.model, 'm2');
  assert.equal(p.effort, 'medium', 'ultra is not on m2\'s list: its own default');
  // Picks travel with the first turn (startThread must not replace them with the server's answer).
  await s.codex.send('r2', p, 'go', []);
  const turn = s.client.of('turn/start')[0];
  assert.equal(turn.model, 'm2');
  assert.equal(turn.effort, 'medium');
  assert.equal(p.model, 'm2');
  assert.equal(s.client.of('thread/start')[0].model, 'm2');
});

test('the thread list: read once, cached, shaped like session rows, and read again on request', async () => {
  const row = { id: THREAD, name: 'Named', preview: 'Fix the build', cwd: 'C:\\p', gitInfo: { branch: 'main' }, recencyAt: 10, originator: 'Codex Desktop' };
  const s = setup({ table: { 'thread/list': (params) => ({ data: [row], nextCursor: null, seen: params }) } });
  const shapeRows = (rows) => rows.map((r) => ({ ...r, archived: false }));
  const t = createCodex({ emit: (e) => s.events.push(e), asks: s.asks, panes: s.panes, tools: () => ({}), openPage: () => {}, createClient: () => s.client, shapeRows, rolloutRoots: [], log: () => {} });
  const first = await t.list({ reqId: 'l1' });
  assert.equal(first.length, 1);
  const ev = s.events.find((e) => e.ev === 'codexThreads');
  assert.deepEqual(ev.items[0], { id: `codex:${THREAD}`, title: 'Named', firstPrompt: 'Fix the build', cwd: 'C:\\p', branch: 'main', lastModified: 10000, size: 0, codex: true, source: 'Codex Desktop', archived: false });
  const asked = s.client.of('thread/list')[0];
  assert.deepEqual(asked.sourceKinds, ['cli', 'vscode', 'exec', 'appServer', 'unknown'], 'threads the Codex app and the CLI made, and ours');
  assert.equal(asked.sortKey, 'recency_at');
  assert.equal(asked.useStateDbOnly, true, 'the first read is the quick one');
  await t.list({ reqId: 'l2' });
  assert.equal(s.client.of('thread/list').length, 1, 'cached for a while');
  await t.list({ reqId: 'l3', refresh: true });
  assert.equal(s.client.of('thread/list').length, 2);
  assert.equal(s.client.of('thread/list')[1].useStateDbOnly, false, 'a refresh scans the rollouts');
  assert.equal(t.cachedRows().length, 1);
  // A failure is a list that says so, not a silence.
  const bad = setup({ table: { 'thread/list': new Error('boom') } });
  const t2 = createCodex({ emit: (e) => bad.events.push(e), asks: bad.asks, panes: bad.panes, tools: () => ({}), openPage: () => {}, createClient: () => bad.client, rolloutRoots: [], log: () => {} });
  await t2.list({ reqId: 'x' });
  assert.deepEqual(bad.events.find((e) => e.ev === 'codexThreads'), { ev: 'codexThreads', reqId: 'x', items: [], error: 'boom' });
});

test('opening a thread the server cannot find says so and leaves an empty Codex pane; the shared token is a pseudo pane', async () => {
  const s = setup({ table: { 'thread/resume': Object.assign(new Error('no rollout found for thread id x'), { code: -32600 }) } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  assert.match(s.of('error')[0].message, /Codex could not open that conversation: no rollout found/);
  assert.equal(s.of('opened')[0].sessionId, `codex:${THREAD}`, 'the pane keeps the thread it was asked for, so a saved workspace still points at it');
  assert.equal(s.of('opened')[0].kind, 'codex');
  assert.equal(s.codex.byThread.size, 0, 'nothing is registered for events of a thread that did not open');
  // The next message tries to resume it again.
  s.client.table['thread/resume'] = () => resumed();
  await s.codex.send('r2', p, 'hello again', []);
  assert.equal(s.client.of('thread/resume').length, 2);
  assert.equal(s.client.of('turn/start')[0].threadId, THREAD);
  assert.equal(s.codex.byThread.get(THREAD), p);
  assert.equal(CODEX_SHARED, 'codex-shared');
});

test('a tool server that fails to start for a thread is said once on that pane; ready, other servers and other threads say nothing', async () => {
  const s = setup();
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const warnings = () => s.activity.filter((m) => m.subtype === 'informational' && /viewer and browser tools/.test(m.content));
  s.client.emit('notification', 'mcpServer/startupStatus/updated', { threadId: THREAD, name: 'apaki', status: 'ready' });
  s.client.emit('notification', 'mcpServer/startupStatus/updated', { threadId: THREAD, name: 'other', status: 'failed', error: 'x' });
  s.client.emit('notification', 'mcpServer/startupStatus/updated', { name: 'apaki', status: 'failed', error: 'no thread' });
  assert.equal(warnings().length, 0);
  s.client.emit('notification', 'mcpServer/startupStatus/updated', { threadId: THREAD, name: 'apaki', status: 'failed', error: 'spawn node ENOENT' });
  s.client.emit('notification', 'mcpServer/startupStatus/updated', { threadId: THREAD, name: 'apaki', status: 'failed', error: 'again' });
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].content, /ENOENT/);
  assert.equal(warnings()[0].level, 'warning');
});

test('/init is an ordinary turn with an AGENTS.md prompt; /mention attaches a file to the next message once, and says when there is no such file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-mention-'));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, 'x');
  const s = setup({ table: { 'thread/resume': () => ({ ...resumed(), cwd: dir }) } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const notes = () => s.of('note').map((n) => n.text);
  // /init
  const initDone = s.codex.send('i1', p, '/init', []);
  await new Promise((r) => setImmediate(r));
  const first = s.client.of('turn/start')[0];
  assert.match(first.input[0].text, /AGENTS\.md/);
  s.client.emit('notification', 'turn/completed', { threadId: THREAD, turn: { id: 'T1', status: 'completed' } });
  await initDone;
  // /mention: nothing named, a file that is not there, then a real one (relative to the thread's folder)
  await s.codex.send('m0', p, '/mention', []);
  assert.match(notes().at(-1), /Name a file/);
  await s.codex.send('m1', p, '/mention nope.md', []);
  assert.match(notes().at(-1), /no file at/);
  await s.codex.send('m2', p, '/mention notes.md', []);
  assert.match(notes().at(-1), /notes\.md goes with your next message/);
  assert.equal(s.client.of('turn/start').length, 1, 'a mention is not a message to the model');
  const next = s.codex.send('m3', p, 'summarize it', []);
  await new Promise((r) => setImmediate(r));
  const second = s.client.of('turn/start')[1];
  assert.deepEqual(second.input.map((i) => i.type), ['text', 'mention']);
  assert.deepEqual([second.input[1].name, second.input[1].path], ['notes.md', file]);
  s.client.emit('notification', 'turn/completed', { threadId: THREAD, turn: { id: 'T2', status: 'completed' } });
  await next;
  // once only
  const third = s.codex.send('m4', p, 'and now?', []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.client.of('turn/start')[2].input.map((i) => i.type), ['text']);
  s.client.emit('notification', 'turn/completed', { threadId: THREAD, turn: { id: 'T3', status: 'completed' } });
  await third;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the context meter follows thread/tokenUsage/updated, with the percent where the user\'s own auto-compact setting compacts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ table: { 'config/read': { config: { model: 'm1', model_auto_compact_token_limit: 9000 } } } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  s.client.emit('notification', 'thread/tokenUsage/updated', { threadId: THREAD, turnId: 'T', tokenUsage: { total: { totalTokens: 9000 }, last: { totalTokens: 1500, inputTokens: 1500 }, modelContextWindow: 10000 } });
  t.mock.timers.tick(300);
  const ctx = s.of('context').at(-1);
  assert.equal(ctx.percentage, 15);
  assert.equal(ctx.autoCompact, 90);
});

test('the billing chip carries the plan windows: read when the account is, and refreshed by account/rateLimits/updated; a key has none', async () => {
  const win = (p, mins) => ({ usedPercent: p, windowDurationMins: mins, resetsAt: 1000 });
  const s = setup({ table: { 'account/rateLimits/read': { rateLimits: { primary: win(29, 300), secondary: win(33, 10080) } } } });
  const p = s.pane('p1');
  s.pane('p2').kind = 'claude';
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  s.codex.models('m1');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.of('codexModels').at(-1).account.limits.map((l) => [l.label, l.usedPercent]), [['5-hour', 29], ['Weekly', 33]]);
  s.client.emit('notification', 'account/rateLimits/updated', { rateLimits: { primary: win(41, 300), secondary: win(33, 10080) } });
  const b = s.of('billing').at(-1);
  assert.equal(b.paneId, 'p1', 'only Codex panes hear it');
  assert.equal(b.limits[0].usedPercent, 41);
  assert.equal(b.name, 'ChatGPT Pro');
  // An API key has no plan windows.
  const k = setup({ table: { 'account/read': { account: { type: 'apiKey' } } } });
  k.codex.models('m2');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(k.of('codexModels').at(-1).account.limits, []);
});

test('/review takes a branch, a commit or instructions; with nothing it reviews the uncommitted changes', async () => {
  assert.deepEqual(reviewTarget(''), { type: 'uncommittedChanges' });
  assert.deepEqual(reviewTarget('branch main'), { type: 'baseBranch', branch: 'main' });
  assert.deepEqual(reviewTarget('base origin/dev'), { type: 'baseBranch', branch: 'origin/dev' });
  assert.deepEqual(reviewTarget('commit 3fa9c0d'), { type: 'commit', sha: '3fa9c0d' });
  assert.deepEqual(reviewTarget('commit nothex'), { type: 'custom', instructions: 'commit nothex' });
  assert.deepEqual(reviewTarget('look at the error handling'), { type: 'custom', instructions: 'look at the error handling' });
  const s = setup({ table: { 'review/start': () => ({ turn: { id: 'RT' } }) } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  s.codex.send('rv', p, '/review branch main', []);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.client.of('review/start')[0], { threadId: THREAD, target: { type: 'baseBranch', branch: 'main' }, delivery: 'inline' });
  assert.equal(p.busy, true, 'a review is a turn');
});

test('/revert takes the newest turn out of the thread and redraws it; /goal sets, shows and clears, and says when Codex moves the goal', async () => {
  const goal = { threadId: THREAD, objective: 'ship it', status: 'active', tokensUsed: 5200 };
  const s = setup({ table: {
    'thread/turns/list': (params) => (params.limit === 1 ? { data: [{ id: 'TURN9', status: 'completed', items: [] }], nextCursor: null } : { data: [], nextCursor: null }),
    'thread/revert': { thread: thread() },
    'thread/goal/set': () => ({ goal }), 'thread/goal/get': () => ({ goal }), 'thread/goal/clear': {},
  } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const notes = () => s.of('note').map((n) => n.text);
  await s.codex.send('v1', p, '/revert', []);
  assert.deepEqual(s.client.of('thread/revert')[0], { threadId: THREAD, beforeTurnId: 'TURN9' });
  assert.match(notes().at(-1), /Files Codex changed stay/);
  assert.ok(s.of('history').length >= 1, 'the pane is drawn again from the server');
  // nothing to take out
  const empty = setup({ table: { 'thread/turns/list': { data: [], nextCursor: null } } });
  const q = empty.pane('p1');
  await empty.codex.open('r', q, `codex:${THREAD}`, null, {});
  await empty.codex.send('v2', q, '/revert', []);
  assert.equal(empty.client.of('thread/revert').length, 0);
  assert.match(empty.of('note').at(-1).text, /nothing to take out/);
  // a running turn is never reverted under its feet
  p.busy = true;
  await s.codex.send('v3', p, '/revert', []);
  assert.equal(s.client.of('thread/revert').length, 1);
  p.busy = false;
  // goals
  await s.codex.send('g1', p, '/goal ship it', []);
  assert.deepEqual(s.client.of('thread/goal/set')[0], { threadId: THREAD, objective: 'ship it', origin: 'user' });
  assert.match(notes().at(-1), /Goal: ship it \(working toward it, 5k tokens used\)/);
  s.client.emit('notification', 'thread/goal/updated', { threadId: THREAD, goal });
  assert.equal(s.of('note').filter((n) => /Goal:/.test(n.text)).length, 1, 'no repeat for a state it already said');
  s.client.emit('notification', 'thread/goal/updated', { threadId: THREAD, goal: { ...goal, status: 'complete' } });
  assert.match(notes().at(-1), /\(done/);
  await s.codex.send('g2', p, '/goal', []);
  assert.match(notes().at(-1), /Goal: ship it/);
  await s.codex.send('g3', p, '/goal clear', []);
  assert.equal(s.client.of('thread/goal/clear').length, 1);
  assert.match(notes().at(-1), /cleared/);
});

test('a Chat only phone may read the goal but cannot set it or take a turn out of the thread; No shell may', async () => {
  const goal = { threadId: THREAD, objective: 'ship it', status: 'active' };
  const table = { 'thread/turns/list': { data: [{ id: 'T9', items: [] }], nextCursor: null }, 'thread/revert': { thread: thread() }, 'thread/goal/set': () => ({ goal }), 'thread/goal/get': () => ({ goal }) };
  const chat = setup({ cap: 'chat', table });
  const p = chat.pane('phone:AAAAAAAAAAAAAAAAAAAAAA:c1');
  await chat.codex.open('r', p, `codex:${THREAD}`, null, {});
  await chat.codex.send('a', p, '/revert', []);
  await chat.codex.send('b', p, '/goal ship it', []);
  assert.equal(chat.client.of('thread/revert').length + chat.client.of('thread/goal/set').length, 0);
  assert.match(chat.of('note').at(-1).text, /Chat only/);
  await chat.codex.send('c', p, '/goal', []);
  assert.match(chat.of('note').at(-1).text, /Goal: ship it/);
  const open = setup({ cap: 'noshell', table });
  const q = open.pane('phone:AAAAAAAAAAAAAAAAAAAAAA:c1');
  await open.codex.open('r', q, `codex:${THREAD}`, null, {});
  await open.codex.send('d', q, '/revert', []);
  assert.equal(open.client.of('thread/revert').length, 1);
});

test('a skill is called as /name words; command words are never skills, and the slash menu lists enabled skills after the commands', async () => {
  assert.deepEqual(skillCall('/deploy staging now'), { name: 'deploy', rest: 'staging now' });
  assert.deepEqual(skillCall('/pdf-tools'), { name: 'pdf-tools', rest: '' });
  assert.equal(skillCall('/review main'), null);
  assert.equal(skillCall('/Model x'), null);
  assert.equal(skillCall('deploy'), null);
  assert.equal(skillCall('/'), null);
  const skills = { data: [{ cwd: 'C:\proj', errors: [], skills: [
    { name: 'deploy', description: 'long text', path: 'C:\s\deploy\SKILL.md', enabled: true, interface: { shortDescription: 'Ship it' } },
    { name: 'status', description: 'shadows a command', path: 'C:\s\status\SKILL.md', enabled: true },
    { name: 'old', description: 'off', path: 'C:\s\old\SKILL.md', enabled: false },
  ] }] };
  const s = setup({ table: { 'skills/list': skills } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const list = await s.codex.commandsFor(p);
  assert.deepEqual(list.slice(-1), [{ name: 'deploy', description: 'Ship it', argumentHint: '', skill: true }]);
  assert.equal(list.filter((c) => c.name === 'status').length, 1);
  assert.equal(list.some((c) => c.name === 'old'), false);
  // a skill that is not there is an ordinary message
  const sent = s.codex.send('k1', p, '/nothing here', []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.client.of('turn/start')[0].input, [{ type: 'text', text: '/nothing here', text_elements: [] }]);
  s.client.emit('notification', 'turn/completed', { threadId: THREAD, turn: { id: 'T1', status: 'completed' } });
  await sent;
});

test('a file name in a patch opens the file in the viewer, only if this conversation changed it; changes in history count too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-open-'));
  const changed = path.join(dir, 'Table.tsx');
  const other = path.join(dir, 'secret.txt');
  const fromHistory = path.join(dir, 'old.md');
  for (const f of [changed, other, fromHistory]) fs.writeFileSync(f, 'x');
  // The thread's history holds a turn that changed old.md.
  const turn = { id: 'TT', status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1000, error: null, itemsView: 'full', items: [
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'edit it', text_elements: [] }] },
    { type: 'fileChange', id: 'fc', status: 'completed', changes: [{ path: 'old.md', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }] },
  ] };
  const s = setup({ table: { 'thread/resume': () => ({ ...resumed(), cwd: dir }), 'thread/turns/list': { data: [turn], nextCursor: null } } });
  const p = s.pane('p1');
  await s.codex.open('r', p, `codex:${THREAD}`, null, {});
  const notes = () => s.of('note').map((n) => n.text);
  // the history's change is known; a file nobody changed is refused
  await s.codex.openFile({ path: 'old.md' }, p);
  assert.deepEqual(s.shows.map((x) => [x.input.kind, x.input.path, x.input.title, x.meta.via]), [['file', fromHistory, 'old.md', 'codex-file']]);
  await s.codex.openFile({ path: changed }, p);
  assert.equal(s.shows.length, 1);
  assert.match(notes().at(-1), /opens the files this conversation changed/);
  // a change drawn live (a relative path counts from the thread's folder)
  s.client.emit('notification', 'item/started', { threadId: THREAD, turnId: 'T', item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'Table.tsx', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }] } });
  await s.codex.openFile({ path: 'Table.tsx' }, p);
  assert.equal(s.shows.at(-1).input.path, changed);
  // a file nobody changed is refused even inside the folder; one that is gone is said to be gone
  await s.codex.openFile({ path: other }, p);
  assert.equal(s.shows.length, 2);
  fs.rmSync(changed);
  await s.codex.openFile({ path: changed }, p);
  assert.match(notes().at(-1), /not there any more/);
  await s.codex.openFile({ path: '' }, p);
  assert.equal(s.shows.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
