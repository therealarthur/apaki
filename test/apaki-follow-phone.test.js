/**
 * The phone side of the shared view (2026-10-12; apaki/engine tests are in apaki-follow.test.js). A pane of the phone
 * can FOLLOW a pane that is open on the PC: it shows the conversation live without taking it over, says so in one quiet
 * bar with Take over, keeps the PC pane's model, effort and mode read only, and ends cleanly when the PC closes or
 * hands over the pane.
 *
 *   1. pane.js: setFollowing / stopFollowing / takeOver / followEnded and the events a follower hears, on a Pane's
 *      prototype over a tiny fake DOM (the same approach as apaki-pane-scroll.test.js)
 *   2. desktop.js: the "Watching" word on the desktop list
 *   3. shim.js: a follower comes back after a reconnect, and the answer to an earlier unfollow never drops a pane that
 *      Take over opened again
 *   4. the wiring in app.js, boot.js, web.css and the engine (pane ids, snapshot and restore, the cap event)
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pane, peerName } from '../apaki/ui/pane.js';
import { build } from '../apaki/scripts/build-web.mjs';
import { installShim } from '../apaki/web/src/shim.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* ---------------------------------------------------------------- 1. pane.js */

/** Just enough of an element for pane.js's el(): classes, children, a query that always finds something clickable. */
function fakeEl(tag = 'div') {
  const classes = new Set();
  const found = new Map();
  const e = {
    tag, className: '', children: [], disabled: false, removed: false, onclick: null, _html: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    append(...n) { e.children.push(...n); }, prepend(n) { e.children.unshift(n); }, remove() { e.removed = true; },
    querySelector(sel) { if (!found.has(sel)) found.set(sel, fakeEl()); return found.get(sel); },
    get innerHTML() { return e._html; }, set innerHTML(v) { e._html = v; },
  };
  return e;
}
const doc = globalThis.document;
globalThis.document = { createElement: fakeEl };
const win = globalThis.window;
globalThis.window = { __apakiLink: { pcName: () => 'Studio PC' } };
after(() => {
  if (doc === undefined) delete globalThis.document; else globalThis.document = doc;
  if (win === undefined) delete globalThis.window; else globalThis.window = win;
});

/** A pane that follows nothing yet, with the calls it makes to its host and the engine recorded. */
function followerPane() {
  const sent = [];
  const calls = [];
  const wrap = fakeEl();
  const ground = fakeEl();
  const viewNote = { present: false };
  const el = fakeEl('section');
  // Only the view-only note is looked up through the pane's element; the rest of the DOM is not needed.
  el.querySelector = (sel) => (sel === '.view-only-note' ? (wrap.children.length ? wrap.children.at(-1) : null) : fakeEl());
  const p = Object.create(Pane.prototype);
  Object.assign(p, {
    id: 'f1', el, sessionId: 'sess-1', cwd: 'C:/code/acme', title: 'Migrate invoices', kind: 'claude', model: 'claude-opus-5-5', effort: 'high', mode: 'default',
    picked: { model: false, effort: false, mode: false }, busy: true, queue: [], viewNote,
    $: { model: fakeEl('button'), effort: fakeEl('button'), mode: fakeEl('button'), ground, wrap, T: fakeEl(), status: fakeEl() },
    host: { send: (op, args) => { sent.push({ op, ...args }); }, takeOver: (pane) => calls.push(['takeOver', pane.id]), changed: () => calls.push(['changed']), close: (pane) => calls.push(['close', pane.id]) },
    setBusy(on) { this.busy = on; }, setStatus() {}, scrollDown() {}, setTitle(t) { this.title = t; }, stopDriftWatch() {}, setKind() {},
  });
  return { p, sent, calls, wrap, ground };
}

