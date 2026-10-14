/**
 * tableview.js: a table of data in the viewer: CSV, TSV, JSON records, a sheet of a workbook, a chart's numbers
 * (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: "spreadsheets" in the viewer, like ChatGPT's side window): a sticky header, click a
 * column to sort it (up, down, as it was), a filter box (the viewer's toolbar), widths that fit the contents and can
 * be dragged, a row count, numbers aligned right. Rows are drawn a screenful at a time (only what is in view, plus a
 * margin), so 100,000 rows scroll as fast as 100; the row number column stays put while you scroll sideways.
 *
 * Because only a screenful exists in the page, Ctrl+F cannot search it the way it searches text: findAdapter() gives
 * find.js a search over the data itself, which scrolls to each match and marks it.
 *
 * The data is { columns: string[], rows: string[][] } (tabular.js); sorting, filtering, widths and TSV are pure
 * functions there, tested on their own.
 */

import { columnWidths, findCells, numericColumns, toCSV, toTSV, viewOrder } from './tabular.js';

const ROW_H = 28;
const OVERSCAN = 12;
const NUM_W = 56;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

let measureCtx = null;
/** A text's width in the table's font (canvas measureText; a guess by length where there is no canvas). */
function measure(text) {
  if (!measureCtx) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
      const body = getComputedStyle(document.body).getPropertyValue('--font-body') || 'system-ui, sans-serif';
      measureCtx.font = `500 13px ${body}`;
    } catch { measureCtx = false; }
  }
  return measureCtx ? measureCtx.measureText(text).width : text.length * 7.2;
}

const SORT_ICON = {
  0: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 4.6 6 2.2l2.5 2.4M3.5 7.4 6 9.8l2.5-2.4"/></svg>',
  1: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 7.2 6 4.2l3 3"/></svg>',
  '-1': '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.8 6 7.8l3-3"/></svg>',
};

