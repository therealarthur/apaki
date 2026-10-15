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
 * Keys: Ctrl+T new tab, Ctrl+W close pane, Ctrl+Tab next tab, Ctrl+1..6 pane,
 * Ctrl+Shift+Enter maximize or restore the focused pane.
 *
 * Tabs, layouts and viewers (2026-10-12, apaki/docs/layout.md, rules in
 * workspace.js): a tab is named after the project its conversations share
 * (or by you, double-click); new panes join an automatic layout chosen by
 * count and shape (or a preset from the Layout menu; a tree you drag into
 * shape stays as you made it); every viewer sits beside the conversation that
 * drives it and is linked to it by an accent; a conversation has one browser
 * pane whose pages are tabs; a session open anywhere is gone to, not opened
 * again; any pane can be maximized to the whole window and put back exactly.
 *
 * The side panel (2026-10-13, apaki/docs/layout.md, sidepanel.js; Arthur: "the
 * current way we display the browser is incredibly hectic ... have a dedicated
 * pane that comes out from the right side of the app"): on the PC, viewers no
 * longer take cells in the pane grid. Each tab has a panel docked to its right
 * edge holding everything its conversations opened (browser pages, artifacts,
 * changes, subagents and shells), grouped by conversation, following the
 * focused one; it collapses to a slim rail and drags wider or narrower. A tab's
 * viewers are its `items` (the tree holds conversations only); the phone, which
 * shows one pane at a time, still pages through them after their conversation.
 * Maximize fills the main area up to the panel.
 *
 * The tabs and layout are saved in localStorage and come back at launch;
 * restored panes start Claude Code on their first message.
 *
 * Browser panes (2026-10-09, browser.js): web pages open in a built-in
 * browser beside the conversation that asked (Claude's browser_open, show
 * with a URL, a caught "start https://...", BROWSER, or a link card's Open);
 * since 2026-10-13 in its tab's side panel. The page is a native WebView2 the
 * shell lays over the browser's body; syncBrowsers() below tells it where the
 * body is (the panel's content area), shows only the page on screen, and hides
 * it (with a picture in its place) while a menu, a sheet or a drag needs the
 * space. Hidden pages stay alive.
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
// Questions, plan approval and permission prompts (Allow once, Always allow, Deny; permission.js) as a card inside the
// pane that asked, never a sheet over the window (askcard.js, 2026-10-12: "it should be shown in the pane and not lock
// the user from using the app").
import { createAsks } from './askcard.js';
import { DRAG_TASK, KIND_LABEL, TaskPane, closeTasksPanel, newTaskViewerId, specKey, taskGlyph, tasksPanel, tasksPanelPane } from './tasks.js';
// Codex panes and rows (codex.js, 2026-10-12).
import { CARD_ONLY_VIA } from './codex.js';
import { ArtifactPane, isPublicWebUrl, kindGlyph, newViewerId } from './artifacts.js';
import { BrowserPane, samePage, tabInitial, tabTitle } from './browser.js';
// The side panel of each tab (2026-10-13): its DOM; the rules are workspace.js's.
import { SidePanel } from './sidepanel.js';
// Tab names, automatic layouts, viewer links, maximize (2026-10-12, apaki/docs/layout.md).
import * as W from './workspace.js';
// Git worktrees (2026-10-12): the branch label, the Worktrees view, the actions, and the diff viewer.
import { GLYPH_WORKTREE, branchName, hasLinked, initWorktrees } from './worktree.js';
import { DiffPane, newDiffViewerId } from './diff.js';
import { initTooltips, setTip } from './tooltip.js';
// The session list in the ChatGPT app's manner, folders that open in place, the session menu and Details (2026-10-12).
import {
  GLYPH, agoText, createOpenState, detailLine, detailsHtml, folderMenuItems, groupRows, leadHtml, navKey, placeChildren, rowTip, sessionFacts, sessionMenuItems, shortTime,
} from './sessionlist.js';
// Decorative motion rests while the window is hidden or unfocused (2026-10-12, input lag).
import { initRest } from './rest.js';
// What the main thread did, a minute at a time (perfwatch.js, 2026-10-15, window lag): Apaki's drawing paths are timed
// through it (renderRail, renderTabs, renderPanel, layout, saveNow, the engine's events), and a busy minute is logged.
import { watch } from './perfwatch.js';
import { osName, pc } from './platform.js';

initRest();

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
const STAGE_EDGE_PX = 30; // the band along the tab's outer edge where a drop spans the whole width or height (2026-10-15)
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
  defaults: { model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions', billing: null, tune: { ultracode: false, size: null } },
  tabs: [], active: null, panes: new Map(), drag: null,
  // Codex (2026-10-12): installed here (the engine's ready event), and the model list it read (event codexModels).
  codexAvailable: false, codex: null,
  // The session list (2026-10-12, sessionlist.js): what the engine read for Details (sessionInfo, by session id), the
  // questions and permission prompts waiting for an answer (askId -> paneId: a row says "waiting"), and whether the
  // folder list has arrived (the open folders are pruned only against a real list).
  info: new Map(), waiting: new Map(), foldersKnown: false,
  // The link accent of each conversation that has viewers (workspace.js accents), kept while it is free in its tab.
  accents: new Map(),
  // The viewer in the side panel you last clicked into (2026-10-13): Ctrl+W, Ctrl+L and Ctrl+F act on it while it has the focus.
  panelFocus: null,
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
  // An answer settles its question: the row stops saying "waiting" (sessionlist.js rowStates).
  if (op === 'answer' && args.askId && S.waiting.delete(args.askId) && !S.drag) queueMicrotask(() => renderRail());
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
/**
 * No room for another viewer, browser or task. Since 2026-10-13 viewers live in the tab's side panel (its `items`), as
 * tabs there, so a tab always has room for one (before: L.count(t.root) >= MAX_LEAVES); kept so the callers read as before.
 */
const tabFullForViewer = () => false;
/** The tab a pane is in: a conversation in its layout tree, a viewer in its side panel (items). */
const tabOf = (pane) => S.tabs.find((t) => L.has(t.root, pane.id) || (t.items || []).includes(pane.id)) || null;
/** Every pane of a tab: its conversations in layout order, then its viewers in the order they opened. */
const panesIn = (t) => [...L.ids(t?.root), ...(t?.items || [])].map((id) => S.panes.get(id)).filter(Boolean);
function focusedPane() {
  const t = activeTab();
  if (!t) return null;
  return S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]) || null;
}
const paneBySession = (id) => (id ? [...S.panes.values()].find((p) => p.sessionId === id) : null);

/* ---------- arrangements (2026-10-12, workspace.js) ---------- */

/** A tab's viewers: browsers, artifacts, diffs and tasks (its side panel's items since 2026-10-13). */
const viewersIn = (t) => (t?.items || []).map((id) => S.panes.get(id)).filter((p) => p && p.isViewer);
/** The viewers that belong to conversation pane `id`, wherever they are. */
const viewersOf = (id) => (id ? [...S.panes.values()].filter((v) => v.isViewer && v.sourcePane === id) : []);
/** What the layout rules need to know of a pane: a viewer or not, and whose. */
const paneInfo = (id) => { const p = S.panes.get(id); return { viewer: Boolean(p?.isViewer), source: p?.isViewer ? p.sourcePane || null : null }; };

/** The size of a tab's stage for the layout rules; a tab in the background measures as the one in front, less its side panel. */
function stageBox(t) {
  let r = t?.stage?.getBoundingClientRect();
  let less = 0;
  if (!r || r.width < 2 || r.height < 2) { r = $('stages')?.getBoundingClientRect(); less = panelSpace(t).w + panelSpace(t).g; }
  return { w: Math.max(1, Math.round((r?.width || window.innerWidth || 1600) - less)), h: Math.round(r?.height || window.innerHeight || 900) };
}

/** Lays tab t out again by its arrangement (a tree you made by hand stays as it is). order: the panes in the order to use. */
function rearrange(t, { order = null } = {}) {
  if (!t?.root || t.arrange === 'custom') return false;
  const box = stageBox(t);
  t.root = W.arrange(order || L.ids(t.root), paneInfo, { preset: t.arrange, ...box });
  t.shape = W.shapeOf(box.w, box.h);
  return true;
}

/**
 * Puts pane `id` into tab t: into its arrangement (Arthur, 2026-10-12: "they need to organize properly, not just split
 * side by side"), or, in a tree you made by hand, beside its conversation (a viewer) or into the largest pane.
 */
function joinTab(t, id, { source = null } = {}) {
  if (!t.root) { t.root = L.leaf(id); return; }
  if (L.has(t.root, id)) return;
  if (t.arrange === 'custom') {
    t.root = W.placeCustom(t.root, id, { source, viewersOf: (s) => viewersOf(s).map((v) => v.id), ...stageBox(t) });
    return;
  }
  rearrange(t, { order: [...L.ids(t.root), id] });
}

/**
 * Takes pane `id` out of tab t; its arrangement closes the gap (a hand-made tree gives the space to the neighbours).
 * A viewer leaves the tab's side panel instead (2026-10-13).
 */
function leaveTab(t, id) {
  if ((t.items || []).includes(id)) { removeItem(t, id); return; }
  t.root = L.remove(t.root, id);
  if (t.max === id) t.max = null;
  if (t.root) rearrange(t);
}

/** Pane `v` takes the place of pane `oldId` in tab t (a viewer of the same kind reused, or a drop on a pane's middle). */
function replaceInTab(t, oldId, v) {
  // A viewer's place is in the side panel's items (2026-10-13): the new one takes the old one's place there.
  const i = (t.items || []).indexOf(oldId);
  if (i >= 0) {
    t.items[i] = v.id;
    t.panel?.mount(v.el);
    for (const k of Object.keys(t.side.pick)) if (t.side.pick[k] === oldId) t.side.pick[k] = v.id;
    if (S.panelFocus === oldId) S.panelFocus = v.id;
  }
  t.root = L.mapLeaves(t.root, (lf) => (lf.pane === oldId ? L.leaf(v.id) : lf));
  if (t.focused === oldId) t.focused = v.id;
  if (t.max === oldId) t.max = v.id;
}

/** You arranged tab t by hand (a pane dropped on an edge, two swapped): new panes now fit around what you made. */
function madeCustom(t) { if (t) t.arrange = 'custom'; }

/* ---------- the side panel (2026-10-13, apaki/docs/layout.md; sidepanel.js draws it, workspace.js has the rules) ----------
   Arthur: "potentially have a dedicated pane that comes out from the right side of the app (that can be minimized and
   opened, that has all the browsers that are opened ... when clicking on a session, it switches the tab in the browser
   pane to the browser(s) specific to that session". Each tab keeps its viewers in `t.items` (the order they opened) and
   the panel's state in `t.side`: open or collapsed to a rail, your width, the group wanted (a conversation's id or Other)
   and the item picked in each group. The phone has no panel: its pager shows a tab's viewers as pages after their
   conversation (phoneRoot). */

const PANEL_GAP = 8;
/** Keep at most this many artifacts, or tasks, of one conversation in the panel; the oldest gives way (its conversation remembers it). */
const KEEP_PER_KIND = 8;

/** A side panel's state: closed until something opens in the tab, at the default width (saved: open, width, group, pick). */
function newSide(o = {}) {
  return {
    open: o.open === true,
    // Something opened (or you opened or collapsed the panel) since the tab last had nothing in it: the next thing that
    // opens does not open the panel by itself (Arthur: it "opens by itself the first time a session in that tab opens something").
    seen: o.seen === true || o.open === true,
    width: Number.isFinite(o.width) && o.width > 0 ? o.width : null,
    group: typeof o.group === 'string' ? o.group : null,
    pick: o.pick && typeof o.pick === 'object' && !Array.isArray(o.pick) ? Object.fromEntries(Object.entries(o.pick).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')) : {},
    // Groups where something new arrived that you have not looked at (drawn tinted until you do; not saved).
    fresh: new Set(),
  };
}

/** The main area's width, the box the panel's width is measured against. */
const mainBoxW = () => Math.max(0, Math.round(($('stages')?.getBoundingClientRect().width || window.innerWidth || 1400) - 2 * PANEL_GAP));

/** How much of the main area tab t's panel takes: { w, g, state }: its width and the gap beside it, none when it holds nothing. */
function panelSpace(t) {
  if (WEB || !t?.panel || !(t.items || []).length) return { w: 0, g: 0, state: 'none' };
  if (!t.side.open) return { w: W.PANEL_RAIL, g: PANEL_GAP, state: 'rail' };
  return { w: W.panelWidth(t.side.width, mainBoxW()), g: PANEL_GAP, state: 'open' };
}

/** The tab in front's panel space, as the CSS the stage and the maximized layer stop at (app.css --spw, --spg). */
function applyPanelSpace(space = panelSpace(activeTab())) {
  const s = document.body.style;
  if (s.getPropertyValue('--spw') !== `${space.w}px`) s.setProperty('--spw', `${space.w}px`);
  if (s.getPropertyValue('--spg') !== `${space.g}px`) s.setProperty('--spg', `${space.g}px`);
}

/** The group viewer v belongs to in tab t's panel: its conversation when that is in the same tab, else Other. */
function groupOfViewer(t, v) {
  const src = S.panes.get(v?.sourcePane);
  return src && !src.isViewer && L.has(t?.root, src.id) ? src.id : W.OTHER;
}

/** Tab t's panel groups and entries (workspace.js panelGroups), from its conversations and its viewers. */
function groupsOf(t) {
  const items = viewersIn(t).map((v) => ({ id: v.id, kind: W.kindOf(v), source: v.sourcePane, pages: v.isBrowser ? v.tabs.map((x) => x.id) : undefined }));
  return W.panelGroups(L.ids(t?.root), items);
}

/** What a group is called in the switcher: its conversation's title, or Other. */
const groupLabel = (key) => (key === W.OTHER ? 'Other' : S.panes.get(key)?.title || 'Conversation');
/** One or two letters for a group on the collapsed rail: the first letters of its first two words that say something. */
const RAIL_SKIP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'and', 'with', 'at', 'by']);
const initialsOf = (s) => {
  const words = String(s || '').match(/[\p{L}\p{N}]+/gu) || [];
  const said = words.filter((w, i) => i === 0 || !RAIL_SKIP.has(w.toLowerCase()));
  return said.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '·';
};

/** One entry as the panel draws it: its title, its mark (a page's initial, a kind's glyph) and its state. */
function entryModel(e) {
  const v = S.panes.get(e.item);
  if (!v) return { ...e, title: 'Closed', mark: '' };
  if (v.isBrowser) {
    const st = (e.page && v.tab(e.page)?.st) || v.st || {};
    const title = tabTitle(st);
    return { ...e, title, mark: `<span class="sp-init">${esc(tabInitial(st))}</span>`, tip: `Page: ${title}${st.url && st.url !== 'about:blank' ? `\n${st.url}` : ''}`, loading: Boolean(st.loading), failed: Boolean(st.error) };
  }
  const kind = W.kindOf(v);
  const word = { diff: 'Changes', task: 'Task', artifact: 'Artifact' }[kind] || 'Viewer';
  const mark = kind === 'diff' ? GLYPH_WORKTREE : kind === 'task' ? taskGlyph(v.spec?.kind || 'task') : kindGlyph(v.art?.kind);
  // The viewer's own header (its file, size) gives way to its toolbar in the panel, so the tab's tooltip names the file.
  const where = v.art?.source || v.art?.path || v.spec?.path || '';
  return { ...e, title: v.title || word, mark, tip: `${word}: ${v.title || ''}${where ? `\n${String(where).replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')}` : ''}` };
}

/** A group's tooltip: whose it is and what it holds ("2 pages, 1 artifact"). */
function groupTip(g) {
  const n = { browser: 0, artifact: 0, diff: 0, task: 0 };
  for (const e of g.entries) n[e.kind] = (n[e.kind] || 0) + 1;
  const parts = [n.browser && `${n.browser} page${n.browser === 1 ? '' : 's'}`, n.artifact && `${n.artifact} artifact${n.artifact === 1 ? '' : 's'}`, n.diff && `${n.diff} changes`, n.task && `${n.task} task${n.task === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  return g.key === W.OTHER ? `Other: ${parts}. Their conversations are closed or in no tab here.` : `${groupLabel(g.key)}: ${parts}. Click to show them and go to the conversation.`;
}

/** The viewer that has the panel's focus (you clicked into it), in the tab in front with its panel open; else null. */
function panelFocused() {
  const t = activeTab();
  if (WEB || !t || !S.panelFocus || !t.side.open || !(t.items || []).includes(S.panelFocus)) return null;
  return S.panes.get(S.panelFocus) || null;
}

/** Draws tab t's side panel (timed for the minute line, perfwatch.js; drawPanel draws). */
function renderPanel(t) { return watch.time('panel', () => drawPanel(t)); }

/** Draws tab t's side panel (cheap: each part is replaced only when its HTML changed) and, in front, the space it takes. */
function drawPanel(t) {
  if (WEB || !t?.panel) return;
  const space = panelSpace(t);
  const groups = groupsOf(t);
  const fp = S.panes.get(t.focused);
  const focus = fp && !fp.isViewer ? fp.id : null;
  const { group, note } = W.shownGroup(groups, { focus, want: t.side.group });
  if (group && space.state === 'open') t.side.fresh.delete(group);
  for (const k of [...t.side.fresh]) if (!groups.some((g) => g.key === k)) t.side.fresh.delete(k);
  const g = groups.find((x) => x.key === group) || null;
  const cur = W.currentEntry(g, t.side.pick[group], (id) => S.panes.get(id)?.active || null);
  t.panel.render({
    state: space.state,
    width: space.w,
    min: W.PANEL_MIN,
    groups: groups.map((x) => ({ key: x.key, label: groupLabel(x.key), initial: initialsOf(groupLabel(x.key)), acc: x.conv && S.accents.has(x.conv) ? S.accents.get(x.conv) : null, count: x.entries.length, tip: groupTip(x), fresh: t.side.fresh.has(x.key) })),
    group,
    groupLabel: group ? groupLabel(group) : '',
    entries: (g?.entries || []).map(entryModel),
    entry: cur?.key || null,
    shown: cur?.item || null,
    note: note && group ? `"${fp?.title || 'This conversation'}" has nothing open here. Showing ${group === W.OTHER ? 'Other' : `"${groupLabel(group)}"`}.` : '',
    focused: Boolean(t.id === S.active && panelFocused()),
  });
  if (t.id === S.active) applyPanelSpace(space);
}

let panelQueued = false;
/** The tab in front's panel, drawn again on the next frame (titles, page loads, accents). */
function panelSoon() {
  if (WEB || panelQueued) return;
  panelQueued = true;
  const go = () => { panelQueued = false; renderPanel(activeTab()); };
  if (document.visibilityState === 'visible') requestAnimationFrame(go); else setTimeout(go, 30);
}

/**
 * Puts viewer v in tab t's side panel (the phone: among its pages). show: it becomes the entry its conversation shows.
 * focus: you asked for it (a card's Open, a click): the panel opens on it. Claude's own opens (focus false) open the panel
 * by itself only the first time something opens in the tab, come to the front only when they belong to the focused
 * conversation (or the focused conversation has nothing open), are marked new otherwise, and never take the keyboard.
 */
function hostItem(t, v, { show = true, focus = false } = {}) {
  if (!t || !v) return;
  if (!t.items.includes(v.id)) t.items.push(v.id);
  if (WEB) { layout(t); return; }
  t.panel.mount(v.el);
  const group = groupOfViewer(t, v);
  if (show) t.side.pick[group] = v.id;
  const focusOwn = groupsOf(t).some((g) => g.key === t.focused);
  if (focus || group === t.focused || !focusOwn) { if (show) t.side.group = group; } else t.side.fresh.add(group);
  if (focus || !t.side.seen) t.side.open = true;
  if (!t.side.open) t.side.fresh.add(group);
  t.side.seen = true;
  renderPanel(t);
  syncSoon();
}

/** Takes viewer `id` out of tab t's panel; a panel left with nothing hides, and opens by itself again next time. */
function removeItem(t, id) {
  const i = (t.items || []).indexOf(id);
  if (i < 0) return;
  t.items.splice(i, 1);
  if (S.panelFocus === id) S.panelFocus = null;
  for (const k of Object.keys(t.side.pick)) if (t.side.pick[k] === id) delete t.side.pick[k];
  if (!t.items.length) { t.side.open = false; t.side.seen = false; t.side.group = null; t.side.fresh.clear(); }
}

/**
 * At most KEEP_PER_KIND artifacts (or tasks) of one conversation stay in the panel: past that the oldest one not on
 * screen closes, and its conversation keeps it in its reopen list (viewerClosed). Browser pages and changes are not trimmed.
 */
function trimKind(t, v) {
  const kind = W.kindOf(v);
  if (kind !== 'artifact' && kind !== 'task') return;
  const group = groupOfViewer(t, v);
  const same = viewersIn(t).filter((x) => x !== v && W.kindOf(x) === kind && groupOfViewer(t, x) === group);
  while (same.length >= KEEP_PER_KIND) closePane(same.shift(), { confirmBusy: false });
}

/** Shows viewer v in its tab's panel (opened, on its conversation's group, on v), and the panel takes the focus. */
function focusItem(v, { scroll = true } = {}) {
  const t = tabOf(v);
  if (!t) return;
  if (t.id !== S.active) switchTab(t);
  const group = groupOfViewer(t, v);
  t.side.group = group;
  t.side.pick[group] = v.id;
  t.side.open = true;
  t.side.seen = true;
  S.panelFocus = v.id;
  renderPanel(t);
  if (scroll && v.isBrowser && document.activeElement?.closest?.('.pane') !== v.el) v.focusInto();
  syncSoon();
  save();
}

/** The panel's actions for tab t (sidepanel.js calls them). */
function panelActions(t) {
  return {
    pickGroup: (key, o) => pickGroup(t, key, o),
    pickEntry: (en) => pickEntry(t, en),
    closeEntry: (en) => closeEntry(t, en),
    closeGroup: (key) => closeGroup(t, key),
    toggle: (open) => setPanelOpen(t, open),
    resize: (w, done) => { t.side.width = W.panelWidth(w, mainBoxW()); renderPanel(t); if (done) save(); },
    resetWidth: () => { t.side.width = null; renderPanel(t); save(); },
    // Hovering a conversation's name in the panel rings its pane: the other end of the link.
    hoverGroup: (key, on) => { const p = S.panes.get(key); if (p && !p.isViewer) p.el.classList.toggle('link-hi', on); },
    menu: (anchor) => panelMenu(t, anchor),
  };
}

/**
 * A conversation picked in the switcher (or on the rail): the panel shows its things, and the conversation takes the
 * focus too (Arthur: "when clicking on a session, it switches the tab in the browser pane"). Maximized on another
 * conversation, the maximized view moves to it, so you stay in focus mode.
 */
function pickGroup(t, key, { open = false } = {}) {
  t.side.group = key;
  t.side.fresh.delete(key);
  if (open) { t.side.open = true; t.side.seen = true; }
  const p = S.panes.get(key);
  if (p && !p.isViewer && tabOf(p) === t) {
    if (t.max && t.max !== p.id) { S.panes.get(t.max)?.el.classList.remove('maxed'); t.max = p.id; layout(t); }
    focusPane(p);
  } else renderPanel(t);
  syncSoon();
  save();
}

/** An entry picked: it shows (a browser page becomes its browser's page on screen, and Claude's tools act on it). */
function pickEntry(t, en) {
  const v = S.panes.get(en.item);
  if (!v) return;
  const group = groupOfViewer(t, v);
  t.side.group = group;
  t.side.pick[group] = v.id;
  if (en.page && v.isBrowser && v.active !== en.page) v.activate(en.page, { pick: true });
  S.panelFocus = v.id;
  renderPanel(t);
  syncSoon();
  save();
}

/** An entry closed (its x, a middle click, Delete, Ctrl+W in the panel): a page closes in its browser, a viewer closes; the next one shows. */
function closeEntry(t, en) {
  const v = S.panes.get(en.item);
  if (!v) return;
  if (en.page && v.isBrowser && v.tabs.length > 1) { v.closeTab(en.page); renderPanel(t); syncSoon(); save(); return; }
  const group = groupOfViewer(t, v);
  const next = W.neighbourEntry(groupsOf(t).find((x) => x.key === group), en.key);
  if (next) t.side.pick[group] = next.item;
  closePane(v, { confirmBusy: false });
}

/** The entry on screen in tab t's panel, if any. */
function currentEntryOf(t) {
  const groups = groupsOf(t);
  const fp = S.panes.get(t.focused);
  const { group } = W.shownGroup(groups, { focus: fp && !fp.isViewer ? fp.id : null, want: t.side.group });
  return W.currentEntry(groups.find((x) => x.key === group), t.side.pick[group], (id) => S.panes.get(id)?.active || null);
}

/** Closes everything a group holds ("close all for this session"). */
function closeGroup(t, key) {
  for (const v of viewersIn(t).filter((x) => groupOfViewer(t, x) === key)) if (S.panes.has(v.id)) closePane(v, { confirmBusy: false });
}

/** Opens or collapses tab t's panel (its buttons, Ctrl+Shift+B, a drag nearly shut). Collapsed, a focused viewer gives the keyboard back. */
function setPanelOpen(t, open) {
  if (!t || WEB || !(t.items || []).length) return;
  t.side.open = Boolean(open);
  t.side.seen = true;
  if (!open && S.panelFocus && t.items.includes(S.panelFocus)) {
    S.panelFocus = null;
    const p = focusedPane();
    if (p && t.id === S.active) focusPane(p);
  }
  renderPanel(t);
  syncSoon();
  save();
}

/** Ctrl+Shift+B: the tab in front's panel, open or collapsed. */
function togglePanel() {
  const t = activeTab();
  if (t?.items?.length) setPanelOpen(t, !t.side.open);
}

/** The panel's ... menu: close all for the conversation shown, close everything, collapse. */
function panelMenu(t, anchor) {
  const groups = groupsOf(t);
  const fp = S.panes.get(t.focused);
  const { group } = W.shownGroup(groups, { focus: fp && !fp.isViewer ? fp.id : null, want: t.side.group });
  const g = groups.find((x) => x.key === group);
  const n = groups.reduce((a, x) => a + x.entries.length, 0);
  const items = [
    ...(g ? [{ value: 'group', label: group === W.OTHER ? 'Close all under Other' : `Close all for "${groupLabel(group)}"`, hint: `${g.entries.length} open` }] : []),
    ...(groups.length > 1 ? [{ value: 'all', label: 'Close everything in this panel', hint: `${n} open` }] : []),
    { divider: true },
    { value: 'hide', label: 'Collapse the panel', hint: 'Ctrl+Shift+B' },
  ];
  menu(anchor, items, {
    above: false,
    width: 300,
    onPick: (v) => {
      if (v === 'group' && group) closeGroup(t, group);
      else if (v === 'all') for (const x of viewersIn(t)) if (S.panes.has(x.id)) closePane(x, { confirmBusy: false });
      else if (v === 'hide') setPanelOpen(t, false);
    },
  });
}

/** The phone pages through a tab: each conversation followed by its viewers, then the viewers whose conversation is elsewhere. */
function phoneRoot(t) {
  const items = t.items || [];
  if (!items.length) return t.root;
  const order = W.groupsOf([...L.ids(t.root), ...items], paneInfo).flatMap((g) => [...(g.conv ? [g.conv] : []), ...g.viewers]);
  if (order.length < 2) return order.length ? L.leaf(order[0]) : null;
  return { type: 'split', dir: 'row', children: order.map(L.leaf), sizes: order.map(() => 1 / order.length) };
}

const host = {
  defaults: S.defaults,
  // This window's access on the PC: 'full' on the desktop, a phone's own below Full (the effort popup dims Ultracode under it).
  phoneCap: () => phoneCap(),
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
  // The Session in use card on a phone offers Watch live when a pane of the PC's window has the conversation (desktop.js deskPaneFor).
  deskPaneFor: (sessionId) => (WEB && window.__apakiLink?.supports?.('follow') ? window.__apaki?.deskPaneFor?.(sessionId) || null : null),
  watchLive: (p, desktopPaneId) => watchLive(p, desktopPaneId),
  voice: (p) => toggleVoice(p),
  folder: (p, value) => paneFolder(p, value),
  folderMenu: (p, anchor) => folderMenu(p.sessionId, anchor),
  newConversation: (p) => newConversation(p),
  // Reconnecting to the engine (engine_exit until the next ready): a pane keeps a message in its box instead of sending it.
  engineLost: () => Boolean(S.engineLost),
  // The console and Open in terminal run on the PC (console.js): the desktop window has them, the phone does not.
  consoleAvailable: () => !WEB,
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
  // A title changed: the tab names and the viewers' link chips (the conversation's name) follow (2026-10-12).
  changed: () => { renderTabs(); renderRailMarks(); renderLinks(); save(); },
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
  showSession: (id) => { const p = paneBySession(id); if (p) { revealPane(p); return; } const s = S.sessions.find((x) => x.id === id); if (s) openFromRail(s, { ctrlKey: true }); },
  // A tab picked in a browser pane's strip (browser.js, 2026-10-12): Claude's browser tools act on that page from now on.
  tabPicked: (b, browserId) => { if (b.sourcePane && !WEB) send('browserTab', { paneId: b.sourcePane, browserId }); syncSoon(); renderLinks(); save(); },
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

/* ---------- questions and approvals, inline (askcard.js, 2026-10-12) ---------- */

// Arthur: "when askuserquestion type things come up, it should be shown in the pane and not lock the user from using
// the app". Each question, plan approval and permission prompt is a card in the pane that asked, above its message box;
// the rest of the window keeps working. The pane's header says "Waiting for you", its tab is marked and counted in the
// taskbar badge like a ready one, and one click on the tab brings the card the keyboard.
const asks = createAsks({
  send,
  web: WEB,
  isFocusedPane: (p) => activeTab() === tabOf(p) && focusedPane() === p,
  onChange: () => { syncWaiting(); renderTabs(); },
  // Approving a plan leaves plan mode, as the sheet did.
  onAnswered: (p, act) => { if (act.then === 'plan-approved' && p?.mode === 'plan') p.setMode('bypassPermissions'); },
});

/** The pane of tab t that waits for an answer: its focused one when that one does, else the first. */
function waitingPaneIn(t) {
  const ids = L.ids(t?.root);
  if (t?.focused && ids.includes(t.focused) && asks.waiting(t.focused)) return S.panes.get(t.focused) || null;
  const id = ids.find((x) => asks.waiting(x));
  return id ? S.panes.get(id) || null : null;
}

/** The session list's "waiting for your answer" rows (S.waiting, sessionlist.js) follow the cards. */
function syncWaiting() {
  const now = asks.pending();
  if (now.length === S.waiting.size && now.every(([id, paneId]) => S.waiting.get(id) === paneId)) return;
  S.waiting.clear();
  for (const [id, paneId] of now) S.waiting.set(id, paneId);
  if (!S.drag) renderRail();
}

/* ---------- git worktrees (worktree.js, diff.js; 2026-10-12) ---------- */

// Arthur: "The best approach to AI development is using git worktrees to tackle multiple features simultaneously ...
// make sure we're updating the app alongside the desktop app so all functionality is equal across the board." This
// file runs on the phone page too, so everything below is on both; a phone's access level decides what the engine runs.
// Apaki's own hover tooltips in place of the browser's title boxes (tooltip.js, Arthur 2026-10-12).
initTooltips();

// A freeze leaves a trace (2026-10-13, Arthur: "still freezes up pretty often"): a stall of this page's main thread over
// a second goes to apaki-window.log with what the window held, at most one line every 5 seconds. Desktop only.
if (!WEB && typeof PerformanceObserver === 'function') {
  let lastStall = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // Every long task counts toward the minute's line (below).
        watch.longTask(e.duration);
        if (e.duration < 1000 || Date.now() - lastStall < 5000) continue;
        lastStall = Date.now();
        const panes = [...S.panes.values()];
        const text = `stall ${Math.round(e.duration)} ms; ${S.tabs?.length ?? '?'} tabs, ${panes.length} panes, ${panes.filter((p) => p.busy).length} working, ${document.visibilityState}, ${document.hasFocus() ? 'focused' : 'unfocused'}`;
        invoke('ui_log', { text }).catch(() => {});
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* no long-task timing here */ }
}

// A busy minute leaves a trace too (2026-10-15, Arthur: "it gets kind of laggy with multiple tabs and panes running at
// the same time - it doesnt stay sharp"). Lag without a single long stall is a thread that is busy most of the time in
// shorter pieces, which the stall line above never sees. Once a minute, when the main thread was busy for more than
// BUSY_LOG_PCT of it, one line goes to apaki-window.log: how busy, the long tasks and the worst, and where Apaki's own
// time went by drawing path (perfwatch.js), with what the window held. Desktop only; costs a timer every 250 ms.
if (!WEB) {
  watch.start();
  setInterval(() => {
    const panes = [...S.panes.values()];
    const m = watch.minute(`${S.tabs?.length ?? '?'} tabs, ${panes.length} panes, ${panes.filter((p) => p.busy).length} working`);
    if (m.line) invoke('ui_log', { text: m.line }).catch(() => {});
  }, 60_000);
}

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

/**
 * The engine sent repositories: every branch label, diff viewer, tab tooltip and the sidebar follow.
 * shape: false when only the numbers moved (worktree.js layoutKey). The engine sends the repositories again after
 * every turn and every few seconds while files change, almost always with new numbers only; the session list (400
 * rows) and the tab bar show no numbers outside the Worktrees view, so since 2026-10-15 (window lag: the list was drawn
 * again every 2 to 3 seconds per working pane) they are drawn again only when something they show changed.
 */
function wtChanged({ save: keep = false, shape = true } = {}) {
  for (const p of S.panes.values()) {
    if (p.isDiff) p.repoChanged();
    else if (!p.isViewer) p.setCwdLine();
  }
  if (shape || S.view === 'worktrees') {
    if (!S.drag) railSoon();
    renderTabs();
  }
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
  decorate(v);
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
  // An empty tab takes it too on the PC (its side panel shows it); the phone gives it a tab of its own, as before.
  if (!t || (!t.root && WEB) || tabFullForViewer(t)) {
    const nt = createTab(null);
    const v = createDiffViewer({ ...spec, ownerPane: src && !src.isViewer ? src.id : null });
    hostItem(nt, v, { focus: true });
    if (WEB) nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  const v = createDiffViewer({ ...spec, ownerPane: src && !src.isViewer ? src.id : null });
  // One diff viewer per conversation on the phone (2026-10-12): another worktree's changes take the place of the one it
  // shows. The PC's side panel gives each its own tab (2026-10-13).
  const old = WEB && src && !src.isViewer ? W.viewerFor([...S.panes.values()], 'diff', src.id) : null;
  const ot = old && tabOf(old);
  if (old && ot) {
    replaceInTab(ot, old.id, v);
    S.panes.delete(old.id);
    old.destroy();
    layout(ot);
    focusPane(v);
    renderTabs();
    save();
    return v;
  }
  // Into the side panel of the conversation's tab (the phone: its pages, laid out again), shown, the panel open.
  hostItem(t, v, { focus: true });
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
  decorate(v);
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
  // The conversation's artifact viewer, wherever it is: one of a kind per conversation on the phone (2026-10-12; a diff or
  // task viewer is not one). The PC's side panel gives each artifact a tab of its own (2026-10-13).
  if (!v && art.sourcePane && WEB) v = W.viewerFor([...S.panes.values()], 'artifact', art.sourcePane);
  const keep = document.activeElement;
  const restoreFocus = () => { if (!focus && keep && document.contains(keep) && document.activeElement !== keep) keep.focus({ preventScroll: true }); };
  if (v) {
    v.show(art);
    // A new revision comes to the front of the panel the way a new artifact does (hostItem), without the keyboard.
    const vt = tabOf(v);
    if (vt && !WEB) hostItem(vt, v, { focus });
    if (focus) focusPane(v); else restoreFocus();
    renderTabs();
    save();
    return v;
  }
  if (!t || tabFullForViewer(t)) {
    if (auto && t) return null;
    const nt = createTab(null);
    v = createViewer(art);
    hostItem(nt, v, { focus: true });
    if (WEB) nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  v = createViewer(art);
  // In the side panel of its conversation's tab, under that conversation (2026-10-13); on the phone a page after it.
  hostItem(t, v, { focus });
  if (WEB && !t.focused) t.focused = v.id;
  if (focus) focusPane(v); else restoreFocus();
  if (!WEB) trimKind(t, v);
  renderTabs();
  save();
  return v;
}

/* ---------- browser panes (browser.js, the shell's src/browser.rs) ---------- */

const browsers = () => [...S.panes.values()].filter((p) => p.isBrowser);
// Pages the shell still held when this window (re)loaded; restored panes adopt them.
S.alive = new Set();

function createBrowser(o, id) {
  const b = new BrowserPane(id, host, { alive: S.alive, ...o });
  S.panes.set(b.id, b);
  decorate(b);
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
  // The conversation's browser pane already has this page in a tab: that tab is shown (2026-10-12, no page twice).
  const bp = owner ? W.viewerFor([...S.panes.values()], 'browser', owner.id) : null;
  const same = bp?.tabs.find((x) => samePage(x.st.url, url));
  if (same) {
    bp.activate(same.id, { pick: true });
    // On the PC it is shown again in the side panel (opened when you asked for it).
    const bt = tabOf(bp);
    if (bt && !WEB) hostItem(bt, bp, { focus });
    if (focus) focusPane(bp);
    syncSoon();
    return;
  }
  // Otherwise a new tab in that pane (the shell makes the page, placeBrowser puts it in the pane), or the pane itself.
  invoke('browser', { cmd: 'open', args: { owner: owner?.id || null, url, focus, reason, hint: 'tab' } })
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
/** The browser pane that has the shell's page `id` as one of its tabs. */
const browserOf = (id) => (id ? browsers().find((b) => b.hasTab(id)) || null : null);

/**
 * The shell made or showed a page (Claude's browser_open, a page from show or BROWSER, a link card's Open, a new tab
 * from the pane's +). Since 2026-10-12 (Arthur: "additional tabs wanted to be opened by the session should open those
 * tabs IN the browser pane") a conversation has one browser pane and every page it opens is a tab there: the shell's
 * hint ('tab', 'new') no longer means an Apaki tab. A conversation with no browser pane yet gets one beside it, in its
 * part of the layout; a page with no conversation behind it gets a pane of its own. A new Apaki tab only when the
 * conversation's tab is full. Claude's own opens never take the focus.
 */
function placeBrowser(e) {
  const keep = document.activeElement;
  const restoreFocus = () => { if (!e.focus && keep && document.contains(keep) && document.activeElement !== keep) keep.focus({ preventScroll: true }); };
  let b = browserOf(e.id);
  if (b) {
    b.addTab(e.id, e.state, { show: true });
    // On the PC the page comes to the front of the side panel (2026-10-13; hostItem decides how far, without the keyboard).
    const bt = tabOf(b);
    if (bt && !WEB) hostItem(bt, b, { focus: e.focus });
    if (e.focus) focusPane(b); else restoreFocus();
    renderTabs();
    save();
    syncSoon();
    return;
  }
  const owner = S.panes.get(e.owner) || null;
  b = owner && !owner.isViewer ? W.viewerFor([...S.panes.values()], 'browser', owner.id) : null;
  if (b) {
    b.addTab(e.id, e.state || { url: e.url || '' }, { show: true });
    const bt = tabOf(b);
    // Before 2026-10-13 a maximized other pane covered the browser and was put back here; the side panel sits beside it now.
    if (bt && !WEB) hostItem(bt, b, { focus: e.focus });
    if (e.focus) focusPane(b); else restoreFocus();
    renderTabs();
    save();
    syncSoon();
    return;
  }
  b = createBrowser({ owner: e.owner, url: e.url || e.state?.url || '', title: e.state?.title || '' }, e.id);
  b.attach(e.id, e.state);
  const t = (owner && tabOf(owner)) || activeTab();
  if (!t || tabFullForViewer(t)) {
    const nt = createTab(null);
    hostItem(nt, b, { focus: true });
    if (WEB) nt.focused = b.id;
    layout(nt);
    if (e.focus || !t) { switchTab(nt); focusPane(b); }
  } else {
    // In the side panel of its conversation's tab, under that conversation (2026-10-13); on the phone a page after it.
    hostItem(t, b, { focus: e.focus });
    if (WEB && !t.focused) t.focused = b.id;
    if (e.focus) focusPane(b); else restoreFocus();
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

/**
 * Tells the shell where every browser's page goes, and which show. On the PC (2026-10-13) a page shows only when it is
 * the entry on screen in the side panel of the tab in front, with the panel open: its place is the panel's content
 * area. Every other page is hidden, and stays alive.
 */
function syncBrowsers() {
  syncQueued = false;
  const cover = overlays();
  const active = activeTab();
  for (const b of browsers()) {
    const t = tabOf(b);
    // The phone (no built-in browser of its own) keeps the old rule; a maximized pane covers nothing of the panel.
    const shown = WEB ? (!t?.max || t.max === b.id) : Boolean(t?.panel && t.side.open && t.panel.shown === b.id && b.el.classList.contains('sp-on'));
    const here = Boolean(t && t === active && b.el.isConnected && shown);
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
  // Ctrl+Shift+B (2026-10-13): the tab's side panel, open or collapsed (src/browser.rs forwards it from inside a page).
  if (k === 'b' && shift && !WEB) { togglePanel(); return; }
  if (k === 't') { addTab(); return; }
  // Ctrl+W with the side panel's focus closes what it shows (a page, a viewer); otherwise the focused pane.
  if (k === 'w') { const v = panelFocused(); const t = activeTab(); const en = v && t ? currentEntryOf(t) : null; if (en) { closeEntry(t, en); return; } const p = focusedPane(); if (p) closePane(p); return; }
  if (k === 'l') { const p = panelFocused() || focusedPane(); if (p?.isBrowser) p.focusAddress(); return; }
  if (key === 'Tab') {
    const i = S.tabs.indexOf(activeTab());
    switchTab(S.tabs[(i + (shift ? -1 : 1) + S.tabs.length) % S.tabs.length]);
    focusPane(focusedPane());
    return;
  }
  // Ctrl+Shift+Enter: maximize the focused pane to the whole window, or put it back (2026-10-12).
  if (k === 'enter' && shift) { const p = focusedPane(); if (p) toggleMaximize(p); return; }
  if (/^[1-6]$/.test(k)) { const id = L.ids(activeTab()?.root)[Number(k) - 1]; if (id) focusNth(S.panes.get(id)); }
}

/**
 * Ctrl+1..6: that conversation. With another one maximized, the maximized view moves to it (2026-10-13, Arthur: "if a
 * session has several panes you should be able to navigate those panes"), so you stay in focus mode; before, the
 * maximized pane was put back first.
 */
function focusNth(p) {
  const t = p && tabOf(p);
  if (t?.max && t.max !== p.id) { S.panes.get(t.max)?.el.classList.remove('maxed'); t.max = WEB ? null : p.id; layout(t); save(); }
  focusPane(p);
}

function createPane(settings = {}) {
  const p = new Pane(settings.id || newPaneId(), host, settings);
  p.setVoice(S.voice);
  p.renderFolderSelect(S.folders, S.sessions);
  S.panes.set(p.id, p);
  decorate(p);
  return p;
}

/**
 * A tab. name: the one you gave it ('' for the automatic name, workspace.js tabLabel); arrange: how new panes are laid
 * out ('auto', a preset, or 'custom' for a tree you made by hand); max: the pane maximized to the whole window, if any.
 */
function createTab(root = null, { name = '', arrange = 'auto', max = null, shape = null, side = null } = {}) {
  const stage = el('div', 'stage');
  stage.append(el('div', 'drop-hint'));
  $('stages').append(stage);
  // shape: 'wide' or 'tall', what its arrangement was made for (a saved tab laid out for another shape re-flows when shown).
  // items and side (2026-10-13): the viewers in its side panel, and the panel's state (newSide).
  const t = { id: newTabId(), root, focused: root ? L.ids(root)[0] : null, stage, name, arrange: W.ARRANGEMENTS.includes(arrange) || arrange === 'custom' ? arrange : 'auto', max, shape: shape === 'wide' || shape === 'tall' ? shape : null, items: [], side: newSide(side || {}) };
  // The side panel sits beside the stage, at the right of the main area; the phone has none (its pager shows viewers as pages).
  if (!WEB) {
    t.panel = new SidePanel(panelActions(t));
    $('stages').append(t.panel.el);
  }
  wireStage(t);
  S.tabs.push(t);
  return t;
}

/**
 * The model, effort and mode a new pane takes from the pane it comes from: Claude's own, never a Codex pane's.
 * Ultracode itself is not passed on (2026-10-13): it spends far more than any effort level, so each pane turns it on
 * where it is wanted; the workflow size a person picked is kept, ready for when they do.
 */
const inheritable = (base) => (base && base.kind !== 'codex' ? { model: base.model, effort: base.effort, mode: base.mode, tune: { ultracode: false, size: base.tune?.size || null } } : {});

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
  for (const x of S.tabs) { x.stage.classList.toggle('on', x === t); x.panel?.el.classList.toggle('on', x === t); }
  // Its side panel, and the space it takes (the stage and a maximized pane stop at it).
  renderPanel(t);
  if (WEB || !t.panel) applyPanelSpace({ w: 0, g: 0 });
  // The tab in front: its own maximized pane (or none), and its arrangement fitted to the window's shape now.
  if (t.root && t.arrange !== 'custom' && t.shape && t.shape !== W.shapeOf(stageBox(t).w, stageBox(t).h) && rearrange(t)) layout(t);
  syncMax();
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
  // On the PC a viewer lives in its tab's side panel (2026-10-13): it shows there and the panel takes the focus; the
  // tab's focused conversation stays the one it was.
  if (p.isViewer && !WEB) { focusItem(p, { scroll }); return; }
  p.checkDrift?.();
  if (t.id !== S.active) switchTab(t);
  if (t.focused !== p.id || !p.el.classList.contains('focused')) {
    t.focused = p.id;
    for (const x of panesIn(t)) x.el.classList.toggle('focused', x.id === p.id);
    save();
  }
  // The side panel follows the focused conversation (Arthur: "when clicking on a session, it switches the tab in the
  // browser pane to the browser(s) specific to that session"); one with nothing open keeps the panel as it was, with a note.
  if (!WEB && !p.isViewer) {
    S.panelFocus = null;
    t.side.group = W.followFocus(groupsOf(t), p.id, t.side.group);
    renderPanel(t);
  }
  if (p.unread) { p.unread = false; p.el.classList.remove('unread'); }
  // On a phone the keyboard would cover the conversation it just opened: it comes up when the person taps the box (2026-10-10).
  // A pane with a question waiting gives the keyboard to its card instead (askcard.js), so its numbers and Enter answer it.
  if (scroll && !WEB && document.activeElement?.closest?.('.pane') !== p.el && !asks.focus(p)) p.$.input?.focus({ preventScroll: true });
  if (scroll && p.isBrowser && document.activeElement?.closest?.('.pane') !== p.el) p.focusInto();
  document.title = `Myrlin Apaki · ${p.title}`;
  renderTabs();
  renderRailMarks();
}

/**
 * Closing a conversation that has viewers asks first (2026-10-12, apaki/docs/layout.md): close them with it, or the
 * conversation only. A small menu at its close button on the PC, a sheet on the phone.
 */
function askCloseWithViewers(p, opts) {
  const vs = viewersOf(p.id);
  const n = vs.length;
  const what = n === 1 ? `its ${W.kindOf(vs[0]) === 'browser' ? 'browser' : 'viewer'}` : `its ${n} viewers`;
  const go = (with_) => closePane(p, { ...opts, viewers: with_ ? 'close' : 'keep' });
  if (WEB) {
    sheet(`<div class="from">${esc(p.title)}</div><h2>Close ${esc(what)} too?</h2>
      <div class="row"><button data-k="keep">Conversation only</button><button class="primary" data-k="all">Close all</button></div>`, (root, close) => {
      root.querySelector('[data-k=keep]').onclick = () => { close(); go(false); };
      root.querySelector('[data-k=all]').onclick = () => { close(); go(true); };
    });
    return;
  }
  const anchor = p.$?.close?.isConnected && p.$.close.getBoundingClientRect().width ? p.$.close : { x: window.innerWidth / 2, y: 80 };
  menu(anchor, [
    { value: 'all', label: `Close with ${what}`, hint: vs.map((v) => v.title).filter(Boolean).slice(0, 3).join(', ') },
    { value: 'keep', label: 'Close the conversation only', hint: n === 1 ? 'the viewer stays open' : 'the viewers stay open' },
  ], { above: false, width: 280, onPick: (v) => go(v === 'all') });
}

function closePane(p, { confirmBusy = true, viewers = 'ask' } = {}) {
  if (!p.isViewer && viewers === 'ask' && viewersOf(p.id).length && S.panes.has(p.id)) { askCloseWithViewers(p, { confirmBusy }); return; }
  if (confirmBusy && p.busy && !window.confirm(`"${p.title}" is still working. Stop it and close the pane?`)) return;
  if (!p.isViewer) {
    const vs = viewersOf(p.id);
    // Kept viewers remember whose they were, so their chip still says it (and reopens the session).
    for (const v of vs) { v.sourceTitle = p.title; v.sourceSession = p.sessionId || null; }
    if (viewers === 'close') for (const v of vs) if (S.panes.has(v.id)) closePane(v, { confirmBusy: false });
  }
  const t = tabOf(p);
  if (rec?.pane === p) stopVoice(true);
  // A phone pane that follows a desktop pane (followDesktop, below) stops following; it never closes the desktop's.
  if (!p.isViewer) send(p.following ? 'unfollow' : 'close', { paneId: p.id });
  S.panes.delete(p.id);
  asks.drop(p);
  syncWaiting();
  p.destroy();
  if (p.isViewer) { viewerClosed(p); refreshArtifactButtons(); }
  if (!t) return;
  // The tab's arrangement closes the gap (2026-10-12); a tree you made by hand gives the space to the neighbours. A viewer
  // leaves its tab's side panel (2026-10-13).
  leaveTab(t, p.id);
  if (t.focused === p.id) t.focused = (p.isViewer && p.sourcePane && L.has(t.root, p.sourcePane) ? p.sourcePane : null) || L.ids(t.root)[0] || null;
  if (!t.root && !t.items.length && S.tabs.length > 1) { closeTab(t, { confirmBusy: false }); return; }
  // On the PC a viewer closing changes only the panel: the conversations keep their places and the keyboard stays where it is.
  if (p.isViewer && !WEB) { renderPanel(t); renderLinks(); renderTabs(); syncSoon(); save(); return; }
  layout(t);
  const next = S.panes.get(t.focused);
  if (next) focusPane(next); else { renderTabs(); save(); }
}

function closeTab(t, { confirmBusy = true } = {}) {
  const panes = panesIn(t);
  if (confirmBusy && panes.some((p) => p.busy) && !window.confirm('A pane in this tab is still working. Stop it and close the tab?')) return;
  for (const p of panes) { if (!p.isViewer) send(p.following ? 'unfollow' : 'close', { paneId: p.id }); S.panes.delete(p.id); asks.drop(p); p.destroy(); }
  syncWaiting();
  for (const p of panes) if (p.isViewer) viewerClosed(p);
  refreshArtifactButtons();
  const i = S.tabs.indexOf(t);
  S.tabs.splice(i, 1);
  t.stage.remove();
  t.panel?.destroy();
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
    joinTab(t, p.id);
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
 * Watch live, from the Session in use card (pane.js showLocked): the pane asked to open a conversation a pane of the PC has, and
 * chose to watch it instead of taking it over. A new pane follows (followDesktop, or the one that follows it already is shown) and
 * the pane that met the lock closes, so the engine never has a half opened pane of this phone where the follower is to be.
 */
function watchLive(p, desktopPaneId) {
  if (!p || !desktopPaneId || !S.panes.has(p.id)) return;
  const title = p.title === 'New conversation' ? '' : p.title;
  const f = followDesktop({ desktopPaneId, title, viewOnly: phoneCap() !== 'full' });
  if (f && f !== p && S.panes.has(p.id)) closePane(p, { confirmBusy: false });
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
    (S.panes.get(t.focused) || p)?.note?.(`${L.MAX_PANES} conversations is the most per tab; opened in a new tab instead.`, 'warn');
    addTab({ cwd: o.cwd });
    return;
  }
  const base = p || focusedPane();
  // Home folder, like a new terminal ("Starts in" changes it); the model, effort and mode of the pane it came from.
  const np = createPane({ cwd: o.cwd || '', ...inheritable(base) });
  // It joins the tab's layout (2026-10-12: side by side, then one large and two stacked, then a grid...).
  joinTab(t, np.id);
  if (t.max) t.max = null;
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

/** Renders a tab's layout tree (timed for the minute line, perfwatch.js; drawLayout draws). */
function layout(t) { return watch.time('layout', () => drawLayout(t)); }

/** Renders a tab's layout tree, moving the existing pane elements (their state stays). */
function drawLayout(t) {
  // The tree drawn: the tab's conversations on the PC (its viewers are in the side panel); on the phone, whose pager pages
  // through a tab, every pane with each conversation's viewers after it (phoneRoot, 2026-10-13).
  const tree = WEB ? phoneRoot(t) : t.root;
  const scrolls = new Map();
  for (const id of L.ids(tree)) { const p = S.panes.get(id); if (p) scrolls.set(p, p.$.ground.scrollTop); }
  const hint = t.stage.querySelector('.drop-hint');
  t.stage.replaceChildren(hint);
  t.stage.classList.toggle('multi', L.count(tree) > 1);
  renderPanel(t);
  if (!tree) {
    const empty = el('div', 'stage-empty', `${MARK_SVG.replace('class="m-mark"', 'class="m-mark empty-mark"')}<p>Drag a session here from the left, or</p>`);
    const b = el('button', 'new', 'New conversation');
    b.onclick = () => { const p = createPane({}); t.root = L.leaf(p.id); t.focused = p.id; layout(t); p.open(null, { warm: true }); focusPane(p); };
    empty.append(b);
    t.stage.append(empty);
    if (t.id === S.active) syncMax();
    syncSoon();
    return;
  }
  if (t.max && !L.has(t.root, t.max)) t.max = null;
  const build = (node) => {
    // The maximized pane is drawn above the window (syncMax); its place in the tree keeps its size (2026-10-12).
    if (node.type === 'leaf' && node.pane === t.max) return el('div', 'pane-slot');
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
  const rootEl = build(tree);
  rootEl.style.flex = '1 1 0px';
  t.stage.append(rootEl);
  if (t.id === S.active) syncMax();
  for (const [p, top] of scrolls) p.$.ground.scrollTop = top;
  for (const id of L.ids(tree)) S.panes.get(id)?.el.classList.toggle('focused', id === t.focused);
  if (!t.shape && t.arrange !== 'custom') t.shape = W.shapeOf(stageBox(t).w, stageBox(t).h);
  renderLinks();
  syncSoon();
}

/* ---------- maximize (2026-10-12) ----------
   Arthur: "a full screen toggle that lets you maximize a pane to take the whole desktop app window size, and then a
   minimize that has it go back to the original size/location/layout it should be in the tab that it was in". The pane
   is drawn in a layer over the whole window; its tab's tree is not touched (a placeholder keeps its place), so putting
   it back is exact, and the other panes keep running behind it. Each tab keeps its own (t.max, saved). */

/** The layer a maximized pane is drawn in. */
function maxLayer() {
  let m = $('paneMax');
  if (!m) { m = el('div', 'pane-max-layer'); m.id = 'paneMax'; document.body.append(m); }
  return m;
}

/** Shows the tab in front's maximized pane in the layer, or empties it. */
function syncMax() {
  const t = activeTab();
  const p = t?.max && L.has(t.root, t.max) ? S.panes.get(t.max) : null;
  const layer = maxLayer();
  if (p && !WEB) {
    if (p.el.parentElement !== layer) {
      const top = p.$?.ground?.scrollTop || 0;
      layer.replaceChildren(p.el);
      if (p.$?.ground) p.$.ground.scrollTop = top;
    }
    // Its share of the split it came from does not apply here (layout sets it again when it goes back).
    p.el.style.flex = '1 1 0px';
    p.el.classList.add('maxed');
  } else if (layer.childElementCount) {
    for (const c of layer.children) c.classList.remove('maxed');
    layer.replaceChildren();
  }
  document.body.classList.toggle('pane-max', Boolean(p) && !WEB);
  for (const x of S.panes.values()) if (x !== p) x.el.classList.remove('maxed');
  // The layer stops at the tab's side panel (2026-10-13: "the session pane take full screen up till the browser pane").
  if (!WEB) applyPanelSpace(panelSpace(t));
  syncMaxButtons();
}

/**
 * Maximizes pane p to the whole window up to its tab's side panel, or puts it back where it was. A viewer is not
 * maximized: it lives in the side panel, which stays beside the maximized conversation.
 */
function toggleMaximize(p) {
  if (WEB || !p || p.isViewer) return;
  const t = tabOf(p);
  if (!t) return;
  const was = t.max;
  t.max = W.toggleMax(t, p.id).max;
  // A pane leaving the layer is put back into its place in the tree.
  if (was && was !== t.max) { const q = S.panes.get(was); if (q) q.el.classList.remove('maxed'); }
  layout(t);
  if (t.id !== S.active) switchTab(t);
  focusPane(p, { scroll: false });
  save();
}

/** Every pane's maximize button says what it does now; a maximized conversation's previous and next say where they go. */
function syncMaxButtons() {
  for (const p of S.panes.values()) {
    const b = p.el.querySelector(':scope > .pane-bar .max-btn');
    if (!b) continue;
    const on = p.el.classList.contains('maxed');
    b.classList.toggle('on', on);
    b.title = on ? 'Restore to its place in the tab (Ctrl+Shift+Enter)' : 'Maximize up to the side panel (Ctrl+Shift+Enter, or double-click the header)';
    b.setAttribute('aria-label', on ? 'Restore' : 'Maximize');
    const nav = p.el.querySelector(':scope > .pane-bar .max-nav');
    if (!nav) continue;
    const ids = on ? L.ids(tabOf(p)?.root) : [];
    nav.hidden = ids.length < 2;
    if (nav.hidden) continue;
    const i = ids.indexOf(p.id);
    const prev = S.panes.get(W.stepMax(ids, p.id, -1));
    const next = S.panes.get(W.stepMax(ids, p.id, 1));
    nav.querySelector('.mx-n').textContent = `${i + 1} of ${ids.length}`;
    const pb = nav.querySelector('.mx-prev');
    const nb = nav.querySelector('.mx-next');
    pb.title = `Previous conversation: "${prev?.title || ''}" (Ctrl+${ids.indexOf(prev?.id) + 1})`;
    nb.title = `Next conversation: "${next?.title || ''}" (Ctrl+${ids.indexOf(next?.id) + 1})`;
    pb.setAttribute('aria-label', `Previous conversation: ${prev?.title || ''}`);
    nb.setAttribute('aria-label', `Next conversation: ${next?.title || ''}`);
  }
}

/** Maximized: the maximized view moves to the previous (d = -1) or next (d = 1) conversation of the tab (2026-10-13). */
function stepMaximize(p, d) {
  const t = p && tabOf(p);
  if (!t?.max) return;
  const next = S.panes.get(W.stepMax(L.ids(t.root), t.max, d));
  if (!next || next.id === t.max) return;
  S.panes.get(t.max)?.el.classList.remove('maxed');
  t.max = next.id;
  layout(t);
  focusPane(next);
  save();
}

/* ---------- pane headers: maximize, and the links between a conversation and its viewers (2026-10-12) ---------- */

const ICON_MAX = '<svg class="i-grow" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg><svg class="i-shrink" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M9.5 6.5l4.5-4.5M2.5 9.5h4v4M6.5 9.5 2 14"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

/**
 * Adds what every pane's header gets from the window: a maximize button before its close button, a double click on
 * the header's empty space to maximize, and the link parts: a viewer's chip (the conversation that drives it) and a
 * conversation's mark (how many viewers it has). renderLinks fills them.
 */
function decorate(p) {
  const bar = p.el.querySelector(':scope > .pane-bar');
  if (!bar || bar.dataset.decorated) return;
  bar.dataset.decorated = '1';
  const close = bar.querySelector(':scope > .close');
  if (!WEB) {
    const mx = el('button', 'icon-btn max-btn', ICON_MAX);
    mx.type = 'button';
    mx.onclick = (e) => { e.stopPropagation(); toggleMaximize(p); };
    bar.insertBefore(mx, close || null);
    // Maximized, a conversation's header gets previous and next (2026-10-13): the other conversations of the tab without
    // restoring first. Hidden otherwise (syncMaxButtons).
    if (!p.isViewer) {
      const nav = el('div', 'max-nav', `<button type="button" class="icon-btn mx-prev">${ICON_PREV}</button><span class="mx-n" aria-live="polite"></span><button type="button" class="icon-btn mx-next">${ICON_NEXT}</button>`);
      nav.hidden = true;
      nav.querySelector('.mx-prev').onclick = (e) => { e.stopPropagation(); stepMaximize(p, -1); };
      nav.querySelector('.mx-next').onclick = (e) => { e.stopPropagation(); stepMaximize(p, 1); };
      bar.insertBefore(nav, mx);
    }
    bar.addEventListener('dblclick', (e) => {
      // The header's empty space only: the title renames, buttons and the address field keep their own double click.
      if (e.target.closest('button, input, textarea, select, a, .title, .grip, .web-tabs, .link-chip, .meta-line, .max-nav')) return;
      toggleMaximize(p);
    });
  }
  if (p.isViewer) {
    const chip = el('button', 'link-chip', `${ICON_LINK}<span class="lc-t"></span>`);
    chip.type = 'button';
    chip.hidden = true;
    chip.onclick = (e) => { e.stopPropagation(); goToSource(p); };
    chip.addEventListener('mouseenter', () => linkHover(p, true));
    chip.addEventListener('mouseleave', () => linkHover(p, false));
    chip.addEventListener('focus', () => linkHover(p, true));
    chip.addEventListener('blur', () => linkHover(p, false));
    const grip = bar.querySelector(':scope > .grip');
    if (grip) grip.after(chip); else bar.prepend(chip);
  } else {
    const mark = el('button', 'link-mark', `${ICON_LINK}<span class="lm-n"></span>`);
    mark.type = 'button';
    mark.hidden = true;
    mark.onclick = (e) => { e.stopPropagation(); goToViewers(p); };
    mark.addEventListener('mouseenter', () => linkHover(p, true));
    mark.addEventListener('mouseleave', () => linkHover(p, false));
    mark.addEventListener('focus', () => linkHover(p, true));
    mark.addEventListener('blur', () => linkHover(p, false));
    const before = bar.querySelector(':scope > .max-btn') || close;
    bar.insertBefore(mark, before || null);
  }
}

/** Hovering a link outlines the other end: a viewer's conversation, or a conversation's viewers. */
function linkHover(p, on) {
  const others = p.isViewer ? [S.panes.get(p.sourcePane)].filter(Boolean) : viewersOf(p.id);
  for (const o of others) o.el.classList.toggle('link-hi', on);
  p.el.classList.toggle('link-from', on);
  // On the PC a conversation's viewers are in the side panel: its name there lights up too (2026-10-13).
  if (!WEB && !p.isViewer) tabOf(p)?.panel?.hi(p.id, on);
}

/** A viewer's chip: to its conversation (put back from maximized if needed), or, once that is closed, its session. */
function goToSource(v) {
  linkHover(v, false);
  const src = S.panes.get(v.sourcePane);
  if (src) { revealPane(src); return; }
  if (v.sourceSession) host.showSession(v.sourceSession);
}

/**
 * A conversation's mark: its viewers in turn. On the PC (2026-10-13) the side panel opens on its things; when it shows
 * them already, the mark steps to the next one there.
 */
function goToViewers(p) {
  linkHover(p, false);
  const vs = viewersOf(p.id);
  if (!vs.length) return;
  const t = tabOf(p);
  if (!WEB && t?.panel && vs.some((v) => tabOf(v) === t)) {
    const here = vs.filter((v) => tabOf(v) === t);
    const groups = groupsOf(t);
    const shown = t.side.open && W.shownGroup(groups, { focus: t.focused, want: t.side.group }).group === p.id;
    const cur = S.panes.get(t.side.pick[p.id]);
    const next = shown ? here[(here.indexOf(cur) + 1) % here.length] : (cur && here.includes(cur) ? cur : here[0]);
    t.side.group = p.id;
    t.side.pick[p.id] = next.id;
    t.side.open = true;
    t.side.seen = true;
    renderPanel(t);
    syncSoon();
    save();
    return;
  }
  const f = focusedPane();
  const next = vs[(vs.indexOf(f) + 1) % vs.length];
  revealPane(next);
}

/**
 * Fills every link: the accent of each conversation that has viewers (workspace.js accents, chosen per tab so
 * neighbours differ), the chip on each viewer (its conversation's name in that accent) and the mark on each
 * conversation (the number of its viewers). Cheap: a class and a few words per pane.
 */
function renderLinks() {
  const accOf = new Map();
  for (const t of S.tabs) {
    const ids = L.ids(t.root);
    const linked = ids.filter((id) => { const p = S.panes.get(id); return p && !p.isViewer && viewersOf(id).length; });
    for (const [id, a] of W.accents(linked, S.accents)) accOf.set(id, a);
  }
  // Conversations with viewers in another tab only (moved away) keep an accent too.
  const rest = [...S.panes.values()].filter((p) => !p.isViewer && !accOf.has(p.id) && viewersOf(p.id).length).map((p) => p.id);
  for (const [id, a] of W.accents(rest, S.accents)) accOf.set(id, a);
  S.accents = accOf;
  for (const p of S.panes.values()) {
    const bar = p.el.querySelector(':scope > .pane-bar');
    if (!bar) continue;
    for (let i = 0; i < W.ACCENTS; i++) p.el.classList.remove(`acc-${i}`);
    if (p.isViewer) {
      const chip = bar.querySelector(':scope > .link-chip');
      if (!chip) continue;
      const src = S.panes.get(p.sourcePane);
      const live = src && !src.isViewer;
      const name = live ? src.title : p.sourceTitle || '';
      chip.hidden = !name;
      chip.classList.toggle('gone', !live);
      // In the PC's side panel the switcher names the conversation, so the chip shows only for a viewer whose conversation
      // is closed (gone, its click reopens it) or in another tab (away, its click goes there): app.css (2026-10-13).
      chip.classList.toggle('away', Boolean(live) && tabOf(src) !== tabOf(p));
      if (live && accOf.has(src.id)) p.el.classList.add(`acc-${accOf.get(src.id)}`);
      const t = chip.querySelector('.lc-t');
      if (t.textContent !== name) t.textContent = name;
      chip.title = live ? `Opened by "${name}". Click to go to that conversation; hover to see it.` : name ? `Opened by "${name}", which is closed now. Click to open it again.` : '';
      chip.setAttribute('aria-label', live ? `Opened by ${name}: go to that conversation` : `Opened by ${name}, closed: open it again`);
    } else {
      const mark = bar.querySelector(':scope > .link-mark');
      if (!mark) continue;
      const vs = viewersOf(p.id);
      mark.hidden = !vs.length;
      if (vs.length && accOf.has(p.id)) p.el.classList.add(`acc-${accOf.get(p.id)}`);
      mark.querySelector('.lm-n').textContent = vs.length > 1 ? String(vs.length) : '';
      const names = vs.map((v) => `${W.kindOf(v) === 'browser' ? 'Browser' : W.kindOf(v) === 'diff' ? 'Changes' : W.kindOf(v) === 'task' ? 'Task' : 'Viewer'}: ${v.title}`);
      mark.title = vs.length ? `${vs.length === 1 ? 'Its viewer' : `Its ${vs.length} viewers`} (click to ${WEB ? 'go there' : 'show them in the side panel'}; hover to see):\n${names.join('\n')}` : '';
      mark.setAttribute('aria-label', vs.length === 1 ? 'Go to its viewer' : `Go to its ${vs.length} viewers`);
    }
  }
  // The side panel names conversations in their accents: drawn again with them.
  panelSoon();
}

/**
 * Goes to a pane wherever it is (Arthur, 2026-10-12: "if a session is already open in a tab somewhere, clicking on the
 * session in the left navbar should take you directly to that pane"): a maximized other pane of its tab is put back,
 * its tab comes forward, it takes the focus, its row in the sidebar scrolls into view, and it flashes briefly.
 */
function revealPane(p) {
  if (!p) return;
  const plan = W.goTo({
    active: S.active,
    // A viewer on the PC is in a side panel beside any maximized pane: focusPane shows it there, nothing is restored.
    tabs: S.tabs.map((t) => ({ id: t.id, ids: [...L.ids(t.root), ...(WEB ? t.items || [] : [])], max: t.max || null })),
    paneOf: () => p.id,
  }, p.id);
  const t = plan && S.tabs.find((x) => x.id === plan.tab);
  if (t && plan.restore) { t.max = null; layout(t); }
  if (t && plan.switchTab) switchTab(t);
  focusPane(p);
  if (p.sessionId) findRow(p.sessionId)?.scrollIntoView({ block: 'nearest' });
  p.el.classList.remove('flash');
  void p.el.offsetWidth;
  p.el.classList.add('flash');
  clearTimeout(p.flashTimer);
  p.flashTimer = setTimeout(() => p.el.classList.remove('flash'), 900);
  save();
}

/* ---------- the tab's arrangement: the Layout menu (2026-10-12) ---------- */

const ARRANGE_HINT = { auto: 'by how many and the tab\'s shape', columns: 'all side by side', rows: 'all stacked', grid: 'an even grid', main: 'the focused one large, the rest beside it' };
/** Each arrangement drawn small, for the Layout button. */
const LAYOUT_ICON = {
  auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="6" height="11" rx="1"/><rect x="9.5" y="2.5" width="4.5" height="4.6" rx="1"/><rect x="9.5" y="8.9" width="4.5" height="4.6" rx="1"/></svg>',
  columns: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="3.4" height="11" rx="1"/><rect x="6.3" y="2.5" width="3.4" height="11" rx="1"/><rect x="10.6" y="2.5" width="3.4" height="11" rx="1"/></svg>',
  rows: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="3" rx="1"/><rect x="2" y="6.5" width="12" height="3" rx="1"/><rect x="2" y="10.5" width="12" height="3" rx="1"/></svg>',
  grid: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="5" height="4.5" rx="1"/><rect x="9" y="2.5" width="5" height="4.5" rx="1"/><rect x="2" y="9" width="5" height="4.5" rx="1"/><rect x="9" y="9" width="5" height="4.5" rx="1"/></svg>',
  main: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="7.5" height="11" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="3" rx=".8"/><rect x="10.5" y="6.5" width="3.5" height="3" rx=".8"/><rect x="10.5" y="10.5" width="3.5" height="3" rx=".8"/></svg>',
  custom: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="4.5" height="7" rx="1"/><rect x="7.5" y="2.5" width="6.5" height="4" rx="1"/><rect x="7.5" y="7.5" width="6.5" height="6" rx="1"/><rect x="2" y="10.5" width="4.5" height="3" rx="1"/></svg>',
};

/** Sets the active tab's arrangement and lays it out now. */
function setArrangement(t, preset) {
  if (!t?.root || !W.ARRANGEMENTS.includes(preset)) return;
  t.arrange = preset;
  const order = preset === 'main' ? W.withFirst(L.ids(t.root), paneInfo, S.panes.get(t.focused)?.isViewer ? S.panes.get(t.focused).sourcePane : t.focused) : null;
  rearrange(t, { order });
  layout(t);
  renderTabs();
  save();
}

function layoutMenu(anchor) {
  const t = activeTab();
  if (!t?.root) return;
  const items = W.ARRANGEMENTS.map((value) => ({ value, label: W.ARRANGE_LABEL[value], hint: ARRANGE_HINT[value], checked: t.arrange === value }));
  if (t.arrange === 'custom') items.push({ divider: true }, { value: 'custom', label: 'Custom', hint: 'as you arranged it; pick one above to tidy up', checked: true, disabled: true });
  menu(anchor, items, { above: false, width: 290, onPick: (v) => setArrangement(t, v) });
}

// The window's shape changed: a tab laid out by its arrangement follows when it flips between wide and tall (a tree
// you dragged into shape, and your gutter drags, stay as they are otherwise).
new ResizeObserver(() => {
  const t = activeTab();
  // The side panel's width is a share of the main area, held in its limits (workspace.js panelWidth).
  renderPanel(t);
  if (!t?.root || t.arrange === 'custom' || !t.shape) return;
  const box = stageBox(t);
  if (W.shapeOf(box.w, box.h) !== t.shape && rearrange(t)) { layout(t); save(); }
}).observe($('stages'));

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

/** Rearranges the active tab's panes into an even grid (2 side by side, 2x2, 3+2, 3x3...), viewers beside their conversations (2026-10-12). */
function arrangeGrid() {
  const t = activeTab();
  if (!t?.root) return;
  setArrangement(t, 'grid');
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

/**
 * Where a drop at this point would go: the whole tab's edge, a pane edge, a pane's middle, or the empty stage.
 * The tab's edge (2026-10-15, Arthur: "it should be easier to drag and put a pane underneath two panes above it"): within
 * STAGE_EDGE_PX of the tab's outer edge, the pane spans the full width (top, bottom) or height (left, right), e.g. one
 * pane under two side by side. Further in, a pane's own edge splits only that pane, as before.
 */
function dropZone(t, e, kind) {
  const stageRect = t.stage.getBoundingClientRect();
  if (!t.root) return { where: 'root', rect: stageRect, stageRect };
  const movingId = kind === 'pane' ? S.drag?.paneId : null;
  const sameTab = movingId && L.has(t.root, movingId);
  const full = (S.drag?.paneId && S.panes.get(S.drag.paneId)?.isViewer ? tabFullForViewer(t) : tabFull(t)) && !sameTab;
  const rest = sameTab ? L.remove(t.root, movingId) : t.root;
  if ((kind === 'pane' || kind === 'session') && !full && L.count(rest) >= 2 && !S.panes.get(movingId)?.isViewer) {
    const sx = e.clientX - stageRect.left;
    const sy = e.clientY - stageRect.top;
    const [sEdge, sDist] = Object.entries({ left: sx, right: stageRect.width - sx, top: sy, bottom: stageRect.height - sy }).sort((p, q) => p[1] - q[1])[0];
    if (sDist < STAGE_EDGE_PX) {
      const share = L.edgeShare(rest, sEdge);
      const w = stageRect.width * share;
      const h = stageRect.height * share;
      const rect = {
        left: { left: stageRect.left, top: stageRect.top, width: w, height: stageRect.height },
        right: { left: stageRect.right - w, top: stageRect.top, width: w, height: stageRect.height },
        top: { left: stageRect.left, top: stageRect.top, width: stageRect.width, height: h },
        bottom: { left: stageRect.left, top: stageRect.bottom - h, width: stageRect.width, height: h },
      }[sEdge];
      return { where: 'stage', edge: sEdge, pane: null, rect, stageRect };
    }
  }
  const paneEl = e.target.closest?.('.pane');
  const pane = paneEl && S.panes.get(paneEl.dataset.pane);
  if (!pane) return null;
  const r = paneEl.getBoundingClientRect();
  if (movingId === pane.id) return null;
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
  if (z.where === 'stage') text = { top: 'Full width above', bottom: 'Full width below', left: 'Full height on the left', right: 'Full height on the right' }[z.edge];
  if (z.where === 'center') {
    if (kind === 'pane') text = L.has(t.root, S.drag?.paneId) ? 'Swap these panes' : 'Move here';
    else if (kind === 'task') text = z.pane.isViewer ? 'Replace this viewer' : 'Open beside this conversation';
    else text = z.full ? `${L.MAX_PANES} conversations is the most per tab. Drop here to replace this one, or on + for a new tab` : z.pane.isBrowser ? 'Replace this browser' : z.pane.isViewer ? 'Replace this viewer' : 'Replace this conversation';
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
  if (existing) { revealPane(existing); existing.note('This session is already open here.'); return; }
  // A viewer in the side panel (2026-10-13) has no place in the layout to give up: the session joins the layout instead.
  if (z.where === 'center' && z.pane?.isViewer && (t.items || []).includes(z.pane.id)) z = { where: 'join', pane: S.panes.get(z.pane.sourcePane) || null };
  if (z.where === 'center' && z.pane.isViewer) {
    // Dropped on a viewer: the session takes the viewer's place.
    const v = z.pane;
    const p = createPane({ cwd: s.cwd, title: s.title });
    replaceInTab(t, v.id, p);
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
  // On an edge you chose: that split, and the tab is yours to arrange (custom). Anywhere else: it joins the layout.
  if (z.where === 'root') t.root = L.leaf(p.id);
  else if (z.where === 'stage') { t.root = L.insertAtEdge(t.root, p.id, z.edge); madeCustom(t); }
  else if (z.where === 'edge') { t.root = L.insert(t.root, z.pane.id, p.id, z.edge); madeCustom(t); } else joinTab(t, p.id);
  if (t.max) t.max = null;
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
  // A viewer moves into this tab's side panel (2026-10-13; on the phone, among its pages).
  if (moving.isViewer && from && (from.items || []).includes(moving.id)) {
    if (from === t) { focusPane(moving); return; }
    removeItem(from, moving.id);
    hostItem(t, moving, { focus: true });
    if (!from.root && !from.items.length && S.tabs.length > 1) { S.tabs.splice(S.tabs.indexOf(from), 1); from.stage.remove(); from.panel?.destroy(); } else layout(from);
    layout(t);
    focusPane(moving);
    save();
    return;
  }
  if (z.where === 'center' && from === t) {
    t.root = L.swap(t.root, moving.id, z.pane.id);
    madeCustom(t);
    layout(t);
    save();
    return;
  }
  if (from) leaveTab(from, moving.id);
  if (z.where === 'root') t.root = L.leaf(moving.id);
  else if (z.where === 'stage') { t.root = L.insertAtEdge(t.root, moving.id, z.edge); madeCustom(t); }
  else if (z.where === 'edge' && L.has(t.root, z.pane.id)) { t.root = L.insert(t.root, z.pane.id, moving.id, z.edge); madeCustom(t); } else joinTab(t, moving.id, { source: moving.isViewer ? moving.sourcePane : null });
  if (t.max) t.max = null;
  t.focused = moving.id;
  if (from && from !== t) {
    if (from.focused === moving.id) from.focused = L.ids(from.root)[0] || null;
    // Its things in the side panel go with it to the other tab (2026-10-13).
    for (const v of viewersOf(moving.id)) if ((from.items || []).includes(v.id)) { removeItem(from, v.id); hostItem(t, v, { show: false }); }
    if (!from.root && !(from.items || []).length) { S.tabs.splice(S.tabs.indexOf(from), 1); from.stage.remove(); from.panel?.destroy(); } else layout(from);
  }
  layout(t);
  focusPane(moving);
  save();
}

/** Adds a session to a tab without a drop position: it joins the tab's layout (2026-10-12; before, it split the focused pane). */
function addToTab(t, s) {
  if (!t.root) { dropSession(t, { where: 'root' }, s); return; }
  const target = S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]);
  if (tabFull(t)) { target?.note(`${L.MAX_PANES} conversations is the most per tab; opened in a new tab instead.`, 'warn'); addTab({ session: s }); return; }
  dropSession(t, { where: 'join', pane: target }, s);
}

/* ---------- tab bar ---------- */

let hoverTimer = null;

/**
 * The project a conversation pane belongs to, for its tab's name (workspace.js projectOf): its repository (a worktree
 * counts as its repository), else its folder. A new conversation still in the home folder has none yet.
 */
function projectOfPane(p) {
  const pr = W.projectOf(p.cwd, (c) => wtc.forCwd(c)?.repo?.name || null);
  return !p.sessionId && pr === 'Home' ? null : pr;
}

/** What workspace.js tabLabels needs of a tab: your name, its conversations' projects and titles, its viewers' titles. */
function tabModel(t) {
  // Its conversations, then the viewers in its side panel (2026-10-13).
  const panes = panesIn(t);
  return {
    name: t.name || '',
    convs: panes.filter((p) => !p.isViewer).map((p) => ({ project: projectOfPane(p), title: p.title })),
    viewers: panes.filter((p) => p.isViewer).map((p) => ({ title: p.title })),
  };
}

/** Every tab's name now (also for the saved workspace, which the phone's "On your desktop" reads). */
const tabNames = () => W.tabLabels(S.tabs.map(tabModel));

/**
 * Names a tab (Arthur, 2026-10-12: the tab named after a session in it was confusing): double-click its name and type;
 * Enter or leaving the field keeps it, Escape cancels, an empty name goes back to the automatic one.
 */
function beginTabRename(t, tabEl, current) {
  if (WEB || S.tabEdit) return;
  const span = tabEl.querySelector('.tab-t');
  if (!span) return;
  const input = el('input', 'tab-rename');
  input.value = t.name || current;
  input.maxLength = 60;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Tab name (empty for the automatic name)');
  span.replaceWith(input);
  tabEl.querySelector('.tab-s')?.remove();
  S.tabEdit = t.id;
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    S.tabEdit = null;
    if (keep) {
      const v = input.value.replace(/\s+/g, ' ').trim();
      t.name = v && v !== (W.tabLabel({ ...tabModel(t), name: '' }).text) ? v : '';
      save();
    }
    renderTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

/** The tab bar (timed for the minute line, perfwatch.js; drawTabs draws). */
function renderTabs() { return watch.time('tabs', drawTabs); }

function drawTabs() {
  const bar = $('tabs');
  // A tab being named keeps its field until you finish (a redraw would take the field away under your typing).
  if (S.tabEdit && bar.querySelector('.tab-rename')) return;
  bar.innerHTML = '';
  const names = tabNames();
  for (const [ti, t] of S.tabs.entries()) {
    // Its conversations, then the viewers in its side panel (2026-10-13).
    const panes = panesIn(t);
    // The number on a tab counts its conversations, not its viewers, browsers or tasks (2026-10-11).
    const convs = panes.filter((p) => !p.isViewer).length;
    const label = names[ti];
    const busy = panes.some((p) => p.busy);
    const unread = panes.some((p) => p.unread);
    const warm = panes.some((p) => p.sessionId && S.warm.has(p.sessionId));
    // A question waits in one of its panes (askcard.js): the tab says so the way unread does, in colour and words, no dot.
    const waiting = waitingPaneIn(t);
    const tab = el('div', `tab${t.id === S.active ? ' on' : ''}${busy ? ' busy' : ''}${unread ? ' unread' : ''}${warm ? ' warm' : ''}${waiting ? ' waiting' : ''}`);
    // A tab whose conversations all work in one worktree says which (worktree.js tabNote, 2026-10-12).
    const onBranch = wtc.tabNote(panes.filter((p) => !p.isViewer && p.cwd).map((p) => p.cwd));
    const kinds = (p) => (p.isViewer ? `${W.kindOf(p) === 'browser' ? 'browser' : W.kindOf(p) === 'diff' ? 'changes' : W.kindOf(p) === 'task' ? 'task' : 'viewer'}: ` : '');
    tab.title = `${label.text}${label.auto ? ' (double-click to name this tab)' : ' (your name for it; double-click to change)'}\n${onBranch ? `${onBranch}\n` : ''}${panes.map((p) => `${asks.waiting(p.id) ? 'waiting for you: ' : p.busy ? 'working: ' : p.unread ? 'finished: ' : ''}${kinds(p)}${p.title}`).join('\n') || 'Empty tab'}`;
    // The tab's name is the workspace's (the project its conversations share, or yours), never whichever pane has focus
    // (2026-10-12); a quiet second name only tells two same-named tabs apart.
    tab.innerHTML = `<span class="tab-t">${esc(label.text)}</span>${label.sub ? `<span class="tab-s">${esc(label.sub)}</span>` : ''}${convs > 1 ? `<span class="tab-n" aria-label="${convs} conversations">${convs}</span>` : ''}${warm ? '<span class="warm-ring" aria-hidden="true"></span>' : ''}${busy ? '<span class="tab-sweep" aria-hidden="true"><i></i></span>' : ''}`;
    tab.classList.toggle('named', !label.auto);
    // Double-click names the tab (2026-10-12; it used to rename the focused pane's session, which the pane's own title still does).
    tab.ondblclick = (e) => { if (e.target.closest('.tab-x')) return; e.stopPropagation(); beginTabRename(t, tab, label.text); };
    const x = el('button', 'tab-x', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>');
    x.title = 'Close tab';
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    tab.append(x);
    // One click reaches the question: the tab comes forward and the pane that asks gets the keyboard (its card).
    tab.onclick = () => { switchTab(t); const w = waitingPaneIn(t); if (w) focusPane(w); };
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
      if (moving.isViewer ? tabFullForViewer(t) : tabFull(t)) { moving.note(moving.isViewer ? 'That tab has no room for another pane.' : `That tab already has ${L.MAX_PANES} conversations.`, 'warn'); return; }
      switchTab(t);
      // It joins that tab's layout (2026-10-12), beside its conversation when it is a viewer of one there.
      dropPane(t, t.root ? { where: 'join' } : { where: 'root' }, moving);
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
      if (existing) { revealPane(existing); return; }
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
  const nv = viewersIn(t).length;
  // The Layout menu (2026-10-12) in the place of "Even grid": the tab's arrangement, drawn and named; a click offers
  // Auto, Columns, Rows, Grid, Main and stack.
  const arr = t?.arrange || 'auto';
  const gridBtn = el('button', 'tab-tool layout-btn', `${LAYOUT_ICON[arr] || LAYOUT_ICON.auto}<span>${esc(W.ARRANGE_LABEL[arr] || 'Auto')}</span><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>`);
  gridBtn.title = `Layout of this tab: ${W.ARRANGE_LABEL[arr] || 'Auto'}${arr === 'custom' ? ' (as you arranged it)' : ''}. Click to change.`;
  gridBtn.setAttribute('aria-haspopup', 'menu');
  gridBtn.disabled = L.count(t?.root) < 2;
  gridBtn.onclick = () => layoutMenu(gridBtn);
  // Honest counts (2026-10-12): conversations against their limit, viewers on their own.
  const counts = n ? `${n} of ${L.MAX_PANES}${nv ? ` · ${nv} viewer${nv === 1 ? '' : 's'}` : ''}` : nv ? `${nv} viewer${nv === 1 ? '' : 's'}` : '';
  const countEl = el('span', 'tab-count', esc(counts));
  countEl.title = n || nv ? `This tab: ${n} of ${L.MAX_PANES} conversations${nv ? `, and ${nv} viewer${nv === 1 ? '' : 's'} (browser, artifact, changes or task), which do not count toward the ${L.MAX_PANES}` : ''}.` : '';
  tools.append(countEl, gridBtn);
  // On the PC the count and the Layout button sit outside the scrolling tab row, so many tabs never push them out of
  // sight (2026-10-12); the phone hides the whole row and keeps them in it.
  const slot = WEB ? null : $('tabTools') || (() => { const s = el('div', 'tab-tools-slot'); s.id = 'tabTools'; bar.after(s); return s; })();
  if (slot) slot.replaceChildren(tools); else bar.append(tools);
  // A pane waiting for an answer counts like one that finished unseen (askcard.js), once.
  const unread = [...S.panes.values()].filter((p) => p.unread || asks.waiting(p.id)).length;
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
  // A tab with a question waiting for you counts like a ready one (askcard.js, 2026-10-12).
  return S.tabs.filter((t) => L.ids(t.root).some((id) => S.panes.get(id)?.unread || asks.waiting(id))).length;
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
    // Codex threads are in All with Claude's, under the same recency headings (2026-10-12); the Codex view shows them alone.
    { id: 'all', label: 'All', n: live.length },
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
//
// Since 2026-10-12 (Arthur: "the folders should expand when clicked on and contract when clicked on again instead of
// just transitioning the entire sidepanel") a click opens a folder in place, its sessions under it, and a second click
// closes it; several can be open, and the open ones come back after a restart (sessionlist.js createOpenState, and the
// saved workspace). Right-click a folder for Show only this folder (the old view), Rename and Delete. Keys: arrows
// move, Enter or Space opens and closes, Right and Left open and close, F2 renames.
const folderUI = { creating: false, pendingSession: null, renaming: null };
const folderOpen = createOpenState(window.localStorage, { onChange: () => save() });
// Most sessions drawn under an open folder; the rest are one click away (Show only this folder).
const FOLDER_ROWS = 60;

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
  // The list is drawn again on every sessions event: the keyboard's place and the scroll stay where they were.
  const keepFocus = navFocusKey(box);
  const keepScroll = box.querySelector('.folder-list')?.scrollTop || 0;
  if (S.foldersKnown) folderOpen.prune(S.folders.map((f) => f.id));
  box.innerHTML = '';
  const head = el('div', 'sec-head folders-head', `<span class="sec-t">Folders</span><span class="sec-n">${S.folders.length || ''}</span>`);
  const add = el('button', 'folder-add', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>');
  add.title = 'New folder (drop a session here to make one with it)';
  add.onclick = () => startNewFolder();
  folderDropTarget(add, (sid) => startNewFolder(sid));
  head.append(add);
  box.append(head);
  const list = el('ul', 'folder-list');
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', 'Folders');
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
    const open = folderOpen.isOpen(f.id);
    // A folder is an item of the tree: its row, and its sessions under it (drawn only while it is open).
    const item = el('li', `folder${open ? ' open' : ''}`);
    item.dataset.folder = f.id;
    const li = el('div', `folder-row${S.view === f.id ? ' on' : ''}`);
    if (folderUI.renaming === f.id) {
      const input = el('input');
      input.value = f.name;
      const done = (ok) => {
        folderUI.renaming = null;
        const name = input.value.trim();
        if (ok && name && name !== f.name) send('folder', { action: 'rename', folderId: f.id, name });
        renderFolders();
      };
      input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      input.onblur = () => done(true);
      li.classList.add('editing');
      li.append(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      li.innerHTML = `${GLYPH.chevron}${GLYPH.folder}<span class="fn">${esc(f.name)}</span><span class="count">${f.sessions.length}</span>`;
      const x = el('button', 'folder-x', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>');
      x.title = 'Delete folder (its sessions stay)';
      x.tabIndex = -1;
      x.onclick = (e) => {
        e.stopPropagation();
        deleteFolder(f);
      };
      li.append(x);
      // A double click renames: its second click does not close the folder the first one opened.
      li.onclick = (e) => { if (e.detail > 1) return; toggleFolder(f.id); };
      li.ondblclick = () => { folderUI.renaming = f.id; renderFolders(); };
      li.oncontextmenu = (e) => { e.preventDefault(); folderContextMenu(f, { x: e.clientX, y: e.clientY }); };
      li.title = 'Click to open or close · double-click to rename · drop sessions here to move them in · right-click for more';
      li.dataset.nav = 'folder';
      li.dataset.folder = f.id;
      li.tabIndex = -1;
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-expanded', String(open));
      item.append(li);
      const kids = el('div', 'folder-kids');
      const inner = el('ul', 'folder-sess');
      inner.setAttribute('role', 'group');
      kids.append(inner);
      kids.inert = !open;
      item.append(kids);
      if (open) fillFolder(item, f);
    }
    if (li.classList.contains('editing')) item.append(li);
    folderDropTarget(item, (sid) => moveToFolder(sid, f.id));
    list.append(item);
  }
  if (!S.folders.length && !folderUI.creating) list.append(el('li', 'folder-empty', 'Drag sessions onto + to group them.'));
  box.append(list);
  list.scrollTop = keepScroll;
  restoreNavFocus(box, keepFocus);
}

/** Draws an open folder's sessions under its row, newest first, as compact rows (sessionRow). */
function fillFolder(item, f) {
  const inner = item.querySelector('.folder-sess');
  if (!inner) return;
  inner.innerHTML = '';
  const ids = new Set(f.sessions);
  const rows = S.sessions.filter((s) => ids.has(s.id) && !s.archived).sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  for (const s of rows.slice(0, FOLDER_ROWS)) {
    inner.append(sessionRow(s, { inFolder: f.id }));
    if (S.expanded.has(s.id)) for (const sub of subRows(s)) inner.append(sub);
  }
  if (rows.length > FOLDER_ROWS) {
    const more = el('li', 'folder-note', `<button class="link-btn">${rows.length - FOLDER_ROWS} more: show only this folder</button>`);
    more.querySelector('button').onclick = () => { S.view = f.id; renderRail(); };
    inner.append(more);
  }
  if (!rows.length) inner.append(el('li', 'folder-note', 'Empty. Drag sessions here, or right-click one: Move to folder.'));
  renderRailMarks();
}

/** Opens or closes a folder in place, with its height easing open (CSS grid rows 0fr to 1fr), and remembers it. */
function toggleFolder(id, on = null) {
  const item = $('folders').querySelector(`li.folder[data-folder="${CSS.escape(id)}"]`);
  const f = S.folders.find((x) => x.id === id);
  if (!item || !f) return;
  const next = on === null ? !folderOpen.isOpen(id) : Boolean(on);
  folderOpen.set(id, next);
  const kids = item.querySelector('.folder-kids');
  if (next && !item.querySelector('.folder-sess')?.children.length) fillFolder(item, f);
  if (kids) kids.inert = !next;
  item.querySelector('.folder-row')?.setAttribute('aria-expanded', String(next));
  // The rows are in place before the class changes, so the height eases from nothing to all of them.
  requestAnimationFrame(() => item.classList.toggle('open', next));
}

/** Deletes a folder after asking (its sessions stay). */
function deleteFolder(f) {
  if (!window.confirm(`Delete folder "${f.name}"? Its ${f.sessions.length} session(s) stay, just without a folder.`)) return;
  send('folder', { action: 'delete', folderId: f.id });
  folderOpen.set(f.id, false);
  if (S.view === f.id) S.view = 'all';
}

/** Right-click on a folder: open or close it, show it alone in the list (the old folder view), rename, delete. */
function folderContextMenu(f, at) {
  const alone = S.view === f.id;
  // The phone leaves out Rename and Delete: renaming and deleting folders stay on the PC (remote-policy.js).
  menu(at, folderMenuItems(f, { open: folderOpen.isOpen(f.id), shownAlone: alone, web: WEB }), {
    above: false,
    width: 230,
    onPick: (v) => {
      if (v === 'toggle') toggleFolder(f.id);
      else if (v === 'alone') { S.view = alone ? 'all' : f.id; renderRail(); }
      else if (v === 'rename') { folderUI.renaming = f.id; renderFolders(); }
      else if (v === 'delete') deleteFolder(f);
    },
  });
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
  decorate(v);
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
    // A tab of its own (Ctrl+click, the + of the tab row): its side panel shows it (the phone: its one page).
    const nt = createTab(null);
    const v = createTaskViewer(spec);
    hostItem(nt, v, { focus: true });
    if (WEB) nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  const v = createTaskViewer(spec);
  // One task viewer per conversation on the phone (2026-10-12): another of its subagents or shells takes that viewer's
  // place. The PC's side panel gives each its own tab (2026-10-13), the oldest giving way past KEEP_PER_KIND.
  const old = WEB && src && !src.isViewer && !inTab ? W.viewerFor([...S.panes.values()], 'task', src.id) : null;
  const ot = old && tabOf(old);
  if (old && ot) {
    replaceInTab(ot, old.id, v);
    S.panes.delete(old.id);
    old.destroy();
    layout(ot);
    if (ot.id !== S.active) switchTab(ot);
    if (focus) focusPane(v);
    renderTabs();
    save();
    return v;
  }
  // In the side panel of its conversation's tab, under that conversation (2026-10-13); on the phone a page after it.
  hostItem(t, v, { focus });
  if (WEB && !t.focused) t.focused = v.id;
  if (t.id !== S.active) switchTab(t);
  if (focus) focusPane(v);
  if (!WEB) trimKind(t, v);
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

/**
 * A task dropped on a stage. Before 2026-10-13 it split a pane at an edge, took a viewer's place, or opened beside a
 * conversation; since the side panel the layout holds conversations only, so it opens in the tab's side panel (the
 * phone: a page after its conversation) wherever it lands.
 */
function dropTask(t, z, spec) {
  if (!spec?.sessionId) return;
  void z;
  openTask(spec, { inTab: t, focus: true });
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
 *
 * 2026-10-12 (Arthur: "think about everything a user might want to do with a session"): the menu is
 * sessionlist.js sessionMenuItems, which adds Open beside, Open in a new tab, Open in a terminal, Pin to top, Move to
 * folder (one item that opens the folder menu, so the menu stays short with many folders), Ask Claude about it, Export
 * as Markdown, its subagents, Show folder in Explorer and Details. The same menu opens from the row's ... button and
 * from the context menu key. row: the row it was asked on (Rename edits that row's name in place).
 */
function sessionMenu(s, e, row = null) {
  e.preventDefault();
  // The phone's own menu (below): a long press on a row opens it as a sheet.
  if (WEB) { phoneSessionMenu(s, { x: e.clientX, y: e.clientY }); return; }
  const pane = paneBySession(s.id);
  const runningHere = Boolean(pane?.busy);
  const at = { x: e.clientX, y: e.clientY };
  const items = sessionMenuItems(s, {
    pane: pane && !pane.isViewer ? { busy: pane.busy } : null,
    running: Boolean(s.running),
    folderName: folderNameOf(s),
    subagents: s.subagents || 0,
    subsOpen: S.expanded.has(s.id),
    tabFull: tabFull(activeTab()),
    shortCwd: short(s.cwd),
  });
  row?.classList.add('menu-open');
  const menuEl = menu(at, items, {
    above: false,
    width: 280,
    onPick: (v) => {
      if (v === 'rename') { const r = row?.isConnected ? row : findRow(s.id); beginRename(s.id, r?.querySelector('.t') || null); return; }
      // Open, wherever it is open already: that pane (its tab forward, focused, a brief flash; 2026-10-12).
      if (v === 'open') { if (pane) revealPane(pane); else openFromRail(s, {}); }
      else if (v === 'here') openFromRail(s, { here: true });
      else if (v === 'tab') { if (pane) revealPane(pane); else openFromRail(s, { ctrlKey: true }); }
      else if (v === 'split') openFromRail(s, { shiftKey: true });
      // openTerminal is built with the console toggle (another branch; reconciled at merge): the exact session in an
      // external terminal window, with the pane's model, effort, mode and billing when it is open in one. PC only.
      else if (v === 'terminal') send('openTerminal', { sessionId: s.id, kind: s.codex ? 'codex' : 'claude', ...(pane && !pane.isViewer ? { paneId: pane.id } : {}) });
      else if (v === 'stop') { if (runningHere) pane.stop(); else send('stopSession', { sessionId: s.id }); }
      else if (v === 'close') closePane(pane);
      else if (v === 'pin' || v === 'unpin') setPinned(s, v === 'pin');
      else if (v === 'move') folderMenu(s.id, at);
      else if (v === 'fork') send('forkSession', { sessionId: s.id });
      else if (v === 'archive' || v === 'unarchive') send('archive', { sessionId: s.id, archived: v === 'archive' });
      else if (v === 'ask') askAbout(s);
      else if (v === 'export') exportSession(s);
      else if (v === 'subs') toggleSubs(s.id);
      else if (v === 'copy-id') copyText(s.id, 'Session id copied.');
      else if (v === 'copy-resume') copyText(`${s.cwd ? `cd "${s.cwd}" && ` : ''}${s.codex ? `codex resume ${s.id.replace(/^codex:/, '')}` : `claude --resume ${s.id}`}`, 'Resume command copied.');
      else if (v === 'reveal') send('revealFolder', { cwd: s.cwd });
      else if (v === 'details') detailsSheet(s);
      else if (v === 'new') startNewFolder(s.id);
      else if (v === 'out') moveToFolder(s.id, null);
      else if (typeof v === 'string' && v.startsWith('f:')) moveToFolder(s.id, v.slice(2));
    },
  });
  // The row keeps its "menu open" look until the menu goes (closeMenu removes it after its exit).
  if (row && menuEl) {
    const watch = new MutationObserver(() => { if (!menuEl.isConnected || menuEl.classList.contains('out')) { row.classList.remove('menu-open'); watch.disconnect(); } });
    watch.observe(menuEl, { attributes: true, attributeFilter: ['class'] });
    watch.observe(document.body, { childList: true });
  }
}

/** The drawn row of a session (the list, then the open folders), or null. */
function findRow(id) {
  const sel = `li.srow[data-id="${CSS.escape(id)}"]`;
  return $('sessions').querySelector(sel) || $('folders').querySelector(sel);
}

/** Pin to top or unpin (engine pins.js): the row moves at once, the engine's list follows. */
function setPinned(s, on) {
  for (const x of S.sessions) if (x.id === s.id) x.pinned = on;
  s.pinned = on;
  if (!S.drag) renderRail();
  send('pin', { sessionId: s.id, pinned: on });
}

/**
 * Ask Claude about it: a new conversation in the session's folder, its message box holding where the session is, for
 * your question (nothing is sent until you send it). Claude reads the transcript with its own tools.
 */
function askAbout(s) {
  const t = addTab({ cwd: s.cwd || null });
  const p = S.panes.get(t?.focused);
  if (!p?.$?.input) return;
  const info = S.info.get(s.id);
  const where = s.codex
    ? `Codex thread ${s.id.replace(/^codex:/, '')}${info?.transcript ? `, rollout ${info.transcript}` : ', its rollout is under ~/.codex/sessions'}`
    : `Claude Code session ${s.id}${info?.transcript ? `, transcript ${info.transcript}` : `, transcript ${s.id}.jsonl under ~/.claude/projects`}`;
  p.$.input.value = `About "${s.title || 'this session'}" (${where}): `;
  p.autosize?.();
  p.$.input.focus();
  p.$.input.setSelectionRange(p.$.input.value.length, p.$.input.value.length);
  if (WEB) phoneShowChat();
}

/** Export as Markdown: the engine saves it in Downloads and shows it (the desktop), or sends the text back (the phone). */
function exportSession(s) {
  send('exportSession', { sessionId: s.id });
  if (!WEB) focusedPane()?.note(`Exporting "${s.title || 'the session'}" as Markdown…`);
}

/** A file the phone saves (Export as Markdown): the browser's own download of a text blob. */
function downloadText(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    phoneToast(`Saved ${name}`);
  } catch (err) {
    phoneToast(`Could not save it: ${err.message || err}`, false);
  }
}

/* ---------- Details (2026-10-12, sessionlist.js sessionFacts) ---------- */

/** What the window knows about a session for Details: the pane holding it, its worktree, its folder's name. */
function factsCtx(s) {
  const p = paneBySession(s.id);
  const { branch, worktree } = branchOf(s);
  return {
    pane: p && !p.isViewer ? { model: p.model || '', effort: p.effort || '', mode: p.mode || '', billing: p.billing?.name || '', busy: Boolean(p.busy) } : null,
    branch, worktree, folderName: folderNameOf(s), web: WEB,
  };
}

/** Draws (or draws again) the Details sheet's contents and wires its buttons. */
function fillDetails(root, close, s) {
  const f = sessionFacts(s, S.info.has(s.id) ? S.info.get(s.id) : null, factsCtx(s));
  root.innerHTML = detailsHtml(f, { web: WEB });
  root.querySelector('[data-k=x]').onclick = close;
  for (const b of root.querySelectorAll('[data-copy]')) b.onclick = () => { const v = f.copies[b.dataset.copy]; if (v) copyText(v, 'Copied.'); };
  root.querySelector('[data-act=reveal]')?.addEventListener('click', () => send('revealFolder', { cwd: s.cwd }));
  root.querySelector('[data-act=export]')?.addEventListener('click', () => exportSession(s));
}

/**
 * Details: everything known about a session (Arthur: "all information available somewhere in details/properties when
 * right clicking"). It opens at once with what the list knows and fills in what the engine reads (op sessionInfo:
 * prompts, replies, tokens, created, size on disk, transcript path...). Read only, on the phone too.
 */
let detailsFor = null;
function detailsSheet(s) {
  const key = `details:${s.id}`;
  if (sheetKey === key) return;
  if (!WEB || phoneCan('sessionInfo')) { S.info.delete(s.id); send('sessionInfo', { sessionId: s.id }); } else S.info.set(s.id, { error: 'The Apaki on your PC is older: update it there to see the rest.' });
  sheet('', (root, close) => { detailsFor = s; fillDetails(root, close, s); }, key, () => { detailsFor = null; });
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
    // Pin to top (2026-10-12, engine pins.js): the PC keeps the pins, so the desktop shows them too.
    ...(s.id ? [gated('pin', s.pinned ? { value: 'unpin', label: 'Unpin', hint: 'back in its time group' } : { value: 'pin', label: 'Pin to top', hint: 'under Pinned' })] : []),
    ...(s.id && !s.archivedCopy ? [gated('forkSession', { value: 'fork', label: 'Fork into a new conversation', hint: 'makes a copy' })] : []),
    ...(s.id ? [gated('archive', s.codexArchived ? { value: null, label: 'Archived in Codex', hint: 'unarchive it in the Codex app', disabled: 'Archived in the Codex app; unarchive it there' } : s.archived ? { value: 'unarchive', label: 'Unarchive', hint: 'back in the lists' } : { value: 'archive', label: 'Archive', hint: 'hide it; nothing is deleted' })] : []),
  ].filter(Boolean);
  if (edits.length) items.push({ divider: true }, ...edits);
  // Ask Claude about it and Export as Markdown (2026-10-12): a new conversation here; the Markdown comes back to the phone.
  if (s.id) {
    items.push({ divider: true }, { value: 'ask', label: 'Ask Claude about it', hint: 'a new conversation' });
    if (phoneCan('exportSession')) items.push({ value: 'export', label: 'Export as Markdown', hint: 'saved on this phone' });
  }
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
  // Details (2026-10-12): everything known about it, read only at every access level (engine sessionInfo).
  if (s.id) items.push({ divider: true }, { value: 'details', label: 'Details', hint: 'everything about it' });
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
      else if (v === 'pin' || v === 'unpin') setPinned(s, v === 'pin');
      else if (v === 'ask') askAbout(s);
      else if (v === 'export') exportSession(s);
      else if (v === 'details') detailsSheet(s);
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
  card.innerHTML = `<div class="sc-t"><b>Sign in to Claude to start</b><span>Claude Code on this ${pc()} has no login yet. Sign in with your Claude account (or a Console account for API billing); Apaki picks it up as soon as you finish.</span>${e.note ? `<span class="sc-note${e.noteOk === false ? ' bad' : ''}">${esc(e.note)}</span>` : ''}</div>
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
  // Codex threads are listed in All with Claude's (2026-10-12, Arthur: integrated exactly like Claude's; the engine lists
  // them from their rollouts at startup, codex-list.js), marked Codex; the Codex view shows them alone, a search shows
  // its hits wherever they are (every agent's), a folder shows what is in it.
  if (S.view === 'all') return true;
  if (S.view === 'terminal') return Boolean(s.terminal);
  if (S.view === 'worktrees') return wtc.inLinked(s.cwd);
  const f = S.folders.find((x) => x.id === S.view);
  return Boolean(f && f.sessions.includes(s.id));
}

/* ---------- a session row, compact (2026-10-12, sessionlist.js) ---------- */

// The record each drawn row stands for (a search hit carries its snippet), for the keys and the ... button.
const rowSession = new WeakMap();

/** What this window knows live about a session: a turn running in its pane here, a question waiting for an answer. */
function liveOf(s) {
  const p = paneBySession(s.id);
  return { runningHere: Boolean(p?.busy), waiting: Boolean(p) && [...S.waiting.values()].includes(p.id), pane: p || null };
}

/** The worktree and branch a session's folder is on (a linked worktree's branch, else the list's branch). */
function branchOf(s) {
  const tag = s.cwd ? wtc.forCwd(s.cwd) : null;
  if (tag && hasLinked(tag.repo)) return { branch: branchName(tag.wt), worktree: tag.wt.main ? '' : tag.wt.path };
  return { branch: s.branch || '', worktree: '' };
}

const folderNameOf = (s) => (s.folder ? S.folders.find((f) => f.id === s.folder)?.name || '' : '');

/**
 * One session as a compact row: state glyphs, the name cut with an ellipsis, the last message's time (and a ... button
 * in its place on hover), then one more line (folder, branch, model, size; its subagents) that shows on the row open in
 * the focused pane and on the row under the keyboard. Hover shows the card (rowTip), right click the menu.
 * o: { grouped: under a recency heading, inFolder: drawn under an open folder }
 */
function sessionRow(s, o = {}) {
  const li = el('li', 'srow');
  li.dataset.id = s.id;
  li.dataset.nav = 'session';
  li.tabIndex = -1;
  if (o.grouped) li.dataset.grouped = '1';
  if (o.inFolder) li.dataset.folder = o.inFolder;
  if (s.wtKid) li.classList.add('wt-kid');
  rowSession.set(li, s);
  const live = liveOf(s);
  const { branch, worktree } = branchOf(s);
  const folderName = o.inFolder ? '' : folderNameOf(s);
  const at = s.lastModified || 0;
  const pane = live.pane && !live.pane.isViewer ? live.pane : null;
  const model = pane?.model || s.model || '';
  const byMeaning = s.sources && !s.sources.includes('words');
  const snip = s.snippet ? `<div class="snip">${byMeaning ? '<span class="by-meaning" title="Found by what it is about, not by your words">by meaning</span> ' : ''}${esc(kindLabel(s.kind, s.codex))}: ${highlight(s.snippet, S.query)}${s.hits > 1 ? ` <span class="mono">(${s.hits})</span>` : ''}</div>` : '';
  const detail = detailLine(s, { branch: s.wtKid ? '' : branch, model, folderName, shortPath: short });
  // A conversation in a linked worktree keeps a quiet worktree mark (its branch is in the second line and the card),
  // except under its own worktree row in the Worktrees view, which says it.
  const wtMark = worktree && !s.wtKid ? `<span class="sr-s sr-wt" role="img" aria-label="${esc(`In the worktree of ${branch}`)}">${GLYPH_WORKTREE}</span>` : '';
  // Glass's row (2026-10-12): one leading glyph for the provider and the state, the name, then quiet marks and the time.
  const pinMark = !o.grouped && s.pinned ? `<span class="sr-s sr-pinned" role="img" aria-label="Pinned">${GLYPH.pinned}</span>` : '';
  li.innerHTML = `<div class="sr-line">${leadHtml(s, live)}<span class="t">${esc(s.title || '(untitled)')}</span>${pinMark}${wtMark}<span class="sr-end"><time class="sr-time" data-at="${at}">${esc(shortTime(at, Date.now(), { grouped: Boolean(o.grouped) }))}</time><button class="sr-more" tabindex="-1" aria-label="More for this session">${GLYPH.more}</button></span></div>`
    + `<div class="sr-detail"><div class="sr-detail-in"><div class="m">${esc(detail)}</div></div></div>${s.why ? `<div class="why">${esc(s.why)}</div>` : snip}`;
  // Its subagents (2026-10-10): a count to click open, in the row's second line; the list follows the row.
  const subsOpen = S.expanded.has(s.id);
  if (subsOpen) li.classList.add('subs-open');
  if (s.subagents > 0) {
    const sb = el('button', `subs-n${subsOpen ? ' open' : ''}`, `${taskGlyph('agent')}<span>${s.subagents} subagent${s.subagents === 1 ? '' : 's'}</span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>`);
    sb.title = subsOpen ? 'Hide its subagents' : 'Show its subagents (and shells)';
    sb.tabIndex = -1;
    sb.onclick = (e) => { e.stopPropagation(); toggleSubs(s.id); };
    li.querySelector('.sr-detail-in').append(sb);
  }
  // Keep-warm is holding this session's prompt cache: a slow moving border (2026-10-09).
  if (S.warm.has(s.id)) { li.classList.add('warm'); li.append(el('span', 'warm-ring')); }
  li.querySelector('.sr-more').onclick = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    sessionMenu(s, { preventDefault() {}, clientX: r.left, clientY: r.bottom }, li);
  };
  li.onclick = (e) => openFromRail(s, e);
  li.oncontextmenu = (e) => sessionMenu(s, e, li);
  li.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); openFromRail(s, { ctrlKey: true }); } };
  setTip(li, rowTip(s, { folderName: folderNameOf(s), branch, worktree, model, live, pane, web: WEB }));
  {
    // Not on the phone (2026-10-12): iOS lifts a draggable row after a long press, and that press opens the menu there.
    li.draggable = !WEB;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG_SESSION, JSON.stringify({ id: s.id, cwd: s.cwd, title: s.title }));
      e.dataTransfer.effectAllowed = 'copyMove';
      S.drag = { kind: 'session', id: s.id };
      document.body.classList.add('dragging');
    });
    li.addEventListener('dragend', endDrag);
  }
  return li;
}

