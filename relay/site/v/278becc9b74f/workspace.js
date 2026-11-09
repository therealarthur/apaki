/**
 * workspace.js: the rules for Apaki's tabs, layouts and viewers, as plain data
 * (no DOM), so they can be tested in Node. app.js applies them.
 *
 * WHY (Arthur, 2026-10-12): "look at how our tabs and panes are set up along
 * with the browsers that open - its all incredibly messy right now". The
 * design is apaki/docs/layout.md; in short:
 *
 *   tabLabel / tabLabels   a tab is a workspace named after the project its
 *                          conversations share (or by you), never after
 *                          whichever session has focus
 *   arrange                automatic layouts by pane count and the tab's shape,
 *                          and the presets (Columns, Rows, Grid, Main and stack),
 *                          with each conversation's viewers kept beside it
 *   placeCustom            where a new pane goes in a tab you arranged by hand
 *   viewerFor / accents    one viewer of a kind per conversation, and the accent
 *                          that links a conversation to its viewers
 *   goTo                   where clicking an open session in the sidebar goes
 *   toggleMax              maximize and restore without touching the tree
 *   foldBrowsers           old saved workspaces with several browser panes per
 *                          conversation become one browser pane with tabs
 *
 * The side panel (2026-10-13, Arthur: "the current way we display the browser
 * is incredibly hectic ... i dont know what browser is connected to what
 * session ... have a dedicated pane that comes out from the right side of the
 * app"): viewers no longer take cells in the pane grid. Each tab has a panel on
 * its right with what its conversations opened, grouped by conversation:
 *
 *   panelGroups            the groups (a conversation's items, then Other) and
 *                          their entries (each browser page its own entry)
 *   followFocus / shownGroup   the group the panel shows follows the focused
 *                          conversation, and never goes blank
 *   currentEntry           the entry a group shows
 *   panelWidth             the panel's width in a given main area
 *   stepMax                maximized: the previous or next conversation
 *   migrateViewers         old saved workspaces: viewer leaves move out of the
 *                          trees into their conversation's tab's panel
 */

import * as L from './layout-tree.js';

/** The arrangements a tab can have; 'custom' is a tree you built by dragging. */
export const ARRANGEMENTS = ['auto', 'columns', 'rows', 'grid', 'main'];
export const ARRANGE_LABEL = { auto: 'Auto', columns: 'Columns', rows: 'Rows', grid: 'Grid', main: 'Main and stack', custom: 'Custom' };
/** A viewer's share of its conversation's cell (the conversation keeps the rest). */
export const VIEWER_SHARE = 0.4;
/** The share the large pane of Main and stack takes. */
export const MAIN_SHARE = 0.6;
/** How many link accents there are (app.css .acc-0 to .acc-5). */
export const ACCENTS = 6;

/** 'tall' when a box is taller than wide, else 'wide' (also for a box not measured yet). */
export const shapeOf = (w, h) => (w > 0 && h > 0 && h > w ? 'tall' : 'wide');

/* ---------- tab names ---------- */

const HOME_RE = /^(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+|\/(?:Users|home)\/[^/]+|~)[\\/]*$/;

/** The last part of a path, without trailing separators. */
export const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

/**
 * The project a folder belongs to: the repository's name when the folder is in
 * one (repoOf(cwd) gives it; a worktree counts as its repository), "Home" for
 * the home folder, else the folder's own name. Null for no folder yet.
 */
export function projectOf(cwd, repoOf = () => null) {
  const c = String(cwd || '').trim();
  if (!c) return null;
  const repo = repoOf(c);
  if (repo) return String(repo);
  if (HOME_RE.test(c)) return 'Home';
  return baseName(c) || null;
}

const clip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * One tab's name. tab: { name?: string (yours), convs: [{ project, title }],
 * viewers: [{ title }] } in layout order. Returns { text, auto } where auto is
 * false for a name you gave it.
 */
