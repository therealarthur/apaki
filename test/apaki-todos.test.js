/**
 * The todo checklist (apaki/ui/todos.js, pane.js addTodos, tasks.js), 2026-10-12.
 *
 * Arthur: a TodoWrite call showed only as "N todos". It now draws as Claude Code does: a
 * checklist with done items struck through and the item being worked on emphasized, updated
 * in place by the calls that follow in the same turn, and the same from history.
 *
 * Pure tests: normalizing a TodoWrite input, the counts and the header line, when a call
 * continues the checklist and when it starts a new one, and the HTML (marks, states, escaping).
 * Then the pane's side on a small fake DOM (no browser here): one card per turn updated in place,
 * a new turn or a new plan after a finished one starting a new card, the result of the call
 * leaving the card alone, an empty list clearing it, history replayed the same way, and the
 * tool line staying for anything that is not a list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TODOS, continuesList, hasTodos, normalizeTodos, paintTodos, sameTodos, todoCounts, todoSummary, todosHtml,
} from '../apaki/ui/todos.js';
import { Pane } from '../apaki/ui/pane.js';

const t = (content, status = 'pending', activeForm = '') => ({ content, status, activeForm });

/* pure */

test('normalizeTodos: the list a TodoWrite input holds, cleaned', () => {
  const out = normalizeTodos({ todos: [
    { content: 'Write the tests', status: 'in_progress', activeForm: 'Writing the tests' },
    { content: '  Ship   it ', status: 'completed', activeForm: '' },
    { content: 'Odd status', status: 'blocked', activeForm: 'Odd' },
    { content: '', status: 'pending', activeForm: 'Only a present form' },
    { content: '   ', status: 'pending' },
    null, 7, 'a plain string',
  ] });
  assert.deepEqual(out, [
    { content: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' },
    { content: 'Ship it', activeForm: '', status: 'completed' },
    { content: 'Odd status', activeForm: 'Odd', status: 'pending' },
    { content: 'Only a present form', activeForm: '', status: 'pending' },
    { content: 'a plain string', activeForm: '', status: 'pending' },
  ]);
  assert.deepEqual(normalizeTodos([{ content: 'from an array' }]).map((x) => x.content), ['from an array']);
  for (const bad of [undefined, null, 'x', 7, {}, { todos: 'no' }]) assert.deepEqual(normalizeTodos(bad), []);
  assert.equal(normalizeTodos({ todos: Array.from({ length: MAX_TODOS + 20 }, (_, i) => t(`item ${i}`)) }).length, MAX_TODOS);
  assert.equal(normalizeTodos({ todos: [t('x'.repeat(900))] })[0].content.length, 400);
  assert.equal(hasTodos({ todos: [] }), true, 'an empty list is still a list (it clears)');
  assert.equal(hasTodos({}), false);
  assert.equal(hasTodos(null), false);
});

test('todoCounts and todoSummary: the header line', () => {
  const list = [t('a', 'completed'), t('b', 'in_progress'), t('c'), t('d')];
  assert.deepEqual(todoCounts(list), { total: 4, done: 1, doing: 1, pending: 2 });
  assert.equal(todoSummary(list), '1 of 4 done');
  assert.equal(todoSummary([t('a', 'completed'), t('b', 'completed')]), 'All 2 done');
  assert.equal(todoSummary([t('a', 'completed')]), 'Done');
  assert.equal(todoSummary([]), 'Cleared');
});

test('continuesList: the same checklist updated, or a new plan', () => {
  const open = [t('a', 'completed'), t('b', 'in_progress')];
  // A list still in progress is always continued, even when Claude rewords every item.
  assert.equal(continuesList(open, [t('totally different')]), true);
  assert.equal(continuesList(open, [t('a', 'completed'), t('b', 'completed'), t('c')]), true);
  // A finished list is continued when the next call keeps one of its items (case and spacing aside)...
  const done = [t('Run the tests', 'completed'), t('Ship it', 'completed')];
  assert.equal(continuesList(done, [t('run  the TESTS', 'completed'), t('Ship it', 'completed'), t('One more')]), true);
  // ...and is a new plan when it shares none.
  assert.equal(continuesList(done, [t('Plan the next thing'), t('Build it')]), false);
  assert.equal(continuesList([], [t('a')]), false);
  assert.equal(continuesList(null, [t('a')]), false);
});

test('sameTodos: a redraw that would change nothing is skipped', () => {
  assert.equal(sameTodos([t('a', 'pending', 'A')], [t('a', 'pending', 'A')]), true);
  assert.equal(sameTodos([t('a')], [t('a', 'completed')]), false);
  assert.equal(sameTodos([t('a')], [t('a'), t('b')]), false);
});

test('todosHtml: a row per item with its state, the item at work emphasized, text escaped', () => {
  const html = todosHtml([
    t('Read <the> code', 'completed'),
    t('Fix "it"', 'in_progress', 'Fixing it'),
    t('Ship'),
  ]);
  assert.match(html, /<span class="todos-name">Todos<\/span><span class="todos-count">1 of 3 done<\/span>/);
  const rows = [...html.matchAll(/<li class="td (\w+)"([^>]*)>/g)];
  assert.deepEqual(rows.map((m) => m[1]), ['done', 'doing', 'todo']);
  assert.ok(rows[1][2].includes('aria-current="step"'), 'the item at work is the current step');
  assert.ok(!rows[0][2].includes('aria-current') && !rows[2][2].includes('aria-current'));
  assert.ok(html.includes('Read &lt;the&gt; code'), 'text is escaped');
  assert.ok(!html.includes('<the>'));
  assert.ok(html.includes('<span class="td-now">Fixing it</span>'), 'the present form shows under the item at work');
  assert.equal([...html.matchAll(/td-now/g)].length, 1, 'only the item at work shows it');
  assert.match(html, /<span class="td-sr">Done: <\/span>/);
  assert.match(html, /<span class="td-sr">In progress: <\/span>/);
  assert.match(html, /<span class="td-sr">To do: <\/span>/);
  assert.ok(!/status|<circle/.test(html), 'boxes, not dots');
  assert.equal(todosHtml([]).includes('<ul'), false, 'a cleared list is only the header');
});

/** A card with just what paintTodos touches. */
function card() {
  const cls = new Set();
  return { innerHTML: '', dataset: {}, attrs: {}, classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, has: (c) => cls.has(c) }, setAttribute(k, v) { this.attrs[k] = v; } };
}

