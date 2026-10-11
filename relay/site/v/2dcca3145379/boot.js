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
 * and the account's, with whether each is online.
 *
 * Private and Connected (2026-10-10, apaki/SECURITY.md 4.4 item 6): the PC
 * decides, and says which in hello (mode). A PC in Private mode is never
 * offered to the account and never asked about: its account section explains
 * Private mode (signing in stays reachable, for other PCs). A PC in
 * Connected mode asks its person before it takes an account (hello feature
 * 'account-ask'); while signed in, this phone asks each such PC once by
 * itself, and "Save to your account" asks again. Online state (presence) is
 * asked only while signed in, and only for the account's PCs that are not
 * Private, so without an account the relay never hears this phone's list.
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
 *
 * Phone keys and enrollment (2026-10-11, apaki/remote/ENROLL.md, version 2):
 * this phone has one key of its own (store.getPhoneKey, phonekey.js) that every
 * account connection signs, so each PC can ask, allow or block this phone and
 * not the whole account. Right after a scan, a PC that offers 'enroll' takes
 * the account at once: signed in, quietly (a toast says so); not signed in, a
 * sheet offers "Next time, sign in with Face ID" and then does the same. A
 * connection a PC is still deciding about shows "Waiting for permission"; a
 * blocked one says so and is not tried again through the account (a flag per
 * PC, until a connection works). The home screen connects by itself when
 * signed in with exactly one PC online and nothing else to choose, unless the
 * person just disconnected or came back from a blocked close.
 *
 * Polish (2026-10-11): those screens share one look with the rest of the
 * phone: a small state tile above the title (a passkey, a clock, a block),
 * "Allow this phone on <PC>" with the phone, the live grid and the PC in one
 * line and the name the PC shows for this phone, the enrollment sheet with one
 * primary button and "Not now" as text, and the PC list as cards with a PC
 * glyph that lights while that PC is online (web.css, "polished").
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
import { autoConnectChoice, clearBlocked, enrollPlan, isBlocked, markBlocked, markHome, rememberNotNow, takeHome, wasNotNow } from './phonekey.js';

window.apakiShell = 'web';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''; };
const WORKSPACE = 'apaki.workspace.v1';
const workspaceKey = (roomId) => `${WORKSPACE}@${roomId}`;
/** Set once this phone asked a PC (by itself) to take its account, so a Deny on the PC is not asked again on every connect. */
const linkAskedKey = (roomId) => `apaki.linkAsked@${roomId}`;
/** What this phone may make Claude do on the PC (hello cap), in the PC list; Full says nothing. */
const CAP_WORDS = { noshell: 'No shell', chat: 'Chat only' };

const S = { link: null, pc: null, appStarted: false, scanAbort: null, sas: null, overlay: false, acct: null, creating: false, busy: '', note: null, presence: new Map(), noAuto: false, enrollOffer: false, appReady: false, afterApp: [], homeError: false };

/** localStorage and sessionStorage, or null where this browser will not hand them out (phonekey.js then remembers nothing). */
const lstore = () => { try { return window.localStorage; } catch { return null; } };
const sstore = () => { try { return window.sessionStorage; } catch { return null; } };

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

/*
 * Glyphs for the phone's state screens (2026-10-11 polish): a small tile above
 * the title says at a glance what kind of screen this is (a passkey to make,
 * a phone waiting on its PC, a request that ran out, a block), in the
 * screen's colour, never as a dot. Decorative: the words carry the meaning.
 */
const GLYPHS = {
  passkey: '<svg viewBox="0 0 24 24"><path d="M7.5 3.8H6A2.2 2.2 0 0 0 3.8 6v1.5M16.5 3.8H18A2.2 2.2 0 0 1 20.2 6v1.5M7.5 20.2H6A2.2 2.2 0 0 1 3.8 18v-1.5M16.5 20.2H18a2.2 2.2 0 0 0 2.2-2.2v-1.5"/><path d="M9 9.2v1.3M15 9.2v1.3M12 9.2v3.6h-1M9.4 15.6a4 4 0 0 0 5.2 0"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="6.6" y="2.8" width="10.8" height="18.4" rx="2.6"/><path d="M10.6 18h2.8"/></svg>',
  pc: '<svg viewBox="0 0 24 24"><rect x="2.8" y="4" width="18.4" height="12.2" rx="2"/><path d="M9 20h6M12 16.2V20"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 2"/></svg>',
  blocked: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M6.1 6.1l11.8 11.8"/></svg>',
};
const mark = (kind, tone = '') => `<div class="state-mark${tone ? ` tone-${tone}` : ''}" aria-hidden="true">${GLYPHS[kind]}</div>`;
/** The phone, Apaki's live grid and the PC in one line: this phone is waiting on that PC. */
const waitLine = () => `<div class="wait-line" aria-hidden="true"><span class="wl-ic">${GLYPHS.phone}</span>${effortGrid('max', { live: true })}<span class="wl-ic">${GLYPHS.pc}</span></div>`;

