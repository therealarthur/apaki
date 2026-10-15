/**
 * worktrees-client.js: the engine's side of the worktree worker (2026-10-15; worktrees-worker.js has the why).
 *
 * WorktreeIndexClient has the API engine.js used on worktrees.js WorktreeIndex, so the engine reads the same:
 *   snapshot(o), recordFor(p), fresh(p), invalidate(p?), changed(p)      promises, answered by the worker
 *   repoOf(p), knownPath(p)                                               synchronous, from the last snapshot the worker returned
 *   meta.set(p, rec), meta.forget(p)                                      Apaki's notes, written by the worker (one owner of the file)
 * plus what used to run on the engine's thread and now runs beside the scans:
 *   diff(p, o)                 worktrees.js diffOf
 *   plan(kind, args, where, ctx) -> { repo, plan }   a fresh record of the repository holding `where`, and the plan
 *   execute(plan), after(plan)                        run a plan's steps; remember what it made (worktrees.js remember)
 *
 * Failures: a call to a worker that stops is rejected (the engine's callers already catch). The next call starts a new
 * worker; after maxRestarts stops the client answers on the engine's own thread (the old way, with worktrees.js
 * itself), and says so once in the log. inline: true starts that way (tests, a Node without worker threads).
 *
 * The worker is unref'd while nothing is asked of it, so it never keeps a process alive on its own.
 */

import { Worker } from 'node:worker_threads';
import { WorktreeIndex, WtMeta, counters, indexMethods, repoOfIn } from './worktrees.js';

const WORKER_FILE = new URL('./worktrees-worker.js', import.meta.url);

export class WorktreeIndexClient {
  /**
   * @param {object} [o]
   * @param {URL|string} [o.workerFile]  the worker script (tests may point at another)
   * @param {object} [o.options]         workerData: { metaFile, ttlMs, coldTtlMs }
   * @param {(line: string) => void} [o.log]
   * @param {number} [o.maxRestarts]     worker stops before the client answers on its own thread
   * @param {boolean} [o.inline]         answer on this thread from the start
   */
  constructor({ workerFile = WORKER_FILE, options = {}, log = () => {}, maxRestarts = 3, inline = false } = {}) {
    this.workerFile = workerFile;
    this.options = options;
    this.log = log;
    this.maxRestarts = maxRestarts;
    /** The records of the last snapshot, for repoOf and knownPath. */
    this.last = [];
    /** Git processes the worker reported starting (the engine's spawns per minute count them). */
    this.workerSpawns = 0;
    this.pending = new Map();
    this.seq = 0;
    this.worker = null;
    this.stops = 0;
    this.closed = false;
    /** The method table on this thread, once the client answers here. */
    this.local = null;
    this.meta = {
      set: (p, rec) => this.call('metaSet', p, rec),
      forget: (p) => this.call('metaForget', p),
    };
    if (inline) this.answerHere('asked to');
  }

  /** Where answers come from now: 'worker' or 'inline'. */
  get mode() { return this.local ? 'inline' : 'worker'; }

  /** Git processes started for this index so far, on either thread. */
  get spawns() { return this.workerSpawns + (this.local ? counters.spawns - this.localBase : 0); }

  /** From now on every call runs on this thread (worktrees.js in-process, as before 2026-10-15). */
  answerHere(why) {
    if (this.local) return;
    const o = this.options || {};
    const index = new WorktreeIndex({
      meta: new WtMeta(...(o.metaFile ? [o.metaFile] : [])),
      ...(Number(o.ttlMs) > 0 ? { ttlMs: Number(o.ttlMs) } : {}),
      ...(Number(o.coldTtlMs) > 0 ? { coldTtlMs: Number(o.coldTtlMs) } : {}),
    });
    this.local = indexMethods(index);
    this.localBase = counters.spawns;
    if (why !== 'asked to') this.log(`worktrees: the worker ${why}; reading worktrees on the engine's own thread from now on`);
  }

  /** The worker, started when needed; null once the client answers on this thread. */
  ensureWorker() {
    if (this.local || this.closed) return null;
    if (this.worker) return this.worker;
    if (this.stops >= this.maxRestarts) { this.answerHere(`stopped ${this.stops} times`); return null; }
    let w;
    try {
      w = new Worker(this.workerFile, { workerData: this.options });
    } catch (e) {
      this.answerHere(`could not start (${e?.message || e})`);
      return null;
    }
    w.unref();
    w.on('message', (m) => this.onMessage(m));
    w.on('error', (e) => this.log(`worktrees worker: ${e?.stack || e?.message || e}`));
    w.on('exit', (code) => this.onExit(w, code));
    this.worker = w;
    return w;
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (Number.isFinite(m.spawns)) this.workerSpawns = m.spawns;
    if (m.id == null) return;
    const call = this.pending.get(m.id);
    if (!call) return;
    this.pending.delete(m.id);
    if (!this.pending.size) this.worker?.unref();
    if (m.ok) call.resolve(m.result);
    else call.reject(new Error(m.error || 'the worktree worker failed'));
  }

  onExit(w, code) {
    if (this.worker !== w) return;
    this.worker = null;
    if (!this.closed) {
      this.stops += 1;
      this.log(`worktrees: the worker stopped (exit ${code}); ${this.pending.size} request(s) failed`);
    }
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) c.reject(new Error('The worktree worker stopped. Try again.'));
  }

  /** Runs one indexMethods method on the worker (or here, see answerHere). */
  call(method, ...args) {
    if (this.closed) return Promise.reject(new Error('The worktree index is closed.'));
    const w = this.ensureWorker();
    if (!w) {
      const fn = this.local?.[method];
      if (!fn) return Promise.reject(new Error(`no such worktree method: ${method}`));
      return Promise.resolve().then(() => fn(...args));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      // Asked for something: the worker keeps the process up until it answers.
      if (this.pending.size === 1) w.ref();
      try {
        w.postMessage({ id, method, args });
      } catch (e) {
        this.pending.delete(id);
        if (!this.pending.size) w.unref();
        reject(e);
      }
    });
  }

  async snapshot(o = {}) {
    const repos = await this.call('snapshot', o);
    this.last = Array.isArray(repos) ? repos : [];
    return this.last;
  }

  recordFor(p) { return this.call('recordFor', p); }
  fresh(p) { return this.call('fresh', p); }
  invalidate(p = null) { return this.call('invalidate', p); }
  changed(p) { return this.call('changed', p); }
  diff(p, o = {}) { return this.call('diff', p, o); }
  plan(kind, args, where, ctx = {}) { return this.call('plan', kind, args, where, ctx); }
  execute(plan) { return this.call('execute', plan); }
  after(plan) { return this.call('after', plan); }

  /** The last snapshot's repository that holds this folder, or null (no round trip: phone checks call it per command). */
  repoOf(p) { return repoOfIn(this.last, p); }
  knownPath(p) { return Boolean(this.repoOf(p)); }

  /** Stops the worker (the engine is exiting). */
  async close() {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) c.reject(new Error('The worktree index is closed.'));
    if (w) await w.terminate().catch(() => {});
  }
}
