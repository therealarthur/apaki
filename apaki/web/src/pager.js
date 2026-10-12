/**
 * pager.js: the phone's conversation screen as tabs and pages (2026-10-11,
 * Claude Code, Opus 5.5, for Arthur). Arthur: "plan out a clean and organized
 * aesthetically pleasing way to display the multiple panes in a tab on the
 * phone (only 1 pane can be viewed once in a tab on the phone, you should be
 * able to kind of scroll sideways through the different panes in a tab, as
 * well as above it scroll through the different tabs".
 *
 * The conversation screen of native.js's stack, top to bottom (web.css,
 * "pager" block; every rule needs body.paged, which this file sets):
 *
 *   nav row     Back (native.js), the visible pane's title with "2 of 3" and
 *               its folder, and that pane's own buttons (artifacts, tasks,
 *               close) mirrored from its hidden pane bar.
 *   tab strip   one item per tab, named by its focused pane's title (or
 *               "Tab N"); the current one is a raised card, a working one has
 *               Apaki's live grid and a brand-coloured name, one that finished
 *               while you looked elsewhere a green name. No dots. It scrolls
 *               sideways and keeps the current tab in view; a tap switches
 *               (150 to 200 ms fade). Only with two or more tabs.
 *   segments    with two or more panes in the tab: a thin segmented bar whose
 *               lit segment follows the finger.
 *   pager       the tab's panes side by side, one screen each, in layout
 *               order: the platform's own horizontal scrolling with snapping,
 *               so momentum and the bounce at either end are native. The
 *               stage is the scroller and its splits are flattened (web.css),
 *               so app.js keeps building the same tree.
 *
 * Who owns what: app.js stays the source of truth. Its tab bar (#tabs) is
 * hidden on the phone but still rendered on every change, so the strip mirrors
 * it and a tap clicks the matching hidden tab (switchTab). A swipe that
 * settles on a pane focuses it in app.js (window.__apaki.focusPane), so the
 * composer, /commands and opening a session from the list act on what is on
 * screen; app.js focusing a pane by itself (a new conversation, which is a new
 * pane in the current tab since 2026-10-11, or a session opened from the list
 * that is already open) scrolls the pager to it.
 *
 * Gestures: a swipe that starts on the left edge of the screen (.edge-catch,
 * 20 px, between the bars and the composer) is native.js's swipe back to the
 * list, and the pager never sees it; anywhere else a sideways swipe pages.
 * Vertical scrolling of a conversation and sideways paging use the platform's
 * direction lock (nested scrollers), so neither fights the other.
 *
 * Nothing here runs in the desktop window: native.js calls initPager on the
 * phone only.
 */

import { effortGrid } from './menu.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** After this long without a scroll event the pager has settled (Safari has no scrollend everywhere yet). */
const SETTLE_MS = 120;

const ICON_ART = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="4.2" width="9" height="9.6" rx="1.6"/><path d="M5 4.2v-.6c0-.8.6-1.4 1.4-1.4h6.4c.8 0 1.4.6 1.4 1.4v6.8c0 .8-.6 1.4-1.4 1.4h-2"/></svg>';
const ICON_TASKS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.2" cy="5.2" r="2"/><path d="M1.8 12.8c.4-2 1.7-3.1 3.4-3.1s3 1.1 3.4 3.1"/><rect x="9.4" y="3" width="5" height="4" rx="1"/><path d="M10.4 9.6h3M10.4 12h3"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
// 2026-10-12: the PC browser's page (a globe), and the conversation menu (three dots).
const ICON_BROWSER = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M2.6 8h10.8M8 2.4c1.6 1.6 2.3 3.5 2.3 5.6S9.6 12 8 13.6M8 2.4C6.4 4 5.7 5.9 5.7 8s.7 4 2.3 5.6"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.4" cy="8" r="1.1"/></svg>';

/**
 * Whether the conversation bar offers the Browser button: Claude used Apaki's browser in this conversation (the pane
 * marks it, pane.js markBrowser), this phone has Full access (only a Full pane's Claude has the browser) and the PC
 * takes browserView. Pure (exported for tests).
 */
export function browserOffer({ marked, cap, canView }) {
  return Boolean(marked) && cap === 'full' && Boolean(canView);
}

