/**
 * archive.js: sessions the user archived in Apaki's session list (2026-10-10).
 *
 * Arthur asked for a right-click menu on sessions with what Codex and the
 * Claude desktop app offer; Archive is one of those. Archiving only hides a
 * session from Apaki's lists (All, In terminals, folders): its transcript
 * stays where Claude Code keeps it, `claude --resume` still finds it, and the
 * Archived view brings it back. Nothing is deleted.
 *
 * File: ~/.claude/latch/archived.json  { "sessions": ["<sessionId>", ...] }
 * (CLAUDE_CONFIG_DIR moves ~/.claude), written atomically. A missing or
 * broken file archives nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'latch', 'archived.json');
// A Codex thread (codex:<id>) archives in Apaki's list too (2026-10-12: Codex threads are in the main list from the start).
const ID_RE = /^(?:(?:codex|kimi):)?[A-Za-z0-9_-]{8,128}$/;

let cache = null;

/** The archived session ids. */
export function archived() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
    cache = new Set((Array.isArray(j.sessions) ? j.sessions : []).filter((id) => typeof id === 'string' && ID_RE.test(id)));
  } catch {
    cache = new Set();
  }
  return cache;
}

/** Archives or restores one session; true when that changed anything. */
export function setArchived(sessionId, on) {
  const id = String(sessionId || '');
  if (!ID_RE.test(id)) return false;
  const set = archived();
  if (on ? set.has(id) : !set.has(id)) return false;
  if (on) set.add(id); else set.delete(id);
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions: [...set] }, null, 2));
  fs.renameSync(tmp, target);
  return true;
}
