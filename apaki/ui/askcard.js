/**
 * askcard.js: questions and approvals inside the pane that asked, docked above its message box (2026-10-12).
 *
 * WHY (Arthur, 2026-10-12: "when askuserquestion type things come up, it should be shown in the pane and not lock
 * the user from using the app"): Claude's AskUserQuestion, plan approval (ExitPlanMode) and permission prompts
 * (engine permissions.js), and Codex's requestUserInput, its command, file and permission approvals and MCP
 * elicitation forms (engine codex-map.js), all arrive as the engine's `ask` event. They used to open one sheet over
 * the whole window, which blocked the other panes, the tabs and the sidebar until it was answered. Now each is a
 * card in its own pane, the way Claude Code's terminal and the Codex app show them, and the rest of the window stays
 * usable: other panes, tabs, the sidebar, menus, typing in another message box.
 *
 *   AskBoard        every waiting ask, by pane, and what a key or a click does to one. Pure (no DOM), so
 *                   test/apaki-askcard.test.js checks several waiting panes, the keyboard scope and a stale answer.
 *   cardKey         what a key means inside a card: a number picks, Enter answers, arrows move between rows,
 *                   Esc goes back to the message box without answering, a letter goes to the message box.
 *   takeFocus       whether a card that just came may take the keyboard: only in the pane you are in, and never
 *                   while you type there or anywhere else.
 *   goneNote        the one quiet line a card leaves when it was settled elsewhere or went stale (ask_gone `why`).
 *   cardHtml        the card's HTML; permission prompts come from permission.js.
 *   createAsks      the window's side: one AskView per pane (its card, the "Waiting for you" mark in its header,
 *                   focus), and the answer op. app.js asks it which panes wait, for the tabs and the taskbar badge.
 *
 * Keys stay in their pane: the card listens on its own dock, so a number or Enter only ever answers the card that
 * has the keyboard, and a card never takes the keyboard from another pane. A pane in a background tab keeps its
 * card until you come back. Shared by the desktop window and the phone page (apaki/ui ships whole, build-web.mjs);
 * what a phone may approve is still decided on the PC (engine remote-policy.js), the card only shows what came.
 */

import { esc, md } from './markdown.js';
import { ARM_MS, denyLabel, permissionChoices, permissionHtml, permissionKey, permissionReply, permissionView } from './permission.js';

/** A message box typed in this recently keeps the keyboard when a card comes. */
export const TYPING_MS = 1500;
/** How long the line a settled card leaves stays once its pane is on screen. */
export const GONE_NOTE_MS = 6000;
/** What Claude is told for a skipped question and a plan kept without a note (the words the sheets used). */
export const SKIP_TEXT = 'The user skipped the question.';
export const KEEP_PLANNING_TEXT = 'The user wants to keep planning.';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 'permission' (a tool call or a Codex approval), 'plan' (ExitPlanMode) or 'questions' (AskUserQuestion, a Codex question or form). */
export function askKind(e) {
  if (isObj(e?.permission)) return 'permission';
  if (e?.toolName === 'ExitPlanMode') return 'plan';
  return 'questions';
}

/**
 * The questions of an AskUserQuestion (or of a Codex question or form, which the engine words the same way), ready
 * to draw: each with its text (also the key of its answer), a short header, its options, whether it takes several,
 * whether it is secret, and whether a typed answer ("Other") is offered. A question without options is typed.
 */
export function questionsModel(e) {
  const input = isObj(e?.input) ? e.input : {};
  const list = Array.isArray(input.questions) ? input.questions.filter(isObj) : [];
  return {
    message: str(input.message).trim(),
    questions: list.map((q, i) => {
      const options = (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o) => ({ label: str(o.label), description: str(o.description) })).filter((o) => o.label);
      const key = str(q.question);
      return { key, text: key || `Question ${i + 1}`, header: str(q.header).trim(), multi: Boolean(q.multiSelect), secret: Boolean(q.secret), other: q.other !== false || !options.length, options };
    }),
  };
}

/** Whether question `i` has an answer: a typed one, or at least one option. */
export const answered = (ui, i) => Boolean(str(ui?.other?.[i]).trim()) || (ui?.picks?.[i]?.length || 0) > 0;

/** The answers object AskUserQuestion takes: per question its typed answer, else its picks joined by commas (as the sheet sent). */
export function questionAnswers(model, ui) {
  const answers = {};
  model.questions.forEach((q, i) => {
    const other = str(ui.other[i]).trim();
    answers[q.key] = other || (ui.picks[i] || []).map((oi) => q.options[oi]?.label).filter(Boolean).join(', ');
  });
  return answers;
}

