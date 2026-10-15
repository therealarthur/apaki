/**
 * Tests for Myrlin Apaki's split layout (apaki/ui/layout-tree.js): splitting
 * by edge, flattening same-direction splits, removing panes, swapping, the
 * even grid for 1 to 6 panes, and that every tree stays well formed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as L from '../apaki/ui/layout-tree.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the first pane is the whole layout; an edge drop halves the target', () => {
  let r = L.insert(null, null, 'a', 'right');
  assert.deepEqual(r, { type: 'leaf', pane: 'a' });
  r = L.insert(r, 'a', 'b', 'right');
  assert.equal(r.dir, 'row');
  assert.deepEqual(L.ids(r), ['a', 'b']);
  r = L.insert(r, 'a', 'c', 'left');
  assert.deepEqual(L.ids(r), ['c', 'a', 'b']);
  assert.deepEqual(r.sizes, [0.25, 0.25, 0.5]);
  assert.ok(L.valid(r));
});

test('splitting across the direction nests, and the same direction flattens', () => {
  let r = L.insert(L.insert(null, null, 'a', 'right'), 'a', 'b', 'right');
  r = L.insert(r, 'b', 'c', 'bottom');
  assert.equal(r.children[1].dir, 'col');
  assert.deepEqual(L.ids(r), ['a', 'b', 'c']);
  r = L.insert(r, 'c', 'd', 'top');
  assert.deepEqual(L.ids(r.children[1]), ['b', 'd', 'c']);
  assert.ok(L.valid(r));
});

test('removing a pane gives its space away and collapses single-child splits', () => {
  let r = L.grid(['a', 'b', 'c', 'd']);
  r = L.remove(r, 'b');
  assert.deepEqual(L.ids(r), ['a', 'c', 'd']);
  assert.ok(L.valid(r));
  r = L.remove(L.remove(r, 'c'), 'd');
  assert.deepEqual(r, { type: 'leaf', pane: 'a' });
  assert.equal(L.remove(r, 'a'), null);
});

test('removing a middle pane of a row keeps the fractions adding to one', () => {
  const r = L.remove({ type: 'split', dir: 'row', children: ['a', 'b', 'c'].map(L.leaf), sizes: [0.2, 0.5, 0.3] }, 'b');
  assert.ok(near(r.sizes[0], 0.4) && near(r.sizes[1], 0.6));
});

test('removing can merge a nested split into its parent direction', () => {
  // row[ a, col[ b, row[c, d] ] ]: removing b leaves row[c, d] inside a row, which must flatten.
  const r = L.remove({
    type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      L.leaf('a'),
      { type: 'split', dir: 'col', sizes: [0.5, 0.5], children: [L.leaf('b'), { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [L.leaf('c'), L.leaf('d')] }] },
    ],
  }, 'b');
  assert.equal(r.dir, 'row');
  assert.deepEqual(L.ids(r), ['a', 'c', 'd']);
  assert.ok(near(r.sizes[1], 0.25));
  assert.ok(L.valid(r));
});

test('swap trades two panes and keeps the shape', () => {
  const r = L.swap(L.grid(['a', 'b', 'c']), 'a', 'c');
  assert.deepEqual(L.ids(r), ['c', 'b', 'a']);
});

test('the even grid: 1-3 side by side, 4 as 2x2, 5 as 3+2, 6 as 3x3', () => {
  assert.deepEqual(L.grid(['a']), L.leaf('a'));
  assert.equal(L.grid(['a', 'b', 'c']).children.length, 3);
  const shape = (n) => L.grid([...'abcdef'].slice(0, n)).children.map((c) => (c.type === 'leaf' ? 1 : c.children.length));
  assert.deepEqual(shape(4), [2, 2]);
  assert.deepEqual(shape(5), [3, 2]);
  assert.deepEqual(shape(6), [3, 3]);
  for (let n = 1; n <= L.MAX_PANES; n++) assert.ok(L.valid(L.grid([...'abcdef'].slice(0, n))));
  assert.equal(L.MAX_PANES, 6);
});

test('random splits and closes always leave a valid tree', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const edges = ['left', 'right', 'top', 'bottom'];
  let r = null;
  let next = 0;
  for (let i = 0; i < 400; i++) {
    const ids = L.ids(r);
    if (ids.length < L.MAX_PANES && (rand(3) || !ids.length)) r = L.insert(r, ids[rand(ids.length || 1)] ?? null, `p${next++}`, edges[rand(4)]);
    else r = L.remove(r, ids[rand(ids.length)]);
    assert.ok(L.valid(r), JSON.stringify(r));
    assert.ok(L.count(r) <= L.MAX_PANES);
  }
});

// The whole tab's edge (2026-10-15): Arthur, "it should be easier to drag and put a pane underneath two panes above it".
test('insertAtEdge puts a pane across the full width under two panes side by side', () => {
  const two = L.insert(L.leaf('a'), 'a', 'b', 'right');
  const t = L.insertAtEdge(two, 'c', 'bottom');
  assert.equal(t.type, 'split');
  assert.equal(t.dir, 'col');
  assert.deepEqual(t.sizes, [0.5, 0.5]);
  assert.equal(t.children[0].dir, 'row');
  assert.deepEqual(L.ids(t.children[0]), ['a', 'b']);
  assert.deepEqual(t.children[1], L.leaf('c'));
  assert.ok(L.valid(t));
  // Above instead: the new pane first.
  assert.deepEqual(L.ids(L.insertAtEdge(two, 'c', 'top')), ['c', 'a', 'b']);
});

test('insertAtEdge joins a layout that already runs that way as one more equal part', () => {
  const stacked = L.insert(L.leaf('a'), 'a', 'b', 'bottom');
  const t = L.insertAtEdge(stacked, 'c', 'bottom');
  assert.equal(t.dir, 'col');
  assert.deepEqual(L.ids(t), ['a', 'b', 'c']);
  assert.ok(t.sizes.every((x) => Math.abs(x - 1 / 3) < 1e-9));
  assert.ok(L.valid(t));
  // A full-height pane on the left of a 2 over 1 layout wraps it in a row, half and half.
  const twoOverOne = L.insertAtEdge(L.insert(L.leaf('a'), 'a', 'b', 'right'), 'c', 'bottom');
  const left = L.insertAtEdge(twoOverOne, 'd', 'left');
  assert.equal(left.dir, 'row');
  assert.deepEqual(left.sizes, [0.5, 0.5]);
  assert.deepEqual(L.ids(left), ['d', 'a', 'b', 'c']);
  assert.ok(L.valid(left));
});

test('edgeShare says how much room the dropped pane would get, and an empty layout takes the pane whole', () => {
  const two = L.insert(L.leaf('a'), 'a', 'b', 'right');
  assert.equal(L.edgeShare(two, 'bottom'), 0.5);
  assert.equal(L.edgeShare(two, 'right'), 1 / 3);
  assert.deepEqual(L.insertAtEdge(null, 'a', 'left'), L.leaf('a'));
});
