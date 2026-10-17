/**
 * The window under load (2026-10-15, Arthur: "our apaki app gets kind of laggy with multiple tabs and panes running at
 * the same time - it doesnt stay sharp - why?"). Measured in the demo harness's load workspace (apaki/demo/perf.mjs),
 * the main thread was busy two thirds of the time, most of it drawing the session list's 400 rows again on every
 * worktrees and subagent event, with Intl formatters made per row and every worktree compared per row; a background tab
 * with a long conversation was laid out whole when it came forward. What changed, checked here:
 *
 *   perfwatch.js      the minute line: busy share from late timers, long tasks, time per drawing path (self time)
 *   sessionlist.js    kept formatters give the same text; placeChildren moves only what moved
 *   worktree.js       wtFor's kept path keys give the same answers; layoutKey ignores the numbers; the controller
 *                     says when only numbers moved, and forgets its answers on a new list
 *   pane.js           stamp's kept formatters; estimateHeight; scrollDown waits a frame and keeps a reader who
 *                     follows the end there, and leaves one who scrolled up alone
 *   streampaint.js    (apaki-streampaint.test.js) replies side by side share their frames
 *   the wiring        app.js draws the list again only when something it shows changed, at most once a frame for
 *                     the engine's events, and logs a busy minute
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUSY_LOG_PCT, LATE_MS, createPerfWatch } from '../apaki/ui/perfwatch.js';
import { exactTime, placeChildren, recencyGroup, shortTime } from '../apaki/ui/sessionlist.js';
import * as WT from '../apaki/ui/worktree.js';
import { Pane, charsPerLine, estimateHeight, stamp } from '../apaki/ui/pane.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* perfwatch.js */