/*
 * Rows kept between drawings (2026-10-15, window lag). The list was emptied and every row (up to 400) made again on
 * each drawing: its markup, its hover card, its handlers, and the browser's style for all of them. A row is now kept
 * under a key of everything it shows (rowKey) and used again while that key is the same; the list is put in order by
 * moving only what moved (placeChildren). A row with anything new (its title, time, state, branch, folder, warm ring,
 * search snippet) gets a new key and is made again, exactly as before. The key holds the whole session record, so the
 * record a kept row's handlers hold is the same as the list's in everything they read.
 */
let railKept = new Map();
let headsKept = new Map();

/** Everything a session row shows, as one string (sessionRow draws from exactly these). */
function rowKey(s, o = {}) {
  const live = liveOf(s);
  const p = live.pane;
  const b = branchOf(s);
  const at = s.lastModified || 0;
  const now = Date.now();
  return JSON.stringify([
    s, o.grouped ? 1 : 0, o.inFolder || '', live.runningHere, live.waiting, p ? [p.id, p.isViewer ? 1 : 0, p.model || '', p.busy ? 1 : 0] : 0,
    b.branch, b.worktree, folderNameOf(s), S.warm.has(s.id), S.expanded.has(s.id), s.snippet ? [S.query, S.searchTerms || null] : 0,
    shortTime(at, now, { grouped: Boolean(o.grouped) }), agoText(at, now),
  ]);
}

