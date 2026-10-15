/**
 * worktrees.js: git worktrees in Apaki's engine (2026-10-12; build order steps 1 and 4 of
 * apaki/remote/WORKTREES.md). Arthur, 2026-10-11: "The best approach to AI development is using git worktrees
 * to tackle multiple features simultaneously".
 *
 * What it does
 *   - finds the repository a folder belongs to without starting git (findRepo reads .git, gitdir and commondir);
 *   - lists a repository's worktrees (`git worktree list`, in its porcelain form) and, for each one, the numbers the
 *     sidebar and the pane header show: lines added and removed against its base, changed files, commits ahead
 *     and behind, commits that exist nowhere else (unpushed), and whether the branch is merged;
 *   - makes the diff the viewer shows, per file;
 *   - plans and runs the git and gh actions: create, remove, commit, push, pull request, merge.
 *
 * Rules every action follows (WORKTREES.md "Safety")
 *   - It is the user's own git and gh, run without a shell (execFile with an argument list), with prompts off.
 *   - plan() says what it will do first: the exact commands (the display text is made from the same argument
 *     lists that run), warnings, and blockers. execute() runs a plan only when it has no blockers; the engine
 *     plans again at run time, so a client never decides what is safe.
 *   - Nothing discards work: remove refuses a dirty, locked, unpushed or in-use worktree and never passes the
 *     force flag; branches are deleted only with the safe delete of `git branch` (git itself refuses an unmerged
 *     one); a push never forces; a merge that would conflict stops before it touches anything (git merge-tree),
 *     and an older git that cannot predict it has the merge undone with merge abort. No git clean, no hard reset,
 *     anywhere.
 *
 * Cost: a repository with no linked worktree is "light": its record comes from files, with no git process. A
 * process runs for repositories that have linked worktrees, and for folders the caller names (open panes).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latchDir } from './host.js';
import { terminalCommand as platformTerminalCommand } from '../../src/platform.js';

/* ---------- running git and gh ---------- */

/** Prompts off, no pager, no editor, and no index writes from read-only commands (GIT_OPTIONAL_LOCKS). */
export const GIT_ENV = Object.freeze({ GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });

/** How many processes this module started (a repository with no linked worktree must cost none; tests read it). */
export const counters = { spawns: 0 };

/**
 * Runs a program with an argument list (no shell). Never rejects: { code, stdout, stderr, missing, timedOut }.
 * low: below-normal CPU priority (2026-10-15), for the background reads, so a busy PC serves the window, Claude
 * Code and its hooks first.
 */
export function run(bin, args, { cwd, timeout = 30000, env, maxBuffer = 32 * 1024 * 1024, low = false } = {}) {
  counters.spawns += 1;
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { cwd, timeout, maxBuffer, windowsHide: true, env: { ...process.env, ...GIT_ENV, ...env } }, (err, stdout, stderr) => {
        resolve({
          code: err ? (Number.isInteger(err.code) ? err.code : -1) : 0,
          stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          missing: err?.code === 'ENOENT', timedOut: Boolean(err?.killed && err?.signal), overflow: err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      });
      if (low && child?.pid) {
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* it may have exited already */ }
      }
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e), missing: false, timedOut: false, overflow: false });
    }
  });
}

/**
 * At most this many of this module's git processes run at once (2026-10-15). A refresh read every repository with
 * linked worktrees, 4 repositories and 2 worktrees each at a time with about 6 commands per worktree: bursts of 50 to
 * 80 git processes (each with a console host, each scanned by Defender) every 30 s and after every turn. On a busy PC
 * that pushed Claude Code's hooks past their 10 s limit ("PreToolUse:Bash hook was cancelled"). The same commands
 * still run, in the same order per worktree; they queue instead of piling up.
 */
export const GIT_AT_ONCE = 4;
let gitRunning = 0;
const gitWaiting = [];
/** The most git processes this module had running at once (tests read it). */
export const gitPeak = { max: 0 };
async function gitSlot() {
  if (gitRunning < GIT_AT_ONCE) { gitRunning += 1; gitPeak.max = Math.max(gitPeak.max, gitRunning); return; }
  await new Promise((resolve) => gitWaiting.push(resolve));
}
function gitDone() {
  const next = gitWaiting.shift();
  if (next) next(); else gitRunning -= 1;
}

/** git in `cwd`; file names come back as they are (core.quotepath off). Bounded (GIT_AT_ONCE) and at low priority. */
export const git = async (cwd, args, opts = {}) => {
  await gitSlot();
  try {
    return await run('git', ['-c', 'core.quotepath=false', ...args], { cwd, low: true, ...opts });
  } finally {
    gitDone();
  }
};

/** The first useful line of a failed command, for a message. */
export function whyFailed(r, what = 'git') {
  if (r.missing) return what === 'gh' ? 'The GitHub CLI (gh) is not installed.' : 'git is not installed or not on the PATH.';
  if (r.timedOut) return `${what} took too long and was stopped.`;
  const line = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line || `${what} failed (exit ${r.code}).`;
}

const one = (s) => String(s ?? '').trim();
const lines = (s) => String(s ?? '').split(/\r?\n/).filter(Boolean);

