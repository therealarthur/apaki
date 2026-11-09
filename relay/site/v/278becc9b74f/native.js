/**
 * native.js: Apaki on a phone, as a native app (2026-10-10).
 *
 * Arthur: "make the phone experience feel incredibly native like an app -
 * eventually we will have an app". Layout chosen: a Messages-style stack.
 *
 *   Sessions (home)   a large title that folds into the bar as the list
 *                     scrolls, the PC at the top left (tap: switch PC,
 *                     account), compose at the top right, pull down to
 *                     read the list again, Glass and Settings at the bottom.
 *   Conversation      slides in from the right over the list (which moves a
 *                     little to the left, iOS style); Back, or a swipe from
 *                     the left edge that follows the finger, returns. The
 *                     browser's back (Android, Safari's own edge swipe) does
 *                     the same, through history.
 *   Menus and sheets  rise from the bottom with a grabber and close with a
 *                     swipe down (web.css styles them; this file adds the
 *                     drag).
 *   Haptics           a short tick where the platform has them
 *                     (navigator.vibrate on Android; iOS Safari has none).
 *   Install           a one-time hint to add Apaki to the Home Screen (iOS
 *                     Safari) or the browser's own install prompt (Android).
 *
 * The same page runs inside a native shell later (a Tauri mobile app): it
 * only needs a WebView, so nothing here assumes a browser chrome.
 *
 * initNative({ onPcTap }) once Apaki's window code is loaded; then
 * setPc(name, state), showChat(), showList(), haptic().
 *
 * 2026-10-11: the conversation screen pages through the tab's panes sideways
 * under a strip of tabs (pager.js), and the list shows what is open on the
 * desktop (desktop.js). The left edge of the conversation stays the swipe
 * back; with the pager on, only a swipe that starts on that edge (outside the
 * pages) goes back, so a sideways swipe on a page turns the page.
 *
 * 2026-10-12 (phone parity): a long press on a row of the list opens its session menu (app.js
 * phoneSessionMenu); the window's short lines (apaki:toast) and its "show the conversation" (apaki:chat)
 * after a menu opened or forked one are drawn here; the PC browser view (browserview.js) starts with the rest.
 */

import { initPager } from './pager.js';
import { initDesktop } from './desktop.js';
import { initBrowserView } from './browserview.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const N = { screen: 'list', pushed: false, ready: false };

/** A short tick, where the platform offers one. */
export function haptic(strength = 'light') {
  try { navigator.vibrate?.(strength === 'heavy' ? 16 : strength === 'medium' ? 11 : 7); } catch { /* none */ }
}

/* ---------- the stack ---------- */

/** The conversation screen: slides in over the list. */
export function showChat({ push = true } = {}) {
  if (N.screen === 'chat') return;
  N.screen = 'chat';
  body.classList.add('at-chat');
  body.classList.remove('at-list');
  if (push) { history.pushState({ apaki: 'chat' }, ''); N.pushed = true; }
  syncChatTitle();
}

/** Back to the sessions list (through history when the conversation was pushed, so Android's back stays in step). */
export function showList({ fromHistory = false } = {}) {
  if (N.screen === 'list') return;
  if (!fromHistory && N.pushed) { history.back(); return; }
  N.pushed = false;
  N.screen = 'list';
  body.classList.add('at-list');
  body.classList.remove('at-chat');
  // The keyboard goes down with the conversation.
  if (document.activeElement?.closest?.('.main')) document.activeElement.blur();
}

export const screen = () => N.screen;

function clearDrag() {
  const main = document.querySelector('.main');
  const rail = document.querySelector('.rail');
  for (const el of [main, rail]) if (el) { el.style.transform = ''; el.style.transition = ''; }
  body.classList.remove('swiping');
  document.documentElement.style.removeProperty('--back-p');
}

window.addEventListener('popstate', () => {
  clearDrag();
  if (N.screen === 'chat') { N.pushed = false; showList({ fromHistory: true }); }
});

