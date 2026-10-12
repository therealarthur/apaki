/**
 * Queued messages that go out with no window (apaki/engine/queue-hold.js) and
 * the "Auto-compact at" setting (apaki/engine/prefs.js), 2026-10-10.
 *
 * Unit tests: the queue rules as pure functions (the window owns the queue
 * while connected, the engine owns it with no window, a user Stop keeps it
 * unsent, a send names the ids it takes, a phone never has a held queue), the
 * pane's side of the contract (pane.js syncQueue, adoptQueue, flushQueue), the
 * saved-workspace patch, the settings file, and what a phone may send.
 *
 * End to end: the real engine.js --host in a temp world with a fake Agent SDK
 * (no Claude Code process, nothing billed; same approach as
 * test/apaki-host.test.js): the engine never double-sends while a window is
 * connected; with the window closed it sends the queue joined as one message
 * and tells the window what it sent when it comes back; a Stop keeps the
 * queue unsent; and the auto-compact choice reaches the process options.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_HELD, MAX_SENT_IDS, cleanItems, dropHeld, heldView, joinItems, rememberSent, resetHeld, setHeld, takeForAutoSend } from '../apaki/engine/queue-hold.js';
import { COMPACT_CHOICES, COMPACT_DEFAULT, compactSettings, loadPrefs, normalizeCompact, prefsFile, savePrefs } from '../apaki/engine/prefs.js';
import { connectHost, patchWorkspaceLeaves, readHostInfo } from '../apaki/engine/host.js';
import { checkPhoneCommand } from '../apaki/engine/remote-policy.js';
import { Pane } from '../apaki/ui/pane.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-queue-test-'));
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

/* ------------------------------------------------------------ queue rules (pure) */

const item = (id, text, images = []) => ({ id, text, images });
const pane = (held, extra = {}) => ({ id: 'p1', held: held.map((it) => ({ ...it, images: it.images || [] })), ...extra });

test('cleanItems keeps what can be sent and drops the rest', () => {
  const png = { media_type: 'image/png', data: 'AAAA', w: 10, h: 20 };
  const out = cleanItems([
    item('a', 'one', [png, { media_type: 'text/html', data: 'x' }, { media_type: 'image/png' }]),
    item('a', 'duplicate id'),
    item('b', ''),
    item('c', '', [png]),
    { text: 'no id' },
    null,
    item('d', 'two'),
  ]);
  assert.deepEqual(out.map((it) => it.id), ['a', 'c', 'd']);
  assert.deepEqual(out[0].images, [png]);
  assert.deepEqual(cleanItems('not a list'), []);
  assert.equal(cleanItems(Array.from({ length: MAX_HELD + 20 }, (_, i) => item(`i${i}`, 'x'))).length, MAX_HELD);
});

test('joinItems joins like pane.js flushQueue: blank line between texts, empty ones skipped, images in order', () => {
  const a = { media_type: 'image/png', data: 'A', w: 1, h: 1 };
  const b = { media_type: 'image/jpeg', data: 'B', w: 2, h: 2 };
  const j = joinItems([item('1', 'first', [a]), item('2', ''), item('3', 'third', [b])]);
  assert.equal(j.text, 'first\n\nthird');
  assert.deepEqual(j.images, [{ media_type: 'image/png', data: 'A' }, { media_type: 'image/jpeg', data: 'B' }]);
});

test('no window connected: the engine takes the queue for the next message, clears its copy and remembers the ids', () => {
  const p = pane([item('q1', 'second'), item('q2', 'third')]);
  const plan = takeForAutoSend(p, { windowConnected: false });
  assert.equal(plan.text, 'second\n\nthird');
  assert.deepEqual(plan.ids, ['q1', 'q2']);
  assert.deepEqual(p.held, []);
  assert.deepEqual(p.heldSent, ['q1', 'q2']);
  // Nothing left, so a second result sends nothing.
  assert.equal(takeForAutoSend(p, { windowConnected: false }), null);
});

test('a window is connected: the window owns the queue and the engine never sends it (no double send)', () => {
  const p = pane([item('q1', 'second')]);
  assert.equal(takeForAutoSend(p, { windowConnected: true }), null);
  assert.deepEqual(p.held.map((it) => it.id), ['q1'], 'the copy stays for the moment the window goes away');
  assert.equal(p.heldSent, undefined);
});

