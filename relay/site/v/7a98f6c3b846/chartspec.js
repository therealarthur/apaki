/**
 * chartspec.js: the small chart spec a session can show without writing an HTML page (show with kind "chart").
 *
 * WHY (Arthur, 2026-10-13: viewers that can show "art, spreadsheets, real browser, code, etc"): a chart used to mean
 * a whole HTML page with a charting library inlined. Now Claude sends a few lines of JSON and Apaki draws it with its
 * own SVG renderer (chart.js), in the app's theme, with tooltips, a data table and PNG or SVG export.
 *
 * The spec (every field but type and the data is optional):
 *   {
 *     "type": "line" | "bar" | "area" | "scatter" | "pie",
 *     "title": "Revenue by month", "subtitle": "2025 and 2026, USD",
 *     "labels": ["Jan", "Feb", "Mar"],                 // categories (also "categories" or x.categories)
 *     "series": [
 *       { "name": "2025", "data": [12, 15, 11] },      // numbers line up with labels
 *       { "name": "2026", "data": [[1, 14], [2, 18]] } // or [x, y] pairs, or { "x": .., "y": .. } objects
 *     ],
 *     "data": [ ... ],                                 // a single series, instead of "series"
 *     "x": { "label": "Month", "type": "category" | "number" | "time" },
 *     "y": { "label": "Revenue", "min": 0, "max": 100, "prefix": "$", "suffix": "%", "decimals": 1 },
 *     "stacked": false,                                // bar and area
 *     "horizontal": false                              // bar
 *   }
 * A pie takes one series of numbers with labels, or data as [{ "label": "A", "value": 3 }].
 *
 * normalizeChart() checks a spec and returns { ok, spec, errors, warnings }: errors are written for Claude (the show
 * tool returns them), the spec is the one shape the renderer reads. Pure: no DOM, no I/O; the engine imports it to
 * refuse a bad spec at show time (apaki/engine/artifacts.js), the window to draw it. Untrusted input is bounded:
 * at most MAX_SERIES series and MAX_POINTS points in all, strings cut short, nothing evaluated.
 */

export const CHART_TYPES = Object.freeze(['line', 'bar', 'area', 'scatter', 'pie']);
export const MAX_SERIES = 8;
export const MAX_POINTS = 50000;
export const MAX_SLICES = 8;
const MAX_TEXT = 200;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, n = MAX_TEXT) => (v === undefined || v === null ? '' : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n));
// A unit before or after a number keeps its spaces (" ms"), unlike other text.
const affix = (v, n) => (v === undefined || v === null ? '' : String(v).replace(/[\u0000-\u001f]+/g, '').slice(0, n));
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : NaN);

/** A date the time axis takes: a number of milliseconds, or an ISO-like date string. NaN otherwise. */
export function timeOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (!/^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return NaN;
  return Date.parse(s.length === 7 ? `${s}-01` : s);
}
const dateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(v.trim());

/**
 * Checks and normalizes a chart spec (an object, or its JSON text).
 * Returns { ok, spec, errors, warnings }. spec: { type, title, subtitle, x: { label, type, utc }, y: { label, min, max,
 * prefix, suffix, decimals }, categories: string[] | null, series: [{ name, points: [{ x, y }] }], stacked, horizontal }.
 * On x type category, each point's x is its category's index.
 */
