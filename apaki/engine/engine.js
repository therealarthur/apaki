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
 * effort, mode, billing, commands, folder. Events (ev): ready, index, sessions,
 * search, opened, history, sdk, result, ask, billing, commands, note, error.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { chooseCredential, childEnv, glassCredential, keySections } from '../../src/auth.js';
import { codexItem, codexResumeHint, isCodexId } from '../../src/codex.js';
import { searchIndex, updateIndex } from '../../src/deepindex.js';
import * as folders from '../../src/folders.js';
import { filterItems, terminalSessions } from '../../src/picker.js';
import { SessionRunner } from '../../src/runner.js';
import { releaseLock, rememberCreated, takeLock } from '../../src/sessions.js';
import { makeLoader } from '../../src/ui/picker.js';

// stdout is the event channel: nothing else may print there.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const DEFAULT_MODEL = process.env.APAKI_MODEL || 'claude-opus-5-5';
const DEFAULT_EFFORT = process.env.APAKI_EFFORT || 'xhigh';
const HISTORY_MESSAGES = 400;
const RESULT_CHARS = 4000;

function emit(ev) {
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}

const state = {
  runner: null,
  sessionId: null,
  credential: glassCredential(),
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  mode: 'bypassPermissions',
  asks: new Map(), // reqId -> resolve
  items: null,
  byId: new Map(),
};

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
  const res = await searchIndex(query, { limit: 80 });
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
    results.push({ item: compact(it, term.get(it.id)?.[0], folderOf), kind: hit.kind, snippet: hit.snippet, hits: hit.hits });
  }
  emit({ ev: 'search', reqId, query, elapsed: res.elapsed_ms, total: res.total_hits, deep: true, results });
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

/* ---------- the open conversation ---------- */

function billingInfo() {
  return { name: state.credential.name, source: state.credential.source, follow: Boolean(state.credential.follow) };
}

async function closeRunner() {
  const r = state.runner;
  state.runner = null;
  if (!r) return;
  await r.stop();
  if (state.sessionId) releaseLock(state.sessionId);
}

