/**
 * tooltip.js: Apaki's own hover tooltips, in place of the browser's.
 *
 * WHY (Arthur, 2026-10-12): "we should have the popups from hovering over elements (like the context) be formatted
 * properly - currently they are not formatted properly". Every hover text in the window was a `title` attribute, which
 * WebView2 shows as a plain Windows tooltip: system font, its own wrapping, light even in dark mode, line breaks shown
 * as they come and no structure. This layer takes over every `title` in the document, so existing code keeps setting
 * `el.title` and gets Apaki's tooltip:
 *
 *   - on hover (mouse or pen; never touch) after a short wait, and at once while you move from one to the next;
 *   - on keyboard focus (:focus-visible), so the same help reaches people who do not use a mouse;
 *   - gone on leave, click, scroll, Escape, or when the element goes away.
 *
 * Text tooltips are formatted from their own lines: with several lines the first is the heading; a part after " · "
 * is quieter; a line (or part) that says what a click does ("Click to ...", "Double-click to rename") is set apart at
 * the end; key names such as Shift+Tab or "(Enter)" are drawn as keys.
 *
 * setTip(el, { head, meter, tone, rows, lines, hint }) gives an element a structured tooltip instead (the context meter
 * and the billing chip use it). The title attribute is moved to data-tip when first shown, and its text is kept as the
 * element's aria-description, so screen readers still hear it.
 */

const SHOW_MS = 450;        // hover this long before a tooltip shows
const SKIM_MS = 450;        // a tooltip hidden less than this long ago: the next one shows at once
const GAP = 8;              // between the element and the tooltip
const EDGE = 8;             // kept clear of the window's edges

const rich = new WeakMap(); // element -> structured content (setTip)
let tip = null;             // the one tooltip element
let target = null;          // the element it is for (or will be, once the wait is over)
let timer = 0;
let hiddenAt = 0;
let watcher = null;         // follows the target's title while it shows (the context meter changes during a turn)
let quiet = null;           // clicked: no tooltip for it again until the pointer leaves it (as the browser's own did)

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Key names drawn as keys: modifier combinations (Shift+Tab, Ctrl+Enter, Ctrl+B), and Enter / Esc / Tab in parentheses.
const KEYS = /\b((?:Ctrl|Shift|Alt|Cmd)(?:\+(?:Ctrl|Shift|Alt|Cmd))*\+(?:Enter|Tab|Space|Backspace|Esc|Up|Down|Left|Right|[A-Z0-9]\b|[↑↓←→]))|\((Enter|Esc|Tab)\)/g;
// A combination never breaks across lines (tt-keys is nowrap).
const keys = (s) => esc(s).replace(KEYS, (m, combo, single) => (combo
  ? `<span class="tt-keys">${combo.split('+').map((k) => `<kbd>${k}</kbd>`).join('<span class="tt-plus">+</span>')}</span>`
  : `(<kbd>${single}</kbd>)`));
const hasKeys = (s) => { KEYS.lastIndex = 0; const hit = KEYS.test(s); KEYS.lastIndex = 0; return hit; };

// What a click (or a drag) does: set apart at the end.
const ACTION = /^(?:click|double-click|ctrl\+click|shift-click|shift\+click|right-click|drag|press)\b/i;

/** The HTML for a text tooltip (exported for tests). */
export function formatTip(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const hints = [];
  const body = [];
  for (const line of lines) {
    if (ACTION.test(line)) { hints.push(line); continue; }
    const parts = line.split(' · ');
    const main = parts.shift();
    // Parts after " · " that say what a click does, or name a shortcut, move to the hint line; the rest stay, quieter.
    const quiet = [];
    for (const p of parts) (ACTION.test(p) || hasKeys(p) ? hints : quiet).push(p);
    body.push(keys(main) + quiet.map((q) => `<span class="tt-q"> · ${keys(q)}</span>`).join(''));
  }
  let html = '';
  if (body.length > 1) html += `<div class="tt-head">${body[0]}</div>${body.slice(1).map((b) => `<div class="tt-line">${b}</div>`).join('')}`;
  else if (body.length === 1) html += `<div class="tt-line tt-only">${body[0]}</div>`;
  if (hints.length) html += `<div class="tt-hint">${hints.map((h) => keys(h.charAt(0).toUpperCase() + h.slice(1))).join(' · ')}</div>`;
  return html;
}

/** The HTML for a structured tooltip: a heading, an optional meter, label/value rows, lines and a hint. */
export function formatRich(c = {}) {
  let html = '';
  if (c.head) html += `<div class="tt-head">${keys(c.head)}</div>`;
  if (typeof c.meter === 'number') {
    const v = Math.max(0, Math.min(1, c.meter));
    // The fill is set from script after rendering (render): a style attribute in markup is refused by the phone page's CSP.
    html += `<div class="tt-meter${c.tone ? ` ${esc(c.tone)}` : ''}" data-v="${v.toFixed(3)}"><i></i></div>`;
  }
  if (c.rows?.length) html += `<div class="tt-rows">${c.rows.map(([k, v]) => `<span class="tt-k">${esc(k)}</span><span class="tt-v">${keys(v)}</span>`).join('')}</div>`;
  for (const l of c.lines || []) if (l) html += `<div class="tt-line">${keys(l)}</div>`;
  if (c.hint) html += `<div class="tt-hint">${keys(c.hint)}</div>`;
  return html;
}

