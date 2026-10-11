/**
 * The shared view (2026-10-11; Arthur: the phone must show the desktop's tabs and the panes in each, swiping
 * between panes, WITHOUT taking a pane over). A phone pane can FOLLOW a desktop conversation pane:
 * apaki/remote/PROTOCOL.md "Following a desktop pane", apaki/SECURITY.md "Status after the shared view".
 *
 * Three layers, each with its own claim:
 *   1. policy (remote-policy.js): follow and unfollow are validated (ids, the desktop pane must be a conversation,
 *      the limit, one phone pane per desktop pane); a follower's ops are retargeted at the desktop pane; a restricted
 *      capability is READ ONLY (send, steer, interrupt and answering are refused), model, effort and mode are the
 *      desktop's; followerView and routeEvent say what a follower sees.
 *   2. the bridge (remote.js) against an in-memory relay and a stand-in engine: the registry, the mirrored events under
 *      the phone's own ids, no queue and no request id of the window, read only enforced on the live capability, the
 *      "followers" event for the window's header line, followers that end with the phone's connection, held account
 *      connections that get nothing. The stand-in only emits what engine.js followState emits.
 *   3. the real engine.js --host with a fake Agent SDK (no Claude Code process, nothing billed; same approach as
 *      test/apaki-queue.test.js) and a real WebSocket relay on loopback: a phone pairs through the real bridge, follows a
 *      desktop pane, sees its state, history and live events, sends, steers, interrupts and answers a question (the
 *      first answer wins and the other side's sheet goes away), is read only when set to No shell or Chat only, and the
 *      engine never takes a pane over or starts a second Claude Code for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket as WsClient, WebSocketServer } from 'ws';

import {
  PhoneSession, createDeviceIdentity, decodePcFrame, deviceIdFor, encodePcFrame, parsePairingUrl, roomUrl, b64urlDecode, b64urlEncode, randomBytes,
} from '../apaki/remote/protocol.js';
import { Inbox, Outbox } from '../apaki/remote/wire.js';
import {
  FOLLOW_EVENTS, MAX_PHONE_PANES, PHONE_OPS, checkPhoneCommand, followerView, parsePhoneId, phonePaneId, phoneView, routeEvent,
} from '../apaki/engine/remote-policy.js';
import { RemoteBridge } from '../apaki/engine/remote.js';
import { connectHost, readHostInfo } from '../apaki/engine/host.js';

const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!(await pred())) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-follow-test-'));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };

async function withDir(fn) {
  const dir = tmp();
  const before = process.env.APAKI_REMOTE_PROTECT;
  process.env.APAKI_REMOTE_PROTECT = 'file';
  try { await fn(dir); } finally {
    if (before === undefined) delete process.env.APAKI_REMOTE_PROTECT; else process.env.APAKI_REMOTE_PROTECT = before;
    rm(dir);
  }
}

/* ================================================================ 1. policy */

/** A world for checkPhoneCommand: the desktop's panes, this phone's own panes, who follows what, who asked what. */
function world(over = {}) {
  const w = {
    desk: new Map([['pA', 'conversation'], ['pB', 'conversation'], ['v1', 'viewer'], ['b1', 'browser'], ['t1', 'task']]),
    own: new Set(),
    fol: new Map(), // phone pane (prefixed) -> desktop pane
    asks: new Map(),
    sessions: ['sess-aaaa1111'],
  };
  w.ctx = {
    deviceId: DEV,
    paneExists: (id) => w.own.has(id),
    paneCount: () => w.own.size,
    askPane: (id) => w.asks.get(id) ?? null,
    phoneSessions: () => w.sessions,
    followOf: (id) => w.fol.get(id) ?? null,
    followLocal: (dev, desk) => { for (const [pane, d] of w.fol) if (d === desk && parsePhoneId(pane)?.deviceId === dev) return pane; return null; },
    followCount: () => w.fol.size,
    followsDesktop: (dev, desk) => [...w.fol.values()].includes(desk),
    desktopPane: (id) => w.desk.get(id) ?? null,
    hasOp: (op) => op === 'artifactGet',
    ...over,
  };
  w.follow = (local, desk) => w.fol.set(phonePaneId(DEV, local), desk);
  return w;
}

test('policy: follow and unfollow are phone ops; ids are checked; only a desktop conversation can be followed, within the limit', () => {
  assert.ok(PHONE_OPS.includes('follow') && PHONE_OPS.includes('unfollow'));
  const w = world();
  const ok = checkPhoneCommand({ op: 'follow', reqId: 'r1', paneId: 'f1', desktopPaneId: 'pA', extra: 'dropped' }, w.ctx);
  assert.deepEqual(ok, { ok: true, cmd: { op: 'follow', reqId: `phone:${DEV}:r1`, paneId: `phone:${DEV}:f1`, desktopPaneId: 'pA' } });

  const refused = (cmd, pattern, ctx = w.ctx) => {
    const r = checkPhoneCommand(cmd, ctx);
    assert.equal(r.ok, false, JSON.stringify(cmd));
    assert.match(r.error, pattern, JSON.stringify(cmd));
    return r;
  };
  refused({ op: 'follow', paneId: '../x', desktopPaneId: 'pA' }, /Bad pane id/);
  refused({ op: 'follow', paneId: 'f1' }, /Bad desktop pane id/);
  refused({ op: 'follow', paneId: 'f1', desktopPaneId: `phone:${DEV}:p1` }, /Bad desktop pane id/);
  refused({ op: 'follow', paneId: 'f1', desktopPaneId: 'p A' }, /Bad desktop pane id/);
  // A viewer, a browser, a task pane and a pane that is not there are not conversations.
  for (const id of ['v1', 'b1', 't1']) refused({ op: 'follow', paneId: 'f1', desktopPaneId: id }, /Only a conversation can be followed/);
  refused({ op: 'follow', paneId: 'f1', desktopPaneId: 'nothere' }, /not open on the desktop/);
  // An engine from before the shared view cannot follow anything.
  refused({ op: 'follow', paneId: 'f1', desktopPaneId: 'pA' }, /not available on this PC/, { ...w.ctx, desktopPane: undefined });
  // A pane that holds a conversation of this phone is never turned into a follower.
  w.own.add(phonePaneId(DEV, 'p1'));
  refused({ op: 'follow', paneId: 'p1', desktopPaneId: 'pA' }, /already holds a conversation/);
  w.own.clear();

  // At most MAX_PHONE_PANES desktop panes at once; moving a pane that already follows is not a new one.
  for (let i = 0; i < MAX_PHONE_PANES; i++) { w.desk.set(`d${i}`, 'conversation'); w.follow(`f${i}`, `d${i}`); }
  refused({ op: 'follow', paneId: 'fx', desktopPaneId: 'pA' }, new RegExp(`${MAX_PHONE_PANES} desktop panes`));
  assert.equal(checkPhoneCommand({ op: 'follow', paneId: 'f0', desktopPaneId: 'pA' }, w.ctx).ok, true, 'f0 follows another desktop pane: the same count');
  // One phone pane per desktop pane, so an answer to a request can name its pane.
  refused({ op: 'follow', paneId: 'f1', desktopPaneId: 'd0' }, /already follows that desktop pane in another pane/);
  assert.equal(checkPhoneCommand({ op: 'follow', paneId: 'f0', desktopPaneId: 'd0' }, w.ctx).ok, true, 'the same pane again is fine (a phone that asks again)');

  // unfollow: idempotent for a pane that follows nothing, and never closes a conversation of the phone's own.
  const u = checkPhoneCommand({ op: 'unfollow', reqId: 'u1', paneId: 'f0' }, w.ctx);
  assert.deepEqual(u, { ok: true, cmd: { op: 'unfollow', reqId: `phone:${DEV}:u1`, paneId: `phone:${DEV}:f0` } });
  assert.equal(checkPhoneCommand({ op: 'unfollow', paneId: 'nobody' }, w.ctx).ok, true);
  w.own.add(phonePaneId(DEV, 'p1'));
  refused({ op: 'unfollow', paneId: 'p1' }, /holds a conversation of this phone/);
});

