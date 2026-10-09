/**
 * cdp-panes.mjs: smoke test for Apaki's tabs and split panes, over WebView2's
 * DevTools port (start Apaki with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333).
 *
 *   node apaki/scripts/cdp-panes.mjs <out.png>
 *
 * Sends real Haiku turns in two panes at the same time (cheap), drags a
 * session onto a pane edge with real drag events, fills a tab to six panes,
 * checks the seventh is refused, resizes with a real mouse drag on a gutter,
 * evens out the grid, reloads and checks the layout comes back. Prints JSON,
 * including the session ids it created so they can be deleted afterwards.
 * Saves a screenshot capped at 1400 px wide.
 */

const PORT = Number(process.env.CDP_PORT || 9333);
const [out = 'apaki-panes.png'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('no Apaki page on the DevTools port');
}

let ws;
let id = 0;
const pending = new Map();
async function connect() {
  ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
}
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 120000, step = 300) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step); }
  return false;
};

await connect();
await waitFor('!!window.__apaki && document.querySelectorAll("#sessions li").length > 1', 30000);
const R = { created: [] };

// Start clean: one tab, one pane, sound on.
await ev(`(() => { const A = window.__apaki; while (A.S.tabs.length > 1) document.querySelector('.tab.on .tab-x').click(); localStorage.setItem('apaki.sound', 'on'); window.__apakiDings = 0; return A.S.tabs.length; })()`);

const paneCount = 'window.__apaki.L.count(window.__apaki.activeTab().root)';
const sendIn = (idx, text) => ev(`(() => { const A = window.__apaki; const p = A.S.panes.get(A.L.ids(A.activeTab().root)[${idx}]); p.setModel('claude-haiku-5-5'); p.$.input.value = ${JSON.stringify(text)}; p.submit(); return p.id; })()`);
const lastFoot = (idx) => `(() => { const A = window.__apaki; const p = A.S.panes.get(A.L.ids(A.activeTab().root)[${idx}]); return p && !p.busy && p.$.T.querySelectorAll('.foot').length; })()`;
const paneInfo = `(() => { const A = window.__apaki; return A.L.ids(A.activeTab().root).map((id) => { const p = A.S.panes.get(id); const r = p.el.getBoundingClientRect(); return { id, session: p.sessionId, title: p.title, busy: p.busy, w: Math.round(r.width), h: Math.round(r.height), reply: [...p.$.T.querySelectorAll('.turn-assistant')].map((e) => e.textContent).slice(-1)[0] || '' }; }); })()`;

// 1. A turn in pane 1 makes session A; a new conversation in the same pane makes B.
await ev(`(() => { const A = window.__apaki; const p = A.focusedPane(); p.open(null); })()`);
await sleep(150);
await sendIn(0, 'Remember the codeword kiwi. Reply with exactly: one');
R.turn1 = await waitFor(lastFoot(0));
const sessA = await ev(`window.__apaki.focusedPane().sessionId`);
R.created.push(sessA);
await ev(`window.__apaki.focusedPane().open(null)`);
await sleep(150);
await sendIn(0, 'Reply with exactly: two');
await waitFor(lastFoot(0));
R.created.push(await ev(`window.__apaki.focusedPane().sessionId`));
R.dingsAfterTwoTurns = await ev('window.__apakiDings');

// 2. Drag session A onto pane 1's right edge with real drag events.
const dropOn = (sessionId, idx, fx, fy) => ev(`(() => {
  const A = window.__apaki; const p = A.S.panes.get(A.L.ids(A.activeTab().root)[${idx}]);
  const r = p.el.getBoundingClientRect(); const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy};
  const dt = new DataTransfer(); dt.setData('application/x-apaki-session', JSON.stringify({ id: ${JSON.stringify(sessionId)}, cwd: '', title: 'dragged' }));
  const target = document.elementFromPoint(x, y);
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  const hint = document.querySelector('.stage.on .drop-hint'); const text = hint.textContent; const full = hint.classList.contains('full');
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  return { text, full };
})()`);
R.dropA = await dropOn(sessA, 0, 0.95, 0.5);
await waitFor(`${paneCount} === 2`, 5000);
await waitFor(`(() => { const A = window.__apaki; const p = A.S.panes.get(A.L.ids(A.activeTab().root)[1]); return p.sessionId === ${JSON.stringify(sessA)} && p.$.T.querySelectorAll('.turn-user').length > 0; })()`, 20000);

