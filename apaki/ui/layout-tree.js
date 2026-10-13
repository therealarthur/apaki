/**
 * layout-tree.js: the split layout of one Apaki tab, as plain data (no DOM),
 * so it can be tested in Node.
 *
 * A layout is a tree. A leaf holds one pane id; a split holds children laid
 * out in a row (side by side) or a col (stacked), with `sizes` as fractions
 * that add up to 1. Dropping a session on a pane's edge splits that pane;
 * a split never nests inside a split of the same direction (it is flattened),
 * so three panes side by side are one row of three, not a row inside a row.
 *
 * Arthur, 2026-10-09: split view, triple, quad, 5 and 6 panes, stopping at 6,
 * every pane resizable.
 */

export const MAX_PANES = 6;

export const leaf = (pane) => ({ type: 'leaf', pane });

/** Pane ids in reading order. */
export function ids(node) {
  if (!node) return [];
  return node.type === 'leaf' ? [node.pane] : node.children.flatMap(ids);
}

export const count = (node) => ids(node).length;

export const has = (node, id) => ids(node).includes(id);

/** Merges splits that sit inside a split of the same direction. */
export function flatten(node) {
  if (!node || node.type === 'leaf') return node;
  const children = [];
  const sizes = [];
  node.children.forEach((c, i) => {
    const f = flatten(c);
    if (f.type === 'split' && f.dir === node.dir) {
      f.children.forEach((cc, j) => { children.push(cc); sizes.push(node.sizes[i] * f.sizes[j]); });
    } else {
      children.push(f);
      sizes.push(node.sizes[i]);
    }
  });
  return { ...node, children, sizes };
}

/**
 * A new tree with pane `newId` placed on `edge` ('left' | 'right' | 'top' |
 * 'bottom') of the pane `targetId`. The target gives up half its space, or
 * `share` of it (2026-10-12: a viewer takes less than a conversation). With
 * no tree yet, the new pane becomes the whole layout.
 */
export function insert(root, targetId, newId, edge, share = 0.5) {
  if (!root) return leaf(newId);
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const s = Number.isFinite(share) && share > 0 && share < 1 ? share : 0.5;
  const walk = (node) => {
    if (node.type === 'leaf') {
      if (node.pane !== targetId) return node;
      return { type: 'split', dir, children: before ? [leaf(newId), node] : [node, leaf(newId)], sizes: before ? [s, 1 - s] : [1 - s, s] };
    }
    const idx = node.children.findIndex((c) => c.type === 'leaf' && c.pane === targetId);
    if (idx >= 0 && node.dir === dir) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      const whole = sizes[idx];
      sizes[idx] = whole * (1 - s);
      const at = before ? idx : idx + 1;
      children.splice(at, 0, leaf(newId));
      sizes.splice(at, 0, whole * s);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return flatten(walk(root));
}

/** A new tree without pane `id`; its space goes to its neighbours. */
export function remove(root, id) {
  if (!root) return null;
  if (root.type === 'leaf') return root.pane === id ? null : root;
  const children = [];
  const sizes = [];
  root.children.forEach((c, i) => {
    const n = remove(c, id);
    if (n) { children.push(n); sizes.push(root.sizes[i]); }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return flatten({ ...root, children, sizes: sizes.map((x) => x / total) });
}

/** A new tree with panes `a` and `b` trading places. */
export function swap(root, a, b) {
  return mapLeaves(root, (lf) => (lf.pane === a ? leaf(b) : lf.pane === b ? leaf(a) : lf));
}

/** A copy of the tree with every leaf passed through `fn`. */
export function mapLeaves(node, fn) {
  if (!node) return null;
  if (node.type === 'leaf') return fn(node);
  return { ...node, sizes: [...node.sizes], children: node.children.map((c) => mapLeaves(c, fn)) };
}

/** Equal sizes everywhere. */
export function equalize(node) {
  if (!node || node.type === 'leaf') return node;
  return { ...node, sizes: node.children.map(() => 1 / node.children.length), children: node.children.map(equalize) };
}

/**
 * A balanced layout for these panes: 1, 2 or 3 side by side; 4 as 2 over 2;
 * 5 as 3 over 2; 6 as 3 over 3.
 */
export function grid(list) {
  const n = list.length;
  if (!n) return null;
  const row = (xs) => (xs.length === 1 ? leaf(xs[0]) : { type: 'split', dir: 'row', children: xs.map(leaf), sizes: xs.map(() => 1 / xs.length) });
  if (n <= 3) return row(list);
  const top = list.slice(0, Math.ceil(n / 2));
  const bottom = list.slice(Math.ceil(n / 2));
  return { type: 'split', dir: 'col', children: [row(top), row(bottom)], sizes: [0.5, 0.5] };
}

/** True when the tree is well formed: fractions add to 1, no empty or single-child split. */
export function valid(node) {
  if (!node) return true;
  if (node.type === 'leaf') return typeof node.pane === 'string';
  if (node.children.length < 2 || node.children.length !== node.sizes.length) return false;
  const total = node.sizes.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) return false;
  return node.children.every((c) => valid(c) && !(c.type === 'split' && c.dir === node.dir));
}
