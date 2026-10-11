/**
 * The phone's conversation pager and its "On your desktop" list (2026-10-11,
 * apaki/web/src/pager.js and desktop.js): the pure parts, from the web build
 * (the modules import Apaki's menu.js, which only the build puts next to them).
 *
 *   stripModel     the tab strip: names ("Tab N" for an empty one), counts, states
 *   pageAt         which page a scroll position shows, kept inside the pages
 *   segmentLevels  the segmented bar: one lit segment at rest, two sharing in motion
 *   deskModel      the desktop's tabs: the tab in front first, what opens here and what
 *                  is quiet, working and on-screen words, the "Show more" cut
 *   deskSummary    the header's "4 tabs · 1 working"
 *
 * Plus the wiring the evaluation relied on: the build ships both modules, native.js
 * starts them, shim.js keeps the last desktopTabs event, app.js hands the phone
 * focusPane, openFromRail and followDesktop, and the planned op follow is feature-detected.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from '../apaki/scripts/build-web.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-phone-ui-'));
let built = null;
const load = async (name) => {
  built ||= build({ relay: 'wss://apaki.myrlin.io', out });
  return import(pathToFileURL(path.join(out, name)).href);
};
after(() => fs.rmSync(out, { recursive: true, force: true }));

test('the tab strip names each tab by its focused pane, "Tab N" when it has none, with counts and states', async () => {
  const { stripModel } = await load('pager.js');
  const m = stripModel([
    { title: 'Pairing that lasts forever', n: '3', on: true, busy: true },
    { title: 'Empty tab', n: undefined },
    { title: '   ', n: '0', unread: true },
  ]);
  assert.deepEqual(m.map((t) => t.title), ['Pairing that lasts forever', 'Tab 2', 'Tab 3']);
  assert.deepEqual(m.map((t) => t.n), [3, 1, 1]);
  assert.deepEqual(m.map((t) => [t.on, t.busy, t.unread]), [[true, true, false], [false, false, false], [false, false, true]]);
  assert.deepEqual(m.map((t) => t.i), [0, 1, 2]);
});

test('the pager: the page a scroll position shows, and how lit each segment is', async () => {
  const { pageAt, segmentLevels } = await load('pager.js');
  const step = 406; // a 390 px stage and its 16 px gap
  assert.equal(pageAt(0, step, 6), 0);
  assert.equal(pageAt(step * 2, step, 6), 2);
  assert.equal(pageAt(step * 2.49, step, 6), 2);
  assert.equal(pageAt(step * 2.51, step, 6), 3);
  assert.equal(pageAt(step * 9, step, 6), 5, 'never past the last page');
  assert.equal(pageAt(-40, step, 6), 0, 'nor before the first (the bounce)');
  assert.equal(pageAt(100, 0, 6), 0, 'a stage with no width yet');
  assert.equal(pageAt(100, step, 0), 0);
  assert.deepEqual(segmentLevels(1, 3), [0, 1, 0]);
  const mid = segmentLevels(0.25, 3);
  assert.equal(mid[0], 0.75);
  assert.equal(mid[1], 0.25);
  assert.equal(mid[2], 0);
  assert.deepEqual(segmentLevels(0, 0), []);
});

test('On your desktop: the tab in front first, conversations open here, the rest are quiet, words instead of dots', async () => {
  const { deskModel, deskSummary, DESK_TABS_SHOWN } = await load('desktop.js');
  const tabs = [
    { index: 0, active: false, panes: [{ kind: 'session', sessionId: 's4', title: 'Search by meaning', busy: false, focused: true }, { kind: 'task', title: 'Explore: phones', focused: false }] },
    { index: 1, active: true, panes: [{ kind: 'session', sessionId: 's1', title: 'Pairing', busy: false, focused: true }, { kind: 'session', sessionId: 's2', title: 'Relay budget', busy: true, focused: false }, { kind: 'browser', title: 'Docs', focused: false }] },
    { index: 2, active: false, panes: [] },
    { index: 3, active: false, panes: [{ kind: 'session', sessionId: null, title: 'New conversation', busy: false, focused: true }, { kind: 'viewer', title: 'Preview', focused: false }, { kind: 'mystery', title: 'Odd', focused: false }] },
  ];
  const m = deskModel(tabs, { openHere: (id) => id === 's4' });
  assert.equal(m.total, 3, 'a tab with no panes is left out');
  assert.equal(m.working, 1);
  assert.equal(m.panes, 8);
  assert.equal(DESK_TABS_SHOWN, 2);
  assert.deepEqual(m.tabs.map((t) => t.index), [1, 0], 'in front first, then the desktop order, cut at two');
  assert.equal(m.hidden, 1);
  const [front, first] = m.tabs;
  assert.deepEqual(front.rows.map((r) => [r.kind, r.go, r.meta]), [['session', true, 'On screen'], ['session', true, 'Working'], ['browser', false, 'Browser']]);
  assert.equal(front.rows[1].busy, true);
  assert.deepEqual(first.rows.map((r) => [r.go, r.meta]), [[true, 'Open here'], [false, 'Task']], 'open on this phone already says so; a focused pane of a tab behind is not "On screen"');
  const all = deskModel(tabs, { expanded: true });
  assert.equal(all.hidden, 0);
  const last = all.tabs.at(-1).rows;
  assert.deepEqual(last.map((r) => [r.kind, r.go, r.meta]), [['session', false, 'Not started'], ['viewer', false, 'Viewer'], ['viewer', false, 'Viewer']], 'not started and unknown kinds cannot open');
  assert.equal(deskSummary(m), '3 tabs · 1 working');
  assert.equal(deskSummary(deskModel([tabs[0]])), '1 tab');
  assert.deepEqual(deskModel(null), { tabs: [], hidden: 0, total: 0, working: 0, panes: 0 });
});

test('wiring: built and started on the phone only, the last desktopTabs kept, app.js lends focusPane and openFromRail', async () => {
  await load('pager.js');
  for (const f of ['pager.js', 'desktop.js']) assert.ok(fs.existsSync(path.join(out, f)), `the web build ships ${f}`);
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const native = read('../apaki/web/src/native.js');
  assert.match(native, /initPager\(\{ haptic \}\)/);
  assert.match(native, /initDesktop\(\{ haptic, showChat \}\)/);
  assert.match(native, /body\.classList\.contains\('paged'\) && e\.target\.closest\?\.\('\.stages'\)/, 'the pages own sideways swipes; the back swipe starts on the edge');
  const shim = read('../apaki/web/src/shim.js');
  assert.match(shim, /ev\?\.ev === 'desktopTabs'\) gotDesktopTabs\(ev\); deliver\(ev\)/, 'app.js still gets the event');
  const app = read('../apaki/ui/app.js');
  assert.match(app, /window\.__apaki = \{[^}]*focusPane, openFromRail/);
  // The PC's planned op follow (2026-10-11): used only when hello lists it, unfollow on close, followed again after a
  // reconnect, never saved as a session to reopen (which would take it over), view only below Full access.
  assert.match(app, /send\('follow', \{ paneId: p\.id, desktopPaneId \}\)/);
  assert.match(app, /send\(p\.following \? 'unfollow' : 'close', \{ paneId: p\.id \}\)/);
  assert.match(app, /s: \(!p\?\.following && p\?\.sessionId\) \|\| null/);
  assert.match(shim, /if \(p\.follow\) link\.send\(\{ op: 'follow'/);
  const desk = read('../apaki/web/src/desktop.js');
  assert.match(desk, /link\?\.supports\?\.\('follow'\) && typeof A\.followDesktop === 'function'/);
  assert.match(desk, /viewOnly: \(link\.cap\?\.\(\) \|\| 'full'\) !== 'full'/);
  assert.match(desk, /A\.openFromRail\(s, \{\}\)/, 'any other PC: the session list\'s own open path');
  // Phone-only: every pager rule needs body.paged, and the desktop window never loads these modules.
  const css = read('../apaki/web/src/web.css');
  assert.match(css, /body\.web\.native\.paged \.pane-bar \{ display: none; \}/);
  assert.equal(/import .*(pager|desktop)\.js/.test(app), false);
  for (const f of ['../apaki/web/src/pager.js', '../apaki/web/src/desktop.js', '../apaki/web/src/web.css', '../apaki/mobile/src/native-shell.js']) {
    const text = read(f);
    assert.equal(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2015)), false, `${f} has no em dash`);
  }
});