test('paintTodos: draws the list, marks a finished one, counts redraws, names the card for screen readers', () => {
  const c = card();
  assert.deepEqual(paintTodos(c, [t('a', 'completed'), t('b')]), { total: 2, done: 1, doing: 0, pending: 1 });
  assert.equal(c.classList.has('all-done'), false);
  assert.equal(c.dataset.n, '1');
  assert.equal(c.attrs['aria-label'], 'Todo list, 1 of 2 done');
  paintTodos(c, [t('a', 'completed'), t('b', 'completed')]);
  assert.equal(c.classList.has('all-done'), true);
  assert.equal(c.dataset.n, '2');
  paintTodos(c, []);
  assert.equal(c.classList.has('cleared'), true);
  assert.equal(c.classList.has('all-done'), false);
});

/* the pane's side, on a fake DOM */

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this._cls = new Set();
    this.innerHTML = '';
    this.dataset = {};
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.offsetWidth = 0;
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c), remove: (c) => self._cls.delete(c), contains: (c) => self._cls.has(c),
      toggle(c, on) { if (on === undefined ? !self._cls.has(c) : on) self._cls.add(c); else self._cls.delete(c); },
    };
  }

  get className() { return [...this._cls].join(' '); }

  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }

  append(...nodes) { for (const n of nodes) { if (typeof n === 'object' && n) { n.parentNode = this; this.children.push(n); } } }

  setAttribute(k, v) { this.attrs[k] = v; }

  querySelector(sel) { return this.children.find((c) => sel.startsWith('.') && c.classList.contains(sel.slice(1))) || null; }
}

const cards = (T) => T.children.filter((c) => c.classList.contains('todos'));

/** A Pane's prototype methods on a plain object with a fake transcript. */
function fakePane() {
  const prev = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeEl(tag), createTextNode: (s) => ({ text: String(s) }) };
  const T = new FakeEl('div');
  const p = Object.create(Pane.prototype);
  Object.assign(p, { $: { T }, tools: new Map(), todoCard: null, cardKeys: new Set(), host: {}, scrollDown() {} });
  return { p, T, restore: () => { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; } };
}

const write = (id, todos) => ({ type: 'tool_use', id, name: 'TodoWrite', input: { todos } });

test('pane: TodoWrite calls of one turn update one checklist in place; the tool results leave it alone', async (tc) => {
  const { p, T, restore } = fakePane();
  tc.after(restore);
  p.addTool(write('t1', [t('Plan', 'in_progress', 'Planning'), t('Build'), t('Test')]));
  assert.equal(cards(T).length, 1);
  const card1 = cards(T)[0];
  assert.match(card1.innerHTML, /0 of 3 done/);
  assert.equal(card1.attrs.role, 'group');
  // A later call in the same turn: the same card, redrawn, with the glow.
  p.addTool(write('t2', [t('Plan', 'completed'), t('Build', 'in_progress', 'Building'), t('Test')]));
  assert.equal(cards(T).length, 1, 'no second card');
  assert.equal(T.children.length, 1);
  assert.match(card1.innerHTML, /1 of 3 done/);
  assert.ok(card1.innerHTML.includes('<span class="td-now">Building</span>'));
  assert.equal(card1.dataset.n, '2');
  assert.ok(card1.classList.contains('fresh'), 'a live update glows');
  // The same list again changes nothing.
  p.addTool(write('t3', [t('Plan', 'completed'), t('Build', 'in_progress', 'Building'), t('Test')]));
  assert.equal(card1.dataset.n, '2');
  // Every call's id points at the card, and a result does not add output to it.
  assert.equal(p.tools.get('t1'), card1);
  assert.equal(p.tools.get('t2'), card1);
  assert.equal(p.tools.get('t3'), card1);
  p.toolResult('t2', 'Todos have been modified successfully. Ensure that you continue to use the todo list...', false);
  assert.equal(card1.children.length, 0, 'nothing appended for a success');
  p.toolResult('t2', 'The todo list could not be saved\nsecond line', true);
  assert.equal(card1.children.length, 1);
  assert.equal(card1.children[0].innerHTML, 'The todo list could not be saved');
  p.toolResult('t2', 'again', true);
  assert.equal(card1.children.length, 1, 'one error line');
  await new Promise((r) => setTimeout(r, 950));
  assert.equal(card1.classList.contains('fresh'), false, 'the glow ends');
});

