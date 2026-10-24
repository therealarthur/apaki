/**
 * The console and Open in terminal (2026-10-12, apaki/engine/console.js; Arthur: "a toggle console that transitions a
 * pane to console for either claude or codex SEAMLESSLY ... should be the authentic tui experience", and "an "open in
 * terminal" button to just open the exact session with all settings/effort/models/etc in a terminal window").
 *
 * What is checked here, without a real terminal or a billable turn:
 *   - the one command builder: `claude --resume` with the pane's model, effort, mode and settings, the relay hook for a
 *     pane billed to an API key, and `codex resume` with the pane's model, effort and preset;
 *   - the terminal window launcher (Windows Terminal, else PowerShell);
 *   - the running TUIs with a fake pty: output batching, input, resize, replay for a window that reloads, the busy
 *     signal, and the quit (the TUI's own Ctrl+C twice, then an end by PID only when it does not exit);
 *   - the ownership handoff with a fake runner: the pane's own process lets go before the TUI starts, a running turn
 *     is never cut off without asking, the lock, and the pane taking the conversation back when the TUI ends;
 *   - the phone policy (the console is PC only; consoleView is a read-only look) and the wiring in engine.js and the window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLAUDE_TUI_COMMANDS, applyEnv, claudeCommand, codexCommand, createConsoleControl, createConsoles, heldFile, plainText, readHeld,
  takeBackHeld, terminalLaunch, tuiCommand, writeHeld,
} from '../apaki/engine/console.js';
import { PC_ONLY_OPS, PHONE_OPS, checkPhoneCommand } from '../apaki/engine/remote-policy.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SID = '0e7f4b4e-1111-2222-3333-444455556666';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-console-'));
const tick = (ms = 15) => new Promise((r) => { setTimeout(r, ms); });

/** A pty module whose processes are plain objects: what was written, sizes, kills, and exit on the TUI's own quit. */
function fakePty({ quitOn = '\x03\x03', exitOnKill = true, echo = false } = {}) {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, opts) {
      const h = {
        file, args, opts, pid: 4000 + spawned.length, written: '', sizes: [], killed: 0, exited: false,
        onData(cb) { h.dataCb = cb; }, onExit(cb) { h.exitCb = cb; },
        write(s) { h.written += s; if (echo && s !== '\r') setTimeout(() => h.out(s), 2); if (quitOn && h.written.includes(quitOn)) setTimeout(() => h.exit(0), 3); },
        resize(c, r) { h.sizes.push([c, r]); },
        kill() { h.killed += 1; if (exitOnKill) setTimeout(() => h.exit(1), 3); },
        out(s) { h.dataCb(s); },
        exit(code) { if (h.exited) return; h.exited = true; h.exitCb({ exitCode: code }); },
      };
      spawned.push(h);
      return h;
    },
  };
}

const quick = { flushMs: 2, quitStepMs: 5, quitWaitMs: 60, killWaitMs: 60, readyQuietMs: 20, readyMaxMs: 300 };

/* ---------- the command ---------- */

test('command: claude --resume with the pane\'s model, effort, mode and settings, on its subscription', () => {
  const dir = tmp();
  const c = claudeCommand({
    bin: 'C:/x/claude.exe', sessionId: SID, model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions',
    flagSettings: { autoCompactWindow: 400000 }, credential: { name: 'subscription (via Glass)', key: null, source: 'subscription', follow: true },
    hookFile: 'C:/x/hooks/prompt-relay.js', userHook: false, holderPid: 77, nodeDir: 'C:/node', settingsDir: dir,
  });
  assert.equal(c.file, 'C:/x/claude.exe');
  assert.deepEqual(c.args.slice(0, 7), ['--resume', SID, '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--dangerously-skip-permissions']);
  const file = c.args[c.args.indexOf('--settings') + 1];
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autoCompactWindow: 400000 }, 'Apaki\'s auto-compact choice, no hook on a subscription');
  assert.ok(fs.existsSync(path.join(dir, '_WHY_THIS_IS_HERE.md')), 'the folder says why it is there');
  assert.equal(c.relay, null);
  assert.equal(c.note, null);
  assert.equal(c.envSet.LATCH_LOCK_PID, '77');
  assert.equal(c.envSet.PROMPT_RELAY_FORCE, undefined);
  assert.ok(c.envUnset.includes('PROMPT_RELAY_CHILD'), 'the relay hook runs in an interactive window');
  assert.match(c.display, /^claude --resume 0e7f4b4e.* --settings <settings>$/);
  // The same settings reuse one file.
  const again = claudeCommand({ bin: 'b', sessionId: SID, flagSettings: { autoCompactWindow: 400000 }, credential: { source: 'subscription' }, settingsDir: dir });
  assert.equal(again.args[again.args.indexOf('--settings') + 1], file);
});

