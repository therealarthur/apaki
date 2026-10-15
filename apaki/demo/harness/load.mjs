/**
 * load.mjs: the "load" workspace of Apaki's demo harness (2026-10-15).
 *
 * The report: "our apaki app gets kind of laggy with multiple tabs and panes running at the same time - it doesnt stay
 * sharp - why?" Measured on that PC: the window's page at 119% of a core with 4 of 8 panes working across 5 tabs, and
 * stalls of several seconds with nothing working. This workspace is a window that busy, on invented data, so the
 * problem can be reproduced, measured and checked again (apaki/demo/perf.mjs drives it; desktop.html?ws=load shows it):
 *
 *   - five tabs and thirteen conversations, five of them working at once (three in the tab on screen, two in tabs
 *     behind it), each turn streamed the way the Agent SDK sends it: thinking and tool input deltas, text deltas,
 *     tool calls with long output, a subagent whose own traffic comes through too, then the next turn;
 *   - long transcripts: two panes with 2400 messages drawn (as after Load all), four with a 300 message first page
 *     of 3000 (the engine's page size);
 *   - the side panel of the first tab with three viewers (a Markdown note, a diff, a subagent);
 *   - a session list of about 640 conversations, and 26 git repositories whose numbers change every 2 to 3 seconds
 *     (the engine sends `worktrees` each time), the list again every 10 seconds, subagent counts as they change.
 *
 * Everything is made up (a fictional team at "Acme"), like the rest of the harness. Node safe: no DOM use.
 *
 * Exports:
 *   LOAD_PANES                 which demo session each pane holds and how long its transcript is
 *   loadSessions(now)          the list: the demo's sessions plus the generated ones
 *   loadRepos()                the repositories (worktrees.mjs shape)
 *   tickRepos(repos, rnd)      moves a few numbers, as a turn ending or a file save would
 *   loadHistory(id, now)       the transcript event fields for a session of the load workspace, or null
 *   LOAD_SCRIPTS               the turn script the working panes play, over and over
 *   loadPreset()               the starting workspace (PRESETS.load in data.mjs)
 */

import { ID, CWD, MIN, HOUR, DAY, buildSessions } from './data.mjs';

/* the dice: a small seeded generator, so the data is the same on every run */

export function seeded(seed = 0x2f6b9a1d) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, list) => list[Math.floor(rnd() * list.length) % list.length];

/* the panes */

/**
 * The thirteen conversations: tab, pane id, the demo session, how long its transcript is (long: 2400 messages drawn;
 * paged: the first 300 of 3000; short: the demo's own few), and whether it works for the whole run.
 */
export const LOAD_PANES = [
  { tab: 0, pane: 'lp1', key: 'flaky', history: 'long', busy: true },
  { tab: 0, pane: 'lp2', key: 'uploads', history: 'paged', busy: true },
  { tab: 0, pane: 'lp3', key: 'dashboard', history: 'short', busy: true },
  { tab: 0, pane: 'lp4', key: 'backfill', history: 'paged', busy: false },
  { tab: 1, pane: 'lp5', key: 'invoices', history: 'long', busy: true },
  { tab: 1, pane: 'lp6', key: 'review', history: 'paged', busy: false },
  { tab: 1, pane: 'lp7', key: 'push', history: 'short', busy: false },
  { tab: 2, pane: 'lp8', key: 'darkmode', history: 'paged', busy: true },
  { tab: 2, pane: 'lp9', key: 'vpc', history: 'short', busy: false },
  { tab: 3, pane: 'lp10', key: 'creds', history: 'short', busy: false },
  { tab: 3, pane: 'lp11', key: 'changelog', history: 'short', busy: false },
  { tab: 4, pane: 'lp12', key: 'docsearch', history: 'short', busy: false },
  { tab: 4, pane: 'lp13', key: 'ci', history: 'short', busy: false },
];

// Read when asked, not at load: data.mjs imports this file to name the preset, so ID is not set yet while it loads.
const historyKind = (id) => LOAD_PANES.find((p) => ID[p.key] === id)?.history || null;
/** The sessions that work for the whole run. */
export const loadBusy = () => LOAD_PANES.filter((p) => p.busy).map((p) => ID[p.key]);

/* the session list */

