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
 * Phones (Track B, 2026-10-09; remote.js): with phone access on, paired
 * phones send the same commands through the relay, checked against an
 * allowlist (remote-policy.js). Their panes are phone:<deviceId>:<name>, and
 * events about them (and answers to their requests) go to that phone instead
 * of the window. A session open on the desktop and on a phone gets the same
 * "Session in use" card and takeover as one held by another app. Desktop ops:
 * remoteStatus, remoteEnable, remoteDisable, remotePairStart,
 * remotePairCancel, remotePairDecision, remoteDevices, remoteRevoke (ev
 * remote). attach re-sends a pane's state without restarting it (a phone that
 * reconnected).
 * Artifacts (2026-10-09, Arthur: like Codex's built-in artifacts, out of the
 * box): every pane's Claude Code gets Apaki's tools at runtime, through SDK
 * options only (apaki-tools.js): the in-process MCP server "apaki" with its
 * show tool, a short appended system prompt, PreToolUse/PostToolUse hooks that
 * turn "open this" shell commands into artifacts, and BROWSER pointing at
 * apaki/bin/apaki-open.cmd with a per-pane token for this engine's localhost
 * server (open-server.js), which also serves artifacts to the viewer.
 *   ev artifact  { paneId, sessionId, id, title, kind, rev, path, src, ext, mime, size, source, revs, via, toolUseId }
 *   ev openUrl   { paneId, sessionId, url, reason, title, toolUseId }  (a web page to open; the
 *                built-in browser takes these over later, for now the window shows a link card)
 *   op artifactGet { id, sessionId?, rev?, content? } -> ev artifactContent (meta, src, and the
 *                content: utf8 for html/markdown/svg/text, base64 for image/pdf)
 *   op artifactList { sessionId } -> ev artifacts { sessionId, items }
 *   op openExternal { url } or { id, sessionId?, rev? } -> the system browser / default app
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getSessionInfo, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { ArtifactStore, kindOfExt } from './artifacts.js';
import { createApakiTools } from './apaki-tools.js';
import { startOpenServer } from './open-server.js';
import { CLAUDE_DIR, chooseCredential, childEnv, glassCredential, keySections } from '../../src/auth.js';
import { codexItem, codexResumeHint, isCodexId } from '../../src/codex.js';
import { searchHybrid, startIndexServer, updateIndex, updateViaServer } from '../../src/deepindex.js';
import { askSearch, digPrompt } from './asksearch.js';
import * as folders from '../../src/folders.js';
import { filterItems, terminalSessions, transcriptMap } from '../../src/picker.js';
import { bareItem, startLive } from './live.js';
import { agentByToolUse, countSubagents, listShells, listSubagents, readEntries, readText, RUNNING_MS, watchFile } from './tasks.js';
import { SessionRunner } from '../../src/runner.js';
import { listSessions, lockInfo, lockStolen, readTail, releaseLock, rememberCreated, setLockApp, takeLock } from '../../src/sessions.js';
import { makeLoader } from '../../src/ui/picker.js';
import { noteRunnerUse, setOn as setWarm, statusText as warmStatus, summary as warmSummary, warmSessions } from '../../src/warm.js';
import { folderStats, listDir, makeDir } from '../../src/places.js';
import { createRemote } from './remote.js';
import { parsePhoneId, windowOf } from './remote-policy.js';

// Locks this engine takes name it, so a blocked terminal window can say who has the session.
setLockApp('apaki');

// stdout is the event channel: nothing else may print there.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const DEFAULT_MODEL = process.env.APAKI_MODEL || 'claude-opus-5-5';
const DEFAULT_EFFORT = process.env.APAKI_EFFORT || 'xhigh';
const HISTORY_MESSAGES = 400;
const RESULT_CHARS = 4000;

/** Phone access (remote.js), created once the command handlers exist. */
let remote = null;

function emit(ev) {
  // Events for a phone's panes and requests go to that phone only.
  if (remote && remote.route(ev)) return;
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}

