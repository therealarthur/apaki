/**
 * Phone parity, the phone page (2026-10-12; Arthur: every desktop feature also works on the phone, and apaki/parity
 * records it). The engine side (policy, access levels, Ask Claude's one-at-a-time gate, the browser view's picture) is
 * in test/apaki-phone-ops.test.js. Here:
 *
 *   - the phone's own pure parts: the browser view's model, the Browser button's rule, "is this link for the phone's own
 *     browser", and a hello that lists ops (link.js supports('op:...'));
 *   - the wiring the evaluation relied on (app.js, native.js, pager.js, find.js, web.css, the web build).
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isPublicWebUrl } from '../apaki/ui/artifacts.js';
import { build } from '../apaki/scripts/build-web.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-phone-parity-'));
let built = null;
const load = async (name) => {
  built ||= build({ relay: 'wss://apaki.myrlin.io', out });
  return import(pathToFileURL(path.join(out, name)).href);
};
after(() => fs.rmSync(out, { recursive: true, force: true }));
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/* the phone's own parts */

test('the browser view\'s model: a picture with a title and address, an error with words, a loading page, a public address to open on the phone', async () => {
  const { viewModel, addressLine, updatedText, REFRESH_QUIET_MS } = await load('browserview.js');
  assert.deepEqual(viewModel(null), { kind: 'loading' });
  const page = viewModel({ ok: true, image: 'QUJD', mime: 'image/jpeg', width: 1200, height: 600, at: 1_700_000_000_000, state: { url: 'https://shop.example/checkout/', title: 'Checkout - Acme', loading: false } });
  assert.equal(page.kind, 'page');
  assert.equal(page.src, 'data:image/jpeg;base64,QUJD');
  assert.equal(page.title, 'Checkout - Acme');
  assert.equal(page.address, 'shop.example/checkout');
  assert.equal(page.ratio, 2);
  assert.equal(page.canOpenHere, true);
  assert.equal(page.at, 1_700_000_000_000);
  const local = viewModel({ ok: true, image: 'QUJD', mime: 'text/html', state: { url: 'http://localhost:3000/', title: 'http://localhost:3000/', loading: true, error: 'ERR_CONNECTION_REFUSED' } });
  assert.equal(local.src.startsWith('data:image/jpeg;'), true, 'only a picture type is ever put in a data address');
  assert.equal(local.title, 'localhost:3000', 'a title that is just the address becomes the host');
  assert.equal(local.canOpenHere, false, 'a dev server on the PC cannot open on the phone');
  assert.equal(local.loading, true);
  assert.equal(local.failed, 'ERR_CONNECTION_REFUSED');
  assert.equal(local.ratio, 1.6);
  assert.deepEqual(viewModel({ ok: false, text: 'Apaki\'s window is closed.' }), { kind: 'error', text: 'Apaki\'s window is closed.' });
  assert.equal(viewModel({ ok: true, image: null }).kind, 'error');
  assert.equal(addressLine(`https://a.example/${'x'.repeat(200)}`).length, 80);
  assert.equal(updatedText(0), '');
  assert.match(updatedText(1_700_000_000_000), /^Updated \d{1,2}:\d{2}/);
  assert.ok(REFRESH_QUIET_MS >= 300 && REFRESH_QUIET_MS <= 2000);
});

test('the conversation bar offers Browser only after Claude used it, to a Full phone, on a PC that has the view', async () => {
  const { browserOffer } = await load('pager.js');
  assert.equal(browserOffer({ marked: true, cap: 'full', canView: true }), true);
  assert.equal(browserOffer({ marked: false, cap: 'full', canView: true }), false);
  assert.equal(browserOffer({ marked: true, cap: 'noshell', canView: true }), false);
  assert.equal(browserOffer({ marked: true, cap: 'chat', canView: true }), false);
  assert.equal(browserOffer({ marked: true, cap: 'full', canView: false }), false);
  assert.equal(browserOffer({ marked: true, cap: 'full', canView: undefined }), false);
});

test('a link card on the phone: public pages open in the phone\'s browser, anything only the PC can reach does not', () => {
  for (const u of ['https://example.com/', 'http://docs.myrlin.io/a?b=1', 'https://8.8.8.8/', 'https://sub.domain.co.uk:8443/x']) assert.equal(isPublicWebUrl(u), true, u);
  for (const u of ['http://localhost:3000/', 'http://127.0.0.1:5173', 'http://[::1]:3000/', 'http://0.0.0.0:8080', 'http://192.168.1.20/', 'http://10.0.0.5:9000', 'http://172.16.4.2/', 'http://169.254.1.1/', 'http://100.118.228.46:3000/',
    'http://studio-pc:3000/', 'http://my-mac.local/', 'http://app.localhost:3000/', 'http://nas.lan/', 'https://svc.internal/', 'file:///C:/work/index.html', 'javascript:alert(1)', 'ftp://example.com/', 'not a url', '', null, undefined, 'http://[fd12::1]/', 'http://[fe80::1]/']) {
    assert.equal(isPublicWebUrl(u), false, String(u));
  }
});

