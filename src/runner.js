/**
 * runner.js
 *
 * One live Claude Code process (via the Agent SDK) attached to one session.
 *
 * - Streaming input mode: prompts are pushed into an async queue, so the
 *   process, its MCP servers and its hooks stay up between turns, and
 *   interrupt() works.
 * - Resumes the session by id, so turns are appended to the same transcript
 *   Claude Code uses; `claude --resume <id>` picks them up afterwards.
 * - Before each prompt it checks whether anything else appended a real
 *   user/assistant message to the transcript since the last turn (an open
 *   Claude Code window, another `claude -p`). If so it restarts the process,
 *   which resumes from disk, so latch never answers from a stale copy.
 * - Per-turn cost: Claude Code reports a running total that a resumed process
 *   restores from the transcript; the turn's cost is the difference.
 */

import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { findSessionFiles, lastCostTotal, readTail } from './sessions.js';

// How long after a result to wait before recording the transcript size, so
// the process's own trailing writes are not mistaken for an outside change.
const SETTLE_MS = 1500;

/** Minimal async queue used as the SDK's prompt stream. */
class Inbox {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** True when bytes [from, to) of the transcript hold a user or assistant message. */
export function hasMessageBetween(file, from, to) {
  if (to <= from) return false;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      // Parse each line and look at its top-level type: attachments can embed
      // serialized messages, so a text match would misfire.
      return buf.toString('utf8').split('\n').some((line) => {
        if (!line.trim()) return false;
        try {
          const entry = JSON.parse(line);
          return (entry.type === 'user' || entry.type === 'assistant') && Boolean(entry.uuid);
        } catch {
          return false; // a partial line at the start of the range
        }
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export class SessionRunner {
  /**
   * @param {object} o
   * @param {string|null} o.sessionId  session to resume; null starts a new one
   * @param {string} o.cwd             working directory for tools
   * @param {object} o.env             full child environment (see auth.childEnv)
   * @param {string} [o.model] @param {string} [o.effort] @param {string} [o.permissionMode]
   * @param {Function} o.canUseTool    SDK permission callback
   * @param {Function} o.onMessage     receives every SDK message
   * @param {Function} [o.onStderr]    receives the child's stderr
   *
   * Optional extras for hosts like Myrlin Apaki (latch's own UI passes none,
   * so its Claude Code starts exactly as before):
   * @param {object|Function} [o.mcpServers] SDK mcpServers, or a function returning them,
   *                                   called on every start (in-process SDK servers serve one
   *                                   connection, so each process needs fresh ones)
   * @param {string} [o.appendSystemPrompt]  appended to Claude Code's own system prompt
   * @param {object} [o.hooks]         SDK hooks ({ PreToolUse: [{ matcher, hooks }] ... }),
   *                                   merged with the question/plan hook below
   * @param {object} [o.envExtra]      variables added on top of env (kept when env changes)
   */
  constructor(o) {
    Object.assign(this, { model: undefined, effort: undefined, permissionMode: undefined, onStderr: () => {} }, o);
    this.q = null;
    this.pending = [];
    this.knownSize = 0;
    this.settleTimer = null;
  }

  get transcript() {
    if (!this._file && this.sessionId) this._file = findSessionFiles(this.sessionId)[0] || null;
    return this._file;
  }

  get running() {
    return Boolean(this.q);
  }

  start() {
    this.inbox = new Inbox();
    const options = this.buildOptions();
    const file = this.transcript;
    this.lastTotal = file ? lastCostTotal(readTail(file)) : 0;
    this.knownSize = file ? fileSize(file) : 0;
    this.q = query({ prompt: this.inbox, options });
    this.done = this.pump(this.q);
  }

  /** The Agent SDK options for the next start (also called by tests, without starting anything). */
  buildOptions() {
    const options = {
      cwd: this.cwd,
      env: this.envExtra ? { ...this.env, ...this.envExtra } : this.env,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: this.canUseTool,
      stderr: this.onStderr,
    };
    if (this.appendSystemPrompt) options.systemPrompt.append = this.appendSystemPrompt;
    const mcp = typeof this.mcpServers === 'function' ? this.mcpServers() : this.mcpServers;
    if (mcp && Object.keys(mcp).length) options.mcpServers = mcp;
    if (this.hooks) {
      options.hooks = {};
      for (const [event, matchers] of Object.entries(this.hooks)) options.hooks[event] = [...matchers];
    }
    if (this.sessionId) options.resume = this.sessionId;
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    if (this.permissionMode) options.permissionMode = this.permissionMode;
    // Required for bypassPermissions, and lets /mode switch into it later.
    // Hooks (the PreToolUse guards) still run in that mode, and questions and
    // plan approvals still reach canUseTool.
    options.allowDangerouslySkipPermissions = true;
    // File checkpoints go into the session like Claude Code's own, so /rewind
    // back on the subscription can undo edits made in latch.
    options.enableFileCheckpointing = true;
    // In bypassPermissions mode the SDK never consults canUseTool, so the
    // tools that need a person (questions, plan approval) are answered from a
    // PreToolUse hook instead, which runs in every mode (verified 2026-10-09).
    if (this.onInteractiveTool) {
      options.hooks = options.hooks || {};
      options.hooks.PreToolUse = [...(options.hooks.PreToolUse || []), {
        matcher: 'AskUserQuestion|ExitPlanMode',
        hooks: [async (input) => {
          const r = await this.onInteractiveTool(input.tool_name, input.tool_input || {});
          if (!r) return {};
          const allow = r.behavior === 'allow';
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: allow ? 'allow' : 'deny',
              ...(allow ? { updatedInput: r.updatedInput } : { permissionDecisionReason: r.message || 'The user declined.' }),
            },
          };
        }],
      }];
    }
    return options;
  }

  async pump(q) {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          const created = !this.sessionId;
          this.sessionId = msg.session_id;
          if (created) this.onNewSession?.(msg.session_id);
        }
        if (msg.type === 'result') this.finishTurn(msg);
        this.onMessage(msg);
      }
    } catch (error) {
      this.onMessage({ type: 'latch_error', error });
    } finally {
      if (this.q === q) this.q = null;
      for (const turn of this.pending.splice(0)) turn.reject(new Error('Claude Code process ended'));
    }
  }

  finishTurn(msg) {
    const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
    if (total !== null) {
      msg.latchTurnCost = total >= this.lastTotal ? total - this.lastTotal : total;
      this.lastTotal = total;
    }
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.knownSize = fileSize(this.transcript); }, SETTLE_MS);
    const turn = this.pending.shift();
    if (turn) turn.resolve(msg);
  }

  /** True when something other than this process added a message since the last turn. */
  changedOutside() {
    const file = this.transcript;
    if (!file) return false;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
      this.knownSize = fileSize(file);
      return false;
    }
    return hasMessageBetween(file, this.knownSize, fileSize(file));
  }

  /**
   * Sends one prompt and resolves with its result message. Returns
   * { reloaded: true } in `this.lastSend` when it had to reload from disk first.
   */
  async send(text) {
    // Another window took this session over (forced takeover): writing now
    // would fork the conversation, so refuse and say who has it.
    const stolen = this.lockGuard?.();
    if (stolen) {
      const err = new Error(`${stolen.name || 'Another window'} took this session over${stolen.at ? ` at ${new Date(stolen.at).toLocaleTimeString()}` : ''}. Continue there, or take it back.`);
      err.code = 'TAKEN_OVER';
      err.holder = stolen;
      throw err;
    }
    let reloaded = false;
    // Billing that follows Myrlin Glass: if the live login changed since the
    // last message, restart on the new one (resuming from disk) before sending.
    if (this.authCheck) {
      const next = this.authCheck();
      if (next && (next.key || null) !== (this.authKey ?? null)) {
        if (this.running) await this.stop();
        this.env = next.env;
        this.authKey = next.key || null;
        this.onAuthChange?.(next);
      }
    }
    if (this.running && this.changedOutside()) {
      await this.stop();
      reloaded = true;
    }
    if (!this.running) this.start();
    this.lastSend = { reloaded };
    const result = new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });
    return result;
  }

  /** Runs a query control call, starting the process first if needed. */
  async ask(method) {
    if (!this.running) this.start();
    return this.q[method]();
  }

  /** Slash commands Claude Code knows here: built-ins, skills, plugins, custom commands. */
  supportedCommands() { return this.ask('supportedCommands'); }

  supportedModels() { return this.ask('supportedModels'); }

  supportedAgents() { return this.ask('supportedAgents'); }

  mcpServerStatus() { return this.ask('mcpServerStatus'); }

  async interrupt() {
    try { await this.q?.interrupt(); } catch { /* not running */ }
  }

  async setModel(model) {
    this.model = model;
    if (this.q) await this.q.setModel(model);
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    if (this.q) await this.q.setPermissionMode(mode);
  }

  /** Ends the process after any running turn; resolves when it has exited (or after 8s). */
  async stop() {
    if (!this.q) return;
    this.inbox.close();
    await Promise.race([this.done, new Promise((r) => setTimeout(r, 8000))]);
    this.q = null;
  }

  /** Restarts with changed settings (env, effort), resuming the same session. */
  async restart(changes = {}) {
    await this.stop();
    Object.assign(this, changes);
    this.start();
  }
}