const REPO_NAMES = [
  'acme-web', 'billing-service', 'mobile-app', 'infra', 'docs-site', 'search-api', 'ledger', 'notify', 'auth-gateway', 'pricing',
  'warehouse-sync', 'design-tokens', 'admin-console', 'reports', 'event-bus', 'image-proxy', 'feature-flags', 'checkout-sdk',
  'support-bot', 'data-pipeline', 'cli-tools', 'status-page', 'onboarding', 'growth-experiments', 'sandbox', 'perf-lab',
];
const VERBS = ['Fix', 'Add', 'Refactor', 'Speed up', 'Document', 'Investigate', 'Port', 'Test', 'Clean up', 'Migrate', 'Review', 'Explain'];
const THINGS = [
  'the retry queue', 'webhook signatures', 'the login redirect', 'CSV export', 'the cache warmer', 'rate limits', 'the settings form',
  'search ranking', 'the invoice PDF renderer', 'time zones in reports', 'the upload widget', 'flaky e2e tests', 'the payment banner',
  'feature flag cleanup', 'the CI matrix', 'dark mode tokens', 'the onboarding checklist', 'API pagination', 'the audit log', 'memory leaks in the worker',
];
const repoPath = (name) => `C:\\Users\\dev\\code\\${name}`;

/** The demo's sessions plus about 620 generated ones over three months, as a busy person's list is. */
export function loadSessions(now) {
  const rnd = seeded(7);
  const base = buildSessions(now);
  const out = [...base];
  for (let i = 0; i < 620; i += 1) {
    const repo = pick(rnd, REPO_NAMES);
    const ago = Math.floor(rnd() * rnd() * 90 * DAY) + 40 * MIN;
    const n = String(i + 100).padStart(4, '0');
    out.push({
      id: `b7d2e4c1-${n}-4c2b-8a1e-6f3d9e2a${n}`,
      title: `${pick(rnd, VERBS)} ${pick(rnd, THINGS)}${rnd() < 0.3 ? ` in ${repo}` : ''}`,
      firstPrompt: `${pick(rnd, VERBS)} ${pick(rnd, THINGS)}. Keep the public behaviour and add a test.`,
      cwd: rnd() < 0.25 ? `${repoPath(repo)}.worktrees\\wt-${i % 9}` : repoPath(repo),
      branch: 'main', lastModified: now - ago, size: 20_000 + Math.floor(rnd() * 900_000), codex: rnd() < 0.08,
      terminal: null, folder: rnd() < 0.1 ? pick(rnd, ['f-checkout', 'f-release', 'f-infra']) : null,
      headless: false, bare: false, warm: false, subagents: rnd() < 0.2 ? 1 + Math.floor(rnd() * 5) : 0, archived: rnd() < 0.04, running: false,
    });
  }
  return out;
}

/* the repositories */

const wt = (path, branch, o = {}) => ({
  path, head: 'a1c4e7b2', branch, detached: false, bare: false, locked: null, prunable: null, main: false, stats: true,
  base: 'main', added: 0, removed: 0, files: 0, changed: 0, untracked: 0, conflicts: 0, staged: 0, upstream: '', aheadUp: 0, behindUp: 0,
  ahead: 0, behind: 0, unpushed: 0, merged: false, approx: false, ...o,
});

/**
 * 24 more repositories with one to four worktrees each, in the shape the engine sends; with the demo's own two
 * (worktrees.mjs: acme-web and billing-service, where the diff viewer's worktree is) that makes 26.
 */
export function loadRepos() {
  const rnd = seeded(11);
  return REPO_NAMES.slice(2).map((name, i) => {
    const root = repoPath(name);
    const extra = Math.floor(rnd() * 4);
    const branches = ['main', ...Array.from({ length: extra }, (_, k) => `wt-${(i + k) % 9}`)];
    return {
      id: `c:/users/dev/code/${name}/.git`, commonDir: `${root}\\.git`, root, name, base: 'main', remote: 'origin', linked: extra > 0, light: false,
      branches,
      worktrees: branches.map((b, k) => (k === 0
        ? wt(root, 'main', { main: true, upstream: 'origin/main' })
        : wt(`${root}.worktrees\\${b}`, b, { added: Math.floor(rnd() * 200), removed: Math.floor(rnd() * 60), files: 1 + Math.floor(rnd() * 9), changed: Math.floor(rnd() * 4), ahead: Math.floor(rnd() * 6) }))),
    };
  });
}

/** A turn ended or a file was saved somewhere: a few worktrees' numbers move (the engine then sends them all again). */
export function tickRepos(repos, rnd) {
  for (let i = 0; i < 3; i += 1) {
    const r = pick(rnd, repos);
    const w = pick(rnd, r.worktrees);
    w.added += 1 + Math.floor(rnd() * 12);
    w.removed += Math.floor(rnd() * 4);
    w.changed = Math.max(0, w.changed + (rnd() < 0.6 ? 1 : -1));
    w.files = Math.max(w.files, w.changed);
  }
  return repos;
}

