/**
 * Phone access hardening (2026-10-10, apaki/SECURITY.md 4.4 and 5; Arthur:
 * "its important that we have that secure and private option"; then
 * "make sure users can login on apaki to see their connected machines!"):
 *   - capabilities: what a phone may make Claude do (full, noshell, chat),
 *     in the policy (remote-policy.js) and in the options every phone pane's
 *     Claude Code gets (capRunnerOptions, capPreToolUse, capCanUseTool
 *     through src/runner.js buildOptions);
 *   - Connected (the default) and Private (opt-in), saved and rebuilt;
 *   - account-link held for an Allow on the PC, refused in Private;
 *   - the page check fails closed, with the explicit unchecked escape hatch;
 *   - the hourly re-check with phone browser headers turns phone access off
 *     on a changed page and keeps the reason;
 *   - the relay's fair-share close codes on the PC (remote.js) and on the
 *     phone (apaki/web/src/link.js, from a real web build).
 * The in-memory relay and phone helpers follow apaki-remote-durable.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PhoneSession, RELAY_CLOSE, createDeviceIdentity, decodePcFrame, encodePcFrame, parsePairingUrl, b64urlDecode, b64urlEncode, randomBytes } from '../apaki/remote/protocol.js';
import { Inbox, Outbox } from '../apaki/remote/wire.js';
import {
  APAKI_BROWSER_TOOLS, CAPS, CAP_BLOCKED_TOOLS, capBlocksTool, capCanUseTool, capDefaultMode, capModes, capOf, capPreToolUse, capRunnerOptions,
  checkPhoneCommand, clampMode, parsePhoneId, phonePaneId,
} from '../apaki/engine/remote-policy.js';
import { BROWSER_TOOLS } from '../apaki/engine/browser-tools.js';
import * as store from '../apaki/engine/remote-store.js';
import { RemoteBridge, budgetShareText, capChoice } from '../apaki/engine/remote.js';
import { browserHeaders, checkPage, pageText, PHONE_AGENTS } from '../apaki/engine/remote-page.js';
import { SessionRunner } from '../src/runner.js';
import { build } from '../apaki/scripts/build-web.mjs';

const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-caps-test-'));
  const before = process.env.APAKI_REMOTE_PROTECT;
  process.env.APAKI_REMOTE_PROTECT = 'file';
  try { await fn(dir); } finally {
    if (before === undefined) delete process.env.APAKI_REMOTE_PROTECT; else process.env.APAKI_REMOTE_PROTECT = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------ relay, phone, bridge helpers */

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
  relay.bye = (code) => emitTo(relay.pc, 'message', { data: JSON.stringify({ t: 'bye', code }) });
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

async function phoneClient(ph, session) {
  const inbox = new Inbox();
  const c = { session, events: [], sas: null, pairing: null, alerts: [] };
  c.pump = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('phone gave up waiting');
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
  ph.send(await session.start());
  return c;
}

function bridgeFor(relay, dir, extra = {}) {
  const desktop = [];
  const dispatched = [];
  const panes = new Map();
  const capChanges = [];
  const b = new RemoteBridge({
    emit: (e) => desktop.push(e),
    dispatch: (c) => { dispatched.push(c); if (c.op === 'open' || c.op === 'attach') panes.set(c.paneId, { sessionId: c.sessionId, running: true, busy: false, mode: c.mode || 'default' }); if (c.op === 'close') panes.delete(c.paneId); },
    readyEvent: () => ({ ev: 'ready', model: 'claude-opus-5-5', mode: 'bypassPermissions' }),
    engine: {
      paneExists: (id) => panes.has(id),
      paneCount: (dev) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev).length,
      phonePanes: (dev) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === dev),
      paneInfo: (id) => panes.get(id) || null,
      askPane: () => null,
      knownCwd: () => false,
      phoneSessions: () => [],
      hasOp: () => false,
      capChanged: (deviceId, cap) => capChanges.push({ deviceId, cap }),
    },
    dir,
    WebSocket: relay.WS,
    relay: 'ws://127.0.0.1:9',
    web: 'http://127.0.0.1:9/',
    pcName: 'Test PC',
    // The re-check's pause before its confirming fetch (20 s in the app) kept short here.
    recheckPauseMs: 10,
    log: () => {},
    pageCheck: false,
    recheckFirstMs: 3_600_000,
    ...extra,
  });
  return { b, desktop, dispatched, panes, capChanges, last: () => desktop[desktop.length - 1] };
}

