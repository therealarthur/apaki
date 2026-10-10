/**
 * live.js: keeps Apaki's session list live.
 *
 * Arthur, 2026-10-09: "we CANNOT miss anything. we must see all sessions,
 * and it should be live - if a terminal opens we see it in In terminals, if
 * it's closed, we see In terminals drop it". Before this the window asked for
 * the list every 15 s, and only while no pane was working, so with Claude busy
 * anywhere the list never moved.
 *
 * Two sources, both cheap:
 *   ~/.claude/sessions/<pid>.json  Claude Code's record of each running window.
 *       Watched (fs.watch) and also checked every 2 s, because a window that
 *       is killed leaves its record behind: terminalSessions() drops records
 *       whose process is gone. A change calls onTerminals(map) at once.
 *   ~/.claude/projects/<project>/<id>.jsonl  the transcripts. A new or
 *       changed one calls onChange() for a full list refresh, 1.5 s after the
 *       last change and at most every 10 s (reading the list takes about
 *       0.7 s). Subagent transcripts (in subfolders) do not count. If the
 *       recursive watch cannot start, a refresh runs every 20 s instead.
 *
 * startLive({ liveDir, projectsDir, terminals, onTerminals, onChange }) returns stop().
 */

import fs from 'node:fs';
import path from 'node:path';

const TERMINAL_POLL_MS = 2000;
const TERMINAL_SETTLE_MS = 150;
const LIST_QUIET_MS = 1500;
const LIST_MIN_GAP_MS = 10000;
const LIST_FALLBACK_MS = 20000;

/** A stable text form of the terminal map, to tell whether anything changed. */
export function terminalSignature(map) {
  return [...map].map(([id, recs]) => `${id}:${recs.map((r) => `${r.pid}/${r.status}/${r.name}`).join(',')}`).sort().join('|');
}

/** True for a top-level transcript path relative to the projects folder (not a subagent's). */
export function isTopTranscript(rel) {
  if (!rel || !rel.endsWith('.jsonl')) return false;
  return rel.split(/[\\/]/).length === 2;
}

export function startLive({ liveDir, projectsDir, terminals, onTerminals, onChange }) {
  const timers = new Set();
  const watchers = [];
  let lastSig = terminalSignature(terminals());
  let settle = null;

  const checkTerminals = () => {
    let map;
    try { map = terminals(); } catch { return; }
    const sig = terminalSignature(map);
    if (sig === lastSig) return;
    lastSig = sig;
    onTerminals(map);
  };
  const poll = setInterval(checkTerminals, TERMINAL_POLL_MS);
  poll.unref?.();
  timers.add(poll);
  try {
    const w = fs.watch(liveDir, () => { clearTimeout(settle); settle = setTimeout(checkTerminals, TERMINAL_SETTLE_MS); });
    w.on('error', () => {});
    watchers.push(w);
  } catch { /* the 2 s check still runs */ }

  // The full list: debounced, and never more often than LIST_MIN_GAP_MS.
  let lastRun = 0;
  let pending = null;
  const schedule = () => {
    if (pending) clearTimeout(pending);
    const wait = Math.max(LIST_QUIET_MS, lastRun + LIST_MIN_GAP_MS - Date.now());
    pending = setTimeout(() => { pending = null; lastRun = Date.now(); onChange(); }, wait);
    pending.unref?.();
  };
  try {
    const w = fs.watch(projectsDir, { recursive: true }, (_event, file) => { if (isTopTranscript(String(file || ''))) schedule(); });
    w.on('error', () => {});
    watchers.push(w);
  } catch {
    const t = setInterval(() => { lastRun = Date.now(); onChange(); }, LIST_FALLBACK_MS);
    t.unref?.();
    timers.add(t);
  }

  return () => {
    for (const t of timers) clearInterval(t);
    clearTimeout(settle);
    if (pending) clearTimeout(pending);
    for (const w of watchers) { try { w.close(); } catch { /* closed */ } }
  };
}

/** A transcript the SDK's list skipped (no prompt yet, or an unreadable head): still a session on this PC. */
export function bareItem(id, file) {
  let st = null;
  try { st = fs.statSync(file); } catch { return null; }
  let cwd = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(65536, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    cwd = (buf.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1]?.replace(/\\\\/g, '\\') || '';
  } catch { /* no cwd */ }
  return { id, title: '(no messages yet)', firstPrompt: '', cwd, branch: '', lastModified: st.mtimeMs, size: st.size, bare: true, file: path.resolve(file) };
}
