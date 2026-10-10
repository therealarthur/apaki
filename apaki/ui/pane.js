/**
 * pane.js: one conversation in Myrlin Apaki. A tab holds up to six panes;
 * each pane is its own Claude Code session with its own transcript, composer,
 * model, effort, permission mode and billing, and its own runner in the
 * engine (every command carries this pane's id).
 *
 * Moved here from the single-conversation app.js (2026-10-09) when Apaki got
 * tabs and split panes; the rendering is the same, now per pane instead of
 * one global transcript.
 *
 * The pane talks to the app through `host`:
 *   send(op, args), focus(pane), close(pane), voice(pane), folder(pane, value),
 *   changed(pane), dragPane(pane, event), defaults, folders(), sessions().
 */

import { esc, md } from './markdown.js';
import { EFFORTS, effortGrid, menu } from './menu.js';
import { SHOW_TOOL, artifactCard, kindGlyph, kindLabel, linkCard, parseOpened, parseRef, updateCard } from './artifacts.js';

// Images go in at most this many pixels on the long edge (the API's sweet
// spot, and under the 2000 px limit that breaks a session).
const IMAGE_MAX_EDGE = 1568;

const LOCAL = [
  { name: 'new', description: 'Start a new conversation in this pane' },
  { name: 'model', description: 'Switch model: opus, sonnet, haiku, fable or a full id' },
  { name: 'effort', description: 'Set effort: low, medium, high, xhigh, max' },
  { name: 'mode', description: 'Permission mode: bypassPermissions, acceptEdits, plan, default' },
  { name: 'key', description: 'Billing: follow Glass, subscription, or a vault key' },
  { name: 'folder', description: 'Move this conversation to a folder (name)' },
  { name: 'warm', description: 'Keep the prompt cache warm between messages (on, off, status)' },
];
const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };
const MODEL_NAMES = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-1': 'Fable 5.1' };
// Permission modes, in Shift+Tab order, worded like Claude Code's footer.
// bypassPermissions is "full access" in Codex terms.
export const MODES = [
  { value: 'bypassPermissions', label: 'Bypass permissions', mark: '⏵⏵', hint: 'Full access: every tool runs without asking' },
  { value: 'acceptEdits', label: 'Auto-accept edits', mark: '⏵⏵', hint: 'File edits run; other tools follow your settings' },
  { value: 'plan', label: 'Plan mode', mark: '⏸', hint: 'Claude plans and asks before changing anything' },
  { value: 'default', label: 'Ask permissions', mark: '?', hint: 'Your Claude Code permission rules decide' },
];
const EFFORT_HINTS = { low: 'Fastest, least thinking', medium: 'Balanced', high: 'Thinks harder', xhigh: 'Thinks much harder', max: 'Everything it has' };

export const short = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');

/**
 * The time a message shows on hover: "11:42 PM" today, "Yesterday 11:42 PM",
 * "Oct 8, 11:42 PM" before that (the year too when it is not this one).
 */
export function stamp(at, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const back = Math.round((day(now) - day(d)) / 86400000);
  if (back === 0) return time;
  if (back === 1) return `Yesterday ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date}, ${time}`;
}

