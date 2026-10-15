/**
 * Git worktrees through the engine and the phone policy (2026-10-12; worktrees.js, engine.js "git worktrees",
 * remote-policy.js). The engine runs as a background host with a stand-in Agent SDK (as in apaki-drift.test.js),
 * a window connects, and the ops are driven over the wire against temp repositories made here:
 *
 *   worktrees        a pane's folder is found, its worktrees listed with numbers; the new state is sent to everyone
 *   worktreePlan     what an action will do, without doing it
 *   worktreeRun      plans again and refuses what the plan blocks; remembers the base of a worktree it made
 *   worktreeDiff     per file patches
 *   the phone        which ops a phone has, at which access level, and for which folders (checkPhoneCommand)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectHost, readHostInfo } from '../apaki/engine/host.js';
import { BROADCAST_EVENTS, PHONE_OPS, WORKTREE_KINDS, checkPhoneCommand, routeEvent } from '../apaki/engine/remote-policy.js';
import { KINDS } from '../apaki/engine/worktrees.js';

const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wte-cfg-'));
fs.writeFileSync(path.join(CONFIG_HOME, 'gitconfig'), '[user]\n\tname = Apaki Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(CONFIG_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
test.after(() => fs.rmSync(CONFIG_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* still in use */ } };
async function until(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(step);
  }
}
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const REAL_SDK = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
const FAKE_SDK = `export * from ${JSON.stringify(REAL_SDK)};
export function query() { const it = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } };
  return Object.assign(it, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, supportedCommands: async () => [], getContextUsage: async () => ({ percentage: 1, categories: [] }) }); }
export async function getSessionInfo(id) { return { sessionId: id, summary: 'Worktree test', cwd: process.cwd() }; }
export async function getSessionMessages() { return []; }
export async function listSessions() { return []; }
export async function renameSession() {}
export function createSdkMcpServer(o = {}) { return { type: 'sdk', name: o.name, instance: {} }; }
export function tool(name, description, inputSchema, handler) { return { name, description, inputSchema, handler }; }
`;
const HOOKS = `export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: new URL('./fake-agent-sdk.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`;
const LOADER = `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`;
const APP = 'apaki-dev-worktrees-test';

async function startHost(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wte-'));
  const claude = path.join(dir, 'claude');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-agent-sdk.mjs'), FAKE_SDK);
  fs.writeFileSync(path.join(fake, 'hooks.mjs'), HOOKS);
  fs.writeFileSync(path.join(fake, 'loader.mjs'), LOADER);
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file, APAKI_ARCHIVE_DIR: path.join(dir, 'archive'),
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(fake, 'loader.mjs')).href, ENGINE, '--host'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    rm(dir);
  });
  await until(() => readHostInfo(file)?.pid === child.pid || child.exitCode !== null, 30000);
  assert.equal(child.exitCode, null, `the host did not start:\n${log}`);
  return { dir, claude, file, log: () => log };
}

/** A repository with a linked worktree, under the host's temp folder. */
function makeRepo(h) {
  const root = path.join(h.dir, 'proj');
  fs.mkdirSync(root);
  g(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'first');
  const wt = path.join(h.dir, 'proj-feat');
  g(root, 'worktree', 'add', '-q', '-b', 'feat', wt);
  return { root, wt };
}

