/**
 * Phone parity, the engine side (2026-10-12; Arthur: every desktop feature also works on the phone, and apaki/parity
 * records it). What a phone may now ask the PC for, and who may:
 *
 *   - the session menu's commands (rename, forkSession, archive, folder move and create), Ask Claude (askSearch) and the
 *     PC browser view (browserView) are phone ops, allowed by remote-policy.js under the right access level, with their
 *     fields cleaned; Dig deeper, stopSession, revealFolder and the rest stay refused;
 *   - one Ask Claude at a time per phone (AskGate, and RemoteBridge.command), because each question costs about a cent;
 *   - the engine's browserView: one quiet JPEG of the page with its state (browser-tools.js view).
 * The phone page's own parts, the scroll fix and the wiring are in test/apaki-phone-parity.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AskGate, BROADCAST_EVENTS, PHONE_OPS, SESSION_WRITE_OPS, capAllowsOp, checkPhoneCommand, routeEvent,
} from '../apaki/engine/remote-policy.js';
import { RemoteBridge } from '../apaki/engine/remote.js';
import { createBrowserTools, jpegSize } from '../apaki/engine/browser-tools.js';

const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
const SID = '0e7f4b4e-1111-2222-3333-444455556666';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/* the policy */

const ctx = (cap, extra = {}) => ({ deviceId: DEV, paneExists: () => false, paneCount: () => 0, cap, ...extra });
const ask = (cmd, cap = 'full', extra = {}) => checkPhoneCommand(cmd, ctx(cap, extra));

test('policy: the session menu\'s commands are phone ops for Full and No shell, and Chat only (read only) is refused with a reason', () => {
  for (const op of ['rename', 'forkSession', 'archive', 'folder']) assert.ok(PHONE_OPS.includes(op), op);
  // pin (2026-10-12, Pin to top) joined the list: it changes what the PC keeps, like a folder move.
  assert.deepEqual([...SESSION_WRITE_OPS].sort(), ['archive', 'folder', 'forkSession', 'pin', 'rename']);
  for (const cap of ['full', 'noshell']) {
    assert.equal(ask({ op: 'rename', sessionId: SID, title: 'Checkout flake' }, cap).ok, true, cap);
    assert.equal(ask({ op: 'forkSession', sessionId: SID }, cap).ok, true, cap);
    assert.equal(ask({ op: 'archive', sessionId: SID }, cap).ok, true, cap);
    assert.equal(ask({ op: 'folder', action: 'move', sessionId: SID, folderId: 'ab12cd34' }, cap).ok, true, cap);
  }
  for (const cap of ['chat', 'weird']) {
    for (const cmd of [{ op: 'rename', sessionId: SID, title: 'x' }, { op: 'forkSession', sessionId: SID }, { op: 'archive', sessionId: SID }, { op: 'folder', action: 'create', name: 'x' }]) {
      const r = ask({ ...cmd, reqId: 'r1' }, cap);
      assert.equal(r.ok, false, `${cap} ${cmd.op}`);
      assert.equal(r.reqId, 'r1');
      assert.match(r.error, /only reads/);
    }
  }
  assert.equal(capAllowsOp('chat', 'askSearch'), true, 'Ask Claude reads only');
  assert.equal(capAllowsOp('chat', 'rename'), false);
  assert.equal(capAllowsOp('noshell', 'browserView'), false);
  assert.equal(capAllowsOp('full', 'browserView'), true);
  // Callers from before capabilities ask as Full.
  assert.equal(checkPhoneCommand({ op: 'archive', sessionId: SID }, { deviceId: DEV }).ok, true);
});

