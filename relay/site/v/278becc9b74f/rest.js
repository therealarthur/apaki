/**
 * rest.js: decorative motion rests while the window is not in use (2026-10-12, input lag).
 *
 * Arthur's window ran its loops (the drifting pearl behind the frosted surfaces, the working glow, the keep-warm
 * rings, the sweeps and spinners) all day, focused or not, and the GPU and the page's main thread paid for each
 * frame even when no one was looking. This puts class "rest" on <html> while the document is hidden or its window
 * has lost focus (Tauri forwards the window's focus and blur to the page); app.css pauses every animation under it.
 * One-shot transitions are untouched, and prefers-reduced-motion is handled by the stylesheet as before.
 *
 *   restState(visibility, focused)   true when the window should rest (pure, for the tests)
 *   initRest(win, doc)               wires the classes; returns a function that re-reads the state
 */

/** True when decorative motion should be paused: the page is not visible, or it is visible but not focused. */
export function restState(visibility, focused) {
  return visibility !== 'visible' || !focused;
}

/** Keeps <html class="rest"> in step with visibility and focus. Safe to call without a window (tests, tools). */
export function initRest(win = typeof window === 'undefined' ? null : window, doc = typeof document === 'undefined' ? null : document) {
  if (!win || !doc?.documentElement) return () => {};
  const sync = () => doc.documentElement.classList.toggle('rest', restState(doc.visibilityState, typeof doc.hasFocus === 'function' ? doc.hasFocus() : true));
  win.addEventListener('focus', sync);
  win.addEventListener('blur', sync);
  doc.addEventListener('visibilitychange', sync);
  sync();
  return sync;
}