export function tabLabel(tab = {}) {
  const own = String(tab.name || '').trim();
  if (own) return { text: clip(own), auto: false };
  const convs = Array.isArray(tab.convs) ? tab.convs : [];
  const projects = [...new Set(convs.map((c) => c?.project).filter(Boolean))];
  if (projects.length === 1) return { text: clip(projects[0]), auto: true };
  if (projects.length === 2) return { text: clip(`${projects[0]} · ${projects[1]}`), auto: true };
  if (projects.length > 2) return { text: clip(`${projects[0]} · ${projects[1]} +${projects.length - 2}`), auto: true };
  if (convs.length) return { text: convs.length === 1 && convs[0]?.title && convs[0].title !== 'New conversation' ? clip(convs[0].title) : 'New conversation', auto: true };
  const v = (Array.isArray(tab.viewers) ? tab.viewers : []).find((x) => x?.title);
  return { text: v ? clip(v.title) : 'Empty tab', auto: true };
}

/**
 * Every tab's name, with quiet secondary text where two automatic names would
 * read the same: a tab holding one conversation adds that conversation's
 * title, so several "claude-latch" tabs are told apart. Returns
 * [{ text, sub, auto, count }] in the same order; count is the conversations.
 */
export function tabLabels(tabs = []) {
  const out = tabs.map((t) => ({ ...tabLabel(t), sub: '', count: Array.isArray(t?.convs) ? t.convs.length : 0 }));
  const seen = new Map();
  out.forEach((l) => seen.set(l.text, (seen.get(l.text) || 0) + 1));
  out.forEach((l, i) => {
    if (!l.auto || seen.get(l.text) < 2 || l.count !== 1) return;
    const title = String(tabs[i].convs[0]?.title || '').trim();
    if (title && title !== 'New conversation' && title !== l.text) l.sub = clip(title, 40);
  });
  return out;
}

/* ---------- layouts ---------- */

const split = (dir, children, sizes) => (children.length === 1 ? children[0] : { type: 'split', dir, children, sizes: sizes || children.map(() => 1 / children.length) });
const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** An even grid of cells: about square, more columns when wide, more rows when tall. */
function gridOf(cells, wide) {
  const n = cells.length;
  const k = Math.ceil(Math.sqrt(n));
  const m = Math.ceil(n / k);
  const cols = wide ? k : m;
  return split('col', chunk(cells, cols).map((r) => split('row', r)));
}

/**
 * Lays out cells (subtrees) for an arrangement and a shape. Auto, wide:
 * 2 side by side, 3 one large and two stacked, 4 a 2x2 grid, 5 and 6 three
 * over two or three. Auto, tall: 2 stacked, 3 two on top and one below,
 * 4 a 2x2 grid, 5 and 6 two columns of three rows.
 */
export function arrangeCells(cells, { preset = 'auto', shape = 'wide' } = {}) {
  const n = cells.length;
  if (!n) return null;
  if (n === 1) return cells[0];
  const wide = shape !== 'tall';
  const row = (xs) => split('row', xs);
  const col = (xs) => split('col', xs);
  switch (preset) {
    case 'columns': return row(cells);
    case 'rows': return col(cells);
    case 'grid': return gridOf(cells, wide);
    case 'main': {
      const [m, ...rest] = cells;
      return split(wide ? 'row' : 'col', [m, wide ? col(rest) : row(rest)], [MAIN_SHARE, 1 - MAIN_SHARE]);
    }
    default:
      if (n === 2) return wide ? row(cells) : col(cells);
      if (n === 3) return wide ? split('row', [cells[0], col(cells.slice(1))]) : split('col', [row(cells.slice(0, 2)), cells[2]]);
      if (n === 4) return col([row(cells.slice(0, 2)), row(cells.slice(2))]);
      return wide ? col([row(cells.slice(0, 3)), row(cells.slice(3))]) : col(chunk(cells, 2).map(row));
  }
}

/**
 * Each pane's rectangle in a w by h box (gutters ignored): Map id -> { x, y, w, h }.
 */
export function rectsOf(node, w = 1, h = 1, x = 0, y = 0, out = new Map()) {
  if (!node) return out;
  if (node.type === 'leaf') { out.set(node.pane, { x, y, w, h }); return out; }
  let at = 0;
  node.children.forEach((c, i) => {
    const f = node.sizes[i];
    if (node.dir === 'row') rectsOf(c, w * f, h, x + w * at, y, out);
    else rectsOf(c, w, h * f, x, y + h * at, out);
    at += f;
  });
  return out;
}

