/**
 * worktrees-worker.js: the engine's git worktree index, on a thread of its own (2026-10-15).
 *
 * WHY: measured on Arthur's PC with 4 of 8 panes working, the engine (engine.js, the background host) sat at 93% of a
 * core and a 10 s profile spent 84% of all its time in native spawn: Windows creates a process on the thread that asks
 * for it, and the worktree refresh started about 80 git processes in 2 seconds, after every turn and every 30 s. Pane
 * output and window requests waited behind them. Here the same work (worktrees.js WorktreeIndex: findRepo, the list,
 * status, the numbers, untracked line counts, the diff, plans and actions) runs on this worker, so process creation and
 * file reads hold up this thread instead of the engine's.
 *
 * Protocol (worktrees-client.js is the other side):
 *   in   { id, method, args }   a method of worktrees.js indexMethods
 *   out  { id, ok: true, result, spawns } | { id, ok: false, error, spawns }
 *   out  { spawns }             the git processes started so far, at most once a second while it moves
 * workerData: { metaFile?, ttlMs?, coldTtlMs? }.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { WorktreeIndex, WtMeta, counters, indexMethods } from './worktrees.js';

// Whatever this thread prints goes to the engine's log (stderr), never to stdout: there stdout is the event channel.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const opts = workerData || {};
const index = new WorktreeIndex({
  meta: new WtMeta(...(opts.metaFile ? [opts.metaFile] : [])),
  ...(Number(opts.ttlMs) > 0 ? { ttlMs: Number(opts.ttlMs) } : {}),
  ...(Number(opts.coldTtlMs) > 0 ? { coldTtlMs: Number(opts.coldTtlMs) } : {}),
});
const methods = indexMethods(index);

parentPort.on('message', async (m) => {
  const id = m?.id;
  const fn = methods[m?.method];
  try {
    if (!fn) throw new Error(`no such worktree method: ${String(m?.method).slice(0, 40)}`);
    const result = await fn(...(Array.isArray(m.args) ? m.args : []));
    parentPort.postMessage({ id, ok: true, result, spawns: counters.spawns });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message || e), spawns: counters.spawns });
  }
});

// The engine's spawns per minute (host-ctl status) include these: sent when they move, at most once a second.
let told = counters.spawns;
setInterval(() => {
  if (counters.spawns === told) return;
  told = counters.spawns;
  parentPort.postMessage({ spawns: told });
}, 1000).unref();
