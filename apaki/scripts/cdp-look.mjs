/**
 * cdp-look.mjs: checks Apaki's composer settings, menus and folders without
 * sending any message (no cost). Start Apaki with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333, then:
 *   node apaki/scripts/cdp-look.mjs <out-prefix>
 * Saves <out-prefix>-menu.png and <out-prefix>-split.png (1320x860, under
 * the 2000 px image limit). Creates and deletes a folder named "zz apaki test".
 */

const [prefix = 'apaki-look'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try { const l = await (await fetch('http://127.0.0.1:9333/json')).json(); const p = l.find((t) => t.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { await sleep(250); }
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 60)}: ${r.result.exceptionDetails.exception?.description}`); return r.result?.result?.value; };
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 } }); (await import('node:fs')).writeFileSync(`${prefix}-${name}.png`, Buffer.from(s.result.data, 'base64')); };
const R = {};

await waitFor('!!window.__apaki && document.querySelectorAll("#sessions li").length > 1');
R.fonts = await ev(`({ archivo: document.fonts.check('820 17px Archivo'), titleStretch: getComputedStyle(document.querySelector('.pane .title')).fontStretch, titleWeight: getComputedStyle(document.querySelector('.pane .title')).fontWeight })`);
R.chips = await ev(`[...document.querySelectorAll('.pane.focused .chip-btn')].map((b) => b.textContent.trim())`);

// Shift+Tab in the message box cycles the mode.
R.modes = await ev(`(() => { const p = window.__apaki.focusedPane(); const out = [p.mode]; for (let i = 0; i < 4; i++) { p.$.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); out.push(p.mode); } return out; })()`);

// The effort menu, open, for the screenshot.
await ev(`document.querySelector('.pane.focused .chip-btn.effort').click()`);
await sleep(250);
R.effortMenu = await ev(`[...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim())`);
await shot('menu');
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// Folders: make one inline, drag a session in, drag it back out via All, delete.
await ev(`document.querySelector('.folder-add').click()`);
await sleep(100);
await ev(`(() => { const i = document.querySelector('.folder-row.editing input'); i.value = 'zz apaki test'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
await waitFor(`[...document.querySelectorAll('.folder-row')].some((r) => r.textContent.includes('zz apaki test'))`);
const sid = await ev(`window.__apaki.S.sessions.find((s) => !s.codex && !s.folder).id`);
const drop = (selector) => ev(`(() => { const t = ${selector}; const dt = new DataTransfer(); dt.setData('application/x-apaki-session', JSON.stringify({ id: ${JSON.stringify(sid)} })); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
await drop(`[...document.querySelectorAll('.folder-row')].find((r) => r.textContent.includes('zz apaki test'))`);
R.movedIn = await waitFor(`window.__apaki.S.sessions.find((s) => s.id === ${JSON.stringify(sid)})?.folder === window.__apaki.S.folders.find((f) => f.name === 'zz apaki test')?.id`);
await drop(`document.querySelector('#views button')`);
R.movedOut = await waitFor(`!window.__apaki.S.sessions.find((s) => s.id === ${JSON.stringify(sid)})?.folder`);
await ev(`(() => { window.confirm = () => true; const row = [...document.querySelectorAll('.folder-row')].find((r) => r.textContent.includes('zz apaki test')); row.querySelector('.folder-x').click(); })()`);
R.deleted = await waitFor(`!window.__apaki.S.folders.some((f) => f.name === 'zz apaki test')`);

// Two panes, for the look: a second new conversation split to the right.
await ev(`window.__apaki.dropSession({ id: null, cwd: '', title: '' }, 'right')`);
await sleep(900);
await shot('split');
R.panes = await ev(`window.__apaki.L.count(window.__apaki.activeTab().root)`);
await ev(`(() => { const A = window.__apaki; const ids = A.L.ids(A.activeTab().root); if (ids.length > 1) A.S.panes.get(ids[1]).$.close.click(); })()`);
console.log(JSON.stringify(R, null, 1));
ws.close();
process.exit(0);
