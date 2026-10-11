/**
 * queue-hold.js: the engine's copy of a pane's queued messages (Arthur,
 * 2026-10-10: queued messages must go out even while the window is closed).
 *
 * WHY: the queue ("send this when Claude finishes") lives in the window's
 * pane (apaki/ui/pane.js). Since the engine became a background host that
 * outlives the window, a turn keeps running with the window closed, but the
 * messages queued behind it sat in the dead window until it came back.
 *
 * THE OWNERSHIP RULE (one owner at any moment, so nothing goes out twice):
 *
 *   - A window is connected: the WINDOW owns the queue. It flushes when a turn
 *     ends, as it always did. The engine only keeps a copy and never sends.
 *   - No window is connected (host mode): the ENGINE owns it. When a pane's
 *     turn ends on its own (a result that is not the user's Stop), it sends
 *     the held items as the next message, joined exactly as pane.js
 *     flushQueue joins them, and clears its copy.
 *   - A user Stop keeps the queue unsent in both places (nothing goes out
 *     after a stop until the user sends again).
 *   - A window's send or steer names the queued ids it takes (`queued`, or the
 *     steer's `qid`); the engine drops those from its copy in the same step it
 *     receives the op, so a window that closes right after flushing leaves
 *     nothing behind for the engine to send again.
 *   - On re-attach (opened { attached: true }) the engine tells the pane what
 *     it still holds (`queue`) and which ids it sent while the window was away
 *     (`queueSent`); the pane shows the first and drops the second.
 *
 * Phones: a phone pane is its own window (remote.js). The phone page does not
 * send queueSet (remote-policy.js does not allow it), so a phone pane never
 * has a held queue and the engine never sends for one; phone queues stay
 * window-side, as before.
 *
 * Pure functions on the pane record (`p.held`, `p.heldSent`, `p.userStopped`),
 * so the rules are tested without starting an engine (test/apaki-queue.test.js).
 */

/** Most queued messages kept per pane (a runaway window cannot grow the engine without limit). */
export const MAX_HELD = 50;
/** How many sent ids a pane remembers, to tell a window that comes back what went out meanwhile. */
export const MAX_SENT_IDS = 100;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * What a window sent as its queue, made safe to keep: { id, text, images } per
 * item (images { media_type, data, w, h }); items without an id or with
 * neither text nor images are dropped.
 */
export function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (out.length >= MAX_HELD) break;
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id || it.id.length > 80 || seen.has(it.id)) continue;
    const text = typeof it.text === 'string' ? it.text : '';
    const images = (Array.isArray(it.images) ? it.images : [])
      .filter((im) => im && typeof im === 'object' && IMAGE_TYPES.has(im.media_type) && typeof im.data === 'string' && im.data)
      .map((im) => ({ media_type: im.media_type, data: im.data, w: Number.isFinite(im.w) ? im.w : 0, h: Number.isFinite(im.h) ? im.h : 0 }));
    if (!text && !images.length) continue;
    seen.add(it.id);
    out.push({ id: it.id, text, images });
  }
  return out;
}

/** The window's queue replaced the engine's copy (queueSet). */
export function setHeld(p, items) {
  p.held = cleanItems(items);
  return p.held;
}

/** Removes queued ids from the copy: a send or steer of the window took them. Returns how many were removed. */
export function dropHeld(p, ids) {
  if (!p?.held?.length || !Array.isArray(ids) || !ids.length) return 0;
  const gone = new Set(ids.filter((x) => typeof x === 'string'));
  const before = p.held.length;
  p.held = p.held.filter((it) => !gone.has(it.id));
  return before - p.held.length;
}

/**
 * Items joined into one message the way pane.js flushQueue joins them: the
 * texts (empty ones skipped) separated by a blank line, every item's images
 * in order.
 */
export function joinItems(items) {
  return {
    text: items.map((it) => it.text).filter(Boolean).join('\n\n'),
    images: items.flatMap((it) => it.images.map(({ media_type, data }) => ({ media_type, data }))),
  };
}

/**
 * A pane's turn ended (a result). Decides whether the ENGINE sends the held
 * queue now (see the ownership rule above) and, if so, takes it: the copy is
 * emptied and the ids are remembered as sent. Returns { items, ids, text,
 * images } for the send, or null when it is not the engine's to send.
 *
 * @param {object} p  the pane record
 * @param {object} o
 * @param {boolean} o.windowConnected  a window is connected (the window owns the queue then); always true outside host mode
 * @param {boolean} [o.phone]  a phone pane (its queue stays window-side)
 */
export function takeForAutoSend(p, { windowConnected, phone = false }) {
  if (windowConnected || phone || p.userStopped || !p.held?.length) return null;
  const items = p.held;
  p.held = [];
  rememberSent(p, items.map((it) => it.id));
  return { items, ids: items.map((it) => it.id), ...joinItems(items) };
}

/** Remembers ids that went out (newest last, bounded). */
export function rememberSent(p, ids) {
  p.heldSent = [...(p.heldSent || []), ...ids].slice(-MAX_SENT_IDS);
}

/** What the engine tells a window that re-attaches to this pane: what is still queued, and what went out meanwhile. */
export function heldView(p) {
  return { queue: (p.held || []).map((it) => ({ ...it, images: it.images.map((im) => ({ ...im })) })), queueSent: [...(p.heldSent || [])] };
}

/** A different conversation in the pane: nothing queued for the old one applies, and Stop no longer counts. */
export function resetHeld(p) {
  p.held = [];
  p.heldSent = [];
  p.userStopped = false;
}