test('policy: a follower\'s ops act on the desktop pane; full may drive it, a restricted phone only reads; the desktop owns model, effort and mode', () => {
  const w = world();
  w.follow('f1', 'pA');
  const mine = phonePaneId(DEV, 'f1');
  const run = (cmd, cap = 'full') => checkPhoneCommand(cmd, { ...w.ctx, cap });
  const tag = { paneId: mine, desktopPaneId: 'pA' };

  const send = run({ op: 'send', reqId: 'r1', paneId: 'f1', text: 'hi', images: [], queued: ['q1'] });
  assert.deepEqual(send, { ok: true, cmd: { op: 'send', paneId: 'pA', text: 'hi', images: [] }, follower: tag }, 'no request id (its result is the pane\'s own), no queued ids');
  const steer = run({ op: 'steer', reqId: 'r2', paneId: 'f1', qid: 'qa', text: 'also' });
  assert.deepEqual(steer.cmd, { op: 'steer', reqId: `phone:${DEV}:r2`, paneId: 'pA', qid: 'qa', text: 'also', images: [] }, 'steered answers the phone, so the request id stays');
  assert.deepEqual(run({ op: 'interrupt', reqId: 'r3', paneId: 'f1' }).cmd, { op: 'interrupt', reqId: `phone:${DEV}:r3`, paneId: 'pA' });
  assert.deepEqual(run({ op: 'contextUsage', reqId: 'r4', paneId: 'f1' }).cmd, { op: 'contextUsage', reqId: `phone:${DEV}:r4`, paneId: 'pA' });
  assert.deepEqual(run({ op: 'commands', reqId: 'r5', paneId: 'f1' }).cmd, { op: 'commands', reqId: `phone:${DEV}:r5`, paneId: 'pA' });
  const page = run({ op: 'historyBefore', reqId: 'r6', paneId: 'f1', before: '11111111-2222-3333-4444-555555555555', sessionId: 'sess-aaaa1111', limit: 50 });
  assert.deepEqual(page.cmd, { op: 'historyBefore', reqId: `phone:${DEV}:r6`, paneId: 'pA', sessionId: 'sess-aaaa1111', before: '11111111-2222-3333-4444-555555555555', limit: 50 });
  assert.equal(run({ op: 'historyBefore', paneId: 'f1', before: '11111111-2222-3333-4444-555555555555', sessionId: 'sess-other999' }).ok, false, 'only the session of a pane it follows');
  assert.equal(run({ op: 'historyBlock', paneId: 'f1', ref: '11111111-2222-3333-4444-555555555555:3' }).cmd.paneId, 'pA');
  // close and artifactGet stay on the phone's own pane id.
  assert.equal(run({ op: 'close', paneId: 'f1' }).cmd.paneId, mine);
  assert.equal(run({ op: 'artifactGet', paneId: 'f1', id: 'a1', sessionId: 'sess-aaaa1111' }, 'full').cmd.paneId, mine, 'artifactGet answers go to the phone pane');

  // open and attach would take the session over: refused while the pane follows.
  for (const op of ['open', 'attach']) assert.match(run({ op, paneId: 'f1', sessionId: 'sess-aaaa1111' }).error, /Unfollow it first/);
  // model, effort and mode belong to the desktop, whatever the capability (even full, for now: the error says so).
  for (const cap of ['full', 'noshell', 'chat']) {
    for (const cmd of [{ op: 'model', model: 'claude-haiku-5-5' }, { op: 'effort', effort: 'low' }, { op: 'mode', mode: 'plan' }]) {
      const r = run({ ...cmd, paneId: 'f1' }, cap);
      assert.equal(r.ok, false, `${cap} ${cmd.op}`);
      assert.match(r.error, /set on the PC/);
      assert.match(r.error, /not available yet/);
    }
  }

  // A restricted phone only reads: the refusal names the capability and why, and is flagged readOnly.
  for (const cap of ['noshell', 'chat']) {
    const label = cap === 'chat' ? 'Chat only' : 'No shell';
    for (const cmd of [{ op: 'send', text: 'hi' }, { op: 'steer', qid: 'qa', text: 'hi' }, { op: 'interrupt' }]) {
      const r = run({ ...cmd, paneId: 'f1' }, cap);
      assert.equal(r.ok, false, `${cap} ${cmd.op}`);
      assert.equal(r.readOnly, true);
      assert.match(r.error, new RegExp(`set to ${label} on the PC`));
      assert.match(r.error, /desktop's own permissions and tools/);
    }
    for (const cmd of [{ op: 'contextUsage' }, { op: 'commands' }, { op: 'historyBefore', before: '11111111-2222-3333-4444-555555555555' }, { op: 'historyBlock', ref: '11111111-2222-3333-4444-555555555555:3' }, { op: 'close' }]) {
      assert.equal(run({ ...cmd, paneId: 'f1' }, cap).ok, true, `${cap} ${cmd.op} only reads`);
    }
  }
  // An unknown capability is the narrowest, here too.
  assert.equal(run({ op: 'send', paneId: 'f1', text: 'hi' }, 'root').ok, false);
  // Callers from before capabilities (no cap) are full, as everywhere.
  assert.equal(checkPhoneCommand({ op: 'send', paneId: 'f1', text: 'hi' }, w.ctx).ok, true);
});

test('policy: a follower may answer the questions of the desktop pane it follows (full only); every other question stays refused', () => {
  const w = world();
  w.follow('f1', 'pA');
  w.asks.set('ask-desk', 'pA');
  w.asks.set('ask-other', 'pB');
  w.asks.set('ask-mine', phonePaneId(DEV, 'p1'));
  w.asks.set('ask-theirs', phonePaneId('ZZZZZZZZZZZZZZZZZZZZZZ', 'p1'));
  const answer = (askId, cap = 'full') => checkPhoneCommand({ op: 'answer', askId, result: { behavior: 'allow', updatedInput: { answers: { q: 'a' } }, extra: 1 } }, { ...w.ctx, cap });
  const ok = answer('ask-desk');
  assert.deepEqual(ok.cmd, { op: 'answer', askId: 'ask-desk', result: { behavior: 'allow', updatedInput: { answers: { q: 'a' } } } });
  assert.deepEqual(ok.follower, { paneId: null, desktopPaneId: 'pA' });
  for (const cap of ['noshell', 'chat']) {
    const r = answer('ask-desk', cap);
    assert.equal(r.ok, false);
    assert.equal(r.readOnly, true);
    assert.match(r.error, /cannot send to it, stop it or answer its questions/);
  }
  assert.equal(answer('ask-other').ok, false, 'a desktop pane this phone does not follow');
  assert.equal(answer('ask-theirs').ok, false, 'another phone\'s pane');
  assert.equal(answer('ask-nope').ok, false);
  const own = answer('ask-mine', 'noshell');
  assert.equal(own.ok, true, 'a question of its own pane is answered as before, whatever the capability');
  assert.equal(own.follower, undefined);
});

test('policy: what a follower is sent: an allowlist of the pane\'s events under its own pane id, never the window\'s request ids, queue or dictation', () => {
  const pane = phonePaneId(DEV, 'f1');
  const view = (ev, o = {}) => followerView(ev, { pane, readOnly: false, ...o });
  assert.deepEqual(view({ ev: 'sdk', paneId: 'pA', reqId: 'r9', msg: { type: 'result' } }), { ev: 'sdk', paneId: 'f1', msg: { type: 'result' } });
  const opened = view({ ev: 'opened', attached: true, reqId: 'r1', paneId: 'pA', sessionId: 's', queue: [{ id: 'q', text: 'PRIVATE' }], queueSent: ['x'], title: 'T' }, { readOnly: true });
  assert.deepEqual(opened, { ev: 'opened', attached: true, paneId: 'f1', sessionId: 's', title: 'T', follower: true, readOnly: true });
  assert.equal(view({ ev: 'ask', askId: 'a', paneId: 'pA', input: {} }, { readOnly: true }).readOnly, true);
  // A message the follower sent itself is not echoed to it; anyone else's is, without the marker.
  assert.equal(view({ ev: 'peerMessage', paneId: 'pA', text: 'x', origin: pane }), null);
  assert.deepEqual(view({ ev: 'peerMessage', paneId: 'pA', text: 'x', from: 'Desktop', origin: phonePaneId(DEV, 'f2') }), { ev: 'peerMessage', paneId: 'f1', text: 'x', from: 'Desktop' });
  // Dictation, browser activity and answers to someone's request are not part of the pane's stream.
  for (const ev of ['transcript', 'browserActivity', 'browserToolResult', 'billingOptions', 'steered', 'steer_missed', 'commands', 'historyPage', 'historyBlock', 'artifactContent', 'followers', 'sessions']) {
    assert.equal(FOLLOW_EVENTS.has(ev), false, ev);
    assert.equal(view({ ev, paneId: 'pA', text: 'PRIVATE' }), null, ev);
  }
  for (const ev of ['opened', 'history', 'sdk', 'result', 'ask', 'ask_gone', 'closed', 'settings', 'context', 'artifact', 'openUrl', 'peerMessage']) assert.ok(FOLLOW_EVENTS.has(ev), ev);
  assert.equal(followerView(null, { pane }), null);
  assert.equal(followerView({ ev: 'sdk', paneId: 'pA' }, { pane: 'not-a-phone-pane' }), null);

  // An answer to a follower's request names the desktop pane: it goes to that phone, under the phone pane that follows it.
  const local = (dev, desk) => (dev === DEV && desk === 'pA' ? 'f1' : null);
  const r = routeEvent({ ev: 'context', reqId: `phone:${DEV}:r5`, paneId: 'pA', percentage: 3 }, local);
  assert.equal(r.deviceId, DEV);
  assert.deepEqual(r.ev, { ev: 'context', reqId: 'r5', paneId: 'f1', percentage: 3 });
  assert.equal(routeEvent({ ev: 'context', reqId: `phone:${DEV}:r5`, paneId: 'pB' }, local).ev.paneId, null, 'a desktop pane id never reaches a phone through here');
  assert.equal(routeEvent({ ev: 'context', reqId: `phone:${DEV}:r5`, paneId: 'pA' }).ev.paneId, null, 'and without a follower lookup either');
  assert.equal(routeEvent({ ev: 'sdk', paneId: 'pA', reqId: 'r5' }, local), null, 'an event of a desktop pane with the window\'s own request id stays on the desktop');
  assert.deepEqual(routeEvent({ ev: 'sessions', reqId: `phone:${DEV}:r4` }, local).ev, { ev: 'sessions', reqId: 'r4' }, 'requests with no pane are routed as before');
  // Whatever reaches a phone, a window's queued messages do not.
  const v = phoneView({ ev: 'opened', paneId: 'p1', queue: [{ id: 'q', text: 'PRIVATE' }], queueSent: ['q'], title: 'T' });
  assert.deepEqual(v, { ev: 'opened', paneId: 'p1', title: 'T' });
});

/* ======================================================= 2. the bridge */

function fakeRelay() {
  const relay = { pc: null, phones: new Map(), nextConn: 1 };
  const emitTo = (sock, type, data) => { for (const f of sock.listeners[type] || []) f(data); };
  class WS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0; this.listeners = {};
      queueMicrotask(() => {
        if (relay.pc) relay.pc.close();
        relay.pc = this;
        this.readyState = 1;
        emitTo(this, 'open', {});
        emitTo(this, 'message', { data: JSON.stringify({ t: 'ready', role: 'pc', phones: [...relay.phones.keys()], limits: {} }) });
      });
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(data) {
      if (this.readyState !== 1) return;
      if (typeof data === 'string') {
        if (data === 'ping') { queueMicrotask(() => emitTo(this, 'message', { data: 'pong' })); return; }
        const m = JSON.parse(data);
        if (m.t === 'kick') relay.phones.get(m.conn)?.kicked();
        return;
      }
      const { connId, payload } = decodePcFrame(new Uint8Array(data));
      relay.phones.get(connId)?.deliver(payload.slice());
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (relay.pc === this) relay.pc = null;
      queueMicrotask(() => emitTo(this, 'close', { code: 1000 }));
    }
  }
  relay.WS = WS;
  relay.phone = () => {
    const conn = relay.nextConn++;
    const ph = {
      conn, inbox: [], waiters: [], gone: false,
      deliver(bytes) { ph.inbox.push(bytes); ph.wake(); },
      kicked() { ph.gone = true; relay.phones.delete(conn); ph.wake(); if (relay.pc) emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'leave', conn }) }); },
      leave() { relay.phones.delete(conn); if (relay.pc) emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'leave', conn }) }); },
      wake() { for (const w of ph.waiters.splice(0)) w(); },
      send(frame) { if (relay.pc) emitTo(relay.pc, 'message', { data: encodePcFrame(conn, frame).buffer }); },
      async next(ms = 4000) {
        const end = Date.now() + ms;
        while (!ph.inbox.length) {
          if (Date.now() > end) throw new Error('no frame for the phone');
          await new Promise((r) => { ph.waiters.push(r); setTimeout(r, 50); });
        }
        return ph.inbox.shift();
      },
    };
    relay.phones.set(conn, ph);
    if (relay.pc) emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'join', conn }) });
    return ph;
  };
  return relay;
}

