/**
 * sidepanel.js: the side panel of one Apaki tab, the DOM part (the rules are in
 * workspace.js; app.js decides what it shows and mounts the viewers in it).
 *
 * WHY (Arthur, 2026-10-13): "the current way we display the browser is
 * incredibly hectic ... i dont know what browser is connected to what session
 * ... have a dedicated pane that comes out from the right side of the app
 * (that can be minimized and opened, that has all the browsers that are opened
 * - that pane should have tabs of all the browsers for all the panes that are
 * in that main tab ... when clicking on a session, it switches the tab in the
 * browser pane to the browser(s) specific to that session". And earlier: the
 * session's window should show "art, spreadsheets, real browser, code, etc",
 * so the panel holds everything a conversation opens: browser pages, artifacts,
 * changes, subagent and shell viewers.
 *
 * Layout, top to bottom:
 *   the switcher   one button per conversation of the tab that has something
 *                  open, its name in that conversation's accent (app.css .acc-N,
 *                  the same accent its header's link mark has), the count
 *                  beside it; Other for things whose conversation is gone
 *   a quiet note   when the focused conversation has nothing open and the
 *                  panel keeps showing another's
 *   the entries    that conversation's things as tabs: every browser page its
 *                  own tab, then artifacts, changes, tasks; close per tab, a
 *                  middle click closes, Close all for the conversation
 *   the body       the viewers themselves (app.js mounts their elements here;
 *                  only the current one is displayed, the others stay alive)
 * Collapsed, the panel is a slim rail: the open button, then one square per
 * conversation with its count in its accent. Its left edge drags to resize
 * (double-click for the default width; dragged nearly shut, it collapses).
 *
 * The panel never decides anything: every click goes to `actions`
 * (pickGroup, pickEntry, closeEntry, closeGroup, toggle, resize, resetWidth,
 * hoverGroup, menu), and render(model) draws what app.js says. Each part is
 * drawn again only when its HTML changed, so frequent renders cost nothing.
 */

import { esc } from './markdown.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

/** Collapse while dragging the edge below this share of the smallest width. */
const COLLAPSE_SHARE = 0.6;

const ICON_X = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
/** The panel drawn small, its right column filled (open) or empty with an arrow (collapse). */
const ICON_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M9.5 2.5v11M7 6 5 8l2 2"/></svg>';
const ICON_HIDE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M9.5 2.5v11M5 6l2 2-2 2"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.4" cy="8" r="1.1"/></svg>';

