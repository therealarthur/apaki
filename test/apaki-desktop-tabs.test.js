/**
 * The desktop's tabs as a phone sees them (apaki/engine/desktop-tabs.js; Arthur, 2026-10-11: "it doesnt
 * display the tabs and the screens/windows in the tabs that are open on the desktop app").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PANES, MAX_VIEWERS, desktopTabs } from '../apaki/engine/desktop-tabs.js';
import { BROADCAST_EVENTS } from '../apaki/engine/remote-policy.js';

const leaf = (o) => ({ type: 'leaf', ...o });

test('desktop tabs: panes in layout order with kind, title, session and focus; private fields stay on the PC', () => {
  const st = {
    active: 1,
    tabs: [
      { focused: 'p1', root: { type: 'split', children: [leaf({ pane: 'p1', s: 'sess-1', title: 'Fix the build', busy: true, draft: 'secret draft', queue: [{ text: 'q' }], cwd: 'C:/private-folder' }), leaf({ pane: 'b1', web: { title: 'App Store Connect', url: 'https://example.com/private?token=1', owner: 'p1' } })] } },
      { focused: 'p3', root: { type: 'split', children: [{ type: 'split', children: [leaf({ pane: 'p2', s: 'sess-2', title: '  Two\nlines ', busy: false }), leaf({ pane: 'p3', s: 'sess-3', title: '' })] }] } },
    ],
  };
  const tabs = desktopTabs(st);
  assert.deepEqual(tabs, [
    { index: 0, active: false, label: '', panes: [{ paneId: 'p1', kind: 'session', sessionId: 'sess-1', title: 'Fix the build', busy: true, focused: true }, { paneId: 'b1', kind: 'browser', title: 'App Store Connect', for: 'Fix the build', focused: false }] },
    { index: 1, active: true, label: '', panes: [{ paneId: 'p2', kind: 'session', sessionId: 'sess-2', title: 'Two lines', busy: false, focused: false }, { paneId: 'p3', kind: 'session', sessionId: 'sess-3', title: 'New conversation', busy: false, focused: true }] },
  ]);
  const text = JSON.stringify(tabs);
  for (const secret of ['secret draft', 'token=1', 'example.com', 'private-folder', '"q"']) assert.ok(!text.includes(secret), `${secret} stays on the PC`);
});

test('desktop tabs: each pane carries the window\'s pane id so a phone can name it (follow); nothing else of the window\'s leaves goes along', () => {
  const st = {
    active: 0,
    tabs: [{ focused: 'p7', root: { type: 'split', children: [
      leaf({ pane: 'p7', s: 'sess-7', title: 'Seven', busy: false, draft: 'unsent words', queue: [{ id: 'q1', text: 'queued words' }], cwd: 'C:/secret-dir', away: { at: 'x', sessionId: 'sess-7' }, view: 'v' }),
      leaf({ pane: 'v2', artifact: { title: 'Plan.md', path: 'C:/secret-dir/plan.md' } }),
      leaf({ pane: 't1', task: { title: 'Shell', description: 'npm run dev' } }),
      leaf({ pane: '../odd id', s: 'sess-8', title: 'Odd' }),
      leaf({ pane: 'x'.repeat(41), s: 'sess-9', title: 'Long' }),
    ] } }],
  };
  const panes = desktopTabs(st)[0].panes;
  assert.deepEqual(panes.map((p) => [p.paneId, p.kind]), [['p7', 'session'], ['v2', 'viewer'], ['t1', 'task'], [null, 'session'], [null, 'session']], 'viewers and tasks carry one too (the PC refuses to follow them); an id that is not plain is sent as null');
  assert.deepEqual(Object.keys(panes[0]).sort(), ['busy', 'focused', 'kind', 'paneId', 'sessionId', 'title']);
  const text = JSON.stringify(desktopTabs(st));
  for (const secret of ['unsent words', 'queued words', 'secret-dir', 'npm run dev', '"away"', '"draft"', '"queue"']) assert.ok(!text.includes(secret), `${secret} stays on the PC`);
});

test('desktop tabs: since the side panel a tab\'s viewers are its items, each listed under its conversation, the rest last', () => {
  const st = {
    active: 0,
    tabs: [{
      focused: 'p2', label: 'acme-web',
      root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf({ pane: 'p1', s: 's1', title: 'Fix the build', draft: '' }), leaf({ pane: 'p2', s: 's2', title: 'Dashboard', draft: '' })] },
      items: [
        leaf({ pane: 'v1', view: { sessionId: 's1', id: 'a1', title: 'Findings.md', kind: 'markdown', sourcePane: 'p1' } }),
        leaf({ pane: 'b1', web: { url: 'https://example.com/private', title: 'Cart', owner: 'p2', tabs: [{ id: 'b1' }, { id: 'b2' }] } }),
        leaf({ pane: 'v2', view: { sessionId: 's2', id: 'a2', title: 'Receipt', kind: 'html', sourcePane: 'p2' } }),
        leaf({ pane: 'v9', view: { sessionId: 'gone', id: 'a9', title: 'Old notes', kind: 'markdown', sourcePane: 'closed' } }),
        { not: 'a leaf' },
      ],
      side: { open: true, group: 'p2', width: 480, pick: {} },
    }],
  };
  const panes = desktopTabs(st)[0].panes;
  assert.deepEqual(panes.map((p) => [p.paneId, p.kind, p.for || null]), [
    ['p1', 'session', null], ['v1', 'viewer', 'Fix the build'],
    ['p2', 'session', null], ['b1', 'browser', 'Dashboard'], ['v2', 'viewer', 'Dashboard'],
    ['v9', 'viewer', null],
  ]);
  assert.equal(panes[3].tabs, 2, 'a browser says how many pages');
  assert.ok(!JSON.stringify(panes).includes('example.com'), 'addresses stay on the PC');
  // Viewers come on top of the pane limit, up to their own.
  const many = Array.from({ length: 12 }, (_, i) => leaf({ pane: `v${i}`, view: { id: `a${i}`, title: `A${i}`, sourcePane: 'p1' } }));
  const lots = desktopTabs({ active: 0, tabs: [{ root: leaf({ pane: 'p1', s: 's1', title: 'One', draft: '' }), items: many }] })[0].panes;
  assert.equal(lots.length, 1 + MAX_VIEWERS);
});

test('desktop tabs: limits, empty and odd input', () => {
  const many = Array.from({ length: 9 }, (_, i) => leaf({ pane: `p${i}`, s: `s${i}`, title: `t${i}` }));
  assert.equal(desktopTabs({ active: 0, tabs: [{ root: { type: 'split', children: many } }] })[0].panes.length, MAX_PANES);
  assert.deepEqual(desktopTabs(null), []);
  assert.deepEqual(desktopTabs({ tabs: [{ root: null }] }), [{ index: 0, active: false, label: '', panes: [] }]);
  assert.ok(BROADCAST_EVENTS.has('desktopTabs'), 'every connected phone gets it, and it is cached for phones that connect later');
});
