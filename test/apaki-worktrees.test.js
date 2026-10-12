/**
 * Git worktrees in the engine (2026-10-12, apaki/engine/worktrees.js; design apaki/remote/WORKTREES.md, build
 * order steps 1 and 4). Every test that touches git runs on a temp repository made here, with the user's own git
 * but no global or system config and an identity of its own, and removes it afterwards.
 *
 *   parsing           git worktree list --porcelain (with and without -z), status v2, numstat, patches
 *   names and places  branch names, folder names, Claude Code's place or the <repo>.worktrees sibling
 *   looking           findRepo reads files only; a repository with no linked worktree costs no process;
 *                     numbers against the base (lines, files, ahead and behind, unpushed, merged)
 *   create            the plan shows the exact command it runs; blockers; an existing branch
 *   remove            refuses the main checkout, a dirty, locked, unpushed or in-use worktree; never --force
 *   commit, push      the files first; a message is required to run; a subset; push never forces
 *   merge             predicts conflicts before touching anything; a merge that conflicts anyway is undone
 *   pull request      gh is injected; blockers and the command shown
 *   diff              per file patches, new files included, only what is uncommitted on request
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The user's git config (autocrlf, signing, hooks paths) must not reach these repositories.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wt-cfg-'));
fs.writeFileSync(path.join(CONFIG_HOME, 'gitconfig'), '[user]\n\tname = Apaki Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(CONFIG_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
test.after(() => fs.rmSync(CONFIG_HOME, { recursive: true, force: true }));

const {
  WorktreeIndex, WtMeta, checkBranchName, chooseWorktreePath, counters, diffOf, execute, findRepo, folderFor, fmtCommand, hasLinked, headOf, inspectWorktree,
  isInside, loadRepo, normPath, parseNumstat, parseStatus, parseWorktreeList, plan, predictConflicts, repoId, samePath, splitPatch, terminalCommand,
} = await import('../apaki/engine/worktrees.js');

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* still in use */ } };
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };

/** A repository with one commit (a.txt) on main, in a folder of its own that the test removes. */
function repo(t, files = { 'a.txt': 'one\ntwo\nthree\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wt-'));
  t.after(() => rmrf(dir));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root);
  g(root, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) write(root, f, text);
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'first');
  return { dir, root };
}