/**
 * What a key means inside a card, before the card's kind says what it does:
 *   { act: 'leave' }            Esc: back to the message box, nothing answered
 *   { act: 'num', n }           1 to 9 on the card or a row
 *   { act: 'enter' }            Enter on the card itself (a row's Enter is its own click)
 *   { act: 'field-enter' }      Enter in a text field of the card (a note, a typed answer)
 *   { act: 'move', by }         ArrowDown / ArrowUp between the rows
 *   { act: 'type' }             any other character: it belongs in the message box
 * null leaves the key to the page (Tab, shortcuts with Ctrl, Alt or Cmd, typing inside a field, an IME at work).
 * target: 'card' (the card itself), 'button' (a row or a button), 'field' (a text field in the card).
 */
export function cardKey({ key, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false, repeat = false, isComposing = false, target = 'card' } = {}) {
  if (ctrlKey || metaKey || altKey || isComposing || typeof key !== 'string') return null;
  if (key === 'Escape') return { act: 'leave' };
  if (target === 'field') return key === 'Enter' && !shiftKey && !repeat ? { act: 'field-enter' } : null;
  if (/^[1-9]$/.test(key)) return repeat ? null : { act: 'num', n: Number(key) };
  if (key === 'ArrowDown' || key === 'ArrowUp') return { act: 'move', by: key === 'ArrowDown' ? 1 : -1 };
  if (key === 'Enter') return target === 'button' || shiftKey || repeat ? null : { act: 'enter' };
  if (key === ' ' && target === 'button') return null;
  if (key.length === 1) return { act: 'type' };
  return null;
}

/**
 * Whether a card that just came (or became the first of its pane) takes the keyboard. Only in the pane you are in
 * (paneFocused), never on the phone (no keyboard pops up for it), and only when the keyboard is in that pane or
 * nowhere: where is 'none' (nothing has focus), 'pane' (that pane, not a text field), 'composer' (its message box),
 * 'field' (another text field in that pane) or 'elsewhere' (another pane, the sidebar, a menu). In its message box it
 * waits while there is a draft or you typed in the last TYPING_MS, so a question never eats what you are writing.
 */
export function takeFocus({ web = false, paneFocused = false, where = 'none', draft = '', typedAgo = Infinity } = {}) {
  if (web || !paneFocused) return false;
  if (where === 'none' || where === 'pane') return true;
  if (where === 'composer') return !str(draft).trim() && typedAgo > TYPING_MS;
  return false;
}

/**
 * The line a card leaves when it goes without an answer from here (ask_gone): who settled it, or why it is not
 * needed any more. '' for none (a closed pane says nothing). who: 'Claude' or 'Codex'.
 */
export function goneNote(e, who = 'Claude') {
  const by = str(e?.by).replace(/\s+/g, ' ').trim().slice(0, 80);
  switch (e?.why) {
    case 'taken': return `${by || 'Another window'} took this conversation, and the question went with it.`;
    case 'resolved': return `Settled in ${by || 'Codex'} before an answer came from here.`;
    case 'turn': return 'No longer needed: the turn ended.';
    case 'again': return `${who} asked again.`;
    case 'cancelled': return `${who} withdrew the request.`;
    case 'stopped': return `${who} stopped before an answer came.`;
    case 'restart': return `The conversation restarted. ${who} asks again if it still needs to.`;
    case 'closed': return '';
    default: return by ? `Answered on ${by}.` : 'Settled elsewhere.';
  }
}

/** The quiet words above a card: who asks, and what. */
export function kicker(entry) {
  const who = entry.who || 'Claude';
  if (entry.kind === 'permission') return `${who} asks first`;
  if (entry.kind === 'plan') return `${who}'s plan`;
  const n = entry.model?.questions.length || 0;
  return `${who} has ${n === 1 ? 'a question' : `${n} questions`}`;
}

/**
 * Every ask waiting in this window, by pane, and what a key or a click does to one. Pure: it returns what to do
 * ({ do: 'answer', askId, result }, { do: 'leave' }...) and the window does it (createAsks below). A key or a click
 * always names its pane, and only that pane's first ask is ever touched, so answering in one pane never answers
 * another. An answer removes the ask at once: a second key, a stale card or a late ask_gone finds nothing.
 */
export class AskBoard {
  constructor({ now = () => Date.now(), armMs = ARM_MS } = {}) {
    this.now = now;
    this.armMs = armMs;
    this.panes = new Map(); // paneId -> [entry], oldest first
    this.where = new Map(); // askId -> paneId
  }

