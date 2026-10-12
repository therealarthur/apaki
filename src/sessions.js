/**
 * sessions.js
 *
 * Finding a Claude Code session and the few facts latch needs from its
 * transcript (~/.claude/projects/<project>/<session-id>.jsonl): which file it
 * is, the model it last used, its running cost, and whether something else
 * wrote to it recently. Listing and titles come from the SDK.
 *
 * Also the owner lock: one latch per session, so two latches never append to
 * the same transcript at once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_DIR } from './auth.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LOCK_DIR = path.join(CLAUDE_DIR, 'latch', 'locks');

export { getSessionInfo, listSessions };

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Transcript files whose session id starts with `prefix`, across all projects. */
export function findSessionFiles(prefix) {
  const want = prefix.toLowerCase();
  const hits = [];
  for (const project of safeReaddir(PROJECTS_DIR)) {
    for (const name of safeReaddir(path.join(PROJECTS_DIR, project))) {
      if (name.endsWith('.jsonl') && name.toLowerCase().startsWith(want)) hits.push(path.join(PROJECTS_DIR, project, name));
    }
  }
  return hits;
}

export function sessionIdOf(file) {
  return path.basename(file, '.jsonl');
}

/** Last `bytes` of a file as text ('' when unreadable). */
export function readTail(file, bytes = 2 * 1024 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Model of the last assistant message, so latch continues on the same model. */
export function lastModel(text) {
  const all = [...text.matchAll(/"model":"(claude-[^"]+)"/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * The session's running cost from its last cost-state entry. A resumed run
 * restores that total and reports total_cost_usd on top of it, so a turn's
 * own cost is the difference.
 */
export function lastCostTotal(text) {
  const all = [...text.matchAll(/"type":"cost-state"[^\n]*?"totalCostUSD":([0-9.eE+-]+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : 0;
}

/** Milliseconds since the transcript last changed, or null when it does not exist. */
export function idleMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return null; }
}

export function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/* ---------- owner lock ---------- */

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Who this process is, written into every lock it takes so a blocked window
// can say who has the session ("latch in a terminal", "Myrlin Apaki").
// Locks from before 2026-10-09 evening carry only { pid, at }.
let lockApp = process.env.LATCH_LOCK_APP || 'latch';
export function setLockApp(app) { lockApp = app; }

// apaki-console and apaki-terminal (2026-10-12, apaki/engine/console.js): a pane's console, and an "Open in terminal" window.
const APP_NAMES = { apaki: 'Myrlin Apaki', latch: 'latch', 'latch-relay': 'a latch terminal window', 'apaki-console': 'the console in Myrlin Apaki', 'apaki-terminal': 'a terminal window (Open in terminal)' };
export const lockAppName = (app) => APP_NAMES[app] || 'another latch';

/**
 * Takes the lock for `sessionId`. Returns null on success, or the holder's
 * pid when another live latch holds it. A lock left by a dead process is taken over.
 * A forced take records who it was taken from, so that holder can tell it lost
 * the session (see lockStolen).
 */
export function takeLock(sessionId, { force = false, app = lockApp } = {}) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, `${sessionId}.json`);
  let from = null;
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (held.pid !== process.pid && pidAlive(held.pid)) {
      if (!force) return held.pid;
      from = { pid: held.pid, app: held.app || null, at: held.at || null };
    }
  } catch { /* no lock or unreadable: take it */ }
  const rec = { pid: process.pid, app, at: new Date().toISOString() };
  if (from) rec.takenFrom = from;
  fs.writeFileSync(file, JSON.stringify(rec));
  return null;
}

/** The lock record for a session with `alive` filled in, or null when nobody holds it. */
export function lockInfo(sessionId) {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, `${sessionId}.json`), 'utf8'));
    return { ...held, alive: pidAlive(held.pid), name: lockAppName(held.app) };
  } catch {
    return null;
  }
}

/**
 * The live holder that took this session away from process `pid` (default:
 * this process), or null while `pid` still holds it or nobody else is alive
 * on it. Writers call it before every message so a takeover can never fork
 * the conversation.
 */
export function lockStolen(sessionId, pid = process.pid) {
  const held = lockInfo(sessionId);
  if (!held || held.pid === pid || !held.alive) return null;
  return held;
}

export function releaseLock(sessionId) {
  const file = path.join(LOCK_DIR, `${sessionId}.json`);
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (held.pid === process.pid) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

/** "3m ago" style age. */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ---------- sessions latch created, and windows that have a session open ---------- */

const CREATED_FILE = path.join(CLAUDE_DIR, 'latch', 'created.json');
const LIVE_RECORDS_DIR = path.join(CLAUDE_DIR, 'sessions');

/**
 * Remembers a session latch started. Its first entry comes from the Agent SDK,
 * so session lists that hide headless sessions would hide it too; latch's
 * picker shows the ones listed here.
 */
export function rememberCreated(id) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(CREATED_FILE, 'utf8')); } catch { /* first one */ }
  all[id] = new Date().toISOString();
  fs.mkdirSync(path.dirname(CREATED_FILE), { recursive: true });
  fs.writeFileSync(CREATED_FILE, JSON.stringify(all, null, 2));
}

export function createdSessions() {
  try { return new Set(Object.keys(JSON.parse(fs.readFileSync(CREATED_FILE, 'utf8')))); } catch { return new Set(); }
}

/**
 * Interactive Claude Code windows that have `sessionId` open, from the live
 * records Claude Code keeps in ~/.claude/sessions/<pid>.json: [{ pid, startedAt }].
 */
export function windowsWith(sessionId, dir = LIVE_RECORDS_DIR) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (rec.sessionId === sessionId && rec.entrypoint === 'cli' && rec.kind !== 'daemon' && pidAlive(rec.pid)) out.push({ pid: rec.pid, startedAt: rec.startedAt });
    } catch { /* partial write */ }
  }
  return out;
}
