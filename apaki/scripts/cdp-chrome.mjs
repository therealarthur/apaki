#!/usr/bin/env node
/**
 * cdp-chrome.mjs: checks the 2026-10-09 evening window changes in a running
 * Apaki (start it with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>):
 * no OS title bar (own window buttons, drag regions), the frosted sidebar in
 * sections, bolder type, the search lens with Ask Claude, and the takeover
 * card (shown with a made-up holder; no lock is touched).
 *   node apaki/scripts/cdp-chrome.mjs <out-prefix> [port] [--ask]
 * --ask also clicks Ask Claude (a real call, about a cent, billed to the live
 * login). Screenshots are 1320x860 CSS px at scale 1 (under the 2000 px image
 * limit; check the size before viewing on a high-DPI screen).
 */

import fs from 'node:fs';

const args = process.argv.slice(2);
const prefix = args[0] || 'apaki-chrome';
const port = Number(args[1]) || 9334;
const ask = args.includes('--ask');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 120 && !ws; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((t) => t.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { await sleep(250); }
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 60)}: ${r.result.exceptionDetails.exception?.description}`); return r.result?.result?.value; };
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };
const size = await ev('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
const shot = async (name) => {
  const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: Math.min(size.w, 1320), height: Math.min(size.h, 860), scale: 1 / size.dpr } });
  fs.writeFileSync(`${prefix}-${name}.png`, Buffer.from(s.result.data, 'base64'));
};
const R = { size };

await waitFor('!!window.__apaki && document.querySelectorAll("#sessions li").length > 1');
R.chrome = await ev(`({
  winButtons: [...document.querySelectorAll('#winctl button')].map((b) => b.dataset.w),
  dragRegions: [...document.querySelectorAll('[data-tauri-drag-region]')].map((e) => e.className || e.tagName),
  topbarHeight: document.querySelector('.topbar').getBoundingClientRect().height,
  brandHeight: document.querySelector('.brand').getBoundingClientRect().height,
  railBackdrop: getComputedStyle(document.querySelector('.rail')).backdropFilter,
  railBg: getComputedStyle(document.querySelector('.rail')).backgroundColor,
  sections: [...document.querySelectorAll('.rail .sec-t')].map((e) => e.textContent),
  scrollbar: getComputedStyle(document.querySelector('#sessions')).scrollbarColor,
  weights: { title: getComputedStyle(document.querySelector('.pane .title')).fontWeight, row: getComputedStyle(document.querySelector('#sessions .t')).fontWeight, wordmark: getComputedStyle(document.querySelector('.wordmark')).fontWeight },
})`);
await shot('window');

// The search lens: type a question, wait for words + meaning results.
const q = 'i want to find a conversation/session that was involved in forge.myrlin.io, specifically the marketing and growth related sessions';
await ev(`(() => { const i = document.getElementById('q'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
R.searched = await waitFor(`/sessions|words/.test(document.getElementById('lensInfo').textContent) && window.__apaki.S.results`, 20000);
R.lens = await ev(`document.getElementById('lensInfo').textContent`);
R.top = await ev(`[...document.querySelectorAll('#sessions li .t')].slice(0, 5).map((e) => e.textContent)`);
R.byMeaning = await ev(`document.querySelectorAll('#sessions .by-meaning').length`);
R.digRow = await ev(`!!document.querySelector('#sessions .dig')`);
await shot('search');

if (ask) {
  await ev(`document.getElementById('ask').click()`);
  R.asked = await waitFor(`!!window.__apaki.S.ai`, 60000);
  R.askLens = await ev(`document.getElementById('lensInfo').textContent`);
  R.picks = await ev(`[...document.querySelectorAll('#sessions li')].filter((l) => l.querySelector('.why')).slice(0, 4).map((l) => l.querySelector('.t').textContent + ' :: ' + l.querySelector('.why').textContent)`);
  await shot('ask');
}

// The takeover card, from a made-up "locked" event (no lock is touched).
await ev(`(() => { const i = document.getElementById('q'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await ev(`window.__apaki.focusedPane().handle({ ev: 'locked', sessionId: '00000000-0000-4000-8000-000000000000', title: 'Toggleable claude -p message routing', cwd: 'C:\\\\Users\\\\Arthur', holder: { pid: 83600, app: 'latch-relay', name: 'latch in a terminal window', at: new Date(Date.now() - 3600e3).toISOString(), alive: true } })`);
await sleep(400);
R.takeover = await ev(`({ card: !!document.querySelector('.takeover'), button: document.querySelector('.tk-go')?.textContent })`);
await shot('takeover');
// Leave the pane as it was: Cancel puts it back to a new conversation.
await ev(`document.querySelector('.tk-no')?.click()`);
console.log(JSON.stringify(R, null, 1));
ws.close();
