/**
 * cdp-browser.mjs: checks Apaki's built-in browser without any model call
 * (no cost). Start an Apaki build (the dev build) with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>, then:
 *   node apaki/scripts/cdp-browser.mjs <out-prefix> [port] [apakiPid]
 *
 * It serves a small test site from a temp folder on 127.0.0.1, opens a new
 * tab with a conversation, and runs Claude's own browser tools for that
 * conversation through the engine (op browserTool, the same code the MCP
 * tools call): browser_open on the test page, browser_read (refs), a click
 * through to a second page, browser_back, browser_type with submit, a
 * screenshot (checked to be at most 1280 px wide), and https://example.com.
 * Then it checks the pane: beside the conversation, hidden while a sheet and
 * a drag need the space, and back after. Security: it connects to the
 * browser page's own DevTools target and checks that nothing of Tauri or
 * the app is in it and that its attempts to call the app reach nothing.
 * Pictures at 1320x860 (Apaki's page with the browser page's own picture in
 * the pane, where the shell puts the native page): <prefix>-browser-light.png
 * and -browser-dark.png, plus the screenshot Claude would get,
 * <prefix>-claude-shot.png. With apakiPid also Windows' own picture of the
 * window (window-shot.ps1): <prefix>-window-dark.png.
 * At the end it closes what it opened, puts the theme back, stops the test
 * site and deletes its folder.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [prefix = 'apaki-browser', portArg = '9341', pidArg = ''] = process.argv.slice(2);
const PORT = Number(portArg);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the test site ---------- */