async function pairPhone({ b, last }, relay, { name = 'Phone', cap } = {}) {
  await b.op({ op: 'remotePairStart' });
  const ph = relay.phone();
  await until(() => b.conns.has(ph.conn));
  const device = await createDeviceIdentity();
  const phone = await phoneClient(ph, new PhoneSession({ device, offer: parsePairingUrl(last().pairing.url), name }));
  await phone.pump(() => phone.sas);
  await until(() => last().request);
  await b.op({ op: 'remotePairDecision', approve: true, ...(cap ? { cap } : {}) });
  await phone.pump(() => phone.pairing && phone.events.some((e) => e.ev === 'ready'));
  return { ph, device, phone, pairing: JSON.parse(JSON.stringify(phone.pairing)), hello: phone.wire('hello')[0] };
}

/**
 * The version 2 via of ENROLL.md: the phone's own key signs "apaki/v1 via" || the connection's nonce || its public key || its name.
 * An account connection is held after hello until this arrives and the PC lets the phone in.
 */
async function viaMessage(key, nonce, name = 'Phone') {
  const bytes = (b64) => b64urlDecode(b64);
  const data = new Uint8Array([...new TextEncoder().encode('apaki/v1 via'), ...bytes(nonce), ...key.pub, ...new TextEncoder().encode(name)]);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, data));
  return { t: 'via', name, pub: b64urlEncode(key.pub), sig: b64urlEncode(sig) };
}

/** A saved phone connecting again. via: { key, name } sends a version 2 via once hello arrives (an account connection needs one); it ends on ready, phone-wait or an alert. */
async function reconnect(b, relay, device, pairing, via = null) {
  const ph = relay.phone();
  await until(() => b.conns.has(ph.conn));
  const c = await phoneClient(ph, new PhoneSession({ device, pairing }));
  if (via) {
    await c.pump(() => c.wire('hello').length || c.alerts.length);
    const hello = c.wire('hello')[0];
    if (hello) await c.out.send(await viaMessage(via.key, hello.nonce, via.name || 'Phone'));
  }
  await c.pump(() => c.events.some((e) => e.ev === 'ready') || c.wire('phone-wait').length || c.alerts.length);
  return { ph, c };
}

/* ---------------------------------------------------------------- policy */

test('caps: what each capability allows, failing closed on anything unknown', () => {
  assert.deepEqual(CAPS, ['full', 'noshell', 'chat']);
  assert.equal(capOf({ id: 'x' }), 'full', 'a record from before capabilities keeps full');
  assert.equal(capOf({ cap: 'noshell' }), 'noshell');
  assert.equal(capOf({ cap: 'root' }), 'chat', 'an unknown value is the narrowest');
  assert.equal(capOf(null), 'chat', 'a phone no longer paired');
  assert.ok(capModes('full').includes('bypassPermissions'));
  assert.ok(!capModes('noshell').includes('bypassPermissions') && capModes('noshell').includes('acceptEdits'));
  assert.deepEqual(capModes('chat'), ['plan']);
  assert.equal(capDefaultMode('full'), 'default', 'never the desktop default (bypassPermissions)');
  assert.equal(clampMode('noshell', 'bypassPermissions'), 'default');
  assert.equal(clampMode('chat', 'acceptEdits'), 'plan');
  for (const t of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__apaki__browser_click', 'mcp__github__push', 'mcp__desktop-commander__run']) {
    assert.equal(capBlocksTool('noshell', t), true, t);
    assert.equal(capBlocksTool('chat', t), true, t);
    assert.equal(capBlocksTool('full', t), false, t);
  }
  for (const t of ['Read', 'Grep', 'Glob', 'WebSearch', 'Task', 'mcp__apaki__show']) assert.equal(capBlocksTool('noshell', t), false, t);
  // The browser tool list here matches browser-tools.js.
  assert.deepEqual([...APAKI_BROWSER_TOOLS].sort(), BROWSER_TOOLS.map((t) => `mcp__apaki__${t}`).sort());
  assert.equal(capChoice(undefined), 'full', 'an older window sends none');
  assert.throws(() => capChoice('admin'), /Full, No shell, Chat only/);
});

