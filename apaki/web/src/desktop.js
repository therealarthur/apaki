/**
 * desktop.js: "On your desktop" on the phone's sessions list (2026-10-11,
 * Claude Code, Opus 5.5, for Arthur). Arthur: "it doesnt display the tabs and
 * the screens/windows in the tabs that are open on the desktop app. that
 * should be displayed as well."
 *
 * The PC sends every phone the desktop window's tabs and the panes in each
 * (engine desktop-tabs.js, event desktopTabs, cached for phones that connect
 * later; shim.js onDesktopTabs keeps the last one). This draws them at the top
 * of the list, under the search field (web.css, "On your desktop"):
 *
 *   - a header row, "On your desktop", with how many tabs and how many are
 *     working; tapping it folds the section (remembered on this phone);
 *   - one card per tab, the tab in front first ("In front"), then the others
 *     in the desktop's order, each with its panes in layout order; past two
 *     tabs a "Show N more tabs" row, so the phone's own list stays close;
 *   - a conversation is a row with a chevron: a tap opens it on the phone the
 *     way a tap in the session list does (app.js openFromRail) and slides the
 *     conversation in. Working: Apaki's live grid and "Working" in the brand
 *     colour (no dot). The pane the PC shows now: "On screen". Open on this
 *     phone already: "Open here".
 *   - browsers, task viewers, artifact viewers and conversations not started
 *     yet are quiet one-line rows, their kind at the right, no chevron: they
 *     cannot open here.
 *
 * Hidden while the list is searched, and when the desktop has no panes. The
 * desktop window never runs this file (native.js calls it on the phone only).
 * Opening a conversation a desktop pane holds follows the engine's rules
 * (today the phone takes it over, the desktop pane says so); this list only
 * asks to open it. A PC that lists 'follow' in hello gets op follow instead
 * (app.js followDesktop): the phone shows that desktop pane live without
 * taking it over ("Watching" on its row, a bar with Take over in the pane),
 * "View only" with No shell or Chat only.
 */

import { onDesktopTabs } from './shim.js';
import { effortGrid } from './menu.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FOLD_KEY = 'apaki.desk.v1';
/** Tabs shown before "Show N more tabs" (the tab in front and the next one; the phone's own list comes right after). */
export const DESK_TABS_SHOWN = 2;

const KIND_WORD = { browser: 'Browser', task: 'Task', viewer: 'Viewer' };

const GLYPH = {
  session: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.6c0-1 .8-1.8 1.8-1.8h6.8c1 0 1.8.8 1.8 1.8v4.6c0 1-.8 1.8-1.8 1.8H7.2L4.4 13.2V11h0c-.9-.1-1.6-.9-1.6-1.8z"/></svg>',
  browser: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M2.6 8h10.8M8 2.4c1.6 1.6 2.3 3.5 2.3 5.6S9.6 12 8 13.6M8 2.4C6.4 4 5.7 5.9 5.7 8s.7 4 2.3 5.6"/></svg>',
  task: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.2"/><path d="M5.2 6.2h5.6M5.2 9.8h3.4"/></svg>',
  viewer: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 1.9h4.9l3 3v8.4c0 .5-.4.9-.9.9H4.4c-.5 0-.9-.4-.9-.9V2.8c0-.5.4-.9.9-.9z"/><path d="M9.2 1.9v3.1h3"/></svg>',
};
const CHEV = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>';

/**
 * The section's content from a desktopTabs event: tabs with panes only, the
 * tab in front first, the rest in the desktop's order; how many are hidden
 * behind "Show more"; counts for the header. Pure (exported for tests).
 *   openHere(sessionId) -> true when this phone has that conversation open.
 */
