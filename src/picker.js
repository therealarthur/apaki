/**
 * picker.js
 *
 * Full-screen, searchable session picker for `latch` (Arthur, 2026-10-09:
 * "make latch interactable and searchable for finding sessions").
 *
 * - Type to filter: every word must appear in the session's title, first
 *   prompt, folder, id or git branch. Matches in the title rank first.
 * - Ctrl+F searches inside the conversations themselves (every transcript is
 *   scanned on demand, with a progress count) and shows a snippet per hit.
 * - Sessions open in a running Claude Code process are marked, from the live
 *   records Claude Code keeps in ~/.claude/sessions/<pid>.json.
 * - A preview pane shows the selected session's folder, size, age, and its
 *   first and latest prompts.
 *
 * Keys: type to search, Up/Down (or Ctrl+P/N), PgUp/PgDn, Enter opens,
 * Tab open-only, Ctrl+F search inside conversations, Ctrl+A include headless
 * sessions, Ctrl+U clear, Esc clears the search or quits, Ctrl+C quits.
 *
 * Input and output streams are injectable so the picker can be driven by tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CLAUDE_DIR } from './auth.js';
import { styler, useColor, visibleLength } from './render.js';
import { ago, listSessions, readTail } from './sessions.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');
const SNIPPET_BEFORE = 90;
const SNIPPET_AFTER = 180;

/* ---------- data ---------- */

/** Session id -> top-level transcript path, across all projects. */
export function transcriptMap(dir = PROJECTS_DIR) {
  const map = new Map();
  let projects = [];
  try { projects = fs.readdirSync(dir); } catch { return map; }
  for (const p of projects) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, p)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) map.set(f.slice(0, -6), path.join(dir, p, f));
  }
  return map;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Session id -> number of running Claude Code processes that have it open. */
export function openSessions(dir = LIVE_DIR, alive = pidAlive) {
  const open = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return open; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.sessionId && j.pid && alive(j.pid)) open.set(j.sessionId, (open.get(j.sessionId) || 0) + 1);
    } catch { /* a record being rewritten */ }
  }
  return open;
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Picker items from SDK session infos. */
export function toItems(infos, files, open) {
  return infos.map((s) => {
    const title = oneLine(s.customTitle || s.summary || s.firstPrompt || '(untitled)');
    const item = {
      id: s.sessionId,
      title,
      firstPrompt: oneLine(s.firstPrompt),
      cwd: s.cwd || '',
      branch: s.gitBranch || '',
      lastModified: s.lastModified || 0,
      size: s.fileSize || 0,
      file: files.get(s.sessionId) || null,
      open: open.get(s.sessionId) || 0,
    };
    item.titleLower = title.toLowerCase();
    item.hay = [item.id, title, item.firstPrompt, item.cwd, item.branch].join(' ').toLowerCase();
    return item;
  });
}

export function terms(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Items matching every word of the query: title matches first, then by recency. */
export function filterItems(items, query, { openOnly = false } = {}) {
  const words = terms(query);
  const hits = items.filter((it) => (!openOnly || it.open) && words.every((w) => it.hay.includes(w)));
  const rank = (it) => (words.length && words.every((w) => it.titleLower.includes(w)) ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b) || b.lastModified - a.lastModified);
}

/** Case variants of a word for a byte search: as typed, lower, upper, Capitalized. */
function variants(word) {
  const set = new Set([word, word.toLowerCase(), word.toUpperCase(), word[0].toUpperCase() + word.slice(1).toLowerCase()]);
  return [...set].map((v) => Buffer.from(v));
}

const NL = 0x0a;
const HEAD_BYTES = 240;
const USER_HEAD = Buffer.from('"type":"user"');
const ASSISTANT_HEAD = Buffer.from('"type":"assistant"');
const isWordByte = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

/**
 * What was said in one transcript entry: the user's typed text and the
 * assistant's reply text. Injected context (system reminders, attachments,
 * command records) and tool calls and results are left out, because every
 * session carries the same context and tool output is mostly noise.
 */
export function spokenText(e) {
  if (!e || !e.message || e.isMeta || e.isSidechain) return '';
  const c = e.message.content;
  const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '') : [];
  return parts
    .map((t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' '))
    .filter((t) => !/^\s*<(command-name|command-message|local-command-|task-notification|relayed-turns)/.test(t))
    .join(' ');
}

