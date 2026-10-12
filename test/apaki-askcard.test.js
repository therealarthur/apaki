/**
 * Questions and approvals inside the pane that asked (apaki/ui/askcard.js), 2026-10-12.
 *
 * Arthur: "when askuserquestion type things come up, it should be shown in the pane and not lock the user from using
 * the app". Every ask (Claude's AskUserQuestion, plan approval and permission prompts; Codex's questions, approvals
 * and forms) is a card in its own pane now, never a sheet over the window.
 *
 * Covered here without a DOM (AskBoard is pure): several panes waiting at once, each with its own card; the keyboard
 * scope (a key names its pane and only ever touches that pane's first card; numbers and Enter wait a moment after a
 * card takes the keyboard; Esc leaves without answering); a stale answer (ask_gone takes the card away with a line
 * saying who settled it, and a late key or click finds nothing); read-only cards on a phone that only watches; the
 * card's HTML and the design rules of its CSS; and how the window and the phone are wired to it.
 * The window's side was also driven in the demo harness (apaki/demo, window.__demo.emit) with Playwright.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AskBoard, GONE_NOTE_MS, KEEP_PLANNING_TEXT, READ_ONLY_TEXT, SKIP_TEXT, TYPING_MS, answered, askKind, cardHtml, cardKey, goneNote, kicker,
  questionAnswers, questionsModel, takeFocus,
} from '../apaki/ui/askcard.js';
import { ARM_MS } from '../apaki/ui/permission.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/* asks as the engine sends them */

const permission = (askId, paneId, extra = {}) => ({
  ev: 'ask', askId, paneId, toolName: 'Bash', input: { command: 'npm test' },
  permission: { title: 'Claude wants to run npm test', always: { lines: ['Allow Bash(npm test:*) for this project'] }, ...extra },
});
const question = (askId, paneId, questions) => ({ ev: 'ask', askId, paneId, toolName: 'AskUserQuestion', input: { questions } });
const plan = (askId, paneId) => ({ ev: 'ask', askId, paneId, toolName: 'ExitPlanMode', input: { plan: '1. Do it.' } });
const ONE = [{ question: 'Which fix?', header: 'Fix', options: [{ label: 'Wait', description: 'for the id' }, { label: 'Retry' }] }];
const TWO = [
  { question: 'Which fix?', options: [{ label: 'Wait' }, { label: 'Retry' }] },
  { question: 'Which browsers?', multiSelect: true, options: [{ label: 'Chromium' }, { label: 'WebKit' }, { label: 'Firefox' }] },
];

/** A board on a clock the test moves. */
function boardAt(start = 1000) {
  const clock = { t: start };
  const board = new AskBoard({ now: () => clock.t });
  return { board, clock, later: (ms) => { clock.t += ms; } };
}
const key = (k, o = {}) => ({ key: k, target: 'card', ...o });

/* what each ask is */

test('askKind and questionsModel: a permission prompt, a plan, questions; Codex\'s typed answers, secrets and forms', () => {
  assert.equal(askKind(permission('a', 'p')), 'permission');
  assert.equal(askKind(plan('a', 'p')), 'plan');
  assert.equal(askKind(question('a', 'p', ONE)), 'questions');
  const m = questionsModel({ input: { message: 'Fill this in', questions: [
    { question: 'Pick', options: [{ label: 'A' }, { label: '' }, null], other: false },
    { question: 'Token', secret: true },
    { question: '', options: [{ label: 'x' }], multiSelect: true },
  ] } });
  assert.equal(m.message, 'Fill this in');
  assert.deepEqual(m.questions.map((q) => [q.text, q.options.length, q.other, q.secret, q.multi]), [
    ['Pick', 1, false, false, false],
    ['Token', 0, true, true, false],
    ['Question 3', 1, true, false, true],
  ]);
  assert.equal(m.questions[2].key, '', 'the answer keeps the question\'s own text as its key');
});

test('questionAnswers: a typed answer wins, else the picks in order, joined as the sheet sent them', () => {
  const model = questionsModel(question('a', 'p', TWO));
  const ui = { picks: [[1], [0, 2]], other: ['', ''] };
  assert.deepEqual(questionAnswers(model, ui), { 'Which fix?': 'Retry', 'Which browsers?': 'Chromium, Firefox' });
  assert.deepEqual(questionAnswers(model, { picks: [[1], []], other: ['my own', ''] }), { 'Which fix?': 'my own', 'Which browsers?': '' });
  assert.equal(answered({ picks: [[]], other: ['  '] }, 0), false);
  assert.equal(answered({ picks: [[]], other: ['x'] }, 0), true);
});