/**
 * The groups of a tab, in layout order: each conversation with the viewers
 * whose source it is; viewers whose conversation is not in this tab group by
 * their source (or stand alone). info(id) -> { viewer: bool, source: id | null }.
 */
export function groupsOf(ids, info) {
  const groups = [];
  const byKey = new Map();
  const present = new Set(ids.filter((id) => !info(id)?.viewer));
  // Groups come in the order their conversation (or, for viewers without one here, their first viewer) appears.
  for (const id of ids) {
    const i = info(id) || {};
    if (!i.viewer) { const g = { conv: id, viewers: [] }; byKey.set(id, g); groups.push(g); continue; }
    if (i.source && present.has(i.source)) continue;
    const key = i.source ? `orphan:${i.source}` : `alone:${id}`;
    if (!byKey.has(key)) { const g = { conv: null, viewers: [] }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).viewers.push(id);
  }
  for (const id of ids) {
    const i = info(id) || {};
    if (i.viewer && i.source && present.has(i.source)) byKey.get(i.source).viewers.push(id);
  }
  return groups;
}

/** A group's own subtree: the conversation first, its viewers beside it (a row when the cell is wide) at the smaller share. */
function groupCell(g, shape) {
  const vs = g.viewers.map(L.leaf);
  if (!g.conv) return split(shape === 'tall' ? 'col' : 'row', vs);
  if (!vs.length) return L.leaf(g.conv);
  const wide = shape !== 'tall';
  return split(wide ? 'row' : 'col', [L.leaf(g.conv), split(wide ? 'col' : 'row', vs)], [1 - VIEWER_SHARE, VIEWER_SHARE]);
}

const SLOT = '\u0000g';

/**
 * The whole layout of a tab: its groups arranged by `preset` for a box of
 * w by h, each group's viewers beside its conversation. ids: the tab's panes
 * in their current order (that order is kept). Returns a valid, flattened tree.
 */
export function arrange(ids, info, { preset = 'auto', w = 1600, h = 900 } = {}) {
  const groups = groupsOf(ids, info);
  if (!groups.length) return null;
  const shape = shapeOf(w, h);
  const slots = groups.map((_, i) => L.leaf(`${SLOT}${i}`));
  const tree = arrangeCells(slots, { preset: ARRANGEMENTS.includes(preset) ? preset : 'auto', shape });
  const rects = rectsOf(tree, w, h);
  const fill = (node) => {
    if (node.type === 'leaf') {
      const i = Number(node.pane.slice(SLOT.length));
      const r = rects.get(node.pane);
      return groupCell(groups[i], r ? shapeOf(r.w, r.h) : shape);
    }
    return { ...node, children: node.children.map(fill) };
  };
  return L.flatten(fill(tree));
}

/** The panes of a tree ordered so the group of `first` comes first (Main and stack picked from the menu). */
export function withFirst(ids, info, first) {
  if (!first) return ids;
  const groups = groupsOf(ids, info);
  const i = groups.findIndex((g) => g.conv === first || g.viewers.includes(first));
  if (i <= 0) return ids;
  const [g] = groups.splice(i, 1);
  groups.unshift(g);
  return groups.flatMap((x) => [...(x.conv ? [x.conv] : []), ...x.viewers]);
}

/**
 * Where a new pane goes in a tab arranged by hand (custom): a viewer beside its
 * conversation (or below or beside that conversation's last viewer) at the
 * smaller share; anything else splits the largest pane along its longer side.
 * Returns the new tree.
 */
