/**
 * tasks.js: what a session started besides its own turns, read from disk.
 *
 * Arthur, 2026-10-10: see a session's subagents and shells, what they are
 * called, open them, drag them, stop them; click a session in the list and see
 * how many subagents it has, expand them, open them. Live tasks of a
 * conversation Apaki runs come from the SDK (task_* messages, handled in the
 * window). This module covers every session on the PC, terminal ones too:
 *
 *   <projects>/<project>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json:
 *       agentType, description, model, toolUseId, spawnDepth, requestShape)
 *   <projects>/<project>/<sessionId>/subagents/workflows/<runId>/agent-*.jsonl
 *   %TEMP%/claude/<project>/<sessionId>/tasks/<taskId>.output  (shells, monitors)
 *
 * A file written to in the last RUNNING_MS counts as running; Claude Code
 * keeps no other on-disk record of that.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeTempRoot } from '../../src/platform.js';

export const RUNNING_MS = 45 * 1000;
const RESULT_CHARS = 4000;
const PROMPT_CHARS = 20000;
// <temp>\claude on Windows; /tmp/claude-<uid> on a Mac or Linux (src/platform.js claudeTempRoot, macOS port 2026-10-12).
const TEMP_ROOT = () => claudeTempRoot({ tmpdir: os.tmpdir() });

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const dirOf = (transcript) => transcript.replace(/\.jsonl$/i, '');

/** The agent transcript files of a session: [{ file, workflow }]. */
function agentFiles(transcript) {
  const base = path.join(dirOf(transcript), 'subagents');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch { return out; }
  for (const n of names) if (/^agent-.*\.jsonl$/.test(n)) out.push({ file: path.join(base, n), workflow: null });
  let runs = [];
  try { runs = fs.readdirSync(path.join(base, 'workflows')); } catch { runs = []; }
  for (const run of runs) {
    let inner = [];
    try { inner = fs.readdirSync(path.join(base, 'workflows', run)); } catch { continue; }
    for (const n of inner) if (/^agent-.*\.jsonl$/.test(n)) out.push({ file: path.join(base, 'workflows', run, n), workflow: run });
  }
  return out;
}

/** How many subagents a session has had (a readdir or two; cached by the caller). */
export function countSubagents(transcript) {
  return agentFiles(transcript).length;
}

/** The first timestamp in a transcript (read from its first 16 KB). */
function startedAt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.slice(0, n).toString('utf8').match(/"timestamp":"([^"]+)"/);
    return m ? Date.parse(m[1]) || null : null;
  } catch { return null; }
}

