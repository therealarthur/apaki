/**
 * codex.js
 *
 * Codex sessions in latch's search (Arthur, 2026-10-09: "yes index codex
 * sessions too"). latch-index indexes ~/.codex/sessions as "codex:<uuid>";
 * this turns a hit into a picker row. Codex sessions are read-only here: they
 * cannot be continued in Claude Code, so opening one shows how to resume it in
 * Codex instead.
 */

import fs from 'node:fs';

const HEAD_BYTES = 2 * 1024 * 1024; // AGENTS.md and plugin lists can come first
const INJECTED = /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<turn_aborted>)/;

export function isCodexId(id) {
  return String(id || '').startsWith('codex:');
}

/**
 * The words a person typed in a Codex user message, or '' when it is only
 * injected context. Codex wraps some prompts in tags (2026-10-09: titles read
 * "Codex: <realtime_delegation> <input>..." and "<recommended_plugins> Here is
 * a list..."): a delegation's <input> is the real request; any other leading
 * tag block is context and is dropped.
 */
export function codexPromptText(raw) {
  let t = String(raw || '').trim();
  if (!t || INJECTED.test(t)) return '';
  const input = t.match(/<input>([\s\S]*?)(<\/input>|$)/);
  if (input) t = input[1];
  for (let i = 0; i < 6 && t.startsWith('<'); i++) {
    const m = t.match(/^<([A-Za-z][\w-]*)[^>]*>[\s\S]*?<\/\1>\s*/);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  t = t.replace(/<\/?[A-Za-z][\w-]*[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (INJECTED.test(t) || /^# (Global Codex Instructions|AGENTS)/.test(t)) return '';
  return t.length >= 4 ? t : '';
}

/** Title (first real prompt), folder and time of a Codex transcript. */
export function codexMeta(file) {
  const meta = { title: '', cwd: '', startedAt: 0 };
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      text = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return meta;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload || {};
    if (e.type === 'session_meta') {
      meta.cwd = p.cwd || meta.cwd;
      meta.startedAt = Date.parse(p.timestamp || e.timestamp || '') || meta.startedAt;
    } else if (!meta.title && e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      // One message can hold AGENTS.md, the environment and the real prompt as separate items.
      const parts = Array.isArray(p.content) ? p.content.map((c) => c.text || '') : [String(p.content || '')];
      const t = parts.map(codexPromptText).find(Boolean) || '';
      if (t) meta.title = t.slice(0, 140);
    }
    // Worker sessions get their task as tool traffic and have no typed
    // prompt: their first reply says what they are doing.
    if (!meta.reply && e.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const r = (Array.isArray(p.content) ? p.content.map((c) => c.text || '').join(' ') : String(p.content || '')).replace(/\s+/g, ' ').trim();
      if (r.length >= 8) meta.reply = r.slice(0, 140);
    }
    if (meta.title && meta.cwd) break;
  }
  if (!meta.title && meta.reply) meta.title = meta.reply;
  delete meta.reply;
  return meta;
}

/** A picker row for a Codex hit from latch-index. */
export function codexItem(hit) {
  const id = hit.session;
  const meta = codexMeta(hit.file);
  let mtime = 0;
  try { mtime = fs.statSync(hit.file).mtimeMs; } catch { /* gone */ }
  const title = `Codex: ${meta.title || '(untitled)'}`;
  return {
    id, codex: true, title, firstPrompt: meta.title, cwd: meta.cwd, branch: '',
    lastModified: mtime || Date.parse(hit.latest || '') || meta.startedAt, size: 0, file: hit.file, open: 0,
    titleLower: title.toLowerCase(), hay: [id, title, meta.cwd].join(' ').toLowerCase(),
  };
}

/** What to tell someone who opens a Codex session in latch. */
export function codexResumeHint(id) {
  return `Codex session, read-only here. Continue it in Codex: codex resume ${String(id).replace(/^codex:/, '')}`;
}
