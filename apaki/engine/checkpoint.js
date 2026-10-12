/**
 * checkpoint.js: a git snapshot of a folder at each Claude / Codex switch, and the code diff between two of them.
 *
 * WHY (SWITCH.md, 2026-10-12: "take a git checkpoint at each switch, e.g. refs/apaki/handoff/N. The handoff then
 * includes the actual code diff, not just the other model's description of its edits, and it catches edits you made
 * by hand in between"): the agent that takes over gets the real change, whoever made it.
 *
 * Additive only. The person's working tree, index, branches, HEAD and stash are never touched: the snapshot is staged
 * into a temporary index (GIT_INDEX_FILE, a copy of the real one so unchanged files are not hashed again), written as a
 * tree, committed with `git commit-tree` (no hooks run, no branch moves) and kept under refs/apaki/handoff/<n>, which no
 * branch, log or push shows. A folder that is not in a git repository is skipped. Untracked files are included and
 * ignored files are not, as `git add -A` decides.
 *
 * Every git call: no external diff or textconv programs, no prompts, no pager, Windows without a console window.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the snapshots are kept. */
export const REF_PREFIX = 'refs/apaki/handoff/';
/** Who the snapshot commits say made them: Apaki's own bookkeeping, not the person's work. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Myrlin Apaki', GIT_AUTHOR_EMAIL: 'apaki@localhost', GIT_COMMITTER_NAME: 'Myrlin Apaki', GIT_COMMITTER_EMAIL: 'apaki@localhost' };
const TIMEOUT_MS = 120000;
/** The most of a patch the handoff carries (the full one stays in git: `git diff <a> <b>`). */
export const PATCH_CHARS = 24000;

/** Runs git in a folder; resolves { ok, out, err, code }. */
export function git(cwd, args, { env = {}, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', '-c', 'diff.external=', ...args], {
      cwd, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', ...env },
    }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || ''), code: err ? (err.code ?? 1) : 0 }));
  });
}

/** The top of the repository a folder is in, or null. */
export async function repoRoot(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok && r.out.trim() ? path.resolve(r.out.trim()) : null;
}

/** The next free snapshot number in a repository (1 for the first). */
async function nextNumber(root) {
  const r = await git(root, ['for-each-ref', '--format=%(refname)', REF_PREFIX]);
  let max = 0;
  for (const line of r.out.split('\n')) {
    const n = Number(line.trim().slice(REF_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Takes a snapshot of the folder's repository as it is on disk now.
 * @param {string} cwd
 * @param {{ message?: string }} [o]
 * @returns {Promise<{ ok: true, root, ref, n, commit, head, tree } | { ok: false, skipped?: true, reason }>}
 */
export async function takeCheckpoint(cwd, { message = 'Apaki handoff checkpoint' } = {}) {
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, skipped: true, reason: 'not a git repository' };
  const headR = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const head = headR.ok ? headR.out.trim() : null;
  const realIndex = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const tmp = path.join(os.tmpdir(), `apaki-handoff-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.index`);
  const env = { GIT_INDEX_FILE: tmp };
  try {
    // A copy of the person's index keeps git from hashing every unchanged file again; without one, start from HEAD.
    let seeded = false;
    const src = realIndex.ok ? realIndex.out.trim() : '';
    if (src && fs.existsSync(src)) { try { fs.copyFileSync(src, tmp); seeded = true; } catch { seeded = false; } }
    if (!seeded && head) await git(root, ['read-tree', head], { env });
    let add = await git(root, ['add', '-A', '--', '.'], { env });
    if (!add.ok && seeded) {
      // The copy was caught mid-write by another git: start over from HEAD.
      try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
      if (head) await git(root, ['read-tree', head], { env });
      add = await git(root, ['add', '-A', '--', '.'], { env });
    }
    if (!add.ok) return { ok: false, reason: `git add failed: ${add.err.trim().split('\n').pop()}` };
    const tree = await git(root, ['write-tree'], { env });
    if (!tree.ok) return { ok: false, reason: `git write-tree failed: ${tree.err.trim().split('\n').pop()}` };
    const treeId = tree.out.trim();
    const commit = await git(root, ['commit-tree', treeId, ...(head ? ['-p', head] : []), '-m', message], { env: IDENTITY });
    if (!commit.ok) return { ok: false, reason: `git commit-tree failed: ${commit.err.trim().split('\n').pop()}` };
    const commitId = commit.out.trim();
    // A free number; the empty old value makes update-ref refuse to replace a snapshot another Apaki just took.
    for (let attempt = 0; attempt < 5; attempt++) {
      const n = await nextNumber(root);
      const ref = `${REF_PREFIX}${n}`;
      const up = await git(root, ['update-ref', '-m', 'apaki handoff', ref, commitId, '']);
      if (up.ok) return { ok: true, root, ref, n, commit: commitId, head, tree: treeId };
    }
    return { ok: false, reason: 'could not store the snapshot ref' };
  } finally {
    for (const f of [tmp, `${tmp}.lock`]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  }
}

/**
 * What changed in the repository from `base` to `to` (two commits; base null: everything in `to`).
 * @returns {Promise<{ ok, stat, patch, cut, files: number, commits: string }>}
 *   commits: the one-line log of commits made on the branch between the two snapshots' heads (when both are given)
 */
export async function diffBetween(root, base, to, { patchChars = PATCH_CHARS, baseHead = null, toHead = null } = {}) {
  const range = base ? [base, to] : null;
  const statR = range
    ? await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--stat=160,120', '--find-renames', ...range])
    : await git(root, ['show', '--no-ext-diff', '--no-textconv', '--stat=160,120', '--format=', to]);
  if (!statR.ok) return { ok: false, stat: '', patch: '', cut: false, files: 0, commits: '', reason: statR.err.trim().split('\n').pop() };
  const patchR = range
    ? await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', ...range])
    : await git(root, ['show', '--no-ext-diff', '--no-textconv', '--no-color', '--format=', to]);
  const stat = statR.out.trimEnd();
  const files = stat ? Math.max(0, stat.split('\n').length - 1) : 0;
  let patch = patchR.out;
  const cut = patch.length > patchChars;
  if (cut) patch = `${patch.slice(0, patchChars)}\n[... the rest of the patch is cut here]`;
  let commits = '';
  if (baseHead && toHead && baseHead !== toHead) {
    const log = await git(root, ['log', '--oneline', '--no-decorate', '-n', '30', `${baseHead}..${toHead}`]);
    commits = log.ok ? log.out.trimEnd() : '';
  }
  return { ok: true, stat, patch: patch.trimEnd(), cut, files, commits };
}