  /**
   * A new ask; the same one again (the engine asks again when a window reconnects) changes nothing and returns null.
   * who: 'Claude' or 'Codex', for the card's words.
   */
  add(e, { who = 'Claude' } = {}) {
    const askId = str(e?.askId);
    const paneId = str(e?.paneId);
    if (!askId || !paneId || this.where.has(askId)) return null;
    const kind = askKind(e);
    const entry = { askId, paneId, kind, who, e, at: this.now(), armedAt: 0, ui: { cur: 0, picks: [], other: [], note: '' } };
    if (kind === 'permission') {
      entry.view = permissionView(e);
      entry.choices = permissionChoices(entry.view);
    } else if (kind === 'plan') {
      entry.plan = str(e.input?.plan);
      entry.choices = ['go', 'keep'];
    } else {
      entry.model = questionsModel(e);
      entry.ui.picks = entry.model.questions.map(() => []);
      entry.ui.other = entry.model.questions.map(() => '');
    }
    if (!this.panes.has(paneId)) this.panes.set(paneId, []);
    this.panes.get(paneId).push(entry);
    this.where.set(askId, paneId);
    return entry;
  }

  list(paneId) { return [...(this.panes.get(paneId) || [])]; }

  /** The ask the pane shows now (its oldest). */
  current(paneId) { return this.panes.get(paneId)?.[0] || null; }

  count(paneId) { return this.panes.get(paneId)?.length || 0; }

  get(askId) {
    const paneId = this.where.get(askId);
    return paneId ? (this.panes.get(paneId) || []).find((x) => x.askId === askId) || null : null;
  }

  /** The panes with something waiting, in the order they first asked. */
  waiting() { return [...this.panes.entries()].filter(([, l]) => l.length).map(([id]) => id); }

  /** Takes an ask off the board; returns it with whether it was the one its pane showed. */
  remove(askId) {
    const paneId = this.where.get(askId);
    if (!paneId) return null;
    this.where.delete(askId);
    const list = this.panes.get(paneId) || [];
    const i = list.findIndex((x) => x.askId === askId);
    if (i < 0) return null;
    const [entry] = list.splice(i, 1);
    if (!list.length) this.panes.delete(paneId);
    return { entry, wasCurrent: i === 0 };
  }

  /** ask_gone: the ask is over without an answer from here. Returns the entry, whether it was shown, and the line to leave. */
  gone(e) {
    const r = this.remove(str(e?.askId));
    if (!r) return null;
    return { ...r, note: r.wasCurrent ? goneNote(e, r.entry.who) : '' };
  }

  /** Every ask of a pane, gone at once (the pane closed, or its conversation restarted). */
  clear(paneId) {
    const list = this.list(paneId);
    for (const x of list) this.where.delete(x.askId);
    this.panes.delete(paneId);
    return list;
  }

  /** The pane's card took the keyboard: numbers and Enter wait ARM_MS, so a keystroke meant for the message box answers nothing. */
  arm(paneId) {
    const entry = this.current(paneId);
    if (entry) entry.armedAt = this.now() + this.armMs;
  }

  armed(entry) { return this.now() >= (entry?.armedAt || 0); }

  /**
   * A key in the card of `paneId`. k: cardKey's input plus `field` ('note', or a question's index for its typed
   * answer). Returns what to do, or null to leave the key to the page.
   */
  key(paneId, k = {}) {
    const entry = this.current(paneId);
    if (!entry) return null;
    const a = cardKey(k);
    if (!a) return null;
    if (a.act === 'leave') return { do: 'leave' };
    if (a.act === 'move') return { do: 'move', by: a.by };
    if (a.act === 'type') return { do: 'type' };
    const armed = this.armed(entry);
    if (entry.kind === 'permission') {
      const c = permissionKey({ ...k, target: k.target === 'card' ? 'other' : k.target, noteText: entry.ui.note, armed, defaultToNo: entry.view.defaultToNo, choices: entry.choices });
      return c && c !== 'leave' ? this.decide(entry, c) : null;
    }
    if (entry.kind === 'plan') {
      if (a.act === 'num') return armed && entry.choices[a.n - 1] ? this.decide(entry, entry.choices[a.n - 1]) : null;
      if (a.act === 'enter') return armed ? this.decide(entry, 'go') : null;
      return entry.ui.note.trim() ? this.decide(entry, 'keep') : null;
    }
    const qs = entry.model.questions;
    const ui = entry.ui;
    if (a.act === 'num') {
      if (!armed) return null;
      const q = qs[ui.cur];
      if (!q) return null;
      if (a.n - 1 < q.options.length) return this.pick(entry, ui.cur, a.n - 1);
      if (a.n - 1 === q.options.length && q.other) return { do: 'other', q: ui.cur };
      return null;
    }
    if (a.act === 'enter') {
      if (!armed) return null;
      return answered(ui, ui.cur) ? this.advance(entry, ui.cur, { explicit: true }) : null;
    }
    // Enter in a typed answer: that question is answered; on to the next, or send.
    const qi = Number.isInteger(k.field) ? k.field : ui.cur;
    return answered(ui, qi) ? this.advance(entry, qi, { explicit: true }) : null;
  }