test('pane: following a PC pane keeps its model, effort and mode read only, and puts one bar with Take over at the top', () => {
  const { p, ground, calls } = followerPane();
  p.setFollowing('ph2');
  assert.equal(p.following, 'ph2');
  assert.equal(p.el.classList.contains('following'), true);
  assert.deepEqual(['model', 'effort', 'mode'].map((k) => p.$[k].disabled), [true, true, true], 'those are the PC pane\'s');
  assert.equal(p.el.classList.contains('view-only'), false, 'Full access keeps the message box');
  const bar = ground.children[0];
  assert.match(bar.className, /follow-bar/);
  assert.match(bar.innerHTML, /Watching live on <b>Studio PC<\/b>/);
  assert.match(bar.innerHTML, /<button type="button" class="fb-go"[^>]*>Take over<\/button>/);
  assert.match(bar.innerHTML, /<svg/, 'a glyph, not a dot');
  bar.querySelector('.fb-go').onclick();
  assert.deepEqual(calls, [['takeOver', 'f1']], 'the page asks first (app.js takeOver)');
  // Drawn again (a phone whose access changed): one bar, the old one removed.
  p.setFollowing('ph2', { readOnly: true });
  assert.equal(bar.removed, true);
  assert.equal(ground.children.length, 2);
  assert.equal(p.el.classList.contains('view-only'), true, 'No shell and Chat only watch, they do not send');
  assert.match(p.$.wrap.children.at(-1).innerHTML, /View only/);
  // And back to Full: the line goes, the message box is back.
  p.setFollowing('ph2', { readOnly: false });
  assert.equal(p.el.classList.contains('view-only'), false);
  assert.equal(p.$.wrap.children.at(-1).removed, true);
});

test('pane: Take over unfollows first, then opens the conversation here with force (the PC refuses an open on a follower)', () => {
  const { p, sent } = followerPane();
  p.setFollowing('ph2');
  p.takeOver();
  assert.equal(p.following, null);
  assert.deepEqual(sent.map((m) => m.op), ['unfollow', 'open'], 'unfollow before open');
  assert.equal(sent[0].paneId, 'f1');
  assert.deepEqual({ sessionId: sent[1].sessionId, force: sent[1].force, warm: sent[1].warm, cwd: sent[1].cwd }, { sessionId: 'sess-1', force: true, warm: true, cwd: 'C:/code/acme' });
  assert.equal(p.el.classList.contains('following'), false);
  assert.deepEqual(['model', 'effort', 'mode'].map((k) => p.$[k].disabled), [false, false, false], 'the chips are the pane\'s own again');
  // A pane that does not follow has nothing to take over.
  sent.length = 0;
  p.takeOver();
  assert.deepEqual(sent, []);
});

test('pane: any open in a following pane ends the following first, so a Take over here card or a reopen never takes a conversation by accident', () => {
  const { p, sent } = followerPane();
  p.setFollowing('ph2');
  p.open({ id: 'sess-1', cwd: 'C:/code/acme', title: 'Migrate invoices' }, { warm: true, force: true });
  assert.deepEqual(sent.map((m) => m.op), ['unfollow', 'open']);
  assert.equal(p.following, null);
});

