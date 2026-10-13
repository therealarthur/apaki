/**
 * codex-map.js (apaki/engine), 2026-10-12: the Codex app-server's items, plans, approvals and questions in the shapes a
 * pane already draws. Pure functions, so these are plain input and output checks; the payloads are shaped like traffic
 * recorded from codex-cli 0.161.0 (names and texts made up).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS, approvalAsk, approvalReply, capPresets, clampPreset, codexId, contextFromUsage, limitsOf, effortFor, elicitationAsk, elicitationReply, friendlyError, hookMessage, isCodexSessionId,
  limitEvents, normalizeModels, plainCommand, presetOf, questionAsk, questionReply, reasoningText, rerouteMessage, threadIdOf, threadPermissions, threadRow, threadTitle, todoWriteOf,
  toolResultOf, toolUseOf, turnInput, turnPermissions, turnsToMessages, userInputText,
} from '../apaki/engine/codex-map.js';

test('ids: codex:<thread> in the lists, the bare thread id for the server', () => {
  assert.equal(codexId('01a1'), 'codex:01a1');
  assert.equal(threadIdOf('codex:01a1'), '01a1');
  assert.equal(threadIdOf('01a1'), '01a1');
  assert.equal(isCodexSessionId('codex:x'), true);
  assert.equal(isCodexSessionId('01a1'), false);
});

test('presets: full access is danger-full-access with approvals never; the server\'s settings read back as a preset', () => {
  assert.deepEqual(Object.keys(PRESETS), ['read-only', 'auto', 'full-access']);
  assert.deepEqual(threadPermissions('full-access'), { approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.deepEqual(threadPermissions('auto'), { approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.deepEqual(threadPermissions('read-only'), { approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.deepEqual(turnPermissions('full-access'), { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  assert.deepEqual(turnPermissions('read-only'), { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
  // An unknown mode is the middle preset, never full access.
  assert.deepEqual(threadPermissions('bypassPermissions'), { approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  // A restricted phone never asks: nobody could approve a command from it.
  assert.deepEqual(threadPermissions('read-only', { restricted: true }), { approvalPolicy: 'never', sandbox: 'read-only' });
  assert.deepEqual(turnPermissions('read-only', { restricted: true }), { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
  assert.equal(presetOf({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } }), 'full-access');
  assert.equal(presetOf({ approvalPolicy: 'never', sandbox: 'danger-full-access' }), 'full-access');
  assert.equal(presetOf({ approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } }), 'read-only');
  assert.equal(presetOf({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }), 'auto');
  assert.equal(presetOf({ approvalPolicy: { granular: {} }, sandbox: { type: 'externalSandbox' } }), 'auto');
  assert.equal(presetOf({}), 'auto');
});

test('a phone\'s access limits the presets: only Full may leave read-only', () => {
  assert.deepEqual(capPresets('full'), ['read-only', 'auto', 'full-access']);
  assert.deepEqual(capPresets('noshell'), ['read-only']);
  assert.deepEqual(capPresets('chat'), ['read-only']);
  assert.equal(clampPreset('full', 'full-access'), 'full-access');
  assert.equal(clampPreset('chat', 'full-access'), 'read-only');
  assert.equal(clampPreset('noshell', 'auto'), 'read-only');
});

test('models: each model keeps its own efforts; an effort the model lacks falls back to its default', () => {
  const list = normalizeModels([
    { id: 'm1', model: 'm1', displayName: 'Model One', description: 'd', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'a' }, { reasoningEffort: 'ultra', description: 'b' }] },
    { id: 'm2', model: 'm2', hidden: true, supportedReasoningEfforts: [] },
    { nope: true }, null,
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'm1', name: 'Model One', description: 'd', efforts: [{ value: 'low', description: 'a' }, { value: 'ultra', description: 'b' }], defaultEffort: 'low', isDefault: true, hidden: false, serviceTiers: [] });
  assert.deepEqual(list[1].efforts.map((e) => e.value), ['low', 'medium', 'high'], 'a model that lists none gets the common three');
  assert.equal(effortFor(list[0], 'ultra'), 'ultra');
  assert.equal(effortFor(list[0], 'medium'), 'low');
  assert.equal(effortFor(null, 'high'), 'high');
});

test('threads: a title from the name, else the words that were really typed; a row like a session\'s', () => {
  assert.equal(threadTitle({ name: '  Named   thread ' }), 'Named thread');
  assert.equal(threadTitle({ name: null, preview: '<environment_context>cwd</environment_context>' }), 'Codex conversation');
  assert.equal(threadTitle({ preview: 'Fix the build please' }), 'Fix the build please');
  const row = threadRow({ id: 't1', name: 'N', preview: 'Fix the build', cwd: 'C:\\p', gitInfo: { branch: 'main' }, updatedAt: 100, recencyAt: 200, originator: 'Codex Desktop' });
  assert.deepEqual(row, { id: 'codex:t1', title: 'N', firstPrompt: 'Fix the build', cwd: 'C:\\p', branch: 'main', lastModified: 200000, size: 0, codex: true, source: 'Codex Desktop' });
});

test('plainCommand: the shell wrapper comes off when it matches exactly, otherwise the command stays as sent', () => {
  assert.equal(plainCommand('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm run build"'), 'npm run build');
  assert.equal(plainCommand('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Force"'), 'Get-ChildItem -Force');
  assert.equal(plainCommand('pwsh -Command Get-Date'), 'Get-Date');
  assert.equal(plainCommand("bash -lc 'ls -la && pwd'"), 'ls -la && pwd');
  assert.equal(plainCommand('/bin/zsh -c "echo hi"'), 'echo hi');
  assert.equal(plainCommand('python build.py --fast'), 'python build.py --fast');
  assert.equal(plainCommand(''), '');
});

test('items: a command is a Bash or PowerShell line with its output; a failed exit marks the result', () => {
  const ps = { type: 'commandExecution', id: 'c1', command: 'powershell.exe -Command "npm test"', cwd: 'C:\\p', status: 'inProgress', aggregatedOutput: null, exitCode: null };
  assert.deepEqual(toolUseOf(ps), { type: 'tool_use', id: 'c1', name: 'PowerShell', input: { command: 'npm test', cwd: 'C:\\p' } });
  assert.equal(toolResultOf(ps), null, 'no result while it runs');
  assert.equal(toolUseOf({ ...ps, command: 'ls' }).name, 'Bash');
  const ok = toolResultOf({ ...ps, status: 'completed', aggregatedOutput: 'a\nb\n', exitCode: 0 });
  assert.deepEqual(ok, { type: 'tool_result', tool_use_id: 'c1', content: 'a\nb', is_error: false });
  const bad = toolResultOf({ ...ps, status: 'failed', aggregatedOutput: 'boom', exitCode: 2 });
  assert.equal(bad.is_error, true);
  assert.equal(bad.content, 'boom\n(exit code 2)');
  const declined = toolResultOf({ ...ps, status: 'declined' });
  assert.equal(declined.is_error, true);
  assert.match(declined.content, /did not run/);
  const huge = toolResultOf({ ...ps, status: 'completed', aggregatedOutput: 'x'.repeat(30000), exitCode: 0 });
  assert.ok(huge.content.length < 20100);
  assert.match(huge.content, /10000 more characters/);
});

test('items: file changes keep their diffs; MCP calls read like Claude\'s mcp__server__tool; searches list their results', () => {
  const patch = { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update', move_path: 'b.ts' }, diff: '@@ -1 +1 @@\n-a\n+b' }, { path: 'n.ts', kind: { type: 'add' }, diff: 'x' }] };
  const use = toolUseOf(patch);
  assert.equal(use.name, 'ApplyPatch');
  assert.deepEqual(use.input.changes[0], { path: 'a.ts', kind: 'update', move_path: 'b.ts', diff: '@@ -1 +1 @@\n-a\n+b' });
  assert.equal(use.input.changes[1].kind, 'add');
  assert.equal(toolResultOf(patch).content, 'Changed 2 files.');
  assert.equal(toolResultOf({ ...patch, status: 'declined' }).is_error, true);
  assert.equal(toolResultOf({ ...patch, status: 'failed' }).is_error, true);

  const mcp = { type: 'mcpToolCall', id: 'm1', server: 'apaki', tool: 'show', status: 'completed', arguments: { title: 'T' }, result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, error: null };
  assert.deepEqual(toolUseOf(mcp), { type: 'tool_use', id: 'm1', name: 'mcp__apaki__show', input: { title: 'T' } });
  assert.deepEqual(toolResultOf(mcp).content, [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  const failed = toolResultOf({ ...mcp, status: 'failed', result: null, error: { message: 'no server' } });
  assert.equal(failed.is_error, true);
  assert.equal(failed.content, 'no server');

  const search = { type: 'webSearch', id: 'w1', query: 'q', action: { type: 'search' }, results: [{ title: 'T', url: 'https://x.test/', snippet: 's' }] };
  assert.deepEqual(toolUseOf(search).input, { query: 'q' });
  assert.equal(toolResultOf(search).content, 'T - https://x.test/');
  assert.equal(toolResultOf({ ...search, results: [] }).content, 'Searched for "q"');

  assert.equal(toolUseOf({ type: 'agentMessage', id: 'a' }), null);
  assert.equal(toolUseOf({ type: 'reasoning', id: 'r' }), null);
  assert.equal(toolUseOf(null), null);
  assert.equal(toolUseOf({ type: 'subAgentActivity', id: 's', kind: 'spawned', agentPath: '/root/a' }).name, 'Subagent');
  assert.equal(toolUseOf({ type: 'dynamicToolCall', id: 'd', namespace: 'ns', tool: 't', arguments: {} }).name, 'ns__t');
});

test('reasoning: the summary, else the raw content', () => {
  assert.equal(reasoningText({ summary: ['One.', 'Two.'], content: ['raw'] }), 'One.\n\nTwo.');
  assert.equal(reasoningText({ summary: [], content: ['raw'] }), 'raw');
  assert.equal(reasoningText({ summary: [], content: [] }), '');
});

test('history: turns become the messages a pane draws, oldest first, with compaction markers and the notices a turn\'s end implies', () => {
  const turns = [
    { id: 't1', status: 'completed', startedAt: 1000, items: [
      { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Hi' }, { type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'mention', name: 'a.txt', path: 'C:\\a.txt' }] },
      { type: 'sleep', id: 'z' }, { type: 'hookPrompt', id: 'h' },
      { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] },
      { type: 'agentMessage', id: 'a1', text: 'Hello', phase: 'final_answer' },
    ] },
    { id: 't2', status: 'failed', startedAt: 2000, error: { message: 'out', codexErrorInfo: 'usageLimitExceeded' }, items: [{ type: 'contextCompaction', id: 'cc' }, { type: 'plan', id: 'p', text: 'the plan' }] },
    { id: 't3', status: 'interrupted', startedAt: 3000, items: [] },
  ];
  const m = turnsToMessages(turns);
  assert.deepEqual(m.map((x) => x.type), ['user', 'assistant', 'assistant', 'compact', 'assistant', 'notice', 'notice']);
  assert.deepEqual(m[0].message.content, [{ type: 'text', text: 'Hi' }, { type: 'image_marker' }, { type: 'text', text: '[file: a.txt]' }]);
  assert.equal(m[0].at, new Date(1000 * 1000).toISOString());
  assert.deepEqual(m[1].message.content, [{ type: 'thinking', thinking: 'thinking' }]);
  assert.equal(m[2].message.content[0].text, 'Hello');
  assert.equal(m[5].notice.tone, 'error');
  assert.match(m[5].notice.text, /usage limit/i);
  assert.deepEqual(m[6].notice, { text: 'Interrupted.', tone: 'dim', label: '' });
  assert.deepEqual(turnsToMessages(null), []);
  assert.deepEqual(userInputText([{ type: 'text', text: ' a ' }, { type: 'localImage', path: 'x' }]), { text: 'a', images: 1, files: [] });
});

test('plans: turn/plan/updated becomes a TodoWrite call, in_progress spelled the way todos.js reads it', () => {
  const u = todoWriteOf('p1', [{ step: 'Read', status: 'inProgress' }, { step: 'Write', status: 'pending' }, { step: '', status: 'completed' }, { step: 'Test', status: 'completed' }]);
  assert.deepEqual(u, { type: 'tool_use', id: 'p1', name: 'TodoWrite', input: { todos: [
    { content: 'Read', activeForm: '', status: 'in_progress' }, { content: 'Write', activeForm: '', status: 'pending' }, { content: 'Test', activeForm: '', status: 'completed' },
  ] } });
});

test('notices: errors in words, a reroute, hooks as Claude Code prints them, usage warnings', () => {
  assert.match(friendlyError({ message: 'try Friday', codexErrorInfo: 'usageLimitExceeded' }), /^You have reached your Codex usage limit\. try Friday$/);
  assert.equal(friendlyError({ message: 'plain failure' }), 'plain failure');
  assert.equal(friendlyError({ codexErrorInfo: 'contextWindowExceeded' }).startsWith('This conversation no longer fits'), true);
  assert.equal(friendlyError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } }, message: 'down' }), 'down');
  assert.equal(friendlyError(null), 'The turn failed.');
  assert.match(rerouteMessage({ fromModel: 'a', toModel: 'b', reason: 'highRiskCyberActivity' }).content, /from a to b because the request looked like high-risk cyber activity/);

  assert.deepEqual(hookMessage({ eventName: 'preToolUse', status: 'failed', entries: [{ kind: 'error', text: 'no' }] }), { type: 'system', subtype: 'hook_response', hook_name: 'preToolUse', hook_event: 'preToolUse', outcome: 'error', exit_code: 1, stderr: 'no', stdout: '' });
  assert.equal(hookMessage({ eventName: 'x', status: 'blocked', entries: [] }).exit_code, 2);
  assert.equal(hookMessage({ eventName: 'x', status: 'stopped', entries: [] }).outcome, 'cancelled');
  assert.equal(hookMessage({ eventName: 'x', status: 'completed', entries: [{ kind: 'context', text: 'fine' }] }), null, 'a quiet success is not shown');
  assert.match(hookMessage({ eventName: 'stop', status: 'completed', entries: [{ kind: 'warning', text: 'careful' }] }).content, /stop hook: careful/);
  assert.equal(hookMessage(null), null);

  const warn = limitEvents({ primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 9 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } });
  assert.deepEqual(warn, [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 85, resetsAt: 9 } }]);
  const out = limitEvents({ primary: { usedPercent: 100, windowDurationMins: 10080 } });
  assert.equal(out[0].rate_limit_info.status, 'rejected');
  assert.equal(out[0].rate_limit_info.rateLimitType, 'seven_day');
  assert.deepEqual(limitEvents({ primary: { usedPercent: 10 } }), []);
  assert.deepEqual(limitEvents(null), []);
});

test('context: the last call over the window; no window, no percentage', () => {
  const usage = { total: { totalTokens: 9000 }, last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 300, reasoningOutputTokens: 50 }, modelContextWindow: 10000 };
  const c = contextFromUsage(usage, { model: 'm', threadId: 't1' });
  assert.equal(c.percentage, 15);
  assert.equal(c.totalTokens, 1500);
  assert.equal(c.maxTokens, 10000);
  assert.equal(c.sessionId, 'codex:t1');
  assert.deepEqual(c.used, [{ name: 'Input', tokens: 200 }, { name: 'Cached input', tokens: 1000 }, { name: 'Output', tokens: 250 }, { name: 'Reasoning', tokens: 50 }]);
  assert.equal(contextFromUsage({ ...usage, modelContextWindow: null }).percentage, null);
  assert.equal(contextFromUsage({ ...usage, last: { totalTokens: 99999 } }).percentage, 100);
  // The user's own auto-compact setting shows as the percent of the window where Codex compacts; unset or nonsense shows nothing.
  assert.equal(c.autoCompact, null);
  assert.equal(contextFromUsage(usage, { autoCompactLimit: 9000 }).autoCompact, 90);
  assert.equal(contextFromUsage(usage, { autoCompactLimit: 20000 }).autoCompact, 100);
  assert.equal(contextFromUsage(usage, { autoCompactLimit: 'x' }).autoCompact, null);
  assert.equal(contextFromUsage({ ...usage, modelContextWindow: null }, { autoCompactLimit: 9000 }).autoCompact, null);
});

test('turn input: text, pictures as data URLs, other files as mentions of where they were saved', () => {
  assert.deepEqual(turnInput('hi', [{ media_type: 'image/png', data: 'AAAA' }, { media_type: 'application/pdf', data: 'BBBB' }], [{ name: 'a.pdf', path: 'C:\\x\\a.pdf' }]), [
    { type: 'text', text: 'hi', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'mention', name: 'a.pdf', path: 'C:\\x\\a.pdf' },
  ]);
  assert.deepEqual(turnInput('  ', [], []), []);
  assert.deepEqual(turnInput('', [{ media_type: 'image/webp', data: 'C' }]), [{ type: 'image', url: 'data:image/webp;base64,C' }]);
});

test('questions: Codex\'s request_user_input is the AskUserQuestion Claude has; answers go back by question id', () => {
  const ask = questionAsk({ questions: [
    { id: 'q1', header: 'Pick', question: 'Which?', isOther: true, isSecret: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: '' }] },
    { id: 'q2', header: 'Key', question: 'Which?', isSecret: true, options: [] },
  ] });
  assert.equal(ask.toolName, 'AskUserQuestion');
  assert.deepEqual(ask.input.questions.map((q) => q.question), ['Which?', 'Which? (2)'], 'two questions with one text stay apart');
  assert.deepEqual(ask.input.questions[0].options, [{ label: 'A', description: 'first' }, { label: 'B', description: '' }]);
  assert.equal(ask.input.questions[1].secret, true);
  assert.deepEqual(questionReply(ask, { behavior: 'allow', updatedInput: { answers: { 'Which?': 'B', 'Which? (2)': 'hunter2' } } }), { answers: { q1: { answers: ['B'] }, q2: { answers: ['hunter2'] } } });
  assert.deepEqual(questionReply(ask, { behavior: 'allow', updatedInput: { answers: { 'Which?': '  ' } } }), { answers: { q1: { answers: [] }, q2: { answers: [] } } });
  assert.deepEqual(questionReply(ask, { behavior: 'deny' }), { answers: { q1: { answers: [] }, q2: { answers: [] } } }, 'a skip answers nothing, it never invents an answer');
  assert.deepEqual(questionReply(ask, null), { answers: { q1: { answers: [] }, q2: { answers: [] } } });
});

test('approvals: a command, a patch and more access ask in Codex\'s words; replies never approve by accident', () => {
  const cmd = approvalAsk('item/commandExecution/requestApproval', { itemId: 'i1', command: 'npm install', cwd: 'C:\\p', reason: 'Needs network', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
  assert.equal(cmd.kind, 'command');
  assert.equal(cmd.toolName, 'Bash');
  assert.deepEqual(cmd.input, { command: 'npm install', description: 'Needs network' });
  assert.equal(cmd.permission.title, 'Run this command?');
  assert.equal(cmd.permission.codex, true);
  assert.deepEqual(cmd.permission.labels, { once: 'Approve once', always: 'Approve for this session', deny: 'Deny' });
  assert.deepEqual(cmd.permission.always, { lines: ['Approve this command for the rest of this session'] });
  assert.deepEqual(approvalReply(cmd, { behavior: 'allow' }), { decision: 'accept' });
  assert.deepEqual(approvalReply(cmd, { behavior: 'allow', always: true }), { decision: 'acceptForSession' });
  assert.deepEqual(approvalReply(cmd, { behavior: 'deny', message: 'no' }), { decision: 'decline' });
  assert.deepEqual(approvalReply(cmd, null), { decision: 'decline' });
  assert.deepEqual(approvalReply(cmd, { behavior: 'maybe' }), { decision: 'decline' });
  assert.deepEqual(approvalReply(cmd, 'allow'), { decision: 'decline' });

  // The server offers no session approval: there is no "for this session" button, and Always settles as once.
  const once = approvalAsk('item/commandExecution/requestApproval', { itemId: 'i', command: 'x', availableDecisions: ['accept', 'decline'] });
  assert.equal(once.permission.always, null);
  assert.deepEqual(approvalReply(once, { behavior: 'allow', always: true }), { decision: 'accept' });
  const amend = approvalAsk('item/commandExecution/requestApproval', { itemId: 'i', command: 'npm test', proposedExecpolicyAmendment: ['npm', 'test'], availableDecisions: ['accept', 'acceptWithExecpolicyAmendment', 'decline'] });
  assert.match(amend.permission.always.lines[0], /start with "npm test"/);
  const net = approvalAsk('item/commandExecution/requestApproval', { itemId: 'i', command: 'curl x', networkApprovalContext: { host: 'x.test' } });
  assert.equal(net.permission.title, 'Allow network access?');

  const item = { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '+x' }] };
  const patch = approvalAsk('item/fileChange/requestApproval', { itemId: 'f1', grantRoot: 'C:\\p' }, { item });
  assert.equal(patch.toolName, 'ApplyPatch');
  assert.equal(patch.input.changes[0].path, 'a.ts');
  assert.equal(patch.permission.title, 'Apply these changes?');
  assert.match(patch.permission.always.lines[0], /edits under C:\\p/);
  assert.deepEqual(approvalReply(patch, { behavior: 'allow', always: true }), { decision: 'acceptForSession' });
  assert.deepEqual(approvalReply(patch, { behavior: 'deny' }), { decision: 'decline' });

  const perms = approvalAsk('item/permissions/requestApproval', { itemId: 'p1', cwd: 'C:\\p', permissions: { fileSystem: { read: ['C:\\r'], write: ['C:\\w'] }, network: { enabled: true } } });
  assert.equal(perms.toolName, 'Permissions');
  assert.deepEqual(perms.input.rows, [['Read access', 'C:\\r'], ['Write access', 'C:\\w'], ['Network', 'on']]);
  perms.requested = { network: { enabled: true } };
  assert.deepEqual(approvalReply(perms, { behavior: 'allow', always: true }), { permissions: { network: { enabled: true } }, scope: 'session' });
  assert.deepEqual(approvalReply(perms, { behavior: 'allow' }), { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(approvalReply(perms, { behavior: 'deny' }), { permissions: {}, scope: 'turn' }, 'denied grants nothing');

  const legacy = approvalAsk('execCommandApproval', { callId: 'c', command: ['npm', 'test'], cwd: 'C:\\p' });
  assert.equal(legacy.input.command, 'npm test');
  assert.deepEqual(approvalReply(legacy, { behavior: 'allow' }), { decision: 'approved' });
  assert.deepEqual(approvalReply(legacy, { behavior: 'allow', always: true }), { decision: 'approved_for_session' });
  assert.deepEqual(approvalReply(legacy, { behavior: 'deny' }), { decision: 'denied' });
  const lp = approvalAsk('applyPatchApproval', { callId: 'c', fileChanges: { 'a.ts': { type: 'update', unified_diff: '+x' } } });
  assert.equal(lp.input.changes[0].path, 'a.ts');
  assert.deepEqual(approvalReply(lp, null), { decision: 'denied' });
  assert.equal(approvalAsk('something/else', {}), null);
});

test('elicitation: a tool-call approval is a permission sheet, a form the question sheet, a link asks first, the rest is declined', () => {
  const approval = elicitationAsk({ serverName: 'docs', message: 'Let docs search?', _meta: { codex_approval_kind: 'mcp_tool_call', tool_title: 'search', persist: ['session', 'always'], tool_params: { q: 'x' } } });
  assert.equal(approval.kind, 'mcpApproval');
  assert.equal(approval.toolName, 'mcp__docs__search');
  assert.deepEqual(approval.input, { q: 'x' });
  assert.equal(approval.permission.mcpServer.name, 'docs');
  assert.match(approval.permission.always.lines[0], /rest of this session/);
  assert.deepEqual(elicitationReply(approval, { behavior: 'allow' }), { action: 'accept', content: null, _meta: null });
  assert.deepEqual(elicitationReply(approval, { behavior: 'allow', always: true }), { action: 'accept', content: null, _meta: { persist: 'session' } });
  assert.deepEqual(elicitationReply(approval, { behavior: 'deny' }), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(elicitationReply(approval, null), { action: 'decline', content: null, _meta: null });

  const form = elicitationAsk({ serverName: 'docs', mode: 'form', message: 'Details', requestedSchema: { properties: { space: { type: 'string', title: 'Space', enum: ['eng', 'ops'] }, count: { type: 'integer', description: 'How many' }, ok: { type: 'boolean' } }, required: ['space'] } });
  assert.equal(form.kind, 'form');
  assert.deepEqual(form.input.questions.map((q) => q.question), ['Space', 'Count (optional): How many', 'Ok (optional)']);
  assert.deepEqual(form.input.questions[0].options.map((o) => o.label), ['eng', 'ops']);
  assert.deepEqual(form.input.questions[2].options.map((o) => o.label), ['Yes', 'No']);
  const reply = elicitationReply(form, { behavior: 'allow', updatedInput: { answers: { Space: 'ops', 'Count (optional): How many': '3', 'Ok (optional)': 'Yes' } } });
  assert.deepEqual(reply, { action: 'accept', content: { space: 'ops', count: 3, ok: true }, _meta: null });
  assert.equal(elicitationReply(form, { behavior: 'deny' }).action, 'decline');

  const link = elicitationAsk({ serverName: 'auth', mode: 'url', url: 'https://login.example/x', message: 'Sign in' });
  assert.equal(link.kind, 'url');
  assert.equal(elicitationReply(link, { behavior: 'allow' }).action, 'accept');
  assert.equal(elicitationAsk({ serverName: 's', mode: 'url', url: 'javascript:alert(1)' }), null, 'only web addresses');
  assert.equal(elicitationAsk({ serverName: 's', mode: 'openai/userVerification', challenge: 'c' }), null);
  assert.equal(elicitationAsk(null), null);
});

test('limitsOf: the plan windows as the chip lists them', () => {
  assert.deepEqual(limitsOf({ primary: { usedPercent: 29.4, windowDurationMins: 300, resetsAt: 100 }, secondary: { usedPercent: 140, windowDurationMins: 10080, resetsAt: 200 } }), [
    { label: '5-hour', usedPercent: 29, resetsAt: 100 }, { label: 'Weekly', usedPercent: 100, resetsAt: 200 },
  ]);
  assert.deepEqual(limitsOf({ primary: { usedPercent: 'x' }, secondary: null }), []);
  assert.deepEqual(limitsOf(null), []);
});
