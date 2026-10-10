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
 * Layout on a phone (web.css, native.js since 2026-10-10): a native app's
 * stack. The sessions list is home, a conversation slides in over it, Back or
 * a swipe from the left edge returns; menus and sheets rise from the bottom;
 * big tap targets, safe-area insets, the same light and dark themes
 * (theme.js) as the desktop.
 *
 * Apaki account (2026-10-10, account.js, apaki/remote/ACCOUNTS.md): sign in
 * with a passkey to see your PCs on any phone and connect without a code.
 * The PC screen (tap the PC at the top of the list) lists this phone's PCs
 * and the account's, with whether each is online. While signed in, a PC this
 * phone pairs or connects to is saved to the account by itself.
 *
 * Staying paired (2026-10-10, Arthur: "the paired phone should be good to go
 * foreeever"): storage that cannot be read shows a retry screen, never the
 * pairing screen; storage held by an older Apaki tab says "Close the other
 * Apaki tab" and carries on once it can; the page asks the browser to keep
 * its storage (persist) once paired; a PC that says it does not know this
 * phone gets an explanation and slow retries, not a forgotten pairing; only
 * Forget (the person) deletes a PC. On an iPhone, Safari first suggests the
 * Home Screen app (it keeps its own storage, so pair from there), and the
 * Home Screen app with nothing paired says why and offers the account.
 */

import { createDeviceIdentity, parsePairingUrl } from './protocol.js';
import { Link } from './link.js';
import { installShim } from './shim.js';
import * as store from './store.js';
import * as account from './account.js';
import { canScan, scanCode } from './scan.js';
import { MARK_SVG } from './mark.js';
import { effortGrid } from './menu.js';
import { haptic, initNative, isIos, isIosSafari, isStandalone, setPc, showChat, showList } from './native.js';

window.apakiShell = 'web';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''; };
const WORKSPACE = 'apaki.workspace.v1';
const workspaceKey = (roomId) => `${WORKSPACE}@${roomId}`;

const S = { link: null, pc: null, appStarted: false, scanAbort: null, sas: null, overlay: false, acct: null, creating: false, busy: '', note: null, presence: new Map() };

/** When a pairing runs out, in words for the PC list: "expires in 6 days", "expired"; '' for never. */
function expiryText(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return 'pairing expired';
  if (s < 86400 * 1.5) return `expires in ${Math.max(1, Math.round(s / 3600))} h`;
  return `expires in ${Math.round(s / 86400)} days`;
}

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

/** One PC row: its name, where it came from, whether it is online now, Connect and Forget. */
function pcRow(pc) {
  const online = S.presence.get(pc.roomId);
  const here = S.pc?.roomId === pc.roomId && S.link?.state === 'open';
  const from = pc.via === 'account' ? 'from your account' : `paired ${esc(day(pc.pairedAt))}`;
  const state = here ? '<span class="pp-on">Connected</span>' : online === true ? '<span class="pp-on">Online</span>' : online === false ? '<span class="pp-off">Offline</span>' : '';
  const saved = S.acct?.rooms?.includes(pc.roomId) && pc.via !== 'account' ? ' · in your account' : '';
  return `<li data-room="${esc(pc.roomId)}"><div class="pp-t"><b>${esc(pc.pcName || 'PC')}</b><small>${state}${state ? ' · ' : ''}${from}${saved}${expiryText(pc.expiresAt) ? ` · ${esc(expiryText(pc.expiresAt))}` : ''}</small></div>${here ? '<button data-k="back">Open</button>' : `<button data-k="use" data-id="${esc(pc.roomId)}">Connect</button>`}<button class="quiet" data-k="forget" data-id="${esc(pc.roomId)}" aria-label="Forget ${esc(pc.pcName || 'this PC')}">${pc.via === 'account' ? 'Remove' : 'Forget'}</button></li>`;
}

