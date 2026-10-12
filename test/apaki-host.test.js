/**
 * The engine as a background host (apaki/engine/host.js, 2026-10-10; Arthur:
 * closing Apaki must not close the Claude Code sessions that are open).
 *
 * Unit tests: the host file, the handshake (both sides prove the token,
 * nothing is processed before), one window at a time, control connections,
 * what a pane is doing from its SDK messages, open-to-attach on restore, the
 * workspace patch for turns that end with no window, and the idle rules.
 *
 * End to end: the real engine.js --host, isolated (temp CLAUDE_CONFIG_DIR,
 * app id apaki-dev-host-test, no Glass, no index, no keeper), with a fake
 * Agent SDK put in place by a Node import hook written to a temp folder, so
 * no Claude Code process starts and nothing is billed. A window client
 * connects, starts a turn, disconnects mid-turn, comes back and sees the
 * result; a question asked with no window waits and is asked again; idle
 * processes close and the host exits; host-ctl.js quit waits for the window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_APP_ID, HostServer, MAX_LINE_BYTES, clientMac, codeStamp, connectHost, createLifecycle, engineStamp, hostFile, macEqual, noteSdkMessage,
  paneTurnBusy, paneWorking, patchWorkspaceLeaves, pidAlive, planIdle, readHostInfo, removeHostInfo, restoreAsAttach, serverMac, taskReplay, writeHostInfo,
} from '../apaki/engine/host.js';
import { createShell } from '../apaki/engine/shell-channel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const HOST_CTL = path.join(ROOT, 'apaki', 'engine', 'host-ctl.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-host-test-'));
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

/** A HostServer in a temp folder, closed after the test. */
async function server(t, o = {}) {
  const dir = tmp();
  const file = path.join(dir, 'apaki-host.test.json');
  const lines = [];
  const seen = { connect: 0, gone: 0 };
  const s = new HostServer({
    appId: 'apaki-dev-host-test', file, root: 'C:\\x', stamp: '1-2', log: () => {},
    onConnect: () => { seen.connect += 1; }, onGone: () => { seen.gone += 1; }, onLine: (line) => lines.push(line),
    control: (c) => ({ ev: c.op === 'hostQuit' ? 'hostQuit' : 'host', reqId: c.reqId, ok: true }),
    ...o,
  });
  await s.start();
  t.after(() => { s.close(); rm(dir); });
  return { s, file, lines, seen, dir };
}

/* ------------------------------------------------------------ host file */

test('host file: per app id names, written readable, removed only by its own host', () => {
  const env = { CLAUDE_CONFIG_DIR: path.join('C:', 'cfg') };
  assert.equal(hostFile(DEFAULT_APP_ID, env), path.join('C:', 'cfg', 'latch', 'apaki-host.json'));
  assert.equal(hostFile('apaki dev/host', env), path.join('C:', 'cfg', 'latch', 'apaki-host.apaki_dev_host.json'));
  assert.equal(hostFile('x', { ...env, APAKI_HOST_FILE: 'D:\\h.json' }), 'D:\\h.json');
  const dir = tmp();
  try {
    const file = path.join(dir, 'h.json');
    writeHostInfo(file, { v: 1, pid: 999999, port: 1234, token: 'abc' });
    assert.equal(readHostInfo(file).port, 1234);
    assert.equal(removeHostInfo(file, 4242), false, 'another pid never removes it');
    assert.ok(fs.existsSync(file));
    assert.equal(removeHostInfo(file, 999999), true);
    assert.equal(readHostInfo(file), null);
    fs.writeFileSync(file, '{"port":"x"}');
    assert.equal(readHostInfo(file), null, 'a malformed file is no host');
    assert.match(engineStamp(ENGINE), /^\d+-\d+$/);
    assert.equal(engineStamp(path.join(dir, 'missing.js')), '');
  } finally { rm(dir); }
});

/* ------------------------------------------------------------ handshake */

