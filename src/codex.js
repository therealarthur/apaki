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

const HEAD_BYTES = 512 * 1024;
const INJECTED = /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<turn_aborted>)/;

export function isCodexId(id) {
  return String(id || '').startsWith('codex:');
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
      const t = (Array.isArray(p.content) ? p.content.map((c) => c.text || '').join(' ') : String(p.content || '')).trim();
      if (t && !INJECTED.test(t)) meta.title = t.replace(/\s+/g, ' ').slice(0, 140);
    }
    if (meta.title && meta.cwd) break;
  }
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
