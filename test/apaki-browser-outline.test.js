/**
 * The built-in browser's page outline (apaki/engine/browser-page.js), the
 * shell request channel (shell-channel.js) and Claude's browser tools
 * (browser-tools.js) over a fake shell. No browser, no model: the live
 * checks are apaki/scripts/cdp-browser.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutText, formatOutline, nodeLine, normalizeRef, pageCall, shortUrl, viewLine } from '../apaki/engine/browser-page.js';
import { createShell } from '../apaki/engine/shell-channel.js';
import { createBrowserTools, pngSize, screenshotClip } from '../apaki/engine/browser-tools.js';
import { createApakiTools } from '../apaki/engine/apaki-tools.js';

const PAGE = {
  title: 'Example Domain',
  url: 'https://example.com/',
  view: { w: 1280, h: 720, x: 0, y: 0, sw: 1280, sh: 720 },
  nodes: [
    { d: 0, k: 'heading', n: 'Example Domain', l: 1 },
    { d: 0, k: 'text', t: 'This domain is for use in documentation examples without needing permission.' },
    { d: 0, k: 'link', n: 'Learn more', r: 1, h: 'https://iana.org/domains/example' },
  ],
};

test('outline: title, address, view, and one line per node with refs', () => {
  const out = formatOutline(PAGE);
  assert.match(out, /^Page: Example Domain\nURL: https:\/\/example\.com\/\nView: 1280x720; the whole page fits in view\./);
  assert.match(out, /- heading "Example Domain" \[level=1\]/);
  assert.match(out, /- text: This domain is for use/);
  assert.match(out, /- link "Learn more" \[ref=1\] -> https:\/\/iana\.org\/domains\/example/);
  assert.match(out, /3 lines, 1 refs\./);
});

test('outline: nesting, fields with values and states, selects with options, rows', () => {
  const out = formatOutline({
    title: 'Sign in', url: 'http://127.0.0.1:5173/login', view: { w: 900, h: 600, x: 0, y: 300, sw: 900, sh: 1800 },
    nodes: [
      { d: 2, k: 'navigation', n: 'Main' },
      { d: 3, k: 'link', n: 'Home', r: 4, h: 'http://127.0.0.1:5173/', s: ['current'] },
      { d: 2, k: 'form', n: 'Login' },
      { d: 3, k: 'textbox', n: 'Email', r: 5, v: 'a@b.c', s: ['required', 'focused'] },
      { d: 3, k: 'textbox', n: 'Password', r: 6, v: '••••' },
      { d: 3, k: 'checkbox', n: 'Remember me', r: 7, s: ['unchecked'] },
      { d: 3, k: 'combobox', n: 'Country', r: 8, v: 'Canada', o: ['Canada', 'Mexico'], c: 30 },
      { d: 3, k: 'button', n: 'Sign in', r: 9 },
      { d: 2, k: 'table', n: 'Plans', c: 2 },
      { d: 3, k: 'row', t: 'Free | $0' },
    ],
  });
  assert.match(out, /View: 900x600 at 50% down of a 1800px page/);
  assert.match(out, /^- navigation "Main":$/m, 'the shallowest depth starts at the margin');
  assert.match(out, /^ {2}- link "Home" \[ref=4\] \[current\] -> \/$/m, 'same-site links show their path');
  assert.match(out, /^ {2}- textbox "Email" \[ref=5\] \[required, focused\]: "a@b\.c"$/m);
  assert.match(out, /- checkbox "Remember me" \[ref=7\] \[unchecked\]/);
  assert.match(out, /- combobox "Country" \[ref=8\]: "Canada" \(options: Canada, Mexico, … 28 more\)/);
  assert.match(out, /- table "Plans" \(2 rows\):\n {2}- row: Free \| \$0/);
});

test('outline: a long page is cut to its budget and says how to read on', () => {
  const nodes = [];
  for (let i = 0; i < 400; i++) {
    nodes.push({ d: 0, k: 'heading', n: `Section ${i}`, l: 2 });
    nodes.push({ d: 0, k: 'link', n: `Item ${i}`, r: i + 1, h: `https://example.com/item/${i}` });
  }
  const out = formatOutline({ title: 'Long', url: 'https://example.com/', nodes }, { maxChars: 4000 });
  const body = out.split('\n\n')[1];
  assert.ok(body.length <= 4000, `outline ${body.length} chars`);
  const m = out.match(/Call browser_read with from=(\d+) to read on\./);
  assert.ok(m, 'tells Claude where to continue');
  assert.match(out, /more refs below/);
  // Reading on starts exactly at the first line that was cut.
  const next = formatOutline({ title: 'Long', url: 'https://example.com/', nodes }, { maxChars: 4000, from: Number(m[1]) });
  const firstLine = next.split('\n\n')[1].split('\n')[0];
  const lastBefore = body.split('\n').pop();
  assert.notEqual(firstLine, lastBefore);
  assert.match(firstLine, /^- (heading|link) /);
});

test('outline: text is shortened before anything with a ref is dropped', () => {
  const long = 'word '.repeat(600).trim();
  const nodes = [...Array.from({ length: 30 }, () => ({ d: 0, k: 'text', t: long })), { d: 0, k: 'button', n: 'Buy', r: 3 }];
  const out = formatOutline({ title: 'T', url: 'https://x.test/', nodes }, { maxChars: 2000 });
  assert.match(out, /- button "Buy" \[ref=3\]/, 'the button survives');
  assert.match(out, /… \(29 more lines of text\)/, 'runs of text collapse to their first line');
  assert.ok(out.split('\n\n')[1].length <= 2000);
});

test('outline: an empty page explains itself instead of returning nothing', () => {
  const out = formatOutline({ title: '', url: 'http://localhost:3000/', nodes: [], error: 'could not connect' });
  assert.match(out, /Page: \(no title\)/);
  assert.match(out, /This page did not load: could not connect\./);
  assert.match(out, /no readable content yet/);
});

test('cutText keeps refs that sat in the cut part', () => {
  const t = `Read the ${'very '.repeat(60)}long guide, then [link "docs" ref=12] and [button "Go" ref=13] at the end`;
  const c = cutText(t, 80);
  assert.ok(c.length < t.length);
  assert.match(c, /…/);
  assert.match(c, /\[link "docs" ref=12\]/);
  assert.match(c, /\[button "Go" ref=13\]/);
  assert.equal(cutText('short', 80), 'short');
});

test('nodeLine, shortUrl, viewLine, normalizeRef', () => {
  assert.equal(nodeLine({ k: 'img', n: 'Logo' }), 'img "Logo"');
  assert.equal(nodeLine({ k: 'listitem', t: 'One' }), 'listitem: One');
  assert.equal(nodeLine({ k: 'clickable', n: 'Card', r: 2 }), 'clickable "Card" [ref=2]');
  assert.equal(nodeLine({ k: 'heading', n: 'Say "hi"', l: 2 }), 'heading "Say \'hi\'" [level=2]');
  assert.equal(shortUrl('https://a.test/x?y=1', 'https://a.test/'), '/x?y=1');
  assert.equal(shortUrl('https://b.test/x', 'https://a.test/'), 'https://b.test/x');
  assert.match(viewLine({ w: 800, h: 600, x: 0, y: 0, sh: 3000 }), /at the top of a 3000px page/);
  assert.match(viewLine({ w: 800, h: 600, x: 0, y: 2400, sh: 3000 }), /at the bottom/);
  for (const r of [12, '12', '[12]', 'ref=12', 'e12', ' 12 ']) assert.equal(normalizeRef(r), 12, String(r));
  for (const r of ['', 'abc', '12a', 0, -1, null]) assert.equal(normalizeRef(r), null, String(r));
});

test('pageCall builds one expression that installs the page library and calls it', () => {
  const e = pageCall('target', 7, true);
  assert.match(e, /^\(function pageLibrary\(version\)/);
  assert.match(e, /\)\(\d+\)\.target\(7, true\)$/);
  // It must parse as JavaScript.
  assert.doesNotThrow(() => new Function(`return ${e};`));
});

test('screenshotClip and pngSize keep screenshots at most 1280 px wide', () => {
  assert.equal(screenshotClip({ w: 1000, h: 700, dpr: 1 }).scale, 1);
  const c = screenshotClip({ w: 1600, h: 900, dpr: 1.5, x: 0, y: 420 });
  assert.ok(1600 * 1.5 * c.scale <= 1280, `scale ${c.scale}`);
  assert.equal(c.y, 420);
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  assert.deepEqual(pngSize(png), { w: 1280, h: 720 });
  assert.equal(pngSize(Buffer.from('nope')), null);
});

/* ---------- the shell channel ---------- */

