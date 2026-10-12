/**
 * session-info.js: everything Apaki can tell about one conversation, for the session list's Details sheet, its
 * Export as Markdown and its Open in a terminal (2026-10-12). READ ONLY: nothing here writes a transcript or a rollout.
 *
 * WHY (Arthur, 2026-10-12): "the sessions listed should be a bit more compact but when selected or right clicked have
 * more information available ... all information available somewhere in details/properties when right clicking". The
 * session list carries only what a row shows (title, folder, branch, last message time, size). Details reads the rest
 * from the conversation's own file when it is asked for:
 *
 *   scanClaude(file)   one pass over a Claude Code transcript: created and last message times, prompts (counted the way
 *                      a pane draws them, history.js isPromptItem), replies, tool calls, compactions, the models used and
 *                      the last one, Claude Code's version, the git branch and folder it last ran in, its names (custom
 *                      title, summary) and the tokens of its replies (each API message counted once).
 *   scanCodex(file)    the same from a Codex rollout (~/.codex/sessions/.../rollout-*.jsonl): session_meta, turn_context
 *                      (model and effort), response_item messages and function calls, the last token_count.
 *   findRollout(id)    the rollout file of a codex:<thread id>, in sessions or archived_sessions.
 *   diskSize(file, id) the transcript and the folder Claude Code keeps beside it (<project>/<id>/: subagents, tool output).
 *
 * And for the menu's actions:
 *   historyMarkdown(items, meta)   a built history (history.js buildHistory) as a Markdown document
 *   codexMarkdown(text, meta)      a rollout as a Markdown document
 *   exportName(title, id)          a safe file name for it
 *   resumeCommand(platform, ...)   what opens a terminal that resumes it (claude --resume, codex resume); pure, tested
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { codexPromptText } from '../../src/codex.js';
import { isPromptItem, promptOf } from './history.js';
import { rolloutRoots } from './codex-rollouts.js';

/** A Claude Code session id, or a Codex one (codex:<thread id>). */
export const SESSION_ID_RE = /^(?:codex:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most entries walked when sizing a session's side folder (a runaway folder is reported as at least this much). */
const MAX_WALK = 20000;
/** Exported Markdown is cut here (a phone gets it inline). */
export const EXPORT_MAX_CHARS = 4 * 1024 * 1024;

const str = (v) => (typeof v === 'string' ? v : '');
const timeOf = (v) => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };

/** Reads a JSON-lines file line by line (a line can be megabytes: images, long tool output). */
async function eachLine(file, fn) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.charCodeAt(0) !== 123) continue; // '{'
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      fn(j);
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

/** True for a block list (or string) with words in it. */
const hasText = (content) => (typeof content === 'string' ? Boolean(content.trim()) : Array.isArray(content) && content.some((b) => b?.type === 'text' && str(b.text).trim()));

/**
 * One pass over a Claude Code transcript. Lines of subagents (isSidechain) and Claude Code's own bookkeeping
 * (isMeta, the compaction summary) are not counted as prompts or replies.
 */