test('policy: rename keeps a clean name and the pane only when it is this phone\'s own; ids are checked, not cleaned', () => {
  const r = ask({ op: 'rename', reqId: 'r4', sessionId: SID, title: '  Fix\u0000  the\tflaky \n checkout\u007f test  ', paneId: 'p1', extra: 1 }, 'full', { paneExists: (id) => id === `phone:${DEV}:p1` });
  assert.deepEqual(r.cmd, { op: 'rename', reqId: `phone:${DEV}:r4`, sessionId: SID, title: 'Fix the flaky checkout test', paneId: `phone:${DEV}:p1` });
  // A pane that is not open (or not the phone's) is simply left out: the op does not depend on it.
  assert.equal(ask({ op: 'rename', sessionId: SID, title: 'x', paneId: 'p9' }).cmd.paneId, undefined);
  assert.equal(ask({ op: 'rename', sessionId: SID, title: 'x', paneId: `phone:${DEV}:p1` }, 'full', { paneExists: () => true }).cmd.paneId, undefined, 'a namespaced id is not a local one');
  assert.equal(ask({ op: 'rename', sessionId: SID, title: 'x'.repeat(500) }).cmd.title.length, 200);
  for (const bad of [{ title: '' }, { title: '   ' }, { title: 5 }, { title: undefined }, { sessionId: 'x; rm -rf /', title: 'ok' }, { sessionId: 7, title: 'ok' }]) {
    assert.equal(ask({ op: 'rename', sessionId: SID, ...bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(ask({ op: 'forkSession', sessionId: '../../x' }).ok, false);
  assert.deepEqual(ask({ op: 'archive', sessionId: SID, archived: false }).cmd, { op: 'archive', sessionId: SID, archived: false });
  assert.equal(ask({ op: 'archive', sessionId: SID }).cmd.archived, true, 'archive is the default');
});

test('policy: a phone may move a session to a folder and make a folder; renaming and deleting folders stay on the PC', () => {
  assert.deepEqual(ask({ op: 'folder', action: 'move', sessionId: SID, folderId: 'ab12cd34', name: 'ignored' }).cmd, { op: 'folder', action: 'move', sessionId: SID, folderId: 'ab12cd34' });
  assert.equal(ask({ op: 'folder', action: 'move', sessionId: SID, folderId: null }).cmd.folderId, null, 'out of its folder');
  assert.equal(ask({ op: 'folder', action: 'move', sessionId: SID }).cmd.folderId, null);
  assert.deepEqual(ask({ op: 'folder', action: 'create', name: '  acme\u0000 web ', sessionId: SID }).cmd, { op: 'folder', action: 'create', name: 'acme web', sessionId: SID });
  assert.equal(ask({ op: 'folder', action: 'create', name: 'y'.repeat(200) }).cmd.name.length, 60);
  for (const cmd of [{ action: 'rename', folderId: 'ab12cd34', name: 'x' }, { action: 'delete', folderId: 'ab12cd34' }, { action: 'move', sessionId: SID, folderId: '../x' }, { action: 'create', name: '  ' }, { action: 'create' }, {}, { action: 'move' }]) {
    assert.equal(ask({ op: 'folder', ...cmd }).ok, false, JSON.stringify(cmd));
  }
  assert.match(ask({ op: 'folder', action: 'delete', folderId: 'ab12cd34' }).error, /on the PC/);
});

test('policy: Ask Claude is open to every access level, takes only the question and a pane of this phone', () => {
  assert.ok(PHONE_OPS.includes('askSearch'));
  for (const cap of ['full', 'noshell', 'chat']) assert.equal(ask({ op: 'askSearch', query: 'the checkout sessions' }, cap).ok, true, cap);
  const r = ask({ op: 'askSearch', reqId: 'r8', query: `  marketing ${'x'.repeat(900)}`, paneId: 'p1', billing: 'sub', credential: 'sk-ant-x' }, 'chat', { paneExists: (id) => id === `phone:${DEV}:p1` });
  assert.equal(r.cmd.op, 'askSearch');
  assert.equal(r.cmd.reqId, `phone:${DEV}:r8`);
  assert.equal(r.cmd.query.length, 500);
  assert.equal(r.cmd.paneId, `phone:${DEV}:p1`, 'its billing follows that pane, as on the desktop');
  assert.deepEqual(Object.keys(r.cmd).sort(), ['op', 'paneId', 'query', 'reqId']);
  assert.equal(ask({ op: 'askSearch', query: 'x', paneId: 'p5' }).cmd.paneId, null, 'no such pane: the live account');
  assert.equal(ask({ op: 'askSearch', query: '   ' }).ok, false);
  assert.equal(ask({ op: 'askSearch', query: 12 }).ok, false);
  assert.equal(ask({ op: 'askSearch' }).ok, false);
});

test('policy: the browser view needs a pane of this phone\'s own and Full access; nothing else reaches the shell', () => {
  assert.ok(PHONE_OPS.includes('browserView'));
  const mine = { paneExists: (id) => id === `phone:${DEV}:p1` };
  assert.deepEqual(ask({ op: 'browserView', reqId: 'r2', paneId: 'p1', url: 'http://evil', tool: 'click' }, 'full', mine).cmd, { op: 'browserView', reqId: `phone:${DEV}:r2`, paneId: `phone:${DEV}:p1` });
  assert.equal(ask({ op: 'browserView', paneId: 'p9' }, 'full', mine).ok, false, 'a pane that is not open');
  assert.equal(ask({ op: 'browserView', paneId: `phone:${DEV}:p1` }, 'full', mine).ok, false, 'a namespaced id');
  assert.equal(ask({ op: 'browserView' }, 'full', mine).ok, false, 'a pane is required');
  for (const cap of ['noshell', 'chat']) {
    const r = ask({ op: 'browserView', paneId: 'p1' }, cap, mine);
    assert.equal(r.ok, false, cap);
    assert.match(r.error, /browser/);
  }
  // What stays out of reach of a phone, whatever its access.
  for (const op of ['billing', 'billingOptions', 'digPrompt', 'stopSession', 'revealFolder', 'openExternal', 'browserTool', 'transcribe', 'places', 'listDir', 'mkdir', 'remoteStatus', 'exec']) {
    assert.ok(!PHONE_OPS.includes(op), op);
    assert.equal(ask({ op, reqId: 'r1', paneId: 'p1' }, 'full', { paneExists: () => true }).ok, false, op);
  }
});

test('policy: answers to these ops reach only the phone that asked; folders are broadcast', () => {
  const asked = routeEvent({ ev: 'askSearch', reqId: `phone:${DEV}:r8`, query: 'q', results: [] });
  assert.equal(asked.deviceId, DEV);
  assert.equal(asked.ev.reqId, 'r8');
  assert.equal(routeEvent({ ev: 'renamed', reqId: `phone:${DEV}:r4`, paneId: null, sessionId: SID, title: 't', ok: true }).deviceId, DEV);
  assert.equal(routeEvent({ ev: 'forked', reqId: `phone:${DEV}:r5`, from: SID, sessionId: 'x' }).ev.reqId, 'r5');
  const view = routeEvent({ ev: 'browserView', reqId: `phone:${DEV}:bv1`, paneId: `phone:${DEV}:p1`, ok: true });
  assert.deepEqual([view.deviceId, view.ev.paneId, view.ev.reqId], [DEV, 'p1', 'bv1']);
  assert.equal(routeEvent({ ev: 'browserActivity', paneId: 'pdesk', browserId: 'b1' }), null, 'the desktop\'s own browser activity stays on the desktop');
  assert.ok(BROADCAST_EVENTS.has('folders'));
});

/* one Ask Claude at a time */

test('AskGate: one question per phone at a time; its answer (or error, or the clock) frees it; other phones are not held', () => {
  const g = new AskGate(1000);
  assert.equal(g.begin('a', 0, 'r1'), null);
  assert.match(g.begin('a', 500, 'r2'), /still answering/);
  assert.equal(g.begin('b', 500, 'r1'), null, 'another phone');
  g.end('a', 'r9');
  assert.match(g.begin('a', 600, 'r3'), /still answering/, 'another request\'s answer leaves it waiting');
  g.end('a', 'r1');
  assert.equal(g.begin('a', 700, 'r3'), null);
  g.end('a');
  assert.equal(g.begin('a', 710, 'r4'), null, 'an answer with no id frees it');
  assert.equal(g.begin('a', 1800, 'r5'), null, 'a question that never answered stops holding after the limit');
});

function bridge() {
  const dispatched = [];
  const b = new RemoteBridge({
    emit: () => {}, dispatch: (c) => dispatched.push(c), readyEvent: () => ({ ev: 'ready' }), log: () => {}, pageCheck: false, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-parity-bridge-')),
    engine: { paneExists: () => false, paneCount: () => 0, hasOp: () => true },
  });
  b.capFor = () => 'full';
  const sent = [];
  const conn = { device: { id: DEV }, outbox: { push: (e) => sent.push(e) } };
  return { b, dispatched, sent, conn, stop: () => { b.stop(); fs.rmSync(b.dir, { recursive: true, force: true }); } };
}

test('bridge: a second Ask Claude from the same phone is answered with a reason and never reaches the engine; its answer frees the phone', async () => {
  const { b, dispatched, sent, conn, stop } = bridge();
  try {
    b.command(conn, { op: 'askSearch', reqId: 'r1', query: 'checkout' });
    b.command(conn, { op: 'askSearch', reqId: 'r2', query: 'checkout again' });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].reqId, `phone:${DEV}:r1`);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].ev, sent[0].reqId, sent[0].query], ['askSearch', 'r2', 'checkout again']);
    assert.match(sent[0].error, /still answering/);
    // The engine's answer to r1 goes out through route, which frees the phone.
    b.route({ ev: 'askSearch', reqId: `phone:${DEV}:r1`, query: 'checkout', results: [] });
    b.command(conn, { op: 'askSearch', reqId: 'r3', query: 'checkout' });
    assert.equal(dispatched.length, 2);
    // An error for the question frees it too; an error for some other request does not.
    b.route({ ev: 'error', reqId: `phone:${DEV}:r77`, message: 'something else' });
    b.command(conn, { op: 'askSearch', reqId: 'r4', query: 'q' });
    assert.equal(dispatched.length, 2);
    b.route({ ev: 'error', reqId: `phone:${DEV}:r3`, message: 'Claude stopped' });
    b.command(conn, { op: 'askSearch', reqId: 'r5', query: 'q' });
    assert.equal(dispatched.length, 3);
    // A refused command is not a question: it never takes the phone's turn.
    b.command(conn, { op: 'askSearch', reqId: 'r6', query: '   ' });
    assert.equal(sent.at(-1).refused, true);
  } finally { stop(); }
});