/** The row for a session: the one drawn last time when it shows the same, else a new one (sessionRow). */
function keptRow(s, o, kept) {
  const key = rowKey(s, o);
  let li = kept.get(key);
  if (li) kept.delete(key);
  else li = sessionRow(s, o);
  railKept.set(key, li);
  return li;
}

// (placeChildren, which puts the list in order moving only what moved, is in sessionlist.js, where it is tested.)

/** A recency heading in the list (Pinned, Today, Yesterday...). */
function groupHead(label) {
  const li = el('li', 'sr-group');
  li.setAttribute('role', 'presentation');
  li.textContent = label;
  return li;
}

/** The list items the keys move between in a container: rows and folder rows that are on screen. */
function navItems(box) {
  return [...box.querySelectorAll('[data-nav]')].filter((x) => !x.closest('.folder:not(.open) .folder-kids') && x.offsetParent !== null);
}

/** What has the keyboard in a list, to find again after it is drawn again. */
function navFocusKey(box) {
  const a = document.activeElement;
  const item = a && box.contains(a) ? a.closest('[data-nav]') : null;
  if (!item) return null;
  return { id: item.dataset.id || null, folder: item.dataset.folder || null, nav: item.dataset.nav };
}

/** Gives the keyboard back to the same item after a redraw, and keeps one item of the list reachable with Tab. */
function restoreNavFocus(box, key) {
  const items = [...box.querySelectorAll('[data-nav]')];
  let target = null;
  if (key) target = items.find((x) => x.dataset.nav === key.nav && (x.dataset.id || null) === key.id && (x.dataset.folder || null) === key.folder) || null;
  // Only what changes is written (2026-10-15): kept rows already have their tab stop, and a write is a change to restyle.
  const tabStop = target || items.find((x) => x.classList.contains('on')) || items[0];
  for (const x of items) if (x !== tabStop && x.tabIndex !== -1) x.tabIndex = -1;
  if (tabStop && tabStop.tabIndex !== 0) tabStop.tabIndex = 0;
  if (target) target.focus({ preventScroll: true });
}

