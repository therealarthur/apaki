/**
 * menu.js: one small popover menu for Apaki (model, effort, mode, folder
 * pickers in the composer, and the right-click menu on a session).
 *
 * menu(anchor, items, { onPick, above }) where each item is
 * { label, value, hint?, html?, checked?, danger?, disabled?, divider? }.
 * A disabled item is shown dimmed and cannot be picked (keys skip it). It opens next to
 * the anchor element (or at an {x, y} point), keeps inside the window, and
 * closes on a pick, a click outside, Escape or a scroll. Arrow keys and Enter
 * work. No library: one element, reused.
 *
 * For a popup that holds settings rather than one choice (the effort menu with Ultracode, 2026-10-13) an item may also be
 *   { keep: true, ... }                      a pick that leaves the menu open; the caller repaints it with el.update(items)
 *   { note: 'text' }                         a quiet line of explanation, not clickable
 *   { seg: [{ value, label, checked, hint?, disabled? }], label? }
 *                                            a row of choices side by side (a pick leaves the menu open)
 * menu() returns the element; el.update(items) rebuilds the rows in place and keeps the menu where its anchor puts it.
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
  let buttons = [];
  // Builds the rows (also the repaint of el.update): items become buttons, headings, dividers, notes and segmented rows.
  const fill = (list) => {
    el.textContent = '';
    buttons = [];
    for (const it of list) {
      if (it.divider) { el.append(Object.assign(document.createElement('div'), { className: 'menu-div' })); continue; }
      if (it.heading) { el.append(Object.assign(document.createElement('div'), { className: 'menu-head', textContent: it.heading })); continue; }
      if (it.note) { el.append(Object.assign(document.createElement('div'), { className: 'menu-note', textContent: it.note })); continue; }
      if (it.seg) {
        if (it.label) el.append(Object.assign(document.createElement('div'), { className: 'menu-seg-label', textContent: it.label }));
        const row = Object.assign(document.createElement('div'), { className: 'menu-seg' });
        for (const s of it.seg) {
          const sb = document.createElement('button');
          sb.className = `menu-seg-item${s.checked ? ' on' : ''}`;
          sb.textContent = s.label;
          if (s.hint) sb.title = s.hint;
          sb.setAttribute('aria-pressed', s.checked ? 'true' : 'false');
          if (s.disabled) sb.disabled = true;
          sb.onclick = (e) => { e.stopPropagation(); onPick?.(s.value, { ...s, seg: true }); };
          row.append(sb);
          if (!s.disabled) buttons.push(sb);
        }
        el.append(row);
        continue;
      }
      const b = document.createElement('button');
      b.className = `menu-item${it.checked ? ' on' : ''}${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`;
      if (it.disabled) { b.disabled = true; b.title = it.disabled === true ? '' : String(it.disabled); }
      b.innerHTML = `${it.html || `<span class="ml">${esc(it.label)}</span>`}${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}`;
      b.onclick = (e) => { e.stopPropagation(); if (!it.keep) closeMenu(); onPick?.(it.value, it); };
      el.append(b);
      if (!it.disabled) buttons.push(b);
    }
  };
  fill(items);
  document.body.append(el);
  // Next to the anchor, inside the window; run again after el.update since the rows (and so the height) may have changed.
  const place = () => {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
    const m = el.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - m.width - 8);
    let top = above ? r.top - m.height - 6 : r.bottom + 6;
    if (top < 8) top = r.bottom + 6;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 6);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${top}px`;
  };
  place();
  let sel = buttons.findIndex((b) => b.classList.contains('on'));
  const paint = () => buttons.forEach((b, i) => b.classList.toggle('kb', i === sel));
  // A settings popup repaints itself after a pick that keeps it open: the keyboard row stays where it was.
  el.update = (next) => {
    const keep = sel;
    fill(next);
    sel = Math.min(keep, buttons.length - 1);
    place();
    if (keep >= 0) paint();
  };
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

export function effortGrid(level, { live = false, levels = null } = {}) {
  // A Codex model lists its own efforts (2026-10-12): the grid spreads however many there are over the five columns.
  const list = Array.isArray(levels) && levels.length ? levels : EFFORTS;
  const at = list.indexOf(level);
  const n = list === EFFORTS ? Math.max(1, at + 1) : Math.max(1, Math.min(5, Math.round(((at < 0 ? 0 : at + 1) / list.length) * 5)));
  let dots = '';
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) dots += `<i style="--c:${c};--r:${r}"${c < n ? ' class="lit"' : ''}></i>`;
  return `<span class="egrid${n === 5 ? ' max' : ''}${live ? ' live' : ''}" aria-hidden="true">${dots}</span>`;
}