test('shell channel: no shell means an immediate NO_SHELL, never a wait', async () => {
  const sent = [];
  const sh = createShell({ emit: (e) => sent.push(e) });
  assert.equal(sh.available, false);
  await assert.rejects(sh.request('browser.state'), (e) => e.code === 'NO_SHELL');
  assert.equal(sent.length, 0);
  assert.equal(await sh.ready(30), false);
});

test('shell channel: requests go out as ev shell and resolve on the matching reply', async () => {
  const sent = [];
  const sh = createShell({ emit: (e) => sent.push(e) });
  const ready = sh.ready(1000);
  sh.hello({ version: 1, features: ['browser'] });
  assert.equal(await ready, true);
  assert.ok(sh.has('browser'));
  const a = sh.request('browser.state', { owner: 'p1' });
  const b = sh.request('browser.open', { url: 'https://x.test/' });
  assert.deepEqual(sent.map((e) => [e.ev, e.cmd]), [['shell', 'browser.state'], ['shell', 'browser.open']]);
  // Answers may come in any order; unknown ids are ignored.
  assert.equal(sh.reply({ id: 'nope', ok: true }), false);
  sh.reply({ id: sent[1].id, ok: false, error: 'no such host' });
  sh.reply({ id: sent[0].id, ok: true, result: { id: 'b1', url: 'about:blank' } });
  assert.deepEqual(await a, { id: 'b1', url: 'about:blank' });
  await assert.rejects(b, /no such host/);
  assert.equal(sh.waiting, 0);
});

