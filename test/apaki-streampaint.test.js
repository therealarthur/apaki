/**
 * The stream painter (apaki/ui/streampaint.js, 2026-10-12, input lag): one frame callback for every streaming reply,
 * a minimum gap per reply, a time budget per frame, every draw before any settle (one layout), slower while typing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamPainter } from '../apaki/ui/streampaint.js';

// Replies are DOM elements in the page; objects here.
const K = {};
const key = (n) => (K[n] ||= { n });

/** A painter on a fake clock and a fake frame loop: step(ms) advances the clock by ms and runs the pending frame. */
function rig(opts = {}) {
  let t = 1000;
  let pending = null;
  const painter = createStreamPainter({ raf: (f) => { pending = f; return 1; }, now: () => t, ...opts });
  return {
    painter,
    clock: () => t,
    advance(ms) { t += ms; },
    frames() { return pending ? 1 : 0; },
    step(ms = 16) { t += ms; const f = pending; pending = null; if (f) f(); return Boolean(f); },
  };
}

test('one frame is scheduled however many replies are queued, and each is drawn once', () => {
  const r = rig();
  const log = [];
  r.painter.queue(key('a'), () => log.push('a'));
  r.painter.queue(key('b'), () => log.push('b'));
  r.painter.queue(key('c'), () => log.push('c'));
  assert.equal(r.frames(), 1);
  r.step();
  assert.deepEqual(log, ['a', 'b', 'c']);
  assert.equal(r.painter.size, 0);
  assert.equal(r.step(), false, 'nothing left, no more frames');
});

test('a reply is drawn at most once per gap; text that arrives in between is drawn on the next one', () => {
  const r = rig({ gap: 50 });
  let draws = 0;
  const draw = () => { draws++; };
  r.painter.queue(key('a'), draw);
  r.step(16);
  assert.equal(draws, 1);
  for (let i = 0; i < 5; i++) { r.painter.queue(key('a'), draw); r.step(16); }
  assert.ok(draws <= 3, `about one draw per 50 ms, got ${draws} in 5 frames of 16 ms`);
  r.step(16); r.step(16); r.step(16);
  assert.equal(r.painter.size, 0, 'the last text was drawn');
});

test('every settle runs once, after every draw', () => {
  const r = rig();
  const log = [];
  const settleA = () => log.push('settle A');
  const settleB = () => log.push('settle B');
  r.painter.queue(key('a1'), () => log.push('draw a1'), settleA);
  r.painter.queue(key('a2'), () => log.push('draw a2'), settleA);
  r.painter.queue(key('b1'), () => log.push('draw b1'), settleB);
  r.step();
  assert.deepEqual(log, ['draw a1', 'draw a2', 'draw b1', 'settle A', 'settle B']);
});

test('a frame that has spent its budget carries the rest over, but always draws at least one', () => {
  let clock = 0;
  let pending = null;
  const painter = createStreamPainter({ raf: (f) => { pending = f; return 1; }, now: () => clock, budget: 6, gap: 0 });
  const log = [];
  for (const k of ['a', 'b', 'c']) painter.queue(key(k), () => { log.push(k); clock += 8; });
  const run = () => { const f = pending; pending = null; clock += 16; if (f) f(); };
  run();
  assert.deepEqual(log, ['a'], 'the first draw spent 8 ms, over the 6 ms budget');
  assert.equal(painter.size, 2);
  run();
  assert.deepEqual(log, ['a', 'b']);
  run();
  assert.deepEqual(log, ['a', 'b', 'c']);
  assert.equal(painter.size, 0);
});

test('typing slows the updates for a moment', () => {
  const r = rig({ gap: 50, typingGap: 110, typingMs: 400 });
  let draws = 0;
  r.painter.queue(key('a'), () => { draws++; });
  r.step(16);
  r.painter.typed();
  for (let i = 0; i < 6; i++) { r.painter.queue(key('a'), () => { draws++; }); r.step(16); }
  assert.ok(draws <= 2, `at most one more draw in 96 ms while typing, got ${draws}`);
  r.advance(500);
  r.painter.queue(key('a'), () => { draws++; });
  const before = draws;
  r.step(16);
  assert.equal(draws, before + 1, 'back to the normal gap once typing stops');
});

test('cancel drops a queued reply; a draw that throws does not stop the others', () => {
  const r = rig();
  const log = [];
  r.painter.queue(key('gone'), () => log.push('gone'));
  r.painter.queue(key('bad'), () => { throw new Error('boom'); });
  r.painter.queue(key('ok'), () => log.push('ok'));
  r.painter.cancel(key('gone'));
  r.step();
  assert.deepEqual(log, ['ok']);
});