/** Moves the keyboard to an item of a list (roving tab stop). */
function navTo(box, item) {
  if (!item) return;
  for (const x of box.querySelectorAll('[data-nav]')) x.tabIndex = -1;
  item.tabIndex = 0;
  item.focus({ preventScroll: false });
  item.scrollIntoView({ block: 'nearest' });
}

/** The keys of the session list and the folder tree (sessionlist.js navKey): move, open, toggle, menu, details, rename. */
function wireListKeys(box) {
  box.addEventListener('keydown', (e) => {
    const item = e.target?.closest?.('[data-nav]');
    if (!item || !box.contains(item) || e.target !== item) return;
    const kind = item.dataset.nav;
    const fid = item.dataset.folder || null;
    const r = navKey(e, { kind, open: kind === 'folder' && folderOpen.isOpen(fid), inFolder: kind === 'session' && Boolean(fid) });
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const items = navItems(box);
    const at = items.indexOf(item);
    const s = kind === 'session' ? rowSession.get(item) : null;
    const f = kind === 'folder' ? S.folders.find((x) => x.id === fid) : null;
    const point = () => { const b = item.getBoundingClientRect(); return { x: b.left + 16, y: b.bottom }; };
    switch (r.act) {
      case 'move': navTo(box, r.by === 'first' ? items[0] : r.by === 'last' ? items[items.length - 1] : items[Math.max(0, Math.min(items.length - 1, at + r.by))]); break;
      case 'open': if (s) openFromRail(s, {}); break;
      case 'toggle': if (f) toggleFolder(f.id); break;
      case 'expand': if (f) toggleFolder(f.id, true); break;
      case 'collapse': if (f) toggleFolder(f.id, false); break;
      case 'parent': navTo(box, box.querySelector(`.folder-row[data-folder="${CSS.escape(fid)}"]`)); break;
      case 'menu': if (s) { const p = point(); sessionMenu(s, { preventDefault() {}, clientX: p.x, clientY: p.y }, item); } else if (f) folderContextMenu(f, point()); break;
      case 'details': if (s) detailsSheet(s); break;
      case 'rename': if (s) beginRename(s.id, item.querySelector('.t')); else if (f) { folderUI.renaming = f.id; renderFolders(); } break;
      default: break;
    }
  });
  // The row with the keyboard is the list's tab stop.
  box.addEventListener('focusin', (e) => {
    const item = e.target?.closest?.('[data-nav]');
    if (!item || e.target !== item) return;
    for (const x of box.querySelectorAll('[data-nav]')) if (x !== item) x.tabIndex = -1;
    item.tabIndex = 0;
  });
}
wireListKeys($('sessions'));
wireListKeys($('folders'));