  /**
   * A click or a tap in the card of `paneId`. c: { askId, k } for a choice or a button ('once', 'always', 'deny',
   * 'go', 'keep', 'answer', 'skip'), or { askId, q, o } for an option of question q. A click on a card that is no
   * longer the pane's first (answered a moment ago) does nothing.
   */
  choose(paneId, c = {}) {
    const entry = this.current(paneId);
    if (!entry || (c.askId && c.askId !== entry.askId)) return null;
    if (entry.kind === 'permission' || entry.kind === 'plan') return entry.choices.includes(c.k) ? this.decide(entry, c.k) : null;
    if (c.k === 'answer') return this.submit(entry);
    if (c.k === 'skip') return this.finish(entry, { behavior: 'deny', message: SKIP_TEXT });
    if (Number.isInteger(c.q) && Number.isInteger(c.o) && entry.model.questions[c.q]?.options[c.o]) return this.pick(entry, c.q, c.o);
    return null;
  }

  /** Typing in the card: the note that goes with Deny or Keep planning, or question q's own answer. */
  setText(paneId, { note, q, text } = {}) {
    const entry = this.current(paneId);
    if (!entry) return null;
    if (note !== undefined) { entry.ui.note = str(note); return { do: 'paint' }; }
    if (entry.kind !== 'questions' || !Number.isInteger(q) || !entry.model.questions[q]) return null;
    entry.ui.other[q] = str(text);
    // A typed answer replaces the pick of a one-answer question (the sheet sent the typed one when both were there).
    if (str(text).trim() && !entry.model.questions[q].multi) entry.ui.picks[q] = [];
    entry.ui.cur = q;
    return { do: 'paint' };
  }

  /** Option o of question q: chosen (one answer) or toggled (several); one answer moves on by itself. */
  pick(entry, q, o) {
    const ui = entry.ui;
    const question = entry.model.questions[q];
    ui.cur = q;
    if (question.multi) {
      const at = ui.picks[q].indexOf(o);
      if (at >= 0) ui.picks[q].splice(at, 1); else ui.picks[q] = [...ui.picks[q], o].sort((x, y) => x - y);
      return { do: 'paint' };
    }
    ui.picks[q] = [o];
    ui.other[q] = '';
    return this.advance(entry, q, { explicit: false });
  }

  /**
   * After question `from` was answered: the next one without an answer becomes the current one; when every question
   * has one, the answers go. A pick (not explicit) sends by itself only when no question takes several answers, so
   * a list of checkboxes is never cut short; Enter or Answer sends it.
   */
  advance(entry, from, { explicit = false } = {}) {
    const qs = entry.model.questions;
    const ui = entry.ui;
    const order = [...qs.keys()].filter((i) => i > from).concat([...qs.keys()].filter((i) => i <= from));
    const next = order.find((i) => !answered(ui, i));
    if (next !== undefined) { ui.cur = next; return { do: 'paint', focus: 'card' }; }
    if (explicit || !qs.some((q) => q.multi)) return this.submit(entry);
    return { do: 'paint' };
  }

  /** Sends the questions' answers, whatever is there (the Answer button), as the sheet did. */
  submit(entry) {
    return this.finish(entry, { behavior: 'allow', updatedInput: { ...(isObj(entry.e.input) ? entry.e.input : {}), answers: questionAnswers(entry.model, entry.ui) } });
  }

  /** A permission or plan choice. */
  decide(entry, choice) {
    if (entry.kind === 'permission') return this.finish(entry, permissionReply(choice, choice === 'deny' ? entry.ui.note : ''));
    if (choice === 'go') return { ...this.finish(entry, { behavior: 'allow', updatedInput: isObj(entry.e.input) ? entry.e.input : {} }), then: 'plan-approved' };
    return this.finish(entry, { behavior: 'deny', message: entry.ui.note.trim().slice(0, 2000) || KEEP_PLANNING_TEXT });
  }

  finish(entry, result) {
    this.remove(entry.askId);
    return { do: 'answer', askId: entry.askId, paneId: entry.paneId, result };
  }
}