test('pane: what a follower hears. opened says whether the phone may only watch; taken_over and locked end the following; the PC closing the pane says so and offers Open here', () => {
  const a = followerPane();
  a.p.setFollowing('ph2');
  a.p.showLocked = function (e, o) { this.shown = [e.ev, Boolean(o?.lost)]; };
  a.p.handle({ ev: 'taken_over', paneId: 'f1', sessionId: 'sess-1', holder: { name: "Maya's iPhone" } });
  assert.equal(a.p.following, null, 'the conversation moved to another window: this is an ordinary pane that lost it');
  assert.deepEqual(a.sent.map((m) => m.op), ['unfollow'], 'the PC drops it from its watchers');
  assert.deepEqual(a.p.shown, ['taken_over', true]);

  const b = followerPane();
  b.p.setFollowing('ph2');
  b.p.showLocked = function () { this.locked = true; };
  b.p.handle({ ev: 'locked', paneId: 'f1', sessionId: 'sess-1', holder: { name: 'Apaki' } });
  assert.equal(b.p.following, null);
  assert.equal(b.p.locked, true);

  // The PC's own words about this phone's access: view only follows opened.readOnly. (The handler continues with the rest of
  // opened, which needs a real DOM; the first lines are the claim here.)
  const c = followerPane();
  c.p.setFollowing('ph2');
  c.p.setViewOnly = function (on) { this.viewOnly = on; };
  try { c.p.handle({ ev: 'opened', follower: true, readOnly: true, paneId: 'f1', sessionId: 'sess-1' }); } catch { /* the rest of opened needs the real DOM */ }
  assert.equal(c.p.viewOnly, true);

  const d = followerPane();
  d.p.setFollowing('ph2');
  d.p.followEnded();
  assert.equal(d.p.following, null);
  assert.equal(d.p.el.classList.contains('following'), false);
  const card = d.p.$.T.children.at(-1);
  assert.match(card.innerHTML, /Closed on the PC/);
  assert.match(card.innerHTML, /class="tk-go">Open here</);
  assert.match(card.innerHTML, /class="tk-no">Close pane</);
  card.querySelector('.tk-no').onclick();
  assert.deepEqual(d.calls.filter((c2) => c2[0] === 'close'), [['close', 'f1']]);
  card.querySelector('.tk-go').onclick();
  assert.deepEqual(d.sent.map((m) => [m.op, m.force]), [['open', false]], 'opened here without force: nothing holds it any more');
  // Not following: nothing happens (the answer to this phone's own unfollow arrives after the pane left).
  const n = d.sent.length;
  d.p.followEnded();
  assert.equal(d.sent.length, n);
});

test('pane: the Session in use card offers Watch live when a pane of the PC has the conversation, and Take over here stays the other choice', () => {
  const lockedPane = (deskPaneFor) => {
    const calls = [];
    const p = Object.create(Pane.prototype);
    Object.assign(p, {
      id: 'p9', sessionId: null, cwd: '', title: 'New conversation', lastOpen: null,
      $: { T: fakeEl(), ground: fakeEl(), wrap: fakeEl() },
      host: { deskPaneFor, watchLive: (pane, id) => calls.push(['watchLive', pane.id, id]), changed() {}, close: (pane) => calls.push(['close', pane.id]), send: (op, args) => calls.push([op, args.force]) },
      setCwdLine() {}, setBusy() {}, setStatus() {}, setTitle() {}, scrollDown() {}, startDriftWatch() {}, stopDriftWatch() {},
    });
    p.showLocked({ ev: 'locked', sessionId: 'sess-1', holder: { name: 'Apaki on this PC', app: 'apaki', at: Date.now() }, title: 'Fix it', cwd: 'C:/code' });
    return { p, calls, card: p.$.T.children.at(-1) };
  };
  const a = lockedPane((sid) => (sid === 'sess-1' ? 'ph1' : null));
  assert.match(a.card.innerHTML, /<button class="tk-go tk-watch">Watch live<\/button><button class="tk-take">Take over here<\/button><button class="tk-no">Cancel<\/button>/, 'watching is the first and primary choice: it takes nothing from the PC');
  a.card.querySelector('.tk-watch').onclick();
  assert.deepEqual(a.calls, [['watchLive', 'p9', 'ph1']]);
  a.card.querySelector('.tk-take').onclick();
  assert.deepEqual(a.calls.at(-1), ['open', true], 'Take over here still opens with force');
  // No pane of the PC has it (a terminal holds it, or the PC cannot follow): the card is what it was.
  const b = lockedPane(() => null);
  assert.match(b.card.innerHTML, /<button class="tk-go tk-take">Take over here<\/button>/);
  assert.equal(/Watch live/.test(b.card.innerHTML), false);
  const c = lockedPane(undefined);
  assert.equal(/Watch live/.test(c.card.innerHTML), false, 'a desktop window has no such host function');
});