test('command: a pane billed to an API key runs the TUI on the live login and relays each message on the key (latch --relay)', () => {
  const dir = tmp();
  const vault = claudeCommand({ bin: 'C:/x/claude.exe', sessionId: SID, mode: 'acceptEdits', credential: { name: "Arthur's Org", key: 'sk-ant-x', source: 'vault' }, hookFile: 'C:/a/hooks/prompt-relay.js', userHook: false, nodeDir: 'C:/node', settingsDir: dir });
  assert.ok(vault.args.includes('--permission-mode'));
  assert.equal(vault.envSet.PROMPT_RELAY_FORCE, '1');
  assert.equal(vault.envSet.PROMPT_RELAY_KEY_WORDS, "Arthur's Org");
  assert.equal(vault.envSet.PROMPT_RELAY_CLAUDE_BIN, 'C:/x/claude.exe');
  assert.equal(vault.pathPrepend, 'C:/node');
  assert.deepEqual(vault.relay, { name: "Arthur's Org", via: 'hook' });
  assert.match(vault.note, /prompt-relay hook/);
  const settings = JSON.parse(fs.readFileSync(vault.args[vault.args.indexOf('--settings') + 1], 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /^node "C:\/a\/hooks\/prompt-relay\.js"$/);
  assert.ok(!JSON.stringify(vault).includes('sk-ant-x'), 'the key itself goes nowhere');
  // Glass made a key live: the live key's words are empty.
  const glass = claudeCommand({ bin: 'b', sessionId: SID, credential: { name: 'Org', key: 'k', source: 'glass' }, userHook: true, settingsDir: dir });
  assert.equal(glass.envSet.PROMPT_RELAY_KEY_WORDS, '');
  assert.equal(glass.relay.via, 'user', 'the user\'s own hook, never twice');
  assert.ok(!glass.args.includes('--settings'));
  // No hook anywhere: the console says why chatting there fails instead of failing silently.
  const none = claudeCommand({ bin: 'b', sessionId: SID, credential: { name: 'Org', key: 'k', source: 'vault' }, userHook: false, hookFile: null, settingsDir: dir });
  assert.equal(none.tone, 'warn');
  assert.match(none.note, /refuses API-key credits/);
  assert.match(claudeCommand({ bin: null }).error, /not found/);
  // A new conversation gets its id up front, so the pane can adopt it.
  const fresh = claudeCommand({ bin: 'b', sessionId: null, newSessionId: SID, credential: { source: 'subscription' }, settingsDir: dir });
  assert.deepEqual(fresh.args.slice(0, 2), ['--session-id', SID]);
});

test('command: codex resume with the pane\'s model, effort and permission preset', () => {
  const c = codexCommand({ codex: { command: 'C:/c/codex.exe', args: [] }, threadId: '019a-thread-1234', model: 'gpt-5.5', effort: 'high', mode: 'full-access', cwd: 'C:/w' });
  assert.equal(c.file, 'C:/c/codex.exe');
  assert.deepEqual(c.args, ['resume', '019a-thread-1234', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"', '-a', 'never', '-s', 'danger-full-access', '-C', 'C:/w']);
  assert.match(c.display, /^codex resume 019a-thread-1234 -m gpt-5\.5/);
  const auto = codexCommand({ codex: { command: 'node', args: ['codex.js'] }, threadId: null, mode: 'auto' });
  assert.deepEqual(auto.args, ['codex.js', '-a', 'on-request', '-s', 'workspace-write']);
  assert.match(codexCommand({ codex: null }).error, /not installed/);
  assert.match(codexCommand({ codex: { command: 'c', args: [] }, threadId: 'x; rm' }).error, /thread id/);
  assert.match(codexCommand({ codex: { command: 'c', args: [] }, model: 'a b' }).error, /model/);
});

test('command: the environment drops what the TUI must not inherit and puts Node first for the hook', () => {
  const env = applyEnv({ PATH: 'C:/win', PROMPT_RELAY_CHILD: '1', KEEP: 'y' }, { envSet: { TERM: 'xterm-256color' }, envUnset: ['PROMPT_RELAY_CHILD'], pathPrepend: 'C:/node' });
  assert.equal(env.PROMPT_RELAY_CHILD, undefined);
  assert.equal(env.KEEP, 'y');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.PATH, `C:/node${path.delimiter}C:/win`);
});

test('command: slash commands that only work in the TUI open the console', () => {
  assert.equal(tuiCommand('claude', '/config'), '/config');
  assert.equal(tuiCommand('claude', '/model'), '/model', 'the picker');
  assert.equal(tuiCommand('claude', '/model opus'), null, 'Apaki sets a named model itself');
  assert.equal(tuiCommand('claude', '/compact'), null, 'the SDK runs it');
  assert.equal(tuiCommand('claude', 'hello /config'), null);
  assert.equal(tuiCommand('codex', '/approvals'), '/approvals');
  assert.equal(tuiCommand('codex', '/approvals auto'), null);
  assert.equal(tuiCommand('codex', '/experimental'), '/experimental');
  for (const c of ['permissions', 'mcp', 'agents', 'hooks', 'memory', 'login']) assert.ok(CLAUDE_TUI_COMMANDS.includes(c), c);
});

test('terminal window: Windows Terminal with PowerShell as the fallback; a semicolon goes through PowerShell', () => {
  const t = terminalLaunch('win32', { cwd: 'C:/w', title: 'Claude Code: x', file: 'C:/node/node.exe', args: ['C:/a/apaki-terminal.mjs', 'C:/s/terminal-1.json'] });
  assert.equal(t.cmd, 'wt.exe');
  assert.deepEqual(t.args, ['-w', 'new', 'new-tab', '-d', 'C:/w', '--title', 'Claude Code: x', '--', 'C:/node/node.exe', 'C:/a/apaki-terminal.mjs', 'C:/s/terminal-1.json']);
  assert.equal(t.fallback.cmd, 'powershell.exe');
  assert.match(t.fallback.args.at(-1), /& 'C:\/node\/node\.exe' 'C:\/a\/apaki-terminal\.mjs' 'C:\/s\/terminal-1\.json'$/);
  const semi = terminalLaunch('win32', { cwd: 'C:/a;b', title: 't', file: 'n', args: [] });
  assert.equal(semi.cmd, 'powershell.exe');
  assert.match(terminalLaunch('win32', { cwd: 'C:/w', title: "it's", file: 'n', args: [] }).fallback.args.at(-1), /'it''s'/);
  // The Mac (src/platform.js, shared with the Mac port): Terminal runs the line; iTerm when it is installed.
  const term = terminalLaunch('darwin', { cwd: '/w x', file: '/n/node', args: ["it's"] }, { exists: () => false, env: {}, home: '/Users/a' });
  assert.equal(term.cmd, 'osascript');
  assert.ok(term.args.includes('tell application "Terminal"'));
  assert.match(term.args.find((a) => a.startsWith('do script')), /cd '\/w x' && '\/n\/node' 'it'\\\\''s'/);
  const iterm = terminalLaunch('darwin', { cwd: '/w', file: 'node', args: [] }, { exists: (p) => p.endsWith('iTerm.app'), env: {}, home: '/Users/a' });
  assert.ok(iterm.args.includes('tell application "iTerm"'));
  assert.equal(terminalLaunch('linux', { cwd: '/w', file: 'node', args: [] }).cmd, 'x-terminal-emulator');
});

/* ---------- the running TUIs (fake pty) ---------- */

test('consoles: output is batched into consoleData, input and resize reach the pty, a reload gets the screen back', async () => {
  const events = [];
  const mod = fakePty();
  const cons = createConsoles({ emit: (e) => events.push(e), loadPty: () => mod, headless: () => null, timing: quick });
  const con = cons.start('p1', { sessionId: SID, kind: 'claude', spec: { file: 'claude', args: ['--resume', SID], display: 'claude --resume' }, env: {}, cwd: 'C:/w', cols: 3, rows: 1000 });
  assert.equal(con.cols, 20, 'clamped');
  assert.equal(con.rows, 200);
  assert.deepEqual(mod.spawned[0].opts.cwd, 'C:/w');
  assert.equal(events[0].state, 'running');
  const h = mod.spawned[0];
  h.out('hello ');
  h.out('world');
  await tick();
  const data = events.filter((e) => e.ev === 'consoleData');
  assert.equal(data.length, 1, 'one event for a burst');
  assert.equal(data[0].data, 'hello world');
  assert.equal(data[0].seq, 1);
  assert.ok(cons.input('p1', 'x'));
  assert.equal(h.written, 'x');
  assert.equal(cons.input('nope', 'x'), false);
  cons.resize('p1', 120, 40);
  assert.deepEqual(h.sizes.at(-1), [120, 40]);
  events.length = 0;
  cons.replay('p1', { reqId: 'r1' });
  assert.equal(events[0].replay, 'hello world');
  assert.equal(events[0].seq, 1, 'what came before the replay is in it');
  await tick(100);
  assert.deepEqual(h.sizes.slice(-2), [[120, 39], [120, 40]], 'the TUI is asked to draw again');
  assert.match(cons.view('p1').text, /hello world/);
});

test('consoles: busy while the TUI draws "esc to interrupt"; the quit is the TUI\'s own Ctrl+C twice', async () => {
  let now = 1000;
  const events = [];
  const mod = fakePty();
  const cons = createConsoles({ emit: (e) => events.push(e), loadPty: () => mod, headless: () => null, now: () => now, timing: quick });
  cons.start('p1', { sessionId: SID, kind: 'claude', spec: { file: 'c', args: [] }, env: {}, cwd: '.', cols: 80, rows: 24 });
  const h = mod.spawned[0];
  h.out('\x1b[2K\r✻ Thinking… (3s · esc to interrupt)');
  assert.equal(cons.busy('p1'), true);
  now += 5000;
  assert.equal(cons.busy('p1'), false, 'quiet for a while: idle');
  const info = await cons.quit('p1');
  assert.equal(info.exitCode, 0);
  assert.ok(h.written.startsWith('\x03\x03'));
  assert.equal(h.killed, 0, 'never ended by PID when it quits itself');
  assert.equal(cons.has('p1'), false);
  assert.ok(events.some((e) => e.state === 'closing'));
});

test('consoles: a TUI that ignores its quit is ended by PID; stopTurn sends Esc first', async () => {
  const mod = fakePty({ quitOn: null });
  const cons = createConsoles({ emit: () => {}, loadPty: () => mod, headless: () => null, timing: quick });
  cons.start('p1', { sessionId: SID, kind: 'codex', spec: { file: 'c', args: [] }, env: {}, cwd: '.', cols: 80, rows: 24 });
  const info = await cons.quit('p1', { stopTurn: true });
  const h = mod.spawned[0];
  assert.ok(h.written.startsWith('\x1b\x03\x03\x03\x03'), JSON.stringify(h.written));
  assert.equal(h.killed, 1);
  assert.equal(info.exitCode, 1);
});

test('consoles: a command typed from the pane waits until the TUI is up and quiet', async () => {
  const mod = fakePty({ echo: true });
  const cons = createConsoles({ emit: () => {}, loadPty: () => mod, headless: () => null, timing: quick });
  cons.start('p1', { sessionId: SID, kind: 'claude', spec: { file: 'c', args: [] }, env: {}, cwd: '.', cols: 80, rows: 24, type: '/config' });
  const h = mod.spawned[0];
  await tick(40);
  assert.equal(h.written, '', 'nothing before it drew');
  h.out('> ');
  await tick(200);
  assert.equal(h.written, '/config\r', 'Enter once the TUI shows the text and settles');
  // A TUI that never shows the text still gets its Enter, a few seconds later, never before the text.
  const mute = fakePty();
  const c2 = createConsoles({ emit: () => {}, loadPty: () => mute, headless: () => null, timing: quick });
  c2.start('p2', { sessionId: SID, kind: 'claude', spec: { file: 'c', args: [] }, env: {}, cwd: '.', cols: 80, rows: 24, type: '/mcp' });
  mute.spawned[0].out('> ');
  await tick(200);
  assert.equal(mute.spawned[0].written, '/mcp');
});

test('consoles: no node-pty says why', () => {
  const cons = createConsoles({ emit: () => {}, loadPty: () => ({ error: 'The console needs node-pty' }), headless: () => null });
  assert.throws(() => cons.start('p1', { spec: { file: 'c', args: [] }, cols: 80, rows: 24 }), /node-pty/);
});

test('plain text: escape sequences and redrawn lines become what the screen shows', () => {
  assert.equal(plainText('\x1b[31mred\x1b[0m\nold\rnew\n\x1b]0;title\x07ok'), 'red\nnew\nok');
});

/* ---------- ownership (fake runner, fake pty) ---------- */

function harness({ busy = false, holder = null, kind = 'claude', sessionId = SID, exists = false, ptyOpts } = {}) {
  const log = [];
  const events = [];
  const mod = fakePty(ptyOpts);
  const p = { id: 'p1', sessionId, runner: { running: true }, busy };
  const consoles = createConsoles({ emit: (e) => events.push(e), loadPty: () => mod, headless: () => null, timing: quick });
  const ctl = createConsoleControl({
    emit: (e) => events.push(e), consoles, getPane: () => p, kindOf: () => kind,
    turnBusy: (x) => Boolean(x.busy),
    interrupt: async (x) => { log.push('interrupt'); setTimeout(() => { x.busy = false; }, 20); },
    release: async (x) => { log.push(`release:${x.runner ? 'runner' : 'none'}`); x.runner = null; },
    reopen: async (x, o) => { log.push(`reopen:${o.sessionId}`); x.runner = { running: false }; },
    cwdOf: () => 'C:/w',
    lock: { take: (id, k) => { log.push(`lock:${id}:${k}`); return holder; }, release: (id, k) => log.push(`unlock:${id}:${k}`) },
    command: (x, o) => { log.push(`command:${o.kind}:${o.sessionId}:${o.newSessionId ? 'new' : 'old'}`); return { file: 'claude', args: ['--resume', o.sessionId || 'new'], display: 'claude', note: null }; },
    envFor: () => ({}),
    serial: async (x, fn) => fn(),
    sessionExists: () => exists,
    adopt: (x, id) => { log.push(`adopt:${id}`); x.sessionId = id; },
    timing: { idlePollMs: 5, stopWaitMs: 500, waitMaxMs: 500 },
  });
  return { log, events, mod, p, consoles, ctl };
}

test('ownership: the pane\'s own process lets go before the TUI starts; the pane takes it back and reads it again after', async () => {
  const h = harness();
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30 });
  assert.deepEqual(h.log, ['release:runner', `lock:${SID}:claude`, `command:claude:${SID}:old`], 'released, locked, then started');
  assert.equal(h.mod.spawned.length, 1);
  assert.ok(h.ctl.active('p1'));
  assert.deepEqual(h.events.map((e) => e.state).filter(Boolean), ['starting', 'running']);
  // Back: the TUI's own quit, then the lock goes, the pane reopens, and the window hears closed last.
  await h.ctl.close({ paneId: 'p1' });
  await tick(30);
  assert.deepEqual(h.log.slice(3), [`unlock:${SID}:claude`, `reopen:${SID}`]);
  assert.equal(h.events.at(-1).state, 'closed');
  assert.equal(h.ctl.active('p1'), false);
  assert.equal(h.mod.spawned[0].killed, 0);
});

test('ownership: a turn running in the pane is never cut off without asking: turn, then wait or stop', async () => {
  const h = harness({ busy: true });
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30 });
  assert.equal(h.events.at(-1).state, 'turn');
  assert.deepEqual(h.log, [], 'nothing released, nothing started');
  assert.equal(h.mod.spawned.length, 0);
  // Stop it: interrupted, then the console starts once the turn ended.
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30, stop: true });
  assert.deepEqual(h.log.slice(0, 2), ['interrupt', 'release:runner']);
  assert.equal(h.mod.spawned.length, 1);
});