/** Drives a PhoneSession over a phone socket (`ph.next` and `ph.send`) and collects what the PC says. */
async function phoneClient(ph, session) {
  const inbox = new Inbox();
  const c = { session, events: [], sas: null, pairing: null, alerts: [] };
  c.pump = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`phone gave up waiting: ${String(pred).slice(0, 160)} ${(new Error().stack.split('\n')[2] || '').trim()}`);
      let frame;
      try { frame = await ph.next(Math.max(50, end - Date.now())); } catch { continue; }
      const step = await session.receive(frame);
      for (const f of step.send) ph.send(f);
      for (const ev of step.events) {
        let m = null;
        if (ev.type === 'sas') c.sas = ev.sas;
        else if (ev.type === 'paired') c.pairing = ev.pairing;
        else if (ev.type === 'json') m = inbox.json(ev.value);
        else if (ev.type === 'chunk') m = inbox.chunk(ev);
        else if (ev.type === 'alert' || ev.type === 'close' || ev.type === 'error') c.alerts.push(ev);
        if (m?.t === 'evs') c.events.push(...m.list);
        else if (m) c.events.push({ wire: m });
      }
    }
  };
  c.out = new Outbox({ session, write: (f) => ph.send(f), flushMs: 1 });
  c.cmd = (cmd) => c.out.send({ t: 'cmd', cmd });
  c.wire = (t) => c.events.filter((e) => e.wire?.t === t).map((e) => e.wire);
  c.got = (ev, pane) => c.events.filter((e) => e.ev === ev && (pane === undefined || e.paneId === pane));
  c.ready = () => c.events.some((e) => e.ev === 'ready');
  ph.send(await session.start());
  return c;
}

/**
 * A bridge over the in-memory relay and a stand-in engine that has some desktop panes (pA and pB conversations, a viewer, a browser
 * and a task pane). Its dispatch does what engine.js does for follow (followState: the pane's state, addressed to the phone's
 * pane); the real engine has its own tests in the last part of this file.
 */
function deskBridge(relay, dir, extra = {}) {
  const desktop = [];
  const dispatched = [];
  const own = new Map();
  const asks = new Map();
  const desk = new Map([
    ['pA', { kind: 'conversation', sessionId: 'sess-aaaa1111', model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions' }],
    ['pB', { kind: 'conversation', sessionId: 'sess-bbbb2222', model: 'claude-opus-5-5', effort: 'high', mode: 'plan' }],
    ['v1', { kind: 'viewer' }], ['b1', { kind: 'browser' }], ['t1', { kind: 'task' }],
  ]);
  const env = { desktop, dispatched, own, asks, desk };
  env.dispatch = (c) => {
    dispatched.push(c);
    if (c.op === 'open' || c.op === 'attach') own.set(c.paneId, { sessionId: c.sessionId, running: true, busy: false, mode: c.mode || 'default' });
    if (c.op === 'close') own.delete(c.paneId);
    if (c.op === 'follow') {
      queueMicrotask(() => {
        const d = desk.get(c.desktopPaneId);
        env.b.route({ ev: 'opened', attached: true, follower: true, readOnly: c.readOnly, reqId: c.reqId, paneId: c.paneId, sessionId: d.sessionId, title: 'Desk conversation', model: d.model, effort: d.effort, mode: d.mode, busy: false });
        env.b.route({ ev: 'history', paneId: c.paneId, sessionId: d.sessionId, messages: [], total: 0 });
      });
    }
  };
  env.b = new RemoteBridge({
    emit: (e) => desktop.push(e),
    dispatch: (c) => env.dispatch(c),
    readyEvent: () => ({ ev: 'ready', model: 'claude-opus-5-5', mode: 'bypassPermissions' }),
    engine: {
      paneExists: (id) => own.has(id),
      paneCount: (dev) => [...own.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev).length,
      phonePanes: (dev) => [...own.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev),
      paneInfo: (id) => own.get(id) || desk.get(id) || null,
      askPane: (id) => asks.get(id) || null,
      knownCwd: () => false,
      phoneSessions: (dev) => [...own.entries()].filter(([id]) => parsePhoneId(id)?.deviceId === dev).map(([, p]) => p.sessionId).filter(Boolean),
      hasOp: () => false,
      desktopPane: (id) => desk.get(id)?.kind ?? null,
    },
    dir,
    WebSocket: relay.WS,
    relay: 'ws://127.0.0.1:9',
    web: 'http://127.0.0.1:9/',
    pcName: 'Test PC',
    log: () => {},
    pageCheck: false,
    recheckFirstMs: 3_600_000,
    viaGraceMs: 60_000,
    ...extra,
  });
  env.last = () => [...desktop].reverse().find((e) => e.ev === 'remote');
  env.followers = (paneId) => desktop.filter((e) => e.ev === 'followers' && e.paneId === paneId).map((e) => e.phones);
  return env;
}

async function pairPhone(env, relay, { name = 'Test iPhone', cap } = {}) {
  const { b } = env;
  await b.op({ op: 'remotePairStart' });
  const ph = relay.phone();
  await until(() => b.conns.has(ph.conn));
  const device = await createDeviceIdentity();
  const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(env.last().pairing.url), name }));
  await phone.pump(() => phone.sas);
  await until(() => env.last().request);
  await b.op({ op: 'remotePairDecision', approve: true, ...(cap ? { cap } : {}) });
  await phone.pump(() => phone.pairing && phone.ready());
  const pairing = JSON.parse(JSON.stringify(phone.pairing));
  const id = pairing.deviceId;
  return { ph, device, phone, pairing, hello: phone.wire('hello')[0], id, me: (local) => phonePaneId(id, local) };
}

/** Sends an event of a desktop pane through the bridge, then one more that must follow it, and waits for that one: what the phone has by then is everything. */
async function settle(env, p, tag, paneId = 'pA') {
  env.b.route({ ev: 'note', paneId, text: tag });
  await p.phone.pump(() => p.phone.events.some((e) => e.ev === 'note' && e.text === tag));
}

async function online(env) {
  await env.b.op({ op: 'remoteEnable' });
  await until(() => env.b.status === 'online');
}