export function normalizeChart(input) {
  const errors = [];
  const warnings = [];
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return { ok: false, spec: null, errors: [`The chart spec is not valid JSON (${String(e.message || e).slice(0, 120)}).`], warnings }; }
  }
  if (!isObj(raw)) return { ok: false, spec: null, errors: ['The chart spec must be a JSON object with "type" and "series" (or "data").'], warnings };
  const type = String(raw.type || '').toLowerCase().trim();
  if (!CHART_TYPES.includes(type)) errors.push(`"type" must be one of ${CHART_TYPES.join(', ')}${raw.type ? `, not "${text(raw.type, 40)}"` : ''}.`);
  const xIn = isObj(raw.x) ? raw.x : {};
  const yIn = isObj(raw.y) ? raw.y : {};
  let cats = Array.isArray(raw.labels) ? raw.labels : Array.isArray(raw.categories) ? raw.categories : Array.isArray(xIn.categories) ? xIn.categories : null;
  if (cats && cats.length > MAX_POINTS) { errors.push(`At most ${MAX_POINTS} labels.`); cats = cats.slice(0, MAX_POINTS); }
  cats = cats ? cats.map((c) => text(c, 80)) : null;

  // The series, as the spec gave them.
  let seriesIn = raw.series;
  if (seriesIn === undefined && raw.data !== undefined) seriesIn = [{ name: text(raw.name) || text(raw.title) || 'Series', data: raw.data }];
  if (isObj(seriesIn)) seriesIn = [seriesIn];
  if (!Array.isArray(seriesIn) || !seriesIn.length) {
    errors.push('Give "series" (a list of { "name", "data" }) or "data" (one series).');
    return { ok: false, spec: null, errors, warnings };
  }

  if (type === 'pie') return pie(raw, seriesIn, cats, errors, warnings, xIn, yIn);

  if (seriesIn.length > MAX_SERIES) errors.push(`At most ${MAX_SERIES} series (this has ${seriesIn.length}); fold the smaller ones into "Other" or show several charts.`);
  const list = seriesIn.slice(0, MAX_SERIES);
  // What x is: categories (labels, or strings), numbers, or dates.
  let xType = ['category', 'number', 'time'].includes(xIn.type) ? xIn.type : null;
  const firstX = [];
  for (const s of list) {
    const d = Array.isArray(s?.data) ? s.data : [];
    for (const p of d.slice(0, 50)) {
      if (Array.isArray(p)) firstX.push(p[0]);
      else if (isObj(p)) firstX.push(p.x ?? p.label ?? p.name);
    }
  }
  if (!xType) {
    if (cats || !firstX.length) xType = 'category';
    else if (firstX.every((v) => typeof v === 'number')) xType = 'number';
    else if (firstX.every((v) => Number.isFinite(timeOf(v)))) xType = 'time';
    else xType = 'category';
  }
  if (type === 'bar' && xType !== 'category') xType = 'category';
  const utc = xType === 'time' && firstX.every((v) => typeof v !== 'string' || dateOnly(v));

  const catIndex = new Map((cats || []).map((c, i) => [c, i]));
  const categories = cats ? [...cats] : [];
  const catOf = (v) => {
    const k = text(v, 80);
    if (!catIndex.has(k)) {
      if (categories.length >= MAX_POINTS) return -1;
      catIndex.set(k, categories.length);
      categories.push(k);
    }
    return catIndex.get(k);
  };

  let total = 0;
  const series = [];
  list.forEach((s, si) => {
    const name = text(isObj(s) ? s.name ?? s.label : '', 80) || (list.length === 1 ? text(raw.title, 80) || 'Series' : `Series ${si + 1}`);
    const data = isObj(s) && Array.isArray(s.data) ? s.data : Array.isArray(s) ? s : null;
    if (!data) { errors.push(`Series ${si + 1} ("${name}") has no "data" list.`); return; }
    if (total + data.length > MAX_POINTS) { errors.push(`At most ${MAX_POINTS} points in all.`); return; }
    total += data.length;
    const points = [];
    let bad = 0;
    data.forEach((p, i) => {
      let x;
      let y;
      if (typeof p === 'number' || typeof p === 'string' || p === null) {
        y = p === null ? null : num(p);
        x = xType === 'category' ? (cats ? i : catOf(String(i + 1))) : i;
        if (xType !== 'category' && xType !== 'number') x = NaN;
      } else if (Array.isArray(p)) { x = p[0]; y = p[1] === null ? null : num(p[1]); } else if (isObj(p)) { x = p.x ?? p.label ?? p.name; y = p.y ?? p.value; y = y === null ? null : num(y); } else { bad += 1; return; }
      if (!Array.isArray(p) && !isObj(p)) {
        // Plain numbers: x is the position (or its label).
      } else if (xType === 'category') x = catOf(x);
      else if (xType === 'time') x = timeOf(x);
      else x = num(x);
      if (!Number.isFinite(x) || (x < 0 && xType === 'category')) { bad += 1; return; }
      if (y === null) { points.push({ x, y: null }); return; }
      if (!Number.isFinite(y)) { bad += 1; return; }
      points.push({ x, y });
    });
    if (bad) errors.push(`Series "${name}" has ${bad} point${bad === 1 ? '' : 's'} that ${bad === 1 ? 'is' : 'are'} not a number${xType === 'time' ? ' with a date (ISO like "2026-10-13" or milliseconds)' : ''}.`);
    if (xType !== 'category') points.sort((a, b) => a.x - b.x);
    series.push({ name, points });
  });
  if (cats && list.some((s) => Array.isArray(s?.data) && s.data.some((p) => typeof p === 'number') && s.data.length > cats.length)) warnings.push('A series has more numbers than there are labels; the extra ones are left out.');
  for (const s of series) if (xType === 'category' && cats) s.points = s.points.filter((p) => p.x < cats.length);

  const ySpec = {
    label: text(yIn.label ?? yIn.title, 80),
    min: Number.isFinite(num(yIn.min)) ? num(yIn.min) : null,
    max: Number.isFinite(num(yIn.max)) ? num(yIn.max) : null,
    prefix: affix(yIn.prefix, 6),
    suffix: affix(yIn.suffix ?? yIn.unit, 10),
    decimals: Number.isInteger(yIn.decimals) && yIn.decimals >= 0 && yIn.decimals <= 6 ? yIn.decimals : null,
  };
  if (ySpec.min !== null && ySpec.max !== null && ySpec.min >= ySpec.max) { errors.push('"y.min" must be below "y.max".'); ySpec.min = null; ySpec.max = null; }
  const spec = {
    type,
    title: text(raw.title),
    subtitle: text(raw.subtitle ?? raw.description),
    x: { label: text(xIn.label ?? xIn.title, 80), type: xType, utc },
    y: ySpec,
    categories: xType === 'category' ? categories : null,
    series,
    stacked: Boolean(raw.stacked) && (type === 'bar' || type === 'area'),
    horizontal: Boolean(raw.horizontal) && type === 'bar',
  };
  if (!series.some((s) => s.points.some((p) => p.y !== null))) errors.push('The chart has no numbers to draw.');
  return { ok: errors.length === 0, spec, errors, warnings };
}

