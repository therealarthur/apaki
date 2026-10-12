/**
 * codex-list.js: Codex threads in Apaki's main session list from the start (2026-10-12). READ ONLY on ~/.codex.
 *
 * WHY (Arthur, 2026-10-12): Codex sessions are integrated exactly like Claude's: listed, searchable, opened side by
 * side. Until now the list held Codex threads only after the Codex view had asked the Codex app-server (thread/list),
 * so at startup the list was Claude only. This reads the rollout files themselves (codex-rollouts.js), without starting
 * the app-server, and the rows go into the same list, under the same recency headings, marked Codex.
 *
 * Startup stays cheap, as the Claude list's does:
 *   - what was read (each rollout's first prompt and folder, and its last message time and model) is kept in
 *     latch/codex-list.json (Apaki's own folder, never ~/.codex), keyed by file size and time, so a restart reads only
 *     rollouts that are new or changed;
 *   - rows() answers at once from memory (the first list at startup shows the kept rows); refresh() walks the rollout
 *     folders in the background, reading at most BATCH new heads per pass with the next pass soon after, and calls
 *     onChange() only when the rows changed, so the engine sends the list again;
 *   - times are each thread's last message (last-active.js), as for Claude.
 * The app-server's own rows (names set in Codex, after the Codex view asked) win over the rollouts' for the same thread.
 *
 *   const list = createCodexList({ cacheFile, onChange })
 *   list.rows(serverRows)   the rows now, newest first (no I/O)
 *   list.refresh()          a background pass (at most every REFRESH_MS unless forced)
 */

import fs from 'node:fs';
import path from 'node:path';

import { createRolloutScanner } from './codex-rollouts.js';
import { LastActive } from './last-active.js';

/** A refresh at most this often (each sessions request asks for one). */
export const REFRESH_MS = 30 * 1000;
/** Rollout heads read per pass at most; when a pass read this many, the next follows FOLLOW_MS later. */
export const BATCH = 80;
export const FOLLOW_MS = 1500;
const SAVE_MS = 3000;
const CACHE_VERSION = 1;

/** What makes two lists the same for the window (so an unchanged pass sends nothing). */
const signature = (rows) => rows.map((r) => `${r.id}|${r.lastModified || 0}|${r.title || ''}|${r.codexArchived ? 1 : 0}|${r.model || ''}`).join('\n');

export function createCodexList({
  cacheFile = null, scanner = createRolloutScanner(), lastActive = new LastActive(), log = () => {}, onChange = () => {},
  now = Date.now, setTimer = setTimeout, firstDelayMs = 0,
} = {}) {
  let rows = [];
  let sig = '';
  let running = null;
  let lastRun = 0;
  let saveTimer = null;
  let followTimer = null;
  // firstDelayMs: the first pass waits this long after the list is made, so the engine's start (and the first session
  // list it sends) does not share the disk with it.
  const readyAt = now() + firstDelayMs;
  let firstTimer = null;
  let firstScheduled = false;

  // What a previous run kept: the heads, the tails' times, and the rows themselves (shown before anything is read).
  if (cacheFile) {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (j?.v === CACHE_VERSION) {
        scanner.seed?.(j.heads);
        for (const t of Array.isArray(j.times) ? j.times : []) {
          if (Array.isArray(t) && typeof t[0] === 'string') lastActive.cache.set(t[0], { size: Number(t[1]) || 0, mtimeMs: Number(t[2]) || 0, at: Number(t[3]) || null, model: typeof t[4] === 'string' ? t[4] : null });
        }
        rows = (Array.isArray(j.rows) ? j.rows : []).filter((r) => r && typeof r.id === 'string' && r.id.startsWith('codex:'));
        sig = signature(rows);
      }
    } catch { /* nothing kept yet, or a broken file: read again */ }
  }

  function save() {
    if (!cacheFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimer(() => {
      saveTimer = null;
      try {
        const times = [...lastActive.cache].map(([file, r]) => [file, r.size, r.mtimeMs, r.at, r.model || null]);
        const body = JSON.stringify({ v: CACHE_VERSION, savedAt: now(), heads: scanner.entries?.() || [], times, rows });
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, cacheFile);
      } catch (e) { log(`codex list: not saved: ${e.message || e}`); }
    }, SAVE_MS);
    saveTimer?.unref?.();
  }

  /** One pass: the rollouts' rows (BATCH new heads at most), timed by their last message. */
  async function pass() {
    const before = scanner.cacheSize();
    // One head at a time between turns of the event loop: the engine answers its window while this reads.
    const found = await scanner.rows(new Set(), { maxNew: BATCH, yieldEvery: 1 });
    const read = scanner.cacheSize() - before;
    await lastActive.apply(found, scanner.paths?.() || new Map());
    found.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    rows = found;
    const next = signature(found);
    if (next !== sig) {
      sig = next;
      save();
      try { onChange(); } catch (e) { log(`codex list: ${e.message || e}`); }
    }
    // More heads than one pass reads (the first run): the next pass soon, until they are all read.
    if (read >= BATCH) {
      clearTimeout(followTimer);
      followTimer = setTimer(() => { followTimer = null; refresh({ force: true }); }, FOLLOW_MS);
      followTimer?.unref?.();
    }
  }

  /** A background pass, unless one ran in the last REFRESH_MS (force: now) or one is running. */
  function refresh({ force = false } = {}) {
    if (running) return running;
    if (!force && now() < readyAt) {
      if (!firstScheduled) { firstScheduled = true; firstTimer = setTimer(() => refresh({ force: true }), readyAt - now()); firstTimer?.unref?.(); }
      return Promise.resolve();
    }
    if (!force && now() - lastRun < REFRESH_MS) return Promise.resolve();
    lastRun = now();
    running = pass().catch((e) => log(`codex list: ${e.message || e}`)).finally(() => { running = null; });
    return running;
  }

  /**
   * The rows to list now: the app-server's rows (serverRows, from the Codex view's thread/list) over the rollouts' for
   * the same thread (its name set in Codex wins; the time is the later of the two), then the rest, newest first.
   */
  function current(serverRows = []) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const s of serverRows || []) {
      if (!s?.id) continue;
      const r = byId.get(s.id);
      byId.set(s.id, r ? { ...r, ...s, lastModified: Math.max(s.lastModified || 0, r.lastModified || 0), size: s.size || r.size || 0, model: s.model || r.model, ...(r.codexArchived ? { codexArchived: true } : {}) } : s);
    }
    return [...byId.values()].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  }

  return {
    rows: current,
    refresh,
    /** Tests: wait for a pass that is running. */
    idle: () => running || Promise.resolve(),
    stop() { clearTimeout(followTimer); clearTimeout(saveTimer); clearTimeout(firstTimer); },
  };
}