test('bridge: a phone follows a desktop pane; the pane\'s state first, then its events under the phone\'s own ids; nothing is opened or taken over', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const env = deskBridge(relay, dir);
    const { b, desktop, dispatched } = env;
    try {
      await online(env);
      const p = await pairPhone(env, relay, { name: 'Test iPhone' });
      const { phone, me } = p;
      assert.ok(p.hello.features.includes('follow'), 'hello says this PC can show a desktop pane without taking it over');
      assert.ok(p.hello.ops.includes('follow') && p.hello.ops.includes('unfollow'));

      await phone.cmd({ op: 'follow', reqId: 'r1', paneId: 'f1', desktopPaneId: 'pA' });
      await phone.pump(() => phone.got('history', 'f1').length === 1);
      assert.deepEqual(dispatched, [{ op: 'follow', reqId: me('r1'), paneId: me('f1'), desktopPaneId: 'pA', readOnly: false }], 'one follow, no open, no attach: nothing taken over');
      const opened = phone.got('opened', 'f1')[0];
      assert.equal(opened.reqId, 'r1');
      assert.equal(opened.attached, true);
      assert.equal(opened.follower, true);
      assert.equal(opened.readOnly, false);
      assert.equal(opened.sessionId, 'sess-aaaa1111');
      assert.deepEqual(env.followers('pA'), [['Test iPhone']], 'the desktop window hears who watches the pane');

      // The pane's later events reach the phone under its own pane id, and the desktop still gets them.
      assert.equal(b.route({ ev: 'sdk', paneId: 'pA', sessionId: 'sess-aaaa1111', msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'LIVE WORDS' }] } } }), false, 'the desktop still gets it');
      assert.equal(b.route({ ev: 'result', reqId: 'r77', paneId: 'pA', sessionId: 'sess-aaaa1111', result: 'done' }), false);
      // What is not the phone's to see: the window's queue and request ids, its dictation, another pane's events.
      b.route({ ev: 'opened', attached: true, reqId: 'r42', paneId: 'pA', sessionId: 'sess-aaaa1111', queue: [{ id: 'q1', text: 'PRIVATE QUEUED' }], queueSent: ['q0'] });
      b.route({ ev: 'transcript', reqId: 'r43', paneId: 'pA', text: 'PRIVATE DICTATION' });
      b.route({ ev: 'steered', reqId: 'r44', paneId: 'pA', qid: 'PRIVATE-QID' });
      b.route({ ev: 'sdk', paneId: 'pB', msg: { text: 'OTHER PANE' } });
      await settle(env, p, 's1');
      const sdk = phone.got('sdk', 'f1');
      assert.equal(sdk.length, 1);
      assert.equal(sdk[0].msg.message.content[0].text, 'LIVE WORDS');
      const result = phone.got('result', 'f1')[0];
      assert.equal(result.result, 'done');
      assert.equal(result.reqId, undefined, 'the window\'s request id does not go along');
      const reopened = phone.got('opened', 'f1')[1];
      assert.deepEqual([reopened.follower, reopened.readOnly, reopened.queue, reopened.queueSent, reopened.reqId], [true, false, undefined, undefined, undefined]);
      const all = JSON.stringify(phone.events);
      for (const secret of ['PRIVATE QUEUED', 'PRIVATE DICTATION', 'PRIVATE-QID', 'OTHER PANE', '"r42"', '"r44"']) assert.ok(!all.includes(secret), secret);
      assert.ok(!JSON.stringify(phone.events.filter((e) => e.ev !== 'desktopTabs')).includes('"pA"'), 'the desktop\'s pane id is not in what a follower is sent (it names its own pane)');

      // A message another window sent: the phone gets it unless it sent it itself.
      b.route({ ev: 'peerMessage', paneId: 'pA', from: 'Other phone', text: 'HI FROM ANOTHER', steered: false, images: [], origin: 'phone:ZZZZZZZZZZZZZZZZZZZZZZ:f9' });
      b.route({ ev: 'peerMessage', paneId: 'pA', from: 'Test iPhone', text: 'MY OWN MESSAGE', steered: false, images: [], origin: me('f1') });
      b.route({ ev: 'peerMessage', paneId: 'pA', from: 'Desktop', text: 'FROM THE DESKTOP', steered: true, images: [], origin: null });
      await settle(env, p, 's2');
      assert.deepEqual(phone.got('peerMessage').map((e) => e.text), ['HI FROM ANOTHER', 'FROM THE DESKTOP']);
      assert.equal(phone.got('peerMessage')[1].steered, true);

      // Its ops run on the desktop pane, tagged with who sent them; the phone's own pane id never reaches the engine as a pane.
      dispatched.length = 0;
      await phone.cmd({ op: 'send', reqId: 'r2', paneId: 'f1', text: 'from phone', images: [] });
      await phone.cmd({ op: 'steer', reqId: 'r3', paneId: 'f1', qid: 'qa1', text: 'steer this' });
      await phone.cmd({ op: 'interrupt', reqId: 'r4', paneId: 'f1' });
      await phone.cmd({ op: 'contextUsage', reqId: 'r5', paneId: 'f1' });
      await phone.cmd({ op: 'historyBefore', reqId: 'r6', paneId: 'f1', before: '11111111-2222-3333-4444-555555555555', sessionId: 'sess-aaaa1111' });
      await phone.cmd({ op: 'commands', reqId: 'r7', paneId: 'f1' });
      await until(() => dispatched.length === 6);
      const who = { follower: 'Test iPhone', origin: me('f1') };
      assert.deepEqual(dispatched, [
        { op: 'send', paneId: 'pA', text: 'from phone', images: [], ...who },
        { op: 'steer', reqId: me('r3'), paneId: 'pA', qid: 'qa1', text: 'steer this', images: [], ...who },
        { op: 'interrupt', reqId: me('r4'), paneId: 'pA', ...who },
        { op: 'contextUsage', reqId: me('r5'), paneId: 'pA', ...who },
        { op: 'historyBefore', reqId: me('r6'), paneId: 'pA', sessionId: 'sess-aaaa1111', before: '11111111-2222-3333-4444-555555555555', ...who },
        { op: 'commands', reqId: me('r7'), paneId: 'pA', ...who },
      ]);
      // The answers to its requests go to it alone, under its own pane id, and the desktop does not get them.
      assert.equal(b.route({ ev: 'context', reqId: me('r5'), paneId: 'pA', percentage: 7 }), true);
      assert.equal(b.route({ ev: 'historyPage', reqId: me('r6'), paneId: 'pA', sessionId: 'sess-aaaa1111', messages: [], error: 'x' }), true);
      assert.equal(b.route({ ev: 'steered', reqId: me('r3'), paneId: 'pA', qid: 'qa1' }), true);
      await settle(env, p, 's3');
      const ctx = phone.got('context')[0];
      assert.deepEqual([ctx.paneId, ctx.reqId, ctx.percentage], ['f1', 'r5', 7]);
      assert.deepEqual([phone.got('historyPage')[0].paneId, phone.got('historyPage')[0].reqId], ['f1', 'r6']);
      assert.deepEqual([phone.got('steered')[0].paneId, phone.got('steered')[0].qid], ['f1', 'qa1']);

      // model, effort and mode are the desktop's: refused, with the desktop pane's own settings sent back.
      for (const [op, extra] of [['mode', { mode: 'plan' }], ['model', { model: 'claude-haiku-5-5' }], ['effort', { effort: 'low' }]]) {
        await phone.cmd({ op, reqId: `m-${op}`, paneId: 'f1', ...extra });
        await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === `m-${op}`));
        assert.match(phone.events.find((e) => e.refused && e.reqId === `m-${op}`).message, /set on the PC.*not available yet/);
      }
      await phone.pump(() => phone.got('settings', 'f1').some((e) => e.mode === 'bypassPermissions' && e.effort === 'xhigh'));
      // open or attach would take the session over: refused while the pane follows.
      await phone.cmd({ op: 'open', reqId: 'r9', paneId: 'f1', sessionId: 'sess-aaaa1111' });
      await phone.cmd({ op: 'attach', reqId: 'r10', paneId: 'f1', sessionId: 'sess-aaaa1111' });
      await phone.pump(() => phone.events.filter((e) => e.refused && /Unfollow it first/.test(e.message)).length === 2);
      assert.equal(dispatched.length, 6, 'none of the refused ops reached the engine');

      // A question of the pane: answered by the follower, as long as it follows that pane.
      env.asks.set('ask-1', 'pA');
      env.asks.set('ask-2', 'pB');
      dispatched.length = 0;
      await phone.cmd({ op: 'answer', askId: 'ask-1', result: { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } } });
      await phone.cmd({ op: 'answer', askId: 'ask-2', result: { behavior: 'allow' } });
      await until(() => dispatched.length === 1);
      assert.deepEqual(dispatched[0], { op: 'answer', askId: 'ask-1', result: { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } }, follower: 'Test iPhone' });
      await phone.pump(() => phone.events.some((e) => e.refused && /another window/.test(e.message)));

      // unfollow ends it: the phone hears closed, the window hears nobody watches, and the pane's events stop.
      await phone.cmd({ op: 'unfollow', reqId: 'u1', paneId: 'f1' });
      await phone.pump(() => phone.got('closed', 'f1').length === 1);
      assert.equal(phone.got('closed', 'f1')[0].reqId, 'u1');
      assert.deepEqual(env.followers('pA').at(-1), [], 'the window\'s "Also on" line goes');
      assert.ok(!dispatched.some((c) => c.op === 'unfollow' || c.op === 'close'), 'unfollow is the bridge\'s own: it never closes anything in the engine');
      await phone.cmd({ op: 'follow', reqId: 'r11', paneId: 'f2', desktopPaneId: 'pB' });
      await phone.pump(() => phone.got('history', 'f2').length === 1);
      const before = phone.got('sdk', 'f1').length;
      b.route({ ev: 'sdk', paneId: 'pA', msg: { text: 'AFTER UNFOLLOW' } });
      await settle(env, p, 's4', 'pB');
      assert.equal(phone.got('sdk', 'f1').length, before);
      assert.ok(!JSON.stringify(phone.events).includes('AFTER UNFOLLOW'));
      await phone.cmd({ op: 'send', reqId: 'r12', paneId: 'f1', text: 'nobody home' });
      await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === 'r12' && /not open on the PC/.test(e.message)));

      // The desktop pane closes: its follower hears closed and is gone.
      assert.equal(b.route({ ev: 'closed', paneId: 'pB' }), false, 'the window hears it as before');
      await phone.pump(() => phone.got('closed', 'f2').length === 1);
      assert.equal(b.following.size, 0);
      await phone.cmd({ op: 'send', reqId: 'r13', paneId: 'f2', text: 'gone' });
      await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === 'r13'));
      assert.ok(!dispatched.some((c) => c.op === 'send'), 'nothing was sent into a pane that closed');
    } finally { b.stop(); }
  });
});

