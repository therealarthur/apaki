/**
 * cdp-theme.mjs: screenshots Apaki in the light and dark themes without
 * sending any message (no cost). Start Apaki (ideally the dev build) with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333, then:
 *   node apaki/scripts/cdp-theme.mjs <out-prefix>
 * Opens one idle session (older than 2 hours, not open in a terminal) beside
 * the empty pane, so a transcript, the split, the focused-pane line and the
 * empty state all show, then saves <prefix>-light.png, <prefix>-dark.png and
 * <prefix>-dark-menu.png at 1320x860 (under the 2000 px image limit), and
 * prints contrast checks for the main text tokens in each theme. It leaves
 * the theme as it found it and closes the pane it opened.
 */

const [prefix = 'apaki-theme'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try { const l = await (await fetch('http://127.0.0.1:9333/json')).json(); const p = l.find((t) => t.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { await sleep(250); }
}
if (!ws) throw new Error('no Apaki page on port 9333');
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 60)}: ${r.result.exceptionDetails.exception?.description}`); return r.result?.result?.value; };
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };
const shot = async (name) => { const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1320, height: 860, scale: 1 } }); (await import('node:fs')).writeFileSync(`${prefix}-${name}.png`, Buffer.from(s.result.data, 'base64')); };

await call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 860, deviceScaleFactor: 1, mobile: false });
await waitFor('!!window.__apaki && !!window.apakiTheme && document.querySelectorAll("#sessions li").length > 1');
const R = { startChoice: await ev('window.apakiTheme.get()') };

// One idle session beside the empty pane.
const opened = await ev(`(() => {
  const now = Date.now();
  const s = window.__apaki.S.sessions.find((x) => x.id && !x.live && !x.codex && (now - (x.lastModified || now)) > 2 * 3600e3 && (x.title || '').length < 60);
  if (!s) return null;
  window.__apaki.dropSession(s, 'right');
  return { id: s.id, title: s.title };
})()`);
R.opened = opened;
if (opened) await waitFor('document.querySelectorAll(".turn-assistant").length > 0', 25000);
await sleep(600);

// Contrast of the text tokens on the card and ground, per theme.
const contrast = `(() => {
  const css = getComputedStyle(document.documentElement);
  const rgb = (v) => { const d = document.createElement('i'); d.style.color = v; document.body.append(d); const c = getComputedStyle(d).color.match(/\\d+(\\.\\d+)?/g).map(Number); d.remove(); return c; };
  const L = ([r, g, b]) => [r, g, b].map((x) => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [L(rgb(a)), L(rgb(b))].sort((p, q) => q - p); return +((x + .05) / (y + .05)).toFixed(2); };
  const t = (n) => css.getPropertyValue(n).trim();
  const out = {};
  for (const fg of ['--ink', '--soft', '--faint', '--brand-strong', '--brand-deep', '--action-strong', '--good']) out[fg] = { card: ratio(t(fg), t('--card')), ground: ratio(t(fg), t('--ground')) };
  out['white on --fill'] = ratio('#fff', t('--fill'));
  return out;
})()`;

for (const theme of ['light', 'dark']) {
  await ev(`window.apakiTheme.set(${JSON.stringify(theme)})`);
  await sleep(500);
  R[theme] = { applied: await ev('document.documentElement.dataset.theme'), button: await ev(`document.getElementById('theme').textContent`), contrast: await ev(contrast) };
  await shot(theme);
}
// Dark with the effort menu open (menus, chips, the peach crest).
await ev(`document.querySelector('.pane.focused .chip-btn.effort')?.click()`);
await sleep(300);
await shot('dark-menu');
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// Leave things as found.
await ev(`window.apakiTheme.set(${JSON.stringify(R.startChoice)})`);
if (opened) await ev(`(() => { for (const p of window.__apaki.S.panes.values()) if (p.session?.id === ${JSON.stringify(opened.id)}) p.$?.close?.click?.(); })()`);
console.log(JSON.stringify(R, null, 1));
ws.close();
