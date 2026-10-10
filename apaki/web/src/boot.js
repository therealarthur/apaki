/**
 * boot.js: the start of the Apaki phone client (Track B part 2, 2026-10-09;
 * Arthur: opening the QR with the phone's camera app is the whole pairing
 * step, and then the phone uses Apaki on the PC from anywhere).
 *
 *   1. A QR link (#p=... in the fragment, which never reaches any server):
 *      read it, take it out of the address bar, pair: the phone shows the
 *      6-digit code, the PC user compares and allows.
 *   2. Otherwise reconnect to the PC used last (this browser remembers paired
 *      PCs in IndexedDB, see store.js), or show how to pair.
 *   3. Once the channel is open, load Apaki's own window code (app.js,
 *      unchanged from the desktop) on top of shim.js, which stands in for
 *      the Tauri shell and talks to the PC through link.js.
 *
 * Layout on a phone (web.css): one pane, the sessions list as a drawer from
 * the left, big tap targets, safe-area insets, the same light and dark themes
 * (theme.js) as the desktop.
 */

import { createDeviceIdentity, parsePairingUrl } from './protocol.js';
import { Link } from './link.js';
import { installShim } from './shim.js';
import * as store from './store.js';
import { canScan, scanCode } from './scan.js';
import { MARK_SVG } from './mark.js';
import { effortGrid } from './menu.js';

window.apakiShell = 'web';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''; };
const WORKSPACE = 'apaki.workspace.v1';
const workspaceKey = (roomId) => `${WORKSPACE}@${roomId}`;

const S = { link: null, pc: null, appStarted: false, scanAbort: null, sas: null, overlay: false };

/* ---------- the pairing and connection screen ---------- */

function show(html) {
  const body = $('pairBody');
  body.innerHTML = html;
  body.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => act(b.dataset.k, b.dataset.id, b); });
  $('pairScreen').hidden = false;
  document.body.classList.remove('linked');
}

function hideScreen() {
  $('pairScreen').hidden = true;
  if (S.appStarted) document.body.classList.add('linked');
  S.overlay = false;
}

const grid = () => `<div class="pair-wait">${effortGrid('max', { live: true })}</div>`;

function welcome(pcs, error = '') {
  const list = pcs.length
    ? `<div class="pair-sec">Paired PCs</div><ul class="pair-pcs">${pcs.map((pc) => `<li><div class="pp-t"><b>${esc(pc.pcName || 'PC')}</b><small>paired ${esc(day(pc.pairedAt))}</small></div><button data-k="use" data-id="${esc(pc.roomId)}">Connect</button><button class="quiet" data-k="forget" data-id="${esc(pc.roomId)}">Forget</button></li>`).join('')}</ul>`
    : '';
  show(`<div class="pair-kicker">Phone</div>
    <h1>Connect to your PC</h1>
    ${error ? `<p class="pair-err">${esc(error)}</p>` : ''}
    <ol class="pair-steps">
      <li>Open Myrlin Apaki on your PC.</li>
      <li>Click <b>Phone</b> at the bottom of its sidebar, then <b>Pair a phone</b>.</li>
      <li>Point this phone's camera at the code and open the link.</li>
    </ol>
    ${canScan() ? '<button class="pair-btn" data-k="scan">Scan the code here</button>' : ''}
    <details class="pair-paste"><summary>Paste a pairing link instead</summary><div class="pp-row"><input id="pasteLink" inputmode="url" placeholder="https://…#p=…" autocomplete="off" spellcheck="false"><button data-k="paste">Pair</button></div></details>
    ${list}
    ${S.appStarted && S.pc ? '<button class="pair-btn quiet" data-k="back">Back to Apaki</button>' : ''}`);
}

function pairingScreen(pcName) {
  if (S.sas) {
    show(`<div class="pair-kicker">Pairing</div>
      <h1>Check the code</h1>
      <div class="pair-code" data-sas="${esc(S.sas)}"><span>${esc(S.sas.slice(0, 3))}</span><span>${esc(S.sas.slice(3))}</span></div>
      <p><b>${esc(pcName)}</b> shows a code too. If both match, click <b>Allow</b> there.</p>
      <p class="pair-note">The code proves nobody sits between this phone and your PC.</p>`);
    return;
  }
  show(`<div class="pair-kicker">Pairing</div><h1>Reaching ${esc(pcName)}</h1>${grid()}<p>Your PC is about to show a code to compare.</p>`);
}

