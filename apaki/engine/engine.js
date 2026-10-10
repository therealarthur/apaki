#!/usr/bin/env node
/**
 * engine.js: Myrlin Apaki's bridge to Claude Code.
 *
 * Started by the Apaki window (apaki/src/main.rs). Reads one JSON command per
 * line on stdin and prints one JSON event per line on stdout. Everything else
 * (logs, Claude Code's stderr) goes to stderr, which the window writes to
 * ~/.claude/latch/apaki-engine.log.
 *
 * It reuses latch's tested pieces instead of new ones:
 *   - SessionRunner (src/runner.js): Claude Code through the Agent SDK,
 *     resumed on the chosen session, so every turn lands in that session and
 *     `claude --resume <id>` continues it on the subscription.
 *   - glassCredential (src/auth.js): billing follows Myrlin Glass both ways,
 *     re-checked before every message.
 *   - the picker data (src/ui/picker.js makeLoader, terminalSessions, folders)
 *     and the deep index (src/deepindex.js, latch-index).
 *
 * Commands (op): sessions, search, open, send, interrupt, answer, model,
 * effort, mode, billing, commands, folder, close, askSearch, digPrompt. Events (ev): ready, index,
 * sessions, search, opened, history, sdk, result, ask, billing, commands, note,
 * error, open_elsewhere, closed, settings (a pane's model, effort and mode,
 * shown in its message box instead of as notes in the conversation).
 *
 * Panes (2026-10-09, Arthur: tabs and up to 6 split panes, each its own
 * session): every conversation command carries a paneId and every event about
 * a conversation carries it back. Each pane has its own runner (its own Claude
 * Code process), model, effort, mode and billing, so panes work at the same
 * time. One session can be open in one pane only.
 *
 * Artifacts (2026-10-09, Arthur: like Codex's built-in artifacts, out of the
 * box): every pane's Claude Code gets Apaki's tools at runtime, through SDK
 * options only (apaki-tools.js): the in-process MCP server "apaki" with its
 * show tool, a short appended system prompt, PreToolUse/PostToolUse hooks that
 * turn "open this" shell commands into artifacts, and BROWSER pointing at
 * apaki/bin/apaki-open.cmd with a per-pane token for this engine's localhost
 * server (open-server.js), which also serves artifacts to the viewer.
 *   ev artifact  { paneId, sessionId, id, title, kind, rev, path, src, ext, mime, size, source, revs, via, toolUseId }
 *   ev openUrl   { paneId, sessionId, url, reason, title, toolUseId, browserId? }  (a web page
 *                to open: the conversation draws a link card, the built-in browser shows it)
 *   op artifactGet { id, sessionId?, rev?, content? } -> ev artifactContent (meta, src, and the
 *                content: utf8 for html/markdown/svg/text, base64 for image/pdf)
 *   op artifactList { sessionId } -> ev artifacts { sessionId, items }
 *   op openExternal { url } or { id, sessionId?, rev? } -> the system browser / default app
 *
 * The built-in browser (2026-10-09, Arthur: "a built-in browser like
 * Codex's, driven by Claude, light and fast"): the shell owns the browser
 * (apaki/src/browser.rs, a WebView2 with no bridge to Tauri or this engine);
 * the engine asks it for things over the same pipes (shell-channel.js):
 *   ev shell       { id, cmd, args }   a request for the shell, never shown to the window
 *   op shellReply  { id, ok, result | error }   its answer
 *   op shellHello  { version, features }        the shell's first line
 * With a browser, every pane's Claude Code also gets browser_open, _read,
 * _click, _type, _back and _screenshot (browser-tools.js), and web pages
 * from show, caught commands and BROWSER open in that browser.
 *   ev openUrl     gains browserId when the page went to the built-in browser
 *   ev browserActivity { paneId, browserId, action, text }   what Claude just did there
 *   op browserTool { paneId, tool, input } -> ev browserToolResult { ok, text, image? }
 *                  (runs one of Claude's browser tools for a pane: checks, later the phone)
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { ArtifactStore, kindOfExt } from './artifacts.js';
import { createApakiTools } from './apaki-tools.js';
import { createBrowserTools } from './browser-tools.js';
import { createShell } from './shell-channel.js';
import { startOpenServer } from './open-server.js';
import { CLAUDE_DIR, chooseCredential, childEnv, glassCredential, keySections } from '../../src/auth.js';
import { codexItem, codexResumeHint, isCodexId } from '../../src/codex.js';
import { searchHybrid, startIndexServer, updateIndex, updateViaServer } from '../../src/deepindex.js';
import { askSearch, digPrompt } from './asksearch.js';
import * as folders from '../../src/folders.js';
import { filterItems, terminalSessions } from '../../src/picker.js';
import { SessionRunner } from '../../src/runner.js';
import { lockInfo, lockStolen, releaseLock, rememberCreated, setLockApp, takeLock } from '../../src/sessions.js';
import { makeLoader } from '../../src/ui/picker.js';

// Locks this engine takes name it, so a blocked terminal window can say who has the session.
setLockApp('apaki');

// stdout is the event channel: nothing else may print there.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const DEFAULT_MODEL = process.env.APAKI_MODEL || 'claude-opus-5-5';
const DEFAULT_EFFORT = process.env.APAKI_EFFORT || 'xhigh';
const HISTORY_MESSAGES = 400;
const RESULT_CHARS = 4000;

function emit(ev) {
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}

// Requests to the Apaki shell (the built-in browser), answered on stdin.
const shell = createShell({ emit });

// Session list shared by every pane.
const state = {
  asks: new Map(), // askId -> { resolve, paneId }
  items: null,
  byId: new Map(),
  commandsByCwd: new Map(),
};

// New panes start from these; the window can pass its own per pane.
const defaults = { credential: glassCredential(), model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, mode: 'bypassPermissions' };

/** paneId -> { id, runner, sessionId, credential, model, effort, mode, tools } */
const panes = new Map();