/* long transcripts */

const CODE = [
  'export async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {',
  '  let last: unknown;',
  '  for (let i = 0; i < tries; i += 1) {',
  '    try { return await fn(); } catch (e) { last = e; await sleep(2 ** i * 100); }',
  '  }',
  '  throw last;',
  '}',
];
const PROSE = [
  'The handler reads the whole body before it checks the size, so a large upload is buffered in memory first.',
  'I moved the check in front of the read and kept the error the clients already expect.',
  'Two tests covered the old path; both still pass, and a new one sends a body one byte over the limit.',
  'The queue drops a job after the first failure, which is why the retries never happened in production.',
  'Nothing else calls this function, so the change stays local to the worker.',
  'The flag is read once at start-up, so flipping it needs a restart; I noted that in the README.',
];

/** One Claude reply as markdown: paragraphs, a list, inline code, sometimes a code block or a table. */
function reply(rnd, i) {
  const parts = [`${pick(rnd, PROSE)} ${pick(rnd, PROSE)}`];
  parts.push(['- `retry()` now waits between tries', '- the worker logs each failed send', '- a dead token is dropped, not retried'].join('\n'));
  if (i % 3 === 0) parts.push(`\`\`\`ts\n${CODE.join('\n')}\n\`\`\``);
  if (i % 7 === 0) parts.push(`| Case | Before | After |\n| - | - | - |\n| 1 MB | 120 ms | 40 ms |\n| 25 MB | 2.4 s | refused |`);
  parts.push(pick(rnd, PROSE));
  return parts.join('\n\n');
}

/** Tool output as the engine keeps it in a page (cut to 4000 characters). */
function output(rnd, lines) {
  const out = [];
  for (let i = 0; i < lines; i += 1) out.push(`src/${pick(rnd, ['api', 'worker', 'lib', 'ui'])}/${pick(rnd, ['queue', 'retry', 'upload', 'auth'])}.ts:${10 + i}: ${pick(rnd, PROSE).slice(0, 60)}`);
  return out.join('\n').slice(0, 4000);
}

/**
 * `count` transcript items (engine history.js shape): prompts, thinking, tool calls with results, replies. `page`
 * keeps the message and tool ids of an earlier page apart from the first page's.
 */
