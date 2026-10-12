/**
 * codex-rollouts.js: Codex threads found in the rollout files, 2026-10-12. READ ONLY.
 *
 * WHY: thread/list (the app-server's own list) is what the Codex app shows, but a rollout can exist that it does not
 * list: a thread another build wrote, one whose state database row is gone, an archived one. CODEX.md asked for every
 * Codex thread on the PC, so the Codex view also reads ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl and
 * ~/.codex/archived_sessions, and lists the ids the server did not. A listed row opens like any other (thread/resume by
 * id; the server reads the same file).
 *
 * Nothing is ever written under ~/.codex (or $CODEX_HOME): this only lists directories and reads the head of a file
 * (the first prompt and the folder, through src/codex.js codexMeta, the reader the search uses). What it learns is kept
 * in memory by file, size and time, so a refresh reads only files that are new or changed.
 *
 *   const scan = createRolloutScanner({ home });
 *   const rows = await scan.rows(knownIds)   rows shaped like codex-map.js threadRow, plus source: 'rollout'
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codexMeta } from '../../src/codex.js';

const FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_DEPTH = 4;
const MAX_FILES = 4000;
/** Files whose head is read in one call; the rest follow on the next refresh (the cache keeps what was read). */
const MAX_NEW_PER_CALL = 250;

/** The two folders Codex keeps rollouts in, under $CODEX_HOME or ~/.codex. */
export function rolloutRoots(home = os.homedir(), env = process.env) {
  const base = env.CODEX_HOME || path.join(home, '.codex');
  return [{ dir: path.join(base, 'sessions'), archived: false }, { dir: path.join(base, 'archived_sessions'), archived: true }];
}

/** Rollout files under a root, in no particular order: [{ file, id, mtimeMs, size, archived }]. */
function walk(root, out, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES * 2) return;
    const full = path.join(root.dir, e.name);
    if (e.isDirectory()) { if (depth < MAX_DEPTH) walk({ ...root, dir: full }, out, depth + 1); continue; }
    const m = FILE_RE.exec(e.name);
    if (!m) continue;
    try {
      const st = fs.statSync(full);
      out.push({ file: full, id: m[1].toLowerCase(), mtimeMs: st.mtimeMs, size: st.size, archived: root.archived });
    } catch { /* gone while listing */ }
  }
}

export function createRolloutScanner({ home = os.homedir(), env = process.env, roots = null } = {}) {
  const where = roots || rolloutRoots(home, env);
  /** file -> { key, row }: what was read from a file the last time its size and time were as now. */
  const cache = new Map();
  /** codex:<id> -> its rollout file, from the last walk (rows()). */
  const paths = new Map();

  /**
   * Rows for the threads the server did not list. `known` holds the codex:<id> ids the server listed; a rollout
   * of one of those is left to the server's row. Up to MAX_NEW_PER_CALL new files are read per call (maxNew: fewer,
   * for the main list's background passes, codex-list.js).
   */
  async function rows(known = new Set(), { maxNew = MAX_NEW_PER_CALL } = {}) {
    const files = [];
    for (const r of where) walk(r, files);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Every rollout seen, newest first wins (2026-10-12): the list reads each thread's last message time from its file.
    paths.clear();
    for (const f of files) if (!paths.has(`codex:${f.id}`)) paths.set(`codex:${f.id}`, f.file);
    const out = [];
    const seen = new Set();
    let read = 0;
    for (const f of files.slice(0, MAX_FILES)) {
      const cid = `codex:${f.id}`;
      if (known.has(cid) || seen.has(cid)) continue;
      seen.add(cid);
      const key = `${f.size}:${f.mtimeMs}`;
      let hit = cache.get(f.file);
      if (!hit || hit.key !== key) {
        if (read >= maxNew) continue;
        read += 1;
        if (read % 20 === 0) await new Promise((r) => setImmediate(r));
        const meta = codexMeta(f.file);
        hit = { key, meta };
        cache.set(f.file, hit);
      }
      out.push({
        id: cid, title: hit.meta.title || 'Codex thread', firstPrompt: hit.meta.title || '', cwd: hit.meta.cwd || '', branch: '',
        // size: the rollout's bytes (2026-10-12), for the list's hover card.
        lastModified: f.mtimeMs, size: f.size || 0, codex: true, source: 'rollout', ...(f.archived ? { codexArchived: true } : {}),
      });
    }
    return out;
  }

  return {
    rows, roots: where, cacheSize: () => cache.size, paths: () => paths,
    /** The heads read so far, to keep across restarts (codex-list.js): [[file, key, meta]]. */
    entries: () => [...cache].map(([file, hit]) => [file, hit.key, hit.meta]),
    /** Seeds the cache from kept entries; a file whose size or time changed since is read again. */
    seed(list) {
      for (const e of Array.isArray(list) ? list : []) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string' || !e[2] || typeof e[2] !== 'object' || cache.has(e[0])) continue;
        cache.set(e[0], { key: e[1], meta: { title: String(e[2].title || ''), cwd: String(e[2].cwd || ''), startedAt: Number(e[2].startedAt) || 0 } });
      }
    },
  };
}
