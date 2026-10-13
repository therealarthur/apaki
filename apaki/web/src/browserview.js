/**
 * browserview.js: the page Claude opened in the PC's browser, seen from the phone (2026-10-12, Claude Code,
 * Sonnet 5.5, for Arthur). Arthur: every desktop feature also works on the phone; the browser pane was the one
 * with nothing on the phone at all.
 *
 * What the PC can send (checked in apaki/engine, 2026-10-12): the browser is a WebView2 the desktop shell owns,
 * so a live page cannot run on a phone. The engine already tells a conversation when Claude used it (a Browser
 * tool line, an openUrl with a browserId, browserActivity lines "Clicked ...") and can take a picture of the page
 * in view (the browser_screenshot path). So the simplest thing that works is a read-only view of that picture:
 *
 *   - a Browser button in the conversation bar (pager.js) once Claude has used the browser there; a link card's
 *     Open for a page that only exists on the PC (a dev server on localhost) opens the same view;
 *   - the view is a sheet: the page's title and address, the picture (tap to zoom), what Claude just did there,
 *     when it was taken, Refresh, and Open on this phone for a public address;
 *   - it asks the PC for the picture when it opens (op browserView, one JPEG of the part in view, quiet: it adds
 *     nothing to the desktop browser's strip) and again, a moment after each browserActivity line, so it follows
 *     Claude click through the page without a stream. One request at a time.
 *
 * Read only on purpose: there is no way to click or type into the PC's browser from here. Full access only (the
 * browser tools are Full; remote-policy.js capAllowsOp), and only the page of this phone's own conversation.
 * Phone only: native.js starts it; the desktop window never loads this file.
 */

import { isPublicWebUrl } from './artifacts.js';

const $ = (id) => document.getElementById(id);

/** After a browserActivity line the page needs a moment to settle before the picture is worth taking. */
export const REFRESH_QUIET_MS = 700;
/** The PC did not answer a browserView within this long (12 s since 2026-10-12: the picture takes about a second; a spinner
 * for half a minute read as broken). */
