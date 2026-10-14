/**
 * Viewers like ChatGPT's side window (2026-10-13; Arthur: "literally exactly everything chatgpt's window could
 * display and allow the session to do"). The pure parts, no browser:
 *
 *   - which viewer draws what (apaki/ui/viewkind.js): kinds, extensions, language hints, download names;
 *   - data as tables (tabular.js): CSV quoting, TSV, header detection, JSON records, sorting, filtering, widths,
 *     TSV and CSV out, find over the data;
 *   - chart specs (chartspec.js): every type, the errors Claude gets, ticks and number formats, the data table;
 *   - the Changes view's line diff (textdiff.js) and the code viewer's line splitting (codeview.js);
 *   - a Word document's links and pictures (docview.js safeHref, safeImageSrc);
 *   - the store (engine artifacts.js): text with a language, charts, workbooks and documents, the user's edits;
 *   - the tools (apaki-tools.js): show's language field, view_read through a real MCP client, the note when a show
 *     replaces an unread edit, the UserPromptSubmit hook;
 *   - policy: the viewer's writes are PC only, view_read is kept for restricted phones;
 *   - the phone build carries the vendored libraries without fetching them up front.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { EDITABLE_KINDS, GRAMMARS, extOfLang, fileNameFor, langOfName, normLang, viewOf } from '../apaki/ui/viewkind.js';
import {
  cellNumber, columnLetters, columnWidths, findCells, guessDelimiter, isTabularJson, looksLikeHeader, numericColumns, parseDelimited,
  parseJsonLines, tableFromJson, tableFromRows, toCSV, toTSV, viewOrder,
} from '../apaki/ui/tabular.js';
import { CHART_TYPES, MAX_SERIES, chartTable, fmtNum, niceTicks, normalizeChart, timeOf, timeTicks } from '../apaki/ui/chartspec.js';
import { diffPatch, lineDiff, splitLines } from '../apaki/ui/textdiff.js';
import { splitHighlighted } from '../apaki/ui/codeview.js';
import { safeHref, safeImageSrc } from '../apaki/ui/docview.js';
import { ArtifactStore, MAX_TEXT_BYTES, SHOW_KINDS, kindOfExt, revKind, sniffOffice } from '../apaki/engine/artifacts.js';
import { createApakiTools, showShape, viewReadShape } from '../apaki/engine/apaki-tools.js';
import { CAP_BLOCKED_TOOLS, PC_ONLY_OPS, PHONE_OPS, capBlocksTool, checkPhoneCommand } from '../apaki/engine/remote-policy.js';
import { build } from '../apaki/scripts/build-web.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-viewers-'));
const SID = '11111111-2222-3333-4444-555555555555';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/* ---------- which viewer draws what ---------- */

test('viewOf: kinds draw as themselves; text goes by the language hint, then the extension, then the title', () => {
  for (const k of ['html', 'markdown', 'svg', 'image', 'pdf', 'sheet', 'docx', 'chart']) assert.equal(viewOf({ kind: k }).view, k);
  assert.deepEqual(viewOf({ kind: 'text', ext: 'py' }), { view: 'code', lang: 'python', grammar: 'python', label: 'Python', wrap: false });
  assert.equal(viewOf({ kind: 'text', ext: 'tsx' }).grammar, 'typescript');
  assert.equal(viewOf({ kind: 'text', ext: 'txt', lang: 'rust' }).grammar, 'rust', 'the hint wins over the extension');
  assert.equal(viewOf({ kind: 'text', ext: 'toml' }).grammar, 'ini');
  assert.equal(viewOf({ kind: 'text', ext: 'ps1' }).label, 'PowerShell');
  assert.equal(viewOf({ kind: 'text', ext: 'html' }).grammar, 'xml');
  const csv = viewOf({ kind: 'text', ext: 'csv' });
  assert.equal(csv.view, 'table');
  assert.equal(csv.delim, ',');
  assert.equal(viewOf({ kind: 'text', ext: 'tsv' }).delim, '\t');
  assert.equal(viewOf({ kind: 'text', ext: 'txt', lang: 'csv' }).view, 'table');
  assert.equal(viewOf({ kind: 'text', ext: 'json' }).view, 'json');
  assert.equal(viewOf({ kind: 'text', ext: 'jsonl' }).lines, true);
  assert.equal(viewOf({ kind: 'text', ext: 'txt', title: 'Dockerfile' }).grammar, 'dockerfile');
  // Plain text wraps; code does not; an unknown language keeps its name as the label, with line numbers.
  assert.equal(viewOf({ kind: 'text', ext: 'txt' }).wrap, true);
  assert.equal(viewOf({ kind: 'text', ext: 'go' }).wrap, false);
  assert.deepEqual(viewOf({ kind: 'text', ext: 'txt', lang: 'haskell' }), { view: 'code', lang: null, grammar: null, label: 'haskell', wrap: false });
  // Older records (no kind on a revision) still resolve.
  assert.equal(viewOf({}).view, 'code');
});

