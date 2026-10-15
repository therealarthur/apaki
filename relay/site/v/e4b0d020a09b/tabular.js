/**
 * tabular.js: data as a table, for the viewer's table (tableview.js). Pure, no DOM, so it is tested on its own
 * (test/apaki-viewers.test.js).
 *
 * WHY (Arthur, 2026-10-13: spreadsheets in the viewer, like ChatGPT's side window): CSV, TSV, JSON records and
 * spreadsheet sheets all become one shape, { columns: string[], rows: string[][] }, which the table draws, sorts,
 * filters and copies as TSV. Untrusted files are parsed defensively: a cap on rows and columns, quotes per RFC 4180,
 * nothing evaluated.
 */

export const MAX_ROWS = 200000;
export const MAX_COLS = 400;
const MAX_CELL = 32768;

/**
 * Parses delimited text (RFC 4180 quoting: "a, b", "say ""hi""", line breaks inside quotes) into rows of strings.
 * delim ',' or '\t' (or any one character); null guesses from the first lines. Returns { rows, delim, truncated }.
 */
export function parseDelimited(text, delim = null, { maxRows = MAX_ROWS, maxCols = MAX_COLS } = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = delim || guessDelimiter(s);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  const n = s.length;
  let i = 0;
  const endCell = () => { if (row.length < maxCols) row.push(cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell); else truncated = true; cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  while (i < n) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      // A quote that never closes would swallow the file: a cell longer than the cap ends it at the line.
      if (cell.length > MAX_CELL && (c === '\n' || c === '\r')) { quoted = false; continue; }
      cell += c; i += 1; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i += 1; continue; }
    if (c === d) { endCell(); i += 1; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      i += 1;
      if (rows.length >= maxRows) { truncated = i < n; break; }
      continue;
    }
    cell += c; i += 1;
  }
  if (i >= n && (cell !== '' || row.length)) endRow();
  return { rows, delim: d, truncated };
}