test('a user Stop keeps the queue unsent; a phone pane never has the engine send for it', () => {
  const stopped = pane([item('q1', 'second')], { userStopped: true });
  assert.equal(takeForAutoSend(stopped, { windowConnected: false }), null);
  assert.equal(stopped.held.length, 1);
  const phone = pane([item('q1', 'second')], { id: 'phone:dev:p1' });
  assert.equal(takeForAutoSend(phone, { windowConnected: false, phone: true }), null);
  assert.equal(takeForAutoSend({ id: 'p9' }, { windowConnected: false }), null, 'a pane with no copy');
});

test('dropHeld removes what a send or steer took; heldView and resetHeld', () => {
  const p = pane([item('q1', 'a'), item('q2', 'b'), item('q3', 'c')]);
  assert.equal(dropHeld(p, ['q2', 'nope', 7]), 1);
  assert.deepEqual(p.held.map((it) => it.id), ['q1', 'q3']);
  assert.equal(dropHeld(p, undefined), 0);
  assert.equal(dropHeld({}, ['q1']), 0);
  rememberSent(p, ['q9']);
  const v = heldView(p);
  assert.deepEqual(v.queue.map((it) => it.id), ['q1', 'q3']);
  assert.deepEqual(v.queueSent, ['q9']);
  v.queue[0].text = 'changed';
  assert.equal(p.held[0].text, 'a', 'the view is a copy');
  p.userStopped = true;
  resetHeld(p);
  assert.deepEqual([p.held, p.heldSent, p.userStopped], [[], [], false]);
  rememberSent(p, Array.from({ length: MAX_SENT_IDS + 10 }, (_, i) => `s${i}`));
  assert.equal(p.heldSent.length, MAX_SENT_IDS);
  assert.equal(p.heldSent.at(-1), `s${MAX_SENT_IDS + 9}`);
  setHeld(p, [item('z', 'zz')]);
  assert.deepEqual(p.held.map((it) => it.id), ['z']);
});

test('the saved workspace: what the engine sent is taken out of a pane\'s saved queue', () => {
  const ws = { v: 1, savedAt: 5, tabs: [{ root: { type: 'leaf', pane: 'p1', s: 'sid', busy: true, queue: [{ id: 'q1', text: 'a' }] } }] };
  const next = patchWorkspaceLeaves(ws, 'p1', { busy: true, queue: [] });
  assert.deepEqual(next.tabs[0].root.queue, []);
  assert.equal(next.tabs[0].root.busy, true);
  assert.equal(next.savedAt, 6);
  // A patch without a queue leaves the saved one alone; what stays unsent keeps its ids.
  assert.deepEqual(patchWorkspaceLeaves(ws, 'p1', { busy: false }).tabs[0].root.queue, [{ id: 'q1', text: 'a' }]);
  assert.deepEqual(patchWorkspaceLeaves(ws, 'p1', { queue: [{ id: 'q2', text: 'b', images: [1] }, { id: 'q3', text: '' }] }).tabs[0].root.queue, [{ id: 'q2', text: 'b' }]);
});

/* ------------------------------------------------------------ the pane's side (pane.js) */

/** A Pane's prototype methods on a plain object: no DOM, the sends are recorded. */
function fakePane({ engineQueue = true, queue = [], busy = false } = {}) {
  const sent = [];
  const p = Object.create(Pane.prototype);
  Object.assign(p, {
    host: { engineQueue }, queue, busy, stoppedByUser: false, attachments: [],
    send: (op, args) => sent.push({ op, ...args }),
    renderQueue() {}, addUser() {}, setBusy(on) { this.busy = on; },
  });
  return { p, sent };
}
const qi = (id, text, attachments = []) => ({ id, text, attachments });

