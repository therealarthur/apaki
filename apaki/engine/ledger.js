/**
 * ledger.js: one provider-agnostic record of a conversation that moves between Claude Code and Codex.
 *
 * WHY (Arthur, 2026-10-11: "an abstraction layer where we take any session and all of its data, and create a unified
 * agnostic transcript with all of the data", so a pane can switch to Codex when Claude's limits are met and back;
 * design in apaki/remote/SWITCH.md, built 2026-10-12): the switch needs to know what happened on the other side. Both
 * native files already hold everything (a Claude Code transcript, ~/.claude/projects/<project>/<session>.jsonl, and a
 * Codex rollout, ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl), so the ledger is not a copy of them: it is
 * two read-only readers that turn either file into the same small events, each pointing back to its file by byte offset.
 * Copying them would double hundreds of megabytes and go stale; reading them on demand never does.
 *
 * An event:
 *   { id: '<side>@<offset>[#<n>]', side: 'claude' | 'codex', offset, at, kind, ... }
 *   kind 'prompt'      text: what the person typed (Apaki's own handoff text taken out, see stripHandoff)
 *   kind 'reply'       text: the agent's answer (phase: Codex's commentary or final_answer)
 *   kind 'reasoning'   text: Claude's thinking, or Codex's reasoning summary (Codex's reasoning itself is encrypted)
 *   kind 'tool_call'   tool, input, callId
 *   kind 'tool_result' callId, output (text), isError
 *   kind 'command'     command, exitCode, output, callId (a Codex command as its app shows it)
 *   kind 'file_change' changes: [{ path, type }] (a Codex patch as its app shows it)
 *   kind 'compaction'  text: the summary when the file keeps one
 *   kind 'settings'    model, cwd, mode, title
 * Neither format is documented and both grow new line types (Codex 0.161 has several this reader has never seen), so
 * an unknown line is counted in stats.unknown and skipped, never an error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plainCommand } from './codex-map.js';

/** The first words of the handoff text Apaki gives the agent that takes over (handoff.js), so the readers can skip it. */
export const HANDOFF_MARK = '[Apaki handoff]';
/** The line that ends a handoff sent in front of the person's own message (the Claude side); what follows is theirs. */
export const HANDOFF_END = "[End of the Apaki handoff. The user's message follows.]";

/** How much of a file a reader takes at most when it starts from the beginning: the newest part of a giant file. */
export const MAX_READ_BYTES = 48 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/* ---------- lines with their byte offsets ---------- */

/**
 * Every line of a file from `start` to `end` with the byte offset it starts at. Lines are split on \n only, so an
 * offset is exact for any line ending, and a line longer than a chunk is joined before it is handed out.
 * @param {string} file
 * @param {{ start?: number, end?: number, skipPartial?: boolean }} [o] skipPartial: `start` may fall inside a line
 */
export async function* fileLines(file, { start = 0, end = Infinity, skipPartial = false } = {}) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const stop = Math.min(size, end);
    let pos = Math.max(0, start);
    let carry = null;
    let carryAt = pos;
    let skipping = skipPartial && pos > 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < stop) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, stop - pos), pos);
      if (!bytesRead) break;
      let chunk = buf.subarray(0, bytesRead);
      let chunkAt = pos;
      pos += bytesRead;
      for (;;) {
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) {
          carry = carry ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
          if (carry.length === chunk.length) carryAt = chunkAt;
          break;
        }
        const piece = chunk.subarray(0, nl);
        const whole = carry ? Buffer.concat([carry, piece]) : piece;
        const at = carry ? carryAt : chunkAt;
        carry = null;
        // next: where the line after this one starts (a bookmark never lands inside a line).
        if (skipping) skipping = false;
        else if (whole.length) yield { text: whole.toString('utf8'), offset: at, next: chunkAt + nl + 1 };
        chunk = chunk.subarray(nl + 1);
        chunkAt += nl + 1;
        if (!chunk.length) break;
      }
    }
    // A last line without its newline is still being written: it is left for the next read.
  } finally {
    await fh.close();
  }
}

