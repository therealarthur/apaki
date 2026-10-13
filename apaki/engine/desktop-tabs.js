/**
 * desktop-tabs.js: the desktop window's tabs and the panes in each, as a
 * phone sees them (Arthur, 2026-10-11: "it doesnt display the tabs and the
 * screens/windows in the tabs that are open on the desktop app. that should
 * be displayed as well").
 *
 * The window saves its workspace to the engine (saveState) on every change;
 * desktopTabs(state) keeps only what a phone shows: per tab, its panes in
 * layout order with a kind, a title, the session id of a conversation,
 * whether it is working and which pane has focus. Drafts, queued messages,
 * folders, scroll positions and browser addresses stay on the PC.
 *
 * paneId (2026-10-11, the shared view): the desktop window's own id for the
 * pane ("p3"), so a phone can name one in follow (remote-policy.js). It is an
 * opaque short id and nothing else of the window's: an id that is not plain
 * letters, digits, "_" and "-" (at most 40) is sent as null, which a phone
 * cannot follow. Browsers, tasks and viewers carry one too (the PC refuses to
 * follow them: only a conversation can be followed).
 */

/** At most this many tabs and panes per tab go to a phone (the desktop keeps 6 panes a tab). */
export const MAX_TABS = 12;
export const MAX_PANES = 6;
const TITLE_CHARS = 120;

const title = (s, fallback) => {
  const t = typeof s === 'string' ? s.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (t || fallback).slice(0, TITLE_CHARS);
};

const PANE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The conversation pane a viewer leaf belongs to (2026-10-12): a browser's owner, an artifact's sourcePane, a task's or a
 * diff's ownerPane. The window saves viewers under `view` (and older shapes under task / artifact).
 */
function ownerOf(leaf) {
  const v = leaf.view && typeof leaf.view === 'object' ? leaf.view : null;
  const id = leaf.web?.owner || v?.sourcePane || v?.ownerPane || v?.diff?.ownerPane || leaf.task?.ownerPane || leaf.artifact?.sourcePane || null;
  return typeof id === 'string' ? id : null;
}

/** One leaf of the layout tree as a phone pane, or null for a leaf a phone does not show. names: pane id -> conversation title in this tab. */
function paneOf(leaf, focused, names = new Map()) {
  const base = { paneId: typeof leaf.pane === 'string' && PANE_ID_RE.test(leaf.pane) ? leaf.pane : null, focused: leaf.pane === focused };
  if (typeof leaf.s === 'string' && leaf.s) return { kind: 'session', sessionId: leaf.s, title: title(leaf.title, 'New conversation'), busy: Boolean(leaf.busy), ...base };
  if (!leaf.s && leaf.type === 'leaf' && 'draft' in leaf && !leaf.web && !leaf.task && !leaf.artifact && !leaf.view) return { kind: 'session', sessionId: null, title: 'New conversation', busy: false, ...base };
  // A viewer says whose it is (2026-10-12, the viewer links): the title of its conversation when that is in the same tab.
  const owner = ownerOf(leaf);
  const link = owner && names.has(owner) ? { for: names.get(owner) } : {};
  if (leaf.web && typeof leaf.web === 'object') return { kind: 'browser', title: title(leaf.web.title, 'Browser'), ...(Array.isArray(leaf.web.tabs) && leaf.web.tabs.length > 1 ? { tabs: Math.min(leaf.web.tabs.length, 99) } : {}), ...link, ...base };
  const v = leaf.view && typeof leaf.view === 'object' ? leaf.view : null;
  if (v?.task || (leaf.task && typeof leaf.task === 'object')) { const t = v || leaf.task; return { kind: 'task', title: title(t.title || t.description, 'Task'), ...link, ...base }; }
  if (v?.diff) return { kind: 'viewer', title: 'Changes', ...link, ...base };
  if (v?.id || (leaf.artifact && typeof leaf.artifact === 'object')) return { kind: 'viewer', title: title((v || leaf.artifact).title, 'Viewer'), ...link, ...base };
  return null;
}

/** The leaves of a layout tree, in order (left to right, top to bottom). */
function leaves(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 32) return out;
  if (node.type === 'leaf') out.push(node);
  else if (Array.isArray(node.children)) for (const c of node.children) leaves(c, out, depth + 1);
  return out;
}

/**
 * The phone's view of a saved workspace: [{ index, active, label, panes: [...] }]. label (2026-10-12): the name the tab
 * shows on the PC (the project its conversations share, or the one the person gave it); '' from an older window.
 * A viewer pane may carry `for` (its conversation's title) and a browser `tabs` (how many pages, from two).
 */
export function desktopTabs(state) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  return tabs.slice(0, MAX_TABS).map((t, index) => {
    const ls = leaves(t?.root);
    const names = new Map(ls.filter((l) => typeof l.pane === 'string' && !l.web && !l.view && 'draft' in l).map((l) => [l.pane, title(l.title, 'New conversation')]));
    return {
      index,
      active: index === state.active,
      label: typeof t?.label === 'string' ? title(t.label, '') : '',
      panes: ls.map((l) => paneOf(l, t?.focused, names)).filter(Boolean).slice(0, MAX_PANES),
    };
  });
}
