/**
 * Worktree refreshes off the engine's thread, and fewer of them (2026-10-15; worktrees.js, worktrees-client.js,
 * worktrees-worker.js, perf.js). Measured on Arthur's PC with 4 of 8 panes working: the engine at 93% of a core, 84% of a
 * profile in process creation (git, from the worktree refresh), about 80 git processes in 2 seconds.
 *
 *   the worker        answers what the index on the engine's thread answers (snapshot, record, plan, diff), and the
 *                     git runs there, not on the calling thread; it falls back to the calling thread when it cannot run
 *   fingerprints      a second look with nothing changed gives the same records for one status per worktree, and
 *                     sees an edit to a file that was already changed, a new file in a new folder, the base moving
 *   a turn end        marks only its own worktree: other worktrees and other repositories keep their records
 *   the refresh       looks again at hot repositories (an open pane) after the short age, the others after the long one
 *   perf              the event loop's delay and the processes started per minute; a slow minute in the log
 *   the list          a headless session's "typed turns" answer is kept per file version
 *
 * Every repository is a temp one made here, with no global or system git config, removed afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wtp-cfg-'));
fs.writeFileSync(path.join(CONFIG_HOME, 'gitconfig'), '[user]\n\tname = Apaki Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(CONFIG_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
test.after(() => fs.rmSync(CONFIG_HOME, { recursive: true, force: true }));

const { WorktreeIndex, WtMeta, counters, diffOf, findRepo, loadRepo, plan, samePath } = await import('../apaki/engine/worktrees.js');
const { WorktreeIndexClient } = await import('../apaki/engine/worktrees-client.js');
const { createPerfMonitor, delayOf, slowLine } = await import('../apaki/engine/perf.js');
const { hasTypedTurnsKept } = await import('../src/picker.js');

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* still in use */ } };
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const append = (root, file, text) => fs.appendFileSync(path.join(root, file), text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A folder of its own for one test, removed afterwards. */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wtp-'));
  t.after(() => rmrf(dir));
  return dir;
}

