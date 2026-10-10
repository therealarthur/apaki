/**
 * cdp-artifacts.mjs: checks Apaki's artifact viewer and cards without any
 * model call (no cost). Start an Apaki build (ideally the dev build) with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>, then:
 *   node apaki/scripts/cdp-artifacts.mjs <out-prefix> [port]
 *
 * It writes four test artifacts (an HTML page that probes its own sandbox,
 * Markdown, SVG, PNG) into the artifact store under the session folder
 * "apaki-cdp-test", then injects the engine events Claude's show tool would
 * cause (artifact, openUrl) through Tauri's event bus, so the window does
 * exactly what it does for a real show: a card in the conversation, the
 * viewer split beside it, revisions, the link card. It reads the sandbox
 * probe from the iframe's own CDP target (no Tauri, no parent, no storage,
 * no network), and saves screenshots at 1320x860 (under the 2000 px image
 * limit): <prefix>-html-light.png, -html-dark.png, -md-dark.png,
 * -md-light.png, -image-light.png, -revs-light.png. At the end it closes
 * the viewers it opened, puts the theme back, and deletes "apaki-cdp-test".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '../engine/artifacts.js';

const [prefix = 'apaki-artifacts', portArg = '9341'] = process.argv.slice(2);
const PORT = Number(portArg);
const SID = 'apaki-cdp-test';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- test artifacts ---------- */