test('handshake: a window authenticates both ways and gets the lines; nothing before auth is processed', async (t) => {
  const { s, file, lines, seen } = await server(t);
  const info = readHostInfo(file);
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, s.port);
  assert.match(info.token, /^[0-9a-f]{64}$/);
  const w = await connectHost({ file, role: 'window' });
  assert.equal(w.ok.pid, process.pid);
  assert.equal(w.ok.root, 'C:\\x');
  assert.equal(w.ok.stamp, '1-2');
  assert.equal(seen.connect, 1);
  w.send({ op: 'sessions', reqId: 'r1' });
  await until(() => lines.length === 1);
  assert.deepEqual(JSON.parse(lines[0]), { op: 'sessions', reqId: 'r1' });
  s.send({ ev: 'ready', pid: 1 });
  assert.equal((await w.next((m) => m.ev === 'ready')).pid, 1);
  // A big line after auth goes through (a message with images, a screenshot).
  const big = 'x'.repeat(3 * 1024 * 1024);
  w.send({ op: 'send', text: big });
  await until(() => lines.length === 2);
  assert.equal(JSON.parse(lines[1]).text.length, big.length);
  assert.ok(MAX_LINE_BYTES >= 64 * 1024 * 1024);
  w.close();
  await until(() => seen.gone === 1);
  assert.equal(s.window, null);
});

test('handshake: a wrong token, garbage, an HTTP request or a long line before auth are closed with nothing done', async (t) => {
  const { file, lines, seen } = await server(t);
  const info = readHostInfo(file);
  await assert.rejects(connectHost({ file, role: 'window', info: { ...info, token: 'f'.repeat(64) } }), (e) => e.code === 'NO_HOST' || e.code === 'AUTH');
  for (const payload of ['GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n', '{"t":"auth","v":1,"role":"window","nonce":"00","mac":"00"}\n', `${'a'.repeat(5000)}\n`]) {
    const got = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: info.port });
      let data = '';
      sock.on('data', (d) => { data += d; });
      sock.on('error', () => {});
      sock.on('connect', () => sock.write(payload));
      sock.on('close', () => resolve(data));
    });
    // Only the host's greeting (a nonce, nothing secret) ever comes back.
    const first = JSON.parse(got.split('\n')[0]);
    assert.equal(first.t, 'apaki-host');
    assert.equal(got.trim().split('\n').length, 1);
  }
  assert.equal(lines.length, 0);
  assert.equal(seen.connect, 0);
});