test('policy: a chat phone stays in plan mode; a no-shell phone cannot bypass permissions; open is clamped, mode changes refused', () => {
  const base = { deviceId: DEV, paneExists: () => true, paneCount: () => 0 };
  const open = (cap, mode) => checkPhoneCommand({ op: 'open', paneId: 'p1', mode }, { ...base, paneExists: () => false, cap });
  assert.equal(open('chat', 'bypassPermissions').cmd.mode, 'plan', 'an older page always asks for bypassPermissions: clamped, not refused');
  assert.equal(open('noshell', 'bypassPermissions').cmd.mode, 'default');
  assert.equal(open('noshell', 'acceptEdits').cmd.mode, 'acceptEdits');
  assert.equal(open('full', 'bypassPermissions').cmd.mode, 'bypassPermissions');
  const mode = (cap, m) => checkPhoneCommand({ op: 'mode', paneId: 'p1', mode: m }, { ...base, cap });
  for (const m of ['bypassPermissions', 'acceptEdits', 'default']) assert.equal(mode('chat', m).ok, false, m);
  assert.equal(mode('chat', 'plan').ok, true);
  assert.equal(mode('noshell', 'bypassPermissions').ok, false);
  assert.match(mode('noshell', 'bypassPermissions').error, /No shell/);
  assert.equal(mode('noshell', 'default').ok, true);
  assert.equal(mode('full', 'bypassPermissions').ok, true);
  assert.equal(mode('weird', 'default').ok, false, 'an unknown capability is chat');
  assert.equal(checkPhoneCommand({ op: 'mode', paneId: 'p1', mode: 'bypassPermissions' }, base).ok, true, 'callers from before capabilities: full');
});

test('engine options: a restricted phone pane loses shell, edit and browser tools, in every mode, and a chat pane cannot carry out a plan', async () => {
  const allow = async (_n, input) => ({ behavior: 'allow', updatedInput: input });
  const make = (cap, mode) => {
    const o = capRunnerOptions(cap, mode);
    return new SessionRunner({ cwd: os.tmpdir(), env: {}, permissionMode: o.permissionMode, disallowedTools: o.disallowedTools, allowedTools: o.allowedTools, hooks: { PreToolUse: [capPreToolUse(() => cap)] }, canUseTool: capCanUseTool(() => cap, allow), onMessage: () => {} }).buildOptions();
  };
  const ns = make('noshell', 'bypassPermissions');
  assert.equal(ns.permissionMode, 'default', 'bypassPermissions is not kept');
  assert.deepEqual(ns.disallowedTools, [...CAP_BLOCKED_TOOLS]);
  assert.deepEqual(ns.allowedTools, ['Grep', 'Glob'], 'search still works without Bash');
  const hook = ns.hooks.PreToolUse[0].hooks[0];
  assert.equal((await hook({ tool_name: 'Bash', tool_input: { command: 'calc' } })).hookSpecificOutput.permissionDecision, 'deny', 'the hook holds where canUseTool is never asked');
  assert.deepEqual(await hook({ tool_name: 'Read' }), {});
  assert.equal((await ns.canUseTool('Write', {})).behavior, 'deny');
  assert.equal((await ns.canUseTool('mcp__someone__exec', {})).behavior, 'deny');
  assert.equal((await ns.canUseTool('Read', { file_path: 'x' })).behavior, 'allow');
  const chat = make('chat', 'acceptEdits');
  assert.equal(chat.permissionMode, 'plan');
  assert.equal((await chat.canUseTool('ExitPlanMode', {})).behavior, 'deny', 'a plan cannot be carried out from a chat phone');
  const full = make('full', 'bypassPermissions');
  assert.equal(full.permissionMode, 'bypassPermissions');
  assert.equal(full.disallowedTools, undefined);
  assert.equal((await full.canUseTool('Bash', {})).behavior, 'allow');
  // The access is read on every call: tightening applies to a running pane at once.
  let live = 'full';
  const h = capPreToolUse(() => live).hooks[0];
  assert.deepEqual(await h({ tool_name: 'Bash' }), {});
  live = 'noshell';
  assert.equal((await h({ tool_name: 'Bash' })).hookSpecificOutput.permissionDecision, 'deny');
});

/* ------------------------------------------------------------- the store */