/** The tabs as app.js's hidden tab bar shows them. Pure over a list of { title, n, on, busy, unread } (exported for tests). */
export function stripModel(tabs) {
  return tabs.map((t, i) => {
    const title = String(t.title || '').trim();
    return { i, title: !title || title === 'Empty tab' ? `Tab ${i + 1}` : title, n: Math.max(1, Number(t.n) || 1), on: Boolean(t.on), busy: Boolean(t.busy), unread: Boolean(t.unread) };
  });
}

/** Which page a pager shows: its scroll position over its width, rounded, kept inside the pages. Pure (exported for tests). */
export function pageAt(scrollLeft, width, count) {
  if (!(width > 0) || !(count > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / width)));
}

/** How lit each segment is for a scroll progress p (in pages): 1 on the page, sharing between two while it moves. Pure (exported for tests). */
export function segmentLevels(p, count) {
  return Array.from({ length: Math.max(0, count) }, (_, i) => Math.max(0, 1 - Math.abs(p - i)));
}

export function initPager({ haptic = () => {} } = {}) {
  const main = document.querySelector('.main');
  const stages = $('stages');
  const tabsBar = $('tabs');
  const A = window.__apaki;
  if (!main || !stages || !tabsBar || typeof A?.focusPane !== 'function' || main.querySelector('.chat-chrome')) return false;
  document.body.classList.add('paged');

  const chrome = document.createElement('div');
  chrome.className = 'chat-chrome';
  chrome.innerHTML = `<div class="cn-row">
      <div class="cn-t"><div class="cn-title"></div><div class="cn-sub"><span class="cn-pos"></span><span class="cn-cwd"></span></div></div>
      <div class="cn-acts">
        <button class="cn-btn cn-art" hidden aria-label="Artifacts from this conversation">${ICON_ART}<span class="cn-n"></span></button>
        <button class="cn-btn cn-tasks" hidden aria-label="Subagents and background tasks">${ICON_TASKS}<span class="cn-n"></span></button>
        <button class="cn-btn cn-browser" hidden aria-label="The page Claude opened in the PC's browser">${ICON_BROWSER}</button>
        <button class="cn-btn cn-more" hidden aria-label="Conversation menu: find, rename, fork, archive">${ICON_MORE}</button>
        <button class="cn-btn cn-close" aria-label="Close this conversation">${ICON_CLOSE}</button>
      </div>
    </div>
    <div class="tab-strip" role="tablist" aria-label="Tabs" hidden></div>
    <div class="pager-bar" aria-hidden="true" hidden></div>`;
  main.prepend(chrome);
  const edge = document.createElement('div');
  edge.className = 'edge-catch';
  edge.setAttribute('aria-hidden', 'true');
  main.append(edge);
  const strip = chrome.querySelector('.tab-strip');
  const bar = chrome.querySelector('.pager-bar');
  const title = chrome.querySelector('.cn-title');
  const pos = chrome.querySelector('.cn-pos');
  const cwd = chrome.querySelector('.cn-cwd');

  // The space the bars take: the stage starts below them (web.css --chat-top).
  new ResizeObserver(() => main.style.setProperty('--chat-top', `${chrome.offsetHeight}px`)).observe(chrome);

  const P = { touching: false, scrolling: false, settleTimer: null, shown: -1, stripKey: '', barN: -1, raf: 0, stage: null, paneObs: null };

  const stage = () => stages.querySelector('.stage.on');
  const panesOf = (s) => (s ? [...s.querySelectorAll('.pane')] : []);
  const paneObj = (el) => [...(A.S?.panes?.values() || [])].find((p) => p.el === el) || null;
  const focusedIndex = (s) => Math.max(0, panesOf(s).findIndex((el) => el.classList.contains('focused')));
  /** One page's step: the stage's width and the gap between pages (web.css), so pearl shows between two pages in motion. */
  const step = (s) => (s ? s.clientWidth + (parseFloat(getComputedStyle(s).columnGap) || 0) : 0);
  const current = (s) => pageAt(s?.scrollLeft || 0, step(s), panesOf(s).length);

  /* ---------- the tab strip ---------- */

  function renderStrip() {
    const tabs = stripModel([...tabsBar.querySelectorAll('.tab')].map((el) => ({
      title: el.querySelector('.tab-t')?.textContent, n: el.querySelector('.tab-n')?.textContent,
      on: el.classList.contains('on'), busy: el.classList.contains('busy'), unread: el.classList.contains('unread'),
    })));
    const key = JSON.stringify(tabs);
    if (key === P.stripKey) return;
    P.stripKey = key;
    strip.hidden = tabs.length < 2;
    chrome.classList.toggle('strip-on', !strip.hidden);
    if (strip.hidden) { strip.innerHTML = ''; return; }
    strip.innerHTML = tabs.map((t) => `<button type="button" role="tab" aria-selected="${t.on}" class="ts-chip${t.on ? ' on' : ''}${t.busy ? ' busy' : ''}${t.unread && !t.busy ? ' unread' : ''}" data-i="${t.i}" title="${esc(t.title)}${t.busy ? ' (working)' : ''}">${t.busy ? effortGrid('max', { live: true }) : ''}<span class="ts-t">${esc(t.title)}</span>${t.n > 1 ? `<span class="ts-n" aria-label="${t.n} panes">${t.n}</span>` : ''}</button>`).join('');
    const on = strip.querySelector('.ts-chip.on');
    // Keep the current tab in view (centred when it can be), without moving the page around it.
    if (on) {
      const left = on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: reduced() || !P.stripShown ? 'auto' : 'smooth' });
    }
    P.stripShown = true;
  }

  strip.addEventListener('click', (e) => {
    const chip = e.target.closest('.ts-chip');
    if (!chip) return;
    const i = Number(chip.dataset.i);
    const tab = tabsBar.querySelectorAll('.tab')[i];
    if (!tab || chip.classList.contains('on')) return;
    haptic();
    tab.click();
    // The new tab's pages: straight to its focused pane, then a short fade in (no slide: the strip says where you went).
    const s = stage();
    if (s) {
      s.scrollLeft = focusedIndex(s) * step(s);
      if (!reduced()) { s.classList.remove('pg-in'); void s.offsetWidth; s.classList.add('pg-in'); }
    }
    sync();
  });

  /* ---------- the segmented bar and the nav row ---------- */

  function renderBar(s) {
    const n = panesOf(s).length;
    if (n !== P.barN) {
      P.barN = n;
      bar.hidden = n < 2;
      chrome.classList.toggle('bar-on', n >= 2);
      bar.innerHTML = n < 2 ? '' : '<i></i>'.repeat(n);
    }
    if (n < 2) return;
    const w = step(s);
    const p = w ? s.scrollLeft / w : 0;
    segmentLevels(p, n).forEach((v, i) => bar.children[i]?.style.setProperty('--on', v.toFixed(3)));
  }

  /** The nav row says what the visible pane is, and mirrors its pane bar's buttons. */
  function renderNav(s, i = current(s)) {
    const panes = panesOf(s);
    const el = panes[i] || null;
    const t = el?.querySelector('.pane-bar .title')?.textContent || (panes.length ? 'Conversation' : 'Empty tab');
    if (title.textContent !== t) {
      title.textContent = t;
      if (P.shown >= 0 && !reduced()) { title.classList.remove('cn-swap'); void title.offsetWidth; title.classList.add('cn-swap'); }
    }
    title.title = t;
    pos.textContent = panes.length > 1 ? `${i + 1} of ${panes.length}` : '';
    cwd.textContent = el?.querySelector('.pane-bar .cwd')?.textContent || '';
    const mirror = (cls, src) => {
      const b = chrome.querySelector(cls);
      const from = el?.querySelector(src);
      b.hidden = !from || from.hidden;
      b.classList.toggle('lit', Boolean(from?.classList.contains('lit')));
      b.querySelector('.cn-n').textContent = from?.querySelector('.ar-n, .tb-n')?.textContent || '';
    };
    mirror('.cn-art', '.art-reopen');
    mirror('.cn-tasks', '.tasks-btn');
    // 2026-10-12: the page Claude opened in the PC's browser (Full access, a PC that has the view), and the menu.
    const link = window.__apakiLink;
    chrome.querySelector('.cn-browser').hidden = !browserOffer({ marked: el?.dataset.browser === '1', cap: link?.cap?.() || 'full', canView: link?.supports?.('op:browserView') });
    chrome.querySelector('.cn-more').hidden = !el;
    chrome.querySelector('.cn-close').hidden = !el;
    P.shown = i;
    // The visible pane's own bar changes (title, tasks, artifacts): follow it.
    if (P.paneObs?.el !== el) {
      P.paneObs?.obs.disconnect();
      P.paneObs = null;
      const pb = el?.querySelector('.pane-bar');
      if (pb) {
        const obs = new MutationObserver(() => schedule());
        obs.observe(pb, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });
        P.paneObs = { el, obs };
      }
    }
  }

  /** The visible pane's button, clicked for real: the pane's own code does the rest. */
  const press = (src) => () => { const el = panesOf(stage())[current(stage())]; el?.querySelector(src)?.click(); };
  chrome.querySelector('.cn-art').onclick = press('.art-reopen');
  chrome.querySelector('.cn-tasks').onclick = press('.tasks-btn');
  chrome.querySelector('.cn-close').onclick = () => { haptic(); press('.pane-bar .close')(); };
  // 2026-10-12: both ask for a screen of their own, which app.js (the menu) and browserview.js (the page) draw.
  const visibleId = () => panesOf(stage())[current(stage())]?.dataset.pane || null;
  chrome.querySelector('.cn-more').onclick = () => { haptic(); window.dispatchEvent(new CustomEvent('apaki:pane-menu', { detail: { pane: visibleId() } })); };
  chrome.querySelector('.cn-browser').onclick = () => { haptic(); window.dispatchEvent(new CustomEvent('apaki:browser-view', { detail: { pane: visibleId() } })); };

  /* ---------- paging ---------- */

  /** The pager settled on a page: that pane becomes app.js's focused pane. */
  function settle() {
    P.scrolling = false;
    const s = stage();
    if (!s) return;
    const i = current(s);
    const el = panesOf(s)[i];
    if (el && !el.classList.contains('focused')) {
      const p = paneObj(el);
      // No tick here: paging is a scroll, and iOS pages scroll silently.
      if (p) A.focusPane(p, { scroll: false });
    }
    renderNav(s, i);
    renderBar(s);
  }

  /** app.js focused a pane by itself: show it (smoothly while the screen is up, at once otherwise). */
  function follow(s) {
    if (!s || P.touching || P.scrolling) return;
    const want = focusedIndex(s);
    if (current(s) === want || !s.clientWidth) return;
    const smooth = !reduced() && document.body.classList.contains('at-chat');
    s.scrollTo({ left: want * step(s), behavior: smooth ? 'smooth' : 'auto' });
  }

  function sync() {
    P.raf = 0;
    const s = stage();
    if (s !== P.stage) { P.stage = s; P.barN = -1; if (s) s.scrollLeft = focusedIndex(s) * step(s); }
    renderStrip();
    follow(s);
    renderBar(s);
    renderNav(s, P.scrolling || P.touching ? current(s) : focusedIndex(s));
  }
  const schedule = () => { if (!P.raf) P.raf = requestAnimationFrame(sync); };

  // A stage scrolled (the transcripts inside scroll too; only the stage itself pages).
  stages.addEventListener('scroll', (e) => {
    const s = e.target;
    if (!(s instanceof HTMLElement) || !s.classList.contains('stage') || s !== stage()) return;
    P.scrolling = true;
    renderBar(s);
    const i = current(s);
    if (i !== P.shown) renderNav(s, i);
    clearTimeout(P.settleTimer);
    P.settleTimer = setTimeout(() => { if (!P.touching) settle(); }, SETTLE_MS);
  }, { capture: true, passive: true });
  // A conversation used the PC's browser (pane.js markBrowser): its Browser button may show now.
  stages.addEventListener('apaki:browser-used', schedule);
  stages.addEventListener('touchstart', () => { P.touching = true; }, { capture: true, passive: true });
  const lift = () => {
    P.touching = false;
    clearTimeout(P.settleTimer);
    P.settleTimer = setTimeout(settle, SETTLE_MS);
  };
  stages.addEventListener('touchend', lift, { capture: true, passive: true });
  stages.addEventListener('touchcancel', lift, { capture: true, passive: true });

  // app.js re-renders its hidden tab bar on every tab, pane, title and busy change: one place to follow it all.
  new MutationObserver(schedule).observe(tabsBar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  // A tab's panes added, closed or moved (layout replaces the stage's children), and tabs added (a stage each).
  for (const s of stages.querySelectorAll('.stage')) new MutationObserver(schedule).observe(s, { childList: true });
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.classList?.contains('stage')) new MutationObserver(schedule).observe(n, { childList: true });
    schedule();
  }).observe(stages, { childList: true });
  // A new size (rotation, the keyboard): stay on the same page.
  window.addEventListener('resize', () => { const s = stage(); if (s && P.shown >= 0) s.scrollLeft = P.shown * step(s); schedule(); });
  window.addEventListener('apaki-theme', schedule);
  sync();
  return true;
}