test('handshake: the client refuses a host that cannot prove the token (someone else on a dead host\'s port)', async (t) => {
  const fake = net.createServer((sock) => {
    sock.write(`${JSON.stringify({ t: 'apaki-host', v: 1, app: 'apaki-dev-host-test', nonce: 'ab'.repeat(32) })}\n`);
    sock.on('data', () => sock.write(`${JSON.stringify({ t: 'ok', v: 1, mac: 'cd'.repeat(32) })}\n`));
    sock.on('error', () => {});
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  await assert.rejects(connectHost({ info: { port: fake.address().port, token: 'e'.repeat(64), pid: 1 }, role: 'window' }), (e) => e.code === 'AUTH');
  // The macs bind the role and both nonces.
  const a = clientMac('k', { app: 'a', serverNonce: 's', clientNonce: 'c', role: 'window' });
  assert.notEqual(a, clientMac('k', { app: 'a', serverNonce: 's', clientNonce: 'c', role: 'control' }));
  assert.notEqual(serverMac('k', { app: 'a', serverNonce: 's', clientNonce: 'c' }), serverMac('k', { app: 'a', serverNonce: 'c', clientNonce: 's' }));
  assert.ok(macEqual(a, a));
  assert.ok(!macEqual(a, a.slice(0, -2)) && !macEqual('zz', 'zz') && !macEqual(null, a));
});

test('one window at a time: a newer window replaces the older; control connections only get host ops', async (t) => {
  const { s, file, lines, seen } = await server(t);
  const w1 = await connectHost({ file, role: 'window' });
  const w2 = await connectHost({ file, role: 'window' });
  await w1.closed;
  assert.equal(seen.connect, 2);
  assert.equal(seen.gone, 1);
  w2.send({ op: 'x' });
  await until(() => lines.length === 1);
  const c = await connectHost({ file, role: 'control' });
  assert.equal(seen.connect, 2, 'a control connection is not a window');
  c.send({ op: 'send', paneId: 'p1', text: 'hi' });
  assert.equal((await c.next((m) => m.ev === 'error')).message, 'a control connection cannot send send');
  c.send({ op: 'hostStatus', reqId: 'q' });
  assert.equal((await c.next((m) => m.ev === 'host')).reqId, 'q');
  s.send({ ev: 'sdk' });
  await w2.next((m) => m.ev === 'sdk');
  assert.ok(!c.events.some((m) => m.ev === 'sdk'), 'events go to the window only');
  assert.equal(lines.length, 1);
  c.close();
  w2.close();
});

/* ------------------------------------------------------------ the shell (browser) comes and goes */

test('shell channel: with the window away, requests fail at once with NO_WINDOW and work again after the next hello', async () => {
  const sent = [];
  const sh = createShell({ emit: (e) => sent.push(e) });
  sh.expect(['browser']);
  assert.equal(sh.has('browser'), false);
  assert.equal(sh.expects('browser'), true);
  await assert.rejects(sh.request('browser.state'), (e) => e.code === 'NO_WINDOW' && /window is closed/.test(e.message));
  sh.hello({ version: 1, features: ['browser'] });
  const p = sh.request('browser.state', {}, { timeout: 2000 });
  sh.reply({ id: sent.at(-1).id, ok: true, result: { url: 'x' } });
  assert.deepEqual(await p, { url: 'x' });
  const inFlight = sh.request('browser.state', {}, { timeout: 2000 });
  sh.goodbye('The Apaki window closed.');
  await assert.rejects(inFlight, (e) => e.code === 'CLOSED');
  assert.equal(sh.has('browser'), false);
  assert.equal(sh.expects('browser'), true, 'a pane started now still gets the browser tools');
  await assert.rejects(sh.request('browser.state'), (e) => e.code === 'NO_WINDOW');
  // An engine that never had a shell (tests, latch) is unchanged.
  await assert.rejects(createShell({ emit: () => {} }).request('browser.state'), (e) => e.code === 'NO_SHELL');
});

/* ------------------------------------------------------------ what a pane is doing */

test('pane activity: turns, auto turns, background tasks (level, per process) and the task replay', () => {
  const q1 = {};
  const runner = { running: true, turnRunning: false, q: q1 };
  const p = { id: 'p1', runner };
  noteSdkMessage(p, { type: 'system', subtype: 'init' }, { q: q1, now: 1 });
  assert.equal(paneTurnBusy(p), false);
  noteSdkMessage(p, { type: 'stream_event', event: { type: 'message_start' } }, { q: q1, now: 2 });
  assert.equal(paneTurnBusy(p), true, 'a turn Claude started by itself counts');
  // A background subagent's messages are not the main turn.
  noteSdkMessage(p, { type: 'result' }, { q: q1, now: 3 });
  noteSdkMessage(p, { type: 'assistant', parent_tool_use_id: 'toolu_9' }, { q: q1, now: 4 });
  assert.equal(paneTurnBusy(p), false);
  assert.equal(p.lastActiveAt, 4);
  noteSdkMessage(p, { type: 'system', subtype: 'task_started', task_id: 't1', description: 'dev server' }, { q: q1 });
  noteSdkMessage(p, { type: 'system', subtype: 'task_progress', task_id: 't1', summary: 'running' }, { q: q1 });
  noteSdkMessage(p, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }, { task_id: 'w', ambient: true }] }, { q: q1 });
  assert.equal(p.bgTasks.size, 1, 'ambient watchers are not work');
  assert.equal(paneWorking(p), true);
  assert.deepEqual(taskReplay(p).map((m) => m.subtype), ['task_started', 'task_progress', 'background_tasks_changed']);
  noteSdkMessage(p, { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' }, { q: q1 });
  noteSdkMessage(p, { type: 'system', subtype: 'background_tasks_changed', tasks: [] }, { q: q1 });
  assert.equal(paneWorking(p), false);
  assert.deepEqual(taskReplay(p), []);
  // A new Claude Code process starts with no background level.
  noteSdkMessage(p, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't2' }] }, { q: q1 });
  noteSdkMessage(p, { type: 'system', subtype: 'init' }, { q: {} });
  assert.equal(p.bgTasks.size, 0);
  // A process that is gone is not working, whatever its last messages said.
  noteSdkMessage(p, { type: 'stream_event' }, { q: p.trackedQ });
  runner.running = false;
  assert.equal(paneWorking(p), false);
  // A message sent and not answered yet is busy even before the process says anything.
  assert.equal(paneTurnBusy({ busy: true, runner: null }), true);
});

