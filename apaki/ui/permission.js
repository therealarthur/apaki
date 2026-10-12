/**
 * permission.js: what the permission sheet shows and how its keys behave.
 *
 * 2026-10-12 (Arthur: in "Ask permissions" and "Auto-accept edits" a tool Claude Code
 * would normally ask about simply ran). The engine (apaki/engine/permissions.js) holds
 * the tool call and sends an `ask` event with a `permission` block; app.js draws the
 * sheet from this file, on the desktop window and on the phone page alike.
 *
 *   permissionView(ask)     what to show: the question, the tool, a readable summary of
 *                           its input (the command, a path and diff, a URL...), notes
 *                           (why it was asked, a path outside the folder), and what
 *                           "Always allow" would save
 *   permissionHtml(view)    the sheet's HTML, in the existing sheet style (app.css .perm-*)
 *   permissionKey(...)      Enter allows once, Esc denies; a stray Enter does not approve
 *   permissionReply(...)    the `answer` op's result for a choice
 *
 * Pure (strings and plain objects, no DOM): test/apaki-permissions.test.js.
 */

import { esc } from './markdown.js';

/** A moment after the sheet opens during which Enter does not approve (a keystroke meant for the message box). */
export const ARM_MS = 600;

const CODE_MAX = 6000;
const DIFF_LINES = 30;
const EDITS_MAX = 8;
const PREVIEW_LINES = 40;
const ROWS_MAX = 12;
const VALUE_MAX = 300;

