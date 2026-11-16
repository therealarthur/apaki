/**
 * worktree.js: git worktrees in the window and on the phone page (2026-10-12; design apaki/remote/WORKTREES.md,
 * build order steps 2 to 4). Arthur, 2026-10-11: "The best approach to AI development is using git worktrees to
 * tackle multiple features simultaneously ... make sure we're updating the app alongside the desktop app so all
 * functionality is equal across the board". apaki/ui is shared by the desktop window and the phone page, so what
 * is drawn here is drawn on both; the engine decides what a phone's access level may do (remote-policy.js).
 *
 * Two halves:
 *   the model   pure functions, no DOM, tested from test/apaki-worktrees-ui.test.js: which worktree a folder is in,
 *               the label ("fix-checkout +42 -7"), the trouble words, the sidebar rows, the pane menu, the branch
 *               name suggested from a first message, and a patch read into lines.
 *   the controller (initWorktrees)  state from the engine's `worktrees` event, requests and their answers, and the
 *               sheets: every git action opens one that shows the exact commands first (the engine plans, the
 *               window only shows), then runs them and shows what came back.
 *
 * Design rules (Arthur): a worktree row shows the branch name and the change count and nothing else; colour only
 * for trouble (conflicts, behind the base, a folder that is gone); no status pill with a dot; no stripes down the
 * left of a row.
 */

import { esc } from './markdown.js';

/* ---------- glyphs ---------- */

/** A branch: two nodes on a line and one off it. The main checkout. */
export const GLYPH_BRANCH = '<svg class="wt-g" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.6" r="1.6"/><circle cx="4.5" cy="12.4" r="1.6"/><circle cx="11.5" cy="5.6" r="1.6"/><path d="M4.5 5.2v5.6M11.5 7.2c0 2.4-2.2 3-5.4 3.6"/></svg>';
/** A worktree: a line from a node out to a folder of its own. Every checkout that is not the main one. */
export const GLYPH_WORKTREE = '<svg class="wt-g" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.6" r="1.6"/><path d="M4.5 5.2v7.4M4.5 9c0-2 1.2-2.8 3.2-2.8"/><rect x="8.2" y="4.4" width="5.6" height="5" rx="1.3"/></svg>';
const GLYPH_PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
const GLYPH_MORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.4" cy="8" r="1.1"/></svg>';
const GLYPH_CHEV = '<svg class="wt-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';

/* ---------- paths ---------- */

/** A path with forward slashes and no trailing one: comparable between the engine's paths and a session's folder. */
export const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const keyOf = (p) => { const n = normPath(p); return /^[A-Za-z]:/.test(n) ? n.toLowerCase() : n; };
/** `child` is `parent` or in it (Windows drive paths compare without case). */
export function isInside(child, parent) {
  const c = keyOf(child);
  const p = keyOf(parent);
  return Boolean(p) && Boolean(c) && (c === p || c.startsWith(`${p}/`));
}

/*
 * Path keys, kept per path (2026-10-15, window lag): the session list asks wtFor for every row it draws, and wtFor
 * compared the row's folder with every worktree of every repository, normalising both paths each time (two regular
 * expressions and a lower-casing per side). With 400 rows and 26 repositories that was a sixth of the main thread
 * while panes worked. The keys are the same strings keyOf makes; only the work is kept.
 */
const pathKeys = new Map();
const PATH_KEYS_MAX = 4000;
function pathKey(p) {
  const s = String(p ?? '');
  let k = pathKeys.get(s);
  if (k === undefined) {
    if (pathKeys.size >= PATH_KEYS_MAX) pathKeys.clear();
    k = keyOf(s);
    pathKeys.set(s, k);
  }
  return k;
}

/**
 * The worktree a folder is in: { repo, wt } or null. The deepest one wins, because the main checkout's folder
 * contains the worktrees Claude Code keeps under .claude/worktrees.
 */
export function wtFor(repos, cwd) {
  if (!cwd) return null;
  // isInside(cwd, wt.path), with the folder's key made once and each worktree's kept (pathKey).
  const c = pathKey(cwd);
  if (!c) return null;
  let best = null;
  for (const repo of repos || []) {
    for (const wt of repo.worktrees || []) {
      const p = pathKey(wt.path);
      if (!p || (c !== p && !c.startsWith(`${p}/`))) continue;
      // keyOf only changes letter case, so its length is normPath's.
      const len = p.length;
      if (!best || len > best.len) best = { repo, wt, len };
    }
  }
  return best ? { repo: best.repo, wt: best.wt } : null;
}

/** The part of `cwd` below `root` ("apaki/ui"), empty when it is the root itself or not below it. */
export function relPath(cwd, root) {
  if (!isInside(cwd, root) || keyOf(cwd) === keyOf(root)) return '';
  return normPath(cwd).slice(normPath(root).length + 1);
}

/** A worktree with its own checkout, in a repository that has more than one: what the Worktrees filter lists. */
export const hasLinked = (repo) => (repo?.worktrees?.length || 0) > 1;

/**
 * What the repositories look like without their numbers (2026-10-15): each one's name and root, and each worktree's
 * folder, branch (or head when detached), main and bare. Everything the session list's rows, the tab names and the
 * Worktrees count read from the repositories; two lists with the same key draw those the same. The numbers (lines
 * added and removed, files, ahead, behind, merged) are left out: they move after every turn.
 */
export function layoutKey(repos) {
  let k = '';
  for (const r of repos || []) {
    k += `\u0001${r.name}\u0002${r.root}\u0002${r.id}`;
    for (const w of r.worktrees || []) k += `\u0003${w.path}\u0002${w.branch || ''}\u0002${w.branch ? '' : w.head || ''}\u0002${w.main ? 1 : 0}${w.bare ? 1 : 0}`;
  }
  return k;
}