/** A watch on a fake clock and timer. step(ms, late) moves the clock and fires due timers `late` ms after they were due. */
function watchRig({ shown = true } = {}) {
  let t = 0;
  let timers = [];
  let visible = shown;
  const w = createPerfWatch({ now: () => t, wait: (f, ms) => { timers.push({ at: t + ms, f }); }, visible: () => visible, random: () => 0.5 });
  return {
    w,
    tick(ms) { t += ms; },
    show(on) { visible = on; },
    /** Runs the sampler for `ms` of clock; `busyAt(t)` says whether a task holds the thread at that moment. */
    run(ms, busyAt = () => false) {
      const end = t + ms;
      while (timers.length) {
        timers.sort((a, b) => a.at - b.at);
        const x = timers[0];
        if (x.at > end) break;
        timers.shift();
        t = x.at + (busyAt(x.at) ? LATE_MS + 6 : 0.5);
        x.f();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

test('perfwatch: each path gets its own time, without the paths it calls', () => {
  const r = watchRig();
  const out = r.w.time('events', () => {
    r.tick(3);
    r.w.time('rail', () => { r.tick(10); r.w.time('tabs', () => r.tick(2)); });
    r.w.time('panes', () => r.tick(4));
    return 'done';
  });
  assert.equal(out, 'done', 'time() gives back what the function returned');
  const p = r.w.peek().paths;
  assert.equal(p.get('events'), 3);
  assert.equal(p.get('rail'), 10);
  assert.equal(p.get('tabs'), 2);
  assert.equal(p.get('panes'), 4);
  // A path that throws is still counted, and the stack is left as it was.
  assert.throws(() => r.w.time('save', () => { r.tick(5); throw new Error('boom'); }));
  assert.equal(r.w.peek().paths.get('save'), 5);
  r.w.time('events', () => r.tick(1));
  assert.equal(r.w.peek().paths.get('events'), 4, 'nothing left on the stack from the throw');
  // wrap keeps `this` and the arguments.
  const obj = { k: 7, f: r.w.wrap('layout', function f(a, b) { r.tick(2); return this.k + a + b; }) };
  assert.equal(obj.f(1, 2), 10);
  assert.equal(r.w.peek().paths.get('layout'), 2);
});

test('perfwatch: the busy share is the share of late timers, counted only while the window is visible', () => {
  const r = watchRig();
  r.w.start();
  assert.equal(r.pending(), 1, 'one timer at a time');
  // Busy in the first 60% of every 100 ms.
  r.run(60_000, (at) => at % 100 < 60);
  const m = r.w.minute('5 tabs, 16 panes, 4 working');
  assert.ok(m.samples >= 200, `about 4 samples a second, got ${m.samples}`);
  assert.ok(m.busyPct >= 45 && m.busyPct <= 75, `about 60% busy, got ${m.busyPct}`);
  assert.ok(m.line.startsWith(`busy ${m.busyPct}% of the last minute; 0 long tasks; time in: `), m.line);
  assert.ok(m.line.endsWith('; 5 tabs, 16 panes, 4 working'), m.line);
  // Hidden: nothing counts (a hidden page's timers are slowed on purpose, which is not the thread being busy).
  r.show(false);
  r.run(60_000, () => true);
  assert.equal(r.w.minute().samples, 0);
  r.w.stop();
  r.run(10_000);
  assert.equal(r.pending(), 0, 'stopped: no timer left');
});

test('perfwatch: the minute line names the long tasks and the paths, stays short, and is only made for a busy minute', () => {
  const r = watchRig();
  r.w.start();
  r.run(60_000, () => false);
  assert.equal(r.w.minute().line, null, 'an idle minute says nothing');
  r.run(60_000, (at) => at % 100 < 70);
  for (const ms of [120, 64, 910]) r.w.longTask(ms);
  r.w.time('rail', () => r.tick(4400));
  r.w.time('stream', () => r.tick(3100));
  r.w.time('events', () => r.tick(14_200));
  const m = r.w.minute('5 tabs, 16 panes, 4 working');
  assert.ok(m.busyPct > BUSY_LOG_PCT);
  assert.equal(m.longs, 3);
  assert.equal(m.worst, 910);
  assert.deepEqual(m.paths.map(([k]) => k), ['events', 'rail', 'stream']);
  assert.match(m.line, /; 3 long tasks, worst 910 ms, 1\.1 s in all; time in: engine events 14 s, session list 4\.4 s, streamed replies 3\.1 s; 5 tabs/);
  assert.ok(`page: ${m.line}`.length <= 300, 'the shell keeps 300 characters of a line');
  // The next minute starts empty.
  const next = r.w.minute();
  assert.equal(next.longs, 0);
  assert.deepEqual(next.paths, []);
});

/* sessionlist.js */

test('kept formatters: the list\'s times read exactly as freshly made formatters write them', () => {
  const now = new Date(2026, 9, 15, 14, 30).getTime();
  const fresh = (o, ms) => new Intl.DateTimeFormat(undefined, o).format(new Date(ms));
  for (const ago of [2 * 3600e3, 26 * 3600e3, 4 * 86400e3, 40 * 86400e3, 400 * 86400e3]) {
    const at = now - ago;
    const s = shortTime(at, now);
    const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400e3);
    const clock = fresh({ hour: 'numeric', minute: '2-digit' }, at);
    const want = days <= 1 ? clock : days < 7 ? `${fresh({ weekday: 'short' }, at)} ${clock}` : new Date(at).getFullYear() === new Date(now).getFullYear() ? fresh({ month: 'short', day: 'numeric' }, at) : fresh({ month: 'short', day: 'numeric', year: 'numeric' }, at);
    assert.equal(s, want, `${ago} ms ago`);
    assert.equal(exactTime(at), fresh({ dateStyle: 'full', timeStyle: 'medium' }, at));
  }
  assert.equal(recencyGroup(now - 60 * 86400e3, now).label, fresh({ month: 'long' }, now - 60 * 86400e3));
});

/** A list of fake nodes: firstChild, nextSibling, insertBefore and remove, counting the moves. */
function fakeList(names) {
  const box = { kids: [], moves: 0 };
  const node = (name) => {
    const n = { name, get nextSibling() { const i = box.kids.indexOf(n); return i < 0 ? null : box.kids[i + 1] || null; }, remove() { const i = box.kids.indexOf(n); if (i >= 0) box.kids.splice(i, 1); } };
    return n;
  };
  Object.defineProperty(box, 'firstChild', { get: () => box.kids[0] || null });
  box.insertBefore = (n, ref) => {
    box.moves += 1;
    const at = box.kids.indexOf(n);
    if (at >= 0) box.kids.splice(at, 1);
    const i = ref ? box.kids.indexOf(ref) : -1;
    if (i < 0) box.kids.push(n); else box.kids.splice(i, 0, n);
  };
  box.kids = names.map(node);
  box.make = node;
  return box;
}

test('placeChildren: the list ends up as wanted, moving only what moved', () => {
  const box = fakeList(['h', 'a', 'b', 'c', 'd', 'note']);
  const [h, a, b, c, d] = box.kids;
  // One row replaced (a by a2), the old note gone, a new note at the end: one insert for a2, one for the new note.
  const a2 = box.make('a2');
  const note2 = box.make('note2');
  placeChildren(box, [h, a2, b, c, d, note2]);
  assert.deepEqual(box.kids.map((n) => n.name), ['h', 'a2', 'b', 'c', 'd', 'note2']);
  assert.equal(box.moves, 2, 'the rows after the replaced one stay where they are');
  // A row that moved up to the top (its session got a new message): one move.
  box.moves = 0;
  placeChildren(box, [h, d, a2, b, c, note2]);
  assert.deepEqual(box.kids.map((n) => n.name), ['h', 'd', 'a2', 'b', 'c', 'note2']);
  assert.equal(box.moves, 1);
  // Nothing changed: nothing moves. Everything gone: an empty list.
  box.moves = 0;
  placeChildren(box, [...box.kids]);
  assert.equal(box.moves, 0);
  placeChildren(box, []);
  assert.deepEqual(box.kids, []);
});

/* worktree.js */

const W = (path, branch, o = {}) => ({ path, branch, head: 'a1c4e7b2', main: false, bare: false, added: 0, removed: 0, files: 0, changed: 0, ...o });
const REPOS = () => [
  { id: 'r1', name: 'acme', root: 'C:\\code\\acme', worktrees: [W('C:\\code\\acme', 'main', { main: true }), W('C:\\code\\acme\\.claude\\worktrees\\agent-1', 'worktree-agent-1'), W('C:\\code\\acme.worktrees\\fix', 'fix', { added: 4 })] },
  { id: 'r2', name: 'mobile', root: '/Users/dev/mobile', worktrees: [W('/Users/dev/mobile', 'main', { main: true })] },
];

test('wtFor with kept path keys: the deepest worktree, any case and slash on Windows, exact case elsewhere', () => {
  const repos = REPOS();
  // The answer the old wtFor gave, written out: isInside on every worktree, the longest path wins.
  const old = (cwd) => {
    let best = null;
    for (const repo of repos) for (const wt of repo.worktrees) if (WT.isInside(cwd, wt.path) && (!best || WT.normPath(wt.path).length > best.len)) best = { repo, wt, len: WT.normPath(wt.path).length };
    return best ? best.wt.path : null;
  };
  for (const cwd of ['C:\\code\\acme', 'c:/CODE/acme/src', 'C:\\code\\acme\\.claude\\worktrees\\agent-1\\x', 'C:\\code\\acme.worktrees\\fix\\', 'C:\\code\\acmeX', '/Users/dev/mobile/app', '/users/dev/mobile', '', null]) {
    assert.equal(WT.wtFor(repos, cwd)?.wt.path ?? null, old(cwd), String(cwd));
  }
});

test('layoutKey: the same while only numbers move; different when a worktree, branch or repository changes', () => {
  const a = REPOS();
  const b = REPOS();
  b[0].worktrees[2].added = 99;
  b[0].worktrees[2].changed = 3;
  b[0].worktrees[1].merged = true;
  assert.equal(WT.layoutKey(a), WT.layoutKey(b));
  const c = REPOS();
  c[0].worktrees.push(W('C:\\code\\acme.worktrees\\new', 'new'));
  assert.notEqual(WT.layoutKey(a), WT.layoutKey(c));
  const d = REPOS();
  d[0].worktrees[2].branch = 'fix-2';
  assert.notEqual(WT.layoutKey(a), WT.layoutKey(d));
});

test('the worktrees controller: says when only the numbers moved, and answers forCwd from the new list', () => {
  const changed = [];
  const c = WT.initWorktrees({ send: () => true, sheet: () => {}, menu: () => {}, web: false, cap: () => 'full', sessions: () => [], openCwds: () => [], changed: (o) => changed.push(o) });
  c.handle({ ev: 'worktrees', repos: REPOS() });
  assert.equal(changed.pop().shape, true, 'the first list is news');
  assert.equal(c.forCwd('C:\\code\\acme.worktrees\\fix\\src').wt.branch, 'fix');
  const moved = REPOS();
  moved[0].worktrees[2].added = 50;
  c.handle({ ev: 'worktrees', repos: moved });
  assert.equal(changed.pop().shape, false, 'numbers only');
  assert.equal(c.forCwd('C:\\code\\acme.worktrees\\fix\\src').wt.added, 50, 'the answer comes from the new list');
  const renamed = REPOS();
  renamed[0].worktrees[2].branch = 'fix-checkout';
  c.handle({ ev: 'worktrees', repos: renamed });
  assert.equal(changed.pop().shape, true);
  assert.equal(c.forCwd('C:\\code\\acme.worktrees\\fix\\src').wt.branch, 'fix-checkout');
});

/* pane.js */

test('stamp\'s kept formatters write what toLocaleTimeString and toLocaleDateString did', () => {
  const now = new Date(2026, 9, 15, 14, 30);
  for (const ago of [5 * 60e3, 30 * 3600e3, 9 * 86400e3, 500 * 86400e3]) {
    const d = new Date(now.getTime() - ago);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const back = Math.round((day(now) - day(d)) / 86400000);
    const want = back === 0 ? time : back === 1 ? `Yesterday ${time}` : `${date}, ${time}`;
    assert.equal(stamp(d.getTime(), now), want);
  }
});

test('estimateHeight: folded parts are a row; messages grow with their lines; code with its lines', () => {
  const node = (tagName, cls, text, children = []) => ({ tagName, classList: { contains: (c) => c === cls }, textContent: text, children });
  assert.equal(estimateHeight(node('DETAILS', 'tool', 'x'.repeat(5000)), 32), 32, 'a folded tool line is one row whatever its output');
  const cpl = charsPerLine(700);
  assert.ok(cpl > 60 && cpl < 100, `about 88 characters a line, got ${cpl}`);
  const short = estimateHeight(node('DIV', 'turn-user', 'Fix the retry queue.'), cpl);
  const long = estimateHeight(node('DIV', 'turn-user', 'word '.repeat(200)), cpl);
  assert.ok(long > short * 3, 'a long message is taller');
  const p = (t) => node('P', '', t);
  const pre = node('PRE', '', 'line\n'.repeat(30));
  const reply = estimateHeight(node('DIV', 'turn-assistant', '', [p('One short paragraph.'), pre]), cpl);
  assert.ok(reply > 30 * 19, 'code counts by its lines');
  assert.ok(charsPerLine(0) === charsPerLine(700), 'an unknown width is a typical pane');
  assert.ok(charsPerLine(300) < charsPerLine(1400), 'narrower panes, fewer characters a line');
});

/** A Pane's prototype on a plain object with a ground (as apaki-pane-scroll.test.js does), frames run on demand. */
function scrollRig() {
  const frames = [];
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
  after(() => { if (raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = raf; });
  const ground = { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400, clientWidth: 700 };
  let reads = 0;
  const g = new Proxy(ground, { get: (o, k) => { if (k === 'scrollHeight' || k === 'clientHeight') reads += 1; return o[k]; } });
  const p = Object.create(Pane.prototype);
  Object.assign(p, { $: { ground: g, wrap: { offsetHeight: 120 } }, el: { style: { setProperty() {} } }, schedulePin() {}, _hadBox: true });
  return { p, ground, frames, reads: () => reads, frame: () => { const f = frames.splice(0); for (const x of f) x(); } };
}

test('scrollDown waits for the frame, reads the layout once for everything added, and keeps a reader who follows the end there', () => {
  const r = scrollRig();
  r.frame();
  const before = r.reads();
  // A tool line, its result and a note arrive in one frame: nothing is read until the frame, then once.
  r.p.scrollDown();
  r.ground.scrollHeight += 400;
  r.p.scrollDown();
  r.ground.scrollHeight += 900;
  r.p.scrollDown();
  assert.equal(r.reads(), before, 'no layout read per event');
  assert.equal(r.frames.length, 1, 'one frame asked for');
  r.frame();
  // 1300 px were added below a reader who was at the end: more than 160 px, and they are still taken to the end.
  assert.equal(r.ground.scrollTop, r.ground.scrollHeight);
  assert.equal(r.p.followsEnd, true);
});

test('scrollDown leaves a reader who scrolled up where they are, and follows again once they are back at the end', () => {
  const r = scrollRig();
  r.p.scrollDown();
  r.frame();
  // The reader scrolls up a long way (a scroll event Apaki did not make).
  r.ground.scrollTop = 200;
  r.p.noteScroll();
  assert.equal(r.p.followsEnd, false);
  r.ground.scrollHeight += 300;
  r.p.scrollDown();
  r.frame();
  assert.equal(r.ground.scrollTop, 200, 'not pulled down');
  // Back at the end: followed again.
  r.ground.scrollTop = r.ground.scrollHeight - r.ground.clientHeight;
  r.p.noteScroll();
  r.ground.scrollHeight += 500;
  r.p.scrollDown();
  r.frame();
  assert.equal(r.ground.scrollTop, r.ground.scrollHeight);
  // A scroll event from Apaki's own scroll to the end keeps it following, even with more text below by then.
  r.ground.scrollHeight += 2000;
  r.p.noteScroll();
  assert.equal(r.p.followsEnd, true);
  // Forced (your own message): at once, no frame.
  r.ground.scrollTop = 0;
  r.p.followsEnd = false;
  r.p.scrollDown(true);
  assert.equal(r.ground.scrollTop, r.ground.scrollHeight);
});

/* the wiring */

test('the window draws the session list again only when it must, at most once a frame for the engine, and logs a busy minute', () => {
  const app = read('../apaki/ui/app.js');
  // Numbers-only worktree refreshes leave the list and the tab bar alone (outside the Worktrees view).
  assert.match(app, /function wtChanged\(\{ save: keep = false, shape = true \} = \{\}\) \{[\s\S]*?if \(shape \|\| S\.view === 'worktrees'\) \{\n\s+if \(!S\.drag\) railSoon\(\);\n\s+renderTabs\(\);/);
  // The engine's subagent counts, terminals and keep-warm ask for one drawing on the next frame.
  assert.match(app, /else if \(s && !S\.drag\) railSoon\(\);/);
  assert.match(app, /if \(!S\.drag\) railSoon\(\);\n\s+break;\n\s+\}\n\s+case 'codexModels'/);
  assert.match(app, /S\.warm = new Set\(e\.sessions \|\| \[\]\);\n\s+if \(!S\.drag\) railSoon\(\);/);
  // Rows are kept by what they show and put in order without emptying the list.
  assert.match(app, /want\.push\(keptRow\(s, \{ grouped \}, kept\)\);/);
  // 2026-10-17: the end-of-list items are placed with the rows and kept while they show the same (keepTail).
  assert.match(app, /placeChildren\(list, \[\.\.\.want, \.\.\.tail\]\);/);
  assert.match(app, /const keepTail = \(node\) => \{ const k = node\.outerHTML; const use = tailKept\.get\(k\) \|\| node;/);
  // The folders, the views and the tab bar go on the page only when their markup changed (swapIfChanged).
  assert.match(app, /function swapIfChanged\(box, next\) \{\n\s+if \(next\.innerHTML === box\.innerHTML\) return false;/);
  assert.match(app, /markRows\(next\.querySelectorAll\('li\.srow'\)\);\n\s+if \(next\.innerHTML === box\.innerHTML\) return;/);
  assert.match(app, /swapIfChanged\(views, viewsNext\);/);
  assert.match(app, /swapIfChanged\(bar, out\);/);
  assert.ok(!/bar\.innerHTML = '';/.test(app), 'the tab bar is not emptied first');
  assert.match(app, /setText\(\$\('sessionsTitle'\), /);
  assert.ok(!/list\.innerHTML = '';\n\s+if \(wtView\)/.test(app), 'the list is not emptied first');
  // The paths are timed and a busy minute is logged, desktop only.
  for (const name of ['rail', 'tabs', 'panel', 'layout', 'save', 'panes']) assert.match(app, new RegExp(`watch\\.time\\('${name}'`));
  assert.match(app, /if \(!WEB\) \{\n\s+watch\.start\(\);\n\s+setInterval\(\(\) => \{[\s\S]*?if \(m\.line\) invoke\('ui_log', \{ text: m\.line \}\)/);
  assert.match(app, /watch\.longTask\(e\.duration\);/);
  const pane = read('../apaki/ui/pane.js');
  assert.match(pane, /watch\.time\('stream', \(\) => this\.drawStream\(a\)\)/);
  assert.match(pane, /renderHistory\(messages, total, e = \{\}\) \{ return watch\.time\('history'/);
  // A long history is folded before it is laid out, unless the reader goes back to a place in the middle.
  assert.match(pane, /if \(toEnd\) \{ this\._sealedKids = 0; this\.sealOld\(\{ blind: true \}\); \}\n\s+this\.scrollDown\(true\);/);
  assert.match(pane, /this\.sealBlind\(box, 0\);/);
});

test('the phone build ships perfwatch.js with the rest of the window (pane.js imports it there too)', async () => {
  const { build } = await import('../apaki/scripts/build-web.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-perf-ui-'));
  after(() => fs.rmSync(out, { recursive: true, force: true }));
  build({ relay: 'wss://apaki.myrlin.io', out });
  for (const f of ['perfwatch.js', 'pane.js', 'sessionlist.js', 'streampaint.js']) assert.ok(fs.existsSync(path.join(out, f)), `the web build ships ${f}`);
  assert.match(fs.readFileSync(path.join(out, 'pane.js'), 'utf8'), /from '\.\/perfwatch\.js(\?[^']*)?'/);
});
