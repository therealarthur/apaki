/**
 * textdiff.js: what changed between two revisions of a text artifact, line by line (the viewer's "Changes").
 *
 * WHY (Arthur, 2026-10-13: viewers like ChatGPT's canvas): every show with an id and every edit of yours is a new
 * revision; Changes shows the difference from the revision before, in the same red and green blocks as a worktree's
 * diff (worktree.js patchHtml draws what diffPatch returns). Pure, no DOM; tested in test/apaki-viewers.test.js.
 *
 * Myers' O(ND) algorithm on lines, after cutting the common start and end. Bounded for untrusted sizes: past
 * MAX_LINES lines or MAX_EDITS differences the middle is shown as all removed and all added, which is still true.
 */

export const MAX_LINES = 200000;
export const MAX_EDITS = 2000;

/** Splits text into lines (\n, \r\n or \r), without the trailing empty line a final newline makes. */
export function splitLines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const lines = s.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The shortest edit from lines a to lines b: [{ t: 'ctx' | 'del' | 'add', text }]. */
export function lineDiff(a, b) {
  const A = Array.isArray(a) ? a : splitLines(a);
  const B = Array.isArray(b) ? b : splitLines(b);
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start += 1;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA -= 1; endB -= 1; }
  const head = A.slice(0, start).map((text) => ({ t: 'ctx', text }));
  const tail = A.slice(endA).map((text) => ({ t: 'ctx', text }));
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  let mid = null;
  if (midA.length + midB.length <= MAX_LINES) mid = myers(midA, midB, MAX_EDITS);
  if (!mid) mid = [...midA.map((text) => ({ t: 'del', text })), ...midB.map((text) => ({ t: 'add', text }))];
  return [...head, ...mid, ...tail];
}

/** Myers' greedy diff; null when it needs more than maxD edits. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ t: 'add', text }));
  if (!m) return a.map((text) => ({ t: 'del', text }));
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d += 1) {
    // Only the diagonals step d can read (k - 1 to k + 1 for k in -d..d), so the trace grows with d squared, not d times n.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, dEnd) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d -= 1) {
    const at = (k) => trace[d][k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ t: 'ctx', text: a[x - 1] }); x -= 1; y -= 1; }
    if (x === prevX) out.push({ t: 'add', text: b[y - 1] }); else out.push({ t: 'del', text: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { out.push({ t: 'ctx', text: a[x - 1] }); x -= 1; y -= 1; }
  return out.reverse();
}

/**
 * The difference as a patch the diff viewer draws (worktree.js patchHtml): { binary: false, hunks: [{ header,
 * lines: [{ t, n, text }] }], added, removed }. `context` unchanged lines are kept around each change.
 */
export function diffPatch(before, after, { context = 3, lineMax = 2000 } = {}) {
  const ops = lineDiff(before, after);
  let added = 0;
  let removed = 0;
  // Line numbers in the old and new text for every op.
  let na = 1;
  let nb = 1;
  const rows = ops.map((o) => {
    const r = { ...o, a: na, b: nb };
    if (o.t === 'ctx') { na += 1; nb += 1; } else if (o.t === 'del') { na += 1; removed += 1; } else { nb += 1; added += 1; }
    return r;
  });
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.t === 'ctx') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j += 1) keep[j] = 1;
  });
  const hunks = [];
  let cur = null;
  rows.forEach((r, i) => {
    if (!keep[i]) { cur = null; return; }
    if (!cur) { cur = { rows: [] }; hunks.push(cur); }
    cur.rows.push(r);
  });
  return {
    binary: false,
    added,
    removed,
    hunks: hunks.map((h) => {
      const first = h.rows[0];
      const lenA = h.rows.filter((r) => r.t !== 'add').length;
      const lenB = h.rows.filter((r) => r.t !== 'del').length;
      return {
        header: `@@ -${lenA ? first.a : first.a - 1},${lenA} +${lenB ? first.b : first.b - 1},${lenB} @@`,
        lines: h.rows.map((r) => ({ t: r.t, n: r.t === 'del' ? r.a : r.b, text: String(r.text).slice(0, lineMax) })),
      };
    }),
  };
}