test('bridge: a Chat only phone\'s rename is refused by the PC with the access in the words; Ask Claude still goes through', async () => {
  const { b, dispatched, sent, conn, stop } = bridge();
  try {
    b.capFor = () => 'chat';
    b.command(conn, { op: 'rename', reqId: 'r1', sessionId: SID, title: 'x' });
    assert.equal(dispatched.length, 0);
    assert.match(sent[0].message, /Chat only/);
    assert.equal(sent[0].refused, true);
    b.command(conn, { op: 'stopSession', reqId: 'r2', sessionId: SID });
    assert.match(sent[1].message, /own pane/, 'a friendlier refusal for the desktop menu\'s Stop');
    b.command(conn, { op: 'askSearch', reqId: 'r3', query: 'checkout' });
    assert.equal(dispatched.length, 1);
    assert.deepEqual(b.phoneOps().filter((op) => ['rename', 'forkSession', 'archive', 'folder', 'askSearch', 'browserView'].includes(op)).sort(), ['archive', 'askSearch', 'browserView', 'folder', 'forkSession', 'rename'], 'the hello lists them, so the page offers only what the PC takes');
  } finally { stop(); }
});

/* the browser view */

/** A JPEG header with a size: SOI, an APP0 segment, a SOF0 with the height and width. */
function jpegOf(w, h) {
  const b = Buffer.alloc(40);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffe0, 2);
  b.writeUInt16BE(16, 4);
  b.writeUInt16BE(0xffc0, 20);
  b.writeUInt16BE(17, 22);
  b.writeUInt8(8, 24);
  b.writeUInt16BE(h, 25);
  b.writeUInt16BE(w, 27);
  return b;
}