/* the keyboard */

test('cardKey: numbers, Enter, arrows, Esc and letters inside a card; shortcuts, Tab, typing and an IME are left alone', () => {
  assert.deepEqual(cardKey(key('Escape')), { act: 'leave' });
  assert.deepEqual(cardKey(key('Escape', { target: 'field' })), { act: 'leave' }, 'Esc leaves a field too');
  assert.deepEqual(cardKey(key('3')), { act: 'num', n: 3 });
  assert.deepEqual(cardKey(key('3', { target: 'button' })), { act: 'num', n: 3 });
  assert.equal(cardKey(key('3', { target: 'field' })), null, 'a number typed in a field is text');
  assert.equal(cardKey(key('0')).act, 'type', '0 is not a choice');
  assert.deepEqual(cardKey(key('Enter')), { act: 'enter' });
  assert.equal(cardKey(key('Enter', { target: 'button' })), null, 'a row\'s Enter is its own click');
  assert.deepEqual(cardKey(key('Enter', { target: 'field' })), { act: 'field-enter' });
  assert.equal(cardKey(key('Enter', { shiftKey: true })), null);
  assert.equal(cardKey(key('Enter', { repeat: true })), null);
  assert.equal(cardKey(key('1', { repeat: true })), null, 'a held number answers nothing');
  assert.deepEqual(cardKey(key('ArrowDown')), { act: 'move', by: 1 });
  assert.deepEqual(cardKey(key('ArrowUp', { target: 'button' })), { act: 'move', by: -1 });
  assert.equal(cardKey(key('ArrowDown', { target: 'field' })), null);
  assert.deepEqual(cardKey(key('h')), { act: 'type' }, 'a letter belongs in the message box');
  assert.equal(cardKey(key(' ', { target: 'button' })), null, 'Space presses the row');
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(cardKey(key('1', { [mod]: true })), null, mod);
  assert.equal(cardKey(key('Tab')), null);
  assert.equal(cardKey(key('F3')), null);
});

test('takeFocus: a new card takes the keyboard only in the pane you are in, never while you type, never on the phone', () => {
  const t = (o) => takeFocus({ paneFocused: true, ...o });
  assert.equal(t({ where: 'none' }), true, 'nothing had the keyboard');
  assert.equal(t({ where: 'pane' }), true, 'its pane, not a text field (a card that was just answered)');
  assert.equal(t({ where: 'composer', draft: '', typedAgo: TYPING_MS + 1 }), true, 'an empty message box you are not typing in');
  assert.equal(t({ where: 'composer', draft: 'half a sentence' }), false, 'a draft keeps the keyboard');
  assert.equal(t({ where: 'composer', draft: '', typedAgo: 200 }), false, 'typing just now keeps it');
  assert.equal(t({ where: 'field' }), false, 'another field in that pane (find, rename)');
  assert.equal(t({ where: 'elsewhere' }), false, 'another pane, the sidebar, a menu: focus never jumps to this question');
  assert.equal(takeFocus({ paneFocused: false, where: 'none' }), false, 'a pane you are not in waits quietly');
  assert.equal(t({ web: true, where: 'none' }), false, 'no keyboard pops up on the phone');
});

/* several panes at once, and the keyboard scope */

test('several panes wait at once, each with its own card; a repeat of an ask (a reconnect) changes nothing', () => {
  const { board } = boardAt();
  assert.ok(board.add(permission('a1', 'pA')));
  assert.ok(board.add(question('b1', 'pB', ONE)));
  assert.ok(board.add(plan('c1', 'pC')));
  assert.ok(board.add(question('a2', 'pA', ONE)), 'a second ask in the same pane waits behind the first');
  assert.equal(board.add(question('b1', 'pB', ONE)), null, 'the engine asks again on attach: same card');
  assert.equal(board.add({ ev: 'ask', paneId: 'pA' }), null, 'no id, no card');
  assert.deepEqual(board.waiting(), ['pA', 'pB', 'pC']);
  assert.deepEqual(['pA', 'pB', 'pC', 'pD'].map((p) => board.count(p)), [2, 1, 1, 0]);
  assert.deepEqual(['pA', 'pB', 'pC'].map((p) => board.current(p).askId), ['a1', 'b1', 'c1']);
  assert.equal(board.get('a2').paneId, 'pA');
  assert.equal(kicker(board.current('pA')), 'Claude asks permission');
  assert.equal(kicker(board.add(question('d1', 'pD', TWO), { who: 'Codex' })), 'Codex has 2 questions');
  assert.equal(kicker(board.current('pC')), 'Claude\'s plan');
});