// Session list shared by every pane.
const state = {
  asks: new Map(), // askId -> { resolve, paneId }
  items: null,
  byId: new Map(),
  commandsByCwd: new Map(),
  warm: new Set(), // sessions keep-warm is looking after (src/warm.js warmSessions)
  renames: new Map(), // sessionId -> title, written once that session's turn in a pane ends
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
    p.tools = createApakiTools({
      store,
      sessionId: () => p.runner?.sessionId || p.sessionId || null,
      cwd: () => p.runner?.cwd || os.homedir(),
      onArtifact: (rec, meta) => emit(artifactEvent(p, rec, meta)),
      onOpenUrl: (o) => emit({ ev: 'openUrl', paneId: p.id, sessionId: p.runner?.sessionId || p.sessionId || null, url: o.url, title: o.title || null, reason: o.reason || 'show', toolUseId: o.toolUseId || null }),
    });
  }
  return p.tools;
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
  emit({ ev: 'openUrl', paneId: p.id, sessionId: p.runner?.sessionId || p.sessionId || null, url, title: null, reason: 'BROWSER', toolUseId: null });
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
    // Started headless and never typed in (claude -p, workers, relayed-only windows); shown, and marked.
    headless: Boolean(it.headless), bare: Boolean(it.bare), warm: state.warm.has(it.id),
    subagents: subagentCount(it.id),
  };
}

/** How many subagents a session has had (tasks.js; files under <session>/subagents). */
function subagentCount(id) {
  const file = state.files?.get(id);
  if (!file) return 0;
  try { return countSubagents(file); } catch { return 0; }
}

/**
 * Every Claude Code session on this PC (Arthur, 2026-10-09: "we CANNOT miss
 * anything"). The SDK's default list leaves out sessions that started
 * headless; latch's picker adds back the ones with typed turns, but a window
 * that had relay on from its first message sends every turn through
 * claude -p, so its session looked like automation and was hidden. Now the
 * headless ones are listed too, marked headless, and so is any transcript the
 * SDK's list skips (no prompt yet).
 */
async function loadSessions() {
  const memo = new Map();
  const loadInfos = (programmatic) => {
    if (!memo.has(programmatic)) memo.set(programmatic, listSessions({ limit: 5000, includeProgrammatic: programmatic }));
    return memo.get(programmatic);
  };
  const loader = makeLoader({ loadInfos });
  const items = await loader(false);
  const shown = new Set(items.map((it) => it.id));
  const term = terminalSessions();
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const it of await loader(true)) if (!byId.has(it.id)) byId.set(it.id, shown.has(it.id) ? it : { ...it, headless: true });
  for (const [id, file] of transcriptMap()) {
    if (byId.has(id)) continue;
    const it = bareItem(id, file);
    if (it) byId.set(id, it);
  }
  state.byId = byId;
  state.items = [...byId.values()].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  state.files = transcriptMap();
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
/**
 * When each message was written, by uuid, from the transcript itself (the
 * SDK's messages carry no time). Reads the end of the file, more of it until
 * every wanted uuid is found or the whole file is read.
 */
function timestampsOf(sessionId, uuids) {
  const want = new Set(uuids.filter(Boolean));
  const out = new Map();
  const file = sessionId ? transcriptMap().get(sessionId) : null;
  if (!file || !want.size) return out;
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return out; }
  for (let bytes = 4 * 1024 * 1024; ; bytes *= 4) {
    const text = readTail(file, bytes);
    for (const m of text.matchAll(/"uuid":"([0-9a-f-]{36})","timestamp":"([^"]+)"|"timestamp":"([^"]+)"[^\n]*?"uuid":"([0-9a-f-]{36})"/g)) {
      const id = m[1] || m[4];
      const at = m[2] || m[3];
      if (want.has(id) && !out.has(id)) out.set(id, at);
    }
    if (out.size >= want.size || bytes >= size) break;
  }
  return out;
}

function compactMessages(msgs, sessionId = null) {
  const last = msgs.slice(-HISTORY_MESSAGES);
  const at = timestampsOf(sessionId, last.map((m) => m.uuid));
  return last.map((m) => {
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
    return { type: m.type, uuid: m.uuid, at: at.get(m.uuid) || null, parent_tool_use_id: m.parent_tool_use_id || null, message: { role: m.message?.role, content: c, model: m.message?.model } };
  });
}

/* ---------- the open conversations (one per pane) ---------- */

function billingInfo(p) {
  const c = p ? p.credential : defaults.credential;
  return { name: c.name, source: c.source, follow: Boolean(c.follow), isKey: Boolean(c.key) };
}

async function closeRunner(p) {
  const r = p.runner;
  p.runner = null;
  if (!r) return;
  await r.stop();
  if (p.sessionId) releaseLock(p.sessionId);
}

/**
 * The other pane that already has this session open, if any. A pane whose
 * session was taken from it (no runner, a "Taken over" card) no longer counts.
 */
function paneWith(sessionId, exceptId) {
  for (const p of panes.values()) if (p.id !== exceptId && p.runner && p.sessionId && p.sessionId === sessionId) return p;
  return null;
}

/**
 * Who holds a session in another window of this engine (the desktop window or
 * a phone), in the shape lockInfo gives for other apps, for the pane's
 * "Session in use" and "Taken over" cards.
 */
