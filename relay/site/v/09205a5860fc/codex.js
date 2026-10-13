/**
 * codex.js: what a Codex pane needs on the page that a Claude pane does not.
 *
 * WHY (Arthur, 2026-10-11/12: a Codex pane should match OpenAI's Codex app as close to 1:1 as possible: the model
 * picker, the effort picker, "bypass session (full access for codex)", voice, attach): the pane (pane.js) is the same
 * one Claude conversations use; this file holds the parts that differ, as pure strings and plain objects so the window,
 * the phone page and the tests share it (test/apaki-codex-ui.test.js):
 *   - the Codex app's three permission presets, worded and ordered for the mode chip
 *   - the model list the engine reads from the app-server (each model has its own efforts) as menu items
 *   - slash commands, a patch (the diffs of a file change) as lines, small text helpers
 * The engine's side is apaki/engine/codex-panes.js; ops and events are the same names Claude panes use.
 */

import { esc } from './markdown.js';

/** The id prefix of a Codex thread in lists and panes. */
export const isCodexId = (id) => String(id || '').startsWith('codex:');

/**
 * The permission presets of the Codex app, most open first (Shift+Tab walks them in this order, like Claude's modes).
 * `mark` and the class suffix draw the same glyph chips Claude's modes use (app.css .chip-btn.mode[data-mode]).
 */
export const CODEX_MODES = Object.freeze([
  { value: 'full-access', label: 'Full access', short: 'Full', mark: '⏵⏵', hint: 'No sandbox, never asks' },
  { value: 'auto', label: 'Auto', short: 'Auto', mark: '⏵', hint: 'Works in the folder, asks beyond it' },
  { value: 'read-only', label: 'Read only', short: 'Read only', mark: '⏸', hint: 'Reads only, asks before changing' },
]);

export const codexMode = (value) => CODEX_MODES.find((m) => m.value === value) || CODEX_MODES[1];

/** What the pane's slash menu offers on its own for a Codex thread (the engine adds compact, status, review, diff, mcp, init, mention). */
export const CODEX_LOCAL = Object.freeze([
  { name: 'new', description: 'Start a new conversation in this pane' },
  { name: 'resume', description: 'Find a conversation to open (words to search for)' },
  { name: 'model', description: 'Switch model (a name from the model picker)' },
  { name: 'effort', description: 'Set the reasoning effort the model offers' },
  { name: 'approvals', description: 'Permissions: full-access, auto, read-only' },
  { name: 'folder', description: 'Move this conversation to a folder (name)' },
  { name: 'fork', description: 'Fork this conversation into a new one' },
]);

/**
 * The plan's usage windows the engine sends with the account (billing.limits, from account/rateLimits): one line for the
 * chip's tooltip, and the worst window's percentage for the small word beside the account name. Both empty when the
 * server did not say (an API key has none).
 */
export function usageText(limits) {
  const rows = (Array.isArray(limits) ? limits : []).filter((l) => l && Number.isFinite(l.usedPercent));
  return rows.map((l) => `${l.label} ${Math.round(l.usedPercent)}% used`).join(', ');
}
export function usageWorst(limits) {
  const rows = (Array.isArray(limits) ? limits : []).filter((l) => l && Number.isFinite(l.usedPercent));
  return rows.length ? `${Math.round(Math.max(...rows.map((l) => l.usedPercent)))}% used` : '';
}

/** The model a model id names, or null. */
export const findModel = (models, id) => (Array.isArray(models) ? models.find((m) => m.id === id) || null : null);

/** A model's name for the chip: the display name, else the id. */
export const modelLabel = (models, id) => findModel(models, id)?.name || String(id || '') || 'Model';

/** The efforts a model offers, as a plain list of names (the grid and the menu use it). */
export const effortNames = (models, id) => (findModel(models, id)?.efforts || []).map((e) => e.value);

/** The model whose name or id the person typed (/model sol), or null. Exact first, then the start of a word. */
export function pickModel(models, text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q || !Array.isArray(models)) return null;
  return models.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q)
    || models.find((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) || null;
}