test('restore: open warm:false becomes attach only for a pane the host still runs (same or created session)', () => {
  const p = { id: 'p1', runner: {}, sessionId: 's1' };
  assert.deepEqual(restoreAsAttach({ op: 'open', reqId: 'r', paneId: 'p1', sessionId: 's1', cwd: 'C:\\w', warm: false }, p), { op: 'attach', reqId: 'r', paneId: 'p1', sessionId: 's1', cwd: 'C:\\w' });
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p1', sessionId: 's1', warm: true }, p), null, 'a real open (rail click) runs as sent');
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p1', sessionId: 's1', warm: false, force: true }, p), null, 'a takeover runs as sent');
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p1', sessionId: 's2', warm: false }, p), null, 'another session opens fresh');
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p1', sessionId: 's1', warm: false }, { ...p, runner: null }), null, 'no process: open as before');
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p1', sessionId: null, warm: false }, p), null);
  // The window closed before it saved the session its new conversation got.
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p1', sessionId: null, warm: false }, { ...p, createdHere: true }).sessionId, 's1');
  assert.equal(restoreAsAttach({ op: 'send', paneId: 'p1' }, p), null);
  assert.equal(restoreAsAttach({ op: 'open', paneId: 'p9', warm: false }, undefined), null);
});

test('workspace: a turn that ended with no window clears busy, fills a new session id, and wins over localStorage', () => {
  const ws = { v: 1, savedAt: 5000, active: 0, tabs: [
    { focused: 'p1', root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      { type: 'leaf', pane: 'p1', s: null, busy: true, draft: 'keep me' },
      { type: 'leaf', pane: 'v1', view: { id: 'a1' } },
    ] } },
    { focused: 'p2', root: { type: 'leaf', pane: 'p2', s: 'other', busy: true } },
  ] };
  const next = patchWorkspaceLeaves(ws, 'p1', { busy: false, s: 's-new' });
  assert.equal(next.savedAt, 5001);
  const leaf = next.tabs[0].root.children[0];
  assert.deepEqual(leaf, { type: 'leaf', pane: 'p1', s: 's-new', busy: false, draft: 'keep me' });
  assert.equal(ws.tabs[0].root.children[0].busy, true, 'the input is not changed');
  assert.equal(next.tabs[1].root.busy, true, 'other panes untouched');
  assert.equal(patchWorkspaceLeaves(ws, 'p2', { s: 'mine' }).tabs[1].root.s, 'other', 'never replaces another session');
  assert.equal(patchWorkspaceLeaves(ws, 'v1', { busy: false }), null, 'viewers are not conversations');
  assert.equal(patchWorkspaceLeaves(ws, 'nope', { busy: false }), null);
  assert.equal(patchWorkspaceLeaves(null, 'p1', {}), null);
});

/* ------------------------------------------------------------ idle rules */

test('idle rules: processes close only with no window, nothing running and no question; the host exits when nothing is left', () => {
  const base = { now: 100000, windowGoneAt: 0, idleCloseMs: 1000 };
  const pane = (o) => ({ id: 'p1', open: true, working: false, asks: 0, lastActiveAt: 0, ...o });
  // A window is connected: nothing closes, nothing exits.
  let r = planIdle({ ...base, window: true, panes: [pane()] });
  assert.deepEqual(r.close, []);
  assert.equal(r.exitReady, false);
  // No window, idle long enough: closes, then the host may exit.
  r = planIdle({ ...base, panes: [pane()] });
  assert.deepEqual(r.close, ['p1']);
  assert.equal(r.exitReady, true);
  // The idle time counts from when the window left, not only from the last activity.
  assert.deepEqual(planIdle({ ...base, windowGoneAt: base.now - 500, panes: [pane()] }).close, []);
  // A turn or background task running, or a question waiting: kept, and the host stays.
  for (const p of [pane({ working: true }), pane({ asks: 1 })]) {
    r = planIdle({ ...base, panes: [p] });
    assert.deepEqual(r.close, []);
    assert.equal(r.exitReady, false);
  }
  // Phone panes follow remote.js; with phone access on the host stays up.
  r = planIdle({ ...base, remoteOn: true, panes: [pane({ id: 'phone:d:p1', phone: true })] });
  assert.deepEqual(r.close, []);
  assert.equal(r.exitReady, false);
  assert.ok(r.waiting.some((w) => w.why === 'phone access is on'));
  // A quit closes idle ones at once (phones too) and ignores phone access, but waits for work.
  r = planIdle({ ...base, quit: true, remoteOn: true, windowGoneAt: base.now, panes: [pane({ lastActiveAt: base.now }), pane({ id: 'phone:d:p1', phone: true })] });
  assert.deepEqual(r.close, ['p1', 'phone:d:p1']);
  assert.equal(r.exitReady, true);
  assert.equal(planIdle({ ...base, quit: true, panes: [pane({ working: true })] }).exitReady, false);
  assert.equal(planIdle({ ...base, quit: true, window: true, panes: [] }).exitReady, false, 'never from under an open window');
});