/** The Apaki account part of the PC screen: sign in or create, or who is signed in and what to do. */
function accountBlock() {
  const note = S.note ? `<p class="${S.note.ok ? 'pair-note' : 'pair-err'}">${esc(S.note.text)}</p>` : '';
  const busy = S.busy ? ' disabled' : '';
  if (!S.acct) {
    if (S.creating) {
      return `<div class="pair-sec">New Apaki account</div>
        <p>A passkey on this phone signs you in, with Face ID or a fingerprint. No password, no email.</p>
        <div class="pp-row"><input id="acctName" maxlength="48" placeholder="Name, e.g. Arthur" autocomplete="nickname" spellcheck="false"><button data-k="create-go"${busy}>${S.busy === 'create' ? 'Making…' : 'Create'}</button></div>
        ${note}<button class="pair-btn quiet" data-k="create-cancel">Cancel</button>`;
    }
    return `<div class="pair-sec">Apaki account</div>
      <p>Sign in with a passkey to see your PCs on any phone and connect without a code. Only your passkey can unlock them; apaki.myrlin.io cannot.</p>
      <button class="pair-btn" data-k="signin"${busy}>${S.busy === 'signin' ? 'Signing in…' : 'Sign in with a passkey'}</button>
      <button class="pair-btn quiet" data-k="create"${busy}>Create an account</button>${note}`;
  }
  const here = S.link?.state === 'open' && S.pc;
  const canSave = here && !S.acct.rooms?.includes(S.pc.roomId) && S.pc.via !== 'account';
  return `<div class="pair-sec">Apaki account</div>
    <div class="acct-row"><div class="pp-t"><b>${esc(S.acct.name)}</b><small>Signed in with a passkey · ${S.acct.rooms?.length || 0} PC${S.acct.rooms?.length === 1 ? '' : 's'} saved</small></div></div>
    ${S.acct.sessionEnded ? `<p class="pair-note">Your sign-in ended (they last 30 days). The PCs on this phone still connect; sign in again to keep them in step with your account.</p><button class="pair-btn" data-k="signin"${busy}>${S.busy === 'signin' ? 'Signing in…' : 'Sign in again'}</button>` : ''}
    ${canSave ? `<button class="pair-btn" data-k="link"${busy}>${S.busy === 'link' ? 'Saving…' : `Save ${esc(S.link.pcName)} to your account`}</button>` : ''}
    ${note}
    <details class="pair-paste acct-more"><summary>Account settings</summary>
      <div class="acct-acts">
        <button data-k="passkey"${busy}>Add a passkey</button>
        <button data-k="signout">Sign out on this phone</button>
        <button data-k="signout-all">Sign out everywhere</button>
        <button class="danger" data-k="delete">${S.confirm === 'delete' ? 'Tap again to delete' : 'Delete account'}</button>
      </div>
      <p class="pair-note">Add a passkey for a phone outside this phone's keychain (an Android phone with an iPhone, say). Signing out leaves your PCs as they are; remove the account on a PC in its Phone sheet.</p>
    </details>`;
}

function welcome(pcs, error = '') {
  const list = pcs.length
    ? `<div class="pair-sec">${S.acct ? 'Your PCs' : 'Paired PCs'}</div><ul class="pair-pcs">${pcs.map(pcRow).join('')}</ul>`
    : '';
  S.lastPcs = pcs;
  show(`<div class="pair-kicker">${S.acct ? `Signed in as ${esc(S.acct.name)}` : 'Phone'}</div>
    <h1>${pcs.length ? 'Your PCs' : 'Connect to your PC'}</h1>
    ${error ? `<p class="pair-err">${esc(error)}</p>` : ''}
    ${homeScreenBlock(pcs)}
    ${list}
    ${accountBlock()}
    ${pcs.length ? '<div class="pair-sec">Pair another PC</div>' : ''}
    <ol class="pair-steps">
      <li><span>Open Myrlin Apaki on your PC.</span></li>
      <li><span>Click <b>Phone</b> at the bottom of its sidebar, then <b>Pair a phone</b>.</span></li>
      <li><span>Point this phone's camera at the code and open the link.</span></li>
    </ol>
    ${canScan() ? '<button class="pair-btn" data-k="scan">Scan the code here</button>' : ''}
    <details class="pair-paste"><summary>Paste a pairing link instead</summary><div class="pp-row"><input id="pasteLink" inputmode="url" placeholder="https://…#p=…" autocomplete="off" spellcheck="false"><button data-k="paste">Pair</button></div></details>
    ${S.appStarted && S.pc ? '<button class="pair-btn quiet" data-k="back">Back to Apaki</button>' : ''}`);
  $('pairScreen').classList.toggle('sheet-mode', Boolean(S.appStarted));
  checkPresence(pcs);
}