function transcript(id, now, count, page = 0) {
  const rnd = seeded(id.length * 131 + count + page);
  const items = [];
  let t = now - count * 40_000;
  let n = page * 1_000_000;
  let tools = page * 1_000_000;
  const at = () => new Date((t += 40_000)).toISOString();
  const uuid = () => `${id.slice(0, 8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  while (items.length < count) {
    const k = items.length;
    const grep = `toolu_h${++tools}`;
    const edit = `toolu_h${++tools}`;
    items.push({ type: 'user', uuid: uuid(), at: at(), prompt: { text: `${pick(rnd, VERBS)} ${pick(rnd, THINGS)} and run the tests (${k}).` }, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } });
    items.push({ type: 'assistant', uuid: uuid(), at: at(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: `${pick(rnd, PROSE)} ${pick(rnd, PROSE)}` }, { type: 'tool_use', id: grep, name: 'Grep', input: { pattern: 'retry', path: 'src' } }] } });
    items.push({ type: 'user', uuid: uuid(), at: at(), prompt: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: grep, content: output(rnd, 20 + (k % 40)), is_error: false }] } });
    items.push({ type: 'assistant', uuid: uuid(), at: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: edit, name: 'Edit', input: { file_path: 'src/worker/retry.ts', old_string: CODE.slice(0, 3).join('\n'), new_string: CODE.slice(0, 5).join('\n') } }] } });
    items.push({ type: 'user', uuid: uuid(), at: at(), prompt: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: edit, content: 'The file src/worker/retry.ts has been updated.', is_error: false }] } });
    items.push({ type: 'assistant', uuid: uuid(), at: at(), message: { role: 'assistant', content: [{ type: 'text', text: reply(rnd, k) }] } });
  }
  return items.slice(0, count);
}

/**
 * The history event's fields for a session of the load workspace (engine history.js firstPage shape), or null for a
 * session that keeps the demo's own short transcript.
 */
export function loadHistory(id, now) {
  const kind = historyKind(id);
  if (kind === 'long') {
    const messages = transcript(id, now, 2400);
    return { messages, total: messages.length, prompts: { before: 0 } };
  }
  if (kind === 'paged') {
    const messages = transcript(id, now, 300);
    return { messages, total: 3000, source: 'transcript', first: 2700, hasMore: true, earlier: 2700, prompts: { before: 450 } };
  }
  return null;
}

/**
 * An earlier page of a paged session (engine historyBefore: the `limit` items before item `before`, or all of them),
 * so Load earlier, Load all and Ctrl+F's Search all have the rest of the 3000 to bring in. Null for other sessions.
 */
export function loadEarlierPage(id, now, before, { all = false, limit = 300 } = {}) {
  if (historyKind(id) !== 'paged' || !(before > 0)) return null;
  const n = all ? before : Math.min(limit, before);
  const messages = transcript(id, now - before * 40_000, n, before);
  const first = before - n;
  return { messages, first, hasMore: first > 0, earlier: first, total: 3000, prompts: { before: Math.round(first / 6) } };
}

/* the working turn */

/** Streams `text` as the SDK does: about `perSecond` deltas a second of a few characters each. */
async function stream(t, index, type, text, perSecond = 45) {
  const key = type === 'thinking' ? 'thinking' : type === 'input' ? 'partial_json' : 'text';
  const deltaType = type === 'thinking' ? 'thinking_delta' : type === 'input' ? 'input_json_delta' : 'text_delta';
  for (let i = 0; i < text.length;) {
    const n = 3 + ((i * 7) % 6);
    t.sdk({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: deltaType, [key]: text.slice(i, i + n) } } });
    i += n;
    await t.sleep(1000 / perSecond);
  }
}

/** One assistant message with one block, streamed: start, deltas, stop, the finished message. */
async function block(t, b, streamed) {
  const id = t.begin();
  const start = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {} } : b.type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
  t.sdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: start } });
  await stream(t, 0, b.type === 'tool_use' ? 'input' : b.type, streamed);
  t.sdk({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  t.sdk({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: b.type === 'tool_use' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 120 } } });
  t.sdk({ type: 'stream_event', event: { type: 'message_stop' } });
  if (b.type !== 'thinking') t.sdk({ type: 'assistant', message: { id, content: [b] } });
  return id;
}

/** A tool call: its input streamed, a pause while it runs, and its result. */
async function toolCall(t, name, input, result, runMs) {
  const id = t.host.nextId('toolu');
  await block(t, { type: 'tool_use', id, name, input }, JSON.stringify(input));
  await t.sleep(runMs);
  t.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
  return id;
}

/** A subagent: the Task call, its progress, and its own traffic (which the window gets too, marked with its parent). */
async function subagent(t, rnd) {
  const toolId = t.host.nextId('toolu');
  const taskId = `task-load-${toolId}`;
  await block(t, { type: 'tool_use', id: toolId, name: 'Task', input: { description: 'Survey the callers of retry()', subagent_type: 'Explore', prompt: 'Find every caller of retry() and say which ones need a longer delay.' } }, '{"description":"Survey the callers of retry()","subagent_type":"Explore"}');
  t.sdk({ type: 'system', subtype: 'task_started', task_id: taskId, task_type: 'local_agent', subagent_type: 'Explore', description: 'Survey the callers of retry()', tool_use_id: toolId });
  t.host.subagentsChanged?.(t.sessionId);
  for (let i = 0; i < 4; i += 1) {
    const sub = t.host.nextId('toolu');
    t.sdk({ type: 'assistant', parent_tool_use_id: toolId, message: { id: t.host.nextId('msg'), content: [{ type: 'tool_use', id: sub, name: 'Read', input: { file_path: `src/${pick(rnd, ['api', 'worker', 'lib'])}/retry.ts` } }] } });
    await t.sleep(600);
    t.sdk({ type: 'user', parent_tool_use_id: toolId, message: { content: [{ type: 'tool_result', tool_use_id: sub, content: output(rnd, 160), is_error: false }] } });
    t.sdk({ type: 'system', subtype: 'task_progress', task_id: taskId, usage: { tool_uses: i + 1, total_tokens: 4000 + i * 3000, duration_ms: (i + 1) * 1200 }, last_tool_name: 'Read', summary: `Reading caller ${i + 1}` });
    if (i % 2 === 1) t.host.subagentsChanged?.(t.sessionId);
    await t.sleep(600);
  }
  const summary = 'Four callers. Two need a longer first delay (the payment and webhook paths); the other two are fine.';
  t.sdk({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', summary, usage: { tool_uses: 4, total_tokens: 16_000, duration_ms: 4800 }, tool_use_id: toolId });
  t.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: summary, is_error: false }] } });
}

/**
 * The working panes' script: a full turn (thinking, a search, a reply with code, a subagent, a long command, an edit,
 * a summary) of about 30 seconds, its result, a breath, and the next turn, until the pane is stopped or closed.
 */
export const LOAD_SCRIPTS = {
  async 'load-stream'(t) {
    const rnd = seeded(t.paneId.length * 977 + t.paneId.charCodeAt(t.paneId.length - 1));
    for (let turn = 0; ; turn += 1) {
      t.startedAt = performance.now();
      await block(t, { type: 'thinking', thinking: '' }, `${pick(rnd, PROSE)} ${pick(rnd, PROSE)} ${pick(rnd, PROSE)}`.repeat(2));
      await toolCall(t, 'Grep', { pattern: 'retry\\(', path: 'src' }, output(rnd, 40), 500);
      await block(t, { type: 'text', text: reply(rnd, turn * 3) }, reply(rnd, turn * 3));
      await subagent(t, rnd);
      await toolCall(t, 'Bash', { command: 'npm test 2>&1 | tail -400', description: 'Run the tests' }, Array.from({ length: 400 }, (_, i) => `  ok ${i + 1} - ${pick(rnd, THINGS)} ${pick(rnd, ['works', 'retries', 'rounds', 'refuses'])} (${(rnd() * 90).toFixed(0)} ms)`).join('\n'), 1500);
      await toolCall(t, 'Edit', { file_path: 'src/worker/retry.ts', old_string: CODE.join('\n'), new_string: CODE.map((l) => l.replace('100', '250')).join('\n') }, 'The file src/worker/retry.ts has been updated.', 400);
      await block(t, { type: 'text', text: reply(rnd, turn * 3 + 1) }, reply(rnd, turn * 3 + 1));
      t.finish({ cost: 0.21, cached: 48_000, fresh: 3_100 });
      await t.sleep(1500);
    }
  },
};

/* the workspace */

const leaf = (pane, sessionId, extra = {}) => ({ type: 'leaf', pane, s: sessionId, cwd: '', title: '', model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions', draft: '', queue: [], scroll: null, busy: false, ...extra });
const split = (dir, sizes, ...children) => ({ type: 'split', dir, sizes, children });

/** The starting workspace: tab 0 a 2x2 grid with its side panel open, then 3, 2, 2 and 2 conversations. */
export function loadPreset() {
  const titles = buildSessions(0);
  const conv = (p) => leaf(p.pane, ID[p.key], { title: titles.find((s) => s.id === ID[p.key])?.title || '', cwd: titles.find((s) => s.id === ID[p.key])?.cwd || CWD.web });
  const of = (tab) => LOAD_PANES.filter((p) => p.tab === tab).map(conv);
  const [a, b, c, d] = of(0);
  const t1 = of(1);
  const roots = [
    split('col', [0.5, 0.5], split('row', [0.5, 0.5], a, b), split('row', [0.5, 0.5], c, d)),
    split('row', [0.4, 0.3, 0.3], ...t1),
    split('row', [0.5, 0.5], ...of(2)),
    split('row', [0.5, 0.5], ...of(3)),
    split('row', [0.5, 0.5], ...of(4)),
  ];
  const wtPath = `${CWD.web}.worktrees\\fix-flaky-checkout`;
  return {
    active: 0,
    tabs: roots.map((root, i) => ({
      focused: LOAD_PANES.find((p) => p.tab === i).pane, name: '', arrange: 'custom', max: null, root,
      ...(i === 0 ? {
        items: [
          { type: 'leaf', pane: 'lv1', view: { sessionId: ID.flaky, id: 'art-flaky-notes', title: 'Flaky checkout: findings', kind: 'markdown', sourcePane: 'lp1' } },
          { type: 'leaf', pane: 'lv2', view: { diff: { path: wtPath, scope: 'base', branch: 'fix-flaky-checkout', repo: 'acme-web', base: 'main', ownerPane: 'lp2' } } },
          { type: 'leaf', pane: 'lv3', view: { task: true, kind: 'agent', sessionId: ID.uploads, toolUseId: 'toolu_u8', taskId: 'agent-u1', ownerPane: 'lp2', title: 'Check which clients still call the old upload endpoint', type: 'Explore' } },
        ],
        side: { open: true, width: 420, group: 'lp1', pick: {} },
      } : {}),
    })),
    scripts: Object.fromEntries(loadBusy().map((id) => [id, Array.from({ length: 50 }, () => 'load-stream')])),
    rail: { view: 'all', expanded: [], scroll: 0, width: 312, collapsed: false },
    worktrees: true,
    load: true,
    busy: loadBusy(),
  };
}