test('pane: every queue change is sent to the engine as queueSet, with the images', () => {
  const { p, sent } = fakePane();
  p.enqueue('later', [{ media_type: 'image/png', data: 'AAAA', url: 'data:x', w: 3, h: 4 }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'queueSet');
  assert.equal(sent[0].items.length, 1);
  assert.equal(sent[0].items[0].text, 'later');
  assert.deepEqual(sent[0].items[0].images, [{ media_type: 'image/png', data: 'AAAA', w: 3, h: 4 }]);
  assert.match(sent[0].items[0].id, /^q/);
  // Removing or pulling one back to edit syncs the new state.
  p.removeItem = Pane.prototype.removeItem;
  p.$ = { input: { focus() {} } };
  p.removeItem(p.queue[0].id);
  assert.deepEqual(sent.at(-1), { op: 'queueSet', items: [] });
});

test('pane: the phone page (no engineQueue) sends no queueSet and no queued ids', () => {
  const { p, sent } = fakePane({ engineQueue: false });
  p.enqueue('later', []);
  assert.equal(sent.length, 0);
  p.flushQueue();
  assert.deepEqual(sent, [{ op: 'send', text: 'later', images: [] }]);
});

test('pane: a flush joins the items and names their ids, so the engine drops its copy in the same step', () => {
  const { p, sent } = fakePane({ queue: [qi('q1', 'one'), qi('q2', ''), qi('q3', 'three')] });
  p.flushQueue();
  assert.deepEqual(sent, [{ op: 'send', text: 'one\n\nthree', images: [], queued: ['q1', 'q2', 'q3'] }]);
  assert.deepEqual(p.queue, []);
  // After a Stop it does not flush.
  const stopped = fakePane({ queue: [qi('q1', 'one')] });
  stopped.p.stoppedByUser = true;
  stopped.p.flushQueue();
  assert.equal(stopped.sent.length, 0);
});

test('pane: steering or sending one item names it and does not sync a second time', () => {
  const { p, sent } = fakePane({ queue: [qi('q1', 'one'), qi('q2', 'two')], busy: true });
  p.steering = new Map();
  p.steerItem('q1');
  assert.deepEqual(sent, [{ op: 'steer', qid: 'q1', text: 'one', images: [] }]);
  p.busy = false;
  p.sendItem('q2');
  assert.deepEqual(sent[1], { op: 'send', text: 'two', images: [], queued: ['q2'] });
});

test('pane: re-attached, the engine\'s queue is what is unsent; what it sent is dropped; local-only items stay and go to the engine', () => {
  const img = { media_type: 'image/png', data: 'AAAA', w: 5, h: 6 };
  const { p, sent } = fakePane({ queue: [qi('q1', 'still queued'), qi('q2', 'sent while away'), qi('mine', 'typed offline')] });
  p.adoptQueue([{ id: 'q1', text: 'still queued', images: [] }, { id: 'q4', text: 'only the engine has it', images: [img] }], ['q2']);
  assert.deepEqual(p.queue.map((it) => it.id), ['q1', 'q4', 'mine']);
  assert.equal(p.queue[0].text, 'still queued');
  assert.deepEqual(p.queue[1].attachments, [{ media_type: 'image/png', data: 'AAAA', url: 'data:image/png;base64,AAAA', w: 5, h: 6 }]);
  assert.deepEqual(sent.map((s) => s.op), ['queueSet'], 'the item only the pane had goes to the engine');
  assert.deepEqual(sent[0].items.map((it) => it.id), ['q1', 'q4', 'mine']);
  // Nothing extra: nothing to send back.
  const calm = fakePane({ queue: [qi('q1', 'x')] });
  calm.p.adoptQueue([{ id: 'q1', text: 'x', images: [] }], []);
  assert.equal(calm.sent.length, 0);
  // Everything went out while the window was away: the queue empties.
  const gone = fakePane({ queue: [qi('q1', 'x'), qi('q2', 'y')] });
  gone.p.adoptQueue([], ['q1', 'q2']);
  assert.deepEqual(gone.p.queue, []);
  assert.equal(gone.sent.length, 0);
});

test('pane: an opened event with attached sets the queue from the engine; a fresh open pushes the pane\'s own', () => {
  const calls = [];
  const p = Object.create(Pane.prototype);
  Object.assign(p, {
    host: { engineQueue: true, changed() {} }, queue: [qi('r0', 'restored')], busy: false, sessionId: 'S', steering: new Map(), closedArts: new Set(), streams: new Map(), tools: new Map(), cardKeys: new Map(), liveTasks: new Map(),
    $: { T: { innerHTML: '', querySelector: () => null, append() {} } }, openNotes: [], commands: [{ name: 'x' }],
    adoptQueue: (held, sent) => calls.push(['adopt', held, sent]), syncQueue: () => calls.push(['sync']),
    send() {}, renderQueue() {}, setBusy(on) { this.busy = on; }, setTitle() {}, setCwdLine() {}, renderBilling() {}, askContext() {}, renderContext() {}, renderTasksButton() {}, flushOpenNotes() {},
    showEmpty() {},
  });
  p.handle({ ev: 'opened', attached: true, busy: false, sessionId: 'S', queue: [{ id: 'q1', text: 'a', images: [] }], queueSent: ['r0'] });
  assert.deepEqual(calls, [['adopt', [{ id: 'q1', text: 'a', images: [] }], ['r0']]]);
  calls.length = 0;
  p.handle({ ev: 'opened', sessionId: 'S' });
  assert.deepEqual(calls, [['sync']]);
});

/* ------------------------------------------------------------ auto-compact setting (pure) */

test('auto-compact: the choices, the default, and what is passed to Claude Code', () => {
  assert.deepEqual([...COMPACT_CHOICES], ['off', 200000, 300000, 500000, 'default']);
  assert.equal(COMPACT_DEFAULT, 'off', 'off by default (Arthur, 2026-10-10 night)');
  assert.equal(normalizeCompact(500000), 500000);
  assert.equal(normalizeCompact('200000'), 200000);
  assert.equal(normalizeCompact('default'), 'default');
  assert.equal(normalizeCompact('off'), 'off');
  assert.equal(normalizeCompact(false), 'off');
  for (const bad of [undefined, null, 0, 12345, 'auto', '5e5', {}, -1]) assert.equal(normalizeCompact(bad), 'off');
  assert.deepEqual(compactSettings(300000), { autoCompactWindow: 300000 });
  assert.deepEqual(compactSettings('500000'), { autoCompactWindow: 500000 });
  assert.equal(compactSettings('default'), null, 'Claude Code decides: nothing is passed');
  assert.deepEqual(compactSettings('off'), { autoCompactEnabled: false, idleCompaction: false });
  assert.deepEqual(compactSettings(undefined), { autoCompactEnabled: false, idleCompaction: false }, 'the default is off');
});

test('auto-compact: kept in one small file under ~/.claude/latch, never in Claude Code\'s own settings', () => {
  const dir = tmp();
  try {
    const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
    const file = prefsFile(env);
    assert.equal(file, path.join(dir, 'claude', 'latch', 'apaki-settings.json'));
    assert.deepEqual(loadPrefs(file), { autoCompact: 'off', releaseHiddenMin: 15 }, 'no file yet: the defaults');
    savePrefs(file, { autoCompact: 200000 });
    assert.deepEqual(loadPrefs(file), { autoCompact: 200000, releaseHiddenMin: 15 });
    savePrefs(file, { autoCompact: 'default' });
    assert.deepEqual(loadPrefs(file), { autoCompact: 'default', releaseHiddenMin: 15 });
    savePrefs(file, { autoCompact: 'off', releaseHiddenMin: 0 });
    assert.deepEqual(loadPrefs(file), { autoCompact: 'off', releaseHiddenMin: 0 }, 'the hidden-conversation setting is kept beside it, and 0 (off) is a choice');
    savePrefs(file, { autoCompact: 'off', releaseHiddenMin: 7 });
    assert.equal(loadPrefs(file).releaseHiddenMin, 15, 'a value that is not a choice is the default');
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(loadPrefs(file), { autoCompact: 'off', releaseHiddenMin: 15 }, 'a damaged file reads as the defaults');
    fs.writeFileSync(file, JSON.stringify({ autoCompact: 42 }));
    assert.deepEqual(loadPrefs(file), { autoCompact: 'off', releaseHiddenMin: 15 });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'claude')), ['latch'], 'nothing written beside the latch folder');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'claude', 'latch')), ['apaki-settings.json'], 'no temp file left behind');
  } finally { rm(dir); }
});