function holderOf(p) {
  const phone = remote?.windowName(p.id) || null;
  return { name: phone ? `${phone} (phone)` : 'Apaki on this PC', app: phone ? 'apaki-phone' : 'apaki', at: p.openedAt || new Date().toISOString(), alive: true };
}

/**
 * A pane in another window of this engine had the session: stop it there
 * (its running turn is interrupted) and tell that window, so the
 * conversation continues only in the pane that took it.
 */
async function takeFrom(other, taker) {
  for (const [id, a] of state.asks) if (a.paneId === other.id) { state.asks.delete(id); a.resolve({ behavior: 'deny', message: 'The session was taken over in another window.' }); }
  const r = other.runner;
  other.runner = null;
  other.busy = false;
  if (r) {
    if (r.running) await r.interrupt();
    await r.stop();
  }
  emit({ ev: 'taken_over', paneId: other.id, sessionId: other.sessionId, holder: holderOf(taker) });
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
  if (other && windowOf(other.id) === windowOf(p.id)) { emit({ ev: 'open_elsewhere', reqId, paneId: p.id, sessionId, otherPane: other.id }); return; }
  if (other && !opts.force) {
    // Open in the other window of this engine (the desktop and a phone): the
    // same card as a session held by another app, with Take over here.
    const held = await getSessionInfo(sessionId).catch(() => null);
    emit({ ev: 'locked', reqId, paneId: p.id, sessionId, holder: holderOf(other), title: held?.customTitle || held?.summary || null, cwd: cwd || held?.cwd || '' });
    return;
  }
  if (other) await takeFrom(other, p);
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
  p.openedAt = new Date().toISOString();
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
    // toolName and input are kept so attach can ask a reconnected window again.
    state.asks.set(id, { resolve, paneId: p.id, toolName, input });
    emit({ ev: 'ask', askId: id, paneId: p.id, toolName, input });
  });
  // A one-line "what it is doing" for running subagents (task_progress summary;
  // a short fork every ~30 s on the subagent's own cache).
  runner.progressSummaries = true;
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
    emit({ ev: 'history', paneId: p.id, sessionId, messages: compactMessages(msgs, sessionId), total: msgs.length });
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
    p.busy = true;
    const r = await p.runner.send(content);
    p.busy = false;
    emit({ ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: r.subtype, isError: Boolean(r.is_error), durationMs: r.duration_ms, usage: r.usage, cost: r.latchTurnCost ?? null, errors: r.errors || null, result: typeof r.result === 'string' ? r.result.slice(0, 2000) : null });
    if (p.sessionId && state.renames.has(p.sessionId)) applyRename(p.sessionId, state.renames.get(p.sessionId), { paneId: p.id }).catch(() => {});
  } catch (e) {
    p.busy = false;
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

/**
 * A window reconnected (the phone client after a network change or a page
 * reload): sends the pane's state again, and any question still waiting for
 * it, without restarting its Claude Code process, so a running turn keeps
 * running. A pane the engine no longer has (or holds another session) is
 * opened as usual, without starting Claude Code until its next message.
 */
async function attach(reqId, paneId, sessionId, cwd) {
  const p = panes.get(String(paneId));
  if (!p || !p.runner || (p.sessionId || null) !== (sessionId || null)) { await open(reqId, paneId, sessionId, cwd, { warm: false }); return; }
  const info = p.sessionId ? await getSessionInfo(p.sessionId).catch(() => null) : null;
  emit({ ev: 'opened', attached: true, busy: Boolean(p.busy), reqId, paneId: p.id, sessionId: p.sessionId, cwd: p.runner.cwd, title: info?.customTitle || info?.summary || 'New conversation', model: p.model, effort: p.effort, mode: p.mode, billing: billingInfo(p), terminal: p.sessionId ? terminalSessions().get(p.sessionId) || [] : [] });
  if (p.sessionId) {
    const msgs = await getSessionMessages(p.sessionId).catch(() => []);
    emit({ ev: 'history', paneId: p.id, sessionId: p.sessionId, messages: compactMessages(msgs, p.sessionId), total: msgs.length });
  }
  for (const [askId, a] of state.asks) if (a.paneId === p.id) emit({ ev: 'ask', askId, paneId: p.id, toolName: a.toolName, input: a.input });
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
  transcribe: (c) => transcribe(c.reqId, c.wav, c.paneId || null),
  sessions: (c) => sessions(c.reqId),
  search: (c) => search(c.reqId, String(c.query || '')),
  askSearch: (c) => askSearchOp(c.reqId, String(c.query || ''), c.paneId || null),
  digPrompt: (c) => digPromptOp(c.reqId, String(c.query || ''), Array.isArray(c.candidates) ? c.candidates : []),
  open: (c) => open(c.reqId, c.paneId, c.sessionId || null, c.cwd || null, { warm: c.warm, model: c.model, effort: c.effort, mode: c.mode, force: c.force }),
  attach: (c) => attach(c.reqId, c.paneId, c.sessionId || null, c.cwd || null),
  send: (c) => send(c.reqId, c.paneId, String(c.text || ''), Array.isArray(c.images) ? c.images : []),
  close: (c) => closePane(c.reqId, c.paneId),
  interrupt: (c) => getPane(c.paneId).runner?.interrupt(),
  // Steer: add a message to the running turn without stopping it (Claude
  // Code takes it in at its next step). If the turn already ended, it goes
  // out as a normal message instead.
  steer: async (c) => {
    const p = getPane(c.paneId);
    const images = Array.isArray(c.images) ? c.images : [];
    const text = String(c.text || '');
    const content = images.length
      ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(text ? [{ type: 'text', text }] : [])]
      : text;
    if (p.runner?.steer(content)) { emit({ ev: 'steered', reqId: c.reqId, paneId: p.id, qid: c.qid }); return; }
    emit({ ev: 'steer_missed', reqId: c.reqId, paneId: p.id, qid: c.qid });
  },
  answer: (c) => { const a = state.asks.get(c.askId); state.asks.delete(c.askId); a?.resolve(c.result || null); },
  model: async (c) => {
    const p = getPane(c.paneId);
    p.model = c.model; if (!parsePhoneId(p.id)) defaults.model = c.model;
    await p.runner?.setModel(c.model);
    emit({ ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode });
  },
  mode: async (c) => {
    const p = getPane(c.paneId);
    p.mode = c.mode; if (!parsePhoneId(p.id)) defaults.mode = c.mode;
    await p.runner?.setPermissionMode(c.mode);
    emit({ ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode });
  },
  effort: async (c) => {
    const p = getPane(c.paneId);
    p.effort = c.effort; if (!parsePhoneId(p.id)) defaults.effort = c.effort;
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
  // Where a new conversation starts (ui/startfolder.js, src/places.js).
  // The Codex scan takes ~2 s the first time, so the Claude Code lists go out first.
  places: async (c) => {
    if (!state.items) await loadSessions();
    const claude = state.items.filter((it) => !it.codex);
    if (!state.codexPlaces) {
      emit({ ev: 'places', reqId: c.reqId, ...folderStats(claude, { codex: false, limit: 6 }) });
      await new Promise((r) => setTimeout(r, 30));
    }
    emit({ ev: 'places', reqId: c.reqId, ...folderStats(claude, { limit: 6 }) });
    state.codexPlaces = true;
  },
  listDir: (c) => emit({ ev: 'dir', reqId: c.reqId, ...listDir(c.path || os.homedir()) }),
  mkdir: (c) => {
    const r = makeDir(c.path, c.name);
    emit(r.error ? { ev: 'dir', reqId: c.reqId, ...listDir(c.path), error: r.error, kind: 'mkdir' } : { ev: 'dir', reqId: c.reqId, ...listDir(r.path), created: r.path });
  },
  // /warm on|off|status: keep prompt caches warm between messages (src/warm.js).
  warm: async (c) => {
    const v = String(c.arg || '').trim().toLowerCase();
    const p = c.paneId ? panes.get(String(c.paneId)) : null;
    if (v === 'on' || v === 'off') {
      setWarm(v === 'on');
      // Register this pane's session at once if it already ran a turn on a key.
      if (v === 'on' && p?.runner?.lastResult) noteRunnerUse(p.runner, p.runner.lastResult);
    }
    const text = v && v !== 'on' && v !== 'off' && v !== 'status' ? 'Use /warm on, /warm off or /warm' : await warmStatus();
    emit({ ev: 'note', paneId: c.paneId || null, text });
  },
  // The Settings sheet's keep-warm switch: the state, and on/off without a note in a pane.
  warmState: (c) => {
    if (c.on === true || c.on === false) setWarm(c.on);
    emit({ ev: 'warmState', reqId: c.reqId, ...warmSummary() });
    refreshWarm();
  },
  /* ---------- subagents, shells, monitors (tasks.js; the window's tasks panel and viewers) ---------- */

  // A session's subagents and shell outputs on disk, for the rail and the tasks panel.
  subagents: (c) => {
    const id = String(c.sessionId || '');
    const file = transcriptMap().get(id);
    const agents = file ? listSubagents(file).map(({ file: _f, ...a }) => a) : [];
    const shells = file ? listShells(file).map(({ file: _f, ...s }) => s) : [];
    emit({ ev: 'subagents', reqId: c.reqId, sessionId: id, agents, shells });
  },
  // Stop one task of a conversation running here (Claude Code's own stop: a task_notification "stopped" follows).
  taskStop: async (c) => {
    const p = getPane(c.paneId);
    if (!p.runner?.q) throw new Error('That conversation is not running here, so its tasks cannot be stopped from Apaki.');
    await p.runner.q.stopTask(String(c.taskId));
  },
  // Ctrl+B: move a foreground subagent or shell to the background so the turn goes on.
  taskBackground: async (c) => {
    const p = getPane(c.paneId);
    if (!p.runner?.q) throw new Error('That conversation is not running here.');
    const ok = await p.runner.q.backgroundTasks(c.toolUseId ? String(c.toolUseId) : undefined);
    if (!ok) emit({ ev: 'note', paneId: p.id, text: 'Nothing to move to the background.' });
  },
  // The end of a running shell's output (the 8 KB /tasks shows), polled by its viewer.
  taskOutput: async (c) => {
    const owner = panes.get(String(c.ownerPane || ''));
    let r = null;
    try { r = owner?.runner?.q ? await owner.runner.q.getTaskOutput(String(c.taskId)) : null; } catch (e) { r = { error: e.message }; }
    emit({ ev: 'taskOutput', paneId: String(c.paneId), taskId: c.taskId, output: r?.output ?? null, error: r?.error || (r ? null : 'not running here') });
  },
  // A viewer following a subagent's transcript as it grows.
  agentWatch: (c) => watchAgent(String(c.paneId), String(c.sessionId || ''), c.agentId ? String(c.agentId) : null, c.toolUseId ? String(c.toolUseId) : null),
  // A viewer following a shell or Monitor output file.
  outputWatch: (c) => watchOutput(String(c.paneId), String(c.sessionId || ''), String(c.taskId || '')),
  unwatch: (c) => unwatchViewer(String(c.paneId)),

  /* ---------- the workspace, saved to disk as well (crash recovery) ---------- */
  saveState: (c) => saveWorkspace(c.state),
  loadState: (c) => emit({ ev: 'state', reqId: c.reqId, state: loadWorkspace() }),

  // A name for a session, saved the way Claude Code's /rename saves it (a
  // custom-title entry in its transcript), so Claude Code, latch and Apaki
  // all show the same one.
  rename: async (c) => {
    const id = String(c.sessionId || '');
    const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!id || !title) { emit({ ev: 'renamed', reqId: c.reqId, paneId: c.paneId || null, sessionId: id, ok: false, message: 'A name needs some text.' }); return; }
    await applyRename(id, title, { reqId: c.reqId, paneId: c.paneId || null });
  },
  // The footer's Glass card: read again now, or switch an account (Arthur picked it, so --user-asked).
  glass: (c) => (c.refresh
    ? new Promise((resolve) => execFile(GLASS_CLI, ['refresh', '--json'], { timeout: 30000, windowsHide: true }, () => resolve())).then(() => glassChanged())
    : glassChanged()),
  glassSwap: (c) => new Promise((resolve) => {
    const provider = c.provider === 'codex' ? 'codex' : 'claude';
    const args = ['swap', provider, String(c.account || ''), '--reason', 'Picked in Myrlin Apaki', '--requester', 'myrlin-apaki', '--user-asked', '--json'];
    execFile(GLASS_CLI, args, { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch { out = null; }
      const ok = !err && out?.ok !== false && !out?.error;
      const message = ok ? '' : String(out?.error || out?.message || stderr || err?.message || 'Glass could not switch').trim().split('\n')[0].slice(0, 240);
      emit({ ev: 'glass_swap', reqId: c.reqId, provider, account: c.account, ok, message, detail: out?.message || '' });
      glassChanged().catch(() => {}).finally(resolve);
    });
  }),
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
    // The runner is kept here: a takeover can stop the pane while this waits.
    const runner = p.runner;
    const list = shape(await runner.supportedCommands().catch(() => []));
    if (list.length) state.commandsByCwd.set(runner.cwd, list);
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
  // Phone access (remote.js): from the desktop window only. A phone's
  // commands never reach these: remote-policy.js does not allow them.
  remoteStatus: (c) => remote.op(c),
  remoteDevices: (c) => remote.op(c),
  remoteEnable: (c) => remote.op(c),
  remoteDisable: (c) => remote.op(c),
  remotePairStart: (c) => remote.op(c),
  remotePairCancel: (c) => remote.op(c),
  remotePairDecision: (c) => remote.op(c),
  remoteRevoke: (c) => remote.op(c),
};

