/**
 * last-active.js: when a conversation was last really used, for the session
 * list's times and order (Arthur, 2026-10-11: "lots of chats have very fresh
 * timestamps (i.e. interacted with 18 mintues ago, etc - doesnt make sense -
 * most of these are hours or days old").
 *
 * The SDK's listSessions gives the transcript file's modified time. Claude
 * Code writes bookkeeping lines into a transcript whenever a session is
 * opened, resumed or closed, with nobody typing: cost-state and last-prompt
 * when a process exits, turn_duration, a recap (away_summary) in a terminal
 * window, permission and mode lines. Measured 2026-10-11: 12 of the 60
 * newest sessions showed a fresh time that way, some 3 to 4 days after their
 * last message. The time of the last user or assistant line is the real one.
 *
 * Reads only each transcript's tail, once per file version (size and mtime),
 * so a refresh only reads the files that changed. Never writes.
 */

import fs from 'node:fs';

/** How much of a transcript's end is read first, and at most. */
export const TAIL_FIRST = 64 * 1024;
export const TAIL_MAX = 1024 * 1024;

/** The time of the last user or assistant line in some transcript text (JSON lines), or null. */
export function lastMessageAt(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // A Codex rollout (2026-10-12): its messages are response_item lines with a role. The server's own times are when
    // a turn started (recencyAt) or anything was written (updatedAt: also token counts, a rename); this is the last message.
    if (line.includes('"type":"response_item"') && line.includes('"type":"message"') && (line.includes('"role":"user"') || line.includes('"role":"assistant"'))) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const role = r?.payload?.role;
      if (r?.type !== 'response_item' || r.payload?.type !== 'message' || (role !== 'user' && role !== 'assistant')) continue;
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t)) return t;
      continue;
    }
    // Cheap checks first: most tail lines are bookkeeping.
    if (!line.includes('"timestamp"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    if (j.isSidechain) continue;
    const t = Date.parse(j.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

async function readTail(file, size, bytes) {
  const len = Math.min(size, bytes);
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}

/** One file's last message time, or null (read the tail, then a larger tail when the first held none). */
export async function lastActiveOf(file, size) {
  let bytes = TAIL_FIRST;
  for (;;) {
    const t = lastMessageAt(await readTail(file, size, bytes));
    if (t || bytes >= TAIL_MAX || bytes >= size) return t;
    bytes = Math.min(TAIL_MAX, bytes * 4);
  }
}

/**
 * A cache of last message times by file. lastActive(file) answers from the
 * cache while the file's size and mtime are unchanged.
 */
export class LastActive {
  constructor() { this.cache = new Map(); }

  async lastActive(file) {
    let st;
    try { st = await fs.promises.stat(file); } catch { return null; }
    const hit = this.cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.at;
    const at = await lastActiveOf(file, st.size).catch(() => null);
    this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, at });
    return at;
  }

  /**
   * Sets each item's lastModified to its last message time (items whose
   * transcript has none keep the file's time), keeping the file's time as
   * fileModified. files: Map of session id to transcript path.
   */
  async apply(items, files, { concurrency = 16 } = {}) {
    const list = [...items];
    let next = 0;
    const work = async () => {
      while (next < list.length) {
        const it = list[next++];
        const file = files.get(it.id);
        if (!file) continue;
        const at = await this.lastActive(file);
        if (it.fileModified === undefined) it.fileModified = it.lastModified || 0;
        if (at) it.lastModified = at;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, work));
  }
}
