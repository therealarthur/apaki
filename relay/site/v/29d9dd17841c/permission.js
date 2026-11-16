/**
 * permission.js: what a permission prompt shows and how its keys behave.
 *
 * 2026-10-12 (Arthur: in "Ask permissions" and "Auto-accept edits" a tool Claude Code
 * would normally ask about simply ran). The engine (apaki/engine/permissions.js) holds
 * the tool call and sends an `ask` event with a `permission` block; the pane that asked
 * draws it from this file, on the desktop window and on the phone page alike.
 *
 * 2026-10-12, later (Arthur: "when askuserquestion type things come up, it should be
 * shown in the pane and not lock the user from using the app"): the prompt is no longer
 * a sheet over the window but a card docked above the pane's message box (askcard.js).
 * Its choices are numbered rows, the way Claude Code's terminal shows them (1 Allow once,
 * 2 Always allow, 3 Deny); Esc goes back to the message box instead of denying.
 *
 *   permissionView(ask)     what to show: the question, the tool, a readable summary of
 *                           its input (the command, a path and diff, a URL...), notes
 *                           (why it was asked, a path outside the folder), and what
 *                           "Always allow" would save
 *   permissionChoices(view) the numbered choices, in order: once, always (when offered), deny
 *   permissionHtml(view)    the card's inner HTML (app.css .ask-card and .perm-*)
 *   permissionKey(...)      a number picks its row, Enter allows once, Esc leaves the card;
 *                           a stray Enter does not approve
 *   permissionReply(...)    the `answer` op's result for a choice
 *
 * Pure (strings and plain objects, no DOM): test/apaki-permissions.test.js.
 */

import { esc } from './markdown.js';
// Codex's file changes are drawn with the same lines as the conversation's patch block (codex.js, 2026-10-12).
import { patchHtml } from './codex.js';

/** A moment after a card takes the keyboard during which Enter and the numbers do nothing (a keystroke meant for the message box). */
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
    case 'ApplyPatch': return 'Apply these changes?';
    case 'Permissions': return 'Grant more access?';
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
    // Codex (apaki/engine/codex-map.js approvalAsk): the changes it wants to make, as diffs; the access it asks for, as rows.
    case 'ApplyPatch':
      return [{ kind: 'patch', changes: Array.isArray(i.changes) ? i.changes.slice(0, EDITS_MAX) : [], more: Math.max(0, (Array.isArray(i.changes) ? i.changes.length : 0) - EDITS_MAX) }];
    case 'Permissions':
      return [rows(Array.isArray(i.rows) ? i.rows : []), i.cwd ? rows([['Folder', short(i.cwd)]]) : null];
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
    // Codex words its own buttons ("Approve once", "Approve for this session"); Claude's keep theirs.
    labels: { once: clip(perm.labels?.once, 40) || 'Allow once', always: clip(perm.labels?.always, 40) || 'Always allow', deny: clip(perm.labels?.deny, 40) || 'Deny' },
    codex: Boolean(perm.codex),
  };
}

const diffSide = (side, sign, cls) => `${side.lines.map((l) => `<span class="${cls}">${sign} ${esc(l)}</span>`).join('')}${side.more ? `<span class="more">... ${side.more} more line${side.more === 1 ? '' : 's'}</span>` : ''}`;

