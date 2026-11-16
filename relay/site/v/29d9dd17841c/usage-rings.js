/**
 * usage-rings.js: the 5-hour and weekly usage rings for Myrlin Glass in Apaki (2026-10-12).
 *
 * Arthur: "for myrlin glass integration we want the circle rings for 5 hour and 5-7 day usage limits with the timings
 * as well - lets make sure not to overcrowd the ui and show additional details when the user clicks in". The Glass
 * card in the sidebar shows two small rings per account (what is left of the 5-hour window and of the tightest
 * weekly window) with the time until each resets under it; the Glass panel (a click on the row) lists every window
 * with a larger ring, the share used and the exact reset time.
 *
 * Windows come from Glass through the engine (engine.js glassAccount): { label, percent (used), resetsAt, seconds }.
 * Glass names Claude's "Session" (5 hours), "Weekly" and per-model weekly ones ("Weekly Fable"); Codex's come from
 * its rate limits ("5-hour", "Weekly"). The window's length (seconds) decides which ring it is; the label is the
 * fallback when Glass did not say.
 *
 * A ring's fill is drawn from its data-left attribute by paintRings (a style attribute in markup is refused by the
 * phone page's CSP).
 *
 * 2026-10-13 (apaki/docs/style.md, Glass style): the card shows Glass's hero ring instead of the pair (heroFor below),
 * and every ring fills with the share used, as Glass draws it, in the provider's colour, amber from 75% and red from 90%.
 */

const SHORT_MAX_S = 6 * 3600;      // a window this long or shorter is the "5h" ring
const LONG_MIN_S = 4 * 24 * 3600;  // this long or longer is the "7d" ring
const LOW_LEFT = 15;               // at or under this share left a ring turns peach

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A window's length in seconds: what Glass said, else read from its label, else null. */
export function windowSeconds(w) {
  if (Number.isFinite(w?.seconds) && w.seconds > 0) return w.seconds;
  const l = String(w?.label || '').toLowerCase();
  if (/session|5[ -]?h|hour/.test(l)) return 5 * 3600;
  if (/week|7[ -]?d/.test(l)) return 7 * 24 * 3600;
  return null;
}

/** The two windows the card shows: the tightest short one and the tightest long one (either may be null). */
export function pickWindows(windows = []) {
  const byUsed = (x, y) => (y.percent ?? 0) - (x.percent ?? 0);
  const list = windows.filter((w) => w && Number.isFinite(Number(w.percent)));
  const short = list.filter((w) => (windowSeconds(w) ?? Infinity) <= SHORT_MAX_S).sort(byUsed)[0] || null;
  const long = list.filter((w) => (windowSeconds(w) ?? 0) >= LONG_MIN_S).sort(byUsed)[0] || null;
  return { short, long };
}