/** A swipe from the left edge of the conversation that follows the finger; past a third of the width (or a flick) it goes back. */
function edgeSwipe() {
  const main = document.querySelector('.main');
  const rail = document.querySelector('.rail');
  if (!main || !rail) return;
  let s = null;
  document.addEventListener('touchstart', (e) => {
    if (N.screen !== 'chat' || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX > 26) return;
    // 2026-10-11: the pages own sideways swipes; the back swipe starts on the edge strip (.edge-catch) or the bars.
    if (body.classList.contains('paged') && e.target.closest?.('.stages')) return;
    s = { x0: t.clientX, y0: t.clientY, t0: performance.now(), dx: 0, axis: null };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x0;
    const dy = t.clientY - s.y0;
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.axis === 'y') { s = null; return; }
      body.classList.add('swiping');
    }
    s.dx = Math.max(0, dx);
    const p = Math.min(1, s.dx / window.innerWidth);
    main.style.transform = `translate3d(${s.dx}px, 0, 0)`;
    rail.style.transform = `translate3d(${(-28 + 28 * p).toFixed(2)}%, 0, 0)`;
    document.documentElement.style.setProperty('--back-p', p.toFixed(3));
  }, { passive: true });
  const end = () => {
    if (!s) return;
    const v = s.dx / Math.max(1, performance.now() - s.t0);
    const back = s.axis === 'x' && (s.dx > window.innerWidth * 0.33 || (v > 0.45 && s.dx > 40));
    s = null;
    const ms = reduced() ? 0 : 260;
    const ease = 'cubic-bezier(.32, .72, 0, 1)';
    main.style.transition = `transform ${ms}ms ${ease}`;
    rail.style.transition = `transform ${ms}ms ${ease}`;
    if (back) {
      main.style.transform = 'translate3d(100%, 0, 0)';
      rail.style.transform = 'translate3d(0, 0, 0)';
      haptic();
      setTimeout(() => { clearDrag(); showList(); }, ms);
    } else {
      main.style.transform = 'translate3d(0, 0, 0)';
      rail.style.transform = 'translate3d(-28%, 0, 0)';
      setTimeout(clearDrag, ms);
    }
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

/* ---------- the two bars ---------- */

const COMPOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.5 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-5.5"/><path d="M17.8 3.7a1.7 1.7 0 0 1 2.5 2.5L12.6 14l-3.3.8.8-3.3z"/></svg>';
const CHEVRON_LEFT = '<svg viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8"/></svg>';
const CHEVRON_DOWN = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>';

/** The sessions list's top: a compact bar (PC, title once scrolled, compose) and the large title. */
function listBars(onPcTap) {
  const rail = document.querySelector('.rail');
  if (!rail || rail.querySelector('.ios-nav')) return;
  const nav = document.createElement('div');
  nav.className = 'ios-nav';
  nav.innerHTML = `<button class="ios-pc" id="iosPc" aria-label="This PC, other PCs and your account"><span class="ios-pc-n">PC</span>${CHEVRON_DOWN}<span class="ios-pc-s"></span></button>
    <span class="ios-nav-t" aria-hidden="true">Sessions</span>
    <button class="ios-compose" id="iosCompose" aria-label="New conversation">${COMPOSE}</button>`;
  const large = document.createElement('h1');
  large.className = 'ios-large';
  large.textContent = 'Sessions';
  const ptr = document.createElement('div');
  ptr.className = 'ptr';
  ptr.innerHTML = '<span class="ptr-dot"></span><span class="ptr-t">Pull to refresh</span>';
  // One scroller under the bar, as in iOS: the large title and the search scroll up under it with the list.
  // The sections keep their ids (app.js finds them by id), only their parent changes.
  const scroll = document.createElement('div');
  scroll.className = 'ios-scroll';
  scroll.append(ptr, large, ...['.rail-find', '.rail-folders', '.rail-sessions'].map((q) => rail.querySelector(q)).filter(Boolean));
  rail.querySelector('.rail-foot')?.before(scroll);
  rail.prepend(nav);
  nav.querySelector('#iosPc').onclick = () => { haptic(); onPcTap?.(); };
  nav.querySelector('#iosCompose').onclick = () => {
    haptic();
    $('new')?.click();
    showChat();
    // A new conversation wants the keyboard; an existing one does not (Messages does the same).
    setTimeout(() => document.querySelector('.stage.on .pane.focused textarea, .stage.on .pane textarea')?.focus(), reduced() ? 0 : 320);
  };
  // The large title says what the list shows (Sessions, In terminals, a folder, Results).
  const title = $('sessionsTitle');
  const sync = () => {
    const t = title?.textContent || 'Sessions';
    large.textContent = t;
    nav.querySelector('.ios-nav-t').textContent = t;
  };
  if (title) new MutationObserver(sync).observe(title, { childList: true, characterData: true, subtree: true });
  sync();
  // The bar takes the title once the large one has scrolled under it.
  scroll.addEventListener('scroll', () => body.classList.toggle('list-scrolled', scroll.scrollTop > large.offsetTop + large.offsetHeight - 12), { passive: true });
  pullToRefresh(scroll, ptr);
}

/** The PC at the top left of the list: its name and whether it is connected. */
export function setPc(name, state) {
  const b = $('iosPc');
  if (!b) return;
  b.querySelector('.ios-pc-n').textContent = name || 'PC';
  const s = b.querySelector('.ios-pc-s');
  s.textContent = state === 'open' ? 'Connected' : state === 'failed' ? 'Not connected' : state === 'unknown' ? 'Not recognized' : 'Connecting';
  s.className = `ios-pc-s${state === 'open' ? ' ok' : state === 'failed' || state === 'unknown' ? ' bad' : ''}`;
}

/** The conversation's bar: a Back button that names the list. */
function chatBar() {
  const main = document.querySelector('.main');
  if (!main || main.querySelector('.nav-back')) return;
  const back = document.createElement('button');
  back.className = 'nav-back';
  back.setAttribute('aria-label', 'Back to sessions');
  back.innerHTML = `${CHEVRON_LEFT}<span>Sessions</span>`;
  back.onclick = () => { haptic(); showList(); };
  main.append(back);
  // The list dims a little under the conversation, and lights up as a swipe back reveals it.
  const dim = document.createElement('div');
  dim.className = 'stack-dim';
  main.before(dim);
}

function syncChatTitle() {
  const t = document.querySelector('.stage.on .pane.focused .pane-bar .title, .stage.on .pane .pane-bar .title');
  document.title = t?.textContent ? `${t.textContent} · Apaki` : 'Myrlin Apaki';
}

/* ---------- pull to refresh ---------- */

function pullToRefresh(scroller, ptr) {
  let y0 = null;
  let dy = 0;
  let armed = false;
  scroller.addEventListener('touchstart', (e) => { y0 = scroller.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; dy = 0; armed = false; }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (scroller.scrollTop > 0) { y0 = null; dy = 0; }
    const p = Math.min(1, dy / 80);
    ptr.style.setProperty('--pull', p.toFixed(3));
    ptr.classList.toggle('on', dy > 6);
    if (!armed && dy > 80) { armed = true; haptic(); ptr.querySelector('.ptr-t').textContent = 'Release to refresh'; }
    if (armed && dy <= 80) { armed = false; ptr.querySelector('.ptr-t').textContent = 'Pull to refresh'; }
  }, { passive: true });
  scroller.addEventListener('touchend', () => {
    if (armed) {
      ptr.classList.add('busy');
      ptr.querySelector('.ptr-t').textContent = 'Reading sessions…';
      $('refreshSessions')?.click();
      setTimeout(() => { ptr.classList.remove('busy', 'on'); ptr.style.removeProperty('--pull'); ptr.querySelector('.ptr-t').textContent = 'Pull to refresh'; }, 900);
    } else {
      ptr.classList.remove('on');
      ptr.style.removeProperty('--pull');
    }
    y0 = null;
    armed = false;
  }, { passive: true });
}