const STATE_COPY = {
  connecting: (l) => `Reaching your PC through ${l.relayHost}…`,
  handshake: () => 'Checking it is really your PC…',
  waiting: () => 'Apaki has to be open on the PC, with phone access on. This page connects as soon as it is.',
  offline: (l, info) => (info.full ? 'This PC has the most phones connected at once. Trying again soon.' : `No connection to the relay. Trying again in ${Math.max(1, Math.round((info.retryInMs || 0) / 1000))} s.`),
};

function connectingScreen(link, state, info = {}) {
  const copy = STATE_COPY[state];
  if (!copy) return;
  show(`<div class="pair-kicker">${state === 'waiting' ? 'Waiting for your PC' : 'Connecting'}</div>
    <h1>${esc(link.pcName)}</h1>${grid()}
    <p>${esc(copy(link, info))}</p>
    <button class="pair-btn quiet" data-k="pcs">Other PCs</button>`);
}

const FAILED = {
  removed: ['This phone was removed', 'The PC removed this phone, so it cannot connect any more. To use it again, pair with a new code.'],
  expired: ['That code expired', 'Codes last two minutes. Show a new one on the PC and scan it again.'],
  used: ['That code was already used', 'Each code pairs one phone. Show a new code on the PC.'],
  rejected: ['The PC said no', 'Pairing was denied on the PC. If that was a mistake, show a new code there.'],
  timeout: ['Nobody answered on the PC', 'Allow the phone on the PC within three minutes. Show a new code to try again.'],
  'no-offer': ['No code is showing on the PC', 'Click Pair a phone on the PC, then scan the new code.'],
  'bad-mac': ['That code does not match', 'Show a new code on the PC and scan it again.'],
  'bad-pc': ['That is not the PC from the code', 'The other end could not prove it is the PC that showed the code, so nothing was shared. Show a new code on your PC.'],
  interrupted: ['The connection dropped while pairing', 'Show a new code on the PC and scan it again.'],
  blocked: ['This page cannot reach that relay', ''],
};

function failedScreen(code, message) {
  const [title, text] = FAILED[code] || ['Could not connect', ''];
  const removed = code === 'removed';
  show(`<div class="pair-kicker">Not connected</div><h1>${esc(title)}</h1>
    <p>${esc(text || message || code)}</p>
    ${removed && S.pc ? `<button class="pair-btn" data-k="forget" data-id="${esc(S.pc.roomId)}">Forget this PC</button>` : '<button class="pair-btn" data-k="home">Start over</button>'}`);
}

/* ---------- actions ---------- */

async function act(k, id, el) {
  if (k === 'scan') return startScan();
  if (k === 'stopscan') { S.scanAbort?.abort(); return goHome(); }
  if (k === 'paste') {
    const v = $('pasteLink')?.value.trim();
    try { await pair(parsePairingUrl(v)); } catch { goHome('That is not a pairing link. Copy the whole address, with the part after #.'); }
    return;
  }
  if (k === 'use') return switchTo(id);
  if (k === 'forget') {
    el.disabled = true;
    await store.forgetPc(id).catch(() => {});
    localStorage.removeItem(workspaceKey(id));
    if (S.pc?.roomId === id) { S.link?.stop(); S.link = null; S.pc = null; if (S.appStarted) { location.replace(location.pathname); return; } }
    return goHome();
  }
  if (k === 'pcs') { S.overlay = true; return goHome(); }
  if (k === 'back') return hideScreen();
  if (k === 'home') { if (S.appStarted) { location.replace(location.pathname); return; } return goHome(); }
}

async function goHome(error = '') {
  welcome(await store.listPcs().catch(() => []), error);
}