// The short times say "now" and "12m": they move on every minute without drawing the list again.
setInterval(() => {
  const now = Date.now();
  for (const t of document.querySelectorAll('.srow .sr-time[data-at]')) {
    const text = shortTime(Number(t.dataset.at) || 0, now, { grouped: t.closest('.srow')?.dataset.grouped === '1' });
    if (t.textContent !== text) t.textContent = text;
  }
}, 60 * 1000);

/*
 * The session list drawn again for the engine's events, once per frame at most (2026-10-15, window lag). Subagent
 * counts, terminals, keep-warm and the repositories each drew all of it (400 rows) the moment they arrived; with five
 * panes working they arrived several times a second, often in the same frame. railSoon() asks for one drawing on the next
 * frame, so a burst costs one. What you do yourself (a view, a search, a rename) still draws at once (renderRail), and a
 * drawing at once takes the one that was asked for with it.
 */
let railFrame = 0;
function railSoon() {
  if (railFrame) return;
  railFrame = requestAnimationFrame(() => { railFrame = 0; if (!S.drag) renderRail(); });
}

/** The sidebar's views, folders and session list (timed for the minute line, perfwatch.js; drawRail draws). */
function renderRail() { return watch.time('rail', drawRail); }

function drawRail() {
  if (railFrame) { cancelAnimationFrame(railFrame); railFrame = 0; }
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
    // Newest first, under recency headings (2026-10-12, groupRows below); sessions in terminals are in their time group,
    // marked, and all together under In terminals.
    rows = S.sessions.filter(inView).sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
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
  // The list is drawn again on every sessions event: the keyboard's place stays where it was.
  const keepFocus = navFocusKey(list);
  // What the list holds, in order; rows that show the same as last time are the same elements (keptRow, 2026-10-15).
  const want = [];
  const kept = railKept;
  const heads = headsKept;
  railKept = new Map();
  headsKept = new Map();
  if (wtView) { const clean = wtc.cleanRowEl(); if (clean) want.push(clean); }
  const focusedCwd = focusedPane()?.cwd || '';
  const addRow = (s, grouped) => {
    want.push(keptRow(s, { grouped }, kept));
    if (S.expanded.has(s.id)) for (const sub of subRows(s)) want.push(sub);
  };
  if (!S.results && !wtView) {
    // The ChatGPT app's order (2026-10-12): Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, then by month.
    for (const g of groupRows(rows.slice(0, 400), Date.now(), { pinned: S.view !== 'archived' })) {
      const head = heads.get(g.label) || groupHead(g.label);
      heads.delete(g.label);
      headsKept.set(g.label, head);
      want.push(head);
      for (const s of g.rows) addRow(s, true);
    }
  } else {
    for (const s of rows.slice(0, 400)) {
      // A repository or a worktree row of the Worktrees view; the conversations between them are ordinary rows.
      if (s.wtRow) { want.push(wtc.rowEl(s.wtRow, { focusedCwd })); continue; }
      addRow(s, false);
    }
  }
  placeChildren(list, want);
  restoreNavFocus(list, keepFocus);
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
  // The rows under open folders too (2026-10-12): the one in the focused pane shows its second line there as well.
  for (const li of $('folders').querySelectorAll('li.srow')) {
    const id = li.dataset.id;
    li.classList.toggle('on', Boolean(id) && id === cur);
    li.classList.toggle('shown', Boolean(id) && id !== cur && open.has(id));
  }
}