/** Every subagent of a session, newest first, with what its .meta.json says about it. */
export function listSubagents(transcript, now = Date.now()) {
  const out = [];
  for (const { file, workflow } of agentFiles(transcript)) {
    const st = statOf(file);
    if (!st) continue;
    const id = path.basename(file, '.jsonl').replace(/^agent-/, '');
    const meta = readJson(file.replace(/\.jsonl$/, '.meta.json')) || {};
    out.push({
      id, file, workflow,
      type: meta.agentType || (workflow ? 'workflow agent' : 'agent'),
      description: meta.description || '',
      model: meta.model || '',
      toolUseId: meta.toolUseId || null,
      depth: meta.spawnDepth || 1,
      background: meta.requestShape === 'background',
      size: st.size,
      startedAt: startedAt(file) || st.birthtimeMs || null,
      lastAt: st.mtimeMs,
      running: now - st.mtimeMs < RUNNING_MS,
    });
  }
  return out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

/** The temp folder Claude Code writes a session's shell and Monitor output to. */
export function shellDir(transcript) {
  const sessionId = path.basename(transcript, '.jsonl');
  const project = path.basename(path.dirname(transcript));
  return path.join(TEMP_ROOT(), project, sessionId, 'tasks');
}

/** A session's shell and Monitor output files, newest first. */
export function listShells(transcript, now = Date.now()) {
  const dir = shellDir(transcript);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.output')) continue;
    const file = path.join(dir, n);
    const st = statOf(file);
    if (st) out.push({ id: n.slice(0, -7), file, size: st.size, lastAt: st.mtimeMs, running: now - st.mtimeMs < RUNNING_MS });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/** True when `file` is a shell output file Claude Code wrote (the only files outputWatch may read). */
export function isTaskOutputFile(file) {
  const root = path.resolve(TEMP_ROOT()).toLowerCase() + path.sep;
  const f = path.resolve(String(file || '')).toLowerCase();
  return f.startsWith(root) && f.endsWith('.output') && f.includes(`${path.sep}tasks${path.sep}`);
}

/** True when `file` is a subagent transcript under the projects folder. */
export function isAgentFile(file, projectsDir) {
  const root = path.resolve(projectsDir).toLowerCase() + path.sep;
  const f = path.resolve(String(file || '')).toLowerCase();
  return f.startsWith(root) && f.includes(`${path.sep}subagents${path.sep}`) && /agent-[^\\/]*\.jsonl$/.test(f);
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${(s.length - n).toLocaleString()} more characters)` : s);

/** One transcript line as the viewer draws it, or null for bookkeeping lines. */
export function compactEntry(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'user' && j.type !== 'assistant') return null;
  if (j.isMeta) return null;
  const content = j.message?.content;
  let c = content;
  if (typeof content === 'string') {
    if (/^\s*<(command-|local-command-|system-reminder)/.test(content)) return null;
    c = cut(content, PROMPT_CHARS);
  } else if (Array.isArray(content)) {
    c = content.map((b) => {
      if (b.type === 'tool_result') {
        const text = Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : String(b.content ?? '');
        return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: Boolean(b.is_error), content: cut(text, RESULT_CHARS) };
      }
      if (b.type === 'image') return { type: 'image_marker' };
      if (b.type === 'thinking' || b.type === 'redacted_thinking') return { type: 'thinking' };
      if (b.type === 'text') return { type: 'text', text: cut(b.text || '', PROMPT_CHARS) };
      return b;
    });
  }
  return { type: j.type, uuid: j.uuid || null, at: j.timestamp || null, model: j.message?.model || null, message: { role: j.message?.role, content: c } };
}

/** The complete lines of `file` from byte `from`: { entries, next } (a half-written last line waits). */
export function readEntries(file, from = 0) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { entries: [], next: from }; }
  if (size < from) from = 0; // rewritten
  if (size === from) return { entries: [], next: from };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { entries: [], next: from };
    const entries = text.slice(0, end).split('\n').map(compactEntry).filter(Boolean);
    return { entries, next: from + Buffer.byteLength(text.slice(0, end + 1), 'utf8') };
  } finally { fs.closeSync(fd); }
}

/** The last `bytes` of a text file from byte `from` on (or its tail when from is null): { text, next }. */
export function readText(file, from = null, bytes = 64 * 1024) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { text: '', next: from || 0 }; }
  const start = from == null || from > size ? Math.max(0, size - bytes) : from;
  if (start >= size) return { text: '', next: size };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), next: size, cut: from == null && start > 0 };
  } finally { fs.closeSync(fd); }
}

/** Calls onChange whenever `file` grows or changes (polled every interval ms). Returns unwatch(). */
export function watchFile(file, onChange, interval = 1000) {
  const fn = (cur, prev) => { if (cur.size !== prev.size || cur.mtimeMs !== prev.mtimeMs) onChange(); };
  fs.watchFile(file, { interval, persistent: false }, fn);
  return () => fs.unwatchFile(file, fn);
}

/** The subagent transcript a tool call started (matched by the toolUseId in its .meta.json). */
export function agentByToolUse(transcript, toolUseId) {
  return listSubagents(transcript).find((a) => a.toolUseId === toolUseId) || null;
}
