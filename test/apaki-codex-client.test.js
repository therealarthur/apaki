/**
 * codex-client.js, codex-history.js and the process overrides of codex-panes.js (apaki/engine), 2026-10-12.
 *
 * The client against a stand-in `codex app-server` (test-fixtures/fake-codex-app-server.mjs, and a few tiny scripts
 * written here for the failures a fake that always answers cannot show): the handshake, requests, notifications, server
 * requests, a process that dies or hangs, a process that starts again on demand. Finding the codex build without a
 * shell. The paged history. No real Codex process, nothing billed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServer, CodexRpcError, codexTriple, findCodex, tomlList, tomlString, tomlTable } from '../apaki/engine/codex-client.js';
import { CodexHistory } from '../apaki/engine/codex-history.js';
import { DEV_INSTRUCTIONS, processEnv, processOverrides } from '../apaki/engine/codex-panes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test-fixtures', 'fake-codex-app-server.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-codex-client-test-'));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };
const touch = (file, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const script = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return { command: process.execPath, args: [f] }; };

/* ---------- finding codex ---------- */

test('the Rust target of the npm package for each platform', () => {
  assert.equal(codexTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(codexTriple('win32', 'arm64'), 'aarch64-pc-windows-msvc');
  assert.equal(codexTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(codexTriple('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(codexTriple('freebsd', 'x64'), null);
});

test('findCodex: APAKI_CODEX_BIN first (a script runs under this Node), then the npm layout without ever spawning the shim', (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const exe = process.execPath;

  const script1 = path.join(dir, 'fake.mjs');
  touch(script1);
  assert.deepEqual(findCodex({ env: { APAKI_CODEX_BIN: script1 }, execPath: exe }), { command: exe, args: [script1], label: script1 });
  const bin = path.join(dir, 'codex-native.exe');
  touch(bin);
  assert.deepEqual(findCodex({ env: { APAKI_CODEX_BIN: bin } }), { command: bin, args: [], label: bin });
  assert.equal(findCodex({ env: { APAKI_CODEX_BIN: path.join(dir, 'missing.exe') } }), null, 'a forced path that is not there is not silently replaced by another codex');

  // The npm global layout on Windows: codex.cmd beside node_modules/@openai/codex, the native build nested in it.
  const npm = path.join(dir, 'npm');
  touch(path.join(npm, 'codex.cmd'), '@echo off');
  touch(path.join(npm, 'node_modules', '@openai', 'codex', 'package.json'), '{}');
  const native = path.join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  touch(native);
  const win = { platform: 'win32', arch: 'x64', env: { PATH: `${path.join(dir, 'nothing')}${path.delimiter}${npm}` }, execPath: exe };
  assert.deepEqual(findCodex(win), { command: native, args: [], label: native });
  // An app started from a shortcut with a short PATH still finds the global npm install (APPDATA\npm).
  assert.deepEqual(findCodex({ platform: 'win32', arch: 'x64', env: { PATH: '', APPDATA: dir }, execPath: exe }), { command: native, args: [], label: native });

  // Without the native build, the package's own launcher script runs under this Node (the shim is not spawned).
  fs.rmSync(native);
  const js = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  touch(js);
  assert.deepEqual(findCodex(win), { command: exe, args: [js], label: js });

  // A real codex.exe on PATH is taken as it is; nothing found is null.
  const apps = path.join(dir, 'apps');
  touch(path.join(apps, 'codex.exe'));
  assert.equal(findCodex({ platform: 'win32', arch: 'x64', env: { PATH: apps } }).command, path.join(apps, 'codex.exe'));
  assert.equal(findCodex({ platform: 'win32', arch: 'x64', env: { PATH: path.join(dir, 'empty') } }), null);
  assert.equal(findCodex({ env: { PATH: '' } }), null);
});

test('findCodex on a Mac: <prefix>/bin/codex is a symlink into lib/node_modules/@openai/codex; the native build is found there, else its launcher script (macOS port, 2026-10-12)', (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const exe = process.execPath;
  const bin = path.join(dir, 'prefix', 'bin');
  const pkg = path.join(dir, 'prefix', 'lib', 'node_modules', '@openai', 'codex');
  const shim = path.join(bin, 'codex');
  const js = path.join(pkg, 'bin', 'codex.js');
  touch(shim, '#!/usr/bin/env node\n');
  touch(path.join(pkg, 'package.json'), '{}');
  touch(js, '#!/usr/bin/env node\n');
  // What the symlink resolves to (a test host without symlink rights passes its own realpath).
  const realpath = (f) => (f === shim ? js : f);
  const mac = { platform: 'darwin', arch: 'arm64', env: { PATH: bin }, execPath: exe, realpath };
  assert.deepEqual(findCodex(mac), { command: exe, args: [js], label: js }, 'no native build: the launcher script under this Node');
  const native = path.join(pkg, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  touch(native, 'native');
  assert.deepEqual(findCodex(mac), { command: native, args: [], label: native }, 'the native build inside the package wins');
  // A shim whose link does not lead to the codex package is not taken for it.
  assert.equal(findCodex({ ...mac, realpath: (f) => f }), null);
});

test('TOML values for -c: backslashes and quotes survive the parse', () => {
  assert.equal(tomlString('C:\\Program Files\\node.exe'), '"C:\\\\Program Files\\\\node.exe"');
  assert.equal(tomlString('say "hi"\n'), '"say \\"hi\\"\\n"');
  assert.equal(tomlList(['a', 'b\\c']), '["a", "b\\\\c"]');
  assert.equal(tomlTable({ A_B: 'x', 'we ird': 'y' }), '{ A_B = "x", "we ird" = "y" }');
});

test('process overrides: Apaki\'s tool server and the BROWSER shim reach this process only, through -c; none without a server', () => {
  assert.deepEqual(processOverrides(null), []);
  const o = processOverrides({ node: 'C:\\node\\node.exe', mcpScript: 'C:\\apaki\\apaki-mcp-stdio.mjs', openUrl: 'http://127.0.0.1:5000/open', token: 'tok', shim: 'C:\\apaki\\apaki-open.cmd' });
  assert.deepEqual(o.slice(0, 5), [
    'mcp_servers.apaki.command="C:\\\\node\\\\node.exe"',
    'mcp_servers.apaki.args=["C:\\\\apaki\\\\apaki-mcp-stdio.mjs"]',
    'mcp_servers.apaki.env={ APAKI_TOOL_PROXY = "1", APAKI_OPEN_URL = "http://127.0.0.1:5000/open", APAKI_OPEN_TOKEN = "tok" }',
    'mcp_servers.apaki.startup_timeout_sec=30',
    'mcp_servers.apaki.tool_timeout_sec=120',
  ]);
  // The default shell policy drops variables named like a secret; the token is set explicitly so the shim still has it.
  assert.ok(o.includes('shell_environment_policy.set.APAKI_OPEN_TOKEN="tok"'));
  assert.ok(o.includes('shell_environment_policy.set.BROWSER="C:\\\\apaki\\\\apaki-open.cmd"'));
  assert.ok(!processOverrides({ node: 'n', mcpScript: 's', openUrl: 'u', token: 't', shim: null }).some((l) => l.startsWith('shell_environment_policy')), 'no shim, no BROWSER');
  assert.equal(processEnv({ node: 'n', mcpScript: 's', openUrl: 'u', token: 't', shim: 'S' }, { X: '1' }).BROWSER, 'S');
  assert.deepEqual(processEnv(null, { X: '1' }), { X: '1' });
  assert.match(DEV_INSTRUCTIONS, /Myrlin Apaki/);
  assert.match(DEV_INSTRUCTIONS, /instead of opening it with start/);
  assert.ok(!DEV_INSTRUCTIONS.includes('\u2014') && !DEV_INSTRUCTIONS.includes('--'));
});

/* ---------- the connection ---------- */

test('the client starts lazily, shakes hands once, and answers requests with results and errors', async (t) => {
  const dir = tmp();
  const log = path.join(dir, 'log.jsonl');
  t.after(() => rm(dir));
  process.env.FAKE_CODEX_LOG = log;
  t.after(() => { delete process.env.FAKE_CODEX_LOG; });
  const c = new CodexAppServer({ binary: { command: process.execPath, args: [FAKE] }, overrides: ['model="x"', 'a.b=1'], env: { ...process.env, FAKE_CODEX_LOG: log } });
  assert.equal(c.ready, false);
  assert.equal(c.pid, null);
  const [a, b] = await Promise.all([c.ensure(), c.ensure()]);
  assert.equal(a, b, 'one start, shared');
  assert.equal(c.ready, true);
  assert.match(c.userAgent, /^fake-codex/);
  const models = await c.request('model/list', {});
  assert.equal(models.data.length, 2);
  await assert.rejects(() => c.request('nope/nothing', {}), (e) => e instanceof CodexRpcError && e.code === -32601 && /Method not found/.test(e.message));
  await assert.rejects(() => c.request('thread/read', { threadId: 'missing' }), (e) => e.code === -32600 && /thread not found/.test(e.message));
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines[0].argv, ['app-server', '-c', 'model="x"', '-c', 'a.b=1'], 'each override is its own -c');
  assert.equal(lines[1].in.method, 'initialize');
  assert.equal(lines[1].in.params.capabilities.experimentalApi, true);
  assert.equal(lines[1].in.params.clientInfo.name, 'myrlin-apaki');
  assert.equal(lines[2].in.method, 'initialized', 'the initialized notification follows the answer');
  await c.stop();
  assert.equal(c.ready, false);
});

test('notifications and server requests reach the handlers; a handler that throws does not end the connection', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const c = new CodexAppServer({ binary: script(dir, 's.mjs', `
    import readline from 'node:readline';
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.method === 'initialize') { out({ id: m.id, result: { userAgent: 'x' } }); return; }
      if (m.method === 'go') { out({ method: 'hello', params: { n: 1 } }); out({ id: 77, method: 'ask', params: { q: 1 } }); out({ id: m.id, result: 'went' }); return; }
      if (m.id === 77) out({ method: 'answered', params: m.result });
    });
  `) });
  t.after(() => c.stop());
  const seen = [];
  c.on('notification', (method, params) => { seen.push([method, params]); if (method === 'hello') throw new Error('a handler bug'); });
  c.on('request', (id, method) => { if (method === 'ask') c.respond(id, { fine: true }); });
  c.on('log', () => {});
  assert.equal(await c.request('go', {}), 'went');
  await until(() => seen.length >= 2);
  assert.deepEqual(seen, [['hello', { n: 1 }], ['answered', { fine: true }]]);
  assert.equal(await c.request('go', {}), 'went', 'still connected');
});

test('a process that exits ends what waits, says so in words, and starts again on the next request', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const spec = script(dir, 's.mjs', `
    import readline from 'node:readline';
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'x', pid: process.pid } });
      else if (m.method === 'die') process.exit(3);
      else if (m.method === 'ping') out({ id: m.id, result: 'pong' });
    });
  `);
  const c = new CodexAppServer({ binary: spec });
  const exits = [];
  c.on('exit', (code, signal, info) => exits.push({ code, expected: info.expected }));
  const first = await c.ensure();
  await assert.rejects(() => c.request('die', {}), (e) => e.code === 'EXIT' && /stopped \(exit 3\)/.test(e.message));
  assert.equal(c.ready, false);
  assert.deepEqual(exits, [{ code: 3, expected: false }]);
  assert.equal(await c.request('ping', {}), 'pong', 'started again');
  const second = await c.ensure();
  assert.notEqual(second.pid, first.pid, 'a new process');
  await c.stop();
  await until(() => exits.length === 2);
  assert.equal(exits[1].expected, true, 'a stop we asked for is expected');
});

test('a server that does not answer initialize fails with a sentence, and one that is missing says how to install it', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const quiet = new CodexAppServer({ binary: script(dir, 'quiet.mjs', 'setInterval(() => {}, 1000);'), requestTimeoutMs: 100 });
  t.after(() => quiet.stop());
  await assert.rejects(() => quiet.ensure(), (e) => /Codex did not start: Codex did not answer initialize/.test(e.message));
  const none = new CodexAppServer({ locate: () => null });
  await assert.rejects(() => none.ensure(), /Codex is not installed on this PC .*npm install -g @openai\/codex/);
  const broken = new CodexAppServer({ binary: { command: path.join(dir, 'does-not-exist.exe'), args: [] } });
  await assert.rejects(() => broken.ensure(), /Codex did not start/);
});

test('a request that gets no answer times out, without waiting forever; unreadable lines are logged, not fatal', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const c = new CodexAppServer({ binary: script(dir, 's.mjs', `
    import readline from 'node:readline';
    process.stdout.write('this is not json\\n');
    readline.createInterface({ input: process.stdin }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n');
    });
  `), requestTimeoutMs: 150 });
  t.after(() => c.stop());
  const logs = [];
  c.on('log', (l) => logs.push(l));
  await c.ensure();
  await assert.rejects(() => c.request('never', {}), (e) => e.code === 'TIMEOUT' && /did not answer never/.test(e.message));
  assert.ok(logs.some((l) => /unreadable line/.test(l)));
});

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(20); }
}