/** A pie: one series of numbers with labels, or { label, value } items. More than MAX_SLICES fold into "Other". */
function pie(raw, seriesIn, cats, errors, warnings, xIn, yIn) {
  if (seriesIn.length > 1) warnings.push('A pie draws one series; only the first is shown.');
  const s = seriesIn[0];
  const data = isObj(s) && Array.isArray(s.data) ? s.data : Array.isArray(s) ? s : null;
  if (!data) return { ok: false, spec: null, errors: [...errors, 'The pie\'s series has no "data" list.'], warnings };
  if (data.length > MAX_POINTS) return { ok: false, spec: null, errors: [...errors, `At most ${MAX_POINTS} slices.`], warnings };
  let slices = [];
  let bad = 0;
  data.forEach((p, i) => {
    let label;
    let value;
    if (typeof p === 'number' || typeof p === 'string') { label = cats?.[i] ?? `Slice ${i + 1}`; value = num(p); } else if (Array.isArray(p)) { label = p[0]; value = num(p[1]); } else if (isObj(p)) { label = p.label ?? p.name ?? p.x ?? cats?.[i] ?? `Slice ${i + 1}`; value = num(p.value ?? p.y); } else { bad += 1; return; }
    if (!Number.isFinite(value)) { bad += 1; return; }
    if (value < 0) { errors.push(`A pie slice cannot be negative ("${text(label, 40)}" is ${value}).`); return; }
    slices.push({ label: text(label, 80) || `Slice ${i + 1}`, value });
  });
  if (bad) errors.push(`${bad} slice${bad === 1 ? ' is' : 's are'} not a number.`);
  if (slices.length > MAX_SLICES) {
    const sorted = [...slices].sort((a, b) => b.value - a.value);
    const keep = sorted.slice(0, MAX_SLICES - 1);
    const rest = sorted.slice(MAX_SLICES - 1).reduce((n, x) => n + x.value, 0);
    warnings.push(`${slices.length - MAX_SLICES + 1} smaller slices are folded into "Other".`);
    const kept = new Set(keep);
    slices = [...slices.filter((x) => kept.has(x)), { label: 'Other', value: rest }];
  }
  const sum = slices.reduce((n, x) => n + x.value, 0);
  if (!slices.length || sum <= 0) errors.push('The pie has nothing to draw (its values add up to 0).');
  const spec = {
    type: 'pie', title: text(raw.title), subtitle: text(raw.subtitle ?? raw.description),
    x: { label: text(xIn.label, 80), type: 'category', utc: false },
    y: { label: text(yIn.label, 80), min: null, max: null, prefix: affix(yIn.prefix, 6), suffix: affix(yIn.suffix ?? yIn.unit, 10), decimals: Number.isInteger(yIn.decimals) && yIn.decimals >= 0 && yIn.decimals <= 6 ? yIn.decimals : null },
    categories: slices.map((x) => x.label),
    series: [{ name: text(isObj(s) ? s.name : '', 80) || text(raw.title, 80) || 'Share', points: slices.map((x, i) => ({ x: i, y: x.value })) }],
    stacked: false, horizontal: false,
  };
  return { ok: errors.length === 0, spec, errors, warnings };
}

