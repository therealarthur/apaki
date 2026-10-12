/**
 * sessionlist.js: the sidebar's session list and folders, in the ChatGPT app's manner (2026-10-12).
 *
 * WHY (Arthur, 2026-10-12): "the folders should expand when clicked on and contract when clicked on again instead of
 * just transitioning the entire sidepanel, also the sessions listed should be a bit more compact but when selected or
 * right clicked have more information available. think about everything a user might want to do with a session. (think
 * about chatgpt app and how the sessions are displayed - lets organize them similarly, with the accurate timestamp, with
 * the name, showing full name and additional information on hover, and all information available somewhere in
 * details/properties when right clicking)".
 *
 * So a row is one line: the name, cut with an ellipsis, and the last message's time in a short form at the right,
 * under recency headings (Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, then by month). State that
 * matters stays visible but quiet, as small glyphs or words, never a pill with a dot: working, waiting for an answer,
 * open in a terminal, Codex, an archived copy. The row open in the focused pane (or under the keyboard) shows one more
 * line; hovering shows a card with the full name, the exact time, the folder, the branch, the agent, the model and the
 * size; right click (or the row's ... button) has every action, and Details shows everything known.
 *
 * Folders open and close in place, like a tree (several at once; the open ones are remembered), instead of replacing
 * the list.
 *
 * This file has the parts that are the same on the desktop and the phone and can be tested without a window:
 *   time:     recencyGroup, groupRows, shortTime, exactTime, agoText, bytesText, modelName
 *   a row:    rowStates, rowTip, detailLine
 *   menus:    sessionMenuItems (the desktop's), folderMenuItems
 *   Details:  sessionFacts, detailsHtml
 *   folders:  createOpenState (which folders are open, kept in localStorage)
 *   keys:     navKey (what a key does in a list: move, open, toggle, menu, details, rename)
 * app.js draws the rows and wires them (it holds the panes, the drag and drop and the engine).
 */

import { esc } from './markdown.js';

const DAY = 86400000;

/* ---------- time ---------- */

/** Local midnight of the day a time falls on. */
export function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days from `ms` to `now` (0 today, 1 yesterday; a time in the future counts as today). */
export function daysAgo(ms, now = Date.now()) {
  return Math.max(0, Math.round((dayStart(now) - dayStart(ms)) / DAY));
}

/**
 * The recency group a time falls in, as the ChatGPT app groups its chats: Today, Yesterday, Previous 7 days, Previous
 * 30 days, then each month ("September", or "September 2025" in another year). No time: "Earlier".
 */