/** A worktree on a new branch next to the repository, made with git itself. */
function addWt(r, branch, folder = branch.replace(/\//g, '-')) {
  const p = path.join(r.dir, 'wt', folder);
  g(r.root, 'worktree', 'add', '-q', '-b', branch, p);
  return p;
}

const fullRepo = async (p) => {
  const info = findRepo(p);
  return loadRepo(info, { wantStats: () => true, full: true, hint: info.top });
};
const wtOf = (rec, p) => rec.worktrees.find((w) => samePath(w.path, p));

/* ---------- parsing ---------- */

test('git worktree list --porcelain: branch, detached, bare, locked and prunable, with -z and without', () => {
  const text = [
    'worktree C:/work/proj', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
    'worktree C:/work/proj.worktrees/fix-x', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feat/fix-x', 'locked claude agent is using it', '',
    'worktree C:/work/old', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable gitdir file points to non-existent location', '',
    'worktree C:/work/bare.git', 'bare', '',
  ];
  for (const raw of [`${text.join('\n')}\n`, `${text.join('\0')}\0`]) {
    const l = parseWorktreeList(raw);
    assert.equal(l.length, 4);
    assert.deepEqual([l[0].branch, l[0].detached, l[0].locked, l[0].prunable], ['main', false, null, null]);
    assert.deepEqual([l[1].branch, l[1].locked], ['feat/fix-x', 'claude agent is using it']);
    assert.deepEqual([l[2].branch, l[2].detached, l[2].prunable], ['', true, 'gitdir file points to non-existent location']);
    assert.equal(l[3].bare, true);
    assert.equal(l[0].path, normPath('C:/work/proj'));
  }
  assert.deepEqual(parseWorktreeList(''), []);
  assert.equal(parseWorktreeList('worktree /x\nlocked\n')[0].locked, 'locked', 'a lock with no reason');
});

test('git status v2: branch lines, every entry kind, renames carry the old name', () => {
  const z = [
    '# branch.oid abc123', '# branch.head fix-x', '# branch.upstream origin/fix-x', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a file.js',
    '1 A. N... 000000 100644 100644 000 ccc new.js',
    '2 R. N... 100644 100644 100644 ddd eee R100 renamed.js\0old name.js',
    'u UU N... 100644 100644 100644 100644 f1 f2 f3 clash.js',
    '? untracked dir/',
  ].join('\0');
  const s = parseStatus(`${z}\0`);
  assert.deepEqual([s.oid, s.head, s.upstream, s.ahead, s.behind], ['abc123', 'fix-x', 'origin/fix-x', 2, 1]);
  assert.deepEqual(s.entries.map((e) => [e.kind, e.path]), [['ordinary', 'src/a file.js'], ['ordinary', 'new.js'], ['rename', 'renamed.js'], ['unmerged', 'clash.js'], ['untracked', 'untracked dir/']]);
  assert.equal(s.entries[2].orig, 'old name.js');
  assert.deepEqual([s.conflicts, s.untracked, s.staged, s.unstaged], [1, 1, 2, 1]);
  assert.deepEqual(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').head, '');
  assert.equal(parseStatus('# branch.oid (initial)\0').oid, '');
});

test('numstat and patches: totals, binary files, statuses, renames', () => {
  const n = parseNumstat('3\t1\ta.txt\n-\t-\timg.png\n0\t5\tgone.txt\nnot a line\n');
  assert.deepEqual([n.added, n.removed, n.files.length], [3, 6, 3]);
  assert.equal(n.files[1].binary, true);
  const patch = [
    'diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+ONE',
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+x',
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-y',
    'diff --git a/old.txt b/moved/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to moved/new.txt',
    'diff --git a/pic.png b/pic.png', 'index 1..2 100644', 'Binary files a/pic.png and b/pic.png differ', '',
  ].join('\n');
  const f = splitPatch(patch);
  assert.deepEqual(f.map((x) => [x.path, x.status, x.binary]), [['a.txt', 'M', false], ['new.txt', 'A', false], ['gone.txt', 'D', false], ['moved/new.txt', 'R', false], ['pic.png', 'M', true]]);
  assert.equal(f[3].oldPath, 'old.txt');
  assert.ok(f[0].patch.startsWith('diff --git a/a.txt') && f[0].patch.endsWith('+ONE\n'));
  assert.deepEqual(splitPatch(''), []);
});

/* ---------- names and places ---------- */

test('branch names are checked before git sees them; folders are made safe', () => {
  for (const ok of ['fix-checkout', 'feat/login-v2', 'a.b_c', 'release/1.2']) assert.equal(checkBranchName(ok), null, ok);
  for (const bad of ['', '  ', '-x', '--force', 'a b', 'a..b', 'a//b', '/a', 'a/', 'a.', 'x.lock', 'a/.hidden', 'a@{b', 'sp\u00e4ce', 'x'.repeat(130)]) assert.ok(checkBranchName(bad), JSON.stringify(bad));
  assert.equal(folderFor('feat/login v2'), 'feat-login-v2');
  assert.equal(folderFor('...'), 'worktree');
  assert.equal(fmtCommand('git', ['worktree', 'add', 'C:\\a b\\c', 'x']), 'git worktree add "C:\\a b\\c" x');
  assert.equal(fmtCommand('git', ['commit', '-m', 'two\nlines']), 'git commit -m "two lines"');
  assert.ok(fmtCommand('git', ['commit', '-m', 'x'.repeat(500)]).length < 200, 'a long message is shortened for display');
  assert.ok(isInside(path.join('C:', 'a', 'b'), path.join('C:', 'a')) && !isInside(path.join('C:', 'ab'), path.join('C:', 'a')), 'a sibling with the same prefix is not inside');
});

test('where a new worktree goes: Claude Code\'s folder when the repository has one, else a sibling; taken names count up', (t) => {
  const r = repo(t);
  const repoRec = { root: r.root, commonDir: path.join(r.root, '.git'), worktrees: [] };
  const sib = chooseWorktreePath(repoRec, 'feat/login');
  assert.equal(sib.path, path.join(r.dir, 'proj.worktrees', 'feat-login'));
  assert.equal(sib.insideRepo, false);
  fs.mkdirSync(path.join(r.dir, 'proj.worktrees', 'feat-login'), { recursive: true });
  assert.equal(chooseWorktreePath(repoRec, 'feat/login').path, path.join(r.dir, 'proj.worktrees', 'feat-login-2'), 'a taken folder gets -2');
  fs.mkdirSync(path.join(r.root, '.claude', 'worktrees'), { recursive: true });
  const cc = chooseWorktreePath(repoRec, 'feat/login');
  assert.equal(cc.path, path.join(r.root, '.claude', 'worktrees', 'feat-login'));
  assert.equal(cc.insideRepo, true);
  const viaLinked = chooseWorktreePath({ root: r.root, commonDir: repoRec.commonDir, worktrees: [{ path: path.join(r.root, '.claude', 'worktrees', 'agent-1') }] }, 'x', { exists: () => false });
  assert.equal(viaLinked.insideRepo, true, 'a worktree already living there is enough to follow that convention');
});

/* ---------- looking at a repository ---------- */

test('findRepo reads the files: main checkout, linked worktree, subfolder, not a repository', (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat');
  const main = findRepo(r.root);
  assert.equal(main.linked, false);
  assert.ok(samePath(main.top, r.root) && samePath(main.commonDir, path.join(r.root, '.git')));
  const sub = path.join(r.root, 'deep', 'er');
  fs.mkdirSync(sub, { recursive: true });
  assert.ok(samePath(findRepo(sub).top, r.root), 'a subfolder belongs to the repository above');
  const lw = findRepo(w);
  assert.equal(lw.linked, true);
  assert.ok(samePath(lw.top, w));
  assert.ok(samePath(lw.commonDir, main.commonDir), 'both name the same repository');
  assert.equal(repoId(lw.commonDir), repoId(main.commonDir));
  assert.equal(findRepo(r.dir), null, 'the folder above the repository is not in one');
  assert.equal(findRepo(path.join(r.dir, 'nope')), null);
  assert.equal(findRepo(''), null);
  assert.equal(hasLinked(main.commonDir), true);
  assert.deepEqual(headOf(main.commonDir), { branch: 'main', detached: false, sha: '' });
  assert.equal(headOf(lw.gitDir).branch, 'feat');
});

test('a repository with no linked worktree is read from files: no process starts', async (t) => {
  const r = repo(t);
  const before = counters.spawns;
  const rec = await loadRepo(findRepo(r.root), { hint: r.root });
  assert.equal(counters.spawns, before, 'no git process for a light repository');
  assert.equal(rec.light, true);
  assert.equal(rec.name, 'proj');
  assert.deepEqual(rec.worktrees.map((w) => [w.branch, w.main, w.stats]), [['main', true, false]]);
  assert.ok(samePath(rec.root, r.root));
  // Asked about, the same repository gets its numbers.
  write(r.root, 'a.txt', 'one\nTWO\nthree\nfour\n');
  const rec2 = await loadRepo(findRepo(r.root), { wantStats: () => true, hint: r.root });
  assert.equal(rec2.light, false);
  assert.deepEqual([rec2.base, rec2.worktrees[0].added, rec2.worktrees[0].removed, rec2.worktrees[0].changed], ['main', 2, 1, 1]);
});

test('numbers against the base: lines (new files included), files, ahead and behind, unpushed, merged', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat/x');
  write(w, 'a.txt', 'one\nTWO\nthree\nfour\nfive\n'); // +3 -1
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'edit a');
  write(w, 'b.txt', 'b1\nb2\n'); // an uncommitted tracked file after add: +2
  g(w, 'add', 'b.txt');
  write(w, 'c.txt', 'c1\nc2\nc3\nc4\n'); // untracked: +4
  fs.mkdirSync(path.join(w, 'dir'));
  write(w, 'dir/d.txt', 'd1\n'); // inside an untracked folder: +1
  write(r.root, 'main-only.txt', 'm\n');
  g(r.root, 'add', '-A');
  g(r.root, 'commit', '-q', '-m', 'main moves on');
  const rec = await fullRepo(r.root);
  assert.equal(rec.base, 'main');
  assert.deepEqual(rec.worktrees.map((x) => [x.main, x.branch]), [[true, 'main'], [false, 'feat/x']]);
  const f = wtOf(rec, w);
  assert.deepEqual([f.added, f.removed], [3 + 2 + 4 + 1, 1]);
  assert.equal(f.files, 4, 'a.txt and b.txt tracked, c.txt and dir/d.txt untracked');
  assert.deepEqual([f.ahead, f.behind], [1, 1]);
  assert.equal(f.unpushed, 1, 'its commit exists nowhere else');
  assert.equal(f.merged, false);
  assert.equal(f.changed, 3, 'b.txt, c.txt and the untracked folder');
  const m = wtOf(rec, r.root);
  assert.deepEqual([m.added, m.removed, m.changed, m.ahead, m.behind], [0, 0, 0, 0, 0], 'the main checkout on the base counts only its own uncommitted work');
  assert.ok(rec.branches.includes('feat/x') && rec.branches.includes('main'));
});