test('store: Connected by default (new and older installs); a Private choice, the alarm and each phone\'s access survive, in both files', async () => {
  await withDir(async (dir) => {
    assert.equal(store.loadState(dir).mode, 'connected', 'a new install');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ v: 1, enabled: true, roomId: 'r', devices: [{ id: DEV, pub: 'p', name: 'n' }] }));
    assert.equal(store.loadState(dir).mode, 'connected', 'a state.json from before modes, with no account device');
    store.saveState({ v: 1, enabled: true, mode: 'private', pageAlarm: { at: '2026-10-10T00:00:00Z', text: 'changed', files: ['app.js'], of: 40 }, roomId: 'r', pcPub: 'p', createdAt: null, devices: [{ id: DEV, pub: 'p', name: 'n', pairedAt: 't', cap: 'chat' }] }, dir);
    const s = store.loadState(dir);
    assert.equal(s.mode, 'private');
    assert.equal(s.pageAlarm.text, 'changed');
    assert.equal(s.devices[0].cap, 'chat');
    await store.saveSecret({ identity: { pub: 'p', jwk: {} }, token: 't', psks: {}, devices: s.devices, mode: 'private' }, dir);
    const sec = await store.loadSecret(dir);
    assert.equal(sec.mode, 'private', 'a rebuilt state.json keeps Private');
    assert.equal(sec.devices[0].cap, 'chat', 'and never widens a phone');
    assert.match(fs.readFileSync(path.join(dir, '_WHY_THIS_IS_HERE.md'), 'utf8'), /pages\.json/);
  });
});

/* ------------------------------------------------- the bridge: caps and modes */

test('bridge: access chosen at Allow is enforced on the phone\'s commands; a change reaches the phone and the engine', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const br = bridgeFor(relay, dir);
    const { b, dispatched, panes, last } = br;
    try {
      await b.op({ op: 'remoteEnable' });
      await until(() => b.status === 'online');
      const p = await pairPhone(br, relay, { name: 'Chat phone', cap: 'chat' });
      assert.equal(p.hello.cap, 'chat');
      assert.equal(p.phone.events.find((e) => e.ev === 'ready').mode, 'plan', 'the ready event names the phone\'s mode, not the desktop\'s');
      const id = p.pairing.deviceId;
      assert.equal(last().devices.find((d) => d.id === id).cap, 'chat');
      await p.phone.cmd({ op: 'open', reqId: 'r1', paneId: 'p1', sessionId: null, mode: 'bypassPermissions' });
      await until(() => dispatched.length === 1);
      assert.equal(dispatched[0].mode, 'plan');
      panes.get(phonePaneId(id, 'p1')).mode = 'plan';
      await p.phone.cmd({ op: 'mode', reqId: 'r2', paneId: 'p1', mode: 'default' });
      await p.phone.pump(() => p.phone.events.some((e) => e.refused && e.reqId === 'r2'));
      await p.phone.pump(() => p.phone.events.some((e) => e.ev === 'settings' && e.mode === 'plan'));
      assert.equal(dispatched.length, 1, 'the mode change did not run');
      // The engine's opened event: the phone hears the real mode and what this phone may do.
      b.route({ ev: 'opened', reqId: `phone:${id}:r1`, paneId: phonePaneId(id, 'p1'), sessionId: null, mode: 'plan', model: 'm', effort: 'high' });
      await p.phone.pump(() => p.phone.events.some((e) => e.ev === 'note' && /Chat only/.test(e.text)));
      // Changed on the PC: the phone hears it, the engine re-applies it, the next command follows it.
      await b.op({ op: 'remoteDeviceCap', deviceId: id, cap: 'noshell' });
      await p.phone.pump(() => p.phone.wire('cap').length);
      assert.equal(p.phone.wire('cap')[0].cap, 'noshell');
      assert.deepEqual(br.capChanges, [{ deviceId: id, cap: 'noshell' }]);
      await b.op({ op: 'remoteDeviceCap', deviceId: id, cap: 'everything', reqId: 'x' });
      assert.match(last().opError, /Full, No shell, Chat only/);
      assert.equal(b.capFor(id), 'noshell');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).devices.find((d) => d.id === id).cap, 'noshell');
    } finally { b.stop(); }
  });
});