const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-browser-test-'));
const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1c1b2e;background:#fff}main{max-width:720px;margin:0 auto;padding:40px 28px}
h1{font:800 34px/1.1 system-ui;letter-spacing:-.02em;margin:0 0 10px}label{display:block;margin:14px 0 4px;font-weight:600}
input,select{font:inherit;padding:8px 10px;border:1px solid #c9cbe6;border-radius:8px;width:320px}button{font:inherit;font-weight:700;padding:9px 16px;border:0;border-radius:8px;background:#5361C9;color:#fff;margin-top:14px;cursor:pointer}
.card{margin:22px 0;padding:16px 18px;border:1px solid #e3e5f6;border-radius:12px;background:#fbfbff}li{margin:4px 0}
@media (prefers-color-scheme: dark){body{background:#16151f;color:#ecedf8}.card{background:#1f1e2c;border-color:#34324a}input,select{background:#1f1e2c;color:#ecedf8;border-color:#44425e}}</style>
</head><body><main>${body}</main></body></html>`;
fs.writeFileSync(path.join(SITE, 'index.html'), PAGE('Apaki browser test', `
<h1>Apaki browser test</h1>
<p>This page checks Claude's browser tools. Read the <a href="/second.html">second page</a> or search below.</p>
<div class="card"><form action="/search" method="get">
  <label for="q">Query</label><input id="q" name="q" placeholder="Type something">
  <label for="size">Size</label><select id="size" name="size"><option>Small</option><option selected>Medium</option><option>Large</option></select>
  <label><input type="checkbox" name="fast"> Fast</label>
  <button type="submit">Search</button>
</form></div>
<div class="card"><button id="count" type="button" onclick="this.textContent = 'Clicked ' + (++this.dataset.n) + ' times'" data-n="0">Count clicks</button></div>
<h2>Things</h2><ul>${Array.from({ length: 8 }, (_, i) => `<li>Thing ${i + 1}</li>`).join('')}</ul>`));
fs.writeFileSync(path.join(SITE, 'second.html'), PAGE('Second page', '<h1>Second page</h1><p>You followed the link. <a href="/">Back home</a>.</p>'));
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/search') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE('Results', `<h1>You searched for: ${String(u.searchParams.get('q') || '').replace(/[<&]/g, '')}</h1><p>Size ${u.searchParams.get('size')}, fast ${u.searchParams.get('fast') ? 'on' : 'off'}.</p>`));
    return;
  }
  const f = path.join(SITE, u.pathname === '/' ? 'index.html' : path.basename(u.pathname));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('not here'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE_URL = `http://127.0.0.1:${server.address().port}/`;

/* ---------- CDP to Apaki's own page ---------- */

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const p = (await targets()).find((t) => t.type === 'page' && /tauri\.localhost|^tauri:/.test(t.url));
    if (p) ws = new WebSocket(p.webSocketDebuggerUrl);
  } catch { /* not up yet */ }
  if (!ws) await sleep(250);
}
if (!ws) throw new Error(`no Apaki page on port ${PORT}`);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let n = 0;
const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const k = ++n; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 90)}: ${r.result.exceptionDetails.exception?.description}`);
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await sleep(150); } return false; };

await waitFor('!!window.__apaki && window.__apaki.S.panes.size > 0');
// A fixed 1320x860 window at 150 %, whatever the real window is doing (a
// minimized window lays out at odd sizes). The pages follow it: the window
// tells the shell where they go in these pixels.
const DSF = 1.5;
await call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 860, deviceScaleFactor: DSF, mobile: false });
await sleep(300);
const R = { site: SITE_URL, theme: await ev('window.apakiTheme.get()') };
await ev(`window.apakiTheme.set('light')`);
// Results of the engine's browserTool op, by reqId.
await ev(`(window.__bt = {}, window.__TAURI__.event.listen('engine', ({ payload }) => { if (payload.ev === 'browserToolResult') window.__bt[payload.reqId] = payload; if (String(payload.reqId || '').startsWith('page-probe')) (window.__probeSeen ||= []).push(payload.reqId); }).then(() => true))`);
const PANE = await ev(`(() => { const A = window.__apaki; A.addTab(); return A.focusedPane()?.id || null; })()`);
if (!PANE) throw new Error('no conversation pane');
R.pane = PANE;
let reqN = 0;
/** Runs one of Claude's browser tools for the test conversation, through the engine. */
async function tool(name, input = {}, ms = 40000) {
  const reqId = `cdp-bt-${++reqN}`;
  await ev(`window.__TAURI__.core.invoke('engine_send', { msg: { op: 'browserTool', reqId: ${JSON.stringify(reqId)}, paneId: ${JSON.stringify(PANE)}, tool: ${JSON.stringify(name)}, input: ${JSON.stringify(input)} } }).then(() => true)`);
  for (let t = 0; t < ms; t += 120) {
    const r = await ev(`window.__bt[${JSON.stringify(reqId)}] || null`);
    if (r) return r;
    await sleep(120);
  }
  return { ok: false, text: `no answer to ${name} in ${ms} ms` };
}
const refOf = (text, re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
// A ref as an outline line (link "x" [ref=3]) or inside a sentence ([link "x" ref=3]).
const refRe = (role, name) => new RegExp(`${role} "${name}"(?: \\[ref=| ref=)(\\d+)`);
const viewport = () => ev('innerWidth + "x" + innerHeight + "@" + devicePixelRatio');
R.viewportStart = await viewport();

// 1. Claude opens the local test page: a browser pane appears beside the conversation.
const opened = await tool('open', { url: SITE_URL });
R.open = opened.text;
// This check's own browser: the one that belongs to its conversation.
const MINE = `window.__apaki.browsers().find((b) => b.sourcePane === ${JSON.stringify(PANE)})`;
R.paneAppeared = await waitFor(`${MINE}?.live === true`);
R.layout = await ev(`(() => { const A = window.__apaki; const t = A.activeTab(); return A.L.ids(t.root).map((i) => { const p = A.S.panes.get(i); return p?.isBrowser ? 'browser' : p?.isViewer ? 'viewer' : 'conversation'; }); })()`);
R.focusStayed = await ev(`window.__apaki.focusedPane()?.id === ${JSON.stringify(PANE)}`);
const BID = await ev(`${MINE}?.id || null`);
await sleep(400);
const list = async () => ev(`window.__TAURI__.core.invoke('browser', { cmd: 'list', args: {} })`);
R.shown = (await list()).browsers.find((b) => b.id === BID)?.visible;

// 2. Read it: refs for the link, the field, the select, the checkbox, the buttons.
const read1 = await tool('read');
R.read = read1.text;
const linkRef = refOf(read1.text, refRe('link', 'second page'));
const qRef = refOf(read1.text, refRe('textbox', 'Query'));
const sizeRef = refOf(read1.text, refRe('combobox', 'Size'));
const countRef = refOf(read1.text, refRe('button', 'Count clicks'));
R.refs = { linkRef, qRef, sizeRef, countRef };

// 3. A click that changes the page in place, then one that navigates, then back.
const c1 = await tool('click', { ref: countRef });
R.clickInPlace = c1.text;
R.clickCounted = /button "Clicked 1 times"/.test((await tool('read')).text);
const c2 = await tool('click', { ref: linkRef });
R.clickNavigates = c2.text;
R.onSecond = /Second page/.test((await tool('read')).text);
R.back = (await tool('back')).text;

// 4. Typing: a select by its label, then the query with Enter.
const read2 = await tool('read');
const q2 = refOf(read2.text, refRe('textbox', 'Query'));
const s2 = refOf(read2.text, refRe('combobox', 'Size'));
R.refsStable = q2 === qRef && s2 === sizeRef;
R.pick = (await tool('type', { ref: s2, text: 'Large' })).text;
const typed = await tool('type', { ref: q2, text: 'apaki', submit: true });
R.type = typed.text;
const read3 = await tool('read');
R.searched = /You searched for: apaki/.test(read3.text) && /Size Large/.test(read3.text);

// 5. What Claude sees: a PNG at most 1280 px wide.
const shot = await tool('screenshot');
R.screenshot = { ok: shot.ok, text: shot.text, width: shot.width, height: shot.height };
if (shot.image) fs.writeFileSync(`${prefix}-claude-shot.png`, Buffer.from(shot.image, 'base64'));

// 6. The page's own view of itself, from its own DevTools target.
const bt = (await targets()).find((t) => t.type === 'page' && t.url.startsWith(SITE_URL));
if (bt) {
  const bw = new WebSocket(bt.webSocketDebuggerUrl);
  await new Promise((r) => bw.addEventListener('open', r, { once: true }));
  const probe = await new Promise((r) => {
    bw.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id === 1) r(j.result?.result?.value); });
    bw.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const out = { tauri: typeof window.__TAURI__, tauriInternals: typeof window.__TAURI_INTERNALS__, ipc: typeof window.ipc, webview: typeof (window.chrome && window.chrome.webview), hostObjects: typeof (window.chrome && window.chrome.webview && window.chrome.webview.hostObjects), apakiInPageWorld: typeof window.__apaki };
      const tryFetch = (u, o) => Promise.race([fetch(u, o).then((r) => 'answered ' + r.status, () => 'blocked'), new Promise((r) => setTimeout(() => r('no answer'), 2500))]);
      const msg = JSON.stringify({ cmd: 'engine_send', callback: 0, error: 0, payload: { msg: { op: 'billingOptions', reqId: 'page-probe-ipc' } } });
      out.ipcProtocol = await tryFetch('http://ipc.localhost/engine_send', { method: 'POST', body: msg, headers: { 'Tauri-Callback': '1', 'Tauri-Error': '2', 'Content-Type': 'application/json' } });
      out.ipcScheme = await tryFetch('ipc://localhost/engine_send', { method: 'POST', body: msg });
      out.appOrigin = await tryFetch('http://tauri.localhost/index.html');
      try { window.chrome?.webview?.postMessage(msg); out.postMessage = window.chrome?.webview ? 'posted' : 'absent'; } catch (e) { out.postMessage = 'threw'; }
      return out;
    })()` } }));
  });
  bw.close();
  R.pageProbe = probe;
} else R.pageProbe = 'browser target not found';
await sleep(1200);
R.probeReachedEngine = (await ev('window.__probeSeen || []')).length;