export async function scanClaude(file) {
  const out = {
    created: 0, lastActive: 0, firstAt: 0, prompts: 0, replies: 0, toolCalls: 0, compactions: 0,
    model: '', models: [], version: '', gitBranch: '', cwd: '', customTitle: '', summary: '', firstPrompt: '',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lines: 0,
  };
  const usage = new Map(); // API message id -> its usage (the last line of a message carries the final numbers)
  const replied = new Set();
  const models = new Set();
  // A local command's run (history.js localCommandRuns): a caveat meta line, the command's record, its output lines.
  // 0: none, 1: after a caveat, 2: after the record. Its record is not a prompt; a slash command Claude answers is.
  let localRun = 0;
  const lastText = (c) => (Array.isArray(c) ? [...c].reverse().find((b) => b?.type === 'text')?.text : typeof c === 'string' ? c : '') || '';
  await eachLine(file, (j) => {
    out.lines += 1;
    const t = timeOf(j.timestamp);
    if (t && (!out.firstAt || t < out.firstAt)) out.firstAt = t;
    if (typeof j.version === 'string' && j.version) out.version = j.version;
    if (typeof j.gitBranch === 'string' && j.gitBranch) out.gitBranch = j.gitBranch;
    if (typeof j.cwd === 'string' && j.cwd && !j.isSidechain) out.cwd = j.cwd;
    if (j.type === 'custom-title' && j.customTitle) out.customTitle = String(j.customTitle).slice(0, 200);
    if (j.type === 'summary' && j.summary && !out.summary) out.summary = String(j.summary).slice(0, 200);
    if (j.type === 'system' && j.subtype === 'compact_boundary' && !j.isSidechain) out.compactions += 1;
    if (j.isSidechain || (j.type !== 'user' && j.type !== 'assistant')) return;
    if (t && (!out.created || t < out.created)) out.created = t;
    if (t && t > out.lastActive) out.lastActive = t;
    const m = j.message && typeof j.message === 'object' ? j.message : {};
    if (j.type === 'user') {
      const tail = lastText(m.content);
      if (j.isMeta) { if (tail.startsWith('<local-command-caveat>')) localRun = 1; return; }
      if (j.isCompactSummary) return;
      let local = false;
      if (localRun === 1 && tail.startsWith('<command-name>')) { local = true; localRun = 2; }
      else if (localRun === 2 && (tail.startsWith('<local-command-stdout>') || tail.startsWith('<local-command-stderr>'))) local = true;
      else localRun = 0;
      // The pane's own rule (history.js promptOf, 2026-10-12): your words, pictures, a slash command Claude answers.
      const p = promptOf({ type: 'user', message: { content: m.content } }, { localRun: local });
      if (p) {
        out.prompts += 1;
        if (!out.firstPrompt && p.text) out.firstPrompt = p.text.replace(/\s+/g, ' ').trim().slice(0, 200);
      }
      return;
    }
    localRun = 0;
    const id = str(m.id) || str(j.uuid);
    if (Array.isArray(m.content)) out.toolCalls += m.content.filter((b) => b?.type === 'tool_use' || b?.type === 'server_tool_use').length;
    if (hasText(m.content) && !replied.has(id)) { replied.add(id); out.replies += 1; }
    if (m.model && m.model !== '<synthetic>') { out.model = m.model; models.add(m.model); }
    if (m.usage && typeof m.usage === 'object') usage.set(id, m.usage);
  });
  for (const u of usage.values()) {
    out.tokens.input += Number(u.input_tokens) || 0;
    out.tokens.output += Number(u.output_tokens) || 0;
    out.tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;
    out.tokens.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
  }
  out.models = [...models];
  return out;
}

/** The words of a Codex message's content (input_text, output_text, text). */
const codexText = (content) => (Array.isArray(content) ? content.map((c) => str(c?.text)).join('\n') : str(content));

/** One pass over a Codex rollout. */
export async function scanCodex(file) {
  const out = {
    created: 0, lastActive: 0, prompts: 0, replies: 0, toolCalls: 0, compactions: 0,
    model: '', models: [], effort: '', version: '', originator: '', gitBranch: '', cwd: '', firstPrompt: '',
    approval: '', sandbox: '', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, lines: 0,
  };
  const models = new Set();
  await eachLine(file, (e) => {
    out.lines += 1;
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const t = timeOf(e.timestamp);
    if (e.type === 'session_meta') {
      out.created = timeOf(p.timestamp) || t || out.created;
      out.cwd = str(p.cwd) || out.cwd;
      out.version = str(p.cli_version) || out.version;
      out.originator = str(p.originator) || out.originator;
      out.gitBranch = str(p.git?.branch) || out.gitBranch;
      return;
    }
    if (e.type === 'turn_context') {
      if (p.model) { out.model = str(p.model); models.add(out.model); }
      if (p.effort || p.reasoning_effort) out.effort = str(p.effort || p.reasoning_effort);
      if (p.cwd) out.cwd = str(p.cwd);
      if (p.approval_policy) out.approval = str(p.approval_policy);
      const sb = p.sandbox_policy;
      if (sb) out.sandbox = typeof sb === 'string' ? sb : str(sb.mode || sb.type);
      return;
    }
    if (e.type === 'compacted' || (e.type === 'event_msg' && p.type === 'context_compacted')) { out.compactions += 1; return; }
    if (e.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const u = p.info.total_token_usage;
      out.tokens = {
        input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cached_input_tokens) || 0,
        cacheWrite: 0, reasoning: Number(u.reasoning_output_tokens) || 0,
      };
      return;
    }
    if (e.type !== 'response_item') return;
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'web_search_call') { out.toolCalls += 1; return; }
    if (p.type !== 'message') return;
    if (p.role === 'user') {
      const words = codexPromptText(codexText(p.content)) || (Array.isArray(p.content) ? p.content.map((c) => codexPromptText(c?.text)).find(Boolean) : '');
      if (!words) return;
      out.prompts += 1;
      if (!out.firstPrompt) out.firstPrompt = words.slice(0, 200);
      if (t > out.lastActive) out.lastActive = t;
    } else if (p.role === 'assistant') {
      if (!codexText(p.content).trim()) return;
      out.replies += 1;
      if (t > out.lastActive) out.lastActive = t;
    }
  });
  out.models = [...models];
  return out;
}