test('end to end: the pane\'s folder is found, worktrees are listed with numbers, actions are planned and run through the engine', { timeout: 180000 }, async (t) => {
  const h = await startHost(t);
  const { root, wt } = makeRepo(h);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'n1\nn2\n');
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });
  let from = w.events.length;
  w.send({ op: 'open', reqId: 'o1', paneId: 'p1', sessionId: null, cwd: wt, warm: false });
  await w.next((m) => m.ev === 'opened' && m.paneId === 'p1', 15000, from);

  // The list: the repository the pane is in, both worktrees, numbers for the pane's.
  from = w.events.length;
  w.send({ op: 'worktrees', reqId: 'w1' });
  const list = await w.next((m) => m.ev === 'worktrees' && m.reqId === 'w1', 30000, from);
  assert.equal(list.repos.length, 1);
  const repo = list.repos[0];
  assert.equal(repo.name, 'proj');
  assert.equal(repo.linked, true);
  assert.deepEqual(repo.worktrees.map((x) => [x.main, x.branch]), [[true, 'main'], [false, 'feat']]);
  const feat = repo.worktrees[1];
  assert.deepEqual([feat.added, feat.removed, feat.files], [4, 1, 2], '+3 -1 in a.txt (one line stays) and the two lines of the new file');
  assert.equal(feat.base, 'main');

  // A plan changes nothing.
  const target = path.join(h.dir, 'proj.worktrees', 'fix-checkout');
  from = w.events.length;
  w.send({ op: 'worktreePlan', reqId: 'pl1', kind: 'create', repo: root, branch: 'fix-checkout', base: 'main' });
  const plan = await w.next((m) => m.ev === 'worktreePlan' && m.reqId === 'pl1', 20000, from);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.commands.length, 1);
  assert.match(plan.commands[0], /^git worktree add -b fix-checkout .*fix-checkout main$/);
  assert.equal(plan.steps, undefined, 'the window gets the commands, not the engine\'s steps');
  assert.equal(plan.repo.base, 'main');
  assert.ok(plan.repo.branches.includes('feat'));
  assert.equal(fs.existsSync(target), false, 'planning made nothing');

  // Running it: the worktree exists, the base is remembered, and everyone is told the new state.
  from = w.events.length;
  w.send({ op: 'worktreeRun', reqId: 'ru1', kind: 'create', repo: root, branch: 'fix-checkout', base: 'main' });
  const done = await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru1', 30000, from);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.branch, 'fix-checkout');
  assert.ok(fs.existsSync(path.join(target, 'a.txt')));
  assert.deepEqual(done.log.map((l) => l.cmd), plan.commands, 'what ran is what the plan showed');
  const pushed = await w.next((m) => m.ev === 'worktrees' && !m.reqId && m.repos[0]?.worktrees.length === 3, 20000, from);
  assert.ok(pushed.repos[0].worktrees.some((x) => x.branch === 'fix-checkout'));
  const meta = JSON.parse(fs.readFileSync(path.join(h.claude, 'latch', 'apaki-worktrees.json'), 'utf8'));
  const note = Object.values(meta).find((x) => x.branch === 'fix-checkout');
  assert.equal(note.base, 'main');
  assert.match(note.startSha, /^[0-9a-f]{40}$/);

  // Refusals come from the engine, not from the client: dirty work, the main checkout, work that exists nowhere else.
  from = w.events.length;
  w.send({ op: 'worktreeRun', reqId: 'ru2', kind: 'remove', path: wt });
  const refused = await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru2', 20000, from);
  assert.equal(refused.ok, false);
  assert.ok(refused.blockers.some((b) => /uncommitted/.test(b)), refused.blockers.join('|'));
  assert.ok(refused.blockers.some((b) => /conversation is open in it/.test(b)), 'the pane open in it keeps it');
  assert.ok(fs.existsSync(wt));
  w.send({ op: 'worktreeRun', reqId: 'ru3', kind: 'remove', path: root });
  assert.ok((await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru3', 20000, from)).blockers.some((b) => /main checkout/.test(b)));
  w.send({ op: 'worktreeRun', reqId: 'ru4', kind: 'commit', path: target, message: 'nothing' });
  assert.ok((await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru4', 20000, from)).blockers.some((b) => /Nothing to commit/.test(b)));
  w.send({ op: 'worktreeRun', reqId: 'ru5', kind: 'rm-rf', path: root });
  assert.equal((await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru5', 20000, from)).ok, false, 'an unknown action does nothing');

  // Commit in the pane's worktree, then the diff since main shows it and the new file.
  from = w.events.length;
  w.send({ op: 'worktreeRun', reqId: 'ru6', kind: 'commit', path: wt, message: 'Edit and add' });
  const committed = await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru6', 30000, from);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(g(wt, 'log', '-1', '--format=%s'), 'Edit and add');
  w.send({ op: 'worktreeDiff', reqId: 'd1', path: wt });
  const diff = await w.next((m) => m.ev === 'worktreeDiff' && m.reqId === 'd1', 20000, from);
  assert.equal(diff.ok, true);
  assert.equal(diff.branch, 'feat');
  assert.deepEqual(diff.files.map((f) => f.path), ['a.txt', 'new.txt']);
  assert.match(diff.files[0].patch, /-two\n\+TWO/);
  w.send({ op: 'worktreeDiff', reqId: 'd2', path: path.join(h.dir, 'not-a-repo') });
  assert.equal((await w.next((m) => m.ev === 'worktreeDiff' && m.reqId === 'd2', 20000, from)).ok, false);

  // Merge it into main from the main checkout: nothing pushed, the worktree stays.
  from = w.events.length;
  w.send({ op: 'worktreeRun', reqId: 'ru7', kind: 'merge', path: wt });
  const merged = await w.next((m) => m.ev === 'worktreeResult' && m.reqId === 'ru7', 30000, from);
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(g(root, 'log', '-1', '--format=%s'), 'Edit and add');
  assert.ok(fs.existsSync(wt));
  w.close();
  assert.ok(!/TypeError|ReferenceError|SyntaxError/.test(h.log()), h.log().slice(-600));
});

// 2026-10-15: the worktree git runs on the engine's worker thread, and host-ctl status says how the engine's thread is doing.
test('host-ctl status shows the event loop delay, the processes started per minute, and the worktree worker', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const { root } = makeRepo(h);
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  const from = w.events.length;
  w.send({ op: 'worktrees', reqId: 'w1', cwd: root });
  const list = await w.next((m) => m.ev === 'worktrees' && m.reqId === 'w1', 30000, from);
  assert.equal(list.repos[0]?.worktrees.length, 2);
  // Let the worker's count reach the engine (it reports at most once a second), then ask the way an installer does.
  await sleep(1200);
  const out = execFileSync(process.execPath, [path.join(ROOT, 'apaki', 'engine', 'host-ctl.js'), 'status', '--file', h.file], { encoding: 'utf8', windowsHide: true });
  const st = JSON.parse(out.trim().split('\n').pop());
  assert.equal(st.ok, true, out);
  assert.equal(st.perf.worktrees.mode, 'worker', 'the engine reads worktrees on its worker thread');
  assert.ok(st.perf.worktrees.gitSpawns > 0, JSON.stringify(st.perf.worktrees));
  assert.equal(st.perf.windowMs, 60000);
  const d = st.perf.current.loopDelayMs;
  assert.ok(Object.keys(d).every((k) => ['p50', 'p99', 'max', 'mean', 'samples'].includes(k)), JSON.stringify(d));
  assert.ok(d.samples > 0 && d.p99 >= 0 && d.max >= d.p50, JSON.stringify(d));
  assert.ok(st.perf.current.spawns.worker > 0, JSON.stringify(st.perf.current.spawns));
  w.close();
});

/* ---------- the phone ---------- */

const DEV = 'abcdefghijklmnopqrstuv';
const known = new Set(['C:\\work\\proj', 'C:\\work\\proj.worktrees\\feat']);
const ctx = (cap, extra = {}) => ({ deviceId: DEV, cap, knownCwd: (p) => known.has(p), ...extra });

test('the phone has the four worktree ops, never the terminal; kinds match the engine', () => {
  for (const op of ['worktrees', 'worktreeDiff', 'worktreePlan', 'worktreeRun']) assert.ok(PHONE_OPS.includes(op), op);
  assert.ok(!PHONE_OPS.includes('worktreeTerminal') && !PHONE_OPS.includes('revealFolder'), 'a phone opens no windows on the PC');
  assert.deepEqual([...WORKTREE_KINDS], [...KINDS]);
  assert.ok(!BROADCAST_EVENTS.has('worktreePlan') && !BROADCAST_EVENTS.has('worktreeResult'), 'plans and results go to whoever asked');
});

test('the phone policy: reading at every access level, actions only with Full, only for folders the PC lists', () => {
  const folder = 'C:\\work\\proj.worktrees\\feat';
  for (const cap of ['full', 'noshell', 'chat']) {
    const r = checkPhoneCommand({ op: 'worktrees', reqId: 'r1' }, ctx(cap));
    assert.deepEqual(r, { ok: true, cmd: { op: 'worktrees', reqId: `phone:${DEV}:r1`, cwd: null } }, cap);
    assert.equal(checkPhoneCommand({ op: 'worktreeDiff', reqId: 'r2', path: folder, scope: 'head' }, ctx(cap)).cmd.scope, 'head', cap);
  }
  // worktrees takes a folder only if the PC knows it; "full" only comes with a folder.
  assert.equal(checkPhoneCommand({ op: 'worktrees', cwd: folder, full: true, refresh: true }, ctx('full')).cmd.full, true);
  assert.equal(checkPhoneCommand({ op: 'worktrees', cwd: 'C:\\Windows', full: true }, ctx('full')).cmd.cwd, null, 'an unknown folder is dropped, not probed');
  assert.equal(checkPhoneCommand({ op: 'worktrees', full: true }, ctx('full')).cmd.full, undefined);
  for (const bad of [{ path: 'C:\\Windows' }, { path: 5 }, {}, { path: 'x'.repeat(2000) }]) assert.equal(checkPhoneCommand({ op: 'worktreeDiff', ...bad }, ctx('full')).ok, false, JSON.stringify(bad).slice(0, 40));

  // Actions: refused below Full, in words.
  for (const cap of ['noshell', 'chat']) for (const op of ['worktreePlan', 'worktreeRun']) {
    const r = checkPhoneCommand({ op, kind: 'commit', path: folder, message: 'm' }, ctx(cap));
    assert.equal(r.ok, false, `${cap} ${op}`);
    assert.match(r.error, /can look at worktrees and their changes but not create, commit, push, merge or remove them/);
  }
  const ok = (cmd) => checkPhoneCommand({ op: 'worktreeRun', reqId: 'r9', ...cmd }, ctx('full'));
  assert.deepEqual(ok({ kind: 'commit', path: folder, message: 'Fix it', paths: ['a.txt'], extra: 'dropped' }).cmd, { op: 'worktreeRun', reqId: `phone:${DEV}:r9`, kind: 'commit', path: folder, message: 'Fix it', paths: ['a.txt'] });
  assert.deepEqual(ok({ kind: 'create', repo: 'C:\\work\\proj', branch: 'fix-x', base: 'main', path: 'C:\\Windows' }).cmd, { op: 'worktreeRun', reqId: `phone:${DEV}:r9`, kind: 'create', repo: 'C:\\work\\proj', branch: 'fix-x', base: 'main', useExisting: false }, 'create names the repository, never a place to put it');
  assert.deepEqual(ok({ kind: 'remove', path: folder, deleteBranch: true }).cmd.deleteBranch, true);
  assert.equal(ok({ kind: 'push', path: folder }).ok, true);
  assert.deepEqual(ok({ kind: 'pr', path: folder, title: 'T', body: 'B', draft: true, base: 'main' }).cmd.draft, true);
  assert.equal(ok({ kind: 'merge', path: folder, into: 'main' }).cmd.into, 'main');
  for (const bad of [
    { kind: 'rm-rf', path: folder }, { kind: 'commit', path: 'C:\\Windows', message: 'm' }, { kind: 'commit', message: 'm' }, { kind: 'create', repo: folder },
    { kind: 'create', repo: 'C:\\work\\proj', branch: 'x'.repeat(200) }, { kind: 'commit', path: folder, message: 'x'.repeat(6000) },
    { kind: 'commit', path: folder, paths: 'a.txt' }, { kind: 'commit', path: folder, paths: Array.from({ length: 300 }, (_, i) => `f${i}`) },
    { kind: 'pr', path: folder, body: 'b'.repeat(30000) }, { kind: 'merge', path: folder, into: 5 },
  ]) assert.equal(ok(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  assert.equal(checkPhoneCommand({ op: 'worktreeRun', kind: 'push', path: folder }, { deviceId: DEV, cap: 'full' }).ok, false, 'no way to know the folder: refused');
});

test('worktree events: an answer goes to the phone that asked, the new state to everyone', () => {
  const ask = routeEvent({ ev: 'worktrees', reqId: `phone:${DEV}:r1`, repos: [] });
  assert.equal(ask.deviceId, DEV);
  assert.equal(ask.ev.reqId, 'r1');
  assert.equal(routeEvent({ ev: 'worktrees', reqId: null, repos: [] }), null, 'no phone asked: the desktop gets it, and every phone through the broadcast');
  assert.equal(routeEvent({ ev: 'worktreeResult', reqId: `phone:${DEV}:r2`, ok: true }).deviceId, DEV);
  assert.ok(BROADCAST_EVENTS.has('worktrees'));
});