test('a hello that lists ops: the page asks supports("op:rename") and the older "features" lookups still work', async () => {
  const { Link } = await load('link.js');
  const l = Object.create(Link.prototype);
  l.hello = { ops: ['sessions', 'rename', 'askSearch'], features: ['mode', 'cap', 'follow'] };
  assert.equal(l.supports('op:rename'), true);
  assert.equal(l.supports('op:browserView'), false);
  assert.equal(l.supports('follow'), true);
  assert.equal(l.supports('rename'), false, 'an op is not a feature');
  l.hello = { features: ['follow'] };
  assert.equal(l.supports('op:rename'), false, 'an older PC lists no ops');
  l.hello = null;
  assert.equal(l.supports('op:rename'), false);
  assert.equal(l.supports('follow'), false);
});

/* wiring */

test('wiring: the session menu, rename sheet, Ask Claude, find and the browser view are on the phone and only the phone', async () => {
  await load('browserview.js');
  assert.ok(fs.existsSync(path.join(out, 'browserview.js')), 'the web build ships browserview.js');
  const app = read('../apaki/ui/app.js');
  assert.match(app, /if \(WEB\) \{ phoneSessionMenu\(s, \{ x: e\.clientX, y: e\.clientY \}\); return; \}/, 'the long press\'s contextmenu opens the phone menu');
  assert.match(app, /if \(WEB\) \{ renameSheet\(sessionId, \{ pane \}\); return; \}/, 'the desktop\'s inline editor is untouched');
  assert.match(app, /window\.addEventListener\('apaki:pane-menu'/);
  assert.match(app, /li\.draggable = !WEB;/, 'iOS would lift a draggable row on the press that opens the menu');
  assert.match(app, /Not it\? Tap Ask Claude\./);
  assert.match(app, /Not it\? Ask Claude \(Ctrl\+Enter\)\./, 'the window keeps its words');
  assert.match(app, /if \(WEB\) \{ if \(reason === 'card'\) openOnPhone\(url, from\); return; \}/, 'Claude\'s own shows never open a tab on the phone unasked');
  assert.match(app, /if \(WEB && e\.refused\) phoneToast\(e\.message, false\);/);
  // The menu offers nothing that reaches the PC's screen or another window.
  const menu = app.slice(app.indexOf('function phoneSessionMenu'), app.indexOf('if (WEB) {\n  // The ... button'));
  assert.equal(/stopSession|revealFolder|openExternal|digPrompt/.test(menu), false);
  assert.match(menu, /gated\('rename'/);
  assert.match(menu, /phoneCap\(\) !== 'chat'/);
  const native = read('../apaki/web/src/native.js');
  assert.match(native, /initBrowserView\(\{ haptic \}\)/);
  assert.match(native, /new MouseEvent\('contextmenu'/);
  assert.match(native, /window\.addEventListener\('apaki:chat', \(\) => showChat\(\)\)/);
  assert.match(native, /classList\.toggle\('can-ask', Boolean\(window\.__apakiLink\?\.supports\?\.\('op:askSearch'\)\)\)/);
  assert.match(native, /const SHEETS = '[^']*\.bv,/, 'the browser view closes with a swipe down like the other sheets');
  const pager = read('../apaki/web/src/pager.js');
  assert.match(pager, /class="cn-btn cn-more"/);
  assert.match(pager, /new CustomEvent\('apaki:pane-menu'/);
  assert.match(pager, /new CustomEvent\('apaki:browser-view'/);
  const css = read('../apaki/web/src/web.css');
  assert.match(css, /body\.web:not\(\.can-ask\) \.ask \{ display: none !important; \}/);
  assert.equal(/body\.web \.ask,/.test(css), false, 'Ask Claude is no longer hidden on every phone');
  assert.match(css, /body\.web\.native \.find-bar button \{ height: 44px; min-width: 44px;/);
  assert.match(css, /\.bv-row button \{\n\s+min-height: 44px;/);
  const find = read('../apaki/ui/find.js');
  assert.match(find, /enterkeyhint="search"/);
  assert.match(find, /if \(!document\.body\.classList\.contains\('native'\)\) pane\.\$\?\.input\?\.focus/, 'the message box does not take the keyboard back after Done on the phone');
  // The pane marks a conversation whose Claude used the browser, from a tool line or an openUrl that went to it.
  const pane = read('../apaki/ui/pane.js');
  assert.match(pane, /if \(block\.name\.startsWith\(BROWSER_TOOL\)\) this\.markBrowser\(\);/);
  assert.match(pane, /if \(e\.browserId\) this\.markBrowser\(\);/);
  // The phone-only files are not imported by the window.
  assert.equal(/import .*browserview\.js/.test(app), false);
  for (const f of ['../apaki/web/src/browserview.js', '../apaki/web/src/pager.js', '../apaki/web/src/native.js', '../apaki/web/src/web.css', '../apaki/engine/remote-policy.js', '../apaki/ui/find.js']) {
    const text = read(f);
    assert.equal(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2015)), false, `${f} has no em dash`);
  }
});