test('jpegSize reads the first start-of-frame; anything else is null', () => {
  assert.deepEqual(jpegSize(jpegOf(1280, 800)), { w: 1280, h: 800 });
  assert.equal(jpegSize(Buffer.from('nope')), null);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(jpegSize(null), null);
});

function fakeShell(onShot) {
  const calls = [];
  const state = { id: 'b1', url: 'http://localhost:3000/checkout', title: 'Checkout - Acme', loading: false, canGoBack: true, status: 200, error: null };
  const shell = {
    has: () => true,
    async request(cmd, args) {
      calls.push([cmd, args]);
      if (cmd === 'browser.state') return { ...state };
      if (cmd === 'browser.cdp') {
        const { method, params } = args;
        if (method === 'Page.getFrameTree') return { id: 'b1', result: { frameTree: { frame: { id: 'F', loaderId: 'L1' } } } };
        if (method === 'Page.createIsolatedWorld') return { id: 'b1', result: { executionContextId: 7 } };
        if (method === 'Runtime.evaluate') return { id: 'b1', result: { result: { value: { w: 1600, h: 900, dpr: 1.5, x: 0, y: 0 } } } };
        if (method === 'Page.captureScreenshot') return { id: 'b1', result: { data: onShot(params).toString('base64') } };
      }
      return { id: 'b1', result: {} };
    },
  };
  return { shell, calls };
}