/** A home folder path shortened the way the panes show it. */
const short = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');
const clip = (v, n = VALUE_MAX) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}...` : s; };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nl = (s) => String(s ?? '').split('\n');

/** "mcp__github__create_issue" -> { server: 'github', tool: 'create_issue' }; null for any other tool. */
export function mcpParts(toolName) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName || ''));
  return m ? { server: m[1], tool: m[2] } : null;
}

const code = (text) => { const t = String(text ?? ''); return { kind: 'code', text: t.slice(0, CODE_MAX), cut: t.length > CODE_MAX }; };
const rows = (list) => ({ kind: 'rows', rows: list.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, clip(v)]) });

/** The old and new text of one edit as diff lines (capped), for the red and green block. */
function editLines(oldText, newText) {
  const side = (t) => { const all = nl(t); return { lines: all.slice(0, DIFF_LINES), more: Math.max(0, all.length - DIFF_LINES) }; };
  return { del: oldText === undefined || oldText === '' ? { lines: [], more: 0 } : side(oldText), add: newText === undefined || newText === '' ? { lines: [], more: 0 } : side(newText) };
}

/** The question each tool asks, in plain words. */
function questionFor(name) {
  switch (name) {
    case 'Bash': case 'PowerShell': return 'Run this command?';
    case 'Edit': case 'MultiEdit': return 'Edit this file?';
    case 'Write': return 'Write this file?';
    case 'NotebookEdit': return 'Edit this notebook?';
    case 'Read': return 'Read this file?';
    case 'Glob': case 'Grep': return 'Search these files?';
    case 'WebFetch': return 'Fetch this page?';
    case 'WebSearch': return 'Search the web?';
    case 'Task': case 'Agent': return 'Start this agent?';
    case 'Skill': return 'Use this skill?';
    default: return null;
  }
}

/** The blocks that show a tool's input: what a person needs to see to say yes. */
function blocksFor(name, input) {
  const i = isObj(input) ? input : {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return [code(i.command), rows([['What it does', i.description], ['Runs', i.run_in_background ? 'in the background' : ''], ['Time limit', Number.isFinite(i.timeout) ? `${Math.round(i.timeout / 1000)} s` : ''], ['Sandbox', i.dangerouslyDisableSandbox ? 'runs outside the sandbox' : '']])];
    case 'Edit':
      return [{ kind: 'diff', file: i.file_path || '', edits: [editLines(i.old_string, i.new_string)], more: 0 }, rows([['Replaces', i.replace_all ? 'every match' : '']])];
    case 'MultiEdit': {
      const list = Array.isArray(i.edits) ? i.edits : [];
      return [{ kind: 'diff', file: i.file_path || '', edits: list.slice(0, EDITS_MAX).map((e) => editLines(e?.old_string, e?.new_string)), more: Math.max(0, list.length - EDITS_MAX) }];
    }
    case 'Write': {
      const all = nl(i.content);
      return [{ kind: 'file', file: i.file_path || '', text: all.slice(0, PREVIEW_LINES).join('\n'), lines: all.length, more: Math.max(0, all.length - PREVIEW_LINES) }];
    }
    case 'NotebookEdit':
      return [rows([['Notebook', short(i.notebook_path)], ['Cell', i.cell_id ?? i.cell_number], ['Change', i.edit_mode], ['Cell type', i.cell_type]]), code(i.new_source)];
    case 'Read':
      return [rows([['File', short(i.file_path)], ['From line', i.offset], ['Lines', i.limit]])];
    case 'Glob':
      return [rows([['Pattern', i.pattern], ['In', short(i.path)]])];
    case 'Grep':
      return [rows([['Pattern', i.pattern], ['In', short(i.path)], ['Files', i.glob || i.type]])];
    case 'WebFetch':
      return [rows([['Address', i.url]]), i.prompt ? { kind: 'text', text: clip(i.prompt, 600) } : null];
    case 'WebSearch':
      return [rows([['Search', i.query]])];
    case 'Task':
    case 'Agent':
      return [rows([['Agent', i.subagent_type], ['Job', i.description]]), i.prompt ? code(i.prompt) : null];
    case 'Skill':
      return [rows([['Skill', i.skill || i.name], ['Arguments', i.args]])];
    default: {
      // Any other tool (an MCP server's, a new one): its simple fields as rows, or the input as text.
      const entries = Object.entries(i);
      if (!entries.length) return [{ kind: 'text', text: 'No details were given.' }];
      const simple = entries.every(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
      if (simple && entries.length <= ROWS_MAX) return [rows(entries)];
      return [code(JSON.stringify(i, null, 2))];
    }
  }
}

/**
 * What the sheet shows for an `ask` event with a `permission` block.
 * { question, tool, server, sub, blocks, notes, always, defaultToNo }
 */
export function permissionView(ask) {
  const name = String(ask?.toolName || 'a tool');
  const perm = isObj(ask?.permission) ? ask.permission : {};
  const mcp = mcpParts(name);
  const tool = perm.displayName || (mcp ? mcp.tool : name === 'Task' ? 'Agent' : name);
  const server = perm.mcpServer?.name || mcp?.server || '';
  const question = clip(perm.title, 200) || questionFor(name) || (mcp ? `Use ${mcp.tool} from ${server}?` : `Use ${name}?`);
  const notes = [];
  if (perm.blockedPath) notes.push({ tone: 'warn', text: `Outside the working folder: ${short(perm.blockedPath)}` });
  if (perm.decisionReason) notes.push({ tone: 'info', text: perm.decisionReason });
  if (perm.agentId) notes.push({ tone: 'info', text: 'Asked by a subagent.' });
  if (perm.cut) notes.push({ tone: 'info', text: 'Long text is shortened here. The whole of it is what runs.' });
  const always = Array.isArray(perm.always?.lines) && perm.always.lines.length ? perm.always.lines.slice(0, 6).map((l) => clip(l, 240)) : null;
  return {
    question, tool, server, sub: clip(perm.description, 300),
    blocks: blocksFor(name, ask?.input).filter(Boolean).filter((b) => b.kind !== 'rows' || b.rows.length),
    notes, always, defaultToNo: Boolean(perm.defaultToNo),
  };
}

const diffSide = (side, sign, cls) => `${side.lines.map((l) => `<span class="${cls}">${sign} ${esc(l)}</span>`).join('')}${side.more ? `<span class="more">... ${side.more} more line${side.more === 1 ? '' : 's'}</span>` : ''}`;

function blockHtml(b) {
  switch (b.kind) {
    case 'code':
      return `<pre class="perm-code">${esc(b.text)}</pre>${b.cut ? '<div class="perm-fine">Shortened here.</div>' : ''}`;
    case 'diff':
      return `${b.file ? `<div class="perm-file">${esc(short(b.file))}</div>` : ''}<pre class="diff perm-diff">${b.edits.map((e) => `${diffSide(e.del, '-', 'del')}${diffSide(e.add, '+', 'add')}`).join('')}${b.more ? `<span class="more">... ${b.more} more edit${b.more === 1 ? '' : 's'}</span>` : ''}</pre>`;
    case 'file':
      return `<div class="perm-file">${esc(short(b.file))}<span class="perm-meta">${b.lines} line${b.lines === 1 ? '' : 's'}</span></div><pre class="perm-code">${esc(b.text)}</pre>${b.more ? `<div class="perm-fine">... ${b.more} more line${b.more === 1 ? '' : 's'}</div>` : ''}`;
    case 'rows':
      return `<dl class="perm-rows">${b.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    case 'text':
      return `<div class="perm-text">${esc(b.text)}</div>`;
    default:
      return '';
  }
}

