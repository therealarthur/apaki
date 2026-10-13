/**
 * Decorative motion rests while the window is hidden or unfocused (apaki/ui/rest.js, 2026-10-12): the class on <html>
 * follows visibility and focus, and the stylesheet pauses every animation under it and still honours reduced motion.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { initRest, restState } from '../apaki/ui/rest.js';

const CSS = fs.readFileSync(new URL('../apaki/ui/app.css', import.meta.url), 'utf8');

function fakeWindow({ visibility = 'visible', focused = true } = {}) {
  const win = { handlers: {}, addEventListener(t, f) { (this.handlers[t] ||= []).push(f); } };
  const classes = new Set();
  const doc = {
    visibilityState: visibility,
    hasFocus: () => focused,
    handlers: {},
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); },
    documentElement: { classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } },
  };
  const fire = (target, type) => (target.handlers[type] || []).forEach((f) => f());
  return { win, doc, classes, fire, set(v) { if ('focused' in v) focused = v.focused; if ('visibility' in v) doc.visibilityState = v.visibility; } };
}

test('restState: rests unless the page is visible and focused', () => {
  assert.equal(restState('visible', true), false);
  assert.equal(restState('visible', false), true);
  assert.equal(restState('hidden', true), true);
  assert.equal(restState('hidden', false), true);
});

test('initRest: the rest class follows focus, blur and visibility', () => {
  const w = fakeWindow();
  initRest(w.win, w.doc);
  assert.ok(!w.classes.has('rest'), 'focused and visible: moving');
  w.set({ focused: false });
  w.fire(w.win, 'blur');
  assert.ok(w.classes.has('rest'), 'blurred: resting');
  w.set({ focused: true });
  w.fire(w.win, 'focus');
  assert.ok(!w.classes.has('rest'), 'focused again: moving');
  w.set({ visibility: 'hidden' });
  w.fire(w.doc, 'visibilitychange');
  assert.ok(w.classes.has('rest'), 'hidden: resting');
});

test('initRest: a window that starts unfocused starts at rest; no window is a no-op', () => {
  const w = fakeWindow({ focused: false });
  initRest(w.win, w.doc);
  assert.ok(w.classes.has('rest'));
  assert.equal(typeof initRest(null, null), 'function');
});

test('app.css: rest pauses every animation, the keep-warm ring turns on a transform, reduced motion still stops it', () => {
  assert.match(CSS, /html\.rest \*, html\.rest \*::before, html\.rest \*::after \{ animation-play-state: paused !important; \}/);
  assert.match(CSS, /\.warm-ring::before \{[^}]*animation: warm-turn 7s linear infinite/);
  assert.match(CSS, /@keyframes warm-turn \{ to \{ transform: translate\(-50%, -50%\) rotate\(360deg\); \} \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{ \.warm-ring::before \{ display: none; \} \}/);
  // The pearl moves in steps: the frosted surfaces over it are blurred again only when it moves.
  assert.match(CSS, /body::before \{[^}]*animation: pearl-drift 48s steps\(\d+, end\) infinite alternate/);
});

test('app.css: the loops that held the main thread run on the compositor (no colour or position in their keyframes)', () => {
  // The effort grid: one moving band over a masked grid, never a per-dot animation.
  assert.match(CSS, /\.egrid\.max i\.lit, \.egrid\.live i \{ opacity: \.66; animation: none; \}/);
  assert.match(CSS, /@keyframes egrid-wave \{ 0% \{ transform: translateX\(-14px\); \} 45%, 100% \{ transform: translateX\(24px\); \} \}/);
  // The working tab's sweep is a child moved by a transform, and the old background-position bar is switched off.
  assert.match(CSS, /\.tab\.busy::after \{ content: none; animation: none; \}/);
  assert.match(CSS, /@keyframes tab-sweep \{ from \{ transform: translateX\(-60%\); \} to \{ transform: translateX\(160%\); \} \}/);
  const keyframes = [...CSS.matchAll(/@keyframes (warm-turn|egrid-wave|tab-sweep) \{([^@]*?)\}\s*(?=\n)/g)].map((m) => m[2]);
  assert.equal(keyframes.length, 3);
  for (const body of keyframes) assert.doesNotMatch(body, /background|--warm-a|left|top|width/, 'only transform in the keyframes');
  // The sidebar is not a live blur any more: nothing in it can make the GPU blur the whole column again.
  assert.match(CSS, /\.rail \{[^}]*-webkit-backdrop-filter: none; backdrop-filter: none;/);
});