function openFromRail(s, e = {}) {
  // A Codex thread opens like any session now (2026-10-12): a new tab, the empty pane, or a split; the pane becomes a Codex one.
  const existing = paneBySession(s.id);
  // Open anywhere already: go there (Arthur, 2026-10-12: "clicking on the session in the left navbar should take you
  // directly to that pane"): its tab, the focus, its row in view, a brief flash.
  if (existing) { revealPane(existing); return; }
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
    <p>This opens a <b>dedicated Claude Code session</b> in a new tab. Claude searches every transcript on this ${pc()} with its own tools (the index, grep, reading files), follows leads, and reports the sessions that match, with ids you can click to open.</p>
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
  b.title = t.get() === 'auto' ? `Theme follows ${osName()} (now ${t.effective()}). Click for ${THEME_UI[ui.next].label.toLowerCase()}.` : `${ui.label} theme. Click for ${THEME_UI[ui.next].label.toLowerCase()}.`;
}
if ($('theme')) $('theme').onclick = () => window.apakiTheme.set(THEME_UI[window.apakiTheme.get()].next);

/* ---------- the rail's bottom-left corner: Glass, Settings, Phone (2026-10-09) ---------- */

// On the phone (WEB) the card only shows: switching accounts and keep-warm are billing, which a phone never runs (remote-policy.js).
const glassCard = initGlassCard({ root: $('glassState'), send, menu, readOnly: WEB, note: (text, tone) => focusedPane()?.note(text, tone) });
const settings = initSettings({
  button: $('settings'), sheet, send, theme: window.apakiTheme, themeUi: THEME_UI, indexText, warm: !WEB,
  // Auto-compact is the PC's: it applies to every Claude Code Apaki starts, and a phone cannot send that op (remote-policy.js).
  compact: !WEB,
  // Freeing the Claude Code process of a hidden, idle conversation is the host's, on the PC (the same: a phone cannot send that op).
  release: !WEB,
  // Open at sign-in is the window shell's (src/autostart.rs); the phone has no such thing.
  autostart: WEB ? null : { get: () => invoke('autostart_get'), set: (on) => invoke('autostart_set', { on }) },
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

/** Speech to 16 kHz mono for Whisper (2026-10-12: iOS records at its own rate whatever the AudioContext asked). */
function to16k(chunks, rate) {
  if (rate === 16000) return chunks;
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(n / ratio));
  // Average each output sample's span of input samples: a cheap low-pass that keeps speech clear at 16 kHz.
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(n, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += all[j];
    out[i] = b > a ? sum / (b - a) : all[a] || 0;
  }
  return [out];
}

function wavFrom(chunks, rate) {
  chunks = to16k(chunks, rate);
  rate = 16000;
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
  // 16 kHz when the browser allows it; some iOS versions refuse that rate, and to16k resamples whatever comes.
  let ctx;
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
  // Made after an await, so iOS may start it suspended (2026-10-12, the phone's mic).
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (ev) => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  const started = Date.now();
  rec = { pane, stream, ctx, proc, chunks, started, timer: setInterval(() => {
    // The phone sends its recording to the PC (remote-policy MAX_VOICE_B64, about 85 s): stop a little before that.
    if (WEB && Date.now() - started > 80000) { stopVoice(); return; }
    pane.setStatus(`Listening · ${Math.round((Date.now() - started) / 1000)}s · click the mic to stop`); if (Date.now() - started > VOICE_MAX_MS) stopVoice(); }, 250) };
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
  // Ctrl+`: the focused pane flips to its console and back, as in VS Code (2026-10-12, console.js).
  if (e.code === 'Backquote' && !WEB) { e.preventDefault(); focusedPane()?.console?.toggle(); return; }
  const k = e.key.toLowerCase();
  // Ctrl+F: find in the focused pane (its conversation, task or artifact), not the browser's own find.
  // A viewer in the side panel you clicked into (2026-10-13) is the one Ctrl+F searches and Ctrl+W closes.
  if (k === 'f' && !e.shiftKey) { e.preventDefault(); openFind(panelFocused() || focusedPane()); return; }
  if (k === 't') { e.preventDefault(); addTab(); return; }
  if (k === 'w') { e.preventDefault(); shortcut('w', false); return; }
  // Ctrl+B: hide or show the sidebar, as in VS Code.
  if (k === 'b' && !e.shiftKey && !WEB) { e.preventDefault(); setRailCollapsed(!S.railCollapsed); return; }
  // Ctrl+Shift+B (2026-10-13): the tab's side panel, open or collapsed to its rail.
  if (k === 'b' && e.shiftKey && !WEB) { e.preventDefault(); togglePanel(); return; }
  // Ctrl+Shift+Enter: the focused pane to the whole window, or back to its place (2026-10-12).
  if (k === 'enter' && e.shiftKey && !WEB) { e.preventDefault(); const p = focusedPane(); if (p) toggleMaximize(p); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const i = S.tabs.indexOf(activeTab());
    switchTab(S.tabs[(i + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length]);
    focusPane(focusedPane());
    return;
  }
  if (/^[1-6]$/.test(e.key)) {
    const id = L.ids(activeTab()?.root)[Number(e.key) - 1];
    if (id) { e.preventDefault(); focusNth(S.panes.get(id)); }
  }
});

/* ---------- sheets (billing, folders, Details), one at a time ---------- */

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

// Questions, plan approval and permission prompts used to open here as sheets (permissionSheet, askSheet), one at a time
// over the whole window. Since 2026-10-12 they are cards inside the pane that asked (askcard.js, `asks` above); the
// sheet stays for what still belongs over the window (billing, folders, Details, renames on the phone).

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
  const names = tabNames();
  const tabs = S.tabs.map((t, ti) => ({
    focused: t.focused,
    // 2026-10-12: your name for the tab (empty: automatic), the name it shows (the phone's "On your desktop" reads it),
    // how it is arranged ('custom' keeps the tree as saved) and its maximized pane. Older workspaces have none of these.
    name: t.name || '', label: names[ti]?.text || '', arrange: t.arrange || 'auto', max: t.max || null, shape: t.shape || null,
    root: L.mapLeaves(t.root, (lf) => {
      const p = S.panes.get(lf.pane);
      if (p?.isBrowser) return { type: 'leaf', pane: lf.pane, web: p.saved() };
      if (p?.isViewer) return { type: 'leaf', pane: lf.pane, view: p.saved() };
      return {
        // A pane following a desktop pane (followDesktop) is kept as an empty one: reopening its session would take it over.
        type: 'leaf', pane: lf.pane, s: (!p?.following && p?.sessionId) || null, cwd: p?.cwd || '', title: p?.following ? '' : p?.title || '', model: p?.model, effort: p?.effort, mode: p?.mode,
        // Ultracode and its size (Claude), the reasoning summary and speed (Codex): kept with the pane in the saved workspace (tune.js).
        tune: p?.tune || null,
        // A new Codex conversation has no session id to say so yet (2026-10-12).
        ...(p?.kind === 'codex' ? { kind: 'codex' } : {}),
        draft: p?.$?.input?.value || '', queue: (p?.queue || []).filter((q) => q.text).map((q) => ({ id: q.id, text: q.text })),
        // A pane in a background tab has no box to measure: its remembered place is saved, not "at the end, 0" (pane.js scrollState, 2026-10-12).
        scroll: p?.scrollState ? p.scrollState() : null,
        busy: Boolean(p?.busy && !p?.following), pendingName: p?.pendingName || null,
        // The shared view: what the pane follows, and the conversation it showed (for its Open here if the PC's pane is gone by then).
        ...(p?.following ? { follow: p.following, fs: p.sessionId || null, ft: p.title || '' } : {}),
        // Its console was showing (console.js): a reload shows it again.
        ...(p?.console?.shown ? { console: true } : {}),
      };
    }),
    // The side panel (2026-10-13): its viewers, saved as the leaves they used to be (web for a browser, view for the
    // rest), and the panel's state. A workspace without them is an older one: restore moves its viewer leaves here.
    items: (t.items || []).map((id) => {
      const p = S.panes.get(id);
      if (!p?.isViewer) return null;
      return p.isBrowser ? { type: 'leaf', pane: id, web: p.saved() } : { type: 'leaf', pane: id, view: p.saved() };
    }).filter(Boolean),
    side: { open: Boolean(t.side?.open), width: t.side?.width ?? null, group: t.side?.group || null, pick: { ...(t.side?.pick || {}) } },
  }));
  return { v: 1, savedAt: Date.now(), active: S.tabs.findIndex((t) => t.id === S.active), tabs, rail: { view: S.view, expanded: [...S.expanded], scroll: $('sessions')?.scrollTop || 0, width: S.railW || null, collapsed: Boolean(S.railCollapsed), wtFolded: wtc.foldedList(), foldersOpen: folderOpen.list() }, win: S.win || null };
}