export class SidePanel {
  /**
   * actions: { pickGroup(key), pickEntry(entry), closeEntry(entry), closeGroup(key), toggle(open), resize(width, done),
   * resetWidth(), hoverGroup(key, on), menu(anchor) }. An entry is { key, item, page }.
   */
  constructor(actions = {}) {
    this.actions = actions;
    this.model = null;
    this.shown = null;
    this.html = { sessions: '', items: '', rail: '', note: '' };
    this.el = el('aside', 'side-panel');
    this.el.dataset.state = 'none';
    this.el.setAttribute('aria-label', 'Side panel: what this tab\'s conversations opened');
    this.el.innerHTML = `
      <div class="sp-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize the side panel. Double-click for the default width; drag it nearly shut to collapse it."></div>
      <div class="sp-card">
        <div class="sp-rail">
          <button type="button" class="icon-btn sp-open-btn" aria-label="Open the side panel">${ICON_OPEN}</button>
          <div class="sp-rail-list"></div>
        </div>
        <div class="sp-main">
          <header class="sp-head">
            <div class="sp-sessions" role="tablist" aria-label="Conversations with something open"></div>
            <button type="button" class="icon-btn sp-more" aria-label="More" aria-haspopup="menu">${ICON_MORE}</button>
            <button type="button" class="icon-btn sp-hide" aria-label="Collapse the side panel">${ICON_HIDE}</button>
          </header>
          <div class="sp-note" hidden></div>
          <div class="sp-items" role="tablist" aria-label="Open in this conversation"></div>
          <div class="sp-body"></div>
        </div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = {
      resize: q('.sp-resize'), rail: q('.sp-rail-list'), open: q('.sp-open-btn'), sessions: q('.sp-sessions'), more: q('.sp-more'),
      hide: q('.sp-hide'), note: q('.sp-note'), items: q('.sp-items'), body: q('.sp-body'), main: q('.sp-main'),
    };
    this.$.open.title = 'Open the side panel (Ctrl+Shift+B)';
    this.$.hide.title = 'Collapse the side panel (Ctrl+Shift+B)';
    this.$.more.title = 'More: close everything here, collapse';
    this.wire();
  }

  /** The entry of the model with this key (in the group shown). */
  entry(key) { return this.model?.entries?.find((e) => e.key === key) || null; }

  wire() {
    const $ = this.$;
    $.open.onclick = () => this.actions.toggle?.(true);
    $.hide.onclick = () => this.actions.toggle?.(false);
    $.more.onclick = () => this.actions.menu?.($.more);
    $.sessions.addEventListener('click', (e) => { const b = e.target.closest('.sp-sess'); if (b) this.actions.pickGroup?.(b.dataset.key); });
    $.rail.addEventListener('click', (e) => { const b = e.target.closest('.sp-rail-g'); if (b) this.actions.pickGroup?.(b.dataset.key, { open: true }); });
    // Hovering a conversation's name (or its square on the rail) rings that conversation's pane.
    for (const list of [$.sessions, $.rail]) {
      list.addEventListener('pointerover', (e) => { const b = e.target.closest('[data-key]'); if (b && b.dataset.key !== this.hover) { this.hoverOut(); this.hover = b.dataset.key; this.actions.hoverGroup?.(this.hover, true); } });
      list.addEventListener('pointerleave', () => this.hoverOut());
      list.addEventListener('focusin', (e) => { const b = e.target.closest('[data-key]'); if (b) { this.hoverOut(); this.hover = b.dataset.key; this.actions.hoverGroup?.(this.hover, true); } });
      list.addEventListener('focusout', () => this.hoverOut());
    }
    $.items.addEventListener('click', (e) => {
      if (e.target.closest('.sp-closeall')) { if (this.model?.group) this.actions.closeGroup?.(this.model.group); return; }
      const b = e.target.closest('.sp-item');
      if (!b) return;
      const en = this.entry(b.dataset.key);
      if (!en) return;
      if (e.target.closest('.sp-x')) { e.stopPropagation(); this.actions.closeEntry?.(en); return; }
      this.actions.pickEntry?.(en);
    });
    // A middle click closes a tab, as in a browser.
    $.items.addEventListener('auxclick', (e) => { const b = e.target.closest('.sp-item'); if (b && e.button === 1) { e.preventDefault(); const en = this.entry(b.dataset.key); if (en) this.actions.closeEntry?.(en); } });
    $.items.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target.closest('.sp-item')) e.preventDefault(); });
    // Arrows move along the tabs and the switcher, Delete closes the tab with the keyboard.
    const arrows = (list, sel, go) => list.addEventListener('keydown', (e) => {
      const all = [...list.querySelectorAll(sel)];
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
        go(next);
        requestAnimationFrame(() => list.querySelector(`${sel}[data-key="${CSS.escape(next.dataset.key)}"]`)?.focus());
      } else if (e.key === 'Delete' && sel === '.sp-item') {
        e.preventDefault();
        const en = this.entry(all[i].dataset.key);
        if (en) this.actions.closeEntry?.(en);
      }
    });
    arrows($.items, '.sp-item', (b) => { const en = this.entry(b.dataset.key); if (en) this.actions.pickEntry?.(en); });
    arrows($.sessions, '.sp-sess', (b) => this.actions.pickGroup?.(b.dataset.key));
    this.wireResize();
  }

  hoverOut() {
    if (!this.hover) return;
    this.actions.hoverGroup?.(this.hover, false);
    this.hover = null;
  }

  /** Dragging the left edge: wider to the left, narrower to the right; nearly shut, it collapses. */
  wireResize() {
    const h = this.$.resize;
    h.addEventListener('dblclick', () => this.actions.resetWidth?.());
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.el.dataset.state !== 'open') return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const right = this.el.getBoundingClientRect().right;
      const min = this.model?.min || 320;
      document.body.classList.add('sp-dragging');
      let last = null;
      const move = (ev) => {
        const w = Math.round(right - ev.clientX);
        if (w < min * COLLAPSE_SHARE) { end(); this.actions.toggle?.(false); return; }
        last = w;
        this.actions.resize?.(w, false);
      };
      const end = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', end);
        h.removeEventListener('pointercancel', end);
        document.body.classList.remove('sp-dragging');
        if (last !== null) this.actions.resize?.(last, true);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', end);
      h.addEventListener('pointercancel', end);
    });
  }

  /** Puts a viewer's element in the body (once: moving an element would reload a frame inside it). */
  mount(node) {
    if (node && node.parentElement !== this.$.body) this.$.body.append(node);
  }

  /**
   * Draws the panel. model: { state: 'open' | 'rail' | 'none', width, min, groups: [{ key, label, acc, count, tip,
   * fresh }], group, entries: [{ key, item, page, title, mark, tip, loading, failed }], entry, note, focused }.
   * shown: the item id whose element is displayed (the others stay mounted, hidden).
   */
  render(model) {
    const prevState = this.el.dataset.state;
    this.model = model;
    const state = model.state || 'none';
    if (prevState !== state) {
      this.el.dataset.state = state;
      // Opening (from the rail, or the first thing in the tab): its content fades in once (app.css sp-in, none with reduced motion).
      if (state === 'open') {
        this.el.classList.remove('sp-opening');
        clearTimeout(this.openTimer);
        requestAnimationFrame(() => { this.el.classList.add('sp-opening'); this.openTimer = setTimeout(() => this.el.classList.remove('sp-opening'), 220); });
      }
    }
    this.el.style.width = state === 'open' ? `${model.width}px` : '';
    this.el.classList.toggle('focused', Boolean(model.focused));
    const groups = model.groups || [];
    const sess = groups.map((g) => {
      const on = g.key === model.group;
      return `<button type="button" role="tab" class="sp-sess${on ? ' on' : ''}${g.fresh ? ' fresh' : ''}${Number.isInteger(g.acc) ? ` acc-${g.acc}` : ' acc-none'}" data-key="${esc(g.key)}" aria-selected="${on}" tabindex="${on ? 0 : -1}" title="${esc(g.tip || g.label)}"><span class="sp-sess-t">${esc(g.label)}</span><span class="sp-sess-n" aria-label="${g.count} open">${g.count}</span></button>`;
    }).join('');
    if (sess !== this.html.sessions) {
      this.html.sessions = sess;
      this.$.sessions.innerHTML = sess;
      this.$.sessions.querySelector('.sp-sess.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const rail = groups.map((g) => `<button type="button" class="sp-rail-g${g.key === model.group ? ' on' : ''}${g.fresh ? ' fresh' : ''}${Number.isInteger(g.acc) ? ` acc-${g.acc}` : ' acc-none'}" data-key="${esc(g.key)}" title="${esc(g.tip || g.label)}" aria-label="${esc(g.label)}: ${g.count} open. Open the side panel on it"><span class="sp-rail-i" aria-hidden="true">${esc(g.initial || '·')}</span><span class="sp-rail-n">${g.count}</span></button>`).join('');
    if (rail !== this.html.rail) { this.html.rail = rail; this.$.rail.innerHTML = rail; }
    const entries = model.entries || [];
    const items = entries.map((e) => {
      const on = e.key === model.entry;
      return `<button type="button" role="tab" class="sp-item k-${esc(e.kind || 'artifact')}${on ? ' on' : ''}${e.loading ? ' loading' : ''}${e.failed ? ' failed' : ''}" data-key="${esc(e.key)}" aria-selected="${on}" tabindex="${on ? 0 : -1}" title="${esc(e.tip || e.title)}"><span class="sp-ic" aria-hidden="true">${e.mark || ''}</span><span class="sp-it">${esc(e.title)}</span><span class="sp-x" role="button" aria-label="Close ${esc(e.title)}" title="Close (middle click)">${ICON_X}</span></button>`;
    }).join('') + (entries.length > 1 ? `<button type="button" class="sp-closeall" title="Close everything open for ${esc(model.groupLabel || 'this conversation')}">Close all</button>` : '');
    if (items !== this.html.items) {
      this.html.items = items;
      this.$.items.innerHTML = items;
      this.$.items.querySelector('.sp-item.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const note = model.note || '';
    if (note !== this.html.note) { this.html.note = note; this.$.note.textContent = note; this.$.note.hidden = !note; }
    this.show(model.shown || null);
  }

  /** Displays the element of viewer `id` (data-pane) and hides the others, which keep running. */
  show(id) {
    if (this.shown === id && (!id || this.$.body.querySelector(`:scope > .sp-on[data-pane="${CSS.escape(id)}"]`))) return;
    this.shown = id;
    for (const c of this.$.body.children) c.classList.toggle('sp-on', Boolean(id) && c.dataset.pane === id);
  }

  /** A conversation's name in the switcher and on the rail, lit while its pane is hovered (the other end of the link). */
  hi(key, on) {
    for (const b of this.el.querySelectorAll(`[data-key="${CSS.escape(String(key))}"]`)) if (b.classList.contains('sp-sess') || b.classList.contains('sp-rail-g')) b.classList.toggle('link-hi', on);
  }

  destroy() { this.hoverOut(); this.el.remove(); }
}