export function placeCustom(root, newId, { source = null, viewersOf = () => [], w = 1600, h = 900 } = {}) {
  if (!root) return L.leaf(newId);
  const rects = rectsOf(root, w, h);
  const ids = L.ids(root);
  let target = null;
  let share = 0.5;
  if (source && ids.includes(source)) {
    const mates = viewersOf(source).filter((id) => ids.includes(id) && id !== newId);
    target = mates.length ? mates[mates.length - 1] : source;
    share = mates.length ? 0.5 : VIEWER_SHARE;
  } else {
    let best = -1;
    for (const id of ids) { const r = rects.get(id); const a = r.w * r.h; if (a > best) { best = a; target = id; } }
  }
  const r = rects.get(target);
  return L.insert(root, target, newId, r && r.h > r.w ? 'bottom' : 'right', share);
}

/* ---------- viewers ---------- */

/** What kind of pane this is: 'conversation', 'browser', 'diff', 'task' or 'artifact'. */
export function kindOf(p) {
  if (!p?.isViewer) return 'conversation';
  if (p.isBrowser) return 'browser';
  if (p.isDiff) return 'diff';
  if (p.isTask) return 'task';
  return 'artifact';
}

/** The viewer of `kind` that belongs to conversation `source` already, if any (one of a kind per conversation). */
export function viewerFor(panes, kind, source) {
  if (!source) return null;
  for (const p of panes) if (p && p.isViewer && p.sourcePane === source && kindOf(p) === kind) return p;
  return null;
}

/**
 * The link accent of each conversation that has viewers in a tab, keeping the
 * one it had when it is still free there, else the lowest free one.
 * linked: conversation ids in layout order; prev: Map id -> accent.
 */
export function accents(linked, prev = new Map()) {
  const out = new Map();
  const used = new Set();
  for (const id of linked) {
    const had = prev.get(id);
    if (Number.isInteger(had) && had >= 0 && had < ACCENTS && !used.has(had)) { out.set(id, had); used.add(had); }
  }
  for (const id of linked) {
    if (out.has(id)) continue;
    let a = 0;
    while (used.has(a) && a < ACCENTS - 1) a += 1;
    if (used.has(a)) a = out.size % ACCENTS;
    out.set(id, a);
    used.add(a);
  }
  return out;
}

/* ---------- going to an open conversation ---------- */

/**
 * Where a click on session `sessionId` goes when a pane has it open.
 * state: { tabs: [{ id, ids: [paneIds], max: paneId | null }], active, paneOf: (sessionId) -> paneId | null }.
 * Returns null when no pane has it, else { tab, pane, switchTab, restore }:
 * restore is the maximized pane of that tab to put back first (another pane).
 */
export function goTo(state, sessionId) {
  const pane = sessionId ? state.paneOf(sessionId) : null;
  if (!pane) return null;
  const tab = state.tabs.find((t) => t.ids.includes(pane));
  if (!tab) return null;
  return { tab: tab.id, pane, switchTab: tab.id !== state.active, restore: tab.max && tab.max !== pane ? tab.max : null };
}

/* ---------- maximize ---------- */

/**
 * Maximizes pane `id` of a tab, or restores it when it is the one maximized.
 * The tree is never changed, so the restore is exact. Returns the new tab.
 */
export function toggleMax(tab, id) {
  if (!tab || !id || !L.has(tab.root, id)) return { ...tab, max: null };
  return { ...tab, max: tab.max === id ? null : id };
}

/* ---------- old saved workspaces ---------- */

const webOf = (lf) => (lf && lf.type === 'leaf' && lf.web && typeof lf.web === 'object' ? lf.web : null);

/**
 * Saved tabs (the workspace's `tabs`) with every conversation's browser panes
 * folded into one browser pane with tabs: the one in the conversation's own tab
 * keeps its place and takes the others' pages as tabs; tabs that end up empty
 * go. Browsers with no conversation behind them stay as they are.
 * Returns { tabs, active }: active is the saved active tab's new index.
 */
