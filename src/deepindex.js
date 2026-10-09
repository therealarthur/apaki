/**
 * deepindex.js
 *
 * Node side of latch-index (index/, Rust): a full-text index over every
 * Claude Code transcript on this machine, subagents included. The picker uses
 * it to search inside all conversations as you type (Arthur, 2026-10-09: "deep,
 * thorough and system wide ... within 3 seconds").
 *
 * The binary is found at LATCH_INDEX_BIN, else index/target/release. When it is
 * missing (or LATCH_NO_INDEX=1, used by the tests) every function here reports
 * unavailable and the picker falls back to its file-by-file scan.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.platform === 'win32' ? 'latch-index.exe' : 'latch-index';

export function indexBin() {
  if (process.env.LATCH_NO_INDEX === '1') return null;
  const candidates = [process.env.LATCH_INDEX_BIN, path.join(REPO, 'index', 'target', 'release', EXE)].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Runs the binary and resolves with its JSON result, or null on any failure. */
function run(args, timeoutMs) {
  const bin = indexBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || '';
      try {
        const j = JSON.parse(line);
        resolve(j && j.ok ? j : null);
      } catch {
        resolve(null);
      }
    });
  });
}

let updating = null;

/**
 * Brings the index up to date (reads only what changed since last time).
 * Concurrent callers share one run. The first build ever can take minutes.
 */
export function updateIndex({ timeoutMs = 30 * 60 * 1000 } = {}) {
  if (!updating) updating = run(['update'], timeoutMs).finally(() => { updating = null; });
  return updating;
}

/**
 * Sessions matching every word of `query`, best first:
 * { sessions: [{ session, hits, kind, snippet, ts, latest, file }], total_hits, elapsed_ms }.
 */
export function searchIndex(query, { limit = 60, timeoutMs = 15000 } = {}) {
  const words = String(query || '').trim();
  if (!words) return Promise.resolve(null);
  return run(['search', ...words.split(/\s+/), '--limit', String(limit)], timeoutMs);
}

export function indexStatus() {
  return run(['status'], 15000);
}

/** Short label for where in a conversation a match was found. */
export function kindLabel(kind = '') {
  const agent = kind.startsWith('agent-');
  const base = agent ? kind.slice(6) : kind;
  const label = { prompt: 'you', reply: 'claude', tool: 'tool call', result: 'tool output' }[base] || base;
  return agent ? `subagent ${label}` : label;
}
