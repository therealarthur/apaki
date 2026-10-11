/**
 * What Claude Code shows its users that is not Claude's reply (apaki/ui/notices.js, src/runner.js
 * quietHookEvent; Arthur, 2026-10-11: "make sure that apaki shows ALL output that would normally be
 * seen by claude code users (including the yellow text that happens when a prompt gets caught/etc)").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookWorthShowing, noticeFor } from '../apaki/ui/notices.js';
import { quietHookEvent } from '../src/runner.js';

const sys = (subtype, extra = {}) => ({ type: 'system', subtype, ...extra });

test('notices: a prompt a hook blocked shows as a yellow Hook line (the message measured 2026-10-11)', () => {
  const n = noticeFor(sys('informational', { content: 'UserPromptSubmit operation blocked by hook:\nNot now.\n\nOriginal prompt: hello', level: 'warning', prevent_continuation: true }));
  assert.equal(n.tone, 'warn');
  assert.equal(n.label, 'Hook');
  assert.match(n.text, /blocked by hook:\nNot now\./);
  assert.equal(noticeFor(sys('informational', { content: 'Tip: try /context', level: 'suggestion' })).tone, 'info');
  assert.equal(noticeFor(sys('informational', { content: 'Auto-update done', level: 'info' })).tone, 'dim');
  assert.equal(noticeFor(sys('informational', { content: '  ', level: 'warning' })), null);
});

test('notices: hook errors, blocks and systemMessage show; quiet successes do not', () => {
  assert.match(noticeFor(sys('hook_response', { hook_name: 'PreToolUse:Bash', outcome: 'success', exit_code: 2, stderr: 'no taskkill' })).text, /^PreToolUse:Bash hook blocked this: no taskkill$/);
  const failed = noticeFor(sys('hook_response', { hook_name: 'PostToolUse', outcome: 'error', exit_code: 1, stderr: 'boom' }));
  assert.equal(failed.tone, 'error');
  assert.match(failed.text, /failed \(exit 1\): boom/);
  assert.equal(noticeFor(sys('hook_response', { hook_name: 'Stop', outcome: 'success', exit_code: 0, stdout: '{"systemMessage":"Em dash found"}' })).text, 'Em dash found');
  assert.equal(noticeFor(sys('hook_response', { hook_name: 'Stop', outcome: 'success', exit_code: 0, stdout: '{}' })), null);
  assert.equal(noticeFor(sys('hook_response', { hook_name: 'Stop', outcome: 'cancelled' })).text, 'Stop hook was cancelled');
  assert.equal(hookWorthShowing(sys('hook_started')), false);
});

test('notices: retries, limits (once), permission, command output, model fallback, compaction, memory', () => {
  assert.equal(noticeFor(sys('api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 4200, error_status: 529, error: 'overloaded_error' })).text, 'API error 529 (overloaded error). Retrying in 4 s, attempt 2 of 10.');
  const seen = new Map();
  const warn = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 } };
  assert.equal(noticeFor(warn, seen).text, 'You have used 80% of your weekly limit.');
  assert.equal(noticeFor(warn, seen), null, 'the same warning is not repeated every turn');
  assert.equal(noticeFor({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }, seen).tone, 'error');
  assert.equal(noticeFor({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, seen), null);
  assert.equal(noticeFor(sys('permission_denied', { tool_name: 'Bash', message: 'Denied by rule' })).text, 'Bash was not allowed: Denied by rule');
  assert.deepEqual(noticeFor(sys('local_command_output', { content: 'Total cost: $0.42' })), { text: 'Total cost: $0.42', tone: 'dim', label: '', mono: true });
  assert.equal(noticeFor(sys('model_refusal_fallback', { original_model: 'a', fallback_model: 'b', content: '' })).text, 'Switched from a to b.');
  assert.equal(noticeFor(sys('status', { status: null, compact_result: 'failed', compact_error: 'too big' })).text, 'Compacting failed: too big');
  assert.equal(noticeFor(sys('status', { status: 'compacting' })), null);
  assert.equal(noticeFor(sys('memory_recall', { mode: 'select', memories: [{ path: 'C:/m/a.md' }, { path: '/m/b.md' }] })).text, 'Recalled 2 memories: a.md, b.md');
});

test('notices: text the harness adds to the conversation; never your own prompt or a subagent', () => {
  assert.deepEqual(noticeFor({ type: 'user', isSynthetic: true, message: { content: '<local-command-stdout>/resume isn\'t available in this environment.</local-command-stdout>' } }),
    { text: '/resume isn\'t available in this environment.', tone: 'dim', label: '', mono: true });
  assert.equal(noticeFor({ type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback:\nNo em dashes.' }] } }).label, 'Hook');
  assert.equal(noticeFor({ type: 'user', message: { content: 'hello' } }), null, 'a plain user message is not a notice');
  assert.equal(noticeFor({ type: 'user', isReplay: true, isSynthetic: true, message: { content: 'x' } }), null);
  assert.equal(noticeFor({ type: 'user', isSynthetic: true, origin: { kind: 'task-notification' }, message: { content: 'x' } }), null);
  assert.equal(noticeFor({ ...sys('informational', { content: 'x', level: 'warning' }), parent_tool_use_id: 't1' }), null);
  assert.equal(noticeFor({ type: 'assistant', message: { content: [] } }), null);
});

test('runner: quiet hook events are dropped before the window; the ones Claude Code shows pass', () => {
  assert.equal(quietHookEvent(sys('hook_started')), true);
  assert.equal(quietHookEvent(sys('hook_progress')), true);
  assert.equal(quietHookEvent(sys('hook_response', { outcome: 'success', exit_code: 0, stdout: '{"continue":true}' })), true);
  assert.equal(quietHookEvent(sys('hook_response', { outcome: 'success', exit_code: 0, stdout: '{"systemMessage":"look"}' })), false);
  assert.equal(quietHookEvent(sys('hook_response', { outcome: 'success', exit_code: 2, stderr: 'no' })), false);
  assert.equal(quietHookEvent(sys('hook_response', { outcome: 'error' })), false);
  assert.equal(quietHookEvent(sys('hook_response', { outcome: 'success', exit_code: 0, stderr: 'warn' })), false);
  assert.equal(quietHookEvent(sys('informational', { content: 'x' })), false);
  assert.equal(quietHookEvent({ type: 'assistant' }), false);
});

/* ---------- the same lines from a transcript (apaki/engine/history.js systemNote, hookNote) ---------- */