test('merged: a branch with commits inside the base is merged; a fresh branch on the base tip is not, until it had work', async (t) => {
  const r = repo(t);
  const fresh = addWt(r, 'fresh');
  const done = addWt(r, 'done');
  write(done, 'x.txt', 'x\n');
  g(done, 'add', '-A');
  g(done, 'commit', '-q', '-m', 'x');
  g(r.root, 'merge', '-q', '--ff-only', 'done');
  const rec = await fullRepo(r.root);
  assert.equal(wtOf(rec, fresh).merged, false, 'no commits of its own yet');
  assert.equal(wtOf(rec, done).merged, true, 'its commit is in main');
  assert.equal(wtOf(rec, done).unpushed, 0, 'nothing is lost: main has it');
  assert.equal(wtOf(rec, done).ahead, 0);
});

test('a worktree whose folder is gone is reported as missing, not as an error that stops the list', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'gone');
  rmrf(w);
  const rec = await fullRepo(r.root);
  const x = wtOf(rec, w);
  assert.equal(x.missing, true);
  assert.ok(x.prunable);
  assert.equal(rec.worktrees.length, 2);
});

test('the index lists every repository a folder belongs to, reuses a pass, and knows worktree paths', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat');
  const lone = path.join(r.dir, 'lone');
  fs.mkdirSync(lone);
  g(lone, 'init', '-q', '-b', 'main');
  const idx = new WorktreeIndex({ meta: new WtMeta(path.join(r.dir, 'meta.json')) });
  const sub = path.join(w, 'sub');
  fs.mkdirSync(sub);
  const cwds = [r.root, sub, lone, path.join(r.dir, 'not-a-repo'), ''];
  const repos = await idx.snapshot({ cwds });
  assert.deepEqual(repos.map((x) => x.name).sort(), ['lone', 'proj']);
  const proj = repos.find((x) => x.name === 'proj');
  assert.equal(proj.linked, true);
  assert.equal(proj.worktrees.length, 2);
  assert.ok(proj.worktrees.every((x) => x.stats), 'a repository with linked worktrees gets numbers for all');
  assert.equal(repos.find((x) => x.name === 'lone').light, true);
  assert.ok(idx.knownPath(sub) && idx.knownPath(w) && idx.knownPath(r.root));
  assert.equal(idx.knownPath(path.join(r.dir, 'not-a-repo')), false);
  assert.equal(idx.repoOf(sub).name, 'proj');
  const before = counters.spawns;
  await idx.snapshot({ cwds });
  assert.equal(counters.spawns, before, 'the second pass inside the ttl starts nothing');
  const again = await idx.snapshot({ cwds, stats: [lone] });
  assert.equal(again.find((x) => x.name === 'lone').worktrees[0].stats, true, 'a folder named in stats gets its numbers');
  idx.invalidate();
  await idx.snapshot({ cwds });
  assert.ok(counters.spawns > before, 'invalidate makes the next pass look again');
});