/* ---------- labels ---------- */

export const branchName = (wt) => wt.branch || (wt.head ? `${String(wt.head).slice(0, 7)} (detached)` : 'detached');

/** "+42 -7": lines added and removed, a side that is zero left out ("+12"); empty when there is nothing to show. */
export function plusMinus(added, removed) {
  return [added ? `+${added}` : '', removed ? `-${removed}` : ''].filter(Boolean).join(' ');
}

/** The change count of a worktree against its base; empty when nothing changed or the numbers were not read. */
export function changeText(wt) {
  if (!wt || wt.stats === false) return '';
  const t = plusMinus(wt.added, wt.removed);
  return t && wt.approx ? `${t}+` : t;
}

/** "fix-checkout +42 -7": the label in the pane header and the phone's nav row. */
export const branchLabel = (wt) => [branchName(wt), changeText(wt)].filter(Boolean).join(' ');

/**
 * The only thing that is coloured: a reason to look. Conflicts first, then a folder that is gone, then a branch
 * that has fallen behind its base (a main checkout is not "behind": it is the base).
 */
export function trouble(wt) {
  if (!wt || wt.stats === false) return '';
  if (wt.conflicts > 0) return wt.conflicts === 1 ? '1 conflict' : `${wt.conflicts} conflicts`;
  if (wt.missing) return 'folder gone';
  if (!wt.main && wt.behind > 0) return `behind ${wt.behind}`;
  return '';
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A hover title for a worktree: the branch, where it is, and the numbers in words. */
export function tooltip(repo, wt) {
  const lines = [branchName(wt), wt.path];
  if (wt.stats !== false && !wt.missing) {
    if (wt.base && !wt.main) lines.push(`From ${wt.base}: ${plural(wt.ahead || 0, 'commit')} ahead, ${wt.behind || 0} behind`);
    const c = changeText(wt);
    lines.push(c ? `${c} in ${plural(wt.files || 0, 'file')}${wt.changed ? `, ${wt.changed} not committed` : ''}` : 'No changes');
    if (wt.locked) lines.push(`Locked${wt.locked === 'locked' ? '' : `: ${wt.locked}`}`);
  }
  if (repo?.name) lines.push(`Repository ${repo.name}`);
  return lines.join('\n');
}

/** Why a worktree cannot be removed right now, in a few words (empty: it can). The engine checks again when it runs. */
export function removeBlocker(wt, { busy = false } = {}) {
  if (!wt || wt.main) return '';
  if (wt.locked) return 'locked';
  if (busy) return 'a conversation is open in it';
  if (wt.error && !wt.missing) return 'could not read it';
  if (wt.changed > 0) return plural(wt.changed, 'uncommitted file');
  if (wt.unpushed === null) return 'could not check its commits';
  if (wt.unpushed > 0) return plural(wt.unpushed, 'unpushed commit');
  return '';
}

/** Worktrees whose work is all in the base and that have nothing left in them: offered for removal in one prompt. */
export function mergedCandidates(repos) {
  const out = [];
  for (const repo of repos || []) {
    for (const wt of repo.worktrees || []) {
      if (!wt.main && wt.merged && !wt.locked && !wt.missing && !wt.changed && wt.unpushed === 0 && !wt.error) out.push({ repo, wt });
    }
  }
  return out;
}

/* ---------- the sidebar ---------- */

/** Most conversations listed under one worktree before "Show more". */
export const KIDS_SHOWN = 6;

/**
 * The Worktrees view as rows: for each repository that has linked worktrees a repo row, then its worktrees (the
 * main checkout first, then the most recently used), each followed by its conversations. Pure.
 *   row.k  'repo' | 'wt' | 'kid' | 'more'
 */
export function worktreeRows(repos, sessions, { folded = new Set(), more = new Set(), shown = KIDS_SHOWN } = {}) {
  const rows = [];
  for (const repo of repos || []) {
    if (!hasLinked(repo)) continue;
    const by = new Map();
    for (const s of sessions || []) {
      const f = wtFor([repo], s.cwd);
      if (!f) continue;
      const k = keyOf(f.wt.path);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(s);
    }
    for (const list of by.values()) list.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    const newest = (wt) => by.get(keyOf(wt.path))?.[0]?.lastModified || 0;
    const wts = [...repo.worktrees].filter((w) => !w.bare).sort((a, b) => (Number(b.main) - Number(a.main)) || (newest(b) - newest(a)) || branchName(a).localeCompare(branchName(b)));
    const isFolded = folded.has(repo.id);
    rows.push({ k: 'repo', repo, folded: isFolded, linked: repo.worktrees.length - 1 });
    if (isFolded) continue;
    for (const wt of wts) {
      const list = by.get(keyOf(wt.path)) || [];
      rows.push({ k: 'wt', repo, wt, n: list.length });
      const open = more.has(keyOf(wt.path));
      for (const s of open ? list : list.slice(0, shown)) rows.push({ k: 'kid', repo, wt, s });
      if (!open && list.length > shown) rows.push({ k: 'more', repo, wt, hidden: list.length - shown });
    }
  }
  return rows;
}

/** How many linked worktrees there are across the repositories: the Worktrees filter's count. */
export const linkedCount = (repos) => (repos || []).reduce((n, r) => n + (hasLinked(r) ? r.worktrees.length - 1 : 0), 0);

/* ---------- the pane menu ---------- */

/**
 * Items for menu() in the pane header and on a sidebar row. `cap` is the phone's access ('full' on the desktop);
 * below Full the git actions are listed but dimmed with the reason, so the phone shows everything the desktop does.
 * `web` hides what opens a window on the PC.
 */
export function menuItems({ repo, wt, cap = 'full', web = false, busy = false, shortPath = (p) => p } = {}) {
  const full = cap === 'full';
  const need = full ? false : 'This phone\'s access on the PC allows looking at changes, not changing them. Change it in the Phone sheet on the PC.';
  const dim = (cond, reason) => (need || (cond ? reason : false));
  const changes = changeText(wt);
  const nothing = !wt.changed;
  const base = wt.base || repo?.base || 'the base branch';
  const refuse = removeBlocker(wt, { busy });
  const items = [
    { heading: `${branchName(wt)}${wt.main ? '' : ` from ${wt.base || repo?.base || 'main'}`}`.slice(0, 60) },
    { value: 'diff', label: 'View changes', hint: changes ? `${changes} in ${plural(wt.files || 0, 'file')}` : 'no changes' },
    { value: 'new', label: 'New conversation here' },
    { divider: true },
    { value: 'commit', label: 'Commit…', hint: nothing ? 'nothing to commit' : plural(wt.changed, 'file'), disabled: dim(nothing, 'Nothing to commit') },
    { value: 'push', label: 'Push…', hint: wt.upstream ? (wt.aheadUp ? `${plural(wt.aheadUp, 'commit')} ahead` : 'up to date') : 'not published', disabled: dim(Boolean(wt.upstream) && !wt.aheadUp && !wt.behindUp, 'Everything is already pushed') },
    { value: 'pr', label: 'Open pull request…', hint: 'with gh', disabled: dim(wt.main || (wt.base && wt.ahead === 0), wt.main ? 'This is the main checkout' : 'No commits beyond the base yet') },
    { value: 'merge', label: `Merge into ${base}…`, hint: wt.merged ? 'already merged' : wt.ahead ? `${plural(wt.ahead, 'commit')}` : '', disabled: dim(wt.main || wt.merged || (wt.base && wt.ahead === 0), wt.main ? 'This is the main checkout' : wt.merged ? 'Already merged' : 'No commits beyond the base yet') },
    { divider: true },
    { value: 'newwt', label: 'New worktree…', hint: 'from this repository', disabled: need },
    ...(web ? [] : [{ value: 'folder', label: 'Open folder', hint: shortPath(wt.path) }, { value: 'terminal', label: 'Open terminal here' }]),
  ];
  if (!wt.main) {
    items.push({ divider: true });
    items.push({ value: 'remove', label: 'Remove worktree…', danger: true, hint: refuse, disabled: need || (refuse ? `Not now: ${refuse}. Nothing is removed while that is true.` : false) });
  }
  return items;
}

/* ---------- a branch name from the first message ---------- */

const FILLER = new Set(['a', 'an', 'the', 'to', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'with', 'my', 'our', 'please', 'can', 'you', 'could', 'would', 'should', 'i', 'we', 'it', 'is', 'be', 'that', 'this', 'so', 'just', 'then', 'now', 'let', 'lets', 'want', 'need', 'help', 'me', 'do', 'does', 'make', 'sure', 'also', 'how', 'what', 'why', 'there', 'are', 'was', 'were', 'will', 'from', 'into', 'about', 'some', 'any', 'all']);

/** A branch name from a message: its first few meaningful words ("Fix the checkout flow bug" is fix-checkout-flow-bug). */
export function suggestBranch(text, taken = []) {
  const words = String(text ?? '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1 && !FILLER.has(w));
  let name = '';
  for (const w of words.slice(0, 6)) {
    if ((name ? `${name}-${w}` : w).length > 36) break;
    name = name ? `${name}-${w}` : w;
  }
  name ||= 'work';
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let n = 2; n < 100; n++) if (!used.has(`${name}-${n}`)) return `${name}-${n}`;
  return `${name}-${Date.now().toString(36)}`;
}

/* ---------- patches ---------- */

const LINE_MAX = 2000;

/** A file's patch as hunks of lines: { binary, hunks: [{ header, lines: [{ t: 'ctx'|'add'|'del'|'note', n, text }] }] }. */
export function parsePatch(patch) {
  const out = { binary: false, hunks: [] };
  let cur = null;
  let a = 0;
  let b = 0;
  for (const l of String(patch ?? '').split('\n')) {
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      a = m ? Number(m[1]) : 0;
      b = m ? Number(m[2]) : 0;
      cur = { header: l, lines: [] };
      out.hunks.push(cur);
      continue;
    }
    if (!cur) { if (/^Binary files |^GIT binary patch/.test(l)) out.binary = true; continue; }
    if (l.startsWith('+')) cur.lines.push({ t: 'add', n: b++, text: l.slice(1, LINE_MAX + 1) });
    else if (l.startsWith('-')) cur.lines.push({ t: 'del', n: a++, text: l.slice(1, LINE_MAX + 1) });
    else if (l.startsWith('\\')) cur.lines.push({ t: 'note', n: '', text: l.slice(2) });
    else if (l !== '') { cur.lines.push({ t: 'ctx', n: b, text: l.slice(1, LINE_MAX + 1) }); a += 1; b += 1; }
  }
  return out;
}