/** Plain words for a structured tooltip (aria-description). */
function richText(c = {}) {
  return [c.head, ...(c.rows || []).map(([k, v]) => `${k}: ${v}`), ...(c.lines || []), c.hint].filter(Boolean).map((x) => String(x).replace(/[.\s]+$/, '')).join('. ');
}

/** Gives an element a structured tooltip (or removes it with null). */
export function setTip(el, content) {
  if (!el) return;
  if (!content) { rich.delete(el); el.removeAttribute('data-tip-rich'); return; }
  rich.set(el, content);
  el.setAttribute('data-tip-rich', '');
  el.removeAttribute('title');
  el.setAttribute('aria-description', richText(content));
  if (target === el && tip && !tip.hidden) render(el);
}

/** The element under the pointer (or focused) that has a tooltip, if any. */
function tipTarget(node) {
  for (let el = node; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
    if (rich.has(el) || el.hasAttribute('title') || el.hasAttribute('data-tip')) return el;
  }
  return null;
}

/** Moves a title into data-tip, so the browser's own tooltip never shows; its words stay for screen readers. */
function adopt(el) {
  if (!el.hasAttribute('title')) return;
  const t = el.getAttribute('title');
  el.removeAttribute('title');
  el.setAttribute('data-tip', t);
  if (t && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-description')) el.setAttribute('aria-description', t.replace(/\s*\n\s*/g, '. '));
}

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tt';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function render(el) {
  const html = rich.has(el) ? formatRich(rich.get(el)) : formatTip(el.getAttribute('data-tip'));
  if (!html) { hide(); return false; }
  ensureTip().innerHTML = html;
  const m = tip.querySelector('.tt-meter');
  if (m) m.style.setProperty('--tt-v', m.dataset.v);
  return true;
}

/** Puts the tooltip under the element (above when there is no room), inside the window. */
function place(el) {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) { hide(); return; }
  tip.style.left = '0px';
  tip.style.top = '0px';
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let top = r.bottom + GAP;
  let below = true;
  if (top + h > vh - EDGE && r.top - GAP - h >= EDGE) { top = r.top - GAP - h; below = false; }
  const left = Math.max(EDGE, Math.min(vw - EDGE - w, r.left + r.width / 2 - w / 2));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(Math.max(EDGE, top))}px`;
  tip.classList.toggle('above', !below);
}

function show(el) {
  if (!el.isConnected) return;
  adopt(el);
  if (!render(el)) return;
  tip.hidden = false;
  tip.classList.remove('in');
  place(el);
  void tip.offsetWidth; // restart the entrance
  tip.classList.add('in');
  watcher?.disconnect();
  watcher = new MutationObserver(() => {
    if (!el.isConnected) { hide(); return; }
    if (el.hasAttribute('title')) adopt(el);
    if (render(el)) place(el);
  });
  watcher.observe(el, { attributes: true, attributeFilter: ['title', 'data-tip'] });
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  watcher?.disconnect();
  watcher = null;
  if (tip && !tip.hidden) { tip.hidden = true; hiddenAt = Date.now(); }
  target = null;
}

function arm(el) {
  if (el === target || el === quiet) return;
  hide();
  target = el;
  // Adopt now, so the browser's own tooltip never gets its chance during the wait.
  adopt(el);
  const wait = Date.now() - hiddenAt < SKIM_MS ? 0 : SHOW_MS;
  timer = setTimeout(() => { timer = 0; if (target === el) show(el); }, wait);
}

/** Starts the tooltip layer for the document (once). */
export function initTooltips() {
  if (initTooltips.done) return;
  initTooltips.done = true;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = tipTarget(e.target);
    if (el) arm(el);
    else if (target) hide();
  }, true);
  // An element that gets its title while the pointer already rests on it (no pointerover comes): checked as it moves.
  document.addEventListener('pointermove', (e) => {
    if (target || e.pointerType === 'touch') return;
    const el = tipTarget(e.target);
    if (el) arm(el);
  }, { capture: true, passive: true });
  document.addEventListener('pointerout', (e) => {
    const inside = (el) => el && e.relatedTarget && el.contains(e.relatedTarget);
    if (quiet && !inside(quiet)) quiet = null;
    if (!target) return;
    // Still inside the same element (moving between its children): keep it.
    if (inside(target)) return;
    hide();
  }, true);
  document.addEventListener('pointerdown', (e) => { quiet = target || tipTarget(e.target); hide(); }, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  // Only a scroll that moves the element closes its tooltip: a conversation scrolling itself while Claude writes does not.
  document.addEventListener('scroll', (e) => {
    if (target && (e.target === document || (e.target.nodeType === 1 && e.target.contains(target)))) hide();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && target) hide(); }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target?.nodeType === 1 && e.target.matches(':focus-visible') ? tipTarget(e.target) : null;
    if (el === e.target) arm(el);
  });
  document.addEventListener('focusout', (e) => { if (target && e.target === target) hide(); });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