/* ---------- sheets: swipe down to close ---------- */

const SHEETS = '.menu, .sheet, .glass-panel, .task-panel, .bv, .pair-screen.sheet-mode .pair-card';

/** Closes a sheet the way its own code does: Escape for menus and panels, its close button for a sheet that has one. */
function dismiss(el) {
  // The PC screen over the running app: its own Back to Apaki.
  if (el.classList.contains('pair-card')) {
    const back = el.querySelector('[data-k=back]');
    if (back) { back.click(); return true; }
    return false;
  }
  if (el.classList.contains('sheet')) {
    const x = el.querySelector('[data-k=x], [data-k=done]');
    if (x) { x.click(); return true; }
    if (el.querySelector('.settings-host')) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; }
    return false; // a question or a plan waits for an answer: it does not close by swiping
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
}

function sheetSwipe() {
  let s = null;
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest?.(SHEETS);
    if (!el || e.touches.length !== 1) return;
    // Only from the top of a sheet that is scrolled to its top (or its grabber), so lists inside still scroll.
    const scroller = e.target.closest('.gp-body, .menu, .sheet, .tp-body, .bv-body') || el;
    const r = el.getBoundingClientRect();
    if (scroller.scrollTop > 0 && e.touches[0].clientY - r.top > 36) return;
    s = { el, y0: e.touches[0].clientY, t0: performance.now(), dy: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!s) return;
    s.dy = Math.max(0, e.touches[0].clientY - s.y0);
    if (s.dy > 4) { s.el.style.transition = 'none'; s.el.style.transform = `translate3d(0, ${s.dy}px, 0)`; }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!s) return;
    const { el, dy, t0 } = s;
    s = null;
    const v = dy / Math.max(1, performance.now() - t0);
    el.style.transition = `transform ${reduced() ? 0 : 220}ms cubic-bezier(.32, .72, 0, 1)`;
    if ((dy > 110 || (v > 0.5 && dy > 40)) && dismiss(el)) { haptic(); el.style.transform = 'translate3d(0, 100%, 0)'; return; }
    el.style.transform = '';
  }, { passive: true });
}