test('ownership: waiting for a turn can be cancelled; nothing starts', async () => {
  const h = harness({ busy: true });
  const opening = h.ctl.open({ paneId: 'p1', cols: 100, rows: 30, wait: true });
  await tick(20);
  assert.equal(h.events.at(-1).state, 'waiting');
  await h.ctl.close({ paneId: 'p1' });
  await opening;
  assert.equal(h.mod.spawned.length, 0);
  assert.equal(h.events.at(-1).state, 'closed');
});

test('ownership: someone else holds the conversation: no TUI, and the pane keeps it', async () => {
  const h = harness({ holder: { name: 'a latch terminal window', pid: 9 } });
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30 });
  assert.equal(h.mod.spawned.length, 0);
  const last = h.events.at(-1);
  assert.equal(last.state, 'error');
  assert.match(last.note, /a latch terminal window has this conversation open \(pid 9\)/);
  assert.deepEqual(h.log.slice(-1), [`reopen:${SID}`]);
});

test('ownership: a TUI working when the person flips back: busy, then wait or stop', async () => {
  const h = harness();
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30 });
  h.mod.spawned[0].out('Working (4s • esc to interrupt)');
  await h.ctl.close({ paneId: 'p1' });
  assert.equal(h.events.at(-1).state, 'busy');
  assert.ok(h.ctl.active('p1'), 'still running');
  await h.ctl.close({ paneId: 'p1', stop: true });
  await tick(30);
  assert.ok(h.mod.spawned[0].written.startsWith('\x1b'), 'Esc stops the turn first');
  assert.equal(h.ctl.active('p1'), false);
});