/** One PC row: its name, where it came from, whether it is online now, Connect and Forget. */
function pcRow(pc) {
  const online = S.presence.get(pc.roomId);
  const here = S.pc?.roomId === pc.roomId && S.link?.state === 'open';
  const from = pc.via === 'account' ? 'from your account' : `paired ${esc(day(pc.pairedAt))}`;
  // 2026-10-11: a PC that blocked this phone says so here until a connection to it works again (Connect tries once more).
  const blocked = !here && isBlocked(lstore(), pc.roomId);
  const state = here ? '<span class="pp-on">Connected</span>' : blocked ? '<span class="pp-off pp-blocked">Blocked on this PC</span>' : online === true ? '<span class="pp-on">Online</span>' : online === false ? '<span class="pp-off">Offline</span>' : '';
  const saved = S.acct?.rooms?.includes(pc.roomId) && pc.via !== 'account' ? ' · in your account' : '';
  // Private mode and this phone's access, as the PC said them (connected now, or the last time).
  const mode = (here ? S.link.hello?.mode : pc.mode) === 'private' ? ' · Private' : '';
  const capWord = here ? CAP_WORDS[S.link.hello?.cap] : '';
  // 2026-10-11: a PC glyph first, lit while the PC is online or connected (the words say which).
  const lit = here || (online === true && !blocked);
  return `<li data-room="${esc(pc.roomId)}" class="${here ? 'here' : blocked ? 'blocked' : online === true ? 'on' : online === false ? 'off' : ''}"><span class="pp-ic${lit ? ' lit' : ''}" aria-hidden="true">${GLYPHS.pc}</span><div class="pp-t"><b>${esc(pc.pcName || 'PC')}</b><small>${state}${state ? ' · ' : ''}${from}${saved}${mode}${capWord ? ` · ${esc(capWord)}` : ''}${expiryText(pc.expiresAt) ? ` · ${esc(expiryText(pc.expiresAt))}` : ''}</small></div>${here ? '<button data-k="back">Open</button><button class="quiet pp-disconnect" data-k="disconnect">Disconnect</button>' : `<button data-k="use" data-id="${esc(pc.roomId)}">Connect</button>`}<button class="quiet" data-k="forget" data-id="${esc(pc.roomId)}" aria-label="Forget ${esc(pc.pcName || 'this PC')}">${pc.via === 'account' ? 'Remove' : 'Forget'}</button></li>`;
}

/** The PC this phone is on now runs in Private mode (it said so in hello, or did the last time). */
function currentPcPrivate() {
  if (S.link?.hello?.mode) return S.link.hello.mode === 'private';
  return S.pc?.mode === 'private';
}

/** The PC this phone is on has phone keys (2026-10-11): it said so in hello, or did the last time. */
function currentPcPhoneKeys() {
  return Boolean(S.link?.supports('phone-key') || S.pc?.phoneKeys);
}