/* ---------- artifacts and "open this" (apaki-tools.js) ---------- */

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPEN_SHIM = path.join(ENGINE_ROOT, 'apaki', 'bin', 'apaki-open.cmd');
const store = new ArtifactStore();

/** A served address for one revision of an artifact, for the window's viewer. */
const srcOf = (rec, rev) => (openServer ? openServer.artifactUrl(rec, rev) : null);

function artifactEvent(p, rec, meta = {}) {
  return {
    ev: 'artifact', paneId: p.id, sessionId: rec.sessionId, id: rec.id, title: rec.title, kind: rec.kind, rev: rec.rev,
    path: store.fileOf(rec).file, src: srcOf(rec), ext: rec.ext, mime: rec.mime, size: rec.size, source: rec.source,
    revs: rec.revs.map((r) => ({ rev: r.rev, at: r.at, title: r.title, ext: r.ext })), via: meta.via || 'show', toolUseId: meta.toolUseId || null,
  };
}

/** The tools one pane's Claude Code gets (made once per pane, shared by its restarts). */
function toolsFor(p) {
  if (!p.tools) {
    // The browser tools only where the shell has a browser (not in tests or latch).
    const browser = shell.has('browser')
      ? createBrowserTools({ shell, owner: () => p.id, onActivity: (a) => emit({ ev: 'browserActivity', paneId: p.id, ...a }) })
      : null;
    p.tools = createApakiTools({
      store,
      sessionId: () => p.runner?.sessionId || p.sessionId || null,
      cwd: () => p.runner?.cwd || os.homedir(),
      onArtifact: (rec, meta) => emit(artifactEvent(p, rec, meta)),
      onOpenUrl: (o) => { openPage(p, o); },
      browser,
    });
  }
  return p.tools;
}

/**
 * A web page for a pane's user (show with kind url, a caught "start
 * https://...", BROWSER): into the pane's built-in browser when the shell has
 * one, and in any case an openUrl event so the conversation gets its card.
 */
async function openPage(p, o) {
  const base = { ev: 'openUrl', paneId: p.id, sessionId: p.runner?.sessionId || p.sessionId || null, url: o.url, title: o.title || null, reason: o.reason || 'show', toolUseId: o.toolUseId || null };
  if (shell.has('browser') && /^https?:\/\//i.test(o.url)) {
    try {
      const st = await shell.request('browser.open', { owner: p.id, url: o.url, hint: 'reuse', reason: o.reason || 'show' }, { timeout: 8000 });
      emit({ ...base, browserId: st.id });
      return;
    } catch (e) {
      process.stderr.write(`apaki: the built-in browser did not open ${o.url}: ${e.message}\n`);
    }
  }
  emit(base);
}

/** BROWSER and friends for a pane's Claude Code, so tools that open a browser open in Apaki. */
function browserEnv(p) {
  if (!openServer || process.platform !== 'win32' || !fs.existsSync(OPEN_SHIM)) return {};
  return { BROWSER: OPEN_SHIM, APAKI_OPEN_URL: openServer.openUrl, APAKI_OPEN_TOKEN: openServer.paneToken(p.id), APAKI_NODE: process.execPath };
}

