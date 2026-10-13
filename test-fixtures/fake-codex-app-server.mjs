#!/usr/bin/env node
/**
 * A stand-in for `codex app-server` (codex-cli 0.161.0 protocol) for Apaki's tests.
 *
 * Kept outside test/ on purpose: node --test runs every .js and .mjs file under a folder named test as a test file, and
 * this one would sit there waiting for input. It speaks the same JSON-RPC lines over stdio and replays traffic shaped like the real thing, recorded on 2026-10-12
 * (model/list, thread/list, thread/resume, thread/turns/list and the item and turn notifications of a streamed turn;
 * the names and texts here are made up). A turn does what its message says, like the fake Agent SDK in
 * test/apaki-permissions.test.js:
 *
 *   (anything)    streams "echo: <text>" in three deltas, then completes
 *   think: x      a reasoning item with a summary, then the echo
 *   run: <cmd>    a commandExecution with two output deltas and an exit code (fail: exit 1)
 *   plan: a|b|c   turn/plan/updated with the steps, the first in progress
 *   patch: <file> a fileChange (asks for approval first), a turn diff
 *   approve: <c>  a commandExecution that waits for item/commandExecution/requestApproval; the decision is echoed
 *   ask: <q>      item/tool/requestUserInput with two options; the answers are echoed
 *   elicit        mcpServer/elicitation/request (a form with an enum field); the reply is echoed
 *   hang          streams a first delta and waits: turn/interrupt completes it as interrupted, turn/steer as a steer
 *   fail: <msg>   the turn ends failed with that message (usageLimitExceeded)
 *   hook          a failed hook run, then the echo
 *   limit         account/rateLimits/updated at 91 percent
 *   reroute       model/rerouted, then the echo
 *
 * Every request the server receives is appended to $FAKE_CODEX_LOG as one JSON line ({ in: {...} }), with the process
 * arguments and the BROWSER variable first, so a test can check what the client asked for and how it was started.
 */

import fs from 'node:fs';
import readline from 'node:readline';

