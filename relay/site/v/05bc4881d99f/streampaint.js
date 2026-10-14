/**
 * streampaint.js: one painter for every streaming reply in the window (2026-10-12, input lag).
 *
 * Each pane used to schedule its own animation frame per streaming reply, and each of those frames wrote the reply
 * and then read the page's layout (to keep the reader at the end). With four panes streaming that was four layouts per
 * frame, in a page whose transcripts are thousands of blocks long, and the main thread had no room left for a key press.
 * This painter takes every reply that has new text and, once per frame:
 *   - draws at most one update per reply per `gap` ms (about 20 a second),
 *   - draws nothing while a key was pressed in the last `hold` ms (someone is typing: their key press must not queue
 *     behind a paint), and catches up the moment they pause; a reply that has waited `maxWait` ms is drawn anyway,
 *   - stops drawing when the frame has spent `budget` ms, and carries the rest to the next frame (at least one reply is
 *     always drawn, so a slow one cannot starve),
 *   - runs every draw first and every settle (the scroll-to-end read) after, so the browser lays the page out once.
 *
 *   const painter = createStreamPainter();
 *   painter.queue(key, draw, settle)   key: the reply element; draw(): writes it; settle(): the pane's scrollDown
 *   painter.cancel(key)                the reply finished or went away
 *   painter.typed()                    a key was pressed: stream updates wait a moment
 *
 * Pure of the page apart from the clock and the schedulers, which tests replace.
 */

/** Creates a painter. raf, wait, now: the frame scheduler, a timer, and the clock (the page's own by default). */
export function createStreamPainter({
  raf = (f) => requestAnimationFrame(f), wait = (f, ms) => setTimeout(f, ms), now = () => performance.now(),
  gap = 50, hold = 200, maxWait = 800, budget = 6,
} = {}) {
  const jobs = new Map();
  const last = new WeakMap();
  let scheduled = false;
  let keyAt = -Infinity;

  function schedule(delay = 0) {
    if (scheduled) return;
    scheduled = true;
    // While someone types the next look is a timer for when they may have paused, not a frame callback every 16 ms.
    if (delay > 0) wait(() => { scheduled = false; schedule(); }, delay);
    else raf(frame);
  }

  function frame() {
    scheduled = false;
    const t0 = now();
    const typingFor = hold - (t0 - keyAt);
    // Typing: nothing is drawn, unless a reply has waited too long.
    const forced = new Set();
    if (typingFor > 0) {
      for (const [key, job] of jobs) if (t0 - job.since >= maxWait) forced.add(key);
      if (!forced.size) { if (jobs.size) schedule(Math.min(typingFor, gap) + 1); return; }
    }
    const settles = new Set();
    let drawn = 0;
    let waiting = false;
    for (const [key, job] of jobs) {
      if (typingFor > 0 && !forced.has(key)) continue;
      if (t0 - (last.get(key) ?? -Infinity) < gap) { waiting = true; continue; }
      if (drawn && now() - t0 > budget) { waiting = true; break; }
      jobs.delete(key);
      last.set(key, t0);
      try { job.draw(); } catch (e) { /* one reply failing to draw must not stop the others */ }
      drawn++;
      if (job.settle) settles.add(job.settle);
    }
    for (const settle of settles) { try { settle(); } catch (e) { /* a pane that went away */ } }
    if (jobs.size) schedule(waiting ? 0 : Math.min(gap, 16));
  }

  return {
    queue(key, draw, settle) {
      const had = jobs.get(key);
      jobs.set(key, { draw, settle, since: had ? had.since : now() });
      schedule();
    },
    cancel(key) { jobs.delete(key); },
    typed() { keyAt = now(); },
    get size() { return jobs.size; },
  };
}