/**
 * iPhone, nothing paired yet. A Home Screen app keeps its own storage, apart
 * from Safari's (WebKit does this on purpose), so a pairing made in Safari is
 * not in the app: in Safari, add the app first and pair from it; in the app,
 * say why it is empty and point at the account, which brings PCs over.
 */
function homeScreenBlock(pcs) {
  if (pcs.length || !isIos()) return '';
  if (isStandalone()) return '<p class="pair-note">This Home Screen app keeps its own storage, apart from Safari, so PCs paired in Safari are not here. Pair it with a new code below, or sign in to your Apaki account to bring your PCs over.</p>';
  if (isIosSafari()) return '<div class="pair-sec">First, add Apaki to your Home Screen</div><p>Tap Share, then <b>Add to Home Screen</b>, open Apaki from there and pair in it. The Home Screen app keeps its own storage, so a pairing made here in Safari would not be in it.</p>';
  return '';
}

/** Asks the relay which PCs are online and fills the rows in (only for the relay on this page's own address). */
async function checkPresence(pcs) {
  const seq = (S.presenceSeq = (S.presenceSeq || 0) + 1);
  // The relay counts these toward a per-minute limit: ask about each PC at most every 30 s.
  S.presenceAt ||= new Map();
  await Promise.all(pcs.map(async (pc) => {
    if (Date.now() - (S.presenceAt.get(pc.roomId) || 0) < 30_000) return;
    S.presenceAt.set(pc.roomId, Date.now());
    const on = await account.presence(pc);
    if (on == null || seq !== S.presenceSeq) return;
    if (S.presence.get(pc.roomId) === on) return;
    S.presence.set(pc.roomId, on);
    const li = $('pairBody').querySelector(`li[data-room="${CSS.escape(pc.roomId)}"]`);
    if (li) li.outerHTML = pcRow(pc);
  }));
  $('pairBody').querySelectorAll('li[data-room] [data-k]').forEach((b) => { b.onclick = () => act(b.dataset.k, b.dataset.id, b); });
}

/** A short line at the top of the screen that goes away by itself (saved to the account, signed in, ...). */
function toast(text, ok = true) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = text;
  t.classList.toggle('bad', !ok);
  t.classList.remove('out');
  t.hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => { t.hidden = true; }, 200); }, 3200);
}

/* ---------- the Apaki account ---------- */

async function accountAct(k) {
  const say = (text, ok = true) => { S.note = { text, ok }; };
  const run = async (what, fn) => {
    S.busy = what;
    S.note = null;
    await goHome();
    try { await fn(); } catch (e) { say(e.message || String(e), false); haptic('medium'); }
    S.busy = '';
    S.acct = await store.getAccount().catch(() => null);
    await goHome();
  };
  if (k === 'create') { S.creating = true; S.note = null; await goHome(); $('acctName')?.focus(); return; }
  if (k === 'create-cancel') { S.creating = false; S.note = null; return goHome(); }
  if (k === 'create-go') {
    const name = $('acctName')?.value || '';
    return run('create', async () => {
      await account.create(name);
      S.creating = false;
      haptic('medium');
      toast('Account made. Your passkey unlocks it on any phone.');
      await linkCurrent({ quiet: false });
    });
  }
  if (k === 'signin') {
    return run('signin', async () => {
      const r = await account.signIn();
      haptic('medium');
      toast(`Signed in as ${r.account.name}${r.pcs.length ? `: ${r.pcs.length} PC${r.pcs.length === 1 ? '' : 's'}` : ''}.`);
      await linkCurrent({ quiet: true });
    });
  }
  if (k === 'link') return run('link', () => linkCurrent({ quiet: false }));
  if (k === 'passkey') return run('passkey', async () => { await account.addPasskey(); say('Passkey added. It unlocks the account too.'); });
  if (k === 'signout') { await account.signOut(); S.acct = null; toast('Signed out on this phone.'); return goHome(); }
  if (k === 'signout-all') return run('signout', async () => { await account.signOutEverywhere(); toast('Signed out on every phone.'); });
  if (k === 'delete') {
    if (S.confirm !== 'delete') { S.confirm = 'delete'; await goHome(); setTimeout(() => { if (S.confirm === 'delete') { S.confirm = null; goHome(); } }, 4000); return; }
    S.confirm = null;
    return run('delete', async () => { await account.remove(); toast('Account deleted. Remove it on each PC in its Phone sheet.'); });
  }
}

