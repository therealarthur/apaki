/**
 * worktree-bench.mjs: what the engine's worktree refresh costs its main thread, old way against new (2026-10-15).
 *
 * WHY: on Arthur's PC with 4 of 8 panes working, the engine sat at 93% of a core and a CPU profile spent 84% of its time
 * in native spawn, from the worktree refresh (git, about 80 processes in 2 seconds, after every turn and every 30 s).
 * This repeats that load on scratch repositories, without the app: no window, no engine, no Claude Code.
 *
 * What it builds (in a scratch folder under the temp folder, deleted at the end): 3 repositories with 8 to 12 linked
 * worktrees each (10, 9, 11), changed and untracked files in them (some in new folders), commits ahead on some
 * branches. Four panes are "open" (two in alpha, one in beta, one in gamma) and sessions ran in a dozen more folders.
 * A turn ends every 2 s in the next pane, after an edit there. For each mode it measures, for the run's length:
 *   - the main thread's event loop delay (perf_hooks monitorEventLoopDelay): p50, p99, max
 *   - git processes started (and how many of them on the main thread), per minute
 *   - passes completed (worktrees events the engine would have sent)
 * Modes:
 *   old     the engine as it was: worktrees.js from a git ref (default master) on the main thread; a turn end forgets every
 *           repository and reads them all again (wtSoon -> invalidate()), and a 30 s timer
 *   inline  this tree's worktrees.js on the main thread with the new policy (a turn end marks its worktree, hot and
 *           cold ages, fingerprints): what scanning less alone does
 *   new     this tree's engine path: the same policy on the worker thread (worktrees-client.js)
 *
 *   node apaki/scripts/worktree-bench.mjs [seconds=60] [modes=old,inline,new] [old=master] [turn=2000] [json=out.json]
 *
 * (old: the git ref whose worktrees.js is the old way; turn: milliseconds between turn ends; json: also write the results there.)
 *
 * Its git runs with no global or system config (GIT_CONFIG_GLOBAL points at a file it writes), and CLAUDE_CONFIG_DIR
 * points into the scratch folder, so nothing of the user's (~/.claude/latch included) is read or written.
 */

import { execFileSync } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine');

function args(argv) {
  const o = { seconds: 60, modes: ['old', 'inline', 'new'], oldRef: 'master', json: null, turnMs: 2000 };
  for (const a of argv) {
    const eq = a.indexOf('=');
    const [k, v] = eq < 0 ? [a, ''] : [a.slice(0, eq), a.slice(eq + 1)];
    if (k === 'seconds') o.seconds = Number(v);
    else if (k === 'modes') o.modes = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'old') o.oldRef = v;
    else if (k === 'json') o.json = v;
    else if (k === 'turn') o.turnMs = Number(v);
    else throw new Error(`unknown argument ${a} (seconds=, modes=, old=, turn=, json=)`);
  }
  if (!(o.seconds > 0) || !(o.turnMs > 0)) throw new Error('seconds and turn need positive numbers');
  return o;
}

const opts = args(process.argv.slice(2));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wt-bench-'));
const say = (s) => process.stderr.write(`${s}\n`);

// Nothing of the user's: an empty git config, and Apaki's notes in the scratch folder.
fs.writeFileSync(path.join(SCRATCH, 'gitconfig'), '[user]\n\tname = Bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(SCRATCH, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', CLAUDE_CONFIG_DIR: path.join(SCRATCH, 'claude') });

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';

