/**
 * demo.test.mjs: guards for Apaki's demo harness (node --test).
 *
 * The harness shows marketing pictures, so the main thing to protect is that
 * nothing real ever lands in them: no real names, projects or paths in the
 * dataset, scripts or pages. The rest checks that the page composes from the
 * live UI and that the pretend engine answers the first ops of a window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeDesktop, composePhone, startServer } from './server.mjs';
import { buildSessions, buildGlass, buildHistory, HANDOFF, ID, PRESETS } from './harness/data.mjs';
import { createEngine } from './harness/engine.mjs';
import { Turn } from './harness/turns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'harness');
const files = fs.readdirSync(HARNESS).filter((f) => f.endsWith('.mjs') || f.endsWith('.css')).map((f) => path.join(HARNESS, f));
const sources = [...files, path.join(HERE, 'scenes.mjs'), path.join(HERE, 'capture.mjs'), path.join(HERE, 'server.mjs'), path.join(HERE, 'desktop.html'),
  // 2026-10-12: the phone page and the scripts that make the site's media.
  path.join(HERE, 'phone.html'), path.join(HERE, 'site-media.mjs'), path.join(HERE, 'brand-images.mjs')];

const DOUBLE_HYPHEN = '-'.repeat(2);
const EM_DASH = String.fromCharCode(0x2014);

test('no real names, projects or paths in the dataset, scripts and pages', () => {
  // apaki.myrlin.io is the product's own public address, used in the phone sheet.
  const forbidden = [/arthur/i, /hytale/i, /claude-latch/i, /workbook/i, /forge/i, /jobs\.myrlin/i, /users\\\\arthur/i, /@gmail\./i];
  for (const f of [...files, path.join(HERE, 'scenes.mjs')]) {
    const text = fs.readFileSync(f, 'utf8').replace(/apaki\.myrlin\.io/g, 'apaki.example');
    for (const re of forbidden) assert.ok(!re.test(text), `${path.basename(f)} matches ${re}`);
  }
});

test('no em dashes or double hyphens in the harness, scenes or README', () => {
  for (const f of [...sources, path.join(HERE, 'README.md')]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.includes(EM_DASH), `${path.basename(f)} has an em dash`);
    assert.ok(!text.includes(DOUBLE_HYPHEN), `${path.basename(f)} has a double hyphen`);
  }
});

test('sessions: five folders on disk, some working in terminals, some Codex', () => {
  const s = buildSessions(Date.UTC(2026, 9, 13, 14, 42));
  assert.ok(new Set(s.map((x) => x.cwd)).size >= 4);
  assert.ok(s.some((x) => x.terminal?.status === 'working'));
  assert.ok(s.filter((x) => x.codex).length >= 3);
  for (const x of s) assert.ok(x.cwd.startsWith('C:\\Users\\dev\\code\\'), x.cwd);
});

test('Glass has two or three Claude subscriptions, one API key and a live account per provider', () => {
  const g = buildGlass(Date.now());
  assert.equal(g.claude.filter((a) => a.isKey).length, 1);
  assert.ok(g.claude.filter((a) => !a.isKey).length >= 3);
  assert.equal(g.claude.filter((a) => a.active).length, 1);
  assert.equal(g.codex.filter((a) => a.active).length, 1);
});

test('the long transcript has a compaction, tool calls, a diff and the system lines', () => {
  const h = buildHistory(ID.uploads, Date.now());
  assert.ok(h.earlier.some((m) => m.type === 'compact'));
  const kinds = h.messages.filter((m) => m.type === 'notice').map((m) => m.notice.label);
  for (const want of ['Hook', 'API', 'Limit']) assert.ok(kinds.includes(want), want);
  assert.ok(h.messages.some((m) => JSON.stringify(m).includes('"name":"Edit"')));
  assert.ok(h.messages.some((m) => JSON.stringify(m).includes('"name":"Task"')));
});

test('every preset names panes whose sessions exist', () => {
  const ids = new Set(Object.values(ID));
  // Since 2026-10-12 a root can be a split (the handoff's grid), and a phone's preset can start with nothing open.
  const leaves = (n) => (n.type === 'leaf' ? [n] : n.children.flatMap(leaves));
  for (const [name, make] of Object.entries(PRESETS)) {
    const p = make();
    assert.ok(p.tabs.length >= 1 || p.desktopTabs, name);
    // A browser pane, and a conversation not started yet (no session), name no session (the layout preset, 2026-10-12).
    for (const t of p.tabs) for (const lf of leaves(t.root)) if (!lf.web && lf.s !== null) assert.ok(ids.has(lf.s), `${name}: ${lf.s}`);
    for (const t of p.desktopTabs || []) for (const d of t.panes) if (!d.kind || d.kind === 'session') assert.ok(ids.has(d.sessionId), `${name} desktop: ${d.sessionId}`);
  }
});

test('desktop.html composes from the live UI index', () => {
  const html = composeDesktop();
  assert.ok(html.includes('id="stages"'), 'the UI body is in');
  assert.ok(html.includes('/harness/shim.mjs'), 'the shim is in');
  assert.ok(/<script type="module" src="app\.js">/.test(html), 'app.js is loaded once');
  assert.equal(html.split('src="app.js"').length - 1, 1);
  assert.ok(!html.includes('{{UI_'), 'no placeholder is left');
});

test('phone.html composes the phone client from the live UI and the phone parts (2026-10-12)', async () => {
  const html = composePhone();
  assert.ok(html.includes('<body class="web">'), 'the phone shell');
  assert.ok(html.includes('id="pairScreen"') && html.includes('pair-mark'), 'the phone shell with the Myrlin M');
  assert.ok(html.includes('href="web.css"'), 'the phone stylesheet after app.css');
  assert.ok(html.includes('id="drawerBtn"') && html.includes('id="pcLine"'), 'the swaps build-web.mjs makes');
  assert.ok(html.includes('/harness/phone-boot.mjs') && !/src="app\.js"/.test(html), 'phone-boot loads app.js, nothing else does');
  assert.ok(!/\{\{[A-Z_]+\}\}|%MARK%/.test(html), 'no placeholder is left');
  // The phone's own modules are served under /ui/ next to the window's, as in the built page.
  const server = await startServer();
  try {
    for (const f of ['native.js', 'pager.js', 'desktop.js', 'shim.js', 'web.css', 'app.js']) {
      assert.equal((await fetch(`${server.url}/ui/${f}`)).status, 200, f);
    }
    assert.equal((await fetch(`${server.url}/ui/../../package.json`)).status, 404, 'nothing outside the folders');
  } finally { await server.close(); }
});

test('the pretend engine answers a window start: sessions, open with history, a scripted send, a stop', async () => {
  const events = [];
  const engine = createEngine({ send: (ev) => events.push(ev), browser: null, preset: 'base' });
  engine.boot();
  engine.handle({ op: 'sessions', reqId: 'r1' });
  engine.handle({ op: 'open', reqId: 'r2', paneId: 'p1', sessionId: ID.flaky });
  await new Promise((r) => setTimeout(r, 400));
  const list = events.find((e) => e.ev === 'sessions');
  assert.ok(list && list.items.length > 8 && list.folders.length === 3);
  assert.ok(events.some((e) => e.ev === 'ready'));
  assert.ok(events.some((e) => e.ev === 'glass' && e.claude && e.codex));
  assert.equal(events.find((e) => e.ev === 'opened')?.sessionId, ID.flaky);
  assert.ok(events.find((e) => e.ev === 'history')?.messages.length >= 5);
  // A message starts its script; a stop ends it with a result.
  events.length = 0;
  engine.handle({ op: 'send', paneId: 'p1', text: 'go' });
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(events.some((e) => e.ev === 'sdk' && e.msg.type === 'stream_event'));
  engine.handle({ op: 'interrupt', paneId: 'p1' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(events.some((e) => e.ev === 'result'));
  // A steer with nothing running comes back to be sent as a message.
  engine.handle({ op: 'steer', paneId: 'p1', qid: 'q9', text: 'late' });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(events.some((e) => e.ev === 'steer_missed' && e.qid === 'q9'));
});

test('a turn takes in a steer at its steer point and tells the window', async () => {
  const events = [];
  const turn = new Turn({ emit: (ev) => events.push(ev), nextId: (p) => `${p}_1` }, { paneId: 'p1', sessionId: ID.flaky, text: 'x' });
  turn.steers.push({ qid: 'q1', text: 'also this' });
  const got = await turn.steerPoint({ timeoutMs: 500 });
  assert.equal(got.text, 'also this');
  assert.ok(events.some((e) => e.ev === 'steered' && e.qid === 'q1'));
  assert.equal(await turn.steerPoint({ timeoutMs: 150 }), null);
});

/* ---------- the PC and the phone in step (2026-10-12) ---------- */