test('lifecycle: grace before exit, a window resets it, quit and quit now', () => {
  let t = 0;
  const closed = [];
  const exits = [];
  const panes = [{ id: 'p1', open: true, working: false, asks: 0, lastActiveAt: 0 }];
  const lc = createLifecycle({ now: () => t, tickMs: 0, idleCloseMs: 1000, exitGraceMs: 500, quitGraceMs: 100,
    view: () => ({ remoteOn: false, panes }), closeIdle: (id) => { closed.push(id); panes[0].open = false; }, exit: (why) => exits.push(why) });
  lc.windowConnected();
  t = 5000; lc.tick();
  assert.deepEqual(closed, []);
  lc.windowGone();
  t = 5500; lc.tick();
  assert.deepEqual(closed, []);
  t = 6100; lc.tick();
  assert.deepEqual(closed, ['p1']);
  t = 6200; lc.tick();
  assert.deepEqual(exits, []);
  lc.windowConnected(); t = 7000; lc.tick(); lc.windowGone();
  t = 7100; lc.tick(); t = 7500; lc.tick();
  assert.deepEqual(exits, [], 'the window reset the grace');
  t = 7700; lc.tick();
  assert.deepEqual(exits, ['idle']);
  assert.equal(lc.exiting, true);

  const exits2 = [];
  const busy = [{ id: 'p1', open: true, working: true, asks: 0, lastActiveAt: 0 }];
  const lc2 = createLifecycle({ now: () => t, tickMs: 0, idleCloseMs: 1000, exitGraceMs: 500, quitGraceMs: 100,
    view: () => ({ remoteOn: true, panes: busy }), closeIdle: () => {}, exit: (why) => exits2.push(why) });
  lc2.requestQuit({ by: 'test' });
  t += 1000; lc2.tick();
  assert.deepEqual(exits2, [], 'waits for the running turn');
  busy[0].working = false;
  t += 10; lc2.tick(); t += 200; lc2.tick();
  assert.deepEqual(exits2, ['quit']);
  const exits3 = [];
  const lc3 = createLifecycle({ now: () => t, tickMs: 0, view: () => ({ panes: busy }), closeIdle: () => {}, exit: (why) => exits3.push(why) });
  lc3.windowConnected();
  lc3.requestQuit({ now: true });
  assert.deepEqual(exits3, ['quit-now']);
});

test('update while open: a newer build on disk moves the host once idle and quiet, even with a window connected', () => {
  let t = 100000;
  let changed = false;
  const exits = [];
  const logs = [];
  const panes = [{ id: 'p1', open: true, working: true, asks: 0, lastActiveAt: t }];
  const lc = createLifecycle({ now: () => t, tickMs: 0, quitGraceMs: 100, swapQuietMs: 60000, codeCheckMs: 30000,
    view: () => ({ remoteOn: true, panes }), closeIdle: () => {}, exit: (why) => exits.push(why), log: (l) => logs.push(l), codeChanged: () => changed });
  lc.windowConnected();
  t += 30000; lc.tick();
  assert.equal(lc.status().swap, false, 'same build: nothing to do');
  changed = true;
  t += 10000; lc.tick();
  assert.equal(lc.status().swap, false, 'the files are looked at every codeCheckMs only');
  t += 20000; lc.tick();
  assert.equal(lc.status().swap, true);
  assert.match(logs.join('\n'), /newer build/);
  assert.deepEqual(lc.status().plan.waiting.map((w) => w.why), ['working', 'a pane was active in the last minute']);
  panes[0].working = false; panes[0].lastActiveAt = t;
  t += 59000; lc.tick(); t += 200; lc.tick();
  assert.deepEqual(exits, [], 'quiet for less than a minute: stays');
  t += 1000; lc.tick(); t += 200; lc.tick();
  assert.deepEqual(exits, ['update']);

  // A question waiting keeps the old build, however long it waits.
  const exits2 = [];
  const asking = [{ id: 'p1', open: true, working: false, asks: 1, lastActiveAt: 0 }];
  const lc2 = createLifecycle({ now: () => t, tickMs: 0, quitGraceMs: 100, codeCheckMs: 0,
    view: () => ({ panes: asking }), closeIdle: () => {}, exit: (why) => exits2.push(why), codeChanged: () => true });
  lc2.windowConnected();
  t += 3600000; lc2.tick(); t += 200; lc2.tick();
  assert.deepEqual(exits2, []);
  asking[0].asks = 0;
  t += 10; lc2.tick(); t += 200; lc2.tick();
  assert.deepEqual(exits2, ['update']);
});