/** One set of repositories for one mode (each mode starts from the same state). */
function buildFixture(dir) {
  const repos = [];
  for (const [name, count] of [['alpha', 10], ['beta', 9], ['gamma', 11]]) {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    g(root, 'init', '-q', '-b', 'main');
    for (let f = 0; f < 20; f++) write(root, `src/f${f}.txt`, lines(30, `${name} f${f}`));
    write(root, 'a0.txt', lines(10, 'a0'));
    g(root, 'add', '-A');
    g(root, 'commit', '-q', '-m', 'first');
    const wts = [];
    for (let k = 1; k <= count; k++) {
      const p = path.join(dir, `${name}.worktrees`, `wt-${k}`);
      g(root, 'worktree', 'add', '-q', '-b', `wt-${k}`, p);
      // Every other branch has a commit of its own (ahead of main).
      if (k % 2 === 0) { write(p, `src/f${k}.txt`, lines(35, `${name} wt${k} committed`)); g(p, 'commit', '-q', '-am', `work ${k}`); }
      // Changed tracked files, an untracked file, and in every third a new folder of files.
      write(p, `src/f${(k + 3) % 20}.txt`, lines(32, `${name} wt${k} edit`));
      write(p, `notes-${k}.md`, lines(5, 'note'));
      if (k % 3 === 0) { write(p, `newdir/x${k}.txt`, lines(4, 'x')); write(p, `newdir/y${k}.txt`, lines(6, 'y')); }
      wts.push(p);
    }
    // main moves on after the branches were made (behind counts).
    write(root, 'a0.txt', lines(12, 'a0 moved'));
    g(root, 'commit', '-q', '-am', 'main moves');
    repos.push({ name, root, wts });
  }
  const [alpha, beta, gamma] = repos;
  const panes = [alpha.wts[0], alpha.wts[1], beta.wts[0], gamma.wts[0]];
  // Folders sessions ran in (the session list's cwds): the roots, the panes' and a dozen more worktrees.
  const sessionCwds = [...repos.map((r) => r.root), ...panes, alpha.wts[4], alpha.wts[7], beta.wts[3], beta.wts[5], gamma.wts[2], gamma.wts[6], gamma.wts[9], path.join(dir, 'not-a-repo')];
  fs.mkdirSync(path.join(dir, 'not-a-repo'), { recursive: true });
  return { repos, panes, sessionCwds };
}

