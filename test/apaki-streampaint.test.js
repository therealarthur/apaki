/**
 * The stream painter (apaki/ui/streampaint.js, 2026-10-12, input lag): one frame callback for every streaming reply,
 * a minimum gap per reply, a time budget per frame, every draw before any settle (one layout), nothing drawn while
 * someone is typing (but never for long).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamPainter } from '../apaki/ui/streampaint.js';

// Replies are DOM elements in the page; objects here.
const K = {};
const key = (n) => (K[n] ||= { n });

/**
 * A painter on a fake clock with a fake frame loop and timers: step(ms) advances the clock by ms, then runs the pending
 * frame callback and every timer that has come due.
 */
function rig(opts = {}) {
  let t = 1000;
  let raf = null;
  const timers = [];
  const painter = createStreamPainter({
    raf: (f) => { raf = f; return 1; },
    wait: (f, ms) => { timers.push({ at: t + ms, f }); },
    now: () => t,
    ...opts,
  });
  return {
    painter,
    advance(ms) { t += ms; },
    frames() { return raf ? 1 : 0; },
    timers: () => timers.length,
    step(ms = 16) {
      t += ms;
      let ran = false;
      const due = timers.filter((x) => x.at <= t);
      for (const x of due) { timers.splice(timers.indexOf(x), 1); x.f(); ran = true; }
      const f = raf;
      raf = null;
      if (f) { f(); ran = true; }
      return ran;
    },
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
  for (let i = 0; i < 6; i++) r.step(16);
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
  const painter = createStreamPainter({ raf: (f) => { pending = f; return 1; }, wait: (f) => { pending = f; }, now: () => clock, budget: 6, gap: 0 });
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

test('while someone types nothing is drawn, and the reply is drawn as soon as they pause', () => {
  const r = rig({ gap: 50, hold: 220 });
  let draws = 0;
  const draw = () => { draws++; };
  r.painter.queue(key('a'), draw);
  r.step(16);
  assert.equal(draws, 1);
  // Typing, a key every 100 ms for a second: text keeps arriving, nothing is painted.
  for (let i = 0; i < 10; i++) {
    r.painter.typed();
    r.painter.queue(key('a'), draw);
    r.step(50); r.step(50);
  }
  assert.equal(draws, 1, 'no paint while keys keep coming');
  assert.ok(r.painter.size === 1, 'the reply is waiting, not lost');
  // They pause: within a couple of frames after the hold it is drawn, once, with everything that arrived.
  for (let i = 0; i < 20 && r.painter.size; i++) r.step(16);
  assert.equal(draws, 2);
  assert.equal(r.painter.size, 0);
});

test('typing never holds a reply back for longer than maxWait', () => {
  const r = rig({ gap: 50, hold: 220, maxWait: 1200 });
  let draws = 0;
  r.painter.queue(key('a'), () => { draws++; });
  // A key every 100 ms, forever: after 1.2 s the reply is drawn anyway.
  let ms = 0;
  while (ms < 3000 && !draws) { r.painter.typed(); r.step(100); ms += 100; }
  assert.equal(draws, 1);
  assert.ok(ms >= 1200 && ms <= 1500, `drawn after about 1.2 s of typing, not ${ms} ms`);
});

test('while typing the painter waits on a timer, not a frame callback every 16 ms', () => {
  const r = rig({ hold: 220 });
  r.painter.queue(key('a'), () => {});
  r.painter.typed();
  r.step(1);
  assert.equal(r.frames(), 0, 'no frame callback pending');
  assert.ok(r.timers() >= 1, 'a timer to look again');
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