/** A file's patch as HTML for a <pre>: one block per line, a number from the file in the margin (CSS reads data-n). */
export function patchHtml(patch) {
  const p = typeof patch === 'string' ? parsePatch(patch) : patch;
  if (p.binary) return '<div class="df-note">A binary file; its bytes are not shown.</div>';
  if (!p.hunks.length) return '<div class="df-note">No lines changed (permissions or a rename).</div>';
  const sign = { add: '+', del: '-', ctx: ' ', note: '' };
  return `<pre class="diff df-pre">${p.hunks.map((h) => `<span class="df-h">${esc(h.header)}</span>${h.lines.map((l) => `<span class="${l.t}" data-n="${l.n}">${esc(`${sign[l.t]}${l.text}`) || ' '}</span>`).join('')}`).join('')}</pre>`;
}

/* ---------- what an action sheet shows ---------- */

/** The commands, warnings and blockers of a plan as the sheet's middle part. Pure markup. */
export function planHtml(plan) {
  if (!plan) return '';
  const cmds = plan.commands?.length ? `<div class="wt-k">What it will run</div><pre class="wt-cmds">${plan.commands.map((c) => esc(c)).join('\n')}</pre>` : '';
  const warns = (plan.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
  const blocks = (plan.blockers || []).map((b) => `<li>${esc(b)}</li>`).join('');
  return `${plan.summary ? `<p class="wt-sum">${esc(plan.summary)}</p>` : ''}${cmds}${warns ? `<ul class="wt-warn">${warns}</ul>` : ''}${blocks ? `<ul class="wt-block">${blocks}</ul>` : ''}`;
}

/** What each action's sheet says in its title and on its button. */
export const ACTION_TEXT = Object.freeze({
  create: { title: 'New worktree', go: 'Create worktree', busy: 'Creating…' },
  remove: { title: 'Remove worktree', go: 'Remove worktree', busy: 'Removing…' },
  commit: { title: 'Commit', go: 'Commit', busy: 'Committing…' },
  push: { title: 'Push', go: 'Push', busy: 'Pushing…' },
  pr: { title: 'Open pull request', go: 'Open pull request', busy: 'Opening…' },
  merge: { title: 'Merge', go: 'Merge', busy: 'Merging…' },
});

const STATUS_WORD = { M: 'changed', A: 'new', D: 'deleted', R: 'renamed', '?': 'new', U: 'conflict' };
export const statusWord = (s) => STATUS_WORD[s] || s;

/** The form for an action, from its plan and the values so far. Returns markup; readForm turns the fields back into arguments. */
export function formHtml(kind, plan, v = {}) {
  const repo = plan?.repo || {};
  const data = plan?.data || {};
  const opts = (list, cur) => list.map((b) => `<option value="${esc(b)}"${b === cur ? ' selected' : ''}>${esc(b)}</option>`).join('');
  if (kind === 'create') {
    const branches = repo.branches || [];
    const base = v.base || data.base || repo.base || branches[0] || '';
    return `<label class="wt-f"><span>Branch name</span><input type="text" data-f="branch" value="${esc(v.branch ?? '')}" placeholder="fix-checkout" spellcheck="false" autocomplete="off"></label>
      ${data.branchExists ? `<button type="button" class="wt-link" data-k="existing">Use the existing branch ${esc(v.branch || '')} instead</button>` : ''}
      <label class="wt-f"><span>Start from</span><select data-f="base"${v.useExisting ? ' disabled' : ''}>${opts(branches.includes(base) ? branches : [base, ...branches].filter(Boolean), base)}</select></label>`;
  }
  if (kind === 'remove') {
    const merged = Boolean(data.merged);
    return `<label class="wt-c"><input type="checkbox" data-f="deleteBranch"${v.deleteBranch ?? merged ? ' checked' : ''}><span>Also delete the branch ${esc(data.branch || '')}<small>${merged ? 'It is merged, so nothing is lost.' : 'Only a merged branch is deleted; this one stays.'}</small></span></label>`;
  }
  if (kind === 'commit') {
    const files = data.files || [];
    const chosen = v.paths ? new Set(v.paths) : new Set(files.map((f) => f.path));
    const rows = files.map((f) => `<label class="wt-file"><input type="checkbox" data-f="file" value="${esc(f.path)}"${chosen.has(f.path) ? ' checked' : ''}><span class="wt-fs">${esc(statusWord(f.status))}</span><span class="wt-fp">${esc(f.path)}</span></label>`).join('');
    return `<label class="wt-f"><span>Message</span><textarea data-f="message" rows="3" placeholder="What changed and why" spellcheck="true">${esc(v.message ?? '')}</textarea></label>
      <div class="wt-k">${files.length ? `${plural(chosen.size, 'file')} of ${files.length}` : 'Files'}</div><div class="wt-files">${rows || '<div class="wt-none">Nothing to commit.</div>'}</div>${data.total > files.length ? `<div class="wt-none">Showing the first ${files.length} of ${data.total}.</div>` : ''}`;
  }
  if (kind === 'pr') {
    const sug = data.suggest || {};
    const branches = repo.branches || [];
    const base = v.base || data.base || repo.base || 'main';
    return `<label class="wt-f"><span>Title</span><input type="text" data-f="title" value="${esc(v.title ?? sug.title ?? '')}" spellcheck="true" autocomplete="off"></label>
      <label class="wt-f"><span>Description</span><textarea data-f="body" rows="4" spellcheck="true">${esc(v.body ?? sug.body ?? '')}</textarea></label>
      <label class="wt-f"><span>Into</span><select data-f="base">${opts(branches.includes(base) ? branches : [base, ...branches].filter(Boolean), base)}</select></label>
      <label class="wt-c"><input type="checkbox" data-f="draft"${v.draft ? ' checked' : ''}><span>Open it as a draft</span></label>`;
  }
  if (kind === 'merge') {
    const into = v.into || data.into || repo.base || 'main';
    const heads = (plan?.checkedOut || []).filter((b) => b !== data.branch);
    return `<label class="wt-f"><span>Merge ${esc(data.branch || 'this branch')} into</span><select data-f="into">${opts(heads.includes(into) ? heads : [into, ...heads], into)}</select></label>`;
  }
  return '';
}

/** The arguments the fields of a sheet hold (the form's DOM is the only place they live). */
export function readForm(kind, root) {
  const get = (f) => root.querySelector(`[data-f="${f}"]`);
  const out = {};
  if (kind === 'create') { out.branch = get('branch')?.value.trim() || ''; out.base = get('base')?.value || ''; }
  if (kind === 'remove') out.deleteBranch = Boolean(get('deleteBranch')?.checked);
  if (kind === 'commit') {
    out.message = get('message')?.value || '';
    const boxes = [...root.querySelectorAll('[data-f="file"]')];
    if (boxes.length && boxes.some((b) => !b.checked)) out.paths = boxes.filter((b) => b.checked).map((b) => b.value);
  }
  if (kind === 'pr') { out.title = get('title')?.value.trim() || ''; out.body = get('body')?.value || ''; out.base = get('base')?.value || ''; out.draft = Boolean(get('draft')?.checked); }
  if (kind === 'merge') out.into = get('into')?.value || '';
  return out;
}

/* ---------- the controller ---------- */

let askSeq = 0;

/**
 * @param {object} app
 * @param {(op: string, args?: object) => any} app.send             engine command (app.js send)
 * @param {(html: string, wire: Function, key?: string, onClose?: Function) => void} app.sheet
 * @param {(anchor, items, opts) => void} app.menu
 * @param {boolean} app.web                                         the phone page
 * @param {() => string} app.cap                                    the phone's access: full, noshell or chat (full on the desktop)
 * @param {() => object[]} app.sessions                             the session list
 * @param {() => string[]} app.openCwds                             folders conversations are open in here
 * @param {(spec) => void} app.openDiff                             opens a diff viewer
 * @param {(cwd: string) => void} app.startIn                       a new conversation in that folder
 * @param {(url: string) => void} app.openUrl
 * @param {() => void} app.changed                                  the repositories changed: redraw what shows them
 * @param {(text: string, tone?: string) => void} app.note          a line in the focused pane
 */
export function initWorktrees(app) {
  const W = { repos: [], seen: false, folded: new Set(), more: new Set() };
  const waiting = new Map();

  /** An op and its answer: resolves with the engine's event, or { ok: false, error } for a refusal or no answer. */
  function ask(op, args = {}, { ms = 120000 } = {}) {
    const reqId = `w${Date.now().toString(36)}${(++askSeq).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(reqId); resolve({ ok: false, error: 'The PC did not answer in time.' }); }, ms);
      waiting.set(reqId, { resolve, timer });
      Promise.resolve(app.send(op, { ...args, reqId })).then((r) => {
        if (r === false && waiting.has(reqId)) { clearTimeout(timer); waiting.delete(reqId); resolve({ ok: false, error: 'Not connected to the PC right now.' }); }
      });
    });
  }

  /**
   * Engine events about worktrees. Returns true when the event is consumed here: the state, or the answer to an op
   * this controller asked (an `error` carrying that request's id too: a phone's refusal comes back that way).
   */
  function handle(e) {
    if (e?.reqId && waiting.has(e.reqId)) {
      const w = waiting.get(e.reqId);
      if (e.ev === 'error') { clearTimeout(w.timer); waiting.delete(e.reqId); w.resolve({ ok: false, error: e.message || 'Refused.', refused: Boolean(e.refused) }); return true; }
      if (/^worktree/.test(e.ev)) { clearTimeout(w.timer); waiting.delete(e.reqId); w.resolve(e); if (e.ev !== 'worktrees') return true; }
    }
    if (e?.ev === 'worktrees') {
      const before = layoutKey(W.repos);
      W.repos = Array.isArray(e.repos) ? e.repos : [];
      W.seen = true;
      found.clear();
      // shape: false when only the numbers moved (lines added, files changed), which is what most refreshes are; the
      // session list and the tab bar show no numbers outside the Worktrees view, so app.js leaves them alone then.
      app.changed({ shape: layoutKey(W.repos) !== before });
      return true;
    }
    return /^worktree(Plan|Result|Diff)$/.test(e?.ev || '');
  }

  const repos = () => W.repos;
  // The answer per folder until the next worktrees event (2026-10-15, window lag): the list asks for every row it draws,
  // the tab bar and the panes for theirs, and the repositories only change with that event.
  const found = new Map();
  const forCwd = (cwd) => {
    if (!cwd) return null;
    if (found.has(cwd)) return found.get(cwd);
    const f = wtFor(W.repos, cwd);
    found.set(cwd, f);
    return f;
  };

  /** Which conversations (panes here) are open inside a worktree. */
  const busyIn = (wt) => (app.openCwds() || []).some((c) => isInside(c, wt.path));

  /* ---------- one sheet for every git action ---------- */

  /**
   * The sheet for an action. It asks the engine for the plan, draws the fields, and asks again when a field changes,
   * so the commands on screen are always the ones that would run. Run sends worktreeRun, which plans once more.
   *   o.kind, o.path (the worktree) or o.repo (a folder in the repository, for create), o.init (field values)
   *   o.note (a line under the title), o.go (button text), o.onDone(result) when it succeeded, o.title
   * Resolves with the engine's result (ok or not), or null when the sheet was cancelled.
   */
  function actionSheet(o) {
    const t = ACTION_TEXT[o.kind];
    const where = o.kind === 'create' ? { repo: o.repo } : { path: o.path };
    return new Promise((resolve) => {
      let finished = false;
      const done = (v) => { if (!finished) { finished = true; resolve(v); } };
      app.sheet(`<div class="from">${esc(o.from || '')}</div><h2>${esc(o.title || t.title)}</h2>${o.note ? `<p class="wt-note">${esc(o.note)}</p>` : ''}
        <div class="wt-form"></div><div class="wt-plan"><div class="wt-wait">Looking at the repository…</div></div>
        <div class="row"><button data-k="x">Cancel</button><button class="primary" data-k="go" disabled>${esc(o.go || t.go)}</button></div>`, (root, close) => {
        const form = root.querySelector('.wt-form');
        const planBox = root.querySelector('.wt-plan');
        const go = root.querySelector('[data-k=go]');
        const cancel = root.querySelector('[data-k=x]');
        let seq = 0;
        let values = { ...(o.init || {}) };
        let useExisting = false;
        let plan = null;
        let busy = false;
        let timer = null;
        cancel.onclick = () => { if (!busy) { close(); done(null); } };

        const args = () => ({ ...values, ...readForm(o.kind, form), ...(o.kind === 'create' ? { useExisting } : {}) });

        async function replan() {
          const mine = ++seq;
          const a = args();
          const r = await ask('worktreePlan', { kind: o.kind, ...where, ...a });
          if (mine !== seq || finished) return;
          if (r.ok === false && !r.commands) { planBox.innerHTML = `<ul class="wt-block"><li>${esc(r.error || 'Could not plan it.')}</li></ul>`; go.disabled = true; return; }
          plan = { ...r, checkedOut: (r.repo ? repoCheckedOut(r.repo.root) : []) };
          planBox.innerHTML = planHtml(plan);
          const needs = (o.kind === 'commit' && !String(a.message || '').trim()) || (o.kind === 'pr' && !String(a.title || '').trim()) || (o.kind === 'create' && !String(a.branch || '').trim());
          go.disabled = busy || (plan.blockers || []).length > 0 || needs;
          go.title = (plan.blockers || [])[0] || (needs ? 'Fill in the field above' : '');
        }
        const replanSoon = () => { clearTimeout(timer); timer = setTimeout(replan, 220); };

        function drawForm(first) {
          values = { ...values, ...(first ? {} : readForm(o.kind, form)) };
          form.innerHTML = formHtml(o.kind, plan, { ...values, useExisting });
          form.querySelectorAll('input, textarea, select').forEach((el) => { el.addEventListener('input', replanSoon); el.addEventListener('change', replanSoon); });
          form.querySelector('[data-k=existing]')?.addEventListener('click', () => { useExisting = true; values = { ...values, ...readForm('create', form) }; drawForm(false); replan(); });
        }

        (async () => {
          const r = await ask('worktreePlan', { kind: o.kind, ...where, ...(o.init || {}) });
          if (finished) return;
          if (r.ok === false && !r.commands) { planBox.innerHTML = `<ul class="wt-block"><li>${esc(r.error || 'Could not plan it.')}</li></ul>`; return; }
          plan = { ...r, checkedOut: r.repo ? repoCheckedOut(r.repo.root) : [] };
          drawForm(true);
          planBox.innerHTML = planHtml(plan);
          const f = form.querySelector('input[type=text], textarea');
          if (f) { f.focus({ preventScroll: true }); f.select?.(); }
          await replan();
        })();

        go.onclick = async () => {
          if (busy || go.disabled) return;
          busy = true;
          go.disabled = true;
          cancel.disabled = true;
          go.textContent = t.busy;
          const r = await ask('worktreeRun', { kind: o.kind, ...where, ...args() }, { ms: 300000 });
          busy = false;
          // A sheet that was only a step on the way (the first message of a conversation) closes itself when it worked.
          if (o.auto && r.ok !== false && !r.error) { done(r); close(); o.onDone?.(r); return; }
          root.querySelector('.wt-form').innerHTML = '';
          resultView(root, r, o, close, done);
        };
      }, null, () => done(null));
    });
  }

  /** The branches that are checked out in some worktree of a repository (what a merge can go into). */
  function repoCheckedOut(root) {
    return (wtFor(W.repos, root)?.repo.worktrees || []).map((w) => w.branch).filter(Boolean);
  }

  /** After a run: what happened, in words, with the commands and their output one click away. */
  function resultView(root, r, o, close, done) {
    const ok = r.ok !== false && !r.error;
    const log = (r.log || []).map((l) => `$ ${l.cmd}${l.out ? `\n${l.out}` : ''}${l.note ? `\n(${l.note})` : ''}`).join('\n\n');
    const lines = ok ? [r.message || 'Done.'] : (r.blockers?.length ? r.blockers : [r.error || 'It did not work.']);
    root.querySelector('.wt-plan').innerHTML = `<ul class="${ok ? 'wt-ok' : 'wt-block'}">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${r.url ? `<p class="wt-sum"><a class="wt-url" href="#" data-url="${esc(r.url)}">${esc(r.url)}</a></p>` : ''}${log ? `<details class="wt-log"><summary>Commands and what they printed</summary><pre>${esc(log)}</pre></details>` : ''}`;
    const extra = ok && o.then ? `<button data-k="then">${esc(o.then.label)}</button>` : '';
    root.querySelector('.row').innerHTML = `<button data-k="x" class="${ok && r.url ? '' : 'primary'}">${ok ? 'Done' : 'Close'}</button>${extra}${ok && r.url ? '<button class="primary" data-k="open">Open the pull request</button>' : ''}`;
    // done() before close(): closing the sheet reports a cancel to anyone still waiting.
    root.querySelector('[data-k=x]').onclick = () => { done(r); close(); if (ok) o.onDone?.(r); };
    root.querySelector('[data-k=then]')?.addEventListener('click', () => { done(r); close(); o.then.run(r); });
    const open = () => app.openUrl(r.url);
    root.querySelector('[data-k=open]')?.addEventListener('click', () => { open(); done(r); close(); o.onDone?.(r); });
    root.querySelector('.wt-url')?.addEventListener('click', (e) => { e.preventDefault(); open(); });
    if (!ok) root.querySelector('[data-k=x]').focus({ preventScroll: true });
  }

  /* ---------- menus ---------- */

  function runItem(v, repo, wt) {
    const from = `${branchName(wt)}${repo?.name ? ` · ${repo.name}` : ''}`;
    if (v === 'diff') { app.openDiff({ path: wt.path, branch: branchName(wt), repo: repo?.name || '', base: wt.base || repo?.base || '' }); return; }
    if (v === 'new') { app.startIn(wt.path); return; }
    if (v === 'folder') { app.send('revealFolder', { cwd: wt.path }); return; }
    if (v === 'terminal') { app.send('worktreeTerminal', { path: wt.path }); return; }
    if (v === 'newwt') { newWorktree({ repo: repo?.root || wt.path, from: repo?.name || '', then: true }); return; }
    if (v === 'remove') {
      actionSheet({ kind: 'remove', path: wt.path, from, note: `${wt.path}`, init: { deleteBranch: Boolean(wt.merged) } });
      return;
    }
    if (v === 'commit') actionSheet({ kind: 'commit', path: wt.path, from, note: 'Everything that changed in this worktree, unless you untick a file.' });
    else if (v === 'push') actionSheet({ kind: 'push', path: wt.path, from });
    else if (v === 'pr') actionSheet({ kind: 'pr', path: wt.path, from });
    else if (v === 'merge') actionSheet({ kind: 'merge', path: wt.path, from, init: { into: wt.base || repo?.base || '' } });
  }

  /** The menu for a worktree, at an element or a point. */
  function openMenu(anchor, repo, wt) {
    app.menu(anchor, menuItems({ repo, wt, cap: app.cap(), web: app.web, busy: busyIn(wt), shortPath: app.shortPath || ((p) => p) }), {
      above: false,
      width: 300,
      onPick: (v) => runItem(v, repo, wt),
    });
  }

  /** A pane's menu (its branch label was clicked): by the pane's folder. */
  function paneMenu(pane, anchor) {
    const f = forCwd(pane.cwd);
    if (f) openMenu(anchor, f.repo, f.wt);
  }

  /* ---------- a new worktree ---------- */

  /**
   * The create sheet. With o.branch given (a conversation's first message named it) the field starts there. Resolves
   * with { path, branch } when the worktree exists, null when cancelled. o.then: offer to start a conversation in it.
   */
  async function newWorktree(o) {
    const r = await actionSheet({
      kind: 'create', repo: o.repo, from: o.from || '', note: o.note || 'Claude works on its own branch in its own folder, so it never touches your other checkouts.',
      init: { branch: o.branch || '', base: o.base || '' }, go: o.go, auto: o.auto,
      then: o.then ? { label: 'New conversation in it', run: (res) => app.startIn(res.path) } : null,
    });
    return r && r.ok !== false && r.path ? { path: r.path, branch: r.branch } : null;
  }

  /**
   * The first message of a conversation that starts in a new worktree: the branch is named from it, the command is
   * shown, and on Create the pane moves into the new folder. Resolves true when the pane may send.
   */
  async function makeFor(pane, text) {
    const p = pane.pendingWorktree;
    if (!p) return true;
    const known = W.repos.find((r) => r.root && normPath(r.root) === normPath(p.repo));
    const taken = [...(known?.branches || [])];
    const made = await newWorktree({ repo: p.repo, from: p.name || known?.name || '', branch: suggestBranch(text, taken), base: p.base || '', note: 'The branch name comes from your message. Change it if you like; nothing is created until you press the button.', go: 'Create it and send', auto: true });
    if (!made) return false;
    pane.pendingWorktree = null;
    pane.setStartFolder(made.path);
    return true;
  }

  /* ---------- cleaning up merged worktrees ---------- */

  function cleanupSheet() {
    const list = mergedCandidates(W.repos);
    if (!list.length) return;
    const rows = list.map((c, i) => `<label class="wt-file"><input type="checkbox" data-i="${i}" checked><span class="wt-fs">${esc(c.repo.name)}</span><span class="wt-fp">${esc(branchName(c.wt))}</span></label>`).join('');
    app.sheet(`<h2>Remove merged worktrees</h2><p class="wt-note">${esc(plural(list.length, 'worktree'))} ${list.length === 1 ? 'is' : 'are'} merged into the base branch with nothing left in ${list.length === 1 ? 'it' : 'them'}. Each removal is checked again before it runs, and the merged branch goes with it.</p>
      <div class="wt-files">${rows}</div><div class="wt-plan"></div><div class="row"><button data-k="x">Close</button><button class="primary" data-k="go">Remove them</button></div>`, (root, close) => {
      const box = root.querySelector('.wt-plan');
      const go = root.querySelector('[data-k=go]');
      root.querySelector('[data-k=x]').onclick = close;
      go.onclick = async () => {
        const picked = [...root.querySelectorAll('[data-i]')].filter((b) => b.checked).map((b) => list[Number(b.dataset.i)]);
        if (!picked.length) return;
        go.disabled = true;
        const out = [];
        for (const c of picked) {
          box.innerHTML = `<div class="wt-wait">${esc(`Removing ${branchName(c.wt)}…`)}</div>`;
          const r = await ask('worktreeRun', { kind: 'remove', path: c.wt.path, deleteBranch: true }, { ms: 120000 });
          out.push(r.ok !== false && !r.error ? `Removed ${branchName(c.wt)}.` : `${branchName(c.wt)} stays: ${r.blockers?.[0] || r.error || 'it could not be removed'}`);
        }
        box.innerHTML = `<ul class="wt-ok">${out.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
        root.querySelectorAll('[data-i]').forEach((b) => { b.disabled = true; });
        go.hidden = true;
        root.querySelector('[data-k=x]').textContent = 'Done';
        ask('worktrees', { refresh: true });
      };
    });
  }

  /* ---------- the sidebar's Worktrees view ---------- */

  const foldedList = () => [...W.folded];

  /** A button inside a row: it acts, and the row's own click does not. */
  const actBtn = (cls, title, svg, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wt-act ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b, e); });
    return b;
  };

  /**
   * The elements for the Worktrees view's rows (app.js renderRail puts the session rows in between).
   * `focusedCwd` marks the worktree of the focused pane.
   */
  function rowEl(row, { focusedCwd = '' } = {}) {
    const li = document.createElement('li');
    if (row.k === 'repo') {
      li.className = `wt-repo${row.folded ? ' folded' : ''}`;
      li.innerHTML = `${GLYPH_CHEV}<span class="wt-rn">${esc(row.repo.name)}</span><span class="wt-rc">${esc(plural(row.linked, 'worktree'))}</span>`;
      li.title = `${row.repo.root || row.repo.name}\nClick to ${row.folded ? 'open' : 'fold'}`;
      li.onclick = () => { if (W.folded.has(row.repo.id)) W.folded.delete(row.repo.id); else W.folded.add(row.repo.id); app.changed({ save: true }); };
      return li;
    }
    if (row.k === 'more') {
      li.className = 'wt-showmore';
      li.innerHTML = `<button type="button" class="link-btn">Show ${row.hidden} more</button>`;
      li.querySelector('button').onclick = () => { W.more.add(keyOf(row.wt.path)); app.changed(); };
      return li;
    }
    const { repo, wt } = row;
    const tr = trouble(wt);
    const counts = changeText(wt);
    // is-main, not main: .main is the window's own layout class (the conversation area), and would take this row over.
    li.className = `wt-row${wt.main ? ' is-main' : ''}${focusedCwd && wtFor([repo], focusedCwd)?.wt === wt ? ' on' : ''}${tr ? ' trouble' : ''}`;
    li.dataset.path = wt.path;
    li.title = `${tooltip(repo, wt)}\nClick for a new conversation here`;
    li.innerHTML = `${wt.main ? GLYPH_BRANCH : GLYPH_WORKTREE}<span class="wt-bn">${esc(branchName(wt))}</span>${tr ? `<span class="wt-tr">${esc(tr)}</span>` : ''}${counts ? `<span class="wt-nn">${esc(counts)}</span>` : ''}`;
    const acts = document.createElement('span');
    acts.className = 'wt-acts';
    acts.append(actBtn('wt-new', 'New conversation here', GLYPH_PLUS, () => app.startIn(wt.path)), actBtn('wt-menu', 'Changes, commit, push, pull request, merge, remove', GLYPH_MORE, (b) => openMenu(b, repo, wt)));
    li.append(acts);
    li.onclick = () => app.startIn(wt.path);
    li.oncontextmenu = (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, repo, wt); };
    return li;
  }

  /** The row above the list when merged worktrees are waiting to be cleaned up. */
  function cleanRowEl() {
    const n = mergedCandidates(W.repos).length;
    if (!n) return null;
    const li = document.createElement('li');
    li.className = 'wt-clean';
    li.innerHTML = `<span>${esc(plural(n, 'merged worktree'))} can go</span><button type="button" class="link-btn">Review</button>`;
    // The whole row opens it; the button inside is only its keyboard stop (its click bubbles up to the row).
    li.onclick = cleanupSheet;
    return li;
  }

  /** The row that ends the Worktrees view: start another one (none while no repository is known). */
  function newRowEl() {
    if (!W.repos.length) return null;
    const li = document.createElement('li');
    li.className = 'wt-newrow';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = 'New worktree…';
    b.onclick = () => startFromFocus(b);
    li.append(b);
    return li;
  }

  /**
   * The repository of the focused pane; with none, the only repository there is, or a menu of them at `anchor`.
   * Then the create sheet.
   */
  function startFromFocus(anchor = null) {
    const here = forCwd(app.focusedCwd?.() || '');
    const go = (repo) => newWorktree({ repo: repo.root || repo.worktrees[0].path, from: repo.name, then: true });
    if (here) { go(here.repo); return; }
    if (!W.repos.length) { app.note('No git repository is known yet. Start a conversation in a repository folder first.', 'warn'); return; }
    if (W.repos.length === 1 || !anchor) { go(W.repos[0]); return; }
    app.menu(anchor, [{ heading: 'Which repository?' }, ...W.repos.map((r, i) => ({ value: i, label: r.name, hint: app.shortPath ? app.shortPath(r.root || '') : r.root || '' }))], { above: false, width: 300, onPick: (i) => go(W.repos[i]) });
  }

  /** A tab's tooltip line when every conversation in it shares one worktree. */
  function tabNote(cwds) {
    const found = cwds.map((c) => forCwd(c));
    if (!found.length || found.some((f) => !f)) return '';
    const first = found[0];
    if (found.some((f) => f.wt.path !== first.wt.path)) return '';
    return `${branchName(first.wt)} · ${first.repo.name}${first.wt.main ? '' : ' (worktree)'}`;
  }

  return {
    repos, forCwd, handle, ask, actionSheet, paneMenu, openMenu, newWorktree, makeFor, cleanupSheet, rowEl, cleanRowEl, newRowEl, startFromFocus, tabNote,
    foldedList, setFolded: (list) => { W.folded = new Set(Array.isArray(list) ? list : []); },
    hasData: () => W.seen,
    count: () => linkedCount(W.repos),
    rows: (sessions) => worktreeRows(W.repos, sessions, { folded: W.folded, more: W.more }),
    inLinked: (cwd) => { const f = forCwd(cwd); return Boolean(f && hasLinked(f.repo)); },
  };
}
