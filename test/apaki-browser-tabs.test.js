/**
 * One browser pane per conversation, tabs inside it (browser-tools.js, 2026-10-12): the tools keep an active tab, every
 * page tool acts on it, browser_open reuses it or opens a new tab, browser_tabs lists / switches / closes. Over a fake
 * shell that keeps a Map of browsers with owners, like src/browser.rs. No browser, no model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOLS, browserToolSpecs, createBrowserTools } from '../apaki/engine/browser-tools.js';

/** A fake shell: open / list / state / nav / close / cdp over browsers that each belong to an owner. */
function tabShell() {
  const browsers = new Map();
  const calls = [];
  let n = 0;
  let clock = 0;
  const stateOf = (b) => ({ id: b.id, owner: b.owner, url: b.url, title: b.title, loading: false, canGoBack: false, status: 200, error: null, visible: true, ready: true });
  const make = (owner, url) => {
    n += 1;
    const b = { id: `b${n}`, owner, url, title: `Page ${n}`, used: ++clock };
    browsers.set(b.id, b);
    return b;
  };
  /** The browser a command means: its id, else the owner's most recently used. */
  const pick = (args) => {
    if (args.id) {
      const b = browsers.get(args.id);
      if (!b) throw new Error(`There is no browser ${args.id}.`);
      return b;
    }
    const mine = [...browsers.values()].filter((b) => b.owner === args.owner).sort((a, c) => c.used - a.used);
    if (!mine.length) throw new Error('This conversation has no browser yet.');
    return mine[0];
  };
  const shell = {
    has: () => true,
    expects: () => true,
    async request(cmd, args = {}) {
      calls.push([cmd, args]);
      if (cmd === 'browser.list') return { browsers: [...browsers.values()].map(stateOf) };
      if (cmd === 'browser.open') {
        let b;
        if (args.id) b = pick(args);
        else if (args.hint === 'reuse' && [...browsers.values()].some((x) => x.owner === args.owner)) b = pick({ owner: args.owner });
        else b = make(args.owner, args.url);
        b.url = args.url;
        b.used = ++clock;
        return stateOf(b);
      }
      if (cmd === 'browser.state') return stateOf(pick(args));
      if (cmd === 'browser.nav') return stateOf(pick(args));
      if (cmd === 'browser.close') { pick(args); browsers.delete(args.id); return { closed: args.id }; }
      if (cmd === 'browser.cdp') {
        const b = pick(args);
        b.used = ++clock;
        const { method, params } = args;
        if (method === 'Page.getFrameTree') return { id: b.id, result: { frameTree: { frame: { id: `F${b.id}`, loaderId: 'L1' } } } };
        if (method === 'Page.createIsolatedWorld') return { id: b.id, result: { executionContextId: 7 } };
        if (method === 'Runtime.evaluate') {
          const fn = params.expression.match(/\.(\w+)\(([^()]*)\)$/);
          const pages = {
            collect: () => ({ title: b.title, url: b.url, view: { w: 1280, h: 720, x: 0, y: 0, sw: 1280, sh: 720 }, nodes: [] }),
            view: () => ({ w: 1280, h: 720, dpr: 1, x: 0, y: 0 }),
          };
          return { id: b.id, result: { result: { value: pages[fn[1]]?.() } } };
        }
        if (method === 'Page.captureScreenshot') return { id: b.id, result: { data: Buffer.from('not really a jpeg').toString('base64') } };
        return { id: b.id, result: {} };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return { shell, calls, browsers, make };
}

function setup(owner = 'p1') {
  const fake = tabShell();
  const activity = [];
  const tools = createBrowserTools({ shell: fake.shell, owner: () => owner, onActivity: (a) => activity.push(a) });
  const selects = () => activity.filter((a) => a.action === 'select');
  const last = (cmd) => fake.calls.filter(([c]) => c === cmd).pop()?.[1];
  return { ...fake, tools, activity, selects, last };
}

test('reuse (the default) navigates the active tab by its id; with no browser yet it creates the conversation\'s one', async () => {
  const s = setup();
  const first = await s.tools.open({ url: 'http://localhost:3000/' });
  assert.ok(first.ok, first.text);
  assert.deepEqual([s.last('browser.open').hint, s.last('browser.open').id], ['reuse', undefined], 'nothing to reuse yet: the shell makes the browser');
  assert.match(first.text, /in tab 1 of 1/);
  const again = await s.tools.open({ url: 'http://localhost:3000/about' });
  assert.ok(again.ok, again.text);
  const sent = s.last('browser.open');
  assert.deepEqual([sent.hint, sent.id, sent.owner], ['reuse', 'b1', 'p1']);
  assert.equal(s.browsers.size, 1, 'no second browser');
  assert.match(again.text, /in tab 1 of 1/);
});

test('paneHint new and tab both open a new tab of the same pane (shell hint tab, no id) and that tab becomes the active one', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://a.test/' });
  for (const [i, hint] of ['new', 'tab'].entries()) {
    const r = await s.tools.open({ url: `http://t${i}.test/`, paneHint: hint });
    assert.ok(r.ok, r.text);
    const sent = s.last('browser.open');
    assert.deepEqual([sent.hint, sent.id], ['tab', undefined], hint);
    assert.match(r.text, new RegExp(`in a new tab \\(${i + 2} of ${i + 2}\\) of this conversation's browser`));
    const tabs = await s.tools.tabs();
    assert.equal(tabs.find((t) => t.active).id, `b${i + 2}`);
  }
  // Reuse after that loads the page in the newest tab, which is the active one.
  await s.tools.open({ url: 'http://again.test/' });
  assert.equal(s.last('browser.open').id, 'b3');
});

test('read, click-style state calls and cdp calls all target the active tab by id', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  s.calls.length = 0;
  const r = await s.tools.read({});
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Page: Page 2/);
  const own = s.calls.filter(([c]) => c === 'browser.state' || c === 'browser.cdp');
  assert.ok(own.length >= 3);
  assert.ok(own.every(([, a]) => a.id === 'b2' && a.owner === 'p1'), 'every request names the active tab and the conversation');
  const sel = await s.tools.call('browser_tabs', { select: 1 });
  assert.ok(sel.ok, sel.text);
  s.calls.length = 0;
  await s.tools.read({});
  assert.match((await s.tools.screenshot()).text, /Page 1|http:\/\/one\.test/);
  assert.ok(s.calls.filter(([c]) => c === 'browser.state' || c === 'browser.cdp').every(([, a]) => a.id === 'b1'));
  s.calls.length = 0;
  await s.tools.back();
  assert.equal(s.last('browser.nav').id, 'b1');
});