async function open(reqId, sessionId, cwd) {
  if (isCodexId(sessionId)) { emit({ ev: 'note', reqId, tone: 'warn', text: codexResumeHint(sessionId) }); return; }
  await closeRunner();
  let info = null;
  if (sessionId) {
    const holder = takeLock(sessionId);
    if (holder) { emit({ ev: 'error', reqId, message: `Another latch or Apaki window (pid ${holder}) has this session open.` }); return; }
    info = await getSessionInfo(sessionId).catch(() => null);
  }
  state.sessionId = sessionId || null;
  state.credential = state.credential.follow ? glassCredential() : state.credential;
  const runner = new SessionRunner({
    sessionId: sessionId || null,
    cwd: cwd || info?.cwd || os.homedir(),
    env: childEnv(state.credential.key),
    model: state.model,
    effort: state.effort,
    permissionMode: state.mode,
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    onMessage: (msg) => emit({ ev: 'sdk', sessionId: state.sessionId, msg }),
    onStderr: (d) => process.stderr.write(String(d).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')),
  });
  // Questions and plan approval go to the window and wait for its answer.
  runner.onInteractiveTool = (toolName, input) => new Promise((resolve) => {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.asks.set(id, resolve);
    emit({ ev: 'ask', askId: id, toolName, input });
  });
  runner.onNewSession = (id) => {
    rememberCreated(id);
    state.sessionId = id;
    takeLock(id, { force: true });
    emit({ ev: 'session_id', sessionId: id });
  };
  // Follow Myrlin Glass before every message (see SessionRunner.send).
  runner.authKey = state.credential.key ?? null;
  runner.authCheck = state.credential.follow ? () => { const c = glassCredential(); return { ...c, env: childEnv(c.key) }; } : null;
  runner.onAuthChange = (next) => {
    state.credential = { ...next, follow: true };
    emit({ ev: 'billing', ...billingInfo(), note: `Myrlin Glass switched Claude to ${next.name}; this conversation continues on it.` });
  };
  state.runner = runner;
  emit({ ev: 'opened', reqId, sessionId: state.sessionId, cwd: runner.cwd, title: info?.customTitle || info?.summary || 'New conversation', model: state.model, effort: state.effort, mode: state.mode, billing: billingInfo(), terminal: sessionId ? terminalSessions().get(sessionId) || [] : [] });
  runner.start();
  if (sessionId) {
    const msgs = await getSessionMessages(sessionId).catch(() => []);
    emit({ ev: 'history', sessionId, messages: compactMessages(msgs), total: msgs.length });
  }
}

async function send(reqId, text, images = []) {
  if (!state.runner) await open(null, null, null);
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(text ? [{ type: 'text', text }] : [])]
    : text;
  try {
    const r = await state.runner.send(content);
    emit({ ev: 'result', reqId, sessionId: state.sessionId, subtype: r.subtype, isError: Boolean(r.is_error), durationMs: r.duration_ms, usage: r.usage, cost: r.latchTurnCost ?? null, errors: r.errors || null, result: typeof r.result === 'string' ? r.result.slice(0, 2000) : null });
  } catch (e) {
    emit({ ev: 'error', reqId, message: e.message || String(e) });
  }
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

function transcribe(reqId, wavBase64) {
  if (!voiceReady()) { emit({ ev: 'error', reqId, message: `Voice is not installed (${WHISPER}).` }); return Promise.resolve(); }
  const file = path.join(os.tmpdir(), `apaki-voice-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, Buffer.from(String(wavBase64 || ''), 'base64'));
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    // The vocabulary prompt keeps names Whisper does not know spelled right.
    const child = spawn(WHISPER, ['-m', WHISPER_MODEL, '-f', file, '-nt', '-np', '-l', 'en', '-t', String(Math.min(8, os.cpus().length)), '--prompt', VOICE_VOCAB], { windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { emit({ ev: 'error', reqId, message: `Whisper failed: ${e.message}` }); });
    child.on('close', () => {
      fs.rm(file, { force: true }, () => {});
      // "Myrlin" sounds exactly like "Merlin"; in Arthur's work it is always Myrlin.
      const text = out.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '').replace(/\s+/g, ' ').trim().replace(/\bMerlin\b/g, 'Myrlin');
      emit({ ev: 'transcript', reqId, text, ms: Date.now() - t0 });
      resolve();
    });
  });
}

/* ---------- command loop ---------- */

const handlers = {
  transcribe: (c) => transcribe(c.reqId, c.wav),
  sessions: (c) => sessions(c.reqId),
  search: (c) => search(c.reqId, String(c.query || '')),
  open: (c) => open(c.reqId, c.sessionId || null, c.cwd || null),
  send: (c) => send(c.reqId, String(c.text || ''), Array.isArray(c.images) ? c.images : []),
  interrupt: () => state.runner?.interrupt(),
  answer: (c) => { const r = state.asks.get(c.askId); state.asks.delete(c.askId); r?.(c.result || null); },
  model: async (c) => { state.model = c.model; await state.runner?.setModel(c.model); emit({ ev: 'note', text: `Model: ${c.model}` }); },
  mode: async (c) => { state.mode = c.mode; await state.runner?.setPermissionMode(c.mode); emit({ ev: 'note', text: `Permission mode: ${c.mode}` }); },
  effort: async (c) => { state.effort = c.effort; if (state.runner) await state.runner.restart({ effort: c.effort }); emit({ ev: 'note', text: `Effort: ${c.effort}` }); },
  billing: async (c) => {
    const v = String(c.value || 'glass');
    const next = chooseCredential(v === 'sub' ? { subscription: true } : v === 'glass' ? {} : { keyWords: v });
    if (next.error) { emit({ ev: 'error', reqId: c.reqId, message: next.error }); return; }
    state.credential = next;
    if (state.runner) {
      state.runner.authKey = next.key ?? null;
      state.runner.authCheck = next.follow ? () => { const g = glassCredential(); return { ...g, env: childEnv(g.key) }; } : null;
      await state.runner.restart({ env: childEnv(next.key) });
    }
    emit({ ev: 'billing', ...billingInfo() });
  },
  billingOptions: (c) => emit({
    ev: 'billingOptions', reqId: c.reqId,
    options: [
      { label: 'Follow Myrlin Glass', value: 'glass' },
      { label: 'Subscription (live login)', value: 'sub' },
      ...keySections().map((s) => { const label = s.heading.replace(/\s+-\s+added\s+\S+\s*$/i, '').replace(/^Anthropic API Key\s*\((.*)\)$/i, '$1'); return { label, value: label }; }),
    ],
  }),
  commands: async (c) => {
    if (!state.runner) { emit({ ev: 'commands', reqId: c.reqId, commands: [] }); return; }
    const list = await state.runner.supportedCommands().catch(() => []);
    emit({ ev: 'commands', reqId: c.reqId, commands: list.map((x) => ({ name: x.name, description: x.description || '', argumentHint: x.argumentHint || '' })) });
  },
  folder: async (c) => {
    if (c.action === 'create') { const f = folders.createFolder(c.name); if (!f.error && c.sessionId) folders.moveToFolder(c.sessionId, f.id); }
    if (c.action === 'move') folders.moveToFolder(c.sessionId, c.folderId || null);
    if (c.action === 'rename') folders.renameFolder(c.folderId, c.name);
    if (c.action === 'delete') folders.deleteFolder(c.folderId);
    emit({ ev: 'folders', folders: folders.listFolders() });
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let c;
  try { c = JSON.parse(line); } catch { return; }
  const h = handlers[c.op];
  if (!h) { emit({ ev: 'error', reqId: c.reqId, message: `unknown op ${c.op}` }); return; }
  try { await h(c); } catch (e) { emit({ ev: 'error', reqId: c.reqId, message: e.message || String(e) }); }
});
rl.on('close', async () => { await closeRunner(); process.exit(0); });

emit({ ev: 'ready', billing: billingInfo(), model: state.model, effort: state.effort, pid: process.pid, voice: voiceReady() });
// Keep the conversation index current in the background.
const t0 = Date.now();
updateIndex().then((r) => emit({ ev: 'index', ok: Boolean(r), ms: Date.now() - t0, stats: r }));
