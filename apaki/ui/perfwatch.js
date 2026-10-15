/**
 * perfwatch.js: what the window's main thread did, a minute at a time (2026-10-15, window lag).
 *
 * Arthur: "our apaki app gets kind of laggy with multiple tabs and panes running at the same time - it doesnt stay
 * sharp - why?" The window already logs a stall of over a second (app.js, apaki-window.log). That missed the lag he
 * felt: a main thread busy most of the time in pieces too short to be a stall each, so a key press waited a little
 * behind every one of them. This keeps three cheap counts, and once a minute app.js logs one line when the thread was
 * busy for more than BUSY_LOG_PCT of it:
 *
 *   busy       the share of the minute the thread was held by work long enough to delay a key press visibly: 4 times
 *              a second, at a random moment, a timer is due; it runs late when a task holds the thread, so the share
 *              of timers more than LATE_MS late is the share of time spent in such work, whatever it was: script,
 *              style, layout, paint. Windows wakes timers on a 15.6 ms tick, so a free thread runs one up to about 16
 *              ms late, and LATE_MS sits above that: pieces of work shorter than it are not counted (checked against
 *              Chrome's own task time in the demo harness: an idle page reads 0%, a page busy 60% in 60 ms pieces reads
 *              about 40%, the load workspace before the 2026-10-15 fixes 43% where Chrome counted 61%). Only while the
 *              window is visible (a hidden page's timers are slowed on purpose).
 *   long tasks how many tasks over 50 ms (the PerformanceObserver app.js already has), the worst, and their total.
 *   paths      the time spent in Apaki's own drawing, by path (the engine's events, the session list, the tab bar, the
 *              streamed replies, the histories...), each path counted without the paths it calls, so the names say
 *              where the time went. time(name, fn) runs fn and counts it; wrap(name, fn) is the same as a function.
 *
 *   const w = createPerfWatch({ now, wait, visible, random })
 *   w.time(name, fn)   w.wrap(name, fn)   w.longTask(ms)   w.start()   w.stop()
 *   w.minute(extra)    -> { busyPct, samples, longs, worst, longMs, paths: [[name, ms]...], line } and a fresh minute
 *
 * The cost: two performance.now() calls per counted call, and one timer every 250 ms on average while visible.
 * Pure apart from the clock and the timer, which tests replace.
 */

/** The busy share (percent of the minute) over which app.js logs the minute's line. */
export const BUSY_LOG_PCT = 30;
/** A sampling timer this late (ms) was held by a task. A free thread runs it within one Windows timer tick (15.6 ms). */
export const LATE_MS = 17;
/** The sampling timer's gap, drawn at random from this range (ms), so it cannot fall into step with periodic work. */
const GAP_MS = [180, 320];

/** Short words for the paths, as the line names them. */
export const PATH_WORDS = {
  events: 'engine events', panes: 'pane events', stream: 'streamed replies', history: 'histories', rail: 'session list',
  tabs: 'tab bar', panel: 'side panel', layout: 'pane grid', save: 'saving', worktrees: 'worktrees',
};

export function createPerfWatch({
  now = () => performance.now(),
  wait = (f, ms) => setTimeout(f, ms),
  visible = () => typeof document === 'undefined' || document.visibilityState === 'visible',
  random = Math.random,
} = {}) {
  let paths = new Map();
  let longs = 0;
  let worst = 0;
  let longMs = 0;
  let samples = 0;
  let busy = 0;
  // Since the start, never reset by minute() (for checks across minutes: apaki/demo/perf.mjs).
  let allSamples = 0;
  let allBusy = 0;
  let running = false;
  // The paths being timed, innermost last: { name, t0, inner } (inner: time of the paths it called).
  const stack = [];

  function time(name, fn) {
    const frame = { name, t0: now(), inner: 0 };
    stack.push(frame);
    try {
      return fn();
    } finally {
      const dur = now() - frame.t0;
      stack.pop();
      paths.set(name, (paths.get(name) || 0) + Math.max(0, dur - frame.inner));
      const up = stack[stack.length - 1];
      if (up) up.inner += dur;
    }
  }

  const wrap = (name, fn) => function wrapped(...args) { return time(name, () => fn.apply(this, args)); };

  function longTask(ms) {
    longs += 1;
    longMs += ms;
    if (ms > worst) worst = ms;
  }

  // The sampler: each timer says when it was due; late means a task held the thread at that moment.
  function sample() {
    if (!running) return;
    const gap = GAP_MS[0] + random() * (GAP_MS[1] - GAP_MS[0]);
    const due = now() + gap;
    const seen = visible();
    wait(() => {
      if (!running) return;
      if (seen && visible()) {
        samples += 1;
        allSamples += 1;
        if (now() - due > LATE_MS) { busy += 1; allBusy += 1; }
      }
      sample();
    }, gap);
  }

  function start() { if (running) return; running = true; sample(); }
  function stop() { running = false; }

  /**
   * Closes the minute: its numbers, and the line app.js logs (null when the thread was not busy enough to say, or
   * was hardly visible: under 40 samples is under 10 seconds on screen). extra: words for the end of the line.
   */
  function minute(extra = '') {
    const busyPct = samples ? Math.round((busy / samples) * 100) : 0;
    const top = [...paths.entries()].filter(([, ms]) => ms >= 1).sort((a, b) => b[1] - a[1]);
    const out = { busyPct, samples, longs, worst: Math.round(worst), longMs: Math.round(longMs), paths: top.map(([k, ms]) => [k, Math.round(ms)]) };
    const s = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    const named = top.slice(0, 5).map(([k, ms]) => `${PATH_WORDS[k] || k} ${s(ms)}`).join(', ');
    out.line = samples >= 40 && busyPct > BUSY_LOG_PCT
      ? `busy ${busyPct}% of the last minute; ${longs} long task${longs === 1 ? '' : 's'}${longs ? `, worst ${Math.round(worst)} ms, ${s(longMs)} in all` : ''}; time in: ${named || 'none of its own'}${extra ? `; ${extra}` : ''}`
      : null;
    paths = new Map();
    longs = 0;
    worst = 0;
    longMs = 0;
    samples = 0;
    busy = 0;
    return out;
  }

  /** The minute so far, without closing it (for checks). */
  const peek = () => ({ samples, busy, longs, worst, paths: new Map(paths), allSamples, allBusy });

  return { time, wrap, longTask, start, stop, minute, peek };
}

/** The window's watch: one for the page, shared by app.js and pane.js. */
export const watch = createPerfWatch();