test('browser_tabs with no arguments lists the tabs in stable order and marks the active one; empty says how to start', async () => {
  const s = setup();
  const none = await s.tools.call('browser_tabs', {});
  assert.ok(none.ok);
  assert.equal(none.text, 'No browser is open for this conversation yet. Open a page with browser_open.');
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  await s.tools.open({ url: 'http://three.test/', paneHint: 'new' });
  s.make('p2', 'http://other-conversation.test/');
  const r = await s.tools.call('browser_tabs', {});
  assert.deepEqual(r.text.split('\n'), [
    '1. Page 1 - http://one.test/',
    '2. Page 2 - http://two.test/',
    '3. Page 3 - http://three.test/ (active)',
  ], 'only this conversation\'s tabs');
  assert.deepEqual(r.tabs.map((t) => [t.id, t.active]), [['b1', false], ['b2', false], ['b3', true]]);
  assert.equal(r.tabs[0].url, 'http://one.test/');
  // The numbers survive a tab being closed behind the tools\' back and a new one arriving (appended, numeric id order).
  s.browsers.delete('b2');
  s.make('p1', 'http://late.test/');
  s.make('p1', 'http://later.test/');
  const t = await s.tools.tabs();
  assert.deepEqual(t.map((x) => x.id), ['b1', 'b3', 'b5', 'b6'], 'known ids keep their place, unknown ones append, the gone one drops out');
});

