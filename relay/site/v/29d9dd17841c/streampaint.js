/**
 * streampaint.js: one painter for every streaming reply in the window (2026-10-12, input lag).
 *
 * Each pane used to schedule its own animation frame per streaming reply, and each of those frames wrote the reply
 * and then read the page's layout (to keep the reader at the end). With four panes streaming that was four layouts per
 * frame, in a page whose transcripts are thousands of blocks long, and the main thread had no room left for a key press.
 * This painter takes every reply that has new text and, once per frame:
 *   - draws every reply that has new text in the same frame, at most once per `gap` ms (about 20 a second; since
 *     2026-10-15 the gap is the painter's, not each reply's, so replies streaming side by side share their frames),
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
  let scheduled = false;
  let keyAt = -Infinity;
  // One drawing for every reply at once (2026-10-15, window lag). Each reply used to keep its own 50 ms gap, so three
  // replies streaming drifted apart and were drawn in three different frames: up to 60 frames a second with work in
  // them, each paying for the whole page's style, layout and paint. Now the gap is the painter's: every reply with new
  // text is drawn in the same frame, at most once per gap (each reply still at most ~20 times a second), and between
  // drawings the painter waits on a timer instead of looking every frame.
  let lastAt = -Infinity; // when a frame last drew something
  let behind = false;     // the last frame ran out of budget with replies still waiting: the next one goes at once

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
    // Drawn less than a gap ago: look again when the gap is over (unless the last frame left replies behind).
    const since = t0 - lastAt;
    if (!behind && since < gap) { schedule(Math.max(1, Math.ceil(gap - since))); return; }
    behind = false;
    const settles = new Set();
    let drawn = 0;
    for (const [key, job] of jobs) {
      if (typingFor > 0 && !forced.has(key)) continue;
      if (drawn && now() - t0 > budget) { behind = true; break; }
      jobs.delete(key);
      try { job.draw(); } catch (e) { /* one reply failing to draw must not stop the others */ }
      drawn++;
      if (job.settle) settles.add(job.settle);
    }
    if (drawn) lastAt = t0;
    for (const settle of settles) { try { settle(); } catch (e) { /* a pane that went away */ } }
    if (jobs.size) schedule(behind ? 0 : gap);
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
