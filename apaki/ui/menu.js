/**
 * menu.js: one small popover menu for Apaki (model, effort, mode, folder
 * pickers in the composer, and the right-click menu on a session).
 *
 * menu(anchor, items, { onPick, above }) where each item is
 * { label, value, hint?, html?, checked?, danger?, divider? }. It opens next to
 * the anchor element (or at an {x, y} point), keeps inside the window, and
 * closes on a pick, a click outside, Escape or a scroll. Arrow keys and Enter
 * work. No library: one element, reused.
 */

import { esc } from './markdown.js';

let open = null;

export function closeMenu() {
  if (!open) return;
  const { el, cleanup } = open;
  open = null;
  cleanup();
  el.classList.add('out');
  setTimeout(() => el.remove(), 110);
}

export function menu(anchor, items, { onPick, above = true, width } = {}) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  if (width) el.style.minWidth = `${width}px`;
  const buttons = [];
  for (const it of items) {
    if (it.divider) { el.append(Object.assign(document.createElement('div'), { className: 'menu-div' })); continue; }
    if (it.heading) { el.append(Object.assign(document.createElement('div'), { className: 'menu-head', textContent: it.heading })); continue; }
    const b = document.createElement('button');
    b.className = `menu-item${it.checked ? ' on' : ''}${it.danger ? ' danger' : ''}`;
    b.innerHTML = `${it.html || `<span class="ml">${esc(it.label)}</span>`}${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}`;
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); onPick?.(it.value, it); };
    el.append(b);
    buttons.push(b);
  }
  document.body.append(el);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const m = el.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - m.width - 8);
  let top = above ? r.top - m.height - 6 : r.bottom + 6;
  if (top < 8) top = r.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 6);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
  let sel = buttons.findIndex((b) => b.classList.contains('on'));
  const paint = () => buttons.forEach((b, i) => b.classList.toggle('kb', i === sel));
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; paint(); return; }
    if (e.key === 'Enter' && buttons[sel]) { e.preventDefault(); buttons[sel].click(); }
  };
  const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('blur', closeMenu);
  open = {
    el,
    cleanup: () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', closeMenu);
    },
  };
  return el;
}

/**
 * The effort dot grid: five columns of three dots, one column lit per level
 * (low to max). At max the lit grid ripples, like Claude's top effort
 * setting. Pure markup; the motion is CSS (and off under reduced motion).
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function effortGrid(level, { live = false } = {}) {
  const n = Math.max(1, EFFORTS.indexOf(level) + 1);
  let dots = '';
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) dots += `<i style="--c:${c};--r:${r}"${c < n ? ' class="lit"' : ''}></i>`;
  return `<span class="egrid${n === 5 ? ' max' : ''}${live ? ' live' : ''}" aria-hidden="true">${dots}</span>`;
}
