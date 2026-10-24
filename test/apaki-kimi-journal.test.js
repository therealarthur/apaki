/** Invented protocol 1.5 journals and a fake ACP process only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKimiList } from '../apaki/engine/kimi-list.js';
import { KimiJournalReader, KimiJournalTranscript, TITLE_BYTES, readKimiTitle } from '../apaki/engine/kimi-journal.js';
import { KimiTranscript } from '../apaki/engine/kimi-map.js';
import { KimiClient } from '../apaki/engine/kimi-client.js';
import { createKimi, mayBeHeld } from '../apaki/engine/kimi-panes.js';
import { Pane } from '../apaki/ui/pane.js';
import { detailLine, rowTip } from '../apaki/ui/sessionlist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = '00000000-0000-4000-8000-000000000001';
const ID = `kimi:${SID}`;
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test-fixtures/kimi-wire.jsonl'), 'utf8');
const line = (r) => JSON.stringify(r) + '\n';
const prompt = (text, origin = { kind: 'user' }) => ({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text }], origin });
const message = (text, role = 'user') => ({ type: 'context.append_message', agentId: 'main', message: { role, content: [{ type: 'text', text }] } });
const part = (text, type = 'text') => ({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type, [type]: text } } });
const textOf = (t) => t.messages.flatMap((m) => m.message.content).map((b) => b.text || b.thinking || '').filter(Boolean);
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('Fake journal event did not arrive'); await new Promise((r) => setTimeout(r, 10)); }
}
function world(t, contents = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-kimi-journal-'));
  const home = path.join(dir, 'kimi');
  const root = path.join(home, 'sessions');
  const session = path.join(root, 'fixture-workspace', SID);
  const file = path.join(session, 'agents/main/wire.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  const state = path.join(session, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ id: SID, cwd: dir, createdAt: 1700000000000 }));
  const list = createKimiList({ home, ttlMs: 0 });
  const cleanup = [];
  t.after(async () => { for (const f of cleanup) await f(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, root, session, file, state, list, cleanup };
}
async function harness(t, extra = {}) {
  const w = world(t), events = [], panes = new Map(), log = path.join(w.dir, 'rpc.jsonl');
  let clock = 0;
  const kimi = createKimi({ list: w.list, emit: (e) => events.push(e), panes, asks: new Map(), followMs: 20, now: () => clock,
    clientFactory: (opts) => new KimiClient({ ...opts, timeoutMs: 2000, env: { ...process.env, KIMI_CODE_HOME: w.home,
      APAKI_KIMI_BIN: path.join(ROOT, 'test-fixtures/fake-kimi-acp.mjs'), APAKI_KIMI_NODE: process.execPath, FAKE_KIMI_LOG: log, ...extra } }),
  });
  const p = { id: 'journal-pane' }; panes.set(p.id, p);
  w.cleanup.unshift(() => kimi.shutdown());
  const held = path.join(w.session, 'held'); fs.writeFileSync(held, 'invented holder');
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.in).map((c) => c.in) : [];
  const check = async (visible = true) => {
    await p.kimi?.followWork;
    await kimi.handle({ op: 'historyCheck', sessionId: ID, visible }, p);
  };
  return { ...w, kimi, p, events, held, calls, check, at: (value) => { clock = value; }, loads: () => calls().filter((c) => c.method === 'session/load').length };
}

test('titles use a real prompt, remove reminders and whitespace, and prefer a Kimi title', async (t) => {
  const w = world(t, line(message('<system-reminder>Invented reminder</system-reminder>'))
    + line(prompt('  Invented first\nprompt <system-reminder>skip me</system-reminder> with details ' + 'x'.repeat(150)))
    + line(message('A later prompt')));
  let row = (await w.list.refresh())[0];
  assert.equal(row.title.length, 120);
  assert.ok(row.title.startsWith('Invented first prompt with details '));
  assert.doesNotMatch(row.title, /reminder|skip me|later|\n/);
  assert.equal(row.kimiRole, undefined);
  fs.writeFileSync(w.state, JSON.stringify({ cwd: w.dir, title: 'Kimi chose this title', lastPrompt: 'Stale prompt' }));
  row = (await w.list.refresh())[0];
  assert.equal(row.title, 'Kimi chose this title');
  assert.match(row.firstPrompt, /Invented first prompt/);
  assert.equal((await w.list.search('with details')).length, 1);
});

test('title prefixes are bounded and cached by both size and mtime', async (t) => {
  const w = world(t, line(prompt('Invented alpha')));
  const original = fs.promises.open;
  let opens = 0;
  fs.promises.open = async (file, ...args) => { if (file === w.file) opens += 1; return original.call(fs.promises, file, ...args); };
  t.after(() => { fs.promises.open = original; });
  assert.equal((await w.list.refresh())[0].title, 'Invented alpha');
  await w.list.refresh(); assert.equal(opens, 1);
  fs.writeFileSync(w.file, line(prompt('Invented bravo')));
  fs.utimesSync(w.file, new Date(1700000000000), new Date(1700000001000));
  assert.equal((await w.list.refresh())[0].title, 'Invented bravo'); assert.equal(opens, 2);
  fs.appendFileSync(w.file, '\n');
  fs.utimesSync(w.file, new Date(1700000000000), new Date(1700000001000));
  await w.list.refresh(); assert.equal(opens, 3);
  fs.writeFileSync(w.file, line({ type: 'profile.bind', systemPrompt: 'x'.repeat(TITLE_BYTES) }) + line(prompt('Beyond the prefix')));
  assert.equal((await w.list.refresh())[0].title, 'Kimi conversation');
});

test('context user records are a fallback and explicit role metadata marks helpers without guessing', async (t) => {
  const w = world(t, line(message('<system-reminder>not a title</system-reminder>')) + line(message('Please ask a builder about this subagent.')));
  let row = (await w.list.refresh())[0];
  assert.equal(row.title, 'Please ask a builder about this subagent.'); assert.equal(row.kimiRole, undefined);
  for (const [record, role] of [[{ type: 'profile.bind', agentId: 'main', profileName: 'builder' }, 'Builder'],
    [{ type: 'metadata', agentRole: 'subagent' }, 'Subagent'], [prompt('Invented file task', { kind: 'agent_file' }), 'Agent file']]) {
    fs.writeFileSync(w.file, line(record) + line(prompt('Invented task')));
    row = (await w.list.refresh())[0];
    assert.equal(row.kimiRole, role);
    assert.match(detailLine(row), new RegExp(role));
    assert.ok(rowTip(row).rows.some(([key, value]) => key === 'Role' && value === role));
  }
  fs.writeFileSync(w.file, line(prompt('First user task')) + line(prompt('Later file task', { kind: 'agent_file' })));
  assert.equal((await w.list.refresh())[0].kimiRole, undefined);
});

test('exclusions and linked journals never supply titles or read only history', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.state, JSON.stringify({ cwd: 'C:/Users/Fixture/Pictures' }));
  assert.equal((await w.list.refresh()).length, 0);
  fs.writeFileSync(w.state, JSON.stringify({ cwd: w.dir }));
  const target = path.join(w.dir, 'invented-wire.jsonl');
  fs.renameSync(w.file, target);
  try { fs.symlinkSync(target, w.file, 'file'); } catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Creating symlinks requires Windows developer mode'); return; } throw e;
  }
  assert.equal((await w.list.refresh())[0].title, 'Kimi conversation');
  await assert.rejects(readKimiTitle(w.file, w.root), /linked/);
  await assert.rejects(new KimiJournalReader(w.file, w.root, () => assert.fail('must not read linked files')).read(), /linked/);
  fs.unlinkSync(w.file);
  fs.rmdirSync(path.dirname(w.file));
  const linkedDir = path.join(w.dir, 'linked-main'); fs.mkdirSync(linkedDir); fs.renameSync(target, path.join(linkedDir, 'wire.jsonl'));
  fs.symlinkSync(linkedDir, path.dirname(w.file), 'junction');
  assert.equal((await w.list.refresh())[0].title, 'Kimi conversation');
  await assert.rejects(readKimiTitle(w.file, w.root), /linked/);
});

test('fixture journal becomes one prompt, thinking, tools and an answer without mirror duplicates', async (t) => {
  const w = world(t, FIXTURE + line(message('Invented answer: two files.', 'assistant')));
  const transcript = new KimiTranscript(), map = new KimiJournalTranscript(transcript);
  const reader = new KimiJournalReader(w.file, w.root, (r) => map.consume(r));
  await reader.read(); transcript.flush();
  assert.equal(transcript.messages.filter((m) => m.prompt).length, 1);
  assert.deepEqual(textOf(transcript), ['Invented first prompt: summarize the fixture folder.', 'Invented thinking.', 'Invented answer: two files.']);
  const content = transcript.messages.flatMap((m) => m.message.content);
  assert.deepEqual(content.find((b) => b.type === 'tool_use'), { type: 'tool_use', id: 'tool_1', name: 'Shell', input: { command: 'ls' } });
  assert.equal(content.find((b) => b.type === 'tool_result').content, 'a.txt\nb.txt');
});

test('journal cursors read only appended bytes, retain split UTF8 and JSON, and skip oversized records', async (t) => {
  const w = world(t, ''), received = [];
  const reader = new KimiJournalReader(w.file, w.root, (r) => received.push(r));
  const data = Buffer.from(line(prompt('Invented café 🦊')));
  const cut = data.indexOf(Buffer.from('🦊')) + 2;
  fs.appendFileSync(w.file, data.subarray(0, cut));
  assert.equal((await reader.read()).bytes, cut); assert.equal(received.length, 0);
  assert.equal((await reader.read()).bytes, 0);
  fs.appendFileSync(w.file, data.subarray(cut));
  assert.equal((await reader.read()).bytes, data.length - cut);
  assert.equal(received[0].input[0].text, 'Invented café 🦊');
  fs.appendFileSync(w.file, '{bad json}\n' + 'x'.repeat(3 * 1024 * 1024) + '\n' + line(prompt('After huge record')));
  let read;
  do { read = await reader.read({ maxBytes: 32768 }); assert.ok(read.bytes <= 32768); assert.ok(Buffer.byteLength(reader.buffer) <= 2 * 1024 * 1024); } while (read.more);
  assert.equal(received.length, 2); assert.equal(received[1].input[0].text, 'After huge record');
  assert.equal(reader.offset, fs.statSync(w.file).size);
  fs.appendFileSync(w.file, JSON.stringify(prompt('Final line without newline')));
  await reader.read(); assert.equal(received.length, 2);
  await reader.read({ final: true }); assert.equal(received.length, 3);
});

for (const mode of ['internal', 'busy']) test(`held ACP load (${mode}) opens read only, follows appended records and refuses sends`, async (t) => {
  const h = await harness(t, { FAKE_KIMI_HELD: mode });
  await h.kimi.open('open', h.p, ID, h.dir);
  assert.equal(h.events.find((e) => e.ev === 'opened').readOnly, true);
  assert.equal(h.events.some((e) => e.ev === 'error'), false);
  assert.equal(h.events.find((e) => e.ev === 'history').messages.length, 5);
  assert.ok(h.events.some((e) => e.ev === 'note' && /another Kimi process.*read only/.test(e.text)));
  assert.equal(h.loads(), 1);
  const initial = h.p.kimi.transcript.messages.map((m) => m.uuid);
  const appended = line(prompt('Invented follow up')) + line(message('Invented follow up')) + line(part('Invented new thought', 'think')) + line(part('Invented appended answer'));
  fs.appendFileSync(h.file, appended.slice(0, -10));
  await until(() => textOf(h.p.kimi.transcript).includes('Invented new thought'));
  assert.equal(textOf(h.p.kimi.transcript).includes('Invented appended answer'), false);
  fs.appendFileSync(h.file, appended.slice(-10));
  await until(() => textOf(h.p.kimi.transcript).includes('Invented appended answer'));
  assert.equal(h.p.kimi.transcript.messages.filter((m) => m.prompt).length, 2);
  assert.deepEqual(h.p.kimi.transcript.messages.slice(0, initial.length).map((m) => m.uuid), initial);
  assert.ok(h.events.some((e) => e.ev === 'sdk' && e.msg.prompt?.text === 'Invented follow up'));
  assert.equal(h.events.some((e) => e.ev === 'sdk' && e.msg.type === 'stream_event'), false);
  await h.kimi.attach('reconnect', h.p);
  assert.equal(h.events.find((e) => e.reqId === 'reconnect' && e.ev === 'opened').readOnly, true);
  await h.kimi.send('blocked', h.p, 'must not run');
  assert.match(h.events.find((e) => e.reqId === 'blocked').message, /read only/);
  await assert.rejects(h.kimi.handle({ op: 'mode', mode: 'yolo' }, h.p), /read only/);
  await h.kimi.interrupt(h.p);
  await h.kimi.close(h.p);
  assert.equal(h.calls().some((c) => ['session/prompt', 'session/cancel', 'session/close', 'session/set_config_option', 'session/set_mode'].includes(c.method)), false);
});

test('quiet visible panes retry at most every 30 seconds and switch live without replacing shown history', async (t) => {
  const h = await harness(t);
  await h.kimi.open('open', h.p, ID, h.dir);
  h.at(29999); await h.check(); assert.equal(h.loads(), 1);
  h.at(30000); await h.check(false); assert.equal(h.loads(), 1, 'hidden panes do not retry');
  await h.check(); assert.equal(h.loads(), 2, 'still held, no error');
  assert.equal(h.events.some((e) => e.ev === 'error'), false);
  fs.unlinkSync(h.held);
  h.at(59999); await h.check(); assert.equal(h.loads(), 2);
  fs.appendFileSync(h.file, line(part('The holder wrote one last answer.')));
  h.at(60000); await h.check(); assert.equal(h.loads(), 2, 'growth resets quiet time');
  h.at(89999); await h.check(); assert.equal(h.loads(), 2);
  await h.p.kimi.followWork;
  const before = structuredClone(h.p.kimi.transcript.messages);
  const historyEvents = h.events.filter((e) => e.ev === 'history').length;
  h.at(90000); await h.check();
  assert.equal(h.loads(), 3); assert.equal(h.p.kimi.readOnly, false); assert.equal(h.p.kimi.loaded, true);
  assert.deepEqual(h.p.kimi.transcript.messages, before, 'ACP replay does not replace or duplicate journal history');
  assert.equal(h.events.filter((e) => e.ev === 'history').length, historyEvents, 'the screen is not redrawn during the switch');
  assert.equal(h.events.filter((e) => e.ev === 'settings').at(-1).readOnly, false);
  await h.kimi.send('live-send', h.p, 'hello');
  await until(() => h.events.some((e) => e.ev === 'result' && e.reqId === 'live-send'));
  assert.equal(h.events.find((e) => e.reqId === 'live-send' && e.ev === 'result').isError, false);
  assert.equal(h.calls().filter((c) => c.method === 'session/prompt').length, 1);
  assert.deepEqual(h.p.kimi.transcript.messages.slice(0, before.length), before);
});

test('real load and retry errors are explained and are not mistaken for a held session', async (t) => {
  const h = await harness(t, { FAKE_KIMI_START: 'load-error' });
  fs.unlinkSync(h.held);
  await h.kimi.open('open', h.p, ID, h.dir);
  assert.equal(h.p.kimi.readOnly, false);
  assert.match(h.events.find((e) => e.ev === 'error').message, /ACP service failed/);
  assert.equal(mayBeHeld({ code: -32603 }), false, 'internal errors outside session/load do not imply a holder');
  const retry = await harness(t, { FAKE_KIMI_START: 'auth' });
  await retry.kimi.open('open', retry.p, ID, retry.dir);
  fs.unlinkSync(retry.held); retry.at(30000); await retry.check();
  assert.equal(retry.p.kimi.readOnly, true);
  assert.match(retry.events.find((e) => e.ev === 'error').message, /OAuth login.*journal remains read only/);
  retry.at(60000); await retry.check(); assert.equal(retry.loads(), 2, 'real retry errors stop automatic attempts');
});

test('the existing composer, thinking renderer and visibility checks support journal watching', async (t) => {
  const previous = globalThis.document;
  const wrap = { children: [], append(n) { this.children.push(n); } };
  const classes = new Set();
  const make = () => { const span = {}; return { innerHTML: '', append() {}, querySelector: () => span, remove() { this.removed = true; } }; };
  globalThis.document = { visibilityState: 'visible', createElement: make };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const p = Object.create(Pane.prototype), sent = [], thinking = [], users = [];
  Object.assign(p, { sessionId: ID, kind: 'kimi', busy: false, queue: [{ id: 'draft' }], streams: new Map(),
    el: { classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } }, querySelector: () => wrap.children.find((n) => !n.removed) },
    $: { wrap, input: { value: 'Keep my draft' }, send: {}, model: {}, effort: {}, mode: {}, T: { append(n) { thinking.push(n); } } },
    startDriftWatch() { this.watching = true; }, stopDriftWatch() { this.watching = false; },
    send(op, args) { sent.push({ op, ...args }); }, isShown: () => true, addUser: (text) => users.push(text),
  });
  p.setJournalReadOnly(true, 'Running in another Kimi process; read only.');
  assert.equal(p.$.input.disabled, true); assert.equal(p.$.send.disabled, true); assert.equal(p.$.mode.disabled, true);
  assert.equal(p.watching, true); assert.ok(classes.has('view-only'));
  assert.match(wrap.children[0].querySelector('span').textContent, /read only/);
  p.submit(); p.sendNow('blocked'); p.flushQueue(); p.sendItem('draft');
  assert.equal(sent.length, 0); assert.equal(p.queue.length, 1); assert.equal(p.$.input.value, 'Keep my draft');
  p.onSdk({ kimi: true, type: 'user', uuid: 'external-prompt', prompt: { text: 'Invented external prompt' }, message: { content: [] } });
  p.onSdk({ kimi: true, type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Invented thought' }] } });
  assert.deepEqual(users, ['Invented external prompt']); assert.equal(thinking[0].open, undefined, 'thinking stays collapsed');
  assert.match(thinking[0].innerHTML, /Thinking/); assert.equal(p.busy, false);
  await p.checkDrift(); assert.equal(sent.at(-1).visible, true);
  globalThis.document.visibilityState = 'hidden'; p.driftAt = 0;
  await p.checkDrift(); assert.equal(sent.at(-1).visible, false);
  p.setJournalReadOnly(false);
  assert.equal(p.$.input.disabled, false); assert.equal(p.$.mode.disabled, false); assert.equal(p.watching, false);
  assert.equal(p.$.input.value, 'Keep my draft'); assert.equal(p.queue.length, 1);
});

test('system origins and their context mirrors cannot become titles or user history', async (t) => {
  const w = world(t, line(prompt('Invented synthetic task', { kind: 'system' })) + line(message('Invented synthetic task'))
    + line(prompt('Invented real task', { kind: 'agent_file' })) + line(message('Invented real task')));
  const row = (await w.list.refresh())[0];
  assert.equal(row.title, 'Invented real task'); assert.equal(row.kimiRole, 'Agent file');
  const transcript = new KimiTranscript(), map = new KimiJournalTranscript(transcript);
  await new KimiJournalReader(w.file, w.root, (r) => map.consume(r)).read();
  assert.deepEqual(textOf(transcript), ['Invented real task']);
});

test('closing during a retry settles its child and stops journal following', async (t) => {
  const h = await harness(t, { FAKE_KIMI_LOAD_DELAY: '200' });
  await h.kimi.open('open', h.p, ID, h.dir);
  fs.unlinkSync(h.held); h.at(30000);
  const retry = h.check();
  await until(() => h.loads() === 2);
  const client = h.p.kimi.client;
  await h.kimi.close(h.p); await retry;
  assert.equal(h.p.kimi, null); assert.equal(client.closed, true);
  assert.notEqual(client.child.exitCode, null);
  const count = h.events.length;
  fs.appendFileSync(h.file, line(part('After pane close')));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.events.length, count);
  assert.equal(h.events.some((e) => e.ev === 'error'), false);
});

test('an internal initialization error explains the failure without assuming a held session', async (t) => {
  const h = await harness(t, { FAKE_KIMI_START: 'init-error' });
  await h.kimi.open('open', h.p, ID, h.dir);
  assert.equal(h.p.kimi.readOnly, false); assert.equal(h.loads(), 0);
  assert.match(h.events.find((e) => e.ev === 'error').message, /ACP service failed/);
});
