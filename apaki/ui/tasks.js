/**
 * tasks.js: subagents, background shells, monitors and workflows in Myrlin Apaki.
 *
 * Arthur, 2026-10-10: "seeing subagents/shells open, etc and be able to click
 * to see what they're called and even open them in new windows/tabs/etc - be
 * able to drag them, stop them", and see how many subagents a session has,
 * expand them, open them.
 *
 * Two parts:
 *   TaskPane     a viewer pane for one subagent (its transcript, live) or one
 *                shell/Monitor (its output, live). It sits in the split layout
 *                like any pane: drag by its grip, close with Ctrl+W, saved with
 *                the workspace. Stop works when the conversation that started
 *                it runs in this window.
 *   tasksPanel   the popover behind a conversation's Tasks button: what is
 *                running now (from the SDK's task_* messages, see pane.js),
 *                what ended, and every subagent and shell this session had
 *                before (from disk, engine tasks.js). Rows open as a split or
 *                a tab, drag onto a pane edge or a tab, stop, or go to the
 *                background (Ctrl+B in Claude Code).
 *
 * A task spec (what a viewer shows, what a drag carries):
 *   { kind: 'agent'|'shell', sessionId, agentId?, toolUseId?, taskId?,
 *     ownerPane?, title, type?, model? }
 */

import { esc, md } from './markdown.js';
import { toolArgs } from './pane.js';
// A subagent's TodoWrite calls as one live checklist, like the conversation's (todos.js, 2026-10-12).
import { continuesList, hasTodos, normalizeTodos, paintTodos, sameTodos } from './todos.js';

export const DRAG_TASK = 'application/x-apaki-task';

const GLYPH = {
  agent: '<circle cx="8" cy="5.2" r="2.4"/><path d="M3.4 13.6c.6-2.6 2.4-4 4.6-4s4 1.4 4.6 4"/><path d="M12.6 2.6l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5z"/>',
  shell: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8"/><path d="m4.6 6.4 2 1.7-2 1.7M8.4 10h3"/>',
  monitor: '<path d="M1.8 8.4h2.6l1.5-3.6 2.4 7 1.6-4.4 1.1 1h3.2"/>',
  workflow: '<rect x="1.8" y="2.2" width="4.6" height="3.6" rx="1"/><rect x="9.6" y="2.2" width="4.6" height="3.6" rx="1"/><rect x="5.7" y="10.2" width="4.6" height="3.6" rx="1"/><path d="M4.1 5.8v1.6c0 .6.4 1 1 1h5.8c.6 0 1-.4 1-1V5.8M8 8.4v1.8"/>',
  task: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>',
};

/** The kind a task_type (or a file on disk) is shown as. */
export function taskKind(type = '') {
  const t = String(type);
  if (t === 'local_agent' || t === 'agent') return 'agent';
  if (t === 'local_bash' || t === 'shell') return 'shell';
  if (/monitor/.test(t)) return 'monitor';
  if (/workflow/.test(t)) return 'workflow';
  return 'task';
}
export const KIND_LABEL = { agent: 'Agent', shell: 'Shell', monitor: 'Monitor', workflow: 'Workflow', task: 'Task' };
export const taskGlyph = (kind) => `<svg viewBox="0 0 16 16" aria-hidden="true">${GLYPH[kind] || GLYPH.task}</svg>`;

/** "8s", "2m 14s", "1h 05m". */
export function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtK = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