const SERIAL_OPS = new Set(['open', 'attach', 'send', 'close', 'model', 'mode', 'effort', 'billing']);

/** Runs one command, from the window (stdin) or from a phone (remote.js, already checked). */
async function dispatch(c) {
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
}

/** The panes of one phone (phone:<deviceId>:...). */
const phonePanes = (deviceId) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === deviceId);

remote = createRemote({
  emit,
  dispatch: (c) => dispatch(c),
  readyEvent: () => ({ ev: 'ready', billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: false }),
  engine: {
    hasOp: (op) => typeof handlers[op] === 'function',
    paneExists: (id) => panes.has(id),
    paneCount: (deviceId) => phonePanes(deviceId).length,
    phonePanes,
    paneInfo: (id) => { const p = panes.get(id); return p ? { sessionId: p.sessionId, running: Boolean(p.runner), busy: Boolean(p.busy) } : null; },
    askPane: (askId) => state.asks.get(askId)?.paneId || null,
    knownCwd: (cwd) => Boolean(state.items?.some((it) => it.cwd === cwd)),
    phoneSessions: (deviceId) => phonePanes(deviceId).map((id) => panes.get(id)?.sessionId).filter(Boolean),
  },
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let c;
  try { c = JSON.parse(line); } catch { return; }
  await dispatch(c);
});
rl.on('close', async () => {
  if (workspaceTimer) { clearTimeout(workspaceTimer); workspaceTimer = null; if (workspacePending) { try { fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(workspacePending)); } catch { /* exiting */ } } }
  remote?.stop();
  fs.unwatchFile(LIVE_LOGIN); await Promise.all([...panes.values()].map((p) => closeRunner(p))); process.exit(0); });

