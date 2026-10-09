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
    const options = {
      cwd: this.cwd,
      env: this.env,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: this.canUseTool,
      stderr: this.onStderr,
    };
    if (this.sessionId) options.resume = this.sessionId;
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    if (this.permissionMode) options.permissionMode = this.permissionMode;

    const file = this.transcript;
    this.lastTotal = file ? lastCostTotal(readTail(file)) : 0;
    this.knownSize = file ? fileSize(file) : 0;
    this.q = query({ prompt: this.inbox, options });
    this.done = this.pump(this.q);
  }

  async pump(q) {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) this.sessionId = msg.session_id;
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
    let reloaded = false;
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