test('phones: queueSet and autoCompact are not available; a phone send never carries queued ids', () => {
  const ctx = { deviceId: 'dev1', paneExists: () => true };
  for (const op of ['queueSet', 'autoCompact', 'releaseHidden']) {
    const r = checkPhoneCommand({ op, paneId: 'p1', items: [], value: 200000 }, ctx);
    assert.equal(r.ok, false, op);
  }
  const r = checkPhoneCommand({ op: 'send', paneId: 'p1', text: 'hi', queued: ['q1'] }, ctx);
  assert.equal(r.ok, true);
  assert.equal('queued' in r.cmd, false);
  const s = checkPhoneCommand({ op: 'steer', paneId: 'p1', qid: 'q1', text: 'hi', queued: ['q9'] }, ctx);
  assert.equal(s.ok, true);
  assert.equal('queued' in s.cmd, false);
});

/* ------------------------------------------------------------ end to end: engine.js --host */

// A stand-in for @anthropic-ai/claude-agent-sdk (as in apaki-host.test.js): each message is echoed, "wait:<ms>" makes the
// turn take that long. Its init message carries the `settings` option it was started with (latchSettings), so a test can see
// what reached the process options. Everything else comes from the real SDK.
const REAL_SDK = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
const FAKE_SDK_BODY = String.raw`
import crypto from 'node:crypto';
const sessions = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Chan {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => (this.items.length ? Promise.resolve({ value: this.items.shift(), done: false }) : this.done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => this.waiters.push(r))),
      return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');
export function query({ prompt, options = {} }) {
  const out = new Chan();
  let sid = options.resume || null;
  let n = 0;
  (async () => {
    let inited = false;
    for await (const m of prompt) {
      if (!sid) sid = crypto.randomUUID();
      if (!sessions.has(sid)) sessions.set(sid, []);
      if (!inited) { inited = true; out.push({ type: 'system', subtype: 'init', session_id: sid, latchSettings: options.settings || null }); }
      const text = textOf(m.message && m.message.content);
      const id = 'msg_' + (++n);
      sessions.get(sid).push({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: text } });
      out.push({ type: 'stream_event', event: { type: 'message_start', message: { id } }, session_id: sid });
      const wait = /wait:(\d+)/.exec(text);
      if (wait) await sleep(Number(wait[1]));
      const reply = 'echo: ' + text;
      sessions.get(sid).push({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
      out.push({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: reply }] }, session_id: sid });
      out.push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, usage: {}, total_cost_usd: 0, result: reply, session_id: sid });
    }
    out.end();
  })().catch(() => out.end());
  return Object.assign(out, {
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, supportedCommands: async () => [],
    getContextUsage: async () => ({ percentage: 1, categories: [] }), stopTask: async () => {}, backgroundTasks: async () => false, getTaskOutput: async () => ({ output: '' }),
  });
}
export async function getSessionMessages(id) { return (sessions.get(id) || []).slice(); }
export async function getSessionInfo(id) { return sessions.has(id) ? { sessionId: id, summary: 'Fake session', cwd: process.cwd() } : null; }
export async function listSessions() { return []; }
export async function renameSession() {}
export function createSdkMcpServer(o = {}) { return { type: 'sdk', name: o.name, instance: {} }; }
export function tool(name, description, inputSchema, handler) { return { name, description, inputSchema, handler }; }
`;
const FAKE_SDK = `export * from ${JSON.stringify(REAL_SDK)};\n${FAKE_SDK_BODY}`;
const HOOKS = `export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: new URL('./fake-agent-sdk.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`;
const LOADER = `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`;
const APP = 'apaki-dev-queue-test';

