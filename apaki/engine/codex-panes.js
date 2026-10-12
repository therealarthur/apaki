/**
 * codex-panes.js: Codex conversations as panes of Myrlin Apaki's engine.
 *
 * WHY (Arthur, 2026-10-11/12: "make a Codex pane match OpenAI's Codex app as close to 1:1 as possible ... the model
 * picker, effort picker, bypass session (full access for codex), voice, attach, etc - all must be usable and properly
 * functional"; "its version of askuserquestiontool - we need to display it similarly"; "make sure codex/chatgpt
 * sessions have the same knowledge of opening a browser/viewer in myrlin apaki as it does in codex/chatgpt app"):
 * Codex threads were only listed. This opens them as working panes next to Claude's, through one `codex app-server`
 * process (codex-client.js) that Apaki starts when something first needs it.
 *
 * A Codex pane is an engine pane (engine.js `panes`) with kind 'codex' and no Claude Code runner:
 *   p.kind    'codex'
 *   p.codex   { threadId, turnId, loaded, cwd, touched, items, blocks, out, usage, ... } (open() below)
 *   p.sessionId  'codex:<thread id>'  (the id the lists, search and the window already use for Codex threads)
 * Every op a Claude pane takes keeps its name (open, attach, send, steer, interrupt, answer, model, effort, mode,
 * contextUsage, commands, historyBefore, historyCheck, close, rename), so the window, the phone and the remote policy
 * need no second vocabulary; engine.js sends the op here when the pane is a Codex one.
 *
 * The events a pane gets are the ones it already draws (codex-map.js turns the protocol's items into SDK-shaped
 * messages: streamed text, thinking, tool_use / tool_result, TodoWrite checklists, hook and limit notices), plus:
 *   ev codexModels { reqId, models, account }   model/list with each model's own efforts, for the pickers
 *   ev codexThreads { reqId, items }            thread/list as session rows (the Codex view of the list)
 *   ev opened      gains kind: 'codex'
 *   ev artifact    via: 'codex-diff' for a turn's changes (a card, no viewer pops up)
 * Questions and approvals use the existing ask / answer / ask_gone events and sheets.
 *
 * Browser and viewer (item 5 of the plan): Apaki's show and browser tools reach every Codex thread, resumed ones
 * included, as the stdio MCP server "apaki" given to this app-server process alone with -c mcp_servers.apaki.* (no
 * config file is written); a developer instruction per thread tells the model to use them; BROWSER and the open
 * token are set for commands it runs, so a link Codex opens lands in Apaki's browser pane. One process serves every
 * thread, so the server cannot tell which pane called: it uses the pane whose turn is running (pickPane).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer, tomlList, tomlString, tomlTable } from './codex-client.js';
import { CodexHistory, PAGE as HISTORY_PAGE } from './codex-history.js';
import { createRolloutScanner } from './codex-rollouts.js';
import { LastActive } from './last-active.js';
import {
  DEFAULT_PRESET, PRESET_NAMES, approvalAsk, approvalReply, assistantMessage, capPresets, clampPreset, codexId, contextFromUsage, effortFor, elicitationAsk, elicitationReply, friendlyError, hookMessage,
  informational, isPreset, limitEvents, limitsOf, messageStart, normalizeModels, presetOf, questionAsk, questionReply, reasoningText, rerouteMessage, streamEvent, textDelta, textStart, threadIdOf, threadPermissions, threadRow,
  threadTitle, todoWriteOf, toolOutput, toolResultMessage, toolResultOf, toolUseOf, turnInput, turnPermissions,
} from './codex-map.js';

/** The pseudo pane the shared app-server's open token belongs to (open-server.js paneToken). */
export const CODEX_SHARED = 'codex-shared';
const SERVICE_NAME = 'myrlin_apaki';
/** A stopped-looking server with no Codex pane open for this long is shut down (it starts again on demand). */
const IDLE_STOP_MS = 3 * 60 * 1000;
const LIST_TTL_MS = 30 * 1000;
const OUTPUT_KEEP = 40000;
const OUTPUT_EVERY_MS = 150;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/**
 * One short paragraph per thread, like the paragraph Claude's appended prompt carries (apaki-tools.js): the tools
 * exist, and to use them instead of opening Chrome or Explorer. Sent as developerInstructions on thread/start and
 * thread/resume, so a thread started in the Codex app learns it when it is opened here.
 */
export const DEV_INSTRUCTIONS = [
  'You are running inside Myrlin Apaki, a desktop app that hosts Codex beside Claude Code; the user reads this conversation there.',
  'Apaki has a viewer and a built-in browser next to the conversation, and a tool server named "apaki" gives you tools for them.',
  'When you want the user to see something (an HTML page or small app, a chart, an SVG, an image, a Markdown report, a PDF, any local file, or a web page such as a dev server), call the apaki "show" tool instead of opening it with start, Start-Process, explorer, open, xdg-open or python -m webbrowser; Apaki redirects those anyway.',
  'Shown pages run sandboxed without network access, so inline their CSS, scripts and images (data: URLs); call show again with the returned id to revise something.',
  'You can also use the browser yourself with the apaki tools browser_open, browser_read, browser_click, browser_type, browser_back and browser_screenshot, for example to check a site you are building; the user watches the same browser.',
].join(' ');

/** Slash commands a Codex pane offers besides the window's own (/new, /resume, /model, /effort, /mode). */
export const COMMANDS = Object.freeze([
  { name: 'compact', description: 'Summarize the conversation to free the context window', argumentHint: '' },
  { name: 'status', description: 'Model, effort, permissions, folder and thread id', argumentHint: '' },
  { name: 'review', description: 'Review the uncommitted changes, a branch, a commit, or what you describe', argumentHint: '[branch <name> | commit <sha> | instructions]' },
  { name: 'diff', description: 'Show what this conversation changed in its last turn', argumentHint: '' },
  { name: 'mcp', description: 'List the tool servers this thread can use', argumentHint: '' },
  { name: 'goal', description: 'Set, show or clear the goal Codex keeps working toward', argumentHint: '[what to get done | clear]' },
  { name: 'revert', description: 'Take the last exchange out of this conversation (files stay as they are)', argumentHint: '' },
  { name: 'init', description: 'Have Codex write an AGENTS.md for this folder', argumentHint: '' },
  { name: 'mention', description: 'Attach a file to your next message', argumentHint: '<file>' },
]);

/** What /init asks (Codex's own /init is a prompt too): an AGENTS.md, the file Codex reads at the start of every thread. */
export const INIT_PROMPT = [
  'Write an AGENTS.md at the root of this repository, the guide a new contributor (or a coding agent) reads first.',
  'Look at the repository before writing: its layout, build, test and lint commands, coding style, commit and pull request habits.',
  'Keep it short and concrete: one heading per topic (project layout, build and test, style, commits and pull requests, anything that surprises a newcomer), real commands in code spans, no filler.',
  'If an AGENTS.md already exists, improve it and keep what is true in it. Do not change any other file.',
].join(' ');

/** True for a pane that runs a Codex thread. */
export const isCodexPane = (p) => p?.kind === 'codex';

/** Slash words that are commands (Codex's, Apaki's own, the window's): a skill with such a name is never offered or called. */
const RESERVED = new Set([...COMMANDS.map((c) => c.name), 'new', 'clear', 'resume', 'continue', 'model', 'effort', 'approvals', 'mode', 'permissions', 'folder', 'fork', 'key', 'warm']);

/** `/name rest` from a message, or null: the shape of a skill call. */
export function skillCall(body) {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(String(body || '').trim());
  return m && !RESERVED.has(m[1].toLowerCase()) ? { name: m[1], rest: (m[2] || '').trim() } : null;
}

/**
 * What /review is asked to look at: nothing after the word means the uncommitted changes; "branch main" the changes
 * against that base branch; "commit abc123" one commit; anything else is read as the review instructions.
 */
export function reviewTarget(arg) {
  const a = String(arg || '').trim();
  if (!a) return { type: 'uncommittedChanges' };
  let m = /^(?:branch|base)\s+(\S+)$/i.exec(a);
  if (m) return { type: 'baseBranch', branch: m[1] };
  m = /^commit\s+([0-9a-f]{6,40})$/i.exec(a);
  if (m) return { type: 'commit', sha: m[1] };
  return { type: 'custom', instructions: a };
}