test('browser_tabs select switches by number, shows the pane through one select activity, and answers with the list', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  s.activity.length = 0;
  const r = await s.tools.call('browser_tabs', { select: 1 });
  assert.ok(r.ok, r.text);
  assert.deepEqual(s.selects(), [{ browserId: 'b1', action: 'select', text: 'Switched to Page 1' }]);
  assert.equal(s.activity.length, 1);
  assert.match(r.text, /^Switched to tab 1\.\n1\. Page 1 - http:\/\/one\.test\/ \(active\)\n2\. Page 2 - http:\/\/two\.test\/$/);
  assert.equal((await s.tools.tabs()).find((t) => t.active).id, 'b1');
});

test('browser_tabs close closes the shell browser; closing the active tab makes the last remaining one active and shows it', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  await s.tools.open({ url: 'http://three.test/', paneHint: 'tab' });
  s.activity.length = 0;
  // A tab that is not active: closed, no switch.
  const a = await s.tools.call('browser_tabs', { close: 1 });
  assert.ok(a.ok, a.text);
  assert.deepEqual(s.last('browser.close'), { owner: 'p1', id: 'b1' });
  assert.equal(s.selects().length, 0);
  assert.match(a.text, /^Closed tab 1\.\n1\. Page 2 - .*\n2\. Page 3 - .* \(active\)$/);
  // The active one: the last remaining tab takes over and the window is told.
  const b = await s.tools.call('browser_tabs', { close: 2 });
  assert.ok(b.ok, b.text);
  assert.equal(s.last('browser.close').id, 'b3');
  assert.deepEqual(s.selects(), [{ browserId: 'b2', action: 'select', text: 'Switched to Page 2' }]);
  assert.match(b.text, /^Closed tab 2\.\n1\. Page 2 - http:\/\/two\.test\/ \(active\)$/);
  assert.equal(s.browsers.has('b3'), false);
  // The last one: nothing is left, and it says so.
  const c = await s.tools.call('browser_tabs', { close: 1 });
  assert.ok(c.ok);
  assert.match(c.text, /^Closed tab 1\. No browser is open for this conversation yet\./);
});

test('browser_tabs refuses bad numbers and both arguments at once, naming the valid range', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  for (const arg of [{ select: 3 }, { select: 0 }, { select: -1 }, { select: 1.5 }, { select: 'two' }, { close: 3 }, { close: 0 }]) {
    const r = await s.tools.call('browser_tabs', arg);
    assert.equal(r.ok, false, JSON.stringify(arg));
    assert.match(r.text, /Tab numbers go from 1 to 2/, JSON.stringify(arg));
  }
  const both = await s.tools.call('browser_tabs', { select: 1, close: 2 });
  assert.equal(both.ok, false);
  assert.match(both.text, /select or close, not both/);
  assert.equal(s.browsers.size, 2, 'a refused call closed nothing');
  assert.equal(s.selects().length, 0);
});

test('select(id) only takes an id of this conversation\'s own tabs, and says nothing to the window (the window asked for it)', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  const foreign = s.make('p2', 'http://not-mine.test/');
  s.activity.length = 0;
  assert.equal(await s.tools.select(foreign.id), false, 'another conversation\'s tab');
  assert.equal(await s.tools.select('nope'), false);
  assert.equal(await s.tools.select(''), false);
  assert.equal((await s.tools.tabs()).find((t) => t.active).id, 'b2', 'still the same active tab');
  assert.equal(await s.tools.select('b1'), true);
  assert.equal((await s.tools.tabs()).find((t) => t.active).id, 'b1');
  assert.equal(s.activity.length, 0);
});

test('adopt(id) makes a tab the engine opened the active one and numbers it last', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  const b = s.make('p1', 'http://shown.test/');
  s.tools.adopt(b.id);
  const tabs = await s.tools.tabs();
  assert.deepEqual(tabs.map((t) => [t.id, t.active]), [['b1', false], [b.id, true]]);
  await s.tools.read({});
  assert.equal(s.calls.filter(([c]) => c === 'browser.cdp').pop()[1].id, b.id);
});