/** The label on the Deny button: it says when a note goes with it. */
export const denyLabel = (note) => (String(note || '').trim() ? 'Deny with note' : 'Deny');

/** The sheet's HTML. `from` is the pane's title (escaped here). */
export function permissionHtml(view, { from = '' } = {}) {
  const keys = view.defaultToNo
    ? 'Esc denies. Enter does not approve this one.'
    : 'Enter allows once. Esc denies.';
  return `${from ? `<div class="from">${esc(from)}</div>` : ''}<h2 id="permQ">${esc(view.question)}</h2>`
    + `${view.sub ? `<div class="perm-sub">${esc(view.sub)}</div>` : ''}`
    + `<div class="perm-tool"><span class="perm-name">${esc(view.tool)}</span>${view.server ? `<span class="perm-srv">${esc(view.server)}</span>` : ''}</div>`
    + `<div class="perm-body">${view.blocks.map(blockHtml).join('')}</div>`
    + view.notes.map((n) => `<div class="perm-note ${n.tone === 'warn' ? 'warn' : ''}">${esc(n.text)}</div>`).join('')
    + '<input type="text" class="perm-say" data-note maxlength="2000" autocomplete="off" aria-label="A note for Claude, sent with Deny" placeholder="Or tell Claude what to do instead (sent with Deny)">'
    + `${view.always ? `<div class="perm-always"><span class="perm-always-h">Always allow saves</span>${view.always.map((l) => `<span class="perm-always-l">${esc(l)}</span>`).join('')}</div>` : ''}`
    + `<div class="row perm-row"><button data-k="deny">Deny</button>${view.always ? '<button data-k="always" title="Allow it now and save the rule above, the way Claude Code does">Always allow</button>' : ''}<button class="primary" data-k="once"${view.defaultToNo ? '' : ' title="Enter"'}>Allow once</button></div>`
    + `<div class="perm-keys">${keys}</div>`;
}

/**
 * What a key does while the sheet is up: 'once' (Enter), 'deny' (Esc), or null (leave it to the page).
 * Enter on a button is that button's own click; in the note box it sends the note with Deny (and does
 * nothing when the box is empty); anywhere else it allows once, but not in the first ARM_MS after the
 * sheet opened, and never when the SDK asked for a default of no (defaultToNo).
 */
export function permissionKey({ key, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false, repeat = false, target = 'other', noteText = '', armed = true, defaultToNo = false } = {}) {
  if (ctrlKey || metaKey || altKey) return null;
  if (key === 'Escape') return 'deny';
  if (key !== 'Enter' || shiftKey || repeat) return null;
  if (target === 'button') return null;
  if (target === 'field') return String(noteText || '').trim() ? 'deny' : null;
  if (!armed || defaultToNo) return null;
  return 'once';
}

/** The `answer` op's result for a choice: 'once', 'always' or 'deny' (with the note, if any). */
export function permissionReply(kind, note = '') {
  if (kind === 'once') return { behavior: 'allow' };
  if (kind === 'always') return { behavior: 'allow', always: true };
  return { behavior: 'deny', message: String(note || '').trim().slice(0, 2000) };
}