/** master's worktrees.js, importable from the scratch folder (its two relative imports pointed at this tree's files). */
function oldModuleFile() {
  const text = execFileSync('git', ['show', `${opts.oldRef}:apaki/engine/worktrees.js`], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const fixed = text
    .replace("from './host.js'", `from ${JSON.stringify(pathToFileURL(path.join(ENGINE, 'host.js')).href)}`)
    .replace("from '../../src/platform.js'", `from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'platform.js')).href)}`);
  const file = path.join(SCRATCH, 'old-worktrees.mjs');
  fs.writeFileSync(file, fixed);
  return file;
}

const pct = (h, p) => Math.round((h.percentile(p) / 1e6) * 10) / 10;

/**
 * One run: `index` has the engine's WorktreeIndex API. policy 'old' forgets everything at a turn end; 'new' marks the
 * pane's worktree and passes the hot folders. spawns() counts git processes so far.
 */
async function runMode(mode, { index, spawns, policy, fixture }) {
  const { panes, sessionCwds } = fixture;
  let mainSpawns = 0;
  const onSpawn = () => { mainSpawns += 1; };
  diagnostics.subscribe('child_process', onSpawn);
  let passes = 0;
  let sent = '';
  let wtTimer = null;
  const dirty = new Set();
  let stopped = false;
  const inFlight = new Set();

  // engine.js wtRepos + sendWorktrees, for both policies.
  const send = () => {
    const job = (async () => {
      const ask = { cwds: [...new Set([...sessionCwds, ...panes])], stats: [...panes], full: [], force: false };
      if (policy === 'new') ask.hot = [...panes];
      const repos = await index.snapshot(ask);
      passes += 1;
      const h = JSON.stringify(repos);
      if (h !== sent) sent = h;
    })().catch((e) => say(`  ${mode}: pass failed: ${e.message}`));
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
    return job;
  };
  // engine.js wtSoon, as it was (old) and as it is (new).
  const soon = (ms, cwd) => {
    if (policy === 'new' && cwd) dirty.add(cwd);
    if (wtTimer) return;
    wtTimer = setTimeout(() => {
      wtTimer = null;
      if (stopped) return;
      if (policy === 'old') index.invalidate();
      else { for (const c of dirty) index.changed(c); dirty.clear(); }
      send();
    }, ms);
  };

  // The first list (a window connected) and the panes opening.
  await send();
  for (const p of panes) soon(600, p);
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.all([...inFlight]);

  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const spawnsAt = await spawns();
  const mainAt = mainSpawns;
  const passesAt = passes;
  const t0 = Date.now();
  const timer = setInterval(() => send(), 30 * 1000);
  let turn = 0;
  let edits = 0;
  const turnTimer = setInterval(() => {
    // Claude edited a file in this pane's worktree, and its turn ended.
    const p = panes[turn % panes.length];
    turn += 1;
    fs.appendFileSync(path.join(p, 'a0.txt'), `turn ${turn}\n`);
    edits += 1;
    soon(2500, p);
  }, opts.turnMs);
  await new Promise((r) => setTimeout(r, opts.seconds * 1000));
  const secs = (Date.now() - t0) / 1000;
  stopped = true;
  clearInterval(timer);
  clearInterval(turnTimer);
  if (wtTimer) clearTimeout(wtTimer);
  h.disable();
  const result = {
    mode,
    seconds: Math.round(secs),
    turns: edits,
    passes: passes - passesAt,
    loopDelayMs: { p50: pct(h, 50), p99: pct(h, 99), max: Math.round((h.max / 1e6) * 10) / 10, mean: Math.round((h.mean / 1e6) * 10) / 10 },
    gitPerMin: Math.round((((await spawns()) - spawnsAt) * 60) / secs),
    mainThreadSpawnsPerMin: Math.round(((mainSpawns - mainAt) * 60) / secs),
  };
  // Let what was running finish before the next mode (not measured).
  await Promise.all([...inFlight]);
  diagnostics.unsubscribe('child_process', onSpawn);
  return result;
}

async function main() {
  say(`scratch: ${SCRATCH}`);
  const results = [];
  for (const mode of opts.modes) {
    const dir = path.join(SCRATCH, mode);
    fs.mkdirSync(dir, { recursive: true });
    say(`${mode}: building 3 repositories with 30 worktrees...`);
    const fixture = buildFixture(dir);
    const metaFile = path.join(dir, 'apaki-worktrees.json');
    let index;
    let spawns;
    let close = async () => {};
    if (mode === 'old') {
      const old = await import(pathToFileURL(oldModuleFile()).href);
      index = new old.WorktreeIndex({ meta: new old.WtMeta(metaFile) });
      spawns = () => old.counters.spawns;
    } else if (mode === 'inline') {
      const cur = await import(pathToFileURL(path.join(ENGINE, 'worktrees.js')).href);
      index = new cur.WorktreeIndex({ meta: new cur.WtMeta(metaFile) });
      spawns = () => cur.counters.spawns;
    } else if (mode === 'new') {
      const { WorktreeIndexClient } = await import(pathToFileURL(path.join(ENGINE, 'worktrees-client.js')).href);
      const client = new WorktreeIndexClient({ options: { metaFile }, log: say });
      index = client;
      // The worker reports its count at most once a second; asking makes it answer with the count as it is.
      spawns = async () => { await client.call('spawns'); return client.spawns; };
      close = () => client.close();
    } else {
      throw new Error(`unknown mode ${mode}`);
    }
    say(`${mode}: running ${opts.seconds} s, a turn ending every ${opts.turnMs / 1000} s...`);
    const r = await runMode(mode, { index, spawns, policy: mode === 'old' ? 'old' : 'new', fixture });
    await close();
    results.push(r);
    say(`${mode}: ${JSON.stringify(r)}`);
  }
  const head = ['mode', 'p50 ms', 'p99 ms', 'max ms', 'git/min', 'main-thread spawns/min', 'passes', 'turns'];
  const rows = results.map((r) => [r.mode, r.loopDelayMs.p50, r.loopDelayMs.p99, r.loopDelayMs.max, r.gitPerMin, r.mainThreadSpawnsPerMin, r.passes, r.turns]);
  const width = head.map((h, i) => Math.max(String(h).length, ...rows.map((row) => String(row[i]).length)));
  const fmt = (row) => row.map((c, i) => String(c).padStart(width[i])).join('  ');
  process.stdout.write(`${fmt(head)}\n${rows.map(fmt).join('\n')}\n`);
  if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify({ at: new Date().toISOString(), seconds: opts.seconds, results }, null, 2)}\n`);
}

try {
  await main();
} finally {
  // The scratch folder goes, whatever happened (a worktree's files may be held a moment on Windows: retried).
  try { fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { say(`could not remove ${SCRATCH}: ${e.message}`); }
}