/* ---------- create ---------- */

test('create: the plan shows the exact command, the run does exactly that, and the base is remembered', async (t) => {
  const r = repo(t);
  const meta = new WtMeta(path.join(r.dir, 'meta.json'));
  const rec = await fullRepo(r.root);
  const p = await plan('create', { branch: 'feat/checkout', base: 'main' }, rec, { meta });
  assert.deepEqual(p.blockers, []);
  const expectPath = path.join(r.dir, 'proj.worktrees', 'feat-checkout');
  assert.equal(p.data.path, expectPath);
  assert.deepEqual(p.commands, [`git worktree add -b feat/checkout ${fmtCommand('', [expectPath]).trim()} main`]);
  assert.match(p.summary, /feat\/checkout/);
  const res = await execute(p);
  assert.equal(res.ok, true);
  assert.deepEqual(res.log.map((l) => l.cmd), p.commands, 'what ran is what was shown');
  assert.ok(fs.existsSync(path.join(expectPath, 'a.txt')));
  assert.equal(g(expectPath, 'branch', '--show-current'), 'feat/checkout');
  assert.equal(g(r.root, 'status', '--porcelain'), '', 'the main checkout is untouched');
  // The same name again: the branch exists now.
  const rec2 = await fullRepo(r.root);
  const again = await plan('create', { branch: 'feat/checkout' }, rec2, { meta });
  assert.ok(again.blockers.some((b) => /already exists/.test(b)));
  assert.equal(again.data.branchExists, true);
  const existing = await plan('create', { branch: 'feat/checkout', useExisting: true }, rec2, { meta });
  assert.ok(existing.blockers.some((b) => /already checked out/.test(b)), 'a branch checked out elsewhere cannot be used twice');
});

test('create: bad names and bases are blockers, an existing branch can be checked out in a new folder', async (t) => {
  const r = repo(t);
  g(r.root, 'branch', 'spare');
  const rec = await fullRepo(r.root);
  for (const [args, re] of [[{ branch: '' }, /Give the branch a name/], [{ branch: '-x' }, /hyphen/], [{ branch: 'a..b' }, /not a valid/], [{ branch: 'ok', base: 'nope' }, /does not exist/], [{ branch: 'ghost', useExisting: true }, /no branch named/]]) {
    const p = await plan('create', args, rec);
    assert.ok(p.blockers.some((b) => re.test(b)), `${JSON.stringify(args)}: ${p.blockers}`);
    assert.deepEqual(await execute(p).then((x) => x.ok), false, 'a blocked plan does not run');
  }
  const p = await plan('create', { branch: 'spare', useExisting: true }, rec);
  assert.deepEqual(p.blockers, []);
  assert.match(p.commands[0], /^git worktree add .*spare$/);
  assert.equal((await execute(p)).ok, true);
  assert.equal(g(p.data.path, 'branch', '--show-current'), 'spare');
});

test('create inside Claude Code\'s folder warns when git does not ignore it', async (t) => {
  const r = repo(t);
  fs.mkdirSync(path.join(r.root, '.claude', 'worktrees'), { recursive: true });
  let rec = await fullRepo(r.root);
  let p = await plan('create', { branch: 'cc' }, rec);
  assert.equal(p.data.path, path.join(r.root, '.claude', 'worktrees', 'cc'));
  assert.ok(p.warnings.some((w) => /not ignore/.test(w)));
  write(r.root, '.gitignore', '.claude/worktrees/\n');
  rec = await fullRepo(r.root);
  p = await plan('create', { branch: 'cc' }, rec);
  assert.deepEqual(p.warnings, []);
});

/* ---------- remove ---------- */

