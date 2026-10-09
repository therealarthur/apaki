/**
 * model.js
 *
 * Pure display logic for latch's Claude Code style UI: turns Agent SDK
 * messages (live or from a saved session) into display items, and describes
 * tool calls and results the way Claude Code's transcript does:
 *   ⏺ Bash(npm test)
 *     ⎿  12 passing … +3 lines
 * Kept free of React so it can be unit tested.
 *
 * Item kinds: user, assistant, tool, note, divider.
 */

const MAX_RESULT_LINES = 3;
const MAX_DIFF_LINES = 14;

function oneLine(s, max = 120) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortPath(p, cwd) {
  const s = String(p || '');
  if (cwd && s.toLowerCase().startsWith(String(cwd).toLowerCase())) {
    const rest = s.slice(String(cwd).length).replace(/^[\\/]/, '');
    return rest || s;
  }
  return s;
}

/** "mcp__context7__query-docs" -> "context7 - query-docs (MCP)". */
export function toolLabel(name) {
  const m = String(name).match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]} - ${m[2]} (MCP)` : name === 'Agent' ? 'Task' : name;
}

/** The argument Claude Code shows in parentheses after a tool name. */
export function toolArgs(name, input = {}, cwd = '') {
  const i = input || {};
  switch (name) {
    case 'Bash': return oneLine(i.command, 140);
    case 'PowerShell': return oneLine(i.command, 140);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return shortPath(i.file_path || i.notebook_path, cwd);
    case 'Grep': return oneLine(`pattern: "${i.pattern ?? ''}"${i.path ? `, path: "${shortPath(i.path, cwd)}"` : ''}`, 140);
    case 'Glob': return oneLine(`pattern: "${i.pattern ?? ''}"${i.path ? `, path: "${shortPath(i.path, cwd)}"` : ''}`, 140);
    case 'WebFetch': return oneLine(i.url);
    case 'WebSearch': return oneLine(i.query);
    case 'Task': case 'Agent': return oneLine(i.description || i.prompt, 80);
    case 'Skill': return oneLine(i.skill || i.command);
    case 'TodoWrite': return '';
    default: {
      const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
      if (pick !== undefined) return oneLine(pick, 100);
      const json = JSON.stringify(i);
      return json && json !== '{}' ? oneLine(json, 100) : '';
    }
  }
}

/** Text of a tool_result content (string or blocks). */
export function resultText(content) {
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).join('\n');
  }
  return String(content ?? '');
}

/** Removed and added lines for an Edit/Write call, Claude Code style. */
export function diffLines(name, input = {}) {
  const lines = [];
  const add = (sign, text) => lines.push({ sign, text });
  if (name === 'Edit') {
    for (const l of String(input.old_string ?? '').split('\n')) add('-', l);
    for (const l of String(input.new_string ?? '').split('\n')) add('+', l);
  } else if (name === 'MultiEdit') {
    for (const e of input.edits || []) {
      for (const l of String(e.old_string ?? '').split('\n')) add('-', l);
      for (const l of String(e.new_string ?? '').split('\n')) add('+', l);
    }
  } else if (name === 'Write') {
    for (const l of String(input.content ?? '').split('\n')) add('+', l);
  }
  if (lines.length > MAX_DIFF_LINES) {
    const more = lines.length - MAX_DIFF_LINES;
    return [...lines.slice(0, MAX_DIFF_LINES), { sign: '…', text: `${more} more line${more === 1 ? '' : 's'}` }];
  }
  return lines;
}

/**
 * The "⎿" summary under a finished tool call: { lines, diff, todos }.
 * Mirrors Claude Code's wording where it has a fixed one.
 */
export function summarizeTool(name, input = {}, content, isError, cwd = '') {
  const text = resultText(content);
  const all = text.split('\n').filter((l) => l.trim());
  if (isError) return { lines: [oneLine(all[0] || 'Error', 160), ...(all.length > 1 ? [`… +${all.length - 1} lines`] : [])] };
  switch (name) {
    case 'Read': {
      const n = Math.max(0, text.split('\n').length - 1) || all.length;
      return { lines: [`Read ${n} line${n === 1 ? '' : 's'}`] };
    }
    case 'Edit': case 'MultiEdit': {
      const d = diffLines(name, input);
      const adds = d.filter((l) => l.sign === '+').length;
      const dels = d.filter((l) => l.sign === '-').length;
      return { lines: [`Updated ${shortPath(input.file_path, cwd)} with ${adds} addition${adds === 1 ? '' : 's'} and ${dels} removal${dels === 1 ? '' : 's'}`], diff: d };
    }
    case 'Write': {
      const n = String(input.content ?? '').split('\n').length;
      return { lines: [`Wrote ${n} line${n === 1 ? '' : 's'} to ${shortPath(input.file_path, cwd)}`], diff: diffLines(name, input) };
    }
    case 'TodoWrite':
      return { lines: [], todos: (input.todos || []).map((t) => ({ text: t.content || t.activeForm || '', status: t.status })) };
    case 'Glob': case 'Grep': {
      const n = all.length;
      if (/^No (files|matches) found/i.test(all[0] || '')) return { lines: [all[0]] };
      return { lines: [`Found ${n} ${name === 'Glob' ? 'file' : 'line'}${n === 1 ? '' : 's'}`] };
    }
    default: {
      if (!all.length) return { lines: ['(No content)'] };
      const shown = all.slice(0, MAX_RESULT_LINES).map((l) => oneLine(l, 160));
      if (all.length > MAX_RESULT_LINES) shown.push(`… +${all.length - MAX_RESULT_LINES} lines`);
      return { lines: shown };
    }
  }
}

/** User-typed text of a user message, or null for tool results and injected context. */
export function userText(message) {
  const c = message && message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
  const t = text.trim();
  if (!t) return null;
  if (/^<(system-reminder|local-command-caveat|local-command-stdout|task-notification|relayed-turns)/.test(t)) return null;
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = (t.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || '';
    return `${cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`}${args.trim() ? ` ${args.trim()}` : ''}`;
  }
  if (/^Caveat: /.test(t) || /^\[Request interrupted/.test(t)) return null;
  return t;
}

