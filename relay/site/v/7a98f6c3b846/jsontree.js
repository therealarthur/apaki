/**
 * jsontree.js: JSON that is not a table, as a tree you fold and unfold (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: viewers like ChatGPT's side window): a config file, an API response or a package.json
 * reads better as a tree than as one long block. Objects and arrays are <details> (so find.js opens the ones that
 * hold a match), the first two levels open; each shows its size when folded. A node with very many children draws
 * the first CHUNK and a "Show more" button; nodes that start folded draw their children when first opened, so a
 * 4 MB file opens at once. Strings, numbers, true, false and null are coloured like code.
 */

const CHUNK = 300;
const OPEN_DEPTH = 2;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const plural = (n, w) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

/** The tree for a parsed JSON value. openDepth: levels open at first. */
export function renderJsonTree(value, { openDepth = OPEN_DEPTH } = {}) {
  const root = el('div', 'jt');
  root.append(node(null, value, 0, openDepth));
  return root;
}

/** Opens every node (Expand all), drawing children as it goes, up to `limit` nodes so a huge file cannot hang. */
export function expandAll(root, limit = 20000) {
  let n = 0;
  const walk = (d) => {
    if (n++ > limit) return;
    d.ensure?.();
    if (!d.open) d.open = true;
    for (const more of d.querySelectorAll(':scope > .jt-kids > .jt-more')) more.click();
    for (const c of d.querySelectorAll(':scope > .jt-kids > details')) walk(c);
  };
  for (const d of root.querySelectorAll(':scope > details')) walk(d);
}

/** Folds every node but the top one. */
export function collapseAll(root) {
  for (const d of root.querySelectorAll('details details')) d.open = false;
}

function leafValue(v) {
  if (v === null) return el('span', 'jt-v jt-null', 'null');
  if (typeof v === 'string') return el('span', 'jt-v jt-str', JSON.stringify(v));
  if (typeof v === 'number') return el('span', 'jt-v jt-num', String(v));
  if (typeof v === 'boolean') return el('span', 'jt-v jt-bool', String(v));
  return el('span', 'jt-v', String(v));
}

function keyEl(key) {
  if (key === null) return null;
  return el('span', typeof key === 'number' ? 'jt-k jt-i' : 'jt-k', typeof key === 'number' ? String(key) : JSON.stringify(key));
}

function node(key, value, depth, openDepth) {
  const isArr = Array.isArray(value);
  if (value === null || typeof value !== 'object') {
    const row = el('div', 'jt-leaf');
    const k = keyEl(key);
    if (k) row.append(k, el('span', 'jt-p', ': '));
    row.append(leafValue(value));
    return row;
  }
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const d = el('details', 'jt-node');
  const sum = el('summary');
  const k = keyEl(key);
  if (k) sum.append(k, el('span', 'jt-p', ': '));
  sum.append(el('span', 'jt-p', isArr ? '[' : '{'), el('span', 'jt-sum', isArr ? plural(entries.length, 'item') : plural(entries.length, 'key')), el('span', 'jt-p jt-close', isArr ? ']' : '}'));
  d.append(sum);
  const kids = el('div', 'jt-kids');
  d.append(kids);
  let drawn = 0;
  const drawMore = () => {
    const end = Math.min(entries.length, drawn + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = drawn; i < end; i += 1) frag.append(node(entries[i][0], entries[i][1], depth + 1, openDepth));
    drawn = end;
    kids.querySelector(':scope > .jt-more')?.remove();
    kids.append(frag);
    if (drawn < entries.length) {
      const more = el('button', 'jt-more', `Show ${Math.min(CHUNK, entries.length - drawn).toLocaleString('en-US')} more of ${plural(entries.length - drawn, isArr ? 'item' : 'key')}`);
      more.type = 'button';
      more.onclick = (e) => { e.preventDefault(); drawMore(); };
      kids.append(more);
    }
  };
  // Drawn now when it starts open, else when first opened (by a click, or by Expand all through ensure()).
  d.ensure = () => { if (!drawn) drawMore(); };
  if (depth < openDepth) { d.open = true; drawMore(); } else d.addEventListener('toggle', () => { if (d.open) d.ensure(); });
  if (!entries.length) { d.classList.add('empty'); sum.querySelector('.jt-sum').textContent = 'empty'; }
  return d;
}
