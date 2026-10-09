/**
 * chat.js
 *
 * The chat screen: Claude Code's layout over the Agent SDK.
 *
 * ChatStore owns the conversation state and talks to the SessionRunner (one
 * live Claude Code process, see ../runner.js); the Chat component renders it.
 * Finished items go to Ink's <Static> (printed once, so the terminal's own
 * scrollback holds the transcript, as in Claude Code); the running turn, the
 * spinner, dialogs and the prompt box are redrawn below it.
 *
 * Commands: everything Claude Code's SDK mode knows (skills, plugins, custom
 * commands, /compact, /init, /review...) is sent through as a prompt. The
 * interactive-only built-ins are implemented here: /help /clear /resume
 * /model /effort /status /cost /mcp /agents /key /reload /exit.
 */

import { Box, Static, Text, useInput, useStdout } from 'ink';
import { useEffect, useReducer, useRef } from 'react';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { readTail, lastCostTotal } from '../sessions.js';
import {
  ChoiceDialog, ItemView, PermissionDialog, PlanDialog, PromptInput, QuestionDialog, Spinner, h, theme,
} from './components.js';
import {
  MODES, SPINNER_VERBS, duration, historyItems, modelName, nextMode, summarizeTool, tailItems, toolArgs, toolLabel,
} from './model.js';

const STREAM_REDRAW_MS = 50;
const HISTORY_TURNS = 12;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Built-ins handled by latch itself, listed in the slash menu first. */
export const LOCAL_COMMANDS = [
  { name: 'help', description: 'Show help and keyboard shortcuts' },
  { name: 'clear', description: 'Clear conversation history and start a new session' },
  { name: 'resume', description: 'Resume another conversation' },
  { name: 'model', description: 'Set the model for this session' },
  { name: 'effort', description: 'Set the effort level (low, medium, high, xhigh, max)' },
  { name: 'status', description: 'Show session, model, billing and MCP status' },
  { name: 'cost', description: 'Show the cost of this session' },
  { name: 'mcp', description: 'Show MCP server status' },
  { name: 'agents', description: 'List available subagents' },
  { name: 'key', description: 'Switch billing: an API key from credentials.md, or your subscription' },
  { name: 'reload', description: 'Reload this session from disk' },
  { name: 'exit', description: 'Exit latch' },
];
const LOCAL = new Set([...LOCAL_COMMANDS.map((c) => c.name), 'quit']);