function blockHtml(b) {
  switch (b.kind) {
    case 'code':
      return `<pre class="perm-code">${esc(b.text)}</pre>${b.cut ? '<div class="perm-fine">Shortened here.</div>' : ''}`;
    case 'diff':
      return `${b.file ? `<div class="perm-file">${esc(short(b.file))}</div>` : ''}<pre class="diff perm-diff">${b.edits.map((e) => `${diffSide(e.del, '-', 'del')}${diffSide(e.add, '+', 'add')}`).join('')}${b.more ? `<span class="more">... ${b.more} more edit${b.more === 1 ? '' : 's'}</span>` : ''}</pre>`;
    case 'patch':
      return `<pre class="diff perm-diff">${patchHtml(b.changes)}${b.more ? `<span class="more">... ${b.more} more file${b.more === 1 ? '' : 's'}</span>` : ''}</pre>`;
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
export const denyLabel = (note, base = 'Deny') => (String(note || '').trim() ? `${base} with note` : base);

/** The card's numbered choices, in order: a number key picks the row with that number (Claude Code's 1, 2, 3). */
export function permissionChoices(view) {
  return view?.always ? ['once', 'always', 'deny'] : ['once', 'deny'];
}

/** A row's number, drawn as a quiet key cap in front of its words. */
const num = (n) => `<span class="ask-n" aria-hidden="true">${n}</span>`;

/**
 * The card's HTML (askcard.js puts it in the pane that asked, above its message box). `from` is a title to show
 * above the question (escaped here; the inline card has no need of it). `id` names the question for the screen
 * reader. Choices are numbered rows; Deny takes the note typed below it.
 */
export function permissionHtml(view, { from = '', id = 'permQ' } = {}) {
  const L = view.labels || { once: 'Allow once', always: 'Always allow', deny: 'Deny' };
  const who = view.codex ? 'Codex' : 'Claude';
  const choices = permissionChoices(view);
  const n = (k) => choices.indexOf(k) + 1;
  const back = 'Esc goes back to your message.';
  const keys = view.defaultToNo
    ? `1 to ${choices.length} choose. Enter does not approve this one. ${back}`
    : view.codex ? `Enter: ${L.once.toLowerCase()}. ${back}` : `Enter allows once. ${back}`;
  const always = view.always
    ? `<small class="perm-always"><span class="perm-always-h">${esc(view.codex ? `${L.always} means` : 'Always allow saves')}</span>${view.always.map((l) => `<span class="perm-always-l">${esc(l)}</span>`).join('')}</small>`
    : '';
  return `${from ? `<div class="from">${esc(from)}</div>` : ''}<div class="ask-scroll"><h3 class="ask-h" id="${esc(id)}">${esc(view.question)}</h3>`
    + `${view.sub ? `<div class="perm-sub">${esc(view.sub)}</div>` : ''}`
    + `<div class="perm-tool"><span class="perm-name">${esc(view.tool)}</span>${view.server ? `<span class="perm-srv">${esc(view.server)}</span>` : ''}</div>`
    + `<div class="perm-body">${view.blocks.map(blockHtml).join('')}</div>`
    + view.notes.map((x) => `<div class="perm-note ${x.tone === 'warn' ? 'warn' : ''}">${esc(x.text)}</div>`).join('')
    + '</div>'
    + `<div class="ask-choices" role="group" aria-labelledby="${esc(id)}">`
    + `<button type="button" class="ask-choice" data-k="once"${view.defaultToNo ? '' : ' title="Enter"'}>${num(n('once'))}<span class="ask-l"><span class="ask-w">${esc(L.once)}</span></span></button>`
    + (view.always ? `<button type="button" class="ask-choice" data-k="always" title="${view.codex ? 'Approve it now and for the rest of this session' : 'Allow it now and save the rule, the way Claude Code does'}">${num(n('always'))}<span class="ask-l"><span class="ask-w">${esc(L.always)}</span>${always}</span></button>` : '')
    + `<button type="button" class="ask-choice" data-k="deny">${num(n('deny'))}<span class="ask-l"><span class="ask-w">${esc(L.deny)}</span></span></button>`
    + '</div>'
    // The placeholder fits a 390 px phone whole (2026-10-12; "(sent with Deny)" was cut there): the Deny row
    // turns into "Deny with note" as soon as there is one, and the field's label still says it goes with Deny.
    + `<input type="text" class="perm-say ask-say" data-note maxlength="2000" autocomplete="off" aria-label="A note for ${who}, sent with Deny" placeholder="Or tell ${who} what to do instead">`
    + `<div class="ask-foot"><span class="ask-keys perm-keys">${keys}</span></div>`;
}

/**
 * What a key does inside a permission card: 'once', 'always' or 'deny' (a choice), 'leave' (Esc: back to the
 * message box, nothing answered), or null (leave it to the page).
 * A number picks the row with that number (`choices`, permissionChoices), but not in the first ARM_MS after the
 * card took the keyboard. Enter on a button is that button's own click; in the note box it sends the note with
 * Deny (and does nothing when the box is empty); anywhere else it allows once, but not in the first ARM_MS, and
 * never when the SDK asked for a default of no (defaultToNo).
 */
export function permissionKey({ key, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false, repeat = false, target = 'other', noteText = '', armed = true, defaultToNo = false, choices = ['once', 'always', 'deny'] } = {}) {
  if (ctrlKey || metaKey || altKey) return null;
  if (key === 'Escape') return 'leave';
  if (target === 'field') return key === 'Enter' && !shiftKey && !repeat && String(noteText || '').trim() ? 'deny' : null;
  if (/^[1-9]$/.test(String(key))) return repeat || !armed ? null : choices[Number(key) - 1] || null;
  if (key !== 'Enter' || shiftKey || repeat) return null;
  if (target === 'button') return null;
  if (!armed || defaultToNo) return null;
  return 'once';
}

/** The `answer` op's result for a choice: 'once', 'always' or 'deny' (with the note, if any). */
export function permissionReply(kind, note = '') {
  if (kind === 'once') return { behavior: 'allow' };
  if (kind === 'always') return { behavior: 'allow', always: true };
  return { behavior: 'deny', message: String(note || '').trim().slice(0, 2000) };
}