test('bridge: a restricted phone follows read only, on its live capability; it still gets everything the pane does', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const env = deskBridge(relay, dir);
    const { b, dispatched } = env;
    try {
      await online(env);
      const p = await pairPhone(env, relay, { name: 'Careful phone', cap: 'noshell' });
      const { phone, me, id } = p;
      assert.equal(p.hello.cap, 'noshell');
      env.asks.set('ask-1', 'pA');

      // Follows (again), waits for the pane's history, and for the line a restricted phone reads after it (the history redraws the pane).
      const follow = async (local, expect) => {
        const seen = phone.got('history', local).length;
        await phone.cmd({ op: 'follow', reqId: `fr-${local}-${seen}`, paneId: local, desktopPaneId: 'pA' });
        await phone.pump(() => phone.got('history', local).length > seen);
        const note = () => phone.got('note', local).find((e) => expect.test(e.text));
        await phone.pump(() => Boolean(note()));
        return note();
      };
      await follow('f1', /No shell on the PC: it can watch this desktop conversation, but not send to it/);
      assert.equal(phone.got('opened', 'f1')[0].readOnly, true);
      assert.equal(dispatched.at(-1).readOnly, true);

      const refuse = async (cmd, label) => {
        const reqId = `x-${label}`;
        await phone.cmd({ ...cmd, reqId, paneId: 'f1' });
        await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === reqId));
        const e = phone.events.find((x) => x.refused && x.reqId === reqId);
        assert.equal(e.readOnly, true, label);
        return e.message;
      };
      dispatched.length = 0;
      assert.match(await refuse({ op: 'send', text: 'run rm -rf' }, 'send'), /set to No shell on the PC.*desktop's own permissions and tools/);
      await refuse({ op: 'steer', qid: 'qa', text: 'run it' }, 'steer');
      await refuse({ op: 'interrupt' }, 'interrupt');
      await phone.cmd({ op: 'answer', reqId: 'x-answer', askId: 'ask-1', result: { behavior: 'allow' } });
      await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === 'x-answer' && e.readOnly && /answer its questions/.test(e.message)));
      assert.equal(dispatched.length, 0, 'nothing reached the desktop pane');

      // Reading is untouched: the pane's events, the context meter, history, the command list.
      b.route({ ev: 'sdk', paneId: 'pA', msg: { text: 'SEEN BY A RESTRICTED PHONE' } });
      b.route({ ev: 'ask', askId: 'ask-1', paneId: 'pA', toolName: 'AskUserQuestion', input: { questions: [] } });
      await settle(env, p, 'r1');
      assert.equal(phone.got('sdk', 'f1').at(-1).msg.text, 'SEEN BY A RESTRICTED PHONE');
      assert.equal(phone.got('ask', 'f1')[0].readOnly, true, 'the page can show the question without an answer button');
      await phone.cmd({ op: 'contextUsage', reqId: 'c1', paneId: 'f1' });
      await phone.cmd({ op: 'commands', reqId: 'c2', paneId: 'f1' });
      await phone.cmd({ op: 'historyBefore', reqId: 'c3', paneId: 'f1', before: '11111111-2222-3333-4444-555555555555', sessionId: 'sess-aaaa1111' });
      await until(() => dispatched.length === 3);
      assert.deepEqual(dispatched.map((c) => c.op), ['contextUsage', 'commands', 'historyBefore']);

      // The access is read live: changed on the PC to Chat only, still read only (and the note says so); back to Full, it may drive.
      await b.op({ op: 'remoteDeviceCap', deviceId: id, cap: 'chat' });
      assert.match(await refuse({ op: 'send', text: 'hi' }, 'chat'), /set to Chat only on the PC/);
      await follow('f1', /Chat only on the PC: it can watch/);
      await b.op({ op: 'remoteDeviceCap', deviceId: id, cap: 'full' });
      dispatched.length = 0;
      await phone.cmd({ op: 'send', reqId: 'x-full', paneId: 'f1', text: 'now allowed' });
      await until(() => dispatched.length === 1);
      assert.deepEqual([dispatched[0].op, dispatched[0].paneId, dispatched[0].follower, dispatched[0].origin], ['send', 'pA', 'Careful phone', me('f1')]);
    } finally { b.stop(); }
  });
});

test('bridge: a phone cannot follow a viewer, a browser, a task, a pane that is not there, a pane it holds itself, or more than the limit', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const env = deskBridge(relay, dir);
    const { b, dispatched, desk } = env;
    try {
      await online(env);
      const p = await pairPhone(env, relay, { name: 'Test iPhone' });
      const { phone } = p;
      const refused = async (cmd, pattern) => {
        const reqId = cmd.reqId;
        await phone.cmd(cmd);
        await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === reqId));
        assert.match(phone.events.find((e) => e.refused && e.reqId === reqId).message, pattern, reqId);
      };
      await refused({ op: 'follow', reqId: 'v', paneId: 'f1', desktopPaneId: 'v1' }, /Only a conversation can be followed/);
      await refused({ op: 'follow', reqId: 'bb', paneId: 'f1', desktopPaneId: 'b1' }, /Only a conversation/);
      await refused({ op: 'follow', reqId: 'tt', paneId: 'f1', desktopPaneId: 't1' }, /Only a conversation/);
      await refused({ op: 'follow', reqId: 'nn', paneId: 'f1', desktopPaneId: 'p99' }, /not open on the desktop/);
      await refused({ op: 'follow', reqId: 'ph', paneId: 'f1', desktopPaneId: `phone:${p.id}:p1` }, /Bad desktop pane id/);
      assert.equal(dispatched.length, 0);
      assert.equal(b.following.size, 0);
      assert.deepEqual(env.followers('pA'), []);

      // A pane that holds a conversation of its own is not turned into a follower.
      await phone.cmd({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: null, warm: true });
      await until(() => dispatched.length === 1);
      await refused({ op: 'follow', reqId: 'own', paneId: 'p1', desktopPaneId: 'pA' }, /already holds a conversation/);
      await refused({ op: 'unfollow', reqId: 'unown', paneId: 'p1' }, /holds a conversation of this phone/);
      assert.equal(b.following.size, 0);

      // The limit: MAX_PHONE_PANES desktop panes at once, counted apart from the phone's own conversations.
      for (let i = 0; i < MAX_PHONE_PANES + 1; i++) desk.set(`d${i}`, { kind: 'conversation', sessionId: `sess-d${i}0000000`, model: 'm', effort: 'e', mode: 'default' });
      for (let i = 0; i < MAX_PHONE_PANES; i++) await phone.cmd({ op: 'follow', reqId: `lf${i}`, paneId: `f${i}`, desktopPaneId: `d${i}` });
      await phone.pump(() => b.following.size === MAX_PHONE_PANES && phone.got('history').length === MAX_PHONE_PANES);
      await refused({ op: 'follow', reqId: 'lfx', paneId: 'fx', desktopPaneId: `d${MAX_PHONE_PANES}` }, new RegExp(`${MAX_PHONE_PANES} desktop panes`));
      await refused({ op: 'follow', reqId: 'lfy', paneId: 'f1', desktopPaneId: 'd0' }, /already follows that desktop pane in another pane/);
      // Moving one of them to another desktop pane is allowed, and the old one stops getting events.
      await phone.cmd({ op: 'follow', reqId: 'mv', paneId: 'f0', desktopPaneId: `d${MAX_PHONE_PANES}` });
      await phone.pump(() => b.following.get(p.me('f0'))?.desktopPaneId === `d${MAX_PHONE_PANES}`);
      assert.equal(b.following.size, MAX_PHONE_PANES);
      assert.deepEqual(env.followers('d0').at(-1), [], 'nobody watches d0 any more');
      assert.deepEqual(env.followers(`d${MAX_PHONE_PANES}`).at(-1), ['Test iPhone']);
    } finally { b.stop(); }
  });
});

