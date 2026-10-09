/**
 * tui.js
 *
 * The terminal front end: a readline prompt over a SessionRunner.
 *
 * Output: streamed assistant text (rendered markdown, line by line), one line
 * per tool call and per tool result, a dim footer per turn (time, cache, cost).
 * Subagent traffic is not shown, only the Agent tool call that started it.
 *
 * Input: Enter sends; a line ending in "\" continues on the next line; a paste
 * of several lines arrives as one message. Messages sent while a turn runs are
 * queued. Esc or Ctrl+C interrupts a running turn; Ctrl+C twice or Ctrl+D at
 * an empty prompt exits. Lines starting with "/" are local commands when
 * latch knows them (see HELP), otherwise they go to Claude Code (/compact etc.).
 *
 * Tool approvals arrive through the SDK's canUseTool callback and are asked
 * inline: y / n / a (always for this tool, this run) / any other text denies
 * with that text as the reason. AskUserQuestion and ExitPlanMode get their own
 * prompts.
 */

import readline from 'node:readline';
import { LineRenderer, renderMarkdown, styler, useColor } from './render.js';

const PASTE_WINDOW_MS = 30;
const DOUBLE_CTRL_C_MS = 1500;

const HELP = `Local commands:
  /help                 this list
  /model [name]         show or switch the model (opus, sonnet, haiku or a full id)
  /mode [mode]          show or set the permission mode: default, acceptEdits, plan, bypassPermissions
  /effort [level]       show or set effort: low, medium, high, xhigh, max (restarts the process)
  /key [words|sub]      show or switch billing: vault key by heading words, or "sub" for the live login
  /reload               reload the session from disk (after using it elsewhere)
  /session              session id, transcript and the command to continue in Claude Code
  /exit                 leave (Ctrl+D also works)
Anything else starting with / (for example /compact) is sent to Claude Code.
Esc or Ctrl+C interrupts a running turn.`;

function oneLine(s, max = 110) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short description of a tool call for the transcript line and approval prompt. */
export function describeTool(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? input.prompt ?? input.skill ?? input.subject;
  if (pick !== undefined) return oneLine(pick);
  const json = JSON.stringify(input);
  return oneLine(json === '{}' ? '' : json);
}

export class Tui {
  /**
   * @param {object} o
   * @param {import('./runner.js').SessionRunner} o.runner
   * @param {object} o.info         { title, cwd, credentialName }
   * @param {Function} o.onExit     called once with the runner when latch exits
   * @param {Function} o.switchKey  (words|'sub') => { name, env } or { error }
   */
  constructor({ runner, info, onExit, switchKey }) {
    this.runner = runner;
    this.info = info;
    this.onExit = onExit;
    this.switchKey = switchKey;
    this.st = styler(useColor());
    this.busy = false;
    this.queue = [];
    this.pasteLines = [];
    this.pasteTimer = null;
    this.continued = [];
    this.alwaysAllow = new Set();
    this.streamed = new Set();
    this.renderer = null;
    this.thinkingShown = null;
    this.lastCtrlC = 0;
    this.exiting = false;
    this.turnCost = 0;
    this.runCost = 0;
  }

  write(s) {
    process.stdout.write(s);
  }

  note(s) {
    this.write(`${this.st.dim(s)}\n`);
  }

  /* ---------- lifecycle ---------- */