/**
 * Round axis ticks from min to max: { min, max, step, ticks }. The range is widened to whole steps; about `count`
 * ticks. A zero range opens up around its value.
 */
export function niceTicks(min, max, count = 5) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) { const d = Math.abs(lo) || 1; lo -= d / 2; hi += d / 2; if (Number(min) === 0) { lo = 0; hi = d; } }
  const span = hi - lo;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const nlo = Math.floor(lo / step + 1e-9) * step;
  const nhi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = nlo, i = 0; v <= nhi + step / 2 && i < 200; v += step, i += 1) ticks.push(Number(v.toFixed(12)));
  return { min: nlo, max: nhi, step, ticks };
}

/** A number for an axis, a tooltip or a table: grouped, compact for large axis values, with the spec's prefix and suffix. */
export function fmtNum(v, { prefix = '', suffix = '', decimals = null, compact = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const neg = v < 0;
  const a = Math.abs(v);
  let body;
  if (compact && a >= 1000) {
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    const [div, u] = units.find(([d]) => a >= d);
    const n = a / div;
    body = `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 1 : 0 })}${u}`;
  } else {
    const d = decimals ?? (a !== 0 && a < 1 ? Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(a)) + 1)) : Number.isInteger(a) ? 0 : 2);
    body = a.toLocaleString('en-US', { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: d });
  }
  return `${neg ? '-' : ''}${prefix}${body}${suffix}`;
}

const DAY = 86400000;
/** Steps for a time axis, short to long, in milliseconds (months and years are approximate and snapped below). */
const TIME_STEPS = [1000, 5000, 15000, 60000, 300000, 900000, 3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY, 182 * DAY, 365 * DAY];