// 7. A public page.
const pub = await tool('open', { url: 'https://example.com/' });
R.publicOpen = pub.text;
const pubRead = await tool('read');
// example.com (2026) is a title and one paragraph, translated by its script.
R.publicRead = /^Page: Example Domain\nURL: https:\/\/example\.com\//.test(pubRead.text) && /text: This domain is for use in documentation/.test(pubRead.text);
if (!R.publicRead) R.publicReadText = pubRead.text;
await tool('open', { url: SITE_URL });

// 8. It steps aside for a sheet and a drag, and comes back.
await ev(`window.__TAURI__.core.invoke('engine_send', { msg: { op: 'billingOptions', reqId: 'cdp-sheet', paneId: ${JSON.stringify(PANE)} } }).then(() => true)`);
await waitFor(`!document.getElementById('scrim').hidden`);
await sleep(500);
R.hiddenForSheet = (await list()).browsers.find((b) => b.id === BID)?.visible === false;
R.snapshotShown = await ev(`!${MINE}.$.snap.hidden && ${MINE}.$.snap.src.startsWith('data:image/jpeg')`);
await ev(`document.querySelector('#sheet [data-k=x]')?.click(), true`);
await sleep(500);
R.backAfterSheet = (await list()).browsers.find((b) => b.id === BID)?.visible === true;
await ev(`document.body.classList.add('dragging'), true`);
await sleep(400);
R.hiddenForDrag = (await list()).browsers.find((b) => b.id === BID)?.visible === false;
await ev(`document.body.classList.remove('dragging'), true`);
await sleep(400);
R.backAfterDrag = (await list()).browsers.find((b) => b.id === BID)?.visible === true;