test('remove: refuses the main checkout, a locked, dirty, unpushed or in-use worktree, with the reason', async (t) => {
  const r = repo(t);
  const clean = addWt(r, 'clean');
  const dirty = addWt(r, 'dirty');
  write(dirty, 'new.txt', 'work\n');
  const ahead = addWt(r, 'ahead');
  write(ahead, 'x.txt', 'x\n');
  g(ahead, 'add', '-A');
  g(ahead, 'commit', '-q', '-m', 'only here');
  const locked = addWt(r, 'locked');
  g(r.root, 'worktree', 'lock', '--reason', 'an agent runs here', locked);
  const rec = await fullRepo(r.root);
  const why = async (p, extra = {}) => (await plan('remove', { path: p }, rec, extra)).blockers.join(' | ');
  assert.match(await why(r.root), /main checkout/);
  assert.match(await why(dirty), /uncommitted/);
  assert.match(await why(ahead), /1 commit is not pushed anywhere/);
  assert.match(await why(locked), /locked \(an agent runs here\)/);
  assert.match(await why(clean, { openCwds: [path.join(clean, 'sub')] }), /conversation is open in it/);
  assert.match(await why(path.join(r.dir, 'elsewhere')), /not a worktree of this repository/);
  assert.equal(await why(clean), '', 'a clean worktree with nothing unique may go');
  for (const p of [r.root, dirty, ahead, locked]) assert.equal((await execute(await plan('remove', { path: p }, rec))).ok, false, 'a refused removal does not run');
  assert.ok(fs.existsSync(dirty) && fs.existsSync(ahead) && fs.existsSync(locked), 'nothing was touched');
});

test('remove: git worktree remove without --force; a merged branch can go with it, an unmerged one stays', async (t) => {
  const r = repo(t);
  const merged = addWt(r, 'merged');
  write(merged, 'm.txt', 'm\n');
  g(merged, 'add', '-A');
  g(merged, 'commit', '-q', '-m', 'm');
  g(r.root, 'merge', '-q', '--ff-only', 'merged');
  const fresh = addWt(r, 'fresh');
  const rec = await fullRepo(r.root);
  const p = await plan('remove', { path: merged, deleteBranch: true }, rec);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.commands.length, 2);
  assert.ok(!p.commands.join(' ').includes('--force') && !p.commands.join(' ').includes(' -D '), p.commands.join(' / '));
  assert.match(p.commands[1], /^git branch -d merged$/);
  const res = await execute(p);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!fs.existsSync(merged));
  assert.ok(!g(r.root, 'branch', '--list', 'merged'), 'the merged branch went with it');
  // A branch with no work of its own is not "merged": it is kept, with a word about it.
  const q = await plan('remove', { path: fresh, deleteBranch: true }, rec);
  assert.equal(q.commands.length, 1);
  assert.ok(q.warnings.some((x) => /stays/.test(x)));
  assert.equal((await execute(q)).ok, true);
  assert.ok(g(r.root, 'branch', '--list', 'fresh'), 'the branch stays');
});

test('remove: a worktree whose folder was deleted is cleaned up with prune', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'vanished');
  rmrf(w);
  const rec = await fullRepo(r.root);
  const p = await plan('remove', { path: w }, rec);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.commands, ['git worktree prune']);
  assert.equal((await execute(p)).ok, true);
  assert.equal((await fullRepo(r.root)).worktrees.length, 1);
});

/* ---------- commit and push ---------- */

test('commit: lists the files first, needs a message to run, can take a chosen subset', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'work');
  write(w, 'a.txt', 'changed\n');
  write(w, 'new.txt', 'new\n');
  write(w, 'skip.txt', 'skip\n');
  const rec = await fullRepo(r.root);
  const p = await plan('commit', { path: w }, rec, { run: false });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.data.files.map((f) => [f.path, f.status]).sort(), [['a.txt', 'M'], ['new.txt', '?'], ['skip.txt', '?']]);
  assert.deepEqual(p.commands, ['git add -A', 'git commit -m "<message>"']);
  const needs = await plan('commit', { path: w }, rec, { run: true });
  assert.ok(needs.blockers.some((b) => /commit message/.test(b)));
  assert.equal((await execute(needs)).ok, false);
  const subset = await plan('commit', { path: w, message: 'Take two files', paths: ['a.txt', 'new.txt'] }, rec, { run: true });
  assert.deepEqual(subset.blockers, []);
  assert.deepEqual(subset.commands, ['git add -- a.txt new.txt', 'git commit -m "Take two files" -- a.txt new.txt']);
  const res = await execute(subset);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(g(w, 'log', '-1', '--format=%s'), 'Take two files');
  assert.equal(g(w, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(','), 'a.txt,new.txt');
  assert.equal(g(w, 'status', '--porcelain'), '?? skip.txt', 'the file left out is still there, untouched');
  for (const bad of [[], ['nope.txt']]) {
    const x = await plan('commit', { path: w, message: 'm', paths: bad }, await fullRepo(r.root), { run: true });
    assert.ok(x.blockers.length, JSON.stringify(bad));
  }
  const all = await plan('commit', { path: w, message: 'Everything else' }, await fullRepo(r.root), { run: true });
  assert.equal((await execute(all)).ok, true);
  assert.equal(g(w, 'status', '--porcelain'), '');
  const none = await plan('commit', { path: w, message: 'again' }, await fullRepo(r.root), { run: true });
  assert.ok(none.blockers.some((b) => /Nothing to commit/.test(b)));
});