/** A URL a pane's BROWSER shim handed over: local files become artifacts, pages go to the window. */
function openedByBrowser(paneId, url) {
  const p = panes.get(paneId);
  if (!p) return;
  if (/^file:\/\//i.test(url)) { toolsFor(p).show({ kind: 'file', path: url }, { via: 'BROWSER' }).catch(() => {}); return; }
  openPage(p, { url, title: null, reason: 'BROWSER', toolUseId: null });
}

/** An artifact the stdio tool server (apaki-mcp-stdio.mjs) stored for a pane: show it like an in-process one. */
function shownByStdio(paneId, { id, sessionId }) {
  const p = panes.get(paneId);
  const rec = p ? store.record(id, sessionId) : null;
  if (rec) emit(artifactEvent(p, rec, { via: 'show' }));
}

let openServer = null;
try { openServer = await startOpenServer({ store, onOpen: openedByBrowser, onShown: shownByStdio }); } catch (e) { process.stderr.write(`apaki: the localhost server did not start (${e.message}); artifacts show without the viewer\n`); }

/** Opens a web page, or a stored artifact's file, outside Apaki (the system browser or default app). */
function openOutside(target) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function getPane(paneId) {
  const id = String(paneId || 'main');
  let p = panes.get(id);
  if (!p) {
    p = { id, runner: null, sessionId: null, credential: defaults.credential, model: defaults.model, effort: defaults.effort, mode: defaults.mode };
    panes.set(id, p);
  }
  return p;
}

/* ---------- session list ---------- */

function compact(it, term, folderOf) {
  return {
    id: it.id, title: it.title, firstPrompt: it.firstPrompt || '', cwd: it.cwd || '', branch: it.branch || '',
    lastModified: it.lastModified || 0, size: it.size || 0, codex: Boolean(it.codex),
    terminal: term ? { name: term.name, status: term.status, pid: term.pid } : null,
    folder: folderOf.get(it.id)?.id || null,
  };
}

async function loadSessions() {
  const loader = makeLoader();
  const items = await loader(false);
  const term = terminalSessions();
  const byId = new Map(items.map((it) => [it.id, it]));
  const wanted = [...term.keys(), ...folders.listFolders().flatMap((f) => f.sessions)].filter((id) => !byId.has(id));
  if (wanted.length) {
    for (const it of await loader(true)) if (wanted.includes(it.id)) byId.set(it.id, it);
  }
  state.byId = byId;
  state.items = [...byId.values()];
  return term;
}

async function sessions(reqId) {
  const term = await loadSessions();
  const folderOf = folders.folderOfSessions();
  const list = state.items.map((it) => compact(it, term.get(it.id)?.[0], folderOf));
  // Open in a terminal right now, even before Claude Code wrote a transcript.
  for (const [id, recs] of term) {
    if (!state.byId.has(id)) list.push(compact({ id, title: `New session (${recs[0].name || 'terminal'})`, cwd: recs[0].cwd, lastModified: recs[0].updatedAt }, recs[0], folderOf));
  }
  emit({ ev: 'sessions', reqId, items: list, folders: folders.listFolders(), billing: billingInfo(), voice: voiceReady() });
}

async function search(reqId, query) {
  if (!state.items) await loadSessions();
  const folderOf = folders.folderOfSessions();
  const term = terminalSessions();
  const t0 = Date.now();
  const res = await searchHybrid(query, { limit: 80 });
  if (!res) {
    const quick = filterItems(state.items, query).map((it) => ({ item: compact(it, term.get(it.id)?.[0], folderOf), kind: null, snippet: '' }));
    emit({ ev: 'search', reqId, query, elapsed: Date.now() - t0, deep: false, results: quick });
    return;
  }
  const results = [];
  for (const hit of res.sessions) {
    let it = state.byId.get(hit.session);
    if (!it && isCodexId(hit.session)) it = codexItem(hit);
    if (!it) it = { id: hit.session, title: '(session hidden from the list)', cwd: '', lastModified: Date.parse(hit.latest || '') || 0 };
    results.push({ item: compact(it, term.get(it.id)?.[0], folderOf), kind: hit.kind, snippet: hit.snippet, hits: hit.hits, sources: hit.sources || ['words'] });
  }
  emit({ ev: 'search', reqId, query, elapsed: res.elapsed_ms, total: res.total_hits, deep: true, semantic: Boolean(res.semantic), terms: res.terms || null, results });
}

/** A list item for a session the list does not show (hidden headless, Codex). */
function itemFor(id, hit) {
  if (state.byId.get(id)) return state.byId.get(id);
  if (isCodexId(id) && hit) return codexItem(hit);
  return { id, title: '(session hidden from the list)', cwd: '', lastModified: Date.parse(hit?.latest || '') || 0 };
}

/**
 * Ask Claude (asksearch.js): billed to the focused pane's account, or to what
 * Glass has live when no pane is focused or the pane follows Glass.
 */
async function askSearchOp(reqId, query, paneId) {
  if (!state.items) await loadSessions();
  const p = paneId ? panes.get(String(paneId)) : null;
  const credential = !p || p.credential.follow ? glassCredential() : p.credential;
  const r = await askSearch({
    query,
    credential,
    items: state.byId,
    makeItem: itemFor,
    progress: (text) => emit({ ev: 'askProgress', reqId, query, text }),
  });
  if (r.error) { emit({ ev: 'askSearch', reqId, query, error: r.error }); return; }
  const folderOf = folders.folderOfSessions();
  const term = terminalSessions();
  const results = r.results.map(({ id, why, hit }) => ({ item: compact(itemFor(id, hit), term.get(id)?.[0], folderOf), why, kind: hit?.kind || null, snippet: hit?.snippet || '' }));
  emit({ ev: 'askSearch', reqId, query, results, terms: r.terms, considered: r.considered, model: r.model, billing: credential.name, cost: r.cost, ms: r.ms, note: r.note });
}

function digPromptOp(reqId, query, candidateIds = []) {
  const candidates = candidateIds.map((id) => state.byId.get(id)).filter(Boolean).map((it) => ({ id: it.id, title: it.title, cwd: it.cwd }));
  emit({ ev: 'digReady', reqId, query, prompt: digPrompt(query, candidates) });
}

/* ---------- history ---------- */

function cut(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t;
}

/** The saved conversation, trimmed for display: tool output cut, images kept as markers. */
function compactMessages(msgs) {
  return msgs.slice(-HISTORY_MESSAGES).map((m) => {
    const content = m.message?.content;
    let c = content;
    if (Array.isArray(content)) {
      c = content.map((b) => {
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : String(b.content ?? '');
          return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: Boolean(b.is_error), content: cut(text, RESULT_CHARS) };
        }
        if (b.type === 'image') return { type: 'image_marker' };
        if (b.type === 'thinking' || b.type === 'redacted_thinking') return { type: 'thinking' };
        return b;
      });
    }
    return { type: m.type, uuid: m.uuid, parent_tool_use_id: m.parent_tool_use_id || null, message: { role: m.message?.role, content: c, model: m.message?.model } };
  });
}

