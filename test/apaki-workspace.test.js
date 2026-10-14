/**
 * Tests for Myrlin Apaki's workspace rules (apaki/ui/workspace.js, design in
 * apaki/docs/layout.md): the layout chooser by count and shape, the presets,
 * viewers kept beside their conversation, placing a pane in a hand-made tree,
 * tab names, viewer reuse and link accents, going to an open session,
 * maximize and restore, and folding an old workspace's browser panes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as L from '../apaki/ui/layout-tree.js';
import * as W from '../apaki/ui/workspace.js';

const conv = () => ({ viewer: false, source: null });
const infoOf = (map) => (id) => map[id] || conv();
/** The tree's shape as nested arrays: a leaf is its id, a split is [dir, ...children]. */
const shape = (n) => (n.type === 'leaf' ? n.pane : [n.dir, ...n.children.map(shape)]);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the layout chooser: 1 to 6 conversations in a wide tab', () => {
  const lay = (n) => shape(W.arrange(['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n), infoOf({}), { w: 1440, h: 860 }));
  assert.equal(lay(1), 'a');
  assert.deepEqual(lay(2), ['row', 'a', 'b']);
  assert.deepEqual(lay(3), ['row', 'a', ['col', 'b', 'c']]);
  assert.deepEqual(lay(4), ['col', ['row', 'a', 'b'], ['row', 'c', 'd']]);
  assert.deepEqual(lay(5), ['col', ['row', 'a', 'b', 'c'], ['row', 'd', 'e']]);
  assert.deepEqual(lay(6), ['col', ['row', 'a', 'b', 'c'], ['row', 'd', 'e', 'f']]);
});

test('the layout chooser: a tall tab stacks instead', () => {
  const lay = (n) => shape(W.arrange(['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n), infoOf({}), { w: 700, h: 1100 }));
  assert.deepEqual(lay(2), ['col', 'a', 'b']);
  assert.deepEqual(lay(3), ['col', ['row', 'a', 'b'], 'c']);
  assert.deepEqual(lay(4), ['col', ['row', 'a', 'b'], ['row', 'c', 'd']]);
  assert.deepEqual(lay(5), ['col', ['row', 'a', 'b'], ['row', 'c', 'd'], 'e']);
  assert.deepEqual(lay(6), ['col', ['row', 'a', 'b'], ['row', 'c', 'd'], ['row', 'e', 'f']]);
  assert.equal(W.shapeOf(0, 0), 'wide', 'a tab not measured yet counts as wide');
});

test('presets: columns, rows, grid, main and stack', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const go = (preset, w = 1600, h = 900) => shape(W.arrange(ids, infoOf({}), { preset, w, h }));
  assert.deepEqual(go('columns'), ['row', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(go('rows'), ['col', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(go('grid'), ['col', ['row', 'a', 'b', 'c'], ['row', 'd', 'e']]);
  assert.deepEqual(go('grid', 800, 1200), ['col', ['row', 'a', 'b'], ['row', 'c', 'd'], 'e']);
  assert.deepEqual(go('main'), ['row', 'a', ['col', 'b', 'c', 'd', 'e']]);
  assert.deepEqual(go('main', 800, 1200), ['col', 'a', ['row', 'b', 'c', 'd', 'e']]);
  const m = W.arrange(ids, infoOf({}), { preset: 'main' });
  assert.ok(near(m.sizes[0], W.MAIN_SHARE));
  // Picking Main and stack from the menu puts the focused one first.
  assert.deepEqual(W.withFirst(ids, infoOf({}), 'c'), ['c', 'a', 'b', 'd', 'e']);
  for (const p of [...W.ARRANGEMENTS, 'nonsense']) for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(L.valid(W.arrange(ids.concat('f').slice(0, n), infoOf({}), { preset: p })), `${p} ${n}`);
});

test('a viewer sits beside its conversation at the smaller share, in that conversation\'s cell', () => {
  const info = infoOf({ v: { viewer: true, source: 'a' }, w: { viewer: true, source: 'a' }, x: { viewer: true, source: 'b' } });
  let t = W.arrange(['a', 'b', 'v'], info, { w: 1600, h: 900 });
  // Two conversations side by side; a's cell is tall (800 by 900), so its viewer goes below it.
  assert.deepEqual(shape(t), ['row', ['col', 'a', 'v'], 'b']);
  assert.ok(near(t.children[0].sizes[1], W.VIEWER_SHARE));
  // One conversation in a wide tab: the viewer is to its right.
  t = W.arrange(['a', 'v'], info, { w: 1600, h: 900 });
  assert.deepEqual(shape(t), ['row', 'a', 'v']);
  assert.ok(near(t.sizes[0], 1 - W.VIEWER_SHARE));
  // Two viewers of one conversation share the 40, stacked.
  t = W.arrange(['a', 'v', 'w'], info, { w: 1600, h: 900 });
  assert.deepEqual(shape(t), ['row', 'a', ['col', 'v', 'w']]);
  // Viewers follow their conversation whatever their place in the old tree.
  t = W.arrange(['x', 'a', 'b'], info, { w: 1600, h: 900 });
  assert.deepEqual(L.ids(t), ['a', 'b', 'x']);
  assert.ok(L.valid(t));
});

test('viewers whose conversation is elsewhere group by their source, in their place', () => {
  const info = infoOf({ v: { viewer: true, source: 'gone' }, w: { viewer: true, source: 'gone' }, z: { viewer: true, source: null } });
  const g = W.groupsOf(['a', 'v', 'b', 'w', 'z'], info);
  assert.deepEqual(g.map((x) => [x.conv, x.viewers]), [['a', []], [null, ['v', 'w']], ['b', []], [null, ['z']]]);
  const t = W.arrange(['v', 'z'], info, { w: 1600, h: 900 });
  assert.deepEqual(shape(t), ['row', 'v', 'z']);
});

test('placing a pane in a tree you arranged by hand', () => {
  // row[a (0.7), b (0.3)]: a new conversation splits the largest pane (a) along its longer side.
  const root = { type: 'split', dir: 'row', children: [L.leaf('a'), L.leaf('b')], sizes: [0.7, 0.3] };
  let t = W.placeCustom(root, 'c', { w: 1600, h: 900 });
  assert.deepEqual(L.ids(t), ['a', 'c', 'b']);
  assert.ok(L.valid(t));
  // A viewer goes beside its conversation at the smaller share (b is tall: below it).
  t = W.placeCustom(root, 'v', { source: 'b', w: 1600, h: 900 });
  assert.deepEqual(shape(t), ['row', 'a', ['col', 'b', 'v']]);
  assert.ok(near(t.children[1].sizes[1], W.VIEWER_SHARE));
  // A second viewer of b splits b's first viewer, not b.
  const t2 = W.placeCustom(t, 'w', { source: 'b', viewersOf: () => ['v'], w: 1600, h: 900 });
  assert.deepEqual(L.ids(t2), ['a', 'b', 'v', 'w']);
  assert.ok(L.valid(t2));
  assert.deepEqual(W.placeCustom(null, 'x'), L.leaf('x'));
});

test('insert takes a share for the new pane, and keeps halving by default', () => {
  const r = L.insert(L.leaf('a'), 'a', 'v', 'right', 0.4);
  assert.deepEqual(r.sizes, [0.6, 0.4]);
  const l = L.insert(L.leaf('a'), 'a', 'v', 'left', 0.4);
  assert.deepEqual(l.sizes, [0.4, 0.6]);
  assert.deepEqual(L.insert(L.leaf('a'), 'a', 'b', 'right').sizes, [0.5, 0.5]);
});

test('tab names: the shared project, two or more, yours, never one of several sessions', () => {
  const c = (project, title = 'x') => ({ project, title });
  assert.deepEqual(W.tabLabel({ convs: [c('acme-web', 'Fix checkout'), c('acme-web', 'Add tests')] }), { text: 'acme-web', auto: true });
  assert.equal(W.tabLabel({ convs: [c('acme-web'), c('billing')] }).text, 'acme-web · billing');
  assert.equal(W.tabLabel({ convs: [c('acme-web'), c('billing'), c('docs'), c('acme-web')] }).text, 'acme-web · billing +1');
  assert.deepEqual(W.tabLabel({ name: '  Release  ', convs: [c('acme-web')] }), { text: 'Release', auto: false });
  // Conversations without a folder yet do not count; only new ones: "New conversation".
  assert.equal(W.tabLabel({ convs: [c(null, 'New conversation'), c('billing')] }).text, 'billing');
  assert.equal(W.tabLabel({ convs: [c(null, 'New conversation'), c(null, 'New conversation')] }).text, 'New conversation');
  assert.equal(W.tabLabel({ convs: [], viewers: [{ title: 'Checkout · Acme' }] }).text, 'Checkout · Acme');
  assert.equal(W.tabLabel({}).text, 'Empty tab');
});

test('tab names: projects from folders, repositories and the home folder', () => {
  assert.equal(W.projectOf('C:\\Users\\someone\\Projects\\acme-web'), 'acme-web');
  assert.equal(W.projectOf('C:\\Users\\someone\\'), 'Home');
  assert.equal(W.projectOf('/Users/someone'), 'Home');
  assert.equal(W.projectOf('/home/someone/'), 'Home');
  assert.equal(W.projectOf('C:\\Users\\someone\\Projects\\acme-web\\.claude\\worktrees\\fix-1', (p) => (p.includes('acme-web') ? 'acme-web' : null)), 'acme-web');
  assert.equal(W.projectOf(''), null);
});

test('tab names: the same project in two one-conversation tabs adds each title, quietly', () => {
  const out = W.tabLabels([
    { convs: [{ project: 'claude-latch', title: 'Layout redesign' }] },
    { convs: [{ project: 'claude-latch', title: 'macOS port' }] },
    { convs: [{ project: 'claude-latch', title: 'a' }, { project: 'claude-latch', title: 'b' }] },
    { convs: [{ project: 'acme-web', title: 'Fix checkout' }] },
  ]);
  assert.deepEqual(out.map((x) => [x.text, x.sub, x.count]), [
    ['claude-latch', 'Layout redesign', 1], ['claude-latch', 'macOS port', 1], ['claude-latch', '', 2], ['acme-web', '', 1],
  ]);
});

test('viewers: one of each kind per conversation, found by kind and source', () => {
  const panes = [
    { id: 'a' }, { id: 'b1', isViewer: true, isBrowser: true, sourcePane: 'a' },
    { id: 'd1', isViewer: true, isDiff: true, sourcePane: 'a' }, { id: 'v1', isViewer: true, sourcePane: 'b' },
  ];
  assert.equal(W.viewerFor(panes, 'browser', 'a').id, 'b1');
  assert.equal(W.viewerFor(panes, 'diff', 'a').id, 'd1');
  assert.equal(W.viewerFor(panes, 'artifact', 'a'), null);
  assert.equal(W.viewerFor(panes, 'artifact', 'b').id, 'v1');
  assert.equal(W.viewerFor(panes, 'browser', null), null);
  assert.deepEqual(panes.map(W.kindOf), ['conversation', 'browser', 'diff', 'artifact']);
});

test('link accents: kept while free, otherwise the lowest free one, neighbours differ', () => {
  let m = W.accents(['a', 'b', 'c']);
  assert.deepEqual([...m.values()], [0, 1, 2]);
  m = W.accents(['b', 'c', 'd'], m);
  assert.deepEqual([m.get('b'), m.get('c'), m.get('d')], [1, 2, 0]);
  const many = W.accents(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(new Set(many.values()).size, W.ACCENTS);
});

test('going to an open session: its tab, its pane, and a maximized other pane restored first', () => {
  const state = {
    active: 't1',
    tabs: [{ id: 't1', ids: ['p1', 'p2'], max: null }, { id: 't2', ids: ['p3', 'p4'], max: 'p4' }],
    paneOf: (sid) => ({ s1: 'p1', s3: 'p3', s4: 'p4' }[sid] || null),
  };
  assert.equal(W.goTo(state, 'nope'), null);
  assert.deepEqual(W.goTo(state, 's1'), { tab: 't1', pane: 'p1', switchTab: false, restore: null });
  assert.deepEqual(W.goTo(state, 's3'), { tab: 't2', pane: 'p3', switchTab: true, restore: 'p4' });
  assert.deepEqual(W.goTo(state, 's4'), { tab: 't2', pane: 'p4', switchTab: true, restore: null });
});

test('maximize and restore leave the tree exactly as it was', () => {
  const root = { type: 'split', dir: 'row', sizes: [0.37, 0.63], children: [L.leaf('a'), { type: 'split', dir: 'col', sizes: [0.2, 0.8], children: [L.leaf('b'), L.leaf('c')] }] };
  const before = JSON.stringify(root);
  let tab = { id: 't', root, focused: 'c', max: null };
  tab = W.toggleMax(tab, 'c');
  assert.equal(tab.max, 'c');
  assert.equal(JSON.stringify(tab.root), before);
  // Saved and read back while maximized (the workspace keeps it), then restored.
  tab = JSON.parse(JSON.stringify(tab));
  tab = W.toggleMax(tab, 'c');
  assert.equal(tab.max, null);
  assert.equal(JSON.stringify(tab.root), before);
  assert.equal(W.toggleMax(tab, 'zz').max, null, 'a pane not in the tab cannot be maximized');
});

test('an old workspace: several browsers of one conversation fold into its browser pane; others stay', () => {
  const conv = (pane, s) => ({ type: 'leaf', pane, s, cwd: '', title: s, draft: '' });
  const web = (pane, owner, url) => ({ type: 'leaf', pane, web: { url, title: url, owner } });
  const saved = [
    { focused: 'p1', root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [conv('p1', 's1'), web('b1', 'p1', 'http://localhost:5173/')] } },
    // The old hint 'tab' made a whole Apaki tab for another page of p1.
    { focused: 'b2', root: web('b2', 'p1', 'https://docs.example/') },
    { focused: 'p2', root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [conv('p2', 's2'), web('b3', null, 'https://unlinked.example/')] } },
  ];
  const { tabs, active } = W.foldBrowsers(saved, 2);
  assert.equal(tabs.length, 2, 'the tab that only held p1\'s second browser goes');
  assert.equal(active, 1, 'the active tab is still the same one');
  const b1 = L.mapLeaves(tabs[0].root, (x) => x).children[1];
  assert.deepEqual(b1.web.tabs.map((x) => x.id), ['b1', 'b2']);
  assert.equal(b1.web.active, 'b1');
  assert.deepEqual(L.ids(tabs[1].root), ['p2', 'b3'], 'a browser with no conversation stays as it is');
  // Nothing to fold: the same object back.
  const same = W.foldBrowsers([saved[2]], 0);
  assert.equal(same.tabs[0], saved[2]);
});

/* ---------- the side panel (2026-10-13) ---------- */

test('side panel: items group under their conversation in layout order, Other last, browser pages first', () => {
  const items = [
    { id: 'v1', kind: 'artifact', source: 'b' },
    { id: 'w1', kind: 'browser', source: 'b', pages: ['w1', 'w1x'] },
    { id: 'k1', kind: 'task', source: 'b' },
    { id: 'd1', kind: 'diff', source: 'b' },
    { id: 'v2', kind: 'artifact', source: 'a' },
    { id: 'v3', kind: 'artifact', source: 'gone' },
    { id: 'w2', kind: 'browser', source: null, pages: [] },
    { id: 'v4', kind: 'artifact', source: 'b' },
  ];
  const g = W.panelGroups(['a', 'b', 'c'], items);
  assert.deepEqual(g.map((x) => x.key), ['a', 'b', W.OTHER], 'a and b in layout order; c has nothing; Other last');
  assert.deepEqual(g[1].entries.map((e) => e.key), ['w1#w1', 'w1#w1x', 'v1', 'v4', 'd1', 'k1'], 'each browser page its own entry, then artifacts, changes, tasks');
  assert.deepEqual(g[1].entries.slice(0, 2).map((e) => [e.item, e.page, e.kind]), [['w1', 'w1', 'browser'], ['w1', 'w1x', 'browser']]);
  assert.deepEqual(g[2].entries.map((e) => e.key), ['w2', 'v3'], 'a browser without pages is one entry; orphans stay in opened order by kind');
  assert.equal(g[2].conv, null);
  assert.deepEqual(W.panelGroups(['a'], []), []);
  assert.deepEqual(W.panelGroups([], [{ id: 'x', kind: 'weird', source: 'a' }])[0].entries[0].kind, 'artifact', 'an unknown kind is drawn as an artifact');
});

test('side panel: it follows focus, keeps showing something with a quiet note, and a pick in the switcher holds', () => {
  const groups = W.panelGroups(['a', 'b', 'c'], [{ id: 'v1', kind: 'artifact', source: 'a' }, { id: 'v2', kind: 'artifact', source: 'b' }, { id: 'v3', kind: 'artifact', source: 'gone' }]);
  // Focusing b shows b's items; focusing c (nothing open) keeps showing what was there.
  assert.equal(W.followFocus(groups, 'b', 'a'), 'b');
  assert.equal(W.followFocus(groups, 'c', 'a'), 'a');
  assert.deepEqual(W.shownGroup(groups, { focus: 'c', want: 'a' }), { group: 'a', note: true }, 'c has nothing: a stays, and the panel says so');
  assert.deepEqual(W.shownGroup(groups, { focus: 'b', want: 'b' }), { group: 'b', note: false });
  // Other picked in the switcher while b has the focus: it holds, without the note (b has items of its own).
  assert.deepEqual(W.shownGroup(groups, { focus: 'b', want: W.OTHER }), { group: W.OTHER, note: false });
  // The wanted group closed: the focused conversation's, else the first.
  assert.deepEqual(W.shownGroup(groups, { focus: 'b', want: 'zz' }), { group: 'b', note: false });
  assert.deepEqual(W.shownGroup(groups, { focus: null, want: null }), { group: 'a', note: false });
  assert.deepEqual(W.shownGroup([], { focus: 'a', want: 'a' }), { group: null, note: false }, 'nothing open: nothing shown');
});

test('side panel: the entry a group shows, the one after a close, and the panel width', () => {
  const [g] = W.panelGroups(['a'], [{ id: 'w', kind: 'browser', source: 'a', pages: ['p1', 'p2', 'p3'] }, { id: 'v', kind: 'artifact', source: 'a' }]);
  assert.equal(W.currentEntry(g, 'w', () => 'p2').key, 'w#p2', 'a browser shows the page it has on screen');
  assert.equal(W.currentEntry(g, 'v').key, 'v');
  assert.equal(W.currentEntry(g, 'closed').key, 'w#p1', 'a picked item that is gone: the first entry');
  assert.equal(W.currentEntry({ entries: [] }, 'v'), null);
  assert.equal(W.neighbourEntry(g, 'w#p2').key, 'v', 'the browser closes: the next thing that is not one of its pages');
  assert.equal(W.neighbourEntry(g, 'v').key, 'w#p3', 'the last one closes: the one before');
  assert.equal(W.neighbourEntry({ entries: [{ key: 'x', item: 'x' }] }, 'x'), null);
  // Width: the default share, yours held between the limits, and the conversations keep room.
  assert.equal(W.panelWidth(null, 1000), 400);
  assert.equal(W.panelWidth(null, 2400), W.PANEL_DEFAULT_MAX, 'a wide screen gives its room to the conversations');
  assert.equal(W.panelWidth(900, 2400), 900, 'a width you dragged to is kept');
  assert.equal(W.panelWidth(200, 1000), W.PANEL_MIN);
  assert.equal(W.panelWidth(900, 1000), 1000 - W.PANEL_MAIN_MIN);
  assert.equal(W.panelWidth(5000, 4000), W.PANEL_MAX);
  assert.equal(W.panelWidth(500, 500), W.PANEL_MIN, 'a tiny window still gets a usable panel');
});

test('side panel: maximized, previous and next go through the tab\'s conversations, wrapping', () => {
  assert.equal(W.stepMax(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(W.stepMax(['a', 'b', 'c'], 'c', 1), 'a');
  assert.equal(W.stepMax(['a', 'b', 'c'], 'a', -1), 'c');
  assert.equal(W.stepMax(['a', 'b', 'c'], 'zz', 1), 'a');
  assert.equal(W.stepMax([], 'a', 1), null);
  // Maximize with the panel: the tab's tree, its items and its panel are untouched by toggling.
  const root = { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [L.leaf('a'), L.leaf('b')] };
  let tab = { id: 't', root, max: null, items: ['v1'], side: { open: true, group: 'a' } };
  tab = W.toggleMax(tab, 'a');
  assert.equal(tab.max, 'a');
  assert.deepEqual([tab.items, tab.side], [['v1'], { open: true, group: 'a' }]);
  tab = W.toggleMax({ ...tab, max: W.stepMax(L.ids(tab.root), tab.max, 1) }, 'b');
  assert.equal(tab.max, null, 'moved to b, then restored from b');
});

test('side panel: an old workspace\'s viewer leaves move into their conversation\'s panel; orphans stay under Other', () => {
  // Arthur's messy tab, as saved before the panel: three conversations in a row on top (the left one with a markdown
  // viewer below it), and below them the middle conversation's browser beside an HTML viewer of the same one.
  const conv = (pane, s) => ({ type: 'leaf', pane, s, cwd: '', title: s, draft: '' });
  const web = (pane, owner) => ({ type: 'leaf', pane, web: { url: 'https://forge.example/', title: 'Forge', owner, tabs: [{ id: pane, url: 'https://forge.example/', title: 'Forge' }], active: pane } });
  const view = (pane, sourcePane, kind = 'html') => ({ type: 'leaf', pane, view: { sessionId: 's', id: `art-${pane}`, title: pane, kind, sourcePane } });
  const split = (dir, sizes, ...children) => ({ type: 'split', dir, sizes, children });
  const messy = {
    focused: 'p1', name: '', arrange: 'custom', max: 'p1',
    root: split('col', [0.57, 0.43],
      split('row', [0.39, 0.33, 0.28], split('col', [0.74, 0.26], conv('p1', 'audi'), view('v1', 'p1', 'markdown')), conv('p2', 'forge'), conv('p3', 'studio')),
      split('row', [0.5, 0.5], web('b1', 'p2'), view('v2', 'p2'))),
  };
  const saved = [
    { focused: 'q1', root: split('row', [0.83, 0.17], conv('q1', 'home'), web('b9', 'q1')) },
    messy,
    // A tab that held only p3's subagent viewer (opened in a new tab when the old tab was full) and a viewer whose
    // conversation was closed long ago.
    { focused: 'k1', arrange: 'auto', root: split('row', [0.5, 0.5], { type: 'leaf', pane: 'k1', view: { task: true, kind: 'agent', sessionId: 's3', ownerPane: 'p3', title: 'Explore' } }, view('v9', 'closed-long-ago')) },
    { focused: 'q2', arrange: 'auto', shape: 'wide', root: split('row', [0.6, 0.4], conv('q2', 'jobs'), { type: 'leaf', pane: 'd1', view: { diff: { path: 'C:/r', ownerPane: 'q2' } } }) },
  ];
  const { tabs, active, moved } = W.migrateViewers(saved, 1);
  assert.equal(moved, 7);
  assert.equal(tabs.length, 4, 'the third tab keeps its orphan, so it stays');
  assert.equal(active, 1);
  // The messy tab: only its three conversations in the tree, as you sized them (the bottom row's space goes to them).
  const t = tabs[1];
  assert.deepEqual(shape(t.root), ['row', 'p1', 'p2', 'p3']);
  assert.ok(L.valid(t.root));
  assert.deepEqual(t.root.sizes.map((x) => Math.round(x * 100)), [39, 33, 28]);
  assert.deepEqual(t.items.map((x) => x.pane), ['v1', 'b1', 'v2', 'k1'], 'p1\'s markdown, p2\'s browser and HTML, and p3\'s subagent from the other tab');
  assert.deepEqual(t.side, { open: true, group: 'p1', width: null, pick: {} }, 'the panel starts open on the focused conversation');
  assert.equal(t.max, 'p1', 'a maximized conversation stays maximized');
  // The panel groups that come out of it.
  const groups = W.panelGroups(L.ids(t.root), t.items.map((lf) => ({ id: lf.pane, kind: lf.web ? 'browser' : lf.view.task ? 'task' : 'artifact', source: W.leafOwner(lf), pages: lf.web?.tabs?.map((x) => x.id) })));
  assert.deepEqual(groups.map((g) => [g.key, g.entries.map((e) => e.key)]), [['p1', ['v1']], ['p2', ['b1#b1', 'v2']], ['p3', ['k1']]]);
  // The orphan stays where it was, under Other, its tab empty of conversations.
  assert.equal(tabs[2].root, null);
  assert.deepEqual(tabs[2].items.map((x) => x.pane), ['v9']);
  assert.equal(tabs[2].focused, null);
  assert.deepEqual(W.panelGroups([], [{ id: 'v9', kind: 'artifact', source: W.leafOwner(tabs[2].items[0]) }]).map((g) => g.key), [W.OTHER]);
  // An arranged tab is laid out again for what is left; a diff follows its conversation.
  assert.equal(shape(tabs[3].root), 'q2');
  assert.deepEqual(tabs[3].root, saved[3].root.children[0], 'the conversation keeps its saved leaf: session, title, draft');
  assert.deepEqual(tabs[3].items.map((x) => x.pane), ['d1']);
  assert.equal(tabs[0].root.pane, 'q1');
  assert.deepEqual(tabs[0].items.map((x) => x.pane), ['b9']);
  // Nothing to move: the same tabs back, and a second pass changes nothing.
  assert.equal(W.migrateViewers(tabs, active).tabs, tabs);
  assert.equal(W.migrateViewers(tabs, active).moved, 0);
  assert.deepEqual(W.migrateViewers(null), { tabs: [], active: 0, moved: 0 });
});

test('side panel: a tab that held only viewers of conversations elsewhere goes, and the active tab follows', () => {
  const conv = (pane) => ({ type: 'leaf', pane, s: pane, title: pane, draft: '' });
  const saved = [
    { focused: 'b2', root: { type: 'leaf', pane: 'b2', web: { url: 'https://x.example/', owner: 'p1' } } },
    { focused: 'p1', root: conv('p1') },
  ];
  const { tabs, active } = W.migrateViewers(saved, 1);
  assert.equal(tabs.length, 1);
  assert.equal(active, 0);
  assert.deepEqual(tabs[0].items.map((x) => x.pane), ['b2']);
  assert.equal(tabs[0].focused, 'p1');
  // An arranged tab of two conversations and a viewer: laid out again, every conversation's saved leaf kept.
  const arranged = W.migrateViewers([{ focused: 'a', arrange: 'auto', shape: 'wide', root: { type: 'split', dir: 'row', sizes: [0.6, 0.4], children: [conv('a'), { type: 'split', dir: 'col', sizes: [0.6, 0.4], children: [{ type: 'leaf', pane: 'v', view: { id: 'x', sourcePane: 'a' } }, conv('b')] }] } }], 0);
  assert.deepEqual(shape(arranged.tabs[0].root), ['row', 'a', 'b']);
  assert.deepEqual(L.mapLeaves(arranged.tabs[0].root, (lf) => lf).children.map((lf) => [lf.pane, lf.s, lf.title]), [['a', 'a', 'a'], ['b', 'b', 'b']]);
  // A focus on a viewer goes to its conversation.
  const one = W.migrateViewers([{ focused: 'a', root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [conv('a'), conv('b')] } }, { focused: 'v', root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [conv('c'), { type: 'leaf', pane: 'v', view: { id: 'x', sourcePane: 'c' } }] } }], 0);
  assert.equal(one.tabs[1].focused, 'c');
  assert.equal(W.isViewerLeaf(conv('a')), false);
  assert.equal(W.leafOwner({ type: 'leaf', pane: 'k', task: { ownerPane: 'p9' } }), 'p9');
});