export class ChatStore {
  /**
   * @param {object} o
   * @param {import('../runner.js').SessionRunner} o.runner
   * @param {object} o.info  { cwd, credentialName, keys: [{label, value}], switchKey(value) => {name, env}|{error} }
   * @param {Function} o.onResume  called when /resume is used
   * @param {Function} o.onExit
   */
  constructor({ runner, info, onResume, onExit }) {
    this.runner = runner;
    this.info = info;
    this.onResume = onResume;
    this.onExit = onExit;
    this.listeners = new Set();
    this.seq = 0;
    this.toolsById = new Map();
    this.alwaysAllow = new Set();
    this.redrawTimer = null;
    this.state = {
      committed: [], pending: [], live: '', busy: false, startedAt: 0, outTokens: 0, baseTokens: 0, thinking: false,
      verb: SPINNER_VERBS[0], queue: [], dialog: null, mode: runner.permissionMode || 'default', commands: LOCAL_COMMANDS,
      history: [], runCost: 0, ctrlCAt: 0, staticKey: 0,
    };
    runner.onMessage = (msg) => this.onMessage(msg);
    runner.canUseTool = (name, input, opts) => this.canUseTool(name, input, opts);
    runner.onInteractiveTool = (name, input) => this.interactive(name, input);
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  set(patch, { now = true } = {}) {
    Object.assign(this.state, patch);
    if (now) { clearTimeout(this.redrawTimer); this.redrawTimer = null; this.emit(); return; }
    if (!this.redrawTimer) this.redrawTimer = setTimeout(() => { this.redrawTimer = null; this.emit(); }, STREAM_REDRAW_MS);
  }

  emit() { for (const fn of this.listeners) fn(); }

  key() { this.seq += 1; return `i${this.seq}`; }

  commit(items) {
    this.set({ committed: [...this.state.committed, ...items.map((it) => ({ ...it, key: it.key || this.key() }))] });
  }

  note(text, tone = 'dim', extra = {}) { this.commit([{ kind: 'note', text, tone, ...extra }]); }

  /** Moves finished items from the head of `pending` into the static transcript. */
  flush() {
    const { pending } = this.state;
    let n = 0;
    while (n < pending.length && !(pending[n].kind === 'tool' && pending[n].status === 'running')) n++;
    if (!n) { this.set({ pending: [...pending] }); return; }
    this.set({ pending: pending.slice(n), committed: [...this.state.committed, ...pending.slice(0, n).map((it) => ({ ...it, key: it.key || this.key() }))] });
  }

  /* ---------- session start ---------- */

  /** Banner plus the tail of the saved conversation. */
  async loadHistory() {
    const r = this.runner;
    const rows = [
      ['cwd', r.cwd],
      ['session', r.sessionId || 'new'],
      ['model', `${modelName(r.model)}${r.effort ? ` · ${r.effort} effort` : ''}`],
      ['billing', this.info.credentialName],
    ];
    const items = [{ kind: 'banner', title: 'latch', rows }];
    const prompts = [];
    if (r.sessionId) {
      try {
        const all = historyItems(await getSessionMessages(r.sessionId), r.cwd);
        for (const it of all) if (it.kind === 'user') prompts.push(it.text);
        const { items: tail, hidden } = tailItems(all, HISTORY_TURNS);
        if (hidden) items.push({ kind: 'divider', text: `${hidden} earlier messages · full history in the session file` });
        items.push(...tail);
        if (tail.length) items.push({ kind: 'divider', text: 'resumed here' });
      } catch (e) {
        items.push({ kind: 'note', text: `Could not load the conversation history: ${e.message}`, tone: 'warn' });
      }
    }
    this.set({ history: prompts.slice(-200) });
    this.commit(items);
  }

  /** Slash menu: latch built-ins, then everything Claude Code reports. */
  async loadCommands() {
    try {
      const sdk = await this.runner.supportedCommands();
      const seen = new Set(LOCAL_COMMANDS.map((c) => c.name));
      const rest = sdk.filter((c) => !seen.has(c.name)).map((c) => ({ name: c.name, description: (c.description || '').replace(/\s+/g, ' '), argumentHint: c.argumentHint }));
      this.set({ commands: [...LOCAL_COMMANDS, ...rest] });
    } catch { /* keep the local list */ }
  }

  /* ---------- SDK messages ---------- */

  onMessage(msg) {
    if (msg.parent_tool_use_id) { this.onSubagent(msg); return; }
    switch (msg.type) {
      case 'stream_event': this.onStream(msg.event); break;
      case 'assistant': this.onAssistant(msg); break;
      case 'user': this.onToolResults(msg); break;
      case 'result': this.onResult(msg); break;
      case 'system':
        if (msg.subtype === 'compact_boundary') this.note('✻ Conversation compacted · ctrl+r for history is not available in latch; the full history stays in the session file');
        if (msg.subtype === 'init' && this.runner.lastSend?.reloaded) {
          this.runner.lastSend.reloaded = false;
          this.note('↻ This session changed outside latch, so it was reloaded from disk before sending.', 'warn');
        }
        break;
      case 'latch_error': this.note(`Error: ${msg.error?.message || msg.error}`, 'error'); break;
      default: break;
    }
  }

  onStream(ev) {
    if (!ev) return;
    if (ev.type === 'message_start') this.set({ baseTokens: this.state.outTokens }, { now: false });
    else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') this.set({ thinking: true }, { now: false });
    else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') this.set({ live: '', thinking: false }, { now: false });
    else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.set({ live: this.state.live + ev.delta.text }, { now: false });
    else if (ev.type === 'message_delta' && ev.usage?.output_tokens) this.set({ outTokens: this.state.baseTokens + ev.usage.output_tokens }, { now: false });
  }

  onAssistant(msg) {
    const pending = [...this.state.pending];
    for (const b of msg.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) pending.push({ kind: 'assistant', text: b.text });
      else if (b.type === 'tool_use') {
        const t = { kind: 'tool', key: this.key(), id: b.id, name: b.name, input: b.input, args: toolArgs(b.name, b.input, this.runner.cwd), status: 'running', lines: [] };
        this.toolsById.set(b.id, t);
        pending.push(t);
      }
    }
    if (msg.error) pending.push({ kind: 'note', text: `API error: ${msg.error}`, tone: 'error' });
    this.state.pending = pending;
    this.set({ live: '', thinking: false }, { now: false });
    this.flush();
  }

