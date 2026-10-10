/**
 * places.js
 *
 * Where a new conversation starts. Arthur, 2026-10-09: the default should be
 * the home folder (where a terminal opens), with a choice of the most recent
 * and most used session folders (Claude Code and Codex), and the freedom to
 * browse anywhere on disk and create a folder there.
 *
 *   folderStats(claudeItems)  recent and most used folders, from Claude Code
 *                             sessions (their cwd) and Codex rollouts (the
 *                             cwd in each file's session_meta line)
 *   listDir(dir)              the subfolders of a folder, plus drives
 *   makeDir(parent, name)     creates one folder (no nested paths)
 *
 * Folders that no longer exist and scratch folders under the system temp
 * directory are left out of the lists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_DIR = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'sessions') : path.join(os.homedir(), '.codex', 'sessions');
const HEAD_BYTES = 64 * 1024;
const WIN = process.platform === 'win32';

export const homeDir = () => os.homedir();

/** A comparable form of a path: resolved, no trailing separator, case-folded on Windows. */
export function pathKey(p) {
  const r = path.resolve(String(p || '')).replace(/[\\/]+$/, '');
  return WIN ? r.toLowerCase() : r;
}

function isScratch(p) {
  const k = pathKey(p);
  const tmp = pathKey(os.tmpdir());
  return k === tmp || k.startsWith(tmp + path.sep);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/* ---------- Codex: cwd from each rollout's first line, cached by mtime ---------- */

const codexCache = new Map(); // file -> { mtimeMs, cwd }

function* walk(dir, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) yield* walk(p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function codexCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.includes('"session_meta"')) continue;
        try { return JSON.parse(line).payload?.cwd || ''; } catch { return ''; }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* unreadable */ }
  return '';
}

/** Codex sessions as { cwd, lastModified }. */
export function codexSessions(dir = CODEX_DIR) {
  const out = [];
  for (const file of walk(dir)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let c = codexCache.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs) { c = { mtimeMs: st.mtimeMs, cwd: codexCwd(file) }; codexCache.set(file, c); }
    if (c.cwd) out.push({ cwd: c.cwd, lastModified: st.mtimeMs });
  }
  return out;
}

/* ---------- stats ---------- */

/**
 * Recent and most used session folders.
 * @param {Array<{cwd: string, lastModified: number}>} claudeItems  Claude Code sessions
 * @param {object} [o] { codex: include Codex rollouts (default true), limit (default 8) }
 * @returns {{ home: string, recent: Place[], used: Place[] }}
 *   Place = { path, name, last, count, days, claude, codex }
 */
export function folderStats(claudeItems = [], { codex = true, limit = 8, codexItems } = {}) {
  const by = new Map();
  const add = (cwd, last, kind) => {
    if (!cwd) return;
    const k = pathKey(cwd);
    let f = by.get(k);
    if (!f) { f = { path: path.resolve(cwd), last: 0, count: 0, claude: 0, codex: 0, days: new Set() }; by.set(k, f); }
    f.count++;
    if (last) f.days.add(new Date(last).toISOString().slice(0, 10));
    f[kind]++;
    if (last > f.last) { f.last = last; f.path = path.resolve(cwd); }
  };
  for (const it of claudeItems) add(it.cwd, it.lastModified || 0, 'claude');
  if (codex) for (const it of codexItems || codexSessions()) add(it.cwd, it.lastModified || 0, 'codex');
  const home = pathKey(os.homedir());
  // Home is offered on its own, as the default, so the lists skip it.
  const places = [...by.values()]
    .filter((f) => pathKey(f.path) !== home && !isScratch(f.path) && isDir(f.path))
    .map((f) => ({ ...f, days: f.days.size, name: path.basename(f.path) || f.path }));
  const recent = [...places].sort((a, b) => b.last - a.last).slice(0, limit);
  // "Most used" counts days with activity, not sessions: an automated worker
  // that starts hundreds of sessions in one folder in a week should not
  // outrank a project you open every day.
  const used = [...places].sort((a, b) => b.days - a.days || b.count - a.count || b.last - a.last).slice(0, limit);
  return { home: os.homedir(), recent, used };
}

/* ---------- browsing ---------- */

/** Drive roots on Windows (C:\, D:\ ...); ['/'] elsewhere. */
export function drives() {
  if (!WIN) return ['/'];
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z; A and B are floppy letters
    const d = `${String.fromCharCode(c)}:\\`;
    try { fs.accessSync(d); out.push(d); } catch { /* no such drive */ }
  }
  return out;
}

/**
 * The subfolders of `dir`, sorted by name. Hidden folders (dot names, and on
 * Windows the system ones) are marked so the UI can tuck them away.
 */
export function listDir(dir) {
  const at = path.resolve(dir || os.homedir());
  let entries;
  try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch (e) {
    const why = { EPERM: 'No access to this folder', EACCES: 'No access to this folder', ENOENT: 'No such folder', ENOTDIR: 'That is a file, not a folder' }[e.code] || e.message;
    return { path: at, error: why, dirs: [], drives: drives() };
  }
  const SYSTEM = new Set(['$recycle.bin', 'system volume information', 'recovery', 'config.msi', '$windows.~bt', '$winreagent']);
  const dirs = entries
    .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(at, e.name))))
    .map((e) => ({ name: e.name, hidden: e.name.startsWith('.') || SYSTEM.has(e.name.toLowerCase()) || /^ntuser/i.test(e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const parent = path.dirname(at);
  return { path: at, parent: parent === at ? null : parent, dirs, drives: drives(), home: os.homedir() };
}

const BAD_NAME = WIN ? /[<>:"/\\|?*\x00-\x1f]/ : /[/\x00]/;

/** Creates `name` inside `parent`. Returns { path } or { error }. */
export function makeDir(parent, name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..') return { error: 'Give the folder a name.' };
  if (BAD_NAME.test(n) || (WIN && /[. ]$/.test(n))) return { error: WIN ? 'A folder name cannot contain < > : " / \\ | ? * or end with a dot or space.' : 'A folder name cannot contain /.' };
  const at = path.join(path.resolve(parent), n);
  try {
    fs.mkdirSync(at);
    return { path: at };
  } catch (e) {
    return { error: e.code === 'EEXIST' ? `${n} already exists here.` : e.code === 'EPERM' || e.code === 'EACCES' ? 'No permission to create a folder here.' : e.message };
  }
}