/* ---------- task viewers: subagent transcripts and shell output, live ---------- */

// viewerId -> stop(); a viewer watches one file at a time.
const viewerWatch = new Map();

function unwatchViewer(id) {
  const stop = viewerWatch.get(id);
  viewerWatch.delete(id);
  try { stop?.(); } catch { /* gone */ }
}

/**
 * Sends a subagent's transcript to its viewer, then every line it adds. One
 * opened the moment it started may have no file yet: looked for again every
 * second for 30 s.
 */
function watchAgent(viewer, sessionId, agentId, toolUseId) {
  unwatchViewer(viewer);
  let tries = 0;
  let timer = null;
  let stopFile = null;
  const find = () => {
    const file = transcriptMap().get(sessionId);
    if (!file) return null;
    return agentId ? listSubagents(file).find((a) => a.id === agentId) || null : agentByToolUse(file, toolUseId);
  };
  const start = (a) => {
    let next = 0;
    const meta = { id: a.id, type: a.type, description: a.description, model: a.model, workflow: a.workflow, startedAt: a.startedAt, toolUseId: a.toolUseId };
    const push = (reset) => {
      let r;
      try { r = readEntries(a.file, next); } catch { return; }
      next = r.next;
      let lastAt = 0;
      try { lastAt = fs.statSync(a.file).mtimeMs; } catch { /* gone */ }
      if (reset || r.entries.length) emit({ ev: 'agentLines', paneId: viewer, reset, entries: r.entries, agent: meta, running: Date.now() - lastAt < RUNNING_MS, lastAt });
    };
    push(true);
    stopFile = watchFile(a.file, () => push(false));
  };
  const attempt = () => {
    const a = find();
    if (a) { start(a); return; }
    if (++tries > 30) { emit({ ev: 'agentLines', paneId: viewer, reset: true, missing: true, entries: [] }); return; }
    timer = setTimeout(attempt, 1000);
  };
  viewerWatch.set(viewer, () => { clearTimeout(timer); stopFile?.(); });
  attempt();
}

