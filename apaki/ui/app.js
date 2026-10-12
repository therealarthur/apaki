/**
 * app.js: Myrlin Apaki's window. Talks to the engine (apaki/engine/engine.js)
 * through the Rust shell: `engine_send` sends a command, `engine` events bring
 * everything back. The engine is latch's Claude Code runner, so a turn here is
 * a turn in the Claude Code session itself.
 *
 * Since 2026-10-09 (Arthur: a ding when any session comes back, several tabs,
 * drag sessions in to split up to six resizable panes) the window holds TABS,
 * each with a split LAYOUT of up to six PANES (pane.js), each pane its own
 * session with its own Claude Code process in the engine. The layout is a tree
 * (layout-tree.js); this file renders it, with draggable gutters between panes.
 *
 * Sessions from the rail:
 *   click        open in the focused pane (or focus the pane that has it)
 *   Ctrl+click   open in a new tab (middle click too)
 *   Shift+click  split it to the right of the focused pane
 *   drag         drop on a pane's edge to split, in its middle to replace it,
 *                on a tab to add it there, on + for a new tab
 * Panes move by dragging the grip at the left of their header.
 * Keys: Ctrl+T new tab, Ctrl+W close pane, Ctrl+Tab next tab, Ctrl+1..6 pane.
 *
 * The tabs and layout are saved in localStorage and come back at launch;
 * restored panes start Claude Code on their first message.
 *
 * Browser panes (2026-10-09, browser.js): web pages open in a built-in
 * browser pane beside the conversation that asked (Claude's browser_open,
 * show with a URL, a caught "start https://...", BROWSER, or a link card's
 * Open). The page is a native WebView2 the shell lays over the pane's body;
 * syncBrowsers() below tells it where the body is and hides it (with a
 * picture in its place) while a menu, a sheet or a drag needs the space.
 */

import { esc, md } from './markdown.js';
import * as L from './layout-tree.js';
import { Pane, short } from './pane.js';
import { closeMenu, menu } from './menu.js';
import { arm, ding, setSoundOn, soundOn } from './sound.js';
import { MARK_SVG } from './mark.js';
import { folderSheet } from './startfolder.js';
import { initGlassCard } from './glasscard.js';
import { initSettings } from './settings.js';
import { findStep, openFind } from './find.js';
// The permission sheet (Allow once, Always allow, Deny) for a tool Claude Code asks about (permission.js, 2026-10-12).
import { ARM_MS, denyLabel, permissionHtml, permissionKey, permissionReply, permissionView } from './permission.js';
import { DRAG_TASK, KIND_LABEL, TaskPane, closeTasksPanel, newTaskViewerId, specKey, taskGlyph, tasksPanel, tasksPanelPane } from './tasks.js';
// Codex panes and rows (codex.js, 2026-10-12).
import { CARD_ONLY_VIA } from './codex.js';
import { ArtifactPane, isPublicWebUrl, newViewerId } from './artifacts.js';
import { BrowserPane } from './browser.js';
// Git worktrees (2026-10-12): the branch label, the Worktrees view, the actions, and the diff viewer.
import { GLYPH_WORKTREE, branchName, hasLinked, initWorktrees } from './worktree.js';
import { DiffPane, newDiffViewerId } from './diff.js';
import { initTooltips } from './tooltip.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
// The phone web client (apaki/web) runs this same file over the relay; it
// sets apakiShell to 'web' and has no Phone sheet of its own.
const WEB = window.apakiShell === 'web';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

const SEARCH_DEBOUNCE_MS = 160;
const SAVE_KEY = 'apaki.workspace.v1';
const GUTTER_PX = 6;
// Smallest a pane can be dragged to; "resizable at any size" within reason.
const MIN_PANE_W = 150;
const MIN_PANE_H = 110;
const EDGE_ZONE = 0.28; // share of a pane's width or height that counts as its edge when dropping
const TAB_HOVER_SWITCH_MS = 450;
const DRAG_SESSION = 'application/x-apaki-session';
const DRAG_PANE = 'application/x-apaki-pane';
// A tab dragged along the tab bar to a new place (2026-10-11).
const DRAG_TAB = 'application/x-apaki-tab';
// Most panes of any kind in one tab's layout: conversations count to L.MAX_PANES, viewers, browsers and tasks
// come on top up to this many (Arthur, 2026-10-11: a tab's number of panes counts conversations, not viewers).
const MAX_LEAVES = 10;

