/**
 * streampaint.js: one painter for every streaming reply in the window (2026-10-12, input lag).
 *
 * Each pane used to schedule its own animation frame per streaming reply, and each of those frames wrote the reply
 * and then read the page's layout (to keep the reader at the end). With four panes streaming that was four layouts per
 * frame, in a page whose transcripts are thousands of blocks long, and the main thread had no room left for a key press.
 * This painter takes every reply that has new text and, once per frame:
 *   - draws at most one update per reply per `gap` ms (about 20 a second; a longer gap while someone is typing),
 *   - stops drawing when the frame has spent `budget` ms, and carries the rest to the next frame (at least one reply is
 *     always drawn, so a slow one cannot starve),
 *   - runs every draw first and every settle (the scroll-to-end read) after, so the browser lays the page out once.
 *
 *   const painter = createStreamPainter();
 *   painter.queue(key, draw, settle)   key: the reply element; draw(): writes it; settle(): the pane's scrollDown
 *   painter.cancel(key)                the reply finished or went away
 *   painter.typed()                    a key was pressed: stream updates slow down for a moment
 *
 * Pure of the page apart from the clock and the frame callback, which tests replace.
 */

/** Creates a painter. raf, now: the frame scheduler and the clock (the page's own by default). */
export function createStreamPainter({
  raf = (f) => requestAnimationFrame(f), now = () => performance.now(), gap = 50, typingGap = 110, typingMs = 400, budget = 6,
} = {}) {
  const jobs = new Map();
  const last = new WeakMap();
  let frameId = 0;
  let keyAt = -Infinity;

  function frame() {
    frameId = 0;
    const t0 = now();
    const wait = t0 - keyAt < typingMs ? typingGap : gap;
    const settles = new Set();
    let drawn = 0;
    for (const [key, job] of jobs) {
      if (t0 - (last.get(key) ?? -Infinity) < wait) continue;
      if (drawn && now() - t0 > budget) break;
      jobs.delete(key);
      last.set(key, t0);
      try { job.draw(); } catch (e) { /* one reply failing to draw must not stop the others */ }
      drawn++;
      if (job.settle) settles.add(job.settle);
    }
    for (const settle of settles) { try { settle(); } catch (e) { /* a pane that went away */ } }
    if (jobs.size) frameId = raf(frame);
  }

  return {
    queue(key, draw, settle) {
      jobs.set(key, { draw, settle });
      if (!frameId) frameId = raf(frame);
    },
    cancel(key) { jobs.delete(key); },
    typed() { keyAt = now(); },
    get size() { return jobs.size; },
  };
}