test('bridge: Private refuses account links and pauses linked accounts (or removes them); Connected asks on the PC every time', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const br = bridgeFor(relay, dir, { linkApprovalMs: 300 });
    const { b, last } = br;
    try {
      await b.op({ op: 'remoteEnable' });
      await until(() => b.status === 'online');
      assert.equal(last().mode, 'connected', 'the default');
      const p = await pairPhone(br, relay, { name: 'Pixel' });
      const acct = await createDeviceIdentity({ extractable: true });
      const link = async (reqId, extra = {}) => {
        await p.phone.out.send({ t: 'account-link', reqId, pub: b64urlEncode(acct.pub), name: 'Arthur', wait: true, ...extra });
        await p.phone.pump(() => p.phone.wire('account-linked').some((m) => m.reqId === reqId) || p.phone.wire('pending').some((m) => m.reqId === reqId));
      };
      const answer = async (reqId) => { await p.phone.pump(() => p.phone.wire('account-linked').some((m) => m.reqId === reqId)); return p.phone.wire('account-linked').find((m) => m.reqId === reqId); };

      // An older page (no wait): refused with why, nothing held.
      await link('old', { wait: undefined });
      assert.equal((await answer('old')).code, 'old-page');
      assert.equal(last().linkRequest, null);
      // Deny on the PC.
      await link('d1');
      await until(() => last().linkRequest);
      await b.op({ op: 'remoteLinkDecision', approve: false });
      assert.match((await answer('d1')).error, /Denied/);
      // Nobody answers: refused when the time runs out.
      await link('t1');
      assert.match((await answer('t1')).error, /in time/);
      // The phone goes away while the PC asks: dropped, nothing added.
      await link('g1');
      await until(() => last().linkRequest);
      p.ph.leave();
      await until(() => !last().linkRequest);
      await b.op({ op: 'remoteLinkDecision', approve: true, reqId: 'late' });
      assert.equal(last().devices.length, 1, 'no account device without an Allow');

      // Linked with an Allow (from a fresh connection), then the PC goes Private.
      const back = await reconnect(b, relay, p.device, p.pairing);
      await back.c.out.send({ t: 'account-link', reqId: 'ok', pub: b64urlEncode(acct.pub), name: 'Arthur', wait: true });
      await until(() => last().linkRequest);
      await b.op({ op: 'remoteLinkDecision', approve: true });
      await back.c.pump(() => back.c.wire('account-linked').some((m) => m.reqId === 'ok'));
      const linked = back.c.wire('account-linked').find((m) => m.reqId === 'ok');
      assert.ok(linked.psk);
      assert.equal(last().devices.find((d) => d.kind === 'account').cap, 'full', 'the asking phone\'s access, offered first');
      const pairing = { ...p.pairing, deviceId: linked.deviceId, psk: linked.psk };
      // 2026-10-11: an account connection is held until the phone behind it proves its own key (a new phone in Connected is let in).
      const phoneKey = await createDeviceIdentity();
      const viaAcct = await reconnect(b, relay, acct, pairing, { key: phoneKey, name: 'New iPhone' });
      assert.ok(viaAcct.c.events.some((e) => e.ev === 'ready'), 'an account phone connects in Connected');

      await b.op({ op: 'remoteMode', mode: 'private' });
      assert.equal(last().mode, 'private');
      await viaAcct.c.pump(() => viaAcct.c.alerts.some((a) => a.type === 'close'));
      assert.match(viaAcct.c.alerts.find((a) => a.type === 'close').reason, /Private mode/);
      await back.c.pump(() => back.c.wire('mode').length);
      assert.equal(back.c.wire('mode')[0].mode, 'private');
      assert.ok(!back.c.wire('mode')[0].features.includes('account-ask'));
      assert.equal(last().devices.find((d) => d.kind === 'account').paused, undefined, 'kept, and no longer paused: Private lets the account connect and asks per phone');
      // A phone Connected let in by itself is asked again in Private; one never seen waits for an Allow too.
      const asked = await reconnect(b, relay, acct, pairing, { key: await createDeviceIdentity(), name: 'Another iPhone' });
      assert.equal(asked.c.wire('phone-wait').length, 1, 'a new phone in Private waits for the person at the PC');
      assert.ok(!asked.c.events.some((e) => e.ev === 'ready'));
      await back.c.out.send({ t: 'account-link', reqId: 'pv', pub: b64urlEncode(acct.pub), name: 'Arthur', wait: true });
      await back.c.pump(() => back.c.wire('account-linked').some((m) => m.reqId === 'pv'));
      assert.equal(back.c.wire('account-linked').find((m) => m.reqId === 'pv').error, 'This PC only accepts phones paired with its code.');
      const hello = (await reconnect(b, relay, p.device, p.pairing)).c.wire('hello')[0];
      assert.equal(hello.mode, 'private');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).mode, 'private');

      // Back to Connected lets the paused account in; Private with removeAccounts removes it.
      await b.op({ op: 'remoteMode', mode: 'connected' });
      assert.ok((await reconnect(b, relay, acct, pairing, { key: phoneKey, name: 'New iPhone' })).c.events.some((e) => e.ev === 'ready'), 'its record (auto) lets it in again in Connected');
      await b.op({ op: 'remoteMode', mode: 'private', removeAccounts: true });
      assert.ok(!last().devices.some((d) => d.kind === 'account'));
      await b.op({ op: 'remoteMode', mode: 'open', reqId: 'm' });
      assert.match(last().opError, /Private or Connected/);
    } finally { b.stop(); }
  });
});