export const ANSWER_MS = 12_000;

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/** The address as one short line: no scheme, no trailing slash. */
export function addressLine(url) {
  const t = String(url || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** What the sheet shows for a browserView event (or nothing yet). Pure (exported for tests). */
export function viewModel(ev, now = Date.now()) {
  if (!ev) return { kind: 'loading' };
  if (!ev.ok || !ev.image) return { kind: 'error', text: String(ev.text || 'The PC could not show the page.') };
  const st = ev.state || {};
  const url = String(st.url || '');
  const title = String(st.title || '').trim();
  return {
    kind: 'page',
    src: `data:${/^image\/(jpeg|png)$/.test(ev.mime) ? ev.mime : 'image/jpeg'};base64,${ev.image}`,
    title: title && title !== url ? title : hostOf(url) || 'Browser',
    address: addressLine(url),
    url,
    loading: Boolean(st.loading),
    failed: st.error ? String(st.error) : '',
    ratio: ev.width > 0 && ev.height > 0 ? ev.width / ev.height : 1.6,
    at: Number(ev.at) || now,
    canOpenHere: isPublicWebUrl(url),
    tabs: tabsModel(ev.tabs),
  };
}

/**
 * The pages of the conversation's browser pane on the PC (2026-10-12: one browser pane per conversation, its pages as
 * tabs), for the row above the picture: shown from two. Pure (exported for tests).
 */
export function tabsModel(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .filter((t) => t && typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(t.id))
    .slice(0, 20)
    .map((t) => {
      const url = String(t.url || '');
      const title = String(t.title || '').trim();
      return { id: t.id, title: title && title !== url ? title : hostOf(url) || (url === 'about:blank' || !url ? 'New tab' : url), active: Boolean(t.active) };
    });
}

/** "Updated 10:42" for the foot of the sheet. */
export function updatedText(at) {
  if (!at) return '';
  return `Updated ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function initBrowserView({ haptic = () => {} } = {}) {
  if ($('bvScrim')) return false;
  const root = document.createElement('div');
  root.className = 'bv-scrim';
  root.id = 'bvScrim';
  root.hidden = true;
  root.innerHTML = `<section class="bv" role="dialog" aria-modal="true" aria-labelledby="bvTitle" tabindex="-1">
      <div class="bv-head">
        <div class="bv-k">Page on your PC</div>
        <h2 class="bv-title" id="bvTitle"></h2>
        <div class="bv-addr mono"></div>
      </div>
      <div class="bv-tabs" role="tablist" aria-label="Pages in this conversation's browser" hidden></div>
      <div class="bv-body">
        <button type="button" class="bv-shot" aria-label="Zoom the page" hidden></button>
        <div class="bv-state" role="status"></div>
      </div>
      <div class="bv-act" aria-live="polite"></div>
      <div class="bv-foot"><span class="bv-at"></span><span class="bv-note">A picture; you cannot click in it</span></div>
      <div class="bv-row"><button type="button" data-k="x">Done</button><button type="button" data-k="open" hidden>Open on this phone</button><button type="button" data-k="refresh" class="primary">Refresh</button></div>
    </section>`;
  document.body.append(root);
  const q = (s) => root.querySelector(s);
  // The picture's <img> is made when the first one arrives (no empty image in the markup).
  const el = { title: q('.bv-title'), addr: q('.bv-addr'), shot: q('.bv-shot'), img: null, state: q('.bv-state'), act: q('.bv-act'), at: q('.bv-at'), open: q('[data-k=open]'), refresh: q('[data-k=refresh]'), card: q('.bv'), tabs: q('.bv-tabs') };
  // tab: a page picked in the row of tabs, sent with the next look (the PC makes it the active tab, its pane follows).
  const V = { pane: null, busy: false, again: false, seq: 0, timer: null, refreshTimer: null, wait: null, model: null, before: null, tab: null };

  /** The row of the browser pane's tabs, from two: the active one filled; a tap looks at that one. */
  function drawTabs(list) {
    const many = Array.isArray(list) && list.length > 1;
    el.tabs.hidden = !many;
    if (!many) { el.tabs.replaceChildren(); return; }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = list.map((t) => `<button type="button" role="tab" class="bv-tab${t.active ? ' on' : ''}" data-id="${esc(t.id)}" aria-selected="${t.active}">${esc(t.title)}</button>`).join('');
    if (html !== el.tabs.dataset.html) { el.tabs.dataset.html = html; el.tabs.innerHTML = html; el.tabs.querySelector('.bv-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  const send = (msg) => window.__TAURI__.core.invoke('engine_send', { msg }).catch(() => {});

  function draw() {
    const m = V.model || viewModel(null);
    el.refresh.disabled = V.busy;
    el.refresh.textContent = V.busy ? 'Looking…' : 'Refresh';
    el.card.classList.toggle('busy', V.busy);
    drawTabs(m.kind === 'page' ? m.tabs : null);
    if (m.kind === 'page') {
      el.title.textContent = m.title;
      el.addr.textContent = m.address;
      if (!el.img) {
        el.img = document.createElement('img');
        el.img.alt = 'The page as it looks in the PC\'s browser';
        el.shot.append(el.img);
      }
      if (el.img.src !== m.src) el.img.src = m.src;
      el.img.style.aspectRatio = String(m.ratio);
      el.shot.hidden = false;
      el.state.hidden = !(m.loading || m.failed);
      el.state.textContent = m.failed ? `The PC's browser could not load it: ${m.failed}` : m.loading ? 'Still loading on the PC' : '';
      el.state.classList.toggle('bad', Boolean(m.failed));
      el.at.textContent = updatedText(m.at);
      el.open.hidden = !m.canOpenHere;
      el.open.dataset.url = m.canOpenHere ? m.url : '';
      return;
    }
    el.shot.hidden = true;
    el.at.textContent = '';
    el.open.hidden = true;
    el.state.hidden = false;
    el.state.classList.toggle('bad', m.kind === 'error');
    el.state.textContent = m.kind === 'error' ? m.text : '';
    // The first look: a quiet shimmer where the page will be, not a spinner.
    el.state.classList.toggle('skeleton', m.kind === 'loading');
    if (m.kind === 'loading') { el.title.textContent = 'Opening the page…'; el.addr.textContent = ''; }
  }

  /** Asks the PC for the picture (one at a time; a request that comes while one is out is made once it returns). */
  function look() {
    if (!V.pane) return;
    // An older Apaki on the PC does not take browserView at all (Arthur, 2026-10-12: "it just loads and never shows anything"):
    // say so at once instead of waiting for an answer that cannot come.
    if (window.__apakiLink?.supports && !window.__apakiLink.supports('op:browserView')) {
      V.model = { kind: 'error', text: 'Apaki on your PC is an older version that cannot show its browser here. Restart Apaki on the PC to finish its update, then try again.' };
      draw();
      return;
    }
    if (V.busy) { V.again = true; return; }
    V.busy = true;
    V.again = false;
    const reqId = `bv${++V.seq}`;
    V.wait = reqId;
    clearTimeout(V.timer);
    V.timer = setTimeout(() => {
      if (V.wait !== reqId) return;
      V.wait = null;
      V.busy = false;
      V.model = { kind: 'error', text: 'The PC did not answer. It may be asleep, or its Apaki window may be closed.' };
      draw();
    }, ANSWER_MS);
    draw();
    // A tab picked in the row goes along once; after that the PC's active tab is that one.
    const tab = V.tab;
    V.tab = null;
    send({ op: 'browserView', reqId, paneId: V.pane, ...(tab ? { tab } : {}) });
  }

  function show(paneId) {
    V.pane = paneId;
    V.model = null;
    V.busy = false;
    V.again = false;
    V.before = document.activeElement;
    el.act.textContent = '';
    el.card.classList.remove('zoom');
    root.hidden = false;
    document.body.classList.add('bv-open');
    draw();
    el.card.focus({ preventScroll: true });
    look();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('bv-open');
    clearTimeout(V.timer);
    clearTimeout(V.refreshTimer);
    V.pane = null;
    V.wait = null;
    V.busy = false;
    if (V.before?.isConnected) V.before.focus?.({ preventScroll: true });
  }

  window.addEventListener('apaki:browser-view', (e) => { if (e.detail?.pane) { haptic(); show(e.detail.pane); } });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) { e.preventDefault(); close(); } });
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  q('[data-k=x]').onclick = () => { haptic(); close(); };
  el.refresh.onclick = () => { haptic(); look(); };
  el.open.onclick = () => { const u = el.open.dataset.url; if (u) window.open(u, '_blank', 'noopener,noreferrer'); };
  el.shot.onclick = () => { haptic(); el.card.classList.toggle('zoom'); };
  // Another page of the conversation's browser (2026-10-12): the PC shows that tab, and this view follows it.
  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.bv-tab');
    if (!b || b.classList.contains('on')) return;
    haptic();
    for (const x of el.tabs.querySelectorAll('.bv-tab')) x.classList.toggle('on', x === b);
    V.tab = b.dataset.id;
    look();
  });

  // What the PC says: the picture, and what Claude is doing there.
  window.__TAURI__.event.listen('engine', ({ payload: ev }) => {
    // A refusal comes back by request id, maybe without the pane (the PC's policy, or an op it does not have): show why.
    if (ev && !root.hidden && ev.ev === 'error' && V.wait && ev.reqId === V.wait) {
      clearTimeout(V.timer);
      V.wait = null;
      V.busy = false;
      V.model = { kind: 'error', text: ev.message || 'The PC could not show its browser.' };
      draw();
      return;
    }
    if (!ev || root.hidden || ev.paneId !== V.pane) return;
    if (ev.ev === 'browserView') {
      if (V.wait && ev.reqId && ev.reqId !== V.wait) return;
      clearTimeout(V.timer);
      V.wait = null;
      V.busy = false;
      V.model = viewModel(ev);
      draw();
      if (V.again) look();
    } else if (ev.ev === 'browserActivity') {
      el.act.textContent = ev.text || ev.action ? `Claude · ${ev.text || ev.action}` : '';
      // Look again a moment after the last thing Claude did (a click, a typed field, a page that loads).
      clearTimeout(V.refreshTimer);
      V.refreshTimer = setTimeout(look, REFRESH_QUIET_MS);
    }
  });
  return true;
}
