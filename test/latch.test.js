/**
 * Unit tests for the parts of latch with real logic: markdown rendering,
 * credential choice and the child env scrub, transcript parsing, the owner
 * lock, and outside-change detection. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-test-'));
process.env.CLAUDE_CONFIG_DIR = tmp; // locks and projects go here, not the real ~/.claude
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const { LineRenderer, renderMarkdown } = await import('../src/render.js');
const { childEnv, liveLogin, vaultKey } = await import('../src/auth.js');
const { lastCostTotal, lastModel, releaseLock, takeLock } = await import('../src/sessions.js');
const { hasMessageBetween } = await import('../src/runner.js');
const { describeTool } = await import('../src/tui.js');
const { claudeArgs, keyApproved } = await import('../src/launch.js');

test('renders headings, bullets, inline styles and code fences without color', () => {
  const out = renderMarkdown('# Title\n- **bold** and `code`\n```js\nconst a = 1;\n```\nafter', { color: false });
  assert.equal(out, 'Title\n  • bold and code\n  js\n  const a = 1;\nafter\n');
});

test('leaves snake_case and arithmetic alone', () => {
  assert.equal(renderMarkdown('file_name_here and 2 * 3 * 4', { color: false }), 'file_name_here and 2 * 3 * 4\n');
});

test('streams deltas line by line and aligns tables when they end', () => {
  let out = '';
  const r = new LineRenderer((s) => { out += s; }, { color: false });
  for (const chunk of ['| a | bb', ' |\n|--|--|\n| ccc | d |', '\nnext line', ' continues\npartial']) r.push(chunk);
  // The table prints once the first non-table line completes; "partial" waits.
  assert.equal(out, 'a     bb\n────────\nccc   d\nnext line continues\n');
  r.end();
  assert.equal(out, 'a     bb\n────────\nccc   d\nnext line continues\npartial\n');
});

test('liveLogin tells a usage key from a subscription token', () => {
  const f = path.join(tmp, 'creds.json');
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-usr-${'x'.repeat(40)}` } }));
  assert.equal(liveLogin(f).kind, 'key');
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-abc' } }));
  assert.deepEqual(liveLogin(f), { kind: 'subscription', key: null });
  assert.equal(liveLogin(path.join(tmp, 'missing.json')).kind, 'subscription');
});

test('vaultKey finds one key by heading words and skips admin keys', () => {
  const f = path.join(tmp, 'credentials.md');
  const key = `sk-ant-api03-${'a'.repeat(40)}`;
  fs.writeFileSync(f, [
    '## Anthropic API Key (Team Org, usage key) - added 2026-10-08', `- Key: ${key}`,
    '## Anthropic Admin API Key (Team Org)', `- Key: sk-ant-admin01-${'b'.repeat(40)}`,
    '## Something else', '- Key: nope',
  ].join('\n'));
  assert.deepEqual(vaultKey('team', f), { name: 'Team Org, usage key', key });
  assert.match(vaultKey('nothing', f).error, /No API key heading/);
});

test('childEnv strips every inherited auth source and session identity', () => {
  const env = childEnv('sk-ant-usr-new', {
    PATH: '/bin', ANTHROPIC_API_KEY: 'corporate', anthropic_auth_token: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_EFFORT: 'xhigh',
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-usr-new');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLAUDE_EFFORT, 'xhigh');
  for (const gone of ['anthropic_auth_token', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) assert.equal(env[gone], undefined);
  assert.equal(env.PROMPT_RELAY_CHILD, '1');
  assert.equal(childEnv(null, { ANTHROPIC_API_KEY: 'corporate' }).ANTHROPIC_API_KEY, undefined);
});

test('reads the last model and the running cost from a transcript', () => {
  const text = [
    '{"type":"assistant","message":{"model":"claude-haiku-5-5"}}',
    '{"type":"cost-state","totalCostUSD":0.5}',
    '{"type":"assistant","message":{"model":"claude-opus-5-5"}}',
    '{"type":"cost-state","sessionId":"x","totalCostUSD":1.25,"other":1}',
  ].join('\n');
  assert.equal(lastModel(text), 'claude-opus-5-5');
  assert.equal(lastCostTotal(text), 1.25);
  assert.equal(lastCostTotal(''), 0);
});

test('lock refuses a second live holder and is taken over from a dead one', () => {
  assert.equal(takeLock('s1'), null);
  const lockFile = path.join(tmp, 'latch', 'locks', 's1.json');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
  assert.equal(takeLock('s1'), process.ppid);
  assert.equal(takeLock('s1', { force: true }), null);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999 }));
  assert.equal(takeLock('s1'), null);
  releaseLock('s1');
  assert.equal(fs.existsSync(lockFile), false);
});

test('outside-change detection counts only top-level user/assistant entries', () => {
  const f = path.join(tmp, 't.jsonl');
  const base = '{"type":"user","uuid":"u1","message":{}}\n';
  fs.writeFileSync(f, base);
  const from = Buffer.byteLength(base);
  fs.appendFileSync(f, '{"type":"attachment","uuid":"a1","attachment":{"snapshot":"{\\"type\\":\\"user\\"}"}}\n{"type":"cost-state","totalCostUSD":1}\n');
  assert.equal(hasMessageBetween(f, from, fs.statSync(f).size), false);
  fs.appendFileSync(f, '{"type":"assistant","uuid":"a2","message":{}}\n');
  assert.equal(hasMessageBetween(f, from, fs.statSync(f).size), true);
});

test('builds Claude Code arguments for the real TUI', () => {
  assert.deepEqual(
    claudeArgs({ sessionId: 'c6e7b179-2ed4-4ae5-afac-7845f0c7b029', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions' }),
    ['--resume', 'c6e7b179-2ed4-4ae5-afac-7845f0c7b029', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--dangerously-skip-permissions'],
  );
  assert.deepEqual(claudeArgs({ model: 'opus', permissionMode: 'acceptEdits' }), ['--model', 'opus', '--permission-mode', 'acceptEdits']);
  assert.throws(() => claudeArgs({ model: 'opus & calc' }), /unexpected argument/);
});

test('reads key approval from Claude Code config without needing the full key', () => {
  const f = path.join(tmp, 'claude.json');
  const key = `sk-ant-usr-${'k'.repeat(30)}abcdefghij0123456789`;
  fs.writeFileSync(f, JSON.stringify({ customApiKeyResponses: { approved: ['abcdefghij0123456789'], rejected: [] } }));
  assert.equal(keyApproved(key, f), true);
  assert.equal(keyApproved(`${key}x`, f), false);
  assert.equal(keyApproved(key, path.join(tmp, 'none.json')), false);
});

test('describes tool calls by their most telling field', () => {
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'run tests' }), 'npm test');
  assert.equal(describeTool('Read', { file_path: 'C:/a.txt' }), 'C:/a.txt');
  assert.equal(describeTool('X', {}), '');
});

test('finds Claude Code windows that have a session open, ignoring headless and dead ones', async () => {
  const { windowsWith } = await import('../src/sessions.js');
  const dir = path.join(tmp, 'live');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', entrypoint: 'cli', kind: 'interactive', startedAt: 5 }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', entrypoint: 'sdk-ts', kind: 'interactive' }));
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 999999, sessionId: 's1', entrypoint: 'cli', kind: 'interactive' }));
  fs.writeFileSync(path.join(dir, '4.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', entrypoint: 'cli', kind: 'interactive' }));
  assert.deepEqual(windowsWith('s1', dir), [{ pid: process.pid, startedAt: 5 }]);
});

test('remembers sessions latch created', async () => {
  const { createdSessions, rememberCreated } = await import('../src/sessions.js');
  rememberCreated('new-1');
  rememberCreated('new-2');
  assert.deepEqual([...createdSessions()].sort(), ['new-1', 'new-2']);
});