/** Sends the end of a shell or Monitor output file to its viewer, then what it appends. */
function watchOutput(viewer, sessionId, taskId) {
  unwatchViewer(viewer);
  let tries = 0;
  let timer = null;
  let stopFile = null;
  const attempt = () => {
    const file = transcriptMap().get(sessionId);
    const sh = file ? listShells(file).find((x) => x.id === taskId) : null;
    if (!sh) {
      if (++tries > 30) { emit({ ev: 'outputText', paneId: viewer, reset: true, missing: true, text: '' }); return; }
      timer = setTimeout(attempt, 1000);
      return;
    }
    let next = null;
    const push = (reset) => {
      let r;
      try { r = readText(sh.file, next); } catch { return; }
      next = r.next;
      let lastAt = 0;
      try { lastAt = fs.statSync(sh.file).mtimeMs; } catch { /* gone */ }
      if (reset || r.text) emit({ ev: 'outputText', paneId: viewer, reset, text: r.text, cut: Boolean(r.cut), running: Date.now() - lastAt < RUNNING_MS, lastAt });
    };
    push(true);
    stopFile = watchFile(sh.file, () => push(false));
  };
  viewerWatch.set(viewer, () => { clearTimeout(timer); stopFile?.(); });
  attempt();
}

/* ---------- the workspace on disk ---------- */