/** The delimiter of some delimited text: tab, semicolon, pipe or comma, by which splits the first lines most evenly. */
export function guessDelimiter(text) {
  const lines = String(text ?? '').split(/\r?\n/, 6).filter((l) => l.length);
  if (!lines.length) return ',';
  let best = ',';
  let bestScore = 0;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    if (min <= 0) continue;
    const same = counts.every((c) => c === counts[0]);
    const score = min + (same ? 100 : 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const NUM_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/;
/** The number a cell holds ("1,234.5", "-3", "12%", "$4.20"), or NaN. */
export function cellNumber(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/^[$€£¥]/, '').replace(/^\((.*)\)$/, '-$1');
  if (!s || !/\d/.test(s) || !NUM_RE.test(s)) return NaN;
  return Number(s.replace(/,/g, '').replace(/%$/, ''));
}

/**
 * Whether the first row of a grid is a header: every cell is filled, none of it is a number, and either a later row
 * has a number in some column or the first row's cells are all different. Spreadsheets without one get A, B, C.
 */
export function looksLikeHeader(rows) {
  if (!rows?.length) return false;
  const first = rows[0];
  if (!first.length || first.some((c) => String(c ?? '').trim() === '' || Number.isFinite(cellNumber(c)))) return false;
  if (rows.length === 1) return true;
  const sample = rows.slice(1, 50);
  const numericBelow = first.some((_, ci) => sample.some((r) => Number.isFinite(cellNumber(r[ci]))));
  return numericBelow || new Set(first.map((c) => String(c).trim().toLowerCase())).size === first.length;
}

/** Spreadsheet column names: A, B, ... Z, AA, AB ... */
export function columnLetters(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * A grid of cells as a table: the first row is the header when it looks like one (or when `header` says so),
 * otherwise A, B, C. Short rows are padded; every cell becomes a string.
 */
export function tableFromRows(rows, { header = null } = {}) {
  const grid = (rows || []).map((r) => (Array.isArray(r) ? r : [r]));
  const width = Math.min(MAX_COLS, grid.reduce((n, r) => Math.max(n, r.length), 0));
  const useHeader = header ?? looksLikeHeader(grid);
  const head = useHeader ? grid[0] : null;
  const body = useHeader ? grid.slice(1) : grid;
  const seen = new Map();
  const columns = Array.from({ length: width }, (_, i) => {
    let name = head ? String(head[i] ?? '').trim() : '';
    if (!name) name = columnLetters(i);
    // Two columns with one name stay told apart.
    const k = name.toLowerCase();
    const count = seen.get(k) || 0;
    seen.set(k, count + 1);
    return count ? `${name} (${count + 1})` : name;
  });
  const out = body.map((r) => Array.from({ length: width }, (_, i) => cellText(r[i])));
  return { columns, rows: out, header: Boolean(useHeader) };
}

/** A cell as text: numbers as they are, dates as ISO, objects as JSON, nothing as empty. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  try { const j = JSON.stringify(v); return j.length > MAX_CELL ? j.slice(0, MAX_CELL) : j; } catch { return String(v); }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * Whether parsed JSON is tabular: an array of records (objects whose values are mostly plain values) or an array of
 * rows (arrays of plain values), with at least one item. A record table may hold some nested values; they show as JSON.
 */
export function isTabularJson(v) {
  if (!Array.isArray(v) || !v.length) return false;
  const sample = v.length > 400 ? [...v.slice(0, 200), ...v.slice(-200)] : v;
  if (sample.every(isRecord)) {
    let scalars = 0;
    let total = 0;
    for (const r of sample) for (const k of Object.keys(r)) { total += 1; if (isScalar(r[k])) scalars += 1; }
    return total > 0 && scalars / total >= 0.6;
  }
  if (sample.every((r) => Array.isArray(r) && r.every(isScalar))) return true;
  return false;
}

/** Tabular JSON as a table: records get one column per key (in first-seen order), rows of arrays use the header rule. */
export function tableFromJson(v) {
  if (!isTabularJson(v)) return null;
  if (Array.isArray(v[0])) return tableFromRows(v.slice(0, MAX_ROWS + 1));
  const keys = [];
  const seen = new Set();
  for (const r of v.slice(0, MAX_ROWS)) {
    for (const k of Object.keys(r)) {
      if (seen.has(k) || keys.length >= MAX_COLS) continue;
      seen.add(k);
      keys.push(k);
    }
  }
  return { columns: keys, rows: v.slice(0, MAX_ROWS).map((r) => keys.map((k) => cellText(r[k]))), header: true };
}

/** JSON Lines text as an array (one value per non-empty line); throws on a bad line, with its number. */
export function parseJsonLines(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < MAX_ROWS; i += 1) {
    const l = lines[i].trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch (e) { throw new Error(`Line ${i + 1} is not JSON (${String(e.message || e).slice(0, 80)}).`); }
  }
  return out;
}

/**
 * A comparison for sorting one column: numbers by value when both cells hold one, empty cells last, text by
 * natural order ("item 2" before "item 10").
 */
const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
export function compareCells(a, b) {
  const ea = a === '' || a === null || a === undefined;
  const eb = b === '' || b === null || b === undefined;
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
  return collator ? collator.compare(String(a), String(b)) : String(a).localeCompare(String(b));
}

/**
 * The order rows show in: indexes into `rows`, filtered by `filter` (every word must appear in some cell of the row,
 * case-insensitive) and sorted by column `sort.col` (`sort.dir` 1 or -1; a stable sort, empty cells last either way).
 */
export function viewOrder(rows, { filter = '', sort = null } = {}) {
  const words = String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  let idx = [];
  if (!words.length) idx = Array.from({ length: rows.length }, (_, i) => i);
  else {
    for (let i = 0; i < rows.length; i += 1) {
      const line = rows[i].join('\u0001').toLowerCase();
      if (words.every((w) => line.includes(w))) idx.push(i);
    }
  }
  if (sort && Number.isInteger(sort.col) && (sort.dir === 1 || sort.dir === -1)) {
    const c = sort.col;
    const keyed = idx.map((i) => {
      const v = rows[i][c] ?? '';
      const n = cellNumber(v);
      return { i, v, n, e: v === '' };
    });
    keyed.sort((a, b) => {
      if (a.e || b.e) return a.e === b.e ? a.i - b.i : a.e ? 1 : -1;
      let d;
      if (Number.isFinite(a.n) && Number.isFinite(b.n)) d = a.n - b.n;
      else if (Number.isFinite(a.n) !== Number.isFinite(b.n)) d = Number.isFinite(a.n) ? -1 : 1;
      else d = collator ? collator.compare(a.v, b.v) : String(a.v).localeCompare(String(b.v));
      return d * sort.dir || a.i - b.i;
    });
    idx = keyed.map((k) => k.i);
  }
  return idx;
}

/**
 * Column widths in pixels that fit their contents: `measure(text)` gives a text's width; a sample of rows is
 * measured (the first 300 and some spread through the rest), plus the header, within [min, max].
 */
export function columnWidths(columns, rows, measure, { min = 56, max = 360, pad = 24, sample = 300 } = {}) {
  const pick = [];
  for (let i = 0; i < Math.min(rows.length, sample); i += 1) pick.push(rows[i]);
  if (rows.length > sample) {
    const step = Math.max(1, Math.floor((rows.length - sample) / 200));
    for (let i = sample; i < rows.length && pick.length < sample + 200; i += step) pick.push(rows[i]);
  }
  return columns.map((name, c) => {
    // The header has a sort mark beside it.
    let w = measure(String(name)) + 18;
    for (const r of pick) {
      const v = String(r[c] ?? '');
      if (!v) continue;
      w = Math.max(w, measure(v.length > 80 ? v.slice(0, 80) : v));
      if (w >= max) break;
    }
    return Math.round(Math.min(max, Math.max(min, w + pad)));
  });
}

/** Which columns hold numbers (most filled cells are numbers): they align right. */
export function numericColumns(columns, rows, sample = 200) {
  return columns.map((_, c) => {
    let filled = 0;
    let nums = 0;
    for (let i = 0; i < Math.min(rows.length, sample); i += 1) {
      const v = rows[i][c];
      if (v === '' || v === undefined) continue;
      filled += 1;
      if (Number.isFinite(cellNumber(v))) nums += 1;
    }
    return filled > 0 && nums / filled >= 0.8;
  });
}

/** Rows as tab-separated text (a header line first), for the clipboard: tabs and line breaks inside cells become spaces. */
export function toTSV(columns, rows, order = null) {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const lines = [columns.map(clean).join('\t')];
  const idx = order || rows.map((_, i) => i);
  for (const i of idx) lines.push(rows[i].map(clean).join('\t'));
  return lines.join('\n');
}

/** Rows as CSV text (RFC 4180 quoting), for saving a filtered table. */
export function toCSV(columns, rows, order = null) {
  const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [columns.map(q).join(',')];
  const idx = order || rows.map((_, i) => i);
  for (const i of idx) lines.push(rows[i].map(q).join(','));
  return lines.join('\r\n');
}

/**
 * Every match of `q` in the table, in the order rows show: [{ r (position in `order`), c }]. Used by Ctrl+F in a
 * table, which is drawn a screenful at a time so the page's own find cannot see it. At most `limit` matches.
 */
export function findCells(columns, rows, order, q, { matchCase = false, limit = 10000 } = {}) {
  if (!q) return [];
  const needle = matchCase ? q : q.toLowerCase();
  const out = [];
  for (let r = 0; r < order.length && out.length < limit; r += 1) {
    const row = rows[order[r]];
    for (let c = 0; c < columns.length; c += 1) {
      const v = String(row[c] ?? '');
      if ((matchCase ? v : v.toLowerCase()).includes(needle)) { out.push({ r, c }); if (out.length >= limit) break; }
    }
  }
  return out;
}