  start() {
    const tty = Boolean(process.stdin.isTTY);
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, historySize: 500 });
    this.setPrompt();
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('SIGINT', () => this.onCtrlC());
    // Piped input ends before its turns run: finish them, then exit.
    this.rl.on('close', () => {
      if (this.busy || this.queue.length) this.closeWhenIdle = true;
      else this.exit();
    });
    if (tty) {
      process.stdin.on('keypress', (_s, key) => {
        if (key && key.name === 'escape' && this.busy) this.interrupt();
      });
    }
    this.rl.prompt();
  }

  setPrompt() {
    this.rl.setPrompt(this.continued.length ? this.st.dim('… ') : this.st.bold('› '));
  }

  async exit() {
    if (this.exiting) return;
    this.exiting = true;
    this.write('\n');
    await this.onExit(this.runner);
    process.exit(0);
  }

  /* ---------- input ---------- */

  onLine(line) {
    if (this.exiting) return;
    if (!process.stdin.isTTY) { this.submit(line); return; }
    // Lines that arrive within a few ms of each other are one paste.
    this.pasteLines.push(line);
    clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      const text = this.pasteLines.join('\n');
      this.pasteLines = [];
      this.submit(text);
    }, PASTE_WINDOW_MS);
  }

  submit(text) {
    if (/\\$/.test(text) && !text.includes('\n')) {
      this.continued.push(text.slice(0, -1));
      this.setPrompt();
      this.rl.prompt();
      return;
    }
    const full = [...this.continued, text].join('\n');
    this.continued = [];
    this.setPrompt();
    if (!full.trim()) { if (!this.busy) this.rl.prompt(); return; }
    // A terminal echoes what was typed; scripted input is echoed here instead.
    if (!process.stdin.isTTY && !this.busy) this.write(`${full}\n`);
    if (this.busy) {
      this.queue.push(full);
      if (process.stdin.isTTY) this.note('  (queued, sends after this turn)');
      return;
    }
    this.dispatch(full);
  }

  async dispatch(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('/') && (await this.localCommand(trimmed))) {
      await this.afterTurn();
      return;
    }
    await this.turn(text);
  }

  /** Sends the next queued message, exits after piped input, or shows the prompt. */
  async afterTurn() {
    if (this.exiting) return;
    const next = this.queue.shift();
    if (next !== undefined) { this.write(`${this.st.bold('› ')}${next}\n`); await this.dispatch(next); return; }
    if (this.closeWhenIdle) { await this.exit(); return; }
    this.rl.prompt();
  }

  onCtrlC() {
    if (this.busy) { this.interrupt(); return; }
    if (this.rl.line) { this.rl.write(null, { ctrl: true, name: 'u' }); return; }
    const now = Date.now();
    if (now - this.lastCtrlC < DOUBLE_CTRL_C_MS) { this.exit(); return; }
    this.lastCtrlC = now;
    this.write('\n');
    this.note('(Ctrl+C again to exit)');
    this.rl.prompt();
  }

  interrupt() {
    this.note('\n  interrupting…');
    this.runner.interrupt();
  }

  ask(question, signal) {
    // Scripted input: the answer is the next queued line.
    if (!process.stdin.isTTY) {
      const answer = this.queue.shift() ?? null;
      this.write(`${question}${answer ?? ''}\n`);
      return Promise.resolve(answer);
    }
    return new Promise((resolve) => {
      const onAbort = () => resolve(null);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.rl.question(question, (answer) => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve(answer);
      });
    });
  }

  /* ---------- turns ---------- */

  async turn(text) {
    this.busy = true;
    this.streamed.clear();
    try {
      await this.runner.send(text);
    } catch (e) {
      this.write(`${this.st.red(`  ${e.message}`)}\n`);
    } finally {
      this.endStream();
      this.busy = false;
    }
    await this.afterTurn();
  }

  /* ---------- SDK messages ---------- */

  onMessage(msg) {
    if (msg.parent_tool_use_id) return; // subagent traffic
    switch (msg.type) {
      case 'stream_event': this.onStream(msg.event); break;
      case 'assistant': this.onAssistant(msg); break;
      case 'user': this.onToolResults(msg); break;
      case 'result': this.onResult(msg); break;
      case 'system': this.onSystem(msg); break;
      case 'latch_error': this.endStream(); this.write(`${this.st.red(`  ${msg.error?.message || msg.error}`)}\n`); break;
      default: break;
    }
  }

  onStream(ev) {
    if (!ev) return;
    if (ev.type === 'message_start' && ev.message?.id) {
      this.streamed.add(ev.message.id);
    } else if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'text') {
        this.endStream();
        this.renderer = new LineRenderer((s) => this.write(s), { color: useColor() });
      } else if (ev.content_block?.type === 'thinking' && !this.thinkingShown) {
        this.thinkingShown = true;
        this.note('  ✻ thinking');
      }
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      this.renderer?.push(ev.delta.text);
    } else if (ev.type === 'content_block_stop') {
      this.endStream();
    }
  }

  endStream() {
    if (this.renderer) {
      this.renderer.end();
      this.renderer = null;
    }
  }

  onAssistant(msg) {
    const content = msg.message?.content || [];
    const streamed = this.streamed.has(msg.message?.id);
    for (const block of content) {
      if (block.type === 'text' && !streamed && block.text?.trim()) {
        this.write(renderMarkdown(block.text, { color: useColor() }));
      } else if (block.type === 'tool_use') {
        this.endStream();
        const detail = describeTool(block.name, block.input);
        this.lastToolLine = `${block.name}|${detail}`;
        this.write(`${this.st.magenta('●')} ${this.st.bold(block.name)}${detail ? `  ${this.st.dim(detail)}` : ''}\n`);
      }
    }
    if (msg.error) this.write(`${this.st.red(`  ${msg.error}`)}\n`);
  }

  onToolResults(msg) {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const text = Array.isArray(block.content)
        ? block.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : String(block.content ?? '');
      const lines = text.split('\n').filter((l) => l.trim());
      const summary = lines.length > 1 ? `${oneLine(lines[0], 90)}  (+${lines.length - 1} lines)` : oneLine(lines[0] || '(no output)', 100);
      this.write(`  ${this.st.dim('⎿')}  ${block.is_error ? this.st.red(summary) : this.st.dim(summary)}\n`);
    }
  }

  onResult(msg) {
    this.endStream();
    this.thinkingShown = null;
    const u = msg.usage || {};
    const k = (n) => `${((n || 0) / 1000).toFixed(1)}k`;
    const cost = typeof msg.latchTurnCost === 'number' ? msg.latchTurnCost : null;
    if (cost !== null) this.runCost += cost;
    const parts = [
      `${((msg.duration_ms || 0) / 1000).toFixed(1)}s`,
      `${k(u.cache_read_input_tokens)} cached`,
      `${k(u.cache_creation_input_tokens)} new`,
      cost !== null ? `$${cost.toFixed(3)}` : null,
    ].filter(Boolean);
    if (msg.subtype !== 'success' || msg.is_error) {
      const why = msg.subtype === 'success' ? (msg.result || 'error') : msg.subtype.replace(/_/g, ' ');
      const detail = Array.isArray(msg.errors) && msg.errors.length ? `: ${oneLine(msg.errors.join('; '), 200)}` : '';
      this.write(`${this.st.yellow(`  ${why}${detail}`)}\n`);
    }
    this.note(`  ${parts.join(' · ')}`);
  }

  onSystem(msg) {
    if (msg.subtype === 'compact_boundary') this.note('  conversation compacted');
    if (msg.subtype === 'init' && this.runner.lastSend?.reloaded) {
      this.runner.lastSend.reloaded = false;
      this.note('  ↻ this session changed outside latch, so it was reloaded from disk before sending');
    }
  }

  /* ---------- permissions ---------- */

  /** SDK canUseTool callback. */
  async canUseTool(toolName, input, { signal } = {}) {
    if (this.alwaysAllow.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (toolName === 'AskUserQuestion') return this.askUserQuestion(input, signal);
    if (toolName === 'ExitPlanMode') return this.approvePlan(input, signal);
    this.endStream();
    const detail = toolName === 'Bash' ? String(input.command || '') : describeTool(toolName, input);
    // The tool line above already shows this call unless it was shortened.
    if (this.lastToolLine !== `${toolName}|${detail}`) this.write(`${this.st.yellow('?')} ${this.st.bold(toolName)}  ${detail}\n`);
    const answer = await this.ask(this.st.yellow('  allow? [y]es / [n]o / [a]lways this tool / or type why not: '), signal);
    const a = (answer ?? 'n').trim();
    if (/^(y|yes)?$/i.test(a)) return { behavior: 'allow', updatedInput: input };
    if (/^(a|always)$/i.test(a)) { this.alwaysAllow.add(toolName); return { behavior: 'allow', updatedInput: input }; }
    return { behavior: 'deny', message: /^(n|no)$/i.test(a) ? 'The user declined this tool call.' : a };
  }

  async askUserQuestion(input, signal) {
    this.endStream();
    const answers = {};
    for (const q of input.questions || []) {
      this.write(`${this.st.yellow('?')} ${this.st.bold(q.question)}\n`);
      (q.options || []).forEach((o, i) => this.write(`  ${i + 1}. ${o.label}${o.description ? this.st.dim(`  ${o.description}`) : ''}\n`));
      const hint = q.multiSelect ? 'numbers separated by commas, or your own answer' : 'a number, or your own answer';
      const raw = ((await this.ask(this.st.yellow(`  answer (${hint}): `), signal)) ?? '').trim();
      const picks = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= (q.options || []).length);
      answers[q.question] = picks.length && /^[\d,\s]+$/.test(raw) ? picks.map((n) => q.options[n - 1].label).join(', ') : raw;
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  async approvePlan(input, signal) {
    this.endStream();
    if (input.plan) this.write(renderMarkdown(String(input.plan), { color: useColor() }));
    const a = ((await this.ask(this.st.yellow('  approve this plan? [y]es / or type what to change: '), signal)) ?? '').trim();
    if (/^(y|yes)?$/i.test(a)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: a || 'The user did not approve the plan.' };
  }

  /* ---------- local commands ---------- */

  /** Runs a latch command. Returns false when the text should go to Claude Code instead. */
  async localCommand(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    const r = this.runner;
    switch (cmd.toLowerCase()) {
      case '/help': this.write(`${HELP}\n`); return true;
      case '/exit': case '/quit': await this.exit(); return true;
      case '/model':
        if (arg) { await r.setModel(arg); this.note(`  model: ${arg}`); } else this.note(`  model: ${r.model || 'default'}`);
        return true;
      case '/mode':
        if (arg) { await r.setPermissionMode(arg); this.note(`  permission mode: ${arg}`); } else this.note(`  permission mode: ${r.permissionMode || 'from settings'}`);
        return true;
      case '/effort':
        if (arg) { await r.restart({ effort: arg }); this.note(`  effort: ${arg}`); } else this.note(`  effort: ${r.effort || 'default'}`);
        return true;
      case '/key': {
        if (!arg) { this.note(`  billing: ${this.info.credentialName}`); return true; }
        const next = this.switchKey(arg);
        if (next.error) { this.write(`${this.st.red(`  ${next.error}`)}\n`); return true; }
        this.info.credentialName = next.name;
        await r.restart({ env: next.env });
        this.note(`  billing: ${next.name}`);
        return true;
      }
      case '/reload': await r.restart(); this.note('  reloaded from disk'); return true;
      case '/session':
        this.note(`  session    ${r.sessionId || '(new, id assigned on first message)'}`);
        this.note(`  transcript ${r.transcript || '(not written yet)'}`);
        this.note(`  continue   claude --resume ${r.sessionId || '<id>'}`);
        this.note(`  spent      $${this.runCost.toFixed(3)} this run on ${this.info.credentialName}`);
        return true;
      default: return false;
    }
  }
}