/** Index of `word` at a word start in lowercase `text`, or -1. */
function wordStart(text, word) {
  let at = text.indexOf(word);
  while (at >= 0) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1])) return at;
    at = text.indexOf(word, at + 1);
  }
  return -1;
}

/**
 * Finds every word, at a word start, in what was said in one transcript.
 * Scans the raw bytes for each word and parses only the user/assistant lines
 * that contain it, so even a 500 MB transcript takes well under a second.
 * Returns a snippet around the first word, or null.
 */
export function findSpoken(buf, words) {
  const parsed = new Map(); // line start -> lowercase spoken text
  let snippet = null;
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    let best = null; // earliest good hit across the case variants
    for (const v of variants(word)) {
      let found = false;
      let at = buf.indexOf(v);
      while (at >= 0 && !found && (!best || at < best.at)) {
        const prev = at > 0 ? buf[at - 1] : 0;
        // A JSON escape such as \n before the word still counts as a boundary.
        const boundary = !isWordByte(prev) || (at > 1 && buf[at - 2] === 0x5c);
        const lineStart = buf.lastIndexOf(NL, at) + 1;
        let lineEnd = buf.indexOf(NL, at);
        if (lineEnd < 0) lineEnd = buf.length;
        if (boundary) {
          if (!parsed.has(lineStart)) {
            const head = buf.subarray(lineStart, Math.min(lineEnd, lineStart + HEAD_BYTES));
            let text = '';
            if (head.indexOf(USER_HEAD) >= 0 || head.indexOf(ASSISTANT_HEAD) >= 0) {
              try { text = spokenText(JSON.parse(buf.subarray(lineStart, lineEnd).toString('utf8'))); } catch { /* partial line */ }
            }
            parsed.set(lineStart, { lower: text.toLowerCase(), text });
          }
          const line = parsed.get(lineStart);
          const pos = line.lower ? wordStart(line.lower, word) : -1;
          if (pos >= 0) {
            found = true;
            best = { at, text: line.text, pos };
            break;
          }
          // This line is done; continue after it.
          at = buf.indexOf(v, lineEnd);
        } else {
          at = buf.indexOf(v, at + v.length);
        }
      }
    }
    if (!best) return null;
    if (w === 0) snippet = oneLine(best.text.slice(Math.max(0, best.pos - SNIPPET_BEFORE), best.pos + word.length + SNIPPET_AFTER));
  }
  return snippet;
}

/**
 * Searches inside transcripts for sessions where every word was said (see
 * findSpoken). Calls onProgress(scanned, total) and onHit(id, snippet) as it
 * goes; returns a cancel function. Files are read one at a time so the UI
 * stays responsive.
 */
export function searchInside(items, query, { onProgress, onHit, onDone }) {
  const words = terms(query);
  let cancelled = false;
  (async () => {
    const list = items.filter((it) => it.file);
    for (let i = 0; i < list.length && !cancelled; i++) {
      let buf = null;
      try { buf = await fs.promises.readFile(list[i].file); } catch { /* deleted meanwhile */ }
      if (cancelled) return;
      if (buf && words.length) {
        const snippet = findSpoken(buf, words);
        if (snippet !== null) onHit(list[i].id, snippet);
      }
      onProgress(i + 1, list.length);
      // Let keypresses and redraws in between files.
      await new Promise((r) => setImmediate(r));
    }
    if (!cancelled) onDone();
  })();
  return () => { cancelled = true; };
}

/** The latest prompt the user typed in a transcript (not commands or tool results). */
export function lastPrompt(file) {
  const lines = readTail(file, 768 * 1024).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"user"')) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) continue;
    const c = e.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
    const t = oneLine(text);
    if (!t || /^<(command-|local-command|system-reminder|task-notification|relayed-turns)/.test(t) || /^Stop hook feedback/.test(t)) continue;
    return t;
  }
  return '';
}

/* ---------- drawing ---------- */

function truncate(s, width) {
  if (width <= 0) return '';
  return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}

function pad(s, width) {
  const len = visibleLength(s);
  return len >= width ? s : s + ' '.repeat(width - len);
}

/** Highlights each search word inside already-truncated plain text. */
function highlight(text, words, st) {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.replace(re, (m) => st.yellow(m));
}

function shortPath(p) {
  return p ? p.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~') : '';
}