test('bridge: held account connections get nothing and cannot follow; a phone that leaves, or is removed, stops following (the page sends follow again)', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const env = deskBridge(relay, dir);
    const { b, dispatched } = env;
    try {
      await online(env);
      const p = await pairPhone(env, relay, { name: 'Pairing phone' });
      // An Apaki account: one phone let in (its key is known), one held (it sends no phone key yet).
      const acct = await createDeviceIdentity({ extractable: true });
      const acctId = await deviceIdFor(acct.pub);
      const psk = b64urlEncode(randomBytes(32));
      await b.addDevice({ id: acctId, pub: b64urlEncode(acct.pub), name: 'Apaki account (Arthur)', kind: 'account', account: 'Arthur', by: 'Pairing phone', psk, pairedAt: new Date().toISOString(), cap: 'full', phones: [] });
      const pairing = { ...p.pairing, deviceId: acctId, psk };
      const te = new TextEncoder();
      const connect = async (key, name, via) => {
        const ph = relay.phone();
        await until(() => b.conns.has(ph.conn));
        const c = await phoneClient(ph, new PhoneSession({ device: acct, pairing }));
        await c.pump(() => c.wire('hello').length);
        if (via) {
          const nonce = b64urlDecode(c.wire('hello')[0].nonce);
          const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new Uint8Array([...te.encode('apaki/v1 via'), ...nonce, ...key.pub, ...te.encode(name)])));
          await c.out.send({ t: 'via', name, pub: b64urlEncode(key.pub), sig: b64urlEncode(sig) });
          await c.pump(() => c.ready());
        }
        return { ph, c };
      };
      const inside = await connect(await createDeviceIdentity(), 'iPhone (Safari)', true);
      const held = await connect(await createDeviceIdentity(), 'Held phone', false);
      await sleep(50);
      assert.ok(!held.c.ready(), 'held: no ready event');
      const aid = acctId;

      await inside.c.cmd({ op: 'follow', reqId: 'a1', paneId: 'f1', desktopPaneId: 'pA' });
      await inside.c.pump(() => inside.c.got('history', 'f1').length === 1);
      assert.deepEqual(env.followers('pA').at(-1), ['iPhone (Safari)'], 'an account\'s phone is named by its own name, not the account\'s');
      b.route({ ev: 'sdk', paneId: 'pA', msg: { text: 'FOR THE FOLLOWER ONLY' } });
      await settle(env, { phone: inside.c }, 'h1');
      assert.equal(inside.c.got('sdk', 'f1').length, 1);
      await sleep(80);
      assert.equal(held.c.events.filter((e) => e.ev).length, 0, 'a held connection gets no event of the account\'s phones, the followed pane included');
      // And it cannot say anything: follow from a held connection is ignored (only via is read until it is let in).
      const n = dispatched.length;
      await held.c.cmd({ op: 'follow', reqId: 'h-f', paneId: 'f9', desktopPaneId: 'pB' });
      await sleep(80);
      assert.equal(dispatched.length, n);
      assert.equal(b.following.has(phonePaneId(aid, 'f9')), false);

      // The phone leaves (the held one is not a phone that is in): its followers end at once, the window's line goes.
      inside.ph.leave();
      await until(() => b.following.size === 0);
      assert.deepEqual(env.followers('pA').at(-1), []);

      // A direct phone: its follower ends when it leaves; a phone that connects again hears nothing for that pane until it follows again.
      await p.phone.cmd({ op: 'follow', reqId: 'd1', paneId: 'f1', desktopPaneId: 'pA' });
      await p.phone.pump(() => p.phone.got('history', 'f1').length === 1);
      assert.deepEqual(env.followers('pA').at(-1), ['Pairing phone']);
      p.ph.leave();
      await until(() => b.following.size === 0);
      assert.deepEqual(env.followers('pA').at(-1), []);
      const ph2 = relay.phone();
      await until(() => b.conns.has(ph2.conn));
      const again = await phoneClient(ph2, new PhoneSession({ device: p.device, pairing: p.pairing }));
      await again.pump(() => again.ready());
      b.route({ ev: 'sdk', paneId: 'pA', msg: { text: 'WHILE NOT FOLLOWING' } });
      await sleep(80);
      assert.ok(!JSON.stringify(again.events).includes('WHILE NOT FOLLOWING'));
      await again.cmd({ op: 'follow', reqId: 'd2', paneId: 'f1', desktopPaneId: 'pA' });
      await again.pump(() => again.got('history', 'f1').length === 1);
      assert.equal(again.got('opened', 'f1')[0].follower, true, 'the state is sent again');
      // Private keeps the feature on offer, and removing the phone ends its followers too.
      await b.op({ op: 'remoteMode', mode: 'private' });
      await again.pump(() => again.wire('mode').length);
      assert.ok(again.wire('mode')[0].features.includes('follow'));
      await b.op({ op: 'remoteRevoke', deviceId: p.id });
      assert.equal(b.following.size, 0);
      assert.deepEqual(env.followers('pA').at(-1), []);
    } finally { b.stop(); }
  });
});

test('bridge: an engine that has no desktopPane cannot be followed, and the phone is told so', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const env = deskBridge(relay, dir);
    try {
      env.b.engine.desktopPane = undefined;
      await online(env);
      const p = await pairPhone(env, relay);
      await p.phone.cmd({ op: 'follow', reqId: 'n1', paneId: 'f1', desktopPaneId: 'pA' });
      await p.phone.pump(() => p.phone.events.some((e) => e.refused && /not available on this PC/.test(e.message)));
      assert.equal(env.b.following.size, 0);
      assert.equal(env.desktop.filter((e) => e.ev === 'followers').length, 0);
    } finally { env.b.stop(); }
  });
});

/* ================================================== 3. the real engine */