/** Saves at once (timed for the minute line, perfwatch.js; saveNowUntimed saves). */
function saveNow() { return watch.time('save', saveNowUntimed); }

/** Saves at once: localStorage, and the engine's copy on disk (desktop only). */
function saveNowUntimed() {
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

/**
 * A viewer made again from its saved leaf (a side panel item, 2026-10-13): a subagent or shell following its file, a
 * browser with its tabs (each page loaded the first time it is on screen), changes read again, an artifact's latest
 * revision. Null for a leaf that is none of these, or a pane id already in use.
 */
function viewerFromLeaf(lf) {
  if (!lf || typeof lf.pane !== 'string' || S.panes.has(lf.pane)) return null;
  if (lf.view?.task) return createTaskViewer(lf.view, lf.pane);
  if (lf.web && typeof lf.web === 'object') return createBrowser({ ...lf.web }, lf.pane);
  if (lf.view?.diff) return createDiffViewer(lf.view.diff, lf.pane);
  if (lf.view?.id) return createViewer(lf.view, lf.pane);
  return null;
}

function restore(saved = readLocal()) {
  // Several browser panes of one conversation (before 2026-10-12, some in tabs of their own) come back as that
  // conversation's one browser pane with a tab for each page (workspace.js foldBrowsers).
  const folded = W.foldBrowsers(saved?.v === 1 && Array.isArray(saved.tabs) ? saved.tabs : [], saved?.active ?? 0);
  // Viewers saved as leaves of the layout tree (before 2026-10-13) move into the side panel of their conversation's tab;
  // those whose conversation is gone stay in their tab, under Other (workspace.js migrateViewers).
  const migrated = W.migrateViewers(folded.tabs, folded.active);
  const tabs = migrated.tabs;
  if (saved && (folded.tabs !== saved.tabs || migrated.tabs !== folded.tabs)) saved = { ...saved, active: migrated.active };
  if (saved?.rail) {
    if (typeof saved.rail.view === 'string') S.view = saved.rail.view;
    S.expanded = new Set(Array.isArray(saved.rail.expanded) ? saved.rail.expanded : []);
    wtc.setFolded(saved.rail.wtFolded);
    // The folders that were open (2026-10-12); localStorage keeps them too, the saved workspace wins after a crash.
    if (Array.isArray(saved.rail.foldersOpen)) folderOpen.load(saved.rail.foldersOpen);
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
      // A browser comes back with its tabs, each page loaded the first time it is on screen (a page the shell kept
      // across a reload of the window is taken back as it is: S.alive).
      if (lf.web) return L.leaf(createBrowser({ ...lf.web }, lf.pane).id);
      // A diff viewer comes back reading its worktree's changes again.
      if (lf.view?.diff) return L.leaf(createDiffViewer(lf.view.diff, lf.pane).id);
      // A viewer comes back showing its artifact's latest revision.
      if (lf.view?.id) return L.leaf(createViewer(lf.view, lf.pane).id);
      // A pane that followed a pane on the PC follows it again (the shared view); opening its conversation here would take it over.
      if (typeof lf.follow === 'string' && lf.follow) {
        const fp = createPane({ id: lf.pane, sessionId: lf.fs || null, cwd: lf.cwd, title: lf.ft, model: lf.model, effort: lf.effort, mode: lf.mode, tune: lf.tune, kind: lf.kind });
        fp.setFollowing(lf.follow, { readOnly: phoneCap() !== 'full' });
        send('follow', { paneId: fp.id, desktopPaneId: lf.follow });
        return L.leaf(fp.id);
      }
      // One session per pane, ever: a duplicate in old saved state opens as a new conversation.
      const sid = lf.s && !seen.has(lf.s) ? lf.s : null;
      if (sid) seen.add(sid);
      // The session id is set at once so a save before the engine answers keeps it.
      const p = createPane({ id: lf.pane, sessionId: sid, cwd: lf.cwd, title: lf.title, model: lf.model, effort: lf.effort, mode: lf.mode, tune: lf.tune, kind: lf.kind });
      // What you were typing, what was queued, where you were reading, a name waiting for its session.
      if (lf.draft) { p.$.input.value = lf.draft; p.autosize(); p.renderSendButton?.(); }
      // The saved id is kept: the engine may hold the same item (it sends it itself when the turn ends with no window), and matches by id (pane.js adoptQueue).
      if (Array.isArray(lf.queue) && lf.queue.length) { p.queue = lf.queue.map((q, i) => ({ id: typeof q.id === 'string' && q.id ? q.id : `r${i}${Date.now().toString(36)}`, text: q.text, attachments: [] })); p.renderQueue(); }
      if (lf.scroll) p.restoreScroll = lf.scroll;
      if (lf.pendingName) p.pendingName = lf.pendingName;
      if (lf.busy) p.crashNote = true;
      // Its console was showing: the engine still has it (its screen comes back), or the pane opens it again (pane.js 'opened').
      if (lf.console) p.consoleRestore = true;
      p.open(sid ? { id: sid, cwd: lf.cwd, title: lf.title } : null, { warm: false });
      return L.leaf(p.id);
    });
    // The side panel's viewers (2026-10-13), made the way the tree's used to be, in the order they opened.
    const items = (Array.isArray(st.items) ? st.items : []).map(viewerFromLeaf).filter(Boolean);
    const okRoot = root && L.valid(root) ? root : null;
    if (!okRoot && !items.length) continue;
    // A workspace saved before 2026-10-12 has no arrangement: its tree comes back exactly as saved (custom).
    const t = createTab(okRoot, { name: typeof st.name === 'string' ? st.name.slice(0, 60) : '', arrange: typeof st.arrange === 'string' ? st.arrange : 'custom', max: typeof st.max === 'string' && L.has(okRoot, st.max) ? st.max : null, shape: st.shape || (typeof st.arrange === 'string' ? 'wide' : null), side: { ...(st.side && typeof st.side === 'object' ? st.side : {}), seen: items.length > 0 } });
    t.items = items.map((v) => v.id);
    for (const v of items) t.panel?.mount(v.el);
    t.focused = L.has(okRoot, st.focused) ? st.focused : WEB && t.items.includes(st.focused) ? st.focused : L.ids(okRoot)[0] || null;
    layout(t);
  }
  if (!S.tabs.length) { addTab(); return; }
  switchTab(S.tabs[Math.min(Math.max(0, saved?.active ?? 0), S.tabs.length - 1)]);
  focusPane(focusedPane());
}