const leafSessions = (node) => (node.type === 'leaf' ? [node.s] : node.children.flatMap(leafSessions));

test('the handoff: the phone lists the same desktop tab the desktop preset opens, in layout order', () => {
  const desk = PRESETS.handoff();
  const phone = PRESETS['handoff-phone']();
  const sessions = leafSessions(desk.tabs[0].root);
  assert.deepEqual(phone.desktopTabs[0].panes.map((p) => p.sessionId), sessions);
  // The one the phone picks up is focused and idle on the PC; the ones that work are the ones the scene starts.
  const flaky = phone.desktopTabs[0].panes.find((p) => p.sessionId === ID.flaky);
  assert.ok(flaky.focused && !flaky.busy);
  assert.deepEqual(phone.desktopTabs[0].panes.filter((p) => p.busy).map((p) => p.sessionId).sort(), [...desk.busy].sort());
  assert.ok(phone.held[ID.flaky], 'the desktop holds it, so the phone is asked to take it over');
});

test('the handoff engine: a held session asks to be taken over; a takeover opens it; the PC pane follows the transcript', async () => {
  // The phone's engine.
  const ev = [];
  const phone = createEngine({ send: (e) => ev.push(e), browser: null, preset: 'handoff-phone' });
  phone.boot();
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(ev.some((e) => e.ev === 'desktopTabs' && e.tabs[0].panes.length === 3), 'the desktop tabs reach the phone');
  phone.handle({ op: 'open', reqId: 'o1', paneId: 'm1', sessionId: ID.flaky });
  await new Promise((r) => setTimeout(r, 120));
  const locked = ev.find((e) => e.ev === 'locked');
  assert.equal(locked?.holder.name, 'Apaki on this PC');
  assert.ok(!ev.some((e) => e.ev === 'opened'), 'nothing opens before Take over here');
  phone.handle({ op: 'open', reqId: 'o2', paneId: 'm1', sessionId: ID.flaky, force: true });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ev.find((e) => e.ev === 'opened')?.tookOver, true);

  // The desktop's engine: the pane that had it says the phone took it, then reads the phone's turn on its next look.
  const dv = [];
  const desk = createEngine({ send: (e) => dv.push(e), browser: null, preset: 'handoff' });
  desk.boot();
  desk.handle({ op: 'open', reqId: 'd1', paneId: 'ph1', sessionId: ID.flaky });
  await new Promise((r) => setTimeout(r, 200));
  const rev = dv.find((e) => e.ev === 'history')?.rev;
  assert.ok(rev, 'history carries a revision');
  assert.equal(desk.control.takenBy(ID.flaky), true);
  assert.match(dv.find((e) => e.ev === 'taken_over')?.holder.name || '', /\(phone\)$/);
  dv.length = 0;
  desk.handle({ op: 'historyCheck', reqId: 'c1', paneId: 'ph1', sessionId: ID.flaky, rev });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(dv.find((e) => e.ev === 'historyChecked')?.fresh, false, 'nothing new yet');
  desk.control.transcriptGrew(ID.flaky, 6);
  dv.length = 0;
  desk.handle({ op: 'historyCheck', reqId: 'c2', paneId: 'ph1', sessionId: ID.flaky, rev });
  await new Promise((r) => setTimeout(r, 150));
  const fresh = dv.find((e) => e.ev === 'history' && e.refresh);
  assert.ok(fresh, 'a refresh with the phone\'s turn');
  assert.ok(JSON.stringify(fresh.messages).includes(HANDOFF.reply));
  assert.equal(dv.find((e) => e.ev === 'historyChecked')?.fresh, true);
});

test('phone-boot.mjs shows boot.js\'s own pairing screens (its copy still matches apaki/web/src/boot.js)', () => {
  const boot = fs.readFileSync(path.resolve(HERE, '..', 'web', 'src', 'boot.js'), 'utf8');
  const copy = fs.readFileSync(path.join(HARNESS, 'phone-boot.mjs'), 'utf8');
  for (const line of [
    '<h1>Check the code</h1>',
    'shows a code too. If both match, click <b>Allow</b> there.',
    '<p class="pair-note">The code proves nobody sits between this phone and your PC.</p>',
    '<li><span>Open Myrlin Apaki on your PC.</span></li>',
    "<li><span>Point this phone's camera at the code and open the link.</span></li>",
    'Your PC is about to show a code to compare.',
  ]) {
    assert.ok(boot.includes(line), `boot.js no longer has: ${line}`);
    assert.ok(copy.includes(line), `phone-boot.mjs lacks: ${line}`);
  }
  // follow is planned on the PC side, so the phone must not use it in recordings.
  assert.match(copy, /supports: \(f\) => f !== 'follow'/);
});