function fmtSize(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/* ---------- the picker ---------- */

/**
 * Shows the picker and resolves with the chosen session id, or null when the
 * user quits.
 * @param {object} [o]
 * @param {string} [o.query]    initial search text
 * @param {string} [o.billing]  shown in the header
 * @param {object} [o.input]    keypress source (default process.stdin)
 * @param {object} [o.output]   terminal (default process.stdout)
 */
export async function pickSession({
  query = '', billing = '', input = process.stdin, output = process.stdout, loadInfos, files: fileMap, open: openMap,
} = {}) {
  const color = output === process.stdout ? useColor(output) : Boolean(output.color);
  const st = styler(color);
  const files = fileMap || transcriptMap();
  const liveOpen = () => openMap || openSessions();
  const load = loadInfos || ((programmatic) => listSessions({ limit: 5000, includeProgrammatic: programmatic }));
  const cache = new Map();
  const getItems = async (programmatic) => {
    if (!cache.has(programmatic)) cache.set(programmatic, toItems(await load(programmatic), files, liveOpen()));
    return cache.get(programmatic);
  };

  const state = {
    query, openOnly: false, programmatic: false, sel: 0, top: 0,
    items: await getItems(false), shown: [],
    inside: null, // { query, hits: Map, scanned, total, done, cancel }
  };
  const previews = new Map();

  const refilter = () => {
    if (state.inside && state.inside.query === state.query) {
      const hits = state.inside.hits;
      state.shown = state.items.filter((it) => hits.has(it.id) && (!state.openOnly || it.open))
        .sort((a, b) => b.lastModified - a.lastModified);
    } else {
      if (state.inside) { state.inside.cancel(); state.inside = null; }
      state.shown = filterItems(state.items, state.query, { openOnly: state.openOnly });
    }
    state.sel = Math.min(state.sel, Math.max(0, state.shown.length - 1));
  };

  const draw = () => {
    // One column short of the width: filling the last column makes some
    // Windows consoles wrap an extra line.
    const cols = Math.max(40, (output.columns || 100) - 1);
    const rows = Math.max(12, output.rows || 30);
    const previewH = rows >= 22 ? 5 : 3;
    const listH = Math.max(3, rows - 6 - previewH);
    if (state.sel < state.top) state.top = state.sel;
    if (state.sel >= state.top + listH) state.top = state.sel - listH + 1;
    const words = terms(state.query);
    const lines = [];

    const head = `${st.bold('latch')}  ${st.dim('pick a session to open in Claude Code')}`;
    const right = billing ? st.dim(`billing: ${billing}`) : '';
    lines.push(pad(head, cols - visibleLength(right)) + right);

    const tags = [];
    if (state.inside) {
      tags.push(state.inside.done ? `inside conversations: ${state.inside.hits.size} found` : `searching inside ${state.inside.scanned}/${state.inside.total}…`);
    }
    if (state.openOnly) tags.push('open only');
    if (state.programmatic) tags.push('incl. headless');
    const count = `${state.shown.length} of ${state.items.length}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
    const box = `${st.bold('›')} ${state.query}${st.dim('▏')}`;
    lines.push(pad(box, cols - count.length - 1) + st.dim(count));
    lines.push(st.dim('─'.repeat(cols)));

    const ageW = 5;
    const openW = 7;
    const folderW = Math.min(34, Math.max(12, Math.floor(cols * 0.28)));
    const titleW = cols - 2 - ageW - 1 - openW - 1 - folderW - 1;
    for (let r = 0; r < listH; r++) {
      const it = state.shown[state.top + r];
      if (!it) { lines.push(''); continue; }
      const selected = state.top + r === state.sel;
      const age = ago(Date.now() - it.lastModified).replace(' ago', '').padStart(ageW);
      const open = it.open ? st.green(pad(it.open > 1 ? `open ×${it.open}` : 'open', openW)) : ' '.repeat(openW);
      const title = highlight(truncate(it.title, titleW), words, st);
      const folder = st.dim(truncate(shortPath(it.cwd), folderW));
      let line = `${selected ? st.bold('›') : ' '} ${st.dim(age)} ${open} ${pad(selected ? st.bold(title) : title, titleW)} ${folder}`;
      if (selected && color) line = `\x1b[48;5;236m${pad(line, cols)}\x1b[49m`;
      lines.push(line);
    }

    lines.push(st.dim('─'.repeat(cols)));
    const it = state.shown[state.sel];
    const preview = [];
    if (it) {
      if (!previews.has(it.id)) previews.set(it.id, it.file ? lastPrompt(it.file) : '');
      preview.push(st.bold(truncate(it.title, cols)));
      preview.push(st.dim(truncate(`${it.id}  ·  ${it.cwd || '?'}  ·  ${fmtSize(it.size)}  ·  active ${ago(Date.now() - it.lastModified)}${it.branch ? `  ·  ${it.branch}` : ''}${it.open ? `  ·  open in ${it.open} window${it.open > 1 ? 's' : ''}` : ''}`, cols)));
      const snippet = state.inside && state.inside.hits.get(it.id);
      if (snippet) preview.push(highlight(truncate(`found: ${snippet}`, cols), words, st));
      preview.push(truncate(`first: ${it.firstPrompt || '-'}`, cols));
      preview.push(truncate(`last:  ${previews.get(it.id) || '-'}`, cols));
    } else {
      preview.push(st.dim(state.query ? 'No session matches. Ctrl+F searches inside the conversations.' : 'No sessions.'));
    }
    for (let i = 0; i < previewH; i++) lines.push(preview[i] || '');

    lines.push(st.dim(truncate('↑↓ move · Enter open · type to search · Ctrl+F inside conversations · Tab open only · Ctrl+A headless · Esc clear/quit', cols)));
    output.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
  };

  let drawTimer = null;
  const drawSoon = () => {
    if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = null; draw(); }, 60);
  };

  const startInside = () => {
    if (!terms(state.query).length) return;
    if (state.inside) state.inside.cancel();
    const run = { query: state.query, hits: new Map(), scanned: 0, total: 0, done: false, cancel: () => {} };
    state.inside = run;
    run.cancel = searchInside(state.items, state.query, {
      onProgress: (n, total) => { run.scanned = n; run.total = total; drawSoon(); },
      onHit: (id, snippet) => { run.hits.set(id, snippet); refilter(); drawSoon(); },
      onDone: () => { run.done = true; refilter(); drawSoon(); },
    });
    refilter();
  };

  return new Promise((resolve) => {
    const isTTY = Boolean(input.isTTY);
    readline.emitKeypressEvents(input);
    if (isTTY && input.setRawMode) input.setRawMode(true);
    output.write('\x1b[?1049h\x1b[?25l');

    const finish = (value) => {
      if (state.inside) state.inside.cancel();
      clearTimeout(drawTimer);
      input.removeListener('keypress', onKey);
      output.removeListener?.('resize', draw);
      if (isTTY && input.setRawMode) input.setRawMode(false);
      input.pause?.();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve(value);
    };

    const move = (d) => {
      state.sel = Math.max(0, Math.min(state.shown.length - 1, state.sel + d));
      draw();
    };

    async function onKey(str, key = {}) {
      const name = key.name;
      if (key.ctrl && name === 'c') return finish(null);
      if (name === 'return' || name === 'enter') return finish(state.shown[state.sel]?.id || null);
      if (name === 'escape') {
        if (state.query) { state.query = ''; state.sel = 0; refilter(); draw(); return undefined; }
        return finish(null);
      }
      if (name === 'up' || (key.ctrl && name === 'p')) return move(-1);
      if (name === 'down' || (key.ctrl && name === 'n')) return move(1);
      if (name === 'pageup') return move(-10);
      if (name === 'pagedown') return move(10);
      if (name === 'tab') { state.openOnly = !state.openOnly; state.sel = 0; refilter(); draw(); return undefined; }
      if (key.ctrl && name === 'f') { startInside(); draw(); return undefined; }
      if (key.ctrl && name === 'a') {
        state.programmatic = !state.programmatic;
        state.items = await getItems(state.programmatic);
        if (state.inside) startInside();
        refilter(); draw();
        return undefined;
      }
      if (key.ctrl && name === 'u') { state.query = ''; }
      else if (key.ctrl && name === 'w') { state.query = state.query.replace(/\S+\s*$/, ''); }
      else if (name === 'backspace') { state.query = state.query.slice(0, -1); }
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') { state.query += str; }
      else return undefined;
      state.sel = 0;
      state.top = 0;
      refilter();
      draw();
      return undefined;
    }

    input.on('keypress', onKey);
    output.on?.('resize', draw);
    input.resume?.();
    refilter();
    draw();
  });
}