/* ---------- engine events ---------- */

// console, consoleData, consoleView, terminal (2026-10-12): the pane's console and Open in terminal (console.js).
// artifactSaved, artifactEdited (2026-10-13): a viewer's Download and Save of an edit (artifacts.js).
const PANE_EVENTS = new Set(['steered', 'steer_missed', 'locked', 'taken_over', 'opened', 'history', 'session_id', 'sdk', 'result', 'billing', 'commands', 'note', 'error', 'transcript', 'settings', 'artifactContent', 'agentLines', 'outputText', 'taskOutput', 'context', 'historyPage', 'historyBlock', 'historyPrompts', 'historyCount', 'followers', 'peerMessage', 'console', 'consoleData', 'consoleView', 'terminal', 'artifactSaved', 'artifactEdited']);

/** Phone access (phone.js), set up at start; null in the phone web client. */
let phone = null;

// Registered before anything is sent: `listen` is async, and events that
// arrive before it resolves are lost (a reload lost restored panes' opens).
// Each event is timed for the minute line (perfwatch.js): its own handling as 'events', a pane's as 'panes', and what
// they draw under their own names.
await listen('engine', watch.wrap('events', ({ payload: e }) => {
  // Git worktrees (worktree.js): the repositories, and the answers to what this window asked about them.
  if (wtc.handle(e)) return;
  // Something Claude showed: a card in its conversation, and the viewer beside it.
  if (e.ev === 'artifact' || e.ev === 'openUrl') {
    const p = S.panes.get(e.paneId);
    if (p) watch.time('panes', () => p.handle(e));
    // A turn's changes and a picture Codex looked at are cards (their Open shows the viewer); only Claude's and Codex's own shows pop one up.
    if (e.ev === 'artifact' && (!CARD_ONLY_VIA.has(e.via) || e.open)) openViewer({ ...e, sourcePane: e.paneId }, { auto: !e.open });
    // openUrl: the engine already put it in the built-in browser (browserId),
    // or this window does now (beside the conversation, without the focus).
    if (e.ev === 'openUrl' && !e.browserId && p) openUrlHere(e.url, p, { focus: false, reason: e.reason || 'show' });
    return;
  }
  // What Claude just did in a browser (browser_click, _type...): a line in that browser's strip.
  if (e.ev === 'browserActivity') {
    // The page is a tab of a conversation's browser pane (2026-10-12): the pane shows the tab Claude works in.
    const b = browserOf(e.browserId);
    if (b) {
      // In the side panel (2026-10-13) that page becomes its browser's tab on screen, without moving the panel elsewhere.
      if (b.active !== e.browserId) { b.activate(e.browserId); syncSoon(); panelSoon(); save(); }
      b.activity(e.text || e.action || '');
    }
    return;
  }
  if (e.paneId && PANE_EVENTS.has(e.ev)) {
    const p = S.panes.get(e.paneId);
    if (!p) return; // a pane closed while its event was on the way
    watch.time('panes', () => p.handle(e));
    if (e.ev === 'result') cameBack(p, 'done');
    if (e.ev === 'taken_over') cameBack(p, 'ask');
    // Opened afresh (not re-attached to a running pane): nothing it asked before still waits, so its cards go.
    if (e.ev === 'opened' && !e.attached) asks.reset(p);
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
      S.foldersKnown = Array.isArray(e.folders);
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
      if (!S.drag) railSoon();
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
      if (S.expanded.has(e.sessionId) && !S.drag) railSoon();
      const pp = tasksPanelPane();
      if (pp && pp.sessionId === e.sessionId) openTasksPanel(pp, null);
      for (const p of S.panes.values()) if (p.sessionId === e.sessionId) p.renderTasksButton?.();
      break;
    }
    case 'subagentsChanged': {
      const s = S.sessions.find((x) => x.id === e.sessionId);
      if (s) s.subagents = e.count;
      if (S.expanded.has(e.sessionId) || tasksPanelPane()?.sessionId === e.sessionId) send('subagents', { sessionId: e.sessionId });
      else if (s && !S.drag) railSoon();
      for (const p of S.panes.values()) if (p.sessionId === e.sessionId) p.renderTasksButton?.();
      break;
    }
    case 'state': S.stateWait?.(e.state || null); S.stateWait = null; break;
    case 'warm':
      S.warm = new Set(e.sessions || []);
      if (!S.drag) railSoon();
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
      S.foldersKnown = Array.isArray(e.folders);
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
      // A card in the pane that asked (askcard.js), never a sheet over the window; a repeat (a reconnect asks again)
      // changes nothing. Its row in the list says "waiting for your answer" until it is answered or gone (syncWaiting).
      // A phone that may only watch (follows a PC pane at No shell or Chat only) cannot answer it, the PC refuses: its
      // card shows the question with every choice off and one line saying where to answer (askcard.js READ_ONLY_TEXT).
      const entry = p ? asks.ask(e, p) : null;
      if (entry?.readOnly) cameBack(p, 'ask');
      else if (entry) ding('ask');
      break;
    }
    // A question nobody waits for any more (answered on another screen, the turn ended, Claude asked again): its card
    // goes, with one line saying who settled it (askcard.js goneNote).
    case 'ask_gone': asks.gone(e, S.panes.get(e.paneId)); dropSheet(e.askId); if (S.waiting.delete(e.askId) && !S.drag) renderRail(); break;
    // Details (2026-10-12): what the engine read about a session; the open Details sheet fills in.
    case 'sessionInfo':
      S.info.set(e.sessionId, e.ok ? e.info : { error: e.message || 'Could not read it.' });
      if (detailsFor?.id === e.sessionId && sheetKey === `details:${e.sessionId}` && sheetClose) fillDetails($('sheet'), sheetClose, detailsFor);
      break;
    // Export as Markdown (2026-10-12): saved in Downloads and shown in Explorer (the desktop), or the text (the phone).
    case 'exported':
      if (!e.ok) { if (WEB) phoneToast(e.message || 'Could not export it.', false); else focusedPane()?.note(e.message || 'Could not export it.', 'error'); break; }
      if (typeof e.markdown === 'string') downloadText(e.name || 'conversation.md', e.markdown);
      else focusedPane()?.note(`Saved ${e.name} in ${short(String(e.path || '').replace(/[\\/][^\\/]*$/, ''))}.`);
      break;
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
    case 'releaseHidden': settings.handle(e); break;
    // The PC closed the pane this phone's pane follows (or no longer has it): the pane says so (pane.js followEnded). The answer to this
    // phone's own unfollow or close finds nothing (the pane left already, or follows no more).
    case 'closed': { const p = S.panes.get(e.paneId); if (p?.following) p.followEnded(); break; }
    case 'remote': phone?.handle(e); break;
    case 'note': focusedPane()?.note(e.text, e.tone || ''); break;
    // Open in terminal asked from outside a pane (the sidebar's row menu, 2026-10-12): the focused pane says how it went.
    case 'terminal': { const fp = focusedPane(); if (fp?.onTerminal) fp.onTerminal(e); break; }
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
}));

// The built-in browser's events (src/browser.rs): pages made, their state,
// the keyboard in a page, a page closing itself.
await listen('browser', ({ payload: e }) => {
  // e.id is a page; since 2026-10-12 a page is one tab of a browser pane (browser.js), found by browserOf.
  const b = browserOf(e.id);
  switch (e.ev) {
    case 'created': case 'reveal': placeBrowser(e); break;
    // A page's title, address and loading light: its tab in the side panel shows them too (2026-10-13).
    case 'state': if (b) { b.update(e.id, e); if (!b.tab(e.id)?.live) b.attach(e.id, e); panelSoon(); } break;
    case 'focus': if (b) focusPane(b, { scroll: false }); break;
    case 'key': if (b) focusPane(b, { scroll: false }); shortcut(e.key, e.shift); break;
    // A page that closes itself (window.close) takes its tab with it; the last tab takes the pane.
    case 'closeRequested': if (b) { b.removeTab(e.id); renderTabs(); panelSoon(); save(); } break;
    // Closed by the shell: could not start (its tab says why), or closed by Claude's browser_tabs (the tab goes).
    case 'closed':
      if (b && e.error) { b.gone(e.id, `The browser could not start: ${e.error}`); panelSoon(); }
      else if (b) { b.removeTab(e.id); renderTabs(); panelSoon(); save(); }
      break;
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
// A page kept is any tab of a restored browser, not only its first one (2026-10-13: the side panel's hidden tabs stay alive).
for (const id of S.alive) if (!S.panes.get(id)?.isBrowser && !browserOf(id)) invoke('browser', { cmd: 'close', args: { id } }).catch(() => {});
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
// 2026-10-13: the side panel for checks and the demo harness (togglePanel, setPanelOpen, groupsOf, stepMaximize).
// 2026-10-15: renderRail and renderTabs, so apaki/demo/perf.mjs can time a drawing of the list and the tab bar on its own.
window.__apaki = { S, L, W, wt: wtc, renderRail, renderTabs, openDiff, openTask, toggleMaximize, revealPane, setArrangement, tabNames, focusedPane, activeTab, addTab, arrangeGrid, openViewer, viewers, browsers, openUrlHere, syncBrowsers, focusPane, openFromRail, followDesktop, togglePanel, setPanelOpen, groupsOf, stepMaximize, dropSession:(s, edge) => { const t = activeTab(); const target = focusedPane(); dropSession(t, target ? { where: edge === 'center' ? 'center' : 'edge', edge, pane: target } : { where: 'root' }, s); } };
