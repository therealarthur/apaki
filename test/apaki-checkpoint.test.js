/**
 * Git checkpoints at a Claude / Codex switch (apaki/engine/checkpoint.js), 2026-10-12.
 *
 * In throwaway repositories: a snapshot holds the folder as it is on disk (changed, staged and untracked files, not
 * ignored ones) and never touches the person's index, working tree, HEAD or branches; snapshots number up; the diff
 * between two of them is the real change; a folder outside git is skipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REF_PREFIX, diffBetween, git, repoRoot, takeCheckpoint } from '../apaki/engine/checkpoint.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-checkpoint-test-'));
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const run = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', windowsHide: true });

function repo() {
  const dir = tmp();
  run(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.log\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('checkpoint: a snapshot holds the folder as it is and leaves the index, files, HEAD and branches alone', async () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
    run(dir, 'add', 'staged.txt');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
    fs.writeFileSync(path.join(dir, 'secret.log'), 'ignored\n');
    const indexFile = path.join(dir, '.git', 'index');
    const indexBefore = fs.readFileSync(indexFile);
    const headBefore = run(dir, 'rev-parse', 'HEAD').trim();
    const statusBefore = run(dir, 'status', '--porcelain');
    const branchesBefore = run(dir, 'branch', '--list');

    const cp = await takeCheckpoint(dir, { message: 'switch 1' });
    assert.equal(cp.ok, true, cp.reason);
    assert.equal(cp.n, 1);
    assert.equal(cp.ref, `${REF_PREFIX}1`);
    assert.equal(cp.head, headBefore);
    assert.equal(path.resolve(cp.root).toLowerCase(), path.resolve(dir).toLowerCase());

    // Nothing of the person's moved.
    assert.deepEqual(fs.readFileSync(indexFile), indexBefore);
    assert.equal(run(dir, 'rev-parse', 'HEAD').trim(), headBefore);
    assert.equal(run(dir, 'status', '--porcelain'), statusBefore);
    assert.equal(run(dir, 'branch', '--list'), branchesBefore);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
    assert.equal(run(dir, 'stash', 'list'), '');
    assert.ok(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith(`apaki-handoff-${process.pid}-`)), 'the temporary index is gone');

    // The snapshot: the changed, staged and untracked files; not the ignored one; its parent is HEAD.
    assert.equal(run(dir, 'rev-parse', `${REF_PREFIX}1`).trim(), cp.commit);
    assert.equal(run(dir, 'show', `${cp.commit}:a.txt`), 'two\n');
    assert.equal(run(dir, 'show', `${cp.commit}:staged.txt`), 'staged\n');
    assert.equal(run(dir, 'show', `${cp.commit}:new.txt`), 'untracked\n');
    assert.ok(!run(dir, 'ls-tree', '-r', '--name-only', cp.commit).includes('secret.log'));
    assert.equal(run(dir, 'rev-parse', `${cp.commit}^`).trim(), headBefore);
    assert.match(run(dir, 'log', '-1', '--format=%an <%ae> %s', cp.commit), /^Myrlin Apaki <apaki@localhost> switch 1/);

    // The first diff: from HEAD to the snapshot.
    const d1 = await diffBetween(cp.root, cp.head, cp.commit);
    assert.equal(d1.ok, true);
    assert.equal(d1.files, 3);
    assert.match(d1.patch, /-one\n\+two/);
    assert.match(d1.stat, /new\.txt/);

    // An edit by hand, then a commit on the branch, then the second snapshot: numbered 2, and the diff and log between them.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    run(dir, 'add', 'a.txt');
    run(dir, 'commit', '-q', '-m', 'by hand');
    const cp2 = await takeCheckpoint(dir);
    assert.equal(cp2.n, 2);
    const d2 = await diffBetween(cp2.root, cp.commit, cp2.commit, { baseHead: cp.head, toHead: cp2.head });
    assert.match(d2.patch, /-two\n\+three/);
    assert.equal(d2.files, 1);
    assert.match(d2.commits, /by hand/);
    // A small budget cuts the patch and says so.
    const d3 = await diffBetween(cp2.root, cp.head, cp2.commit, { patchChars: 20 });
    assert.equal(d3.cut, true);
    assert.match(d3.patch, /the rest of the patch is cut here/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkpoint: a repository with no commit yet, a subfolder, and a folder outside git', async () => {
  const fresh = tmp();
  const plain = tmp();
  try {
    run(fresh, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(fresh, 'sub'));
    fs.writeFileSync(path.join(fresh, 'sub', 'x.txt'), 'x\n');
    const cp = await takeCheckpoint(path.join(fresh, 'sub'));
    assert.equal(cp.ok, true, cp.reason);
    assert.equal(cp.head, null);
    assert.equal(run(fresh, 'show', `${cp.commit}:sub/x.txt`), 'x\n');
    assert.equal(run(fresh, 'status', '--porcelain').trim(), '?? sub/');
    const d = await diffBetween(cp.root, null, cp.commit);
    assert.equal(d.ok, true);
    assert.match(d.patch, /\+x/);

    const none = await takeCheckpoint(plain);
    assert.deepEqual(none, { ok: false, skipped: true, reason: 'not a git repository' });
    assert.equal(await repoRoot(plain), null);
    assert.equal(await repoRoot(path.join(plain, 'missing')), null);
    assert.equal((await git(plain, ['--version'])).ok, true);
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});