/** Starts engine.js --host in a temp world (isolated, no Glass, no index, no keeper); resolves once its host file names it. */
async function startHost(t, extraEnv = {}) {
  const dir = tmp();
  const claude = path.join(dir, 'claude');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-agent-sdk.mjs'), FAKE_SDK);
  fs.writeFileSync(path.join(fake, 'hooks.mjs'), HOOKS);
  fs.writeFileSync(path.join(fake, 'loader.mjs'), LOADER);
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
    ...extraEnv,
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
  return { child, file, dir, claude, log: () => log, workspace: () => { try { return JSON.parse(fs.readFileSync(path.join(claude, 'latch', `apaki-workspace.${APP}.json`), 'utf8')); } catch { return null; } } };
}

const windowOf = async (h) => {
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });
  return w;
};

/** A saved workspace with one tab per leaf: { pane, s, busy, queue }. */
const ws = (leaves, savedAt) => ({ v: 1, savedAt, active: 0, tabs: leaves.map((l) => ({ focused: l.pane, root: { type: 'leaf', ...l } })) });
const leafOf = (saved, pane) => saved?.tabs?.map((tb) => tb.root).find((r) => r.pane === pane);
const echoes = (hist) => hist.messages.filter((m) => m.message.role === 'assistant').map((m) => (Array.isArray(m.message.content) ? m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(m.message.content)));
/** Opens a pane the way a window restores it (open warm:false), which the host turns into attach; resolves with opened and its history. */
async function reattach(w, h, paneId, sessionId, reqId) {
  const from = w.events.length;
  w.send({ op: 'open', reqId, paneId, sessionId, cwd: h.dir, warm: false });
  const opened = await w.next((m) => m.ev === 'opened' && m.reqId === reqId, 10000, from);
  const hist = await w.next((m) => m.ev === 'history' && m.paneId === paneId, 10000, from);
  return { opened, hist };
}