  onToolResults(msg) {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    let changed = false;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const t = this.toolsById.get(b.tool_use_id);
      if (!t) continue;
      Object.assign(t, { status: b.is_error ? 'error' : 'ok', ...summarizeTool(t.name, t.input, b.content, b.is_error, this.runner.cwd) });
      if (t.name === 'ExitPlanMode' && !b.is_error) this.set({ mode: this.runner.permissionMode || 'default' });
      changed = true;
    }
    if (changed) this.flush();
  }

  /** Subagent activity shows under its Task line, as Claude Code does. */
  onSubagent(msg) {
    const parent = this.toolsById.get(msg.parent_tool_use_id);
    if (!parent || msg.type !== 'assistant') return;
    for (const b of msg.message?.content || []) {
      if (b.type !== 'tool_use') continue;
      parent.subCount = (parent.subCount || 0) + 1;
      parent.progress = `${toolLabel(b.name)}(${toolArgs(b.name, b.input, this.runner.cwd)})`;
    }
    this.set({ pending: [...this.state.pending] }, { now: false });
  }

  onResult(msg) {
    // Anything still marked running (an interrupted tool) is closed out.
    for (const t of this.state.pending) if (t.kind === 'tool' && t.status === 'running') Object.assign(t, { status: 'error', lines: ['Interrupted'] });
    if (this.state.live.trim()) this.state.pending.push({ kind: 'assistant', text: this.state.live });
    this.state.live = '';
    this.flush();
    const cost = typeof msg.latchTurnCost === 'number' ? msg.latchTurnCost : null;
    if (cost !== null) this.state.runCost += cost;
    if (msg.subtype === 'error_during_execution' && this.interrupted) {
      this.note('  ⎿  Interrupted · What should Claude do instead?', 'error', { tight: true });
    } else if (msg.subtype !== 'success' || msg.is_error) {
      const why = msg.subtype === 'success' ? (msg.result || 'error') : msg.subtype.replace(/_/g, ' ');
      const detail = Array.isArray(msg.errors) && msg.errors.length ? `: ${msg.errors.join('; ')}` : '';
      this.note(`${why}${detail}`, 'error');
    }
    this.interrupted = false;
    const parts = [`✻ Worked for ${duration(msg.duration_ms || Date.now() - this.state.startedAt)}`];
    if (cost !== null) parts.push(`$${cost.toFixed(3)}`);
    parts.push(this.info.credentialName);
    this.note(parts.join(' · '));
  }

  /* ---------- permissions and questions ---------- */

  /** Questions and plan approval, asked from the runner's PreToolUse hook (every mode). */
  interactive(toolName, input) {
    if (toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode') return Promise.resolve(null);
    return this.showDialog(toolName, input, {});
  }

  /** SDK permission callback (only consulted outside bypassPermissions mode). */
  canUseTool(toolName, input, opts = {}) {
    // Already answered by the PreToolUse hook; input carries the answers.
    if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return Promise.resolve({ behavior: 'allow', updatedInput: input });
    if (this.alwaysAllow.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return this.showDialog(toolName, input, opts);
  }

  showDialog(toolName, input, { signal } = {}) {
    return new Promise((resolve) => {
      const done = (result) => {
        if (result.always) this.alwaysAllow.add(toolName);
        const { always, ...rest } = result;
        this.set({ dialog: null });
        resolve(rest);
      };
      signal?.addEventListener?.('abort', () => done({ behavior: 'deny', message: 'Cancelled.' }), { once: true });
      if (toolName === 'AskUserQuestion') { this.set({ dialog: { type: 'question', input, resolve: done } }); return; }
      if (toolName === 'ExitPlanMode') {
        this.set({ dialog: { type: 'plan', input, resolve: done, setMode: (m) => this.setMode(m) } });
        return;
      }
      const detail = toolName === 'Bash' || toolName === 'PowerShell'
        ? `${input.command || ''}${input.description ? `\n${input.description}` : ''}`
        : `${toolLabel(toolName)}(${toolArgs(toolName, input, this.runner.cwd)})`;
      this.set({ dialog: { type: 'permission', toolName, input, detail, resolve: done } });
    });
  }

  choose(title, options, { subtitle, initial } = {}) {
    return new Promise((resolve) => {
      this.set({ dialog: { type: 'choice', title, subtitle, options, initial, resolve: (o) => { this.set({ dialog: null }); resolve(o); } } });
    });
  }

  async setMode(mode) {
    this.set({ mode });
    try { await this.runner.setPermissionMode(mode); } catch (e) { this.note(`Could not change mode: ${e.message}`, 'error'); }
  }

  cycleMode() { this.setMode(nextMode(this.state.mode)); }

  /* ---------- input ---------- */

  submit(text) {
    this.set({ history: [...this.state.history, text].slice(-200) });
    if (this.state.busy) { this.set({ queue: [...this.state.queue, text] }); return; }
    this.dispatch(text);
  }

  async dispatch(text) {
    const trimmed = text.trim();
    const m = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (m && LOCAL.has(m[1].toLowerCase())) {
      this.commit([{ kind: 'user', text: trimmed }]);
      await this.local(m[1].toLowerCase(), m[2].trim());
      this.next();
      return;
    }
    await this.turn(text);
  }

  async turn(text) {
    this.commit([{ kind: 'user', text }]);
    this.toolsById.clear();
    this.set({ busy: true, startedAt: Date.now(), outTokens: 0, baseTokens: 0, live: '', thinking: false, verb: SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] });
    try {
      await this.runner.send(text);
    } catch (e) {
      this.note(e.message, 'error');
    } finally {
      this.set({ busy: false });
    }
    this.next();
  }

  next() {
    const [head, ...rest] = this.state.queue;
    if (head === undefined) return;
    this.set({ queue: rest });
    this.dispatch(head);
  }

  interrupt() {
    if (!this.state.busy) return;
    this.interrupted = true;
    this.runner.interrupt();
  }

  ctrlC() {
    if (this.state.busy) { this.interrupt(); return; }
    const now = Date.now();
    if (now - this.state.ctrlCAt < 1500) { this.onExit(); return; }
    this.set({ ctrlCAt: now });
    setTimeout(() => this.set({}), 1600);
  }

  /* ---------- built-in commands ---------- */

  async local(cmd, arg) {
    const r = this.runner;
    switch (cmd) {
      case 'help': {
        this.note([
          'latch: Claude Code on Platform credits, through the Agent SDK.',
          '',
          'Shortcuts: enter send · \\ or alt+enter newline · ↑↓ history · shift+tab cycle mode · esc interrupt · ctrl+c clear / exit',
          `Commands: ${this.state.commands.length} (type / to browse). Skills, plugins, custom commands, /compact and /init run in Claude Code;`,
          '/clear /resume /model /effort /status /cost /mcp /agents /key /reload /exit are handled by latch.',
        ].join('\n'));
        return;
      }
      case 'exit': case 'quit': this.onExit(); return;
      case 'clear': {
        await r.restart({ sessionId: null, _file: null });
        this.toolsById.clear();
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        this.set({ committed: [], pending: [], staticKey: this.state.staticKey + 1 });
        await this.loadHistory();
        return;
      }
      case 'resume': this.onResume(arg); return;
      case 'model': {
        let choice = arg;
        if (!choice) {
          let models = [];
          try { models = await r.supportedModels(); } catch { /* fall back */ }
          const options = [
            { label: 'Opus 5.5', description: 'claude-opus-5-5', value: 'claude-opus-5-5' },
            { label: 'Sonnet 5.5', description: 'claude-sonnet-5-5', value: 'claude-sonnet-5-5' },
            { label: 'Haiku 5.5', description: 'claude-haiku-5-5', value: 'claude-haiku-5-5' },
            ...models.filter((m) => !['default', 'opus', 'sonnet', 'haiku'].includes(m.value)).map((m) => ({ label: m.displayName, description: m.value, value: m.value })),
          ];
          const picked = await this.choose('Select model', options, { subtitle: `Current: ${modelName(r.model)}`, initial: Math.max(0, options.findIndex((o) => o.value === r.model)) });
          if (!picked) { this.note('  ⎿  Kept model as ' + modelName(r.model), 'dim', { tight: true }); return; }
          choice = picked.value;
        }
        await r.setModel(choice);
        this.note(`  ⎿  Set model to ${modelName(choice)}`, 'dim', { tight: true });
        return;
      }
      case 'effort': {
        let level = arg.toLowerCase();
        if (!level) {
          const picked = await this.choose('Effort level', EFFORTS.map((e) => ({ label: e, value: e })), { subtitle: `Current: ${r.effort || 'default'}`, initial: Math.max(0, EFFORTS.indexOf(r.effort)) });
          if (!picked) return;
          level = picked.value;
        }
        if (!EFFORTS.includes(level)) { this.note(`  ⎿  Unknown effort "${level}". Use ${EFFORTS.join(', ')}.`, 'error', { tight: true }); return; }
        await r.restart({ effort: level });
        this.note(`  ⎿  Set effort level to ${level}`, 'dim', { tight: true });
        return;
      }
      case 'key': {
        let value = arg;
        if (!value) {
          const picked = await this.choose('Billing', this.info.keys, { subtitle: `Current: ${this.info.credentialName}` });
          if (!picked) return;
          value = picked.value;
        }
        const next = this.info.switchKey(value);
        if (next.error) { this.note(next.error, 'error'); return; }
        this.info.credentialName = next.name;
        await r.restart({ env: next.env });
        this.note(`  ⎿  Billing: ${next.name}`, 'dim', { tight: true });
        return;
      }
      case 'reload': await r.restart(); this.note('  ⎿  Reloaded from disk', 'dim', { tight: true }); return;
      case 'cost': {
        const total = r.transcript ? lastCostTotal(readTail(r.transcript)) : 0;
        this.note(`  ⎿  This latch run: $${this.state.runCost.toFixed(3)} · whole session (all runs): $${total.toFixed(2)} · billed to ${this.info.credentialName}`, 'dim', { tight: true });
        return;
      }
      case 'mcp': {
        let servers = [];
        try { servers = await r.mcpServerStatus(); } catch (e) { this.note(e.message, 'error'); return; }
        const lines = servers.map((s) => `  ${s.status === 'connected' ? '✔' : s.status === 'failed' ? '✘' : '…'} ${s.name.padEnd(22)} ${s.status}`);
        this.note(['MCP servers', ...lines, '', '  Servers that need a sign-in are configured with `claude mcp` in a normal Claude Code window.'].join('\n'));
        return;
      }
      case 'agents': {
        let agents = [];
        try { agents = await r.supportedAgents(); } catch (e) { this.note(e.message, 'error'); return; }
        this.note(['Agents', ...agents.map((a) => `  ${a.name.padEnd(28)} ${(a.description || '').replace(/\s+/g, ' ').slice(0, 90)}`)].join('\n'));
        return;
      }
      case 'status': {
        let mcp = [];
        try { mcp = await r.mcpServerStatus(); } catch { /* not started yet */ }
        const connected = mcp.filter((s) => s.status === 'connected').length;
        const mode = MODES.find((x) => x.id === this.state.mode);
        this.note([
          'Status',
          `  Session      ${r.sessionId || '(new, id on first message)'}`,
          `  Folder       ${r.cwd}`,
          `  Model        ${modelName(r.model)}${r.effort ? ` · ${r.effort} effort` : ''}`,
          `  Permissions  ${this.state.mode}${mode && mode.label ? ` (${mode.label})` : ''}`,
          `  Billing      ${this.info.credentialName}`,
          `  MCP          ${connected}/${mcp.length} connected`,
          `  Commands     ${this.state.commands.length}`,
          `  Transcript   ${r.transcript || '(not written yet)'}`,
        ].join('\n'));
        return;
      }
      default: return;
    }
  }
}

