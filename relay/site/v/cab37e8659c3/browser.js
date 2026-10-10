/**
 * browser.js: the browser pane in Myrlin Apaki's window.
 *
 * WHY (Arthur, 2026-10-09: "a built-in browser like Codex's, driven by
 * Claude, light and fast"): web pages open beside the conversation that
 * asked for them, in a pane like the others (grip, split, resize, close,
 * comes back with the workspace), and Claude can use the same page through
 * its browser tools while the user watches.
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
 * shortcut(key, shift), paneTitle(id).
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

let seq = 0;
export const newBrowserId = () => `b${Date.now().toString(36)}${(++seq).toString(36)}`;

export class BrowserPane {
  /**
   * o: { owner, url, title, state? }. A pane made from the saved workspace
   * has no page yet: it asks the shell for one the first time it shows.
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
    this.live = false;
    this.starting = false;
    this.adopt = Boolean(o.adopt);
    this.placed = null;
    this.gen = 0;
    this.st = { url: o.url || '', title: o.title || '', loading: false, canGoBack: false, canGoForward: false, error: null, status: null };
    this.title = o.title || hostOf(o.url) || 'Browser';
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
        <button class="icon-btn outside" title="Open in your browser"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg></button>
        <button class="icon-btn close" title="Close browser (Ctrl+W)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
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
      ground: q('.web-ground'), input: null,
    };
    this.el.addEventListener('pointerdown', () => host.focus(this), true);
    this.$.close.onclick = () => host.close(this);
    this.$.back.onclick = () => this.nav('back');
    this.$.fwd.onclick = () => this.nav('forward');
    this.$.reload.onclick = () => this.nav(this.st.loading ? 'stop' : 'reload');
    q('.outside').onclick = () => { if (/^https?:/i.test(this.st.url)) host.openOutside(this.st.url); };
    this.$.form.onsubmit = (e) => { e.preventDefault(); this.go(this.$.addr.value); };
    this.$.addr.addEventListener('focus', () => { this.editing = true; this.$.addr.value = this.st.url || ''; this.$.addr.select(); });
    this.$.addr.addEventListener('blur', () => { this.editing = false; this.renderAddr(); });
    this.$.addr.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this.$.addr.blur(); this.focusPage(); } });
    this.$.grip.addEventListener('dragstart', (e) => host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => host.dragEnd());
    this.render();
  }

  /* ---------- the shell ---------- */

  cmd(name, args = {}) { return this.host.browser(name, { id: this.id, ...args }); }

  /** Makes the page exist (a restored pane, the first time it is on screen). */
  ensureLive() {
    if (this.live || this.starting || !this.st.url) return;
    this.starting = true;
    this.host.browser('open', { id: this.id, owner: this.sourcePane, url: this.st.url, adopt: this.adopt, reason: 'restore' })
      .catch((e) => this.fail(String(e)))
      .finally(() => { this.starting = false; });
  }

  /** The shell has (or made) the page for this pane. */
  attach(state) {
    this.live = true;
    this.placed = null;
    if (state) this.update(state);
  }

  /** A state event from the shell: address, title, loading, history. */
  update(s = {}) {
    for (const k of ['url', 'title', 'loading', 'canGoBack', 'canGoForward', 'error', 'status']) if (s[k] !== undefined) this.st[k] = s[k];
    this.render();
  }

  go(text) {
    const url = addressToUrl(text);
    if (!url) return;
    this.st.url = url;
    this.$.addr.blur();
    if (!this.live) { this.ensureLive(); return; }
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
   * Puts the page over this pane's body, or hides it. why: 'overlay' (a
   * menu, sheet or drag needs the space: show a picture of the page in its
   * place first) or 'away' (another tab, closed).
   */
  async place(visible, why = 'away') {
    if (!this.live) { if (visible) this.ensureLive(); return; }
    const r = this.$.body.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(r.left * dpr);
    const y = Math.round(r.top * dpr);
    const rect = { x, y, w: Math.max(1, Math.round(r.right * dpr) - x), h: Math.max(1, Math.round(r.bottom * dpr) - y) };
    const on = visible && r.width > 2 && r.height > 2;
    const key = `${on}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
    if (this.placed === key) return;
    const was = this.placed?.startsWith('true');
    this.placed = key;
    const gen = ++this.gen;
    if (!on && was && why === 'overlay') {
      // A picture of the page first, so its place never goes blank under the menu.
      const s = await this.cmd('snapshot').catch(() => null);
      if (gen !== this.gen) return;
      if (s?.dataUrl) { this.$.snap.src = s.dataUrl; this.$.snap.hidden = false; }
    }
    await this.cmd('place', { ...rect, visible: on }).catch(() => {});
  }

  /* ---------- drawing ---------- */

  renderAddr() {
    if (this.editing) return;
    const u = this.st.url || '';
    this.$.addr.value = u === 'about:blank' ? '' : u;
    this.$.addr.title = u;
  }

  render() {
    const s = this.st;
    const title = s.title && s.title !== s.url ? s.title : hostOf(s.url) || 'Browser';
    if (title !== this.title || this.$.title.textContent !== title) {
      this.title = title;
      this.$.title.textContent = title;
      this.$.title.title = title;
      this.host.changed?.(this);
    }
    this.renderAddr();
    this.$.back.disabled = !s.canGoBack;
    this.$.fwd.disabled = !s.canGoForward;
    this.$.reload.title = s.loading ? 'Stop' : 'Reload (F5)';
    this.el.classList.toggle('loading', Boolean(s.loading));
    this.el.classList.toggle('failed', Boolean(s.error));
    // Under the page while it loads; what shows when there is none.
    this.$.empty.hidden = this.live && Boolean(s.url);
    this.$.emptyT.textContent = s.url ? `${hostOf(s.url) || s.url}${this.live ? '' : ' · opens when you look at it'}` : 'Type an address or a search above.';
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
    this.live = false;
    this.$.empty.hidden = false;
    this.$.emptyT.innerHTML = `${esc(text.replace(/^Error:\s*/, ''))}`;
  }

  /** The shell closed the page on its own (it could not start, or the page closed itself). */
  gone(why) { this.live = false; this.placed = null; this.fail(why || 'This page was closed.'); }

  /** What the workspace saves for this pane. */
  saved() { return { url: this.st.url, title: this.st.title, owner: this.sourcePane }; }

  // The pane interface app.js uses; a browser has no conversation behind it.
  handle() {}
  note() {}
  engineLost() {}
  engineBack() {}
  setVoice() {}
  renderFolderSelect() {}
  open() {}

  destroy() {
    this.gen++;
    // adopt: the shell may still hold this page from before a reload of the window.
    if (this.live || this.starting || this.adopt) this.cmd('close').catch(() => {});
    this.live = false;
    this.el.remove();
  }
}