test('pane: who sent a message that another window typed into the conversation', () => {
  assert.equal(peerName('Desktop', true), 'the PC');
  assert.equal(peerName('Desktop', false), '', 'the window never draws its own words as a stranger\'s');
  assert.equal(peerName("Maya's iPhone", true), "Maya's iPhone");
  assert.equal(peerName("  Maya's \n iPhone ", false), "Maya's iPhone");
  assert.equal(peerName('', true), '');
  assert.equal(peerName(undefined, true), '');
  assert.equal(peerName('x'.repeat(200), true).length, 60);
  const pane = read('../apaki/ui/pane.js');
  assert.match(pane, /`\$\{steered \? 'Steered in' : 'Sent'\} from \$\{esc\(from\)\}`/, 'the name is escaped');
  assert.match(pane, /from: peerName\(e\.from, this\.following\)/);
});

/* ---------------------------------------------------------------- 2. desktop.js */

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-follow-phone-'));
let built = null;
const load = async (name) => {
  built ||= build({ relay: 'wss://apaki.myrlin.io', out });
  return import(pathToFileURL(path.join(out, name)).href);
};
after(() => fs.rmSync(out, { recursive: true, force: true }));

test('On your desktop: a conversation this phone follows says Watching (and Working · Watching while it runs); one it holds itself still says Open here', async () => {
  const { deskModel } = await load('desktop.js');
  const tabs = [{ index: 0, active: true, panes: [
    { paneId: 'p1', kind: 'session', sessionId: 's1', title: 'One', busy: false, focused: true },
    { paneId: 'p2', kind: 'session', sessionId: 's2', title: 'Two', busy: true, focused: false },
    { paneId: 'p3', kind: 'session', sessionId: 's3', title: 'Three', busy: false, focused: false },
    { paneId: 'p4', kind: 'session', sessionId: 's4', title: 'Four', busy: false, focused: false },
    { paneId: 'b1', kind: 'browser', title: 'Page', focused: false },
  ] }];
  const m = deskModel(tabs, { openHere: (id) => id === 's3', watching: (pane) => pane === 'p1' || pane === 'p2' });
  assert.deepEqual(m.tabs[0].rows.map((r) => r.meta), ['Watching', 'Working · Watching', 'Open here', '', 'Browser']);
  assert.equal(m.tabs[0].rows[0].paneId, 'p1', 'the row carries the pane to follow');
  assert.equal(m.tabs[0].rows[4].go, false, 'a browser cannot be followed');
  // Without the option nothing changes (the earlier signature).
  assert.deepEqual(deskModel(tabs).tabs[0].rows.map((r) => r.meta), ['On screen', 'Working', '', '', 'Browser']);
  // A pane the desktop gave no id cannot be watched, so it never says so.
  const noId = deskModel([{ index: 0, active: true, panes: [{ kind: 'session', sessionId: 's1', title: 'One', busy: false, focused: false }] }], { watching: () => true });
  assert.equal(noId.tabs[0].rows[0].meta, '');
});

/* ---------------------------------------------------------------- 3. shim.js */