test('browser view: one quiet JPEG of the part in view and the page\'s state; Claude\'s screenshot stays a PNG that says so in the strip', async () => {
  const activity = [];
  const { shell, calls } = fakeShell((params) => (params.format === 'jpeg' ? jpegOf(1200, 675) : Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])));
  const t = createBrowserTools({ shell, owner: () => 'phone:x:p1', onActivity: (a) => activity.push(a) });
  const v = await t.view();
  assert.equal(v.ok, true, v.text);
  assert.equal(v.mimeType, 'image/jpeg');
  assert.deepEqual([v.width, v.height], [1200, 675]);
  assert.ok(v.width <= 1280);
  assert.deepEqual(v.state, { url: 'http://localhost:3000/checkout', title: 'Checkout - Acme', loading: false, error: null, status: 200, canGoBack: true });
  const cap = calls.find(([, a]) => a?.method === 'Page.captureScreenshot')[1];
  assert.equal(cap.params.format, 'jpeg');
  assert.ok(cap.params.quality >= 30 && cap.params.quality <= 95);
  assert.equal(cap.render, true);
  assert.equal(cap.owner, 'phone:x:p1', 'the shell finds the page by the conversation that owns it');
  assert.deepEqual(activity, [], 'a phone looking is not Claude acting: nothing for the browser\'s strip (or the phone would refresh on its own look)');
  const png = await t.screenshot();
  assert.equal(png.mimeType, 'image/png');
  assert.deepEqual(activity.map((a) => a.action), ['screenshot']);
});

test('browser view: a page that is not there, or a failed picture, is an answer with words, not a throw', async () => {
  const t = createBrowserTools({ shell: { has: () => true, request: async () => { throw new Error('The browser has no page yet.'); } }, owner: () => 'p1' });
  const v = await t.view();
  assert.equal(v.ok, false);
  assert.match(v.text, /no page/);
  const empty = createBrowserTools({ shell: fakeShell(() => Buffer.alloc(0)).shell, owner: () => 'p1' });
  assert.equal((await empty.view()).ok, false);
});


test('wiring: the engine answers browserView through the pane\'s own browser tools, and the policy and engine agree on the op names', () => {
  const engine = read('../apaki/engine/engine.js');
  assert.match(engine, /browserView: async \(c\) => \{\n\s+const p = getPane\(c\.paneId\);\n\s+const b = toolsFor\(p\)\.browser;\n\s+const r = b \? await b\.view\(\)/);
  for (const op of ['rename', 'forkSession', 'archive', 'folder', 'askSearch', 'browserView']) assert.match(engine, new RegExp(`\\n  ${op}: (async )?\\(c\\)`), `engine.js has a ${op} handler`);
  // Every op a phone may send has a handler in the engine (artifactGet is the one it checks for at run time).
  // unfollow is the exception (the shared view): it ends a registry entry in remote.js (endFollow) and never reaches the engine.
  for (const op of PHONE_OPS.filter((o) => o !== 'unfollow')) assert.match(engine, new RegExp(`\\n  ${op}: `), `engine.js handles ${op}`);
});