// 3. Both panes at once: pane 2 must remember session A's codeword.
const before = await ev('window.__apakiDings');
await sendIn(0, 'Reply with exactly: three');
await sendIn(1, 'What codeword did I give you? Reply with the word only.');
R.bothBusyAtOnce = await ev(`${paneInfo}.every((p) => p.busy)`);
await waitFor(`${lastFoot(0)} && ${lastFoot(1)}`);
R.dingsForConcurrent = (await ev('window.__apakiDings')) - before;
R.twoPanes = await ev(paneInfo);

// 3b. Resize: a real mouse drag on the gutter between the two panes.
const g = await ev(`(() => { const r = document.querySelector('.stage.on > .split > .gutter').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dir: document.querySelector('.stage.on > .split > .gutter').classList.contains('row') ? 'row' : 'col' }; })()`);
const sizesBefore = await ev(`JSON.stringify(window.__apaki.activeTab().root.sizes)`);
const dx = g.dir === 'row' ? 140 : 0;
const dy = g.dir === 'col' ? 90 : 0;
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y });
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 });
for (let s = 1; s <= 8; s++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x + (dx * s) / 8, y: g.y + (dy * s) / 8, button: 'left', buttons: 1 });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x + dx, y: g.y + dy, button: 'left', clickCount: 1 });
R.resize = { dir: g.dir, before: sizesBefore, after: await ev(`JSON.stringify(window.__apaki.activeTab().root.sizes)`) };
// 4. Fill the tab to six with new conversations dropped on edges, then try a seventh.
const edges = [[0.5, 0.97], [0.03, 0.5], [0.5, 0.97], [0.97, 0.5]];
for (let i = 0; i < 4; i++) {
  await dropOn(null, i % 2, ...edges[i]);
  await sleep(400);
}
R.panesAfterFill = await ev(paneCount);
R.seventh = await ev(`(() => { const A = window.__apaki; const p = A.S.panes.get(A.L.ids(A.activeTab().root)[2]); const r = p.el.getBoundingClientRect(); const x = r.left + r.width * .97, y = r.top + r.height * .5; const dt = new DataTransfer(); dt.setData('application/x-apaki-session', 'null'); document.elementFromPoint(x, y).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })); const h = document.querySelector('.stage.on .drop-hint'); const res = { text: h.textContent, full: h.classList.contains('full') }; h.classList.remove('on'); return res; })()`);

R.sixPanes = (await ev(paneInfo)).map(({ w, h }) => `${w}x${h}`);

// 6. Even grid.
await ev(`document.querySelector('.tab-tool').click()`);
await sleep(300);
R.grid = await ev(`(() => { const r = window.__apaki.activeTab().root; return r.dir + ':' + r.children.map((c) => c.type === 'leaf' ? 1 : c.children.length).join('+'); })()`);
await sleep(400);
const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 } });
const fs = await import('node:fs');
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

// 7. A second tab, then reload: both tabs and all panes come back.
await ev(`window.__apaki.addTab()`);
await sleep(600);
const layoutBefore = await ev(`window.__apaki.S.tabs.map((t) => window.__apaki.L.ids(t.root).length).join(',')`);
await sleep(500); // the save is debounced
await call('Page.reload');
ws.close();
await sleep(1500);
await connect();
await waitFor('!!window.__apaki', 20000);
await sleep(1500);
R.reload = { before: layoutBefore, after: await ev(`window.__apaki.S.tabs.map((t) => window.__apaki.L.ids(t.root).length).join(',')`), sessionsBack: await ev(`[...window.__apaki.S.panes.values()].map((p) => p.sessionId).filter(Boolean)`) };

// 8. Close everything back to one empty pane and clear the saved workspace.
await ev(`(() => { const A = window.__apaki; for (const t of [...A.S.tabs]) for (const id of A.L.ids(t.root)) { const p = A.S.panes.get(id); if (p) p.$.close.click(); } return A.S.tabs.length; })()`);
await sleep(150);
R.afterClose = await ev(`({ tabs: window.__apaki.S.tabs.length, panes: window.__apaki.S.panes.size })`);
console.log(JSON.stringify(R, null, 1));
ws.close();
process.exit(0);