test('end to end: the window owns the queue while connected; with no window the engine sends it joined; a Stop keeps it unsent', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);

  // A: a window is connected when the turn ends. The engine holds a copy but sends nothing; the window's own send names the
  // queued ids, so the copy is gone and nothing goes out again when the window leaves.
  let w = await windowOf(h);
  w.send({ op: 'open', reqId: 'oA', paneId: 'pA', sessionId: null, cwd: h.dir, warm: true });
  await w.next((m) => m.ev === 'opened' && m.reqId === 'oA');
  w.send({ op: 'send', reqId: 'sA1', paneId: 'pA', text: 'wait:300 first' });
  w.send({ op: 'queueSet', paneId: 'pA', items: [item('q1', 'second'), item('q2', 'third')] });
  const sidA = (await w.next((m) => m.ev === 'session_id' && m.paneId === 'pA')).sessionId;
  await w.next((m) => m.ev === 'result' && m.reqId === 'sA1');
  await sleep(800);
  const starts = (pid) => w.events.filter((m) => m.ev === 'sdk' && m.paneId === pid && m.msg?.type === 'stream_event').length;
  assert.equal(starts('pA'), 1, 'the engine did not send while a window was connected');
  w.send({ op: 'send', reqId: 'sA2', paneId: 'pA', text: 'second\n\nthird', queued: ['q1', 'q2'] });
  assert.equal((await w.next((m) => m.ev === 'result' && m.reqId === 'sA2')).result, 'echo: second\n\nthird');
  w.close();
  await w.closed;
  await sleep(1000);
  w = await windowOf(h);
  let back = await reattach(w, h, 'pA', sidA, 'rA');
  assert.equal(back.opened.attached, true);
  assert.deepEqual(back.opened.queue, [], 'the window flushed it; the engine holds nothing');
  assert.deepEqual(back.opened.queueSent, []);
  assert.deepEqual(echoes(back.hist), ['echo: wait:300 first', 'echo: second\n\nthird'], 'each message went out once');

  // B: the window closes mid-turn with two messages queued. The turn ends with no window: the engine sends them joined as
  // one message, clears its copy and the saved workspace's queue, and tells the window that comes back what it sent.
  w.send({ op: 'open', reqId: 'oB', paneId: 'pB', sessionId: null, cwd: h.dir, warm: true });
  await w.next((m) => m.ev === 'opened' && m.reqId === 'oB');
  w.send({ op: 'send', reqId: 'sB1', paneId: 'pB', text: 'wait:700 first' });
  const sidB = (await w.next((m) => m.ev === 'session_id' && m.paneId === 'pB')).sessionId;
  w.send({ op: 'queueSet', paneId: 'pB', items: [item('q1', 'second'), item('q2', 'third')] });
  w.send({ op: 'saveState', state: ws([{ pane: 'pA', s: sidA, busy: false }, { pane: 'pB', s: sidB, busy: true, queue: [{ id: 'q1', text: 'second' }, { id: 'q2', text: 'third' }] }], 1000) });
  await sleep(100);
  w.close();
  await w.closed;
  await until(() => { const l = leafOf(h.workspace(), 'pB'); return l && l.busy === false && Array.isArray(l.queue) && l.queue.length === 0; }, 15000);
  w = await windowOf(h);
  back = await reattach(w, h, 'pB', sidB, 'rB');
  assert.equal(back.opened.attached, true);
  assert.equal(back.opened.busy, false);
  assert.deepEqual(back.opened.queue, []);
  assert.deepEqual(back.opened.queueSent, ['q1', 'q2'], 'the window is told what went out');
  assert.deepEqual(echoes(back.hist), ['echo: wait:700 first', 'echo: second\n\nthird'], 'one message, joined like pane.js joins it');

  // C: the user stops the turn, then the window closes. The queue stays unsent, held for the window that returns.
  w.send({ op: 'open', reqId: 'oC', paneId: 'pC', sessionId: null, cwd: h.dir, warm: true });
  await w.next((m) => m.ev === 'opened' && m.reqId === 'oC');
  w.send({ op: 'send', reqId: 'sC1', paneId: 'pC', text: 'wait:700 first' });
  const sidC = (await w.next((m) => m.ev === 'session_id' && m.paneId === 'pC')).sessionId;
  w.send({ op: 'queueSet', paneId: 'pC', items: [item('q1', 'second')] });
  w.send({ op: 'interrupt', paneId: 'pC' });
  w.send({ op: 'saveState', state: ws([{ pane: 'pC', s: sidC, busy: true, queue: [{ id: 'q1', text: 'second' }] }], 2000) });
  await sleep(100);
  w.close();
  await w.closed;
  await until(() => leafOf(h.workspace(), 'pC')?.busy === false, 15000);
  await sleep(800);
  w = await windowOf(h);
  back = await reattach(w, h, 'pC', sidC, 'rC');
  assert.deepEqual(back.opened.queue.map((it) => [it.id, it.text]), [['q1', 'second']], 'still queued after a Stop');
  assert.deepEqual(back.opened.queueSent, []);
  assert.deepEqual(echoes(back.hist), ['echo: wait:700 first'], 'nothing was sent after the Stop');

  // D: a new message after the Stop arms the queue again: the window closes mid-turn and the engine sends it at the end.
  w.send({ op: 'send', reqId: 'sC2', paneId: 'pC', text: 'wait:700 again' });
  await w.next((m) => m.ev === 'sdk' && m.paneId === 'pC' && m.msg?.type === 'stream_event');
  w.send({ op: 'saveState', state: ws([{ pane: 'pC', s: sidC, busy: true, queue: [{ id: 'q1', text: 'second' }] }], 3000) });
  await sleep(100);
  w.close();
  await w.closed;
  await until(() => { const l = leafOf(h.workspace(), 'pC'); return l && l.busy === false && l.queue?.length === 0; }, 15000);
  w = await windowOf(h);
  back = await reattach(w, h, 'pC', sidC, 'rC2');
  assert.deepEqual(back.opened.queue, []);
  assert.deepEqual(back.opened.queueSent, ['q1']);
  assert.deepEqual(echoes(back.hist), ['echo: wait:700 first', 'echo: wait:700 again', 'echo: second']);
  w.close();
});