/** A reset time as milliseconds: an ISO string, epoch milliseconds, or epoch seconds (Codex). */
export function resetMs(resetsAt) {
  if (resetsAt == null || resetsAt === '') return null;
  if (typeof resetsAt === 'number' || /^\d+$/.test(String(resetsAt))) {
    const n = Number(resetsAt);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(resetsAt);
  return Number.isNaN(t) ? null : t;
}

/** How long until a window resets, short: "38m", "2h 13m", "3d 4h"; "" when unknown. */
export function untilText(resetsAt, now = Date.now()) {
  const t = resetMs(resetsAt);
  if (t == null) return '';
  const mins = Math.round((t - now) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  // A zero second part is left out: "3h", not "3h 0m".
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** The exact reset time in the user's own words: "3:42 PM" today, else "Fri 3:42 PM". */
export function resetAtText(resetsAt, now = Date.now()) {
  const t = resetMs(resetsAt);
  if (t == null) return '';
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Share left, 0 to 100, of a window. */
export const leftOf = (w) => Math.max(0, Math.min(100, 100 - Math.round(Number(w.percent) || 0)));

/** One ring: the share left as an arc, a short label inside ("5h", "7d"). */
export function ringHtml(w, label, { size = 'sm' } = {}) {
  const left = leftOf(w);
  // Since 2026-10-13 the arc is drawn as the share used, as Glass draws it (app.css); its severity rides on the arc.
  const sev = sevOf(100 - left);
  return `<span class="u-ring ${size}${left <= LOW_LEFT ? ' low' : ''}" data-left="${left}" aria-hidden="true">`
    + `<svg viewBox="0 0 36 36"><circle class="u-t" cx="18" cy="18" r="15"/><circle class="u-a${sev ? ` sev-${sev}` : ''}" cx="18" cy="18" r="15" pathLength="100"/></svg>`
    + `<b>${esc(label)}</b></span>`;
}

/** The card's pair: each ring with its countdown under it. Empty when the account has no windows. */
export function ringPairHtml(windows, now = Date.now()) {
  const { short, long } = pickWindows(windows);
  const unit = (w, label, name) => (w ? `<span class="u-unit" aria-label="${esc(`${name}: ${leftOf(w)}% left, resets in ${untilText(w.resetsAt, now) || 'unknown'}`)}">${ringHtml(w, label)}<span class="u-until">${esc(untilText(w.resetsAt, now))}</span></span>` : '');
  const html = unit(short, '5h', '5-hour window') + unit(long, '7d', long ? String(long.label || 'Weekly') : 'Weekly');
  return html ? `<span class="u-pair">${html}</span>` : '';
}

/** The panel's details: every window, a larger ring, the share used and the exact reset. */
export function windowsDetailHtml(windows = [], now = Date.now()) {
  const list = windows.filter((w) => w && Number.isFinite(Number(w.percent)))
    .sort((x, y) => (windowSeconds(x) ?? 0) - (windowSeconds(y) ?? 0) || String(x.label).localeCompare(String(y.label)));
  if (!list.length) return '';
  const short = (w) => ((windowSeconds(w) ?? 0) <= SHORT_MAX_S ? '5h' : (windowSeconds(w) ?? 0) >= LONG_MIN_S ? '7d' : '');
  return `<div class="u-detail">${list.map((w) => {
    const until = untilText(w.resetsAt, now);
    const at = resetAtText(w.resetsAt, now);
    return `<div class="u-win">${ringHtml(w, short(w), { size: 'md' })}<span class="u-txt"><span class="u-l">${esc(w.label || 'Usage')}</span>`
      + `<span class="u-v">${Math.round(Number(w.percent) || 0)}% used${at ? ` · resets ${esc(at)}` : ''}${until && until !== 'now' ? ` <span class="u-in">in ${esc(until)}</span>` : ''}</span></span></div>`;
  }).join('')}</div>`;
}

/* The hero ring (2026-10-13, apaki/docs/style.md).
   Arthur: "myrlin glass ui/ux is much clearer, we want to borrow from it as much as possible". Glass draws each provider's
   live account as one ring with the share used large in its centre: the outer ring the short window (Claude's Session,
   Codex's 5-hour), a thinner inner ring the weekly one, both filling with what is used, in the provider's colour, amber
   from 75% and red from 90%. The Glass card in the sidebar draws the same, so an account reads the same in both apps;
   every other window and the exact reset times stay in the panel a click opens. */

const WARN_AT = 75; // Glass's severity steps: amber from here,
const CRIT_AT = 90; // red from here.

/** Glass's severity for a share used: '' (normal), 'warn' or 'crit'. */
export function sevOf(pct) {
  const p = Number(pct) || 0;
  return p >= CRIT_AT ? 'crit' : p >= WARN_AT ? 'warn' : '';
}

/** A per-model weekly window ("Weekly Fable"): listed in the panel, never a ring (as in Glass). */
const scopedWeekly = (w) => /^weekly\s+\S/i.test(String(w?.label || '').trim());

/**
 * The hero's two windows, as Glass picks them: outer the shortest window, inner the longest (null with only one).
 * Per-model weekly windows are left out while a plain one exists.
 */
export function heroWindows(windows = []) {
  const list = windows.filter((w) => w && Number.isFinite(Number(w.percent)));
  if (!list.length) return { outer: null, inner: null };
  const base = list.filter((w) => !scopedWeekly(w));
  const secs = (w) => windowSeconds(w) ?? Number.MAX_SAFE_INTEGER;
  const pool = (base.length ? base : list).slice().sort((x, y) => secs(x) - secs(y));
  return { outer: pool[0], inner: pool.length > 1 ? pool[pool.length - 1] : null };
}

/** The ring window that matters most: the worse severity, then the larger share used. */
export function worstWindow({ outer, inner } = {}) {
  const rank = (w) => ({ '': 0, warn: 1, crit: 2 }[sevOf(w.percent)]);
  const list = [outer, inner].filter(Boolean);
  return list.reduce((best, w) => (!best || rank(w) > rank(best) || (rank(w) === rank(best) && Number(w.percent) > Number(best.percent)) ? w : best), null);
}

const usedOf = (w) => Math.max(0, Math.min(100, Math.round(Number(w?.percent) || 0)));

/**
 * One hero ring: arcs for { outer, inner } shares used (0 to 100, or null for a track only), and the number in its
 * centre ('' for none). The arcs are filled by paintRings from data-p (no style attribute: the phone page's CSP).
 */
export function heroRingHtml({ outer = null, inner = null, center = '', dim = false } = {}) {
  const arc = (p, cls) => (p == null ? '' : `<circle class="g-a${cls}${sevOf(p) ? ` sev-${sevOf(p)}` : ''}${p <= 0 ? ' is-zero' : ''}" cx="23" cy="23" r="${cls ? 15.5 : 20.75}" pathLength="100" data-p="${Math.max(0, Math.min(100, Math.round(p)))}"/>`);
  const n = String(center);
  const num = n === '' ? '' : /^\d+$/.test(n) ? `<span class="g-pct${n.length > 2 ? ' is-full' : ''}"><b>${esc(n)}</b>${n.length > 2 ? '' : '<i>%</i>'}</span>` : `<span class="g-pct"><b>${esc(n)}</b></span>`;
  return `<span class="g-ring${dim ? ' dim' : ''}${inner == null ? ' single' : ''}">`
    + '<svg viewBox="0 0 46 46" aria-hidden="true">'
    + '<circle class="g-t" cx="23" cy="23" r="20.75"/>' + arc(outer, '')
    + (inner == null ? '' : `<circle class="g-t in" cx="23" cy="23" r="15.5"/>${arc(inner, ' in')}`)
    + `</svg>${num}</span>`;
}

/**
 * A subscription's hero: its ring, and the line under its name (the window that matters and the time to its reset).
 * Returns { ring, line, sev } with line as escaped HTML; an account with no windows keeps its share left in words.
 */
export function heroFor(windows = [], { headroom = null, dim = false, now = Date.now() } = {}) {
  const pick = heroWindows(windows);
  const worst = worstWindow(pick);
  if (!worst) {
    const used = headroom == null ? null : 100 - Math.max(0, Math.min(100, Math.round(headroom)));
    return {
      ring: heroRingHtml({ outer: used, center: used == null ? '' : String(used), dim }),
      line: headroom == null ? '' : `<span class="num">${esc(String(Math.round(headroom)))}%</span> left`,
      sev: used == null ? '' : sevOf(used),
    };
  }
  const until = untilText(worst.resetsAt, now);
  const label = String(worst.label || 'Usage');
  return {
    ring: heroRingHtml({ outer: usedOf(pick.outer), inner: pick.inner ? usedOf(pick.inner) : null, center: String(usedOf(worst)), dim }),
    line: `<span class="lbl">${esc(label)}</span>${until ? `<span class="sep"> · </span><span class="num">${esc(until === 'now' ? 'resets now' : until)}</span>` : ''}`,
    sev: sevOf(worst.percent),
  };
}

/** Draws every ring's fill under root (after its HTML is in place). */
export function paintRings(root) {
  for (const r of root.querySelectorAll('.u-ring[data-left]')) r.style.setProperty('--left', r.dataset.left);
  // The hero rings' arcs (heroRingHtml): the share used of each window.
  for (const a of root.querySelectorAll('.g-ring .g-a[data-p]')) a.style.setProperty('--p', a.dataset.p);
}