export function recencyGroup(ms, now = Date.now(), locale = undefined) {
  if (!ms || !Number.isFinite(ms)) return { key: 'undated', label: 'Earlier' };
  const days = daysAgo(ms, now);
  if (days === 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (days <= 7) return { key: 'week', label: 'Previous 7 days' };
  if (days <= 30) return { key: 'month', label: 'Previous 30 days' };
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const label = new Intl.DateTimeFormat(locale, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' }).format(d);
  return { key: `m:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label };
}

/**
 * Rows in recency groups, newest first: [{ key, label, rows }]. Pinned rows come first under "Pinned" (pinned: false
 * leaves them in their time group). A row's time is s.lastModified (the last real message, engine last-active.js).
 */
export function groupRows(rows, now = Date.now(), { pinned = true, locale } = {}) {
  const sorted = [...rows].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  const groups = [];
  const byKey = new Map();
  const add = (key, label, s) => {
    let g = byKey.get(key);
    if (!g) { g = { key, label, rows: [] }; byKey.set(key, g); groups.push(g); }
    g.rows.push(s);
  };
  if (pinned) for (const s of sorted) if (s.pinned) add('pinned', 'Pinned', s);
  for (const s of sorted) {
    if (pinned && s.pinned) continue;
    const g = recencyGroup(s.lastModified, now, locale);
    add(g.key, g.label, s);
  }
  // Pinned first, then by time (the groups were made in time order, so only Pinned moves).
  return groups.sort((a, b) => (b.key === 'pinned') - (a.key === 'pinned'));
}

const fmt = (locale, o) => new Intl.DateTimeFormat(locale, o);

/**
 * A row's time, short and exact enough to tell rows apart: "now" under a minute, "12m" under an hour, the clock time
 * today ("2:32 PM"), and yesterday too when the row sits under Yesterday (grouped); a weekday and the time within the
 * week ("Mon 2:32 PM"); the date before that ("Sep 28"), with the year when it is another one ("Sep 28, 2025").
 */
export function shortTime(ms, now = Date.now(), { grouped = true, locale } = {}) {
  if (!ms || !Number.isFinite(ms)) return '';
  const diff = now - ms;
  if (diff >= 0 && diff < 60 * 1000) return 'now';
  if (diff >= 0 && diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))}m`;
  const d = new Date(ms);
  const days = daysAgo(ms, now);
  const clock = fmt(locale, { hour: 'numeric', minute: '2-digit' }).format(d);
  if (days === 0 || (days === 1 && grouped)) return clock;
  if (days < 7) return `${fmt(locale, { weekday: 'short' }).format(d)} ${clock}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return fmt(locale, { month: 'short', day: 'numeric' }).format(d);
  return fmt(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** The exact local date and time: "Tuesday, October 13, 2026 at 10:42:07 AM". */
export function exactTime(ms, locale = undefined) {
  if (!ms || !Number.isFinite(ms)) return '';
  try { return fmt(locale, { dateStyle: 'full', timeStyle: 'medium' }).format(new Date(ms)); } catch { return new Date(ms).toLocaleString(locale); }
}

/** How long ago, in words: "just now", "4 minutes ago", "3 hours ago", "2 days ago", "5 months ago", "2 years ago". */
export function agoText(ms, now = Date.now()) {
  if (!ms || !Number.isFinite(ms)) return '';
  const s = Math.max(0, (now - ms) / 1000);
  const w = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 45) return 'just now';
  if (s < 3600) return w(Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return w(Math.round(s / 3600), 'hour');
  if (s < 30 * 86400) return w(Math.round(s / 86400), 'day');
  if (s < 365 * 86400) return w(Math.max(1, Math.round(s / (30 * 86400))), 'month');
  return w(Math.round(s / (365 * 86400)), 'year');
}

/** Bytes in words: "812 B", "14 KB", "2.1 MB", "1.2 GB". */
export function bytesText(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** A model id as people say it: claude-opus-5-5 is "Opus 5.5", claude-sonnet-4-5-20250929 "Sonnet 4.5"; others as they are. */
export function modelName(id) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(String(id || ''));
  if (!m) return String(id || '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}

const plural = (n, w) => `${Number(n).toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

/* ---------- a row ---------- */

const WORKING_RE = /work|busy|run|think|stream/i;
const WAITING_RE = /wait|input|permission|ask|approv/i;

/**
 * The states a row shows, quietest last: [{ k, label }]. live: what this window knows ({ runningHere, waiting }).
 * k is one of working, waiting, terminal, codex, archived-copy, pinned (pinned only when asked: under Pinned it is
 * already said).
 */
export function rowStates(s, live = {}, { showPinned = false } = {}) {
  const out = [];
  const status = String(s?.terminal?.status || '');
  if (live.waiting || (s?.terminal && WAITING_RE.test(status))) out.push({ k: 'waiting', label: 'Waiting for your answer' });
  else if (live.runningHere || s?.running || (s?.terminal && WORKING_RE.test(status))) out.push({ k: 'working', label: 'Working' });
  if (s?.terminal) out.push({ k: 'terminal', label: `Open in ${s.terminal.name || 'a terminal'}${status ? `, ${status}` : ''}` });
  if (s?.codex) out.push({ k: 'codex', label: 'Codex' });
  if (s?.archivedCopy) out.push({ k: 'archived-copy', label: 'Archived copy: Claude Code deleted the original after 30 days' });
  if (showPinned && s?.pinned) out.push({ k: 'pinned', label: 'Pinned' });
  return out;
}

/** Small glyphs (16 unit box, drawn in currentColor by CSS) for the states and the row's controls. */
export const GLYPH = Object.freeze({
  working: '<svg class="sg sg-working" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/></svg>',
  waiting: '<svg class="sg sg-waiting" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5v-2.5H3A1.5 1.5 0 0 1 1.5 10V5A1.5 1.5 0 0 1 3 3.5z"/><path d="M6.6 6.2a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9M8 9.6v.1"/></svg>',
  terminal: '<svg class="sg sg-terminal" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M4.6 6.4 6.6 8l-2 1.6M8.2 10h3"/></svg>',
  'archived-copy': '<svg class="sg sg-archived" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.5 8.8h3"/></svg>',
  // The small Codex mark (2026-10-12): a hexagon with a prompt chevron, apart from the terminal's rectangle.
  codex: '<svg class="sg sg-codex" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 13.5 4.85v6.3L8 14.3 2.5 11.15v-6.3z"/><path d="M6.5 5.9 8.7 8l-2.2 2.1"/></svg>',
  pinned: '<svg class="sg sg-pinned" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 2.2 13.8 6.4l-1.6.6-2.4 2.4.2 3-1.2 1.2-2.4-2.4L3.6 14l-.6-.6 2.8-2.8-2.4-2.4 1.2-1.2 3 .2L10 4.8z"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.4" cy="8" r="1.15"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>',
  folder: '<svg class="fi" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/></svg>',
});

/** The state marks of a row as HTML: small glyphs (Codex's too), with their words for screen readers. */
export function statesHtml(states) {
  return states.map((x) => `<span class="sr-s sr-${x.k}" role="img" aria-label="${esc(x.label)}">${GLYPH[x.k] || ''}</span>`).join('');
}

/**
 * The hover card of a row (tooltip.js setTip): the full name, the exact time of the last message, the folder, the
 * branch or worktree, Claude or Codex, the model when known, the size and what it is doing.
 * c: { now, locale, folderName, branch, worktree, model, live, pane }
 */
export function rowTip(s, c = {}) {
  const now = c.now ?? Date.now();
  const rows = [];
  if (s.lastModified) rows.push(['Last message', `${exactTime(s.lastModified, c.locale)} (${agoText(s.lastModified, now)})`]);
  if (s.cwd) rows.push(['Folder', s.cwd]);
  const branch = c.branch || s.branch || '';
  if (c.worktree) rows.push(['Worktree', `${branch || 'detached'} · ${c.worktree}`]);
  else if (branch) rows.push(['Branch', branch]);
  rows.push(['Agent', s.codex ? 'Codex' : 'Claude Code']);
  const model = c.model || s.model || '';
  if (model) rows.push(['Model', modelName(model)]);
  if (s.size) rows.push(['Size', bytesText(s.size)]);
  if (c.folderName) rows.push(['In folder', c.folderName]);
  // Codex is already the Agent row.
  const states = rowStates(s, c.live || {}, { showPinned: true }).filter((x) => x.k !== 'codex').map((x) => x.label);
  if (s.subagents > 0) states.push(plural(s.subagents, 'subagent'));
  if (s.headless) states.push('Started headless (claude -p, a worker, or relay on from its first message)');
  if (s.bare) states.push('No messages yet');
  if (c.pane) states.push(c.pane.busy ? 'Open here, working' : 'Open here');
  if (states.length) rows.push(['State', states.join(' · ')]);
  return {
    head: s.title || '(untitled)',
    rows,
    hint: c.web ? '' : 'Shift+click: beside · Ctrl+click: new tab · Right-click: more',
  };
}

/** The one more line the row in the focused pane (or under the keyboard) shows: folder, branch, model, size. */
export function detailLine(s, c = {}) {
  const parts = [];
  if (s.cwd) parts.push(c.shortPath ? c.shortPath(s.cwd) : s.cwd);
  const branch = c.branch || s.branch || '';
  if (branch) parts.push(branch);
  const model = c.model || s.model || '';
  if (model) parts.push(modelName(model));
  if (s.size) parts.push(bytesText(s.size));
  if (c.folderName) parts.push(`in ${c.folderName}`);
  return parts.join(' · ');
}

/* ---------- menus ---------- */

/**
 * The desktop's menu for a session (right click, or the row's ... button). Everything a person may want to do with
 * one, grouped: open it (here, beside, in a new tab, in a terminal), stop or close it where it runs, change it (rename,
 * pin, move to a folder, fork, archive), use it (ask Claude about it, export it), copy and find it (id, resume command,
 * its folder in Explorer), and Details. Items that cannot apply say why (disabled with a reason) or are left out.
 *
 * ctx: { pane: an object when it is open in a pane here (busy: working), running: a turn runs in the engine,
 *        folderName: its folder's name, subagents: count, subsOpen: its subagents show, tabFull: the active tab is
 *        full }
 */
export function sessionMenuItems(s, ctx = {}) {
  const pane = ctx.pane || null;
  const codex = Boolean(s.codex || String(s.id || '').startsWith('codex:'));
  const runningHere = Boolean(pane?.busy);
  const running = runningHere || Boolean(ctx.running || s.running);
  const items = [{ heading: String(s.title || 'Session').slice(0, 48) }];
  items.push(pane ? { value: 'open', label: 'Show it', hint: 'it is open in a pane' } : { value: 'open', label: 'Open', hint: 'Click' });
  if (!pane) {
    items.push({ value: 'split', label: 'Open beside', hint: ctx.tabFull ? 'this tab is full: a new tab' : 'Shift+click' });
    items.push({ value: 'tab', label: 'Open in a new tab', hint: 'Ctrl+click' });
    items.push({ value: 'here', label: 'Open here', hint: 'replaces the focused pane' });
  }
  if (s.archivedCopy) items.push({ value: null, label: 'Open in a terminal', disabled: 'Claude Code deleted the original; open it here and send a message to restore it first', hint: 'restore it first' });
  else if (pane) items.push({ value: null, label: 'Open in a terminal', disabled: 'It is open in a pane here; close the pane first', hint: 'open here' });
  else items.push({ value: 'terminal', label: 'Open in a terminal', hint: codex ? 'codex resume' : 'claude --resume' });
  if (running || pane) {
    items.push({ divider: true });
    if (running) items.push({ value: 'stop', label: 'Stop', hint: runningHere ? (codex ? 'stop Codex here (Esc)' : 'stop Claude here (Esc)') : 'stop its running turn', danger: true });
    if (pane) items.push({ value: 'close', label: 'Close its pane', hint: pane.busy ? 'asks first: it is working' : '' });
  } else if (s.terminal && WORKING_RE.test(String(s.terminal.status || ''))) {
    items.push({ divider: true }, { value: null, label: 'Stop', hint: 'runs in a terminal; stop it there', disabled: 'It runs in a Claude Code terminal window; stop it there' });
  }
  items.push({ divider: true });
  items.push({ value: 'rename', label: 'Rename…', hint: 'F2' });
  items.push(s.pinned ? { value: 'unpin', label: 'Unpin', hint: 'back in its time group' } : { value: 'pin', label: 'Pin to top', hint: 'under Pinned' });
  items.push({ value: 'move', label: 'Move to folder…', hint: ctx.folderName ? `in ${ctx.folderName}` : '' });
  if (!s.archivedCopy) items.push({ value: 'fork', label: 'Fork into a new conversation', hint: 'a copy to take elsewhere' });
  if (s.codexArchived) items.push({ value: null, label: 'Archived in Codex', hint: 'unarchive it in the Codex app', disabled: 'Archived in the Codex app; unarchive it there' });
  else if (s.archived) items.push({ value: 'unarchive', label: 'Unarchive', hint: 'back in the lists' });
  else items.push({ value: 'archive', label: 'Archive', hint: 'hide it; nothing is deleted' });
  items.push({ divider: true });
  items.push({ value: 'ask', label: 'Ask Claude about it', hint: 'a new conversation' });
  items.push({ value: 'export', label: 'Export as Markdown', hint: 'to Downloads' });
  if (ctx.subagents > 0) items.push({ value: 'subs', label: ctx.subsOpen ? 'Hide its subagents' : `Show its subagents (${ctx.subagents})` });
  items.push({ divider: true });
  items.push({ value: 'copy-id', label: 'Copy session id' });
  items.push({ value: 'copy-resume', label: 'Copy resume command', hint: codex ? 'codex resume' : 'claude --resume' });
  if (s.cwd) items.push({ value: 'reveal', label: 'Show folder in Explorer', hint: ctx.shortCwd || '' });
  items.push({ divider: true });
  items.push({ value: 'details', label: 'Details', hint: 'Alt+Enter' });
  return items;
}

/**
 * The menu of a folder row (right click, or a long press on the phone): open or close it, show it alone in the list,
 * rename, delete. web: the phone, which leaves renaming and deleting folders to the PC (remote-policy.js).
 */
export function folderMenuItems(f, { open = false, shownAlone = false, web = false } = {}) {
  return [
    { heading: String(f.name || 'Folder').slice(0, 48) },
    { value: 'toggle', label: open ? 'Close' : 'Open', hint: web ? '' : 'Click' },
    { value: 'alone', label: shownAlone ? 'Show all sessions' : 'Show only this folder', hint: 'in the list below' },
    ...(web ? [] : [
      { divider: true },
      { value: 'rename', label: 'Rename…', hint: 'F2' },
      { value: 'delete', label: 'Delete folder…', hint: 'its sessions stay', danger: true },
    ]),
  ];
}

/* ---------- Details ---------- */

const n = (v) => (Number.isFinite(v) ? Number(v).toLocaleString() : '');

/** A pane's permission mode in the words its picker uses (Claude Code's modes, the Codex app's presets). */
export const MODE_WORDS = Object.freeze({
  bypassPermissions: 'Bypass permissions', acceptEdits: 'Auto-accept edits', plan: 'Plan mode', default: 'Ask permissions',
  'full-access': 'Full access', auto: 'Auto', 'read-only': 'Read only',
});

/**
 * Everything the Details sheet shows about a session, in sections, from its list record (s), what the engine read
 * (info: null while it reads, { error } when it could not) and what this window knows (c: { pane, worktree, folderName,
 * now, locale, web, branch }). Rows: { k, v, mono?, copy?, act? }. copies: what the copy buttons copy.
 */
export function sessionFacts(s, info, c = {}) {
  const now = c.now ?? Date.now();
  const i = info && !info.error ? info : {};
  const reading = info === null || info === undefined;
  const wait = reading ? 'Reading…' : '';
  const codex = Boolean(s.codex || i.provider === 'codex' || String(s.id || '').startsWith('codex:'));
  const title = i.customTitle || s.title || i.title || '(untitled)';
  const resume = `${s.cwd ? `cd "${s.cwd}" && ` : ''}${codex ? `codex resume ${String(s.id).replace(/^codex:/, '')}` : `claude --resume ${s.id}`}`;
  const copies = { id: s.id, resume, ...(s.cwd ? { cwd: s.cwd } : {}), ...(i.transcript ? { transcript: i.transcript } : {}) };
  const row = (k, v, o = {}) => ({ k, v: v === undefined || v === null ? '' : String(v), ...o });
  const sections = [];

  // The full name is the sheet's heading; the list's name shows here only when Claude Code saved another one.
  const conv = [
    ...(s.title && s.title !== title ? [row('Listed as', s.title)] : []),
    row('Session id', s.id, { mono: true, copy: 'id' }),
    row('Agent', `${codex ? 'Codex' : 'Claude Code'}${i.version ? ` ${i.version}` : ''}${i.originator ? ` (${i.originator})` : ''}`),
  ];
  const first = i.firstPromptFull || s.firstPrompt || '';
  if (first && first !== title) conv.push(row('First prompt', first, { long: true }));
  if (i.summary && i.summary !== title) conv.push(row('Summary', i.summary, { long: true }));
  sections.push({ title: 'Conversation', rows: conv });

  const where = [];
  if (s.cwd) where.push(row('Folder', s.cwd, { mono: true, copy: 'cwd', act: c.web ? '' : 'reveal' }));
  if (i.lastCwd && s.cwd && i.lastCwd.replace(/[\\/]+$/, '').toLowerCase() !== s.cwd.replace(/[\\/]+$/, '').toLowerCase()) where.push(row('Last ran in', i.lastCwd, { mono: true }));
  const branch = c.branch || i.gitBranch || s.branch || '';
  if (branch) where.push(row('Branch', branch, { mono: true }));
  if (c.worktree) where.push(row('Worktree', c.worktree, { mono: true }));
  if (c.folderName || i.folder?.name) where.push(row('In folder', c.folderName || i.folder.name));
  if (i.transcript) where.push(row(codex ? 'Rollout' : 'Transcript', i.transcript, { mono: true, copy: 'transcript' }));
  else if (i.archivedCopy || s.archivedCopy) where.push(row('Transcript', "Apaki's archive keeps a copy (Claude Code deleted the original after 30 days)"));
  else if (reading) where.push(row('Transcript', wait, { pending: true }));
  sections.push({ title: 'Where', rows: where });

  const act = [];
  if (i.created || reading) act.push(row('Started', i.created ? exactTime(i.created, c.locale) : wait, { pending: !i.created }));
  const last = i.lastActive || s.lastModified;
  if (last) act.push(row('Last message', `${exactTime(last, c.locale)} (${agoText(last, now)})`));
  if (reading) act.push(row('Prompts and replies', wait, { pending: true }));
  else if (Number.isFinite(i.prompts)) {
    act.push(row('Prompts', n(i.prompts)));
    act.push(row('Replies', n(i.replies)));
    if (i.toolCalls) act.push(row('Tool calls', n(i.toolCalls)));
    if (i.compactions) act.push(row('Compactions', n(i.compactions)));
  }
  const t = i.tokens;
  if (t && (t.output || t.input)) {
    act.push(row('Tokens', [`${n(t.output)} out`, `${n(t.input)} in`, t.cacheRead ? `${n(t.cacheRead)} cache read` : '', t.cacheWrite ? `${n(t.cacheWrite)} cache write` : '', t.reasoning ? `${n(t.reasoning)} reasoning` : ''].filter(Boolean).join(' · ')));
  }
  sections.push({ title: 'Activity', rows: act });

  const pane = c.pane || (i.panes || [])[0] || null;
  const run = [];
  const model = (pane && pane.model) || i.model || s.model || '';
  if (model) run.push(row(pane?.model ? 'Model' : 'Model last used', modelName(model)));
  if ((i.models || []).length > 1) run.push(row('Models used', i.models.map(modelName).join(', ')));
  const effort = (pane && pane.effort) || i.effort || '';
  if (effort) run.push(row('Effort', effort));
  if (pane?.mode) run.push(row('Permissions', MODE_WORDS[pane.mode] || pane.mode));
  if (i.approval || i.sandbox) run.push(row('Codex approvals', [i.approval, i.sandbox].filter(Boolean).join(' · ')));
  const billing = (pane && pane.billing) || '';
  if (billing) run.push(row('Billed to', billing));
  if (reading && !model) run.push(row('Model', wait, { pending: true }));
  if (run.length) sections.push({ title: 'Model', rows: run });

  const st = [];
  const panes = i.panes || [];
  if (c.pane) st.push(row('In Apaki', c.pane.busy ? 'Open in a pane here, working' : 'Open in a pane here'));
  else if (panes.length) st.push(row('In Apaki', panes.map((p) => `${p.where === 'phone' ? 'on a phone' : 'in a pane'}${p.running ? ', working' : ''}`).join(' · ')));
  else st.push(row('In Apaki', s.running ? 'Working (kept running in the background)' : 'Not open'));
  const term = (i.terminal && i.terminal.length ? i.terminal : s.terminal ? [s.terminal] : []);
  st.push(row('Terminal', term.length ? term.map((x) => `${x.name || 'Terminal'}${x.status ? `, ${x.status}` : ''}${x.pid ? ` (pid ${x.pid})` : ''}`).join(' · ') : 'Not open in a terminal'));
  const subs = Number.isFinite(i.subagents) && !reading ? i.subagents : s.subagents || 0;
  if (subs) st.push(row('Subagents', n(subs)));
  if (i.shells) st.push(row('Background shells', `${n(i.shells)}${i.shellsRunning ? `, ${n(i.shellsRunning)} running` : ''}`));
  const archived = s.codexArchived || i.codexArchived ? 'Archived in Codex' : s.archived || i.archived ? 'Archived in Apaki (hidden from the lists; nothing deleted)' : 'No';
  st.push(row('Archived', archived));
  if (s.archivedCopy || i.archivedCopy) st.push(row('Original', 'Deleted by Claude Code after 30 days; this is the archive copy'));
  st.push(row('Pinned', s.pinned || i.pinned ? 'Yes' : 'No'));
  if (s.headless || i.headless) st.push(row('Started', 'Headless (claude -p, a worker, or relay on from its first message)'));
  sections.push({ title: 'State', rows: st });

  const size = [];
  const tsize = i.size || s.size || 0;
  if (tsize) size.push(row(codex ? 'Rollout' : 'Transcript', bytesText(tsize)));
  if (i.sideSize) size.push(row('Subagents and tool output', bytesText(i.sideSize)));
  if (i.totalSize && i.sideSize) size.push(row('Total', bytesText(i.totalSize)));
  if (size.length) sections.push({ title: 'Size on disk', rows: size });

  return {
    id: s.id, title, codex, sections, copies, reading,
    error: info?.error || '',
    sub: [codex ? 'Codex' : 'Claude Code', last ? `last message ${agoText(last, now)}` : ''].filter(Boolean).join(' · '),
  };
}

/** The Details sheet's HTML (inside app.js's sheet): sections of label and value rows, copy buttons, the actions. */
export function detailsHtml(f, { web = false } = {}) {
  const sec = f.sections.filter((x) => x.rows.length).map((x) => `<section class="sd-sec"><div class="sd-h">${esc(x.title)}</div><dl class="sd-rows">${x.rows.map((r) => {
    const btns = [
      r.copy ? `<button class="sd-btn" data-copy="${esc(r.copy)}" title="Copy ${esc(r.k.toLowerCase())}">Copy</button>` : '',
      r.act === 'reveal' ? '<button class="sd-btn" data-act="reveal" title="Show this folder in Explorer">Show</button>' : '',
    ].join('');
    return `<dt>${esc(r.k)}</dt><dd class="${[r.mono ? 'mono' : '', r.long ? 'long' : '', r.pending ? 'pending' : ''].filter(Boolean).join(' ')}"><span class="sd-v">${esc(r.v)}</span>${btns ? `<span class="sd-acts">${btns}</span>` : ''}</dd>`;
  }).join('')}</dl></section>`).join('');
  return `<div class="sd" data-details="${esc(f.id)}">
    <div class="from">${esc(f.sub)}</div><h2 class="sd-title">${esc(f.title)}</h2>
    ${f.error ? `<div class="sd-note">${esc(f.error)}</div>` : ''}
    ${sec}
    <div class="row sd-row"><button data-copy="resume">Copy resume command</button>${web ? '' : '<button data-act="export">Export as Markdown</button>'}<button class="primary" data-k="x">Done</button></div>
  </div>`;
}

/* ---------- which folders are open ---------- */

export const OPEN_KEY = 'apaki.folders.open';

/**
 * The folders that are open in the sidebar, kept in `storage` (localStorage) under OPEN_KEY as a JSON list of ids, so
 * they come back after a restart (the saved workspace keeps a copy too). onChange runs after every change.
 */
export function createOpenState(storage = null, { key = OPEN_KEY, onChange = null } = {}) {
  let open = new Set();
  try { const j = JSON.parse(storage?.getItem(key) || '[]'); if (Array.isArray(j)) open = new Set(j.filter((x) => typeof x === 'string')); } catch { /* none open */ }
  const persist = () => {
    try { storage?.setItem(key, JSON.stringify([...open])); } catch { /* not kept */ }
    onChange?.();
  };
  return {
    isOpen: (id) => open.has(id),
    toggle(id) { if (open.has(id)) open.delete(id); else open.add(id); persist(); return open.has(id); },
    set(id, on) { if (on === open.has(id)) return; if (on) open.add(id); else open.delete(id); persist(); },
    list: () => [...open],
    /** Replaces the set (a restored workspace); unknown ids are dropped by prune. */
    load(ids) { if (!Array.isArray(ids)) return; open = new Set(ids.filter((x) => typeof x === 'string')); persist(); },
    /** Forgets folders that are gone. */
    prune(ids) { const keep = new Set(ids); const before = open.size; open = new Set([...open].filter((x) => keep.has(x))); if (open.size !== before) persist(); },
  };
}

/* ---------- keys in a list ---------- */

/**
 * What a key does on a list item (a folder row or a session row), or null when it is not for the list:
 *   move: +1 / -1 / 'first' / 'last'; open (a session: Enter or Space), toggle (a folder: Enter or Space),
 *   expand / collapse (a folder: Right / Left), parent (a session in a folder: Left), menu (the context menu key or
 *   Shift+F10), details (Alt+Enter), rename (F2).
 * kind: 'folder' or 'session'; open: the folder is open; inFolder: the session sits in a folder.
 */
export function navKey(e, { kind = 'session', open = false, inFolder = false } = {}) {
  const k = e.key;
  if (k === 'Enter' && e.altKey) return { act: 'details' };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (k === 'ArrowDown') return { act: 'move', by: 1 };
  if (k === 'ArrowUp') return { act: 'move', by: -1 };
  if (k === 'Home') return { act: 'move', by: 'first' };
  if (k === 'End') return { act: 'move', by: 'last' };
  if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) return { act: 'menu' };
  if (e.shiftKey && k !== 'Enter') return null;
  if (k === 'F2') return { act: 'rename' };
  if (kind === 'folder') {
    if (k === 'Enter' || k === ' ') return { act: 'toggle' };
    if (k === 'ArrowRight') return { act: open ? 'move' : 'expand', by: 1 };
    if (k === 'ArrowLeft') return open ? { act: 'collapse' } : null;
    return null;
  }
  if (k === 'Enter' || k === ' ') return { act: 'open' };
  if (k === 'ArrowLeft' && inFolder) return { act: 'parent' };
  return null;
}