const LOG = process.env.FAKE_CODEX_LOG || '';
const log = (o) => { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`); };
log({ argv: process.argv.slice(2), browser: process.env.BROWSER || null, token: process.env.APAKI_OPEN_TOKEN || null });

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = (method, params) => out({ method, params });
let serverIdSeq = 100;
const waiting = new Map(); // server request id -> resolve(response)
/** Sends a server request and resolves with the client's response. */
const ask = (method, params) => new Promise((resolve) => { const id = ++serverIdSeq; waiting.set(id, resolve); out({ id, method, params }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = Math.floor(Date.now() / 1000);
const MODELS = [
  { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', modelSpecialty: null, hidden: false, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((e) => ({ reasoningEffort: e, description: `${e} reasoning` })), defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], isDefault: true, serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }] },
  { id: 'gpt-6-astra', model: 'gpt-6-astra', upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', modelSpecialty: null, hidden: false, supportedReasoningEfforts: ['low', 'medium', 'high'].map((e) => ({ reasoningEffort: e, description: `${e} reasoning` })), defaultReasoningEffort: 'medium', inputModalities: ['text'], isDefault: false },
  { id: 'gpt-hidden', model: 'gpt-hidden', hidden: true, displayName: 'Hidden', description: '', supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false },
];
const CONFIG = JSON.parse(process.env.FAKE_CODEX_CONFIG || '{"model":"gpt-6.1-sol","model_reasoning_effort":"low","approval_policy":"on-request","sandbox_mode":"workspace-write"}');

const thread = (id, extra = {}) => ({
  id, sessionId: id, preview: `Preview of ${id.slice(0, 8)}`, ephemeral: false, modelProvider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'low', createdAt: NOW - 3600, updatedAt: NOW - 60, recencyAt: NOW - 60,
  status: { type: 'notLoaded' }, path: null, cwd: process.env.FAKE_CODEX_CWD || process.cwd(), cliVersion: '0.161.0', originator: 'Codex Desktop', source: 'vscode', gitInfo: { sha: null, branch: 'main', originUrl: null }, name: null, turns: [], ...extra,
});
const ids = { small: '01a00000-0000-7000-8000-000000000001', big: '01a00000-0000-7000-8000-000000000002' };
const threads = new Map([[ids.small, thread(ids.small, { name: 'Small thread' })], [ids.big, thread(ids.big, { name: 'Big thread' })]]);

/** History the turns/list answers with: small = one turn of every item kind; big = 200 turns of a question and an answer (400 messages: more than one page). */
const hist = new Map();
const goals = new Map();
hist.set(ids.small, [{
  id: '01a00000-0000-7000-8000-0000000000a1', status: 'completed', startedAt: NOW - 600, completedAt: NOW - 590, durationMs: 10000, error: null, itemsView: 'full',
  items: [
    { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'Fix the build', text_elements: [] }] },
    { type: 'reasoning', id: 'r1', summary: ['Looking at the build script first.'], content: [] },
    { type: 'commandExecution', id: 'c1', command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm run build"', cwd: 'C:\\proj', source: 'unifiedExecStartup', status: 'failed', commandActions: [], aggregatedOutput: 'error TS2304', exitCode: 1, durationMs: 900 },
    { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'C:\\proj\\a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep' }] },
    { type: 'mcpToolCall', id: 'm1', server: 'apaki', tool: 'show', status: 'completed', arguments: { title: 'Report', kind: 'markdown', content: '# hi' }, result: { content: [{ type: 'text', text: 'Showing "Report" to the user in Apaki (artifact report-1234, rev 1, markdown).' }] }, error: null },
    { type: 'webSearch', id: 'w1', query: 'tsc error 2304', action: { type: 'search', query: 'tsc error 2304', queries: ['tsc error 2304'] }, results: [{ type: 'text_result', title: 'TS2304', url: 'https://example.com/ts2304', snippet: 'x' }] },
    { type: 'contextCompaction', id: 'cc1' },
    { type: 'agentMessage', id: 'a1', text: 'Fixed the **build**.', phase: 'final_answer', memoryCitation: null, delivery: null },
  ],
}]);
hist.set(ids.big, Array.from({ length: 200 }, (_, i) => ({
  id: `01a00000-0000-7000-8000-${String(1000 + i).padStart(12, '0')}`, status: 'completed', startedAt: NOW - 3000 + i * 10, completedAt: NOW - 2990 + i * 10, durationMs: 1000, error: null, itemsView: 'full',
  items: [{ type: 'userMessage', id: `bu${i}`, content: [{ type: 'text', text: `Question ${i}`, text_elements: [] }] }, { type: 'agentMessage', id: `ba${i}`, text: `Answer ${i}`, phase: 'final_answer' }],
})));

let turnSeq = 0;
const active = new Map(); // thread id -> { turnId, release(kind) }

async function runTurn(threadId, input, params) {
  const turnId = `01a00000-0000-7000-8000-${String(9000 + ++turnSeq).padStart(12, '0')}`;
  const text = input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  const turn = (status, extra = {}) => ({ id: turnId, items: [], status, error: null, startedAt: NOW, completedAt: status === 'inProgress' ? null : NOW, durationMs: status === 'inProgress' ? null : 1200, ...extra });
  const base = { threadId, turnId };
  note('turn/started', { threadId, turn: turn('inProgress') });
  note('item/started', { ...base, startedAtMs: Date.now(), item: { type: 'userMessage', id: `um-${turnId}`, clientId: params.clientUserMessageId || null, content: input } });
  note('item/completed', { ...base, completedAtMs: Date.now(), item: { type: 'userMessage', id: `um-${turnId}`, clientId: params.clientUserMessageId || null, content: input } });
  let status = 'completed';
  let error = null;
  let reply = `echo: ${text}`;
  const m = /^(think|run|plan|patch|approve|ask|elicit|hang|fail|hook|limit|reroute)\b:?\s*(.*)$/s.exec(text);
  const kind = m?.[1];
  const arg = m?.[2] || '';
  if (kind === 'think') {
    const item = { type: 'reasoning', id: `rs-${turnId}`, summary: [], content: [] };
    note('item/started', { ...base, startedAtMs: Date.now(), item });
    note('item/reasoning/summaryTextDelta', { ...base, itemId: item.id, summaryIndex: 0, delta: `Thinking about ${arg}` });
    note('item/completed', { ...base, completedAtMs: Date.now(), item: { ...item, summary: [`Thinking about ${arg}`] } });
  } else if (kind === 'run') {
    const item = { type: 'commandExecution', id: `ce-${turnId}`, command: arg, cwd: process.cwd(), source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    note('item/started', { ...base, startedAtMs: Date.now(), item });
    note('item/commandExecution/outputDelta', { ...base, itemId: item.id, delta: 'line one\n' });
    await sleep(40);
    note('item/commandExecution/outputDelta', { ...base, itemId: item.id, delta: 'line two\n' });
    const bad = /fail/.test(arg);
    note('item/completed', { ...base, completedAtMs: Date.now(), item: { ...item, status: bad ? 'failed' : 'completed', aggregatedOutput: 'line one\nline two\n', exitCode: bad ? 1 : 0, durationMs: 80 } });
  } else if (kind === 'plan') {
    note('turn/plan/updated', { ...base, explanation: null, plan: arg.split('|').map((s, i) => ({ step: s.trim(), status: i === 0 ? 'inProgress' : 'pending' })) });
  } else if (kind === 'patch') {
    const item = { type: 'fileChange', id: `fc-${turnId}`, status: 'inProgress', changes: [{ path: arg || 'a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }] };
    note('item/started', { ...base, startedAtMs: Date.now(), item });
    const r = await ask('item/fileChange/requestApproval', { ...base, itemId: item.id, startedAtMs: Date.now(), reason: 'Write access', grantRoot: null });
    const ok = r?.decision === 'accept' || r?.decision === 'acceptForSession';
    note('serverRequest/resolved', { threadId, requestId: serverIdSeq });
    note('turn/diff/updated', { ...base, diff: `diff --git a/${arg || 'a.txt'} b/${arg || 'a.txt'}\n--- a/${arg || 'a.txt'}\n+++ b/${arg || 'a.txt'}\n@@ -1 +1 @@\n-old\n+new\n` });
    note('item/completed', { ...base, completedAtMs: Date.now(), item: { ...item, status: ok ? 'completed' : 'declined' } });
    reply = `patch ${JSON.stringify(r)}`;
  } else if (kind === 'approve') {
    const item = { type: 'commandExecution', id: `ap-${turnId}`, command: arg, cwd: process.cwd(), source: 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    note('item/started', { ...base, startedAtMs: Date.now(), item });
    const r = await ask('item/commandExecution/requestApproval', { ...base, itemId: item.id, startedAtMs: Date.now(), command: arg, cwd: process.cwd(), reason: 'Needs network', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
    const ok = r?.decision === 'accept' || r?.decision === 'acceptForSession';
    note('item/completed', { ...base, completedAtMs: Date.now(), item: { ...item, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'ran' : '', exitCode: ok ? 0 : null } });
    reply = `approval ${JSON.stringify(r)}`;
  } else if (kind === 'ask') {
    const r = await ask('item/tool/requestUserInput', { ...base, itemId: `q-${turnId}`, isBlocking: true, questions: [{ header: 'Pick', id: 'choice', question: arg || 'Which one?', isOther: true, isSecret: false, options: [{ label: 'Alpha', description: 'The first' }, { label: 'Beta', description: 'The second' }] }] });
    reply = `answers ${JSON.stringify(r)}`;
  } else if (kind === 'elicit') {
    const r = await ask('mcpServer/elicitation/request', { threadId, turnId, serverName: 'docs', mode: 'form', message: 'Which space?', requestedSchema: { type: 'object', properties: { space: { type: 'string', title: 'Space', enum: ['eng', 'ops'] } }, required: ['space'] } });
    reply = `elicitation ${JSON.stringify(r)}`;
  } else if (kind === 'fail') {
    status = 'failed';
    error = { message: arg || 'boom', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
    note('error', { ...base, error, willRetry: false });
  } else if (kind === 'hook') {
    note('hook/completed', { threadId, turnId, run: { id: 'h1', eventName: 'preToolUse', status: 'failed', entries: [{ kind: 'error', text: 'policy said no' }], executionMode: 'sync', handlerType: 'command', scope: 'thread', sourcePath: 'x', startedAt: NOW, displayOrder: 0 } });
  } else if (kind === 'limit') {
    note('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: NOW + 3600 }, secondary: null, planType: 'pro', rateLimitReachedType: null } });
  } else if (kind === 'reroute') {
    note('model/rerouted', { ...base, fromModel: 'gpt-6.1-sol', toModel: 'gpt-6-astra', reason: 'highRiskCyberActivity' });
  } else if (kind === 'hang') {
    const id = `am-${turnId}`;
    note('item/started', { ...base, startedAtMs: Date.now(), item: { type: 'agentMessage', id, text: '', phase: null } });
    note('item/agentMessage/delta', { ...base, itemId: id, delta: 'working' });
    const how = await new Promise((resolve) => { active.set(threadId, { turnId, release: resolve }); });
    active.delete(threadId);
    if (how.kind === 'interrupt') status = 'interrupted';
    else reply = `steered: ${how.text}`;
    if (status === 'interrupted') { note('turn/completed', { threadId, turn: turn('interrupted') }); return; }
  }
  if (status !== 'failed') {
    const id = `am-${turnId}-r`;
    note('item/started', { ...base, startedAtMs: Date.now(), item: { type: 'agentMessage', id, text: '', phase: 'final_answer' } });
    const third = Math.ceil(reply.length / 3);
    for (let i = 0; i < reply.length; i += third) { note('item/agentMessage/delta', { ...base, itemId: id, delta: reply.slice(i, i + third) }); await sleep(5); }
    note('item/completed', { ...base, completedAtMs: Date.now(), item: { type: 'agentMessage', id, text: reply, phase: 'final_answer', memoryCitation: null, delivery: null } });
    note('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { totalTokens: 3000, inputTokens: 2500, cachedInputTokens: 2000, outputTokens: 500, reasoningOutputTokens: 100 }, last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 300, reasoningOutputTokens: 50 }, modelContextWindow: 10000 } });
  }
  note('turn/completed', { threadId, turn: turn(status, { error }) });
}

const handlers = {
  initialize: () => ({ userAgent: 'fake-codex/0.161.0', codexHome: 'C:\\fake', platformFamily: 'windows', platformOs: 'windows' }),
  'model/list': () => ({ data: MODELS.filter((m) => !m.hidden), nextCursor: null }),
  'config/read': () => ({ config: CONFIG, origins: {} }),
  'account/read': () => ({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' }, requiresOpenaiAuth: true }),
  'account/rateLimits/read': () => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: NOW + 3600 }, secondary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: NOW + 5 * 86400 }, planType: 'pro', rateLimitReachedType: null } }),
  'thread/list': (p) => ({ data: [...threads.values()].filter(() => !p.archived), nextCursor: null }),
  'thread/read': (p) => ({ thread: threads.get(p.threadId) || (() => { throw Object.assign(new Error('thread not found'), { code: -32600 }); })() }),
  'thread/resume': (p) => {
    const t = threads.get(p.threadId);
    if (!t) throw Object.assign(new Error(`no rollout found for thread id ${p.threadId}`), { code: -32600 });
    const permissive = p.sandbox === 'danger-full-access';
    return { thread: t, model: p.model || t.model, modelProvider: 'openai', reasoningEffort: t.reasoningEffort, cwd: t.cwd, approvalPolicy: p.approvalPolicy || 'on-request', approvalsReviewer: 'user', sandbox: { type: permissive ? 'dangerFullAccess' : p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
  },
  'thread/start': (p) => {
    const id = `01a00000-0000-7000-8000-${String(5000 + threads.size).padStart(12, '0')}`;
    const t = thread(id, { cwd: p.cwd || process.cwd(), preview: '' });
    threads.set(id, t);
    hist.set(id, []);
    return { thread: t, model: p.model || 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'low', cwd: t.cwd, approvalPolicy: p.approvalPolicy || 'on-request', approvalsReviewer: 'user', sandbox: { type: p.sandbox === 'danger-full-access' ? 'dangerFullAccess' : p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
  },
  'thread/turns/list': (p) => {
    const all = (hist.get(p.threadId) || []).slice().reverse(); // newest first
    const start = p.cursor ? Number(JSON.parse(p.cursor).at) : 0;
    const n = p.limit || 10;
    const data = all.slice(start, start + n);
    const next = start + n < all.length ? JSON.stringify({ at: start + n }) : null;
    return { data, nextCursor: next, backwardsCursor: null };
  },
  'turn/start': (p) => {
    const t = threads.get(p.threadId);
    if (!t) throw new Error('unknown thread');
    setTimeout(() => runTurn(p.threadId, p.input || [], p).catch((e) => process.stderr.write(`fake turn failed: ${e.stack}\n`)), 5);
    return { turn: { id: `01a00000-0000-7000-8000-${String(9000 + turnSeq + 1).padStart(12, '0')}`, items: [], status: 'inProgress', error: null } };
  },
  'turn/steer': (p) => {
    const a = active.get(p.threadId);
    if (!a || a.turnId !== p.expectedTurnId) throw Object.assign(new Error('expected turn id does not match the active turn'), { code: -32600 });
    a.release({ kind: 'steer', text: (p.input || []).filter((i) => i.type === 'text').map((i) => i.text).join(' ') });
    return { turnId: a.turnId };
  },
  'turn/interrupt': (p) => {
    const a = active.get(p.threadId);
    if (a) a.release({ kind: 'interrupt' });
    return {};
  },
  'thread/name/set': (p) => { const t = threads.get(p.threadId); if (t) { t.name = p.name; note('thread/name/updated', { threadId: p.threadId, threadName: p.name }); } return {}; },
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  'thread/compact/start': (p) => {
    setTimeout(() => { note('item/started', { threadId: p.threadId, turnId: 'tc', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc-live' } }); note('item/completed', { threadId: p.threadId, turnId: 'tc', completedAtMs: 2, item: { type: 'contextCompaction', id: 'cc-live' } }); }, 20);
    return {};
  },
  'mcpServerStatus/list': () => ({ data: [{ name: 'apaki', authStatus: 'unsupported', tools: { show: {} } }], nextCursor: null }),
  'skills/list': (p) => ({ data: (p.cwds || [process.cwd()]).map((cwd) => ({ cwd, errors: [], skills: [
    { name: 'deploy', description: 'Deploy the app to staging, then check it', path: 'C:\skills\deploy\SKILL.md', enabled: true, scope: 'user', interface: { shortDescription: 'Ship the current branch' } },
    { name: 'review', description: 'Shadows a command', path: 'C:\skills\review\SKILL.md', enabled: true, scope: 'user' },
    { name: 'off', description: 'Switched off', path: 'C:\skills\off\SKILL.md', enabled: false, scope: 'user' },
  ] })) }),
  'thread/revert': (p) => {
    const turns = hist.get(p.threadId) || [];
    const at = turns.findIndex((t) => t.id === p.beforeTurnId);
    if (at < 0) throw Object.assign(new Error('turn not found'), { code: -32600 });
    hist.set(p.threadId, turns.slice(0, at));
    return { thread: { ...threads.get(p.threadId), turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  },
  'thread/goal/get': (p) => ({ goal: goals.get(p.threadId) || null }),
  'thread/goal/set': (p) => {
    const g = { threadId: p.threadId, objective: p.objective, status: p.status || 'active', tokenBudget: p.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: NOW, updatedAt: NOW };
    goals.set(p.threadId, g);
    return { goal: g };
  },
  'thread/goal/clear': (p) => ({ cleared: goals.delete(p.threadId) }),
  'review/start': (p) => ({ turn: { id: 'review-turn', items: [], status: 'inProgress' }, reviewThreadId: p.threadId }),
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  log({ in: m });
  // A reply to one of our server requests.
  if (m.id !== undefined && !m.method && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); return; }
  if (!m.method || m.id === undefined) return;
  const h = handlers[m.method];
  if (!h) { out({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } }); return; }
  try { out({ id: m.id, result: h(m.params || {}) }); } catch (e) { out({ id: m.id, error: { code: e.code || -32600, message: e.message } }); }
});
rl.on('close', () => process.exit(0));