/* -------------------------------------------- the page check and the re-check */

test('bridge: no pairing code when the page cannot be checked; "Pair without checking the page" only for an unreachable site', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const base = { version: 'abc123def456', url: 'http://127.0.0.1:9/v/abc123def456/', files: 40, differs: [], missing: [], at: Date.now() };
    let page = { ...base, state: 'unreachable', error: 'HTTP 503 for app.js' };
    const { b, last } = bridgeFor(relay, dir, { pageCheck: async () => ({ ...page, at: Date.now() }) });
    try {
      await b.op({ op: 'remoteEnable' });
      await until(() => b.status === 'online');
      await b.op({ op: 'remotePairStart', reqId: 'p1' });
      assert.match(last().opError, /shows no pairing code/);
      assert.equal(last().pairing, null, 'fails closed');
      assert.equal(last().page.canSkip, true);
      await b.op({ op: 'remotePairStart', unchecked: true });
      assert.equal(last().pairing.unchecked, true, 'the person chose it, and the code says so');
      assert.match(last().pairing.url, /\/v\/abc123def456\/#p=/);
      b.clearOffer();
      page = { ...base, state: 'differs', differs: ['app.js'] };
      await b.op({ op: 'remotePairStart', reqId: 'p2' });
      await b.op({ op: 'remotePairStart', unchecked: true, reqId: 'p3' });
      assert.match(last().opError, /will not show a pairing code/);
      assert.equal(last().pairing, null, 'never over a page that differs');
      assert.equal(last().page.canSkip, false);
    } finally { b.stop(); }
  });
});

test('re-check: a verified version fetched like a phone browser; a changed file turns phone access off and the reason stays', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const hashes = { 'index.html': 'a'.repeat(64), 'app.js': 'b'.repeat(64) };
    const base = { version: 'abc123def456', url: 'http://127.0.0.1:9/v/abc123def456/', files: 2, differs: [], missing: [], hashes };
    const calls = [];
    // The build the PC makes now is another version than the one it verified (a dev build since), so both are checked.
    const v = (a) => (a.recheck && !a.files ? { version: 'fff000fff000' } : {});
    let answer = (a) => ({ ...base, state: 'ok', at: Date.now(), ...v(a) });
    const br = bridgeFor(relay, dir, { pageCheck: async (a) => { calls.push(a); return answer(a); } });
    const { b, last } = br;
    try {
      await b.op({ op: 'remoteEnable' });
      await until(() => b.status === 'online');
      const p = await pairPhone(br, relay, { name: 'Pixel' });
      assert.deepEqual(store.loadPages(dir).map((x) => x.version), ['abc123def456'], 'a verified version is remembered with its hashes');
      // Not published (a dev build) or unreachable: nothing changes.
      answer = (a) => ({ ...base, state: 'missing', missing: ['index.html', 'app.js'], at: Date.now(), ...v(a) });
      await b.recheckPages();
      answer = (a) => ({ ...base, state: 'unreachable', at: Date.now(), ...v(a) });
      await b.recheckPages();
      assert.equal(b.state.enabled, true);
      const re = calls.filter((a) => a.recheck);
      assert.ok(re.some((a) => a.files && a.version === 'abc123def456'), 'the remembered version is checked against its own hashes');
      assert.ok(re.every((a) => typeof a.headers === 'function'));
      assert.match(re[0].headers('index.html')['user-agent'], /iPhone|Android/);
      assert.notEqual(re[0].agent, re.at(-1).agent, 'the phone browsers take turns');
      // Changed: twice in a row, then off, with the reason kept on disk and shown.
      answer = (a) => ({ ...base, state: 'differs', differs: ['app.js'], at: Date.now(), ...(a.files ? {} : { state: 'missing', differs: [] }), ...v(a) });
      await b.recheckPages();
      assert.equal(b.state.enabled, false);
      assert.equal(last().state, 'off');
      assert.match(last().pageAlarm.text, /turned off/);
      assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).pageAlarm.text, /Someone may have changed that site/);
      await p.phone.pump(() => p.phone.alerts.some((a) => a.type === 'close'));
      assert.doesNotMatch(p.phone.alerts.find((a) => a.type === 'close').reason, /removed|expired/, 'the phone keeps the PC');
      // Turning it on again clears the alarm (the person has seen it).
      answer = (a) => ({ ...base, state: 'ok', at: Date.now() });
      await b.op({ op: 'remoteEnable' });
      assert.equal(last().pageAlarm, null);
    } finally { b.stop(); }
  });
});