test('keyboard scope: a key answers only the card of the pane it was pressed in, and only once', () => {
  const { board, later } = boardAt();
  board.add(permission('a1', 'pA'));
  board.add(question('b1', 'pB', ONE));
  board.add(permission('a2', 'pA'));
  // 1 in pane B picks B's first option: B's question is answered and goes; A is untouched.
  const b = board.key('pB', key('1'));
  assert.deepEqual([b.do, b.askId, b.paneId], ['answer', 'b1', 'pB']);
  assert.deepEqual(b.result.updatedInput.answers, { 'Which fix?': 'Wait' });
  assert.equal(board.count('pB'), 0);
  assert.equal(board.count('pA'), 2);
  assert.equal(board.key('pB', key('1')), null, 'pane B has nothing left: the second press answers nothing anywhere');
  assert.equal(board.key('pZ', key('1')), null, 'a pane with no card');
  // 3 in pane A is Deny on A's first card; its second card is next, and taking the keyboard arms it.
  assert.deepEqual(board.key('pA', key('3')).result, { behavior: 'deny', message: '' });
  assert.equal(board.current('pA').askId, 'a2');
  board.arm('pA');
  assert.equal(board.key('pA', key('1')), null, 'numbers wait a moment after a card takes the keyboard');
  assert.equal(board.key('pA', key('Enter')), null, 'so does Enter');
  assert.deepEqual(board.key('pA', key('Escape')), { do: 'leave' }, 'Esc always works, and answers nothing');
  later(ARM_MS);
  assert.deepEqual(board.key('pA', key('1')).result, { behavior: 'allow' });
  assert.deepEqual(board.waiting(), []);
});

test('keyboard: arrows move between rows, letters go to the message box, Tab and shortcuts belong to the page', () => {
  const { board } = boardAt();
  board.add(permission('a1', 'pA'));
  assert.deepEqual(board.key('pA', key('ArrowDown')), { do: 'move', by: 1 });
  assert.deepEqual(board.key('pA', key('x')), { do: 'type' });
  assert.equal(board.key('pA', key('Tab')), null);
  assert.equal(board.key('pA', key('1', { ctrlKey: true })), null, 'Ctrl+1 still focuses pane 1');
  assert.equal(board.count('pA'), 1);
});

/* each kind */

test('a permission card: 1 once, 2 always, 3 deny; Enter allows once unless the SDK asked for a default of no; a note goes with Deny', () => {
  const { board } = boardAt();
  board.add(permission('a1', 'p'));
  assert.deepEqual(board.key('p', key('2')).result, { behavior: 'allow', always: true });
  board.add(permission('a2', 'p'));
  assert.deepEqual(board.key('p', key('Enter')).result, { behavior: 'allow' });
  board.add(permission('a3', 'p', { defaultToNo: true }));
  assert.equal(board.key('p', key('Enter')), null, 'a default of no: Enter does not approve');
  board.setText('p', { note: 'use pnpm' });
  assert.deepEqual(board.key('p', key('Enter', { target: 'field', field: 'note' })).result, { behavior: 'deny', message: 'use pnpm' });
  board.add(permission('a4', 'p', { always: null }));
  assert.deepEqual(board.current('p').choices, ['once', 'deny']);
  assert.equal(board.key('p', key('3')), null, 'no third row without Always allow');
  assert.deepEqual(board.choose('p', { askId: 'a4', k: 'deny' }).result, { behavior: 'deny', message: '' });
});

test('a plan card: 1 approves (and the window leaves plan mode), 2 keeps planning with the note or the old words', () => {
  const { board } = boardAt();
  board.add(plan('c1', 'p'));
  const go = board.key('p', key('1'));
  assert.equal(go.then, 'plan-approved');
  assert.deepEqual(go.result, { behavior: 'allow', updatedInput: { plan: '1. Do it.' } });
  board.add(plan('c2', 'p'));
  assert.deepEqual(board.choose('p', { k: 'keep' }).result, { behavior: 'deny', message: KEEP_PLANNING_TEXT });
  board.add(plan('c3', 'p'));
  board.setText('p', { note: 'split step 2' });
  assert.deepEqual(board.key('p', key('Enter', { target: 'field', field: 'note' })).result, { behavior: 'deny', message: 'split step 2' });
  board.add(plan('c4', 'p'));
  assert.equal(board.key('p', key('Enter')).then, 'plan-approved', 'Enter approves, as the first row');
});