/** A command as it is shown: arguments with spaces in quotes, a long one (a commit message) shortened. */
export function fmtCommand(bin, args, { max = 160 } = {}) {
  const q = (a) => {
    let s = String(a);
    if (s.length > max) s = `${s.slice(0, max).replace(/\s+/g, ' ')}...`;
    s = s.replace(/\r?\n/g, ' ');
    return /^[\w@%+=:,./\\~^{}-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
  };
  return [bin, ...args.map(q)].join(' ');
}

/* ---------- paths ---------- */

const WIN = process.platform === 'win32';

/** A path as this machine writes it, without a trailing separator. */
export function normPath(p) {
  let n = path.normalize(String(p ?? ''));
  if (n.length > 1) n = n.replace(/[\\/]+$/, '');
  return n;
}
/** Paths compare equal here when they name the same place (Windows ignores case). */
export const pathKey = (p) => (WIN ? normPath(p).toLowerCase() : normPath(p));
export const samePath = (a, b) => pathKey(a) === pathKey(b);
/** `child` is `parent` or in it. */
export function isInside(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (!p) return false;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/* ---------- finding a repository without git ---------- */

/**
 * The repository a folder is in, read from the files: { top, gitDir, commonDir, linked }. `top` is the folder that
 * holds .git (the worktree's root); `commonDir` is the repository's own .git folder, the same for the main
 * checkout and every linked worktree; `linked` is true for a worktree added with `git worktree add`. null when the
 * folder is not in a repository (or does not exist).
 */
export function findRepo(dir) {
  if (!dir || typeof dir !== 'string') return null;
  let cur = path.resolve(dir);
  for (let i = 0; i < 80; i++) {
    const dot = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dot); } catch { st = null; }
    if (st?.isDirectory()) return { top: cur, gitDir: dot, commonDir: dot, linked: false };
    if (st?.isFile()) {
      let text = '';
      try { text = fs.readFileSync(dot, 'utf8'); } catch { return null; }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return null;
      const gitDir = path.resolve(cur, m[1]);
      let commonDir = gitDir;
      try {
        const c = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
        if (c) commonDir = path.resolve(gitDir, c);
      } catch { /* a submodule's gitdir has no commondir: it is its own repository */ }
      return { top: cur, gitDir, commonDir, linked: !samePath(gitDir, commonDir) };
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** The branch a gitdir's HEAD names, read from the file: { branch, detached, sha }. */
export function headOf(gitDir) {
  try {
    const t = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(t);
    if (m) return { branch: m[1], detached: false, sha: '' };
    return { branch: '', detached: true, sha: /^[0-9a-f]{7,64}$/i.test(t) ? t : '' };
  } catch { return { branch: '', detached: true, sha: '' }; }
}

/** The repository has linked worktrees (the common dir has a worktrees folder with entries). */
export function hasLinked(commonDir) {
  try { return fs.readdirSync(path.join(commonDir, 'worktrees')).length > 0; } catch { return false; }
}

/** A repository's id: its common dir, normalized, with forward slashes (the same in every worktree of it). */
export const repoId = (commonDir) => pathKey(commonDir).replace(/\\/g, '/');

/* ---------- parsing git's output ---------- */

/** The porcelain output of `git worktree list` (NUL separated or not) as [{ path, head, branch, detached, bare, locked, prunable }]. */
export function parseWorktreeList(text) {
  const raw = String(text ?? '');
  const parts = raw.includes('\0') ? raw.split('\0') : raw.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of parts) {
    if (!line) { if (cur) { out.push(cur); cur = null; } continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: normPath(val), head: '', branch: '', detached: false, bare: false, locked: null, prunable: null };
    } else if (!cur) {
      continue;
    } else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = val || 'locked';
    else if (key === 'prunable') cur.prunable = val || 'prunable';
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The NUL separated porcelain v2 output of `git status` (with its branch lines) as { oid, head, upstream, ahead, behind, entries, untracked, conflicts,
 * staged, unstaged }. ahead and behind are against the upstream branch (0 without one). An entry is
 * { kind: 'ordinary' | 'rename' | 'unmerged' | 'untracked', x, y, path, orig? }.
 */
export function parseStatus(text) {
  const out = { oid: '', head: '', upstream: '', ahead: 0, behind: 0, entries: [], untracked: 0, conflicts: 0, staged: 0, unstaged: 0 };
  const parts = String(text ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (!l) continue;
    if (l.startsWith('# ')) {
      let m;
      if ((m = /^# branch\.oid (\S+)/.exec(l))) out.oid = m[1] === '(initial)' ? '' : m[1];
      else if ((m = /^# branch\.head (.+)$/.exec(l))) out.head = m[1] === '(detached)' ? '' : m[1];
      else if ((m = /^# branch\.upstream (.+)$/.exec(l))) out.upstream = m[1];
      else if ((m = /^# branch\.ab \+(\d+) -(\d+)/.exec(l))) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
      continue;
    }
    const kind = l[0];
    if (kind === '1') {
      const f = l.split(' ');
      out.entries.push({ kind: 'ordinary', x: f[1][0], y: f[1][1], path: f.slice(8).join(' ') });
    } else if (kind === '2') {
      const f = l.split(' ');
      out.entries.push({ kind: 'rename', x: f[1][0], y: f[1][1], path: f.slice(9).join(' '), orig: parts[i + 1] || '' });
      i += 1;
    } else if (kind === 'u') {
      const f = l.split(' ');
      out.entries.push({ kind: 'unmerged', x: f[1][0], y: f[1][1], path: f.slice(10).join(' ') });
      out.conflicts += 1;
    } else if (kind === '?') {
      out.entries.push({ kind: 'untracked', x: '?', y: '?', path: l.slice(2) });
      out.untracked += 1;
    }
  }
  for (const e of out.entries) {
    if (e.kind === 'untracked' || e.kind === 'unmerged') continue;
    if (e.x !== '.') out.staged += 1;
    if (e.y !== '.') out.unstaged += 1;
  }
  return out;
}

/** The numstat output of `git diff` as { files: [{ path, added, removed, binary }], added, removed }. */
export function parseNumstat(text) {
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === '-';
    const a = binary ? 0 : Number(m[1]);
    const r = binary ? 0 : Number(m[2]);
    files.push({ path: m[3], added: a, removed: r, binary });
    added += a;
    removed += r;
  }
  return { files, added, removed };
}

/**
 * A unified diff split into files: [{ path, oldPath, status, binary, patch }], status 'M' (changed), 'A' (new),
 * 'D' (deleted) or 'R' (renamed). `patch` keeps everything from the file's first header line, so a viewer can draw it.
 */
export function splitPatch(text) {
  const out = [];
  const raw = String(text ?? '');
  if (!raw) return out;
  const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const c of chunks) {
    const head = c.split('\n', 1)[0];
    const hm = /^diff --git a\/(.+?) b\/(.+)$/.exec(head);
    let filePath = hm ? hm[2] : head.slice(11);
    let oldPath = hm ? hm[1] : '';
    let status = 'M';
    if (/^new file mode /m.test(c)) status = 'A';
    else if (/^deleted file mode /m.test(c)) status = 'D';
    else if (/^rename from /m.test(c)) status = 'R';
    const rf = /^rename from (.+)$/m.exec(c);
    const rt = /^rename to (.+)$/m.exec(c);
    if (rf) oldPath = rf[1];
    if (rt) filePath = rt[1];
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(c);
    if (plus && plus[1] !== '/dev/null' && !rt) filePath = plus[1];
    out.push({ path: filePath, oldPath: status === 'R' ? oldPath : '', status, binary: /^Binary files .* differ$|^GIT binary patch$/m.test(c), patch: c.endsWith('\n') ? c : `${c}\n` });
  }
  return out;
}

/* ---------- names and places ---------- */

/** What is wrong with a branch name before git sees it (null when it looks fine). */
export function checkBranchName(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Give the branch a name.';
  if (n.length > 120) return 'That branch name is too long.';
  if (n.startsWith('-')) return 'A branch name cannot start with a hyphen.';
  if (!/^[A-Za-z0-9._/-]+$/.test(n)) return 'Use letters, numbers, dots, slashes, underscores and hyphens in a branch name.';
  if (/\.\.|\/\/|^\/|\/$|\.$|\.lock$|@\{/.test(n) || n.split('/').some((s) => s.startsWith('.') || s.endsWith('.lock'))) return `"${n}" is not a valid branch name.`;
  return null;
}

/** A folder name for a branch ("feature/login" is feature-login). */
export function folderFor(branch) {
  return String(branch ?? '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'worktree';
}

/**
 * Where a new worktree goes: Claude Code's own place (<repo>/.claude/worktrees/<name>) when the repository has
 * one (the folder exists, or a worktree already lives in it); otherwise a sibling folder <repo>.worktrees/<name>,
 * so the repository itself needs no .gitignore change. A taken name gets -2, -3... Returns { path, insideRepo, parent }.
 */
export function chooseWorktreePath(repo, branch, { exists = (p) => fs.existsSync(p) } = {}) {
  const top = repo.root || path.dirname(repo.commonDir);
  const claudeRoot = path.join(top, '.claude', 'worktrees');
  const usesClaude = isDir(claudeRoot) || (repo.worktrees || []).some((w) => !samePath(w.path, claudeRoot) && isInside(w.path, claudeRoot));
  const parent = usesClaude ? claudeRoot : path.join(path.dirname(top), `${path.basename(top)}.worktrees`);
  const name = folderFor(branch);
  const taken = (p) => exists(p) || (repo.worktrees || []).some((w) => samePath(w.path, p));
  let candidate = path.join(parent, name);
  for (let n = 2; taken(candidate) && n < 50; n++) candidate = path.join(parent, `${name}-${n}`);
  return { path: candidate, insideRepo: usesClaude, parent };
}

/* ---------- Apaki's own notes about worktrees it made ---------- */

/**
 * Which base a worktree was made from, and the commit it started at, kept in Apaki's own file under
 * ~/.claude/latch (never in the repository's config): the counts are "against the base" and a worktree made
 * from a feature branch would otherwise be measured against the wrong one.
 */
export class WtMeta {
  constructor(file = path.join(latchDir(), 'apaki-worktrees.json')) {
    this.file = file;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { this.data = {}; }
    return this.data;
  }

  get(p) { return this.load()[pathKey(p)] || null; }

  set(p, rec) {
    this.load()[pathKey(p)] = { ...rec, path: normPath(p) };
    this.save();
  }

  forget(p) {
    if (!this.load()[pathKey(p)]) return;
    delete this.data[pathKey(p)];
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch { /* the notes are a convenience; a read-only home loses only the base memory */ }
  }
}

/* ---------- looking at a repository ---------- */

/** Runs fn over items, `limit` at a time, keeping the order of the results. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const UNTRACKED_FILES_MAX = 300;
const UNTRACKED_BYTES_MAX = 256 * 1024;

/** Lines in the untracked files of a worktree (they are part of its change count): { added, approx }. */
async function untrackedLines(root, entries) {
  let paths = entries.filter((e) => e.kind === 'untracked').map((e) => e.path);
  if (!paths.length) return { added: 0, approx: false };
  // A collapsed untracked folder ("dir/") is expanded to its files.
  if (paths.some((p) => p.endsWith('/'))) {
    const r = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (r.code === 0) paths = r.stdout.split('\0').filter(Boolean);
  }
  let approx = paths.length > UNTRACKED_FILES_MAX;
  let added = 0;
  for (const rel of paths.slice(0, UNTRACKED_FILES_MAX)) {
    try {
      const file = path.join(root, rel);
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (st.size > UNTRACKED_BYTES_MAX) { approx = true; continue; }
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      let n = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n += 1;
      if (buf.length && buf[buf.length - 1] !== 10) n += 1;
      added += n;
    } catch { /* gone while counting */ }
  }
  return { added, approx };
}

/** A ref names a commit here. */
async function refExists(cwd, ref) {
  if (!ref) return false;
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
}

/**
 * The repository's usual base branch: what origin/HEAD points at, else main, master, trunk or develop when one
 * exists, else the main checkout's branch.
 */
export async function defaultBranch(cwd, branches, mainBranch = '') {
  const sym = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0) {
    const name = one(sym.stdout).replace(/^origin\//, '');
    if (name && (branches.includes(name) || (await refExists(cwd, name)))) return name;
    if (name && (await refExists(cwd, `origin/${name}`))) return `origin/${name}`;
  }
  for (const c of ['main', 'master', 'trunk', 'develop']) if (branches.includes(c)) return c;
  return mainBranch || branches[0] || '';
}

/**
 * Everything the sidebar and the pane header show about one worktree: the entry from the list plus status and
 * numbers against `base` (null base: the worktree's own HEAD). Never throws; a failure is `error`.
 */
export async function inspectWorktree(wt, { base = '', meta = null } = {}) {
  const out = { ...wt, stats: true, base, added: 0, removed: 0, files: 0, changed: 0, untracked: 0, conflicts: 0, staged: 0, upstream: '', aheadUp: 0, behindUp: 0, ahead: 0, behind: 0, unpushed: 0, merged: false, approx: false };
  if (wt.bare) return out;
  if (wt.prunable || !isDir(wt.path)) { out.missing = true; out.error = 'Its folder is gone.'; return out; }
  const cwd = wt.path;
  const st = await git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z']);
  if (st.code !== 0) { out.error = whyFailed(st); return out; }
  const s = parseStatus(st.stdout);
  Object.assign(out, { upstream: s.upstream, aheadUp: s.ahead, behindUp: s.behind, changed: s.entries.length, untracked: s.untracked, conflicts: s.conflicts, staged: s.staged });
  if (!out.head && s.oid) out.head = s.oid;
  const rec = meta?.get?.(wt.path) || null;
  // The base this worktree was made from, if Apaki made it and it still exists; else the repository's.
  const baseName = rec?.base && (await refExists(cwd, rec.base)) ? rec.base : base;
  out.base = baseName;
  const onBase = !wt.detached && wt.branch && wt.branch === baseName;
  let diffBase = 'HEAD';
  if (baseName && !onBase) {
    const mb = await git(cwd, ['merge-base', baseName, 'HEAD']);
    if (mb.code === 0 && one(mb.stdout)) diffBase = one(mb.stdout);
  }
  const [num, lr, uns, anc, extra] = await Promise.all([
    s.oid ? git(cwd, ['diff', '--numstat', diffBase]) : null,
    baseName && !onBase && s.oid ? git(cwd, ['rev-list', '--left-right', '--count', `${baseName}...HEAD`]) : null,
    s.oid ? git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...(baseName ? [baseName] : [])]) : null,
    baseName && !onBase && s.oid ? git(cwd, ['merge-base', '--is-ancestor', 'HEAD', baseName]) : null,
    untrackedLines(cwd, s.entries),
  ]);
  let trackedFiles = 0;
  if (num && num.code === 0) {
    const n = parseNumstat(num.stdout);
    out.added = n.added; out.removed = n.removed; trackedFiles = n.files.length;
  }
  out.added += extra.added;
  out.approx = extra.approx;
  out.files = trackedFiles + s.untracked;
  if (lr && lr.code === 0) { const m = /^(\d+)\s+(\d+)/.exec(one(lr.stdout)); if (m) { out.behind = Number(m[1]); out.ahead = Number(m[2]); } }
  // null: git could not tell, and the remove guard then refuses rather than guesses.
  out.unpushed = uns ? (uns.code === 0 ? Number(one(uns.stdout)) || 0 : null) : 0;
  if (anc && anc.code === 0 && !onBase && wt.branch && !wt.detached) {
    // Inside the base is not enough: a branch made a moment ago and never committed to is inside it too. It counts as
    // merged once it had work of its own (it left the commit Apaki made it at, or its reflog has more than its creation).
    let had = false;
    if (rec?.startSha) had = rec.startSha !== s.oid;
    else {
      const rl = await git(cwd, ['reflog', 'show', '--format=%H', '-n', '3', wt.branch]);
      had = rl.code === 0 && lines(rl.stdout).length > 1;
    }
    out.merged = had;
  }
  return out;
}

/**
 * A repository as the engine reports it: { id, commonDir, root, name, base, branches, remote, linked, light,
 * worktrees }. `wantStats(path)` says which worktrees get the numbers (a linked repository gets them for all, up to
 * MAX_INSPECT, the ones the caller named first); `full` also reads the branches and the base, for a repository the
 * New worktree sheet is about to use. A light repository (no linked worktree, nobody asked) needs no git process.
 */
const MAX_INSPECT = 24;
export async function loadRepo(info, { wantStats = () => false, full = false, meta = null, hint = '' } = {}) {
  const commonDir = normPath(info.commonDir);
  const mainTop = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : (hint ? normPath(hint) : '');
  const linked = hasLinked(commonDir);
  const rec = { id: repoId(commonDir), commonDir, root: mainTop || null, name: '', base: '', branches: [], remote: null, linked, light: false, worktrees: [] };
  let entries;
  if (linked) {
    const cwd = mainTop && isDir(mainTop) ? mainTop : commonDir;
    let wl = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
    if (wl.code !== 0) wl = await git(cwd, ['worktree', 'list', '--porcelain']);
    if (wl.code !== 0) return { ...rec, name: path.basename(mainTop || commonDir), error: whyFailed(wl) };
    entries = parseWorktreeList(wl.stdout);
    if (entries[0]) rec.root = entries[0].path;
  } else {
    const h = headOf(commonDir);
    entries = [{ path: mainTop || normPath(info.top), head: h.sha, branch: h.branch, detached: h.detached, bare: false, locked: null, prunable: null }];
  }
  rec.name = path.basename(rec.root || commonDir).replace(/\.git$/, '');
  entries.forEach((e, i) => { e.main = i === 0; });
  const need = entries.map((e) => !e.bare && (linked || wantStats(e.path)));
  rec.light = !linked && !need.some(Boolean) && !full;
  if (!rec.light) {
    const cwd = rec.root && isDir(rec.root) ? rec.root : commonDir;
    const fe = await git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', '--count=60', 'refs/heads']);
    rec.branches = fe.code === 0 ? lines(fe.stdout) : [];
    const rm = await git(cwd, ['remote']);
    const remotes = rm.code === 0 ? lines(rm.stdout) : [];
    rec.remote = remotes.includes('origin') ? 'origin' : (remotes[0] || null);
    rec.base = await defaultBranch(cwd, rec.branches, entries[0]?.branch || '');
  }
  const order = entries.map((e, i) => i).filter((i) => need[i]);
  // Past the cap the ones the caller asked about come first, then the rest in list order.
  order.sort((a, b) => (Number(wantStats(entries[b].path)) - Number(wantStats(entries[a].path))) || (a - b));
  const chosen = new Set(order.slice(0, MAX_INSPECT));
  rec.worktrees = await pool(entries, 2, async (e, i) => {
    if (!chosen.has(i)) return { ...e, base: rec.base, added: 0, removed: 0, files: 0, changed: 0, untracked: 0, conflicts: 0, staged: 0, upstream: '', aheadUp: 0, behindUp: 0, ahead: 0, behind: 0, unpushed: 0, merged: false, approx: false, ...(e.bare ? {} : { stats: false }) };
    const w = await inspectWorktree(e, { base: rec.base, meta });
    if (w.main) { w.merged = false; }
    return w;
  });
  return rec;
}

/* ---------- the diff the viewer shows ---------- */

const PATCH_TOTAL_MAX = 900 * 1024;
const PATCH_FILE_MAX = 80 * 1024;
const UNTRACKED_PATCH_FILES = 120;

/** A patch for a file git does not track yet, in git's own format, so the viewer reads every file the same way. */
function newFilePatch(rel, buf) {
  if (buf.subarray(0, 8000).includes(0)) return { patch: `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`, added: 0, binary: true };
  const text = buf.toString('utf8');
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  const body = ls.map((l) => `+${l}`).join('\n');
  const missingNl = text.length > 0 && !text.endsWith('\n');
  return { patch: `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${ls.length} @@\n${body}${ls.length ? '\n' : ''}${missingNl ? '\\ No newline at end of file\n' : ''}`, added: ls.length, binary: false };
}

/**
 * The changes in a worktree for the viewer. scope 'base' (default): everything since the branch left `base`, plus
 * uncommitted work and new files; scope 'head': only what is not committed yet. Returns { ok, base, ref, scope,
 * files: [{ path, oldPath, status, added, removed, binary, untracked, patch, cut }], added, removed, truncated }.
 * Read only.
 */
export async function diffOf(wtPath, { base = '', scope = 'base' } = {}) {
  const cwd = normPath(wtPath);
  if (!isDir(cwd)) return { ok: false, error: 'That folder is gone.' };
  let ref = 'HEAD';
  if (scope !== 'head' && base) {
    const mb = await git(cwd, ['merge-base', base, 'HEAD']);
    if (mb.code === 0 && one(mb.stdout)) ref = one(mb.stdout);
  }
  const hasHead = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).code === 0;
  const [num, pat, un] = await Promise.all([
    hasHead ? git(cwd, ['diff', '--numstat', '-M', ref]) : null,
    hasHead ? git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', '--unified=3', ref], { maxBuffer: 16 * 1024 * 1024, timeout: 60000 }) : null,
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const stats = new Map(parseNumstat(num?.stdout).files.map((f) => [f.path, f]));
  let files = pat && pat.code === 0 ? splitPatch(pat.stdout) : [];
  const overflow = Boolean(pat?.overflow);
  if (overflow && num?.code === 0) files = [...stats.values()].map((f) => ({ path: f.path, oldPath: '', status: 'M', binary: f.binary, patch: '', cut: true }));
  let added = 0;
  let removed = 0;
  let budget = PATCH_TOTAL_MAX;
  let truncated = overflow;
  const out = [];
  for (const f of files) {
    const n = stats.get(f.path) || [...stats.values()].find((x) => x.path.includes(f.path)) || { added: 0, removed: 0 };
    let patch = f.patch;
    let cut = Boolean(f.cut);
    if (patch.length > PATCH_FILE_MAX) { patch = `${patch.slice(0, PATCH_FILE_MAX)}\n`; cut = true; }
    if (patch.length > budget) { patch = ''; cut = true; truncated = true; }
    budget -= patch.length;
    out.push({ path: f.path, oldPath: f.oldPath, status: f.status, added: n.added, removed: n.removed, binary: f.binary, untracked: false, patch, cut });
    added += n.added;
    removed += n.removed;
  }
  const untracked = un.code === 0 ? un.stdout.split('\0').filter(Boolean) : [];
  for (const rel of untracked.slice(0, UNTRACKED_PATCH_FILES)) {
    try {
      const file = path.join(cwd, rel);
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (st.size > PATCH_FILE_MAX * 2) { out.push({ path: rel, oldPath: '', status: 'A', added: 0, removed: 0, binary: false, untracked: true, patch: '', cut: true }); truncated = true; continue; }
      const np = newFilePatch(rel, fs.readFileSync(file));
      let patch = np.patch;
      let cut = false;
      if (patch.length > PATCH_FILE_MAX) { patch = `${patch.slice(0, PATCH_FILE_MAX)}\n`; cut = true; }
      if (patch.length > budget) { patch = ''; cut = true; truncated = true; }
      budget -= patch.length;
      out.push({ path: rel, oldPath: '', status: 'A', added: np.added, removed: 0, binary: np.binary, untracked: true, patch, cut });
      added += np.added;
    } catch { /* gone while reading */ }
  }
  if (untracked.length > UNTRACKED_PATCH_FILES) truncated = true;
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, base: scope === 'head' ? '' : base, ref, scope: scope === 'head' ? 'head' : 'base', files: out, added, removed, truncated };
}

/* ---------- plans: say what will happen, then do exactly that ---------- */

export const KINDS = Object.freeze(['create', 'remove', 'commit', 'push', 'pr', 'merge']);

const findWt = (repo, p) => (p ? (repo.worktrees || []).find((w) => samePath(w.path, String(p))) || null : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const statusLetter = (e) => (e.kind === 'untracked' ? '?' : e.kind === 'unmerged' ? 'U' : e.kind === 'rename' ? 'R' : (e.x !== '.' ? e.x : e.y));

/** A step to run: the program, its arguments and the folder. The text shown for it is made from these. */
const step = (bin, args, cwd, extra = {}) => ({ bin, args, cwd, ...extra });
const withDisplay = (plan) => ({ ...plan, commands: plan.steps.map((s) => fmtCommand(s.bin, s.args)) });

/** gh is installed and signed in; { ok, why }. `runGh(args, opts)` is injectable so tests never call GitHub. */
async function ghReady(cwd, runGh) {
  const v = await runGh(['--version'], { cwd, timeout: 10000 });
  if (v.missing || v.code !== 0) return { ok: false, why: 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run gh auth login.' };
  const a = await runGh(['auth', 'status'], { cwd, timeout: 15000 });
  if (a.code !== 0) return { ok: false, why: 'gh is not signed in. Run gh auth login on this PC.' };
  return { ok: true, why: '' };
}

/**
 * Plans one action. `repo` is a fresh full repo record (loadRepo with full), `args` what the client sent, and
 * ctx { run: false | true (true: the action is about to run, so a missing message or title is a blocker),
 * openCwds: folders conversations are open in, meta: WtMeta }.
 * Returns { ok: true, kind, title, summary, steps, commands, blockers, warnings, data } where ok only says the
 * plan could be made; `blockers` empty means it may run.
 */
export async function plan(kind, args, repo, ctx = {}) {
  const base = { ok: true, kind, title: '', summary: '', steps: [], commands: [], blockers: [], warnings: [], data: {} };
  if (!KINDS.includes(kind)) return { ...base, ok: false, blockers: [`"${String(kind).slice(0, 40)}" is not something worktrees can do.`], commands: [] };
  if (!repo || repo.error) return withDisplay({ ...base, blockers: [repo?.error || 'That folder is not in a git repository.'] });
  const fn = { create: planCreate, remove: planRemove, commit: planCommit, push: planPush, pr: planPr, merge: planMerge }[kind];
  return withDisplay(await fn(base, args || {}, repo, ctx));
}

async function planCreate(p, args, repo, ctx) {
  const branch = one(args.branch);
  const baseName = one(args.base) || repo.base;
  const useExisting = args.useExisting === true;
  const top = repo.root;
  p.title = 'New worktree';
  if (!top) { p.blockers.push('This is a bare repository; make the worktree from a checkout of it.'); return p; }
  const bad = checkBranchName(branch);
  if (bad) p.blockers.push(bad);
  else if ((await git(top, ['check-ref-format', '--branch', branch])).code !== 0) p.blockers.push(`"${branch}" is not a valid branch name.`);
  const exists = repo.branches.includes(branch);
  const at = repo.worktrees.find((w) => w.branch === branch);
  if (exists && !useExisting) { p.blockers.push(`A branch named ${branch} already exists.`); p.data.branchExists = true; }
  if (exists && useExisting && at) p.blockers.push(`${branch} is already checked out in ${at.path}.`);
  if (!exists && useExisting) p.blockers.push(`There is no branch named ${branch} to use.`);
  if (!useExisting) {
    if (!baseName) p.blockers.push('This repository has no branch to start from yet. Make a first commit.');
    else if (!(await refExists(top, baseName))) p.blockers.push(`The base branch ${baseName} does not exist here.`);
  }
  const where = chooseWorktreePath(repo, branch || 'worktree');
  p.data = { ...p.data, branch, base: useExisting ? '' : baseName, path: where.path, repo: repo.root, useExisting };
  if (where.insideRepo) {
    const ig = await git(top, ['check-ignore', '-q', path.relative(top, where.path).replace(/\\/g, '/')]);
    if (ig.code !== 0) p.warnings.push('This folder is inside the repository and git does not ignore it, so git status in the main checkout will list it as untracked.');
  }
  p.summary = useExisting ? `Check out ${branch} in a new folder next to your other worktrees.` : `Make a new branch ${branch} from ${baseName || 'the base'} in its own folder, so work there never touches your other checkouts.`;
  p.steps.push(useExisting ? step('git', ['worktree', 'add', where.path, branch], top) : step('git', ['worktree', 'add', '-b', branch, where.path, baseName], top));
  return p;
}

async function planRemove(p, args, repo, ctx) {
  const wt = findWt(repo, args.path);
  p.title = 'Remove worktree';
  if (!wt) { p.blockers.push('That folder is not a worktree of this repository.'); return p; }
  p.data = { path: wt.path, branch: wt.branch, merged: wt.merged };
  p.summary = `Remove the folder ${wt.path}. The branch and everything committed to it stay unless you also delete a merged branch below.`;
  if (wt.main) p.blockers.push('This is the main checkout of the repository; it is not removed from here.');
  if (wt.locked) p.blockers.push(`It is locked (${wt.locked === 'locked' ? 'something is using it' : wt.locked}). Unlock it with git worktree unlock first.`);
  if ((ctx.openCwds || []).some((c) => isInside(c, wt.path))) p.blockers.push('A conversation is open in it. Close that conversation first.');
  if (wt.error && !wt.missing) p.blockers.push(`Could not check it: ${wt.error}`);
  if (wt.changed > 0) p.blockers.push(`${plural(wt.changed, 'file')} ${wt.changed === 1 ? 'has' : 'have'} uncommitted changes. Commit or move them first.`);
  if (wt.unpushed === null) p.blockers.push('Could not check whether its commits are saved anywhere else, so it is kept.');
  else if (wt.unpushed > 0) p.blockers.push(`${plural(wt.unpushed, 'commit')} ${wt.unpushed === 1 ? 'is' : 'are'} not pushed anywhere and not in ${wt.base || 'the base branch'}. Push or merge ${wt.unpushed === 1 ? 'it' : 'them'} first.`);
  if (wt.prunable || wt.missing) p.steps.push(step('git', ['worktree', 'prune'], repo.root));
  else p.steps.push(step('git', ['worktree', 'remove', wt.path], repo.root));
  if (args.deleteBranch === true && wt.branch && !wt.detached) {
    if (wt.merged) p.steps.push(step('git', ['branch', '-d', wt.branch], repo.root, { tolerate: true, note: `The branch ${wt.branch} stays: git does not consider it fully merged.` }));
    else p.warnings.push(`The branch ${wt.branch} stays: it has work that is not merged into ${wt.base || 'the base branch'}.`);
  }
  return p;
}

async function planCommit(p, args, repo, ctx) {
  const wt = findWt(repo, args.path);
  p.title = 'Commit';
  if (!wt) { p.blockers.push('That folder is not a worktree of this repository.'); return p; }
  const st = await git(wt.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  if (st.code !== 0) { p.blockers.push(whyFailed(st)); return p; }
  const s = parseStatus(st.stdout);
  const files = s.entries.slice(0, 500).map((e) => ({ path: e.path, status: statusLetter(e), staged: e.kind !== 'untracked' && e.kind !== 'unmerged' && e.x !== '.' }));
  p.data = { path: wt.path, branch: wt.branch, files, total: s.entries.length };
  if (!s.entries.length) p.blockers.push('Nothing to commit.');
  if (s.conflicts) p.blockers.push(`${plural(s.conflicts, 'file')} still ${s.conflicts === 1 ? 'has' : 'have'} merge conflicts. Resolve them first.`);
  if (wt.detached) p.warnings.push('HEAD is detached: this commit belongs to no branch. Make a branch for it afterwards.');
  let chosen = null;
  if (Array.isArray(args.paths)) {
    const valid = new Set(s.entries.map((e) => e.path));
    chosen = args.paths.map(String).filter((x) => valid.has(x));
    if (chosen.length !== args.paths.length) p.blockers.push('Some of the chosen files have no changes any more. Look again.');
    if (!chosen.length) p.blockers.push('Choose at least one file.');
    if (chosen.length > 200) p.blockers.push('That is too many files to choose one by one. Commit all of them, or fewer.');
  }
  const message = String(args.message ?? '').trim();
  if (ctx.run && !message) p.blockers.push('Write a commit message.');
  const count = chosen ? chosen.length : s.entries.length;
  p.summary = `Commit ${plural(count, 'file')} on ${wt.branch || 'a detached HEAD'}.`;
  if (chosen) {
    p.steps.push(step('git', ['add', '--', ...chosen], wt.path));
    p.steps.push(step('git', ['commit', '-m', message || '<message>', '--', ...chosen], wt.path));
  } else {
    p.steps.push(step('git', ['add', '-A'], wt.path));
    p.steps.push(step('git', ['commit', '-m', message || '<message>'], wt.path));
  }
  return p;
}

async function planPush(p, args, repo, ctx) {
  const wt = findWt(repo, args.path);
  p.title = 'Push';
  if (!wt) { p.blockers.push('That folder is not a worktree of this repository.'); return p; }
  p.data = { path: wt.path, branch: wt.branch, upstream: wt.upstream, ahead: wt.aheadUp };
  if (wt.detached || !wt.branch) { p.blockers.push('HEAD is detached, so there is no branch to push.'); return p; }
  if (!repo.remote) { p.blockers.push('This repository has no remote. Add one with git remote add origin <url>.'); return p; }
  if (wt.upstream && wt.aheadUp === 0 && wt.behindUp === 0) p.blockers.push('Everything is already pushed.');
  if (wt.upstream && wt.behindUp > 0) p.warnings.push(`The remote has ${plural(wt.behindUp, 'commit')} you do not have. git will refuse the push until you merge them; Apaki never forces a push.`);
  if (wt.changed > 0) p.warnings.push(`${plural(wt.changed, 'file')} with uncommitted changes ${wt.changed === 1 ? 'is' : 'are'} not part of the push.`);
  p.summary = wt.upstream ? `Send ${plural(wt.aheadUp, 'commit')} on ${wt.branch} to ${wt.upstream}.` : `Publish ${wt.branch} to ${repo.remote} and track it.`;
  p.steps.push(wt.upstream ? step('git', ['push'], wt.path, { timeout: 180000 }) : step('git', ['push', '-u', repo.remote, wt.branch], wt.path, { timeout: 180000 }));
  return p;
}

async function planPr(p, args, repo, ctx) {
  const wt = findWt(repo, args.path);
  p.title = 'Open pull request';
  if (!wt) { p.blockers.push('That folder is not a worktree of this repository.'); return p; }
  const baseName = one(args.base) || wt.base || repo.base;
  const baseOnRemote = baseName.replace(/^origin\//, '');
  p.data = { path: wt.path, branch: wt.branch, base: baseOnRemote, draft: args.draft === true };
  if (wt.detached || !wt.branch) { p.blockers.push('HEAD is detached, so there is no branch for a pull request.'); return p; }
  if (!repo.remote) { p.blockers.push('This repository has no remote. Add one with git remote add origin <url>.'); return p; }
  if (wt.branch === baseOnRemote) { p.blockers.push(`This is the base branch (${baseOnRemote}). Make a branch of your own first.`); return p; }
  if (wt.base && wt.ahead === 0) p.blockers.push(`There are no commits beyond ${baseOnRemote} to open a pull request for.`);
  const runGh = ctx.runGh || ((a, o) => run('gh', a, o));
  const gh = await ghReady(wt.path, runGh);
  if (!gh.ok) { p.blockers.push(gh.why); return p; }
  const existing = await runGh(['pr', 'list', '--head', wt.branch, '--state', 'open', '--json', 'url,number,title', '-L', '1'], { cwd: wt.path, timeout: 30000 });
  if (existing.code === 0) {
    try {
      const j = JSON.parse(existing.stdout || '[]');
      if (j[0]?.url) { p.blockers.push(`A pull request is already open for ${wt.branch}: ${j[0].url}`); p.data.existing = j[0]; }
    } catch { /* not JSON: treat as none */ }
  }
  // A subject and a list of commits to start the form with.
  const log = await git(wt.path, ['log', '--format=%s', '-n', '20', `${baseName}..HEAD`]);
  const subjects = log.code === 0 ? lines(log.stdout) : [];
  p.data.suggest = {
    title: subjects.length === 1 ? subjects[0] : (wt.branch || '').replace(/^[^/]+\//, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    body: subjects.length > 1 ? subjects.map((s) => `- ${s}`).reverse().join('\n') : '',
  };
  const title = one(args.title);
  if (ctx.run && !title) p.blockers.push('Give the pull request a title.');
  if (wt.changed > 0) p.warnings.push(`${plural(wt.changed, 'file')} with uncommitted changes ${wt.changed === 1 ? 'is' : 'are'} not in the pull request. Commit first to include ${wt.changed === 1 ? 'it' : 'them'}.`);
  const needsPush = !wt.upstream || wt.aheadUp > 0;
  p.summary = `${needsPush ? 'Push the branch, then open' : 'Open'} a pull request from ${wt.branch} into ${baseOnRemote} on GitHub.`;
  if (needsPush) p.steps.push(wt.upstream ? step('git', ['push'], wt.path, { timeout: 180000 }) : step('git', ['push', '-u', repo.remote, wt.branch], wt.path, { timeout: 180000 }));
  p.steps.push(step('gh', ['pr', 'create', '--base', baseOnRemote, '--head', wt.branch, '--title', title || '<title>', '--body', String(args.body ?? ''), ...(args.draft === true ? ['--draft'] : [])], wt.path, { timeout: 90000, kind: 'pr' }));
  return p;
}

/** Files that would conflict if `branch` were merged into `into`, from git merge-tree (changes nothing); null when git cannot tell. */
export async function predictConflicts(cwd, into, branch) {
  const r = await git(cwd, ['merge-tree', '--write-tree', '--name-only', into, branch]);
  if (r.code === 0) return [];
  if (r.code === 1) {
    const ls = r.stdout.split(/\r?\n/);
    const files = [];
    for (let i = 1; i < ls.length && ls[i]; i++) files.push(ls[i]);
    return files.length ? files : ['(a file)'];
  }
  return null;
}

async function planMerge(p, args, repo, ctx) {
  const src = findWt(repo, args.path);
  p.title = 'Merge';
  if (!src) { p.blockers.push('That folder is not a worktree of this repository.'); return p; }
  const into = one(args.into) || src.base || repo.base;
  const target = repo.worktrees.find((w) => w.branch === into && !w.bare);
  p.data = { path: src.path, branch: src.branch, into, targetPath: target?.path || '', ahead: src.ahead };
  p.summary = `Merge ${src.branch || 'this branch'} into ${into}. Nothing is pushed, and nothing is deleted.`;
  if (src.detached || !src.branch) { p.blockers.push('HEAD is detached, so there is no branch to merge.'); return p; }
  if (src.branch === into) { p.blockers.push(`This is ${into} itself. Merge a different branch into it.`); return p; }
  if (!target) { p.blockers.push(`${into} is not checked out in any worktree of this repository. Check it out in the main checkout first, then merge.`); return p; }
  if (target.error) p.blockers.push(`Could not check the ${into} checkout: ${target.error}`);
  if (target.changed > 0) p.blockers.push(`The ${into} checkout (${target.path}) has uncommitted changes. Commit or move them first so the merge cannot mix with them.`);
  if (target.conflicts > 0) p.blockers.push(`The ${into} checkout has unresolved conflicts.`);
  if (src.merged) p.blockers.push(`${src.branch} is already merged into ${into}.`);
  else if (src.ahead === 0 && src.base === into) p.blockers.push(`${src.branch} has no commits that ${into} lacks.`);
  if (src.changed > 0) p.warnings.push(`${plural(src.changed, 'file')} with uncommitted changes ${src.changed === 1 ? 'is' : 'are'} not part of the merge. Commit first to include ${src.changed === 1 ? 'it' : 'them'}.`);
  if (src.behind > 0 && src.base === into) p.warnings.push(`${src.branch} is ${src.behind} behind ${into}.`);
  const conflicts = p.blockers.length ? null : await predictConflicts(repo.root, into, src.branch);
  if (conflicts && conflicts.length) {
    p.data.conflicts = conflicts;
    p.blockers.push(`The merge would conflict in ${conflicts.length > 3 ? `${conflicts.slice(0, 3).join(', ')} and ${conflicts.length - 3} more` : conflicts.join(', ')}. Nothing was changed. Merge ${into} into ${src.branch} in its own worktree first and settle the conflicts there, or ask Claude to.`);
  } else if (conflicts === null && !p.blockers.length) {
    p.warnings.push('This git cannot check for conflicts ahead of time. If the merge conflicts it is undone and nothing changes.');
    p.data.unchecked = true;
  }
  p.steps.push(step('git', ['merge', '--no-edit', src.branch], target.path, { abortOnFail: true, timeout: 120000 }));
  return p;
}

/* ---------- running a plan ---------- */

const tail = (s, n = 1800) => (String(s).length > n ? `...${String(s).slice(-n)}` : String(s));

/**
 * Runs a plan's steps in order and stops at the first failure. A merge step that fails is undone with
 * a merge abort (only when it left a merge in progress). Returns { ok, error?, log: [{ cmd, code, out }], url? }.
 */
export async function execute(plan, { runner = run } = {}) {
  const log = [];
  if (!plan || plan.blockers?.length) return { ok: false, error: plan?.blockers?.[0] || 'Nothing to run.', log };
  let url = '';
  for (const s of plan.steps) {
    const r = await runner(s.bin, s.args, { cwd: s.cwd, timeout: s.timeout || 120000 });
    const out = tail(`${r.stdout}${r.stderr}`.trim());
    log.push({ cmd: fmtCommand(s.bin, s.args), code: r.code, out });
    if (r.code === 0) {
      if (s.kind === 'pr') url = (r.stdout.match(/https?:\/\/\S+/g) || []).pop() || '';
      continue;
    }
    if (s.tolerate) { log[log.length - 1].note = s.note || ''; continue; }
    let error = whyFailed(r, s.bin);
    if (s.abortOnFail) {
      const merging = await git(s.cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      if (merging.code === 0) {
        const un = await git(s.cwd, ['diff', '--name-only', '--diff-filter=U']);
        const ab = await git(s.cwd, ['merge', '--abort']);
        log.push({ cmd: 'git merge --abort', code: ab.code, out: tail(`${ab.stdout}${ab.stderr}`.trim()) });
        const files = lines(un.stdout);
        error = `The merge stopped${files.length ? ` on conflicts in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ' and more' : ''}` : ''} and was undone. Nothing changed.`;
      }
    }
    return { ok: false, error, log };
  }
  return { ok: true, log, ...(url ? { url } : {}) };
}

/**
 * What opens a terminal in a folder (Open terminal in the worktree menu): Windows Terminal, else a plain console
 * window; iTerm when installed, else Terminal, on a Mac (2026-10-12); the desktop's default on Linux. Pure, so the choice
 * is tested without opening anything. The choice itself lives in src/platform.js (the same one serves Open in a terminal).
 */
export function terminalCommand(platform, dir, opts) {
  return platformTerminalCommand(platform, dir, opts);
}

/* ---------- the engine's view of all repositories ---------- */

/**
 * Which repositories the engine knows and what it last saw of them. snapshot() is what the `worktrees` event
 * carries: every repository some session or pane ran in (found from files, no git), each with its worktrees; the
 * numbers (stats) only for linked repositories and for the folders named in `stats` (open panes). Results are kept
 * for ttlMs, so a refresh every 30 s and a window asking at the same moment cost one pass.
 */
export class WorktreeIndex {
  constructor({ meta = new WtMeta(), ttlMs = 20000, now = Date.now } = {}) {
    this.meta = meta;
    this.ttl = ttlMs;
    this.now = now;
    /** repo id -> { at, key, rec } */
    this.cache = new Map();
    /** cwd -> { at, info } (findRepo answers, a minute) */
    this.infos = new Map();
    /** The records of the last snapshot, for knownPath and repoOf. */
    this.last = [];
    /** repo id + request -> the load in flight (2026-10-15): a timer and a window asking at once share one pass. */
    this.pending = new Map();
  }

  /** findRepo for a cwd, remembered for a minute (a folder's repository rarely changes). */
  info(cwd) {
    const k = pathKey(cwd);
    const hit = this.infos.get(k);
    if (hit && this.now() - hit.at < 60000) return hit.info;
    const info = findRepo(cwd);
    this.infos.set(k, { at: this.now(), info });
    if (this.infos.size > 5000) this.infos.clear();
    return info;
  }

  /**
   * @param {object} o
   * @param {string[]} [o.cwds]   every folder worth listing (session folders, pane folders)
   * @param {string[]} [o.stats]  folders whose worktree gets the numbers even in a repository with no linked worktree
   * @param {string[]} [o.full]   folders whose repository is read in full (branches, base): a New worktree sheet
   * @param {boolean} [o.force]   ignore what was kept
   */
  async snapshot({ cwds = [], stats = [], full = [], force = false } = {}) {
    const repos = new Map(); // id -> { info, hint }
    const add = (cwd) => {
      const info = this.info(cwd);
      if (info) repos.set(repoId(info.commonDir), { info, hint: info.top });
    };
    for (const c of cwds) if (c) add(c);
    const mark = (list, into) => {
      for (const c of list) {
        const info = c ? this.info(c) : null;
        if (!info) continue;
        const id = repoId(info.commonDir);
        if (!repos.has(id)) repos.set(id, { info, hint: info.top });
        if (!into.has(id)) into.set(id, new Set());
        into.get(id).add(pathKey(info.top));
      }
    };
    const statsBy = new Map(); // id -> Set(pathKey of worktree roots)
    mark(stats, statsBy);
    const fullBy = new Map();
    mark(full, fullBy);
    const ids = [...repos.keys()];
    const made = await pool(ids, 4, (id) => {
      const { info, hint } = repos.get(id);
      return this.load(id, info, hint, statsBy.get(id) || new Set(), fullBy.has(id), force);
    });
    this.last = made.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    for (const id of [...this.cache.keys()]) if (!repos.has(id)) this.cache.delete(id);
    return this.last;
  }

  /** One repository's record, kept for ttlMs per (folders with numbers, full) request. */
  async load(id, info, hint, want, isFull, force = false) {
    const key = `${[...want].sort().join('|')}#${isFull ? 'F' : ''}`;
    const hit = this.cache.get(id);
    if (!force && hit && hit.key === key && this.now() - hit.at < this.ttl) return hit.rec;
    const k = `${id}\n${key}`;
    if (this.pending.has(k)) return this.pending.get(k);
    const job = loadRepo(info, { wantStats: (p) => want.has(pathKey(p)), full: isFull, meta: this.meta, hint })
      .then((rec) => { this.cache.set(id, { at: this.now(), key, rec }); return rec; })
      .finally(() => { this.pending.delete(k); });
    this.pending.set(k, job);
    return job;
  }

  /** The record of the repository holding `p`, with numbers for the worktree at `p`'s root: { rec, wt } or null. */
  async recordFor(p) {
    const info = p ? this.info(p) : null;
    if (!info) return null;
    const rec = await this.load(repoId(info.commonDir), info, info.top, new Set([pathKey(info.top)]), true);
    const wt = rec?.worktrees?.find((w) => samePath(w.path, info.top)) || null;
    return { rec, wt, top: info.top };
  }

  /** The last snapshot's repository that holds this folder, or null. */
  repoOf(p) {
    if (!p) return null;
    return this.last.find((r) => r.worktrees.some((w) => isInside(p, w.path))) || null;
  }

  /** This folder is a known worktree or in one (a phone may start a conversation there). */
  knownPath(p) {
    return Boolean(this.repoOf(p));
  }

  /** A full, fresh record of the repository holding `p` with numbers for every worktree: what a plan is made from. */
  async fresh(p) {
    const info = p ? findRepo(p) : null;
    if (!info) return null;
    return loadRepo(info, { wantStats: () => true, full: true, meta: this.meta, hint: info.top });
  }

  /** Forget what was kept (after an action changed something). */
  invalidate() {
    this.cache.clear();
  }
}