test('languages: aliases, extensions, every grammar vendored, download names', () => {
  assert.equal(normLang('Python'), 'python');
  assert.equal(normLang('ts'), 'typescript');
  assert.equal(normLang('C++'), 'cpp');
  assert.equal(normLang('c#'), 'csharp');
  assert.equal(normLang('shell'), 'bash');
  assert.equal(normLang('yml'), 'yaml');
  assert.equal(normLang('.rs'), 'rust');
  assert.equal(normLang('klingon'), null);
  assert.equal(normLang('x'.repeat(50)), null);
  assert.equal(extOfLang('python'), 'py');
  assert.equal(extOfLang('TypeScript'), 'ts');
  assert.equal(extOfLang('csv'), 'csv');
  assert.equal(extOfLang('nope'), null);
  assert.equal(langOfName('C:\\x\\Makefile'), 'makefile');
  assert.equal(langOfName('a/b/main.go'), 'go');
  for (const g of GRAMMARS) assert.ok(fs.existsSync(path.join(ROOT, 'apaki', 'ui', 'vendor', 'highlight', 'languages', `${g}.min.js`)), `grammar ${g} is vendored`);
  for (const f of ['highlight/LICENSE', 'highlight/core.min.js', 'sheetjs/LICENSE', 'sheetjs/xlsx.core.min.js', 'mammoth/LICENSE', 'mammoth/NOTICE', 'mammoth/mammoth.browser.min.js']) assert.ok(fs.existsSync(path.join(ROOT, 'apaki', 'ui', 'vendor', f)), f);
  assert.equal(fileNameFor({ title: 'Report', ext: 'md' }), 'Report.md');
  assert.equal(fileNameFor({ title: 'data.csv', ext: 'csv' }), 'data.csv');
  assert.equal(fileNameFor({ title: 'a/b:c*?', ext: 'py' }), 'a b c.py');
  assert.equal(fileNameFor({ title: '', ext: '' }), 'artifact.txt');
  assert.deepEqual([...EDITABLE_KINDS].sort(), ['markdown', 'text']);
});

/* ---------- tables ---------- */