/** The one line that starts at `offset` (an event id points there), or null when no line starts there. */
export async function lineAt(file, offset) {
  const at = Math.floor(Number(offset));
  if (!Number.isFinite(at) || at < 0) return null;
  if (at > 0) {
    // A line starts right after a newline; anything else is the middle of a line.
    const fh = await fs.promises.open(file, 'r');
    try {
      const b = Buffer.alloc(1);
      const { bytesRead } = await fh.read(b, 0, 1, at - 1);
      if (!bytesRead || b[0] !== 0x0a) return null;
    } finally { await fh.close(); }
  }
  for await (const l of fileLines(file, { start: at })) return l.offset === at ? l.text : null;
  return null;
}

/* ---------- small helpers ---------- */

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * The person's own words in a message that may carry Apaki's handoff: a handoff sent alone (injected into a Codex
 * thread) leaves nothing; one sent in front of a message (the Claude side) leaves the message after HANDOFF_END.
 */
export function stripHandoff(text) {
  const t = str(text);
  if (!t.trimStart().startsWith(HANDOFF_MARK)) return t;
  const end = t.indexOf(HANDOFF_END);
  return end < 0 ? '' : t.slice(end + HANDOFF_END.length).trim();
}

/** True when a message is Apaki's handoff (its first words). */
export const isHandoff = (text) => str(text).trimStart().startsWith(HANDOFF_MARK);

/** Text of a tool result's content: a string, or blocks of text (pictures are counted, not kept). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content && typeof content === 'object' ? str(content.text || content.output || '') : '';
  const out = [];
  let images = 0;
  for (const b of content) {
    if (typeof b === 'string') out.push(b);
    else if (b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text') out.push(str(b.text));
    else if (b?.type === 'image' || b?.type === 'input_image') images += 1;
  }
  if (images) out.push(`[${images} image${images > 1 ? 's' : ''}]`);
  return out.join('\n');
}

const SYSTEM_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** A Claude user message's own words, or null when it is not something the person typed (a command's output, a notice). */
function claudePromptText(raw) {
  let t = str(raw).replace(SYSTEM_RE, '').trim();
  if (!t) return null;
  // A slash command the person ran: its name and words, as they typed them.
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return `${cmd[1].trim()}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`;
  }
  if (/^<(local-command-|task-notification|bash-|user-memory-input)/.test(t)) return null;
  t = stripHandoff(t);
  return t || null;
}

/* ---------- Claude Code transcript lines ---------- */

/** Lines a Claude transcript has that say nothing the other agent needs (kept out of stats.unknown). */
const CLAUDE_QUIET = new Set(['attachment', 'queue-operation', 'agent-name', 'mode', 'permission-mode', 'last-prompt', 'file-history-snapshot',
  'file-history-delta', 'cost-state', 'atis-latch', 'summary', 'progress', 'pr-link', 'tag']);

/**
 * The events in one parsed line of a Claude Code transcript.
 * @param {object} j        the line
 * @param {number} offset   its byte offset
 * @param {object} [stats]  { unknown: Map } counts the line types it does not know
 */