test('ownership: a new conversation started in the TUI becomes the pane\'s; a closed pane does not take it back', async () => {
  const h = harness({ sessionId: null, exists: true });
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30 });
  assert.match(h.log.at(-1), /command:claude:null:new/);
  await h.ctl.close({ paneId: 'p1' });
  await tick(30);
  assert.ok(h.log.some((l) => l.startsWith('adopt:')));
  assert.ok(h.log.at(-1).startsWith('reopen:') && h.log.at(-1) !== 'reopen:null');
  const g = harness();
  await g.ctl.open({ paneId: 'p1', cols: 100, rows: 30 });
  await g.ctl.shut(g.p, { reopen: false });
  await tick(30);
  assert.ok(!g.log.some((l) => l.startsWith('reopen:')), 'no reopen for a pane that is going');
  assert.equal(g.events.at(-1).state, 'closed');
});

test('ownership: a Codex pane hands its thread over the same way (no Claude lock, the thread let go)', async () => {
  const h = harness({ kind: 'codex', sessionId: 'codex:019a-thread-1234' });
  await h.ctl.open({ paneId: 'p1', cols: 100, rows: 30, command: '/approvals' });
  assert.deepEqual(h.log.slice(0, 2), ['release:runner', 'lock:codex:019a-thread-1234:codex']);
  assert.equal(h.events.find((e) => e.state === 'running').kind, 'codex');
});

