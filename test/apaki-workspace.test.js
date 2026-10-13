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