test('push: publishes a branch the first time, says when there is nothing to send, warns when behind, never forces', async (t) => {
  const r = repo(t);
  const remote = path.join(r.dir, 'remote.git');
  g(r.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  g(r.root, 'remote', 'add', 'origin', remote);
  g(r.root, 'push', '-q', '-u', 'origin', 'main');
  const w = addWt(r, 'feat');
  write(w, 'f.txt', 'f\n');
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'f');
  let rec = await fullRepo(r.root);
  assert.equal(rec.remote, 'origin');
  let p = await plan('push', { path: w }, rec);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.commands, ['git push -u origin feat']);
  assert.equal((await execute(p)).ok, true);
  assert.match(g(remote, 'branch', '--list', 'feat'), /feat/);
  rec = await fullRepo(r.root);
  assert.equal(wtOf(rec, w).unpushed, 0, 'pushed commits are saved elsewhere');
  p = await plan('push', { path: w }, rec);
  assert.ok(p.blockers.some((b) => /already pushed/.test(b)));
  // Another clone pushes to the same branch: this one is behind, and says so.
  const other = path.join(r.dir, 'other');
  g(r.dir, 'clone', '-q', remote, other);
  g(other, 'checkout', '-q', 'feat');
  write(other, 'g.txt', 'g\n');
  g(other, 'add', '-A');
  g(other, 'commit', '-q', '-m', 'g');
  g(other, 'push', '-q');
  write(w, 'h.txt', 'h\n');
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'h');
  g(w, 'fetch', '-q');
  rec = await fullRepo(r.root);
  p = await plan('push', { path: w }, rec);
  assert.deepEqual(p.commands, ['git push']);
  assert.ok(p.warnings.some((x) => /never forces/.test(x)));
  const res = await execute(p);
  assert.equal(res.ok, false, 'git itself refuses a push that is behind');
  assert.ok(!/force/.test(p.commands.join(' ')));
  assert.match(g(remote, 'log', '-1', '--format=%s', 'feat'), /g/, 'the remote kept the other commit');
  // No remote at all.
  const bare = repo(t);
  const brec = await fullRepo(bare.root);
  assert.ok((await plan('push', { path: bare.root }, brec)).blockers.some((b) => /no remote/.test(b)));
});

/* ---------- merge ---------- */

test('merge: into the base checkout, fast-forward when it can; nothing pushed or deleted', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat');
  write(w, 'f.txt', 'f\n');
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'f');
  const rec = await fullRepo(r.root);
  const p = await plan('merge', { path: w }, rec);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.data.into, 'main');
  assert.deepEqual(p.commands, ['git merge --no-edit feat']);
  assert.ok(samePath(p.steps[0].cwd, r.root), 'it runs in the checkout that has main');
  const res = await execute(p);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(g(r.root, 'log', '-1', '--format=%s'), 'f');
  assert.ok(g(r.root, 'branch', '--list', 'feat'), 'the branch is still there');
  assert.ok(fs.existsSync(w), 'so is the worktree');
  const after = await plan('merge', { path: w }, await fullRepo(r.root));
  assert.ok(after.blockers.some((b) => /already merged/.test(b)));
});

test('merge: conflicts are found before anything is touched, and the run is refused', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat');
  write(w, 'a.txt', 'one\nFEATURE\nthree\n');
  g(w, 'commit', '-q', '-am', 'feature edit');
  write(r.root, 'a.txt', 'one\nMAIN\nthree\n');
  g(r.root, 'commit', '-q', '-am', 'main edit');
  const head = g(r.root, 'rev-parse', 'HEAD');
  const rec = await fullRepo(r.root);
  assert.deepEqual(await predictConflicts(r.root, 'main', 'feat'), ['a.txt']);
  const p = await plan('merge', { path: w }, rec);
  assert.ok(p.blockers.some((b) => /would conflict in a\.txt/.test(b) && /Nothing was changed/.test(b)), p.blockers.join('|'));
  assert.deepEqual(p.data.conflicts, ['a.txt']);
  assert.equal((await execute(p)).ok, false);
  assert.equal(g(r.root, 'rev-parse', 'HEAD'), head);
  assert.equal(g(r.root, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8').replace(/\r/g, ''), 'one\nMAIN\nthree\n');
});

test('merge: a merge that conflicts anyway (git could not predict it) is undone with --abort', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat');
  write(w, 'a.txt', 'one\nFEATURE\nthree\n');
  g(w, 'commit', '-q', '-am', 'feature edit');
  write(r.root, 'a.txt', 'one\nMAIN\nthree\n');
  g(r.root, 'commit', '-q', '-am', 'main edit');
  const head = g(r.root, 'rev-parse', 'HEAD');
  const plain = { ok: true, kind: 'merge', blockers: [], warnings: [], data: {}, steps: [{ bin: 'git', args: ['merge', '--no-edit', 'feat'], cwd: r.root, abortOnFail: true }] };
  const res = await execute(plain);
  assert.equal(res.ok, false);
  assert.match(res.error, /conflicts in a\.txt and was undone\. Nothing changed/);
  assert.deepEqual(res.log.map((l) => l.cmd), ['git merge --no-edit feat', 'git merge --abort']);
  assert.equal(g(r.root, 'rev-parse', 'HEAD'), head);
  assert.equal(g(r.root, 'status', '--porcelain'), '', 'no conflict markers, no merge in progress');
  assert.equal(fs.existsSync(path.join(r.root, '.git', 'MERGE_HEAD')), false);
});