/* ---------- the card's HTML ---------- */

const num = (n) => `<span class="ask-n" aria-hidden="true">${n}</span>`;
const CHECK = '<svg class="ask-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.8"/></svg>';
const BACK = 'Esc goes back to your message.';
const safeId = (s) => str(s).replace(/[^\w-]/g, '_').slice(0, 80);

/** The questions of a card: each with its rows (options, then a typed answer), and Skip and Answer. */
export function questionsHtml(entry, { id = 'ask' } = {}) {
  const { message, questions } = entry.model;
  const ui = entry.ui;
  const cur = questions[ui.cur];
  const max = cur ? cur.options.length + (cur.other && cur.options.length ? 1 : 0) : 0;
  const keys = max > 1 ? `1 to ${max} choose. Enter answers. ${BACK}` : max === 1 ? `1 chooses. Enter answers. ${BACK}` : `Enter answers. ${BACK}`;
  const rows = questions.map((q, i) => {
    const qid = `${id}-q${i}`;
    const opts = q.options.map((o, oi) => {
      const on = ui.picks[i]?.includes(oi);
      return `<button type="button" class="ask-choice${on ? ' on' : ''}${q.multi ? ' multi' : ''}" data-q="${i}" data-o="${oi}" role="${q.multi ? 'checkbox' : 'radio'}" aria-checked="${on ? 'true' : 'false'}">${num(oi + 1)}<span class="ask-l"><span class="ask-w">${esc(o.label)}</span>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span>${CHECK}</button>`;
    }).join('');
    const typed = q.other
      ? `<label class="ask-choice ask-other${str(ui.other[i]).trim() ? ' on' : ''}">${q.options.length ? num(q.options.length + 1) : ''}<input type="${q.secret ? 'password' : 'text'}" data-other="${i}" maxlength="4000" autocomplete="off" spellcheck="${q.secret ? 'false' : 'true'}" aria-labelledby="${qid}" placeholder="${q.options.length ? 'Other: type your own answer' : 'Type your answer'}" value="${esc(ui.other[i])}"></label>`
      : '';
    return `<div class="ask-q${i === ui.cur ? ' cur' : ''}" data-q="${i}" role="group" aria-labelledby="${qid}">`
      + `${q.header && q.header !== q.text ? `<div class="ask-qh">${esc(q.header)}</div>` : ''}`
      + `<div class="ask-h ask-qt" id="${qid}">${esc(q.text)}</div>`
      + `${q.multi ? '<div class="ask-qm">Choose any that apply</div>' : ''}`
      + `<div class="ask-choices">${opts}${typed}</div></div>`;
  }).join('');
  return `<div class="ask-scroll">${message ? `<div class="ask-msg">${esc(message)}</div>` : ''}${rows}</div>`
    + `<div class="ask-foot"><span class="ask-keys">${keys}</span><span class="ask-acts"><button type="button" class="ask-btn" data-k="skip">Skip</button><button type="button" class="ask-btn primary" data-k="answer">Answer</button></span></div>`;
}

/** A plan to approve: the plan itself, Approve or Keep planning, and a note for what to change. */
export function planHtml(entry, { id = 'ask', leavesPlan = false } = {}) {
  const who = entry.who || 'Claude';
  return `<div class="ask-scroll"><h3 class="ask-h" id="${esc(id)}">Ready to code?</h3><div class="turn-assistant ask-plan">${md(entry.plan || '')}</div></div>`
    + `<div class="ask-choices" role="group" aria-labelledby="${esc(id)}">`
    + `<button type="button" class="ask-choice" data-k="go" title="Enter">${num(1)}<span class="ask-l"><span class="ask-w">Approve</span>${leavesPlan ? '<small>Leaves plan mode and works without asking (Bypass permissions)</small>' : ''}</span></button>`
    + `<button type="button" class="ask-choice" data-k="keep">${num(2)}<span class="ask-l"><span class="ask-w">Keep planning</span></span></button>`
    + '</div>'
    + `<input type="text" class="perm-say ask-say" data-note maxlength="2000" autocomplete="off" aria-label="A note for ${esc(who)}, sent with Keep planning" placeholder="Or tell ${esc(who)} what to change">`
    + `<div class="ask-foot"><span class="ask-keys">1 or 2 choose. Enter approves. ${BACK}</span></div>`;
}