test('shell channel: a request with no answer times out', async () => {
  const sh = createShell({ emit: () => {} });
  sh.hello({ features: ['browser'] });
  await assert.rejects(sh.request('browser.cdp', {}, { timeout: 40 }), (e) => e.code === 'TIMEOUT');
  assert.equal(sh.waiting, 0);
});

/* ---------- the tools over a fake shell ---------- */

/** A fake shell that answers like src/browser.rs, with a scripted page. */
function fakeShell(page) {
  const calls = [];
  const state = { id: 'b1', url: 'https://example.com/', title: 'Example Domain', loading: false, canGoBack: false, status: 200, error: null };
  const shell = {
    has: () => true,
    async request(cmd, args) {
      calls.push([cmd, args]);
      if (cmd === 'browser.state') return { ...state };
      if (cmd === 'browser.open') { state.url = args.url; return { ...state }; }
      if (cmd === 'browser.nav') { if (!state.canGoBack) throw new Error('There is no earlier page in this browser.'); return { ...state }; }
      if (cmd === 'browser.cdp') {
        const { method, params } = args;
        if (method === 'Page.getFrameTree') return { id: 'b1', result: { frameTree: { frame: { id: 'F', loaderId: page.loader } } } };
        if (method === 'Page.createIsolatedWorld') return { id: 'b1', result: { executionContextId: 7 } };
        if (method === 'Runtime.evaluate') {
          const fn = params.expression.match(/\.(\w+)\(([^()]*)\)$/);
          const value = page[fn[1]]?.(...JSON.parse(`[${fn[2]}]`));
          return { id: 'b1', result: { result: { value } } };
        }
        if (method === 'Page.captureScreenshot') {
          const png = Buffer.alloc(24);
          png.writeUInt32BE(0x89504e47, 0);
          png.writeUInt32BE(Math.round(page.view().w * page.view().dpr * (params.clip?.scale || 1)), 16);
          png.writeUInt32BE(400, 20);
          return { id: 'b1', result: { data: png.toString('base64') } };
        }
        return { id: 'b1', result: {} };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return { shell, calls, state };
}

const scripted = (over = {}) => ({
  loader: 'L1',
  collect: () => PAGE,
  target: (ref) => (ref === 1 ? { x: 300, y: 200, visible: true, ok: true, desc: 'link "Learn more"' } : { stale: true }),
  clickJs: () => ({ ok: true, desc: 'link "Learn more"' }),
  prepType: (ref) => (ref === 2 ? { ok: true, desc: 'searchbox "Search"', focused: true } : { stale: true }),
  valueNow: () => ({ value: 'apaki' }),
  view: () => ({ w: 1600, h: 900, dpr: 1.5, x: 0, y: 0 }),
  ...over,
});

test('browser_read returns the outline of the page in the isolated world', async () => {
  const { shell, calls } = fakeShell(scripted());
  const t = createBrowserTools({ shell, owner: () => 'p1' });
  const r = await t.read({});
  assert.ok(r.ok);
  assert.match(r.text, /link "Learn more" \[ref=1\]/);
  const ev = calls.find(([c, a]) => c === 'browser.cdp' && a.method === 'Runtime.evaluate');
  assert.equal(ev[1].params.contextId, 7, 'runs in the isolated world, not the page\'s own');
  assert.equal(ev[1].owner, 'p1', 'every request names the conversation');
});

test('browser_click sends a real mouse click at the element, then reports where the page is', async () => {
  const { shell, calls } = fakeShell(scripted());
  const t = createBrowserTools({ shell, owner: () => 'p1' });
  const r = await t.click({ ref: '[1]' });
  assert.ok(r.ok, r.text);
  const mouse = calls.filter(([c, a]) => c === 'browser.cdp' && a.method === 'Input.dispatchMouseEvent').map(([, a]) => [a.params.type, a.params.x, a.params.y]);
  assert.deepEqual(mouse, [['mouseMoved', 300, 200], ['mousePressed', 300, 200], ['mouseReleased', 300, 200]]);
  assert.match(r.text, /Clicked \[1\] link "Learn more"/);
  const stale = await t.click({ ref: 9 });
  assert.equal(stale.ok, false);
  assert.match(stale.text, /Call browser_read again/);
  const bad = await t.click({ ref: 'the blue one' });
  assert.match(bad.text, /is not a ref/);
});

test('browser_click falls back to a script click when something covers the element', async () => {
  const { shell, calls } = fakeShell(scripted({ target: () => ({ x: 10, y: 10, visible: true, ok: false, cover: 'div "Cookie banner"', desc: 'button "Buy"' }) }));
  const t = createBrowserTools({ shell, owner: () => 'p1' });
  const r = await t.click({ ref: 4 });
  assert.ok(r.ok);
  assert.match(r.text, /covered by div "Cookie banner"/);
  assert.equal(calls.filter(([, a]) => a?.method === 'Input.dispatchMouseEvent').length, 0);
});

test('browser_type selects the field, inserts the text as input, and presses Enter on submit', async () => {
  const { shell, calls } = fakeShell(scripted());
  const t = createBrowserTools({ shell, owner: () => 'p1' });
  const r = await t.type({ ref: 2, text: 'apaki', submit: true });
  assert.ok(r.ok, r.text);
  const methods = calls.filter(([c]) => c === 'browser.cdp').map(([, a]) => a.method + (a.params?.type ? `:${a.params.type}` : ''));
  assert.ok(methods.includes('Input.insertText'));
  assert.ok(methods.includes('Input.dispatchKeyEvent:keyDown') && methods.includes('Input.dispatchKeyEvent:keyUp'));
  assert.equal(calls.find(([, a]) => a?.method === 'Input.insertText')[1].params.text, 'apaki');
  assert.match(r.text, /It now reads "apaki"/);
});

test('browser_screenshot asks for a clip scaled to at most 1280 px and returns the image', async () => {
  const { shell, calls } = fakeShell(scripted());
  const t = createBrowserTools({ shell, owner: () => 'p1' });
  const r = await t.screenshot();
  assert.ok(r.ok, r.text);
  assert.ok(r.width <= 1280, `width ${r.width}`);
  const cap = calls.find(([, a]) => a?.method === 'Page.captureScreenshot')[1];
  assert.equal(cap.render, true, 'a hidden browser renders for the screenshot');
  assert.equal(cap.params.format, 'png');
  const mcp = t.result(r);
  assert.equal(mcp.content[1].type, 'image');
  assert.equal(mcp.content[1].mimeType, 'image/png');
});

test('browser_open and browser_back report the page, or why not', async () => {
  const { shell } = fakeShell(scripted());
  const t = createBrowserTools({ shell, owner: () => 'p1' });
  const o = await t.open({ url: 'http://127.0.0.1:4173/' });
  assert.ok(o.ok);
  assert.match(o.text, /Opened http:\/\/127\.0\.0\.1:4173\/ \("Example Domain"\) in Apaki's browser/);
  assert.equal((await t.open({ url: 'javascript:alert(1)' })).ok, false);
  const b = await t.back();
  assert.equal(b.ok, false);
  assert.match(b.text, /no earlier page/);
});

test('Apaki\'s tool server lists the browser tools only when the shell has a browser', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const list = async (tools) => {
    const server = tools.mcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const names = (await client.listTools()).tools.map((x) => x.name);
    await client.close();
    return names;
  };
  const store = { show: () => { throw new Error('unused'); }, record: () => null };
  assert.deepEqual(await list(createApakiTools({ store })), ['show', 'view_read']);
  const { shell } = fakeShell(scripted());
  const withBrowser = createApakiTools({ store, browser: createBrowserTools({ shell, owner: () => 'p1' }) });
  assert.deepEqual(await list(withBrowser), ['show', 'view_read', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_back', 'browser_screenshot', 'browser_tabs']);
  assert.match(withBrowser.appendSystemPrompt, /browser_open/);
  assert.doesNotMatch(createApakiTools({ store }).appendSystemPrompt, /browser_open/);
});
