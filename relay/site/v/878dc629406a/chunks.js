/**
 * chunks.js: which messages of a long conversation to fold into a chunk (2026-10-12, input lag).
 *
 * A conversation of thousands of messages is thousands of top-level blocks in one scroll container, and every update
 * (a streamed word, a tool result, a key press that resizes the composer) made the browser walk all of them again to
 * lay out, hit-test and paint: about 7 ms per update in a 2400-message pane, a frame's worth for each pane streaming.
 * pane.js now wraps older messages, in groups of about 24, in a `.chunk` box that app.css gives content-visibility:
 * auto and the height it measured, so the browser skips what is off screen and the page has a hundred blocks, not
 * thousands, while looking and scrolling exactly as before. This file decides the groups; the DOM work is in pane.js.
 *
 *   planChunks(kinds, { keep, size })   -> [[from, to), ...]
 *
 * kinds: one entry per top-level node of the transcript, in order: 'turn' (one of your messages), 'item' (anything
 * else that may be folded) or 'skip' (stays where it is: the Load earlier bar, the archive line, notices at the top,
 * and chunks that already exist). Rules: the last `keep` nodes stay open (what is streaming and what you are reading
 * at the end); a chunk never holds a 'skip' node; a chunk starts at one of your messages when it can, so it reads as a
 * turn; a run too short to make a chunk is left alone and joins the next one.
 */

/** The groups to wrap, as [from, to) index ranges into `kinds`. */
export function planChunks(kinds, { keep = 48, size = 24 } = {}) {
  const ranges = [];
  const limit = Math.max(0, kinds.length - keep);
  let i = 0;
  while (i < limit) {
    if (kinds[i] === 'skip') { i++; continue; }
    // A run of foldable nodes: i up to the next 'skip' or the limit.
    let end = i;
    while (end < limit && kinds[end] !== 'skip') end++;
    let from = i;
    while (end - from >= size) {
      // Cut after `size` nodes, moved forward to the next message of yours when one is within another `size`.
      let to = from + size;
      for (let k = to; k < Math.min(end, from + size * 2); k++) { if (kinds[k] === 'turn') { to = k; break; } }
      // Leave a remainder too short to be a chunk of its own to the next pass instead of cutting it off.
      if (end - to < Math.ceil(size / 2) && to !== end) to = end;
      ranges.push([from, to]);
      from = to;
    }
    i = end;
  }
  return ranges;
}