/** The preset a typed word names (/approvals full), or null. */
export function pickMode(text) {
  const q = String(text || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!q) return null;
  const alias = { full: 'full-access', bypass: 'full-access', danger: 'full-access', 'read': 'read-only', readonly: 'read-only', ro: 'read-only', default: 'auto', workspace: 'auto' };
  const v = alias[q] || q;
  return CODEX_MODES.find((m) => m.value === v || m.value.startsWith(v))?.value || null;
}

/** Wording of the "Load earlier" line when the server does not say how many turns exist. */
export function earlierText(h) {
  if (h?.countless) return `${(h.total || 0).toLocaleString()} messages loaded`;
  return `${(h?.earlier || 0).toLocaleString()} earlier · ${(h?.total || 0).toLocaleString()} in all`;
}

/** Which artifact events open a viewer by themselves: Claude's shows do; a turn's changes and a looked-at picture are cards. */
export const CARD_ONLY_VIA = new Set(['codex-diff', 'codex-image']);

const CHANGE_WORD = { add: 'new file', update: 'edited', delete: 'deleted' };
const LINES_PER_FILE = 400;

/**
 * A file change's lines for the red and green block: [{ cls, text }] with cls hunk, add, del or ctx. A new file's diff
 * is its whole content (every line added); a deleted file's is what was removed.
 */
export function patchLines(change) {
  const text = String(change?.diff ?? '');
  const kind = change?.kind || 'update';
  const rows = text.split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  const out = rows.map((l) => {
    if (kind === 'add') return { cls: 'add', text: `+ ${l}` };
    if (kind === 'delete') return { cls: 'del', text: `- ${l}` };
    if (l.startsWith('@@')) return { cls: 'hunk', text: l };
    if (l.startsWith('+')) return { cls: 'add', text: `+ ${l.slice(1)}` };
    if (l.startsWith('-')) return { cls: 'del', text: `- ${l.slice(1)}` };
    return { cls: 'ctx', text: `  ${l.startsWith(' ') ? l.slice(1) : l}` };
  });
  return out;
}

/**
 * The HTML of a patch's diff block (inside a <pre class="diff">): a header per file, then its lines, capped.
 * open: true makes each file's name a button that opens the file in the viewer (a file that was deleted has none);
 * only for patches that were applied, so not in an approval sheet.
 */
export function patchHtml(changes, { open = false } = {}) {
  return (Array.isArray(changes) ? changes : []).map((c) => {
    const lines = patchLines(c);
    const more = Math.max(0, lines.length - LINES_PER_FILE);
    const name = open && c.path && (c.kind || 'update') !== 'delete'
      ? `<button type="button" class="file-open" data-path="${esc(c.move_path || c.path)}" title="Open in the viewer">${esc(c.path)}</button>`
      : esc(c.path || '');
    const head = `<span class="hunk file">${name} <i>${esc(CHANGE_WORD[c.kind] || c.kind || '')}${c.move_path ? ` to ${esc(c.move_path)}` : ''}</i></span>`;
    return head + lines.slice(0, LINES_PER_FILE).map((l) => `<span class="${l.cls}">${esc(l.text)}</span>`).join('') + (more ? `<span class="more">... ${more} more line${more === 1 ? '' : 's'}</span>` : '');
  }).join('');
}

/** A patch's file names for the tool line: "a.ts, b.ts" (base names), at most three. */
export function patchArgs(changes) {
  const names = (Array.isArray(changes) ? changes : []).map((c) => String(c.path || '').split(/[\\/]/).pop()).filter(Boolean);
  return `${names.slice(0, 3).join(', ')}${names.length > 3 ? `, +${names.length - 3}` : ''}`;
}

/** The footer under a finished Codex turn: how long, how many tokens the last call held, whose account. */
export function codexFooter(e, billing) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return [`${((e.durationMs || 0) / 1000).toFixed(1)}s`, e.tokens ? `${k(e.tokens)} tokens in context` : null, e.interrupted ? 'stopped' : null, billing?.name || null].filter(Boolean).join(' · ');
}