test('end to end: a conversation in a hidden tab lets go of its Claude Code process when idle, and the next message starts it again', { timeout: 60000 }, async (t) => {
  // The hidden time is shortened for the test (APAKI_HOST_HIDE_MS; the setting itself is in minutes, 15 by default).
  const h = await startHost(t, { APAKI_HOST_HIDE_MS: '600' });
  const w = await windowOf(h);
  const ctl = await connectHost({ file: h.file, role: 'control' });
  const running = async () => {
    ctl.send({ op: 'hostStatus', reqId: 'st' });
    const st = await ctl.next((m) => m.ev === 'host' && m.reqId === 'st', 10000, ctl.events.length);
    return Object.fromEntries(st.panes.map((p) => [p.id, p.running]));
  };
  const sids = {};
  for (const id of ['pA', 'pB']) {
    w.send({ op: 'open', reqId: `o${id}`, paneId: id, sessionId: null, cwd: h.dir, warm: true });
    await w.next((m) => m.ev === 'opened' && m.reqId === `o${id}`);
    w.send({ op: 'send', reqId: `s${id}`, paneId: id, text: 'hello' });
    sids[id] = (await w.next((m) => m.ev === 'session_id' && m.paneId === id)).sessionId;
    await w.next((m) => m.ev === 'result' && m.reqId === `s${id}`);
  }
  assert.deepEqual(await running(), { pA: true, pB: true });
  // The window shows tab 0 (pA); pB's tab is hidden. After its hidden time the host frees pB's process, never pA's.
  w.send({ op: 'saveState', state: ws([{ pane: 'pA', s: sids.pA, busy: false }, { pane: 'pB', s: sids.pB, busy: false }], 1000) });
  await until(() => /freed the Claude Code process of hidden pane pB/.test(h.log()), 20000);
  assert.deepEqual(await running(), { pA: true, pB: false });
  assert.ok(!/hidden pane pA/.test(h.log()), 'the showing tab is never released');
  // The next message in pB starts its process again, resuming the same conversation from disk.
  w.send({ op: 'send', reqId: 'sB2', paneId: 'pB', text: 'again' });
  const r = await w.next((m) => m.ev === 'result' && m.reqId === 'sB2', 20000);
  assert.equal(r.result, 'echo: again');
  assert.equal((await running()).pB, true);
  assert.equal(r.sessionId, sids.pB, 'the same conversation');
  // Showing pB's tab clears its hidden time: it is not released again while it shows.
  w.send({ op: 'saveState', state: { ...ws([{ pane: 'pA', s: sids.pA, busy: false }, { pane: 'pB', s: sids.pB, busy: false }], 2000), active: 1 } });
  // pA is hidden now and is freed in turn (polled: a loaded machine can be slow); pB, showing, is not.
  let now = await running();
  for (let i = 0; i < 60 && now.pA; i++) { await sleep(250); now = await running(); }
  assert.equal(now.pA, false, 'pA is hidden now and freed in turn');
  assert.equal(now.pB, true, 'showing');
  ctl.close();
  w.close();
});