/** The Apaki account part of the PC screen: sign in or create, or who is signed in and what to do. */
function accountBlock() {
  const note = S.note ? `<p class="${S.note.ok ? 'pair-note' : 'pair-err'}">${esc(S.note.text)}</p>` : '';
  const busy = S.busy ? ' disabled' : '';
  // The PC this phone is on is in Private mode: accounts are not offered for it; signing in stays reachable (for other PCs).
  const priv = currentPcPrivate() && (S.link || S.pc);
  // 2026-10-11 (ENROLL.md): a PC with phone keys in Private mode does take an account, with an OK on the PC for each phone.
  const legacyPriv = priv && !currentPcPhoneKeys();
  const privNote = legacyPriv
    ? `<p class="pair-note">${esc(S.link?.pcName || S.pc?.pcName || 'This PC')} is in Private mode: it only accepts phones paired with its code, so an Apaki account cannot reach it, and this phone does not tell our servers about it. That is chosen on the PC, in its Phone sheet.</p>`
    : priv ? `<p class="pair-note">${esc(S.link?.pcName || S.pc?.pcName || 'This PC')} is in Private mode: it asks on the PC about each phone before it lets it in. It joins an account only right after you scan its code with this phone.</p>` : '';
  if (!S.acct && legacyPriv && !S.creating) {
    return `<div class="pair-sec">Apaki account</div>
      ${privNote}
      <details class="pair-paste acct-more"><summary>Sign in anyway, for PCs in Connected mode</summary>
        <button class="pair-btn" data-k="signin"${busy}>${S.busy === 'signin' ? 'Signing in…' : 'Sign in with a passkey'}</button>
        <button class="pair-btn quiet" data-k="create"${busy}>Create an account</button>
      </details>${note}`;
  }
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
  // Not for a Private PC; a Connected one asks its person first (the button says so).
  const canSave = here && !priv && !S.acct.rooms?.includes(S.pc.roomId) && S.pc.via !== 'account';
  return `<div class="pair-sec">Apaki account</div>
    <div class="acct-row"><span class="acct-ic" aria-hidden="true">${esc(String(S.acct.name || '?').trim().slice(0, 1).toUpperCase() || '?')}</span><div class="pp-t"><b>${esc(S.acct.name)}</b><small>Signed in with a passkey · ${S.acct.rooms?.length || 0} PC${S.acct.rooms?.length === 1 ? '' : 's'} saved</small></div></div>
    ${S.acct.sessionEnded ? `<p class="pair-note">Your sign-in ended (they last 30 days). The PCs on this phone still connect; sign in again to keep them in step with your account.</p><button class="pair-btn" data-k="signin"${busy}>${S.busy === 'signin' ? 'Signing in…' : 'Sign in again'}</button>` : ''}
    ${privNote}
    ${canSave ? `<button class="pair-btn" data-k="link"${busy}>${S.busy === 'link' ? `Waiting for ${esc(S.link.pcName)}…` : `Save ${esc(S.link.pcName)} to your account`}</button><p class="pair-note">${esc(S.link.pcName)} asks you on the PC before it takes the account.</p>` : ''}
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

/** "3 PCs · 2 online" (online only once the relay has said so for some), "Paired PCs" with no account. */
function pcsSummary(pcs) {
  if (!S.acct) return pcs.length === 1 ? 'Paired PC' : 'Paired PCs';
  const known = pcs.filter((pc) => S.presence.has(pc.roomId));
  const on = known.filter((pc) => S.presence.get(pc.roomId) === true).length;
  return `${pcs.length} PC${pcs.length === 1 ? '' : 's'}${known.length ? ` · ${on} online` : ''}`;
}

function welcome(pcs, error = '') {
  S.homeError = Boolean(error);
  // 2026-10-11: under the "Your PCs" title the section header counts them (and how many are online, once known).
  const list = pcs.length
    ? `<div class="pair-sec" id="pcsSec">${esc(pcsSummary(pcs))}</div><ul class="pair-pcs">${pcs.map(pcRow).join('')}</ul>`
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

/**
 * Asks the relay which PCs are online and fills the rows in (only for the
 * relay on this page's own address). Since 2026-10-10 (SECURITY.md 5 item
 * 13) only while signed in, and only about the account's PCs that are not
 * in Private mode: without an account this phone never tells the relay
 * which rooms it knows.
 */
async function checkPresence(pcs) {
  const seq = (S.presenceSeq = (S.presenceSeq || 0) + 1);
  if (!S.acct) return;
  // A Private PC with phone keys (version 2, ENROLL.md) takes an account too, so it is asked like any other.
  const ask = pcs.filter((pc) => (pc.via === 'account' || S.acct.rooms?.includes(pc.roomId)) && (pc.mode !== 'private' || pc.phoneKeys));
  // The relay counts these toward a per-minute limit: ask about each PC at most every 30 s.
  S.presenceAt ||= new Map();
  await Promise.all(ask.map(async (pc) => {
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
  const sec = $('pcsSec');
  if (sec && seq === S.presenceSeq) sec.textContent = pcsSummary(pcs);
  // 2026-10-11: one PC online and nothing else to choose connects by itself (only the newest check decides).
  if (seq === S.presenceSeq) maybeAutoConnect(pcs);
}

/**
 * The home screen, signed in, one PC online and every other PC known to be
 * offline: connect to it (ENROLL.md, "Home, signed in"). Not while the person
 * is choosing (the PC list opened over the app, a sign-in or a new account in
 * progress, a message on screen), is connected or connecting already, just
 * disconnected, or came back from a blocked close: S.noAuto. phonekey.js
 * autoConnectChoice is the rule; this only supplies the facts.
 */
function maybeAutoConnect(pcs) {
  if (S.busy || S.creating || S.homeError) return;
  const roomId = autoConnectChoice({
    signedIn: Boolean(S.acct), pcs, presence: S.presence, isBlocked: (id) => isBlocked(lstore(), id),
    noAuto: S.noAuto, overlay: S.overlay, linked: Boolean(S.link) || S.appStarted,
  });
  const pc = roomId && pcs.find((p) => p.roomId === roomId);
  if (!pc) return;
  // Once per visit: if it does not work out (the PC went offline meanwhile) the person chooses.
  S.noAuto = true;
  connect(pc);
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
 * account's device; account.link). Since 2026-10-10 the PC asks its person
 * first (Connected mode only; a Private PC refuses), so this waits for that
 * answer and says so. Quiet (by itself, after hello or sign-in): only for a
 * PC that asks first, at most once per PC on this phone, and without a word
 * when it cannot be done now.
 *
 * enroll (2026-10-11, ENROLL.md): right after a scan, a PC that offers 'enroll'
 * takes the account with no asking and in Private mode too, so none of the
 * Private, account-ask or once-per-PC rules below apply to it.
 */
async function linkCurrent({ quiet, enroll = false }) {
  const acct = await store.getAccount().catch(() => null);
  // A sign-in that ran out cannot update the vault: link nothing until the person signs in again.
  if (acct?.sessionEnded) { if (!quiet) toast('Your sign-in ended. Sign in again first.', false); return; }
  if (!acct || !S.link || S.link.state !== 'open' || !S.pc) { if (!quiet && acct) toast('Connect to a PC, then save it to your account.', false); return; }
  if (S.pc.via === 'account' || S.link.hello?.asAccount || acct.rooms?.includes(S.pc.roomId)) return;
  const enrolling = enroll && S.link.supports('enroll') && Boolean(S.link.phone);
  if (!enrolling && S.link.hello?.mode === 'private') { if (!quiet) toast(`${S.link.pcName} is in Private mode: it only accepts phones paired with its code.`, false); return; }
  if (!enrolling && !S.link.supports('account-ask')) { if (!quiet) toast(`${S.link.pcName} runs an older Apaki. Update it there first.`, false); return; }
  const roomId = S.pc.roomId;
  if (quiet && !enrolling) {
    // By itself only once per PC: after a Deny (or nobody at the PC) the button below asks again.
    try { if (localStorage.getItem(linkAskedKey(roomId))) return; localStorage.setItem(linkAskedKey(roomId), new Date().toISOString()); } catch { return; }
  }
  const pcName = S.link.pcName;
  try {
    await account.link(S.link, { enroll: enrolling, onPending: () => toast(`Allow it on ${pcName}: it asks before it takes your account.`) });
    toast(enrolling ? `${pcName} was added to your account.` : `${pcName} is saved to your account.`);
  } catch (e) {
    if (!quiet || e.code !== 'already') toast(e.message, false);
  }
  S.acct = await store.getAccount().catch(() => null);
  // The PC screen, when it is up, shows the account as it is now.
  if (S.overlay) goHome().catch(() => {});
}

/* enrollment after a scan (2026-10-11, ENROLL.md) */

/** Runs fn once the app's own code has started (the sheet must not be hidden by it). */
function afterApp(fn) {
  if (S.appReady) fn();
  else S.afterApp.push(fn);
}

/**
 * Right after a pairing completed and the PC's hello offered 'enroll':
 * signed in already, add the PC to the account at once (quiet, a toast says
 * so); not signed in, offer the sheet unless the person said "Not now" for
 * this PC. A PC that does not offer it, or a page with no phone key, keeps
 * the older way: a Connected PC is asked once by itself (linkCurrent).
 */
async function offerEnroll() {
  const link = S.link;
  if (!link || !S.pc) return;
  const acct = await store.getAccount().catch(() => null);
  const plan = enrollPlan({
    offered: link.supports('enroll'),
    hasPhoneKey: Boolean(link.phone),
    asAccount: Boolean(link.hello?.asAccount),
    signedIn: Boolean(acct && !acct.sessionEnded),
    inAccount: Boolean(acct?.rooms?.includes(S.pc.roomId)),
    notNow: wasNotNow(lstore(), S.pc.roomId),
  });
  if (plan === 'quiet') await linkCurrent({ quiet: true, enroll: true });
  else if (plan === 'sheet') {
    S.enrollName = (await deviceName()).slice(0, 48);
    afterApp(() => { if (S.link?.state === 'open' && !S.overlay) enrollSheet(); });
  } else if (link.hello?.mode === 'connected') linkCurrent({ quiet: true }).catch(() => {});
}

/**
 * "Next time, sign in with Face ID": offered once, right after a scan, to a
 * phone with no account signed in. The primary button makes the passkey (the
 * account.create path, PRF vault), the second signs in with a passkey the
 * person already has; either way the PC is then added to the account at
 * once. WebAuthn needs a tap: the buttons are it.
 */
function enrollSheet() {
  const link = S.link;
  if (!link) return;
  const busy = S.busy ? ' disabled' : '';
  const note = S.note ? `<p class="${S.note.ok ? 'pair-note' : 'pair-err'}">${esc(S.note.text)}</p>` : '';
  // 2026-10-11 polish: a passkey mark, then the promise, then what happens now on its own line.
  show(`<div class="enroll-sheet">
    ${mark('passkey', 'brand')}
    <div class="pair-kicker">Paired with ${esc(link.pcName)}</div>
    <h1>Next time, sign in with Face ID</h1>
    <p>Make an Apaki passkey on this phone. Any phone with that passkey then sees your PCs and connects without a code.</p>
    <p class="enroll-now"><b>${esc(link.pcName)}</b> joins the account now, with no second Allow on the PC.</p>
    <div class="pp-row"><input class="enroll-name" id="enrollName" maxlength="48" placeholder="Your name (optional)" value="${esc(S.enrollNameValue || '')}" autocomplete="nickname" spellcheck="false"></div>
    ${note}
    <button class="pair-btn enroll-create" data-k="enroll-create"${busy}>${S.busy === 'create' ? 'Making the passkey…' : 'Create a passkey'}</button>
    <button class="pair-btn quiet enroll-signin" data-k="enroll-signin"${busy}>${S.busy === 'signin' ? 'Signing in…' : 'I already have an Apaki passkey'}</button>
    <button class="pair-btn quiet enroll-later" data-k="enroll-later"${busy}>Not now</button>
  </div>`);
  $('pairScreen').classList.add('sheet-mode');
}

async function enrollAct(k) {
  if (S.busy) return;
  if (k === 'enroll-later') {
    if (S.pc) rememberNotNow(lstore(), S.pc.roomId);
    S.note = null;
    hideScreen();
    return;
  }
  const way = k === 'enroll-create' ? 'create' : 'signin';
  S.enrollNameValue = $('enrollName')?.value || S.enrollNameValue || '';
  S.busy = way;
  S.note = null;
  enrollSheet();
  try {
    if (way === 'create') await account.create(S.enrollNameValue.trim() || S.enrollName || 'Phone');
    else await account.signIn();
    haptic('medium');
    S.busy = '';
    S.acct = await store.getAccount().catch(() => null);
    // The PC adds this phone's account with no second Allow; linkCurrent says so, or says why not.
    await linkCurrent({ quiet: false, enroll: true });
    hideScreen();
  } catch (e) {
    S.busy = '';
    S.note = { text: e.message || String(e), ok: false };
    haptic('medium');
    enrollSheet();
  }
}

/** Drops the connection to this PC and shows the PC list, without connecting by itself (a fresh page when the app had started). */
function disconnect() {
  keepWorkspace();
  markHome(sstore());
  S.noAuto = true;
  S.link?.stop();
  if (S.appStarted) { location.replace(location.pathname); return; }
  S.link = null;
  S.pc = null;
  return goHome();
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
  // 2026-10-11 (ENROLL.md): the PC is deciding about this phone, or its person did not answer in time.
  // 2026-10-11 polish: the title asks for the Allow; this line says where and what happens then.
  'phone-wait': (l) => `${l.pcName} shows a request with Allow and Block in its Phone sheet. This page connects as soon as someone allows it.`,
  'phone-timeout': (l, info) => `${info.reason || `Nobody allowed this phone on ${l.pcName} in time.`} Ask again, then allow it in the PC's Phone sheet.`,
  waiting: () => 'Apaki has to be open on the PC, with phone access on. This page connects as soon as it is.',
  // info.budget (link.js budgetReason): the relay's day is spent, for everyone or for this address or room.
  offline: (l, info) => (info.budget ? `${info.budget} This page tries again in about ${Math.max(1, Math.round((info.retryInMs || 0) / 60_000))} min.` : info.full ? 'This PC has the most phones connected at once. Trying again soon.' : `No connection to the relay. Trying again in ${Math.max(1, Math.round((info.retryInMs || 0) / 1000))} s.`),
};