/* ---------- the open conversations (one per pane) ---------- */

function billingInfo(p) {
  const c = p ? p.credential : defaults.credential;
  return { name: c.name, source: c.source, follow: Boolean(c.follow) };
}

async function closeRunner(p) {
  const r = p.runner;
  p.runner = null;
  if (!r) return;
  await r.stop();
  if (p.sessionId) releaseLock(p.sessionId);
}

/** The other pane that already has this session open, if any. */
function paneWith(sessionId, exceptId) {
  for (const p of panes.values()) if (p.id !== exceptId && p.sessionId && p.sessionId === sessionId) return p;
  return null;
}

/**
 * Opens a session (or a new conversation) in a pane. warm=false defers
 * starting Claude Code to the first message, so restoring six panes at launch
 * does not start six processes.
 */
async function open(reqId, paneId, sessionId, cwd, opts = {}) {
  const p = getPane(paneId);
  if (isCodexId(sessionId)) { emit({ ev: 'note', reqId, paneId: p.id, tone: 'warn', text: codexResumeHint(sessionId) }); return; }
  const other = sessionId ? paneWith(sessionId, p.id) : null;
  if (other) { emit({ ev: 'open_elsewhere', reqId, paneId: p.id, sessionId, otherPane: other.id }); return; }
  await closeRunner(p);
  if (opts.model) p.model = opts.model;
  if (opts.effort) p.effort = opts.effort;
  if (opts.mode) p.mode = opts.mode;
  let info = null;
  if (sessionId) {
    // Held by a live latch or another Apaki: the pane offers "Take over here",
    // which comes back as open with force. The old holder is stopped before it
    // writes again (runner.lockGuard there, the relay hook in terminal windows).
    const holder = takeLock(sessionId, { force: Boolean(opts.force) });
    if (holder) {
      info = await getSessionInfo(sessionId).catch(() => null);
      emit({ ev: 'locked', reqId, paneId: p.id, sessionId, holder: lockInfo(sessionId), title: info?.customTitle || info?.summary || null, cwd: cwd || info?.cwd || '' });
      return;
    }
    info = await getSessionInfo(sessionId).catch(() => null);
  }
  p.sessionId = sessionId || null;
  p.credential = p.credential.follow ? glassCredential() : p.credential;
  const tools = toolsFor(p);
  const runner = new SessionRunner({
    sessionId: sessionId || null,
    cwd: cwd || info?.cwd || os.homedir(),
    env: childEnv(p.credential.key),
    // Apaki's own tools and "open this" catcher, passed at runtime only.
    mcpServers: tools.mcpServers,
    appendSystemPrompt: tools.appendSystemPrompt,
    hooks: tools.hooks,
    envExtra: browserEnv(p),
    model: p.model,
    effort: p.effort,
    permissionMode: p.mode,
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    onMessage: (msg) => emit({ ev: 'sdk', paneId: p.id, sessionId: p.sessionId, msg }),
    onStderr: (d) => process.stderr.write(String(d).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')),
  });
  // Questions and plan approval go to the window and wait for its answer.
  runner.onInteractiveTool = (toolName, input) => new Promise((resolve) => {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.asks.set(id, { resolve, paneId: p.id });
    emit({ ev: 'ask', askId: id, paneId: p.id, toolName, input });
  });
  runner.onNewSession = (id) => {
    rememberCreated(id);
    p.sessionId = id;
    takeLock(id, { force: true });
    emit({ ev: 'session_id', paneId: p.id, sessionId: id });
  };
  // Follow Myrlin Glass before every message (see SessionRunner.send).
  runner.authKey = p.credential.key ?? null;
  runner.authCheck = p.credential.follow ? () => { const c = glassCredential(); return { ...c, env: childEnv(c.key) }; } : null;
  runner.onAuthChange = (next) => {
    // The Glass watcher below usually announced this swap already.
    const announced = (p.credential.key ?? null) === (next.key ?? null);
    p.credential = { ...next, follow: true };
    emit({ ev: 'billing', paneId: p.id, ...billingInfo(p), note: announced ? undefined : `Myrlin Glass switched Claude to ${next.name}; this conversation continues on it.` });
  };
  // Taken over by another window since: stop instead of forking the conversation.
  runner.lockGuard = () => (p.sessionId ? lockStolen(p.sessionId) : null);
  p.runner = runner;
  emit({ ev: 'opened', tookOver: Boolean(opts.force),  reqId, paneId: p.id, sessionId: p.sessionId, cwd: runner.cwd, title: info?.customTitle || info?.summary || 'New conversation', model: p.model, effort: p.effort, mode: p.mode, billing: billingInfo(p), terminal: sessionId ? terminalSessions().get(sessionId) || [] : [] });
  if (opts.warm !== false) runner.start();
  if (sessionId) {
    const msgs = await getSessionMessages(sessionId).catch(() => []);
    emit({ ev: 'history', paneId: p.id, sessionId, messages: compactMessages(msgs), total: msgs.length });
  }
}

async function send(reqId, paneId, text, images = []) {
  const p = getPane(paneId);
  if (!p.runner && p.sessionId) {
    // This pane lost its session to a takeover: never start a new one in its place.
    const holder = lockStolen(p.sessionId);
    if (holder) { emit({ ev: 'taken_over', reqId, paneId: p.id, sessionId: p.sessionId, holder }); return; }
    await open(null, p.id, p.sessionId, null, {});
    if (!p.runner) return;
  }
  if (!p.runner) await open(null, p.id, null, null);
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(text ? [{ type: 'text', text }] : [])]
    : text;
  try {
    const r = await p.runner.send(content);
    emit({ ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: r.subtype, isError: Boolean(r.is_error), durationMs: r.duration_ms, usage: r.usage, cost: r.latchTurnCost ?? null, errors: r.errors || null, result: typeof r.result === 'string' ? r.result.slice(0, 2000) : null });
  } catch (e) {
    if (e.code === 'TAKEN_OVER') {
      // Stop this pane's process; the lock is the other window's now.
      const r = p.runner;
      p.runner = null;
      await r?.stop();
      emit({ ev: 'taken_over', reqId, paneId: p.id, sessionId: p.sessionId, holder: e.holder });
      return;
    }
    emit({ ev: 'error', reqId, paneId: p.id, message: e.message || String(e) });
  }
}

