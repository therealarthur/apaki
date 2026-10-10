/**
 * shell-channel.js: requests from the engine to the Apaki shell (the Rust
 * window process that started it), with answers and timeouts.
 *
 * WHY (2026-10-09, the built-in browser): Claude's browser tools run in the
 * engine, but the browser itself is a WebView2 the shell owns. The engine is
 * the shell's child over stdin/stdout, so both directions already exist:
 *
 *   engine -> shell   {ev:'shell', id, cmd, args} on stdout (the shell keeps
 *                     these from the window)
 *   shell -> engine   {op:'shellReply', id, ok, result | error} on stdin
 *   shell -> engine   {op:'shellHello', version, features} once, as the first
 *                     line, so the engine knows what the shell can do (an
 *                     engine run by a test or by latch never gets one, and
 *                     its tools say so instead of waiting).
 *
 * A request that gets no answer in time rejects with code TIMEOUT; one made
 * without a shell rejects with NO_SHELL at once.
 */

export class ShellError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} o
 * @param {(ev: object) => void} o.emit   prints one event line for the shell
 * @param {number} [o.timeoutMs]          default wait for an answer
 */
export function createShell({ emit, timeoutMs = 20000 } = {}) {
  let seq = 0;
  let info = null;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const hellos = [];

  return {
    /** True once the shell said hello. */
    get available() { return Boolean(info); },
    get info() { return info; },
    has(feature) { return Boolean(info?.features?.includes(feature)); },

    /** The shell's first line: { version, features }. */
    hello(msg = {}) {
      info = { version: msg.version ?? 1, features: Array.isArray(msg.features) ? msg.features : [] };
      for (const r of hellos.splice(0)) r(true);
    },

    /** Resolves true when the shell has said hello (at once if it has), false after ms. */
    ready(ms = 1500) {
      if (info) return Promise.resolve(true);
      return new Promise((resolve) => {
        const t = setTimeout(() => { const i = hellos.indexOf(done); if (i >= 0) hellos.splice(i, 1); resolve(false); }, ms);
        const done = (v) => { clearTimeout(t); resolve(v); };
        hellos.push(done);
      });
    },

    /** Sends one request; resolves with the shell's result. */
    request(cmd, args = {}, { timeout = timeoutMs } = {}) {
      if (!info) return Promise.reject(new ShellError('Apaki\'s browser is not available here (this engine is not running inside the Apaki window).', 'NO_SHELL'));
      const id = `s${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new ShellError(`Apaki's window did not answer ${cmd} within ${Math.round(timeout / 1000)} s.`, 'TIMEOUT'));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        emit({ ev: 'shell', id, cmd, args });
      });
    },

    /** An answer from the shell: { id, ok, result | error }. Unknown or late ids are ignored. */
    reply(msg = {}) {
      const p = pending.get(msg.id);
      if (!p) return false;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new ShellError(String(msg.error || 'The shell could not do that.'), 'SHELL'));
      return true;
    },

    /** Requests still waiting (tests). */
    get waiting() { return pending.size; },

    /** Fails everything in flight (the shell went away). */
    closeAll(reason = 'The Apaki window closed.') {
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new ShellError(reason, 'CLOSED')); pending.delete(id); }
    },
  };
}