test('questions: one answer moves on by itself, several need Enter, a typed answer replaces a pick, Skip and Answer always work', () => {
  const { board } = boardAt();
  board.add(question('q1', 'p', TWO));
  // 2 answers the first question and makes the second the current one.
  assert.deepEqual(board.key('p', key('2')), { do: 'paint', focus: 'card' });
  assert.equal(board.current('p').ui.cur, 1);
  // The second takes several: numbers toggle, nothing is sent until Enter.
  assert.deepEqual(board.key('p', key('3')), { do: 'paint' });
  assert.deepEqual(board.key('p', key('1')), { do: 'paint' });
  assert.deepEqual(board.key('p', key('3')), { do: 'paint' }, 'a second press takes it back');
  assert.deepEqual(board.current('p').ui.picks, [[1], [0]]);
  const sent = board.key('p', key('Enter'));
  assert.deepEqual(sent.result.updatedInput.answers, { 'Which fix?': 'Retry', 'Which browsers?': 'Chromium' });
  // The row after the options is "Other": its number puts you in the field; typing there replaces a pick.
  board.add(question('q2', 'p', ONE));
  assert.deepEqual(board.key('p', key('3')), { do: 'other', q: 0 });
  board.choose('p', { q: 0, o: 0 });
  board.add(question('q3', 'p', TWO));
  board.choose('p', { q: 0, o: 1 });
  board.setText('p', { q: 0, text: 'something else' });
  assert.deepEqual(board.current('p').ui.picks[0], [], 'a typed answer replaces the pick');
  assert.equal(board.key('p', key('Enter', { target: 'field', field: 0 })).do, 'paint', 'on to the question still open');
  assert.equal(board.current('p').ui.cur, 1);
  assert.deepEqual(board.choose('p', { k: 'answer' }).result.updatedInput.answers, { 'Which fix?': 'something else', 'Which browsers?': '' }, 'Answer sends what is there');
  board.add(question('q4', 'p', ONE));
  assert.deepEqual(board.choose('p', { k: 'skip' }).result, { behavior: 'deny', message: SKIP_TEXT });
  // A question with no options is typed: Enter in its field sends it.
  board.add(question('q5', 'p', [{ question: 'Name?' }]));
  assert.equal(board.key('p', key('Enter', { target: 'field', field: 0 })), null, 'nothing typed yet');
  board.setText('p', { q: 0, text: 'Maya' });
  assert.deepEqual(board.key('p', key('Enter', { target: 'field', field: 0 })).result.updatedInput.answers, { 'Name?': 'Maya' });
});

/* stale answers */

test('a stale answer: ask_gone takes the card away with who settled it, and a late key or click finds nothing', () => {
  const { board } = boardAt();
  board.add(question('q1', 'pA', ONE));
  board.add(permission('p1', 'pA'));
  board.add(plan('c1', 'pB'));
  // Answered on the phone that follows this pane (the shared view): the card on screen goes, with one line.
  const g = board.gone({ ev: 'ask_gone', askId: 'q1', paneId: 'pA', why: 'answered', by: "Maya's iPhone" });
  assert.equal(g.wasCurrent, true);
  assert.equal(g.note, "Answered on Maya's iPhone.");
  assert.equal(board.choose('pA', { askId: 'q1', q: 0, o: 0 }), null, 'a click on the card that just went does nothing');
  assert.equal(board.current('pA').askId, 'p1', 'the next one shows');
  // A card waiting behind another goes quietly: nobody saw it.
  board.add(question('q2', 'pA', ONE));
  assert.equal(board.gone({ askId: 'q2', why: 'turn' }).note, '');
  // Gone twice, or after an answer: nothing.
  assert.equal(board.gone({ askId: 'q1', why: 'turn' }), null);
  board.key('pA', key('1'));
  assert.equal(board.gone({ askId: 'p1', why: 'turn' }), null, 'answered here first: the engine\'s late word changes nothing');
  assert.equal(board.count('pA'), 0);
  // The pane in a background tab keeps its card until something settles it.
  assert.equal(board.current('pB').askId, 'c1');
  board.clear('pB');
  assert.equal(board.count('pB'), 0);
});

