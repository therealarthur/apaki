/**
 * Which messages of a long conversation fold into a chunk (apaki/ui/chunks.js, 2026-10-12, input lag): the last ones
 * stay open, a chunk never holds a node that must stay where it is, chunks start at your messages when they can, and
 * every node ends up in at most one chunk, in order.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { planChunks } from '../apaki/ui/chunks.js';
import { Pane } from '../apaki/ui/pane.js';

/** A conversation of `n` rounds: your message, then `k` items. */
const rounds = (n, k = 3) => Array.from({ length: n }, () => ['turn', ...Array(k).fill('item')]).flat();

const covered = (ranges) => ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));

test('a short conversation folds nothing', () => {
  assert.deepEqual(planChunks(rounds(10), { keep: 48, size: 24 }), []);
  assert.deepEqual(planChunks([], {}), []);
});

test('the last `keep` nodes stay open, and the rest folds in order without overlap', () => {
  const kinds = rounds(100);
  const ranges = planChunks(kinds, { keep: 48, size: 24 });
  assert.ok(ranges.length > 5);
  const all = covered(ranges);
  assert.equal(new Set(all).size, all.length, 'no node twice');
  assert.deepEqual(all, [...all].sort((a, b) => a - b), 'in order');
  assert.ok(Math.max(...all) < kinds.length - 48, 'nothing inside the open tail');
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] >= ranges[i - 1][1]);
});

test('chunks start at one of your messages when they can, and are about the planned size', () => {
  const kinds = rounds(200, 5);
  const ranges = planChunks(kinds, { keep: 48, size: 24 });
  for (const [a, b] of ranges.slice(1)) assert.equal(kinds[a], 'turn', `chunk at ${a} starts at a message of yours`);
  for (const [a, b] of ranges) assert.ok(b - a >= 24 && b - a <= 24 * 2 + 12, `size ${b - a}`);
});

test('a skip node (the loader, the archive line, an existing chunk) is never inside a chunk and ends a run', () => {
  const kinds = ['skip', 'skip', ...rounds(30), 'skip', ...rounds(30), 'skip', ...rounds(30)];
  const ranges = planChunks(kinds, { keep: 20, size: 24 });
  for (const [a, b] of ranges) for (let i = a; i < b; i++) assert.notEqual(kinds[i], 'skip');
  assert.ok(ranges.length >= 2);
  // Nodes before the first skip run are folded too (an earlier page put on top of existing chunks).
  assert.ok(ranges.some(([a]) => a === 2));
});

test('a run too short to be a chunk is left alone, and the next pass takes it with what has grown after it', () => {
  const kinds = ['item', 'item', 'item', 'skip', ...rounds(60)];
  const first = planChunks(kinds, { keep: 20, size: 24 });
  assert.ok(first.every(([a]) => a >= 4), 'the three loose nodes before the skip stay');
  // The tail grows by 30 messages: it folds more, still never touching the open end.
  const grown = [...kinds, ...rounds(10)];
  const second = planChunks(grown, { keep: 20, size: 24 });
  assert.ok(Math.max(...covered(second)) < grown.length - 20);
});

test('a remainder shorter than half a chunk joins the chunk before it instead of standing alone', () => {
  const kinds = Array(30).fill('item');
  const ranges = planChunks(kinds, { keep: 2, size: 24 });
  assert.deepEqual(ranges, [[0, 28]]);
});

/* ---------- the pin through chunks ---------- */

/**
 * A pane whose transcript is `turns` of your message boxes in chunks of `per`, each turn `h` px tall with 30 px between,
 * the ground showing from y = `top`. Counts how often a turn's own box is asked for.
 */
function chunkedPane({ turns, per, h = 40, top = 0 }) {
  const probes = { turn: 0, chunk: 0 };
  const offset = { v: 0 };
  const list = [];
  const chunks = [];
  let y = 0;
  let chunk = null;
  for (let i = 0; i < turns; i++) {
    if (i % per === 0) {
      chunk = { classList: { contains: (c) => c === 'chunk' }, first: i, last: Math.min(turns, i + per) - 1 };
      chunks.push(chunk);
    }
    const t = { i, parentElement: chunk, y0: y, y1: y + h };
    t.getBoundingClientRect = () => { probes.turn++; return { top: t.y0 - offset.v, bottom: t.y1 - offset.v }; };
    list.push(t);
    y += h + 30;
  }
  for (const c of chunks) {
    const a = list[c.first];
    const b = list[c.last];
    c.getBoundingClientRect = () => { probes.chunk++; return { top: a.y0 - offset.v - 22, bottom: b.y1 - offset.v + 10 }; };
  }
  const pane = Object.create(Pane.prototype);
  Object.assign(pane, {
    $: { T: { querySelectorAll: () => list }, ground: { getBoundingClientRect: () => ({ top, height: 600 }) } },
    promptsBefore: 0, history: null, promptsKnown: true,
  });
  return { pane, list, probes, scroll: (px) => { offset.v = px; } };
}

test('pinnedTurn through chunks answers as asking every turn would, with few turn probes', () => {
  const { pane, list, probes, scroll } = chunkedPane({ turns: 600, per: 20 });
  for (const px of [0, 1, 500, 12345, 20000, 41999, 42000]) {
    scroll(px);
    probes.turn = 0;
    const got = pane.pinnedTurn();
    let want = -1;
    list.forEach((t, i) => { if (t.y1 - px < 6) want = i; });
    assert.equal(got ? got.n - 1 : -1, want, `scrolled ${px}`);
    assert.ok(probes.turn <= 24, `only the chunk the edge runs through is probed turn by turn (${probes.turn})`);
  }
});

test('app.css: a chunk keeps its margins inside, skips off screen once measured, and gives the doubled gap back', () => {
  const css = fs.readFileSync(new URL('../apaki/ui/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.chunk \{ contain: layout style; padding-bottom: 8px; margin-bottom: -18px; \}/);
  assert.match(css, /\.chunk\.cv \{ content-visibility: auto; \}/);
});