/** The line under a task's name: type, model, time, tool uses, tokens. */
export function taskLine(t, now = Date.now()) {
  const kind = taskKind(t.type);
  const end = t.endedAt || (t.status === 'running' ? now : t.lastAt || now);
  const parts = [
    kind === 'agent' ? (t.subagentType || 'agent') : KIND_LABEL[kind],
    t.model || '',
    t.startedAt ? fmtDur(end - t.startedAt) : '',
    t.usage?.tool_uses ? `${t.usage.tool_uses} tool use${t.usage.tool_uses === 1 ? '' : 's'}` : '',
    t.usage?.total_tokens ? `${fmtK(t.usage.total_tokens)} tokens` : '',
    t.lastTool && t.status === 'running' ? `now ${t.lastTool}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** What a task's status reads as. */
export function statusWord(t) {
  return { running: 'running', pending: 'starting', completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped', paused: 'paused' }[t.status] || t.status || '';
}

/** A stable key for a spec, so the same task opens in one viewer. */
export const specKey = (s) => [s.kind, s.sessionId, s.agentId || s.toolUseId || s.taskId || ''].join(':');

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
// Shell output: plain text, escape sequences out.
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\r(?!\n)/g, '\n');

/* ---------- the viewer ---------- */

export class TaskPane {
  constructor(id, host, spec = {}) {
    this.id = id;
    this.host = host;
    this.isViewer = true;
    this.isTask = true;
    this.art = {}; // not an artifact viewer (app.js looks artifacts up by art.id)
    this.spec = { ...spec };
    this.sessionId = null;
    this.cwd = '';
    this.busy = false;
    this.unread = false;
    this.sourcePane = spec.ownerPane || null;
    this.title = spec.title || KIND_LABEL[spec.kind] || 'Task';
    this.tools = new Map();
    this.todoCard = null;
    this.running = false;
    this.el = el('section', 'pane viewer task-viewer');
    this.el.dataset.pane = id;
    this.el.innerHTML = `
      <header class="pane-bar">
        <span class="grip" draggable="true" title="Drag to move this viewer">
          <svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/></svg>
        </span>
        <div class="title-block">
          <h2 class="title"></h2>
          <div class="meta-line"><span class="art-badge tk-badge"></span><span class="cwd tk-meta"></span></div>
        </div>
        <button class="tk-stop" hidden title="Stop it (Claude Code's own stop)">Stop</button>
        <button class="icon-btn source" title="Show the conversation that started it"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.2c0-.8.6-1.4 1.4-1.4h8.2c.8 0 1.4.6 1.4 1.4v5.4c0 .8-.6 1.4-1.4 1.4H7.4l-3 2.4V11h-.5c-.8 0-1.4-.6-1.4-1.4z"/></svg></button>
        <button class="icon-btn close" title="Close viewer (Ctrl+W)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      </header>
      <div class="ground tk-ground"><div class="transcript tk-body"></div></div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { title: q('.title'), badge: q('.tk-badge'), meta: q('.tk-meta'), body: q('.tk-body'), ground: q('.tk-ground'), grip: q('.grip'), close: q('.close'), stop: q('.tk-stop'), source: q('.source'), input: null };
    this.el.addEventListener('pointerdown', () => host.focus(this), true);
    this.$.close.onclick = () => host.close(this);
    this.$.stop.onclick = () => { this.$.stop.disabled = true; this.$.stop.textContent = 'Stopping…'; host.stopTask?.(this.spec); };
    this.$.source.onclick = () => host.showSession?.(this.spec.sessionId);
    this.$.grip.addEventListener('dragstart', (e) => host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => host.dragEnd());
    this.$.body.innerHTML = '<div class="art-loading"><i></i><i></i><i></i></div>';
    this.renderHead();
    this.watch();
  }

  /** Asks the engine for the file and every change to it (agentWatch / outputWatch). */
  watch() {
    if (this.spec.kind === 'agent') this.host.send('agentWatch', { paneId: this.id, sessionId: this.spec.sessionId, agentId: this.spec.agentId || null, toolUseId: this.spec.toolUseId || null });
    else this.host.send('outputWatch', { paneId: this.id, sessionId: this.spec.sessionId, taskId: this.spec.taskId || '' });
  }

  renderHead() {
    const s = this.spec;
    const kind = s.kind === 'agent' ? 'agent' : taskKind(s.type || 'shell');
    this.title = s.title || KIND_LABEL[kind];
    this.$.title.textContent = this.title;
    this.$.title.title = this.title;
    const live = this.host.taskState?.(s) || null;
    const running = live ? live.status === 'running' : this.running;
    this.$.badge.innerHTML = `${taskGlyph(kind)}<span>${esc(KIND_LABEL[kind])}</span>`;
    const from = this.host.sessionTitle?.(s.sessionId);
    // A live task's line already names its type; the model comes from its file on disk.
    const meta = live
      ? [taskLine({ ...live, model: s.model || live.model }), running ? 'running' : statusWord(live), from ? `from ${from}` : '']
      : [s.kind === 'agent' ? s.type : '', s.model || '', running ? 'running' : this.lastAt ? 'ended' : '', from ? `from ${from}` : ''];
    this.$.meta.textContent = [...new Set(meta.filter(Boolean))].join('  ·  ');
    this.el.classList.toggle('running', Boolean(running));
    const canStop = Boolean(running && live && s.ownerPane && (s.taskId || live.id));
    this.$.stop.hidden = !canStop;
    if (canStop && this.$.stop.textContent !== 'Stopping…') this.$.stop.disabled = false;
  }

  handle(e) {
    if (e.ev === 'agentLines') this.onAgentLines(e);
    if (e.ev === 'outputText') this.onOutput(e);
  }

  onAgentLines(e) {
    const body = this.$.body;
    const g = this.$.ground;
    const atEnd = g.scrollHeight - g.scrollTop - g.clientHeight < 40;
    if (e.reset) { body.innerHTML = ''; this.tools.clear(); this.todoCard = null; }
    if (e.missing) { body.innerHTML = '<p class="tk-empty">No transcript for this subagent yet. It appears here as soon as Claude Code writes one.</p>'; return; }
    if (e.agent) {
      this.spec = { ...this.spec, agentId: e.agent.id, title: this.spec.title || e.agent.description, type: this.spec.type || e.agent.type, model: this.spec.model || e.agent.model };
    }
    this.running = Boolean(e.running);
    this.lastAt = e.lastAt || this.lastAt;
    for (const m of e.entries || []) this.renderEntry(m);
    if (!body.children.length) body.innerHTML = '<p class="tk-empty">Nothing written yet.</p>';
    this.renderHead();
    if (atEnd || e.reset) g.scrollTop = g.scrollHeight;
  }

  renderEntry(m) {
    const body = this.$.body;
    body.querySelector('.tk-empty, .art-loading')?.remove();
    const c = m.message?.content;
    if (m.type === 'user') {
      if (typeof c === 'string') { this.addPrompt(c, body.querySelector('.tk-prompt') ? 'Message' : 'Prompt'); return; }
      for (const b of c || []) {
        if (b.type === 'text' && b.text?.trim() && !/^<(system-reminder|task-notification)/.test(b.text)) this.addPrompt(b.text, 'Message');
        if (b.type === 'tool_result') this.toolResult(b);
      }
      return;
    }
    for (const b of c || []) {
      if (b.type === 'text' && b.text?.trim()) body.append(el('div', 'turn-assistant', md(b.text)));
      if (b.type === 'tool_use') this.addTool(b);
    }
  }

  addPrompt(text, label) {
    this.todoCard = null;
    const card = el('div', 'tk-prompt');
    card.innerHTML = `<div class="tk-prompt-h">${esc(label)}</div><div class="tk-prompt-t"></div>`;
    card.querySelector('.tk-prompt-t').textContent = text;
    if (text.split('\n').length > 8 || text.length > 700) {
      card.classList.add('long');
      const more = el('button', 'tk-more', 'Show all');
      more.onclick = () => { card.classList.toggle('open'); more.textContent = card.classList.contains('open') ? 'Show less' : 'Show all'; };
      card.append(more);
    }
    this.$.body.append(card);
  }

  addTool(b) {
    if (b.name === 'TodoWrite' && hasTodos(b.input) && (normalizeTodos(b.input).length || this.todoCard?.card.parentNode)) { this.addTodos(b); return; }
    const d = el('details', 'tool');
    const label = b.name === 'Task' ? 'Agent' : String(b.name || '').replace(/^mcp__\w+__/, '');
    d.innerHTML = `<summary><span class="dot">⏺</span><span class="name">${esc(label)}</span><span class="args">(${esc(toolArgs(b.name, b.input))})</span></summary><div class="sum">running…</div>`;
    this.$.body.append(d);
    this.tools.set(b.id, d);
  }

  /** A TodoWrite call: one checklist card per run of calls, updated in place (pane.js addTodos has the rules). */
  addTodos(b) {
    const list = normalizeTodos(b.input);
    const cur = this.todoCard?.card.parentNode ? this.todoCard : null;
    if (cur && (!list.length || continuesList(cur.list, list))) {
      this.tools.set(b.id, cur.card);
      if (!sameTodos(cur.list, list)) { paintTodos(cur.card, list); cur.list = list; }
      return;
    }
    const card = el('div', 'todos');
    card.setAttribute('role', 'group');
    paintTodos(card, list);
    this.$.body.append(card);
    this.tools.set(b.id, card);
    this.todoCard = { card, list };
  }

  toolResult(b) {
    const d = this.tools.get(b.tool_use_id);
    if (!d || d.classList.contains('todos')) return;
    const text = String(b.content || '');
    const lines = text.split('\n').filter((l) => l.trim());
    d.querySelector('.sum').textContent = `⎿ ${lines[0]?.slice(0, 160) || '(no output)'}${lines.length > 1 ? ` … ${lines.length} lines` : ''}`;
    d.classList.add(b.is_error ? 'err' : 'ok');
    const pre = el('pre', '');
    pre.textContent = text;
    d.append(pre);
  }

  onOutput(e) {
    const body = this.$.body;
    if (e.missing) { body.innerHTML = '<p class="tk-empty">No output file for this task. Claude Code may have removed it, or it has not written anything yet.</p>'; return; }
    let pre = body.querySelector('pre.tk-out');
    if (e.reset || !pre) {
      body.innerHTML = '';
      if (e.cut) body.append(el('p', 'tk-cut', 'Showing the end of the output.'));
      pre = el('pre', 'tk-out');
      body.append(pre);
    }
    const g = this.$.ground;
    const atEnd = g.scrollHeight - g.scrollTop - g.clientHeight < 40;
    pre.append(document.createTextNode(stripAnsi(e.text)));
    // Keep the page light: about the last 400 KB on screen.
    if (pre.textContent.length > 450000) pre.textContent = pre.textContent.slice(-400000);
    this.running = Boolean(e.running);
    this.lastAt = e.lastAt || this.lastAt;
    this.renderHead();
    if (atEnd || e.reset) g.scrollTop = g.scrollHeight;
  }

  /** The engine restarted: watch the file again. */
  engineBack() { this.watch(); }

  /** What the workspace saves for this viewer. */
  saved() { return { task: true, ...this.spec }; }

  // The pane interface app.js uses.
  note() {}
  engineLost() {}
  setVoice() {}
  renderFolderSelect() {}
  open() {}

  destroy() {
    this.host.send('unwatch', { paneId: this.id });
    this.el.remove();
  }
}