test('goneNote: one short line for each reason the engine gives, no line for a closed pane', () => {
  assert.equal(goneNote({ why: 'answered', by: 'the PC' }), 'Answered on the PC.');
  assert.equal(goneNote({ why: 'taken', by: 'Pixel 9 (phone)' }), 'Pixel 9 (phone) took this conversation, and the question went with it.');
  assert.equal(goneNote({ why: 'resolved', by: 'Codex' }, 'Codex'), 'Settled in Codex before an answer came from here.');
  assert.equal(goneNote({ why: 'turn' }), 'No longer needed: the turn ended.');
  assert.equal(goneNote({ why: 'again' }), 'Claude asked again.');
  assert.equal(goneNote({ why: 'cancelled' }, 'Codex'), 'Codex withdrew the request.');
  assert.equal(goneNote({ why: 'stopped' }), 'Claude stopped before an answer came.');
  assert.match(goneNote({ why: 'restart' }), /^The conversation restarted\./);
  assert.equal(goneNote({ why: 'closed' }), '');
  assert.equal(goneNote({}), 'Settled elsewhere.', 'an older engine says no reason');
  assert.equal(goneNote({ why: 'answered', by: 'x'.repeat(200) }).length, 'Answered on .'.length + 80, 'a long name is cut');
  assert.ok(GONE_NOTE_MS >= 3000 && GONE_NOTE_MS <= 10000);
});

test('read only: a phone that only watches sees the card, answers nothing, and the pane is not marked as waiting for it', () => {
  const { board } = boardAt();
  const e = board.add({ ...question('r1', 'pF', ONE), readOnly: true });
  assert.equal(e.readOnly, true);
  assert.equal(board.count('pF'), 1);
  assert.equal(board.answerable('pF'), 0);
  assert.deepEqual(board.waiting(), []);
  assert.equal(board.key('pF', key('1')), null);
  assert.equal(board.key('pF', key('Enter')), null);
  assert.equal(board.choose('pF', { q: 0, o: 0 }), null);
  assert.equal(board.setText('pF', { note: 'x' }), null);
  assert.deepEqual(board.key('pF', key('Escape')), { do: 'leave' });
  const html = cardHtml(e);
  assert.ok(html.includes(READ_ONLY_TEXT));
});

/* the card */

test('cardHtml: escaped, numbered rows, the count of what else waits, the plan\'s way out of plan mode only when it applies', () => {
  const { board } = boardAt();
  const q = board.add(question('q<1>', 'p', [{ question: 'Use <b>?', header: 'H&H', options: [{ label: '<i>A</i>', description: 'd "1"' }] }]));
  const html = cardHtml(q, { count: 3 });
  assert.ok(html.includes('Use &lt;b&gt;?') && html.includes('&lt;i&gt;A&lt;/i&gt;') && html.includes('H&amp;H'));
  assert.ok(!html.includes('<b>?') && !html.includes('<i>A'));
  assert.ok(html.includes('2 more waiting'));
  assert.ok(html.includes('<span class="ask-n" aria-hidden="true">1</span>') && html.includes('<span class="ask-n" aria-hidden="true">2</span>'), 'the option, then Other');
  assert.ok(html.includes('id="ask-q_1_-q0"'), 'ids are safe');
  assert.ok(html.includes('data-k="skip"') && html.includes('data-k="answer"'));
  const p = board.add(plan('c1', 'p2'));
  assert.ok(cardHtml(p, { leavesPlan: true }).includes('Leaves plan mode'));
  assert.ok(!cardHtml(p).includes('Leaves plan mode'));
  const perm = board.add(permission('a1', 'p3'));
  const ph = cardHtml(perm);
  assert.ok(ph.includes('Claude asks permission') && ph.includes('data-k="always"'));
  const secret = board.add(question('s1', 'p4', [{ question: 'Token', secret: true }]));
  assert.ok(cardHtml(secret).includes('type="password"'));
  for (const h of [html, cardHtml(p), ph]) assert.ok(!h.includes('—') && !h.includes('-'.repeat(2)), 'no em dashes or double hyphens');
});