const S = {
  warm: new Set(), // sessions keep-warm is looking after (engine 'warm' events)
  expanded: new Set(), // rail rows showing their subagents
  subs: new Map(), // sessionId -> { agents, shells, at } from the engine's subagents op
  sessions: [], folders: [], view: 'all', query: '', results: null, searchInfo: '', ai: null, asking: null, lastSearch: null,
  voice: false, seq: 0, engineLost: false,
  defaults: { model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions', billing: null },
  tabs: [], active: null, panes: new Map(), drag: null,
  // Codex (2026-10-12): installed here (the engine's ready event), and the model list it read (event codexModels).
  codexAvailable: false, codex: null,
};

/**
 * "Reconnecting to the engine" as one quiet banner at the top of the window while the window has no engine, and gone
 * the moment it is back (the next ready). Shown only after 1.5 s, so a reconnect that takes a blink shows nothing.
 */
let bannerTimer = null;
function engineBanner(on) {
  let b = document.getElementById('engineBanner');
  if (!on) { clearTimeout(bannerTimer); bannerTimer = null; if (b) b.hidden = true; return; }
  if (bannerTimer || (b && !b.hidden)) return;
  bannerTimer = setTimeout(() => {
    bannerTimer = null;
    if (!S.engineLost) return;
    if (!b) {
      b = document.createElement('div');
      b.id = 'engineBanner';
      b.className = 'engine-banner';
      b.setAttribute('role', 'status');
      document.body.append(b);
    }
    // An update moving the engine to the new build (engineRestarting) reads differently from a lost connection.
    b.textContent = S.engineUpdating
      ? 'Moving to the Apaki update you installed… back in a few seconds; nothing you type is lost.'
      : 'Reconnecting to the engine… your conversations keep running, and nothing you type is lost.';
    b.hidden = false;
  }, 1500);
}

function send(op, args = {}) {
  return invoke('engine_send', { msg: { op, reqId: `r${++S.seq}`, ...args } }).catch((e) => {
    // While the window reconnects every command is refused; one quiet line says so, not one per command
    // (Arthur, 2026-10-11, saw "engine is not running" a dozen times while the engine switched over).
    if (/engine is not running/i.test(String(e))) {
      // The banner already says so (engineBanner); nothing is added to the conversation.
      engineBanner(true);
      return false;
    }
    focusedPane()?.note(String(e), 'error');
    return false;
  });
}

/* What this phone may do (the phone page only; 2026-10-12) */

/** What this phone may do on the PC: 'full', 'noshell' or 'chat' (the desktop window can do everything). */
const phoneCap = () => (WEB ? (window.__apakiLink?.cap?.() || 'full') : 'full');
/** True when the PC takes this command from a phone (its hello lists it); always true in the desktop window. */
const phoneCan = (op) => !WEB || Boolean(window.__apakiLink?.supports?.(`op:${op}`));
/** A short line at the top of the phone's screen (native.js draws it). */
const phoneToast = (text, ok = true) => window.dispatchEvent(new CustomEvent('apaki:toast', { detail: { text, ok } }));
/** Shows the conversation screen of the phone's stack (native.js), after something opened one from a menu. */
const phoneShowChat = () => window.dispatchEvent(new CustomEvent('apaki:chat'));

/* ---------- formatting helpers ---------- */

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const kindLabel = (kind = '', codex = false) => {
  const agent = kind.startsWith('agent-');
  const base = agent ? kind.slice(6) : kind;
  const who = { prompt: 'you', reply: codex ? 'codex' : 'claude', tool: 'tool call', result: 'tool output' }[base] || base;
  return agent ? `subagent ${who}` : who;
};
/**
 * Bolds the words the search actually used (the server's terms, without
 * filler like "the" or "find"), at word starts only, so "in" never lights up
 * inside "leading".
 */
function highlight(text, query) {
  let h = esc(text || '');
  const terms = S.searchTerms?.length ? S.searchTerms : query.split(/\s+/);
  const words = [...new Set(terms.flatMap((t) => String(t).replace(/"/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length > 2))];
  if (!words.length) return h;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return h.replace(re, '$1<b>$2</b>');
}

/* ---------- panes and tabs ---------- */

let paneSeq = 0;
const newPaneId = () => `p${Date.now().toString(36)}${(++paneSeq).toString(36)}`;
let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(++tabSeq).toString(36)}`;

const activeTab = () => S.tabs.find((t) => t.id === S.active) || S.tabs[0] || null;
/** A tab's conversation panes; viewers, browsers and tasks (isViewer) are not counted as its panes. */
const conversationsIn = (t) => L.ids(t?.root).map((id) => S.panes.get(id)).filter((p) => p && !p.isViewer);
/** No room for another conversation: L.MAX_PANES of them, or MAX_LEAVES panes of any kind. */
const tabFull = (t) => Boolean(t?.root) && (conversationsIn(t).length >= L.MAX_PANES || L.count(t.root) >= MAX_LEAVES);
/** No room for another viewer, browser or task: only the layout's overall limit applies to them. */
const tabFullForViewer = (t) => Boolean(t?.root) && L.count(t.root) >= MAX_LEAVES;
const tabOf = (pane) => S.tabs.find((t) => L.has(t.root, pane.id)) || null;
function focusedPane() {
  const t = activeTab();
  if (!t) return null;
  return S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]) || null;
}
const paneBySession = (id) => (id ? [...S.panes.values()].find((p) => p.sessionId === id) : null);

const host = {
  defaults: S.defaults,
  send,
  // The desktop window tells the engine each pane's queued messages (pane.js syncQueue), so they go out even with the window
  // closed (queue-hold.js). The phone page does not: a phone's queue stays in its own pane.
  engineQueue: !WEB,
  // Double-click a pane's title: name its session (beginRename, below).
  renameSession: (p, anchor) => beginRename(p.sessionId, anchor, { pane: p }),
  focus: (p) => focusPane(p, { scroll: false }),
  close: (p) => closePane(p),
  // A pane that follows a pane on the PC asks to take its conversation over (the phone's shared view; takeOver below).
  takeOver: (p) => takeOver(p),
  voice: (p) => toggleVoice(p),
  folder: (p, value) => paneFolder(p, value),
  folderMenu: (p, anchor) => folderMenu(p.sessionId, anchor),
  newConversation: (p) => newConversation(p),
  // Reconnecting to the engine (engine_exit until the next ready): a pane keeps a message in its box instead of sending it.
  engineLost: () => Boolean(S.engineLost),
  // /resume and /continue (pane.js): Claude Code's own /resume is a terminal picker the SDK turns off ("isn't
  // available in this environment"), so Apaki opens its session search instead, with what followed the command.
  findSession: (query = '') => findSession(query),
  // opts.mode 'worktree' opens it on New worktree. The phone cannot browse the PC's disks: it picks among folders the PC knows.
  chooseFolder: (p, opts = {}) => { if (p && !p.sessionId && !p.busy) startUI = folderSheet(p, { sheet, send, esc, ago, web: WEB, wt: wtc, mode: opts.mode, known: knownFolders }); },
  // Git worktrees (worktree.js): the worktree a pane's folder is in, its menu, and making one from a first message.
  worktreeFor: (p) => wtc.forCwd(p.cwd),
  worktreeMenu: (p, anchor) => wtc.paneMenu(p, anchor),
  makeWorktree: (p, text) => wtc.makeFor(p, text),
  wt: null, // set below, once the controller exists (the diff viewer reads it)
  changed: () => { renderTabs(); renderRailMarks(); save(); },
  // Something worth saving changed (a draft, the queue, where you scrolled); no redraw.
  dirty: () => save(),
  // Subagents, shells, monitors (tasks.js).
  openTask: (spec, opts) => openTask(spec, opts),
  stopTask: (spec) => stopTask(spec),
  taskState: (spec) => taskState(spec),
  dragTask: (spec, e) => dragTask(spec, e),
  openTasksPanel: (p, anchor) => openTasksPanel(p, anchor),
  tasksChanged: (p) => tasksChanged(p),
  subagentCount: (id) => S.sessions.find((s) => s.id === id)?.subagents || 0,
  // A conversation Claude Code deleted that Apaki's archive kept (engine archivedCopy, 2026-10-12): the pane says so at its top.
  archivedCopy: (id) => Boolean(id && S.sessions.find((s) => s.id === id)?.archivedCopy),
  sessionTitle: (id) => S.sessions.find((s) => s.id === id)?.title || paneBySession(id)?.title || null,
  // Codex panes (pane.js): whether Codex is installed, the model list the engine read, and a request for it.
  codexAvailable: () => S.codexAvailable,
  codexModels: () => S.codex,
  askCodexModels: () => askCodexModels(),
  showSession: (id) => { const p = paneBySession(id); if (p) { const t = tabOf(p); if (t && t.id !== S.active) switchTab(t); focusPane(p); return; } const s = S.sessions.find((x) => x.id === id); if (s) openFromRail(s, { ctrlKey: true }); },
  dragPane: (p, e) => {
    e.dataTransfer.setData(DRAG_PANE, p.id);
    e.dataTransfer.effectAllowed = 'move';
    S.drag = { kind: 'pane', paneId: p.id };
    document.body.classList.add('dragging');
  },
  dragEnd: () => endDrag(),
  linkSessions: (node) => linkSessions(node),
  // Artifacts (artifacts.js): a card's Open, and web pages, which the
  // built-in browser (browser.js) shows since 2026-10-09.
  showArtifact: (art, opts) => openViewer(art, opts),
  // Whether a viewer shows this artifact now (the conversation's reopen icon, pane.js).
  artifactOpen: (sessionId, id) => viewers().some((v) => v.art.id === id && v.art.sessionId === sessionId),
  // Web pages open in the built-in browser beside the pane they came from
  // (2026-10-09); without one (no shell browser) in the system browser.
  openUrl: (url, from) => openUrlHere(url, from),
  openOutside: (url) => send('openExternal', { url }),
  browser: (cmd, args = {}) => invoke('browser', { cmd, args }),
  shortcut: (key, shift) => shortcut(key, shift),
  paneTitle: (id) => S.panes.get(id)?.title || null,
};

/* ---------- git worktrees (worktree.js, diff.js; 2026-10-12) ---------- */

// Arthur: "The best approach to AI development is using git worktrees to tackle multiple features simultaneously ...
// make sure we're updating the app alongside the desktop app so all functionality is equal across the board." This
// file runs on the phone page too, so everything below is on both; a phone's access level decides what the engine runs.
// Apaki's own hover tooltips in place of the browser's title boxes (tooltip.js, Arthur 2026-10-12).
initTooltips();

const wtc = initWorktrees({
  send, sheet, menu, web: WEB, shortPath: short,
  cap: () => (WEB ? (window.__apakiLink?.cap?.() || 'full') : 'full'),
  sessions: () => S.sessions,
  openCwds: () => [...S.panes.values()].filter((p) => !p.isViewer && p.cwd).map((p) => p.cwd),
  openDiff: (spec) => openDiff(spec),
  startIn: (path) => newConversation(focusedPane(), { cwd: path }),
  // A pull request opens in the built-in browser on the desktop, and in the phone's own browser on the phone.
  openUrl: (url) => { if (!/^https:\/\//i.test(String(url || ''))) return; if (WEB) window.open(url, '_blank', 'noopener,noreferrer'); else openUrlHere(url); },
  focusedCwd: () => focusedPane()?.cwd || '',
  note: (text, tone) => focusedPane()?.note(text, tone),
  changed: (o) => wtChanged(o),
});
host.wt = wtc;

/** The engine sent repositories: every branch label, diff viewer, tab tooltip and the sidebar follow. */
function wtChanged({ save: keep = false } = {}) {
  for (const p of S.panes.values()) {
    if (p.isDiff) p.repoChanged();
    else if (!p.isViewer) p.setCwdLine();
  }
  if (!S.drag) renderRail();
  renderTabs();
  if (keep) save();
}

/** The folders the PC knows, newest first: what the phone's Starts in sheet offers (it cannot browse the PC's disks). */
function knownFolders() {
  const by = new Map();
  const name = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  for (const s of S.sessions) {
    if (!s.cwd || s.archived) continue;
    const r = by.get(s.cwd) || { path: s.cwd, name: name(s.cwd), last: 0, claude: 0 };
    r.last = Math.max(r.last, s.lastModified || 0);
    r.claude += 1;
    by.set(s.cwd, r);
  }
  for (const repo of wtc.repos()) for (const w of repo.worktrees) if (!w.bare && !by.has(w.path)) by.set(w.path, { path: w.path, name: name(w.path), last: 0, claude: 0 });
  return [...by.values()].sort((a, b) => b.last - a.last).slice(0, 40);
}

function createDiffViewer(spec, id = newDiffViewerId()) {
  const v = new DiffPane(id, host, spec);
  S.panes.set(v.id, v);
  return v;
}

/**
 * View changes: a diff viewer for a worktree beside the conversation it was asked from (the one already showing that
 * worktree is shown again, and read again). A full tab gets it in a new tab.
 */
function openDiff(spec) {
  const have = [...S.panes.values()].find((x) => x.isDiff && x.spec.path === spec.path);
  if (have) {
    const ht = tabOf(have);
    if (ht && ht.id !== S.active) switchTab(ht);
    focusPane(have);
    have.load();
    return have;
  }
  const src = focusedPane();
  const t = activeTab();
  if (!t || !t.root || tabFullForViewer(t)) {
    const nt = createTab(null);
    const v = createDiffViewer({ ...spec, ownerPane: src && !src.isViewer ? src.id : null });
    nt.root = L.leaf(v.id);
    nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  const v = createDiffViewer({ ...spec, ownerPane: src && !src.isViewer ? src.id : null });
  const anchor = src && L.has(t.root, src.id) ? src.id : t.focused || L.ids(t.root)[0];
  t.root = L.insert(t.root, anchor, v.id, 'right');
  layout(t);
  focusPane(v);
  renderTabs();
  save();
  return v;
}

/** A new tab whose conversation starts in a new worktree of the repository the focused pane is in (the sheet asks when there is none). */
function newTabInWorktree() {
  const from = focusedPane();
  const f = from && !from.isViewer ? wtc.forCwd(from.cwd) : null;
  const t = addTab();
  const p = S.panes.get(t.focused);
  if (!p) return;
  if (f) p.setPendingWorktree({ repo: f.repo.root || f.wt.path, name: f.repo.name, base: f.repo.base || f.wt.base || '' });
  else host.chooseFolder(p, { mode: 'worktree' });
}

/* ---------- artifact viewers ---------- */

const viewers = () => [...S.panes.values()].filter((p) => p.isViewer && !p.isBrowser);

function createViewer(art, id = newViewerId()) {
  const v = new ArtifactPane(id, host, art);
  S.panes.set(v.id, v);
  return v;
}

/**
 * Shows an artifact: in the viewer already showing it, else in the viewer
 * that belongs to the conversation that made it, else in a new viewer split
 * to that conversation's right. Claude's own shows (auto) never rearrange a
 * full tab; the card's Open then puts the viewer in a new tab. Focus stays
 * where it was unless asked, so typing in the conversation is not interrupted.
 */
function openViewer(art, opts = {}) {
  const v = openViewerIn(art, opts);
  refreshArtifactButtons();
  return v;
}

/** Every conversation's reopen icon, after a viewer opened or closed. */
function refreshArtifactButtons() {
  for (const p of S.panes.values()) if (!p.isViewer) p.renderArtifactsButton?.();
}

/** A viewer closed: its conversation keeps a link to reopen it (the icon beside its grip). */
function viewerClosed(v) {
  const a = v.art || {};
  const owner = S.panes.get(v.sourcePane);
  const p = owner && !owner.isViewer && owner.sessionId === a.sessionId ? owner : [...S.panes.values()].find((x) => !x.isViewer && x.sessionId && x.sessionId === a.sessionId);
  p?.rememberArtifact(a);
}

function openViewerIn(art, { focus = false, auto = false } = {}) {
  const src = S.panes.get(art.sourcePane) || null;
  let v = viewers().find((x) => x.art.id === art.id && x.art.sessionId === art.sessionId) || null;
  const t = (v && tabOf(v)) || (src && tabOf(src)) || activeTab();
  if (!v && t?.root) v = L.ids(t.root).map((id) => S.panes.get(id)).find((x) => x?.isViewer && !x.isBrowser && x.sourcePane === art.sourcePane) || null;
  const keep = document.activeElement;
  const restoreFocus = () => { if (!focus && keep && document.contains(keep) && document.activeElement !== keep) keep.focus({ preventScroll: true }); };
  if (v) {
    v.show(art);
    if (focus) focusPane(v);
    renderTabs();
    save();
    return v;
  }
  if (!t || tabFullForViewer(t)) {
    if (auto && t) return null;
    const nt = createTab(null);
    v = createViewer(art);
    nt.root = L.leaf(v.id);
    nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  v = createViewer(art);
  const anchor = src && L.has(t.root, src.id) ? src.id : t.focused || L.ids(t.root)[0];
  t.root = t.root ? L.insert(t.root, anchor, v.id, 'right') : L.leaf(v.id);
  if (!t.focused) t.focused = v.id;
  layout(t);
  if (focus) focusPane(v); else restoreFocus();
  renderTabs();
  save();
  return v;
}

/* ---------- browser panes (browser.js, the shell's src/browser.rs) ---------- */

const browsers = () => [...S.panes.values()].filter((p) => p.isBrowser);
// Pages the shell still held when this window (re)loaded; restored panes adopt them.
S.alive = new Set();

function createBrowser(o, id) {
  const b = new BrowserPane(id, host, o);
  S.panes.set(b.id, b);
  new ResizeObserver(() => syncSoon()).observe(b.$.body);
  return b;
}

/**
 * Opens a web page in the built-in browser beside `from` (a conversation, or
 * a viewer or browser that belongs to one). Without a built-in browser it
 * goes to the system browser.
 */
function openUrlHere(url, from = null, { focus = true, reason = 'card' } = {}) {
  if (!/^(https?:\/\/|file:\/\/\/)/i.test(String(url || ''))) return;
  // The phone has no built-in browser (2026-10-12): a card's Open opens a public page in the phone's own browser, and a
  // page that exists only on the PC as the PC browser view. Never unasked: Claude's own shows only draw the card.
  if (WEB) { if (reason === 'card') openOnPhone(url, from); return; }
  let owner = from || focusedPane();
  if (owner?.isViewer) owner = S.panes.get(owner.sourcePane) || null;
  invoke('browser', { cmd: 'open', args: { owner: owner?.id || null, url, focus, reason } })
    .catch(() => send('openExternal', { url }));
}

/** A web page link card's Open on the phone (openUrlHere): the phone's own browser, or the PC browser view for a PC-only page. */
function openOnPhone(url, from) {
  if (isPublicWebUrl(url)) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  const owner = from?.isViewer ? S.panes.get(from.sourcePane) : from || focusedPane();
  if (owner?.el?.dataset.browser === '1' && phoneCan('browserView') && phoneCap() === 'full') {
    window.dispatchEvent(new CustomEvent('apaki:browser-view', { detail: { pane: owner.id } }));
    return;
  }
  phoneToast('That page only exists on your PC. Ask Claude to open it in the browser, then use Browser at the top.', false);
}

/**
 * The shell made a browser (Claude's browser_open, a page from show or a
 * command, or openUrlHere): its pane goes beside the conversation it belongs
 * to, under that conversation's viewer or browser when it has one, else to
 * its right; in a new tab when the tab is full or Claude asked for one.
 * Claude's own opens never take the focus.
 */
function placeBrowser(e) {
  let b = S.panes.get(e.id);
  if (b?.isBrowser) {
    b.attach(e.state);
    if (e.focus) focusPane(b);
    syncSoon();
    return;
  }
  b = createBrowser({ owner: e.owner, url: e.url || e.state?.url || '', title: e.state?.title || '' }, e.id);
  b.attach(e.state);
  const owner = S.panes.get(e.owner) || null;
  const t = (owner && tabOf(owner)) || activeTab();
  const keep = document.activeElement;
  if (e.hint === 'tab' || !t || tabFull(t)) {
    const nt = createTab(L.leaf(b.id));
    nt.focused = b.id;
    layout(nt);
    if (e.focus || !t) { switchTab(nt); focusPane(b); }
  } else {
    const ids = L.ids(t.root);
    const mates = ids.map((id) => S.panes.get(id)).filter((x) => x && x !== b && x.isViewer && x.sourcePane && x.sourcePane === e.owner);
    const anchor = mates.find((x) => x.isBrowser) || mates[0] || (owner && ids.includes(owner.id) ? owner : null);
    if (!t.root) t.root = L.leaf(b.id);
    else t.root = L.insert(t.root, anchor?.id || t.focused || ids[0], b.id, anchor && anchor !== owner ? 'bottom' : 'right');
    if (!t.focused) t.focused = b.id;
    layout(t);
    if (e.focus) focusPane(b);
    else if (keep && document.contains(keep) && document.activeElement !== keep) keep.focus({ preventScroll: true });
  }
  renderTabs();
  save();
  syncSoon();
}

/** Something covers part of the window: an open menu, a sheet, a drag. */
function overlays() {
  if (document.body.classList.contains('dragging')) return 'all';
  if (!$('scrim').hidden) return 'all';
  return [...document.querySelectorAll('body > .menu:not(.out)')].map((m) => m.getBoundingClientRect());
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Tells the shell where every browser pane's page goes, and which show. */
function syncBrowsers() {
  syncQueued = false;
  const cover = overlays();
  const active = activeTab();
  for (const b of browsers()) {
    const t = tabOf(b);
    const here = Boolean(t && t === active && b.el.isConnected);
    const r = b.$.body.getBoundingClientRect();
    const covered = cover === 'all' || (Array.isArray(cover) && cover.some((c) => overlaps(c, r)));
    b.place(here && !covered, here && covered ? 'overlay' : 'away');
  }
}
let syncQueued = false;
function syncSoon() {
  if (syncQueued) return;
  syncQueued = true;
  // A minimized window gets no animation frames; the pages still have to be told.
  if (document.visibilityState === 'visible') requestAnimationFrame(syncBrowsers);
  else setTimeout(syncBrowsers, 30);
}

/** Apaki's shortcuts pressed while a page had the keyboard (the shell passes them on). */
/* ---------- the sidebar: resize and collapse (Arthur, 2026-10-10) ----------
   "the sidebar should be resizeable and then at some point collapse to the
   left (where it can then be reopened by clicking on the relevant button)".
   Drag its right edge (220 to 560 px); past the left edge (under 150 px) it
   hides; the button at the left of the tab row, the one in its header, or
   Ctrl+B toggles it. Width and state are saved with the workspace. */
const RAIL_MIN = 220;
const RAIL_MAX = 560;
const RAIL_DEFAULT = 312;
const RAIL_HIDE_AT = 150;
// Under this width the wordmark steps down from the display size to the title size (app.css body.rail-narrow, 2026-10-12).
const RAIL_WORDMARK_FULL = 300;

function applyRail() {
  if (WEB) return;
  document.documentElement.style.setProperty('--rail', `${Math.round(S.railW || RAIL_DEFAULT)}px`);
  document.body.classList.toggle('rail-narrow', (S.railW || RAIL_DEFAULT) < RAIL_WORDMARK_FULL);
  document.body.classList.toggle('rail-collapsed', Boolean(S.railCollapsed));
  if ($('railShow')) $('railShow').hidden = !S.railCollapsed;
}

function setRailCollapsed(on) {
  S.railCollapsed = Boolean(on);
  applyRail();
  save();
}

/** Opens the session search (the sidebar's box) with a query: /resume [words]. On the phone, back to the list first. */
function findSession(query) {
  if (WEB) window.dispatchEvent(new CustomEvent('apaki:list'));
  else if (S.railCollapsed) setRailCollapsed(false);
  const q = $('q');
  if (!q) return;
  q.value = query;
  q.dispatchEvent(new Event('input'));
  q.focus();
  if (query) q.select();
}

function wireRail() {
  const handle = $('railResize');
  if (!handle || WEB) return;
  $('railHide')?.addEventListener('click', () => setRailCollapsed(true));
  $('railShow')?.addEventListener('click', () => setRailCollapsed(false));
  handle.addEventListener('dblclick', () => { S.railW = RAIL_DEFAULT; applyRail(); save(); });
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('rail-dragging');
    // Dragged to hiding, the sidebar keeps the width it had before this drag for when it comes back.
    const startW = S.railW || RAIL_DEFAULT;
    const move = (ev) => {
      if (ev.clientX < RAIL_HIDE_AT) { S.railW = startW; S.railCollapsed = true; end(); return; }
      S.railW = Math.max(RAIL_MIN, Math.min(RAIL_MAX, ev.clientX));
      applyRail();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('rail-dragging');
      applyRail();
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  applyRail();
}
wireRail();

function shortcut(key, shift) {
  const k = String(key).toLowerCase();
  // Ctrl+B from inside a browser pane (it forwards keys): the sidebar.
  if (k === 'b' && !shift && !WEB) { setRailCollapsed(!S.railCollapsed); return; }
  if (k === 't') { addTab(); return; }
  if (k === 'w') { const p = focusedPane(); if (p) closePane(p); return; }
  if (k === 'l') { const p = focusedPane(); if (p?.isBrowser) p.focusAddress(); return; }
  if (key === 'Tab') {
    const i = S.tabs.indexOf(activeTab());
    switchTab(S.tabs[(i + (shift ? -1 : 1) + S.tabs.length) % S.tabs.length]);
    focusPane(focusedPane());
    return;
  }
  if (/^[1-6]$/.test(k)) { const id = L.ids(activeTab()?.root)[Number(k) - 1]; if (id) focusPane(S.panes.get(id)); }
}

function createPane(settings = {}) {
  const p = new Pane(settings.id || newPaneId(), host, settings);
  p.setVoice(S.voice);
  p.renderFolderSelect(S.folders, S.sessions);
  S.panes.set(p.id, p);
  return p;
}

function createTab(root = null) {
  const stage = el('div', 'stage');
  stage.append(el('div', 'drop-hint'));
  $('stages').append(stage);
  const t = { id: newTabId(), root, focused: root ? L.ids(root)[0] : null, stage };
  wireStage(t);
  S.tabs.push(t);
  return t;
}

/** The model, effort and mode a new pane takes from the pane it comes from: Claude's own, never a Codex pane's. */
const inheritable = (base) => (base && base.kind !== 'codex' ? { model: base.model, effort: base.effort, mode: base.mode } : {});

/** A new tab with one pane, holding `session` or a new conversation. */
function addTab({ session = null, cwd = null, activate = true } = {}) {
  const base = focusedPane();
  // New conversations start in the home folder unless a folder is given (Arthur, 2026-10-09).
  // A Codex pane's model, effort and mode are Codex's (2026-10-12): a new Claude pane never inherits them.
  const p = createPane({ cwd: cwd || session?.cwd || '', ...inheritable(base) });
  const t = createTab(L.leaf(p.id));
  layout(t);
  p.open(session, { warm: true });
  if (activate) switchTab(t);
  focusPane(p);
  return t;
}

function switchTab(t) {
  if (!t) return;
  S.active = t.id;
  for (const x of S.tabs) x.stage.classList.toggle('on', x === t);
  syncSoon();
  const p = S.panes.get(t.focused);
  if (p) { p.unread = false; p.el.classList.remove('unread'); }
  // Back on this tab: any conversation here that moved on elsewhere is drawn again (pane.js checkDrift, 2026-10-11).
  for (const id of L.ids(t.root)) S.panes.get(id)?.checkDrift?.();
  renderTabs();
  renderRailMarks();
  save();
}

/** The window came back into view: the panes on screen check their conversations (no drift, 2026-10-11). */
function checkVisibleDrift() {
  const t = activeTab();
  if (!t || document.visibilityState !== 'visible') return;
  for (const id of L.ids(t.root)) S.panes.get(id)?.checkDrift?.();
}
window.addEventListener('focus', checkVisibleDrift);
document.addEventListener('visibilitychange', checkVisibleDrift);

function focusPane(p, { scroll = true } = {}) {
  if (!p) return;
  const t = tabOf(p);
  if (!t) return;
  p.checkDrift?.();
  if (t.id !== S.active) switchTab(t);
  if (t.focused !== p.id || !p.el.classList.contains('focused')) {
    t.focused = p.id;
    for (const id of L.ids(t.root)) S.panes.get(id)?.el.classList.toggle('focused', id === p.id);
    save();
  }
  if (p.unread) { p.unread = false; p.el.classList.remove('unread'); }
  // On a phone the keyboard would cover the conversation it just opened: it comes up when the person taps the box (2026-10-10).
  if (scroll && !WEB && document.activeElement?.closest?.('.pane') !== p.el) p.$.input?.focus({ preventScroll: true });
  if (scroll && p.isBrowser && document.activeElement?.closest?.('.pane') !== p.el) p.focusInto();
  document.title = `Myrlin Apaki · ${p.title}`;
  renderTabs();
  renderRailMarks();
}

function closePane(p, { confirmBusy = true } = {}) {
  if (confirmBusy && p.busy && !window.confirm(`"${p.title}" is still working. Stop it and close the pane?`)) return;
  const t = tabOf(p);
  if (rec?.pane === p) stopVoice(true);
  // A phone pane that follows a desktop pane (followDesktop, below) stops following; it never closes the desktop's.
  if (!p.isViewer) send(p.following ? 'unfollow' : 'close', { paneId: p.id });
  S.panes.delete(p.id);
  p.destroy();
  if (p.isViewer) { viewerClosed(p); refreshArtifactButtons(); }
  if (!t) return;
  t.root = L.remove(t.root, p.id);
  if (t.focused === p.id) t.focused = L.ids(t.root)[0] || null;
  if (!t.root && S.tabs.length > 1) { closeTab(t, { confirmBusy: false }); return; }
  layout(t);
  const next = S.panes.get(t.focused);
  if (next) focusPane(next); else { renderTabs(); save(); }
}

function closeTab(t, { confirmBusy = true } = {}) {
  const panes = L.ids(t.root).map((id) => S.panes.get(id)).filter(Boolean);
  if (confirmBusy && panes.some((p) => p.busy) && !window.confirm('A pane in this tab is still working. Stop it and close the tab?')) return;
  for (const p of panes) { if (!p.isViewer) send(p.following ? 'unfollow' : 'close', { paneId: p.id }); S.panes.delete(p.id); p.destroy(); }
  for (const p of panes) if (p.isViewer) viewerClosed(p);
  refreshArtifactButtons();
  const i = S.tabs.indexOf(t);
  S.tabs.splice(i, 1);
  t.stage.remove();
  if (!S.tabs.length) { addTab(); return; }
  if (S.active === t.id) switchTab(S.tabs[Math.max(0, i - 1)]);
  renderTabs();
  save();
}

/**
 * The phone follows a desktop pane (apaki/web/src/desktop.js; the engine op follow, used only when the PC lists 'follow' in
 * hello): a pane of the phone's own that shows that desktop pane's conversation live, without taking it over. Followed
 * already: shown. Otherwise a new page next to the focused one in the tab in front (a new tab past six panes). viewOnly (the
 * phone's access is No shell or Chat only): the composer gives way to a quiet "View only" line. Closing it sends unfollow
 * (closePane); Take over (takeOver below) ends it and opens the conversation here. It is saved as a follower (snapshot, restore),
 * never as a session of its own, so a reload follows again instead of reopening, and so taking over, the conversation. Phone only.
 */
function followDesktop({ desktopPaneId, title = '', viewOnly = false } = {}) {
  if (!desktopPaneId) return null;
  const have = [...S.panes.values()].find((x) => x.following === desktopPaneId);
  if (have) { focusPane(have, { scroll: false }); return have; }
  const t = activeTab();
  const base = focusedPane();
  const p = createPane({ cwd: '', ...inheritable(base) });
  // The bar ("Watching live on <PC>", Take over), the read only chips and, for a restricted phone, the "View only" line (pane.js).
  p.setFollowing(desktopPaneId, { readOnly: viewOnly });
  if (title) p.setTitle(title);
  if (!t || !t.root || L.count(t.root) >= L.MAX_PANES) {
    const nt = createTab(L.leaf(p.id));
    layout(nt);
    switchTab(nt);
  } else {
    const anchor = t.focused && L.has(t.root, t.focused) ? t.focused : L.ids(t.root)[0];
    t.root = L.insert(t.root, anchor, p.id, 'right');
    t.focused = p.id;
    layout(t);
  }
  send('follow', { paneId: p.id, desktopPaneId });
  focusPane(p, { scroll: false });
  renderTabs();
  save();
  return p;
}

/**
 * Take over (the phone's shared view, 2026-10-12): the pane that follows a conversation on the PC moves that conversation here. It asks
 * first, because it stops the PC's pane (the same hand-over as opening a conversation the PC holds and choosing Take over here).
 * Phone only: a window never has a pane that follows.
 */
function takeOver(p) {
  if (!p?.following || !S.panes.has(p.id)) return;
  const pc = String(window.__apakiLink?.pcName?.() || '').trim() || 'the PC';
  sheet(`<div class="from">${esc(p.title)}</div><h2>Take over from ${esc(pc)}?</h2>
    <p>${p.busy ? 'It is working on the PC right now, and taking over stops that. ' : ''}The pane there stops before its next message and says the conversation moved to this phone, so nothing forks. Everything it already did is saved and loads here.</p>
    <div class="row"><button data-k="x">Keep watching</button><button class="primary" data-k="go">Take over</button></div>`, (root, close) => {
    root.querySelector('[data-k=x]').onclick = close;
    root.querySelector('[data-k=go]').onclick = () => { close(); if (S.panes.has(p.id)) p.takeOver(); };
  });
}

// The PC changed what this phone may do (boot.js cap): the panes that follow a PC pane become view only, or send again.
if (WEB) {
  window.addEventListener('apaki:cap', (e) => {
    const readOnly = (e.detail?.cap || 'full') !== 'full';
    for (const p of S.panes.values()) if (p.following) p.setFollowing(p.following, { readOnly });
  });
}

function newConversation(p, o = {}) {
  // A new conversation is a new pane in the current tab, next to the focused one (Arthur, 2026-10-11: "a new
  // conversation creates a new pane in the currently active tab, not a new tab"); it no longer replaces the
  // focused conversation. A pane that is already a new, unsent conversation is reused; a full tab opens a new one.
  // o.cwd (a worktree's row, 2026-10-12): it starts in that folder instead of the home folder.
  if (p && !p.sessionId && !p.busy && !p.isViewer && !p.isBrowser) { if (o.cwd) p.setStartFolder(o.cwd); focusPane(p); return; }
  const t = activeTab();
  if (!t || !t.root) { addTab({ cwd: o.cwd }); return; }
  if (tabFull(t)) {
    (S.panes.get(t.focused) || p)?.note?.(`${L.MAX_PANES} panes is the most per tab; opened in a new tab instead.`, 'warn');
    addTab({ cwd: o.cwd });
    return;
  }
  const base = p || focusedPane();
  // Home folder, like a new terminal ("Starts in" changes it); the model, effort and mode of the pane it came from.
  const np = createPane({ cwd: o.cwd || '', ...inheritable(base) });
  const anchor = t.focused && L.has(t.root, t.focused) ? t.focused : L.ids(t.root)[0];
  t.root = L.insert(t.root, anchor, np.id, 'right');
  t.focused = np.id;
  layout(t);
  np.open(null, { warm: true });
  focusPane(np);
  renderTabs();
  save();
}

// The open "Start this conversation in" sheet (startfolder.js), if any.
let startUI = null;

/* ---------- layout rendering ---------- */

/** Renders a tab's layout tree, moving the existing pane elements (their state stays). */
function layout(t) {
  const scrolls = new Map();
  for (const id of L.ids(t.root)) { const p = S.panes.get(id); if (p) scrolls.set(p, p.$.ground.scrollTop); }
  const hint = t.stage.querySelector('.drop-hint');
  t.stage.replaceChildren(hint);
  t.stage.classList.toggle('multi', L.count(t.root) > 1);
  if (!t.root) {
    const empty = el('div', 'stage-empty', `${MARK_SVG.replace('class="m-mark"', 'class="m-mark empty-mark"')}<p>Drag a session here from the left, or</p>`);
    const b = el('button', 'new', 'New conversation');
    b.onclick = () => { const p = createPane({}); t.root = L.leaf(p.id); t.focused = p.id; layout(t); p.open(null, { warm: true }); focusPane(p); };
    empty.append(b);
    t.stage.append(empty);
    return;
  }
  const build = (node) => {
    if (node.type === 'leaf') return S.panes.get(node.pane)?.el || el('div', 'pane missing');
    const box = el('div', `split ${node.dir}`);
    node.children.forEach((c, i) => {
      if (i) box.append(gutter(t, node, i, box));
      const child = build(c);
      child.style.flex = `${node.sizes[i]} 1 0px`;
      box.append(child);
    });
    return box;
  };
  const rootEl = build(t.root);
  rootEl.style.flex = '1 1 0px';
  t.stage.append(rootEl);
  for (const [p, top] of scrolls) p.$.ground.scrollTop = top;
  for (const id of L.ids(t.root)) S.panes.get(id)?.el.classList.toggle('focused', id === t.focused);
  syncSoon();
}

/** The draggable bar between two neighbours of a split. Double-click evens the split out. */
function gutter(t, node, i, box) {
  const g = el('div', `gutter ${node.dir}`);
  g.title = 'Drag to resize · double-click to even out';
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add('active');
    document.body.classList.add(node.dir === 'row' ? 'resizing-x' : 'resizing-y');
    const horizontal = node.dir === 'row';
    const rect = box.getBoundingClientRect();
    const total = (horizontal ? rect.width : rect.height) - GUTTER_PX * (node.children.length - 1);
    const a = i - 1;
    const b = i;
    const start = horizontal ? e.clientX : e.clientY;
    const sa = node.sizes[a];
    const sb = node.sizes[b];
    const sum = node.sizes.reduce((x, y) => x + y, 0);
    const minFrac = ((horizontal ? MIN_PANE_W : MIN_PANE_H) / total) * sum;
    const kids = [...box.children].filter((c) => !c.classList.contains('gutter'));
    const move = (ev) => {
      const d = (((horizontal ? ev.clientX : ev.clientY) - start) / total) * sum;
      let na = sa + d;
      let nb = sb - d;
      if (na < minFrac) { nb -= minFrac - na; na = minFrac; }
      if (nb < minFrac) { na -= minFrac - nb; nb = minFrac; }
      if (na < minFrac || nb < minFrac) return;
      node.sizes[a] = na;
      node.sizes[b] = nb;
      kids[a].style.flex = `${na} 1 0px`;
      kids[b].style.flex = `${nb} 1 0px`;
    };
    const up = () => {
      g.releasePointerCapture(e.pointerId);
      g.classList.remove('active');
      document.body.classList.remove('resizing-x', 'resizing-y');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      save();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => {
    node.sizes = node.children.map(() => 1 / node.children.length);
    layout(t);
    save();
  });
  return g;
}

/** Rearranges the active tab's panes into an even grid (2 side by side, 2x2, 3+2, 3x3...). */
function arrangeGrid() {
  const t = activeTab();
  if (!t?.root) return;
  t.root = L.grid(L.ids(t.root));
  layout(t);
  save();
}

/* ---------- drag and drop into the stage ---------- */

function dragKind(e) {
  const types = [...(e.dataTransfer?.types || [])];
  if (types.includes(DRAG_TAB)) return 'tab';
  if (types.includes(DRAG_PANE)) return 'pane';
  if (types.includes(DRAG_TASK)) return 'task';
  if (types.includes(DRAG_SESSION)) return 'session';
  if (types.includes('Files')) return 'files';
  return null;
}

/** Where a drop at this point would go: a pane edge, a pane's middle, or the empty stage. */
function dropZone(t, e, kind) {
  const stageRect = t.stage.getBoundingClientRect();
  if (!t.root) return { where: 'root', rect: stageRect, stageRect };
  const paneEl = e.target.closest?.('.pane');
  const pane = paneEl && S.panes.get(paneEl.dataset.pane);
  if (!pane) return null;
  const r = paneEl.getBoundingClientRect();
  const movingId = kind === 'pane' ? S.drag?.paneId : null;
  if (movingId === pane.id) return null;
  const sameTab = movingId && L.has(t.root, movingId);
  const full = (S.drag?.paneId && S.panes.get(S.drag.paneId)?.isViewer ? tabFullForViewer(t) : tabFull(t)) && !sameTab;
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const [edge, dist] = Object.entries({ left: x, right: 1 - x, top: y, bottom: 1 - y }).sort((p, q) => p[1] - q[1])[0];
  if (dist < EDGE_ZONE && !full) {
    const half = {
      left: { left: r.left, top: r.top, width: r.width / 2, height: r.height },
      right: { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height },
      top: { left: r.left, top: r.top, width: r.width, height: r.height / 2 },
      bottom: { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 },
    }[edge];
    return { where: 'edge', edge, pane, rect: half, stageRect };
  }
  return { where: 'center', pane, rect: r, stageRect, full };
}

function showHint(t, z, kind) {
  const hint = t.stage.querySelector('.drop-hint');
  if (!z) { hint.classList.remove('on'); return; }
  const { rect, stageRect } = z;
  Object.assign(hint.style, { left: `${rect.left - stageRect.left + 4}px`, top: `${rect.top - stageRect.top + 4}px`, width: `${rect.width - 8}px`, height: `${rect.height - 8}px` });
  let text = 'Open here';
  if (z.where === 'edge') text = `Split ${z.edge}`;
  if (z.where === 'center') {
    if (kind === 'pane') text = L.has(t.root, S.drag?.paneId) ? 'Swap these panes' : 'Move here';
    else if (kind === 'task') text = z.pane.isViewer ? 'Replace this viewer' : 'Open beside this conversation';
    else text = z.full ? `${L.MAX_PANES} panes is the most per tab. Drop here to replace this one, or on + for a new tab` : z.pane.isBrowser ? 'Replace this browser' : z.pane.isViewer ? 'Replace this viewer' : 'Replace this conversation';
    if (z.pane.busy && kind === 'session') text = 'This pane is working; drop on an edge instead';
  }
  hint.textContent = text;
  hint.classList.toggle('full', Boolean(z.full) || (z.where === 'center' && z.pane.busy && kind === 'session'));
  hint.classList.add('on');
}

function endDrag() {
  S.drag = null;
  document.body.classList.remove('dragging');
  for (const t of S.tabs) t.stage.querySelector('.drop-hint')?.classList.remove('on');
  for (const tab of document.querySelectorAll('.tab.drop')) tab.classList.remove('drop');
}

function wireStage(t) {
  t.stage.addEventListener('dragover', (e) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === 'files') {
      const paneEl = e.target.closest?.('.pane');
      for (const c of t.stage.querySelectorAll('.composer.drop')) if (c.closest('.pane') !== paneEl) c.classList.remove('drop');
      paneEl?.querySelector('.composer')?.classList.add('drop');
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    const z = dropZone(t, e, kind);
    e.dataTransfer.dropEffect = z ? (kind === 'pane' ? 'move' : 'copy') : 'none';
    showHint(t, z, kind);
  });
  t.stage.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && t.stage.contains(e.relatedTarget)) return;
    t.stage.querySelector('.drop-hint').classList.remove('on');
    for (const c of t.stage.querySelectorAll('.composer.drop')) c.classList.remove('drop');
  });
  t.stage.addEventListener('drop', async (e) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === 'files') {
      for (const c of t.stage.querySelectorAll('.composer.drop')) c.classList.remove('drop');
      let pane = S.panes.get(e.target.closest?.('.pane')?.dataset.pane) || focusedPane();
      if (pane?.isViewer) pane = S.panes.get(pane.sourcePane) || null;
      for (const f of e.dataTransfer.files || []) await pane?.addImageFile?.(f);
      return;
    }
    const z = dropZone(t, e, kind);
    const payload = kind === 'pane' ? e.dataTransfer.getData(DRAG_PANE) : kind === 'task' ? e.dataTransfer.getData(DRAG_TASK) : e.dataTransfer.getData(DRAG_SESSION);
    endDrag();
    if (!z) return;
    if (kind === 'task') { dropTask(t, z, JSON.parse(payload || 'null')); return; }
    if (kind === 'session') dropSession(t, z, JSON.parse(payload || 'null'));
    else dropPane(t, z, S.panes.get(payload));
  });
}

/** A session dropped on a stage: split, replace, or fill an empty tab. */
function dropSession(t, z, s) {
  if (!s) return;
  const existing = paneBySession(s.id);
  if (existing) { focusPane(existing); existing.note('This session is already open here.'); return; }
  if (z.where === 'center' && z.pane.isViewer) {
    // Dropped on a viewer: the session takes the viewer's place.
    const v = z.pane;
    const p = createPane({ cwd: s.cwd, title: s.title });
    t.root = L.mapLeaves(t.root, (lf) => (lf.pane === v.id ? L.leaf(p.id) : lf));
    if (t.focused === v.id) t.focused = p.id;
    S.panes.delete(v.id);
    v.destroy();
    layout(t);
    p.open(s, { warm: true });
    focusPane(p);
    save();
    return;
  }
  if (z.where === 'center') {
    if (z.pane.busy) { z.pane.note('This pane is working. Drop the session on an edge to split instead.', 'warn'); return; }
    z.pane.open(s, { warm: true });
    focusPane(z.pane);
    return;
  }
  const base = z.pane || focusedPane();
  const p = createPane({ cwd: s.cwd, title: s.title, ...inheritable(base) });
  t.root = z.where === 'root' ? L.leaf(p.id) : L.insert(t.root, z.pane.id, p.id, z.edge);
  t.focused = p.id;
  layout(t);
  p.open(s, { warm: true });
  focusPane(p);
  save();
}

/** A pane dragged by its grip: move it to an edge, or swap with the pane it was dropped on. */
function dropPane(t, z, moving) {
  if (!moving) return;
  const from = tabOf(moving);
  if (z.where === 'center' && from === t) {
    t.root = L.swap(t.root, moving.id, z.pane.id);
    layout(t);
    save();
    return;
  }
  if (from) from.root = L.remove(from.root, moving.id);
  if (z.where === 'root') t.root = L.leaf(moving.id);
  else if (z.where === 'edge') t.root = L.insert(t.root, z.pane.id, moving.id, z.edge);
  else t.root = L.insert(t.root, z.pane.id, moving.id, 'right');
  t.focused = moving.id;
  if (from && from !== t) {
    if (from.focused === moving.id) from.focused = L.ids(from.root)[0] || null;
    if (!from.root) { S.tabs.splice(S.tabs.indexOf(from), 1); from.stage.remove(); } else layout(from);
  }
  layout(t);
  focusPane(moving);
  save();
}

/** Adds a session to a tab without a drop position: next to its focused pane. */
function addToTab(t, s) {
  if (!t.root) { dropSession(t, { where: 'root' }, s); return; }
  const target = S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]);
  if (tabFull(t)) { target?.note(`${L.MAX_PANES} panes is the most per tab; opened in a new tab instead.`, 'warn'); addTab({ session: s }); return; }
  dropSession(t, { where: 'edge', edge: 'right', pane: target }, s);
}

/* ---------- tab bar ---------- */

let hoverTimer = null;

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  for (const t of S.tabs) {
    const panes = L.ids(t.root).map((id) => S.panes.get(id)).filter(Boolean);
    // The number on a tab counts its conversations, not its viewers, browsers or tasks (2026-10-11).
    const convs = panes.filter((p) => !p.isViewer).length;
    const f = S.panes.get(t.focused) || panes[0];
    const busy = panes.some((p) => p.busy);
    const unread = panes.some((p) => p.unread);
    const warm = panes.some((p) => p.sessionId && S.warm.has(p.sessionId));
    const tab = el('div', `tab${t.id === S.active ? ' on' : ''}${busy ? ' busy' : ''}${unread ? ' unread' : ''}${warm ? ' warm' : ''}`);
    // A tab whose conversations all work in one worktree says which (worktree.js tabNote, 2026-10-12).
    const onBranch = wtc.tabNote(panes.filter((p) => !p.isViewer && p.cwd).map((p) => p.cwd));
    tab.title = `${onBranch ? `${onBranch}\n` : ''}${panes.map((p) => `${p.busy ? 'working: ' : p.unread ? 'finished: ' : ''}${p.title}`).join('\n') || 'Empty tab'}`;
    tab.innerHTML = `<span class="tab-t">${esc(f?.title || 'Empty tab')}</span>${convs > 1 ? `<span class="tab-n">${convs}</span>` : ''}${warm ? '<span class="warm-ring" aria-hidden="true"></span>' : ''}`;
    // Double-click the name to rename its session (saved in the session, not only here).
    tab.querySelector('.tab-t').ondblclick = (e) => { e.stopPropagation(); if (f && !f.isViewer) beginRename(f.sessionId, tab.querySelector('.tab-t'), { pane: f }); };
    const x = el('button', 'tab-x', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>');
    x.title = 'Close tab';
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    tab.append(x);
    tab.onclick = () => switchTab(t);
    tab.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    // Drag a tab along the bar to put it somewhere else (Arthur, 2026-10-11: "reorganize tabs").
    if (!WEB) {
      tab.draggable = true;
      tab.addEventListener('dragstart', (e) => {
        if (e.target.closest('.tab-x')) { e.preventDefault(); return; }
        e.dataTransfer.setData(DRAG_TAB, t.id);
        e.dataTransfer.effectAllowed = 'move';
        S.drag = { kind: 'tab', tabId: t.id };
        tab.classList.add('dragging-tab');
      });
      tab.addEventListener('dragend', () => { tab.classList.remove('dragging-tab'); clearTabMarks(); if (S.drag?.kind === 'tab') S.drag = null; });
    }
    tab.addEventListener('dragover', (e) => {
      const kind = dragKind(e);
      if (kind === 'tab') {
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        clearTabMarks();
        tab.classList.add(before ? 'tab-before' : 'tab-after');
        return;
      }
      if (kind !== 'session' && kind !== 'pane' && kind !== 'task') return;
      e.preventDefault();
      tab.classList.add('drop');
      if (t.id !== S.active && !hoverTimer) hoverTimer = setTimeout(() => { hoverTimer = null; switchTab(t); }, TAB_HOVER_SWITCH_MS);
    });
    tab.addEventListener('dragleave', () => { tab.classList.remove('drop', 'tab-before', 'tab-after'); clearTimeout(hoverTimer); hoverTimer = null; });
    tab.addEventListener('drop', (e) => {
      const kind = dragKind(e);
      if (kind === 'tab') {
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        moveTab(e.dataTransfer.getData(DRAG_TAB), t.id, e.clientX < r.left + r.width / 2);
        return;
      }
      if (kind !== 'session' && kind !== 'pane' && kind !== 'task') return;
      e.preventDefault();
      clearTimeout(hoverTimer); hoverTimer = null;
      if (kind === 'task') { const spec = JSON.parse(e.dataTransfer.getData(DRAG_TASK) || 'null'); endDrag(); switchTab(t); openTask(spec, { inTab: t }); return; }
      const data = e.dataTransfer.getData(kind === 'pane' ? DRAG_PANE : DRAG_SESSION);
      endDrag();
      if (kind === 'session') { switchTab(t); addToTab(t, JSON.parse(data || 'null')); return; }
      const moving = S.panes.get(data);
      if (!moving || tabOf(moving) === t) return;
      if (moving.isViewer ? tabFullForViewer(t) : tabFull(t)) { moving.note(`That tab already has ${L.MAX_PANES} panes.`, 'warn'); return; }
      switchTab(t);
      dropPane(t, t.root ? { where: 'edge', edge: 'right', pane: S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]) } : { where: 'root' }, moving);
    });
    bar.append(tab);
  }
  const plus = el('button', 'tab-plus', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>');
  plus.title = 'New tab (Ctrl+T) · right-click for a new tab in a new worktree · drop a session here to open it in a new tab';
  plus.onclick = () => addTab();
  // The + menu (2026-10-12): the same tab, or one whose conversation starts in a new git worktree.
  plus.oncontextmenu = (e) => {
    e.preventDefault();
    menu(plus, [{ value: 'tab', label: 'New tab', hint: 'Ctrl+T' }, { value: 'worktree', label: 'New tab in a new worktree', hint: 'its own branch and folder' }], { above: false, width: 280, onPick: (v) => (v === 'worktree' ? newTabInWorktree() : addTab()) });
  };
  plus.addEventListener('dragover', (e) => { const k = dragKind(e); if (k === 'session' || k === 'pane' || k === 'task') { e.preventDefault(); plus.classList.add('drop'); } });
  plus.addEventListener('dragleave', () => plus.classList.remove('drop'));
  plus.addEventListener('drop', (e) => {
    const kind = dragKind(e);
    if (kind !== 'session' && kind !== 'pane' && kind !== 'task') return;
    e.preventDefault();
    if (kind === 'task') { const spec = JSON.parse(e.dataTransfer.getData(DRAG_TASK) || 'null'); endDrag(); openTask(spec, { tab: true }); return; }
    const data = e.dataTransfer.getData(kind === 'pane' ? DRAG_PANE : DRAG_SESSION);
    endDrag();
    if (kind === 'session') {
      const s = JSON.parse(data || 'null');
      const existing = s && paneBySession(s.id);
      if (existing) { focusPane(existing); return; }
      addTab({ session: s });
      return;
    }
    const moving = S.panes.get(data);
    if (!moving) return;
    const t = createTab(null);
    dropPane(t, { where: 'root' }, moving);
    switchTab(t);
  });
  bar.append(plus);
  const tools = el('div', 'tabs-tools');
  const t = activeTab();
  const n = conversationsIn(t).length;
  const gridBtn = el('button', 'tab-tool', '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="5" height="4.5" rx="1"/><rect x="9" y="2.5" width="5" height="4.5" rx="1"/><rect x="2" y="9" width="5" height="4.5" rx="1"/><rect x="9" y="9" width="5" height="4.5" rx="1"/></svg><span>Even grid</span>');
  gridBtn.title = 'Arrange this tab\'s panes into an even grid';
  gridBtn.disabled = n < 2;
  gridBtn.onclick = arrangeGrid;
  tools.append(el('span', 'tab-count', n ? `${n} of ${L.MAX_PANES} panes` : ''), gridBtn);
  bar.append(tools);
  const unread = [...S.panes.values()].filter((p) => p.unread).length;
  const fp = focusedPane();
  document.title = `${unread ? `(${unread}) ` : ''}Myrlin Apaki${fp ? ` · ${fp.title}` : ''}`;
  updateBadge();
}

/** Clears the before/after marks a tab drag leaves on the tab bar. */
function clearTabMarks() {
  for (const el2 of document.querySelectorAll('.tab.tab-before, .tab.tab-after')) el2.classList.remove('tab-before', 'tab-after');
}

/** Moves a tab before or after another one in the tab bar; the order is saved with the workspace. */
function moveTab(fromId, toId, before) {
  clearTabMarks();
  if (!fromId || fromId === toId) return;
  const from = S.tabs.findIndex((x) => x.id === fromId);
  if (from < 0) return;
  const [moving] = S.tabs.splice(from, 1);
  let to = S.tabs.findIndex((x) => x.id === toId);
  if (to < 0) { S.tabs.splice(from, 0, moving); return; }
  if (!before) to += 1;
  S.tabs.splice(to, 0, moving);
  renderTabs();
  save();
}

/*
 * The taskbar and dock badge (Arthur, 2026-10-11: "any notifications to show a number of notifications (ready
 * tabs) top right of the myrlin apaki app in the dock/task bar"): the number of tabs with a conversation that
 * finished or asks something while you were not looking (unread). macOS shows it as the dock's own badge at the
 * top right; Windows has no number badge for desktop apps, so it is an overlay icon drawn here (Windows puts
 * overlays at the bottom right of the taskbar button).
 */
let badgeShown = -1;
function readyTabs() {
  return S.tabs.filter((t) => L.ids(t.root).some((id) => S.panes.get(id)?.unread)).length;
}
/** A 32 px round badge with the number (9+ above nine), as RGBA bytes for the taskbar overlay. */
function badgePixels(n) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#D2643F';
  g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
  g.lineWidth = 2; g.strokeStyle = '#FFFFFF'; g.stroke();
  g.fillStyle = '#FFFFFF';
  const text = n > 9 ? '9+' : String(n);
  g.font = `700 ${text.length > 1 ? 15 : 19}px 'Segoe UI', system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 16, 17);
  return new Uint8Array(g.getImageData(0, 0, 32, 32).data.buffer);
}
async function updateBadge() {
  if (WEB || !window.__TAURI__?.window) return;
  const n = readyTabs();
  if (n === badgeShown) return;
  badgeShown = n;
  const T = window.__TAURI__;
  const win = T.window.getCurrentWindow();
  try {
    if (/Mac/i.test(navigator.platform || navigator.userAgent)) { await win.setBadgeCount(n || undefined); return; }
    if (!n) { await win.setOverlayIcon(undefined); return; }
    const img = await T.image.Image.new(badgePixels(n), 32, 32);
    await win.setOverlayIcon(img);
  } catch (e) {
    // An older shell without the permission or the API: the title keeps the count, as before.
    console.warn('badge:', e?.message || e);
  }
}

/* ---------- rail ---------- */

function viewList() {
  const live = S.sessions.filter((s) => !s.archived);
  const term = live.filter((s) => s.terminal).length;
  const codex = live.filter((s) => s.codex).length;
  return [
    { id: 'all', label: 'All', n: live.length - (S.codexAvailable ? codex : 0) },
    { id: 'terminal', label: 'In terminals', n: term },
    // Codex threads (2026-10-12): their own view, next to Claude's, read from the Codex app-server when it is opened.
    ...(S.codexAvailable ? [{ id: 'codex', label: 'Codex', n: codex }] : []),
    // Worktrees (2026-10-12): repositories with their worktrees and the conversations in each (worktree.js).
    { id: 'worktrees', label: 'Worktrees', n: wtc.count() },
    // Archived sessions (right-click > Archive) open from a link under the list (renderRail), so the
    // header keeps two switches; while that view shows, the header's x leaves it.
  ];
}

/** Asks the engine for Codex's model list (once; the answer is event codexModels). */
let codexModelsAsked = 0;
function askCodexModels() {
  if (S.codex || Date.now() - codexModelsAsked < 4000) return;
  codexModelsAsked = Date.now();
  send('codexModels');
}

/** Reads the Codex threads on this PC for the Codex view (event codexThreads); refresh=true reads them again now. */
function loadCodexThreads(refresh = false) {
  if (!S.codexAvailable) return;
  send('codexThreads', refresh ? { refresh: true } : {});
}

/* ---------- folders ---------- */

// Folders (Arthur, 2026-10-09: "very clean and simple and easy to organize,
// move things in and out of"). One folder per session. Drag a session (or a
// pane's grip) onto a folder to move it in, onto All to take it out. Click a
// folder to show it, double-click to rename, the x deletes it (its sessions
// stay). Right-click a session for the same moves.
const folderUI = { creating: false, pendingSession: null, renaming: null };

function moveToFolder(sessionId, folderId) {
  if (!sessionId) return;
  send('folder', { action: 'move', sessionId, folderId: folderId || null });
}

function startNewFolder(sessionId = null) {
  // The phone asks for the name in a sheet (the sidebar's inline field is not on screen there) and may only create (2026-10-12).
  if (WEB) {
    nameSheet({ heading: 'New folder', placeholder: 'Folder name', cta: 'Create', maxLength: 60, onDone: (name) => send('folder', { action: 'create', name, ...(sessionId ? { sessionId } : {}) }) });
    return;
  }
  folderUI.creating = true;
  folderUI.pendingSession = sessionId;
  renderFolders();
}

/** Drop handling shared by folder rows, the new-folder row and All. */
function folderDropTarget(node, onSession) {
  node.addEventListener('dragover', (e) => {
    const kind = dragKind(e);
    if (kind !== 'session' && kind !== 'pane') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    const kind = dragKind(e);
    if (kind !== 'session' && kind !== 'pane') return;
    e.preventDefault();
    node.classList.remove('drop');
    const sid = kind === 'pane' ? S.panes.get(e.dataTransfer.getData(DRAG_PANE))?.sessionId : JSON.parse(e.dataTransfer.getData(DRAG_SESSION) || 'null')?.id;
    endDrag();
    if (sid) onSession(sid);
  });
}

function renderFolders() {
  const box = $('folders');
  box.innerHTML = '';
  const head = el('div', 'sec-head folders-head', `<span class="sec-t">Folders</span><span class="sec-n">${S.folders.length || ''}</span>`);
  const add = el('button', 'folder-add', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>');
  add.title = 'New folder (drop a session here to make one with it)';
  add.onclick = () => startNewFolder();
  folderDropTarget(add, (sid) => startNewFolder(sid));
  head.append(add);
  box.append(head);
  const list = el('ul', 'folder-list');
  if (folderUI.creating) {
    const li = el('li', 'folder-row editing');
    const input = el('input');
    input.placeholder = 'Folder name';
    input.spellcheck = false;
    const done = (ok) => {
      const name = input.value.trim();
      folderUI.creating = false;
      if (ok && name) send('folder', { action: 'create', name, sessionId: folderUI.pendingSession });
      folderUI.pendingSession = null;
      renderFolders();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    input.onblur = () => done(true);
    li.append(input);
    list.append(li);
    setTimeout(() => input.focus(), 0);
  }
  for (const f of S.folders) {
    const li = el('li', `folder-row${S.view === f.id ? ' on' : ''}`);
    if (folderUI.renaming === f.id) {
      const input = el('input');
      input.value = f.name;
      const done = (ok) => {
        folderUI.renaming = null;
        const name = input.value.trim();
        if (ok && name && name !== f.name) send('folder', { action: 'rename', folderId: f.id, name });
        renderFolders();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      input.onblur = () => done(true);
      li.classList.add('editing');
      li.append(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      li.innerHTML = `<svg class="fi" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/></svg><span class="fn">${esc(f.name)}</span><span class="count">${f.sessions.length}</span>`;
      const x = el('button', 'folder-x', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>');
      x.title = 'Delete folder (its sessions stay)';
      x.onclick = (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete folder "${f.name}"? Its ${f.sessions.length} session(s) stay, just without a folder.`)) return;
        send('folder', { action: 'delete', folderId: f.id });
        if (S.view === f.id) S.view = 'all';
      };
      li.append(x);
      li.onclick = () => { S.view = S.view === f.id ? 'all' : f.id; renderRail(); };
      li.ondblclick = () => { folderUI.renaming = f.id; renderFolders(); };
      li.title = 'Click to show · double-click to rename · drop sessions here to move them in';
    }
    folderDropTarget(li, (sid) => moveToFolder(sid, f.id));
    list.append(li);
  }
  if (!S.folders.length && !folderUI.creating) list.append(el('li', 'folder-empty', 'Drag sessions onto + to group them.'));
  box.append(list);
}

/** The folder menu for one session: move into a folder, a new folder, or out. */
function folderMenu(sessionId, anchor) {
  if (!sessionId) return;
  const cur = S.sessions.find((x) => x.id === sessionId)?.folder || null;
  const items = [
    ...S.folders.map((f) => ({ value: f.id, label: f.name, checked: f.id === cur })),
    ...(S.folders.length ? [{ divider: true }] : []),
    { value: '__new', label: 'New folder…' },
    ...(cur ? [{ value: '__out', label: 'Remove from folder' }] : []),
  ];
  menu(anchor, items, {
    above: false,
    width: 200,
    onPick: (v) => {
      if (v === '__new') { startNewFolder(sessionId); return; }
      moveToFolder(sessionId, v === '__out' ? null : v);
    },
  });
}

/** Right-click on a session row. */
/* ---------- subagents, shells, monitors (tasks.js, 2026-10-10) ---------- */

function createTaskViewer(spec, id = newTaskViewerId()) {
  const v = new TaskPane(id, host, spec);
  S.panes.set(v.id, v);
  return v;
}

/** The live task a spec names, from the conversation that runs it here (or null). */
function liveTask(spec) {
  const owner = S.panes.get(spec?.ownerPane) || (spec?.sessionId ? paneBySession(spec.sessionId) : null);
  if (!owner?.liveTasks) return null;
  return (spec.taskId && owner.liveTasks.get(spec.taskId)) || [...owner.liveTasks.values()].find((t) => spec.toolUseId && t.toolUseId === spec.toolUseId) || null;
}
const taskState = (spec) => liveTask(spec);

/**
 * Opens a task viewer: the one already showing it, else beside the
 * conversation that started it, else in a new tab (also when asked, or when
 * that tab is full).
 */
function openTask(spec, { tab = false, inTab = null, focus = true } = {}) {
  if (!spec?.sessionId) return null;
  const have = [...S.panes.values()].find((x) => x.isTask && specKey(x.spec) === specKey(spec));
  if (have) { const ht = tabOf(have); if (ht && ht.id !== S.active) switchTab(ht); focusPane(have); return have; }
  const src = S.panes.get(spec.ownerPane) || paneBySession(spec.sessionId) || null;
  const t = tab ? null : inTab || (src && tabOf(src)) || activeTab();
  if (!t || tabFullForViewer(t)) {
    const nt = createTab(null);
    const v = createTaskViewer(spec);
    nt.root = L.leaf(v.id);
    nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  const v = createTaskViewer(spec);
  const anchor = src && L.has(t.root, src.id) ? src.id : t.focused || L.ids(t.root)[0];
  t.root = t.root ? L.insert(t.root, anchor, v.id, 'right') : L.leaf(v.id);
  if (!t.focused) t.focused = v.id;
  layout(t);
  if (t.id !== S.active) switchTab(t);
  if (focus) focusPane(v);
  renderTabs();
  save();
  return v;
}

function stopTask(spec) {
  const live = liveTask(spec);
  const owner = S.panes.get(spec?.ownerPane) || paneBySession(spec?.sessionId);
  if (!live || !owner) { (owner || focusedPane())?.note('That task is not running in this window, so Apaki cannot stop it. Stop it in the window that started it.', 'warn'); return; }
  send('taskStop', { paneId: owner.id, taskId: live.id });
}

function dragTask(spec, e) {
  e.dataTransfer.setData(DRAG_TASK, JSON.stringify(spec));
  e.dataTransfer.effectAllowed = 'copyMove';
  S.drag = { kind: 'task' };
  document.body.classList.add('dragging');
}

/** A task dropped on a stage: split at an edge, take a viewer's place, or open beside a conversation. */
function dropTask(t, z, spec) {
  if (!spec?.sessionId) return;
  if (z.where === 'center' && !z.pane.isViewer && tabFull(t)) { z.pane.note(`${L.MAX_PANES} panes is the most per tab; drop it on + for a new tab.`, 'warn'); return; }
  const v = createTaskViewer(spec);
  if (z.where === 'root') t.root = L.leaf(v.id);
  else if (z.where === 'edge') t.root = L.insert(t.root, z.pane.id, v.id, z.edge);
  else if (z.pane.isViewer) {
    const old = z.pane;
    t.root = L.mapLeaves(t.root, (lf) => (lf.pane === old.id ? L.leaf(v.id) : lf));
    S.panes.delete(old.id);
    old.destroy();
  } else t.root = L.insert(t.root, z.pane.id, v.id, 'right');
  t.focused = v.id;
  layout(t);
  focusPane(v);
  save();
}

const taskActions = {
  open: (spec, o) => openTask(spec, o),
  stop: (spec) => stopTask(spec),
  background: (spec) => { const live = liveTask(spec); if (live?.toolUseId) send('taskBackground', { paneId: spec.ownerPane, toolUseId: live.toolUseId }); },
  dragStart: (spec, e) => dragTask(spec, e),
  dragEnd: () => endDrag(),
};

let panelAnchor = null;
/** The Tasks popover for a conversation (asks the engine for its earlier subagents if not read lately). */
function openTasksPanel(p, anchor) {
  if (anchor) panelAnchor = anchor;
  if (!panelAnchor || !p.sessionId) { if (!p.sessionId) p.note('Its tasks show once the conversation has a session.'); return; }
  const disk = S.subs.get(p.sessionId) || null;
  if (anchor && (!disk || Date.now() - disk.at > 3000)) send('subagents', { sessionId: p.sessionId });
  tasksPanel(panelAnchor, p, taskActions, disk);
}

function tasksChanged(p) {
  renderTabs();
  if (tasksPanelPane() === p) openTasksPanel(p, null);
  for (const v of S.panes.values()) if (v.isTask && (v.spec.ownerPane === p.id || v.spec.sessionId === p.sessionId)) v.renderHead();
}

/** Shows or hides a rail row's subagents. */
function toggleSubs(id) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else { S.expanded.add(id); send('subagents', { sessionId: id }); }
  renderRail();
  save();
}

/** The rows under a session in the rail: its subagents, then its shells. */
function subRows(s) {
  const data = S.subs.get(s.id);
  if (!data) return [el('li', 'sub-row note', 'Reading its subagents…')];
  const rows = [];
  const mk = (spec, title, meta, running) => {
    const li = el('li', `sub-row${running ? ' running' : ''}`);
    li.innerHTML = `<span class="sub-g">${taskGlyph(spec.kind === 'agent' ? 'agent' : 'shell')}</span><div class="sub-main"><div class="sub-t"></div><div class="sub-m"></div></div>`;
    li.querySelector('.sub-t').textContent = title;
    li.querySelector('.sub-m').textContent = meta;
    li.title = 'Click: open beside it · Ctrl+click: new tab · drag onto a pane edge or a tab';
    li.onclick = (e) => openTask(spec, { tab: e.ctrlKey || e.metaKey });
    li.draggable = true;
    li.addEventListener('dragstart', (e) => dragTask(spec, e));
    li.addEventListener('dragend', endDrag);
    li.oncontextmenu = (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }, [{ value: 'open', label: 'Open beside it' }, { value: 'tab', label: 'Open in new tab', hint: 'Ctrl+click' }], { above: false, width: 200, onPick: (v) => openTask(spec, { tab: v === 'tab' }) }); };
    return li;
  };
  const RAIL_SUBS = 30;
  for (const a of data.agents.slice(0, RAIL_SUBS)) {
    rows.push(mk({ kind: 'agent', sessionId: s.id, agentId: a.id, toolUseId: a.toolUseId, title: a.description || a.type, type: a.type, model: a.model },
      a.description || a.type, [a.type, a.model, a.workflow ? 'workflow' : '', a.running ? 'running' : ago(a.lastAt)].filter(Boolean).join(' · '), a.running));
  }
  for (const sh of data.shells.slice(0, 12)) {
    rows.push(mk({ kind: 'shell', sessionId: s.id, taskId: sh.id, title: `Shell ${sh.id}`, type: 'local_bash' }, `${KIND_LABEL.shell} ${sh.id}`, [sh.running ? 'running' : ago(sh.lastAt), `${Math.max(1, Math.round(sh.size / 1024))} KB`].join(' · '), sh.running));
  }
  if (data.agents.length > RAIL_SUBS) {
    const more = el('li', 'sub-row note more', `${data.agents.length - RAIL_SUBS} older subagents not shown (the newest ${RAIL_SUBS} are)`);
    rows.splice(RAIL_SUBS, 0, more);
  }
  if (!rows.length) rows.push(el('li', 'sub-row note', 'No subagents left on disk.'));
  return rows;
}

/* ---------- renaming a session (2026-10-09) ---------- */

// Arthur: tabs must be renamable, and the name must stick to the session:
// "one name, not a bunch of different labels saved only for this app". The
// engine saves it the way Claude Code's /rename does (renameSession).

/** Shows a session's new name everywhere it appears here. */
function setSessionTitle(sessionId, title) {
  if (!sessionId || !title) return;
  for (const p of S.panes.values()) if (p.sessionId === sessionId) p.setTitle(title);
  for (const s of S.sessions) if (s.id === sessionId) s.title = title;
  for (const r of S.results || []) if (r.item?.id === sessionId) r.item.title = title;
  renderTabs();
  if (!S.drag) renderRail();
  save();
}

/**
 * An inline editor over `anchor` (a tab's name, a pane's title, a rail row).
 * Enter or leaving it saves; Escape cancels. A conversation with no session
 * yet keeps the name and saves it once its first message makes the session.
 */
function beginRename(sessionId, anchor, { pane = null } = {}) {
  // The phone has no title to edit in place (the pane bar is replaced by the conversation bar): a sheet asks (2026-10-12).
  if (WEB) { renameSheet(sessionId, { pane }); return; }
  if (!anchor || anchor.querySelector?.('input.rename')) return;
  const current = (pane?.title || S.sessions.find((s) => s.id === sessionId)?.title || '').replace(/^New conversation$/, '');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = current;
  input.placeholder = 'Name this session';
  input.spellcheck = false;
  const before = anchor.textContent;
  anchor.textContent = '';
  anchor.append(input);
  if (pane) pane.renaming = true;
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (pane) pane.renaming = false;
    const title = input.value.replace(/\s+/g, ' ').trim();
    input.remove();
    anchor.textContent = before;
    if (!save || !title || title === current) return;
    if (!sessionId) {
      if (!pane) return;
      pane.pendingName = title;
      pane.setTitle(title);
      renderTabs();
      pane.note(`"${title}" becomes this session's name when your first message starts it.`);
      return;
    }
    setSessionTitle(sessionId, title);
    send('rename', { sessionId, title, paneId: pane?.id || null });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  for (const ev of ['click', 'dblclick', 'pointerdown']) input.addEventListener(ev, (e) => e.stopPropagation());
}

/**
 * A session's right-click menu (Arthur, 2026-10-10: "right click session in
 * the navbar and stop them among other things (think of what codex and claude
 * desktop would let you do)"): open it (new tab, here, split), stop or close
 * it where it runs, rename, fork it into a new conversation, move it between
 * folders, archive it (hidden from the lists, nothing deleted), copy its id or
 * resume command, and show its folder.
 */
function sessionMenu(s, e) {
  e.preventDefault();
  // The phone's own menu (below): a long press on a row opens it as a sheet.
  if (WEB) { phoneSessionMenu(s, { x: e.clientX, y: e.clientY }); return; }
  const cur = s.folder || null;
  const pane = paneBySession(s.id);
  const runningHere = Boolean(pane?.busy);
  const running = runningHere || Boolean(s.running);
  let stopItem = { value: null, label: 'Stop', hint: 'nothing is running', disabled: true };
  if (running) stopItem = { value: 'stop', label: 'Stop', hint: runningHere ? 'stop Claude here (Esc)' : 'stop its running turn', danger: true };
  else if (s.terminal) stopItem = { value: null, label: 'Stop', hint: 'runs in a terminal; stop it there', disabled: 'It runs in a Claude Code terminal window; stop it there' };
  const items = [
    { heading: (s.title || 'Session').slice(0, 48) },
    { value: 'tab', label: pane ? 'Show it' : 'Open', hint: pane ? 'it is open in a pane' : 'new tab, click' },
    ...(pane ? [] : [{ value: 'here', label: 'Open here', hint: 'replaces the focused pane' }]),
    ...(pane ? [] : [{ value: 'split', label: 'Split right', hint: 'Shift+click' }]),
    { divider: true },
    stopItem,
    ...(pane ? [{ value: 'close', label: 'Close its pane', hint: pane.busy ? 'asks first: it is working' : '' }] : []),
    { divider: true },
    { value: 'rename', label: 'Rename…', hint: 'saved in the session' },
    ...(WEB ? [] : [{ value: 'fork', label: 'Fork into a new conversation', hint: 'a copy to take elsewhere' }]),
    ...(WEB ? [] : [s.codexArchived ? { value: null, label: 'Archived in Codex', hint: 'unarchive it in the Codex app', disabled: 'Archived in the Codex app; unarchive it there' } : s.archived ? { value: 'unarchive', label: 'Unarchive', hint: 'back in the lists' } : { value: 'archive', label: 'Archive', hint: 'hide it; nothing is deleted' }]),
    { divider: true },
    { value: 'copy-id', label: 'Copy session id' },
    { value: 'copy-resume', label: 'Copy resume command', hint: s.codex ? 'codex resume' : 'claude --resume' },
    ...(WEB || !s.cwd ? [] : [{ value: 'reveal', label: 'Show folder', hint: short(s.cwd) }]),
    { divider: true },
    { heading: 'Move to folder' },
    ...S.folders.map((f) => ({ value: `f:${f.id}`, label: f.name, checked: f.id === cur })),
    { value: 'new', label: 'New folder…' },
    ...(cur ? [{ value: 'out', label: 'Remove from folder' }] : []),
  ];
  menu({ x: e.clientX, y: e.clientY }, items, {
    above: false,
    width: 270,
    onPick: (v) => {
      if (v === 'rename') { const row = [...$('sessions').children].find((li) => li.dataset.id === s.id); beginRename(s.id, row?.querySelector('.t') || null); return; }
      if (v === 'here') openFromRail(s, { here: true });
      else if (v === 'tab') { if (pane) focusPane(pane); else openFromRail(s, { ctrlKey: true }); }
      else if (v === 'split') openFromRail(s, { shiftKey: true });
      else if (v === 'stop') { if (runningHere) pane.stop(); else send('stopSession', { sessionId: s.id }); }
      else if (v === 'close') closePane(pane);
      else if (v === 'fork') send('forkSession', { sessionId: s.id });
      else if (v === 'archive' || v === 'unarchive') send('archive', { sessionId: s.id, archived: v === 'archive' });
      else if (v === 'copy-id') copyText(s.id, 'Session id copied.');
      else if (v === 'copy-resume') copyText(`${s.cwd ? `cd "${s.cwd}" && ` : ''}${s.codex ? `codex resume ${s.id.replace(/^codex:/, '')}` : `claude --resume ${s.id}`}`, 'Resume command copied.');
      else if (v === 'reveal') send('revealFolder', { cwd: s.cwd });
      else if (v === 'new') startNewFolder(s.id);
      else if (v === 'out') moveToFolder(s.id, null);
      else if (v.startsWith('f:')) moveToFolder(s.id, v.slice(2));
    },
  });
}

/* The session menu on the phone (2026-10-12) */

// Arthur: every desktop feature also works on the phone. The desktop's menu is a right click; a phone has none. Its
// menu opens from a long press on a row of the list (native.js turns the press into the same contextmenu event) and
// from the ... button in the conversation bar (pager.js, event apaki:pane-menu), as a sheet from the bottom.

/**
 * A one-field sheet: a heading, a text box holding `value`, Cancel and a button. Enter saves. onDone(text) runs with
 * the cleaned text unless it is empty or unchanged. The phone's Rename and New folder (the desktop edits in place).
 */
function nameSheet({ heading, from = '', value = '', placeholder = '', cta = 'Save', maxLength = 200, onDone, onClose = null }) {
  sheet(`${from ? `<div class="from">${esc(from)}</div>` : ''}<h2>${esc(heading)}</h2>
    <input type="text" data-k="name" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="${maxLength}" spellcheck="false" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" aria-label="${esc(heading)}">
    <div class="row"><button data-k="x">Cancel</button><button class="primary" data-k="go">${esc(cta)}</button></div>`, (root, close) => {
    const input = root.querySelector('[data-k=name]');
    const go = () => {
      const text = input.value.replace(/\s+/g, ' ').trim();
      close();
      if (text && text !== value.trim()) onDone(text);
    };
    root.querySelector('[data-k=x]').onclick = close;
    root.querySelector('[data-k=go]').onclick = go;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.focus();
    input.select();
  }, null, onClose);
}

/** Rename on the phone: the same save as the desktop's inline editor (setSessionTitle, then the rename op). */
function renameSheet(sessionId, { pane = null } = {}) {
  const current = (pane?.title || S.sessions.find((s) => s.id === sessionId)?.title || '').replace(/^New conversation$/, '');
  if (pane) pane.renaming = true;
  nameSheet({
    heading: 'Rename session', value: current, placeholder: 'Name this session', cta: 'Rename',
    onClose: () => { if (pane) pane.renaming = false; },
    onDone: (title) => {
      // A conversation with no session yet keeps the name and saves it once its first message makes the session.
      if (!sessionId) {
        if (!pane) return;
        pane.pendingName = title;
        pane.setTitle(title);
        renderTabs();
        pane.note(`"${title}" becomes this session's name when your first message starts it.`);
        return;
      }
      setSessionTitle(sessionId, title);
      send('rename', { sessionId, title, paneId: pane?.id || null });
    },
  });
}

/**
 * The session menu on the phone: a sheet with what a phone can do safely. s: the session's list record (or the pane's
 * own when it has none yet); at: where the press was (the sheet ignores it); pane: given when the ... button of an open
 * conversation asked, which adds Find. Rename, fork, archive and folders need Full or No shell access on the PC and a PC
 * that takes them (hello ops): otherwise the item is left out, or shown dimmed with the reason when it is the access.
 * Left out on purpose: Show folder (it opens Explorer on the PC), and Stop for a turn that runs on the PC.
 */
function phoneSessionMenu(s, at, { pane = null } = {}) {
  const here = pane || paneBySession(s.id);
  const writes = phoneCap() !== 'chat';
  // An access-limited item stays visible but cannot be picked; a PC that lacks the op never shows it.
  const gated = (op, item) => (!phoneCan(op) ? null : writes ? item : { ...item, value: null, disabled: 'Chat only access cannot change sessions', hint: 'Chat only reads' });
  const items = [{ heading: (s.title || here?.title || 'Session').slice(0, 48) }];
  if (here) items.push({ value: 'find', label: 'Find in conversation', hint: 'words in this chat' });
  if (!pane && s.id) {
    items.push(here ? { value: 'show', label: 'Show it', hint: 'it is open here' } : { value: 'open', label: 'Open' });
    if (!here && !tabFull(activeTab())) items.push({ value: 'split', label: 'Open in a new pane', hint: 'beside this tab\'s others' });
  }
  if (here?.busy) items.push({ divider: true }, { value: 'stop', label: 'Stop', hint: here.kind === 'codex' ? 'stop Codex here' : 'stop Claude here', danger: true });
  else if (s.running || s.terminal) items.push({ divider: true }, { value: null, label: 'Stop', hint: 'it runs on the PC', disabled: 'It runs on the PC; stop it there' });
  if (here && !pane) items.push({ value: 'close', label: 'Close its pane', hint: here.busy ? 'asks first: it is working' : '' });
  const edits = [
    gated('rename', { value: 'rename', label: 'Rename…', hint: 'saved in the session' }),
    ...(s.id && !s.archivedCopy ? [gated('forkSession', { value: 'fork', label: 'Fork into a new conversation', hint: 'makes a copy' })] : []),
    ...(s.id ? [gated('archive', s.codexArchived ? { value: null, label: 'Archived in Codex', hint: 'unarchive it in the Codex app', disabled: 'Archived in the Codex app; unarchive it there' } : s.archived ? { value: 'unarchive', label: 'Unarchive', hint: 'back in the lists' } : { value: 'archive', label: 'Archive', hint: 'hide it; nothing is deleted' })] : []),
  ].filter(Boolean);
  if (edits.length) items.push({ divider: true }, ...edits);
  if (s.id) items.push({ divider: true }, { value: 'copy-id', label: 'Copy session id' }, { value: 'copy-resume', label: 'Copy resume command', hint: s.codex ? 'codex resume' : 'claude --resume' });
  if (s.id && phoneCan('folder')) {
    const cur = s.folder || null;
    // Chat only: one dimmed row says why, not a dimmed row per folder.
    if (!writes) items.push({ divider: true }, { value: null, label: 'Move to folder…', hint: 'Chat only reads', disabled: 'Chat only access cannot change sessions' });
    else {
      items.push({ divider: true }, { heading: 'Move to folder' },
        ...S.folders.map((f) => ({ value: `f:${f.id}`, label: f.name, checked: f.id === cur })),
        { value: 'new', label: 'New folder…' },
        ...(cur ? [{ value: 'out', label: 'Remove from folder' }] : []));
    }
  }
  menu(at, items.filter(Boolean), {
    above: false,
    width: 270,
    onPick: (v) => {
      if (v === 'find') { openFind(here); return; }
      if (v === 'show') { focusPane(here); phoneShowChat(); return; }
      if (v === 'open' || v === 'split') { openFromRail(s, v === 'split' ? { shiftKey: true } : {}); phoneShowChat(); return; }
      if (v === 'stop') here?.stop();
      else if (v === 'close') closePane(here);
      else if (v === 'rename') renameSheet(s.id || null, { pane: here });
      else if (v === 'fork') send('forkSession', { sessionId: s.id });
      else if (v === 'archive' || v === 'unarchive') send('archive', { sessionId: s.id, archived: v === 'archive' });
      else if (v === 'copy-id') copyText(s.id, 'Session id copied.');
      else if (v === 'copy-resume') copyText(`${s.cwd ? `cd "${s.cwd}" && ` : ''}${s.codex ? `codex resume ${s.id.replace(/^codex:/, '')}` : `claude --resume ${s.id}`}`, 'Resume command copied.');
      else if (v === 'new') startNewFolder(s.id);
      else if (v === 'out') moveToFolder(s.id, null);
      else if (typeof v === 'string' && v.startsWith('f:')) moveToFolder(s.id, v.slice(2));
    },
  });
}

if (WEB) {
  // The ... button of the conversation bar (pager.js) asks for the menu of the conversation on screen.
  window.addEventListener('apaki:pane-menu', (e) => {
    const p = S.panes.get(e.detail?.pane);
    if (!p || p.isViewer) return;
    const s = S.sessions.find((x) => x.id === p.sessionId) || { id: p.sessionId || null, title: p.title, cwd: p.cwd, codex: p.kind === 'codex' };
    phoneSessionMenu(s, { x: 0, y: 0 }, { pane: p });
  });
}

/**
 * The sign-in card (2026-10-10, for a PC where Claude Code has never been
 * signed in): it sits at the top of the window until the engine reports a
 * login. Sign in opens Claude Code's own sign-in (engine op signIn); with an
 * API key in Myrlin Glass the card never shows (the engine counts that as
 * signed in). Desktop only: a phone never runs this.
 */
function renderSignIn(e) {
  if (WEB) return;
  S.auth = e;
  let card = $('signInCard');
  if (e.loggedIn || e.method === 'unknown') { card?.remove(); return; }
  if (!card) {
    card = el('div', 'signin-card');
    card.id = 'signInCard';
    card.setAttribute('role', 'status');
    document.querySelector('.main')?.prepend(card);
  }
  card.innerHTML = `<div class="sc-t"><b>Sign in to Claude to start</b><span>Claude Code on this PC has no login yet. Sign in with your Claude account (or a Console account for API billing); Apaki picks it up as soon as you finish.</span>${e.note ? `<span class="sc-note${e.noteOk === false ? ' bad' : ''}">${esc(e.note)}</span>` : ''}</div>
    <div class="sc-act"><button class="primary" data-k="claude">Sign in</button><button data-k="console" title="Bill an Anthropic Console account (API credits) instead of a subscription">Console account</button></div>`;
  card.querySelector('[data-k=claude]').onclick = () => send('signIn', {});
  card.querySelector('[data-k=console]').onclick = () => send('signIn', { console: true });
}

/** Copies text, and says so in the focused pane (a textarea fallback where the clipboard API is refused). */
function copyText(text, said) {
  // The phone says so in a toast: the pane's note would be out of sight when the copy came from the list (2026-10-12).
  const done = () => (WEB ? phoneToast(said) : focusedPane()?.note(said, ''));
  const fallback = () => {
    const t = el('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    try { document.execCommand('copy'); done(); } catch { /* nothing more to try */ }
    t.remove();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

function inView(s) {
  if (S.view === 'archived') return Boolean(s.archived);
  if (s.archived) return false;
  if (S.view === 'codex') return Boolean(s.codex);
  // Codex threads have their own view; a search shows its hits wherever they are (every agent's), a folder shows what is in it.
  if (s.codex && S.view === 'all' && !S.results && S.codexAvailable) return false;
  if (S.view === 'all') return true;
  if (S.view === 'terminal') return Boolean(s.terminal);
  if (S.view === 'worktrees') return wtc.inLinked(s.cwd);
  const f = S.folders.find((x) => x.id === S.view);
  return Boolean(f && f.sessions.includes(s.id));
}

function renderRail() {
  const views = $('views');
  views.innerHTML = '';
  for (const v of viewList()) {
    const b = el('button', v.id === S.view ? 'on' : '', `${esc(v.label)}<span class="count">${v.n}</span>`);
    b.onclick = () => { S.view = v.id; if (v.id === 'codex') loadCodexThreads(); renderRail(); };
    // Dropping a session on All takes it out of its folder.
    if (v.id === 'all') { b.title = 'Drop a session here to take it out of its folder'; folderDropTarget(b, (sid) => moveToFolder(sid, null)); }
    views.append(b);
  }
  let rows;
  if (S.results) {
    rows = S.results.filter((r) => inView(r.item)).map((r) => ({ ...r.item, kind: r.kind, snippet: r.snippet, hits: r.hits, why: r.why || '', sources: r.sources || null }));
  } else {
    rows = S.sessions.filter(inView).sort((a, b) => (Boolean(b.terminal) - Boolean(a.terminal)) || (b.lastModified - a.lastModified));
  }
  // The Worktrees view (2026-10-12): repository and worktree rows with their conversations nested under them (worktree.js).
  // Searching shows the matches, filtered to the conversations that live in a worktree, as in every other view.
  const wtView = S.view === 'worktrees' && !S.results;
  if (wtView) rows = wtc.rows(S.sessions.filter((s) => !s.archived)).map((r) => (r.k === 'kid' ? { ...r.s, wtKid: true } : { wtRow: r }));
  renderFolders();
  const folder = S.folders.find((f) => f.id === S.view);
  $('sessionsTitle').textContent = S.results ? (S.ai ? 'Picks' : 'Results') : folder ? folder.name : S.view === 'terminal' ? 'In terminals' : S.view === 'worktrees' ? 'Worktrees' : S.view === 'archived' ? 'Archived' : S.view === 'codex' ? 'Codex threads' : 'Sessions';
  $('sessionsCount').textContent = String(wtView ? wtc.count() : Math.min(rows.length, 400));
  $('clearView').hidden = !folder && S.view !== 'archived';
  $('searchState').textContent = S.results ? S.searchInfo : '';
  $('searchState').hidden = !S.results;
  const list = $('sessions');
  list.innerHTML = '';
  const folderName = (id) => S.folders.find((f) => f.id === id)?.name;
  if (wtView) { const clean = wtc.cleanRowEl(); if (clean) list.append(clean); }
  const focusedCwd = focusedPane()?.cwd || '';
  for (const s of rows.slice(0, 400)) {
    // A repository or a worktree row of the Worktrees view; the conversations between them are ordinary rows (below).
    if (s.wtRow) { list.append(wtc.rowEl(s.wtRow, { focusedCwd })); continue; }
    const li = el('li');
    li.dataset.id = s.id;
    if (s.wtKid) li.classList.add('wt-kid');
    // A conversation in a linked worktree says which branch, beside its time (not under its own worktree row, which says it).
    const tag = !s.wtKid && s.cwd ? wtc.forCwd(s.cwd) : null;
    const branchTag = tag && hasLinked(tag.repo) ? `<span class="wt-tag" title="${esc(tag.wt.path)}">${tag.wt.main ? '' : GLYPH_WORKTREE}${esc(branchName(tag.wt))}</span>` : '';
    const meta = [
      s.codex ? '<span class="codex">codex</span>' : '',
      s.terminal ? `<span class="live">terminal${s.terminal.status ? ` · ${esc(s.terminal.status)}` : ''}</span>` : '',
      s.headless ? '<span class="headless" title="Started headless and never typed into: claude -p, a worker, or a window with relay on from its first message">claude -p</span>' : '',
      s.bare ? '<span class="headless" title="Its transcript has no messages yet">empty</span>' : '',
      // Claude Code deleted it after 30 days; Apaki's archive kept a copy (engine archivedCopy, 2026-10-12). Words, no badge.
      s.archivedCopy ? `<span class="arch-copy" title="Claude Code deleted the original after 30 days; Apaki's archive kept this copy, without images.${s.restorable ? ' Open it and send a message to restore it.' : ''}">Archived copy</span>` : '',
      ago(s.lastModified), branchTag, esc(short(s.cwd)),
      S.view === 'all' && s.folder ? `▸ ${esc(folderName(s.folder) || '')}` : '',
    ].filter(Boolean).join(' · ');
    const byMeaning = s.sources && !s.sources.includes('words');
    const snip = s.snippet ? `<div class="snip">${byMeaning ? '<span class="by-meaning" title="Found by what it is about, not by your words">by meaning</span> ' : ''}${esc(kindLabel(s.kind, s.codex))}: ${highlight(s.snippet, S.query)}${s.hits > 1 ? ` <span class="mono">(${s.hits})</span>` : ''}</div>` : '';
    li.innerHTML = `<div class="t">${esc(s.title || '(untitled)')}</div><div class="m">${meta}</div>${s.why ? `<div class="why">${esc(s.why)}</div>` : snip}`;
    // Keep-warm is holding this session's prompt cache: a slow moving border (2026-10-09).
    if (S.warm.has(s.id)) { li.classList.add('warm'); li.append(el('span', 'warm-ring')); }
    // Its subagents (2026-10-10): a count to click open; the list follows the row.
    const subsOpen = S.expanded.has(s.id);
    if (s.subagents > 0) {
      const sb = el('button', `subs-n${subsOpen ? ' open' : ''}`, `${taskGlyph('agent')}<span>${s.subagents} subagent${s.subagents === 1 ? '' : 's'}</span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>`);
      sb.title = subsOpen ? 'Hide its subagents' : 'Show its subagents (and shells)';
      sb.onclick = (e) => { e.stopPropagation(); toggleSubs(s.id); };
      li.append(sb);
    }
    li.onclick = (e) => openFromRail(s, e);
    li.oncontextmenu = (e) => sessionMenu(s, e);
    li.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); openFromRail(s, { ctrlKey: true }); } };
    {
      // Not on the phone (2026-10-12): iOS lifts a draggable row after a long press, and that press opens the menu there.
      li.draggable = !WEB;
      li.title = `Click: open (a new tab, or the empty pane) · Shift+click: split right · drag onto a pane edge to split, or onto a folder · right-click: stop, rename, fork, archive and more${S.warm.has(s.id) ? '\nKeep-warm is keeping its prompt cache warm' : ''}`;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(DRAG_SESSION, JSON.stringify({ id: s.id, cwd: s.cwd, title: s.title }));
        e.dataTransfer.effectAllowed = 'copyMove';
        S.drag = { kind: 'session', id: s.id };
        document.body.classList.add('dragging');
      });
      li.addEventListener('dragend', endDrag);
    }
    list.append(li);
    if (subsOpen) for (const sub of subRows(s)) list.append(sub);
  }
  if (!rows.length) list.append(el('li', 'note', S.results ? 'Nothing matches in this view.' : S.view === 'archived' ? 'Nothing archived.' : wtView ? (wtc.hasData() ? 'No worktrees yet. Start a conversation in a new worktree to see it here.' : 'Looking for worktrees…') : 'No sessions here yet.'));
  const newWt = wtView ? wtc.newRowEl() : null;
  if (newWt) list.append(newWt);
  // Archived sessions: one quiet link at the end of the list opens them (right-click > Unarchive brings one back).
  const archivedN = S.sessions.filter((x) => x.archived).length;
  if (archivedN && S.view !== 'archived' && !S.results && !wtView) {
    const more = el('li', 'note archived-link', `<button class="link-btn">${archivedN} archived</button>`);
    more.querySelector('button').onclick = () => { S.view = 'archived'; renderRail(); };
    list.append(more);
  }
  if (S.results && S.query) {
    const dig = el('button', 'dig', '<b>Dig deeper in a dedicated session</b>Claude searches every transcript with its tools and reports what it finds.');
    dig.onclick = () => digDeeper(S.query);
    const li = el('li', 'dig-row');
    li.append(dig);
    list.append(li);
  }
  renderRailMarks();
}

/** Marks which rail rows are open in a pane, and which one is focused. */
function renderRailMarks() {
  const open = new Set([...S.panes.values()].map((p) => p.sessionId).filter(Boolean));
  const cur = focusedPane()?.sessionId;
  for (const li of $('sessions').children) {
    const id = li.dataset.id;
    li.classList.toggle('on', Boolean(id) && id === cur);
    li.classList.toggle('shown', Boolean(id) && id !== cur && open.has(id));
  }
}

function openFromRail(s, e = {}) {
  // A Codex thread opens like any session now (2026-10-12): a new tab, the empty pane, or a split; the pane becomes a Codex one.
  const existing = paneBySession(s.id);
  if (existing) { focusPane(existing); return; }
  if (e.ctrlKey || e.metaKey) { addTab({ session: s }); return; }
  const t = activeTab();
  let p = focusedPane();
  if (e.shiftKey && t?.root) { addToTab(t, s); return; }
  // A click never replaces a conversation you have open (Arthur, 2026-10-10): it opens in a new tab,
  // unless the focused pane is an empty new conversation, which it fills. "Open here" in the
  // right-click menu still replaces on purpose (e.here). The phone's single-pane stack keeps replacing.
  if (!WEB && !e.here && p && !p.isViewer && (p.sessionId || p.busy || p.$?.T?.querySelector('.turn-user'))) { addTab({ session: s }); return; }
  // A viewer is focused: open in the conversation it belongs to, if that is here and free.
  if (p?.isViewer) {
    const src = S.panes.get(p.sourcePane);
    if (src && !src.busy && tabOf(src) === t) p = src;
    else { if (t?.root) addToTab(t, s); else addTab({ session: s }); return; }
  }
  if (!p || p.busy) { addTab({ session: s }); return; }
  p.open(s, { warm: true });
  focusPane(p);
}

let searchTimer = null;
$('q').addEventListener('input', (e) => {
  S.query = e.target.value.trim();
  S.ai = null;
  clearTimeout(searchTimer);
  renderLens();
  if (!S.query) { S.results = null; renderRail(); return; }
  searchTimer = setTimeout(() => send('search', { query: S.query }), SEARCH_DEBOUNCE_MS);
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; S.query = ''; S.results = null; S.ai = null; renderLens(); renderRail(); }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && S.query) { e.preventDefault(); askClaude(); }
});

/* ---------- advanced search (Arthur, 2026-10-09) ---------- */

// Three depths, cheapest first:
//   1. As you type (free, local, about a tenth of a second): the keyword
//      index and the meaning index together, so "marketing and growth on
//      forge.myrlin.io" also finds GA4 funnels and landing-page work.
//   2. Ask Claude (Ctrl+Enter, about a cent, a few seconds): Claude turns the
//      question into searches, the local indexes run them, and Claude reads
//      the best candidates and keeps the ones that fit, with a reason each.
//      Billed to the focused pane's account; no session is saved.
//   3. Dig deeper: a dedicated Claude Code session that searches with its
//      own tools; it says so before it opens.
function billingName() {
  return focusedPane()?.billing?.name || S.defaults.billing?.name || 'the live account';
}

function renderLens() {
  const lens = $('lens');
  lens.hidden = !S.query;
  if (!S.query) return;
  const ask = $('ask');
  ask.classList.toggle('busy', Boolean(S.asking));
  ask.querySelector('span').textContent = S.asking ? 'Asking…' : 'Ask Claude';
  ask.title = `Claude turns your question into searches, reads the best matches and keeps the sessions that fit, with a reason for each. Billed to ${billingName()}, about a cent. Ctrl+Enter`;
  const info = $('lensInfo');
  if (S.asking) { info.innerHTML = esc(S.asking); return; }
  if (S.ai) { info.innerHTML = `<b>Claude</b> · ${esc(S.ai.summary)}`; return; }
  const r = S.lastSearch;
  info.innerHTML = r && r.query === S.query ? `<b>${r.n}</b> · ${esc(r.how)} · ${r.ms} ms` : 'Searching…';
}

/** The line after a search's results that points at Ask Claude: Ctrl+Enter in the window, the button on the phone (and none for a PC without it). */
function askHint() {
  if (!phoneCan('askSearch')) return '';
  return WEB ? ' Not it? Tap Ask Claude.' : ' Not it? Ask Claude (Ctrl+Enter).';
}

function askClaude() {
  if (!S.query || S.asking) return;
  S.asking = 'Claude is reading your question…';
  renderLens();
  send('askSearch', { query: S.query, paneId: focusedPane()?.id || null });
}
$('ask').onclick = askClaude;

function digDeeper(query) {
  const who = billingName();
  sheet(`<h2>Dig deeper</h2>
    <p>This opens a <b>dedicated Claude Code session</b> in a new tab. Claude searches every transcript on this PC with its own tools (the index, grep, reading files), follows leads, and reports the sessions that match, with ids you can click to open.</p>
    <p class="note">It runs on Opus 5.5 billed to <b>${esc(who)}</b>, usually a few minutes and between ten cents and a couple of dollars. It is a normal session: keep it, or delete it when you are done. It changes no files.</p>
    <div class="q">Looking for</div><div class="from" style="white-space:normal">${esc(query)}</div>
    <div class="row"><button data-k="x">Cancel</button><button class="primary" data-k="go">Open search session</button></div>`, (root, close) => {
    root.querySelector('[data-k=x]').onclick = close;
    root.querySelector('[data-k=go]').onclick = () => { close(); send('digPrompt', { query, candidates: (S.results || []).slice(0, 15).map((r) => r.item.id) }); };
  });
}

/** Session ids in a reply become links that open the session in a new tab. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
function linkSessions(node) {
  const known = new Map(S.sessions.map((x) => [x.id, x]));
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) { UUID_RE.lastIndex = 0; if (UUID_RE.test(t.nodeValue)) hits.push(t); }
  for (const t of hits) {
    if (t.parentElement?.closest('a, pre')) continue;
    const v = t.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of v.matchAll(UUID_RE)) {
      const s = known.get(m[0]);
      if (!s) continue;
      frag.append(v.slice(last, m.index));
      const a = el('a', 'sess-link', esc(m[0]));
      a.href = '#';
      a.title = `Open "${s.title}" in a new tab`;
      a.onclick = (e) => { e.preventDefault(); openFromRail(s, { ctrlKey: true }); };
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (!last) continue;
    frag.append(v.slice(last));
    t.replaceWith(frag);
  }
}

$('new').onclick = () => newConversation(focusedPane());
$('clearView').onclick = () => { S.view = 'all'; renderRail(); };

function paneFolder(p, v) {
  if (v === '__new') { startNewFolder(p.sessionId); return; }
  send('folder', { action: 'move', sessionId: p.sessionId, folderId: v || null });
}

/** The footer line: meaning-index progress while it builds, else the index state. */
function renderIndexState() {
  const building = /%/.test(S.meaningLine || '');
  $('indexState').textContent = building ? S.meaningLine : [S.indexLine, S.meaningLine].filter(Boolean).join(' · ') || 'Loading…';
  $('indexState').title = indexText();
  settings?.refresh();
}
const indexText = () => [S.indexLine, S.meaningLine].filter(Boolean).join(' · ') || 'Loading…';

/* ---------- sound ---------- */

function renderSound() {
  settings?.refresh();
  const b = $('sound');
  if (!b) return;
  b.textContent = soundOn() ? 'Ding on' : 'Ding off';
  b.classList.toggle('off', !soundOn());
}
if ($('sound')) $('sound').onclick = () => { setSoundOn(!soundOn()); renderSound(); if (soundOn()) ding('done'); };

/* ---------- theme (theme.js sets it before first paint) ---------- */

const THEME_UI = {
  auto: { label: 'Auto', next: 'light', icon: '<circle cx="8" cy="8" r="5.5"/><path class="i-fill" d="M8 2.5a5.5 5.5 0 0 1 0 11z"/>' },
  light: { label: 'Light', next: 'dark', icon: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>' },
  dark: { label: 'Dark', next: 'auto', icon: '<path class="i-fill" d="M12.8 10.2A5.6 5.6 0 0 1 5.8 3.2a5.6 5.6 0 1 0 7 7z"/>' },
};
function renderTheme() {
  settings?.refresh();
  const t = window.apakiTheme;
  const b = $('theme');
  if (!b) return;
  if (!t) { b.hidden = true; return; }
  const ui = THEME_UI[t.get()];
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ui.icon}</svg>${ui.label}`;
  b.title = t.get() === 'auto' ? `Theme follows Windows (now ${t.effective()}). Click for ${THEME_UI[ui.next].label.toLowerCase()}.` : `${ui.label} theme. Click for ${THEME_UI[ui.next].label.toLowerCase()}.`;
}
if ($('theme')) $('theme').onclick = () => window.apakiTheme.set(THEME_UI[window.apakiTheme.get()].next);

/* ---------- the rail's bottom-left corner: Glass, Settings, Phone (2026-10-09) ---------- */

// On the phone (WEB) the card only shows: switching accounts and keep-warm are billing, which a phone never runs (remote-policy.js).
const glassCard = initGlassCard({ root: $('glassState'), send, menu, readOnly: WEB, note: (text, tone) => focusedPane()?.note(text, tone) });
const settings = initSettings({
  button: $('settings'), sheet, send, theme: window.apakiTheme, themeUi: THEME_UI, indexText, warm: !WEB,
  // Auto-compact is the PC's: it applies to every Claude Code Apaki starts, and a phone cannot send that op (remote-policy.js).
  compact: !WEB,
  sound: { on: soundOn, set: (on) => { setSoundOn(on); if (on) ding('done'); } },
});
// The Phone button is phone.js's (initPhone below fills it in); the glyph shows until that module loads.
if ($('phone') && !$('phone').innerHTML.trim()) {
  $('phone').innerHTML = '<svg viewBox="0 0 16 16" class="ph-glyph" aria-hidden="true"><rect class="ph-body" x="3.8" y="1.2" width="8.4" height="13.6" rx="2.1"/><rect class="ph-screen" x="5.3" y="3" width="5.4" height="8.6" rx=".9"/><path class="ph-home" d="M7 13.2h2"/></svg>';
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderTheme);
window.addEventListener('apaki-theme', renderTheme);
// The webview plays sound only after a user gesture: arm on the first one.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, arm, { capture: true });
window.addEventListener('resize', closeMenu);

/** A pane came back (turn finished) or needs an answer: ding, and mark it if you are not looking at it. */
function cameBack(p, kind) {
  ding(kind);
  const watching = document.hasFocus() && activeTab() === tabOf(p) && focusedPane() === p;
  if (!watching) { p.unread = true; p.el.classList.add('unread'); }
  renderTabs();
}

/* ---------- voice (local Whisper) ---------- */

// Click a pane's mic to start, click again to stop (2 minutes at most). One
// recording at a time; the text lands in the message box of the pane that
// recorded it. Audio is 16 kHz mono WAV, transcribed on this PC by whisper.cpp.
const VOICE_MAX_MS = 120000;
let rec = null;

function wavFrom(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function startVoice(pane) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); } catch (e) { pane.note(`Microphone unavailable: ${e.message}`, 'error'); return; }
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (ev) => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  const started = Date.now();
  rec = { pane, stream, ctx, proc, chunks, started, timer: setInterval(() => { pane.setStatus(`Listening · ${Math.round((Date.now() - started) / 1000)}s · click the mic to stop`); if (Date.now() - started > VOICE_MAX_MS) stopVoice(); }, 250) };
  pane.$.mic.classList.add('rec');
}

function stopVoice(discard = false) {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.pane.$.mic.classList.remove('rec');
  r.proc.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  const rate = r.ctx.sampleRate;
  r.ctx.close();
  if (discard || !r.chunks.length) { r.pane.setStatus(''); return; }
  r.pane.setStatus('Transcribing…');
  send('transcribe', { paneId: r.pane.id, wav: wavFrom(r.chunks, rate) });
}

function toggleVoice(pane) {
  if (rec) { const same = rec.pane === pane; stopVoice(); if (same) return; }
  startVoice(pane);
}

/* ---------- paste ---------- */

document.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (!files.length) return;
  e.preventDefault();
  let pane = S.panes.get(document.activeElement?.closest?.('.pane')?.dataset.pane) || focusedPane();
  if (pane?.isViewer) pane = S.panes.get(pane.sourcePane) || null;
  for (const f of files) await pane?.addImageFile?.(f);
});
// Files dropped outside a pane must not navigate the window away.
document.addEventListener('dragover', (e) => { if (dragKind(e) === 'files') e.preventDefault(); });
document.addEventListener('drop', (e) => { if (dragKind(e) === 'files') e.preventDefault(); });

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  // F3 / Shift+F3: the next or previous match in the focused pane (find.js).
  if (e.key === 'F3' && !e.ctrlKey && !e.altKey) { e.preventDefault(); findStep(focusedPane(), e.shiftKey ? -1 : 1); return; }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  // Ctrl+F: find in the focused pane (its conversation, task or artifact), not the browser's own find.
  if (k === 'f' && !e.shiftKey) { e.preventDefault(); openFind(focusedPane()); return; }
  if (k === 't') { e.preventDefault(); addTab(); return; }
  if (k === 'w') { e.preventDefault(); const p = focusedPane(); if (p) closePane(p); return; }
  // Ctrl+B: hide or show the sidebar, as in VS Code.
  if (k === 'b' && !e.shiftKey && !WEB) { e.preventDefault(); setRailCollapsed(!S.railCollapsed); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const i = S.tabs.indexOf(activeTab());
    switchTab(S.tabs[(i + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length]);
    focusPane(focusedPane());
    return;
  }
  if (/^[1-6]$/.test(e.key)) {
    const id = L.ids(activeTab()?.root)[Number(e.key) - 1];
    if (id) { e.preventDefault(); focusPane(S.panes.get(id)); }
  }
});

/* ---------- sheets (questions, plan approval, billing), one at a time ---------- */

const sheetQueue = [];
let sheetOpen = false;

// The key of the sheet showing now (a question's askId), and how to close it, so a question that
// went stale can be taken away (ask_gone) before anyone answers it twice.
let sheetKey = null;
let sheetClose = null;

// onClose (optional): called once when this sheet goes, however it closes (a button, or dropSheet taking it away).
function sheet(html, wire, key = null, onClose = null) {
  if (sheetOpen) { sheetQueue.push([html, wire, key, onClose]); return; }
  sheetOpen = true;
  sheetKey = key;
  $('sheet').innerHTML = html;
  $('scrim').hidden = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    $('scrim').hidden = true;
    sheetOpen = false;
    sheetKey = null;
    sheetClose = null;
    try { onClose?.(); } catch { /* a cleanup must not keep the next sheet from showing */ }
    const next = sheetQueue.shift();
    if (next) sheet(...next);
  };
  sheetClose = close;
  wire($('sheet'), close);
}

/** Takes away the sheet for `key`, showing or still queued. */
function dropSheet(key) {
  if (!key) return;
  for (let i = sheetQueue.length - 1; i >= 0; i--) if (sheetQueue[i][2] === key) sheetQueue.splice(i, 1);
  if (sheetOpen && sheetKey === key) sheetClose?.();
}

/**
 * A tool Claude Code asks about (Ask permissions, Auto-accept edits): what it wants to do, and Allow once, Always
 * allow (the engine saves the rule the SDK suggested, as Claude Code does) or Deny with an optional note for Claude.
 * Enter allows once and Esc denies; the engine settles it once, and drops this sheet if the turn ends first (ask_gone).
 * The same sheet runs on the phone page (apaki/ui is shared).
 */
function permissionSheet(e) {
  const view = permissionView(e);
  const pane = S.panes.get(e.paneId);
  const html = permissionHtml(view, { from: pane?.title || '' });
  const reply = (result) => send('answer', { askId: e.askId, result });
  let onKey = null;
  let before = null;
  sheet(html, (root, close) => {
    before = document.activeElement;
    const noteBox = root.querySelector('[data-note]');
    const denyBtn = root.querySelector('[data-k=deny]');
    const armedAt = Date.now() + ARM_MS;
    const choose = (kind) => {
      const note = noteBox?.value || '';
      close();
      reply(permissionReply(kind, note));
    };
    denyBtn.onclick = () => choose('deny');
    root.querySelector('[data-k=once]').onclick = () => choose('once');
    const always = root.querySelector('[data-k=always]');
    if (always) always.onclick = () => choose('always');
    // The button says when the note goes with it.
    noteBox?.addEventListener('input', () => { denyBtn.textContent = denyLabel(noteBox.value, view.labels?.deny); });
    onKey = (ev) => {
      if (!root.isConnected || sheetKey !== e.askId) return;
      const t = ev.target;
      const target = t === noteBox ? 'field' : t?.closest?.('button') ? 'button' : 'other';
      const act = permissionKey({ key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, shiftKey: ev.shiftKey, repeat: ev.repeat, target, noteText: noteBox?.value || '', armed: Date.now() >= armedAt, defaultToNo: view.defaultToNo });
      if (!act) return;
      ev.preventDefault();
      ev.stopPropagation();
      choose(act);
    };
    document.addEventListener('keydown', onKey, true);
    // Keys must land in the sheet, not in the message box behind it. When the SDK asked for a default of no, the
    // prompt opens on Deny; otherwise on the sheet itself, so a stray Enter in the first moments approves nothing.
    root.tabIndex = -1;
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-labelledby', 'permQ');
    (view.defaultToNo ? denyBtn : root).focus({ preventScroll: true });
  }, e.askId, () => {
    if (onKey) document.removeEventListener('keydown', onKey, true);
    $('sheet').removeAttribute('role');
    $('sheet').removeAttribute('aria-labelledby');
    $('sheet').removeAttribute('tabindex');
    if (before?.isConnected && before !== document.body) before.focus?.({ preventScroll: true });
  });
}

function askSheet(e) {
  // The engine asks again when a window reconnects (attach); a sheet already showing or waiting for this question is the same one.
  if (e.askId && (sheetKey === e.askId || sheetQueue.some((q) => q[2] === e.askId))) return;
  // A tool call waiting for permission (engine permissions.js) has its own sheet; questions and plan approval follow.
  if (e.permission) { permissionSheet(e); return; }
  const input = e.input || {};
  const pane = S.panes.get(e.paneId);
  const from = pane ? `<div class="from">${esc(pane.title)}</div>` : '';
  const reply = (result) => send('answer', { askId: e.askId, result });
  if (e.toolName === 'ExitPlanMode') {
    sheet(`${from}<h2>Ready to code?</h2><div class="turn-assistant plan">${md(input.plan || '')}</div>
      <div class="row"><button data-k="keep">Keep planning</button><button class="primary" data-k="go">Approve</button></div>`, (root, close) => {
      root.querySelector('[data-k=go]').onclick = () => { close(); reply({ behavior: 'allow', updatedInput: input }); if (pane?.mode === 'plan') pane.setMode('bypassPermissions'); };
      root.querySelector('[data-k=keep]').onclick = () => { close(); reply({ behavior: 'deny', message: 'The user wants to keep planning.' }); };
    }, e.askId);
    return;
  }
  const qs = input.questions || [];
  const picks = qs.map(() => new Set());
  const who = pane?.kind === 'codex' ? 'Codex' : 'Claude';
  const html = `${from}<h2>${who} has ${qs.length === 1 ? 'a question' : `${qs.length} questions`}</h2>${qs.map((q, qi) => `
    ${q.header && q.header !== q.question && pane?.kind === 'codex' ? `<div class="from">${esc(q.header)}</div>` : ''}<div class="q">${esc(q.question)}</div>
    ${(q.options || []).map((o, oi) => `<button class="opt" data-q="${qi}" data-o="${oi}">${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}
    <input type="${q.secret ? 'password' : 'text'}" data-other="${qi}" placeholder="${q.options?.length ? 'Or type your own answer' : 'Type your answer'}"${q.secret ? ' autocomplete="off"' : ''}>`).join('')}
    <div class="row"><button data-k="skip">Skip</button><button class="primary" data-k="ok">Answer</button></div>`;
  sheet(html, (root, close) => {
    root.querySelectorAll('.opt').forEach((b) => {
      b.onclick = () => {
        const qi = Number(b.dataset.q);
        const oi = Number(b.dataset.o);
        if (!qs[qi].multiSelect) { picks[qi].clear(); root.querySelectorAll(`.opt[data-q="${qi}"]`).forEach((x) => x.classList.remove('on')); }
        if (picks[qi].has(oi)) picks[qi].delete(oi); else picks[qi].add(oi);
        b.classList.toggle('on', picks[qi].has(oi));
      };
    });
    root.querySelector('[data-k=ok]').onclick = () => {
      const answers = {};
      qs.forEach((q, qi) => {
        const other = root.querySelector(`[data-other="${qi}"]`).value.trim();
        answers[q.question] = other || [...picks[qi]].map((oi) => q.options[oi].label).join(', ');
      });
      close();
      reply({ behavior: 'allow', updatedInput: { ...input, answers } });
    };
    root.querySelector('[data-k=skip]').onclick = () => { close(); reply({ behavior: 'deny', message: 'The user skipped the question.' }); };
  }, e.askId);
}

function billingSheet(options, paneId) {
  const pane = S.panes.get(paneId);
  const html = `${pane ? `<div class="from">${esc(pane.title)}</div>` : ''}<h2>Billing</h2><div class="note">Following Glass moves this conversation whenever Glass switches Claude between Platform credits and a subscription.</div>
    ${options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o.label)}</button>`).join('')}
    <div class="row"><button data-k="x">Cancel</button></div>`;
  sheet(html, (root, close) => {
    root.querySelectorAll('.opt').forEach((b) => { b.onclick = () => { close(); send('billing', { paneId, value: options[Number(b.dataset.i)].value }); }; });
    root.querySelector('[data-k=x]').onclick = close;
  });
}

/* ---------- saving and restoring the workspace ---------- */

let saveTimer = null;
/**
 * Everything needed to reopen the window as it was (Arthur, 2026-10-10: "the
 * state of everything in myrlin apaki needs to be persistent and constantly
 * saved so in case of a crash, on opening it everything goes back to where it
 * was"): tabs and splits with their sizes, each pane's session, settings,
 * draft, queued messages, scroll position and whether it was working; viewers
 * (artifacts, subagents, shells); the rail's view, open subagent lists and
 * scroll; the window's size and place.
 */
function snapshot() {
  const tabs = S.tabs.map((t) => ({
    focused: t.focused,
    root: L.mapLeaves(t.root, (lf) => {
      const p = S.panes.get(lf.pane);
      if (p?.isBrowser) return { type: 'leaf', pane: lf.pane, web: p.saved() };
      if (p?.isViewer) return { type: 'leaf', pane: lf.pane, view: p.saved() };
      return {
        // A pane following a desktop pane (followDesktop) is kept as an empty one: reopening its session would take it over.
        type: 'leaf', pane: lf.pane, s: (!p?.following && p?.sessionId) || null, cwd: p?.cwd || '', title: p?.following ? '' : p?.title || '', model: p?.model, effort: p?.effort, mode: p?.mode,
        // A new Codex conversation has no session id to say so yet (2026-10-12).
        ...(p?.kind === 'codex' ? { kind: 'codex' } : {}),
        draft: p?.$?.input?.value || '', queue: (p?.queue || []).filter((q) => q.text).map((q) => ({ id: q.id, text: q.text })),
        // A pane in a background tab has no box to measure: its remembered place is saved, not "at the end, 0" (pane.js scrollState, 2026-10-12).
        scroll: p?.scrollState ? p.scrollState() : null,
        busy: Boolean(p?.busy && !p?.following), pendingName: p?.pendingName || null,
        // The shared view: what the pane follows, and the conversation it showed (for its Open here if the PC's pane is gone by then).
        ...(p?.following ? { follow: p.following, fs: p.sessionId || null, ft: p.title || '' } : {}),
      };
    }),
  }));
  return { v: 1, savedAt: Date.now(), active: S.tabs.findIndex((t) => t.id === S.active), tabs, rail: { view: S.view, expanded: [...S.expanded], scroll: $('sessions')?.scrollTop || 0, width: S.railW || null, collapsed: Boolean(S.railCollapsed), wtFolded: wtc.foldedList() }, win: S.win || null };
}

/** Saves at once: localStorage, and the engine's copy on disk (desktop only). */
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!S.restored) return; // nothing to save over the last good state before it is back
  const st = snapshot();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(st)); } catch { /* not saved */ }
  if (!WEB) send('saveState', { state: st });
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}
// Closing, hiding or a reload: save what is there now, without waiting.
window.addEventListener('pagehide', saveNow);
window.addEventListener('beforeunload', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
setInterval(() => { if (S.restored) save(); }, 5000);

function readLocal() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return null; }
}

function restore(saved = readLocal()) {
  const tabs = saved?.v === 1 && Array.isArray(saved.tabs) ? saved.tabs : [];
  if (saved?.rail) {
    if (typeof saved.rail.view === 'string') S.view = saved.rail.view;
    S.expanded = new Set(Array.isArray(saved.rail.expanded) ? saved.rail.expanded : []);
    wtc.setFolded(saved.rail.wtFolded);
    S.railScroll = saved.rail.scroll || 0;
    if (Number.isFinite(saved.rail.width)) S.railW = saved.rail.width;
    S.railCollapsed = saved.rail.collapsed === true;
    applyRail();
  }
  if (saved?.win) S.win = saved.win;
  for (const st of tabs) {
    const seen = new Set();
    const root = L.mapLeaves(st.root, (lf) => {
      // A subagent or shell viewer comes back following its file.
      if (lf.view?.task) return L.leaf(createTaskViewer(lf.view, lf.pane).id);
      // A browser comes back with its page, loaded the first time it is on screen.
      if (lf.web) return L.leaf(createBrowser({ ...lf.web, adopt: S.alive.has(lf.pane) }, lf.pane).id);
      // A diff viewer comes back reading its worktree's changes again.
      if (lf.view?.diff) return L.leaf(createDiffViewer(lf.view.diff, lf.pane).id);
      // A viewer comes back showing its artifact's latest revision.
      if (lf.view?.id) return L.leaf(createViewer(lf.view, lf.pane).id);
      // A pane that followed a pane on the PC follows it again (the shared view); opening its conversation here would take it over.
      if (typeof lf.follow === 'string' && lf.follow) {
        const fp = createPane({ id: lf.pane, sessionId: lf.fs || null, cwd: lf.cwd, title: lf.ft, model: lf.model, effort: lf.effort, mode: lf.mode, kind: lf.kind });
        fp.setFollowing(lf.follow, { readOnly: phoneCap() !== 'full' });
        send('follow', { paneId: fp.id, desktopPaneId: lf.follow });
        return L.leaf(fp.id);
      }
      // One session per pane, ever: a duplicate in old saved state opens as a new conversation.
      const sid = lf.s && !seen.has(lf.s) ? lf.s : null;
      if (sid) seen.add(sid);
      // The session id is set at once so a save before the engine answers keeps it.
      const p = createPane({ id: lf.pane, sessionId: sid, cwd: lf.cwd, title: lf.title, model: lf.model, effort: lf.effort, mode: lf.mode, kind: lf.kind });
      // What you were typing, what was queued, where you were reading, a name waiting for its session.
      if (lf.draft) { p.$.input.value = lf.draft; p.autosize(); p.renderSendButton?.(); }
      // The saved id is kept: the engine may hold the same item (it sends it itself when the turn ends with no window), and matches by id (pane.js adoptQueue).
      if (Array.isArray(lf.queue) && lf.queue.length) { p.queue = lf.queue.map((q, i) => ({ id: typeof q.id === 'string' && q.id ? q.id : `r${i}${Date.now().toString(36)}`, text: q.text, attachments: [] })); p.renderQueue(); }
      if (lf.scroll) p.restoreScroll = lf.scroll;
      if (lf.pendingName) p.pendingName = lf.pendingName;
      if (lf.busy) p.crashNote = true;
      p.open(sid ? { id: sid, cwd: lf.cwd, title: lf.title } : null, { warm: false });
      return L.leaf(p.id);
    });
    if (!root || !L.valid(root)) continue;
    const t = createTab(root);
    t.focused = L.has(root, st.focused) ? st.focused : L.ids(root)[0];
    layout(t);
  }
  if (!S.tabs.length) { addTab(); return; }
  switchTab(S.tabs[Math.min(Math.max(0, saved?.active ?? 0), S.tabs.length - 1)]);
  focusPane(focusedPane());
}

/* ---------- engine events ---------- */

const PANE_EVENTS = new Set(['steered', 'steer_missed', 'locked', 'taken_over', 'opened', 'history', 'session_id', 'sdk', 'result', 'billing', 'commands', 'note', 'error', 'transcript', 'settings', 'artifactContent', 'agentLines', 'outputText', 'taskOutput', 'context', 'historyPage', 'historyBlock', 'followers', 'peerMessage']);

/** Phone access (phone.js), set up at start; null in the phone web client. */
let phone = null;

// Registered before anything is sent: `listen` is async, and events that
// arrive before it resolves are lost (a reload lost restored panes' opens).
await listen('engine', ({ payload: e }) => {
  // Git worktrees (worktree.js): the repositories, and the answers to what this window asked about them.
  if (wtc.handle(e)) return;
  // Something Claude showed: a card in its conversation, and the viewer beside it.
  if (e.ev === 'artifact' || e.ev === 'openUrl') {
    const p = S.panes.get(e.paneId);
    p?.handle(e);
    // A turn's changes and a picture Codex looked at are cards (their Open shows the viewer); only Claude's and Codex's own shows pop one up.
    if (e.ev === 'artifact' && (!CARD_ONLY_VIA.has(e.via) || e.open)) openViewer({ ...e, sourcePane: e.paneId }, { auto: !e.open });
    // openUrl: the engine already put it in the built-in browser (browserId),
    // or this window does now (beside the conversation, without the focus).
    if (e.ev === 'openUrl' && !e.browserId && p) openUrlHere(e.url, p, { focus: false, reason: e.reason || 'show' });
    return;
  }
  // What Claude just did in a browser (browser_click, _type...): a line in that browser's strip.
  if (e.ev === 'browserActivity') {
    const b = S.panes.get(e.browserId);
    if (b?.isBrowser) b.activity(e.text || e.action || '');
    return;
  }
  if (e.paneId && PANE_EVENTS.has(e.ev)) {
    const p = S.panes.get(e.paneId);
    if (!p) return; // a pane closed while its event was on the way
    p.handle(e);
    if (e.ev === 'result') cameBack(p, 'done');
    if (e.ev === 'taken_over') cameBack(p, 'ask');
    if (e.ev === 'opened' || e.ev === 'session_id') { p.renderFolderSelect(S.folders, S.sessions); renderTabs(); renderRailMarks(); save(); }
    return;
  }
  switch (e.ev) {
    case 'ready':
      S.voice = Boolean(e.voice);
      S.defaults.billing = e.billing;
      // Codex is installed here: the Codex view and the new-conversation choice show. Back in that view from the last session, read its threads.
      S.codexAvailable = Boolean(e.codex);
      if (S.view === 'codex') loadCodexThreads();
      if (!S.codexAvailable && S.view === 'codex') S.view = 'all';
      for (const p of S.panes.values()) p.setVoice(S.voice);
      // The engine restarted: every pane lost its Claude Code process. Reopen
      // each one (without starting Claude Code until its next message).
      engineBanner(false);
      S.engineUpdating = false;
      if (S.engineLost) {
        S.engineLost = false;
        S.offlineNoted = false;
        for (const p of S.panes.values()) {
          // Viewers load again from the new engine's server address.
          if (p.isViewer) { p.engineBack(); continue; }
          // A pane that follows a PC pane follows it again (opening its conversation would take it over).
          if (p.following) { send('follow', { paneId: p.id, desktopPaneId: p.following }); continue; }
          p.open(p.sessionId ? { id: p.sessionId, cwd: p.cwd, title: p.title } : null, { warm: false });
        }
      }
      send('sessions');
      send('worktrees');
      phone?.refresh();
      break;
    case 'index':
      S.indexLine = e.ok ? `Words index up to date · ${e.stats?.blocks_added ?? 0} new · ${(e.ms / 1000).toFixed(1)}s` : 'Conversation index unavailable; search uses titles only.';
      renderIndexState();
      break;
    case 'meaning':
      // The meaning index (embeddings): its first build takes a few minutes on the GPU.
      if (e.stage === 'loading') S.meaningLine = 'Meaning index: loading the model…';
      else if (e.stage === 'embedding' && e.total) S.meaningLine = e.total > 200 ? `Meaning index ${Math.round((e.done / e.total) * 100)}% · ${e.done.toLocaleString()} of ${e.total.toLocaleString()} passages · ${e.device === 'gpu' ? 'GPU' : 'CPU'}` : '';
      else if (e.stage === 'ready') S.meaningLine = e.result?.ok ? `Meaning index ready · ${(e.result.passages || 0).toLocaleString()} passages` : 'Meaning index unavailable; searching by words';
      renderIndexState();
      break;
    case 'sessions':
      if (e.voice !== undefined) { S.voice = Boolean(e.voice); for (const p of S.panes.values()) p.setVoice(S.voice); }
      S.sessions = e.items; S.folders = e.folders;
      if (e.billing) S.defaults.billing = S.defaults.billing || e.billing;
      for (const p of S.panes.values()) {
        p.renderFolderSelect(S.folders, S.sessions);
        const s = p.sessionId && S.sessions.find((x) => x.id === p.sessionId);
        // One name per session: a rename anywhere (here, /rename in a terminal, latch) reaches the tab.
        if (s?.title && s.title !== p.title && !s.bare && !p.renaming && !/^New session \(/.test(s.title)) { p.setTitle(s.title); renderTabs(); }
        // Restored from the archive (a message brought it back) or newly an archived copy: the line at its top follows.
        if (s && p.historyShownFor === s.id && Boolean(s.archivedCopy) !== Boolean(p.archivedCopy)) p.setArchivedCopy?.(s.archivedCopy);
      }
      S.warm = new Set(S.sessions.filter((x) => x.warm).map((x) => x.id));
      // Rows that were showing their subagents when the workspace was saved.
      for (const id of S.expanded) if (!S.subs.has(id)) send('subagents', { sessionId: id });
      renderRail();
      if (S.railScroll != null) { $('sessions').scrollTop = S.railScroll; S.railScroll = null; }
      renderTabs();
      for (const p of S.panes.values()) p.renderTasksButton?.();
      break;
    case 'terminals': {
      // A terminal window opened, closed or changed status (engine live.js): marks and In terminals at once.
      const t = e.terminals || {};
      for (const s of S.sessions) s.terminal = t[s.id] ? { name: t[s.id].name, status: t[s.id].status, pid: t[s.id].pid } : null;
      for (const [id, r] of Object.entries(t)) {
        if (!S.sessions.some((s) => s.id === id)) S.sessions.unshift({ id, title: `New session (${r.name || 'terminal'})`, firstPrompt: '', cwd: r.cwd || '', lastModified: r.updatedAt || Date.now(), terminal: { name: r.name, status: r.status, pid: r.pid }, folder: null });
      }
      if (!S.drag) renderRail();
      break;
    }
    case 'codexModels':
      // Codex's models with each one's efforts (engine codexModels): the pickers of every Codex pane use them.
      if (!e.error) { S.codex = { models: e.models || [], defaults: e.defaults || null, presets: e.presets || [], account: e.account || null }; for (const p of S.panes.values()) p.codexModelsChanged?.(); }
      break;
    case 'codexThreads': {
      // The Codex threads on this PC: they replace the Codex rows of the list (the other rows are not touched).
      if (e.error && !(e.items || []).length) { $('searchState').textContent = `Codex: ${e.error}`; break; }
      const keep = S.sessions.filter((x) => !x.codex);
      S.sessions = [...keep, ...(e.items || [])];
      for (const p of S.panes.values()) {
        const s = p.sessionId && S.sessions.find((x) => x.id === p.sessionId);
        if (s?.codex && s.title && !p.renaming) p.setTitle(s.title);
      }
      renderRail();
      renderTabs();
      break;
    }
    case 'subagents': {
      // A session's subagents and shells on disk (engine tasks.js): the rail list and the Tasks panel.
      S.subs.set(e.sessionId, { agents: e.agents || [], shells: e.shells || [], at: Date.now() });
      const s = S.sessions.find((x) => x.id === e.sessionId);
      if (s) s.subagents = (e.agents || []).length;
      if (S.expanded.has(e.sessionId) && !S.drag) renderRail();
      const pp = tasksPanelPane();
      if (pp && pp.sessionId === e.sessionId) openTasksPanel(pp, null);
      for (const p of S.panes.values()) if (p.sessionId === e.sessionId) p.renderTasksButton?.();
      break;
    }
    case 'subagentsChanged': {
      const s = S.sessions.find((x) => x.id === e.sessionId);
      if (s) s.subagents = e.count;
      if (S.expanded.has(e.sessionId) || tasksPanelPane()?.sessionId === e.sessionId) send('subagents', { sessionId: e.sessionId });
      else if (s && !S.drag) renderRail();
      for (const p of S.panes.values()) if (p.sessionId === e.sessionId) p.renderTasksButton?.();
      break;
    }
    case 'state': S.stateWait?.(e.state || null); S.stateWait = null; break;
    case 'warm':
      S.warm = new Set(e.sessions || []);
      if (!S.drag) renderRail();
      renderTabs();
      break;
    case 'renamed': {
      const p = e.paneId ? S.panes.get(e.paneId) : null;
      const where = p || focusedPane();
      if (!e.ok) { where?.note(`Not renamed: ${e.message}`, 'error'); send('sessions'); break; }
      setSessionTitle(e.sessionId, e.title);
      if (e.pending) where?.note(`"${e.title}" is saved when this turn ends.`);
      if (e.note) where?.note(e.note, 'warn');
      break;
    }
    case 'folders':
      S.folders = e.folders;
      if (S.view !== 'all' && S.view !== 'terminal' && S.view !== 'worktrees' && !S.folders.some((f) => f.id === S.view)) S.view = 'all';
      send('sessions');
      break;
    case 'search':
      if (e.query !== S.query || S.ai) break;
      S.results = e.results;
      S.searchTerms = e.terms || null;
      S.lastSearch = { query: e.query, n: e.results.length, ms: e.elapsed, how: e.semantic ? 'words + meaning' : e.deep ? 'words' : 'titles only' };
      S.searchInfo = e.deep ? `Every conversation, subagent and Codex session${e.semantic ? ', matched by words and by meaning' : ''}.${askHint()}` : 'The conversation index is unavailable; matching titles only.';
      renderLens();
      renderRail();
      break;
    case 'askProgress':
      if (e.query !== S.query) break;
      S.asking = e.text;
      renderLens();
      break;
    case 'askSearch':
      if (e.query !== S.query) break;
      S.asking = null;
      if (e.error) { S.ai = null; renderLens(); $('lensInfo').innerHTML = `<b>Claude</b> · ${esc(e.error)}`; break; }
      S.searchTerms = [...(S.searchTerms || []), ...(e.terms || [])];
      S.ai = { summary: `${e.results.length} of ${e.considered} fit · ${e.model} on ${e.billing} · ${(e.ms / 1000).toFixed(1)} s${e.cost != null ? ` · $${e.cost.toFixed(3)}` : ''}` };
      S.results = e.results;
      S.searchInfo = e.note || (e.terms?.length ? `Searched for: ${e.terms.join(' · ')}` : '');
      renderLens();
      renderRail();
      break;
    case 'digReady': {
      // A dedicated search session: a new tab, its first message already written and sent.
      const t = addTab();
      const p = S.panes.get(t.focused);
      if (p) { p.$.input.value = e.prompt; p.autosize(); p.submit(); }
      break;
    }
    case 'open_elsewhere': {
      const p = S.panes.get(e.paneId);
      const other = S.panes.get(e.otherPane);
      if (other) focusPane(other);
      p?.note('That session is already open in another pane.', 'warn');
      break;
    }
    case 'ask': {
      const p = S.panes.get(e.paneId);
      if (p) cameBack(p, 'ask');
      // A phone that may only watch (follows a PC pane at No shell or Chat only) cannot answer it: the PC refuses. One line says where.
      if (e.readOnly) { p?.note('Claude is asking a question on the PC. This phone can watch, not answer: answer it there, or take the conversation over here.'); break; }
      askSheet(e);
      break;
    }
    // A question nobody waits for any more (the turn ended, or Claude asked again): take its sheet away.
    case 'ask_gone': dropSheet(e.askId); break;
    case 'billingOptions': billingSheet(e.options, e.paneId); break;
    case 'places': startUI?.places(e); break;
    case 'dir': startUI?.dir(e); break;
    case 'glass':
    case 'glass_op':
    case 'glass_swap':
      // What Myrlin Glass has Claude Code and Codex on right now; updates the moment Glass swaps (glasscard.js).
      glassCard.handle(e);
      break;
    case 'warmState': settings.handle(e); break;
    case 'autoCompact': settings.handle(e); break;
    // The PC closed the pane this phone's pane follows (or no longer has it): the pane says so (pane.js followEnded). The answer to this
    // phone's own unfollow or close finds nothing (the pane left already, or follows no more).
    case 'closed': { const p = S.panes.get(e.paneId); if (p?.following) p.followEnded(); break; }
    case 'remote': phone?.handle(e); break;
    case 'note': focusedPane()?.note(e.text, e.tone || ''); break;
    // Fresh installs (2026-10-10): Claude Code has no login yet, so the first message would fail.
    case 'auth': renderSignIn(e); break;
    case 'auth_signin': renderSignIn({ ...(S.auth || {}), note: e.message, noteOk: e.ok }); break;
    // A fork from the session menu: open it next to the original.
    case 'forked':
      addTab({ session: { id: e.sessionId, title: 'Fork', cwd: S.sessions.find((x) => x.id === e.from)?.cwd || '' } });
      if (WEB) phoneShowChat();
      break;
    case 'error':
      focusedPane()?.note(e.message, 'error');
      // A phone's menu action the PC refused (access, an older PC): the pane's note may be off screen, so a toast says it too.
      if (WEB && e.refused) phoneToast(e.message, false);
      break;
    // The engine is about to move to a newer build that was installed while Apaki was open (host.js codeStamp).
    case 'engineRestarting': S.engineUpdating = true; break;
    case 'engine_exit':
      S.engineLost = true;
      for (const p of S.panes.values()) p.engineLost();
      // The background engine may still be running (its turns keep going): reconnecting re-attaches the panes.
      // One banner over the window, gone once it is back (2026-10-11: two notes per attempt piled up in the pane).
      engineBanner(true);
      break;
    default: break;
  }
});

// The built-in browser's events (src/browser.rs): pages made, their state,
// the keyboard in a page, a page closing itself.
await listen('browser', ({ payload: e }) => {
  const b = S.panes.get(e.id);
  switch (e.ev) {
    case 'created': case 'reveal': placeBrowser(e); break;
    case 'state': if (b?.isBrowser) { b.update(e); if (!b.live) b.attach(e); } break;
    case 'focus': if (b) focusPane(b, { scroll: false }); break;
    case 'key': if (b) focusPane(b, { scroll: false }); shortcut(e.key, e.shift); break;
    case 'closeRequested': if (b) closePane(b, { confirmBusy: false }); break;
    case 'closed': if (b?.isBrowser && e.error) b.gone(`The browser could not start: ${e.error}`); break;
    default: break;
  }
});
// The pages are native windows over this one: they follow every layout
// change, and step aside (a picture in their place) for menus, sheets and drags.
new MutationObserver(() => syncSoon()).observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true });
new MutationObserver(() => syncSoon()).observe($('scrim'), { attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('resize', () => syncSoon());
// Pages see Apaki's theme (prefers-color-scheme) and its ground while loading.
const sendTheme = () => invoke('browser', { cmd: 'theme', args: { dark: document.documentElement.dataset.theme === 'dark' } }).catch(() => {});
new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
sendTheme();
// Pages the shell kept across a reload of this window: restored panes adopt them, the rest close.
try { S.alive = new Set(((await invoke('browser', { cmd: 'list', args: {} }))?.browsers || []).map((x) => x.id)); } catch { S.alive = new Set(); }

/* ---------- window buttons (the OS title bar is off) ---------- */

// Arthur, 2026-10-09: the title bar "needs to not be a separate section -
// should seamlessly be a part of the application". The brand row and the tab
// row are the top of the window (data-tauri-drag-region on their empty space:
// drag moves, double-click maximizes); these are its three buttons.
{
  const win = window.__TAURI__.window.getCurrentWindow();
  const box = $('winctl');
  box.querySelector('[data-w=min]').onclick = () => win.minimize();
  box.querySelector('[data-w=max]').onclick = () => win.toggleMaximize();
  box.querySelector('[data-w=close]').onclick = () => win.close();
  const syncMax = async () => {
    const max = await win.isMaximized().catch(() => false);
    document.body.classList.toggle('maximized', max);
    box.querySelector('[data-w=max]').title = max ? 'Restore' : 'Maximize';
  };
  win.onResized(syncMax);
  // Its size and place are part of the workspace (restoreWindow below puts them back).
  const track = async () => {
    try {
      const [pos, size, max] = await Promise.all([win.outerPosition(), win.outerSize(), win.isMaximized()]);
      S.win = max ? { ...(S.win || {}), max: true } : { x: pos.x, y: pos.y, w: size.width, h: size.height, max: false };
      save();
    } catch { /* not allowed or closing */ }
  };
  win.onResized(track);
  win.onMoved?.(track);
  syncMax();
}

/* ---------- start ---------- */

renderSound();
renderTheme();
// Phone access (phone.js, with the QR encoder) loads on the desktop only.
if (WEB) $('phone')?.remove();
else phone = (await import('./phone.js')).initPhone({ send, sheet, ding, button: $('phone') });
/** Puts the window back where it was, if that place is still on a screen. */
async function restoreWindow(w) {
  if (!w || WEB) return;
  const T = window.__TAURI__;
  const win = T.window.getCurrentWindow();
  try {
    if (w.max) { await win.maximize(); return; }
    if (!(w.w > 480 && w.h > 360)) return;
    await win.setSize(new T.dpi.PhysicalSize(w.w, w.h));
    const mons = await T.window.availableMonitors();
    const onScreen = mons.some((m) => w.x + 120 > m.position.x && w.x + 120 < m.position.x + m.size.width && w.y + 20 > m.position.y && w.y + 20 < m.position.y + m.size.height);
    if (onScreen) await win.setPosition(new T.dpi.PhysicalPosition(w.x, w.y));
  } catch { /* stays where Windows put it */ }
}

// The engine's copy of the workspace (on disk, so a crash or a lost WebView
// profile cannot lose it); the newer of it and localStorage wins.
const diskState = WEB ? null : await new Promise((resolve) => {
  S.stateWait = resolve;
  send('loadState');
  setTimeout(() => { if (S.stateWait === resolve) { S.stateWait = null; resolve(null); } }, 1500);
});
const localState = readLocal();
const startState = (diskState?.savedAt || 0) > (localState?.savedAt || 0) ? diskState : localState;
restore(startState);
S.restored = true;
restoreWindow(startState?.win);
save();
renderTabs();
for (const id of S.alive) if (!S.panes.get(id)?.isBrowser) invoke('browser', { cmd: 'close', args: { id } }).catch(() => {});
syncSoon();
// Ask the engine for its state in case it was ready before this page loaded.
send('sessions');
send('worktrees');
// Sessions open in terminals change on their own: refresh the list now and then.
// The engine keeps the list live (live.js); this is only a slow safety net, and it no longer waits for idle panes.
setInterval(() => { if (!S.query && !S.drag) send('sessions'); }, 60000);
$('refreshSessions').onclick = () => {
  const b = $('refreshSessions');
  b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  send('sessions');
  // The Codex view reads Codex again too (the list also refreshes when the view opens).
  if (S.view === 'codex') loadCodexThreads(true);
};

// For apaki/scripts/cdp-check.mjs: the live state, read only.
// 2026-10-11: focusPane and openFromRail for the phone (apaki/web/src/pager.js focuses the pane a swipe settles on;
// desktop.js opens a conversation from "On your desktop" the way a tap in the session list does, or follows the desktop
// pane with followDesktop when the PC offers 'follow'). The window never calls them.
window.__apaki = { S, L, wt: wtc, openDiff, focusedPane, activeTab, addTab, arrangeGrid, openViewer, viewers, browsers, openUrlHere, syncBrowsers, focusPane, openFromRail, followDesktop, dropSession: (s, edge) => { const t = activeTab(); const target = focusedPane(); dropSession(t, target ? { where: edge === 'center' ? 'center' : 'edge', edge, pane: target } : { where: 'root' }, s); } };