test('shim: a follower follows again after a reconnect, and the answer to an earlier unfollow cannot drop a pane Take over opened again', async () => {
  const sentToPc = [];
  const link = { send: async (m) => { sentToPc.push(m); }, onEvent: null, onReopen: null };
  installShim(link);
  const tauri = globalThis.window.__TAURI__;
  const send = (msg) => tauri.core.invoke('engine_send', { msg });

  await send({ op: 'follow', reqId: 'r1', paneId: 'f1', desktopPaneId: 'ph2' });
  link.onReopen();
  assert.equal(sentToPc.at(-2).op, 'follow', 'a reconnect sends follow again, not attach (attach would take it over)');
  assert.equal(sentToPc.at(-2).desktopPaneId, 'ph2');
  assert.equal(sentToPc.at(-1).op, 'sessions');

  // Take over: unfollow, then open with force; the PC's answer to the unfollow (closed, with its request id) arrives after.
  await send({ op: 'unfollow', reqId: 'r2', paneId: 'f1' });
  await send({ op: 'open', reqId: 'r3', paneId: 'f1', sessionId: 'sess-1', cwd: 'C:/code', force: true });
  link.onEvent({ ev: 'closed', reqId: 'r2', paneId: 'f1' });
  link.onEvent({ ev: 'opened', reqId: 'r3', paneId: 'f1', sessionId: 'sess-1', cwd: 'C:/code' });
  sentToPc.length = 0;
  link.onReopen();
  assert.deepEqual(sentToPc.slice(0, 1).map((m) => [m.op, m.paneId, m.sessionId]), [['attach', 'f1', 'sess-1']], 'the pane Take over opened is still on the list for the next reconnect');

  // The PC closing a followed pane by itself (no request id) ends it for good.
  await send({ op: 'follow', reqId: 'r4', paneId: 'f2', desktopPaneId: 'ph3' });
  link.onEvent({ ev: 'closed', paneId: 'f2' });
  sentToPc.length = 0;
  link.onReopen();
  assert.equal(sentToPc.some((m) => m.paneId === 'f2'), false);

  // A follow of a pane that is already gone is answered with closed carrying the follow's own request id: also the end of it.
  await send({ op: 'follow', reqId: 'r5', paneId: 'f3', desktopPaneId: 'gone' });
  link.onEvent({ ev: 'closed', reqId: 'r5', paneId: 'f3' });
  sentToPc.length = 0;
  link.onReopen();
  assert.equal(sentToPc.some((m) => m.paneId === 'f3'), false);

  // A pane re-followed after a reconnect has a new request id: its closed ends it too.
  await send({ op: 'follow', reqId: 'r6', paneId: 'f4', desktopPaneId: 'ph9' });
  sentToPc.length = 0;
  link.onReopen();
  const again = sentToPc.find((m) => m.paneId === 'f4');
  link.onEvent({ ev: 'closed', reqId: again.reqId, paneId: 'f4' });
  sentToPc.length = 0;
  link.onReopen();
  assert.equal(sentToPc.some((m) => m.paneId === 'f4'), false);
});

/* ---------------------------------------------------------------- 4. wiring */