/** The whole card's inner HTML: the quiet line on top (who asks, how many more wait), then the ask itself. */
export function cardHtml(entry, { count = 1, leavesPlan = false } = {}) {
  const id = `ask-${safeId(entry.askId)}`;
  const body = entry.kind === 'permission' ? permissionHtml(entry.view, { id: `${id}-h` })
    : entry.kind === 'plan' ? planHtml(entry, { id: `${id}-h`, leavesPlan })
      : questionsHtml(entry, { id });
  return `<div class="ask-top"><span class="ask-kick">${esc(kicker(entry))}</span>${count > 1 ? `<span class="ask-more">${count - 1} more waiting</span>` : ''}</div>${body}`;
}

/* ---------- the window's side ---------- */

/**
 * One pane's card and its "Waiting for you" mark. The card sits in the pane's .composer-wrap, right above the
 * message box (the wrap floats over the conversation and pane.js keeps the last message clear of it).
 */
class AskView {
  constructor(pane, ctx) {
    this.pane = pane;
    this.ctx = ctx;
    this.shown = null;
    this.card = null;
    this.typedAt = 0;
    this.dock = document.createElement('div');
    this.dock.className = 'ask-dock';
    const wrap = pane.$?.wrap;
    const composer = pane.$?.composer;
    if (wrap && composer?.parentNode === wrap) wrap.insertBefore(this.dock, composer);
    else (wrap || pane.el).append(this.dock);
    // The header says so without shouting: words, in the attention colour, and a click takes you to the question.
    this.mark = document.createElement('button');
    this.mark.type = 'button';
    this.mark.className = 'ask-wait';
    this.mark.hidden = true;
    this.mark.textContent = 'Waiting for you';
    this.mark.title = 'Answer the question in this pane';
    const block = pane.el.querySelector('.pane-bar .title-block');
    if (block) block.after(this.mark); else pane.el.querySelector('.pane-bar')?.append(this.mark);
    this.mark.addEventListener('click', (ev) => { ev.stopPropagation(); this.focus(); });
    pane.$?.input?.addEventListener('input', () => { this.typedAt = Date.now(); });
    this.dock.addEventListener('keydown', (ev) => this.onKey(ev));
    this.dock.addEventListener('click', (ev) => this.onClick(ev));
    this.dock.addEventListener('input', (ev) => this.onInput(ev));
    // The card never grows past most of the pane's height; its own middle scrolls (a long plan, a diff).
    if (pane.$?.ground && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.fit()).observe(pane.$.ground);
  }

  fit() {
    const h = this.pane.$?.ground?.clientHeight || 0;
    if (h) this.dock.style.setProperty('--ask-max', `${Math.max(180, Math.round(h * 0.62))}px`);
  }

  /** Where the keyboard is now, for takeFocus. */
  where() {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return 'none';
    if (this.dock.contains(a)) return 'pane';
    if (!this.pane.el.contains(a)) return 'elsewhere';
    if (a === this.pane.$?.input) return 'composer';
    return a.matches?.('input, textarea, select, [contenteditable="true"]') ? 'field' : 'pane';
  }

  /** Draws the pane's first ask (a new card when it changed, else only what changed), its mark, and the count. */
  render() {
    const board = this.ctx.board;
    const entry = board.current(this.pane.id);
    const count = board.count(this.pane.id);
    this.pane.el.classList.toggle('waiting', count > 0);
    this.mark.hidden = !count;
    if (!entry) {
      const had = this.card?.contains(document.activeElement);
      this.card?.remove();
      this.card = null;
      this.shown = null;
      // Answered from the keyboard: the keyboard goes back to the message box, as in Claude Code.
      if (had && !this.ctx.web) this.pane.$?.input?.focus({ preventScroll: true });
      return;
    }
    if (this.shown === entry.askId) { this.paint(entry, count); return; }
    const had = Boolean(this.card?.contains(document.activeElement)) || this.where() === 'pane';
    const card = document.createElement('section');
    card.className = `ask-card ask-${entry.kind}`;
    card.tabIndex = -1;
    card.dataset.ask = entry.askId;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', kicker(entry));
    card.innerHTML = cardHtml(entry, { count, leavesPlan: entry.kind === 'plan' && this.pane.mode === 'plan' });
    if (this.card) this.card.replaceWith(card); else this.dock.append(card);
    this.card = card;
    this.shown = entry.askId;
    this.fit();
    const draft = this.pane.$?.input?.value || '';
    if (had || takeFocus({ web: this.ctx.web, paneFocused: this.ctx.isFocusedPane(this.pane), where: this.where(), draft, typedAgo: Date.now() - this.typedAt })) this.focus();
  }