export function foldBrowsers(savedTabs, active = 0) {
  if (!Array.isArray(savedTabs)) return { tabs: [], active: 0 };
  const leavesOf = (n, out = []) => { if (!n) return out; if (n.type === 'leaf') out.push(n); else (n.children || []).forEach((c) => leavesOf(c, out)); return out; };
  const convTab = new Map();
  savedTabs.forEach((t, i) => leavesOf(t?.root).forEach((lf) => { if (!lf.web && !lf.view && typeof lf.pane === 'string') convTab.set(lf.pane, i); }));
  const byOwner = new Map();
  savedTabs.forEach((t, i) => leavesOf(t?.root).forEach((lf) => {
    const w = webOf(lf);
    if (!w || !w.owner) return;
    if (!byOwner.has(w.owner)) byOwner.set(w.owner, []);
    byOwner.get(w.owner).push({ tab: i, leaf: lf });
  }));
  const drop = new Set();
  const merged = new Map();
  for (const [owner, list] of byOwner) {
    if (list.length < 2) continue;
    const keep = list.find((x) => x.tab === convTab.get(owner)) || list[0];
    const tabsOf = (x) => {
      const w = webOf(x.leaf);
      return Array.isArray(w.tabs) && w.tabs.length ? w.tabs : [{ id: x.leaf.pane, url: w.url || '', title: w.title || '' }];
    };
    const all = [];
    for (const x of [keep, ...list.filter((y) => y !== keep)]) for (const tb of tabsOf(x)) if (!all.some((a) => a.id === tb.id)) all.push(tb);
    merged.set(keep.leaf.pane, all);
    for (const x of list) if (x !== keep) drop.add(x.leaf.pane);
  }
  if (!drop.size) return { tabs: savedTabs, active };
  const out = [];
  let nowActive = 0;
  for (const [i, t] of savedTabs.entries()) {
    if (i === active) nowActive = out.length;
    let root = t?.root || null;
    for (const id of drop) if (root && L.has(root, id)) root = L.remove(root, id);
    if (root) {
      root = L.mapLeaves(root, (lf) => {
        const all = merged.get(lf.pane);
        if (!all) return lf;
        const w = webOf(lf);
        const active = w.active && all.some((a) => a.id === w.active) ? w.active : all[0].id;
        return { ...lf, web: { ...w, tabs: all, active } };
      });
    }
    if (!root) continue;
    out.push({ ...t, root, focused: L.has(root, t.focused) ? t.focused : L.ids(root)[0] });
  }
  return { tabs: out, active: Math.min(nowActive, Math.max(0, out.length - 1)) };
}

/* ---------- the side panel (2026-10-13) ---------- */

/** The panel's width limits, in CSS pixels, and its share of the main area until you drag it (at most PANEL_DEFAULT_MAX). */
export const PANEL_MIN = 320;
export const PANEL_MAX = 1100;
export const PANEL_DEFAULT_SHARE = 0.4;
export const PANEL_DEFAULT_MAX = 640;
/** The conversations keep at least this much of the main area beside the panel. */
export const PANEL_MAIN_MIN = 360;
/** Collapsed, the panel is a rail this wide. */
export const PANEL_RAIL = 44;
/** The group of items whose conversation is not in this tab (closed, or there never was one). */
export const OTHER = 'other';
/** The order kinds take inside a group (Arthur: "browser pages first, then artifacts, diffs and task/subagent viewers"). */
const KIND_RANK = { browser: 0, artifact: 1, diff: 2, task: 3 };

/** An entry's key: a viewer's id, or for a browser page its browser's id and the page's. */
export const entryKey = (item, page = null) => (page ? `${item}#${page}` : item);

/**
 * The panel's groups for a tab. convs: the tab's conversation ids in layout order. items: the viewers in its panel in the
 * order they were opened, as { id, kind, source, pages? } (pages: a browser's page ids in its own order). A conversation
 * with items is a group, in layout order; items whose conversation is not in this tab form the group OTHER, last. Inside
 * a group, browser pages come first (each page its own entry), then artifacts, changes and tasks, each kind in the order
 * opened. Returns [{ key, conv, entries: [{ key, item, page, kind }] }].
 */