test('codeStamp: changes when a file in a watched folder changes, is added or goes; dotfiles and .tmp files do not count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-codestamp-'));
  try {
    const sub = path.join(dir, 'engine');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.js'), 'one');
    const single = path.join(dir, 'build.mjs');
    fs.writeFileSync(single, 'x');
    const s0 = codeStamp([sub, single]);
    assert.equal(codeStamp([sub, single]), s0, 'stable');
    fs.writeFileSync(path.join(sub, '.x.swp'), 'z');
    fs.writeFileSync(path.join(sub, 'a.js.123.tmp'), 'z');
    assert.equal(codeStamp([sub, single]), s0, 'dotfiles and temp files are ignored');
    fs.writeFileSync(path.join(sub, 'a.js'), 'one plus');
    const s1 = codeStamp([sub, single]);
    assert.notEqual(s1, s0, 'a changed size');
    fs.writeFileSync(path.join(sub, 'b.css'), 'b');
    const s2 = codeStamp([sub, single]);
    assert.notEqual(s2, s1, 'a new file');
    fs.rmSync(single);
    assert.notEqual(codeStamp([sub, single]), s2, 'a file gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ end to end: engine.js --host */

// A stand-in for @anthropic-ai/claude-agent-sdk: each message is echoed;
// "wait:<ms>" makes the turn take that long, "ask:" asks a question through
// the PreToolUse hook first, "bg:<ms>" leaves a background task running.
// Everything else comes from the real SDK (export *; the local exports below
// take precedence), so a new import in the engine does not break the fake.
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
      if (!inited) { inited = true; out.push({ type: 'system', subtype: 'init', session_id: sid }); }
      const text = textOf(m.message && m.message.content);
      const id = 'msg_' + (++n);
      sessions.get(sid).push({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: text } });
      out.push({ type: 'stream_event', event: { type: 'message_start', message: { id } }, session_id: sid });
      const bg = /bg:(\d+)/.exec(text);
      if (bg) {
        out.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_bash', description: 'sleep' }], session_id: sid });
        out.push({ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash', description: 'sleep', is_backgrounded: true, session_id: sid });
        setTimeout(() => {
          out.push({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '', summary: 'done', session_id: sid });
          out.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: sid });
        }, Number(bg[1]));
      }
      if (/ask:/.test(text)) {
        for (const h of (options.hooks && options.hooks.PreToolUse) || []) {
          if (!new RegExp('^(' + h.matcher + ')$').test('AskUserQuestion')) continue;
          for (const fn of h.hooks) await fn({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which one?' }] } }, 'toolu_1', {});
        }
      }
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

/** Starts engine.js --host in a temp world; resolves once its host file names it. */
async function startHost(t, env = {}) {
  const dir = tmp();
  const claude = path.join(dir, 'claude');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-agent-sdk.mjs'), FAKE_SDK);
  fs.writeFileSync(path.join(fake, 'hooks.mjs'), HOOKS);
  fs.writeFileSync(path.join(fake, 'loader.mjs'), LOADER);
  const file = path.join(claude, 'latch', 'apaki-host.apaki-dev-host-test.json');
  const childEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: 'apaki-dev-host-test', APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
    ...env,
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(fake, 'loader.mjs')).href, ENGINE, '--host'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    rm(dir);
  });
  await until(() => readHostInfo(file)?.pid === child.pid || child.exitCode !== null, 30000);
  assert.equal(child.exitCode, null, `the host did not start:\n${log}`);
  return { child, file, dir, claude, exited, log: () => log };
}