/**
 * Saves the PC this phone is connected to in the account (it accepts the
 * account's device; account.link). Quiet: only when it is needed, without
 * a word when it cannot be done now (not connected, an older PC).
 */
async function linkCurrent({ quiet }) {
  const acct = await store.getAccount().catch(() => null);
  // A sign-in that ran out cannot update the vault: link nothing until the person signs in again.
  if (acct?.sessionEnded) { if (!quiet) toast('Your sign-in ended. Sign in again first.', false); return; }
  if (!acct || !S.link || S.link.state !== 'open' || !S.pc) { if (!quiet && acct) toast('Connect to a PC, then save it to your account.', false); return; }
  if (S.pc.via === 'account' || S.link.hello?.asAccount || acct.rooms?.includes(S.pc.roomId)) return;
  if (!S.link.supports('account')) { if (!quiet) toast(`${S.link.pcName} runs an older Apaki. Update it there first.`, false); return; }
  try {
    await account.link(S.link);
    toast(`${S.link.pcName} is saved to your account.`);
  } catch (e) {
    if (!quiet || e.code !== 'already') toast(e.message, false);
  }
  S.acct = await store.getAccount().catch(() => null);
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
  // The lifetime chosen on the PC at Allow ran out (the PC said so, encrypted; or this phone's own expiry passed).
  lapsed: ['This pairing expired', 'This phone was allowed for a limited time on the PC, and that time is up. To use it again, pair with a new code.'],
};

function failedScreen(code, message) {
  let [title, text] = FAILED[code] || ['Could not connect', ''];
  const removed = code === 'removed';
  // Reached through the account: the PC removed the account, not this phone.
  if (removed && S.pc?.via === 'account') [title, text] = ['This PC left your account', 'The PC removed your Apaki account, so no phone signed in to it reaches that PC now. Pair with its code to use it again.'];
  show(`<div class="pair-kicker">Not connected</div><h1>${esc(title)}</h1>
    <p>${esc(text || message || code)}</p>
    ${(removed || code === 'lapsed') && S.pc ? `<button class="pair-btn" data-k="forget" data-id="${esc(S.pc.roomId)}">Forget this PC</button>` : '<button class="pair-btn" data-k="home">Start over</button>'}`);
}

/**
 * The PC said it does not know this phone. That alert is not encrypted, and
 * a PC can say it for a while for other reasons, so the pairing stays and
 * the link tries again by itself (link.js unknown); forgetting is the
 * person's call.
 */
function unknownScreen(info = {}) {
  const name = S.link?.pcName || S.pc?.pcName || 'your PC';
  const mins = Math.max(1, Math.round((info.retryInMs || 0) / 60_000));
  show(`<div class="pair-kicker">Not recognized</div><h1>${esc(name)} does not know this phone right now</h1>
    <p>It may have been removed in the PC's Phone sheet; then pair it again with a new code. If it was not, this page reconnects by itself. It tries again in ${mins} min, and whenever you come back to it.</p>
    <p class="pair-note">This phone keeps its pairing until you forget it.</p>
    <button class="pair-btn" data-k="retry-link">Try again now</button>
    ${S.pc ? `<button class="pair-btn quiet" data-k="forget" data-id="${esc(S.pc.roomId)}">Forget this PC</button>` : ''}
    <button class="pair-btn quiet" data-k="pcs">Other PCs</button>`);
}

/** This phone's storage could not be read: say so and offer a retry. Never the pairing screen, since nothing is known to be lost. */
function storageScreen(e) {
  show(`<div class="pair-kicker">Phone storage</div><h1>Could not read this phone's saved PCs</h1>
    <p>${esc(e?.message || String(e))}</p>
    <p class="pair-note">Apaki only forgets a PC when you tap Forget. Try again; if it keeps happening, close other Apaki tabs and reload.</p>
    <button class="pair-btn" data-k="reload">Try again</button>
    ${S.appStarted && S.pc ? '<button class="pair-btn quiet" data-k="back">Back to Apaki</button>' : ''}`);
}