let taskSeq = 0;
export const newTaskViewerId = () => `k${Date.now().toString(36)}${(++taskSeq).toString(36)}`;

/* ---------- the tasks panel ---------- */

let panel = null;

export function closeTasksPanel() {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.cleanup();
  p.el.classList.add('out');
  setTimeout(() => p.el.remove(), 110);
}

/** The panel's pane, if it is open (app.js redraws it as tasks change). */
export const tasksPanelPane = () => panel?.pane || null;

/**
 * Opens (or redraws) the tasks panel for `pane` below `anchor`.
 * actions: { open(spec, { tab }), stop(spec), background(spec), dragStart(spec, e), dragEnd() }
 * disk: { agents, shells } from the engine's subagents op, or null while it loads.
 */
export function tasksPanel(anchor, pane, actions, disk = null) {
  const reopen = panel?.pane === pane;
  const scroll = reopen ? panel.el.querySelector('.tp-body')?.scrollTop || 0 : 0;
  if (panel && !reopen) closeTasksPanel();
  const box = reopen ? panel.el : el('div', 'task-panel');
  const live = [...(pane.liveTasks?.values() || [])].filter((t) => !t.ambient);
  const running = live.filter((t) => t.status === 'running' || t.status === 'pending');
  const ended = live.filter((t) => !running.includes(t));
  const liveTools = new Set(live.map((t) => t.toolUseId).filter(Boolean));
  const liveIds = new Set(live.map((t) => t.id));
  const earlierAgents = (disk?.agents || []).filter((a) => !liveTools.has(a.toolUseId) && !liveIds.has(a.id));
  const earlierShells = (disk?.shells || []).filter((s) => !liveIds.has(s.id));

  const row = (t, spec, { canStop = false, canBackground = false } = {}) => {
    const kind = spec.kind === 'agent' ? 'agent' : taskKind(t.type || 'shell');
    const r = el('div', `tp-row${t.status === 'running' ? ' running' : ''}`);
    r.draggable = true;
    r.innerHTML = `<span class="tp-g">${taskGlyph(kind)}</span>
      <div class="tp-main"><div class="tp-t"></div><div class="tp-m"></div>${t.summary ? '<div class="tp-s"></div>' : ''}</div>
      <div class="tp-act">${canBackground ? '<button data-a="bg" title="Move it to the background so the turn goes on (Ctrl+B in Claude Code)">Background</button>' : ''}${canStop ? '<button data-a="stop" class="danger" title="Stop it">Stop</button>' : ''}<button data-a="open" title="Open beside this conversation">Open</button><button data-a="tab" class="icon" title="Open in a new tab"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.5" width="12" height="9.5" rx="1.6"/><path d="M2 6.2h12M9.5 9.6h-3M8 8.1v3"/></svg></button></div>`;
    r.querySelector('.tp-t').textContent = spec.title || t.description || KIND_LABEL[kind];
    r.querySelector('.tp-m').textContent = [statusWord(t), taskLine(t)].filter(Boolean).join(' · ');
    r.querySelector('.tp-m').title = r.querySelector('.tp-m').textContent;
    if (t.summary) r.querySelector('.tp-s').textContent = t.summary;
    r.querySelectorAll('button').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.a;
        if (a === 'open') { closeTasksPanel(); actions.open(spec, {}); }
        if (a === 'tab') { closeTasksPanel(); actions.open(spec, { tab: true }); }
        if (a === 'stop') { b.disabled = true; b.textContent = 'Stopping…'; actions.stop(spec); }
        if (a === 'bg') { b.disabled = true; actions.background(spec); }
      };
    });
    r.onclick = (e) => { closeTasksPanel(); actions.open(spec, { tab: e.ctrlKey || e.metaKey }); };
    r.addEventListener('dragstart', (e) => { actions.dragStart(spec, e); setTimeout(closeTasksPanel, 0); });
    r.addEventListener('dragend', () => actions.dragEnd());
    return r;
  };

  const liveSpec = (t) => {
    const kind = taskKind(t.type);
    return kind === 'agent'
      ? { kind: 'agent', sessionId: pane.sessionId, toolUseId: t.toolUseId || null, agentId: null, taskId: t.id, ownerPane: pane.id, title: t.description, type: t.subagentType || 'agent' }
      : { kind: 'shell', sessionId: pane.sessionId, taskId: t.id, ownerPane: pane.id, title: t.description, type: t.type };
  };

  const head = `<div class="tp-head"><span class="tp-h">Tasks</span><span class="tp-n">${running.length ? `${running.length} running` : 'nothing running'}</span></div>`;
  box.innerHTML = `${head}<div class="tp-body"></div>`;
  const body = box.querySelector('.tp-body');
  const section = (title, rows) => {
    if (!rows.length) return;
    body.append(el('div', 'tp-sec', esc(title)));
    for (const r of rows) body.append(r);
  };
  section('Running now', running.map((t) => row(t, liveSpec(t), { canStop: true, canBackground: !t.backgrounded && ['agent', 'shell'].includes(taskKind(t.type)) && Boolean(t.toolUseId) })));
  section('Finished here', ended.map((t) => row(t, liveSpec(t))));
  const EARLIER = 60;
  section('Earlier in this session', [
    ...earlierAgents.slice(0, EARLIER).map((a) => row({ ...a, type: 'local_agent', subagentType: a.type, status: a.running ? 'running' : 'completed', startedAt: a.startedAt, lastAt: a.lastAt }, { kind: 'agent', sessionId: pane.sessionId, agentId: a.id, toolUseId: a.toolUseId, title: a.description || a.type, type: a.type, model: a.model })),
    ...earlierShells.map((s) => row({ ...s, type: 'local_bash', status: s.running ? 'running' : 'completed', description: `Output ${s.id}` }, { kind: 'shell', sessionId: pane.sessionId, taskId: s.id, title: `Shell ${s.id}`, type: 'local_bash' })),
  ]);
  if (earlierAgents.length > EARLIER) body.append(el('p', 'tp-wait', `${earlierAgents.length - EARLIER} older subagents not shown (the newest ${EARLIER} are).`));
  if (!body.children.length) body.append(el('p', 'tp-empty', disk ? 'This session has not started any subagents, shells or monitors.' : 'Reading this session’s subagents…'));
  if (!disk && body.children.length) body.append(el('p', 'tp-wait', 'Reading earlier subagents…'));

  if (!reopen) {
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    const w = 420;
    box.style.width = `${w}px`;
    box.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    box.style.top = `${r.bottom + 6}px`;
    box.style.maxHeight = `${Math.max(220, window.innerHeight - r.bottom - 20)}px`;
    const onDown = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closeTasksPanel(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeTasksPanel(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    panel = { el: box, pane, anchor, cleanup: () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); } };
  } else {
    body.scrollTop = scroll;
  }
  return box;
}
