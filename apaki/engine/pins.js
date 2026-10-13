/**
 * pins.js: sessions pinned to the top of Apaki's session list (2026-10-12).
 *
 * WHY (Arthur, 2026-10-12): "think about everything a user might want to do with a session ... think about chatgpt app
 * and how the sessions are displayed". The ChatGPT app pins a chat to the top of its list; Apaki's session menu has
 * Pin to top, and pinned sessions show under Pinned above Today. Pinning only changes Apaki's own list: the transcript
 * is not touched. Kept by the engine (not the window), so the desktop and a paired phone show the same pins.
 *
 * File: ~/.claude/latch/pinned.json  { "sessions": ["<sessionId>", ...] }  newest pin first (CLAUDE_CONFIG_DIR moves
 * ~/.claude), written atomically. A missing or broken file pins nothing. Codex threads (codex:<id>) pin too.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'latch', 'pinned.json');
const ID_RE = /^(?:codex:)?[A-Za-z0-9_-]{8,80}$/;
/** Most pins kept (a list of pins longer than this is not "the top" any more). */
export const MAX_PINS = 200;

let cache = null;
let cacheFile = null;

/** The pinned session ids, newest pin first (a Set keeps that order). */
export function pinned() {
  const f = file();
  if (cache && cacheFile === f) return cache;
  cacheFile = f;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    cache = new Set((Array.isArray(j.sessions) ? j.sessions : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, MAX_PINS));
  } catch {
    cache = new Set();
  }
  return cache;
}

/** Pins or unpins one session; true when that changed anything. */
export function setPinned(sessionId, on) {
  const id = String(sessionId || '');
  if (!ID_RE.test(id)) return false;
  const set = pinned();
  if (on ? set.has(id) : !set.has(id)) return false;
  const next = on ? [id, ...set].slice(0, MAX_PINS) : [...set].filter((x) => x !== id);
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions: next }, null, 2));
  fs.renameSync(tmp, target);
  cache = new Set(next);
  return true;
}