/** The chat screen. */
export function Chat({ store }) {
  const [, force] = useReducer((n) => n + 1, 0);
  const { stdout } = useStdout();
  const started = useRef(false);
  useEffect(() => store.subscribe(force), [store]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    store.loadHistory().then(() => store.loadCommands());
  }, [store]);
  useInput((input, key) => {
    if (store.state.dialog) return;
    if (key.escape && store.state.busy) store.interrupt();
  });

  const s = store.state;
  const width = Math.max(40, (stdout?.columns || 100) - 1);
  const mode = MODES.find((m) => m.id === s.mode) || MODES[0];
  const modeColor = s.mode === 'plan' ? theme.plan : s.mode === 'acceptEdits' ? theme.accept : theme.bypass;
  const r = store.runner;
  const right = `${modelName(r.model)}${r.effort ? ` · ${r.effort}` : ''} · ${store.info.credentialName}${s.runCost ? ` · $${s.runCost.toFixed(2)}` : ''}`;

  let dialog = null;
  if (s.dialog?.type === 'permission') dialog = h`<${PermissionDialog} key=${s.dialog.toolName + s.dialog.detail} dialog=${s.dialog} />`;
  else if (s.dialog?.type === 'question') dialog = h`<${QuestionDialog} dialog=${s.dialog} />`;
  else if (s.dialog?.type === 'plan') dialog = h`<${PlanDialog} dialog=${s.dialog} />`;
  else if (s.dialog?.type === 'choice') dialog = h`<${ChoiceDialog} key=${s.dialog.title} dialog=${s.dialog} />`;

  return h`<${Box} flexDirection="column">
    <${Static} key=${s.staticKey} items=${s.committed}>${(item) => h`<${ItemView} key=${item.key} item=${item} />`}</${Static}>
    ${s.pending.map((item) => h`<${ItemView} key=${item.key || item.id} item=${item} />`)}
    ${s.live ? h`<${ItemView} item=${{ kind: 'assistant', text: s.live }} />` : null}
    ${s.busy && !s.dialog ? h`<${Spinner} verb=${s.verb} startedAt=${s.startedAt} outTokens=${s.outTokens} thinking=${s.thinking} />` : null}
    ${s.queue.length ? h`<${Text} color=${theme.dim}>${`  ${s.queue.length} queued message${s.queue.length === 1 ? '' : 's'}: ${s.queue[0].slice(0, 60)}`}</${Text}>` : null}
    ${dialog || h`<${PromptInput}
      commands=${s.commands} history=${s.history} busy=${s.busy} width=${width}
      placeholder=${s.busy ? 'Type to queue a message…' : 'Try "fix the failing test" or / for commands'}
      onSubmit=${(t) => store.submit(t)} onShiftTab=${() => store.cycleMode()}
      onEscape=${() => store.interrupt()} onCtrlC=${() => store.ctrlC()} />`}
    <${Box} paddingX=${2} width=${width}>
      <${Box} flexGrow=${1}>
        ${Date.now() - s.ctrlCAt < 1500
    ? h`<${Text} color=${theme.dim}>Press Ctrl+C again to exit</${Text}>`
    : mode.label
      ? h`<${Text}><${Text} color=${modeColor}>${mode.label}</${Text}><${Text} color=${theme.dim}>${' (shift+tab to cycle)'}</${Text}></${Text}>`
      : h`<${Text} color=${theme.dim}>? /help for shortcuts · shift+tab to cycle modes</${Text}>`}
      </${Box}>
      <${Text} color=${theme.dim}>${right}</${Text}>
    </${Box}>
  </${Box}>`;
}