test('wiring: the page follows, asks before it takes over, saves and restores a follower, hears the PC close it and follows access changes', () => {
  const app = read('../apaki/ui/app.js');
  assert.match(app, /takeOver: \(p\) => takeOver\(p\),/, 'the pane reaches it through its host');
  assert.match(app, /function takeOver\(p\) \{[\s\S]*?Take over from \$\{esc\(pc\)\}\?[\s\S]*?Keep watching[\s\S]*?p\.takeOver\(\)/, 'a sheet first: it stops the PC pane');
  assert.match(app, /It is working on the PC right now, and taking over stops that\./, 'it says so when the PC pane is mid-turn');
  assert.match(app, /p\.setFollowing\(desktopPaneId, \{ readOnly: viewOnly \}\)/);
  assert.match(app, /case 'closed': \{ const p = S\.panes\.get\(e\.paneId\); if \(p\?\.following\) p\.followEnded\(\); break; \}/);
  assert.match(app, /if \(e\.readOnly\) \{ p\?\.note\('Claude is asking a question on the PC\./, 'a view only phone is told where to answer, no sheet it cannot answer');
  assert.match(app, /window\.addEventListener\('apaki:cap', /);
  assert.match(app, /\.\.\.\(p\?\.following \? \{ follow: p\.following, fs: p\.sessionId \|\| null, ft: p\.title \|\| '' \} : \{\}\)/, 'saved as a follower');
  assert.match(app, /busy: Boolean\(p\?\.busy && !p\?\.following\)/, 'a follower is never "crashed mid-turn" on restore');
  assert.match(app, /if \(typeof lf\.follow === 'string' && lf\.follow\) \{[\s\S]*?send\('follow', \{ paneId: fp\.id, desktopPaneId: lf\.follow \}\);[\s\S]*?return L\.leaf\(fp\.id\);/, 'restored by following again, never by open');
  assert.match(app, /if \(p\.following\) \{ send\('follow', \{ paneId: p\.id, desktopPaneId: p\.following \}\); continue; \}/, 'after an engine restart too');
  assert.match(app, /deskPaneFor: \(sessionId\) => \(WEB && window\.__apakiLink\?\.supports\?\.\('follow'\) \? window\.__apaki\?\.deskPaneFor\?\.\(sessionId\) \|\| null : null\)/, 'only a phone whose PC can follow is offered it');
  assert.match(app, /function watchLive\(p, desktopPaneId\) \{[\s\S]*?followDesktop\(\{ desktopPaneId, title, viewOnly: phoneCap\(\) !== 'full' \}\);[\s\S]*?closePane\(p, \{ confirmBusy: false \}\)/, 'a new follower, then the pane that met the lock closes');
  const boot = read('../apaki/web/src/boot.js');
  assert.match(boot, /new CustomEvent\('apaki:cap', \{ detail: \{ cap \} \}\)/);
  const desk = read('../apaki/web/src/desktop.js');
  assert.match(desk, /!openHere\(id\) && link\?\.supports\?\.\('follow'\)/, 'a conversation this phone holds itself is shown, not followed');
  assert.match(desk, /A\.deskPaneFor = \(sessionId\) => \{[\s\S]*?p\?\.kind === 'session' && p\.sessionId === sessionId && typeof p\.paneId === 'string'/, 'the lock card asks the desktop list which pane has a conversation');
  const css = read('../apaki/web/src/web.css');
  assert.match(css, /body\.web \.pane\.following \.follow-bar \{[^}]*position: sticky;[^}]*min-height: 44px;/s, '44 px touch target');
  assert.match(css, /\.follow-bar \.fb-go \{[^}]*min-width: 44px; min-height: 44px;/s);
  const bar = css.slice(css.indexOf('/* The follow bar'), css.indexOf('body.web .pane.following .chip-btn.model'));
  assert.equal(/\d+px\/|font: \d+ \d+px|font-size: \d+px/.test(bar), false, 'type tokens, no new px font sizes');
  assert.equal(/border-left|box-shadow: inset \d+px/.test(bar), false, 'no accent stripe');
  assert.equal(/<i class="dot"|border-radius: 99|border-radius: 50%/.test(bar), false, 'no pill and no dot');
});

test('wiring: no em dash anywhere in what the shared view added, and the PC side lists what it offers', () => {
  for (const f of ['../apaki/ui/pane.js', '../apaki/ui/app.js', '../apaki/web/src/desktop.js', '../apaki/web/src/shim.js', '../apaki/web/src/web.css', '../apaki/engine/remote.js', '../apaki/engine/remote-policy.js', '../apaki/engine/engine.js', '../apaki/engine/codex-panes.js']) {
    const text = read(f);
    assert.equal(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2015)), false, `${f} has no em dash`);
  }
  const engine = read('../apaki/engine/engine.js');
  assert.match(engine, /if \(isCodexPane\(p\)\) \{ await codex\.attach\(c\.reqId, p, \{ paneId: to, readOnly: Boolean\(c\.readOnly\) \}\); return; \}/, 'a Codex pane is followed through codex.attach under the phone\'s pane id');
  assert.match(engine, /\.\.\.\(a\.permission \? \{ permission: a\.permission \} : \{\}\), readOnly: Boolean\(c\.readOnly\)/, 'a permission prompt waiting on the PC pane is shown to the follower the way it is');
  const remote = read('../apaki/engine/remote.js');
  assert.match(remote, /if \(this\.following\.size && ev && typeof ev\.paneId === 'string'\) this\.mirror\(ev\);/, 'the pane\'s events reach its followers');
});