/** Storage is held by an older Apaki page in another tab (store.js onWait): what to do. The page carries on once it can. */
function waitScreen() {
  show(`<div class="pair-kicker">One moment</div><h1>Close the other Apaki tab</h1>${grid()}
    <p>An older Apaki page is open in another tab of this browser and is holding this phone's storage. Close that tab, or reload it, and this page carries on by itself.</p>
    <p class="pair-note">Your paired PCs are safe while it waits.</p>`);
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
  if (k === 'use') { haptic(); return switchTo(id); }
  if (['create', 'create-cancel', 'create-go', 'signin', 'link', 'passkey', 'signout', 'signout-all', 'delete'].includes(k)) return accountAct(k);
  if (k === 'forget') {
    el.disabled = true;
    const rec = await store.getPc(id).catch(() => null);
    // A PC that came from the account leaves the account (and, when connected, the PC drops the account's device).
    if (rec?.via === 'account') {
      try {
        const r = await account.unlink(id, S.pc?.roomId === id ? S.link : null);
        toast(r.offPc ? `${rec.pcName} left your account.` : `${rec.pcName} left your account. On the PC, remove the account in its Phone sheet too.`);
      } catch (e) { toast(e.message, false); el.disabled = false; return; }
    }
    await store.forgetPc(id).catch(() => {});
    localStorage.removeItem(workspaceKey(id));
    if (S.pc?.roomId === id) { S.link?.stop(); S.link = null; S.pc = null; if (S.appStarted) { location.replace(location.pathname); return; } }
    return goHome();
  }
  if (k === 'pcs') { S.overlay = true; return goHome(); }
  if (k === 'back') return hideScreen();
  if (k === 'reload') { location.reload(); return; }
  if (k === 'retry-link') { haptic(); S.link?.wake(); return; }
  if (k === 'home') { if (S.appStarted) { location.replace(location.pathname); return; } return goHome(); }
}

async function goHome(error = '') {
  S.acct = await store.getAccount().catch(() => null);
  let pcs;
  try {
    pcs = await store.listPcs();
  } catch (e) {
    // Could not read is not "nothing saved": never show the pairing screen for it.
    storageScreen(e);
    return;
  }
  welcome(pcs, error);
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
      S.pc = rec;
      S.sas = null;
      // Saved before the channel opens; a storage hiccup is retried, and never stops the pairing itself.
      S.unsaved = !(await savePairing(rec));
      // Paired: ask the browser to keep this site's storage (no eviction when space runs low).
      askPersist();
    },
    open: () => {
      if (S.pc) {
        if (S.unsaved) savePairing(S.pc, { quiet: true }).then((ok) => { S.unsaved = !ok; });
        else store.touchPc(S.pc.roomId).catch(() => {});
      }
      askPersist();
      startApp();
    },
    // Signed in: a PC this phone reaches with its own pairing joins the account by itself.
    hello: () => { renderPcLine(); linkCurrent({ quiet: true }).catch(() => {}); },
    // The PC said when this pairing runs out (or that it never does): kept with the PC, shown in the PC list.
    lifetime: (expiresAt) => {
      if (!S.pc) return;
      S.pc = { ...S.pc, expiresAt };
      store.updatePc(S.pc.roomId, { expiresAt }).catch(() => {});
    },
    // "Unknown device" (link.js keeps the pairing and retries): explain, unless the app or the PC list is up.
    unknown: (info) => { if (!S.appStarted && !S.overlay) unknownScreen(info); },
    fatal: (code, message) => failedScreen(code, message),
  };
}

/**
 * Saves a new pairing, trying again a few times. False when storage would
 * not take it: the channel works anyway, and open tries again.
 */
async function savePairing(rec, { quiet = false } = {}) {
  let err = null;
  for (const wait of [0, 400, 1500]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { await store.savePc(rec); return true; } catch (e) { err = e; }
  }
  if (!quiet) toast(`This phone could not save the pairing (${err?.message || 'storage error'}). It works while this page is open, and Apaki tries to save it again when it reconnects.`, false);
  return false;
}