// A stand-in for @anthropic-ai/claude-agent-sdk (as in apaki-queue.test.js): each message is echoed; "wait:<ms>" makes the turn take that
// long; "ask:<name>" asks a question the way Claude does (through the PreToolUse hook the engine installs) and replies with the answer.
// Every query() it is asked to start, and every interrupt, is written to FAKE_QUERY_LOG, so a test can count Claude Code processes.
const REAL_SDK = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
const FAKE_SDK_BODY = String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs';
const sessions = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (line) => { if (process.env.FAKE_QUERY_LOG) fs.appendFileSync(process.env.FAKE_QUERY_LOG, line + '\n'); };
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
  note('query ' + (options.resume || 'new'));
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
      const wait = /wait:(\d+)/.exec(text);
      if (wait) await sleep(Number(wait[1]));
      let reply = 'echo: ' + text;
      const ask = /ask:(\S+)/.exec(text);
      if (ask) {
        const hook = ((options.hooks && options.hooks.PreToolUse) || []).find((h) => /AskUserQuestion/.test(h.matcher || ''));
        const r = hook ? await hook.hooks[0]({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which ' + ask[1] + '?', options: [{ label: 'A' }, { label: 'B' }] }] } }) : null;
        const o = r && r.hookSpecificOutput;
        reply = o ? (o.permissionDecision === 'allow' ? 'asked ' + ask[1] + ': ' + JSON.stringify((o.updatedInput || {}).answers) : 'denied ' + ask[1]) : 'no answer ' + ask[1];
      }
      sessions.get(sid).push({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
      out.push({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: reply }] }, session_id: sid });
      out.push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, usage: {}, total_cost_usd: 0, result: reply, session_id: sid });
    }
    out.end();
  })().catch(() => out.end());
  return Object.assign(out, {
    interrupt: async () => { note('interrupt'); }, setModel: async () => {}, setPermissionMode: async () => {}, supportedCommands: async () => [],
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
const APP = 'apaki-dev-follow-test';

/**
 * A real relay on loopback: the PC's socket and the phones' sockets, with the relay's control messages and the connection-id framing
 * the PC expects (relay/src/index.js; the same behaviour as the in-memory relay above). Plain HTTP requests get a 500, so the PC's
 * page check says "unreachable" at once and a code can be shown with "Pair without checking the page".
 */
async function startRelay(t) {
  const server = http.createServer((req, res) => { res.statusCode = 500; res.end('no page here'); });
  const wss = new WebSocketServer({ server, handleProtocols: () => 'apaki.v1' });
  const st = { pc: null, phones: new Map(), next: 1 };
  wss.on('connection', (sock, req) => {
    const m = /\/rooms\/([^/]+)\/(pc|phone)$/.exec(String(req.url).split('?')[0]);
    if (!m) { sock.close(); return; }
    if (m[2] === 'pc') {
      st.pc?.close();
      st.pc = sock;
      sock.send(JSON.stringify({ t: 'ready', role: 'pc', phones: [...st.phones.keys()], limits: {} }));
      sock.on('message', (data, isBinary) => {
        if (!isBinary) {
          const text = data.toString();
          if (text === 'ping') { sock.send('pong'); return; }
          try { const j = JSON.parse(text); if (j.t === 'kick') st.phones.get(j.conn)?.close(); } catch { /* not a control message */ }
          return;
        }
        const { connId, payload } = decodePcFrame(new Uint8Array(data));
        st.phones.get(connId)?.send(payload);
      });
      sock.on('close', () => { if (st.pc === sock) st.pc = null; });
    } else {
      const conn = st.next++;
      st.phones.set(conn, sock);
      sock.on('message', (data, isBinary) => { if (isBinary && st.pc) st.pc.send(encodePcFrame(conn, new Uint8Array(data))); });
      sock.on('close', () => { st.phones.delete(conn); st.pc?.send(JSON.stringify({ t: 'leave', conn })); });
      st.pc?.send(JSON.stringify({ t: 'join', conn }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); });
  return { port: server.address().port };
}

/** Starts engine.js --host in a temp world (isolated, no Glass, no index, no keeper) pointed at the loopback relay; resolves once its host file names it. */
async function startWorld(t) {
  const dir = tmp();
  const claude = path.join(dir, 'claude');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-agent-sdk.mjs'), FAKE_SDK);
  fs.writeFileSync(path.join(fake, 'hooks.mjs'), HOOKS);
  fs.writeFileSync(path.join(fake, 'loader.mjs'), LOADER);
  const relay = await startRelay(t);
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const queries = path.join(dir, 'queries.log');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), APAKI_REMOTE_PROTECT: 'file', APAKI_RELAY_URL: `ws://127.0.0.1:${relay.port}`, APAKI_WEB_URL: `http://127.0.0.1:${relay.port}/`,
    LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
    FAKE_QUERY_LOG: queries,
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
  const lines = () => { try { return fs.readFileSync(queries, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { child, file, dir, claude, relay, log: () => log, queries: () => lines().filter((l) => l.startsWith('query')), interrupts: () => lines().filter((l) => l === 'interrupt') };
}

const windowOf = async (h) => {
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });
  // A wait that times out says what it waited for and where, so a failure points at its step.
  const wait = w.next;
  w.next = (pred, ms, from) => {
    const site = (new Error().stack.split('\n')[2] || '').trim();
    return wait.call(w, pred, ms, from).catch((e) => { throw new Error(`${e.message}: ${String(pred).slice(0, 160)} ${site}`); });
  };
  return w;
};

/** A phone socket on the loopback relay, with the next() and send() the phone client above expects. */
async function phoneSocket(url) {
  const ws = new WsClient(url, 'apaki.v1');
  const ph = { inbox: [], waiters: [], gone: false, ws };
  ph.wake = () => { for (const r of ph.waiters.splice(0)) r(); };
  ph.send = (frame) => ws.send(frame);
  ph.next = async (ms = 4000) => {
    const end = Date.now() + ms;
    while (!ph.inbox.length) {
      if (Date.now() > end) throw new Error('no frame for the phone');
      await new Promise((r) => { ph.waiters.push(r); setTimeout(r, 50); });
    }
    return ph.inbox.shift();
  };
  ws.on('message', (data, isBinary) => { if (isBinary) { ph.inbox.push(new Uint8Array(data)); ph.wake(); } });
  ws.on('close', () => { ph.gone = true; ph.wake(); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ph;
}

/** Turns phone access on in the engine, shows a code (unchecked: the page check cannot reach a site here), pairs a phone through Allow with this access. */
async function pairWithEngine(h, w, { name = 'E2E iPhone', cap } = {}) {
  const from = w.events.length;
  w.send({ op: 'remoteEnable', reqId: 'enable' });
  await w.next((m) => m.ev === 'remote' && m.state === 'online', 20000, from);
  w.send({ op: 'remotePairStart', reqId: 'code', unchecked: true });
  const withCode = await w.next((m) => m.ev === 'remote' && m.pairing?.url, 30000, from);
  const offer = parsePairingUrl(withCode.pairing.url);
  const device = await createDeviceIdentity();
  const ph = await phoneSocket(roomUrl(offer.relay, offer.roomId, 'phone'));
  const phone = await phoneClient(ph, new PhoneSession({ device, offer, name }));
  await phone.pump(() => phone.sas, 10000);
  await w.next((m) => m.ev === 'remote' && m.request?.sas === phone.sas, 15000, from);
  w.send({ op: 'remotePairDecision', approve: true, ...(cap ? { cap } : {}) });
  await phone.pump(() => phone.pairing && phone.ready(), 15000);
  return { phone, ph, deviceId: phone.pairing.deviceId };
}

/** What a saved workspace of the window looks like with these leaves (a split holding them, one tab). */
const layout = (leaves) => ({ v: 1, savedAt: 1, active: 0, tabs: [{ focused: leaves[0].pane, root: { type: 'split', children: leaves.map((l) => ({ type: 'leaf', ...l })) } }] });

test('end to end: a phone follows a pane of the real engine; the window keeps its one Claude Code; the first answer wins; a restricted phone only reads', { timeout: 240000 }, async (t) => {
  const h = await startWorld(t);
  const w = await windowOf(h);
  const wEvents = (from, pred) => w.events.slice(from).filter(pred);

  // The desktop: pane pA runs a conversation (its Claude Code is started), pB is a new pane with no process yet. The saved layout also
  // holds a viewer, and private things (a draft, a queued message) that must never reach a phone.
  w.send({ op: 'open', reqId: 'oA', paneId: 'pA', sessionId: null, cwd: h.dir, warm: true });
  await w.next((m) => m.ev === 'opened' && m.reqId === 'oA');
  w.send({ op: 'send', reqId: 'sA1', paneId: 'pA', text: 'hello desk' });
  const sidA = (await w.next((m) => m.ev === 'session_id' && m.paneId === 'pA')).sessionId;
  await w.next((m) => m.ev === 'result' && m.reqId === 'sA1');
  w.send({ op: 'open', reqId: 'oB', paneId: 'pB', sessionId: null, cwd: h.dir, warm: false });
  await w.next((m) => m.ev === 'opened' && m.reqId === 'oB');
  w.send({ op: 'saveState', state: layout([
    { pane: 'pA', s: sidA, title: 'Desk', busy: false, draft: 'PRIVATE DRAFT', queue: [{ id: 'q9', text: 'PRIVATE QUEUED' }] },
    { pane: 'pB', draft: '' },
    { pane: 'v1', artifact: { title: 'Plan.md' } },
  ]) });
  assert.equal(h.queries().length, 1, 'one Claude Code so far: the window\'s pane pA');

  // A phone pairs through the real bridge and sees the desktop's tabs, with the pane ids and without the private things.
  const p = await pairWithEngine(h, w, { name: 'E2E iPhone' });
  const { phone, deviceId } = p;
  await phone.pump(() => phone.got('desktopTabs').some((e) => e.tabs[0]?.panes.some((x) => x.paneId === 'pA')), 10000);
  const tabs = phone.got('desktopTabs').at(-1).tabs;
  assert.deepEqual(tabs[0].panes.map((x) => [x.paneId, x.kind]), [['pA', 'session'], ['pB', 'session'], ['v1', 'viewer']]);
  assert.ok(phone.wire('hello')[0].features.includes('follow'));
  assert.ok(!JSON.stringify(phone.events).includes('PRIVATE'), 'a draft and a queued message stay on the PC');

  // Not everything can be followed.
  const refusedFor = async (reqId) => { await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === reqId), 10000); return phone.events.find((e) => e.refused && e.reqId === reqId).message; };
  await phone.cmd({ op: 'follow', reqId: 'x1', paneId: 'fv', desktopPaneId: 'v1' });
  assert.match(await refusedFor('x1'), /Only a conversation can be followed/);
  await phone.cmd({ op: 'follow', reqId: 'x2', paneId: 'fv', desktopPaneId: 'p99' });
  assert.match(await refusedFor('x2'), /not open on the desktop/);

  // Follow pA: its state and history come first, the window hears who watches, and nothing is taken over or started.
  let wFrom = w.events.length;
  await phone.cmd({ op: 'follow', reqId: 'f1r', paneId: 'f1', desktopPaneId: 'pA' });
  await phone.pump(() => phone.got('history', 'f1').length === 1, 10000);
  const opened = phone.got('opened', 'f1')[0];
  assert.deepEqual([opened.reqId, opened.attached, opened.follower, opened.readOnly, opened.sessionId, opened.busy, opened.running], ['f1r', true, true, false, sidA, false, true]);
  assert.equal(opened.queue, undefined, 'the window\'s queue is not part of it');
  assert.ok(JSON.stringify(phone.got('history', 'f1')[0].messages).includes('echo: hello desk'), 'the conversation so far');
  assert.deepEqual((await w.next((m) => m.ev === 'followers' && m.paneId === 'pA', 10000, wFrom)).phones, ['E2E iPhone']);
  assert.deepEqual(wEvents(wFrom, (m) => ['taken_over', 'locked', 'open_elsewhere'].includes(m.ev)), [], 'the desktop pane was not taken over or locked');
  assert.equal(h.queries().length, 1, 'no second Claude Code process');

  // The window sends: the phone gets the pane's stream under its own pane id, and the message itself (the engine does not echo it).
  let pFrom = phone.events.length;
  wFrom = w.events.length;
  w.send({ op: 'send', reqId: 'sA2', paneId: 'pA', text: 'again' });
  await w.next((m) => m.ev === 'result' && m.reqId === 'sA2', 10000, wFrom);
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'result' && e.paneId === 'f1'), 10000);
  const live = phone.events.slice(pFrom);
  assert.equal(live.find((e) => e.ev === 'result').result, 'echo: again');
  assert.equal(live.find((e) => e.ev === 'result').reqId, undefined);
  assert.ok(live.some((e) => e.ev === 'sdk' && e.paneId === 'f1' && e.msg.type === 'assistant'));
  const desk = live.find((e) => e.ev === 'peerMessage');
  assert.deepEqual([desk.paneId, desk.from, desk.text], ['f1', 'Desktop', 'again']);
  assert.equal(wEvents(wFrom, (m) => m.ev === 'peerMessage').length, 0, 'the window drew its own message; it is not told about it');
  assert.ok(!JSON.stringify(phone.events.filter((e) => e.ev !== 'desktopTabs')).includes('"pA"'), 'the phone only ever hears its own pane id');

  // The phone sends, with full access: it lands in the desktop pane, the window sees it, and the one Claude Code answers.
  pFrom = phone.events.length;
  wFrom = w.events.length;
  await phone.cmd({ op: 'send', reqId: 's1', paneId: 'f1', text: 'from the phone' });
  const typed = await w.next((m) => m.ev === 'peerMessage', 10000, wFrom);
  assert.deepEqual([typed.paneId, typed.from, typed.text, typed.steered], ['pA', 'E2E iPhone', 'from the phone', false]);
  const done = await w.next((m) => m.ev === 'result' && m.paneId === 'pA' && m.result === 'echo: from the phone', 10000, wFrom);
  assert.equal(done.sessionId, sidA);
  assert.ok(done.reqId == null, 'the window gets the result like one of its own');
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'result' && e.paneId === 'f1'), 10000);
  assert.equal(phone.events.slice(pFrom).some((e) => e.ev === 'peerMessage'), false, 'its own message is not echoed back to it');
  assert.equal(h.queries().length, 1);

  // Steering a running turn, and interrupting it.
  wFrom = w.events.length;
  w.send({ op: 'send', reqId: 'sA3', paneId: 'pA', text: 'wait:1200 long one' });
  await w.next((m) => m.ev === 'sdk' && m.paneId === 'pA' && m.msg?.type === 'stream_event', 10000, wFrom);
  await phone.cmd({ op: 'steer', reqId: 'st1', paneId: 'f1', qid: 'qq1', text: 'steer words' });
  await phone.pump(() => phone.events.some((e) => e.ev === 'steered' && e.qid === 'qq1' && e.paneId === 'f1' && e.reqId === 'st1'), 10000);
  const steered = await w.next((m) => m.ev === 'peerMessage' && m.steered === true, 10000, wFrom);
  assert.deepEqual([steered.paneId, steered.text, steered.from], ['pA', 'steer words', 'E2E iPhone']);
  // The fake answers a steered message as a turn of its own (the real Claude Code folds it into the running one): that result is an sdk message.
  await w.next((m) => m.ev === 'sdk' && m.paneId === 'pA' && m.msg?.type === 'result' && m.msg.result === 'echo: steer words', 15000, wFrom);
  wFrom = w.events.length;
  w.send({ op: 'send', reqId: 'sA4', paneId: 'pA', text: 'wait:600 stop me' });
  await w.next((m) => m.ev === 'sdk' && m.paneId === 'pA' && m.msg?.type === 'stream_event', 10000, wFrom);
  await phone.cmd({ op: 'interrupt', reqId: 'in1', paneId: 'f1' });
  await until(() => h.interrupts().length === 1, 10000);
  await w.next((m) => m.ev === 'result' && m.result === 'echo: wait:600 stop me', 15000, wFrom);

  // The meter and paging answer the phone alone, under its own pane id.
  wFrom = w.events.length;
  await phone.cmd({ op: 'contextUsage', reqId: 'cu1', paneId: 'f1' });
  await phone.pump(() => phone.events.some((e) => e.ev === 'context' && e.reqId === 'cu1'), 10000);
  const meter = phone.events.find((e) => e.ev === 'context' && e.reqId === 'cu1');
  assert.deepEqual([meter.paneId, meter.percentage], ['f1', 1]);
  await phone.cmd({ op: 'historyBefore', reqId: 'hb1', paneId: 'f1', sessionId: sidA, before: '11111111-2222-3333-4444-555555555555' });
  await phone.pump(() => phone.events.some((e) => e.ev === 'historyPage' && e.reqId === 'hb1'), 10000);
  assert.equal(phone.events.find((e) => e.ev === 'historyPage' && e.reqId === 'hb1').paneId, 'f1');
  assert.equal(wEvents(wFrom, (m) => m.ev === 'context' || m.ev === 'historyPage').length, 0, 'answers to the phone\'s requests are not the window\'s');

  // A question: answered on the phone, the window's sheet goes (ask_gone); answered on the window, the phone's goes. First answer wins.
  wFrom = w.events.length;
  w.send({ op: 'send', reqId: 'sA5', paneId: 'pA', text: 'ask:one' });
  const q1 = await w.next((m) => m.ev === 'ask' && m.paneId === 'pA', 10000, wFrom);
  await phone.pump(() => phone.events.some((e) => e.ev === 'ask' && e.askId === q1.askId), 10000);
  const phoneQ1 = phone.events.find((e) => e.ev === 'ask' && e.askId === q1.askId);
  assert.deepEqual([phoneQ1.paneId, phoneQ1.readOnly, phoneQ1.toolName], ['f1', false, 'AskUserQuestion']);
  await phone.cmd({ op: 'answer', askId: q1.askId, result: { behavior: 'allow', updatedInput: { ...q1.input, answers: { 'Which one?': 'A' } } } });
  await w.next((m) => m.ev === 'ask_gone' && m.askId === q1.askId, 10000, wFrom);
  assert.equal((await w.next((m) => m.ev === 'result' && m.paneId === 'pA' && /^asked one/.test(m.result || ''), 10000, wFrom)).result, 'asked one: {"Which one?":"A"}');
  wFrom = w.events.length;
  pFrom = phone.events.length;
  w.send({ op: 'send', reqId: 'sA6', paneId: 'pA', text: 'ask:two' });
  const q2 = await w.next((m) => m.ev === 'ask' && m.paneId === 'pA', 10000, wFrom);
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'ask' && e.askId === q2.askId), 10000);
  w.send({ op: 'answer', askId: q2.askId, result: { behavior: 'deny', message: 'no thanks' } });
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'ask_gone' && e.askId === q2.askId && e.paneId === 'f1'), 10000);
  assert.equal((await w.next((m) => m.ev === 'result' && m.paneId === 'pA' && /^denied two/.test(m.result || ''), 10000, wFrom)).result, 'denied two');
  // Too late is harmless: the phone's answer to a question that is gone is refused, and nothing else happens.
  await phone.cmd({ op: 'answer', reqId: 'late', askId: q2.askId, result: { behavior: 'allow' } });
  await phone.pump(() => phone.events.some((e) => e.refused && /another window/.test(e.message)), 10000);

  // Set to No shell on the PC, the phone keeps watching but cannot drive (and the PC says why); then Chat only; then Full again.
  const setCap = async (cap) => {
    const from = w.events.length;
    w.send({ op: 'remoteDeviceCap', deviceId, cap });
    await w.next((m) => m.ev === 'remote' && m.devices?.find((d) => d.id === deviceId)?.cap === cap, 10000, from);
    await phone.pump(() => phone.wire('cap').at(-1)?.cap === cap, 10000);
  };
  await setCap('noshell');
  wFrom = w.events.length;
  pFrom = phone.events.length;
  w.send({ op: 'send', reqId: 'sA7', paneId: 'pA', text: 'ask:three' });
  const q3 = await w.next((m) => m.ev === 'ask' && m.paneId === 'pA', 10000, wFrom);
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'ask' && e.askId === q3.askId && e.readOnly === true), 10000);
  const refuse = async (cmd) => {
    const reqId = `ro-${cmd.op}`;
    await phone.cmd({ ...cmd, reqId });
    await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === reqId), 10000);
    const e = phone.events.find((x) => x.refused && x.reqId === reqId);
    assert.equal(e.readOnly, true, cmd.op);
    assert.match(e.message, /set to (No shell|Chat only) on the PC.*desktop's own permissions and tools/, cmd.op);
  };
  const quiet = w.events.length;
  await refuse({ op: 'send', paneId: 'f1', text: 'do something' });
  await refuse({ op: 'steer', paneId: 'f1', qid: 'qq2', text: 'do it now' });
  await refuse({ op: 'interrupt', paneId: 'f1' });
  await phone.cmd({ op: 'answer', reqId: 'ro-answer', askId: q3.askId, result: { behavior: 'allow', updatedInput: { ...q3.input, answers: { 'Which three?': 'A' } } } });
  await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === 'ro-answer' && e.readOnly && /answer its questions/.test(e.message)), 10000);
  assert.equal(wEvents(quiet, (m) => m.ev === 'peerMessage' || m.ev === 'ask_gone').length, 0, 'nothing a restricted phone sent reached the desktop pane');
  assert.equal(h.interrupts().length, 1, 'and it did not interrupt');
  // The window answers; the phone, though read only, hears the pane's events.
  pFrom = phone.events.length;
  w.send({ op: 'answer', askId: q3.askId, result: { behavior: 'allow', updatedInput: { ...q3.input, answers: { 'Which three?': 'B' } } } });
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'ask_gone' && e.askId === q3.askId) && phone.events.slice(pFrom).some((e) => e.ev === 'result' && e.paneId === 'f1'), 10000);
  await phone.cmd({ op: 'contextUsage', reqId: 'ro-meter', paneId: 'f1' });
  await phone.pump(() => phone.events.some((e) => e.ev === 'context' && e.reqId === 'ro-meter'), 10000);
  await setCap('chat');
  await phone.cmd({ op: 'send', reqId: 'ro-chat', paneId: 'f1', text: 'chat only?' });
  await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === 'ro-chat' && /set to Chat only on the PC/.test(e.message)), 10000);
  await setCap('full');
  wFrom = w.events.length;
  await phone.cmd({ op: 'send', reqId: 'full-again', paneId: 'f1', text: 'full again' });
  await w.next((m) => m.ev === 'result' && m.result === 'echo: full again', 10000, wFrom);
  assert.equal(h.queries().length, 1, 'still the window\'s one Claude Code for pA');

  // A second desktop pane, with no process yet: follow it, then unfollow; its events stop and the window's line goes.
  wFrom = w.events.length;
  await phone.cmd({ op: 'follow', reqId: 'f2r', paneId: 'f2', desktopPaneId: 'pB' });
  await phone.pump(() => phone.got('opened', 'f2').length === 1, 10000);
  assert.deepEqual([phone.got('opened', 'f2')[0].sessionId, phone.got('opened', 'f2')[0].running], [null, false]);
  assert.deepEqual((await w.next((m) => m.ev === 'followers' && m.paneId === 'pB', 10000, wFrom)).phones, ['E2E iPhone']);
  w.send({ op: 'send', reqId: 'sB1', paneId: 'pB', text: 'hello B' });
  await phone.pump(() => phone.events.some((e) => e.ev === 'result' && e.paneId === 'f2'), 10000);
  assert.equal(h.queries().length, 2, 'pB\'s Claude Code was started by the window\'s send, and by nothing else');
  await phone.cmd({ op: 'unfollow', reqId: 'u1', paneId: 'f2' });
  await phone.pump(() => phone.events.some((e) => e.ev === 'closed' && e.paneId === 'f2' && e.reqId === 'u1'), 10000);
  assert.deepEqual((await w.next((m) => m.ev === 'followers' && m.paneId === 'pB' && m.phones.length === 0, 10000, wFrom)).phones, []);
  pFrom = phone.events.length;
  wFrom = w.events.length;
  w.send({ op: 'send', reqId: 'sB2', paneId: 'pB', text: 'after unfollow' });
  await w.next((m) => m.ev === 'result' && m.reqId === 'sB2', 10000, wFrom);
  await sleep(300);
  assert.equal(phone.events.slice(pFrom).filter((e) => e.paneId === 'f2').length, 0, 'unfollow stopped the delivery');

  // The desktop pane closes: the follower hears closed, and a send to it is refused.
  pFrom = phone.events.length;
  w.send({ op: 'close', reqId: 'cA', paneId: 'pA' });
  await phone.pump(() => phone.events.slice(pFrom).some((e) => e.ev === 'closed' && e.paneId === 'f1'), 10000);
  await phone.cmd({ op: 'send', reqId: 'gone', paneId: 'f1', text: 'anyone?' });
  await phone.pump(() => phone.events.some((e) => e.refused && e.reqId === 'gone' && /not open on the PC/.test(e.message)), 10000);
  await phone.cmd({ op: 'follow', reqId: 'f3r', paneId: 'f3', desktopPaneId: 'pA' });
  assert.match(await refusedFor('f3r'), /not open on the desktop/);

  // Through all of it: two Claude Code processes, the window's own (pA and pB); the phone started none, and took nothing over.
  assert.equal(h.queries().length, 2);
  assert.equal(h.queries().every((l) => l === 'query new'), true, 'no process resumed a session for the phone');
  assert.equal(w.events.some((m) => ['taken_over', 'locked', 'open_elsewhere'].includes(m.ev)), false);
  w.close();
});