/** Ticks for a time axis between two dates (ms): about `count` of them, on round days, months or years. */
export function timeTicks(min, max, count = 6, utc = true) {
  const span = Math.max(1, max - min);
  const step = TIME_STEPS.find((s) => span / s <= count) || 365 * DAY * Math.ceil(span / (365 * DAY * count));
  const ticks = [];
  const g = (d, k) => (utc ? d[`getUTC${k}`]() : d[`get${k}`]());
  const mk = (y, mo, da) => (utc ? Date.UTC(y, mo, da) : new Date(y, mo, da).getTime());
  if (step >= 28 * DAY) {
    const months = step >= 365 * DAY ? 12 * Math.max(1, Math.round(step / (365 * DAY))) : Math.max(1, Math.round(step / (30 * DAY)));
    const d0 = new Date(min);
    let y = g(d0, 'FullYear');
    let mo = g(d0, 'Month');
    mo = Math.ceil(mo / months) * months;
    for (let i = 0; i < 400; i += 1) {
      const t = mk(y + Math.floor(mo / 12), mo % 12, 1);
      if (t > max) break;
      if (t >= min) ticks.push(t);
      mo += months;
    }
    return { ticks, step, unit: months >= 12 ? 'year' : 'month' };
  }
  const offset = utc ? 0 : new Date(min).getTimezoneOffset() * 60000;
  let t = Math.ceil((min - offset) / step) * step + offset;
  for (let i = 0; t <= max && i < 400; t += step, i += 1) ticks.push(t);
  return { ticks, step, unit: step >= DAY ? 'day' : step >= 3600000 ? 'hour' : step >= 60000 ? 'minute' : 'second' };
}

/** A date for an axis tick or a tooltip, as precise as the unit needs. */
export function fmtTime(t, unit = 'day', utc = true) {
  const d = new Date(t);
  const tz = utc ? { timeZone: 'UTC' } : {};
  if (unit === 'year') return d.toLocaleDateString('en-US', { year: 'numeric', ...tz });
  if (unit === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', ...tz });
  if (unit === 'day') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...tz });
  if (unit === 'full') return d.toLocaleString('en-US', utc ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' } : { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(unit === 'second' ? { second: '2-digit' } : {}), ...tz });
}

/** The x value of a point as text (a category name, a date or a number). */
export function xText(spec, x) {
  if (spec.x.type === 'category') return spec.categories?.[x] ?? String(x);
  if (spec.x.type === 'time') return fmtTime(x, 'full', spec.x.utc);
  return fmtNum(x);
}

/** The chart's numbers as a table: { columns, rows } with one row per x and one column per series (the data view, Copy). */
export function chartTable(spec) {
  if (!spec) return { columns: [], rows: [] };
  const xName = spec.x.label || (spec.type === 'pie' ? 'Label' : spec.x.type === 'time' ? 'Date' : spec.x.type === 'number' ? 'x' : 'Category');
  const columns = [xName, ...spec.series.map((s) => s.name)];
  const keys = [];
  const seen = new Map();
  for (const s of spec.series) for (const p of s.points) if (!seen.has(p.x)) { seen.set(p.x, keys.length); keys.push(p.x); }
  if (spec.x.type !== 'category') keys.sort((a, b) => a - b);
  const index = new Map(keys.map((k, i) => [k, i]));
  const rows = keys.map((k) => [xText(spec, k), ...spec.series.map(() => '')]);
  spec.series.forEach((s, si) => { for (const p of s.points) rows[index.get(p.x)][si + 1] = p.y === null ? '' : String(p.y); });
  return { columns, rows };
}

/** The categorical colours, in their fixed order, for the light and dark surfaces (validated: dataviz palette check). */
// Eight slots and no more: a ninth series is never a made-up hue, it folds into "Other" (MAX_SERIES, MAX_SLICES).
export const SERIES_COLORS = Object.freeze({
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
});
/** The colour of a pie's "Other" slice: a neutral that never reads as a series. */
export const OTHER_COLOR = Object.freeze({ light: '#898781', dark: '#898781' });