test('the card\'s CSS: type tokens only, no stripe down a side, no dot, motion that respects reduced motion', () => {
  const css = read('apaki', 'ui', 'app.css');
  const start = css.indexOf('/* ---------- questions and approvals in the pane (askcard.js');
  assert.ok(start > 0);
  const end = css.indexOf('/* The todo checklist', start);
  const block = css.slice(start, end);
  assert.ok(block.length > 3000);
  assert.deepEqual([...block.matchAll(/font(-size)?:[^;]*?\d+(\.\d+)?px/g)].map((m) => m[0]), [], 'the type tokens only');
  assert.doesNotMatch(block, /border-left|border-right:|box-shadow: inset [1-9]/, 'no stripe down a side');
  assert.doesNotMatch(block, /border-radius: 50%|status-dot/, 'no dot');
  assert.match(block, /prefers-reduced-motion/);
  for (const sel of ['.ask-dock', '.ask-card', '.ask-choice.on', '.ask-wait', '.tab.waiting .tab-t', '.pane.waiting .pane-bar .title', '.ask-gone', '.ask-ro']) assert.ok(block.includes(sel), sel);
  // The phone: 44 px rows and buttons, fields at 16 px so iOS does not zoom.
  const web = read('apaki', 'web', 'src', 'web.css');
  assert.match(web, /body\.web \.ask-choice, body\.web \.ask-btn \{ min-height: 44px; \}/);
  assert.match(web, /body\.web \.ask-card input\[type=text\][^{]*\{ font-size: 16px;/);
  assert.match(web, /\.ts-chip\.waiting \.ts-t/);
});

/* the wiring */

test('the window: asks go to the pane\'s card, never a sheet; tabs, the badge and focus follow waiting panes', () => {
  const app = read('apaki', 'ui', 'app.js');
  assert.ok(app.includes("import { createAsks } from './askcard.js';"));
  assert.ok(!/askSheet\(|permissionSheet\(/.test(app.replace(/^\s*\/\/.*$/gm, '')), 'no question sheet is drawn any more');
  assert.match(app, /case 'ask': \{[\s\S]*?const entry = p \? asks\.ask\(e, p\) : null;/);
  assert.match(app, /case 'ask_gone': asks\.gone\(e, S\.panes\.get\(e\.paneId\)\);/);
  assert.match(app, /if \(e\.ev === 'opened' && !e\.attached\) asks\.reset\(p\);/, 'a pane opened afresh drops what it asked before');
  assert.match(app, /!asks\.focus\(p\)\) p\.\$\.input\?\.focus/, 'focusing a waiting pane gives its card the keyboard');
  assert.match(app, /tab\.onclick = \(\) => \{ switchTab\(t\); const w = waitingPaneIn\(t\); if \(w\) focusPane\(w\); \};/, 'the question is one click from its tab');
  assert.match(app, /S\.panes\.get\(id\)\?\.unread \|\| asks\.waiting\(id\)/, 'the taskbar badge counts a waiting tab like a ready one');
  assert.match(app, /\$\{waiting \? ' waiting' : ''\}/, 'the tab is marked');
  assert.match(app, /p\.setMode\('bypassPermissions'\)/, 'approving a plan still leaves plan mode');
  assert.match(app, /asks\.drop\(p\);/, 'a closed pane forgets its cards');
  // The engine says why a question went, so the card can say so.
  const engine = read('apaki', 'engine', 'engine.js');
  for (const why of ["why: 'taken'", "why: 'answered'", "why: 'again'", "why: 'stopped'", "why: 'closed'"]) assert.ok(engine.includes(why), why);
  assert.ok(read('apaki', 'engine', 'codex-panes.js').includes("why: 'resolved', by: 'Codex'"));
  assert.ok(read('apaki', 'engine', 'permissions.js').includes("why: 'cancelled'"));
});

test('the phone: the tab strip, the nav line and the page segments say which pane waits', () => {
  // stripModel itself is checked on the built page (test/apaki-phone-ui.test.js, the tab strip).
  const pager = read('apaki', 'web', 'src', 'pager.js');
  assert.ok(pager.includes('waiting: Boolean(t.waiting)'), 'the strip model carries it');
  assert.ok(pager.includes("${t.waiting ? ' waiting' : ''}"), 'the strip marks it');
  assert.ok(pager.includes("wait.textContent = el?.classList.contains('waiting') ? 'Waiting for you' : '';"), 'the nav line says it');
  assert.ok(pager.includes("classList.toggle('waiting', el.classList.contains('waiting'))"), 'the segment of its page');
});