export class TableView {
  /** data: { columns, rows }; onChange(view) after a sort or filter (the toolbar's count follows). */
  constructor(data, { onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.el = el('div', 'tv');
    this.el.tabIndex = -1;
    this.scroll = el('div', 'tv-scroll');
    this.head = el('div', 'tv-head');
    this.bodyEl = el('div', 'tv-body');
    this.rowsEl = el('div', 'tv-rows');
    this.bodyEl.append(this.rowsEl);
    this.scroll.append(this.head, this.bodyEl);
    this.el.append(this.scroll);
    this.filterText = '';
    this.sort = null;
    this.range = [-1, -1];
    this.find = null; // { q, matchCase, hits, cur }
    this.scroll.addEventListener('scroll', () => this.queue(), { passive: true });
    this.resize = new ResizeObserver(() => this.queue(true));
    this.resize.observe(this.scroll);
    this.setData(data);
  }

  setData({ columns = [], rows = [] } = {}) {
    this.columns = columns;
    this.rows = rows;
    this.numeric = numericColumns(columns, rows);
    this.widths = columnWidths(columns, rows, measure);
    this.order = viewOrder(rows, { filter: this.filterText, sort: this.sort });
    this.drawHead();
    this.layout();
  }

  /** The columns' widths as the grid's template (the row number column first). */
  layout() {
    const tpl = `${NUM_W}px ${this.widths.map((w) => `${w}px`).join(' ')}`;
    this.el.style.setProperty('--tv-cols', tpl);
    this.el.style.setProperty('--tv-width', `${NUM_W + this.widths.reduce((n, w) => n + w, 0)}px`);
    this.bodyEl.style.height = `${this.order.length * ROW_H}px`;
    this.range = [-1, -1];
    this.queue(true);
  }

  drawHead() {
    const cells = [el('div', 'tv-c tv-n tv-corner', '#')];
    this.columns.forEach((name, c) => {
      const cell = el('div', `tv-c tv-h${this.numeric[c] ? ' num' : ''}`);
      const b = el('button', 'tv-sort');
      b.type = 'button';
      const dir = this.sort?.col === c ? this.sort.dir : 0;
      b.innerHTML = `<span class="tv-hn"></span>${SORT_ICON[dir]}`;
      b.querySelector('.tv-hn').textContent = name;
      b.title = `${name}: sort ${dir === 1 ? 'descending' : dir === -1 ? 'as it was' : 'ascending'}`;
      b.classList.toggle('on', dir !== 0);
      b.onclick = () => this.sortBy(c);
      const grip = el('span', 'tv-grip');
      grip.title = 'Drag to resize; double-click to fit';
      grip.addEventListener('pointerdown', (e) => this.dragWidth(e, c));
      grip.addEventListener('dblclick', () => { this.widths[c] = columnWidths([name], this.rows.map((r) => [r[c]]), measure)[0]; this.layout(); });
      cell.append(b, grip);
      cells.push(cell);
    });
    this.head.replaceChildren(...cells);
  }

  dragWidth(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = this.widths[c];
    const t = e.target;
    t.setPointerCapture?.(e.pointerId);
    const move = (ev) => { this.widths[c] = Math.max(40, Math.min(1200, w0 + ev.clientX - x0)); this.layout(); };
    const up = () => { t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
    t.addEventListener('pointercancel', up);
  }

  /** Sorts by column c: ascending, then descending, then the file's own order. */
  sortBy(c) {
    const dir = this.sort?.col === c ? this.sort.dir : 0;
    this.sort = dir === 0 ? { col: c, dir: 1 } : dir === 1 ? { col: c, dir: -1 } : null;
    this.reorder();
  }

  /** Keeps rows that have every word of `q` somewhere. */
  setFilter(q) {
    this.filterText = String(q || '');
    this.reorder();
  }

  reorder() {
    this.order = viewOrder(this.rows, { filter: this.filterText, sort: this.sort });
    this.drawHead();
    if (this.find) this.runFind(this.find.q, this.find.matchCase);
    this.layout();
    this.scroll.scrollTop = Math.min(this.scroll.scrollTop, Math.max(0, this.order.length * ROW_H - this.scroll.clientHeight));
    this.onChange(this);
  }

  queue(force = false) {
    if (force) this.range = [-1, -1];
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  /** Draws the rows in view (and a margin) when the range changed. */
  draw() {
    const top = Math.max(0, this.scroll.scrollTop - this.head.offsetHeight);
    const h = this.scroll.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(this.order.length, Math.ceil((top + h) / ROW_H) + OVERSCAN);
    if (first === this.range[0] && last === this.range[1]) return;
    this.range = [first, last];
    const hitRows = this.find?.byRow;
    const cur = this.find?.hits[this.find.cur];
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r += 1) {
      const src = this.rows[this.order[r]];
      const row = el('div', `tv-r${r % 2 ? ' odd' : ''}`);
      row.style.transform = `translateY(${r * ROW_H}px)`;
      row.append(el('div', 'tv-c tv-n', String(this.order[r] + 1)));
      const hits = hitRows?.get(r);
      for (let c = 0; c < this.columns.length; c += 1) {
        const v = src[c] ?? '';
        const cell = el('div', `tv-c${this.numeric[c] ? ' num' : ''}`);
        if (hits?.has(c)) {
          cell.classList.add('hit');
          if (cur && cur.r === r && cur.c === c) cell.classList.add('cur');
          markInto(cell, v, this.find.q, this.find.matchCase, cur && cur.r === r && cur.c === c);
        } else cell.textContent = v;
        if (v.length > 24) cell.title = v.length > 600 ? `${v.slice(0, 600)}…` : v;
        row.append(cell);
      }
      frag.append(row);
    }
    this.rowsEl.replaceChildren(frag);
  }

  /** How many rows show, and of how many. */
  counts() { return { shown: this.order.length, total: this.rows.length, columns: this.columns.length }; }

  /** The rows as they show (filtered and sorted) as TSV or CSV, with the header. */
  tsv() { return toTSV(this.columns, this.rows, this.order); }
  csv() { return toCSV(this.columns, this.rows, this.order); }

  /* Ctrl+F (find.js findAdapter). */

  runFind(q, matchCase) {
    const hits = findCells(this.columns, this.rows, this.order, q, { matchCase });
    const byRow = new Map();
    for (const h of hits) { if (!byRow.has(h.r)) byRow.set(h.r, new Set()); byRow.get(h.r).add(h.c); }
    const keep = this.find && this.find.q === q ? Math.min(this.find.cur, hits.length - 1) : -1;
    this.find = { q, matchCase, hits, byRow, cur: keep };
    return hits.length;
  }

  /** find.js drives the table through this: run a search, step to a match, clear. */
  findAdapter() {
    return {
      run: (q, matchCase) => {
        if (!q) { this.find = null; this.queue(true); return { count: 0, cur: -1 }; }
        const n = this.runFind(q, matchCase);
        // The first match at or below the top row in view.
        const top = Math.floor(this.scroll.scrollTop / ROW_H);
        const below = this.find.hits.findIndex((h) => h.r >= top);
        this.find.cur = n ? (below >= 0 ? below : 0) : -1;
        this.reveal();
        return { count: n, cur: this.find.cur };
      },
      select: (i) => { if (!this.find?.hits.length) return; this.find.cur = i; this.reveal(); },
      clear: () => { this.find = null; this.queue(true); },
    };
  }

  /** Scrolls the current match into the middle of the view (and its column into view) and redraws the marks. */
  reveal() {
    const h = this.find?.hits[this.find.cur];
    if (h) {
      const y = h.r * ROW_H - (this.scroll.clientHeight - ROW_H) / 2;
      this.scroll.scrollTop = Math.max(0, y);
      let x = NUM_W;
      for (let c = 0; c < h.c; c += 1) x += this.widths[c];
      const w = this.widths[h.c];
      if (x < this.scroll.scrollLeft + NUM_W || x + w > this.scroll.scrollLeft + this.scroll.clientWidth) this.scroll.scrollLeft = Math.max(0, x - NUM_W - 24);
    }
    this.queue(true);
  }

  destroy() {
    this.resize.disconnect();
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}

/** A cell's text with every match of q marked (the current one stronger), as find.js marks text elsewhere. */
function markInto(cell, text, q, matchCase, isCur) {
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? q : q.toLowerCase();
  let i = hay.indexOf(needle);
  let last = 0;
  while (i >= 0 && needle) {
    if (i > last) cell.append(text.slice(last, i));
    const m = el('mark', `find-hit${isCur ? ' cur' : ''}`, text.slice(i, i + q.length));
    cell.append(m);
    last = i + q.length;
    i = hay.indexOf(needle, last);
  }
  if (last < text.length) cell.append(text.slice(last));
}
