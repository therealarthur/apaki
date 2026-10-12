/**
 * Codex panes on a phone (apaki/engine/remote-policy.js), 2026-10-12: what a paired phone may ask of a Codex pane, checked
 * on the PC whatever the phone's page sends. The ops are the ones a Claude pane takes; the values are Codex's: its model ids,
 * the efforts a model offers, the Codex app's three presets, files as well as pictures. A restricted phone (No shell, Chat
 * only) gets read-only; only a Full phone may use the other presets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CODEX_MODES, PHONE_OPS, capCodexModes, checkPhoneCommand, phoneView, routeEvent } from '../apaki/engine/remote-policy.js';

const DEVICE = 'A'.repeat(22);
const SID = 'codex:01a00000-0000-7000-8000-000000000001';
const ctx = (over = {}) => ({ deviceId: DEVICE, cap: 'full', paneExists: () => true, paneCount: () => 0, paneKind: (id) => (/:c\d+$/.test(id) ? 'codex' : 'claude'), phoneSessions: () => [SID], ...over });
const ok = (cmd, c) => { const r = checkPhoneCommand(cmd, c || ctx()); assert.equal(r.ok, true, r.error); return r.cmd; };
const bad = (cmd, c) => { const r = checkPhoneCommand(cmd, c || ctx()); assert.equal(r.ok, false, 'should be refused'); return r.error; };

test('the Codex ops a phone may send: its models and its thread list, read only', () => {
  assert.ok(PHONE_OPS.includes('codexModels'));
  assert.ok(PHONE_OPS.includes('codexThreads'));
  assert.deepEqual(ok({ op: 'codexModels', reqId: 'r1' }), { op: 'codexModels', reqId: `phone:${DEVICE}:r1` });
  assert.deepEqual(ok({ op: 'codexThreads', reqId: 'r2', refresh: true, junk: 1 }), { op: 'codexThreads', reqId: `phone:${DEVICE}:r2`, refresh: true });
  assert.deepEqual(ok({ op: 'codexThreads', reqId: 'r3', refresh: 'yes' }), { op: 'codexThreads', reqId: `phone:${DEVICE}:r3`, refresh: false });
  assert.match(bad({ op: 'codexFork' }), /not available from a phone/);
  assert.match(bad({ op: 'worktreeTerminal', path: 'x' }), /not available from a phone/);
  // The session menu's ops (phone parity, 2026-10-12) take a Codex thread's id like any other: the engine renames and forks it.
  assert.equal(ok({ op: 'rename', sessionId: SID, title: 'A name' }).sessionId, SID);
  assert.equal(ok({ op: 'forkSession', sessionId: SID }).sessionId, SID);
});

test('opening a Codex thread: the codex: session id passes, the Codex pick rules apply, a bare id is still a Claude pick', () => {
  const c = ok({ op: 'open', paneId: 'c1', sessionId: SID, cwd: 'x', warm: true });
  assert.equal(c.sessionId, SID);
  assert.equal(c.kind, 'codex');
  // A new Codex conversation names its kind; any model id the server lists is allowed, effort is a plain word, mode a preset.
  const n = ok({ op: 'open', paneId: 'c2', sessionId: null, kind: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', mode: 'full-access' });
  assert.deepEqual([n.kind, n.model, n.effort, n.mode], ['codex', 'gpt-6.1-sol', 'ultra', 'full-access']);
  assert.match(bad({ op: 'open', paneId: 'c2', sessionId: null, kind: 'codex', model: 'gpt 6; rm -rf' }), /Unknown model/);
  assert.match(bad({ op: 'open', paneId: 'c2', sessionId: null, kind: 'codex', effort: 'Ultra!' }), /Unknown effort/);
  assert.match(bad({ op: 'open', paneId: 'c2', sessionId: null, kind: 'codex', mode: 'bypassPermissions' }), /Unknown permission mode/);
  // Claude's rules did not move.
  assert.match(bad({ op: 'open', paneId: 'p1', sessionId: null, model: 'gpt-6.1-sol' }), /Unknown model/);
  assert.match(bad({ op: 'open', paneId: 'p1', sessionId: null, mode: 'full-access' }), /Unknown permission mode/);
  const claude = ok({ op: 'open', paneId: 'p1', sessionId: '01a00000-0000-7000-8000-000000000009', model: 'claude-opus-5-5', effort: 'high', mode: 'default' });
  assert.equal(claude.kind, undefined);
  assert.match(bad({ op: 'open', paneId: 'p1', sessionId: 'codex:bad id' }), /Bad session id/);
  assert.match(bad({ op: 'open', paneId: 'p1', sessionId: 'other:01a00000-0000-7000-8000-000000000009' }), /Bad session id/);
});

test('a restricted phone opens a Codex thread read-only, whatever the page asks; only a Full phone may pick the other presets', () => {
  assert.deepEqual(CODEX_MODES, ['full-access', 'auto', 'read-only']);
  assert.deepEqual(capCodexModes('full'), CODEX_MODES);
  assert.deepEqual(capCodexModes('noshell'), ['read-only']);
  assert.deepEqual(capCodexModes('chat'), ['read-only']);
  for (const cap of ['noshell', 'chat']) {
    const o = ok({ op: 'open', paneId: 'c1', sessionId: SID, mode: 'full-access' }, ctx({ cap }));
    assert.equal(o.mode, 'read-only', `${cap}: clamped, not refused (a page always asks for a mode)`);
    assert.match(bad({ op: 'mode', paneId: 'c1', mode: 'full-access' }, ctx({ cap })), /stays read-only/);
    assert.match(bad({ op: 'mode', paneId: 'c1', mode: 'auto' }, ctx({ cap })), /stays read-only/);
    assert.equal(ok({ op: 'mode', paneId: 'c1', mode: 'read-only' }, ctx({ cap })).mode, 'read-only');
  }
  assert.equal(ok({ op: 'mode', paneId: 'c1', mode: 'full-access' }).mode, 'full-access');
  assert.equal(ok({ op: 'mode', paneId: 'c1', mode: 'auto' }).mode, 'auto');
  assert.match(bad({ op: 'mode', paneId: 'c1', mode: 'plan' }), /Unknown permission mode/);
  // On a Claude pane the modes are Claude's, as before.
  assert.equal(ok({ op: 'mode', paneId: 'p1', mode: 'plan' }).mode, 'plan');
  assert.match(bad({ op: 'mode', paneId: 'p1', mode: 'read-only' }), /Unknown permission mode/);
});

test('model and effort on a Codex pane are Codex\'s; on a Claude pane they are Claude\'s', () => {
  assert.equal(ok({ op: 'model', paneId: 'c1', model: 'gpt-6-astra' }).model, 'gpt-6-astra');
  assert.equal(ok({ op: 'effort', paneId: 'c1', effort: 'xhigh' }).effort, 'xhigh');
  assert.equal(ok({ op: 'effort', paneId: 'c1', effort: 'minimal' }).effort, 'minimal');
  assert.match(bad({ op: 'model', paneId: 'c1', model: '../../etc' }), /Unknown model/);
  assert.match(bad({ op: 'effort', paneId: 'c1', effort: 'HIGH' }), /Unknown effort/);
  assert.match(bad({ op: 'model', paneId: 'p1', model: 'gpt-6-astra' }), /Unknown model/);
  assert.match(bad({ op: 'effort', paneId: 'p1', effort: 'ultra' }), /Unknown effort/);
  assert.equal(ok({ op: 'effort', paneId: 'p1', effort: 'max' }).effort, 'max');
});

test('a Codex message may carry files as well as pictures; a Claude one only pictures; sizes and counts are capped', () => {
  const png = { media_type: 'image/png', data: 'AAAA' };
  const pdf = { media_type: 'application/pdf', data: 'BBBB', name: '../../My Report (1).pdf' };
  const c = ok({ op: 'send', paneId: 'c1', text: 'see', images: [png, pdf] });
  assert.deepEqual(c.images, [png, { media_type: 'application/pdf', data: 'BBBB', name: '.._.._My Report (1).pdf' }], 'the name is made safe');
  assert.match(bad({ op: 'send', paneId: 'p1', text: 'see', images: [pdf] }), /An image could not be sent/);
  assert.match(bad({ op: 'send', paneId: 'c1', text: 'x', images: Array.from({ length: 5 }, () => ({ ...pdf })) }), /At most 4 files/);
  assert.match(bad({ op: 'send', paneId: 'c1', text: 'x', images: [{ media_type: 'application/pdf', data: 'not base64!' }] }), /A file could not be sent/);
  assert.match(bad({ op: 'send', paneId: 'c1', text: 'x', images: [{ media_type: 'not a type', data: 'AAAA' }] }), /A file could not be sent/);
  assert.match(bad({ op: 'send', paneId: 'c1', text: 'x', images: [{ media_type: 'application/pdf', data: 'A'.repeat(8 * 1024 * 1024 + 4) }] }), /could not be sent/);
  // steer takes the same attachments.
  const s = ok({ op: 'steer', paneId: 'c1', qid: 'q1', text: 'tabs', images: [pdf] });
  assert.equal(s.images[0].name, '.._.._My Report (1).pdf');
});

test('events: a phone gets its Codex pane\'s events only, and the thread list is trimmed like the session list', () => {
  const r = routeEvent({ ev: 'sdk', paneId: `phone:${DEVICE}:c1`, msg: { type: 'assistant' } });
  assert.equal(r.deviceId, DEVICE);
  assert.equal(r.ev.paneId, 'c1');
  assert.equal(routeEvent({ ev: 'sdk', paneId: 'p1', msg: {} }), null, 'a desktop pane\'s events stay on the desktop');
  const long = 'x'.repeat(500);
  const view = phoneView({ ev: 'codexThreads', items: [{ id: 'codex:1', firstPrompt: long, title: 't' }] });
  assert.equal(view.items[0].firstPrompt.length, 200);
  assert.equal(view.items[0].title, 't');
  assert.equal(routeEvent({ ev: 'codexModels', reqId: `phone:${DEVICE}:r1`, models: [] }).ev.reqId, 'r1', 'the model list goes back to the phone that asked');
  assert.equal(phoneView({ ev: 'ready', voice: true, codex: true }).voice, false);
  assert.equal(phoneView({ ev: 'ready', voice: true, codex: true }).codex, true);
});