test('re-check: a version this PC never verified that does not match yet is waited for, not an alarm (a fresh deploy, 2026-10-11)', async () => {
  await withDir(async (dir) => {
    const relay = fakeRelay();
    const base = { version: 'new000new000', url: 'http://127.0.0.1:9/v/new000new000/', files: 1, differs: [], missing: [], hashes: { 'index.html': 'a'.repeat(64) } };
    let answer = () => ({ ...base, state: 'ok', at: Date.now() });
    const br = bridgeFor(relay, dir, { pageCheck: async () => answer(), recheckRetryMs: 40 });
    const { b, last } = br;
    try {
      await b.op({ op: 'remoteEnable' });
      await until(() => b.status === 'online');
      assert.deepEqual(store.loadPages(dir).map((x) => x.version), [], 'no version verified by this PC yet');
      // Phone access went off minutes after a deploy (the page was still spreading, or an engine read a half-copied
      // install): a mismatch on a version never seen whole is a "not yet", checked again shortly.
      answer = () => ({ ...base, state: 'differs', differs: ['index.html'], at: Date.now() });
      await b.recheckPages();
      assert.equal(b.state.enabled, true, 'phone access stays on');
      assert.equal(last().pageAlarm ?? null, null, 'no alarm');
      assert.ok(b.pendingRecheck, 'checked again shortly');
      answer = () => ({ ...base, state: 'ok', at: Date.now() });
      await until(() => !b.pendingRecheck);
      await until(() => !b.rechecking);
      assert.equal(b.state.enabled, true);
    } finally { b.stop(); }
  });
});

test('page check: browser-like headers per file; an HTTP error is unreachable and gets no code', async () => {
  const seen = [];
  const files = { 'index.html': 'x', 'app.js': 'y', 'app.css': 'z' };
  const crypto = await import('node:crypto');
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const exp = { version: 'abcdef123456', files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])) };
  const fetch = async (url, init) => { seen.push({ url, headers: init.headers }); const rel = url.split('/v/abcdef123456/')[1] || 'index.html'; return new Response(files[rel] ?? '', { status: 200 }); };
  const ok = await checkPage({ web: 'https://site.example/', relay: 'wss://r.example', fetch, build: () => exp, headers: browserHeaders(PHONE_AGENTS[1]) });
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.hashes, exp.files);
  const page = seen.find((s) => s.url.endsWith('/v/abcdef123456/')).headers;
  assert.match(page['user-agent'], /Android .*Mobile/);
  assert.equal(page['sec-fetch-dest'], 'document');
  assert.equal(seen.find((s) => s.url.endsWith('app.js')).headers['sec-fetch-dest'], 'script');
  const err = await checkPage({ web: 'https://site.example/', relay: 'wss://r.example', fetch: async () => new Response('busy', { status: 503 }), build: () => exp });
  assert.equal(err.state, 'unreachable');
  assert.match(pageText(err), /shows no pairing code/);
});

/* ------------------------------------------------- the relay's fair shares */