  /** What changed in the card shown now: picks, the current question, typed answers, the Deny row's words, the count. */
  paint(entry = this.ctx.board.current(this.pane.id), count = this.ctx.board.count(this.pane.id)) {
    const card = this.card;
    if (!card || !entry) return;
    const more = card.querySelector('.ask-more');
    if (count > 1) {
      if (more) more.textContent = `${count - 1} more waiting`;
      else card.querySelector('.ask-top')?.insertAdjacentHTML('beforeend', `<span class="ask-more">${count - 1} more waiting</span>`);
    } else more?.remove();
    if (entry.kind === 'permission') {
      const w = card.querySelector('[data-k=deny] .ask-w');
      if (w) w.textContent = denyLabel(entry.ui.note, entry.view.labels?.deny);
      return;
    }
    if (entry.kind !== 'questions') return;
    const ui = entry.ui;
    for (const q of card.querySelectorAll('.ask-q')) q.classList.toggle('cur', Number(q.dataset.q) === ui.cur);
    for (const b of card.querySelectorAll('.ask-choice[data-o]')) {
      const on = ui.picks[Number(b.dataset.q)]?.includes(Number(b.dataset.o)) || false;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    for (const f of card.querySelectorAll('input[data-other]')) {
      const i = Number(f.dataset.other);
      if (document.activeElement !== f && f.value !== ui.other[i]) f.value = ui.other[i];
      f.closest('.ask-other')?.classList.toggle('on', Boolean(str(ui.other[i]).trim()));
    }
    const q = entry.model.questions[ui.cur];
    const max = q ? q.options.length + (q.other && q.options.length ? 1 : 0) : 0;
    const keys = card.querySelector('.ask-keys');
    if (keys) keys.textContent = max > 1 ? `1 to ${max} choose. Enter answers. ${BACK}` : max === 1 ? `1 chooses. Enter answers. ${BACK}` : `Enter answers. ${BACK}`;
  }

  /**
   * Gives the card the keyboard: the card itself, so the numbers and Enter work; Deny when the SDK asked for a default
   * of no; the answer field when the question is typed. Numbers and Enter wait ARM_MS from here. False when there is no card.
   */
  focus() {
    const entry = this.ctx.board.current(this.pane.id);
    if (!entry || !this.card) return false;
    let target = this.card;
    if (entry.kind === 'permission' && entry.view.defaultToNo) target = this.card.querySelector('[data-k=deny]') || target;
    if (entry.kind === 'questions') {
      const q = entry.model.questions[entry.ui.cur];
      if (q && !q.options.length) target = this.card.querySelector(`input[data-other="${entry.ui.cur}"]`) || target;
    }
    this.ctx.board.arm(this.pane.id);
    target.focus({ preventScroll: true });
    this.card.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  onKey(ev) {
    const card = ev.target?.closest?.('.ask-card');
    if (!card || card !== this.card) return;
    const t = ev.target;
    const field = t.matches?.('input, textarea');
    const k = {
      key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, shiftKey: ev.shiftKey, repeat: ev.repeat, isComposing: ev.isComposing,
      target: field ? 'field' : t.closest?.('button') ? 'button' : 'card',
      field: field && t.dataset.other !== undefined ? Number(t.dataset.other) : field ? 'note' : null,
    };
    const act = this.ctx.board.key(this.pane.id, k);
    if (!act) return;
    // A letter typed while the card has the keyboard belongs in the message box: it moves there and the key lands in it.
    if (act.do === 'type') { this.pane.$?.input?.focus({ preventScroll: true }); return; }
    ev.preventDefault();
    ev.stopPropagation();
    this.apply(act);
  }

  onClick(ev) {
    const b = ev.target?.closest?.('button');
    if (!b || !this.card?.contains(b)) return;
    const c = { askId: this.shown };
    if (b.dataset.k) c.k = b.dataset.k;
    else if (b.dataset.o !== undefined) { c.q = Number(b.dataset.q); c.o = Number(b.dataset.o); } else return;
    const act = this.ctx.board.choose(this.pane.id, c);
    if (act) this.apply(act);
  }

  onInput(ev) {
    const t = ev.target;
    if (!this.card?.contains(t)) return;
    if (t.dataset.note !== undefined) this.ctx.board.setText(this.pane.id, { note: t.value });
    else if (t.dataset.other !== undefined) this.ctx.board.setText(this.pane.id, { q: Number(t.dataset.other), text: t.value });
    else return;
    this.paint();
  }

  apply(act) {
    switch (act.do) {
      case 'answer': this.ctx.answered(act, this.pane); break;
      case 'leave': this.pane.$?.input?.focus({ preventScroll: true }); break;
      case 'other': this.card?.querySelector(`input[data-other="${act.q}"]`)?.focus({ preventScroll: true }); break;
      case 'move': this.move(act.by); break;
      case 'paint':
        this.paint();
        if (act.focus === 'card' && this.card) {
          this.card.focus({ preventScroll: true });
          this.card.querySelector('.ask-q.cur')?.scrollIntoView?.({ block: 'nearest' });
        }
        break;
      default: break;
    }
  }

  /** ArrowDown / ArrowUp: the next or previous row of the choices in play (the current question's, or the card's). */
  move(by) {
    const card = this.card;
    if (!card) return;
    const scope = card.querySelector('.ask-q.cur .ask-choices') || card.querySelector('.ask-choices');
    const rows = [...(scope?.querySelectorAll('.ask-choice') || [])].map((r) => (r.matches('label') ? r.querySelector('input') : r)).filter(Boolean);
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    const next = at < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + by));
    rows[next].focus({ preventScroll: true });
  }