test('pane: a new turn starts a new checklist; a steered message does not', (tc) => {
  const { p, T, restore } = fakePane();
  tc.after(restore);
  p.addTool(write('a1', [t('One', 'in_progress')]));
  p.addUser('also do this', [], { steered: true });
  p.addTool(write('a2', [t('One', 'completed'), t('Two')]));
  assert.equal(cards(T).length, 1, 'a steered message is part of the turn that runs');
  assert.match(cards(T)[0].innerHTML, /1 of 2 done/);
  p.addUser('next thing', []);
  p.addTool(write('a3', [t('One', 'completed'), t('Two', 'in_progress')]));
  assert.equal(cards(T).length, 2, 'you wrote something: the call after it is a new card');
  assert.match(cards(T)[0].innerHTML, /1 of 2 done/, 'the first turn keeps the list as it ended');
  assert.equal(p.tools.get('a3'), cards(T)[1]);
});

test('pane: once the list is done, a call sharing none of it is a new plan; one that keeps an item continues it', (tc) => {
  const { p, T, restore } = fakePane();
  tc.after(restore);
  p.addTool(write('b1', [t('Run the tests', 'completed'), t('Ship it', 'completed')]));
  p.addTool(write('b2', [t('Run the tests', 'completed'), t('Ship it', 'completed'), t('Tell Arthur')]));
  assert.equal(cards(T).length, 1);
  assert.match(cards(T)[0].innerHTML, /2 of 3 done/);
  p.addTool(write('b3', [t('Tell Arthur', 'completed')]));
  p.addTool(write('b4', [t('Plan the next feature'), t('Build it')]));
  assert.equal(cards(T).length, 2, 'a finished list and a list that shares nothing with it');
});

test('pane: an empty list clears the checklist in place; with no checklist it stays a tool line', (tc) => {
  const { p, T, restore } = fakePane();
  tc.after(restore);
  p.addTool(write('c0', []));
  assert.equal(cards(T).length, 0);
  assert.equal(T.children.length, 1, 'an empty first call is an ordinary tool line');
  assert.ok(T.children[0].classList.contains('tool'));
  p.addTool(write('c1', [t('Only', 'in_progress')]));
  p.addTool(write('c2', []));
  assert.equal(cards(T).length, 1);
  assert.match(cards(T)[0].innerHTML, /Cleared/);
  assert.ok(cards(T)[0].classList.contains('cleared'));
});

test('pane: a TodoWrite without a list, and other tools, stay tool lines', (tc) => {
  const { p, T, restore } = fakePane();
  tc.after(restore);
  p.addTool({ type: 'tool_use', id: 'd1', name: 'TodoWrite', input: {} });
  p.addTool({ type: 'tool_use', id: 'd2', name: 'TodoWrite', input: { todos: 'not a list' } });
  p.addTool({ type: 'tool_use', id: 'd3', name: 'Bash', input: { command: 'ls' } });
  assert.equal(cards(T).length, 0);
  assert.equal(T.children.length, 3);
});

test('pane: history draws the same way, one card per turn, without the live glow', (tc) => {
  const { p, T, restore } = fakePane();
  tc.after(restore);
  const user = (text) => ({ type: 'user', uuid: text, message: { role: 'user', content: text } });
  const asst = (id, todos) => ({ type: 'assistant', uuid: id, message: { role: 'assistant', content: [write(id, todos)] } });
  const res = (id) => ({ type: 'user', uuid: `r${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully.' }] } });
  p.renderMessages([
    user('first request'),
    asst('h1', [t('A', 'in_progress'), t('B')]), res('h1'),
    asst('h2', [t('A', 'completed'), t('B', 'in_progress')]), res('h2'),
    asst('h3', [t('A', 'completed'), t('B', 'completed')]), res('h3'),
    user('second request'),
    asst('h4', [t('A', 'completed'), t('B', 'completed'), t('C', 'in_progress')]), res('h4'),
  ]);
  const found = cards(T);
  assert.equal(found.length, 2);
  assert.match(found[0].innerHTML, /All 2 done/, 'the first turn ends as it ended');
  assert.match(found[1].innerHTML, /2 of 3 done/);
  assert.equal(found[0].classList.contains('fresh'), false, 'no glow replaying history');
  assert.equal(found[0].children.length, 0, 'the results added nothing');
  assert.equal(p.tools.get('h2'), found[0]);
  assert.equal(p.tools.get('h4'), found[1]);
  assert.equal(p._replaying, false);
});