test('CSV: RFC 4180 quoting, doubled quotes, line breaks in quotes, CRLF, a BOM, no phantom last row', () => {
  const r = parseDelimited('\uFEFFname,note,n\r\n"Lee, Sam","said ""hi""",1\r\n"two\nlines",,2\r\n');
  assert.equal(r.delim, ',');
  assert.deepEqual(r.rows, [['name', 'note', 'n'], ['Lee, Sam', 'said "hi"', '1'], ['two\nlines', '', '2']]);
  assert.equal(r.truncated, false);
  assert.deepEqual(parseDelimited('a,b\n1,2').rows, [['a', 'b'], ['1', '2']], 'no final newline');
  assert.deepEqual(parseDelimited('a\tb c\n1\t2\n').rows, [['a', 'b c'], ['1', '2']], 'TSV is guessed');
  assert.equal(guessDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(guessDelimiter('a|b\n1|2'), '|');
  assert.equal(guessDelimiter('just text'), ',');
  const cut = parseDelimited('a\n1\n2\n3\n', ',', { maxRows: 2 });
  assert.equal(cut.rows.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal(parseDelimited('a,b,c,d', ',', { maxCols: 2 }).rows[0].length, 2);
  // An unclosed quote does not swallow the whole file past the cell cap.
  const huge = `"${'x'.repeat(40000)}\nnext,row\n`;
  assert.ok(parseDelimited(huge).rows.length >= 2);
});

test('tables: header detection, A B C columns, JSON records and rows, JSON Lines', () => {
  assert.equal(looksLikeHeader([['region', 'orders'], ['North', '12']]), true);
  assert.equal(looksLikeHeader([['1', '2'], ['3', '4']]), false);
  assert.equal(looksLikeHeader([['a', ''], ['b', 'c']]), false);
  assert.equal(columnLetters(0), 'A');
  assert.equal(columnLetters(25), 'Z');
  assert.equal(columnLetters(26), 'AA');
  const t = tableFromRows([['x', 'x', 'y'], ['1', '2', '3'], ['4']]);
  assert.deepEqual(t.columns, ['x', 'x (2)', 'y']);
  assert.deepEqual(t.rows, [['1', '2', '3'], ['4', '', '']]);
  assert.deepEqual(tableFromRows([['1', '2'], ['3', '4']]).columns, ['A', 'B']);
  assert.equal(isTabularJson([{ a: 1, b: 'x' }, { a: 2, c: true }]), true);
  assert.equal(isTabularJson([[1, 2], [3, 4]]), true);
  assert.equal(isTabularJson({ a: 1 }), false);
  assert.equal(isTabularJson([]), false);
  assert.equal(isTabularJson([1, 2, 3]), false);
  assert.equal(isTabularJson([{ deep: { a: { b: 1 } }, more: [1] }]), false, 'mostly nested: a tree reads better');
  const j = tableFromJson([{ a: 1, b: 'x' }, { a: 2, c: { d: 1 } }]);
  assert.deepEqual(j.columns, ['a', 'b', 'c']);
  assert.deepEqual(j.rows, [['1', 'x', ''], ['2', '', '{"d":1}']]);
  assert.deepEqual(parseJsonLines('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => parseJsonLines('{"a":1}\nnope'), /Line 2/);
});

test('tables: numbers, sorting (numbers by value, empties last, stable), filtering by every word, widths, TSV, CSV, find', () => {
  assert.equal(cellNumber('1,234.5'), 1234.5);
  assert.equal(cellNumber('$4.20'), 4.2);
  assert.equal(cellNumber('12%'), 12);
  assert.equal(cellNumber('(3)'), -3);
  assert.ok(Number.isNaN(cellNumber('v1.2')));
  assert.ok(Number.isNaN(cellNumber('')));
  const rows = [['b', '10'], ['a', '9'], ['c', ''], ['a', '100'], ['item 10', '1'], ['item 2', '1']];
  assert.deepEqual(viewOrder(rows, { sort: { col: 1, dir: 1 } }), [4, 5, 1, 0, 3, 2], 'numbers by value, ties stable, empty last');
  assert.deepEqual(viewOrder(rows, { sort: { col: 1, dir: -1 } }), [3, 0, 1, 4, 5, 2], 'empty last when descending too');
  assert.deepEqual(viewOrder(rows, { sort: { col: 0, dir: 1 } }), [1, 3, 0, 2, 5, 4], 'natural order: item 2 before item 10');
  assert.deepEqual(viewOrder(rows, { filter: 'A 9' }), [1], 'every word, any cell, any case');
  assert.deepEqual(viewOrder(rows, { filter: '' }), [0, 1, 2, 3, 4, 5]);
  const w = columnWidths(['id', 'note'], [['1', 'x'.repeat(500)]], (s) => s.length * 7);
  assert.ok(w[0] >= 56 && w[0] < 100);
  assert.equal(w[1], 360);
  assert.deepEqual(numericColumns(['n', 't'], [['1', 'a'], ['2', 'b'], ['', 'c']]), [true, false]);
  assert.equal(toTSV(['a', 'b'], [['1\t2', 'x\ny'], ['3', '4']], [1, 0]), 'a\tb\n3\t4\n1 2\tx y');
  assert.equal(toCSV(['a', 'b'], [['1,2', 'say "hi"']]), 'a,b\r\n"1,2","say ""hi"""');
  assert.deepEqual(findCells(['a', 'b'], [['Foo', 'x'], ['y', 'food']], [1, 0], 'foo'), [{ r: 0, c: 1 }, { r: 1, c: 0 }]);
  assert.deepEqual(findCells(['a'], [['Foo']], [0], 'foo', { matchCase: true }), []);
  // 100,000 rows sort and filter quickly (the viewer stays fast at that size).
  const big = Array.from({ length: 100000 }, (_, i) => [`ACME-${i}`, String((i * 7919) % 100000), i % 3 ? 'paid' : 'refunded']);
  const t0 = Date.now();
  assert.equal(viewOrder(big, { sort: { col: 1, dir: -1 } }).length, 100000);
  assert.ok(viewOrder(big, { filter: 'refunded' }).length > 30000);
  assert.ok(Date.now() - t0 < 3000, `sort and filter of 100k rows took ${Date.now() - t0} ms`);
});

/* ---------- charts ---------- */

test('chart specs: every type normalizes; labels, pairs, objects and dates; stacked and horizontal', () => {
  assert.deepEqual([...CHART_TYPES], ['line', 'bar', 'area', 'scatter', 'pie']);
  const line = normalizeChart({ type: 'line', title: 'T', labels: ['a', 'b', 'c'], series: [{ name: 's', data: [1, 2, null] }], y: { suffix: ' ms', prefix: '$' } });
  assert.equal(line.ok, true);
  assert.equal(line.spec.x.type, 'category');
  assert.deepEqual(line.spec.categories, ['a', 'b', 'c']);
  assert.deepEqual(line.spec.series[0].points, [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: null }]);
  assert.equal(line.spec.y.suffix, ' ms', 'a unit keeps its space');
  const json = normalizeChart(JSON.stringify({ type: 'bar', data: [3, 4], stacked: true, horizontal: true }));
  assert.equal(json.ok, true);
  assert.deepEqual(json.spec.categories, ['1', '2']);
  assert.equal(json.spec.stacked, true);
  assert.equal(json.spec.horizontal, true);
  assert.equal(normalizeChart({ type: 'line', data: [1], horizontal: true }).spec.horizontal, false, 'horizontal is for bars');
  const pairs = normalizeChart({ type: 'scatter', series: [{ name: 'p', data: [[3, 1], [1, 2]] }] });
  assert.equal(pairs.spec.x.type, 'number');
  assert.deepEqual(pairs.spec.series[0].points.map((p) => p.x), [1, 3], 'sorted by x');
  const time = normalizeChart({ type: 'area', series: [{ name: 'd', data: [['2026-10-01', 1], ['2026-10-02', 2]] }] });
  assert.equal(time.spec.x.type, 'time');
  assert.equal(time.spec.x.utc, true);
  assert.equal(time.spec.series[0].points[0].x, Date.UTC(2026, 9, 1));
  const objs = normalizeChart({ type: 'bar', series: [{ name: 'o', data: [{ x: 'North', y: 2 }, { label: 'South', value: 3 }] }] });
  assert.deepEqual(objs.spec.categories, ['North', 'South']);
  const pie = normalizeChart({ type: 'pie', data: [{ label: 'A', value: 3 }, { label: 'B', value: 1 }] });
  assert.equal(pie.ok, true);
  assert.deepEqual(pie.spec.categories, ['A', 'B']);
  const many = normalizeChart({ type: 'pie', data: Array.from({ length: 12 }, (_, i) => ({ label: `S${i}`, value: 12 - i })) });
  assert.equal(many.spec.categories.length, 8);
  assert.equal(many.spec.categories[7], 'Other');
  // Values 12 down to 1: the seven largest stay, 5 + 4 + 3 + 2 + 1 fold into Other.
  assert.equal(many.spec.series[0].points[7].y, 15, 'the small slices are summed into Other');
  assert.ok(many.warnings.length);
  assert.equal(timeOf('2026-10'), Date.UTC(2026, 9, 1));
  assert.ok(Number.isNaN(timeOf('October')));
});

test('chart specs: what Claude hears when a spec is wrong', () => {
  const err = (spec) => normalizeChart(spec).errors.join(' ');
  assert.match(err('{nope'), /not valid JSON/);
  assert.match(err([1, 2]), /JSON object/);
  assert.match(err({ type: 'donut', data: [1] }), /"type" must be one of line, bar, area, scatter, pie, not "donut"/);
  assert.match(err({ type: 'line' }), /Give "series"/);
  assert.match(err({ type: 'line', series: Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({ name: `s${i}`, data: [1] })) }), /At most 8 series/);
  assert.match(err({ type: 'line', series: [{ name: 's', data: [1, 'x', {}] }] }), /2 points that are not a number/);
  assert.match(err({ type: 'line', series: [{ name: 's' }] }), /has no "data" list/);
  assert.match(err({ type: 'pie', data: [{ label: 'a', value: -1 }] }), /cannot be negative/);
  assert.match(err({ type: 'pie', data: [0, 0] }), /add up to 0/);
  assert.match(err({ type: 'bar', data: [1], y: { min: 5, max: 1 } }), /y\.min/);
  assert.match(err({ type: 'line', series: [{ name: 's', data: [null] }] }), /no numbers to draw/);
  assert.match(err({ type: 'line', series: [{ name: 's', data: [['yesterday', 1]] }], x: { type: 'time' } }), /with a date/);
});

test('chart helpers: round ticks, number formats, time ticks, the data table', () => {
  assert.deepEqual(niceTicks(0, 97, 5).ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(0.1, 0.43, 4).ticks, [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(niceTicks(-12, 18, 6).ticks, [-15, -10, -5, 0, 5, 10, 15, 20]);
  assert.deepEqual(niceTicks(5, 5).ticks.length > 1, true, 'a flat line still gets an axis');
  assert.equal(fmtNum(1234.5), '1,234.5');
  assert.equal(fmtNum(12500, { compact: true }), '13K');
  assert.equal(fmtNum(2400000, { compact: true, prefix: '$' }), '$2.4M');
  assert.equal(fmtNum(-3, { suffix: '%' }), '-3%');
  assert.equal(fmtNum(0.004), '0.004');
  assert.equal(fmtNum(2, { decimals: 2 }), '2.00');
  assert.equal(fmtNum(null), '');
  const t = timeTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), 6);
  assert.equal(t.unit, 'month');
  assert.ok(t.ticks.every((x) => new Date(x).getUTCDate() === 1), 'month ticks fall on the first');
  const days = timeTicks(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 8), 8);
  assert.equal(days.unit, 'day');
  const spec = normalizeChart({ type: 'line', labels: ['a', 'b'], series: [{ name: 'x', data: [1, 2] }, { name: 'y', data: [3] }] }).spec;
  assert.deepEqual(chartTable(spec), { columns: ['Category', 'x', 'y'], rows: [['a', '1', '3'], ['b', '2', '']] });
});

/* ---------- Changes, code lines, documents ---------- */

test('Changes: the line diff rebuilds both sides, and the patch has hunks with line numbers', () => {
  let seed = 9;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 400; n += 1) {
    const mk = () => Array.from({ length: Math.floor(rnd() * 10) }, () => 'abc'[Math.floor(rnd() * 3)]);
    const a = mk();
    const b = mk();
    const ops = lineDiff(a, b);
    assert.deepEqual(ops.filter((o) => o.t !== 'add').map((o) => o.text), a);
    assert.deepEqual(ops.filter((o) => o.t !== 'del').map((o) => o.text), b);
  }
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines(''), []);
  const p = diffPatch('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nB\nc\nd\ne\nf\ng\nh\ni\n', { context: 1 });
  assert.equal(p.added, 2);
  assert.equal(p.removed, 1);
  assert.deepEqual(p.hunks.map((h) => h.header), ['@@ -1,3 +1,3 @@', '@@ -8,1 +8,2 @@']);
  assert.deepEqual(p.hunks[0].lines, [{ t: 'ctx', n: 1, text: 'a' }, { t: 'del', n: 2, text: 'b' }, { t: 'add', n: 2, text: 'B' }, { t: 'ctx', n: 3, text: 'c' }]);
  assert.deepEqual(diffPatch('same\n', 'same\n').hunks, []);
});