const store = new ArtifactStore();
const PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>Signups</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1c1b2e; background: #fbfbff; }
  main { padding: 34px 38px; }
  h1 { font: 800 30px/1.1 system-ui, sans-serif; letter-spacing: -.02em; margin: 0 0 6px; }
  p { margin: 0 0 22px; color: #55566b; }
  .bars { display: flex; align-items: flex-end; gap: 14px; height: 190px; padding: 0 0 8px; border-bottom: 1px solid #e3e5f6; }
  .bar { flex: 1; border-radius: 8px 8px 3px 3px; background: linear-gradient(180deg, #6572d4, #8e96dc); position: relative; animation: grow .5s cubic-bezier(.22,1,.36,1) both; transform-origin: bottom; }
  .bar span { position: absolute; top: -22px; left: 0; right: 0; text-align: center; font: 600 12px ui-monospace, monospace; color: #2c3578; }
  .bar.hot { background: linear-gradient(180deg, #f2a57e, #f6c8ae); }
  .labels { display: flex; gap: 14px; margin-top: 6px; font: 600 12px system-ui; color: #63647d; }
  .labels div { flex: 1; text-align: center; }
  @keyframes grow { from { transform: scaleY(0); } }
  pre { margin-top: 26px; padding: 12px 14px; background: #f1f2fb; border-radius: 8px; font: 12px/1.5 ui-monospace, monospace; }
</style></head><body><main>
<h1>Weekly signups</h1><p>A sample artifact from cdp-artifacts.mjs. The box below is the page checking its own sandbox.</p>
<div class="bars"><div class="bar" style="height:38%"><span>412</span></div><div class="bar" style="height:52%"><span>566</span></div><div class="bar" style="height:47%"><span>509</span></div><div class="bar" style="height:71%"><span>771</span></div><div class="bar hot" style="height:92%"><span>998</span></div></div>
<div class="labels"><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div></div>
<pre id="checks">checking…</pre></main>
<script>
  const out = {};
  out.tauri = typeof window.__TAURI__;
  out.tauriInternals = typeof window.__TAURI_INTERNALS__;
  out.ipc = typeof window.ipc;
  out.webview = typeof (window.chrome && window.chrome.webview);
  out.origin = String(window.origin);
  try { out.parent = String(window.parent.document.title); } catch (e) { out.parent = 'blocked'; }
  try { localStorage.setItem('x', '1'); out.storage = 'open'; } catch (e) { out.storage = 'blocked'; }
  try { document.cookie = 'a=1'; out.cookie = document.cookie ? 'open' : 'blocked'; } catch (e) { out.cookie = 'blocked'; }
  const img = new Promise((r) => { const i = new Image(); i.onload = () => r('open'); i.onerror = () => r('blocked'); i.src = 'https://www.google.com/favicon.ico'; });
  const net = fetch('https://example.com/').then(() => 'open', () => 'blocked');
  const local = fetch(location.origin + '/').then(() => 'open', () => 'blocked');
  // The one that matters: can the page reach the app's commands? (billingOptions has no side effects.)
  const call = (o, name) => {
    try {
      if (!o || typeof o.invoke !== 'function') return Promise.resolve('absent');
      return Promise.race([o.invoke('engine_send', { msg: { op: 'billingOptions', reqId: 'iframe-probe-' + name } }).then(() => 'OPEN', (e) => 'refused: ' + String(e && (e.message || e)).slice(0, 120)), new Promise((r) => setTimeout(() => r('no answer'), 3000))]);
    } catch (e) { return Promise.resolve('threw: ' + String(e).slice(0, 120)); }
  };
  const inv1 = call(window.__TAURI_INTERNALS__, 'internals');
  const inv2 = call(window.__TAURI__ && window.__TAURI__.core, 'core');
  const raw = new Promise((r) => { try { if (window.chrome && window.chrome.webview) { window.chrome.webview.postMessage(JSON.stringify({ cmd: 'engine_send', callback: 0, error: 0, payload: { msg: { op: 'billingOptions', reqId: 'iframe-probe-raw' } } })); r('posted'); } else r('absent'); } catch (e) { r('threw: ' + String(e).slice(0, 80)); } });
  Promise.all([net, local, img, inv1, inv2, raw]).then(([a, b, c, d, e, f]) => {
    out.fetchRemote = a; out.fetchEngine = b; out.imageRemote = c; out.invokeInternals = d; out.invokeCore = e; out.rawPostMessage = f;
    document.getElementById('checks').textContent = JSON.stringify(out, null, 1);
    document.body.dataset.done = '1';
  });
</script></body></html>`;

const MD = `# Release notes, week 41

Apaki now shows what Claude makes **right beside the conversation**: pages, charts, diagrams, images and documents.

## What changed

- A viewer pane opens to the right of the conversation that made it.
- Every show is a *revision*; step back with the arrows in the header.
- Shell commands like \`start report.html\` open here instead of a browser.

| Kind | Where it renders | Network |
| --- | --- | --- |
| HTML | sandboxed frame | none |
| Markdown | the app's renderer | none |
| SVG, images | image view | none |

\`\`\`js
await show({ title: 'Signups', kind: 'html', content: page });
\`\`\`

> Pages run without network access, so everything they need is inline.
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 260" width="520" height="260">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#6572D4"/><stop offset="1" stop-color="#F2A57E"/></linearGradient></defs>
<rect width="520" height="260" rx="18" fill="#FDFDFF"/>
<g font-family="system-ui" font-weight="700" font-size="15" fill="#1E1B33">
<rect x="34" y="96" width="120" height="68" rx="12" fill="#EDEEFB" stroke="#6572D4"/><text x="94" y="135" text-anchor="middle">Claude</text>
<rect x="200" y="96" width="120" height="68" rx="12" fill="#EDEEFB" stroke="#6572D4"/><text x="260" y="128" text-anchor="middle">show</text><text x="260" y="148" text-anchor="middle" font-size="11" font-weight="500">mcp__apaki</text>
<rect x="366" y="96" width="120" height="68" rx="12" fill="#FCF2EC" stroke="#F2A57E"/><text x="426" y="135" text-anchor="middle">Viewer</text>
</g>
<path d="M156 130h40M322 130h40" stroke="url(#g)" stroke-width="3" stroke-linecap="round"/>
<path d="M190 124l8 6-8 6M356 124l8 6-8 6" fill="none" stroke="#6572D4" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** A one-page PDF with a line of text, built by hand (offsets computed), so no tool is needed. */
function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 220] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  const stream = `BT /F1 22 Tf 36 120 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
const pdfFile = path.join(store.root, `${SID}-tmp.pdf`);
fs.mkdirSync(store.root, { recursive: true });
fs.writeFileSync(pdfFile, tinyPdf('Apaki shows PDFs too'));

const html1 = store.show(SID, { title: 'Weekly signups', kind: 'html', content: PROBE });
const pdf = store.show(SID, { title: 'Invoice', kind: 'file', path: pdfFile });
fs.rmSync(pdfFile, { force: true });
const md = store.show(SID, { title: 'Release notes', kind: 'markdown', content: MD });
const svg = store.show(SID, { title: 'How show works', kind: 'svg', content: SVG });
const png = store.show(SID, { title: 'App icon', kind: 'file', path: path.join(HERE, '..', 'icons', 'icon.png') });

/* ---------- CDP ---------- */

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { await sleep(250); }
}
if (!ws) throw new Error(`no Apaki page on port ${PORT}`);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.result.exceptionDetails.exception?.description}`); return r.result?.result?.value; };
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await sleep(150); } return false; };
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 } }); fs.writeFileSync(`${prefix}-${name}.png`, Buffer.from(s.result.data, 'base64')); };
const emit = (payload) => ev(`window.__TAURI__.event.emit('engine', ${JSON.stringify(payload)}).then(() => true)`);
const event = (rec, extra = {}) => ({ ev: 'artifact', paneId: PANE, sessionId: rec.sessionId, id: rec.id, title: rec.title, kind: rec.kind, rev: rec.rev, ext: rec.ext, size: rec.size, source: rec.source, revs: rec.revs, via: 'show', toolUseId: null, ...extra });

await call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 860, deviceScaleFactor: 1, mobile: false });
await waitFor('!!window.__apaki && !!window.apakiTheme && window.__apaki.S.panes.size > 0');
const R = { theme: await ev('window.apakiTheme.get()') };
await ev(`window.apakiTheme.set('light')`);
// A new tab with a new conversation, so the viewer has room and no history redraw wipes the cards.
const PANE = await ev(`(() => {
  const A = window.__apaki;
  for (const v of A.viewers()) v.$.close.click();
  A.addTab();
  return A.focusedPane()?.id || null;
})()`);
if (!PANE) throw new Error('no conversation pane');
R.pane = PANE;
await waitFor(`window.__apaki.S.panes.get(${JSON.stringify(PANE)})?.$.cwd.textContent.length > 0`);
// Any engine reply the page's IPC probe below manages to cause.
await ev(`(window.__probeSeen = [], window.__TAURI__.event.listen('engine', ({ payload }) => { if (String(payload.reqId || '').startsWith('iframe-probe')) window.__probeSeen.push(payload.reqId); }).then(() => true))`);

// 1. An HTML artifact, as the show tool would announce it (no src: the viewer asks the engine).
await emit(event(html1));
R.viewerOpened = await waitFor(`window.__apaki.viewers().length === 1`);
R.cardShown = await waitFor(`!!document.querySelector('.pane[data-pane="${PANE}"] .art-card[data-id="${html1.id}"]')`);
R.frameLoaded = await waitFor(`!!document.querySelector('.pane.viewer iframe.art-frame')?.src`);
R.frame = await ev(`(() => { const f = document.querySelector('.pane.viewer iframe.art-frame'); return { sandbox: f.getAttribute('sandbox'), src: f.src.replace(/\\/a\\/[^/]+\\//, '/a/<token>/') }; })()`);
R.layout = await ev(`(() => { const A = window.__apaki; const t = A.activeTab(); return { panes: A.L.count(t.root), order: A.L.ids(t.root).map((i) => A.S.panes.get(i)?.isViewer ? 'viewer' : 'conversation') }; })()`);
R.focusStayed = await ev(`window.__apaki.focusedPane()?.id === ${JSON.stringify(PANE)}`);

// The page's own view of its sandbox, read from the iframe's CDP target.
let probe = null;
for (let i = 0; i < 40 && !probe; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const f = targets.find((t) => t.type === 'iframe' && /\/a\/[^/]+\/apaki-cdp-test\//.test(t.url));
  if (f) {
    const fw = new WebSocket(f.webSocketDebuggerUrl);
    await new Promise((r) => fw.addEventListener('open', r, { once: true }));
    const got = await new Promise((r) => {
      fw.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id === 1) r(j.result?.result?.value); });
      fw.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `new Promise((r) => { const t = () => document.body?.dataset.done ? r(document.getElementById('checks').textContent) : setTimeout(t, 100); t(); })`, awaitPromise: true, returnByValue: true } }));
    });
    fw.close();
    probe = got ? JSON.parse(got) : null;
  } else await sleep(250);
}
R.sandboxProbe = probe || 'iframe target not found (same-process frame?)';
await sleep(800);
// Engine replies caused from inside the page: must be none.
R.ipcFromFrameReachedEngine = await ev('window.__probeSeen');
await sleep(700);
await shot('html-light');
await ev(`window.apakiTheme.set('dark')`);
await sleep(400);
await shot('html-dark');

// 2. Markdown in the same viewer (same conversation), then the link card.
await emit(event(md));
R.markdown = await waitFor(`!!document.querySelector('.pane.viewer .art-doc h1')`);
await emit({ ev: 'openUrl', paneId: PANE, sessionId: SID, url: 'http://localhost:5173/', title: null, reason: 'vite --open', toolUseId: null });
R.linkCard = await waitFor(`!!document.querySelector('.pane[data-pane="${PANE}"] .art-card.link')`);
await sleep(400);
await shot('md-dark');
await ev(`window.apakiTheme.set('light')`);
await sleep(400);
await shot('md-light');

// 3. SVG and an image file.
await emit(event(svg));
R.svg = await waitFor(`document.querySelector('.pane.viewer .art-figure img')?.complete && document.querySelector('.pane.viewer .art-figure img').naturalWidth > 0`);
await emit(event(png, { via: 'start' }));
R.image = await waitFor(`(() => { const i = document.querySelector('.pane.viewer .art-figure img'); return i && i.src.includes(${JSON.stringify(png.id)}) && i.complete && i.naturalWidth === 512; })()`);
await sleep(300);
await shot('image-light');
R.imageFits = await ev(`(() => { const v = document.querySelector('.pane.viewer'); const i = v.querySelector('.art-figure img'); const c = v.querySelector('.close').getBoundingClientRect(); const r = v.getBoundingClientRect(); return i.getBoundingClientRect().width <= r.width && c.right <= r.right + 1; })()`);
await emit(event(pdf));
R.pdf = await waitFor(`!!document.querySelector('.pane.viewer iframe.art-frame.pdf')?.src`);
await sleep(1500);
await shot('pdf-light');

// 4. A live revision of the HTML page, then the card for rev 1 opens rev 1 again.
const html2 = store.show(SID, { id: html1.id, title: 'Weekly signups', kind: 'html', content: PROBE.replace('Weekly signups</h1>', 'Weekly signups, revised</h1>') });
await emit(event(html2));
R.revision = await waitFor(`/rev 2 of 2/.test(document.querySelector('.pane.viewer .rev-n')?.textContent || '')`);
await ev(`document.querySelector('.pane[data-pane="${PANE}"] .art-card[data-id="${html1.id}"][data-rev="1"] .art-open')?.click()`);
R.cardOpensRev1 = await waitFor(`/rev 1 of 2/.test(document.querySelector('.pane.viewer .rev-n')?.textContent || '')`);
await sleep(500);
await shot('revs-light');
R.cards = await ev(`[...document.querySelectorAll('.pane[data-pane="${PANE}"] .art-card')].map((c) => c.querySelector('.art-kicker').textContent + ' / ' + c.querySelector('.art-title').textContent)`);
R.saved = await ev(`new Promise((r) => setTimeout(() => { const w = JSON.parse(localStorage.getItem('apaki.workspace.v1') || '{}'); r(JSON.stringify(w).includes('"view"')); }, 400))`);
R.contrast = await ev(`(() => { const k = getComputedStyle(document.querySelector('.art-kicker')); const t = getComputedStyle(document.querySelector('.art-title')); return { kicker: k.color, title: t.color, titleFont: t.fontFamily.split(',')[0] + ' ' + t.fontWeight + ' ' + t.fontStretch }; })()`);

// Leave things as found: the viewers and the tab this made go.
await ev(`(() => { const A = window.__apaki; for (const v of A.viewers()) v.$.close.click(); A.S.panes.get(${JSON.stringify(PANE)})?.$.close.click(); })()`);
await ev(`window.apakiTheme.set(${JSON.stringify(R.theme)})`);
fs.rmSync(store.dir(SID), { recursive: true, force: true });
R.cleaned = !fs.existsSync(store.dir(SID));
console.log(JSON.stringify(R, null, 1));
ws.close();
process.exit(0);