const windowOf = async (h) => {
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });
  return w;
};

test('end to end: the window closes mid-turn, the turn finishes, the window comes back and takes the pane over', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const ws = (s, busy, savedAt) => ({ v: 1, savedAt, active: 0, tabs: [{ focused: 'p1', root: { type: 'leaf', pane: 'p1', s, busy } }] });

  const w1 = await windowOf(h);
  assert.equal(w1.ok.root.toLowerCase(), ROOT.toLowerCase());
  assert.equal(w1.ok.stamp, engineStamp(ENGINE));
  w1.send({ op: 'saveState', state: ws(null, false, 1000) });
  w1.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: null, cwd: h.dir, warm: true });
  const opened = await w1.next((m) => m.ev === 'opened' && m.reqId === 'o1');
  assert.equal(opened.attached, undefined);
  w1.send({ op: 'send', reqId: 's1', paneId: 'p1', text: 'wait:1500 hello' });
  const sid = (await w1.next((m) => m.ev === 'session_id')).sessionId;
  // What the window saves while Claude works, then the window closes.
  w1.send({ op: 'saveState', state: ws(sid, true, 2000) });
  await sleep(100);
  w1.close();
  await w1.closed;

  // Nobody is connected; the turn runs to its end anyway.
  const ctl = await connectHost({ file: h.file, role: 'control' });
  ctl.send({ op: 'hostStatus', reqId: 'st' });
  const st = await ctl.next((m) => m.ev === 'host');
  assert.equal(st.window, false);
  assert.equal(st.panes.find((p) => p.id === 'p1').busy, true, 'still running with the window closed');
  ctl.close();
  await sleep(2000);

  const w2 = await windowOf(h);
  const ready = w2.events.find((m) => m.ev === 'ready');
  assert.equal(ready.host.panes, 1);
  assert.equal(ready.host.running, 1, 'its Claude Code process is still up');
  // The saved workspace knows the turn ended, so the window will not say it was cut off.
  w2.send({ op: 'loadState', reqId: 'ls' });
  const saved = (await w2.next((m) => m.ev === 'state')).state;
  assert.equal(saved.tabs[0].root.busy, false);
  assert.equal(saved.tabs[0].root.s, sid);
  assert.ok(saved.savedAt > 2000);
  // The window restores its pane (open, warm:false): taken over, not restarted.
  w2.send({ op: 'open', reqId: 'o2', paneId: 'p1', sessionId: sid, cwd: h.dir, warm: false });
  const back = await w2.next((m) => m.ev === 'opened' && m.reqId === 'o2');
  assert.equal(back.attached, true);
  assert.equal(back.running, true);
  assert.equal(back.busy, false);
  const hist = await w2.next((m) => m.ev === 'history');
  assert.ok(hist.messages.some((m) => m.message.role === 'assistant' && JSON.stringify(m.message.content).includes('echo: wait:1500 hello')), 'the result is there');

  // Closed again mid-turn and back while it still runs: busy, and the result arrives here.
  w2.send({ op: 'send', reqId: 's2', paneId: 'p1', text: 'wait:2000 again' });
  await w2.next((m) => m.ev === 'sdk' && m.msg?.type === 'stream_event');
  w2.close();
  await w2.closed;
  await sleep(300);
  const w3 = await windowOf(h);
  w3.send({ op: 'open', reqId: 'o3', paneId: 'p1', sessionId: sid, cwd: h.dir, warm: false });
  const mid = await w3.next((m) => m.ev === 'opened' && m.reqId === 'o3');
  assert.equal(mid.attached, true);
  assert.equal(mid.busy, true);
  const res = await w3.next((m) => m.ev === 'result' && m.reqId === 's2', 10000);
  assert.equal(res.result, 'echo: wait:2000 again');

  // A question asked while no window is connected waits, and is asked again on return.
  w3.close();
  await w3.closed;
  const lone = await connectHost({ file: h.file, role: 'control' });
  lone.close();
  const w4pre = await windowOf(h);
  w4pre.send({ op: 'send', reqId: 's3', paneId: 'p1', text: 'ask: pick one' });
  await w4pre.next((m) => m.ev === 'ask');
  w4pre.close();
  await w4pre.closed;
  await sleep(300);
  const w4 = await windowOf(h);
  w4.send({ op: 'open', reqId: 'o4', paneId: 'p1', sessionId: sid, cwd: h.dir, warm: false });
  const again = await w4.next((m) => m.ev === 'ask');
  assert.equal(again.paneId, 'p1');
  assert.equal(again.toolName, 'AskUserQuestion');
  w4.send({ op: 'answer', askId: again.askId, result: { behavior: 'allow', updatedInput: { answers: { 'Which one?': 'A' } } } });
  assert.equal((await w4.next((m) => m.ev === 'result' && m.reqId === 's3', 10000)).result, 'echo: ask: pick one');

  // A fresh open (a rail click) still restarts as before; the host only rewrites restores.
  w4.send({ op: 'open', reqId: 'o5', paneId: 'p1', sessionId: sid, cwd: h.dir, warm: true });
  assert.equal((await w4.next((m) => m.ev === 'opened' && m.reqId === 'o5')).attached, undefined);
  w4.close();
});