// The window keeps its workspace in localStorage and sends it here too, so a
// crash (or a lost WebView profile) still reopens every tab, pane, draft and
// queued message. Written at most once a second, atomically.
const WORKSPACE_FILE = path.join(CLAUDE_DIR, 'latch', 'apaki-workspace.json');
let workspacePending = null;
let workspaceTimer = null;
function saveWorkspace(st) {
  if (!st || typeof st !== 'object') return;
  workspacePending = st;
  if (workspaceTimer) return;
  workspaceTimer = setTimeout(() => {
    workspaceTimer = null;
    const data = workspacePending;
    workspacePending = null;
    try {
      fs.mkdirSync(path.dirname(WORKSPACE_FILE), { recursive: true });
      const tmp = `${WORKSPACE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, WORKSPACE_FILE);
    } catch (e) { process.stderr.write(`apaki: workspace not saved (${e.message})\n`); }
  }, 1000);
}
function loadWorkspace() {
  try { return JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); } catch { return null; }
}

/* ---------- renames ---------- */

/**
 * Writes a session's name. A running Claude Code process writes its own
 * in-memory name back into the transcript after its turns (one renamed
 * session on this PC had the same custom-title entry 155 times), so a pane of
 * ours holding the session is stopped first (it resumes with the new name at
 * its next message, no API call). If one of them is mid-turn the name is
 * written when that turn ends. A terminal window cannot be reached: when it
 * holds a session that already had a name, the note says to /rename there too.
 */
async function applyRename(id, title, { reqId = null, paneId = null } = {}) {
  const holders = [...panes.values()].filter((x) => x.sessionId === id && x.runner?.running);
  if (holders.some((x) => x.runner.turnRunning)) {
    state.renames.set(id, title);
    emit({ ev: 'renamed', reqId, paneId, sessionId: id, title, ok: true, pending: true });
    return;
  }
  state.renames.delete(id);
  const before = await getSessionInfo(id).catch(() => null);
  for (const x of holders) await x.runner.stop().catch(() => {});
  try {
    await renameSession(id, title);
  } catch (e) {
    emit({ ev: 'renamed', reqId, paneId, sessionId: id, ok: false, message: e.message || String(e) });
    return;
  }
  const it = state.byId.get(id);
  if (it) it.title = title;
  const terminal = terminalSessions().get(id);
  const note = terminal?.length && before?.customTitle && before.customTitle !== title
    ? `Renamed. It is also open in a terminal window (${terminal.map((t) => t.name || t.pid).join(', ')}) that still has it as "${before.customTitle}": run /rename ${title} there too, or that window puts its old name back after its next turn.`
    : '';
  emit({ ev: 'renamed', reqId, paneId, sessionId: id, title, ok: true, note });
}

/* ---------- live session list and keep-warm marks ---------- */

// The list follows Claude Code as it happens (live.js): terminal windows
// opening and closing at once, new or changed transcripts within seconds.
let listBusy = false;
async function refreshList() {
  if (listBusy) return;
  listBusy = true;
  try { await sessions(null); } catch { /* the next change tries again */ } finally { listBusy = false; }
}
startLive({
  liveDir: path.join(CLAUDE_DIR, 'sessions'),
  projectsDir: path.join(CLAUDE_DIR, 'projects'),
  terminals: () => terminalSessions(),
  onTerminals: (map) => {
    const out = {};
    for (const [id, recs] of map) out[id] = { name: recs[0].name, status: recs[0].status, pid: recs[0].pid, cwd: recs[0].cwd, updatedAt: recs[0].updatedAt };
    emit({ ev: 'terminals', terminals: out });
    refreshList();
  },
  onChange: () => refreshList(),
  // A session's subagents changed on disk: the rail's count and an open list follow.
  onSubagents: (sessionId) => {
    const file = transcriptMap().get(sessionId);
    emit({ ev: 'subagentsChanged', sessionId, count: file ? countSubagents(file) : 0 });
  },
});

/** Which sessions keep-warm is looking after; the window draws a moving border on them. */
function refreshWarm() {
  let next = [];
  try { next = warmSessions(); } catch { next = []; }
  const same = next.length === state.warm.size && next.every((id) => state.warm.has(id));
  if (same) return;
  state.warm = new Set(next);
  emit({ ev: 'warm', sessions: next });
}
setInterval(refreshWarm, 30 * 1000).unref();
setTimeout(refreshWarm, 2000).unref();

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

/** Glass's full status (both providers, their accounts, API credit orgs), or null. */
function glassStatus() {
  return new Promise((resolve) => {
    if (!fs.existsSync(GLASS_CLI)) { resolve(null); return; }
    execFile(GLASS_CLI, ['status', '--json'], { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

const accountName = (a) => a?.label || (a?.email ? String(a.email).split('@')[0] : '') || 'Account';

/**
 * One Glass account for the footer and its menu. An API-credit entry is
 * marked isKey and its plan reads "API key" (Arthur, 2026-10-09: it must be
 * apparent when Claude bills a key, not a subscription).
 */
function glassAccount(a) {
  if (!a) return null;
  const isKey = /api credits/i.test(a.plan || '');
  const seen = new Set();
  const windows = (a.windows || []).filter((w) => { const k = `${w.label}:${Math.round(w.percent)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((w) => ({ label: w.label, percent: Math.round(w.percent ?? 0), resetsAt: w.resetsAt || null }));
  return {
    id: a.id, name: accountName(a), plan: isKey ? 'API key' : (a.plan || ''), isKey, state: a.state || 'ok',
    headroom: a.headroom == null ? null : Math.round(a.headroom), detail: a.stateDetail || '', windows, active: Boolean(a.active),
    leftUsd: a.apiCredit?.leftUsd ?? null,
  };
}

/** The live account and the swappable list for each provider, from glassStatus(). */
function glassView(st) {
  if (!st) return null;
  const acc = st.accounts || [];
  const live = (p) => glassAccount(acc.find((a) => a.provider === p && a.active));
  const claude = live('claude');
  // A key's dollars live on its API-credit entry, not on the account Glass made for it.
  const credit = claude?.isKey ? (st.apiCredits || []).find((c) => c.id === claude.id) || (st.apiCredits || []).find((c) => c.active) : null;
  if (credit) Object.assign(claude, { leftUsd: credit.leftUsd ?? null, creditUsd: credit.creditUsd ?? null, detail: credit.orgName || claude.detail });
  // Subscriptions come from the accounts; every API-credit org is offered as a key.
  const subs = acc.filter((a) => a.provider === 'claude' && !/api credits/i.test(a.plan || '')).map(glassAccount);
  const keys = (st.apiCredits || []).map((c) => ({
    id: c.id, name: c.label, plan: 'API key', isKey: true, state: c.keyStatus === 'active' ? 'ok' : (c.keyStatus || 'unknown'),
    headroom: c.creditUsd ? Math.round((100 * (c.leftUsd ?? 0)) / c.creditUsd) : null, leftUsd: c.leftUsd ?? null, creditUsd: c.creditUsd ?? null, windows: [],
    active: Boolean(c.active) || Boolean(claude?.isKey && claude.id === c.id), detail: c.orgName || '',
  }));
  return { claude, codex: live('codex'), lists: { claude: [...keys, ...subs], codex: acc.filter((a) => a.provider === 'codex').map(glassAccount) } };
}

async function glassChanged() {
  const c = glassCredential();
  const id = `${c.source}:${c.key ? c.key.slice(-12) : ''}`;
  const view = glassView(await glassStatus());
  const account = view?.claude ? { label: view.claude.name, plan: view.claude.plan, headroom: view.claude.headroom } : null;
  const name = c.key ? (view?.claude?.isKey ? view.claude.name : c.name) : account?.label ? `${account.label} (${account.plan || 'subscription'})` : c.name;
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
  emit({ ev: 'glass', installed: fs.existsSync(GLASS_CLI), name, source: c.source, plan: account?.plan || null, headroom: account?.headroom ?? null, changed, isKey: Boolean(c.key), claude: view?.claude || null, codex: view?.codex || null, lists: view?.lists || null });
}

fs.watchFile(LIVE_LOGIN, { interval: 1500 }, () => { glassChanged().catch(() => {}); });
glassChanged().catch(() => {});
// Usage numbers move without a login change; Glass keeps them, this only reads them.
setInterval(() => { glassChanged().catch(() => {}); }, 60 * 1000).unref();

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