/** A repository `name` in `dir` with one commit on main and linked worktrees on new branches. */
function repoWith(dir, name, branches = []) {
  const root = path.join(dir, name);
  fs.mkdirSync(root);
  g(root, 'init', '-q', '-b', 'main');
  write(root, 'a.txt', 'one\ntwo\nthree\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'first');
  const wts = {};
  for (const b of branches) {
    const p = path.join(dir, `${name}-wt`, b);
    g(root, 'worktree', 'add', '-q', '-b', b, p);
    wts[b] = p;
  }
  return { root, wts };
}

const wtOf = (repos, p) => repos.flatMap((r) => r.worktrees).find((w) => samePath(w.path, p));
const repoNamed = (repos, n) => repos.find((r) => r.name === n);
const numbers = (w) => [w.added, w.removed, w.files, w.changed, w.ahead, w.behind];
const fullLoad = (p, extra = {}) => { const info = findRepo(p); return loadRepo(info, { wantStats: () => true, full: true, hint: info.top, ...extra }); };

/* ---------- the worker ---------- */

test('the worker answers what the index on this thread answers, and the git runs on the worker', { timeout: 120000 }, async (t) => {
  const dir = scratch(t);
  const { root, wts } = repoWith(dir, 'proj', ['feat', 'fix']);
  write(wts.feat, 'a.txt', 'one\nTWO\nthree\nfour\n');
  write(wts.feat, 'newdir/n.txt', 'n1\nn2\n');
  write(wts.fix, 'b.txt', 'b\n');
  g(wts.fix, 'add', '-A');
  g(wts.fix, 'commit', '-q', '-m', 'b');
  const lone = path.join(dir, 'lone');
  fs.mkdirSync(lone);
  g(lone, 'init', '-q', '-b', 'main');
  const ask = { cwds: [root, lone], stats: [wts.feat, lone], full: [lone], hot: [wts.feat] };

  // What the index on this thread answers (the engine's path before 2026-10-15).
  const here = new WorktreeIndex({ meta: new WtMeta(path.join(dir, 'meta-here.json')) });
  const expected = await here.snapshot(ask);
  const expectedRecord = await here.recordFor(wts.feat);
  const expectedDiff = await diffOf(wts.feat, { base: 'main' });
  const local = await plan('create', { branch: 'more', base: 'main' }, await here.fresh(root), { run: false, openCwds: [] });

  const client = new WorktreeIndexClient({ options: { metaFile: path.join(dir, 'meta-worker.json') } });
  t.after(() => client.close());
  const before = counters.spawns;
  const got = await client.snapshot(ask);
  assert.equal(client.mode, 'worker');
  assert.deepEqual(got, expected, 'the same snapshot as the index on this thread');
  assert.equal(counters.spawns, before, 'no git process started on this thread');
  assert.ok(client.spawns > 0, `the worker reported its git processes (${client.spawns})`);
  assert.equal(client.knownPath(path.join(wts.feat, 'newdir')), true, 'knownPath answers from the last snapshot, with no round trip');
  assert.equal(client.repoOf(wts.fix).name, 'proj');
  assert.equal(client.knownPath(path.join(dir, 'elsewhere')), false);

  // A record, a diff and a plan: the same as on this thread.
  assert.deepEqual(await client.recordFor(wts.feat), expectedRecord);
  const d = await client.diff(wts.feat, { base: 'main' });
  assert.deepEqual(d, expectedDiff);
  assert.deepEqual(d.files.map((f) => f.path), ['a.txt', 'newdir/n.txt']);
  const viaWorker = await client.plan('create', { branch: 'more', base: 'main' }, root, { run: false, openCwds: [] });
  assert.deepEqual(viaWorker.plan.commands, local.commands);
  assert.deepEqual(viaWorker.plan.blockers, []);
  assert.equal(viaWorker.repo.base, 'main');
  assert.equal(counters.spawns, before, 'still none on this thread');

  // An action runs on the worker, and its note (the base it came from) is written there.
  const ran = await client.execute(viaWorker.plan);
  assert.equal(ran.ok, true, JSON.stringify(ran));
  await client.after(viaWorker.plan);
  const note = JSON.parse(fs.readFileSync(path.join(dir, 'meta-worker.json'), 'utf8'));
  assert.equal(Object.values(note)[0].base, 'main');
  await client.invalidate(root);
  const after = await client.snapshot(ask);
  assert.equal(repoNamed(after, 'proj').worktrees.length, 4, 'the new worktree is listed after its repository was forgotten');
});

test('the client answers on this thread when its worker cannot run', { timeout: 60000 }, async (t) => {
  const dir = scratch(t);
  const { root } = repoWith(dir, 'proj', ['feat']);
  const broken = path.join(dir, 'broken-worker.mjs');
  fs.writeFileSync(broken, 'throw new Error("this worker cannot start");\n');
  const logs = [];
  const client = new WorktreeIndexClient({ workerFile: broken, maxRestarts: 1, log: (l) => logs.push(l), options: { metaFile: path.join(dir, 'meta.json') } });
  t.after(() => client.close());
  await assert.rejects(client.snapshot({ cwds: [root] }), /stopped/);
  const repos = await client.snapshot({ cwds: [root] });
  assert.equal(client.mode, 'inline');
  assert.equal(repos[0].worktrees.length, 2);
  assert.ok(logs.some((l) => /own thread/.test(l)), logs.join('\n'));
});

/* ---------- fingerprints ---------- */

test('a second look with nothing changed costs one status per worktree and gives the same records; real changes are seen', { timeout: 120000 }, async (t) => {
  const dir = scratch(t);
  const { root, wts } = repoWith(dir, 'proj', ['feat', 'fix']);
  write(wts.feat, 'a.txt', 'one\nTWO\nthree\n');
  write(wts.fix, 'c.txt', 'c\n');
  const first = await fullLoad(root);
  let before = counters.spawns;
  const again = await fullLoad(root, { prev: first });
  // The list, the refs, the remotes, and one status for each of the three worktrees.
  assert.equal(counters.spawns - before, 6, 'list + refs + remote + 3 status');
  assert.deepEqual(again, first);

  // A file that was already changed changes again: status reads the same, the numbers do not. Its commits did not
  // move, so only its lines are counted again (one diff), not the counts against the base.
  append(wts.feat, 'a.txt', 'four\nfive\n');
  before = counters.spawns;
  const edited = await fullLoad(root, { prev: again });
  assert.equal(counters.spawns - before, 7, 'list + refs + remote + 3 status + one diff for the edited worktree');
  assert.deepEqual(edited, await fullLoad(root), 'the same records as a look from scratch');
  assert.equal(wtOf([edited], wts.feat).added, 3);

  // A new file inside a new folder (status shows only the folder).
  write(wts.fix, 'deep/one.txt', '1\n');
  let prev = await fullLoad(root, { prev: edited });
  write(wts.fix, 'deep/two.txt', '1\n2\n3\n');
  before = counters.spawns;
  const deeper = await fullLoad(root, { prev });
  assert.equal(wtOf([deeper], wts.fix).added, 1 + 1 + 3, 'c.txt, deep/one.txt and the new deep/two.txt');
  assert.deepEqual(deeper, await fullLoad(root));
  prev = deeper;
  before = counters.spawns;
  assert.deepEqual(await fullLoad(root, { prev }), deeper);
  assert.equal(counters.spawns - before, 7, 'list + refs + remote + 3 status + the folder listed file by file');

  // The base moves: a worktree whose own files did not change is behind now.
  write(root, 'm.txt', 'm\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'main moves');
  const moved = await fullLoad(root, { prev });
  assert.equal(wtOf([moved], wts.feat).behind, 1);
  assert.deepEqual(moved, await fullLoad(root));
});

/* ---------- a turn end, and the refresh ---------- */

/** Two repositories with linked worktrees, an index on a clock the test moves. */
async function twoRepos(t) {
  const dir = scratch(t);
  const A = repoWith(dir, 'alpha', ['a1', 'a2']);
  const B = repoWith(dir, 'beta', ['b1']);
  const clock = { now: 1_000_000 };
  const idx = new WorktreeIndex({ meta: new WtMeta(path.join(dir, 'meta.json')), now: () => clock.now, ttlMs: 20000, coldTtlMs: 300000 });
  // An open pane in alpha's a1: alpha is hot, beta is not.
  const ask = { cwds: [A.root, B.root, A.wts.a1], stats: [A.wts.a1], hot: [A.wts.a1] };
  const first = await idx.snapshot(ask);
  // Every worktree gets a change the index has not seen yet.
  for (const p of [A.wts.a1, A.wts.a2, B.wts.b1]) append(p, 'a.txt', 'more\n');
  return { A, B, clock, idx, ask, first };
}

test('a turn end marks only its own worktree: the other worktrees and the other repositories keep their records', { timeout: 120000 }, async (t) => {
  const { A, B, clock, idx, ask, first } = await twoRepos(t);
  // Inside the age and nothing marked: a pass starts nothing.
  clock.now += 1000;
  let before = counters.spawns;
  assert.deepEqual(await idx.snapshot(ask), first);
  assert.equal(counters.spawns, before, 'nothing marked, nothing old: no git');

  // The turn in a1 ended (engine.js wtSoon -> changed).
  assert.equal(idx.changed(A.wts.a1), true);
  before = counters.spawns;
  const next = await idx.snapshot(ask);
  const spent = counters.spawns - before;
  assert.equal(wtOf(next, A.wts.a1).added, 1, 'the worktree where the turn ended has its new numbers');
  assert.equal(wtOf(next, A.wts.a2).added, 0, 'the other worktree of the same repository was not looked at');
  assert.deepEqual(repoNamed(next, 'beta'), repoNamed(first, 'beta'), 'the other repository was not looked at');
  assert.ok(spent <= 8, `alpha's list and refs and one worktree, not both repositories (${spent} processes)`);
  assert.equal(idx.changed(path.join(path.dirname(A.root), 'not-a-repo')), false);

  // invalidate(p) forgets one repository; beta is read again from scratch, alpha is kept.
  idx.invalidate(B.wts.b1);
  before = counters.spawns;
  const third = await idx.snapshot(ask);
  assert.equal(wtOf(third, B.wts.b1).added, 1, 'beta read again');
  assert.equal(wtOf(third, A.wts.a2).added, 0, 'alpha kept');
});

test('the refresh reads hot repositories again after the short age and leaves the others for the long one', { timeout: 120000 }, async (t) => {
  const { A, B, clock, idx, ask } = await twoRepos(t);
  // Past the short age, inside the long one: alpha (an open pane) is looked at again, beta keeps its record.
  clock.now += 25000;
  const next = await idx.snapshot(ask);
  assert.equal(wtOf(next, A.wts.a1).added, 1);
  assert.equal(wtOf(next, A.wts.a2).added, 1, 'every worktree of a hot repository is looked at again');
  assert.equal(wtOf(next, B.wts.b1).added, 0, 'beta has no open pane: its record stands for minutes');
  // Asked about by a window (its folder in hot): beta is looked at as soon as its short age is over too.
  const asked = await idx.snapshot({ ...ask, hot: [A.wts.a1, B.wts.b1] });
  assert.equal(wtOf(asked, B.wts.b1).added, 1);
  // Past the long age every repository is looked at again.
  append(B.wts.b1, 'a.txt', 'again\n');
  clock.now += 301000;
  const later = await idx.snapshot(ask);
  assert.equal(wtOf(later, B.wts.b1).added, 2);
  // Left out, hot means every repository (the behaviour before 2026-10-15).
  append(B.wts.b1, 'a.txt', 'and again\n');
  clock.now += 21000;
  assert.equal(wtOf(await idx.snapshot({ cwds: ask.cwds, stats: ask.stats }), B.wts.b1).added, 3);
});

/* ---------- perf ---------- */

test('perf: the event loop delay and the processes started per minute; a slow minute leaves a line in the log', { timeout: 30000 }, async () => {
  const lines = [];
  let worker = 10;
  const mon = createPerfMonitor({ timer: false, resolutionMs: 10, log: (l) => lines.push(l), workerSpawns: () => worker });
  try {
    await sleep(60);
    // The thread is held up for 300 ms, a process starts, and the worker reports 5 git processes.
    const end = Date.now() + 300;
    while (Date.now() < end) { /* busy */ }
    await sleep(60);
    await new Promise((r) => execFile(process.execPath, ['-e', ''], { windowsHide: true }, () => r()));
    worker += 5;
    const st = mon.status();
    assert.ok(st.current.loopDelayMs.max >= 250, `the 300 ms block shows (${st.current.loopDelayMs.max} ms)`);
    const w = mon.rotate();
    assert.ok(w.loopDelayMs.p99 >= 250 && w.loopDelayMs.max >= 250, JSON.stringify(w.loopDelayMs));
    assert.equal(w.spawns.main, 1);
    assert.equal(w.spawns.worker, 5);
    assert.equal(w.spawns.total, 6);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /p99 \d+(\.\d)? ms/);
    assert.deepEqual(mon.status().lastMinute, w);
    // A quiet minute: nothing logged.
    await sleep(80);
    const quiet = mon.rotate();
    assert.ok(quiet.loopDelayMs.max < 200, JSON.stringify(quiet.loopDelayMs));
    assert.equal(quiet.spawns.total, 0);
    assert.equal(lines.length, 1);
  } finally {
    mon.stop();
  }
  assert.deepEqual(delayOf(null), { p50: null, p99: null, max: null, mean: null, samples: 0 });
  assert.equal(slowLine({ loopDelayMs: { p99: 150 } }), null);
});

/* ---------- the session list ---------- */

test('a headless session\'s "typed turns" answer is kept per file version', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"type":"user","entrypoint":"cli"}\n');
  assert.equal(hasTypedTurnsKept(file, 10, 1), true);
  fs.writeFileSync(file, '{"type":"user","entrypoint":"sdk-py"}\n');
  assert.equal(hasTypedTurnsKept(file, 10, 1), true, 'the same version: kept, not read again');
  assert.equal(hasTypedTurnsKept(file, 11, 2), false, 'a new version is read');
  const st = fs.statSync(file);
  assert.equal(hasTypedTurnsKept(file), false, 'without a version it is taken from the file');
  fs.writeFileSync(file, '{"type":"user","entrypoint":"cli"}\n{"x":1}\n');
  fs.utimesSync(file, new Date(), new Date(st.mtimeMs + 5000));
  assert.equal(hasTypedTurnsKept(file), true);
  assert.equal(hasTypedTurnsKept(path.join(dir, 'gone.jsonl')), false);
});
