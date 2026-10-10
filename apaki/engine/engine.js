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
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_DIR, chooseCredential, childEnv, glassCredential, keySections } from '../../src/auth.js';
import { codexItem, codexResumeHint, isCodexId } from '../../src/codex.js';
import { searchHybrid, startIndexServer, updateIndex, updateViaServer } from '../../src/deepindex.js';
import { askSearch, digPrompt } from './asksearch.js';
import * as folders from '../../src/folders.js';
import { filterItems, terminalSessions } from '../../src/picker.js';
import { SessionRunner } from '../../src/runner.js';
import { lockInfo, lockStolen, releaseLock, rememberCreated, setLockApp, takeLock } from '../../src/sessions.js';
import { makeLoader } from '../../src/ui/picker.js';
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
};

// New panes start from these; the window can pass its own per pane.
const defaults = { credential: glassCredential(), model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, mode: 'bypassPermissions' };

/** paneId -> { id, runner, sessionId, credential, model, effort, mode } */
const panes = new Map();

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
  const runner = new SessionRunner({
    sessionId: sessionId || null,
    cwd: cwd || info?.cwd || os.homedir(),
    env: childEnv(p.credential.key),
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
    p.busy = true;
    const r = await p.runner.send(content);
    p.busy = false;
    emit({ ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: r.subtype, isError: Boolean(r.is_error), durationMs: r.duration_ms, usage: r.usage, cost: r.latchTurnCost ?? null, errors: r.errors || null, result: typeof r.result === 'string' ? r.result.slice(0, 2000) : null });
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
    emit({ ev: 'history', paneId: p.id, sessionId: p.sessionId, messages: compactMessages(msgs), total: msgs.length });
  }
  for (const [askId, a] of state.asks) if (a.paneId === p.id) emit({ ev: 'ask', askId, paneId: p.id, toolName: a.toolName, input: a.input });
}

/** Closes a pane: its Claude Code process stops and its session lock is freed. */
async function closePane(reqId, paneId) {
  const p = panes.get(String(paneId));
  if (!p) return;
  for (const [id, a] of state.asks) if (a.paneId === p.id) { state.asks.delete(id); a.resolve({ behavior: 'deny', message: 'The pane was closed.' }); }
  await closeRunner(p);
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
  remote?.stop();
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

emit({ ev: 'ready', billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: voiceReady() });
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