export function claudeLineEvents(j, offset, stats = null) {
  if (!j || typeof j !== 'object') return [];
  const at = typeof j.timestamp === 'string' ? j.timestamp : null;
  let n = 0;
  const ev = (o) => ({ id: `claude@${offset}${n++ ? `#${n - 1}` : ''}`, side: 'claude', offset, at, ...o });
  // A subagent's own steps: its call and its answer are on the main line already (Task / Agent tool).
  if (j.isSidechain) return [];
  switch (j.type) {
    case 'user': {
      const c = j.message?.content;
      if (j.isCompactSummary) return [ev({ kind: 'compaction', text: contentText(c) })];
      if (j.isMeta) return [];
      if (typeof c === 'string') { const t = claudePromptText(c); return t ? [ev({ kind: 'prompt', text: t })] : []; }
      if (!Array.isArray(c)) return [];
      const out = [];
      const words = claudePromptText(c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
      const images = c.filter((b) => b?.type === 'image').length;
      if (words || images) out.push(ev({ kind: 'prompt', text: words || '', images }));
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        out.push(ev({ kind: 'tool_result', callId: str(b.tool_use_id), output: contentText(b.content), isError: Boolean(b.is_error) }));
      }
      return out;
    }
    case 'assistant': {
      const c = j.message?.content;
      if (!Array.isArray(c)) return typeof c === 'string' && c.trim() ? [ev({ kind: 'reply', text: c })] : [];
      const out = [];
      for (const b of c) {
        if (b?.type === 'text' && str(b.text).trim()) out.push(ev({ kind: 'reply', text: b.text }));
        else if (b?.type === 'thinking' && str(b.thinking).trim()) out.push(ev({ kind: 'reasoning', text: b.thinking }));
        else if (b?.type === 'tool_use') out.push(ev({ kind: 'tool_call', tool: str(b.name), input: b.input ?? null, callId: str(b.id) }));
      }
      if (out.length && j.message?.model && stats) stats.model = j.message.model;
      return out;
    }
    case 'system':
      if (j.subtype === 'compact_boundary') return [ev({ kind: 'compaction', text: '' })];
      return [];
    case 'custom-title':
      if (stats && j.customTitle) stats.title = str(j.customTitle);
      return [];
    default:
      if (stats && !CLAUDE_QUIET.has(j.type)) stats.unknown.set(str(j.type), (stats.unknown.get(str(j.type)) || 0) + 1);
      return [];
  }
}

/* ---------- Codex rollout lines ---------- */

/** User messages Codex writes itself (its environment, the instructions files): not the person's words. */
const CODEX_CONTEXT_RE = /^(<(environment_context|user_instructions|user_shell_command|turn_aborted|subagent_notification|permissions|collaboration_mode|skills_instructions|apps_instructions|model_switch|personality)\b|# AGENTS\.md instructions)/i;

/** Rollout lines that say nothing the other agent needs. */
const CODEX_QUIET = new Set(['token_usage_record', 'inter_agent_communication_metadata', 'world_state']);
const CODEX_QUIET_EVENTS = new Set(['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'token_count', 'task_started',
  'task_complete', 'turn_aborted', 'thread_settings_applied', 'exec_command_begin', 'exec_command_end', 'patch_apply_begin', 'patch_apply_end',
  'item_started', 'mcp_tool_call_begin', 'mcp_tool_call_end', 'web_search_begin', 'web_search_end', 'context_compacted', 'entered_review_mode', 'exited_review_mode']);
/** Response items that are not part of the conversation the other agent needs. */
const CODEX_QUIET_ITEMS = new Set(['agent_message', 'ghost_snapshot', 'other', 'compaction', 'compaction_summary']);

/** A command as one line: Codex keeps it as an argument list with its shell in front (pwsh -Command "..."), or a string. */
export function commandLine(command) {
  if (Array.isArray(command)) {
    const a = command.map(str);
    if (a.length >= 3 && /(?:^|[\\/])(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?$/i.test(a[0]) && /^(?:-c|-lc|-Command|\/c)$/i.test(a[a.length - 2])) return a[a.length - 1];
    return a.join(' ');
  }
  return plainCommand(str(command));
}

/** The text of a tool output in a rollout: a string (older shells wrote JSON with output and exit code), or content items. */
function codexOutput(output) {
  if (typeof output === 'string') {
    const t = output.trim();
    if (t.startsWith('{') && t.includes('"output"')) {
      try { const o = JSON.parse(t); if (typeof o.output === 'string') return { text: o.output, exitCode: o.metadata?.exit_code ?? null }; } catch { /* plain text */ }
    }
    return { text: output, exitCode: null };
  }
  if (Array.isArray(output)) return { text: contentText(output), exitCode: null };
  if (output && typeof output === 'object') return { text: contentText(output.content ?? output.text ?? ''), exitCode: null, isError: output.success === false };
  return { text: '', exitCode: null };
}

/** File changes of a Codex patch item: a map by path (rollout) or a list (app-server). */
function changeList(changes) {
  if (Array.isArray(changes)) return changes.map((c) => ({ path: str(c?.path), type: str(c?.kind?.type || c?.type || 'update') })).filter((c) => c.path);
  if (changes && typeof changes === 'object') return Object.entries(changes).map(([p, c]) => ({ path: p, type: str(c?.type || 'update') }));
  return [];
}

/**
 * The events in one parsed line of a Codex rollout.
 * @param {object} j        the line ({ timestamp, type, payload })
 * @param {number} offset   its byte offset
 * @param {object} [stats]  { unknown: Map }
 */
export function codexLineEvents(j, offset, stats = null) {
  if (!j || typeof j !== 'object') return [];
  const at = typeof j.timestamp === 'string' ? j.timestamp : null;
  const p = j.payload && typeof j.payload === 'object' ? j.payload : {};
  let n = 0;
  const ev = (o) => ({ id: `codex@${offset}${n++ ? `#${n - 1}` : ''}`, side: 'codex', offset, at, ...o });
  const unknown = (k) => { if (stats) stats.unknown.set(k, (stats.unknown.get(k) || 0) + 1); return []; };
  switch (j.type) {
    case 'session_meta':
      if (stats) { stats.cwd = str(p.cwd) || stats.cwd; stats.threadId = str(p.id) || stats.threadId; }
      return [ev({ kind: 'settings', cwd: str(p.cwd), version: str(p.cli_version) })];
    case 'turn_context':
      if (stats && p.model) stats.model = str(p.model);
      return [ev({ kind: 'settings', model: str(p.model), cwd: str(p.cwd), mode: str(p.approval_policy), sandbox: str(p.sandbox_policy?.type || p.sandbox_policy?.mode || p.sandbox_policy || '') })];
    case 'compacted':
      return [ev({ kind: 'compaction', text: str(p.message) })];
    case 'response_item':
      switch (p.type) {
        case 'message': {
          const text = contentText(p.content);
          if (p.role === 'user') {
            // The words only: pictures are counted on their own, and a block Codex wrote itself (its environment, the
            // instructions files) comes off, also when it shares the message with what the person typed.
            const own = (Array.isArray(p.content) ? p.content : [{ type: 'input_text', text }]).filter((b) => b?.type !== 'input_image' && !CODEX_CONTEXT_RE.test(str(b?.text).trim()));
            const words = stripHandoff(contentText(own)).trim();
            const images = (Array.isArray(p.content) ? p.content : []).filter((b) => b?.type === 'input_image').length;
            return words || images ? [ev({ kind: 'prompt', text: words, images })] : [];
          }
          if (p.role === 'assistant') return text.trim() ? [ev({ kind: 'reply', text, phase: str(p.phase) || null })] : [];
          return [];
        }
        case 'reasoning': {
          const t = (Array.isArray(p.summary) ? p.summary : []).map((s) => str(s?.text)).filter(Boolean).join('\n\n');
          return t.trim() ? [ev({ kind: 'reasoning', text: t })] : [];
        }
        case 'function_call': {
          let input = p.arguments;
          if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* kept as text */ } }
          return [ev({ kind: 'tool_call', tool: p.namespace ? `${p.namespace}.${str(p.name)}` : str(p.name), input, callId: str(p.call_id) })];
        }
        case 'custom_tool_call':
          return [ev({ kind: 'tool_call', tool: str(p.name), input: p.input ?? null, callId: str(p.call_id) })];
        case 'local_shell_call':
          return [ev({ kind: 'tool_call', tool: 'shell', input: { command: p.action?.command ?? null }, callId: str(p.call_id || p.id) })];
        case 'web_search_call':
          return [ev({ kind: 'tool_call', tool: 'web_search', input: p.action ?? null, callId: str(p.id) })];
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const o = codexOutput(p.output);
          return [ev({ kind: 'tool_result', callId: str(p.call_id), output: o.text, isError: Boolean(o.isError) || (o.exitCode != null && o.exitCode !== 0), exitCode: o.exitCode })];
        }
        default:
          return CODEX_QUIET_ITEMS.has(p.type) ? [] : unknown(`response_item/${str(p.type)}`);
      }
    case 'event_msg': {
      if (p.type !== 'item_completed') return CODEX_QUIET_EVENTS.has(p.type) ? [] : unknown(`event_msg/${str(p.type)}`);
      const it = p.item && typeof p.item === 'object' ? p.item : {};
      const type = str(it.type).toLowerCase();
      if (type === 'commandexecution') {
        return [ev({ kind: 'command', command: commandLine(it.command), exitCode: it.exit_code ?? it.exitCode ?? null, output: str(it.aggregated_output ?? it.aggregatedOutput ?? it.formatted_output ?? it.stdout ?? ''), callId: str(it.id) })];
      }
      if (type === 'filechange') return [ev({ kind: 'file_change', changes: changeList(it.changes), callId: str(it.id) })];
      return [];
    }
    default:
      return CODEX_QUIET.has(j.type) ? [] : unknown(str(j.type));
  }
}

/* ---------- reading a file ---------- */

/**
 * The events of one side's file from a byte offset (a bookmark) to its end now.
 * @param {'claude'|'codex'} side
 * @param {string} file
 * @param {{ from?: number, maxBytes?: number }} [o]
 * @returns {Promise<{ events: object[], start: number, end: number, skipped: number, stats: object }>}
 *   end: where the last whole line ends (the next bookmark; a line still being written is read next time);
 *   skipped: bytes after `from` left unread because the file is giant (only its newest maxBytes are read)
 */
export async function readEvents(side, file, { from = 0, maxBytes = MAX_READ_BYTES } = {}) {
  const stats = { unknown: new Map(), lines: 0, bad: 0, title: '', model: '', cwd: '', threadId: '' };
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { events: [], start: from, end: from, skipped: 0, stats, missing: true }; }
  const begin = Math.min(Math.max(0, from), size);
  const start = size - begin > maxBytes ? size - maxBytes : begin;
  const events = [];
  const parse = side === 'codex' ? codexLineEvents : claudeLineEvents;
  let end = begin;
  for await (const l of fileLines(file, { start, end: size, skipPartial: start > begin })) {
    stats.lines += 1;
    end = l.next;
    let j;
    try { j = JSON.parse(l.text); } catch { stats.bad += 1; continue; }
    for (const e of parse(j, l.offset, stats)) events.push(e);
  }
  return { events, start, end, skipped: start - begin, stats };
}

/* ---------- finding the files ---------- */

/** A Claude session's transcript, by id (~/.claude/projects/<project>/<id>.jsonl), or null. */
export function claudeTranscript(sessionId, { claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const want = `${str(sessionId).toLowerCase()}.jsonl`;
  if (!/^[0-9a-f-]{8,64}\.jsonl$/.test(want)) return null;
  const root = path.join(claudeDir, 'projects');
  let projects = [];
  try { projects = fs.readdirSync(root); } catch { return null; }
  for (const p of projects) {
    const f = path.join(root, p, want);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * A Codex thread's rollout file, by thread id, under the given roots (codex-rollouts.js rolloutRoots): the newest
 * days first, since a thread being switched to or from is a recent one.
 */
export function codexRollout(threadId, roots) {
  const want = str(threadId).toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(want)) return null;
  const sorted = (dir) => { try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; } };
  for (const root of roots || []) {
    for (const y of sorted(root).filter((d) => /^\d{4}$/.test(d))) {
      for (const m of sorted(path.join(root, y)).filter((d) => /^\d{2}$/.test(d))) {
        for (const d of sorted(path.join(root, y, m)).filter((x) => /^\d{2}$/.test(x))) {
          const dir = path.join(root, y, m, d);
          for (const f of sorted(dir)) { const hit = ROLLOUT_RE.exec(f); if (hit && hit[1].toLowerCase() === want) return path.join(dir, f); }
        }
      }
    }
    // Archived rollouts sit flat in their folder.
    for (const f of sorted(root)) { const hit = ROLLOUT_RE.exec(f); if (hit && hit[1].toLowerCase() === want) return path.join(root, f); }
  }
  return null;
}
