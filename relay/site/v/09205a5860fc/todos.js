/**
 * todos.js: Claude Code's todo list as a checklist, the way Claude Code draws it.
 *
 * 2026-10-12 (Arthur: a TodoWrite call showed only as "N todos"). A TodoWrite call
 * carries the WHOLE list every time: { todos: [{ content, status, activeForm }] } with
 * status pending, in_progress or completed. Claude Code prints that list as a checklist
 * (done items struck through, the item being worked on in bold) and each later call
 * redraws it. Apaki does the same: one checklist card in the conversation where the first
 * call is, and the calls that follow in the same turn update that card in place instead of
 * stacking new ones. A new turn (you wrote something) or a plan that shares nothing with a
 * finished one starts a new card. The same code draws it live (pane.js onSdk), from
 * history (renderMessages, tool_use blocks of the transcript) and in a subagent's viewer
 * (tasks.js), on the desktop window and on the phone page.
 *
 * Everything here is pure (strings and plain objects, no DOM), so
 * test/apaki-todos.test.js checks it directly; pane.js and tasks.js only place the card.
 */

import { esc } from './markdown.js';

export const MAX_TODOS = 100;
const TEXT_MAX = 400;

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

const clip = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : '');

/**
 * The list a TodoWrite input holds, cleaned: { content, activeForm, status } for each item that has any text,
 * status one of pending, in_progress, completed (anything else reads as pending). Takes the tool input or the
 * array itself. A malformed input gives an empty list.
 */
export function normalizeTodos(input) {
  const raw = Array.isArray(input) ? input : Array.isArray(input?.todos) ? input.todos : [];
  const out = [];
  for (const t of raw.slice(0, MAX_TODOS)) {
    if (typeof t === 'string') {
      const content = clip(t);
      if (content) out.push({ content, activeForm: '', status: 'pending' });
      continue;
    }
    if (!t || typeof t !== 'object') continue;
    const activeForm = clip(t.activeForm);
    const content = clip(t.content) || activeForm;
    if (!content) continue;
    out.push({ content, activeForm: activeForm === content ? '' : activeForm, status: STATUSES.has(t.status) ? t.status : 'pending' });
  }
  return out;
}

/** True when a TodoWrite input has a todos array at all (an empty one clears the list). */
export const hasTodos = (input) => Array.isArray(input?.todos);

/** How many items are done, in progress and waiting. */
export function todoCounts(list) {
  const c = { total: list.length, done: 0, doing: 0, pending: 0 };
  for (const t of list) {
    if (t.status === 'completed') c.done += 1;
    else if (t.status === 'in_progress') c.doing += 1;
    else c.pending += 1;
  }
  return c;
}

/** The count line in the card's header: "2 of 5 done", "All 5 done", or "Cleared". */
export function todoSummary(list) {
  const c = todoCounts(list);
  if (!c.total) return 'Cleared';
  if (c.done === c.total) return c.total === 1 ? 'Done' : `All ${c.total} done`;
  return `${c.done} of ${c.total} done`;
}

const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The two lists show the same thing (same items in the same states), so a redraw would change nothing. */
export function sameTodos(a, b) {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.content === b[i].content && t.status === b[i].status && t.activeForm === b[i].activeForm);
}

/**
 * Whether `next` is the same checklist as `prev`, updated, so the card changes in place. A list still in progress is
 * always continued by the next call (Claude rewrites the whole list each time, often rewording an item). Once
 * every item of the old list is done, a call that shares none of its items is a new plan and gets a new card.
 */
export function continuesList(prev, next) {
  if (!prev || !prev.length) return false;
  if (prev.some((t) => t.status !== 'completed')) return true;
  const had = new Set(prev.map((t) => key(t.content)));
  return next.some((t) => had.has(key(t.content)));
}

const MARKS = {
  completed: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="tb" x="1.75" y="1.75" width="12.5" height="12.5" rx="3.4"/><path class="tc" d="m5 8.3 2.15 2.15L11.2 6"/></svg>',
  in_progress: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="tb" x="1.75" y="1.75" width="12.5" height="12.5" rx="3.4"/><rect class="tn" x="5.2" y="5.2" width="5.6" height="5.6" rx="1.6"/></svg>',
  pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="tb" x="1.75" y="1.75" width="12.5" height="12.5" rx="3.4"/></svg>',
};
const STATE = { completed: 'done', in_progress: 'doing', pending: 'todo' };
const SAID = { completed: 'Done: ', in_progress: 'In progress: ', pending: 'To do: ' };

/**
 * The checklist's inner HTML: a header (Todos, the count), then one row per item with its mark. The item being
 * worked on is emphasized and, when Claude wrote a present-tense form ("Running the tests"), shows it under the
 * item. A cleared list (an empty todos array) is just the header.
 */
export function todosHtml(list) {
  const rows = list.map((t) => {
    const s = STATE[t.status] || 'todo';
    const now = t.status === 'in_progress' && t.activeForm ? `<span class="td-now">${esc(t.activeForm)}</span>` : '';
    return `<li class="td ${s}"${t.status === 'in_progress' ? ' aria-current="step"' : ''}><span class="td-mark">${MARKS[t.status] || MARKS.pending}</span><span class="td-body"><span class="td-sr">${SAID[t.status] || SAID.pending}</span><span class="td-text">${esc(t.content)}</span>${now}</span></li>`;
  }).join('');
  return `<div class="todos-head"><span class="todos-name">Todos</span><span class="todos-count">${esc(todoSummary(list))}</span></div>${list.length ? `<ul class="todos-list">${rows}</ul>` : ''}`;
}

/**
 * Draws `list` into a card element (any object with innerHTML, dataset and classList). The card's class says whether
 * everything is done (the header calms down) and its data-n counts the redraws. Returns the counts.
 */
export function paintTodos(card, list) {
  card.innerHTML = todosHtml(list);
  const c = todoCounts(list);
  card.classList.toggle('all-done', c.total > 0 && c.done === c.total);
  card.classList.toggle('cleared', c.total === 0);
  card.dataset.n = String(Number(card.dataset.n || 0) + 1);
  card.setAttribute?.('aria-label', `Todo list, ${todoSummary(list)}`);
  return c;
}