test('end to end: Auto-compact is kept by the engine, defaults to off, and reaches each new Claude Code process as its own setting', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const ask = async (reqId, extra = {}) => { w.send({ op: 'autoCompact', reqId, ...extra }); return w.next((m) => m.ev === 'autoCompact' && m.reqId === reqId); };
  const first = await ask('c1');
  assert.equal(first.value, 'off');
  assert.deepEqual(first.choices, ['off', 200000, 300000, 500000, 'default']);
  const file = path.join(h.claude, 'latch', 'apaki-settings.json');
  assert.equal((await ask('c2', { value: 500000 })).value, 500000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autoCompact: 500000, releaseHiddenMin: 15 });

  /** Opens a pane, sends one message and returns the settings its Claude Code process was started with. */
  const startedWith = async (paneId) => {
    w.send({ op: 'open', reqId: `o-${paneId}`, paneId, sessionId: null, cwd: h.dir, warm: true });
    await w.next((m) => m.ev === 'opened' && m.reqId === `o-${paneId}`);
    w.send({ op: 'send', reqId: `s-${paneId}`, paneId, text: 'hello' });
    await w.next((m) => m.ev === 'result' && m.reqId === `s-${paneId}`);
    return w.events.find((m) => m.ev === 'sdk' && m.paneId === paneId && m.msg?.subtype === 'init').msg.latchSettings;
  };
  assert.deepEqual(await startedWith('p1'), { autoCompactWindow: 500000 });
  // Changing it does not touch a running conversation; the next one to start gets the new value.
  assert.equal((await ask('c3', { value: 200000 })).value, 200000);
  assert.deepEqual(await startedWith('p2'), { autoCompactWindow: 200000 });
  // Claude Code's default: nothing is passed.
  assert.equal((await ask('c4', { value: 'default' })).value, 'default');
  assert.equal(await startedWith('p3'), null);
  // A value that is not one of the choices falls back to the install default.
  assert.equal((await ask('c5', { value: 12345 })).value, 'off');
  assert.deepEqual(await startedWith('p4'), { autoCompactEnabled: false, idleCompaction: false });
  // Off by choice: the same settings.
  assert.equal((await ask('c6', { value: 'off' })).value, 'off');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autoCompact: 'off', releaseHiddenMin: 15 });
  assert.deepEqual(await startedWith('p5'), { autoCompactEnabled: false, idleCompaction: false });
  // Claude Code's own settings file is never written (the temp CLAUDE_CONFIG_DIR holds only the latch folder).
  assert.equal(fs.existsSync(path.join(h.claude, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(h.dir, '.claude.json')), false);
  w.close();
});