test('merge: needs the base checked out somewhere, a clean base checkout, and something to merge', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'feat');
  write(w, 'f.txt', 'f\n');
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'f');
  write(r.root, 'dirty.txt', 'x\n');
  let p = await plan('merge', { path: w }, await fullRepo(r.root));
  assert.ok(p.blockers.some((b) => /has uncommitted changes/.test(b)), 'a dirty base checkout is not merged into');
  fs.rmSync(path.join(r.root, 'dirty.txt'));
  p = await plan('merge', { path: w, into: 'release' }, await fullRepo(r.root));
  assert.ok(p.blockers.some((b) => /not checked out in any worktree/.test(b)));
  p = await plan('merge', { path: r.root }, await fullRepo(r.root));
  assert.ok(p.blockers.some((b) => /main itself/.test(b)));
  write(w, 'more.txt', 'm\n');
  p = await plan('merge', { path: w }, await fullRepo(r.root));
  assert.deepEqual(p.blockers, []);
  assert.ok(p.warnings.some((x) => /not part of the merge/.test(x)), 'uncommitted work in the branch is not merged, and the plan says so');
});

/* ---------- pull request (gh is injected) ---------- */

test('pull request: needs gh, a sign-in, no open pull request and a title; shows the push and the command', async (t) => {
  const r = repo(t);
  const remote = path.join(r.dir, 'remote.git');
  g(r.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  g(r.root, 'remote', 'add', 'origin', remote);
  g(r.root, 'push', '-q', '-u', 'origin', 'main');
  const w = addWt(r, 'feat/login');
  write(w, 'l.txt', 'l\n');
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'Add login');
  const rec = await fullRepo(r.root);
  const ok = async (a) => (a[0] === '--version' || a[0] === 'auth' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '[]', stderr: '' });
  let p = await plan('pr', { path: w, title: 'Add login', body: 'Login page.', draft: true }, rec, { run: true, runGh: ok });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.commands, ['git push -u origin feat/login', 'gh pr create --base main --head feat/login --title "Add login" --body "Login page." --draft']);
  assert.equal(p.data.suggest.title, 'Add login');
  // Running it: gh answers with the address.
  const seen = [];
  const res = await execute(p, { runner: async (bin, args) => { seen.push(`${bin} ${args[0]}`); return bin === 'gh' ? { code: 0, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(seen, ['git push', 'gh pr']);
  assert.equal(res.url, 'https://github.com/o/r/pull/7');
  // Every way it can be blocked.
  const missing = async () => ({ code: -1, stdout: '', stderr: '', missing: true });
  assert.ok((await plan('pr', { path: w, title: 't' }, rec, { runGh: missing })).blockers.some((b) => /not installed/.test(b)));
  const signedOut = async (a) => (a[0] === 'auth' ? { code: 1, stdout: '', stderr: 'not logged in' } : { code: 0, stdout: '', stderr: '' });
  assert.ok((await plan('pr', { path: w, title: 't' }, rec, { runGh: signedOut })).blockers.some((b) => /not signed in/.test(b)));
  const open = async (a) => (a[0] === 'pr' ? { code: 0, stdout: JSON.stringify([{ url: 'https://github.com/o/r/pull/3', number: 3, title: 'x' }]), stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const dup = await plan('pr', { path: w, title: 't' }, rec, { runGh: open });
  assert.ok(dup.blockers.some((b) => /already open.*pull\/3/.test(b)));
  assert.equal(dup.data.existing.number, 3);
  assert.ok((await plan('pr', { path: w }, rec, { run: true, runGh: ok })).blockers.some((b) => /title/.test(b)));
  assert.ok((await plan('pr', { path: r.root, title: 't' }, rec, { runGh: ok })).blockers.some((b) => /base branch/.test(b)));
  const nothing = addWt(r, 'empty');
  assert.ok((await plan('pr', { path: nothing, title: 't' }, await fullRepo(r.root), { runGh: ok })).blockers.some((b) => /no commits beyond main/.test(b)));
  // Already pushed: only the gh command.
  g(w, 'push', '-q', '-u', 'origin', 'feat/login');
  const pushed = await plan('pr', { path: w, title: 'T' }, await fullRepo(r.root), { runGh: ok });
  assert.deepEqual(pushed.commands.map((c) => c.split(' ')[0]), ['gh']);
});

test('pull request: no remote and a detached HEAD are blockers before gh is asked', async (t) => {
  const r = repo(t);
  let asked = 0;
  const spy = async () => { asked += 1; return { code: 0, stdout: '', stderr: '' }; };
  const w = addWt(r, 'feat');
  const rec = await fullRepo(r.root);
  assert.ok((await plan('pr', { path: w, title: 't' }, rec, { runGh: spy })).blockers.some((b) => /no remote/.test(b)));
  g(w, 'checkout', '-q', '--detach');
  assert.ok((await plan('pr', { path: w, title: 't' }, await fullRepo(r.root), { runGh: spy })).blockers.some((b) => /detached/.test(b)));
  assert.equal(asked, 0);
});

/* ---------- the diff ---------- */

test('diff: per file patches since the base, new files included; head scope shows only what is not committed', async (t) => {
  const r = repo(t, { 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n', 'keep.txt': 'k\n' });
  const w = addWt(r, 'feat');
  write(w, 'a.txt', 'one\nTWO\nthree\n');
  fs.rmSync(path.join(w, 'gone.txt'));
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'edit and delete');
  write(w, 'fresh.txt', 'x1\nx2\n');
  fs.writeFileSync(path.join(w, 'pic.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  write(w, 'keep.txt', 'k\nmore\n');
  const d = await diffOf(w, { base: 'main' });
  assert.equal(d.ok, true);
  assert.deepEqual(d.files.map((f) => [f.path, f.status]), [['a.txt', 'M'], ['fresh.txt', 'A'], ['gone.txt', 'D'], ['keep.txt', 'M'], ['pic.bin', 'A']]);
  const a = d.files.find((f) => f.path === 'a.txt');
  assert.deepEqual([a.added, a.removed], [1, 1]);
  assert.match(a.patch, /^diff --git a\/a\.txt b\/a\.txt[\s\S]*-two\n\+TWO\n/);
  const fresh = d.files.find((f) => f.path === 'fresh.txt');
  assert.equal(fresh.untracked, true);
  assert.match(fresh.patch, /@@ -0,0 \+1,2 @@\n\+x1\n\+x2\n$/);
  assert.equal(d.files.find((f) => f.path === 'pic.bin').binary, true);
  assert.deepEqual([d.added, d.removed], [1 + 2 + 1, 1 + 1], 'a.txt +1 -1, fresh +2, gone -1, keep +1');
  const head = await diffOf(w, { base: 'main', scope: 'head' });
  assert.deepEqual(head.files.map((f) => f.path), ['fresh.txt', 'keep.txt', 'pic.bin'], 'committed work is not in the uncommitted view');
  assert.equal(head.scope, 'head');
  assert.equal((await diffOf(path.join(r.dir, 'missing'), {})).ok, false);
});

test('diff: a huge file is cut and the diff says so', async (t) => {
  const r = repo(t);
  const w = addWt(r, 'big');
  write(w, 'big.txt', `${'line of text\n'.repeat(20000)}`);
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', 'big');
  const d = await diffOf(w, { base: 'main' });
  const f = d.files.find((x) => x.path === 'big.txt');
  assert.equal(f.cut, true);
  assert.ok(f.patch.length <= 81 * 1024);
  assert.equal(f.added, 20000, 'the counts are still whole');
});

test('inspectWorktree: an empty repository and a detached HEAD do not break the numbers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wt-'));
  t.after(() => rmrf(dir));
  g(dir, 'init', '-q', '-b', 'main');
  write(dir, 'x.txt', 'x\n');
  const w = await inspectWorktree({ path: dir, branch: 'main', head: '', detached: false, bare: false, locked: null, prunable: null, main: true }, { base: '' });
  assert.equal(w.error, undefined);
  assert.equal(w.changed, 1);
  assert.equal(w.added, 1, 'an untracked file counts even before the first commit');
  const r = repo(t);
  g(r.root, 'checkout', '-q', '--detach');
  const rec = await fullRepo(r.root);
  assert.equal(rec.worktrees[0].detached, true);
  assert.equal(rec.worktrees[0].branch, '');
});

test('what opens a terminal in a folder', () => {
  assert.equal(terminalCommand('win32', 'C:\\w').cmd, 'wt.exe');
  assert.deepEqual(terminalCommand('win32', 'C:\\w').args, ['-d', 'C:\\w']);
  assert.equal(terminalCommand('win32', 'C:\\w').fallback.cmd, 'cmd.exe');
  assert.deepEqual(terminalCommand('darwin', '/w'), { cmd: 'open', args: ['-a', 'Terminal', '/w'] });
  assert.equal(terminalCommand('linux', '/w').cwd, '/w');
});

test('Apaki\'s notes about the worktrees it made live in its own file, not in the repository', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wt-meta-'));
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'sub', 'apaki-worktrees.json');
  const m = new WtMeta(file);
  assert.equal(m.get('C:\\x\\y'), null);
  m.set('C:\\x\\y', { base: 'develop', startSha: 'abc' });
  const again = new WtMeta(file);
  assert.equal(again.get('C:\\x\\y\\')?.base, 'develop', 'found again with a trailing separator');
  if (process.platform === 'win32') assert.equal(again.get('c:\\X\\Y')?.base, 'develop', 'and with any letter case, as Windows paths are');
  again.forget('C:\\x\\y');
  assert.equal(new WtMeta(file).get('C:\\x\\y'), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(new WtMeta(file).get('C:\\x\\y'), null, 'a damaged file reads as empty');
});