/* A long press on a session opens its menu (2026-10-12) */

/** How long a finger must stay on a row, and how far it may drift before it is a scroll instead. */
const LONG_PRESS_MS = 460;
const LONG_PRESS_SLOP_PX = 9;

/**
 * A long press on a row of the sessions list opens the session menu: app.js sessionMenu listens for contextmenu on
 * every row. Android's browser sends that event by itself after about half a second; iOS Safari never does, so this
 * press makes it there (and first on Android: the browser's own one, which follows, is ignored). A finger that moves
 * more than a few pixels is scrolling the list. The tap a lifted finger would make after a press is swallowed.
 */
function longPress() {
  // The rows under an open folder (2026-10-12, folders open in place) and the folder rows themselves too: a long press on
  // a folder opens its menu (Open or Close, Show only this folder).
  for (const list of [$('sessions'), $('folders')]) if (list) longPressOn(list);
}

function longPressOn(list) {
  let p = null;
  let swallowUntil = 0;
  const cancel = () => { if (p) { clearTimeout(p.timer); p = null; } };
  const fire = () => {
    if (!p) return;
    const { li, x, y } = p;
    p = null;
    swallowUntil = Date.now() + 700;
    haptic('medium');
    li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };
  list.addEventListener('touchstart', (e) => {
    const li = e.target.closest?.('li[data-id], .folder-row[data-folder]');
    cancel();
    if (!li || e.touches.length !== 1 || e.target.closest('.subs-n')) return;
    const t = e.touches[0];
    p = { li, x: t.clientX, y: t.clientY, timer: setTimeout(fire, LONG_PRESS_MS) };
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!p) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > LONG_PRESS_SLOP_PX) cancel();
  }, { passive: true });
  list.addEventListener('touchend', cancel, { passive: true });
  list.addEventListener('touchcancel', cancel, { passive: true });
  list.addEventListener('click', (e) => { if (Date.now() < swallowUntil) { e.stopPropagation(); e.preventDefault(); } }, true);
  list.addEventListener('contextmenu', (e) => { if (e.isTrusted && Date.now() < swallowUntil) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

/* A short line that leaves by itself */

/** The window's own short lines (copied, refused, forked): the same toast the pairing screens use (boot.js), at the top. */
function toast(text, ok = true) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); body.append(t); }
  t.textContent = text;
  t.classList.toggle('bad', !ok);
  t.classList.remove('out');
  t.hidden = false;
  clearTimeout(N.toastTimer);
  N.toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => { t.hidden = true; }, 200); }, 3200);
}

/* ---------- install ---------- */

const HINT_KEY = 'apaki.installHint.v1';
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** Running as an installed app (from the Home Screen), not in a browser tab. */
export const isStandalone = () => { try { return standalone(); } catch { return false; } };

/** An iPhone or iPad (where a Home Screen app keeps its own storage, apart from the browser's: WebKit does that on purpose). */
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent || '');

/** iOS Safari itself (not Chrome, Firefox or Edge on iOS), in a tab. */
export const isIosSafari = () => {
  const ua = navigator.userAgent || '';
  return isIos() && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
};

