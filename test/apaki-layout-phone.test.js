/**
 * Tabs, layouts and viewers on the phone and in the browser pane (2026-10-12, apaki/docs/layout.md): the phone shows
 * the PC's tab names and its viewer links ("On your desktop", desktop-tabs.js), its own pages say whose a viewer is
 * (pager.js linkLine), its browser view lists the conversation's browser tabs (browserview.js tabsModel), and the
 * browser pane's tabs are named and matched the same way everywhere (browser.js).
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from '../apaki/scripts/build-web.mjs';
import { desktopTabs } from '../apaki/engine/desktop-tabs.js';
import { samePage, tabInitial, tabTitle } from '../apaki/ui/browser.js';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-layout-phone-'));
let built = null;
const load = async (name) => {
  built ||= build({ relay: 'wss://apaki.myrlin.io', out });
  return import(pathToFileURL(path.join(out, name)).href);
};
after(() => fs.rmSync(out, { recursive: true, force: true }));
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const conv = (pane, s, title) => ({ type: 'leaf', pane, s, cwd: '', title, draft: '' });

test('desktop tabs carry the PC\'s tab name and each viewer\'s conversation', () => {
  const state = {
    active: 0,
    tabs: [
      { label: 'acme-web', focused: 'p1', root: { type: 'split', dir: 'row', sizes: [0.6, 0.4], children: [
        conv('p1', 'sess-1', 'Fix flaky checkout test'),
        { type: 'leaf', pane: 'b1', web: { url: 'http://localhost:3000/cart', title: 'Cart', owner: 'p1', tabs: [{ id: 'b1' }, { id: 'b2' }], active: 'b1' } },
      ] } },
      { focused: 'p2', root: { type: 'split', dir: 'row', sizes: [0.5, 0.25, 0.25], children: [
        conv('p2', 'sess-2', 'Migrate invoices'),
        { type: 'leaf', pane: 'v1', view: { sessionId: 'sess-2', id: 'art-1', title: 'Report', kind: 'html', sourcePane: 'p2' } },
        { type: 'leaf', pane: 't1', view: { task: true, kind: 'agent', sessionId: 'sess-2', title: 'Find callers', ownerPane: 'p2' } },
      ] } },
    ],
  };
  const [a, b] = desktopTabs(state);
  assert.equal(a.label, 'acme-web');
  assert.equal(b.label, '', 'a tab saved by an older window has no name to send');
  assert.deepEqual(a.panes[1], { kind: 'browser', title: 'Cart', tabs: 2, for: 'Fix flaky checkout test', paneId: 'b1', focused: false });
  assert.deepEqual(b.panes.map((p) => [p.kind, p.title, p.for]), [['session', 'Migrate invoices', undefined], ['viewer', 'Report', 'Migrate invoices'], ['task', 'Find callers', 'Migrate invoices']]);
});

test('"On your desktop": the tab\'s name, honest counts, and whose a viewer is', async () => {
  const { deskModel, paneCount } = await load('desktop.js');
  const m = deskModel([
    { index: 0, active: true, label: 'acme-web', panes: [
      { kind: 'session', sessionId: 's1', title: 'Fix flaky checkout test', paneId: 'p1', focused: true },
      { kind: 'browser', title: 'Cart', tabs: 2, for: 'Fix flaky checkout test', paneId: 'b1' },
    ] },
    { index: 1, active: false, panes: [{ kind: 'session', sessionId: 's2', title: 'Migrate invoices', paneId: 'p2' }] },
  ]);
  assert.equal(m.tabs[0].label, 'acme-web');
  assert.equal(m.tabs[1].label, 'Tab 2', 'an older PC sends no name: the old one');
  assert.equal(m.tabs[0].rows[1].for, 'Fix flaky checkout test');
  assert.equal(m.tabs[0].rows[1].meta, 'Browser · 2 tabs');
  assert.equal(m.tabs[0].rows[0].for, '', 'a conversation is nobody\'s viewer');
  assert.equal(paneCount(m.tabs[0].rows), '1 conversation · 1 viewer');
  assert.equal(paneCount(m.tabs[1].rows), '1 conversation');
});

test('the pager\'s link line: whose a viewer is, how many viewers a conversation has', async () => {
  const { linkLine } = await load('pager.js');
  assert.equal(linkLine({ chip: 'Fix flaky checkout test' }), 'for Fix flaky checkout test');
  assert.equal(linkLine({ chip: 'Fix flaky checkout test', gone: true }), 'was for Fix flaky checkout test');
  assert.equal(linkLine({ viewers: 1 }), '1 viewer');
  assert.equal(linkLine({ viewers: 3 }), '3 viewers');
  assert.equal(linkLine({}), '');
});

test('the phone\'s browser view lists the conversation\'s browser tabs and sends the one picked', async () => {
  const { viewModel, tabsModel } = await load('browserview.js');
  const tabs = tabsModel([
    { id: 'b1', title: 'Checkout · Acme Store', url: 'http://localhost:3000/checkout', active: true },
    { id: 'b2', title: '', url: 'http://localhost:3000/cart', active: false },
    { id: 'bad id!', title: 'x', url: '', active: false },
    { id: 'b3', title: '', url: 'about:blank', active: false },
  ]);
  assert.deepEqual(tabs, [
    { id: 'b1', title: 'Checkout · Acme Store', active: true },
    { id: 'b2', title: 'localhost:3000', active: false },
    { id: 'b3', title: 'New tab', active: false },
  ]);
  assert.deepEqual(tabsModel(null), []);
  const page = viewModel({ ok: true, image: 'QUJD', mime: 'image/jpeg', width: 10, height: 10, state: { url: 'http://localhost:3000/checkout' }, tabs: [{ id: 'b1', url: 'x', active: true }, { id: 'b2', url: 'y' }] });
  assert.equal(page.tabs.length, 2);
  const src = read('../apaki/web/src/browserview.js');
  assert.match(src, /op: 'browserView', reqId, paneId: V\.pane, \.\.\.\(tab \? \{ tab \} : \{\}\)/, 'a picked tab goes along with the next look');
});

test('browser tabs are named and matched the same way in the pane, the engine and the phone', () => {
  assert.equal(tabTitle({ url: 'http://localhost:5173/', title: 'Vite App' }), 'Vite App');
  assert.equal(tabTitle({ url: 'http://localhost:5173/', title: 'http://localhost:5173/' }), 'localhost:5173');
  assert.equal(tabTitle({ url: 'about:blank' }), 'New tab');
  assert.equal(tabInitial({ url: 'https://www.github.com/acme' }), 'G');
  assert.equal(tabInitial({ url: '' }), 'N');
  assert.ok(samePage('http://localhost:5173/#top', 'http://localhost:5173'));
  assert.ok(!samePage('http://localhost:5173/a', 'http://localhost:5173/b'));
  assert.ok(!samePage('', ''));
});

test('the wiring: viewers linked on the PC, the phone mirrors the link, a tab pick reaches the engine', () => {
  const app = read('../apaki/ui/app.js');
  assert.match(app, /send\('browserTab', \{ paneId: b\.sourcePane, browserId \}\)/, 'a picked tab tells the engine');
  assert.match(app, /if \(existing\) \{ revealPane\(existing\); return; \}/, 'an open session is gone to, not opened again');
  assert.match(app, /W\.foldBrowsers\(/, 'an old workspace folds its browsers');
  assert.match(app, /hint: 'tab'/, 'a link card\'s Open is a new tab of the conversation\'s browser');
  const pager = read('../apaki/web/src/pager.js');
  assert.match(pager, /class="cn-link"/, 'the phone\'s nav row has the link line');
  const desk = read('../apaki/web/src/desktop.js');
  assert.match(desk, /desk-for/, 'a viewer row on the phone says whose it is');
});