test('view({tab}) switches only to an own tab, tells the desktop pane once, and returns the tab list', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: `http://two.test/${'x'.repeat(400)}`, paneHint: 'tab' });
  const foreign = s.make('p2', 'http://not-mine.test/');
  s.browsers.get('b2').title = 'T'.repeat(300);
  s.activity.length = 0;

  const plain = await s.tools.view();
  assert.ok(plain.ok, plain.text);
  assert.equal(plain.mimeType, 'image/jpeg');
  assert.deepEqual(plain.tabs.map((t) => [t.id, t.active]), [['b1', false], ['b2', true]]);
  assert.equal(plain.tabs[1].title.length, 120);
  assert.equal(plain.tabs[1].url.length, 300);
  assert.equal(s.activity.length, 0, 'a phone looking is quiet');

  const other = await s.tools.view({ tab: foreign.id });
  assert.ok(other.ok);
  assert.deepEqual(other.tabs.map((t) => t.active), [false, true], 'another conversation\'s tab is ignored');
  assert.equal(s.selects().length, 0);

  const mine = await s.tools.view({ tab: 'b1' });
  assert.ok(mine.ok, mine.text);
  assert.deepEqual(mine.tabs.map((t) => t.active), [true, false]);
  assert.deepEqual(s.selects(), [{ browserId: 'b1', action: 'select', text: 'Switched tab' }]);
  assert.equal(s.calls.filter(([c, a]) => c === 'browser.cdp' && a.method === 'Page.captureScreenshot').pop()[1].id, 'b1', 'the picture is of that tab');

  // Asking again for the tab that is already active must not repeat the line: a phone refreshes on activity lines.
  await s.tools.view({ tab: 'b1' });
  assert.equal(s.selects().length, 1);
});

test('when the active tab is gone (the person closed it), the tools fall back to the conversation\'s last tab', async () => {
  const s = setup();
  await s.tools.open({ url: 'http://one.test/' });
  await s.tools.open({ url: 'http://two.test/', paneHint: 'tab' });
  await s.tools.open({ url: 'http://three.test/', paneHint: 'tab' });
  s.browsers.delete('b3');
  s.calls.length = 0;
  const r = await s.tools.read({});
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Page: Page 2/);
  assert.ok(s.calls.filter(([c]) => c === 'browser.cdp').every(([, a]) => a.id === 'b2'));
  // A reuse open lands in that tab too, not in a dead id.
  await s.tools.open({ url: 'http://next.test/' });
  assert.equal(s.last('browser.open').id, 'b2');
  // With every tab gone the tools go back to the plain owner fallback (the shell makes a browser).
  s.browsers.clear();
  s.calls.length = 0;
  await s.tools.open({ url: 'http://fresh.test/' });
  assert.deepEqual([s.last('browser.open').hint, s.last('browser.open').id], ['reuse', undefined]);
});

test('browser_tabs as spec and as in-process tool say the same words, take the same fields, and are listed with the others', () => {
  const specs = browserToolSpecs();
  assert.deepEqual(specs.map((x) => x.name), BROWSER_TOOLS);
  assert.equal(BROWSER_TOOLS[BROWSER_TOOLS.indexOf('browser_screenshot') + 1], 'browser_tabs');
  const sdk = createBrowserTools({ shell: { request: async () => ({}) }, owner: () => 'p' }).sdkTools();
  const spec = specs.find((x) => x.name === 'browser_tabs');
  const tool = sdk.find((x) => x.name === 'browser_tabs');
  assert.ok(spec && tool);
  assert.equal(spec.description, tool.description);
  assert.deepEqual(Object.keys(spec.shape).sort(), ['close', 'select']);
  assert.deepEqual(Object.keys(tool.inputSchema).sort(), ['close', 'select']);
  assert.deepEqual(spec.annotations, { title: 'Browser tabs', readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  const open = specs.find((x) => x.name === 'browser_open');
  assert.match(open.description, /one browser pane beside it with its own tabs/);
  assert.equal(open.description, sdk.find((x) => x.name === 'browser_open').description);
  assert.equal(spec.shape.select.safeParse(0).success, false);
  assert.equal(spec.shape.select.safeParse(2).success, true);
});

test('an unreachable list does not break a page tool: it keeps today\'s owner fallback', async () => {
  const s = setup();
  const real = s.shell.request;
  s.shell.request = async (cmd, args) => { if (cmd === 'browser.list') throw new Error('no list'); return real(cmd, args); };
  const o = await s.tools.open({ url: 'http://one.test/' });
  assert.ok(o.ok, o.text);
  const r = await s.tools.read({});
  assert.ok(r.ok, r.text);
});