/** The rollout file of a Codex thread (codex:<id> or the bare id), or null. */
export function findRollout(id, roots = rolloutRoots()) {
  const tid = String(id || '').replace(/^codex:/, '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tid)) return null;
  const tail = `-${tid}.jsonl`;
  let seen = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // Newest first: the date folders sort by name.
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      if (++seen > MAX_WALK * 2) return null;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) { const hit = walk(full, depth + 1); if (hit) return hit; } continue; }
      if (e.name.toLowerCase().endsWith(tail) && e.name.startsWith('rollout-')) return full;
    }
    return null;
  };
  for (const r of roots) {
    const file = walk(r.dir, 0);
    if (file) return { file, archived: Boolean(r.archived) };
  }
  return null;
}

/** Bytes of a file, or 0. */
export function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Bytes under a folder (walked up to MAX_WALK entries), or 0 when it is not there. */
export function folderSize(dir) {
  let total = 0;
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++n > MAX_WALK) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else total += fileSize(full);
    }
  };
  walk(dir);
  return total;
}

/** A Claude Code transcript's size and the size of the folder Claude Code keeps beside it (<project>/<id>/). */
export function diskSize(file, id) {
  const size = fileSize(file);
  const side = id ? folderSize(path.join(path.dirname(file), String(id))) : 0;
  return { size, side, total: size + side };
}

/* ---------- Export as Markdown ---------- */

const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '');

/** One line for a tool call: its name and the input a person recognises (a command, a file, a search). */
export function toolLine(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '';
  let what = typeof pick === 'string' ? pick : Array.isArray(pick) ? pick.join(' ') : '';
  if (!what) { try { what = JSON.stringify(i); } catch { what = ''; } }
  what = what.replace(/\s+/g, ' ').trim();
  if (what.length > 160) what = `${what.slice(0, 157)}...`;
  return `- Tool: **${String(name || 'tool')}**${what ? ` \`${what.replace(/`/g, "'")}\`` : ''}`;
}

/** The header every export starts with. */
function exportHead(meta = {}) {
  const lines = [`# ${String(meta.title || 'Conversation').replace(/\s+/g, ' ').trim()}`, ''];
  const rows = [
    ['Session', meta.id],
    ['Agent', meta.provider === 'codex' ? 'Codex' : 'Claude Code'],
    ['Folder', meta.cwd],
    ['Branch', meta.branch],
    ['Model', meta.model],
    ['Started', iso(meta.created)],
    ['Last message', iso(meta.lastActive)],
    ['Exported', `${iso(meta.now || Date.now())} by Myrlin Apaki`],
  ].filter(([, v]) => v);
  for (const [k, v] of rows) lines.push(`- ${k}: ${k === 'Session' || k === 'Folder' ? `\`${v}\`` : v}`);
  lines.push('', '---', '');
  return lines;
}

/**
 * A built Claude Code history (history.js buildHistory items) as Markdown: your prompts and Claude's replies in order,
 * each tool call as one line under the reply that made it, compactions marked. Tool output, thinking and Claude Code's
 * own notices are left out: the export is the conversation, not the log.
 */
export function historyMarkdown(items = [], meta = {}) {
  const out = exportHead({ ...meta, provider: 'claude' });
  let who = null;
  for (const it of items) {
    if (it?.type === 'compact') { out.push('', '*The conversation was compacted here.*', ''); who = null; continue; }
    if (it?.type !== 'user' && it?.type !== 'assistant') continue;
    const content = it.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (it.type === 'user') {
      if (!isPromptItem(it)) continue;
      // The prompt as the pane shows it (history.js marks it: reminders out, a slash command as "/name args").
      const p = it.prompt || promptOf(it);
      const text = (p?.text ?? blocks.filter((b) => b?.type === 'text').map((b) => String(b.text || '')).join('\n\n')).trim();
      const images = p?.images ?? blocks.filter((b) => b?.type === 'image' || b?.type === 'image_marker').length;
      out.push(`## You${it.at ? ` (${iso(timeOf(it.at))})` : ''}`, '', text || '', ...(images ? ['', `*${images} image${images === 1 ? '' : 's'} attached*`] : []), '');
      who = 'you';
      continue;
    }
    const parts = [];
    for (const b of blocks) {
      if (b?.type === 'text' && String(b.text || '').trim()) parts.push(String(b.text).trim());
      else if (b?.type === 'tool_use' || b?.type === 'server_tool_use') parts.push(toolLine(b.name, b.input));
    }
    if (!parts.length) continue;
    if (who !== 'claude') { out.push(`## Claude${it.at ? ` (${iso(timeOf(it.at))})` : ''}`, ''); who = 'claude'; }
    // Consecutive tool lines stay a list; words get a blank line around them.
    for (const p of parts) out.push(p, ...(p.startsWith('- Tool:') ? [] : ['']));
    if (parts[parts.length - 1].startsWith('- Tool:')) out.push('');
  }
  return cap(out.join('\n'));
}