function installHint() {
  if (standalone() || localStorage.getItem(HINT_KEY)) return;
  const ios = isIosSafari();
  let deferred = null;
  const show = (html, onGo) => {
    const rail = document.querySelector('.rail');
    if (!rail || rail.querySelector('.install-hint')) return;
    const card = document.createElement('div');
    card.className = 'install-hint';
    card.innerHTML = `${html}<button class="ih-x" aria-label="Not now">Not now</button>`;
    card.querySelector('.ih-x').onclick = () => { localStorage.setItem(HINT_KEY, 'no'); card.remove(); };
    card.querySelector('.ih-go')?.addEventListener('click', onGo);
    (rail.querySelector('.ios-scroll') || rail).append(card);
  };
  if (ios) {
    // The Home Screen app keeps its own storage (2026-10-10: a pairing made here in Safari is not in it), so say so up front.
    show('<div class="ih-t"><b>Add Apaki to your Home Screen</b><span>Tap Share, then Add to Home Screen. It opens full screen, like an app. It keeps its own storage, so pair it once more there, or sign in to your Apaki account in it.</span></div>');
    return;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    show('<div class="ih-t"><b>Install Apaki</b><span>It opens full screen from your home screen, like an app.</span></div><button class="ih-go">Install</button>', async () => {
      deferred?.prompt();
      const choice = await deferred?.userChoice.catch(() => null);
      if (choice?.outcome) { localStorage.setItem(HINT_KEY, choice.outcome); document.querySelector('.install-hint')?.remove(); }
    });
  });
}

/* ---------- start ---------- */

/**
 * Turns Apaki's window into the phone app. Opening a session (a row, or
 * compose) pushes the conversation; a restored workspace with a
 * conversation in it starts there, with the list one Back away.
 */
export function initNative({ onPcTap, startInChat = false } = {}) {
  if (N.ready) return;
  N.ready = true;
  body.classList.add('native', 'at-list');
  listBars(onPcTap);
  chatBar();
  // 2026-10-11: tabs and pages on the conversation screen, the desktop's tabs on the list.
  try { initPager({ haptic }); } catch (e) { console.warn('apaki pager:', e); }
  try { initDesktop({ haptic, showChat }); } catch (e) { console.warn('apaki desktop tabs:', e); }
  // 2026-10-12: the PC browser view, the session menu's long press, Ask Claude's button, and what app.js asks of this screen.
  try { initBrowserView({ haptic }); } catch (e) { console.warn('apaki browser view:', e); }
  longPress();
  window.addEventListener('apaki:toast', (e) => toast(String(e.detail?.text || ''), e.detail?.ok !== false));
  window.addEventListener('apaki:chat', () => showChat());
  // Ask Claude's button shows only when the PC takes the command from a phone (an older Apaki does not).
  const syncAsk = () => body.classList.toggle('can-ask', Boolean(window.__apakiLink?.supports?.('op:askSearch')));
  $('q')?.addEventListener('input', syncAsk);
  syncAsk();
  edgeSwipe();
  sheetSwipe();
  installHint();
  $('sessions')?.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li || e.target.closest('.subs-n')) return;
    haptic();
    showChat();
  });
  // A session under an open folder opens the same way (2026-10-12); a tap on the folder row only opens or closes it.
  $('folders')?.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li || e.target.closest('.subs-n, .sr-more')) return;
    haptic();
    showChat();
  });
  // A subagent or shell opened from the list shows as a conversation too.
  document.querySelector('.rail')?.addEventListener('click', (e) => { if (e.target.closest('.sub-row:not(.note)')) showChat(); });
  // Closing the conversation goes back to the list; 2026-10-11: unless the tab (or the tab app.js switches to) still has a
  // pane to show, which the pager then shows (closing one page of several stays on the next one).
  document.querySelector('.main')?.addEventListener('click', (e) => {
    if (e.target.closest('.pane-bar .close')) setTimeout(() => { if (!body.classList.contains('paged') || !document.querySelector('.stage.on .pane')) showList(); }, 0);
  });
  // /resume in a conversation (app.js findSession): back to the list, where its search box is.
  window.addEventListener('apaki:list', () => showList());
  // The title follows the conversation.
  const stages = $('stages');
  if (stages) new MutationObserver(() => { if (N.screen === 'chat') syncChatTitle(); }).observe(stages, { subtree: true, childList: true, characterData: true });
  if (startInChat) {
    history.replaceState({ apaki: 'list' }, '');
    showChat();
  }
}