/* ---------- a terminal window that holds a conversation ---------- */

test('terminal window: its record says who has the conversation; a gone window\'s record is dropped; Take it back asks it to stop', async () => {
  const dir = tmp();
  writeHeld(dir, { sessionId: 'codex:019a-thread', kind: 'codex', pid: process.pid, cwd: 'C:/w' });
  assert.ok(fs.existsSync(heldFile(dir, 'codex:019a-thread')));
  assert.ok(!heldFile(dir, 'codex:019a-thread').includes(':019a'), 'no colon in a Windows file name');
  const h = readHeld(dir, 'codex:019a-thread');
  assert.equal(h.app, 'apaki-terminal');
  assert.equal(h.pid, process.pid);
  assert.equal(readHeld(dir, 'codex:019a-thread', () => false), null, 'a window that is gone');
  assert.equal(fs.existsSync(heldFile(dir, 'codex:019a-thread')), false);
  writeHeld(dir, { sessionId: SID, kind: 'claude', pid: process.pid });
  const back = takeBackHeld(dir, SID, { waitMs: 400 });
  await tick(50);
  assert.ok(JSON.parse(fs.readFileSync(heldFile(dir, SID), 'utf8')).takenBy, 'the window is asked to stop');
  fs.unlinkSync(heldFile(dir, SID));
  assert.equal(await back, true);
});