export function deskModel(tabs, { expanded = false, shown = DESK_TABS_SHOWN, openHere = () => false, watching = () => false } = {}) {
  const list = (Array.isArray(tabs) ? tabs : [])
    .filter((t) => Array.isArray(t?.panes) && t.panes.length)
    .map((t) => ({
      index: Number(t.index) || 0,
      active: Boolean(t.active),
      rows: t.panes.map((p) => {
        const kind = ['session', 'browser', 'task', 'viewer'].includes(p?.kind) ? p.kind : 'viewer';
        const go = kind === 'session' && typeof p.sessionId === 'string' && p.sessionId.length > 0;
        const busy = kind === 'session' && Boolean(p.busy);
        const here = go && openHere(p.sessionId);
        // This phone follows this desktop pane (the shared view): "Watching", said beside "Working" when both are true.
        const watched = go && typeof p.paneId === 'string' && p.paneId.length > 0 && Boolean(watching(p.paneId));
        const meta = busy ? (watched ? 'Working · Watching' : 'Working') : watched ? 'Watching' : here ? 'Open here' : p.focused && t.active ? 'On screen' : kind === 'session' ? (go ? '' : 'Not started') : KIND_WORD[kind];
        // paneId (2026-10-11): the desktop pane's own id, which a phone can follow without taking it over.
        return { kind, go, busy, sessionId: go ? p.sessionId : null, paneId: typeof p.paneId === 'string' && p.paneId ? p.paneId : null, title: String(p.title || (kind === 'session' ? 'New conversation' : KIND_WORD[kind])).trim(), meta, focused: Boolean(p.focused) };
      }),
    }));
  list.sort((a, b) => (b.active - a.active) || (a.index - b.index));
  const visible = expanded ? list : list.slice(0, shown);
  const working = list.reduce((n, t) => n + t.rows.filter((r) => r.busy).length, 0);
  return { tabs: visible, hidden: list.length - visible.length, total: list.length, working, panes: list.reduce((n, t) => n + t.rows.length, 0) };
}

/** "3 tabs · 1 working" for the header. Pure (exported for tests). */
export function deskSummary(m) {
  return `${m.total} tab${m.total === 1 ? '' : 's'}${m.working ? ` · ${m.working} working` : ''}`;
}