/** The artifact kind a file's extension gives (for cards rebuilt from history). */
const kindFromPath = (p) => {
  const e = (String(p).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  return { html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown', svg: 'svg', pdf: 'pdf' }[e] || (/^(png|jpe?g|gif|webp|bmp|ico|avif)$/.test(e) ? 'image' : 'text');
};

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** Apaki's browser tools (mcp__apaki__browser_open...) read as "Browser" plus what they did. */
const BROWSER_TOOL = 'mcp__apaki__browser_';
function browserArgs(name, input = {}) {
  const action = name.slice(BROWSER_TOOL.length);
  const ref = input.ref != null ? ` [${input.ref}]` : '';
  const text = input.text != null ? ` "${String(input.text).slice(0, 60)}"${input.submit ? ' + Enter' : ''}` : '';
  return `${action}${input.url ? ` ${input.url}` : ''}${ref}${text}${input.from ? ` from line ${input.from}` : ''}`;
}

export function toolArgs(name, input = {}) {
  if (name.startsWith(BROWSER_TOOL)) return browserArgs(name, input).slice(0, 160);
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill ?? '';
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return String(pick).replace(/\s+/g, ' ').slice(0, 160);
}

export class Pane {
  constructor(id, host, settings = {}) {
    this.id = id;
    this.host = host;
    this.sessionId = settings.sessionId || null;
    this.cwd = settings.cwd || '';
    this.title = settings.title || 'New conversation';
    this.model = settings.model || host.defaults.model;
    this.effort = settings.effort || host.defaults.effort;
    this.mode = settings.mode || host.defaults.mode;
    this.billing = host.defaults.billing;
    this.busy = false;
    this.unread = false;
    this.attachments = [];
    // Messages typed while Claude works: sent when the turn ends, or steered
    // into it now (see submit / steerItem).
    this.queue = [];
    this.steering = new Map();
    this.stoppedByUser = false;
    this.commands = [];
    this.streams = new Map();
    this.tools = new Map();
    this.cardKeys = new Set(); // artifact and link cards already in the transcript
    this.closedArts = new Map(); // viewers of this conversation's artifacts that were closed (by id)
    // Subagents, shells, monitors and workflows this conversation's Claude Code
    // started (task_* messages): taskId -> task. See tasks.js and the Tasks button.
    this.liveTasks = new Map();
    this.slashSel = 0;
    this.curMsg = null;
    this.tick = null;
    this.turnStart = 0;

    this.el = document.getElementById('paneTpl').content.firstElementChild.cloneNode(true);
    this.el.dataset.pane = id;
    const q = (s) => this.el.querySelector(s);
    this.$ = {
      title: q('.title'), cwd: q('.cwd'), T: q('.transcript'), ground: q('.ground'), input: q('textarea'),
      send: q('.send'), status: q('.status'), slash: q('.slash'), attachments: q('.attachments'), composer: q('.composer'),
      file: q('input[type=file]'), mic: q('.mic'), model: q('.chip-btn.model'), effort: q('.chip-btn.effort'), mode: q('.chip-btn.mode'),
      folder: q('.folder-chip'), billing: q('.chip-btn.billing'), close: q('.close'), grip: q('.grip'), ctx: q('.chip-btn.ctx'),
      statusLine: q('.status-line'), egridSlot: q('.egrid-slot'), wrap: q('.composer-wrap'), queue: q('.queue'),
      pin: q('.prompt-pin'), artReopen: q('.art-reopen'), tasksBtn: q('.tasks-btn'),
    };
    this.$.ground.addEventListener('scroll', () => { this.schedulePin(); this.host.dirty?.(); }, { passive: true });
    // The composer floats over the conversation (frosted); keep the last
    // message clear of it as it grows and shrinks.
    new ResizeObserver(() => {
      const g = this.$.ground;
      const atEnd = g.scrollHeight - g.scrollTop - g.clientHeight < 8;
      this.el.style.setProperty('--composer-h', `${this.$.wrap.offsetHeight}px`);
      if (atEnd) g.scrollTop = g.scrollHeight;
    }).observe(this.$.wrap);
    this.renderChips();
    this.setTitle(this.title);
    this.wire();
    this.renderBilling();
    this.showEmpty();
  }

  send(op, args = {}) { return this.host.send(op, { paneId: this.id, ...args }); }

  /* ---------- wiring ---------- */

  wire() {
    this.$.cwd.onclick = () => { if (!this.sessionId && !this.busy) this.host.chooseFolder(this); };
    const { input } = this.$;
    this.el.addEventListener('pointerdown', () => this.host.focus(this), true);
    this.el.addEventListener('focusin', () => this.host.focus(this));
    input.addEventListener('input', () => { this.autosize(); this.updateSlash(); this.renderSendButton(); this.host.dirty?.(); });
    input.addEventListener('keydown', (e) => this.onKey(e));
    // Stop only when the box is empty; with text it queues (see submit).
    this.$.send.onclick = () => { if (this.busy && !this.hasDraft()) this.stop(); else this.submit(); };
    this.$.file.addEventListener('change', async (e) => { for (const f of e.target.files) await this.addImageFile(f); e.target.value = ''; });
    this.$.mic.onclick = () => this.host.voice(this);
    this.$.model.onclick = () => menu(this.$.model, Object.entries(MODEL_NAMES).map(([value, label]) => ({ value, label, checked: value === this.model })), { onPick: (v) => this.setModel(v) });
    this.$.effort.onclick = () => menu(this.$.effort, EFFORTS.map((value) => ({ value, html: `${effortGrid(value)}<span class="ml">${value}</span>`, hint: EFFORT_HINTS[value], checked: value === this.effort })), { onPick: (v) => this.setEffort(v), width: 250 });
    this.$.mode.onclick = () => menu(this.$.mode, MODES.map((m) => ({ value: m.value, html: `<span class="mm ${m.value}">${m.mark}</span><span class="ml">${m.label}</span>`, hint: m.hint, checked: m.value === this.mode })), { onPick: (v) => this.setMode(v), width: 330 });
    this.$.folder.onclick = () => this.host.folderMenu(this, this.$.folder);
    this.$.billing.onclick = () => this.send('billingOptions');
    if (this.$.ctx) this.$.ctx.onclick = () => this.contextMenu();
    this.$.close.onclick = () => this.host.close(this);
    if (this.$.artReopen) this.$.artReopen.onclick = () => this.artifactsMenu();
    if (this.$.tasksBtn) this.$.tasksBtn.onclick = () => this.host.openTasksPanel?.(this, this.$.tasksBtn);
    this.$.title.ondblclick = () => this.host.renameSession?.(this, this.$.title);
    this.$.title.title = 'Double-click to rename';
    this.$.grip.addEventListener('dragstart', (e) => this.host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => this.host.dragEnd());
  }

  onKey(e) {
    const { slash, input } = this.$;
    if (!slash.hidden) {
      const items = [...slash.children];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.slashSel = (this.slashSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; this.paintSlash(); return; }
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && items[this.slashSel]) {
        const name = items[this.slashSel].dataset.name;
        if (e.key === 'Tab' || input.value.trim() !== `/${name}`) { e.preventDefault(); input.value = `/${name} `; this.hideSlash(); return; }
      }
      if (e.key === 'Escape') { this.hideSlash(); return; }
    }
    // Ctrl+Enter (Cmd+Enter on a Mac) steers: while Claude works the message goes into the running
    // turn now instead of the queue (Arthur, 2026-10-10). Enter alone still queues it.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); this.submit({ steer: true }); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); return; }
    // Up in an empty box pulls the last queued message back to edit, as in Codex.
    if (e.key === 'ArrowUp' && !input.value && this.queue.length) { e.preventDefault(); this.editItem(this.queue[this.queue.length - 1].id); return; }
    // Shift+Tab cycles the permission mode, as in Claude Code.
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); this.cycleMode(); return; }
    if (e.key === 'Escape' && this.busy) this.stop();
  }

  cycleMode() {
    const i = MODES.findIndex((m) => m.value === this.mode);
    this.setMode(MODES[(i + 1) % MODES.length].value);
  }

  /** The settings line under the message box: model, effort grid, mode, billing. */
  renderChips() {
    const { model, effort, mode } = this.$;
    model.textContent = MODEL_NAMES[this.model] || this.model;
    effort.innerHTML = `${effortGrid(this.effort)}<span>${esc(this.effort)}</span>`;
    const m = MODES.find((x) => x.value === this.mode) || MODES[0];
    mode.innerHTML = `<span class="mm">${m.mark}</span>${esc(m.label)}`;
    mode.dataset.mode = m.value;
    mode.title = `${m.hint} · Shift+Tab to cycle`;
  }

  /* ---------- header ---------- */

  setTitle(title) {
    this.title = title || 'New conversation';
    this.$.title.textContent = this.title;
    this.$.title.title = `${this.title}\nDouble-click to rename`;
  }

  setCwdLine() {
    this.$.cwd.textContent = `${short(this.cwd)}${this.sessionId ? `  ·  ${this.sessionId}` : ''}`;
    // Until the first message the folder can still change: say so, and let a click do it.
    const open = !this.sessionId;
    this.$.cwd.classList.toggle('pickable', open);
    this.$.cwd.title = open ? 'Folder this conversation starts in · click to change' : this.cwd;
    const start = this.$.T.querySelector('.start-path');
    if (start) start.textContent = short(this.cwd) || '~';
  }

  /** Starts this new conversation in another folder (only before its first message). */
  setStartFolder(dir) {
    if (this.sessionId || this.busy) return;
    this.cwd = dir;
    this.setCwdLine();
    this.open(null, { warm: true });
    this.host.changed(this);
  }

  renderBilling() {
    const b = this.billing;
    if (!b) return;
    // A key says so beside its name (Arthur, 2026-10-09): it bills per token, a subscription does not.
    const key = b.isKey ? '<span class="key-tag" aria-label="(API key)">API key</span>' : '';
    this.$.billing.innerHTML = `<span class="bn">${esc(b.name)}</span>${key}${b.follow && !/glass/i.test(b.name) ? '<span class="src">Glass</span>' : ''}`;
    this.$.billing.title = `Billing: ${b.name}${b.isKey ? ' (API key, billed per token)' : ''}${b.follow ? ' (follows Myrlin Glass)' : ''} · click to change`;
  }

  /** The folder chip under the title: the folder's name, or a quiet "Add to folder". */
  renderFolderSelect(folders, sessions) {
    const chip = this.$.folder;
    const cur = sessions.find((s) => s.id === this.sessionId)?.folder || '';
    const f = folders.find((x) => x.id === cur);
    chip.textContent = f ? f.name : 'Add to folder';
    chip.classList.toggle('set', Boolean(f));
    chip.hidden = !this.sessionId;
    this.folderId = f?.id || null;
  }

  setModel(m) { this.model = m; this.renderChips(); this.send('model', { model: m }); this.host.changed(this); this.askContext(1500); }

  /* ---------- the context meter (2026-10-10) ---------- */

  /** Asks the engine how full this conversation's context window is (it also says so after every turn). */
  askContext(ms = 1200) {
    clearTimeout(this.ctxTimer);
    this.ctxTimer = setTimeout(() => { if (this.sessionId || this.busy) this.send('contextUsage'); }, ms);
  }

  /** The meter in the settings line: a thin bar and the percentage, warmer as the window fills. */
  renderContext() {
    const b = this.$.ctx;
    const c = this.ctx;
    if (!b) return;
    if (!c || c.percentage == null) { b.hidden = true; return; }
    const pct = Math.max(0, Math.round(c.percentage));
    b.hidden = false;
    b.querySelector('.ctx-n').textContent = `${pct}%`;
    b.style.setProperty('--ctx', Math.min(1, pct / 100).toFixed(3));
    b.classList.toggle('warm', pct >= 70 && pct < 88);
    b.classList.toggle('full', pct >= 88);
    const k = (n) => (n == null ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const auto = typeof c.autoCompact === 'number' ? ` Claude Code compacts it on its own near ${Math.round(c.autoCompact)}%.` : c.autoCompact === false ? ' Auto-compact is off.' : '';
    b.title = `Context: ${k(c.totalTokens)} of ${k(c.maxTokens)} tokens used (${pct}%).${auto} Click for the breakdown.`;
    b.setAttribute('aria-label', `Context ${pct}% used`);
  }

  /** The breakdown: what fills the window, and Compact now. */
  contextMenu() {
    const c = this.ctx;
    if (!c) { this.askContext(0); return; }
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
    const items = [{ heading: `Context ${Math.round(c.percentage)}% · ${k(c.totalTokens || 0)} of ${k(c.maxTokens || 0)}` }];
    for (const u of c.used || []) items.push({ label: u.name, hint: `${k(u.tokens)} tokens`, value: null, disabled: true });
    items.push({ divider: true });
    items.push({ label: 'Compact now', hint: 'summarize the conversation to free the window', value: 'compact', disabled: this.busy ? 'Wait until Claude finishes' : false });
    items.push({ label: 'Measure again', value: 'refresh' });
    menu(this.$.ctx, items, {
      width: 300,
      onPick: (v) => {
        if (v === 'refresh') this.askContext(0);
        if (v === 'compact' && !this.busy) { this.$.input.value = '/compact'; this.submit(); }
      },
    });
  }
  setEffort(x) { this.effort = x; this.renderChips(); this.send('effort', { effort: x }); this.host.changed(this); }
  setMode(x) { this.mode = x; this.renderChips(); this.send('mode', { mode: x }); this.host.changed(this); }

  /* ---------- open ---------- */

  /** Opens a session here (null for a new conversation). warm=false waits for the first message to start Claude Code. */
  open(s, { warm = true, force = false } = {}) {
    const sessionId = s?.id || null;
    if (s?.title) this.setTitle(s.title);
    if (!sessionId) this.setTitle('New conversation');
    this.lockedBy = null;
    this.lastOpen = s ? { id: s.id, cwd: s.cwd, title: s.title } : null;
    this.send('open', { sessionId, cwd: s?.cwd || this.cwd || null, warm, force, model: this.model, effort: this.effort, mode: this.mode });
  }

  /**
   * The session is held by another window (latch in a terminal, another
   * Apaki): say who, and offer to take it over here. A takeover stops the
   * other window before it writes again, so the conversation cannot fork.
   * `lost` = this pane had it and the other window took it.
   */
  showLocked(e, { lost = false } = {}) {
    const h = e.holder || {};
    const who = h.name || 'Another window';
    const when = h.at ? new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    this.lockedBy = h;
    this.sessionId = e.sessionId || this.sessionId;
    if (e.title) this.setTitle(e.title);
    if (e.cwd) this.cwd = e.cwd;
    this.setCwdLine();
    this.setBusy(false);
    this.setStatus('');
    if (!lost) this.$.T.innerHTML = '';
    this.$.T.querySelector('.takeover')?.remove();
    const terminal = h.app === 'latch-relay' || !h.app;
    const card = el('div', 'takeover', `
      <div class="tk-kicker">${lost ? 'Taken over' : 'Session in use'}</div>
      <h3>${lost ? `${esc(who)} took this session` : `Open in ${esc(who)}`}</h3>
      <p>${lost
        ? `It moved there${when ? ` at ${esc(when)}` : ''}, so this pane stopped before it could write anything. Take it back to continue here.`
        : `${esc(who.charAt(0).toUpperCase() + who.slice(1))} has had it since ${esc(when || 'earlier')}${h.pid ? ` (pid ${h.pid})` : ''}. Take it over to work on it here.`}</p>
      <p class="tk-fine">${terminal
        ? 'That terminal window is blocked as soon as you take over: its next message is stopped with a note to continue here, so nothing forks.'
        : 'That window stops before its next message, with a note to continue here, so nothing forks.'} Anything it already did is on disk and loads here.</p>
      <div class="tk-row"><button class="tk-go">${lost ? 'Take it back' : 'Take over here'}</button><button class="tk-no">${lost ? 'Close pane' : 'Cancel'}</button></div>`);
    card.querySelector('.tk-go').onclick = () => {
      this.$.T.innerHTML = '';
      this.open(this.lastOpen || { id: this.sessionId, cwd: this.cwd, title: this.title }, { warm: true, force: true });
    };
    card.querySelector('.tk-no').onclick = () => {
      if (lost) { this.host.close(this); return; }
      this.lockedBy = null;
      this.sessionId = null;
      this.setTitle('New conversation');
      this.setCwdLine();
      this.open(null, { warm: false });
    };
    this.$.T.append(card);
    this.scrollDown(true);
    this.host.changed(this);
  }

  showEmpty() {
    this.$.T.innerHTML = '';
    queueMicrotask(() => { const b = this.$.T.querySelector('.start-in'); if (b) b.onclick = () => this.host.chooseFolder(this); });
    // 40 cells, slow and out of step; about 5% (two, placed at random) in peach, the rest periwinkle.
    const peach = new Set();
    while (peach.size < 2) peach.add(Math.floor(Math.random() * 40));
    const cells = Array.from({ length: 40 }, (_, i) => `<i${peach.has(i) ? ' class="pk"' : ''} style="--d:${(-Math.random() * 9).toFixed(2)}s"></i>`).join('');
    this.$.T.append(el('div', 'empty', `<div class="empty-grid rand" aria-hidden="true">${cells}</div><h3>New conversation</h3><p>It becomes a Claude Code session with your first message.</p><button class="start-in" title="Choose the folder this conversation starts in"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2c0-.7.6-1.2 1.2-1.2h3l1.4 1.6h5.6c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.6 0-1.2-.5-1.2-1.2z"/></svg><span class="start-label">Starts in</span><span class="start-path">${esc(short(this.cwd) || '~')}</span><span class="start-change">Change</span></button><p class="hint">Drag a session from the left onto an edge to split, up to six panes.</p>`));
  }

  /* ---------- transcript ---------- */

  scrollDown(force = false) {
    const g = this.$.ground;
    if (force || g.scrollHeight - g.scrollTop - g.clientHeight < 160) g.scrollTop = g.scrollHeight;
    this.schedulePin();
  }

  /* ---------- the prompt pin ---------- */

  // Arthur, 2026-10-09: scrolled down, the message that started what you are
  // reading sits in a card at the top; a click scrolls back up to it. Scroll
  // up past that message and the card shows the one before it.
  schedulePin() {
    if (this._pinRaf) return;
    this._pinRaf = requestAnimationFrame(() => { this._pinRaf = 0; this.updatePin(); });
  }

  /** Your last message scrolled out above the top edge ({ el, n, of }), or null. */
  pinnedTurn() {
    const turns = this.$.T.querySelectorAll(':scope > .turn-user');
    if (!turns.length) return null;
    const edge = this.$.ground.getBoundingClientRect().top + 6;
    // Turns run top to bottom, so the last one above the edge is a binary search away.
    let lo = 0;
    let hi = turns.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid].getBoundingClientRect().bottom < edge) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return hit < 0 ? null : { el: turns[hit], n: hit + 1, of: turns.length };
  }

  updatePin() {
    const pin = this.$.pin;
    if (!pin) return;
    const t = this.pinnedTurn();
    if (!t) { pin.hidden = true; this._pinKey = ''; return; }
    const key = `${t.n}/${t.of}`;
    if (key === this._pinKey && !pin.hidden && this._pinEl === t.el) return;
    this._pinKey = key;
    this._pinEl = t.el;
    // Its own text (Ctrl+F's marks included), not the steer tag or image row.
    const words = [...t.el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE || n.matches?.('mark.find-hit')).map((n) => n.textContent).join('').trim();
    const imgs = t.el.querySelectorAll('.imgs img, .imgs .img-marker').length;
    const text = words || (imgs ? `${imgs} image${imgs > 1 ? 's' : ''}` : 'Your message');
    pin.innerHTML = `<button class="pin-card" title="Scroll up to this message"><span class="pin-head"><span class="pin-who">${t.el.classList.contains('steered') ? 'You, steered in' : 'You asked'}</span><span class="pin-n">${t.n} of ${t.of}</span><span class="pin-go">Jump up<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/></svg></span></span><span class="pin-text">${esc(text)}</span></button>`;
    pin.querySelector('.pin-card').onclick = () => this.jumpTo(t.el);
    pin.hidden = false;
  }

  /** Scrolls a message of yours to the top (just under the pin) and marks it for a moment. */
  jumpTo(u) {
    const g = this.$.ground;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = u.getBoundingClientRect().top - g.getBoundingClientRect().top + g.scrollTop - (this.$.pin.offsetHeight || 0) - 14;
    g.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
    u.classList.remove('pin-arrive');
    void u.offsetWidth;
    u.classList.add('pin-arrive');
    setTimeout(() => u.classList.remove('pin-arrive'), 1400);
  }

  note(text, tone = '') {
    const n = el('div', `note ${tone}`);
    n.textContent = text;
    this.$.T.append(n);
    this.scrollDown();
  }

  clearEmpty() { if (this.$.T.querySelector('.empty')) this.$.T.innerHTML = ''; }

  addUser(text, images = [], { steered = false } = {}) {
    this.clearEmpty();
    const u = el('div', steered ? 'turn-user steered' : 'turn-user');
    if (steered) u.append(el('span', 'steer-tag', 'Steered in'));
    if (images.length) {
      const box = el('div', 'imgs');
      for (const im of images) { if (im.url) { const i = el('img'); i.src = im.url; box.append(i); } else box.append(el('span', 'img-marker', '[image]')); }
      u.append(box);
    }
    u.append(document.createTextNode(text));
    u.dataset.ts = stamp(this._at || Date.now());
    this.$.T.append(u);
    this.scrollDown(true);
  }

  /** Redraws a streaming reply as markdown, once per animation frame. */
  paintStream(a) {
    if (a._raf) return;
    a._raf = requestAnimationFrame(() => {
      a._raf = 0;
      a.innerHTML = md(a._raw || '');
      this.scrollDown();
    });
  }

  addAssistant(text) {
    if (!text || !text.trim()) return null;
    const a = el('div', 'turn-assistant', md(text));
    a.dataset.ts = stamp(this._at || Date.now());
    this.host.linkSessions?.(a);
    this.$.T.append(a);
    this.scrollDown();
    return a;
  }

  addTool(block) {
    // Apaki's show tool is drawn as a card the user can open again later.
    if (block.name === SHOW_TOOL) { this.addShowCard(block); return; }
    const d = el('details', 'tool');
    const label = block.name === 'Task' ? 'Agent' : block.name.startsWith(BROWSER_TOOL) ? 'Browser' : block.name;
    d.innerHTML = `<summary><span class="dot">⏺</span><span class="name">${esc(label)}</span><span class="args">(${esc(toolArgs(block.name, block.input))})</span></summary><div class="sum">running…</div>`;
    if ((block.name === 'Edit' || block.name === 'MultiEdit') && block.input) {
      const edits = block.input.edits || [{ old_string: block.input.old_string, new_string: block.input.new_string }];
      const diff = edits.map((e) => `${String(e.old_string || '').split('\n').map((l) => `<span class="del">- ${esc(l)}</span>`).join('')}${String(e.new_string || '').split('\n').map((l) => `<span class="add">+ ${esc(l)}</span>`).join('')}`).join('');
      d.append(el('pre', 'diff', diff));
    } else if (block.input && (block.name === 'Write' || block.name === 'Bash' || block.name === 'PowerShell')) {
      d.append(el('pre', '', esc(block.input.content || block.input.command || '')));
    }
    this.$.T.append(d);
    this.tools.set(block.id, d);
    // A subagent: openable at once (the engine finds its transcript by this tool call).
    if (block.name === 'Task' || block.name === 'Agent') this.linkTool(block.id, { id: null, type: 'local_agent', description: block.input?.description || '', subagentType: block.input?.subagent_type || 'agent', status: this.liveTasks.size ? 'running' : 'completed' });
    this.scrollDown();
  }

  /* ---------- artifact and link cards (artifacts.js) ---------- */

  /** A card for a show call; it gets its id from the artifact event or the tool's result. */
  addShowCard(block) {
    const input = block.input || {};
    const kind = String(input.kind || 'file').toLowerCase();
    const card = artifactCard({ title: input.title || (input.path ? String(input.path).split(/[\\/]/).pop() : 'Artifact'), kind, state: 'pending' }, { onOpen: (c) => this.openCard(c) });
    card.dataset.tool = block.id;
    card.dataset.input = kind === 'url' ? JSON.stringify({ url: input.url || input.content || input.path || '', title: input.title || '' }) : '';
    this.clearEmpty();
    this.$.T.append(card);
    this.tools.set(block.id, card);
    this.scrollDown();
  }

  /** Opens a card's artifact in a viewer beside this conversation. */
  openCard(c) {
    this.host.showArtifact?.({ sessionId: this.sessionId, id: c.dataset.id, rev: Number(c.dataset.rev) || null, title: c.dataset.title, kind: c.dataset.kind, sourcePane: this.id }, { focus: true });
  }

  /* ---------- subagents, shells, monitors (tasks.js) ---------- */

  /** Folds one task_* message (or the live set) into liveTasks and redraws what shows it. */
  onTaskMessage(msg) {
    const now = Date.now();
    const get = (id) => this.liveTasks.get(id);
    const put = (id, patch) => { const t = { ...(get(id) || { id, status: 'running', startedAt: now }), ...patch }; this.liveTasks.set(id, t); return t; };
    switch (msg.subtype) {
      case 'task_started':
        put(msg.task_id, {
          type: msg.task_type || (msg.subagent_type ? 'local_agent' : 'local_bash'), description: msg.description || '', subagentType: msg.subagent_type || '',
          prompt: msg.prompt || '', toolUseId: msg.tool_use_id || null, parentId: msg.parent_task_id || null, depth: msg.spawn_depth || 1,
          workflowName: msg.workflow_name || '', backgrounded: Boolean(msg.is_backgrounded), ambient: Boolean(msg.ambient || msg.skip_transcript), status: 'running', startedAt: now,
        });
        break;
      case 'task_progress':
        put(msg.task_id, { usage: msg.usage || get(msg.task_id)?.usage, lastTool: msg.last_tool_name || get(msg.task_id)?.lastTool || '', summary: msg.summary || get(msg.task_id)?.summary || '', ...(msg.description ? { description: msg.description } : {}), ...(msg.subagent_type ? { subagentType: msg.subagent_type } : {}) });
        break;
      case 'task_updated': {
        const p = msg.patch || {};
        put(msg.task_id, { ...(p.status ? { status: p.status } : {}), ...(p.description ? { description: p.description } : {}), ...(p.error ? { error: p.error } : {}), ...(p.is_backgrounded !== undefined ? { backgrounded: p.is_backgrounded } : {}), ...(p.end_time ? { endedAt: p.end_time } : {}) });
        break;
      }
      case 'task_notification':
        put(msg.task_id, { status: msg.status, outputFile: msg.output_file || '', summary: msg.summary || get(msg.task_id)?.summary || '', usage: msg.usage || get(msg.task_id)?.usage, endedAt: now, ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}) });
        break;
      case 'background_tasks_changed':
        for (const t of msg.tasks || []) put(t.task_id, { type: t.task_type, description: t.description || get(t.task_id)?.description || '', subagentType: t.subagent_type || get(t.task_id)?.subagentType || '', backgrounded: true, ambient: Boolean(t.ambient), ...(get(t.task_id) ? {} : { status: 'running' }) });
        break;
      default: break;
    }
    const t = get(msg.task_id);
    if (t?.toolUseId) this.linkTool(t.toolUseId, t);
    this.renderTasksButton();
    this.host.tasksChanged?.(this);
  }

  /** Running (non-housekeeping) tasks, for the button and the tab. */
  runningTasks() {
    return [...this.liveTasks.values()].filter((t) => !t.ambient && (t.status === 'running' || t.status === 'pending'));
  }

  /** The Tasks button: shown once there is anything to list; brand ink and a count while some run. */
  renderTasksButton() {
    const b = this.$.tasksBtn;
    if (!b) return;
    const run = this.runningTasks();
    const disk = this.sessionId ? this.host.subagentCount?.(this.sessionId) || 0 : 0;
    const any = run.length || [...this.liveTasks.values()].some((t) => !t.ambient) || disk;
    b.hidden = !any;
    b.classList.toggle('lit', run.length > 0);
    b.querySelector('.tb-n').textContent = run.length ? String(run.length) : disk ? String(disk) : '';
    b.title = run.length ? `${run.length} running: ${run.map((t) => t.description || t.subagentType || t.type).slice(0, 4).join(', ')}${run.length > 4 ? '…' : ''}` : disk ? `${disk} subagent${disk === 1 ? '' : 's'} in this session` : 'Subagents and background tasks';
  }

  /** A tool line that started a task gets an Open button (and the task's name). */
  linkTool(toolUseId, t) {
    const d = this.tools.get(toolUseId);
    if (!d || d.classList.contains('art-card')) return;
    let b = d.querySelector('.tool-open');
    if (!b) {
      b = document.createElement('button');
      b.className = 'tool-open';
      b.textContent = 'Open';
      d.querySelector('summary')?.append(b);
    }
    const kind = /agent/.test(t.type || '') ? 'agent' : 'shell';
    b.title = `Open this ${kind === 'agent' ? 'subagent' : 'shell'} in a viewer (Ctrl+click: new tab; drag onto a pane edge or a tab)`;
    b.classList.toggle('running', t.status === 'running');
    const spec = () => (kind === 'agent'
      ? { kind, sessionId: this.sessionId, toolUseId, taskId: t.id, ownerPane: this.id, title: t.description, type: t.subagentType || 'agent' }
      : { kind, sessionId: this.sessionId, taskId: t.id, ownerPane: this.id, title: t.description, type: t.type });
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.host.openTask?.(spec(), { tab: e.ctrlKey || e.metaKey }); };
    b.draggable = true;
    b.ondragstart = (e) => this.host.dragTask?.(spec(), e);
    b.ondragend = () => this.host.dragEnd();
  }

  /* ---------- reopening this conversation's artifacts ---------- */

  // Arthur, 2026-10-09: "when you close the artifact page it should be linked
  // to the session and there should be an icon on the top left to let you open
  // it back up again". The icon beside the grip lists what this conversation
  // showed (its ready cards, plus viewers of it that were closed).

  /** A viewer of one of this conversation's artifacts closed: keep it to reopen. */
  rememberArtifact(a) {
    if (!a?.id) return;
    this.closedArts.set(a.id, { id: a.id, title: a.title || 'Artifact', kind: a.kind || 'file', rev: null });
    this.renderArtifactsButton();
  }

  /** This conversation's artifacts, newest first, one entry per artifact (its latest card). */
  artifactsList() {
    const by = new Map(this.closedArts);
    for (const c of this.$.T.querySelectorAll('.art-card[data-state=ready][data-id]')) {
      if (c.classList.contains('link')) continue;
      by.delete(c.dataset.id);
      by.set(c.dataset.id, { id: c.dataset.id, title: c.dataset.title || 'Artifact', kind: c.dataset.kind || 'file', rev: Number(c.dataset.rev) || null });
    }
    return [...by.values()].reverse();
  }

  renderArtifactsButton() {
    const b = this.$.artReopen;
    if (!b) return;
    const list = this.sessionId ? this.artifactsList() : [];
    // Lit only for viewers you closed here (not for every artifact of an old session).
    const shut = list.filter((a) => this.closedArts.has(a.id) && !this.host.artifactOpen?.(this.sessionId, a.id));
    b.hidden = !list.length;
    b.classList.toggle('lit', shut.length > 0);
    b.querySelector('.ar-n').textContent = list.length > 1 ? String(list.length) : '';
    const one = list.length === 1 ? list[0] : null;
    b.title = !list.length ? '' : one ? (this.host.artifactOpen?.(this.sessionId, one.id) ? `"${one.title}" is open` : `Reopen "${one.title}"`) : `${list.length} artifacts from this conversation${shut.length ? `, ${shut.length} closed here` : ''}`;
  }

  /** One artifact: reopen it (or bring its viewer forward). Several: a menu, newest first. */
  artifactsMenu() {
    const list = this.artifactsList();
    if (!list.length) return;
    const open = (a) => this.host.showArtifact?.({ sessionId: this.sessionId, id: a.id, rev: null, title: a.title, kind: a.kind, sourcePane: this.id }, { focus: true });
    if (list.length === 1) { open(list[0]); return; }
    const items = list.map((a) => ({
      value: a.id,
      html: `<span class="ar-g">${kindGlyph(a.kind)}</span><span class="ml">${esc(a.title)}</span>`,
      hint: `${kindLabel(a.kind)}${a.rev > 1 ? ` · rev ${a.rev}` : ''}`,
      checked: Boolean(this.host.artifactOpen?.(this.sessionId, a.id)),
    }));
    menu(this.$.artReopen, [{ heading: 'Artifacts from this conversation' }, ...items], { above: false, width: 300, onPick: (v) => { const a = list.find((x) => x.id === v); if (a) open(a); } });
  }

  /** Swaps a show card for a link card (kind url), or adds one after `after`. */
  placeLink({ url, title, reason, toolUseId }, replace = null, after = null) {
    const key = `u:${url}:${toolUseId || Math.random()}`;
    if (this.cardKeys.has(key)) return;
    this.cardKeys.add(key);
    const card = linkCard({ url, title, reason }, { onOpen: (u) => this.host.openUrl?.(u, this) });
    if (replace) { replace.replaceWith(card); if (toolUseId) this.tools.set(toolUseId, card); } else if (after?.isConnected) after.after(card); else this.$.T.append(card);
    this.scrollDown();
  }

  /** A card for an artifact a caught "open" command or BROWSER showed. */
  placeArtifact({ id, rev, title, kind, sub }, after = null) {
    const key = `a:${id}:${rev}`;
    if (this.cardKeys.has(key)) return;
    this.cardKeys.add(key);
    this.clearEmpty();
    const card = artifactCard({ id, rev, title, kind, sub, state: 'ready' }, { onOpen: (c) => this.openCard(c) });
    if (after?.isConnected) {
      // After the tool line and any cards already placed after it.
      let at = after;
      while (at.nextElementSibling?.classList.contains('art-card')) at = at.nextElementSibling;
      at.after(card);
    } else this.$.T.append(card);
    this.scrollDown();
    this.renderArtifactsButton();
  }

  /** The engine stored an artifact for this pane: fill its show card, or add a card. */
  onArtifact(e) {
    let card = e.toolUseId ? this.tools.get(e.toolUseId) : null;
    if (card && !card.classList.contains('art-card')) card = null; // a Bash line: the open was caught
    if (!card && e.via === 'show') card = [...this.$.T.querySelectorAll('.art-card[data-state=pending]')].pop() || null;
    if (card) {
      this.cardKeys.add(`a:${e.id}:${e.rev}`);
      updateCard(card, { id: e.id, rev: e.rev, title: e.title, kind: e.kind, state: 'ready' });
      this.renderArtifactsButton();
      return;
    }
    const via = e.via && e.via !== 'show' ? `Opened by ${e.via}` : '';
    this.placeArtifact({ id: e.id, rev: e.rev, title: e.title, kind: e.kind, sub: via }, e.toolUseId ? this.tools.get(e.toolUseId) : null);
  }

  onOpenUrl(e) {
    const tool = e.toolUseId ? this.tools.get(e.toolUseId) : null;
    if (tool?.classList.contains('art-card')) { this.placeLink({ url: e.url, title: e.title, reason: e.reason, toolUseId: e.toolUseId }, tool); return; }
    this.clearEmpty();
    this.placeLink({ url: e.url, title: e.title, reason: e.reason, toolUseId: e.toolUseId }, null, tool);
  }

  toolResult(id, content, isError) {
    const d = this.tools.get(id);
    if (!d) return;
    const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(content ?? '');
    if (d.classList.contains('art-card')) {
      if (d.classList.contains('link')) return;
      const urlInput = d.dataset.input ? JSON.parse(d.dataset.input) : null;
      if (urlInput && !isError) { this.placeLink({ url: urlInput.url, title: urlInput.title, reason: 'show', toolUseId: id }, d); return; }
      const ref = parseRef(text);
      if (isError || !ref) { updateCard(d, { state: 'error', error: text.replace(/^Apaki could not show that: /, '').slice(0, 240) }); return; }
      this.cardKeys.add(`a:${ref.id}:${ref.rev}`);
      updateCard(d, { id: ref.id, rev: ref.rev, state: 'ready' });
      this.renderArtifactsButton();
      return;
    }
    // A command run in the background: its result names the task, so it can be opened.
    const bg = text.match(/running in (?:the )?background with ID: ([\w-]+)/i);
    if (bg && !d.querySelector('.tool-open')) this.linkTool(id, { id: bg[1], type: 'local_bash', description: d.querySelector('.args')?.textContent.slice(1, -1) || 'Shell', status: this.liveTasks.get(bg[1])?.status || 'completed' });
    // A shell command Apaki caught opening something: cards for what it showed.
    const opened = parseOpened(text);
    for (const o of opened) {
      if (o.kind === 'url') this.placeLink({ url: o.url, reason: 'command', toolUseId: id }, null, d);
      else this.placeArtifact({ id: o.id, rev: o.rev, title: o.path.split(/[\\/]/).pop(), kind: kindFromPath(o.path), sub: 'Opened by a command' }, d);
    }
    const lines = text.split('\n').filter((l) => l.trim());
    // Denied only because Apaki showed it itself: that is a success, not an error.
    d.classList.add(isError && !opened.length ? 'err' : 'ok');
    if (opened.length) d.classList.add('caught');
    d.querySelector('.sum').textContent = lines.length ? `${lines[0].slice(0, 200)}${lines.length > 1 ? `  … +${lines.length - 1} lines` : ''}` : '(no output)';
    const pre = el('pre');
    pre.textContent = text.slice(0, 20000);
    d.append(pre);
    // What Claude saw (browser_screenshot): the picture, small, inside the tool line.
    const shot = Array.isArray(content) ? content.find((c) => c.type === 'image' && (c.source?.data || c.data)) : null;
    if (shot) {
      const img = el('img', 'tool-shot');
      img.alt = 'Screenshot Claude took';
      img.src = `data:${shot.source?.media_type || shot.mimeType || 'image/png'};base64,${shot.source?.data || shot.data}`;
      d.append(img);
    }
  }

  renderBlocks(role, content, { images } = {}) {
    if (typeof content === 'string') { if (role === 'user') this.addUser(content, images); else this.addAssistant(content); return; }
    if (!Array.isArray(content)) return;
    if (role === 'user') {
      const texts = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      const imgs = content.filter((b) => b.type === 'image' || b.type === 'image_marker');
      if ((texts && !/^<(command-|local-command-|task-notification)/.test(texts)) || imgs.length) this.addUser(texts, imgs.map(() => ({})));
      for (const b of content) if (b.type === 'tool_result') this.toolResult(b.tool_use_id, b.content, b.is_error);
      return;
    }
    for (const b of content) {
      if (b.type === 'text') this.addAssistant(b.text);
      else if (b.type === 'tool_use') this.addTool(b);
    }
  }

  renderHistory(messages, total) {
    // Ctrl+F says when it can only search the messages loaded here.
    this.historyCut = total > messages.length ? { shown: messages.length, total } : null;
    this.$.T.innerHTML = '';
    this.tools.clear();
    this.cardKeys.clear();
    if (total > messages.length) this.note(`Showing the latest ${messages.length} of ${total} messages. The whole conversation is in the session.`);
    for (const m of messages) {
      if (m.parent_tool_use_id) continue; // subagent traffic
      if (m.type !== 'user' && m.type !== 'assistant') continue;
      const c = m.message?.content;
      if (m.type === 'user' && typeof c === 'string' && (/^\s*<(command-|local-command-|system-reminder)/.test(c))) continue;
      this._at = m.at ? Date.parse(m.at) : null;
      this.renderBlocks(m.type, c);
    }
    this._at = null;
    this.flushOpenNotes();
    this.scrollDown(true);
    // Back where you were reading when the workspace was saved (crash recovery).
    if (this.restoreScroll && !this.restoreScroll.atEnd) this.$.ground.scrollTop = this.restoreScroll.top;
    this.restoreScroll = null;
    this.renderArtifactsButton();
    this.renderTasksButton();
  }

  flushOpenNotes() {
    for (const [text, tone] of this.openNotes || []) this.note(text, tone);
    this.openNotes = [];
  }

  /* ---------- live SDK messages ---------- */

  onSdk(msg) {
    if (msg.parent_tool_use_id) return;
    const T = this.$.T;
    if (msg.type === 'result' && this.autoTurn) {
      this.setBusy(false);
      this.setStatus('');
      queueMicrotask(() => this.flushQueue());
    }
    if (msg.type === 'stream_event') {
      const ev = msg.event || {};
      if (ev.type === 'message_start') {
        this.curMsg = ev.message?.id;
        // A turn Claude started by itself (a background task finished, a
        // notification): it works like one you sent, with its timer and Stop.
        if (!this.busy) { this.autoTurn = true; this.setBusy(true); }
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
        this.clearEmpty();
        const a = el('div', 'turn-assistant streaming');
        a.dataset.ts = stamp(Date.now());
        T.append(a);
        this.streams.set(`${this.curMsg}:${ev.index}`, a);
      }
      if (ev.type === 'content_block_start') {
        const b = ev.content_block || {};
        const next = b.type === 'thinking' || b.type === 'redacted_thinking' ? 'Thinking' : b.type === 'text' ? 'Writing' : b.type === 'tool_use' ? `Running ${String(b.name || 'a tool').replace(/^mcp__\w+__/, '')}` : this.phase;
        if (next !== this.phase) { this.phase = next; if (this.busy) this.showWorking(); }
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const a = this.streams.get(`${this.curMsg}:${ev.index}`);
        // Formatted while it streams (Arthur saw raw ** before), redrawn at most once a frame.
        if (a) { a._raw = (a._raw || '') + ev.delta.text; this.paintStream(a); }
      }
      return;
    }
    if (msg.type === 'assistant') {
      const id = msg.message?.id;
      (msg.message?.content || []).forEach((b, i) => {
        // The SDK can send each block of a message on its own (index 0), while
        // the stream numbered it after a thinking block; so fall back to the
        // oldest open stream of the same message, or the reply is drawn twice.
        let key = `${id}:${i}`;
        if (!this.streams.has(key)) key = [...this.streams.keys()].find((k) => k.startsWith(`${id}:`)) || key;
        const live = this.streams.get(key);
        if (b.type === 'text') {
          if (live) { cancelAnimationFrame(live._raf); live.classList.remove('streaming'); live.innerHTML = md(b.text); this.host.linkSessions?.(live); this.streams.delete(key); } else this.addAssistant(b.text);
        } else if (b.type === 'tool_use') {
          this.addTool(b);
        }
      });
      if (msg.error) this.note(String(msg.error), 'error');
      return;
    }
    if (msg.type === 'user') {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const b of content) if (b.type === 'tool_result') this.toolResult(b.tool_use_id, b.content, b.is_error);
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') this.note('Conversation compacted.');
    if (msg.type === 'system' && /^(task_|background_tasks_changed)/.test(msg.subtype || '')) this.onTaskMessage(msg);
  }

  /* ---------- status, busy state ---------- */

  setStatus(text) {
    this._working = false;
    this.$.status.textContent = text;
    this.statusOn(Boolean(text));
  }

  statusOn(on) {
    const g = this.$.ground;
    const atEnd = g.scrollHeight - g.scrollTop - g.clientHeight < 8;
    const was = this.$.statusLine.classList.contains('on');
    this.$.statusLine.classList.toggle('on', on);
    // The transcript makes room for the working line in one step (app.css): stay at the end if you were there.
    if (atEnd && was !== on) g.scrollTop = g.scrollHeight;
  }

  /**
   * The working line: what Claude is doing (Thinking, Writing, Running Bash),
   * three moving dots, and the time. Built once per turn and updated in place,
   * so the dots keep their rhythm.
   */
  showWorking() {
    const st = this.$.status;
    if (!this._working) {
      st.innerHTML = '<span class="ph"></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="st-rest"></span>';
      this._working = true;
      this.statusOn(true);
    }
    st.querySelector('.ph').textContent = this.phase || 'Working';
    st.querySelector('.st-rest').textContent = ` · ${Math.round((Date.now() - this.turnStart) / 1000)}s · esc to stop`;
  }

  setBusy(on) {
    this.busy = on;
    if (!on) this.autoTurn = false;
    this.renderSendButton();
    this.renderQueue();
    this.el.classList.toggle('busy', on);
    clearInterval(this.tick);
    // While working, the status line above the message box carries a live grid.
    this.$.egridSlot.innerHTML = on ? effortGrid('max', { live: true }) : '';
    if (on) {
      this.turnStart = Date.now();
      this.phase = 'Working';
      this.tick = setInterval(() => this.showWorking(), 500);
      this.showWorking();
    }
    this.host.changed(this);
  }

  /* ---------- send ---------- */

  localCommand(text) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'new': case 'clear': this.host.newConversation(this); return true;
      case 'model': if (arg) this.setModel(MODELS[arg] || arg); else this.note(`Model: ${this.model}`); return true;
      case 'effort': if (arg) this.setEffort(arg); else this.note(`Effort: ${this.effort}`); return true;
      case 'mode': if (arg) this.setMode(arg); else this.note(`Mode: ${this.mode}`); return true;
      case 'key': this.send('billingOptions'); return true;
      case 'warm': this.send('warm', { arg }); return true;
      case 'folder': if (arg && this.sessionId) this.send('folder', { action: 'create', name: arg, sessionId: this.sessionId }); return true;
      default: return false;
    }
  }

  /** True when the box holds something to send (text or images). */
  hasDraft() {
    return Boolean(this.$.input.value.trim()) || this.attachments.length > 0;
  }

  /** The button: Send when idle; while working, Queue with a draft and Stop without. */
  renderSendButton() {
    const b = this.$.send;
    const mode = !this.busy ? 'send' : this.hasDraft() ? 'queue' : 'stop';
    b.textContent = { send: 'Send', queue: 'Queue', stop: 'Stop' }[mode];
    b.classList.toggle('stop', mode === 'stop');
    b.classList.toggle('queue', mode === 'queue');
    b.title = { send: 'Send (Enter)', queue: 'Queue this for when Claude finishes (Enter). Ctrl+Enter steers it in now', stop: 'Stop Claude (Esc)' }[mode];
  }

  /** Stops the running turn. Queued messages stay; they do not go out on their own after a stop. */
  stop() {
    if (!this.busy) return;
    this.stoppedByUser = true;
    this.send('interrupt');
    this.setStatus('Stopping…');
  }

  /* ---------- queued messages ---------- */

  enqueue(text, attachments) {
    this.queue.push({ id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text, attachments });
    this.renderQueue();
  }

  renderQueue() {
    const box = this.$.queue;
    if (!box) return;
    this.host.dirty?.();
    box.hidden = !this.queue.length;
    if (!this.queue.length) { box.innerHTML = ''; this.queueSig = ''; return; }
    // While Claude works: Steer adds the message to the current work now.
    // After a stop (nothing to steer): Send starts a new turn with it.
    const act = this.busy ? 'Steer' : 'Send';
    const actTip = this.busy ? 'Add this to what Claude is doing now, without stopping it (Ctrl+Enter in the box does the same)' : 'Send this now';
    // Rebuilt only when something changed: a row replaced between press and release swallows the click
    // (2026-10-10, "the steer button doesnt work").
    const sig = `${this.busy}|${this.queue.map((it) => `${it.id}:${it.text.length}:${it.attachments.length}`).join(',')}`;
    if (sig === this.queueSig && box.childElementCount) return;
    this.queueSig = sig;
    box.innerHTML = `<div class="q-head"><span>${this.queue.length === 1 ? 'Queued' : `${this.queue.length} queued`}</span><span class="q-hint">${this.busy ? 'Sends when Claude finishes · Steer or Ctrl+Enter adds it now' : 'Not sent: Claude was stopped'}</span></div>`
      + this.queue.map((it) => `<div class="q-item" data-id="${it.id}"><span class="q-text" title="Edit">${esc(it.text || '(images)')}</span>${it.attachments.length ? `<span class="q-img">${it.attachments.length} image${it.attachments.length > 1 ? 's' : ''}</span>` : ''}<button class="q-act" data-q="act" title="${actTip}">${act}</button><button class="q-edit" data-q="edit" title="Put it back in the message box to change it (Up arrow in an empty box does the same)">Edit</button><button class="q-x" data-q="x" title="Remove" aria-label="Remove">×</button></div>`).join('');
    // One listener for the whole list (set once), reading the row and the button at click time.
    if (!box.dataset.wired) {
      box.dataset.wired = '1';
      box.addEventListener('click', (e) => {
        const row = e.target.closest('.q-item');
        if (!row) return;
        const id = row.dataset.id;
        const k = e.target.closest('[data-q]')?.dataset.q || (e.target.closest('.q-text') ? 'edit' : null);
        if (k === 'act') { if (this.busy) this.steerItem(id); else this.sendItem(id); }
        else if (k === 'edit') this.editItem(id);
        else if (k === 'x') this.removeItem(id);
      });
    }
  }

  takeItem(id) {
    const i = this.queue.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [it] = this.queue.splice(i, 1);
    this.renderQueue();
    return it;
  }

  removeItem(id) { this.takeItem(id); this.$.input.focus(); }

  /** Pulls a queued message back into the box to change it (Enter queues it again). */
  editItem(id) {
    const it = this.takeItem(id);
    if (!it) return;
    const { input } = this.$;
    input.value = input.value.trim() ? `${it.text}\n${input.value}` : it.text;
    this.attachments = [...it.attachments, ...this.attachments];
    this.renderAttachments();
    this.autosize();
    this.renderSendButton();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Steer: hand a queued message to the running turn; it is shown once Claude Code took it. */
  steerItem(id) {
    const it = this.takeItem(id);
    if (!it) return;
    this.steering.set(id, it);
    this.send('steer', { qid: id, text: it.text, images: it.attachments.map(({ media_type, data }) => ({ media_type, data })) });
  }

  sendItem(id) {
    const it = this.takeItem(id);
    if (it) this.sendNow(it.text, it.attachments);
  }

  /** Starts a turn with this message. */
  sendNow(text, attachments = []) {
    const images = attachments.map(({ media_type, data }) => ({ media_type, data }));
    this.stoppedByUser = false;
    this.addUser(text, attachments);
    this.setBusy(true);
    this.send('send', { text, images });
  }

  /** After a turn ends on its own, everything queued goes out together as the next message. */
  flushQueue() {
    if (this.busy || this.stoppedByUser || !this.queue.length) return;
    const items = this.queue.splice(0);
    this.renderQueue();
    this.sendNow(items.map((it) => it.text).filter(Boolean).join('\n\n'), items.flatMap((it) => it.attachments));
  }

  /** Sends the box. While Claude works it queues, or with { steer: true } (Ctrl+Enter) goes into the running turn now. */
  submit({ steer = false } = {}) {
    // Held elsewhere: the card's button is the way forward, not a message.
    if (this.lockedBy) { this.$.T.querySelector('.takeover')?.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 220, easing: 'ease-out' }); return; }
    const { input } = this.$;
    const text = input.value.trim();
    if (!text && !this.attachments.length) return;
    this.hideSlash();
    if (text.startsWith('/') && !this.attachments.length && this.localCommand(text)) { input.value = ''; this.autosize(); return; }
    const attachments = this.attachments;
    this.attachments = [];
    this.renderAttachments();
    input.value = '';
    this.autosize();
    // Working: queue it (Steer adds it to the current work). Never stops the turn.
    if (this.busy && steer) { this.enqueue(text, attachments); this.steerItem(this.queue[this.queue.length - 1].id); this.renderSendButton(); return; }
    if (this.busy) { this.enqueue(text, attachments); this.renderSendButton(); return; }
    this.sendNow(text, attachments);
  }

  /* ---------- composer ---------- */

  autosize() {
    const { input } = this.$;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, this.el.clientHeight * 0.4 || window.innerHeight * 0.4)}px`;
  }

  updateSlash() {
    const v = this.$.input.value;
    const m = v.match(/^\/(\S*)$/);
    if (!m) { this.hideSlash(); return; }
    const q = m[1].toLowerCase();
    const all = [...LOCAL, ...this.commands.filter((c) => !LOCAL.some((l) => l.name === c.name))];
    const hits = all.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 40);
    const ul = this.$.slash;
    ul.innerHTML = '';
    for (const c of hits) {
      const li = el('li', '', `<span class="n">/${esc(c.name)}</span><span class="d">${esc(c.description || '')}</span>`);
      li.dataset.name = c.name;
      li.onmousedown = (e) => { e.preventDefault(); this.$.input.value = `/${c.name} `; this.hideSlash(); this.$.input.focus(); };
      ul.append(li);
    }
    ul.hidden = !hits.length;
    this.slashSel = 0;
    this.paintSlash();
  }

  paintSlash() { [...this.$.slash.children].forEach((li, i) => li.classList.toggle('on', i === this.slashSel)); }

  hideSlash() { this.$.slash.hidden = true; }

  /* ---------- images ---------- */

  async addImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const type = file.type === 'image/png' && w * h < 1200 * 1200 ? 'image/png' : 'image/jpeg';
    const url = canvas.toDataURL(type, 0.9);
    this.attachments.push({ media_type: type, data: url.split(',')[1], url, w, h });
    this.renderAttachments();
  }

  renderAttachments() {
    this.renderSendButton();
    const box = this.$.attachments;
    box.innerHTML = '';
    this.attachments.forEach((a, i) => {
      const c = el('div', 'chip', `<img src="${a.url}" alt=""><span class="dim">${a.w}×${a.h}</span>`);
      const x = el('button', 'chip-x', '×');
      x.title = 'Remove';
      x.onclick = () => { this.attachments.splice(i, 1); this.renderAttachments(); };
      c.append(x);
      box.append(c);
    });
  }

  setVoice(available) {
    this.$.mic.disabled = !available;
    this.$.mic.title = available ? 'Dictate (local Whisper): click to start, click again to stop' : 'Voice needs whisper.cpp in Programs\\Myrlin Apaki\\voice';
  }

  /* ---------- engine events for this pane ---------- */

  handle(e) {
    switch (e.ev) {
      case 'locked': this.showLocked(e); break;
      case 'taken_over': this.showLocked(e, { lost: true }); break;
      case 'opened':
        this.lockedBy = null;
        if (e.sessionId !== this.sessionId) { this.queue = []; this.steering.clear(); this.stoppedByUser = false; this.renderQueue(); this.closedArts.clear(); }
        this.sessionId = e.sessionId; this.cwd = e.cwd; this.billing = e.billing;
        this.streams.clear(); this.tools.clear(); this.cardKeys.clear();
        this.setTitle(e.title || 'New conversation');
        this.setCwdLine();
        this.renderBilling();
        // The context meter belongs to the session: another one starts empty, then measures.
        if (this.ctx && this.ctx.sessionId !== e.sessionId) { this.ctx = null; this.renderContext(); }
        this.askContext(1500);
        if (e.sessionId) this.$.T.innerHTML = '';
        else this.showEmpty();
        // Re-attached after a reconnect (the phone client): busy says whether a turn is still running.
        if (e.attached) this.setBusy(Boolean(e.busy));
        // Notes about how this session opened go below its history, which
        // arrives next and redraws the transcript (they were wiped before).
        this.openNotes = [];
        if (e.tookOver) this.openNotes.push(['Taken over: the other window is stopped before its next message, so this conversation continues only here.', '']);
        if (e.terminal?.length) this.openNotes.push([`This session is also open in a Claude Code terminal window (${e.terminal.map((t) => t.name).join(', ')}). Stop typing there while you work here; that window must /resume to see these turns.`, 'warn']);
        // Re-attached (the background host kept this Claude Code process running): nothing was cut off.
        if (this.crashNote && e.attached) this.crashNote = false;
        if (this.crashNote) { this.openNotes.push(['Apaki closed while Claude was working here, and its Claude Code process stopped with it. Everything it did until then is above; send a message to carry on.', 'warn']); this.crashNote = false; }
        if (e.sessionId !== this.sessionId || e.reset) this.liveTasks.clear();
        this.renderTasksButton();
        if (!e.sessionId) this.flushOpenNotes();
        this.send('commands');
        this.host.changed(this);
        break;
      case 'history': if (e.sessionId === this.sessionId) this.renderHistory(e.messages, e.total); break;
      case 'session_id':
        this.sessionId = e.sessionId; this.setCwdLine(); this.host.changed(this);
        if (this.pendingName) { this.send('rename', { sessionId: e.sessionId, title: this.pendingName }); this.pendingName = null; }
        break;
      case 'sdk': this.onSdk(e.msg); break;
      case 'result': {
        this.setBusy(false);
        queueMicrotask(() => this.flushQueue());
        const u = e.usage || {};
        const k = (n) => `${((n || 0) / 1000).toFixed(1)}k`;
        const foot = [`${((e.durationMs || 0) / 1000).toFixed(1)}s`, `${k(u.cache_read_input_tokens)} cached`, `${k(u.cache_creation_input_tokens)} new`, e.cost != null ? `$${e.cost.toFixed(3)}` : null, this.billing?.name ? `${this.billing.name}${this.billing.isKey ? ' (API key)' : ''}` : null].filter(Boolean).join(' · ');
        this.$.T.append(el('div', 'foot', esc(foot)));
        if (e.isError) this.note(e.result || (e.errors || []).join('; ') || e.subtype, 'error');
        this.setStatus('');
        this.scrollDown();
        if (!this.commands.length) this.send('commands');
        break;
      }
      case 'billing': this.billing = e; this.renderBilling(); if (e.note) this.note(e.note); break;
      case 'context': if (!e.none && (!e.sessionId || !this.sessionId || e.sessionId === this.sessionId)) { this.ctx = e; this.renderContext(); } break;
      case 'commands': this.commands = e.commands || []; break;
      case 'artifact': this.onArtifact(e); break;
      case 'openUrl': this.onOpenUrl(e); break;
      case 'settings': this.model = e.model || this.model; this.effort = e.effort || this.effort; this.mode = e.mode || this.mode; this.renderChips(); break;
      case 'note': this.note(e.text, e.tone || ''); break;
      case 'steered': { const it = this.steering.get(e.qid); this.steering.delete(e.qid); if (it) this.addUser(it.text, it.attachments, { steered: true }); break; }
      case 'steer_missed': {
        // The turn ended before the steer arrived: send it as the next message.
        const it = this.steering.get(e.qid);
        this.steering.delete(e.qid);
        if (!it) break;
        if (this.busy) { this.queue.unshift(it); this.renderQueue(); } else this.sendNow(it.text, it.attachments);
        break;
      }
      case 'error': this.setBusy(false); this.setStatus(''); this.note(e.message, 'error'); break;
      case 'transcript': {
        if (!this.busy) this.setStatus(e.text ? `Transcribed in ${(e.ms / 1000).toFixed(1)}s` : 'Heard nothing');
        const { input } = this.$;
        if (e.text) { input.value = input.value ? `${input.value.replace(/\s*$/, '')} ${e.text}` : e.text; this.autosize(); input.focus(); }
        break;
      }
      default: break;
    }
  }

  /** Called when the engine restarted: every Claude Code process is gone. */
  engineLost() {
    if (this.busy) { this.setBusy(false); this.note('The engine stopped and is restarting; send your message again.', 'warn'); }
    this.setStatus('');
  }

  destroy() {
    clearInterval(this.tick);
    this.el.remove();
  }
}
