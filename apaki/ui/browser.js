/**
 * browser.js: the browser pane in Myrlin Apaki's window.
 *
 * WHY (Arthur, 2026-10-09: "a built-in browser like Codex's, driven by
 * Claude, light and fast"): web pages open beside the conversation that
 * asked for them, in a pane like the others (grip, split, resize, close,
 * comes back with the workspace), and Claude can use the same page through
 * its browser tools while the user watches.
 *
 * TABS (Arthur, 2026-10-12: "so many browsers ended up being opened in new
 * tabs unconnected to the main session that wanted to drive them ...
 * additional tabs wanted to be opened by the session should open those tabs IN
 * the browser pane (like codex/gpt)"): a conversation has ONE browser pane,
 * and every page it opens is a tab inside it, with a small tab strip in the
 * pane's header (an initial, the title, close; the active one filled). Each
 * tab is its own page in the shell (its own browser id); only the active one
 * is on screen, and Claude's tools act on the active one (the engine is told
 * when you pick another: host.tabPicked). The pane's own id never changes, so
 * the layout and the saved workspace keep it whatever its tabs do.
 *
 * The page itself is not in this document. It is a native WebView2 the shell
 * owns (apaki/src/browser.rs) and lays over this pane's body: this pane is
 * the frame around it (address strip, title, loading light) and reports
 * where its body is so the shell can put the page exactly there
 * (place: physical pixels, and whether it shows). When a menu, a sheet or a
 * drag needs the space, app.js hides the page and this pane shows a picture
 * of it in its place (snapshot), so nothing jumps.
 *
 * The page has no way back into Apaki: it is not a Tauri webview, has no
 * bridge and runs in its own profile. This pane only ever sends commands to
 * the shell through host.browser(cmd, args).
 *
 * Host interface: browser(cmd, args), focus(pane), close(pane),
 * dragPane(pane, e), dragEnd(), changed(pane), openOutside(url),
 * shortcut(key, shift), paneTitle(id), tabPicked(pane, browserId).
 */

import { esc } from './markdown.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const hostOf = (u) => { try { const x = new URL(u); return x.protocol === 'file:' ? decodeURIComponent(x.pathname.split('/').pop() || 'file') : x.host; } catch { return ''; } };
const ACTIVITY_MS = 4200;
// Typed words that are not an address go to a search.
const SEARCH = 'https://www.google.com/search?q=';

