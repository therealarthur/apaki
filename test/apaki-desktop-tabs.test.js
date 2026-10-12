/**
 * The desktop's tabs as a phone sees them (apaki/engine/desktop-tabs.js; Arthur, 2026-10-11: "it doesnt
 * display the tabs and the screens/windows in the tabs that are open on the desktop app").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PANES, desktopTabs } from '../apaki/engine/desktop-tabs.js';
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
    { index: 0, active: false, panes: [{ paneId: 'p1', kind: 'session', sessionId: 'sess-1', title: 'Fix the build', busy: true, focused: true }, { paneId: 'b1', kind: 'browser', title: 'App Store Connect', focused: false }] },
    { index: 1, active: true, panes: [{ paneId: 'p2', kind: 'session', sessionId: 'sess-2', title: 'Two lines', busy: false, focused: false }, { paneId: 'p3', kind: 'session', sessionId: 'sess-3', title: 'New conversation', busy: false, focused: true }] },
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

test('desktop tabs: limits, empty and odd input', () => {
  const many = Array.from({ length: 9 }, (_, i) => leaf({ pane: `p${i}`, s: `s${i}`, title: `t${i}` }));
  assert.equal(desktopTabs({ active: 0, tabs: [{ root: { type: 'split', children: many } }] })[0].panes.length, MAX_PANES);
  assert.deepEqual(desktopTabs(null), []);
  assert.deepEqual(desktopTabs({ tabs: [{ root: null }] }), [{ index: 0, active: false, panes: [] }]);
  assert.ok(BROADCAST_EVENTS.has('desktopTabs'), 'every connected phone gets it, and it is cached for phones that connect later');
});