/** A Codex rollout (its text) as Markdown, the same shape as historyMarkdown. */
export function codexMarkdown(text, meta = {}) {
  const out = exportHead({ ...meta, provider: 'codex' });
  let who = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload || {};
    if (e.type === 'compacted') { out.push('', '*The conversation was compacted here.*', ''); who = null; continue; }
    if (e.type !== 'response_item') continue;
    const at = timeOf(e.timestamp);
    if (p.type === 'message' && p.role === 'user') {
      const words = Array.isArray(p.content) ? p.content.map((c) => codexPromptText(c?.text)).filter(Boolean).join('\n\n') : codexPromptText(p.content);
      if (!words) continue;
      out.push(`## You${at ? ` (${iso(at)})` : ''}`, '', words, '');
      who = 'you';
    } else if (p.type === 'message' && p.role === 'assistant') {
      const words = codexText(p.content).trim();
      if (!words) continue;
      if (who !== 'codex') { out.push(`## Codex${at ? ` (${iso(at)})` : ''}`, ''); who = 'codex'; }
      out.push(words, '');
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input = p.arguments ?? p.input ?? p.action ?? {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
      if (who !== 'codex') { out.push(`## Codex${at ? ` (${iso(at)})` : ''}`, ''); who = 'codex'; }
      out.push(toolLine(p.name || p.type, input), '');
    }
  }
  return cap(out.join('\n'));
}

function cap(text) {
  const t = `${text.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  return t.length > EXPORT_MAX_CHARS ? `${t.slice(0, EXPORT_MAX_CHARS)}\n\n*Cut here: the export is limited to ${EXPORT_MAX_CHARS / 1024 / 1024} MB.*\n` : t;
}

/** A file name for an export: the title without characters Windows refuses, cut, and the id's first part. */
export function exportName(title, id) {
  const base = String(title || 'Conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 80) || 'Conversation';
  const short = String(id || '').replace(/^codex:/, '').slice(0, 8);
  return `${base}${short ? ` (${short})` : ''}.md`;
}

/** A free path for `name` in `dir`: "name.md", then "name 2.md", "name 3.md"... */
export function freePath(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, i === 1 ? name : `${stem} ${i}${ext}`);
    if (!exists(p)) return p;
  }
  return path.join(dir, `${stem} ${Date.now()}${ext}`);
}

/* ---------- Open in a terminal ---------- */

/**
 * What opens a terminal in the session's folder that resumes it: `claude --resume <id>`, or `codex resume <thread id>`
 * for a Codex thread. Windows Terminal (a plain console window when it is missing), Terminal on a Mac, the desktop's
 * default on Linux. Arguments are passed as a list (no shell parses the folder or the id), and the id must look like
 * one. Returns null for an id that does not. Pure, so the choice is tested without opening anything.
 */
export function resumeCommand(platform, { cwd = '', id = '' } = {}) {
  const sid = String(id || '');
  if (!SESSION_ID_RE.test(sid)) return null;
  const codex = sid.startsWith('codex:');
  const words = codex ? ['codex', 'resume', sid.slice(6)] : ['claude', '--resume', sid];
  const dir = String(cwd || '');
  if (platform === 'win32') {
    const plain = { cmd: 'cmd.exe', args: ['/c', 'start', '', '/D', dir, 'cmd.exe', '/k', ...words], cwd: dir };
    // Windows Terminal reads ";" in its arguments as "another tab": a folder with one goes to the plain console.
    if (dir.includes(';')) return { ...plain, words };
    return { cmd: 'wt.exe', args: ['-d', dir, 'cmd.exe', '/k', ...words], cwd: dir, fallback: plain, words };
  }
  const line = words.join(' ');
  if (platform === 'darwin') {
    const sh = `cd '${dir.replace(/'/g, "'\\''")}' && ${line}`;
    const script = `tell application "Terminal" to do script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return { cmd: 'osascript', args: ['-e', script, '-e', 'tell application "Terminal" to activate'], cwd: dir, words };
  }
  return { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', `${line}; exec bash`], cwd: dir, words };
}

/** The command a person types to resume it themselves (Copy resume command). */
export function resumeLine({ cwd = '', id = '' } = {}) {
  const sid = String(id || '');
  const cmd = sid.startsWith('codex:') ? `codex resume ${sid.slice(6)}` : `claude --resume ${sid}`;
  return `${cwd ? `cd "${cwd}" && ` : ''}${cmd}`;
}