test('end to end: idle processes close with no window, background tasks keep them, then the host exits on its own', { timeout: 90000 }, async (t) => {
  const h = await startHost(t, { APAKI_HOST_IDLE_MS: '700', APAKI_HOST_EXIT_MS: '400' });
  const w = await windowOf(h);
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: null, cwd: h.dir, warm: true });
  await w.next((m) => m.ev === 'opened');
  w.send({ op: 'send', reqId: 's1', paneId: 'p1', text: 'bg:2500 start a server' });
  await w.next((m) => m.ev === 'result' && m.reqId === 's1');
  const sid = w.events.find((m) => m.ev === 'session_id').sessionId;
  const lock = path.join(h.claude, 'latch', 'locks', `${sid}.json`);
  assert.ok(fs.existsSync(lock), 'the session is locked while open');
  w.close();
  await w.closed;
  // The turn is over, but its background task still runs: nothing closes.
  await sleep(1300);
  assert.equal(h.child.exitCode, null);
  assert.ok(fs.existsSync(lock));
  const c = await connectHost({ file: h.file, role: 'control' });
  c.send({ op: 'hostStatus', reqId: 's' });
  const st = await c.next((m) => m.ev === 'host');
  c.close();
  assert.equal(st.panes[0].tasks, 1);
  assert.equal(st.panes[0].working, true);
  // The task ends; after the idle time the process closes (lock freed), then the host exits.
  const code = await Promise.race([h.exited, sleep(15000).then(() => 'still running')]);
  assert.equal(code, 0, h.log());
  assert.equal(fs.existsSync(lock), false, 'its session lock was freed');
  assert.equal(readHostInfo(h.file), null, 'the host file is gone');
  assert.match(h.log(), /closing the idle Claude Code process of pane p1/);
});

test('end to end: host-ctl quit --when-idle waits for the window to close, then the host exits; a new host starts clean', { timeout: 90000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: null, cwd: h.dir, warm: true });
  await w.next((m) => m.ev === 'opened');
  const ctl = (args) => new Promise((resolve) => execFile(process.execPath, [HOST_CTL, ...args, '--file', h.file], { windowsHide: true }, (err, stdout) => resolve({ code: err ? err.code : 0, out: JSON.parse(String(stdout).trim().split('\n').pop() || '{}') })));
  const status = await ctl(['status']);
  assert.equal(status.code, 0);
  assert.equal(status.out.window, true);
  assert.ok(!JSON.stringify(status.out).includes(readHostInfo(h.file).token), 'never prints the token');
  // With a window open it does not leave.
  const early = await ctl(['quit', '--when-idle', '--wait', '1']);
  assert.equal(early.code, 2);
  assert.equal(early.out.running, true);
  w.close();
  await w.closed;
  const done = await ctl(['quit', '--when-idle', '--wait', '20']);
  assert.equal(done.code, 0, JSON.stringify(done.out));
  assert.equal(done.out.running, false);
  assert.equal(await h.exited, 0);
  assert.equal((await ctl(['status'])).out.running, false);
  assert.equal(pidAlive(h.child.pid), false);
});