import { buildHistory, hookNote, slimEntry, systemNote } from '../apaki/engine/history.js';

test('history: system lines and hook attachments of a transcript become notices', () => {
  assert.equal(systemNote({ subtype: 'informational', content: 'UserPromptSubmit operation blocked by hook:\n[relay] answer', level: 'warning' }).label, 'Hook');
  assert.equal(systemNote({ subtype: 'away_summary', content: 'You wanted X.' }).label, 'Recap');
  assert.equal(systemNote({ subtype: 'local_command', content: '/resume', level: 'info' }).text, '> /resume');
  assert.equal(systemNote({ subtype: 'model_refusal_no_fallback', content: '', originalModel: 'claude-opus-5-5', apiRefusalExplanation: 'Blocked under policy.' }).text, 'Blocked under policy.');
  assert.equal(systemNote({ subtype: 'stop_hook_summary', hookErrors: [], preventedContinuation: false }), null, 'a quiet Stop hook run is not shown');
  assert.match(systemNote({ subtype: 'stop_hook_summary', hookErrors: ['boom'] }).text, /Stop hook error: boom/);
  assert.equal(systemNote({ subtype: 'turn_duration' }), null);
  assert.equal(hookNote({ type: 'hook_non_blocking_error', hookName: 'SessionStart:startup', stderr: 'No such file', exitCode: 127 }).text, 'SessionStart:startup hook error (exit 127): No such file');
  assert.equal(hookNote({ type: 'hook_cancelled', hookName: 'UserPromptSubmit', timedOut: false }).text, 'UserPromptSubmit hook was cancelled');
  assert.equal(hookNote({ type: 'hook_success', hookName: 'Stop', stdout: '' }), null, 'a quiet success stays out');
});

test('history: notices sit in order among the messages, as their own items', () => {
  const lines = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'test' } },
    { type: 'system', subtype: 'informational', uuid: 's1', parentUuid: 'u1', content: 'UserPromptSubmit operation blocked by hook:\nrelay reply', level: 'warning' },
    { type: 'attachment', uuid: 'a1', parentUuid: 's1', attachment: { type: 'hook_success', hookName: 'Stop' } },
    { type: 'assistant', uuid: 'x1', parentUuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ];
  const entries = lines.map((j) => slimEntry(j)).filter(Boolean);
  const h = buildHistory(entries, []);
  assert.deepEqual(h.items.map((i) => i.type), ['user', 'notice', 'assistant']);
  assert.equal(h.items[1].notice.text, 'UserPromptSubmit operation blocked by hook:\nrelay reply');
});