/* ---------- policy and wiring ---------- */

test('policy: the console is PC only; a phone may only look at it (consoleView, its own pane)', () => {
  const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
  for (const op of PC_ONLY_OPS) {
    assert.ok(!PHONE_OPS.includes(op), op);
    assert.equal(checkPhoneCommand({ op, paneId: 'p1', data: 'x' }, { deviceId: DEV, cap: 'full', paneExists: () => true }).ok, false, op);
  }
  assert.ok(PHONE_OPS.includes('consoleView'));
  const ok = checkPhoneCommand({ op: 'consoleView', paneId: 'p1', reqId: 'r1', data: 'rm -rf' }, { deviceId: DEV, cap: 'chat', paneExists: (id) => id === `phone:${DEV}:p1` });
  assert.deepEqual(ok.cmd, { op: 'consoleView', reqId: `phone:${DEV}:r1`, paneId: `phone:${DEV}:p1` });
  assert.equal(checkPhoneCommand({ op: 'consoleView', paneId: 'p9' }, { deviceId: DEV, cap: 'full', paneExists: () => false }).ok, false);
});

test('wiring: the engine handles every console op, keeps one writer, and the window and phone draw the events', () => {
  const engine = read('../apaki/engine/engine.js');
  for (const op of [...PC_ONLY_OPS, 'consoleView']) assert.match(engine, new RegExp(`\\n  ${op}: `), `engine.js handles ${op}`);
  assert.match(engine, /if \(consoleCtl\.active\(p\.id\)\) \{ emit\(\{ ev: 'error'/, 'no send while the console has the conversation');
  assert.match(engine, /const termHeld = p\.sessionId \? readHeld\(CONSOLE_DIR, p\.sessionId\) : null;\n\s+if \(termHeld\) \{ emit\(\{ ev: 'taken_over'/, 'no send over a terminal window');
  assert.match(engine, /\(p\.runner \|\| isCodexPane\(p\) \|\| isKimiPane\(p\) \|\| consoles\.has\(p\.id\)\) && p\.sessionId/, 'a console holds its conversation for other windows');
  assert.match(engine, /await consoles\.shutdown\(\)/);
  const app = read('../apaki/ui/app.js');
  for (const ev of ['console', 'consoleData', 'consoleView', 'terminal']) assert.match(app, new RegExp(`PANE_EVENTS = new Set\\(\\[[^\\]]*'${ev}'`), ev);
  const pane = read('../apaki/ui/pane.js');
  assert.match(pane, /case 'console':/);
  assert.match(pane, /case 'consoleData':/);
  const ui = read('../apaki/ui/console.js');
  assert.ok(!/^import .*vendor/m.test(ui), 'xterm loads on demand (the phone build has no vendor folder)');
  assert.match(ui, /import\('\.\/vendor\/xterm\/xterm\.js'\)/);
  for (const f of ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-web-links.js', 'addon-unicode11.js', 'addon-webgl.js', 'LICENSE.txt']) {
    assert.ok(fs.existsSync(new URL(`../apaki/ui/vendor/xterm/${f}`, import.meta.url)), `vendored ${f}`);
  }
});

test('wiring: the window and the engine agree on which slash commands open the console', async () => {
  const ui = await import('../apaki/ui/console.js');
  const engine = await import('../apaki/engine/console.js');
  for (const k of ['CLAUDE_TUI_COMMANDS', 'CLAUDE_TUI_BARE', 'CODEX_TUI_COMMANDS', 'CODEX_TUI_BARE']) assert.deepEqual([...ui[k]], [...engine[k]], k);
  for (const [kind, text] of [['claude', '/config'], ['claude', '/model'], ['claude', '/model opus'], ['codex', '/approvals'], ['codex', '/review']]) {
    assert.equal(ui.tuiCommand(kind, text), engine.tuiCommand(kind, text), `${kind} ${text}`);
  }
  // Apaki's palette in both themes, all 16 colours, and a see-through ground that still names the real ground for contrast.
  for (const mode of ['light', 'dark']) assert.equal(Object.keys(ui.ANSI[mode]).length, 16, mode);
});