/** A different PC: its own workspace, its own connection; a fresh page keeps the two apart. */
function switchTo(roomId) {
  if (S.pc?.roomId === roomId && S.link) { hideScreen(); return; }
  keepWorkspace();
  location.replace(`${location.pathname}?pc=${encodeURIComponent(roomId)}`);
}

async function startScan() {
  show(`<div class="pair-kicker">Scan</div><h1>Point at the code</h1><video class="pair-video" playsinline muted></video><button class="pair-btn quiet" data-k="stopscan">Cancel</button>`);
  S.scanAbort = new AbortController();
  try {
    const url = await scanCode($('pairBody').querySelector('video'), { signal: S.scanAbort.signal });
    await pair(parsePairingUrl(url));
  } catch (e) {
    if (e.message !== 'stopped') goHome(e.name === 'NotAllowedError' ? 'The camera was not allowed. Open the code with your camera app instead.' : e.message);
  }
}

/* ---------- the workspace (tabs and panes) per PC ---------- */

function loadWorkspace(roomId) {
  const saved = localStorage.getItem(workspaceKey(roomId));
  if (saved) localStorage.setItem(WORKSPACE, saved);
  else localStorage.removeItem(WORKSPACE);
  return Boolean(saved);
}

function keepWorkspace() {
  if (!S.pc || !S.appStarted) return;
  const cur = localStorage.getItem(WORKSPACE);
  if (cur) localStorage.setItem(workspaceKey(S.pc.roomId), cur);
}
window.addEventListener('pagehide', keepWorkspace);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') keepWorkspace(); });

/* ---------- connecting ---------- */

function linkHandlers() {
  return {
    state: (state, info) => onState(state, info),
    sas: (code) => { S.sas = code; pairingScreen(S.link.pcName); },
    paired: async (pairing) => {
      const rec = { roomId: pairing.roomId, pcName: pairing.pcName, relay: pairing.relay, pairing, device: S.link.device, pairedAt: pairing.pairedAt, lastUsed: new Date().toISOString() };
      await store.savePc(rec);
      S.pc = rec;
      S.sas = null;
    },
    open: () => { if (S.pc) store.touchPc(S.pc.roomId).catch(() => {}); startApp(); },
    hello: () => renderPcLine(),
    fatal: (code, message) => failedScreen(code, message),
  };
}

function onState(state, info) {
  renderPcLine();
  const link = S.link;
  if (!link) return;
  if (S.appStarted) {
    renderLinkBar(state, info);
    return;
  }
  if (S.overlay) return;
  if (state === 'pairing' || state === 'sas') pairingScreen(link.pcName);
  else if (link.pairing) connectingScreen(link, state, info);
  else if (state === 'connecting' || state === 'waiting' || state === 'offline') pairingScreen(link.pcName);
}

async function pair(offer) {
  S.sas = null;
  S.pc = null;
  pairingScreen(offer.name || 'your PC');
  const device = await createDeviceIdentity();
  S.link = new Link({ device, offer, name: await deviceName(), on: linkHandlers() });
  installShim(S.link);
  S.link.start();
}

function connect(pc) {
  S.pc = pc;
  S.link = new Link({ device: pc.device, pairing: pc.pairing, on: linkHandlers() });
  installShim(S.link);
  S.link.start();
}

async function startApp() {
  if (S.appStarted) { hideScreen(); return; }
  S.appStarted = true;
  const restored = S.pc ? loadWorkspace(S.pc.roomId) : false;
  hideScreen();
  // The desktop's message box hint mentions dropping files; a phone attaches with the clip.
  const box = $('paneTpl')?.content.querySelector('textarea');
  if (box) box.placeholder = 'Message Claude, / for commands';
  await import('./app.js');
  renderPcLine();
  // First visit to this PC: show the sessions straight away.
  if (!restored) setDrawer(true);
}

/** This phone's name as the PC shows it: the model when the browser tells it, and the browser. */
async function deviceName() {
  const ua = navigator.userAgent || '';
  let model = '';
  try { model = String((await navigator.userAgentData?.getHighEntropyValues?.(['model']))?.model || '').trim(); } catch { /* not offered */ }
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const device = model || (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone');
  return `${device} (${browser})`.slice(0, 60);
}

/* ---------- once Apaki is running: the drawer, the link bar, the PC line ---------- */

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  $('drawerBtn')?.setAttribute('aria-expanded', String(open));
}