/**
 * The `-c key=value` overrides for the app-server process (and only for it): Apaki's tool server, and the variables a
 * command Codex runs needs to hand a link back (shell_environment_policy.set, because the default policy drops any
 * variable whose name holds KEY, SECRET or TOKEN). `shared` is { node, mcpScript, openUrl, token, shim } or null.
 */
export function processOverrides(shared) {
  if (!shared) return [];
  const mcpEnv = { APAKI_TOOL_PROXY: '1', APAKI_OPEN_URL: shared.openUrl, APAKI_OPEN_TOKEN: shared.token };
  const out = [
    `mcp_servers.apaki.command=${tomlString(shared.node)}`,
    `mcp_servers.apaki.args=${tomlList([shared.mcpScript])}`,
    `mcp_servers.apaki.env=${tomlTable(mcpEnv)}`,
    'mcp_servers.apaki.startup_timeout_sec=30',
    'mcp_servers.apaki.tool_timeout_sec=120',
  ];
  if (shared.shim) {
    for (const [k, v] of Object.entries({ BROWSER: shared.shim, APAKI_OPEN_URL: shared.openUrl, APAKI_OPEN_TOKEN: shared.token, APAKI_NODE: shared.node })) out.push(`shell_environment_policy.set.${k}=${tomlString(v)}`);
  }
  return out;
}

/** The environment of the app-server process itself: BROWSER too, for anything it starts that honours it. */
export function processEnv(shared, base = process.env) {
  const env = { ...base };
  if (shared?.shim) Object.assign(env, { BROWSER: shared.shim, APAKI_OPEN_URL: shared.openUrl, APAKI_OPEN_TOKEN: shared.token, APAKI_NODE: shared.node });
  return env;
}