export function panelGroups(convs = [], items = []) {
  const present = new Set(convs);
  const by = new Map();
  for (const it of items) {
    if (!it || typeof it.id !== 'string') continue;
    const key = it.source && present.has(it.source) ? it.source : OTHER;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(it);
  }
  const entriesOf = (list) => list
    .map((it, i) => ({ it, i, rank: KIND_RANK[it.kind] ?? 9 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .flatMap(({ it }) => (it.kind === 'browser' && Array.isArray(it.pages) && it.pages.length
      ? it.pages.map((p) => ({ key: entryKey(it.id, p), item: it.id, page: p, kind: 'browser' }))
      : [{ key: entryKey(it.id), item: it.id, page: null, kind: KIND_RANK[it.kind] === undefined ? 'artifact' : it.kind }]));
  const out = [];
  for (const c of convs) if (by.has(c)) out.push({ key: c, conv: c, entries: entriesOf(by.get(c)) });
  if (by.has(OTHER)) out.push({ key: OTHER, conv: null, entries: entriesOf(by.get(OTHER)) });
  return out;
}

/**
 * The group the panel moves to when conversation `focus` takes the focus (Arthur: "when clicking on a session, it
 * switches the tab in the browser pane to the browser(s) specific to that session"): its own group when it has items,
 * else the group shown until now (the panel never goes blank because you clicked a conversation with nothing open).
 */
export function followFocus(groups, focus, shown) {
  if (focus && groups.some((g) => g.key === focus)) return focus;
  return shown;
}

/**
 * What the panel shows now: the group wanted (followFocus, or one picked in its switcher) while it still exists, else the
 * focused conversation's, else the first. note: the focused conversation has nothing open, so another conversation's
 * items show (the panel says so, quietly). Returns { group: key | null, note: bool }.
 */
export function shownGroup(groups, { focus = null, want = null } = {}) {
  if (!groups.length) return { group: null, note: false };
  const has = (k) => Boolean(k) && groups.some((g) => g.key === k);
  const group = has(want) ? want : has(focus) ? focus : groups[0].key;
  return { group, note: Boolean(focus) && !has(focus) };
}

/**
 * The entry a group shows: the item picked there last (for a browser, the page it shows: activePage(itemId)), else the
 * group's first entry. Null for an empty group.
 */
export function currentEntry(group, picked, activePage = () => null) {
  if (!group?.entries?.length) return null;
  const mine = group.entries.filter((e) => e.item === picked);
  if (mine.length) {
    const a = activePage(picked);
    return mine.find((e) => e.page === a) || mine[0];
  }
  return group.entries[0];
}

/**
 * The entry to show after the item of entry `key` closes: the next entry of another item in its group, else the one
 * before, else null. (A page closed in a browser with other pages is the browser's own business: browser.js shows its
 * neighbour.)
 */
export function neighbourEntry(group, key) {
  const list = group?.entries || [];
  const i = list.findIndex((e) => e.key === key);
  if (i < 0) return list[0] || null;
  const item = list[i].item;
  return list.slice(i + 1).find((e) => e.item !== item) || list.slice(0, i).reverse().find((e) => e.item !== item) || null;
}

/**
 * The panel's width in a main area `box` px wide: the width you dragged it to, else PANEL_DEFAULT_SHARE of the area (at
 * most PANEL_DEFAULT_MAX, so a wide screen gives its room to the conversations), held between PANEL_MIN and PANEL_MAX
 * and never leaving the conversations less than PANEL_MAIN_MIN.
 */
export function panelWidth(want, box) {
  const room = Number.isFinite(box) && box > 0 ? box : 1400;
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, room - PANEL_MAIN_MIN));
  const w = Number.isFinite(want) && want > 0 ? want : Math.min(PANEL_DEFAULT_MAX, Math.round(room * PANEL_DEFAULT_SHARE));
  return Math.round(Math.max(PANEL_MIN, Math.min(max, w)));
}

/** Maximized, the conversation the previous (d = -1) or next (d = 1) control goes to: layout order, wrapping. */
export function stepMax(ids, max, d) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const i = ids.indexOf(max);
  if (i < 0) return ids[0];
  return ids[(i + (d < 0 ? -1 : 1) + ids.length) % ids.length];
}

/** A saved leaf that is a viewer (a browser, an artifact, changes, a task), in any shape a window saved. */
export const isViewerLeaf = (lf) => Boolean(lf && lf.type === 'leaf' && ((lf.web && typeof lf.web === 'object') || (lf.view && typeof lf.view === 'object') || (lf.task && typeof lf.task === 'object') || (lf.artifact && typeof lf.artifact === 'object')));

