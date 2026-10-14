/**
 * chart.js: draws a chart spec (chartspec.js) as SVG in the viewer, in the app's theme (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: viewers that show "everything chatgpt's window could display"): a session shows a line,
 * bar, area, scatter or pie chart with a few lines of JSON (show kind "chart") instead of a page with a charting
 * library inlined. Apaki's own renderer, no library: thin marks (2 px lines, bars at most 24 px thick with a 4 px
 * rounded end and a square base, 2 px surface gaps and rings), recessive hairline grid, a legend for two or more
 * series plus labels at the line ends when they fit, a crosshair and tooltip on hover, and colours in a fixed order
 * that were checked for colour vision deficiencies against both of the app's surfaces (chartspec.js SERIES_COLORS).
 *
 * The drawing is a pure function of the spec, the size and the theme (drawChart), so a chart redraws when the pane
 * resizes or the theme flips, and exports as the same SVG, or a PNG at twice the size, with the theme's colours
 * written into it.
 */

import { OTHER_COLOR, SERIES_COLORS, fmtNum, fmtTime, niceTicks, timeTicks, xText } from './chartspec.js';

const PAD = 16;
const FONT_FALLBACK = "'Archivo', 'Segoe UI', system-ui, sans-serif";
const escX = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;

/** The colours a chart draws with, read from the app's tokens now (so an export carries real colours, not var()). */
export function chartTheme(dark = document.documentElement.dataset.theme === 'dark') {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fb) => (css.getPropertyValue(name) || '').trim() || fb;
  return {
    dark,
    surface: v('--card', dark ? '#1A1928' : '#FFFFFF'),
    ink: v('--ink', dark ? '#ECEDF8' : '#171717'),
    soft: v('--soft', dark ? '#B7B9D3' : '#55566B'),
    muted: v('--faint', dark ? '#8D8FAD' : '#63647D'),
    grid: v('--hairline', dark ? '#2A2940' : '#E3E5F6'),
    axis: v('--hairline-strong', dark ? '#3A3956' : '#D5D8EF'),
    series: dark ? SERIES_COLORS.dark : SERIES_COLORS.light,
    other: dark ? OTHER_COLOR.dark : OTHER_COLOR.light,
    font: (v('--font-body', '') || FONT_FALLBACK).replace(/"/g, "'"),
  };
}

let ctx = null;
/** A text's width at a size and weight (canvas measureText; a guess by length without a canvas). */
function textWidth(text, size = 12, weight = 500, font = FONT_FALLBACK) {
  if (ctx === null) { try { ctx = document.createElement('canvas').getContext('2d'); } catch { ctx = false; } }
  if (!ctx) return String(text).length * size * 0.58;
  ctx.font = `${weight} ${size}px ${font}`;
  return ctx.measureText(String(text)).width;
}

const ellipsize = (text, max, size, weight, font) => {
  let t = String(text);
  if (textWidth(t, size, weight, font) <= max) return t;
  while (t.length > 1 && textWidth(`${t}…`, size, weight, font) > max) t = t.slice(0, -1);
  return `${t}…`;
};

/** A bar with a rounded end (4 px) away from its base and a square base. end: 'top' | 'bottom' | 'right' | 'left'. */
function barPath(x, y, w, h, end, r = 4) {
  if (w <= 0 || h <= 0) return '';
  const rr = Math.min(r, (end === 'top' || end === 'bottom' ? w : h) / 2, end === 'top' || end === 'bottom' ? h : w);
  if (end === 'top') return `M${r1(x)} ${r1(y + h)}V${r1(y + rr)}Q${r1(x)} ${r1(y)} ${r1(x + rr)} ${r1(y)}H${r1(x + w - rr)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + rr)}V${r1(y + h)}Z`;
  if (end === 'bottom') return `M${r1(x)} ${r1(y)}V${r1(y + h - rr)}Q${r1(x)} ${r1(y + h)} ${r1(x + rr)} ${r1(y + h)}H${r1(x + w - rr)}Q${r1(x + w)} ${r1(y + h)} ${r1(x + w)} ${r1(y + h - rr)}V${r1(y)}Z`;
  if (end === 'right') return `M${r1(x)} ${r1(y)}H${r1(x + w - rr)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + rr)}V${r1(y + h - rr)}Q${r1(x + w)} ${r1(y + h)} ${r1(x + w - rr)} ${r1(y + h)}H${r1(x)}Z`;
  return `M${r1(x + w)} ${r1(y)}H${r1(x + rr)}Q${r1(x)} ${r1(y)} ${r1(x)} ${r1(y + rr)}V${r1(y + h - rr)}Q${r1(x)} ${r1(y + h)} ${r1(x + rr)} ${r1(y + h)}H${r1(x + w)}Z`;
}