  /**
   * The line a settled card leaves, above whatever comes next. It stays until the pane has been on screen for
   * GONE_NOTE_MS, so a pane in a background tab still says what happened when you come back.
   */
  note(text) {
    if (!text) return;
    const n = document.createElement('div');
    n.className = 'ask-gone';
    n.setAttribute('role', 'status');
    n.textContent = text;
    this.dock.prepend(n);
    let seen = 0;
    const step = 500;
    const timer = setInterval(() => {
      if (!n.isConnected) { clearInterval(timer); return; }
      if (this.onScreen()) seen += step;
      if (seen < GONE_NOTE_MS) return;
      clearInterval(timer);
      n.classList.add('out');
      setTimeout(() => n.remove(), 220);
    }, step);
  }

  onScreen() {
    if (document.visibilityState === 'hidden') return false;
    const stage = this.pane.el.closest('.stage');
    return Boolean(this.pane.el.offsetParent) && (!stage || stage.classList.contains('on'));
  }
}

/**
 * The window's side. ctx:
 *   send(op, args)          the engine (answer)
 *   isFocusedPane(pane)     true for the focused pane of the tab in front
 *   onChange(pane)          something waits or stopped waiting: the tabs, the badge and the title follow
 *   onAnswered(pane, act)   an answer went (the plan approval switches the pane out of plan mode)
 *   web                     the phone page
 * Returns { board, ask, gone, reset, count, focus, drop }.
 */
export function createAsks({ send, isFocusedPane = () => false, onChange = () => {}, onAnswered = () => {}, web = false } = {}) {
  const board = new AskBoard();
  const views = new Map();
  const ctx = {
    board, web, isFocusedPane,
    answered: (act, pane) => {
      send('answer', { askId: act.askId, result: act.result });
      onAnswered(pane, act);
      views.get(pane.id)?.render();
      onChange(pane);
    },
  };
  const viewOf = (pane) => {
    let v = views.get(pane.id);
    if (!v || v.pane !== pane) { v = new AskView(pane, ctx); views.set(pane.id, v); }
    return v;
  };
  return {
    board,
    /** An ask event for `pane`: true when it is new (ding), false for a repeat or a pane that is not here. */
    ask(e, pane) {
      if (!pane?.el || pane.isViewer) return false;
      const entry = board.add(e, { who: pane.kind === 'codex' ? 'Codex' : 'Claude' });
      if (!entry) return false;
      viewOf(pane).render();
      onChange(pane);
      return true;
    },
    /** ask_gone: the card goes, with its line when it was the one on screen. */
    gone(e, pane = null) {
      const r = board.gone(e);
      if (!r) return false;
      const v = views.get(r.entry.paneId) || (pane ? viewOf(pane) : null);
      if (v) { v.note(r.note); v.render(); }
      onChange(v?.pane || pane);
      return true;
    },
    /** The pane's conversation started again (opened, not re-attached): nothing it asked still waits. */
    reset(pane, why = 'restart') {
      if (!pane || !board.count(pane.id)) return;
      const shown = board.current(pane.id);
      board.clear(pane.id);
      const v = views.get(pane.id);
      if (v) { v.note(goneNote({ why }, shown?.who)); v.render(); }
      onChange(pane);
    },
    count: (paneId) => board.count(paneId),
    /** Gives the pane's card the keyboard; false when it has none. */
    focus: (pane) => Boolean(pane && board.count(pane.id) && views.get(pane.id)?.focus()),
    /** The pane closed: its asks are settled by the engine (ask_gone 'closed'); forget them here. */
    drop(pane) { if (!pane) return; board.clear(pane.id); views.delete(pane.id); },
  };
}