/** The conversation pane a saved viewer leaf belongs to: a browser's owner, a viewer's sourcePane, a task's or a diff's ownerPane. */
export function leafOwner(lf) {
  const v = lf?.view && typeof lf.view === 'object' ? lf.view : null;
  const id = lf?.web?.owner || v?.sourcePane || v?.ownerPane || v?.diff?.ownerPane || lf?.task?.ownerPane || lf?.artifact?.sourcePane || null;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Saved workspaces from before the side panel keep viewers as leaves of the layout tree. Each viewer leaf moves into the
 * panel items of the tab that holds its conversation; one whose conversation is in no tab stays in the tab it was in
 * (its panel's Other group, with the quiet chip that reopens the session). The trees keep only conversations: a tab
 * laid out by an arrangement is laid out again for them, a tree made by hand (or saved before arrangements) gives each
 * viewer's space to its neighbours. A tab left with nothing goes. A focus or maximized pane on a viewer goes to its
 * conversation, else the tab's first. The panel of a tab that received viewers starts open on the focused conversation.
 * Nothing to move: the same tabs back. Returns { tabs, active, moved }.
 */
export function migrateViewers(savedTabs, active = 0) {
  if (!Array.isArray(savedTabs)) return { tabs: [], active: 0, moved: 0 };
  const leavesOf = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (n.type === 'leaf') out.push(n); else (n.children || []).forEach((c) => leavesOf(c, out)); return out; };
  const convTab = new Map();
  savedTabs.forEach((t, i) => leavesOf(t?.root).forEach((lf) => { if (!isViewerLeaf(lf) && typeof lf.pane === 'string') convTab.set(lf.pane, i); }));
  const items = savedTabs.map((t) => (Array.isArray(t?.items) ? [...t.items] : []));
  const got = savedTabs.map(() => false);
  let moved = 0;
  const roots = savedTabs.map((t, i) => {
    let root = t?.root || null;
    for (const lf of leavesOf(root)) {
      if (!isViewerLeaf(lf)) continue;
      const owner = leafOwner(lf);
      const to = owner && convTab.has(owner) ? convTab.get(owner) : i;
      items[to].push(lf);
      got[to] = true;
      root = L.remove(root, lf.pane);
      moved += 1;
    }
    return root;
  });
  if (!moved) return { tabs: savedTabs, active, moved: 0 };
  const out = [];
  let nowActive = 0;
  savedTabs.forEach((t, i) => {
    if (i === active) nowActive = out.length;
    let root = roots[i];
    if (!root && !items[i].length) return;
    const ids = L.ids(root);
    const preset = typeof t?.arrange === 'string' && ARRANGEMENTS.includes(t.arrange) ? t.arrange : null;
    if (root && preset && root !== t.root) {
      const tall = t.shape === 'tall';
      // The arrangement makes bare leaves: each takes back its saved leaf (the session, title, model, draft...).
      const saved = new Map(leavesOf(root).map((lf) => [lf.pane, lf]));
      root = L.mapLeaves(arrange(ids, () => ({ viewer: false, source: null }), { preset, w: tall ? 900 : 1600, h: tall ? 1600 : 900 }), (lf) => saved.get(lf.pane) || lf);
    }
    const ownerOfId = (id) => leafOwner(leavesOf(t?.root).find((lf) => lf.pane === id));
    const onConv = (id) => (ids.includes(id) ? id : ids.includes(ownerOfId(id)) ? ownerOfId(id) : null);
    const focused = onConv(t?.focused) || ids[0] || null;
    const max = typeof t?.max === 'string' && ids.includes(t.max) ? t.max : null;
    const side = t?.side && typeof t.side === 'object' ? t.side : got[i] ? { open: true, group: focused, width: null, pick: {} } : undefined;
    out.push({ ...t, root, focused, max, items: items[i], ...(side ? { side } : {}) });
  });
  return { tabs: out, active: Math.min(nowActive, Math.max(0, out.length - 1)), moved };
}
