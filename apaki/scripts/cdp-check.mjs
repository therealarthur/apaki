/**
 * cdp-check.mjs: drives a running Myrlin Apaki window over WebView2's DevTools
 * port, for smoke tests without a person at the keyboard.
 *
 * Start Apaki with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333,
 * then: node apaki/scripts/cdp-check.mjs <out.png> [message]
 * Prints the window's state as JSON and saves a screenshot capped at 1400 px
 * wide (images over 2000 px break Claude sessions). With a message, it picks
 * Haiku, sends the message in a new conversation and waits for the reply.
 */

const PORT = Number(process.env.CDP_PORT || 9333);
const [out = 'apaki-check.png', message = ''] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('no Apaki page on the DevTools port');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expr) => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

const state = () => evaluate(`({
  sessions: document.querySelectorAll('#sessions li').length,
  views: [...document.querySelectorAll('#views button')].map((b) => b.textContent),
  index: document.getElementById('indexState').textContent,
  billing: document.getElementById('billing').textContent,
  title: document.getElementById('title').textContent,
  status: document.getElementById('status').textContent,
  transcript: [...document.querySelectorAll('#transcript > *')].slice(-6).map((e) => e.className + ': ' + e.textContent.slice(0, 120)),
  fontsOk: document.fonts.check('16px Archivo'),
})`);

for (let i = 0; i < 30; i++) { const s = await state(); if (s?.sessions > 1 && !/Loading/.test(s.index)) break; await sleep(300); }
const t0 = Date.now();
await evaluate(`(() => { const q = document.getElementById('q'); q.value = 'ground truth drafter'; q.dispatchEvent(new Event('input')); })()`);
for (let i = 0; i < 30; i++) { if (await evaluate(`document.getElementById('searchState').textContent.length > 0`)) break; await sleep(100); }
const searchMs = Date.now() - t0;
const search = await evaluate(`({ info: document.getElementById('searchState').textContent, top: [...document.querySelectorAll('#sessions li .t')].slice(0, 3).map((e) => e.textContent) })`);

let reply = null;
if (message) {
  await evaluate(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); document.getElementById('new').click(); })()`);
  await sleep(1500);
  await evaluate(`(() => { const m = document.getElementById('model'); m.value = 'claude-haiku-5-5'; m.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  await evaluate(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(message)}; document.getElementById('sendBtn').click(); })()`);
  for (let i = 0; i < 240; i++) { if (await evaluate(`!!document.querySelector('#transcript .foot')`)) break; await sleep(500); }
  reply = await evaluate(`({ foot: document.querySelector('#transcript .foot')?.textContent, assistant: [...document.querySelectorAll('#transcript .turn-assistant')].map((e) => e.textContent.slice(0, 200)), tools: [...document.querySelectorAll('#transcript .tool summary')].map((e) => e.textContent), session: document.getElementById('cwd').textContent })`);
}

const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 } });
const fs = await import('node:fs');
const png = Buffer.from(shot.result.data, 'base64');
fs.writeFileSync(out, png);
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);
console.log(JSON.stringify({ state: await state(), searchMs, search, reply, screenshot: { out, w, h } }, null, 1));
ws.close();
process.exit(0);