function arcPath(cx, cy, r0, r1x, a0, a1) {
  const big = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => `${r1(cx + r * Math.sin(a))} ${r1(cy - r * Math.cos(a))}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // A whole ring: two halves (an arc cannot start and end at one point).
    return `M${p(r1x, 0)}A${r1x} ${r1x} 0 1 1 ${p(r1x, Math.PI)}A${r1x} ${r1x} 0 1 1 ${p(r1x, 0)}M${p(r0, 0)}A${r0} ${r0} 0 1 0 ${p(r0, Math.PI)}A${r0} ${r0} 0 1 0 ${p(r0, 0)}Z`;
  }
  return `M${p(r1x, a0)}A${r1x} ${r1x} 0 ${big} 1 ${p(r1x, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${big} 0 ${p(r0, a0)}Z`;
}

/**
 * Lays a chart out at width x height: { svg (markup, without the outer <svg>), model (geometry for hover) }.
 * Pure but for text measuring.
 */
export function drawChart(spec, width, height, theme) {
  const W = Math.max(240, Math.round(width));
  const H = Math.max(180, Math.round(height));
  const F = theme.font;
  const parts = [];
  const fmtY = (v, compact = false) => fmtNum(v, { prefix: spec.y.prefix, suffix: spec.y.suffix, decimals: compact ? null : spec.y.decimals, compact });
  const colorOf = (i, label) => (label === 'Other' && spec.type === 'pie' ? theme.other : theme.series[i % theme.series.length]);
  let top = PAD;
  // Title and subtitle.
  if (spec.title) {
    parts.push(`<text x="${PAD}" y="${top + 15}" fill="${theme.ink}" font-size="15" font-weight="760">${escX(ellipsize(spec.title, W - PAD * 2, 15, 760, F))}</text>`);
    top += 22;
  }
  if (spec.subtitle) {
    parts.push(`<text x="${PAD}" y="${top + 13}" fill="${theme.soft}" font-size="12" font-weight="500">${escX(ellipsize(spec.subtitle, W - PAD * 2, 12, 500, F))}</text>`);
    top += 18;
  }
  if (spec.title || spec.subtitle) top += 8;

  const isPie = spec.type === 'pie';
  const entries = isPie
    ? spec.categories.map((label, i) => ({ name: label, color: colorOf(i, label) }))
    : spec.series.map((s, i) => ({ name: s.name, color: colorOf(i) }));
  const model = { type: spec.type, W, H, series: [], bars: [], slices: [], legend: entries };

  // The legend: always for two or more series, and for a pie; swatch plus name in text ink.
  const legendRows = [];
  if (entries.length > 1 || isPie) {
    let row = [];
    let x = 0;
    for (const e of entries) {
      const name = ellipsize(e.name, 180, 12, 560, F);
      const w = 14 + textWidth(name, 12, 560, F) + 16;
      if (x + w > W - PAD * 2 && row.length) { legendRows.push(row); row = []; x = 0; }
      row.push({ ...e, label: name, x });
      x += w;
    }
    if (row.length) legendRows.push(row);
    for (const r of legendRows.slice(0, 3)) {
      for (const e of r) {
        parts.push(`<rect x="${r1(PAD + e.x)}" y="${top + 2}" width="10" height="10" rx="2.5" fill="${e.color}"/><text x="${r1(PAD + e.x + 14)}" y="${top + 11}" fill="${theme.soft}" font-size="12" font-weight="560">${escX(e.label)}</text>`);
      }
      top += 20;
    }
    top += 6;
  }

  if (isPie) {
    const s = spec.series[0];
    const total = s.points.reduce((n, p) => n + (p.y || 0), 0);
    const cx = W / 2;
    const avail = Math.min(W - PAD * 2, H - top - PAD);
    const R = Math.max(40, avail / 2);
    const cy = top + R;
    const r0 = R * 0.58;
    let a = 0;
    s.points.forEach((p, i) => {
      const frac = total > 0 ? (p.y || 0) / total : 0;
      const a1 = a + frac * Math.PI * 2;
      const label = spec.categories[i];
      if (frac > 0) parts.push(`<path d="${arcPath(cx, cy, r0, R, a, a1)}" fill="${colorOf(i, label)}" stroke="${theme.surface}" stroke-width="2" stroke-linejoin="round"/>`);
      model.slices.push({ i, label, value: p.y, frac, a0: a, a1, color: colorOf(i, label) });
      a = a1;
    });
    parts.push(`<text x="${cx}" y="${r1(cy + 2)}" text-anchor="middle" fill="${theme.ink}" font-size="${R > 90 ? 22 : 16}" font-weight="760">${escX(fmtY(total, true))}</text>`);
    parts.push(`<text x="${cx}" y="${r1(cy + (R > 90 ? 20 : 16))}" text-anchor="middle" fill="${theme.muted}" font-size="11" font-weight="560">total</text>`);
    Object.assign(model, { cx, cy, r0, R, total });
    return { svg: parts.join(''), model };
  }

  const horiz = spec.horizontal;
  const cat = spec.x.type === 'category';
  const cats = spec.categories || [];
  const stacked = spec.stacked;

  // The value domain (cumulative when stacked: positives and negatives stack apart).
  let vmin = Infinity;
  let vmax = -Infinity;
  const stackPos = new Map();
  const stackNeg = new Map();
  for (const s of spec.series) {
    for (const p of s.points) {
      if (p.y === null) continue;
      if (stacked) {
        const m = p.y >= 0 ? stackPos : stackNeg;
        const v = (m.get(p.x) || 0) + p.y;
        m.set(p.x, v);
        vmin = Math.min(vmin, v);
        vmax = Math.max(vmax, v);
      } else {
        vmin = Math.min(vmin, p.y);
        vmax = Math.max(vmax, p.y);
      }
    }
  }
  if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
  // Bars and areas grow from zero; a line may start where its data does unless zero is close.
  if (spec.type === 'bar' || spec.type === 'area' || (vmin > 0 && vmin < vmax * 0.5)) vmin = Math.min(vmin, 0);
  if (vmax < 0 && (spec.type === 'bar' || spec.type === 'area')) vmax = 0;
  if (spec.y.min !== null) vmin = spec.y.min;
  if (spec.y.max !== null) vmax = spec.y.max;
  const valueTicks = niceTicks(vmin, vmax, horiz ? Math.max(3, Math.floor((W - 160) / 90)) : Math.max(3, Math.floor((H - top - 60) / 46)));
  if (spec.y.min !== null) valueTicks.min = spec.y.min;
  if (spec.y.max !== null) valueTicks.max = spec.y.max;
  const ticksV = valueTicks.ticks.filter((t) => t >= valueTicks.min - 1e-9 && t <= valueTicks.max + 1e-9);

  // x domain for number and time axes.
  let xmin = Infinity;
  let xmax = -Infinity;
  if (!cat) for (const s of spec.series) for (const p of s.points) { xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x); }
  if (!cat && !Number.isFinite(xmin)) { xmin = 0; xmax = 1; }
  if (!cat && xmin === xmax) { xmin -= 1; xmax += 1; }
  let xTicks = [];
  let xUnit = 'day';
  if (spec.x.type === 'number') { const t = niceTicks(xmin, xmax, Math.max(3, Math.floor((W - 120) / 90))); xTicks = t.ticks.filter((v) => v >= xmin && v <= xmax); }
  if (spec.x.type === 'time') { const t = timeTicks(xmin, xmax, Math.max(3, Math.floor((W - 120) / 110)), spec.x.utc); xTicks = t.ticks; xUnit = t.unit; }
  const xTickText = (v) => (spec.x.type === 'time' ? fmtTime(v, xUnit, spec.x.utc) : fmtNum(v, { compact: true }));

  // Margins: value tick labels on the value axis, category or x labels on the other, the axis titles, end labels.
  const valueLabels = ticksV.map((t) => fmtY(t, true));
  const valueLabelW = Math.max(...valueLabels.map((t) => textWidth(t, 11, 500, F)), 10);
  const yTitle = horiz ? spec.x.label : spec.y.label;
  const xTitle = horiz ? spec.y.label : spec.x.label;
  const endLabels = (spec.type === 'line' || spec.type === 'area') && spec.series.length > 1 && spec.series.length <= 4 && !horiz;
  const endW = endLabels ? Math.min(120, Math.max(...spec.series.map((s) => textWidth(s.name, 12, 600, F))) + 12) : 0;
  let left = PAD + (yTitle ? 18 : 0);
  let bottom = H - PAD - (xTitle ? 18 : 0);
  if (horiz) {
    const catW = Math.min(160, Math.max(...cats.map((c) => textWidth(c, 11, 500, F)), 10));
    left += catW + 10;
    bottom -= 18;
  } else {
    left += valueLabelW + 10;
    bottom -= 20;
  }
  const right = W - PAD - endW - (horiz ? valueLabelW / 2 : 6);
  const plot = { x: left, y: top + 4, w: Math.max(40, right - left), h: Math.max(40, bottom - top - 4) };
  model.plot = plot;

  // Scales.
  const vToPx = (v) => (horiz
    ? plot.x + ((v - valueTicks.min) / (valueTicks.max - valueTicks.min || 1)) * plot.w
    : plot.y + plot.h - ((v - valueTicks.min) / (valueTicks.max - valueTicks.min || 1)) * plot.h);
  const n = Math.max(1, cats.length);
  const band = (horiz ? plot.h : plot.w) / n;
  const catCenter = (i) => (horiz ? plot.y + band * (i + 0.5) : plot.x + band * (i + 0.5));
  const xToPx = (x) => (cat ? catCenter(x) : plot.x + ((x - xmin) / (xmax - xmin)) * plot.w);
  model.band = band;
  model.horiz = horiz;
  model.catCenter = cat ? cats.map((_, i) => catCenter(i)) : null;

  // Grid and value axis labels.
  for (let i = 0; i < ticksV.length; i += 1) {
    const t = ticksV[i];
    const p = r1(vToPx(t));
    if (horiz) {
      parts.push(`<line x1="${p}" y1="${plot.y}" x2="${p}" y2="${plot.y + plot.h}" stroke="${t === 0 ? theme.axis : theme.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${p}" y="${r1(plot.y + plot.h + 16)}" text-anchor="middle" fill="${theme.muted}" font-size="11" font-weight="500">${escX(valueLabels[i])}</text>`);
    } else {
      parts.push(`<line x1="${plot.x}" y1="${p}" x2="${r1(plot.x + plot.w)}" y2="${p}" stroke="${t === 0 ? theme.axis : theme.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${r1(plot.x - 8)}" y="${r1(p + 4)}" text-anchor="end" fill="${theme.muted}" font-size="11" font-weight="500">${escX(valueLabels[i])}</text>`);
    }
  }
  // The other axis: its baseline and labels.
  if (horiz) {
    parts.push(`<line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${r1(plot.y + plot.h)}" stroke="${theme.axis}" stroke-width="1"/>`);
    const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plot.h / 16))));
    cats.forEach((c, i) => {
      if (i % step) return;
      parts.push(`<text x="${r1(plot.x - 8)}" y="${r1(catCenter(i) + 4)}" text-anchor="end" fill="${theme.muted}" font-size="11" font-weight="500">${escX(ellipsize(c, left - PAD - 18, 11, 500, F))}</text>`);
    });
  } else {
    const baseY = r1(plot.y + plot.h);
    parts.push(`<line x1="${plot.x}" y1="${baseY}" x2="${r1(plot.x + plot.w)}" y2="${baseY}" stroke="${theme.axis}" stroke-width="1"/>`);
    if (cat) {
      const maxW = Math.max(...cats.map((c) => Math.min(120, textWidth(c, 11, 500, F))), 10);
      const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plot.w / (maxW + 12)))));
      cats.forEach((c, i) => {
        if (i % step) return;
        parts.push(`<text x="${r1(catCenter(i))}" y="${r1(baseY + 16)}" text-anchor="middle" fill="${theme.muted}" font-size="11" font-weight="500">${escX(ellipsize(c, Math.max(band * step - 6, 30), 11, 500, F))}</text>`);
      });
    } else {
      for (const t of xTicks) parts.push(`<text x="${r1(xToPx(t))}" y="${r1(baseY + 16)}" text-anchor="middle" fill="${theme.muted}" font-size="11" font-weight="500">${escX(xTickText(t))}</text>`);
    }
  }
  if (yTitle) parts.push(`<text transform="translate(${PAD + 10} ${r1(plot.y + plot.h / 2)}) rotate(-90)" text-anchor="middle" fill="${theme.soft}" font-size="12" font-weight="600">${escX(ellipsize(yTitle, plot.h, 12, 600, F))}</text>`);
  if (xTitle) parts.push(`<text x="${r1(plot.x + plot.w / 2)}" y="${H - PAD + 2}" text-anchor="middle" fill="${theme.soft}" font-size="12" font-weight="600">${escX(ellipsize(xTitle, plot.w, 12, 600, F))}</text>`);

  const base = vToPx(Math.max(valueTicks.min, Math.min(0, valueTicks.max)));
  // Marks.
  if (spec.type === 'bar') {
    const k = spec.series.length;
    const inner = band * 0.72;
    const gap = 2;
    const thick = stacked ? Math.min(24, inner) : Math.max(2, Math.min(24, (inner - gap * (k - 1)) / k));
    const groupW = stacked ? thick : thick * k + gap * (k - 1);
    const posTop = new Map();
    const negTop = new Map();
    spec.series.forEach((s, si) => {
      for (const p of s.points) {
        if (p.y === null) continue;
        const c0 = catCenter(p.x) - groupW / 2 + (stacked ? 0 : si * (thick + gap));
        let from = 0;
        if (stacked) { const m = p.y >= 0 ? posTop : negTop; from = m.get(p.x) || 0; m.set(p.x, from + p.y); }
        const a = vToPx(from);
        const b = vToPx(from + p.y);
        // A 2 px surface gap between stacked segments: each segment after the first gives up 2 px at its base.
        const joined = stacked && from !== 0;
        const lo = Math.min(a, b);
        const len = Math.abs(b - a);
        let d;
        if (horiz) {
          const x0 = p.y >= 0 ? lo + (joined ? 2 : 0) : lo;
          const w = Math.max(0, len - (joined ? 2 : 0));
          d = barPath(x0, c0, w, thick, p.y >= 0 ? 'right' : 'left');
        } else {
          const y0 = p.y >= 0 ? lo : lo + (joined ? 2 : 0);
          const h = Math.max(0, len - (joined ? 2 : 0));
          d = barPath(c0, y0, thick, h, p.y >= 0 ? 'top' : 'bottom');
        }
        if (d) parts.push(`<path d="${d}" fill="${colorOf(si)}"/>`);
        model.bars.push({ si, x: p.x, y: p.y });
      }
    });
  } else {
    const lower = new Map();
    spec.series.forEach((s, si) => {
      const color = colorOf(si);
      const pts = [];
      for (const p of s.points) {
        if (p.y === null) { pts.push(null); continue; }
        let y = p.y;
        let y0 = 0;
        if (stacked) { y0 = lower.get(p.x) || 0; y = y0 + p.y; lower.set(p.x, y); }
        pts.push({ x: p.x, y: p.y, px: xToPx(p.x), py: vToPx(y), py0: vToPx(y0) });
      }
      const runs = [];
      let run = [];
      for (const q of pts) { if (q) run.push(q); else if (run.length) { runs.push(run); run = []; } }
      if (run.length) runs.push(run);
      if (spec.type === 'area') {
        for (const rn of runs) {
          const topLine = rn.map((q, i) => `${i ? 'L' : 'M'}${r1(q.px)} ${r1(q.py)}`).join('');
          const back = [...rn].reverse().map((q) => `L${r1(q.px)} ${r1(stacked ? q.py0 : base)}`).join('');
          parts.push(`<path d="${topLine}${back}Z" fill="${color}" fill-opacity="${stacked ? (theme.dark ? 0.3 : 0.22) : (theme.dark ? 0.16 : 0.1)}"/>`);
        }
      }
      if (spec.type === 'line' || spec.type === 'area') {
        for (const rn of runs) parts.push(`<path d="${rn.map((q, i) => `${i ? 'L' : 'M'}${r1(q.px)} ${r1(q.py)}`).join('')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        const real = pts.filter(Boolean);
        if (real.length <= 30) for (const q of real) parts.push(`<circle cx="${r1(q.px)}" cy="${r1(q.py)}" r="4" fill="${color}" stroke="${theme.surface}" stroke-width="2"/>`);
        else if (real.length) { const q = real[real.length - 1]; parts.push(`<circle cx="${r1(q.px)}" cy="${r1(q.py)}" r="4" fill="${color}" stroke="${theme.surface}" stroke-width="2"/>`); }
      }
      if (spec.type === 'scatter') for (const q of pts) if (q) parts.push(`<circle cx="${r1(q.px)}" cy="${r1(q.py)}" r="4" fill="${color}" fill-opacity=".85" stroke="${theme.surface}" stroke-width="2"/>`);
      model.series.push({ name: s.name, color, pts: pts.filter(Boolean) });
    });
    // Labels at the line ends, when they do not collide (the legend carries identity either way).
    if (endLabels) {
      const ends = model.series.map((s) => ({ s, q: s.pts[s.pts.length - 1] })).filter((e) => e.q).sort((a, b) => a.q.py - b.q.py);
      const clash = ends.some((e, i) => i && Math.abs(e.q.py - ends[i - 1].q.py) < 14);
      if (!clash) for (const e of ends) parts.push(`<text x="${r1(e.q.px + 8)}" y="${r1(e.q.py + 4)}" fill="${theme.soft}" font-size="12" font-weight="600">${escX(ellipsize(e.s.name, endW - 10, 12, 600, F))}</text>`);
    }
  }
  Object.assign(model, { vToPx, xToPx, cat, xmin, xmax });
  return { svg: parts.join(''), model };
}

/** The whole SVG document for export, with the surface behind it. */
export function svgDocument(markup, W, H, theme) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${escX(theme.font)}"><rect width="${W}" height="${H}" fill="${theme.surface}"/>${markup}</svg>`;
}

/**
 * A chart in the viewer: draws to fit its box, redraws on resize and theme change, shows a crosshair and tooltip on
 * hover, zooms, and exports. spec: a normalized spec (chartspec.js normalizeChart).
 */
export class ChartView {
  constructor(spec) {
    this.spec = spec;
    this.zoom = 1;
    this.el = document.createElement('div');
    this.el.className = 'ch';
    this.box = document.createElement('div');
    this.box.className = 'ch-box';
    this.el.append(this.box);
    this.tip = document.createElement('div');
    this.tip.className = 'ch-tip';
    this.tip.hidden = true;
    this.el.append(this.tip);
    this.box.addEventListener('pointermove', (e) => this.hover(e));
    this.box.addEventListener('pointerleave', () => this.unhover());
    this.ro = new ResizeObserver(() => this.queue());
    this.ro.observe(this.el);
    this.mo = new MutationObserver(() => this.queue());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  queue() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  /** The size a chart is drawn at: the box's, at least 320 by 220, at most 1600 by 1000. */
  size() {
    const w = Math.min(1600, Math.max(320, this.el.clientWidth - 24));
    const h = Math.min(1000, Math.max(220, this.el.clientHeight - 24));
    return [w, h];
  }

  draw() {
    if (!this.el.isConnected) return;
    const [w, h] = this.size();
    this.theme = chartTheme();
    const { svg, model } = drawChart(this.spec, w, h, this.theme);
    this.model = model;
    this.W = model.W;
    this.H = model.H;
    this.markup = svg;
    const title = this.spec.title || `${this.spec.type} chart`;
    this.box.innerHTML = `<svg class="ch-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.W} ${this.H}" width="${Math.round(this.W * this.zoom)}" height="${Math.round(this.H * this.zoom)}" role="img" aria-label="${escX(title)}" font-family="${escX(this.theme.font)}">${svg}<g class="ch-hover"></g></svg>`;
    this.svg = this.box.firstElementChild;
    this.hoverG = this.svg.querySelector('.ch-hover');
    this.box.classList.toggle('zoomed', this.zoom > 1);
  }

  setZoom(z) {
    this.zoom = Math.max(0.5, Math.min(4, z));
    this.draw();
    return this.zoom;
  }

  /** The pointer in chart coordinates. */
  point(e) {
    const r = this.svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.W, ((e.clientY - r.top) / r.height) * this.H];
  }

  hover(e) {
    if (!this.model || !this.svg) return;
    const [x, y] = this.point(e);
    const m = this.model;
    const spec = this.spec;
    const fmtY = (v) => fmtNum(v, { prefix: spec.y.prefix, suffix: spec.y.suffix, decimals: spec.y.decimals });
    const marks = [];
    let head = '';
    let rows = [];
    if (m.type === 'pie') {
      const dx = x - m.cx;
      const dy = y - m.cy;
      const d = Math.hypot(dx, dy);
      if (d < m.r0 - 2 || d > m.R + 4) { this.unhover(); return; }
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += Math.PI * 2;
      const s = m.slices.find((q) => a >= q.a0 && a < q.a1);
      if (!s) { this.unhover(); return; }
      marks.push(`<path d="${arcPath(m.cx, m.cy, m.r0 - 3, m.R + 3, s.a0, s.a1)}" fill="none" stroke="${this.theme.ink}" stroke-width="1.5" stroke-opacity=".55"/>`);
      head = s.label;
      rows = [{ color: s.color, name: fmtY(s.value), value: `${(s.frac * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%` }];
    } else {
      const p = m.plot;
      if (x < p.x - 12 || x > p.x + p.w + 12 || y < p.y - 12 || y > p.y + p.h + 12) { this.unhover(); return; }
      if (m.type === 'scatter') {
        let best = null;
        for (const s of m.series) for (const q of s.pts) { const d = Math.hypot(q.px - x, q.py - y); if (d < 24 && (!best || d < best.d)) best = { d, s, q }; }
        if (!best) { this.unhover(); return; }
        marks.push(`<circle cx="${r1(best.q.px)}" cy="${r1(best.q.py)}" r="7" fill="none" stroke="${best.s.color}" stroke-width="2"/>`);
        head = best.s.name;
        rows = [{ color: best.s.color, name: xText(spec, best.q.x), value: fmtY(best.q.y) }];
      } else {
        // The x under the pointer: a category, or the nearest x any series has.
        let key;
        if (m.cat) {
          const pos = m.horiz ? y - p.y : x - p.x;
          key = Math.max(0, Math.min(spec.categories.length - 1, Math.floor(pos / m.band)));
        } else {
          let best = Infinity;
          for (const s of m.series) for (const q of s.pts) { const d = Math.abs(q.px - x); if (d < best) { best = d; key = q.x; } }
        }
        if (key === undefined) { this.unhover(); return; }
        const at = m.cat ? m.catCenter[key] : m.xToPx(key);
        if (m.type === 'bar') {
          marks.push(m.horiz
            ? `<rect x="${p.x}" y="${r1(at - m.band / 2)}" width="${p.w}" height="${r1(m.band)}" fill="${this.theme.ink}" fill-opacity=".05"/>`
            : `<rect x="${r1(at - m.band / 2)}" y="${p.y}" width="${r1(m.band)}" height="${p.h}" fill="${this.theme.ink}" fill-opacity=".05"/>`);
        } else {
          marks.push(`<line x1="${r1(at)}" y1="${p.y}" x2="${r1(at)}" y2="${r1(p.y + p.h)}" stroke="${this.theme.muted}" stroke-width="1"/>`);
        }
        head = xText(spec, key);
        spec.series.forEach((s, si) => {
          const pt = s.points.find((q) => q.x === key);
          if (!pt || pt.y === null) return;
          const color = this.theme.series[si % this.theme.series.length];
          rows.push({ color, name: s.name, value: fmtY(pt.y) });
          if (m.type !== 'bar') {
            const ms = m.series[si]?.pts.find((q) => q.x === key);
            if (ms) marks.push(`<circle cx="${r1(ms.px)}" cy="${r1(ms.py)}" r="5" fill="${color}" stroke="${this.theme.surface}" stroke-width="2"/>`);
          }
        });
        if (!rows.length) { this.unhover(); return; }
      }
    }
    this.hoverG.innerHTML = marks.join('');
    this.tip.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'ch-tip-h';
    h.textContent = head;
    this.tip.append(h);
    for (const r of rows.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'ch-tip-r';
      const sw = document.createElement('i');
      sw.style.background = r.color;
      const n = document.createElement('span');
      n.textContent = r.name;
      const v = document.createElement('b');
      v.textContent = r.value;
      row.append(sw, n, v);
      this.tip.append(row);
    }
    this.tip.hidden = false;
    const box = this.el.getBoundingClientRect();
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let left = e.clientX - box.left + 14;
    let topPx = e.clientY - box.top + 14;
    if (left + tw > box.width - 6) left = e.clientX - box.left - tw - 14;
    if (topPx + th > box.height - 6) topPx = e.clientY - box.top - th - 14;
    this.tip.style.transform = `translate(${Math.max(6, Math.round(left))}px, ${Math.max(6, Math.round(topPx))}px)`;
  }

  unhover() {
    if (this.hoverG) this.hoverG.innerHTML = '';
    this.tip.hidden = true;
  }

  /** The chart as a standalone SVG document, in the theme it shows now. */
  svgText() { return svgDocument(this.markup || '', this.W, this.H, this.theme || chartTheme()); }

  /** The chart as PNG bytes (a Blob) at `scale` times its size, at most 2400 px a side. */
  async png(scale = 2) {
    const text = this.svgText();
    const s = Math.min(scale, 2400 / Math.max(this.W, this.H));
    const img = new Image();
    img.decoding = 'async';
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.round(this.W * s);
    c.height = Math.round(this.H * s);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made here.'))), 'image/png'));
  }

  destroy() {
    this.ro.disconnect();
    this.mo.disconnect();
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}