test('PC: the relay\'s fair-share closes (4504, 4505) wait like the daily budget and say why', async () => {
  await withDir(async (dir) => {
    for (const code of [RELAY_CLOSE.IP_SHARE, RELAY_CLOSE.ROOM_SHARE]) {
      const relay = fakeRelay();
      const { b, last } = bridgeFor(relay, dir);
      try {
        await b.op({ op: 'remoteEnable' });
        await until(() => b.status === 'online');
        relay.bye(code);
        await until(() => b.status === 'offline');
        assert.equal(last().error, budgetShareText(code));
        assert.match(last().error, /share .*00:00 UTC/);
        assert.ok(last().retryInMs > 25 * 60_000, 'a long wait, not a knock every minute');
      } finally { b.stop(); }
    }
    assert.equal(budgetShareText(RELAY_CLOSE.BUDGET), null);
  });
});

test('phone link: NO_PC is the quiet wait for the PC; the fair-share closes wait long with a reason; pending, mode and cap from the PC', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-caps-web-'));
  const saved = { document: globalThis.document, window: globalThis.window, WebSocket: globalThis.WebSocket };
  try {
    build({ relay: 'wss://relay.example', out });
    globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
    const { Link, budgetReason } = await import(pathToFileURL(path.join(out, 'link.js')).href);
    const device = await createDeviceIdentity();
    const pc = await createDeviceIdentity();
    const pairing = { v: 1, roomId: 'CCCCCCCCCCCCCCCCCCCCCC', relay: 'wss://relay.example', pcPub: b64urlEncode(pc.pub), pcName: 'Desk', deviceId: 'DDDDDDDDDDDDDDDDDDDDDD', psk: b64urlEncode(randomBytes(32)), pairedAt: new Date().toISOString() };
    const make = () => {
      const seen = { states: [], mode: [], cap: [] };
      const link = new Link({ device, pairing, on: { state: (s, info) => seen.states.push([s, info]), mode: (m) => seen.mode.push(m), cap: (c) => seen.cap.push(c) } });
      return { link, seen };
    };
    let { link, seen } = make();
    link.ws = {};
    link.gone(link.ws, RELAY_CLOSE.NO_PC);
    assert.equal(link.state, 'waiting');
    assert.ok(!seen.states.some(([s]) => s === 'offline'), 'no "No connection" flicker');
    assert.ok(seen.states.at(-1)[1].retryInMs >= 45_000 && seen.states.at(-1)[1].retryInMs <= 75_000);
    assert.ok(link.timers.retry);
    link.stop();
    for (const code of [RELAY_CLOSE.BUDGET, RELAY_CLOSE.IP_SHARE, RELAY_CLOSE.ROOM_SHARE]) {
      ({ link, seen } = make());
      link.ws = {};
      link.gone(link.ws, code);
      const [state, info] = seen.states.at(-1);
      assert.equal(state, 'offline');
      assert.equal(info.budget, budgetReason(code));
      assert.match(info.budget, /00:00 UTC/);
      assert.ok(info.retryInMs > 25 * 60_000);
      link.stop();
    }
    // A held request: pending extends the wait and says so; the answer resolves it.
    ({ link, seen } = make());
    link.state = 'open';
    const sent = [];
    link.outbox = { send: async (m) => { sent.push(m); }, close() {} };
    let pendings = 0;
    const p = link.request({ t: 'account-link' }, 'account-linked', 50, { onPending: () => { pendings += 1; } });
    await sleep(5);
    link.message(() => ({ t: 'pending', reqId: sent[0].reqId, timeoutMs: 180_000 }));
    await sleep(120);
    assert.equal(pendings, 1);
    link.message(() => ({ t: 'account-linked', reqId: sent[0].reqId, deviceId: 'x' }));
    assert.equal((await p).deviceId, 'x', 'still waiting past the first 50 ms, then answered');
    link.message(() => ({ t: 'mode', mode: 'private', features: ['mode', 'cap'] }));
    assert.equal(link.hello.mode, 'private');
    assert.equal(link.supports('account-ask'), false);
    link.message(() => ({ t: 'cap', cap: 'chat' }));
    assert.deepEqual([seen.mode, seen.cap], [['private'], ['chat']]);
    link.stop();
  } finally {
    Object.assign(globalThis, saved);
    for (const k of ['document', 'window', 'WebSocket']) if (saved[k] === undefined) delete globalThis[k];
    fs.rmSync(out, { recursive: true, force: true });
  }
});