export function initDesktop({ haptic = () => {}, showChat = () => {} } = {}) {
  const scroll = document.querySelector('.rail .ios-scroll');
  const A = window.__apaki;
  if (!scroll || document.querySelector('.desk')) return false;
  const sec = document.createElement('section');
  sec.className = 'desk';
  sec.hidden = true;
  sec.setAttribute('aria-label', 'On your desktop');
  const find = scroll.querySelector('.rail-find');
  if (find) find.after(sec); else scroll.prepend(sec);

  const D = { ev: null, expanded: false, folded: false };
  try { D.folded = localStorage.getItem(FOLD_KEY) === 'folded'; } catch { /* no storage */ }
  const searching = () => Boolean($('q')?.value.trim());
  // A pane that follows a desktop pane has the conversation's session id too, but it is not "open here": it is "Watching".
  const openHere = (id) => [...(A?.S?.panes?.values() || [])].some((p) => p.sessionId === id && !p.following);
  const watching = (paneId) => [...(A?.S?.panes?.values() || [])].some((p) => p.following === paneId);
  // The desktop pane that has a conversation open (its id, which a phone can follow), for the Session in use card's Watch live (app.js).
  if (A) {
    A.deskPaneFor = (sessionId) => {
      for (const t of D.ev?.tabs || []) for (const p of t?.panes || []) if (p?.kind === 'session' && p.sessionId === sessionId && typeof p.paneId === 'string' && p.paneId) return p.paneId;
      return null;
    };
  }

  function row(r) {
    const meta = r.meta && r.go ? `<span class="desk-m">${r.busy ? effortGrid('max', { live: true }) : ''}${esc(r.meta)}</span>` : '';
    // A quiet row says its kind on the same line, at the right.
    const kind = !r.go && r.meta ? `<span class="desk-kind">${esc(r.meta)}</span>` : '';
    const inner = `<span class="desk-g">${GLYPH[r.kind]}</span><span class="desk-t"><span class="desk-name">${esc(r.title)}</span>${meta}</span>${kind}`;
    const cls = `desk-row${r.busy ? ' busy' : ''}${r.meta === 'On screen' ? ' front' : ''}`;
    return r.go
      ? `<li><button type="button" class="${cls} go" data-sid="${esc(r.sessionId)}"${r.paneId ? ` data-pane="${esc(r.paneId)}"` : ''} data-title="${esc(r.title)}" aria-label="Open ${esc(r.title)} on this phone${r.busy ? ', working' : ''}">${inner}</button></li>`
      : `<li><div class="${cls} quiet">${inner}</div></li>`;
  }

  function render() {
    const tabs = D.ev?.tabs;
    const m = deskModel(tabs, { expanded: D.expanded, openHere, watching });
    sec.hidden = !m.total || searching();
    if (sec.hidden) return;
    sec.classList.toggle('folded', D.folded);
    const cards = m.tabs.map((t) => `<div class="desk-tab${t.active ? ' front' : ''}">
        <div class="desk-tab-h"><span class="desk-tab-t">Tab ${t.index + 1}</span>${t.active ? '<span class="desk-front">In front</span>' : ''}<span class="desk-tab-n">${t.rows.length} pane${t.rows.length === 1 ? '' : 's'}</span></div>
        <ul class="desk-rows">${t.rows.map(row).join('')}</ul>
      </div>`).join('');
    const more = m.hidden ? `<button type="button" class="desk-more">Show ${m.hidden} more tab${m.hidden === 1 ? '' : 's'}</button>` : D.expanded && m.total > DESK_TABS_SHOWN ? '<button type="button" class="desk-more">Show fewer</button>' : '';
    const html = `<button type="button" class="desk-head" aria-expanded="${!D.folded}"><span class="desk-k">On your desktop</span><span class="desk-n">${esc(deskSummary(m))}</span>${CHEV}</button>
      <div class="desk-body"${D.folded ? ' hidden' : ''}>${cards}${more}</div>`;
    // Only when something changed: a row replaced under a finger would lose its tap.
    if (html !== D.html) { D.html = html; sec.innerHTML = html; }
  }

  sec.addEventListener('click', (e) => {
    if (e.target.closest('.desk-head')) {
      D.folded = !D.folded;
      try { localStorage.setItem(FOLD_KEY, D.folded ? 'folded' : 'open'); } catch { /* no storage */ }
      haptic();
      render();
      return;
    }
    if (e.target.closest('.desk-more')) { D.expanded = !D.expanded; render(); return; }
    const go = e.target.closest('.desk-row.go');
    if (!go || typeof A?.openFromRail !== 'function') return;
    haptic();
    const id = go.dataset.sid;
    // A PC that offers 'follow' shows its pane here without taking it over; with No shell or Chat only access the phone
    // may watch, not send ("View only"). A conversation this phone already holds as its own pane just shows that pane
    // (the desktop's is stopped, so there is nothing to follow). Any other PC: the session list's own open path.
    const link = window.__apakiLink;
    if (go.dataset.pane && !openHere(id) && link?.supports?.('follow') && typeof A.followDesktop === 'function') {
      A.followDesktop({ desktopPaneId: go.dataset.pane, title: go.dataset.title || '', viewOnly: (link.cap?.() || 'full') !== 'full' });
      showChat();
      return;
    }
    // The session list's own record when it has one (title, folder); otherwise what the desktop said.
    const s = A.S?.sessions?.find((x) => x.id === id) || { id, title: go.dataset.title || '', cwd: null };
    A.openFromRail(s, {});
    showChat();
  });

  onDesktopTabs((ev) => { D.ev = ev; render(); });
  $('q')?.addEventListener('input', render);
  // "Open here" follows the phone's own panes (app.js re-renders its hidden tab bar on every change).
  const tabsBar = $('tabs');
  if (tabsBar) new MutationObserver(() => { if (D.ev) render(); }).observe(tabsBar, { childList: true });
  return true;
}
