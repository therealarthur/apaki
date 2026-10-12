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
  return `<span class="u-ring ${size}${left <= LOW_LEFT ? ' low' : ''}" data-left="${left}" aria-hidden="true">`
    + '<svg viewBox="0 0 36 36"><circle class="u-t" cx="18" cy="18" r="15"/><circle class="u-a" cx="18" cy="18" r="15" pathLength="100"/></svg>'
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

/** Draws every ring's fill under root (after its HTML is in place). */
export function paintRings(root) {
  for (const r of root.querySelectorAll('.u-ring[data-left]')) r.style.setProperty('--left', r.dataset.left);
}