function connectingScreen(link, state, info = {}) {
  const copy = STATE_COPY[state];
  if (!copy) return;
  const kicker = state === 'waiting' ? 'Waiting for your PC' : state === 'phone-wait' ? 'Waiting for permission' : state === 'phone-timeout' ? 'Not allowed yet' : 'Connecting';
  // 2026-10-11 polish: the two permission states get their own title and picture; the others keep the PC's name.
  const title = state === 'phone-wait' ? `Allow this phone on ${link.pcName}` : state === 'phone-timeout' ? 'Not allowed in time' : link.pcName;
  const picture = state === 'phone-wait' ? waitLine() : state === 'phone-timeout' ? '' : grid();
  const name = state === 'phone-wait' && link.name ? `<p class="pair-note">It shows this phone as <b>${esc(link.name)}</b>.</p>` : '';
  show(`${state === 'phone-timeout' ? mark('clock') : ''}<div class="pair-kicker">${kicker}</div>
    <h1>${esc(title)}</h1>${picture}
    <p>${esc(copy(link, info))}</p>${name}
    ${state === 'phone-timeout' ? '<button class="pair-btn" data-k="retry-link">Ask again</button>' : ''}
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
  // The PC blocked this phone (ENROLL.md): its own words say who to ask; the text is the PC's close reason.
  'phone-blocked': ['This phone was blocked', ''],
};

function failedScreen(code, message) {
  let [title, text] = FAILED[code] || ['Could not connect', ''];
  const removed = code === 'removed';
  // Reached through the account: the PC removed the account, not this phone.
  if (removed && S.pc?.via === 'account') [title, text] = ['This PC left your account', 'The PC removed your Apaki account, so no phone signed in to it reaches that PC now. Pair with its code to use it again.'];
  // 2026-10-11 polish: a block shows its mark, and its only way on (Other PCs) is the quiet button, not a call to action.
  const blockedPhone = code === 'phone-blocked';
  show(`${blockedPhone ? mark('blocked', 'warn') : ''}<div class="pair-kicker">Not connected</div><h1>${esc(title)}</h1>
    <p>${esc(text || message || code)}</p>
    ${(removed || code === 'lapsed') && S.pc ? `<button class="pair-btn" data-k="forget" data-id="${esc(S.pc.roomId)}">Forget this PC</button>` : `<button class="pair-btn${blockedPhone ? ' quiet' : ''}" data-k="home">${blockedPhone ? 'Other PCs' : 'Start over'}</button>`}`);
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
  // Reached through the account: a PC in Private mode answers account phones this way too (it keeps the account, paused).
  const viaAccount = S.pc?.via === 'account';
  show(`<div class="pair-kicker">Not recognized</div><h1>${esc(name)} does not know this phone right now</h1>
    <p>It may have been removed in the PC's Phone sheet; then pair it again with a new code.${viaAccount ? ' Or the PC is in Private mode, where it only accepts phones paired with its code; your account works there again once the PC is back in Connected mode.' : ''} If it was not, this page reconnects by itself. It tries again in ${mins} min, and whenever you come back to it.</p>
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
  if (['enroll-create', 'enroll-signin', 'enroll-later'].includes(k)) return enrollAct(k);
  if (k === 'disconnect') return disconnect();
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
    clearBlocked(lstore(), id);
    if (S.pc?.roomId === id) { S.link?.stop(); S.link = null; S.pc = null; if (S.appStarted) { location.replace(location.pathname); return; } }
    return goHome();
  }
  if (k === 'pcs') { S.overlay = true; return goHome(); }
  if (k === 'back') return hideScreen();
  if (k === 'reload') { location.reload(); return; }
  if (k === 'retry-link') { haptic(); if (S.link?.state === 'phone-timeout') S.link.retryNow(); else S.link?.wake(); return; }
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
      // A pairing just completed: the PC's hello decides whether to enroll the account (offerEnroll), once.
      S.enrollOffer = true;
      // Saved before the channel opens; a storage hiccup is retried, and never stops the pairing itself.
      S.unsaved = !(await savePairing(rec));
      // Paired: ask the browser to keep this site's storage (no eviction when space runs low).
      askPersist();
    },
    open: () => {
      if (S.pc) {
        // A connection that works: the PC does not hold this phone blocked (any more).
        clearBlocked(lstore(), S.pc.roomId);
        if (S.unsaved) savePairing(S.pc, { quiet: true }).then((ok) => { S.unsaved = !ok; });
        else store.touchPc(S.pc.roomId).catch(() => {});
      }
      askPersist();
      startApp();
    },
    // The PC's mode is kept with it (presence and the account section read it while not connected). Signed in, a
    // Connected PC that asks first is asked once by itself (linkCurrent); a Private or older PC never is.
    hello: (m) => {
      renderPcLine();
      if (S.pc && (m?.mode === 'private' || m?.mode === 'connected') && S.pc.mode !== m.mode) {
        S.pc = { ...S.pc, mode: m.mode };
        store.updatePc(S.pc.roomId, { mode: m.mode }).catch(() => {});
      }
      // 2026-10-11: remember the PC has phone keys (a Private one is then a PC the account can reach, and presence asks about it).
      if (S.pc && S.link?.supports('phone-key') && !S.pc.phoneKeys) {
        S.pc = { ...S.pc, phoneKeys: true };
        store.updatePc(S.pc.roomId, { phoneKeys: true }).catch(() => {});
      }
      // Right after a scan, a PC that offers it takes the account at once (once per pairing); otherwise the older way.
      if (S.enrollOffer) {
        S.enrollOffer = false;
        if (S.link?.supports('enroll')) { offerEnroll().catch(() => {}); return; }
      }
      if (m?.mode === 'connected') linkCurrent({ quiet: true }).catch(() => {});
    },
    // The PC deciding about this phone (link.js phone): "Waiting for permission" is the link state; a toast when it lets us in.
    phone: (info) => {
      if (info.kind === 'wait') S.phoneWaited = true;
      else if (info.kind === 'ok' && S.phoneWaited) { S.phoneWaited = false; toast(`${S.link?.pcName || 'The PC'} let this phone in.`); }
    },
    // The PC switched between Private and Connected while this phone is connected.
    mode: (mode) => {
      if (S.pc) { S.pc = { ...S.pc, mode }; store.updatePc(S.pc.roomId, { mode }).catch(() => {}); }
      if (S.overlay) goHome().catch(() => {});
    },
    // The PC changed what this phone may make Claude do: the PC list says it, the panes hear it from the PC.
    cap: (cap) => {
      if (S.overlay) goHome().catch(() => {});
      toast(cap === 'full' ? `${S.link?.pcName || 'The PC'} gave this phone full access.` : `${S.link?.pcName || 'The PC'} set this phone to ${CAP_WORDS[cap] || cap}.`);
    },
    // The PC said when this pairing runs out (or that it never does): kept with the PC, shown in the PC list.
    lifetime: (expiresAt) => {
      if (!S.pc) return;
      S.pc = { ...S.pc, expiresAt };
      store.updatePc(S.pc.roomId, { expiresAt }).catch(() => {});
    },
    // "Unknown device" (link.js keeps the pairing and retries): explain, unless the app or the PC list is up.
    unknown: (info) => { if (!S.appStarted && !S.overlay) unknownScreen(info); },
    fatal: (code, message) => {
      // This PC blocked this phone: remember it (no reconnecting through the account on later starts, nothing connects by itself), and say so.
      if (code === 'phone-blocked') {
        if (S.pc) markBlocked(lstore(), S.pc.roomId);
        markHome(sstore());
        S.noAuto = true;
      }
      failedScreen(code, message);
    },
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
  // In the iOS app (apaki/mobile) the store makes the device key in the Secure Enclave; a browser makes a WebCrypto one.
  const device = await (store.newDevice ? store.newDevice() : createDeviceIdentity());
  // This phone's own key (ENROLL.md): signs the enroll proof after the scan; none if storage fails (the older ways then apply).
  const phone = await store.getPhoneKey().catch((e) => { console.warn('apaki: no phone key:', e?.message || e); return null; });
  S.link = new Link({ device, offer, name: await deviceName(), phone, on: linkHandlers() });
  installShim(S.link);
  S.link.start();
}