test('code: highlighted HTML split into self-contained lines (a comment over three lines stays coloured)', () => {
  const html = 'let <span class="hljs-comment">/* one\ntwo\nthree */</span> x\n<span class="hljs-string">"s"</span>\n';
  assert.deepEqual(splitHighlighted(html), [
    'let <span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two</span>',
    '<span class="hljs-comment">three */</span> x',
    '<span class="hljs-string">"s"</span>',
  ]);
  assert.deepEqual(splitHighlighted('a &lt; b'), ['a &lt; b']);
  assert.deepEqual(splitHighlighted(''), ['']);
});

test('Word documents: links keep http, https, mailto and anchors only; pictures only data images', () => {
  assert.equal(safeHref('https://acme.example/a?b=1'), 'https://acme.example/a?b=1');
  assert.equal(safeHref('mailto:sam@acme.example'), 'mailto:sam@acme.example');
  assert.equal(safeHref('#_Toc123'), '#_Toc123');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', 'file:///C:/x', 'data:text/html,<b>', 'vbscript:x', '', null]) assert.equal(safeHref(bad), null, String(bad));
  assert.equal(safeImageSrc('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(safeImageSrc('data:image/svg+xml;base64,PHN2Zy8+'), 'data:image/svg+xml;base64,PHN2Zy8+');
  for (const bad of ['https://x.example/a.png', 'data:text/html;base64,PGI+', 'data:image/png;base64,<script>', 'data:image/x-emf;base64,AAAA', 'javascript:x']) assert.equal(safeImageSrc(bad), null, bad);
});

/* ---------- the store ---------- */

test('store: text with a language is saved under its extension; charts are checked; workbooks and documents by their bytes', () => {
  const dir = tmp();
  const s = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  assert.ok(SHOW_KINDS.includes('text') && SHOW_KINDS.includes('chart'));
  const py = s.show(SID, { title: 'fib', kind: 'text', language: 'Python', content: 'def f(): pass\n' });
  assert.equal(py.ext, 'py');
  assert.equal(py.lang, 'python');
  assert.equal(py.revs[0].by, 'session');
  assert.equal(py.revs[0].kind, 'text');
  const odd = s.show(SID, { title: 'odd', kind: 'text', language: 'haskell', content: 'main = pure ()' });
  assert.equal(odd.ext, 'txt');
  assert.equal(odd.lang, 'haskell');
  const nohint = s.show(SID, { title: 'n', kind: 'text', language: '<script>', content: 'x' });
  assert.equal(nohint.lang, null, 'a hint that is not a name is dropped');
  const csv = s.show(SID, { title: 'orders', kind: 'text', language: 'csv', content: 'a,b\n1,2\n' });
  assert.equal(csv.ext, 'csv');
  assert.throws(() => s.show(SID, { title: 'big', kind: 'text', content: 'x'.repeat(MAX_TEXT_BYTES + 1) }), /Apaki shows text up to/);
  const chart = s.show(SID, { title: 'c', kind: 'chart', content: JSON.stringify({ type: 'bar', labels: ['a'], series: [{ name: 's', data: [1] }] }) });
  assert.equal(chart.kind, 'chart');
  assert.equal(chart.ext, 'json');
  assert.throws(() => s.show(SID, { title: 'c', kind: 'chart', content: '{"type":"donut","data":[1]}' }), /chart spec has problems: "type" must be one of/);
  assert.throws(() => s.show(SID, { title: 'c', kind: 'chart', content: 'not json' }), /not valid JSON/);
  // Files: a workbook needs zip bytes (an .xls may also be the old binary format, or HTML Excel saved), a .docx zip bytes.
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
  fs.writeFileSync(path.join(dir, 'q3.xlsx'), zipBytes);
  fs.writeFileSync(path.join(dir, 'old.xls'), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40)]));
  fs.writeFileSync(path.join(dir, 'html.xls'), '<table><tr><td>1</td></tr></table>');
  fs.writeFileSync(path.join(dir, 'spec.docx'), zipBytes);
  fs.writeFileSync(path.join(dir, 'fake.docx'), 'not a zip');
  fs.writeFileSync(path.join(dir, 'fake.xlsx'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(s.show(SID, { title: 'q3', kind: 'file', path: path.join(dir, 'q3.xlsx') }).kind, 'sheet');
  assert.equal(s.show(SID, { title: 'old', kind: 'file', path: path.join(dir, 'old.xls') }).kind, 'sheet');
  assert.equal(s.show(SID, { title: 'h', kind: 'file', path: path.join(dir, 'html.xls') }).kind, 'sheet');
  assert.equal(s.show(SID, { title: 'spec', kind: 'file', path: path.join(dir, 'spec.docx') }).kind, 'docx');
  assert.throws(() => s.show(SID, { title: 'f', kind: 'file', path: path.join(dir, 'fake.docx') }), /not a Word document/);
  assert.throws(() => s.show(SID, { title: 'f', kind: 'file', path: path.join(dir, 'fake.xlsx') }), /not a XLSX workbook/);
  assert.equal(sniffOffice(zipBytes), 'zip');
  assert.equal(sniffOffice(Buffer.from('hello world')), null);
  assert.equal(kindOfExt('xlsx'), 'sheet');
  assert.equal(kindOfExt('docx'), 'docx');
  // A text file shown as text, with a hint; a binary one refused.
  fs.writeFileSync(path.join(dir, 'script'), 'echo hi\n');
  const sh = s.show(SID, { title: 'script', kind: 'text', path: path.join(dir, 'script'), language: 'bash' });
  assert.equal(sh.ext, 'sh');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
  assert.throws(() => s.show(SID, { title: 'b', kind: 'text', path: path.join(dir, 'bin.dat') }), /not a text file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: the user\'s edit is a revision marked as theirs; stale and same-text saves; who saw what', () => {
  const dir = tmp();
  const s = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  const md = s.show(SID, { title: 'Notes', kind: 'markdown', content: '# One' });
  assert.equal(md.sessionRev, 1);
  const e = s.edit(SID, md.id, { content: '# One\n\nmine', baseRev: 1, now: 5 });
  assert.equal(e.rev, 2);
  assert.equal(e.revs[1].by, 'user');
  assert.equal(e.sessionRev, 1, 'the session made rev 1; rev 2 is news to it');
  assert.deepEqual(s.userEdits(e), [{ rev: 2, at: 5 }]);
  assert.equal(s.get(md.id, { sessionId: SID }).by, 'user');
  assert.equal(s.get(md.id, { sessionId: SID, rev: 1 }).by, 'session');
  assert.equal(s.edit(SID, md.id, { content: '# One\n\nmine', baseRev: 2 }).rev, 2, 'the same text makes no revision');
  assert.throws(() => s.edit(SID, md.id, { content: 'x', baseRev: 1 }), (err) => err.code === 'stale' && err.rev === 2);
  assert.equal(s.edit(SID, md.id, { content: 'x', baseRev: 1, force: true }).rev, 3, 'Save anyway');
  s.mark(SID, md.id, { readRev: 3 });
  assert.deepEqual(s.userEdits(s.record(md.id, SID)), [], 'read: nothing new');
  const again = s.show(SID, { id: md.id, title: 'Notes', kind: 'markdown', content: '# Two' });
  assert.equal(again.sessionRev, 4);
  const chart = s.show(SID, { title: 'c', kind: 'chart', content: '{"type":"bar","data":[1]}' });
  assert.throws(() => s.edit(SID, chart.id, { content: '{}' }), /cannot be edited here/);
  assert.throws(() => s.edit(SID, 'nope', { content: 'x' }), /no longer on this PC/);
  assert.throws(() => s.edit(SID, md.id, { content: 'x'.repeat(MAX_TEXT_BYTES + 1), force: true }), /the most is/);
  // revKind: a revision's own kind, or (older records) the record's for the newest and the extension's before it.
  assert.equal(revKind({ rev: 2, kind: 'text' }, { rev: 1, ext: 'md' }), 'markdown');
  assert.equal(revKind({ rev: 2, kind: 'chart' }, { rev: 2, ext: 'json' }), 'chart');
  assert.equal(revKind({ rev: 2, kind: 'text' }, { rev: 1, ext: 'json', kind: 'chart' }), 'chart');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- the tools ---------- */

async function client(tools) {
  const server = tools.mcpServers().apaki;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(ct);
  return c;
}

test('tools: show takes language; view_read lists and reads, says who edited what; a show over an unread edit says so', async () => {
  const dir = tmp();
  const store = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  const shown = [];
  const tools = createApakiTools({ store, sessionId: () => SID, cwd: () => dir, onArtifact: (rec) => shown.push(rec) });
  assert.ok(showShape().language.isOptional(), 'older calls without language still validate');
  assert.ok(viewReadShape().id.isOptional());
  const c = await client(tools);
  try {
    const list = await c.listTools();
    const show = list.tools.find((t) => t.name === 'show');
    assert.ok(show.inputSchema.properties.language);
    assert.ok(show.inputSchema.properties.kind.enum.includes('chart'));
    assert.match(show.description, /kind "chart"/);
    const read = list.tools.find((t) => t.name === 'view_read');
    assert.equal(read.annotations.readOnlyHint, true);
    const empty = await c.callTool({ name: 'view_read', arguments: {} });
    assert.match(empty.content[0].text, /not shown anything/);
    const r1 = await c.callTool({ name: 'show', arguments: { title: 'Plan', kind: 'markdown', content: '# Plan' } });
    const id = /artifact ([a-z0-9-]+), rev/.exec(r1.content[0].text)[1];
    await c.callTool({ name: 'show', arguments: { title: 'fib.py', kind: 'text', language: 'python', content: 'x = 1\n' } });
    assert.equal(shown[1].ext, 'py');
    store.edit(SID, id, { content: '# Plan\n\n- mine', baseRev: 1 });
    const listed = await c.callTool({ name: 'view_read', arguments: {} });
    assert.match(listed.content[0].text, new RegExp(`${id}: "Plan" \\(markdown, rev 2\\), edited by the user in rev 2`));
    assert.match(listed.content[0].text, /fib-py-[0-9a-f]{4}: "fib\.py" \(text, python, rev 1\)/);
    const hook = await tools.userPromptSubmit({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    assert.match(hook.hookSpecificOutput.additionalContext, /the user edited "Plan" \(id .+, now rev 2\) in the viewer/);
    assert.equal(hook.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.deepEqual(await tools.userPromptSubmit({}), {}, 'told once');
    const got = await c.callTool({ name: 'view_read', arguments: { id } });
    assert.match(got.content[0].text, /rev 2 of 2, made by the user \(edited in Apaki\)\. The user edited it in Apaki after you last showed it: rev 2 is theirs/);
    assert.match(got.content[0].text, /\nContent:\n# Plan\n\n- mine$/);
    const old = await c.callTool({ name: 'view_read', arguments: { id, rev: 1 } });
    assert.match(old.content[0].text, /rev 1 of 2, made by you/);
    const missing = await c.callTool({ name: 'view_read', arguments: { id: 'nope' } });
    assert.equal(missing.isError, true);
    // Read, then edited again, then replaced by a show without reading: the result says the edit was dropped.
    store.edit(SID, id, { content: 'theirs again', baseRev: 2 });
    const over = await c.callTool({ name: 'show', arguments: { title: 'Plan', kind: 'markdown', content: '# Plan v3', id } });
    assert.match(over.content[0].text, /the user had edited it in Apaki \(rev 3\) and you had not read their version/);
    const clean = await c.callTool({ name: 'show', arguments: { title: 'Plan', kind: 'markdown', content: '# Plan v4', id } });
    assert.doesNotMatch(clean.content[0].text, /had edited/);
    // Binary kinds are named, not dumped.
    fs.writeFileSync(path.join(dir, 'q.xlsx'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]));
    const wb = await c.callTool({ name: 'show', arguments: { title: 'q', kind: 'file', path: path.join(dir, 'q.xlsx') } });
    const wid = /artifact ([a-z0-9-]+), rev/.exec(wb.content[0].text)[1];
    const wr = await c.callTool({ name: 'view_read', arguments: { id: wid } });
    assert.match(wr.content[0].text, /It is a spreadsheet \(xlsx, 24 bytes\), so its text is not shown here\. Its file is /);
    const hooks = tools.hooks;
    assert.equal(hooks.UserPromptSubmit[0].hooks[0], tools.userPromptSubmit);
  } finally {
    await c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- policy and the phone build ---------- */

test('policy: Download and Edit are PC only (a phone reads every kind, never writes); view_read stays for restricted phones', () => {
  const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
  for (const op of ['artifactSave', 'artifactEdit']) {
    assert.ok(PC_ONLY_OPS.includes(op), op);
    assert.ok(!PHONE_OPS.includes(op), op);
    for (const cap of ['full', 'noshell', 'chat']) assert.equal(checkPhoneCommand({ op, id: 'a', sessionId: SID, content: 'x' }, { deviceId: DEV, cap }).ok, false, `${op} ${cap}`);
  }
  assert.ok(PHONE_OPS.includes('artifactGet'), 'reading stays a phone op');
  assert.equal(capBlocksTool('chat', 'mcp__apaki__view_read'), false);
  assert.equal(capBlocksTool('noshell', 'mcp__apaki__view_read'), false);
  assert.ok(!CAP_BLOCKED_TOOLS.includes('mcp__apaki__view_read'));
  const engine = fs.readFileSync(path.join(ROOT, 'apaki', 'engine', 'engine.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const op of ['artifactSave', 'artifactEdit']) assert.match(engine, new RegExp(`\\n  ${op}: `), `engine.js handles ${op}`);
  const policy = fs.readFileSync(path.join(ROOT, 'apaki', 'engine', 'remote-policy.js'), 'utf8');
  assert.match(policy, /artifactEdit {2}the canvas's "edit and send back"/, 'the reasoning is written down where the list is');
});

test('the phone build carries the viewer libraries and the new modules, and does not fetch the libraries up front', () => {
  const out = tmp();
  try {
    build({ relay: 'wss://relay.example', out });
    for (const f of ['viewkind.js', 'chartspec.js', 'chart.js', 'tabular.js', 'tableview.js', 'codeview.js', 'jsontree.js', 'docview.js', 'sheets.js', 'sheetworker.js', 'lazy.js', 'textdiff.js',
      'vendor/highlight/core.min.js', 'vendor/highlight/languages/python.min.js', 'vendor/highlight/LICENSE', 'vendor/sheetjs/xlsx.core.min.js', 'vendor/sheetjs/LICENSE', 'vendor/mammoth/mammoth.browser.min.js', 'vendor/mammoth/LICENSE', 'vendor/mammoth/NOTICE']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    const assets = JSON.parse(/const ASSETS = (\[.*\]);/.exec(sw)[1]);
    assert.ok(assets.includes('./chart.js'));
    assert.ok(!assets.some((a) => a.startsWith('./vendor/')), 'the libraries load when a viewer needs them, not at install');
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /worker-src 'self'/, 'the workbook reader runs in a worker of the page\'s own origin');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the window\'s CSP is unchanged: no eval, no remote scripts, no new origins', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'apaki', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.app.security.csp, "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data: blob: http://127.0.0.1:*; frame-src http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; font-src 'self'");
  for (const f of ['lazy.js', 'codeview.js', 'chart.js', 'docview.js', 'sheets.js', 'sheetworker.js', 'tableview.js', 'jsontree.js', 'artifacts.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'apaki', 'ui', f), 'utf8');
    assert.ok(!/\beval\(|new Function\(/.test(src), `${f} evaluates no strings`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}\//i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} names no remote address in code`);
  }
});
