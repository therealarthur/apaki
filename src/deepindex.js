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

/* ---------- the long-running server (2026-10-09) ---------- */

/**
 * One `latch-index serve` process kept open, so a search reuses the open
 * keyword index, the meaning index and the loaded embedding model instead of
 * starting a process each time. Searches go by words AND meaning
 * (src/semantic.rs). Events (meaning-index progress) go to `onEvent`.
 *
 * Start it with startIndexServer(); searchHybrid() then uses it, and falls
 * back to the one-shot keyword search while it is not running.
 */
let server = null;

export function startIndexServer({ onEvent = () => {} } = {}) {
  if (server) return server;
  const bin = indexBin();
  if (!bin) return null;
  let child;
  try {
    child = spawn(bin, ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const pending = new Map();
  let seq = 0;
  let buf = '';
  const s = {
    child,
    ready: false,
    call(op, args = {}, timeoutMs = 15000) {
      return new Promise((resolve) => {
        if (!s.alive) { resolve(null); return; }
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
        pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
        try { child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
      });
    },
    alive: true,
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.id != null && pending.has(j.id)) { const r = pending.get(j.id); pending.delete(j.id); r(j); continue; }
      if (j.ev === 'ready') s.ready = true;
      if (j.ev) onEvent(j);
    }
  });
  const gone = () => {
    s.alive = false;
    for (const r of pending.values()) r(null);
    pending.clear();
    if (server === s) server = null;
  };
  child.on('exit', gone);
  child.on('error', gone);
  server = s;
  return s;
}

export function stopIndexServer() {
  if (!server) return;
  try { server.child.stdin.end(`${JSON.stringify({ op: 'quit' })}\n`); } catch { /* gone */ }
  server = null;
}

/**
 * Sessions matching `query` by words and by meaning, best first:
 * { sessions: [{ session, sources: ['words'|'meaning'], hits, kind, snippet, latest, file }],
 *   terms, semantic, passages, elapsed_ms }. Falls back to the keyword-only
 * search (with semantic: false) when the server is not running.
 */
export async function searchHybrid(query, { limit = 80 } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (server?.alive) {
    const r = await server.call('search', { query: q, limit });
    if (r?.ok) return r;
  }
  const r = await searchIndex(q, { limit });
  return r ? { ...r, semantic: false, sessions: r.sessions.map((x) => ({ ...x, sources: ['words'] })) } : null;
}

/** Keyword and meaning update in the server (progress arrives as events); false when no server. */
export async function updateViaServer() {
  if (!server?.alive) return false;
  const r = await server.call('update', {}, 10000);
  return Boolean(r?.ok);
}

/** Short label for where in a conversation a match was found. */
export function kindLabel(kind = '') {
  const agent = kind.startsWith('agent-');
  const base = agent ? kind.slice(6) : kind;
  const label = { prompt: 'you', reply: 'claude', tool: 'tool call', result: 'tool output' }[base] || base;
  return agent ? `subagent ${label}` : label;
}