// 9. Pictures of the window, the page included. A capture of Apaki's own
// page cannot see the native page over the pane, so the page's own picture
// (PNG, from its DevTools channel) goes into the pane's stand-in image at
// the very spot the shell puts the page, then Apaki's page is captured at
// 1320x860. With apakiPid it also asks Windows for the real window
// (window-shot.ps1), which includes the native page.
R.viewportBeforeShots = await viewport();
async function picture(name) {
  await ev(`(async () => {
    const b = ${MINE};
    const r = await window.__TAURI__.core.invoke('browser', { cmd: 'cdp', args: { id: b.id, method: 'Page.captureScreenshot', params: { format: 'png' }, render: true } });
    b.$.snap.src = 'data:image/png;base64,' + r.result.data;
    b.$.snap.hidden = false;
    await b.$.snap.decode();
    return true;
  })()`);
  await sleep(250);
  const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 / DSF } });
  fs.writeFileSync(`${prefix}-${name}.png`, Buffer.from(s.result.data, 'base64'));
  return `${prefix}-${name}.png`;
}
// A fresh page with something typed and the loading light visible is the most telling picture.
await tool('open', { url: SITE_URL });
const r4 = await tool('read');
await tool('type', { ref: refOf(r4.text, refRe('textbox', 'Query')), text: 'built-in browser' });
await ev(`${MINE}.activity('Typed into textbox "Query"'), true`);
R.pictureLight = await picture('browser-light');
await ev(`window.apakiTheme.set('dark')`);
await sleep(900);
await ev(`${MINE}.activity('Typed into textbox "Query"'), true`);
R.pictureDark = await picture('browser-dark');
if (pidArg) {
  const ps = (out) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'window-shot.ps1'), '-ProcessId', pidArg, '-Out', out], { encoding: 'utf8' }).trim();
  try { R.windowShot = ps(path.resolve(`${prefix}-window-dark.png`)); } catch (e) { R.windowShot = String(e.message).split('\n')[0]; }
}
R.saved = await ev(`new Promise((r) => setTimeout(() => r(JSON.stringify(JSON.parse(localStorage.getItem('apaki.workspace.v1') || '{}')).includes('"web"')), 400))`);

// Leave things as found: this check's browser and tab go, the window gets its own size back.
await ev(`(() => { const A = window.__apaki; ${MINE}?.$.close.click(); A.S.panes.get(${JSON.stringify(PANE)})?.$.close.click(); return true; })()`);
await sleep(500);
R.closedInShell = !(await list()).browsers.some((b) => b.id === BID);
await ev(`window.apakiTheme.set(${JSON.stringify(R.theme)})`);
await call('Emulation.clearDeviceMetricsOverride');
server.close();
fs.rmSync(SITE, { recursive: true, force: true });
R.siteRemoved = !fs.existsSync(SITE);
console.log(JSON.stringify(R, null, 1));
ws.close();
process.exit(0);