/* ---------- history ---------- */

/** A thread of n turns (two messages each), served newest first in pages like thread/turns/list. */
function pagedThread(n) {
  const turns = Array.from({ length: n }, (_, i) => ({ id: `turn-${i}`, status: 'completed', startedAt: 1000 + i, items: [
    { type: 'userMessage', id: `u${i}`, content: [{ type: 'text', text: `Q${i}` }] }, { type: 'agentMessage', id: `a${i}`, text: `A${i}` },
  ] }));
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'full');
    const newest = turns.slice().reverse();
    const at = params.cursor ? Number(params.cursor) : 0;
    const data = newest.slice(at, at + params.limit);
    return { data, nextCursor: at + params.limit < newest.length ? String(at + params.limit) : null };
  };
  return { request, calls };
}

test('history: the newest messages first, the page before by the first turn, and a stale ask refused', async () => {
  const { request, calls } = pagedThread(200);
  const h = new CodexHistory({ request });
  const first = await h.firstPage('t', { limit: 50 });
  assert.equal(first.source, 'codex');
  assert.equal(first.hasMore, true);
  assert.equal(first.countless, true);
  assert.equal(first.messages.at(-1).message.content[0].text, 'A199');
  assert.ok(first.messages.length >= 50 && first.messages.length < 100);
  assert.equal(first.first, `turn-${200 - first.messages.length / 2}`);
  assert.equal(first.total, first.messages.length);
  assert.ok(calls.length >= 4, 'turns come eight at a time');

  const before = await h.pageBefore('t', first.first, { limit: 100 });
  assert.equal(before.gone, undefined);
  assert.equal(before.messages.at(-1).uuid, `a${200 - first.messages.length / 2 - 1}`, 'the page ends where the first one began');
  assert.equal(before.total, first.messages.length + before.messages.length);

  // A cursor from before the last page is not this thread's oldest turn any more.
  assert.deepEqual(await h.pageBefore('t', first.first, { limit: 100 }), { gone: true, total: before.total });
  assert.deepEqual(await h.pageBefore('other', 'x'), { gone: true, total: 0 });

  // Load all: everything left in one call (bounded), and nothing more after it.
  const rest = await h.pageBefore('t', before.first, { all: true });
  assert.equal(rest.hasMore, false);
  assert.equal(rest.countless, false);
  assert.equal(rest.messages[0].message.content[0].text, 'Q0');
  assert.equal(rest.total, 400);
  h.forget('t');
  assert.deepEqual(await h.pageBefore('t', rest.first), { gone: true, total: 0 });
});

test('history: a short thread is one page with nothing more to load', async () => {
  const { request } = pagedThread(3);
  const h = new CodexHistory({ request });
  const page = await h.firstPage('t');
  assert.equal(page.hasMore, false);
  assert.equal(page.countless, false);
  assert.equal(page.messages.length, 6);
  assert.equal(page.first, 'turn-0');
  const empty = await new CodexHistory({ request: async () => ({ data: [], nextCursor: null }) }).firstPage('t');
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.first, null);
  assert.equal(empty.hasMore, false);
});