/** Asks once per page for persistent storage (store.persist). */
function askPersist() {
  if (S.persistAsked) return;
  S.persistAsked = true;
  store.persist().then((ok) => { S.persisted = ok; }).catch(() => {});
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

async function connect(pc) {
  S.pc = pc;
  // The name goes with an account connection (link.js sends it as { t: 'via' }), so the PC shows which phone it is.
  S.link = new Link({ device: pc.device, pairing: pc.pairing, name: pc.via === 'account' ? await deviceName() : '', expiresAt: pc.expiresAt || null, on: linkHandlers() });
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
  // The phone app (native.js): a workspace that had a conversation open starts in it, one Back from the list.
  const saved = restored ? localStorage.getItem(WORKSPACE) || '' : '';
  initNative({ onPcTap: () => { S.overlay = true; goHome(); }, startInChat: /"sessionId":"[^"]+"/.test(saved) });
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

/**
 * The sessions list. Since 2026-10-10 the phone is a stack (native.js): the
 * list is home and a conversation slides over it, so "open the drawer" means
 * going back to the list and "close it" means the conversation.
 */
function setDrawer(open) {
  if (document.body.classList.contains('native')) { if (open) showList(); else showChat(); return; }
  document.body.classList.toggle('drawer-open', open);
  $('drawerBtn')?.setAttribute('aria-expanded', String(open));
}

function wireDrawer() {
  $('drawerBtn')?.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
  $('drawerScrim')?.addEventListener('click', () => setDrawer(false));
  $('sessions')?.addEventListener('click', (e) => { if (e.target.closest('li[data-id]')) setDrawer(false); });
  $('new')?.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.body.classList.contains('native')) setDrawer(false); });
  // A swipe to the left closes the drawer.
  const rail = document.querySelector('.rail');
  let x0 = null;
  rail?.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  // (The stack has no drawer to swipe shut: there a left swipe on the list does nothing.)
  rail?.addEventListener('touchend', (e) => { if (!document.body.classList.contains('native') && x0 !== null && e.changedTouches[0].clientX - x0 < -60) setDrawer(false); x0 = null; }, { passive: true });
}

const BAR_COPY = {
  connecting: (l) => ['Reconnecting', `to ${l.pcName}…`],
  handshake: (l) => ['Reconnecting', `to ${l.pcName}…`],
  waiting: (l) => ['Offline', `${l.pcName} is not reachable. Apaki has to be open there.`],
  offline: (l, info) => ['No connection', `Trying again in ${Math.max(1, Math.round((info.retryInMs || 0) / 1000))} s. Tap to retry now.`],
  unknown: (l) => ['Not recognized', `${l.pcName} does not know this phone right now. This phone keeps its pairing; tap to try again.`],
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
  if (S.link) setPc(S.link.pcName, S.link.state);
  const line = $('pcLine');
  if (!line || !S.link) return;
  const word = S.link.state === 'open' ? 'Connected' : S.link.state === 'failed' ? 'Not connected' : S.link.state === 'unknown' ? 'Not recognized' : 'Reconnecting';
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
  // Storage held by an older Apaki page in another tab: store.js waits for it; say what to do meanwhile.
  store.onWait((state) => {
    if (state !== 'blocked') return;
    if (S.link || S.appStarted) toast('Close the other Apaki tab: it is holding this phone\'s storage.', false);
    else waitScreen();
  });
  // Signed in: take in PCs other phones saved to the account (quietly; offline is fine).
  const synced = account.refresh().catch(() => null);
  if (offer) { await pair(offer); return; }
  let pcs;
  try {
    pcs = await store.listPcs();
  } catch (e) {
    // Could not read is not "nothing saved" (2026-10-10): a retry screen, never the pairing screen.
    storageScreen(e);
    return;
  }
  if (!pcs.length && (await store.getAccount().catch(() => null))) { await synced; pcs = await store.listPcs().catch(() => pcs); }
  const want = new URLSearchParams(location.search).get('pc');
  const pc = pcs.find((p) => p.roomId === want) || pcs[0];
  if (pc && !error) { connect(pc); return; }
  S.acct = await store.getAccount().catch(() => null);
  welcome(pcs, error);
}

// For apaki/scripts/cdp-remote.mjs: the connection's state, and a way to drop it (it reconnects by itself).
window.__apakiLink = { state: () => S.link?.state || null, pcName: () => S.link?.pcName || null, drop: () => S.link?.restart() };

main().catch(async (e) => {
  console.error(e);
  if (store.isStorageError(e)) { storageScreen(e); return; }
  // Whatever went wrong, list the saved PCs when they can be read: never an empty "Connect to your PC" by mistake.
  let pcs = [];
  try { pcs = await store.listPcs(); } catch (e2) { storageScreen(e2); return; }
  welcome(pcs, `Apaki could not start here: ${e.message}`);
});
