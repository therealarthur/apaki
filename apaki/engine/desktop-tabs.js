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
 */

/** At most this many tabs and panes per tab go to a phone (the desktop keeps 6 panes a tab). */
export const MAX_TABS = 12;
export const MAX_PANES = 6;
const TITLE_CHARS = 120;

const title = (s, fallback) => {
  const t = typeof s === 'string' ? s.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (t || fallback).slice(0, TITLE_CHARS);
};

/** One leaf of the layout tree as a phone pane, or null for a leaf a phone does not show. */
function paneOf(leaf, focused) {
  const base = { focused: leaf.pane === focused };
  if (typeof leaf.s === 'string' && leaf.s) return { kind: 'session', sessionId: leaf.s, title: title(leaf.title, 'New conversation'), busy: Boolean(leaf.busy), ...base };
  if (!leaf.s && leaf.type === 'leaf' && 'draft' in leaf && !leaf.web && !leaf.task && !leaf.artifact) return { kind: 'session', sessionId: null, title: 'New conversation', busy: false, ...base };
  if (leaf.web && typeof leaf.web === 'object') return { kind: 'browser', title: title(leaf.web.title, 'Browser'), ...base };
  if (leaf.task && typeof leaf.task === 'object') return { kind: 'task', title: title(leaf.task.title || leaf.task.description, 'Task'), ...base };
  if (leaf.artifact && typeof leaf.artifact === 'object') return { kind: 'viewer', title: title(leaf.artifact.title, 'Viewer'), ...base };
  return null;
}

/** The leaves of a layout tree, in order (left to right, top to bottom). */
function leaves(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 32) return out;
  if (node.type === 'leaf') out.push(node);
  else if (Array.isArray(node.children)) for (const c of node.children) leaves(c, out, depth + 1);
  return out;
}

/** The phone's view of a saved workspace: [{ index, active, panes: [...] }]. */
export function desktopTabs(state) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  return tabs.slice(0, MAX_TABS).map((t, index) => ({
    index,
    active: index === state.active,
    panes: leaves(t?.root).map((l) => paneOf(l, t?.focused)).filter(Boolean).slice(0, MAX_PANES),
  }));
}
