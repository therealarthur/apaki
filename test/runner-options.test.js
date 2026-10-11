/**
 * Tests for SessionRunner.buildOptions (src/runner.js): latch's own runner
 * starts Claude Code exactly as before, and the optional extras Myrlin Apaki
 * passes (an in-process MCP server, an appended system prompt, extra hooks,
 * extra env) are added without disturbing the question/plan hook. Nothing is
 * started.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASK_TIMEOUT_S, SessionRunner } from '../src/runner.js';

const base = { sessionId: 'abc', cwd: '/tmp', env: { A: '1' }, canUseTool: async () => ({ behavior: 'allow' }), onMessage: () => {} };

test('without extras the options are the plain latch shape', () => {
  const o = new SessionRunner(base).buildOptions();
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.equal(o.mcpServers, undefined);
  assert.equal(o.hooks, undefined);
  assert.deepEqual(o.env, { A: '1' });
  assert.equal(o.resume, 'abc');
  const r = new SessionRunner(base);
  r.onInteractiveTool = async () => null;
  const h = r.buildOptions().hooks;
  assert.deepEqual(Object.keys(h), ['PreToolUse']);
  assert.equal(h.PreToolUse.length, 1);
  assert.equal(h.PreToolUse[0].matcher, 'AskUserQuestion|ExitPlanMode');
  // A person may take a while to answer: the hook waits a week, not Claude Code's default (2026-10-10).
  assert.equal(h.PreToolUse[0].timeout, ASK_TIMEOUT_S);
  assert.ok(ASK_TIMEOUT_S >= 24 * 3600);
});

test('Apaki extras: fresh MCP servers per start, appended prompt, merged hooks, env on top', () => {
  let made = 0;
  const pre = async () => ({});
  const post = async () => ({});
  const r = new SessionRunner({
    ...base,
    mcpServers: () => ({ apaki: { type: 'sdk', name: 'apaki', n: ++made } }),
    appendSystemPrompt: 'Use the show tool.',
    hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [pre] }], PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [post] }] },
    envExtra: { BROWSER: 'x.cmd' },
  });
  r.onInteractiveTool = async () => null;
  const o1 = r.buildOptions();
  const o2 = r.buildOptions();
  assert.equal(o1.mcpServers.apaki.n, 1);
  assert.equal(o2.mcpServers.apaki.n, 2, 'a new server object for every start');
  assert.equal(o1.systemPrompt.append, 'Use the show tool.');
  assert.equal(o1.systemPrompt.preset, 'claude_code');
  assert.deepEqual(o1.hooks.PreToolUse.map((m) => m.matcher), ['Bash|PowerShell', 'AskUserQuestion|ExitPlanMode']);
  assert.equal(o1.hooks.PostToolUse[0].hooks[0], post);
  assert.deepEqual(o1.env, { A: '1', BROWSER: 'x.cmd' });
  // The runner's own hook list is not mutated by building options twice.
  assert.equal(r.hooks.PreToolUse.length, 1);
  // A billing change replaces env; the extras stay on top of the new one.
  r.env = { B: '2' };
  assert.deepEqual(r.buildOptions().env, { B: '2', BROWSER: 'x.cmd' });
});

// "Auto-compact at" (Apaki, 2026-10-10): the engine's choice reaches Claude Code as its own settings, through the SDK's
// `settings` option (claude --settings), never a settings file. Latch's own runner passes none and starts as before.
test('flagSettings: passed as the SDK settings option, read again on every start, absent when there is none', () => {
  assert.equal(new SessionRunner(base).buildOptions().settings, undefined, 'latch: no settings option');
  let window = 300000;
  const r = new SessionRunner({ ...base, flagSettings: () => (window ? { autoCompactWindow: window } : null) });
  const o1 = r.buildOptions();
  assert.deepEqual(o1.settings, { autoCompactWindow: 300000 });
  // A changed preference reaches the next process, not the running one.
  window = 500000;
  assert.deepEqual(r.buildOptions().settings, { autoCompactWindow: 500000 });
  assert.deepEqual(o1.settings, { autoCompactWindow: 300000 });
  // Claude Code's default: the function returns null and no option is set.
  window = 0;
  assert.equal('settings' in r.buildOptions(), false);
  // A plain object works too, and the runner's own copy is not handed out.
  const fixed = { autoCompactWindow: 200000 };
  const r2 = new SessionRunner({ ...base, flagSettings: fixed });
  const o2 = r2.buildOptions();
  assert.deepEqual(o2.settings, fixed);
  assert.notEqual(o2.settings, fixed);
  // The user, project and local settings still load as before: it is an extra layer, not a replacement.
  assert.deepEqual(o2.settingSources, ['user', 'project', 'local']);
});
