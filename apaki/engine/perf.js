/**
 * perf.js: how responsive the engine's main thread is, and how many processes it starts (2026-10-15).
 *
 * WHY: Arthur's PC, 4 of 8 panes working: the engine at 93% of a core, its event loop almost never idle, so pane output
 * and window requests waited. Nothing in the engine said so; it took a CPU profile to see it was process creation. This
 * keeps the two numbers that tell, all the time and cheaply:
 *   - the event loop delay (perf_hooks monitorEventLoopDelay): p50, p99 and max in milliseconds, per minute;
 *   - spawns per minute: processes started on the engine's thread (the child_process diagnostics channel: Claude Code,
 *     Glass, git when the worktree worker is off) and git processes the worktree worker started (worktrees-client.js).
 * `host-ctl status` shows them (engine.js hostControl, field `perf`), and a minute whose p99 is over 200 ms leaves one
 * line in the engine log.
 *
 *   const perf = createPerfMonitor({ log, workerSpawns: () => wtIndex.spawns })
 *   perf.status()  -> { windowMs, lastMinute: { from, to, loopDelayMs: { p50, p99, max, mean }, spawns: { main, worker, total } } | null,
 *                      current: the same for the minute so far (spawns as a per-minute rate) }
 *   perf.stop()
 */

import diagnostics from 'node:diagnostics_channel';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** p99 above this (milliseconds) over a minute is written to the log. */
export const SLOW_P99_MS = 200;
export const WINDOW_MS = 60 * 1000;

const msOf = (ns) => Math.round((Number(ns) / 1e6) * 10) / 10;

/**
 * The delay figures of one histogram, in milliseconds (null fields when it has no samples yet).
 * @param {import('node:perf_hooks').IntervalHistogram} h
 */
export function delayOf(h) {
  if (!h || !h.count) return { p50: null, p99: null, max: null, mean: null, samples: 0 };
  return { p50: msOf(h.percentile(50)), p99: msOf(h.percentile(99)), max: msOf(h.max), mean: msOf(h.mean), samples: h.count };
}

/** The log line for a slow minute, or null when it was not slow. */
export function slowLine(win, threshold = SLOW_P99_MS) {
  const d = win?.loopDelayMs;
  if (!d || d.p99 == null || d.p99 <= threshold) return null;
  const s = win.spawns || {};
  return `apaki perf: the engine's event loop was slow over the last minute: delay p50 ${d.p50} ms, p99 ${d.p99} ms, max ${d.max} ms; spawns ${s.main ?? 0} on the main thread, ${s.worker ?? 0} git in the worktree worker`;
}

/**
 * @param {object} [o]
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.workerSpawns]   the worktree worker's git processes so far (a running count)
 * @param {number} [o.windowMs]
 * @param {number} [o.resolutionMs]         monitorEventLoopDelay's sampling, in milliseconds
 * @param {number} [o.threshold]            p99 in milliseconds above which a minute is logged
 * @param {() => number} [o.now]
 * @param {boolean} [o.timer]               false: no interval (tests call rotate() themselves)
 */
export function createPerfMonitor({ log = () => {}, workerSpawns = () => 0, windowMs = WINDOW_MS, resolutionMs = 20, threshold = SLOW_P99_MS, now = Date.now, timer = true } = {}) {
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  let mainSpawns = 0;
  const onSpawn = () => { mainSpawns += 1; };
  diagnostics.subscribe('child_process', onSpawn);
  let from = now();
  let mainAt = mainSpawns;
  let workerAt = Number(workerSpawns()) || 0;
  let last = null;

  /** The figures since `from`; rate: spawns scaled to a minute (for a window still running). */
  const view = (to, rate) => {
    const span = Math.max(1, to - from);
    const scale = rate ? 60000 / span : 1;
    const main = mainSpawns - mainAt;
    const worker = Math.max(0, (Number(workerSpawns()) || 0) - workerAt);
    const r = (n) => Math.round(n * scale * 10) / 10;
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), loopDelayMs: delayOf(h), spawns: { main: r(main), worker: r(worker), total: r(main + worker) } };
  };

  /** Closes the minute: keeps its figures, logs it when slow, starts the next. */
  function rotate() {
    const to = now();
    last = view(to, false);
    const line = slowLine(last, threshold);
    if (line) { try { log(line); } catch { /* a log that failed */ } }
    h.reset();
    from = to;
    mainAt = mainSpawns;
    workerAt = Number(workerSpawns()) || 0;
    return last;
  }

  const t = timer ? setInterval(rotate, windowMs) : null;
  t?.unref?.();

  return {
    rotate,
    status() {
      return { windowMs, thresholdMs: threshold, lastMinute: last, current: view(now(), true) };
    },
    stop() {
      if (t) clearInterval(t);
      h.disable();
      diagnostics.unsubscribe('child_process', onSpawn);
    },
  };
}