/** Closes a pane: its Claude Code process stops and its session lock is freed. */
async function closePane(reqId, paneId) {
  const p = panes.get(String(paneId));
  if (!p) return;
  for (const [id, a] of state.asks) if (a.paneId === p.id) { state.asks.delete(id); a.resolve({ behavior: 'deny', message: 'The pane was closed.' }); }
  await closeRunner(p);
  openServer?.forget(p.id);
  panes.delete(p.id);
  emit({ ev: 'closed', reqId, paneId: p.id });
}

/* ---------- voice (local Whisper) ---------- */

// whisper.cpp (CPU build) and a free English model, installed next to the app
// (Arthur, 2026-10-09: "local whisper model - something free"). Nothing leaves
// the PC: the window records 16 kHz WAV, this transcribes it.
const VOICE_DIR = process.env.APAKI_VOICE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Myrlin Apaki', 'voice');
const WHISPER = path.join(VOICE_DIR, 'bin', 'Release', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
const WHISPER_MODEL = process.env.APAKI_WHISPER_MODEL || path.join(VOICE_DIR, 'models', 'ggml-base.en.bin');
const voiceReady = () => fs.existsSync(WHISPER) && fs.existsSync(WHISPER_MODEL);
const VOICE_VOCAB = process.env.APAKI_VOICE_VOCAB || 'Myrlin, Myrlin Glass, Myrlin Apaki, Myrlin Forge, Myrlin Jobs, Claude, Claude Code, Codex, Opus, Sonnet, Haiku, Fable, SignalSentry, Pantex, Hytale, Tauri, latch.';

function transcribe(reqId, wavBase64, paneId = null) {
  if (!voiceReady()) { emit({ ev: 'error', reqId, paneId, message: `Voice is not installed (${WHISPER}).` }); return Promise.resolve(); }
  const file = path.join(os.tmpdir(), `apaki-voice-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, Buffer.from(String(wavBase64 || ''), 'base64'));
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    // The vocabulary prompt keeps names Whisper does not know spelled right.
    const child = spawn(WHISPER, ['-m', WHISPER_MODEL, '-f', file, '-nt', '-np', '-l', 'en', '-t', String(Math.min(8, os.cpus().length)), '--prompt', VOICE_VOCAB], { windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { emit({ ev: 'error', reqId, paneId, message: `Whisper failed: ${e.message}` }); });
    child.on('close', () => {
      fs.rm(file, { force: true }, () => {});
      // "Myrlin" sounds exactly like "Merlin"; in Arthur's work it is always Myrlin.
      const text = out.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '').replace(/\s+/g, ' ').trim().replace(/\bMerlin\b/g, 'Myrlin');
      emit({ ev: 'transcript', reqId, paneId, text, ms: Date.now() - t0 });
      resolve();
    });
  });
}

/* ---------- command loop ---------- */

const handlers = {
  // From the Apaki shell, not the window: its hello, and answers to our requests (shell-channel.js).
  shellHello: (c) => shell.hello(c),
  shellReply: (c) => { shell.reply(c); },
  // One of Claude's browser tools, run for a pane without a model turn (checks; later the phone).
  browserTool: async (c) => {
    const p = getPane(c.paneId);
    const b = toolsFor(p).browser;
    const r = b ? await b.call(String(c.tool || ''), c.input || {}) : { ok: false, text: 'This window has no built-in browser.' };
    emit({ ev: 'browserToolResult', reqId: c.reqId, paneId: p.id, tool: c.tool, ok: r.ok, text: r.text, image: r.image || null, width: r.width || null, height: r.height || null });
  },
  transcribe: (c) => transcribe(c.reqId, c.wav, c.paneId || null),
  sessions: (c) => sessions(c.reqId),
  search: (c) => search(c.reqId, String(c.query || '')),
  askSearch: (c) => askSearchOp(c.reqId, String(c.query || ''), c.paneId || null),
  digPrompt: (c) => digPromptOp(c.reqId, String(c.query || ''), Array.isArray(c.candidates) ? c.candidates : []),
  open: (c) => open(c.reqId, c.paneId, c.sessionId || null, c.cwd || null, { warm: c.warm, model: c.model, effort: c.effort, mode: c.mode, force: c.force }),
  send: (c) => send(c.reqId, c.paneId, String(c.text || ''), Array.isArray(c.images) ? c.images : []),
  close: (c) => closePane(c.reqId, c.paneId),
  interrupt: (c) => getPane(c.paneId).runner?.interrupt(),
  answer: (c) => { const a = state.asks.get(c.askId); state.asks.delete(c.askId); a?.resolve(c.result || null); },
  model: async (c) => {
    const p = getPane(c.paneId);
    p.model = c.model; defaults.model = c.model;
    await p.runner?.setModel(c.model);
    emit({ ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode });
  },
  mode: async (c) => {
    const p = getPane(c.paneId);
    p.mode = c.mode; defaults.mode = c.mode;
    await p.runner?.setPermissionMode(c.mode);
    emit({ ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode });
  },
  effort: async (c) => {
    const p = getPane(c.paneId);
    p.effort = c.effort; defaults.effort = c.effort;
    if (p.runner?.running) await p.runner.restart({ effort: c.effort });
    else if (p.runner) p.runner.effort = c.effort;
    emit({ ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode });
  },
  billing: async (c) => {
    const p = getPane(c.paneId);
    const v = String(c.value || 'glass');
    const next = chooseCredential(v === 'sub' ? { subscription: true } : v === 'glass' ? {} : { keyWords: v });
    if (next.error) { emit({ ev: 'error', reqId: c.reqId, paneId: p.id, message: next.error }); return; }
    p.credential = next;
    defaults.credential = next;
    if (p.runner) {
      p.runner.authKey = next.key ?? null;
      p.runner.authCheck = next.follow ? () => { const g = glassCredential(); return { ...g, env: childEnv(g.key) }; } : null;
      if (p.runner.running) await p.runner.restart({ env: childEnv(next.key) });
      else p.runner.env = childEnv(next.key);
    }
    emit({ ev: 'billing', paneId: p.id, ...billingInfo(p) });
  },
  billingOptions: (c) => emit({
    ev: 'billingOptions', reqId: c.reqId, paneId: c.paneId || null,
    options: [
      { label: 'Follow Myrlin Glass', value: 'glass' },
      { label: 'Subscription (live login)', value: 'sub' },
      ...keySections().map((s) => { const label = s.heading.replace(/\s+-\s+added\s+\S+\s*$/i, '').replace(/^Anthropic API Key\s*\((.*)\)$/i, '$1'); return { label, value: label }; }),
    ],
  }),
  // Commands come from a running Claude Code process. A pane that has not
  // started yet (restored, waiting for its first message) gets the list last
  // seen for its folder instead of starting a process just for the menu.
  commands: async (c) => {
    const p = getPane(c.paneId);
    const shape = (list) => list.map((x) => ({ name: x.name, description: x.description || '', argumentHint: x.argumentHint || '' }));
    if (!p.runner) { emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: [] }); return; }
    if (!p.runner.running) {
      const cached = state.commandsByCwd.get(p.runner.cwd) || [...state.commandsByCwd.values()][0] || [];
      emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: cached, cached: true });
      return;
    }
    const list = shape(await p.runner.supportedCommands().catch(() => []));
    if (list.length) state.commandsByCwd.set(p.runner.cwd, list);
    emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: list });
  },
  // One artifact revision for the viewer and (later) the phone: its record, a
  // served address, and the content unless content:false (the viewer loads
  // html, images and pdf from src and only needs the text of markdown and code).
  artifactGet: (c) => {
    const got = store.get(c.id, { sessionId: c.sessionId || null, rev: c.rev ?? null });
    if (!got) { emit({ ev: 'artifactContent', reqId: c.reqId, paneId: c.paneId || null, id: c.id, sessionId: c.sessionId || null, error: 'This artifact is no longer on this PC.' }); return; }
    const rec = got.record;
    const kind = got.rev === rec.rev ? rec.kind : kindOfExt(got.ext);
    const binary = kind === 'image' || kind === 'pdf';
    // content: 'text' = only when it is text (the viewer); false = never; default = always (the phone).
    const want = c.content === 'text' ? !binary : c.content !== false;
    emit({
      ev: 'artifactContent', reqId: c.reqId, paneId: c.paneId || null, id: rec.id, sessionId: rec.sessionId, title: (rec.revs.find((r) => r.rev === got.rev) || rec).title,
      kind, ext: got.ext, mime: got.mime, rev: got.rev, latest: rec.rev, size: got.buf.length, src: srcOf(rec, got.rev), path: got.file, source: rec.source,
      revs: rec.revs.map((r) => ({ rev: r.rev, at: r.at, title: r.title, ext: r.ext })),
      ...(want ? { encoding: binary ? 'base64' : 'utf8', content: binary ? got.buf.toString('base64') : got.buf.toString('utf8') } : {}),
    });
  },
  artifactList: (c) => emit({
    ev: 'artifacts', reqId: c.reqId, sessionId: c.sessionId || null,
    items: c.sessionId ? store.list(c.sessionId).map((r) => ({ id: r.id, title: r.title, kind: r.kind, rev: r.rev, ext: r.ext, size: r.size, updatedAt: r.updatedAt, src: srcOf(r) })) : [],
  }),
  openExternal: (c) => {
    if (c.url) {
      if (!/^https?:\/\/[^\s"'<>]+$/i.test(String(c.url))) { emit({ ev: 'error', reqId: c.reqId, paneId: c.paneId || null, message: `Not a web address: ${c.url}` }); return; }
      openOutside(String(c.url));
      return;
    }
    const got = c.id ? store.get(c.id, { sessionId: c.sessionId || null, rev: c.rev ?? null }) : null;
    if (got) openOutside(got.file);
  },
  folder: async (c) => {
    if (c.action === 'create') { const f = folders.createFolder(c.name); if (!f.error && c.sessionId) folders.moveToFolder(c.sessionId, f.id); }
    if (c.action === 'move') folders.moveToFolder(c.sessionId, c.folderId || null);
    if (c.action === 'rename') folders.renameFolder(c.folderId, c.name);
    if (c.action === 'delete') folders.deleteFolder(c.folderId);
    emit({ ev: 'folders', folders: folders.listFolders() });
  },
};

const SERIAL_OPS = new Set(['open', 'send', 'close', 'model', 'mode', 'effort', 'billing']);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let c;
  try { c = JSON.parse(line); } catch { return; }
  const h = handlers[c.op];
  if (!h) { emit({ ev: 'error', reqId: c.reqId, message: `unknown op ${c.op}` }); return; }
  const run = async () => { try { await h(c); } catch (e) { emit({ ev: 'error', reqId: c.reqId, paneId: c.paneId, message: e.message || String(e) }); } };
  // A pane's opens, sends, closes and setting changes run one after another.
  // Without this, a message sent while the pane was still switching
  // conversations started a second runner and its turn landed in a new
  // session (found in the 2026-10-09 smoke test). interrupt and answer must
  // not wait: the running turn is what they act on.
  if (c.paneId && SERIAL_OPS.has(c.op)) {
    const p = getPane(c.paneId);
    p.queue = (p.queue || Promise.resolve()).then(run);
    return;
  }
  await run();
});
rl.on('close', async () => {
  fs.unwatchFile(LIVE_LOGIN); await Promise.all([...panes.values()].map((p) => closeRunner(p))); process.exit(0); });

/* ---------- Myrlin Glass, live ---------- */

// Apaki follows Glass as it happens (Arthur, 2026-10-09: "meant to integrate
// with and dynamically respond to choices made in myrlin glass"). Glass swaps
// Claude Code's login by rewriting ~/.claude/.credentials.json; the engine
// watches that file, and on a change every pane that follows Glass shows its
// new billing at once (its runner restarts on the new login with its next
// message, see SessionRunner.send). The account's label and plan come from
// `glass status`, asynchronously, so the engine never waits on Glass.
const LIVE_LOGIN = process.env.LATCH_LIVE_LOGIN_FILE || path.join(CLAUDE_DIR, '.credentials.json');
const GLASS_CLI = process.env.LATCH_GLASS_CLI || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Myrlin Glass', 'glass.exe');
let glassSeen = null;

function glassActive() {
  return new Promise((resolve) => {
    if (!fs.existsSync(GLASS_CLI)) { resolve(null); return; }
    execFile(GLASS_CLI, ['status', '--provider', 'claude', '--json'], { timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const live = (JSON.parse(stdout).accounts || []).find((a) => a.provider === 'claude' && a.active);
        resolve(live ? { label: live.label || live.email || '', plan: live.plan || '', headroom: live.headroom ?? null } : null);
      } catch { resolve(null); }
    });
  });
}

async function glassChanged() {
  const c = glassCredential();
  const id = `${c.source}:${c.key ? c.key.slice(-12) : ''}`;
  const account = await glassActive();
  const name = c.key ? c.name : account?.label ? `${account.label} (${account.plan || 'subscription'})` : c.name;
  const changed = glassSeen !== null && glassSeen !== id;
  glassSeen = id;
  const next = { ...c, name };
  if (defaults.credential.follow) defaults.credential = next;
  for (const p of panes.values()) {
    if (!p.credential.follow) continue;
    const moved = (p.credential.key ?? null) !== (next.key ?? null);
    p.credential = next;
    if (changed || moved) emit({ ev: 'billing', paneId: p.id, ...billingInfo(p), note: moved ? `Myrlin Glass switched Claude to ${name}; the next message here uses it.` : undefined });
  }
  emit({ ev: 'glass', installed: fs.existsSync(GLASS_CLI), name, source: c.source, plan: account?.plan || null, headroom: account?.headroom ?? null, changed });
}

fs.watchFile(LIVE_LOGIN, { interval: 1500 }, () => { glassChanged().catch(() => {}); });
glassChanged().catch(() => {});

emit({ ev: 'ready', billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: voiceReady(), artifacts: Boolean(openServer) });
// Keep the conversation indexes current in the background. The index server
// (latch-index serve) holds the keyword index, the meaning index and the
// embedding model open for searches, and updates both: keyword first (under a
// second), then meaning (the first build takes a few minutes on the GPU).
const UPDATE_EVERY_MS = 3 * 60 * 1000;
let indexStarted = Date.now();
const indexServer = startIndexServer({
  onEvent: (j) => {
    if (j.ev === 'keyword') emit({ ev: 'index', ok: Boolean(j.result?.ok), ms: Date.now() - indexStarted, stats: j.result });
    if (j.ev === 'semantic') emit({ ev: 'meaning', stage: j.stage, done: j.done ?? null, total: j.total ?? null, device: j.device || j.result?.device || null, result: j.result || null });
  },
});
async function refreshIndexes() {
  indexStarted = Date.now();
  if (indexServer && (await updateViaServer())) return;
  const r = await updateIndex();
  emit({ ev: 'index', ok: Boolean(r), ms: Date.now() - indexStarted, stats: r });
}
refreshIndexes();
setInterval(() => { refreshIndexes().catch(() => {}); }, UPDATE_EVERY_MS).unref();