function wireDrawer() {
  $('drawerBtn')?.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
  $('drawerScrim')?.addEventListener('click', () => setDrawer(false));
  $('sessions')?.addEventListener('click', (e) => { if (e.target.closest('li[data-id]')) setDrawer(false); });
  $('new')?.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
  // A swipe to the left closes the drawer.
  const rail = document.querySelector('.rail');
  let x0 = null;
  rail?.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  rail?.addEventListener('touchend', (e) => { if (x0 !== null && e.changedTouches[0].clientX - x0 < -60) setDrawer(false); x0 = null; }, { passive: true });
}

const BAR_COPY = {
  connecting: (l) => ['Reconnecting', `to ${l.pcName}…`],
  handshake: (l) => ['Reconnecting', `to ${l.pcName}…`],
  waiting: (l) => ['Offline', `${l.pcName} is not reachable. Apaki has to be open there.`],
  offline: (l, info) => ['No connection', `Trying again in ${Math.max(1, Math.round((info.retryInMs || 0) / 1000))} s. Tap to retry now.`],
};

function renderLinkBar(state, info = {}) {
  const bar = $('linkBar');
  if (!bar) return;
  if (state === 'open') { bar.hidden = true; return; }
  if (state === 'failed') { bar.hidden = true; return; }
  const copy = BAR_COPY[state];
  if (!copy) return;
  const [k, text] = copy(S.link, info);
  bar.innerHTML = `<span class="lb-k">${esc(k)}</span><span class="lb-t">${esc(text)}</span>`;
  bar.hidden = false;
}

function renderPcLine() {
  const line = $('pcLine');
  if (!line || !S.link) return;
  const word = S.link.state === 'open' ? 'Connected' : S.link.state === 'failed' ? 'Not connected' : 'Reconnecting';
  line.innerHTML = `<span class="pc-k">PC</span><span class="pc-n">${esc(S.link.pcName)}</span><span class="pc-s${S.link.state === 'open' ? ' ok' : ''}">${esc(word)}</span><button id="pcSwitch">Switch</button>`;
  line.querySelector('#pcSwitch').onclick = () => { setDrawer(false); S.overlay = true; goHome(); };
}

/* ---------- small things ---------- */

/** The browser bar follows the theme. */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim() || '#FDFDFF';
}

/** Keeps the layout the size of what is visible, so the message box sits above the keyboard. */
function watchViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const set = () => document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  vv.addEventListener('resize', set);
  set();
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* works without; just not offline */ });
}

/* ---------- start ---------- */

async function main() {
  registerWorker();
  watchViewport();
  wireDrawer();
  syncThemeColor();
  window.addEventListener('apaki-theme', () => requestAnimationFrame(syncThemeColor));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => requestAnimationFrame(syncThemeColor));
  $('linkBar')?.addEventListener('click', () => S.link?.wake());

  // The QR link: its secret is in the fragment; take it out of the address bar and history at once.
  let offer = null;
  let error = '';
  if (/[#&]p=/.test(location.hash)) {
    try { offer = parsePairingUrl(location.href); } catch { error = 'That pairing link is damaged. Show a new code on your PC and scan it again.'; }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (offer) { await pair(offer); return; }
  const pcs = await store.listPcs().catch(() => []);
  const want = new URLSearchParams(location.search).get('pc');
  const pc = pcs.find((p) => p.roomId === want) || pcs[0];
  if (pc && !error) { connect(pc); return; }
  welcome(pcs, error);
}

// For apaki/scripts/cdp-remote.mjs: the connection's state, and a way to drop it (it reconnects by itself).
window.__apakiLink = { state: () => S.link?.state || null, pcName: () => S.link?.pcName || null, drop: () => S.link?.restart() };

main().catch((e) => {
  console.error(e);
  welcome([], `Apaki could not start here: ${e.message}`);
});