async function connect(pc) {
  S.pc = pc;
  // The name goes with an account connection (link.js sends it as { t: 'via' }), so the PC shows which phone it is.
  // An account connection signs its via with this phone's own key (ENROLL.md) and waits for the PC to decide about this phone.
  const phone = await store.getPhoneKey().catch((e) => { console.warn('apaki: no phone key:', e?.message || e); return null; });
  S.link = new Link({ device: pc.device, pairing: pc.pairing, name: pc.via === 'account' ? await deviceName() : '', expiresAt: pc.expiresAt || null, phone, viaAccount: pc.via === 'account', on: linkHandlers() });
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
  // Things that wait for the app to be up (the enroll sheet, which the app's start must not hide).
  S.appReady = true;
  for (const fn of S.afterApp.splice(0)) { try { fn(); } catch (e) { console.warn('apaki:', e); } }
}

/** This phone's name as the PC shows it: the model when the browser tells it, and the browser. */
async function deviceName() {
  const ua = navigator.userAgent || '';
  let model = '';
  try { model = String((await navigator.userAgentData?.getHighEntropyValues?.(['model']))?.model || '').trim(); } catch { /* not offered */ }
  const browser = /ApakiApp\//.test(ua) ? 'Apaki app' : /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
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
  offline: (l, info) => (info.budget ? ['Relay resting', `${info.budget} Tap to try now.`] : ['No connection', `Trying again in ${Math.max(1, Math.round((info.retryInMs || 0) / 1000))} s. Tap to retry now.`]),
  unknown: (l) => ['Not recognized', `${l.pcName} does not know this phone right now. This phone keeps its pairing; tap to try again.`],
  'phone-wait': (l) => ['Waiting for permission', `Allow this phone on ${l.pcName}.`],
  'phone-timeout': (l) => ['Not allowed in time', `Nobody allowed this phone on ${l.pcName}. Tap to ask again.`],
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
  $('linkBar')?.addEventListener('click', () => { if (S.link?.state === 'phone-timeout') S.link.retryNow(); else S.link?.wake(); });

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
  // One-shot (2026-10-11): the person disconnected, or came back from a blocked close. Show the PCs; connect to none by itself.
  const home = takeHome(sstore());
  if (home) S.noAuto = true;
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
  // A PC that blocked this phone is not the default (the person can still choose it); a PC asked for by address always is tried.
  const pc = pcs.find((p) => p.roomId === want) || pcs.find((p) => !isBlocked(lstore(), p.roomId));
  if (pc && !error && !home) { connect(pc); return; }
  S.acct = await store.getAccount().catch(() => null);
  welcome(pcs, error);
}

// For apaki/scripts/cdp-remote.mjs: the connection's state, and a way to drop it (it reconnects by itself).
// wake (2026-10-10): the iOS app (apaki/mobile) reconnects at once when it comes back to the foreground.
// supports and cap (2026-10-11): desktop.js asks whether the PC offers 'follow' and what this phone may do there.
window.__apakiLink = { state: () => S.link?.state || null, pcName: () => S.link?.pcName || null, drop: () => S.link?.restart(), wake: () => S.link?.wake(), supports: (f) => Boolean(S.link?.supports?.(f)), cap: () => S.link?.hello?.cap || 'full' };

main().catch(async (e) => {
  console.error(e);
  if (store.isStorageError(e)) { storageScreen(e); return; }
  // Whatever went wrong, list the saved PCs when they can be read: never an empty "Connect to your PC" by mistake.
  let pcs = [];
  try { pcs = await store.listPcs(); } catch (e2) { storageScreen(e2); return; }
  welcome(pcs, `Apaki could not start here: ${e.message}`);
});