/**
 * Display items for a saved conversation (SDK getSessionMessages output):
 * user prompts, assistant text, and finished tool calls. Subagent traffic is
 * left out.
 */
export function historyItems(messages, cwd = '') {
  const items = [];
  const tools = new Map();
  for (const m of messages || []) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message || {};
    if (m.type === 'user') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      let sawResult = false;
      for (const b of blocks) {
        if (b && b.type === 'tool_result' && tools.has(b.tool_use_id)) {
          sawResult = true;
          const t = tools.get(b.tool_use_id);
          Object.assign(t, { status: b.is_error ? 'error' : 'ok', ...summarizeTool(t.name, t.input, b.content, b.is_error, cwd) });
        }
      }
      if (!sawResult) {
        const text = userText(msg);
        if (text) items.push({ kind: 'user', text });
      }
    } else if (m.type === 'assistant') {
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) items.push({ kind: 'assistant', text: b.text });
        else if (b.type === 'tool_use') {
          const t = { kind: 'tool', id: b.id, name: b.name, input: b.input, args: toolArgs(b.name, b.input, cwd), status: 'ok', lines: [] };
          tools.set(b.id, t);
          items.push(t);
        }
      }
    }
  }
  return items;
}

/** Keeps the tail of a history: the last `n` user turns and everything after the first of them. */
export function tailItems(items, n = 12) {
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user' && ++seen === n) return { items: items.slice(i), hidden: i };
  }
  return { items, hidden: 0 };
}

/** Claude Code's spinner verbs, a few of them. */
export const SPINNER_VERBS = ['Thinking', 'Cogitating', 'Brewing', 'Pondering', 'Crafting', 'Mulling', 'Working', 'Noodling', 'Percolating', 'Simmering'];
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** "1m 12s" style duration. */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** "3.2k" style token count. */
export function tokens(n) {
  const v = n || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/** Display name for a model id. */
export function modelName(id) {
  const s = String(id || '');
  const m = s.match(/claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return s ? s[0].toUpperCase() + s.slice(1) : 'Default';
}

/** Permission modes in Claude Code's Shift+Tab order, with their footer labels. */
export const MODES = [
  { id: 'default', label: '' },
  { id: 'acceptEdits', label: '⏵⏵ accept edits on' },
  { id: 'plan', label: '⏸ plan mode on' },
  { id: 'bypassPermissions', label: '⏵⏵ bypass permissions on' },
];

export function nextMode(id) {
  const i = MODES.findIndex((m) => m.id === id);
  return MODES[(i + 1) % MODES.length].id;
}

/** Slash menu entries matching what is typed after "/": prefix matches first. */
export function matchCommands(commands, typed, limit = 8) {
  const q = typed.toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    const score = n.startsWith(q) ? 0 : n.includes(q) ? 1 : (c.description || '').toLowerCase().includes(q) && q.length > 2 ? 2 : -1;
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((s) => s.c);
}