/** What the address field turns into a URL: an address as is, host-like text with https, anything else a search. */
export function addressToUrl(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^(https?:\/\/|file:\/\/\/)/i.test(t)) return t;
  if (/^about:blank$/i.test(t)) return 'about:blank';
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`;
  return `${SEARCH}${encodeURIComponent(t)}`;
}

/** The name a tab shows: its page's title, else its host, else "New tab". */
export function tabTitle(st = {}) {
  const t = String(st.title || '').trim();
  if (t && t !== st.url) return t;
  if (!st.url || st.url === 'about:blank') return 'New tab';
  return hostOf(st.url) || st.url;
}

/** The one character a tab shows before its title (there are no favicons from the shell): the host's first letter. */
export function tabInitial(st = {}) {
  const h = hostOf(st.url || '').replace(/^www\./i, '');
  const c = (h || tabTitle(st)).match(/[\p{L}\p{N}]/u);
  return c ? c[0].toUpperCase() : '·';
}

/** The same page, for "is it open in a tab already": no #hash, one trailing slash ignored. */
export function samePage(a, b) {
  const n = (u) => String(u || '').split('#')[0].replace(/\/$/, '').toLowerCase();
  return Boolean(a) && n(a) === n(b);
}

let seq = 0;
export const newBrowserId = () => `b${Date.now().toString(36)}${(++seq).toString(36)}`;

const ICON_X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

export class BrowserPane {
  /**
   * o: { owner, url, title, tabs?: [{ id, url, title }], active?, adopt? }.
   * Without tabs (a page the shell just made, or an old saved workspace) the
   * pane's one tab has the pane's own id. A pane made from the saved
   * workspace has no page yet: it asks the shell for one the first time its
   * tab shows.
   */
  constructor(id, host, o = {}) {
    this.id = id;
    this.host = host;
    // An auxiliary pane like a viewer: no conversation behind it (app.js guards on isViewer).
    this.isViewer = true;
    this.isBrowser = true;
    this.sessionId = null;
    this.cwd = '';
    this.busy = false;
    this.unread = false;
    this.sourcePane = o.owner || null;
    this.adopt = Boolean(o.adopt);
    // The pages, in the strip's order: { id, st, live, starting, adopt, placed, gen }.
    this.tabs = [];
    const list = Array.isArray(o.tabs) && o.tabs.length ? o.tabs : [{ id, url: o.url || '', title: o.title || '' }];
    for (const t of list) if (t && typeof t.id === 'string' && !this.tabs.some((x) => x.id === t.id)) this.tabs.push(this.makeTab(t.id, { url: t.url || '', title: t.title || '' }, { adopt: this.adopt || Boolean(o.alive?.has?.(t.id)) }));
    this.active = (o.active && this.tabs.some((t) => t.id === o.active) ? o.active : this.tabs[0].id);
    this.title = tabTitle(this.cur().st);
    this.el = el('section', 'pane viewer web');
    this.el.dataset.pane = id;
    this.el.innerHTML = `
      <header class="pane-bar web-bar">
        <span class="grip" draggable="true" title="Drag to move this browser">
          <svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/></svg>
        </span>
        <div class="web-nav">
          <button class="icon-btn back" title="Back (Alt+Left)" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg></button>
          <button class="icon-btn fwd" title="Forward (Alt+Right)" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>
          <button class="icon-btn reload" title="Reload (F5)"><svg class="i-reload" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg><svg class="i-stop" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>
        </div>
        <div class="title-block web-title">
          <div class="web-head"><h2 class="title">Browser</h2><span class="web-act" aria-live="polite"></span></div>
          <form class="web-addr" autocomplete="off"><input class="addr" spellcheck="false" placeholder="Search or type an address" aria-label="Address"></form>
        </div>
        <button class="icon-btn new-tab" title="New tab in this browser"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button>
        <button class="icon-btn outside" title="Open in your browser"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg></button>
        <button class="icon-btn close" title="Close browser and its tabs (Ctrl+W)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        <div class="web-tabs" role="tablist" aria-label="Pages in this browser" hidden></div>
        <i class="web-sweep" aria-hidden="true"></i>
      </header>
      <div class="ground web-ground">
        <div class="web-body">
          <img class="web-snap" alt="" hidden>
          <div class="web-empty"><div class="tk-kicker">Browser</div><p class="web-empty-t"></p></div>
        </div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = {
      title: q('.title'), act: q('.web-act'), addr: q('.addr'), form: q('.web-addr'), back: q('.back'), fwd: q('.fwd'), reload: q('.reload'),
      body: q('.web-body'), snap: q('.web-snap'), empty: q('.web-empty'), emptyT: q('.web-empty-t'), grip: q('.grip'), close: q('.close'),
      ground: q('.web-ground'), input: null, strip: q('.web-tabs'), newTab: q('.new-tab'),
    };
    this.el.addEventListener('pointerdown', () => host.focus(this), true);
    this.$.close.onclick = () => host.close(this);
    this.$.back.onclick = () => this.nav('back');
    this.$.fwd.onclick = () => this.nav('forward');
    this.$.reload.onclick = () => this.nav(this.st.loading ? 'stop' : 'reload');
    this.$.newTab.onclick = () => this.newTab();
    q('.outside').onclick = () => { if (/^https?:/i.test(this.st.url)) host.openOutside(this.st.url); };
    this.$.form.onsubmit = (e) => { e.preventDefault(); this.go(this.$.addr.value); };
    this.$.addr.addEventListener('focus', () => { this.editing = true; this.$.addr.value = this.st.url === 'about:blank' ? '' : this.st.url || ''; this.$.addr.select(); });
    this.$.addr.addEventListener('blur', () => { this.editing = false; this.renderAddr(); });
    this.$.addr.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this.$.addr.blur(); this.focusPage(); } });
    this.$.grip.addEventListener('dragstart', (e) => host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => host.dragEnd());
    // The strip: a click picks a tab, its x (or a middle click) closes it.
    this.$.strip.addEventListener('click', (e) => {
      const b = e.target.closest('.web-tab');
      if (!b) return;
      if (e.target.closest('.wt-x')) { e.stopPropagation(); this.closeTab(b.dataset.id); return; }
      this.activate(b.dataset.id, { pick: true });
    });
    this.$.strip.addEventListener('auxclick', (e) => { const b = e.target.closest('.web-tab'); if (b && e.button === 1) { e.preventDefault(); this.closeTab(b.dataset.id); } });
    this.$.strip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = this.tabs.findIndex((t) => t.id === this.active);
      const next = this.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + this.tabs.length) % this.tabs.length];
      if (next) { e.preventDefault(); this.activate(next.id, { pick: true }); this.$.strip.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.focus(); }
    });
    this.render();
  }

  makeTab(id, st = {}, { adopt = false } = {}) {
    return { id, st: { url: st.url || '', title: st.title || '', loading: false, canGoBack: false, canGoForward: false, error: null, status: null }, live: false, starting: false, adopt, placed: null, gen: 0 };
  }

  /* ---------- tabs ---------- */

  /** The tab on screen. */
  cur() { return this.tabs.find((t) => t.id === this.active) || this.tabs[0]; }
  tab(id) { return this.tabs.find((t) => t.id === id) || null; }
  hasTab(id) { return this.tabs.some((t) => t.id === id); }

  // The pane interface app.js has always used reads these of the tab on screen.
  get st() { return this.cur().st; }
  get live() { return this.cur().live; }

  /** A page the shell made for this conversation becomes a tab here (at the end), shown unless asked not to. */
  addTab(id, state = null, { show = true } = {}) {
    let t = this.tab(id);
    if (!t) {
      t = this.makeTab(id, state || {});
      this.tabs.push(t);
    }
    if (state) { t.live = true; this.applyState(t, state); }
    if (show) this.activate(id); else this.render();
    return t;
  }

  /**
   * Shows tab `id`. pick: you chose it (the strip, the keyboard), so the
   * engine is told and Claude's tools act on it from now on.
   */
  activate(id, { pick = false } = {}) {
    const next = this.tab(id);
    if (!next) return;
    const prev = this.cur();
    this.active = id;
    if (prev && prev !== next) {
      // The page that was on screen goes away; the one picked comes where it was.
      prev.placed = null;
      prev.gen++;
      if (prev.live) this.cmdFor(prev, 'place', { x: 0, y: 0, w: 1, h: 1, visible: false }).catch(() => {});
      next.placed = null;
      this.$.snap.hidden = true;
    }
    if (pick) this.host.tabPicked?.(this, id);
    this.render();
    this.host.changed?.(this);
  }

  /** Closes one tab; the last one closes the pane. */
  closeTab(id) {
    const t = this.tab(id);
    if (!t) return;
    if (this.tabs.length === 1) { this.host.close(this); return; }
    const i = this.tabs.indexOf(t);
    t.gen++;
    if (t.live || t.starting || t.adopt) this.cmdFor(t, 'close').catch(() => {});
    this.tabs.splice(i, 1);
    if (this.active === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id, { pick: true });
    else { this.render(); this.host.changed?.(this); }
  }

  /** A new, empty tab: its page is made at once, and the address field takes the keyboard. */
  newTab(url = 'about:blank') {
    const id = newBrowserId();
    const t = this.makeTab(id, { url });
    this.tabs.push(t);
    this.activate(id, { pick: true });
    this.ensureLive(t);
    if (url === 'about:blank') setTimeout(() => this.$.addr.focus(), 0);
    return t;
  }

  /* ---------- the shell ---------- */

  cmdFor(t, name, args = {}) { return this.host.browser(name, { id: t.id, ...args }); }
  cmd(name, args = {}) { return this.cmdFor(this.cur(), name, args); }

  /** Makes a tab's page exist (a restored pane, the first time the tab is on screen). */
  ensureLive(t = this.cur()) {
    if (!t || t.live || t.starting || !t.st.url) return;
    t.starting = true;
    this.host.browser('open', { id: t.id, owner: this.sourcePane, url: t.st.url, adopt: t.adopt, reason: 'restore' })
      .catch((e) => { if (t === this.cur()) this.fail(String(e)); })
      .finally(() => { t.starting = false; });
  }

  /** The shell has (or made) the page for tab `id` (the pane's only one when no id is given). */
  attach(idOrState, state) {
    const [id, st] = typeof idOrState === 'string' ? [idOrState, state] : [this.cur().id, idOrState];
    const t = this.tab(id) || this.cur();
    t.live = true;
    t.placed = null;
    if (st) this.applyState(t, st);
    if (t === this.cur()) this.render(); else this.renderStrip();
  }

  applyState(t, s = {}) {
    for (const k of ['url', 'title', 'loading', 'canGoBack', 'canGoForward', 'error', 'status']) if (s[k] !== undefined) t.st[k] = s[k];
  }

  /** A state event from the shell: address, title, loading, history (for tab `id`, or the one on screen). */
  update(idOrState = {}, state) {
    const [id, s] = typeof idOrState === 'string' ? [idOrState, state || {}] : [this.cur().id, idOrState];
    const t = this.tab(id);
    if (!t) return;
    this.applyState(t, s);
    if (t === this.cur()) this.render(); else this.renderStrip();
  }

  go(text) {
    const url = addressToUrl(text);
    if (!url) return;
    const t = this.cur();
    t.st.url = url;
    this.$.addr.blur();
    if (!t.live) { this.ensureLive(t); return; }
    this.cmd('go', { url }).catch((e) => this.flash(String(e)));
    this.focusPage();
  }

  nav(action) { if (this.live) this.cmd('nav', { action }).catch((e) => this.flash(String(e))); }

  focusPage() { if (this.live) this.cmd('focus').catch(() => {}); }

  /** Focus for keyboard switching (Ctrl+1..6): into the page. */
  focusInto() { this.focusPage(); }

  /** Ctrl+L from inside the page: the keyboard comes back to Apaki's window, then the address field. */
  focusAddress() {
    this.host.browser('focusApp', {}).catch(() => {}).finally(() => { this.$.addr.focus(); });
  }

  /* ---------- where the page sits ---------- */

  /**
   * Puts the active tab's page over this pane's body, or hides it. why:
   * 'overlay' (a menu, sheet or drag needs the space: show a picture of the
   * page in its place first) or 'away' (another tab, closed). The other tabs'
   * pages stay hidden.
   */
  async place(visible, why = 'away') {
    const t = this.cur();
    if (!t.live) { if (visible) this.ensureLive(t); return; }
    const r = this.$.body.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(r.left * dpr);
    const y = Math.round(r.top * dpr);
    const rect = { x, y, w: Math.max(1, Math.round(r.right * dpr) - x), h: Math.max(1, Math.round(r.bottom * dpr) - y) };
    const on = visible && r.width > 2 && r.height > 2;
    const key = `${on}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
    if (t.placed === key) return;
    const was = t.placed?.startsWith('true');
    t.placed = key;
    const gen = ++t.gen;
    if (!on && was && why === 'overlay') {
      // A picture of the page first, so its place never goes blank under the menu.
      const s = await this.cmdFor(t, 'snapshot').catch(() => null);
      if (gen !== t.gen || t !== this.cur()) return;
      if (s?.dataUrl) { this.$.snap.src = s.dataUrl; this.$.snap.hidden = false; }
    }
    if (on) this.$.snap.hidden = true;
    await this.cmdFor(t, 'place', { ...rect, visible: on }).catch(() => {});
  }

  /* ---------- drawing ---------- */

  renderAddr() {
    if (this.editing) return;
    const u = this.st.url || '';
    this.$.addr.value = u === 'about:blank' ? '' : u;
    this.$.addr.title = u;
  }

  /** The tab strip: shown from two tabs; one row, the active tab filled, each with its initial, title and close. */
  renderStrip() {
    const many = this.tabs.length > 1;
    this.$.strip.hidden = !many;
    this.el.classList.toggle('tabbed', many);
    if (!many) { if (this.$.strip.childElementCount) this.$.strip.replaceChildren(); return; }
    const html = this.tabs.map((t) => {
      const on = t.id === this.active;
      const title = tabTitle(t.st);
      return `<button type="button" role="tab" class="web-tab${on ? ' on' : ''}${t.st.loading ? ' loading' : ''}${t.st.error ? ' failed' : ''}" data-id="${esc(t.id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}" title="${esc(title)}${t.st.url && t.st.url !== 'about:blank' ? `\n${esc(t.st.url)}` : ''}"><span class="wt-i" aria-hidden="true">${esc(tabInitial(t.st))}</span><span class="wt-t">${esc(title)}</span><span class="wt-x" role="button" aria-label="Close ${esc(title)}" title="Close tab">${ICON_X}</span></button>`;
    }).join('');
    if (html !== this.stripHtml) { this.stripHtml = html; this.$.strip.innerHTML = html; }
  }

  render() {
    const s = this.st;
    const title = tabTitle(s) === 'New tab' && !s.url ? 'Browser' : tabTitle(s);
    if (title !== this.title || this.$.title.textContent !== title) {
      this.title = title;
      this.$.title.textContent = title;
      this.$.title.title = title;
      this.host.changed?.(this);
    }
    this.renderAddr();
    this.renderStrip();
    this.$.back.disabled = !s.canGoBack;
    this.$.fwd.disabled = !s.canGoForward;
    this.$.reload.title = s.loading ? 'Stop' : 'Reload (F5)';
    this.el.classList.toggle('loading', Boolean(s.loading));
    this.el.classList.toggle('failed', Boolean(s.error));
    // Under the page while it loads; what shows when there is none.
    this.$.empty.hidden = this.live && Boolean(s.url);
    this.$.emptyT.textContent = s.url && s.url !== 'about:blank' ? `${hostOf(s.url) || s.url}${this.live ? '' : ' · opens when you look at it'}` : 'Type an address or a search above.';
  }

  /** What Claude just did here (browser_click, _type...): a line beside the title for a few seconds. */
  activity(text) {
    clearTimeout(this.actTimer);
    this.$.act.textContent = `Claude · ${text}`;
    this.$.act.classList.remove('on');
    void this.$.act.offsetWidth;
    this.$.act.classList.add('on');
    this.actTimer = setTimeout(() => this.$.act.classList.remove('on'), ACTIVITY_MS);
  }

  flash(text) { this.activity(text.replace(/^Error:\s*/, '')); }

  fail(text) {
    this.cur().live = false;
    this.$.empty.hidden = false;
    this.$.emptyT.innerHTML = `${esc(text.replace(/^Error:\s*/, ''))}`;
  }

  /** The shell closed a tab's page on its own (it could not start, or the page closed itself). */
  gone(idOrWhy, why) {
    const [id, text] = typeof idOrWhy === 'string' && this.hasTab(idOrWhy) ? [idOrWhy, why] : [this.cur().id, idOrWhy];
    const t = this.tab(id);
    if (!t) return;
    t.live = false;
    t.placed = null;
    if (t === this.cur()) this.fail(text || 'This page was closed.');
  }

  /** The shell closed a tab's page for good (browser_tabs close, a page that closed itself): the tab goes. */
  removeTab(id) {
    const t = this.tab(id);
    if (!t) return;
    t.live = false;
    t.adopt = false;
    t.starting = false;
    this.closeTab(id);
  }

  /** What the workspace saves for this pane: the tab on screen at the top (older readers), and every tab. */
  saved() {
    const c = this.cur().st;
    return { url: c.url, title: c.title, owner: this.sourcePane, tabs: this.tabs.map((t) => ({ id: t.id, url: t.st.url, title: t.st.title })), active: this.active };
  }

  // The pane interface app.js uses; a browser has no conversation behind it.
  handle() {}
  note() {}
  engineLost() {}
  engineBack() {}
  setVoice() {}
  renderFolderSelect() {}
  open() {}

  destroy() {
    // adopt: the shell may still hold this page from before a reload of the window.
    for (const t of this.tabs) {
      t.gen++;
      if (t.live || t.starting || t.adopt) this.cmdFor(t, 'close').catch(() => {});
      t.live = false;
    }
    this.el.remove();
  }
}