const rid = () => `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const safeName = (n) => path.basename(String(n || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';

/**
 * @param {object} env
 * @param {(ev: object) => void} env.emit                  the engine's event sender
 * @param {Map} env.asks                                   the engine's state.asks
 * @param {Map} env.panes                                  the engine's panes
 * @param {(p: object) => object} env.tools                the pane's Apaki tools (engine toolsFor): .show(), .browser
 * @param {(p: object, o: object) => void} env.openPage    shows a web page for a pane (built-in browser, or a link card)
 * @param {() => (object|null)} [env.shared]               { node, mcpScript, openUrl, token, shim } or null
 * @param {(rows: object[]) => object[]} [env.shapeRows]    thread rows as session-list rows
 * @param {(paneId: string) => (string|null)} [env.phoneCap]  a phone pane's access (full, noshell, chat), null for the desktop
 * @param {(p: object, msg: object) => void} [env.activity] every message a pane drew (the host's idle tracking)
 * @param {(p: object, info: object) => void} [env.turnEnded] a turn ended (queue hand-off, saved workspace)
 * @param {() => string} [env.attachDir]                   where attached files are saved
 * @param {(line: string) => void} [env.log]
 * @param {(o: object) => object} [env.createClient]       tests give a client that talks to a fake server
 */
export function createCodex(env) {
  const { emit, asks, panes, tools, openPage, log = () => {} } = env;
  const phoneCap = env.phoneCap || (() => null);
  // The engine gives list rows the fields every session row has (archived, folder...): env.shapeRows.
  const shape = (rows) => (env.shapeRows ? env.shapeRows(rows) : rows);
  const activity = env.activity || (() => {});
  const turnEnded = env.turnEnded || (() => {});
  const rollouts = createRolloutScanner({ home: env.home || undefined, roots: env.rolloutRoots || null });
  // The list's times: each thread's last message, read from its rollout's tail once per file version (last-active.js).
  const lastActive = new LastActive();
  const byThread = new Map();
  const shared = { models: null, config: null, account: null, rows: null, rowsAt: 0, idle: null, skills: new Map() };
  let client = null;
  let history = null;

  /* ---------- the process ---------- */

  function getClient() {
    if (client) return client;
    const s = env.shared?.() || null;
    const opts = { overrides: processOverrides(s), env: processEnv(s), clientInfo: { name: 'myrlin-apaki', title: 'Myrlin Apaki', version: '0.1.0' } };
    client = env.createClient ? env.createClient(opts) : new CodexAppServer(opts);
    client.on('notification', (method, params) => { try { onNotification(method, params); } catch (e) { log(`codex ${method}: ${e.stack || e.message}`); } });
    client.on('request', (id, method, params) => { onRequest(id, method, params).catch((e) => { log(`codex ${method}: ${e.message}`); client.respondError(id, -32603, `Apaki could not handle ${method}`); }); });
    client.on('exit', (code, signal, info) => onExit(info));
    client.on('log', (line) => log(`codex: ${String(line).trimEnd()}`));
    history = new CodexHistory({ request: (m, p) => client.request(m, p) });
    return client;
  }

  const rpc = (method, params, opts) => getClient().request(method, params, opts);

  /** The server went away. A deliberate stop is quiet; a crash ends every running turn and asks nobody. */
  function onExit(info) {
    for (const p of panes.values()) {
      if (!isCodexPane(p)) continue;
      const cx = p.codex;
      cx.loaded = false;
      cx.turnId = null;
      for (const [id, a] of asks) if (a.paneId === p.id && a.codexRequestId !== undefined) { asks.delete(id); emit({ ev: 'ask_gone', askId: id, paneId: p.id }); }
      if (p.busy && !info?.expected) {
        p.busy = false;
        p.inTurn = false;
        emit({ ev: 'result', paneId: p.id, sessionId: p.sessionId, subtype: 'error_during_execution', isError: true, durationMs: 0, usage: {}, cost: null, errors: ['The Codex app-server stopped, so this turn ended. Send a message to carry on.'], result: 'The Codex app-server stopped, so this turn ended. Send a message to carry on.', codex: true });
        turnEnded(p, { status: 'failed' });
      }
    }
  }

  function touchIdle() {
    clearTimeout(shared.idle);
    shared.idle = null;
    if (!client?.ready) return;
    if ([...panes.values()].some(isCodexPane)) return;
    shared.idle = setTimeout(() => { if (![...panes.values()].some(isCodexPane)) client?.stop().catch(() => {}); }, IDLE_STOP_MS);
    shared.idle.unref?.();
  }

  /* ---------- what the pickers need ---------- */

  async function loadShared() {
    const c = getClient();
    await c.ensure();
    if (!shared.models) {
      const all = [];
      let cursor = null;
      for (let i = 0; i < 5; i++) {
        const r = await c.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        all.push(...(Array.isArray(r?.data) ? r.data : []));
        cursor = r?.nextCursor || null;
        if (!cursor) break;
      }
      shared.models = normalizeModels(all);
    }
    if (!shared.config) {
      try { shared.config = (await c.request('config/read', {}))?.config || {}; } catch { shared.config = {}; }
    }
    if (!shared.account) {
      try { shared.account = (await c.request('account/read', {}))?.account || {}; } catch { shared.account = {}; }
      // What is left of the plan's windows, for the billing chip (only a ChatGPT sign-in has them).
      if (shared.account.type === 'chatgpt') {
        try { shared.limits = limitsOf((await c.request('account/rateLimits/read', {}))?.rateLimits); } catch { shared.limits = []; }
      } else shared.limits = [];
    }
    return shared;
  }

  /** The account line the billing chip shows ("ChatGPT Pro"): Codex bills the signed-in ChatGPT account or an API key. */
  function billingOf() {
    const a = shared.account || {};
    if (a.type === 'apiKey') return { name: 'API key', source: 'codex', follow: false, isKey: true, limits: [] };
    const plan = a.planType ? String(a.planType).replace(/^./, (c) => c.toUpperCase()) : '';
    return { name: a.type === 'chatgpt' ? `ChatGPT${plan ? ` ${plan}` : ''}` : 'Codex', source: 'codex', follow: false, isKey: false, limits: shared.limits || [] };
  }

  const modelOf = (id) => shared.models?.find((m) => m.id === id) || null;

  /** The model, effort and mode a new Codex conversation starts with: the user's own Codex config, as the Codex app does. */
  function defaultsOf() {
    const cfg = shared.config || {};
    const list = shared.models || [];
    const model = list.find((m) => m.id === cfg.model) || list.find((m) => m.isDefault) || list[0] || null;
    return {
      model: model?.id || cfg.model || '', effort: effortFor(model, cfg.model_reasoning_effort),
      mode: presetOf({ approvalPolicy: cfg.approval_policy, sandbox: cfg.sandbox_mode }),
    };
  }

  /** ev codexModels: the model list with each model's efforts, the presets and the account line. */
  async function models(reqId) {
    try {
      await loadShared();
      const d = defaultsOf();
      emit({ ev: 'codexModels', reqId, models: shared.models.filter((m) => !m.hidden), defaults: d, presets: PRESET_NAMES, account: billingOf() });
    } catch (e) {
      emit({ ev: 'codexModels', reqId, error: e.message || String(e), models: [], defaults: null, presets: PRESET_NAMES, account: null });
    }
  }

  /** The Codex threads on this PC as session-list rows (thread/list: the Codex app's own threads included). */
  async function list({ refresh = false, reqId = null } = {}) {
    try {
      if (shared.rows && !refresh && Date.now() - shared.rowsAt < LIST_TTL_MS) { emit({ ev: 'codexThreads', reqId, items: shape(shared.rows) }); return shared.rows; }
      const c = getClient();
      await c.ensure();
      const rows = [];
      const files = new Map();
      let cursor = null;
      for (let i = 0; i < 3; i++) {
        const r = await c.request('thread/list', { limit: 100, sortKey: 'recency_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], useStateDbOnly: i === 0 && !refresh, ...(cursor ? { cursor } : {}) });
        const data = Array.isArray(r?.data) ? r.data : [];
        rows.push(...data.map(threadRow));
        for (const t of data) if (typeof t?.path === 'string' && t.path) files.set(codexId(t.id), t.path);
        cursor = r?.nextCursor || null;
        if (!cursor) break;
      }
      // Rollout files the server did not list (read only; codex-rollouts.js).
      try { rows.push(...await rollouts.rows(new Set(rows.map((r) => r.id)))); } catch (e) { log(`codex rollout scan failed: ${e.message}`); }
      // Each thread's time is its last message (2026-10-12, as Claude's list does: last-active.js), not the server's
      // recency time, which is when its last turn started, nor the file's, which token counts and renames move.
      for (const [id, f] of rollouts.paths?.() || []) if (!files.has(id)) files.set(id, f);
      await lastActive.apply(rows, files).catch((e) => log(`codex last active: ${e.message || e}`));
      shared.rows = rows;
      shared.rowsAt = Date.now();
      emit({ ev: 'codexThreads', reqId, items: shape(rows) });
      touchIdle();
      return rows;
    } catch (e) {
      // The server would not start or answer: the rollout files still say which threads exist.
      let rows = shared.rows || [];
      try { rows = [...rows, ...await rollouts.rows(new Set(rows.map((r) => r.id)))]; } catch { /* nothing more to show */ }
      emit({ ev: 'codexThreads', reqId, items: shape(rows), error: e.message || String(e) });
      return rows;
    }
  }

  /* ---------- opening ---------- */

  const restricted = (p) => { const cap = phoneCap(p.id); return Boolean(cap) && cap !== 'full'; };

  /** Panes emit through here so the host's idle rules see every message (engine paneActivity). */
  function sdk(p, msg) {
    p.lastActiveAt = Date.now();
    activity(p, msg);
    emit({ ev: 'sdk', paneId: p.id, sessionId: p.sessionId, msg });
  }

  function note(p, text, tone = '') { emit({ ev: 'note', paneId: p.id, tone, text }); }

  function freshState(opts = {}) {
    return {
      threadId: null, turnId: null, loaded: false, cwd: '', touched: { model: false, effort: false, mode: false },
      items: new Map(), blocks: new Map(), blockSeq: 0, out: new Map(), sentIds: new Set(), reqByTurn: new Map(), planSeq: 0,
      usage: null, mentions: [], changedFiles: new Set(), goalStatus: null, contextTimer: null, startedAt: 0, diffs: new Map(), lastDiffTurn: null, compactWait: null, opts,
    };
  }

  function settingsEvent(p) { emit({ ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode }); }

  /**
   * Applies a thread's settings to the pane (what the server says it has now), except what the person picked in this
   * pane: those stay and travel with the next turn (touched), so a pick is never undone by the server's answer.
   */
  function adopt(p, r) {
    const cx = p.codex;
    if (r.model && !cx.touched.model) p.model = r.model;
    if (r.reasoningEffort && !cx.touched.effort) p.effort = r.reasoningEffort;
    if (!cx.touched.mode && (r.approvalPolicy !== undefined || r.sandbox !== undefined)) p.mode = presetOf({ approvalPolicy: r.approvalPolicy, sandbox: r.sandbox });
    if (restricted(p)) p.mode = clampPreset(phoneCap(p.id), p.mode);
    cx.cwd = String(r.cwd || r.thread?.cwd || cx.cwd || os.homedir());
  }

  /** Parameters shared by thread/start and thread/resume. */
  function threadParams(p, cwd) {
    const cx = p.codex;
    const params = { developerInstructions: DEV_INSTRUCTIONS, ...(cwd ? { cwd } : {}) };
    if (cx.touched.model && p.model) params.model = p.model;
    if (cx.touched.mode || restricted(p)) Object.assign(params, threadPermissions(p.mode, { restricted: restricted(p) }));
    return params;
  }

  /**
   * Opens a pane on a Codex thread (sessionId 'codex:<id>') or on a new conversation (null: the thread starts with the
   * first message). Emits opened, then the newest page of history. opts: { model, effort, mode } the pane's own picks.
   */
  async function open(reqId, p, sessionId, cwd, opts = {}) {
    p.kind = 'codex';
    const cx = p.codex = freshState(opts);
    p.runner = null;
    p.busy = false;
    p.openedAt = new Date().toISOString();
    clearTimeout(shared.idle);
    // A failure to open keeps the thread the pane was asked for (the saved workspace still points at it, and the next message
    // tries to resume it again); the pane shows the reason.
    const keep = sessionId ? threadIdOf(sessionId) : null;
    if (keep) { cx.threadId = keep; p.sessionId = codexId(keep); }
    try {
      await loadShared();
    } catch (e) {
      emit({ ev: 'error', reqId, paneId: p.id, message: e.message || String(e) });
      emit({ ev: 'opened', reqId, paneId: p.id, sessionId: p.sessionId || null, cwd: cwd || os.homedir(), title: 'Codex', model: '', effort: '', mode: DEFAULT_PRESET, billing: billingOf(), terminal: [], kind: 'codex' });
      return;
    }
    const d = defaultsOf();
    const m = shared.models;
    const wantModel = typeof opts.model === 'string' && m.some((x) => x.id === opts.model) ? opts.model : '';
    p.model = wantModel || d.model;
    cx.touched.model = Boolean(wantModel);
    const mdl = modelOf(p.model);
    cx.touched.effort = typeof opts.effort === 'string' && Boolean(mdl?.efforts.some((e) => e.value === opts.effort));
    p.effort = cx.touched.effort ? opts.effort : effortFor(mdl, d.effort);
    cx.touched.mode = isPreset(opts.mode);
    p.mode = cx.touched.mode ? opts.mode : d.mode;
    if (restricted(p)) { p.mode = clampPreset(phoneCap(p.id), p.mode); cx.touched.mode = true; }
    const threadId = sessionId ? threadIdOf(sessionId) : null;
    let title = 'New conversation';
    if (threadId) {
      cx.threadId = threadId;
      p.sessionId = codexId(threadId);
      byThread.set(threadId, p);
      try {
        const r = await rpc('thread/resume', { threadId, excludeTurns: true, ...threadParams(p, cwd || null) });
        cx.loaded = true;
        // Settings the pane asked for explicitly (a restored pane) are re-applied with its next turn (adopt leaves them).
        adopt(p, r);
        title = threadTitle(r.thread);
        p.codexTitle = title;
      } catch (e) {
        byThread.delete(threadId);
        emit({ ev: 'error', reqId, paneId: p.id, message: `Codex could not open that conversation: ${e.message || e}` });
        emit({ ev: 'opened', reqId, paneId: p.id, sessionId: p.sessionId, cwd: cwd || os.homedir(), title: 'Codex', model: p.model, effort: p.effort, mode: p.mode, billing: billingOf(), terminal: [], kind: 'codex' });
        return;
      }
    } else {
      p.sessionId = null;
      cx.cwd = cwd || os.homedir();
    }
    emit({ ev: 'opened', reqId, paneId: p.id, sessionId: p.sessionId, cwd: cx.cwd, title, model: p.model, effort: p.effort, mode: p.mode, billing: billingOf(), terminal: [], kind: 'codex', tookOver: Boolean(opts.force) });
    if (threadId) await sendHistory(p);
  }

  /** ev history: the newest page of the thread, in the shape a Claude transcript gives. */
  async function sendHistory(p, { refresh = false, reqId = null, paneId = null } = {}) {
    const threadId = p.codex?.threadId;
    if (!threadId) return;
    try {
      const rev = await revOf(threadId);
      const page = await history.firstPage(threadId, { limit: HISTORY_PAGE });
      trackFromMessages(p, page.messages);
      // paneId: a phone that follows this pane (the shared view) is sent it under its own pane id.
      emit({ ev: 'history', reqId, paneId: paneId || p.id, sessionId: p.sessionId, ...page, rev, ...(refresh ? { refresh: true } : {}) });
      // More turns than the page holds: how many prompts come before it, from the turn summaries (pin "N of M").
      if (page.hasMore && !page.prompts) countPrompts(p, threadId);
    } catch (e) {
      note(p, `Codex could not read this conversation's history: ${e.message || e}`, 'warn');
    }
  }

  /* ---------- opening a changed file in the viewer ---------- */

  const MAX_CHANGED_FILES = 3000;
  const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

  /** Remembers the files this pane's Codex changed (absolute paths): the only ones the pane may open in the viewer. */
  function trackChanged(p, changes) {
    const cx = p.codex;
    if (!cx || !Array.isArray(changes)) return;
    for (const c of changes) {
      for (const raw of [c?.path, c?.move_path]) {
        if (!raw || typeof raw !== 'string' || cx.changedFiles.size >= MAX_CHANGED_FILES) continue;
        cx.changedFiles.add(path.resolve(cx.cwd || os.homedir(), raw));
      }
    }
  }

  /** The changes in a page of history messages (ApplyPatch tool calls), so a thread opened later can open its files too. */
  function trackFromMessages(p, messages) {
    for (const m of Array.isArray(messages) ? messages : []) {
      for (const b of Array.isArray(m?.message?.content) ? m.message.content : []) {
        if (b?.type === 'tool_use' && b.name === 'ApplyPatch') trackChanged(p, b.input?.changes);
      }
    }
  }

  /**
   * Op codexOpenFile { path }: shows a file this conversation changed in the viewer, as the Codex app's side panel does
   * (the patch line's file name is the button). Only files Codex changed here are opened; nothing is written.
   */
  async function openFile(c, p) {
    const cx = p.codex;
    const file = path.resolve(cx.cwd || os.homedir(), String(c.path || ''));
    const name = path.basename(file);
    if (!c.path || !cx.changedFiles.has(file)) { note(p, 'Apaki opens the files this conversation changed.', 'warn'); return; }
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st?.isFile()) { note(p, `${name} is not there any more.`, 'warn'); return; }
    if (st.size > MAX_PREVIEW_BYTES) { note(p, `${name} is too large to preview (${Math.round(st.size / 1048576)} MB).`, 'warn'); return; }
    const show = tools(p)?.show;
    if (!show) { note(p, 'This phone\'s access does not allow opening files.', 'warn'); return; }
    try {
      const r = await show({ kind: 'file', path: file, title: name }, { via: 'codex-file' });
      if (r && r.ok === false) note(p, String(r.text || `Could not open ${name}.`).slice(0, 300), 'warn');
    } catch (e) { note(p, `Could not open ${name}: ${e.message || e}`, 'warn'); }
  }

  /** A short revision of the thread on disk, for the drift check: its updated time and recency (digits only). */
  async function revOf(threadId) {
    try {
      const r = await rpc('thread/read', { threadId, includeTurns: false });
      const t = r?.thread || {};
      return `${Number(t.updatedAt) || 0}:${Number(t.recencyAt) || 0}`;
    } catch { return null; }
  }

  async function historyBefore(c, p) {
    const base = { ev: 'historyPage', reqId: c.reqId || null, paneId: c.paneId || null, before: c.before || null };
    const threadId = p?.codex?.threadId;
    if (!threadId || (c.sessionId && c.sessionId !== p.sessionId)) { emit({ ...base, sessionId: c.sessionId || null, error: 'That conversation is not open in this pane.' }); return; }
    const limit = Math.min(5000, Math.max(1, Math.floor(Number(c.limit)) || HISTORY_PAGE));
    try {
      const page = await history.pageBefore(threadId, String(c.before), { limit, all: c.all === true, until: typeof c.until === 'string' ? c.until : null });
      trackFromMessages(p, page.messages);
      emit({ ...base, sessionId: p.sessionId, ...page });
    } catch (e) {
      emit({ ...base, sessionId: p.sessionId, error: `Codex could not read the rest of this conversation: ${e.message || e}` });
    }
  }

  /*
   * Your prompts across the whole thread (2026-10-12, codex-history.js): the count before the loaded pages arrives
   * a moment after the first page (ev historyCount), and the full list on request (op historyPrompts).
   */

  /** Counts the prompts before the loaded pages in the background; the pane's pin takes it when it still shows that page. */
  function countPrompts(p, threadId) {
    history.promptCount(threadId).then((r) => {
      if (!r || p.codex?.threadId !== threadId) return;
      emit({ ev: 'historyCount', paneId: p.id, sessionId: p.sessionId, first: r.first, prompts: { before: r.before, total: r.total } });
    }).catch((e) => log(`codex prompt count: ${e.message || e}`));
  }

  /** op historyPrompts: every prompt of the thread, oldest first. */
  async function prompts(c, p) {
    const base = { ev: 'historyPrompts', reqId: c.reqId || null, paneId: p.id, sessionId: p.sessionId };
    const threadId = p.codex?.threadId;
    if (!threadId) { emit({ ...base, prompts: [], total: 0 }); return; }
    try {
      const r = await history.promptList(threadId);
      emit({ ...base, ...(r || { prompts: [], total: 0 }) });
    } catch (e) { emit({ ...base, error: `Codex could not list this conversation's prompts: ${e.message || e}` }); }
  }

  async function historyCheck(c, p) {
    const base = { ev: 'historyChecked', reqId: c.reqId || null, paneId: c.paneId || null };
    const threadId = p?.codex?.threadId;
    if (!threadId) { emit({ ...base, sessionId: c.sessionId || null, fresh: true }); return; }
    // A turn running here streams into the pane: it is the newest there is. Otherwise the thread may have moved on in
    // the Codex app (or another Apaki): the revision tells.
    if (p.busy) { emit({ ...base, sessionId: p.sessionId, fresh: true }); return; }
    const rev = await revOf(threadId);
    if (!rev || rev === c.rev) { emit({ ...base, sessionId: p.sessionId, fresh: true }); return; }
    await sendHistory(p, { refresh: true });
    emit({ ...base, sessionId: p.sessionId, fresh: false, rev });
  }

  /** A window reconnected to a running pane: its state again, the history, any question still waiting. */
  async function attach(reqId, p, as = null) {
    const cx = p.codex;
    // as: { paneId, readOnly } (the shared view, engine.js followState): a phone that follows this pane gets the same state under
    // its own pane id, marked as a follower. Nothing about the pane changes.
    const to = as?.paneId || p.id;
    const follower = as ? { follower: true, readOnly: Boolean(as.readOnly) } : {};
    emit({ ev: 'opened', attached: true, busy: Boolean(p.busy), turn: Boolean(p.busy), running: Boolean(client?.ready), reqId, paneId: to, sessionId: p.sessionId, cwd: cx.cwd, title: p.codexTitle || 'Codex', model: p.model, effort: p.effort, mode: p.mode, billing: billingOf(), terminal: [], kind: 'codex', ...follower });
    if (cx.threadId) await sendHistory(p, as ? { paneId: to } : {});
    for (const [askId, a] of asks) if (a.paneId === p.id) emit({ ev: 'ask', askId, paneId: to, toolName: a.toolName, input: a.input, ...(a.permission ? { permission: a.permission } : {}), ...(as ? { readOnly: follower.readOnly } : {}) });
    if (cx.usage) sendContext(p, null, to);
  }

  /* ---------- sending ---------- */

  /** Starts the thread of a new conversation (its first message). */
  async function startThread(p) {
    const cx = p.codex;
    const r = await rpc('thread/start', { serviceName: SERVICE_NAME, ...threadParams(p, cx.cwd) });
    cx.threadId = r.thread.id;
    cx.loaded = true;
    p.sessionId = codexId(cx.threadId);
    byThread.set(cx.threadId, p);
    adopt(p, r);
    if (cx.touched.model && p.model) { /* the pane's own pick stays what the next turn sends */ }
    emit({ ev: 'session_id', paneId: p.id, sessionId: p.sessionId });
    settingsEvent(p);
    shared.rowsAt = 0;
  }

  /** The thread was dropped (the server restarted): resume it. */
  async function ensureLoaded(p) {
    const cx = p.codex;
    if (!cx.threadId) { await startThread(p); return; }
    if (cx.loaded && client?.ready) return;
    await getClient().ensure();
    const r = await rpc('thread/resume', { threadId: cx.threadId, excludeTurns: true, ...threadParams(p, null) });
    cx.loaded = true;
    byThread.set(cx.threadId, p);
    adopt(p, r);
  }

  /** Saves non-picture attachments where Codex can read them; returns [{ name, path }]. */
  function saveFiles(p, files) {
    const out = [];
    if (!files.length) return out;
    const root = path.join(env.attachDir ? env.attachDir() : path.join(os.homedir(), '.claude', 'latch', 'codex-attachments'));
    const dir = path.join(root, safeName(p.codex.threadId || p.id));
    fs.mkdirSync(dir, { recursive: true });
    const why = path.join(root, '_WHY_THIS_IS_HERE.md');
    if (!fs.existsSync(why)) {
      fs.writeFileSync(why, '# codex-attachments\n\n**What:** files attached to Codex conversations in Myrlin Apaki, one folder per thread (Apaki saves them here so Codex can read them by path; pictures are sent inline and not saved).\n\n**Made by:** Myrlin Apaki (apaki/engine/codex-panes.js).\n\n**Safe to delete:** yes, once the conversations that mention them are done. Codex can no longer open a deleted attachment. Nothing here is regenerated.\n');
    }
    let n = 0;
    for (const f of files) {
      const buf = Buffer.from(String(f.data || ''), 'base64');
      if (!buf.length || buf.length > ATTACH_MAX_BYTES) continue;
      const name = safeName(f.name || `attachment-${++n}`);
      const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
      fs.writeFileSync(file, buf);
      out.push({ name, path: file });
    }
    return out;
  }

  /** The overrides a turn carries: what the person picked in this pane, and always the limits of a restricted phone. */
  function turnOverrides(p) {
    const cx = p.codex;
    const o = {};
    if (cx.touched.model && p.model) o.model = p.model;
    if (cx.touched.effort && p.effort) o.effort = p.effort;
    if (cx.touched.mode || restricted(p)) Object.assign(o, turnPermissions(p.mode, { restricted: restricted(p) }));
    return o;
  }

  const split = (items) => {
    const list = Array.isArray(items) ? items : [];
    return { images: list.filter((x) => /^image\/(png|jpeg|gif|webp)$/.test(String(x?.media_type))), files: list.filter((x) => x && !/^image\//.test(String(x.media_type)) && x.data) };
  };

  /**
   * A message: the commands Codex has as slash commands run here, anything else starts a turn. The turn's events
   * arrive as notifications; the result event (with this reqId) is sent when it completes.
   */
  async function send(reqId, p, text, attachments = []) {
    const cx = p.codex;
    const body = String(text || '').trim();
    const slash = /^\/(compact|status|diff|mcp|revert)\b\s*$/i.exec(body);
    if (slash && !attachments.length) { await slashCommand(reqId, p, slash[1].toLowerCase()); return; }
    // The commands that take words after them.
    const withArg = /^\/(mention|review|goal)\b\s*(.*)$/is.exec(body);
    if (withArg && !attachments.length) { await slashCommand(reqId, p, withArg[1].toLowerCase(), withArg[2]); return; }
    // /init is an ordinary turn with Codex's own kind of prompt.
    if (/^\/init\s*$/i.test(body) && !attachments.length) text = INIT_PROMPT;
    try {
      await ensureLoaded(p);
      // /<skill> [words]: one of Codex's skills (skills/list), sent the way the Codex app sends a picked skill: its $name in
      // the text and the skill itself as an input item.
      const call = attachments.length ? null : skillCall(body);
      const skill = call ? (await skillsOf(p)).find((s) => s.name === call.name) : null;
      if (skill) text = `$${skill.name} ${call.rest}`.trim();
      const { images, files } = split(attachments);
      const saved = saveFiles(p, files);
      // Files /mention attached ride with this message, once.
      const input = turnInput(text, images, [...saved, ...(cx.mentions || [])]);
      cx.mentions = [];
      if (skill) input.push({ type: 'skill', name: skill.name, path: skill.path });
      if (!input.length) { emit({ ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: 'success', isError: false, durationMs: 0, usage: {}, cost: null, errors: null, result: null, codex: true }); return; }
      const clientId = `apaki-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      cx.sentIds.add(clientId);
      p.busy = true;
      p.inTurn = true;
      cx.startedAt = Date.now();
      const r = await rpc('turn/start', { threadId: cx.threadId, input, clientUserMessageId: clientId, summary: 'auto', ...turnOverrides(p) });
      const turnId = r?.turn?.id;
      // A turn that already ended (its events came before this answer) must not leave a turn id behind for a later steer to trust.
      if (turnId && p.busy) { cx.turnId = cx.turnId || turnId; cx.reqByTurn.set(turnId, reqId); }
    } catch (e) {
      p.busy = false;
      p.inTurn = false;
      emit({ ev: 'error', reqId, paneId: p.id, message: e.message || String(e) });
    }
  }

  /** Adds a message to the running turn without stopping it (the Ctrl+Enter / Steer button). */
  async function steer(c, p) {
    const cx = p.codex;
    const { images, files } = split(c.images);
    if (!cx.turnId || !p.busy) { emit({ ev: 'steer_missed', reqId: c.reqId, paneId: p.id, qid: c.qid }); return; }
    try {
      const input = turnInput(String(c.text || ''), images, saveFiles(p, files));
      await rpc('turn/steer', { threadId: cx.threadId, expectedTurnId: cx.turnId, input });
      emit({ ev: 'steered', reqId: c.reqId, paneId: p.id, qid: c.qid });
    } catch (e) {
      log(`codex steer missed: ${e.message}`);
      emit({ ev: 'steer_missed', reqId: c.reqId, paneId: p.id, qid: c.qid });
    }
  }

  async function interrupt(p) {
    const cx = p.codex;
    if (!cx?.threadId || !cx.turnId) return;
    try { await rpc('turn/interrupt', { threadId: cx.threadId, turnId: cx.turnId }); } catch (e) { log(`codex interrupt: ${e.message}`); }
  }

  /* ---------- settings ---------- */

  async function setModel(p, model) {
    const cx = p.codex;
    const known = modelOf(model);
    if (!known) { settingsEvent(p); return; }
    p.model = model;
    cx.touched.model = true;
    // A model that does not offer the current effort takes its own default, as the Codex app does.
    const e = effortFor(known, p.effort);
    if (e !== p.effort) { p.effort = e; cx.touched.effort = true; }
    settingsEvent(p);
  }

  function setEffort(p, effort) {
    const known = modelOf(p.model);
    if (known && !known.efforts.some((e) => e.value === effort)) { settingsEvent(p); return; }
    p.effort = effort;
    p.codex.touched.effort = true;
    settingsEvent(p);
  }

  function setMode(p, mode) {
    if (!isPreset(mode)) { settingsEvent(p); return false; }
    const cap = phoneCap(p.id);
    if (cap && !capPresets(cap).includes(mode)) { settingsEvent(p); return false; }
    p.mode = mode;
    p.codex.touched.mode = true;
    settingsEvent(p);
    return true;
  }

  /* ---------- slash commands ---------- */

  /** The skills Codex has for this thread's folder (skills/list), kept a minute: [{ name, description, path }]. */
  async function skillsOf(p) {
    const cx = p.codex;
    const cwd = cx.cwd || os.homedir();
    const hit = shared.skills.get(cwd);
    if (hit && Date.now() - hit.at < 60000) return hit.list;
    let list = [];
    try {
      const r = await rpc('skills/list', { cwds: [cwd] });
      const data = Array.isArray(r?.data) ? r.data : [];
      const entry = data.find((e) => e?.cwd === cwd) || data[0] || null;
      list = (Array.isArray(entry?.skills) ? entry.skills : []).filter((s) => s && s.enabled !== false && typeof s.name === 'string' && typeof s.path === 'string')
        .map((s) => ({ name: s.name, description: String(s.interface?.shortDescription || s.shortDescription || s.description || '').replace(/\s+/g, ' ').slice(0, 140), path: s.path }));
    } catch (e) { log(`codex skills/list failed: ${e.message}`); }
    shared.skills.set(cwd, { at: Date.now(), list });
    return list;
  }

  /** The slash menu of a Codex pane: its own commands, then the skills Codex has here (a skill never hides a command). */
  async function commandsFor(p) {
    const own = COMMANDS.map((c) => ({ ...c }));
    if (!p?.codex?.threadId && !p?.codex?.cwd) return own;
    const skills = (await skillsOf(p)).filter((s) => !RESERVED.has(s.name)).map((s) => ({ name: s.name, description: s.description || 'A Codex skill', argumentHint: '', skill: true }));
    return [...own, ...skills];
  }

  async function slashCommand(reqId, p, name, arg = '') {
    const cx = p.codex;
    const done = (extra = {}) => emit({ ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: 'success', isError: false, durationMs: 0, usage: {}, cost: null, errors: null, result: null, codex: true, quiet: true, ...extra });
    try {
      if (name === 'status') {
        note(p, `Model ${p.model || '?'}, effort ${p.effort || '?'}, ${({ 'read-only': 'read only', auto: 'auto (edits inside the workspace)', 'full-access': 'full access' })[p.mode] || p.mode}. Folder ${cx.cwd || '?'}. Thread ${cx.threadId || '(starts with your first message)'}.`);
        done();
        return;
      }
      if (name === 'mention') {
        // The file goes to the model as a mention item with the next message (what the Codex app's @ does). Only the path
        // is looked at here: nothing is read or changed.
        const raw = String(arg || '').trim().replace(/^["']|["']$/g, '').replace(/^@/, '');
        if (!raw) { note(p, 'Name a file to attach to your next message, for example /mention src/app.ts'); done(); return; }
        const file = path.resolve(cx.cwd || os.homedir(), raw);
        let isFile = false;
        try { isFile = fs.statSync(file).isFile(); } catch { isFile = false; }
        if (!isFile) { note(p, `There is no file at ${file}.`, 'warn'); done(); return; }
        cx.mentions = [...(cx.mentions || []).filter((m) => m.path !== file), { name: path.basename(file), path: file }];
        note(p, `${path.basename(file)} goes with your next message.`);
        done();
        return;
      }
      if (name === 'diff') {
        const id = cx.lastDiffTurn;
        if (!id) note(p, 'This conversation has no changes to show yet.');
        else await showDiff(p, id, { open: true });
        done();
        return;
      }
      if (name === 'mcp') {
        const r = await rpc('mcpServerStatus/list', { ...(cx.threadId ? { threadId: cx.threadId } : {}), detail: 'toolsAndAuthOnly' });
        const rows = (Array.isArray(r?.data) ? r.data : []).map((s) => `${s.name}${s.authStatus ? ` (${s.authStatus})` : ''}${s.tools ? `: ${Object.keys(s.tools).length} tools` : ''}`);
        note(p, rows.length ? `Tool servers: ${rows.join('; ')}.` : 'No tool servers.');
        done();
        return;
      }
      await ensureLoaded(p);
      if (name === 'compact') {
        p.busy = true;
        p.inTurn = true;
        cx.startedAt = Date.now();
        const waiter = new Promise((resolve) => { cx.compactWait = resolve; });
        await rpc('thread/compact/start', { threadId: cx.threadId });
        // The server reports the compaction as an item (or thread/compacted); if it reports nothing in a while, the pane is freed anyway.
        await Promise.race([waiter, new Promise((r) => setTimeout(r, 120000).unref?.())]);
        cx.compactWait = null;
        if (p.busy && !cx.turnId) { p.busy = false; p.inTurn = false; done(); turnEnded(p, { status: 'completed' }); }
        return;
      }
      // What changes the thread itself follows the phone rules the session menu has: Chat only reads, it does not rewrite.
      const changes = name === 'revert' || (name === 'goal' && String(arg || '').trim());
      if (changes && phoneCap(p.id) === 'chat') { note(p, 'This phone is set to Chat only on the PC, which cannot change the conversation itself.', 'warn'); done(); return; }
      if (name === 'revert') {
        // thread/revert drops the newest turn (and any after it) from the thread's history; what Codex changed on disk stays.
        if (p.busy) { note(p, 'Wait until Codex finishes, or stop it first.', 'warn'); done(); return; }
        const last = await rpc('thread/turns/list', { threadId: cx.threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
        const turn = (Array.isArray(last?.data) ? last.data : [])[0];
        if (!turn?.id) { note(p, 'There is nothing to take out yet.'); done(); return; }
        await rpc('thread/revert', { threadId: cx.threadId, beforeTurnId: turn.id });
        cx.usage = null;
        await sendHistory(p, { refresh: true });
        note(p, 'The last exchange is out of this conversation. Files Codex changed stay as they are.');
        shared.rowsAt = 0;
        done();
        return;
      }
      if (name === 'goal') {
        const a = String(arg || '').trim();
        if (!a) {
          const r = await rpc('thread/goal/get', { threadId: cx.threadId });
          cx.goalStatus = r?.goal?.status || null;
          note(p, r?.goal ? goalLine(r.goal) : 'No goal is set. /goal followed by what you want done sets one.');
        } else if (/^(clear|off|none)$/i.test(a)) {
          await rpc('thread/goal/clear', { threadId: cx.threadId });
          cx.goalStatus = null;
          note(p, 'The goal is cleared.');
        } else {
          const r = await rpc('thread/goal/set', { threadId: cx.threadId, objective: a, origin: 'user' });
          cx.goalStatus = r?.goal?.status || cx.goalStatus;
          note(p, r?.goal ? goalLine(r.goal) : 'The goal is set.');
        }
        done();
        return;
      }
      if (name === 'review') {
        p.busy = true;
        p.inTurn = true;
        cx.startedAt = Date.now();
        const r = await rpc('review/start', { threadId: cx.threadId, target: reviewTarget(arg), delivery: 'inline' });
        if (r?.turn?.id) { cx.turnId = cx.turnId || r.turn.id; cx.reqByTurn.set(r.turn.id, reqId); }
      }
    } catch (e) {
      p.busy = false;
      p.inTurn = false;
      emit({ ev: 'error', reqId, paneId: p.id, message: e.message || String(e) });
    }
  }

  /** One line saying what the thread's goal is and where it stands. */
  function goalLine(g) {
    const state = { active: 'working toward it', paused: 'paused', blocked: 'blocked', usageLimited: 'stopped by a usage limit', budgetLimited: 'stopped at its token budget', complete: 'done' }[g?.status] || g?.status || 'set';
    const k = Number(g?.tokensUsed) >= 1000 ? `, ${Math.round(Number(g.tokensUsed) / 1000)}k tokens used` : '';
    return `Goal: ${g?.objective || '(none)'} (${state}${k}).`;
  }

  /* ---------- the context meter ---------- */

  function sendContext(p, reqId = null, to = null) {
    const cx = p.codex;
    if (!cx?.usage) { if (reqId) emit({ ev: 'context', reqId, paneId: to || p.id, none: true }); return; }
    emit({ ev: 'context', reqId, paneId: to || p.id, ...contextFromUsage(cx.usage, { model: p.model, threadId: cx.threadId, autoCompactLimit: shared.config?.model_auto_compact_token_limit }) });
  }

  function contextSoon(p) {
    const cx = p.codex;
    clearTimeout(cx.contextTimer);
    cx.contextTimer = setTimeout(() => sendContext(p), 250);
    cx.contextTimer.unref?.();
  }

  /* ---------- notifications ---------- */

  const paneOf = (params) => byThread.get(params?.threadId) || null;

  function flushOutput(p, itemId) {
    const cx = p.codex;
    const o = cx.out.get(itemId);
    if (!o) return;
    clearTimeout(o.timer);
    o.timer = null;
    if (o.dirty) { o.dirty = false; sdk(p, toolOutput(itemId, o.text)); }
  }

  function emitToolUse(p, item) {
    const cx = p.codex;
    const use = toolUseOf(item);
    if (item?.type === 'fileChange') trackChanged(p, use?.input?.changes);
    if (!use || cx.items.get(item.id)?.shown) return false;
    cx.items.set(item.id, { ...item, shown: true });
    sdk(p, assistantMessage(cx.turnId || item.id, [use]));
    return true;
  }

  function onItemStarted(p, params) {
    const cx = p.codex;
    const item = params.item;
    if (!item?.id) return;
    if (item.type === 'userMessage') { if (item.clientId) cx.sentIds.delete(item.clientId); return; }
    cx.items.set(item.id, { ...(cx.items.get(item.id) || {}), ...item });
    if (item.type === 'reasoning') { sdk(p, streamEvent({ type: 'content_block_start', index: ++cx.blockSeq, content_block: { type: 'thinking', thinking: '' } })); return; }
    if (item.type === 'contextCompaction') { sdk(p, { type: 'system', subtype: 'status', status: 'compacting' }); return; }
    emitToolUse(p, item);
  }

  function onItemCompleted(p, params) {
    const cx = p.codex;
    const item = params.item;
    if (!item?.id) return;
    const turnId = params.turnId || cx.turnId || item.id;
    switch (item.type) {
      case 'userMessage': return;
      case 'agentMessage': {
        cx.blocks.delete(item.id);
        if (String(item.text || '').trim()) sdk(p, assistantMessage(turnId, [{ type: 'text', text: item.text }]));
        return;
      }
      case 'plan':
        if (String(item.text || '').trim()) sdk(p, assistantMessage(turnId, [{ type: 'text', text: item.text }]));
        return;
      case 'reasoning': {
        const t = reasoningText(item);
        if (t) sdk(p, assistantMessage(turnId, [{ type: 'thinking', thinking: t }]));
        return;
      }
      case 'contextCompaction':
        sdk(p, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
        if (cx.compactWait) { cx.compactWait(); }
        return;
      default: break;
    }
    const prior = cx.items.get(item.id);
    if (!prior?.shown) emitToolUse(p, item);
    flushOutput(p, item.id);
    cx.items.set(item.id, { ...item, shown: true });
    const res = toolResultOf(item);
    if (res) sdk(p, toolResultMessage([res]));
    cx.out.delete(item.id);
    // An imageView / image generation result: show the picture, as the Codex app does.
    if ((item.type === 'imageView' && item.path) || (item.type === 'imageGeneration' && item.savedPath)) showImage(p, item.type === 'imageView' ? item.path : item.savedPath, item.id);
  }

  function showImage(p, file, toolUseId) {
    try {
      tools(p).show({ kind: 'image', path: String(file), title: path.basename(String(file)) }, { via: 'codex-image', toolUseId }).catch(() => {});
    } catch { /* a picture that cannot be shown is still in the tool line */ }
  }

  function onNotification(method, params) {
    switch (method) {
      case 'account/updated':
        shared.account = null;
        loadShared().then(() => { for (const p of panes.values()) if (isCodexPane(p)) emit({ ev: 'billing', paneId: p.id, ...billingOf() }); }).catch(() => {});
        return;
      case 'account/rateLimits/updated':
        // The chip's usage line follows the server's numbers (the warnings below say it when it matters).
        shared.limits = limitsOf(params?.rateLimits);
        for (const p of panes.values()) if (isCodexPane(p)) emit({ ev: 'billing', paneId: p.id, ...billingOf() });
        for (const msg of limitEvents(params?.rateLimits)) for (const p of panes.values()) if (isCodexPane(p) && p.codex.threadId) sdk(p, msg);
        return;
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice': {
        const text = String(params?.message || params?.summary || '').trim();
        const p = paneOf(params);
        if (text && p) sdk(p, informational(text, 'warning'));
        return;
      }
      default: break;
    }
    const p = paneOf(params);
    if (!p) return;
    const cx = p.codex;
    switch (method) {
      case 'turn/started':
        cx.turnId = params.turn?.id || cx.turnId;
        cx.startedAt = Date.now();
        p.busy = true;
        p.inTurn = true;
        sdk(p, messageStart(cx.turnId));
        break;
      case 'turn/completed': onTurnCompleted(p, params); break;
      case 'item/started': onItemStarted(p, params); break;
      case 'item/completed': onItemCompleted(p, params); break;
      case 'item/agentMessage/delta': {
        let b = cx.blocks.get(params.itemId);
        if (b === undefined) { b = ++cx.blockSeq; cx.blocks.set(params.itemId, b); sdk(p, textStart(b)); }
        if (params.delta) sdk(p, textDelta(b, params.delta));
        break;
      }
      case 'item/commandExecution/outputDelta': {
        let o = cx.out.get(params.itemId);
        if (!o) { o = { text: '', dirty: false, timer: null }; cx.out.set(params.itemId, o); }
        o.text = `${o.text}${params.delta || ''}`.slice(-OUTPUT_KEEP);
        o.dirty = true;
        if (!o.timer) { o.timer = setTimeout(() => flushOutput(p, params.itemId), OUTPUT_EVERY_MS); o.timer.unref?.(); }
        break;
      }
      case 'turn/plan/updated':
        sdk(p, assistantMessage(cx.turnId || params.turnId, [todoWriteOf(`plan-${params.turnId || cx.turnId}-${++cx.planSeq}`, params.plan)]));
        break;
      case 'turn/diff/updated':
        if (params.turnId && typeof params.diff === 'string') { cx.diffs.set(params.turnId, params.diff); cx.lastDiffTurn = params.turnId; }
        break;
      case 'thread/tokenUsage/updated':
        cx.usage = params.tokenUsage;
        contextSoon(p);
        break;
      case 'error':
        // A retry is shown (Claude shows API retries the same way); a final failure arrives with turn/completed.
        if (params.willRetry) sdk(p, informational(`${friendlyError(params.error)} Retrying.`, 'warning'));
        break;
      case 'hook/completed': { const m = hookMessage(params.run); if (m) sdk(p, m); break; }
      // Apaki's tool server (the viewer and browser tools) did not start for this thread: say so once, instead of Codex quietly
      // having no show tool (it still works without them; links and files just open outside Apaki).
      case 'mcpServer/startupStatus/updated':
        if (params.name === 'apaki' && params.status === 'failed' && !cx.toolsWarned) {
          cx.toolsWarned = true;
          sdk(p, informational(`Apaki's viewer and browser tools did not start for this thread${params.error ? `: ${String(params.error).slice(0, 300)}` : ''}`, 'warning'));
        }
        break;
      case 'model/rerouted': sdk(p, rerouteMessage(params)); break;
      case 'thread/name/updated':
        if (params.threadName) { p.codexTitle = params.threadName; emit({ ev: 'renamed', paneId: p.id, sessionId: p.sessionId, title: params.threadName, ok: true }); shared.rowsAt = 0; }
        break;
      // A goal Codex moved on its own (done, blocked, out of budget, or changed in the Codex app): said once per change of state.
      case 'thread/goal/updated':
        if (params.goal && params.goal.status !== cx.goalStatus) { cx.goalStatus = params.goal.status; note(p, goalLine(params.goal)); }
        break;
      case 'thread/goal/cleared':
        if (cx.goalStatus) { cx.goalStatus = null; note(p, 'The goal was cleared.'); }
        break;
      case 'thread/compacted':
      case 'context/compacted':
        sdk(p, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
        cx.compactWait?.();
        break;
      case 'serverRequest/resolved':
        for (const [id, a] of asks) {
          if (a.paneId === p.id && a.codexRequestId === params.requestId) { a.settled = true; asks.delete(id); emit({ ev: 'ask_gone', askId: id, paneId: p.id }); }
        }
        break;
      case 'thread/closed':
        cx.loaded = false;
        break;
      default: break;
    }
  }

  function onTurnCompleted(p, params) {
    const cx = p.codex;
    const turn = params.turn || {};
    for (const id of [...cx.out.keys()]) flushOutput(p, id);
    cx.out.clear();
    cx.blocks.clear();
    // The turn's items (kept so an approval can show a patch's diffs) are not needed once it is over.
    cx.items.clear();
    const reqId = cx.reqByTurn.get(turn.id) ?? null;
    cx.reqByTurn.delete(turn.id);
    const failed = turn.status === 'failed';
    const why = failed ? friendlyError(turn.error) : null;
    const wasBusy = p.busy;
    p.busy = false;
    p.inTurn = false;
    cx.turnId = null;
    // Anything still waiting on this turn is gone with it.
    for (const [id, a] of [...asks]) if (a.paneId === p.id && a.codexRequestId !== undefined) { a.settled = true; asks.delete(id); emit({ ev: 'ask_gone', askId: id, paneId: p.id }); }
    emit({
      ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: failed ? 'error_during_execution' : turn.status === 'interrupted' ? 'error_during_execution' : 'success',
      isError: failed, durationMs: Number(turn.durationMs) || (cx.startedAt ? Date.now() - cx.startedAt : 0), usage: {}, cost: null, errors: why ? [why] : null, result: why, codex: true,
      interrupted: turn.status === 'interrupted', tokens: cx.usage?.last?.totalTokens ?? null,
    });
    if (turn.status === 'interrupted') sdk(p, informational('Interrupted.', 'info'));
    if (cx.diffs.has(turn.id)) showDiff(p, turn.id).catch(() => {});
    cx.compactWait?.();
    if (wasBusy) turnEnded(p, { status: turn.status });
  }

  /** A turn's changes as a card (no viewer opens by itself; the card does). */
  async function showDiff(p, turnId, { open = false } = {}) {
    const cx = p.codex;
    const diff = cx.diffs.get(turnId);
    if (!diff || !diff.trim()) return;
    const files = new Set([...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]));
    const n = files.size || 1;
    const title = `Changes: ${n} file${n === 1 ? '' : 's'}`;
    await tools(p).show({ kind: 'markdown', title, content: `\`\`\`diff\n${diff.slice(0, 600000)}\n\`\`\`\n` }, { via: 'codex-diff', sub: files.size ? [...files].slice(0, 3).join(', ') + (files.size > 3 ? ', ...' : '') : '', open });
  }

  /* ---------- server requests: approvals, questions, tool calls ---------- */

  function raise(p, a, requestId, reply, after = null) {
    const id = rid();
    const entry = {
      paneId: p.id, toolName: a.toolName, input: a.input, at: Date.now(), codexRequestId: requestId, settled: false,
      ...(a.permission ? { kind: 'permission', permission: a.permission } : {}),
      answer: (r) => { if (entry.settled) return; entry.settled = true; asks.delete(id); client.respond(requestId, reply(r)); after?.(r); },
      resolve: () => { if (entry.settled) return; entry.settled = true; asks.delete(id); client.respond(requestId, reply(null)); },
    };
    asks.set(id, entry);
    emit({ ev: 'ask', askId: id, paneId: p.id, toolName: a.toolName, input: a.input, ...(a.permission ? { permission: a.permission } : {}) });
  }

  /** Deny with a note: Codex's decline carries no text, so the note goes to the model as a steer right after. */
  const noteAfterDeny = (p, text) => (r) => {
    const note = r && r.behavior === 'deny' && typeof r.message === 'string' ? r.message.trim() : '';
    if (!note || !p.codex?.turnId) return;
    rpc('turn/steer', { threadId: p.codex.threadId, expectedTurnId: p.codex.turnId, input: turnInput(`${text} ${note}`) }).catch(() => {});
  };

  async function onRequest(id, method, params) {
    const p = byThread.get(params?.threadId || params?.conversationId) || null;
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        if (!p) { client.respond(id, method.startsWith('item/') ? (method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' }) : { decision: 'denied' }); return; }
        const item = p.codex.items.get(params.itemId) || null;
        const a = approvalAsk(method, params, { item });
        if (a.kind === 'permissions') a.requested = params.permissions || {};
        raise(p, a, id, (r) => approvalReply(a, r), noteAfterDeny(p, 'The user did not allow that and says:'));
        return;
      }
      case 'item/tool/requestUserInput': {
        if (!p) { client.respond(id, { answers: {} }); return; }
        const a = questionAsk(params);
        raise(p, a, id, (r) => questionReply(a, r));
        return;
      }
      case 'mcpServer/elicitation/request': {
        const a = p ? elicitationAsk(params) : null;
        if (!a) { client.respond(id, { action: 'decline', content: null, _meta: null }); return; }
        raise(p, a, id, (r) => {
          const out = elicitationReply(a, r);
          if (a.kind === 'url' && out.action === 'accept') openPage(p, { url: a.input.url, title: null, reason: 'codex' });
          return out;
        });
        return;
      }
      case 'item/tool/call':
        client.respond(id, { contentItems: [{ type: 'inputText', text: `Apaki does not provide a tool named ${params?.tool || 'that'}; use the apaki MCP tools.` }], success: false });
        return;
      case 'account/chatgptAuthTokens/refresh':
        client.respondError(id, -32000, 'Apaki cannot refresh a ChatGPT sign-in; sign in again in the Codex app or with codex login.');
        return;
      default:
        client.respondError(id, -32601, `Apaki does not handle ${method}`);
    }
  }

  /* ---------- Apaki's tools, called by the tool server ---------- */

  /** The Codex pane a call from the shared tool server or BROWSER belongs to: the one whose turn is running, the newest first. */
  function pickPane(preferThread = null) {
    const list = [...panes.values()].filter(isCodexPane);
    if (preferThread) { const hit = list.find((p) => p.codex.threadId === preferThread); if (hit) return hit; }
    const running = list.filter((p) => p.busy).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    if (running.length) return running[0];
    return list.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0] || null;
  }

  /** Runs one of Apaki's tools for the pane that called it. Returns { ok, text, image?, mimeType? }. */
  async function runTool(tool, input = {}, meta = {}) {
    const hint = meta?.threadId || meta?.thread_id || meta?.['x-codex-turn-metadata']?.thread_id || meta?.['x-codex-turn-metadata']?.session_id || null;
    const p = pickPane(hint);
    if (!p) return { ok: false, text: 'No Codex conversation is open in Apaki right now.' };
    const cap = phoneCap(p.id);
    if (cap && cap !== 'full') return { ok: false, text: `This phone is set to ${cap === 'chat' ? 'Chat only' : 'No shell'} on the PC, so Codex may not use Apaki's tools from it.` };
    const t = tools(p);
    p.lastActiveAt = Date.now();
    if (tool === 'show') return t.show(input, { via: 'show' });
    if (!t.browser) return { ok: false, text: 'This window has no built-in browser.' };
    return t.browser.call(tool, input);
  }

  /** A link a command opened through the BROWSER shim: the pane whose turn is running shows it. */
  function openedLink(url) {
    const p = pickPane();
    if (p) openPage(p, { url, title: null, reason: 'BROWSER', toolUseId: null });
  }

  /* ---------- closing ---------- */

  function release(p) {
    const cx = p.codex;
    if (!cx) return;
    for (const [id, a] of [...asks]) if (a.paneId === p.id) { a.resolve?.(null); asks.delete(id); }
    clearTimeout(cx.contextTimer);
    if (cx.threadId) {
      byThread.delete(cx.threadId);
      history?.forget(cx.threadId);
    }
  }

  async function close(p) {
    const cx = p.codex;
    if (!cx) return;
    if (cx.threadId && client?.ready) {
      if (p.busy && cx.turnId) await interrupt(p);
      rpc('thread/unsubscribe', { threadId: cx.threadId }).catch(() => {});
    }
    release(p);
    p.busy = false;
    p.inTurn = false;
    p.codex = null;
    p.kind = null;
    touchIdle();
  }

  async function rename(threadId, name) {
    await rpc('thread/name/set', { threadId, name });
    shared.rowsAt = 0;
  }

  /** A copy of a thread to take elsewhere (thread/fork): its session id. */
  async function fork(threadId) {
    const r = await rpc('thread/fork', { threadId });
    shared.rowsAt = 0;
    return codexId(r.thread.id);
  }

  /** A phone's access changed on the PC: its Codex pane takes the presets the access allows now. */
  function recap(p) {
    const cap = phoneCap(p.id);
    if (!cap || !p.codex) return;
    p.mode = clampPreset(cap, p.mode);
    p.codex.touched.mode = true;
    settingsEvent(p);
  }

  async function shutdown() {
    clearTimeout(shared.idle);
    if (client) await client.stop().catch(() => {});
  }

  return {
    isCodexPane, open, attach, send, steer, openFile, interrupt, setModel, setEffort, setMode, models, list, sendContext, historyBefore, historyCheck, sendHistory,
    runTool, openedLink, pickPane, release, close, rename, fork, recap, shutdown, touchIdle, rpc, commands: () => COMMANDS.map((c) => ({ ...c })), commandsFor,
    prompts,
    /** The thread rows read by the last list() (empty until the Codex view asks). */
    cachedRows: () => shared.rows || [],
    /** Tests: the client and the panes by thread. */
    get client() { return getClient(); }, byThread,
  };
}
