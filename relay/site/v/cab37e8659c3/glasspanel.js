/**
 * glasspanel.js: the Glass panel, opened from a row of the Glass card in
 * the rail's corner (2026-10-10).
 *
 * Arthur: the account list "looks a little rough - not super well formatted
 * (you have some names that are so long for a credential it pushes usage
 * out, its hard to see the different sections, the fonts are weird, etc.
 * you should also be able to edit names of credentials here, reconnect them
 * if you want, add credentials, remove them".
 *
 * One provider per panel. Sections: the live account, subscriptions, API
 * keys (Claude), accounts that need signing in again, and hidden ones. Every
 * row has fixed columns (name, usage, actions), so a long name is cut with an
 * ellipsis (the whole name on hover) and never pushes the usage out.
 *
 * What each action does (engine glassOp, the `glass` command line):
 *   Use        switches the live login (glass swap --user-asked)
 *   Rename     subscriptions are renamed in Workbook, their owner; API keys in Glass
 *   Sign in    reconnects an account, or adds one (a browser sign-in you finish)
 *   Hide/Show  leaves a subscription out of the lists; Workbook keeps the login
 *   Remove     an API key: Glass deletes the entry and its keys (two clicks)
 *   Add key    a Console org's API credits; the keys go to Glass on stdin only
 * A row shows only Use (or Sign in) and a "more" button; Rename, Sign in
 * again, Hide/Show and Remove sit in that menu, so the name keeps its room.
 *
 * openGlassPanel(anchor, provider, data, actions) / closeGlassPanel() /
 * glassPanelProvider(); actions = { send, onSwitch }.
 */

import { esc } from './markdown.js';
import { leftShare, leftText } from './glasscard.js';

const NAMES = { claude: 'Claude', codex: 'Codex' };
const NEEDS = new Set(['needsLogin', 'noSubscription']);
const ICON = {
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.9l2.5 2.5-7.6 7.6-3 .5.5-3z"/></svg>',
  hide: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><path d="M2.5 13.5l11-11"/></svg>',
  show: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/></svg>',
  trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.4h10.4M6.2 4.4V2.9h3.6v1.5M4.2 4.4l.6 8.4c.1.7.6 1.2 1.3 1.2h3.8c.7 0 1.2-.5 1.3-1.2l.6-8.4"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7M13.2 2.6v2.9h-2.9"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.4" cy="8" r=".9"/></svg>',
};

let open = null;

export function closeGlassPanel() {
  if (!open) return;
  const o = open;
  open = null;
  o.cleanup();
  o.el.classList.add('out');
  setTimeout(() => o.el.remove(), 110);
}

/** Which provider the open panel shows (the card redraws it as Glass changes), or null. */
export const glassPanelProvider = () => open?.provider || null;

const resetText = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const soon = d.getTime() - Date.now() < 20 * 3600 * 1000;
  return d.toLocaleString(undefined, soon ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

/**
 * The faint line under a name: plan or org, when the tightest limit resets,
 * or why it needs attention. The usage column already says how much is left,
 * so this line does not repeat a percent.
 */
function subLine(a) {
  if (NEEDS.has(a.state)) return a.state === 'noSubscription' ? 'No subscription on this login' : a.detail || 'Needs signing in again';
  if (a.isKey) return [a.detail, a.keyHint, a.error].filter(Boolean).join(' · ') || 'Console org';
  const w = (a.windows || []).filter((x) => x.resetsAt).sort((x, y) => y.percent - x.percent)[0];
  return [a.plan, w ? `${String(w.label || '').toLowerCase()} resets ${resetText(w.resetsAt)}` : '', a.state === 'stale' ? 'usage out of date' : ''].filter(Boolean).join(' · ');
}

/** The row's "more" menu: rename, sign in again, hide or show, remove (API keys). */
function menu(a, ui) {
  const confirming = ui.confirm === a.id;
  const items = [`<button data-a="rename">${ICON.edit}<span>Rename${a.isKey ? '' : '<small>in Workbook, so it shows everywhere</small>'}</span></button>`];
  if (!a.isKey) items.push(`<button data-a="login">${ICON.refresh}<span>Sign in again<small>reconnect this login in a browser</small></span></button>`);
  if (a.isKey && !a.active) items.push(`<button data-a="remove" class="${confirming ? 'sure' : 'danger'}">${ICON.trash}<span>${confirming ? 'Click again to remove' : 'Remove this key'}<small>Glass deletes the entry and its keys</small></span></button>`);
  else if (!a.isKey && !a.active) items.push(`<button data-a="${a.hidden ? 'show' : 'hide'}">${a.hidden ? ICON.show : ICON.hide}<span>${a.hidden ? 'Show in the lists' : 'Hide from the lists'}<small>Workbook keeps the login</small></span></button>`);
  return `<div class="gp-menu" role="menu">${items.join('')}</div>`;
}

function row(provider, a, ui) {
  const share = leftShare(a);
  const low = share != null && share <= 15;
  const needs = NEEDS.has(a.state);
  const renaming = ui.renaming === a.id;
  const tag = a.isKey ? '<span class="key-tag">API key</span>' : '';
  const name = renaming
    ? `<input class="gp-rename" value="${esc(a.label || a.name)}" maxlength="60" spellcheck="false" aria-label="New name">`
    : `<span class="gp-n" title="${esc(a.name)}">${esc(a.name)}</span>${tag}`;
  const use = needs ? '' : `<div class="gp-use${low ? ' low' : ''}"><span class="gp-left">${esc(leftText(a) || '')}</span><span class="gp-meter" aria-hidden="true"><i style="--v:${share == null ? 0 : (share / 100).toFixed(3)}"></i></span></div>`;
  const acts = [];
  if (!a.active && !needs) acts.push('<button class="gp-btn primary" data-a="use" title="Make this the live login on this PC">Use</button>');
  if (needs) acts.push(`<button class="gp-btn" data-a="login" title="Sign this account in again in a browser window">Sign in</button>`);
  const menuOpen = ui.menu === a.id;
  acts.push(`<button class="gp-icon gp-more${menuOpen ? ' on' : ''}" data-a="menu" aria-haspopup="menu" aria-expanded="${menuOpen}" title="Rename, sign in again, ${a.isKey ? 'remove' : 'hide'}">${ICON.more}</button>`);
  return `<div class="gp-row${a.active ? ' live' : ''}${needs ? ' needs' : ''}${a.hidden ? ' hidden-acct' : ''}${menuOpen ? ' menu-open' : ''}" data-id="${esc(a.id)}">
    <div class="gp-main"><div class="gp-name">${name}</div><div class="gp-sub" title="${esc(subLine(a))}">${esc(subLine(a))}</div></div>
    ${use}<div class="gp-act">${acts.join('')}</div>${menuOpen ? menu(a, ui) : ''}</div>`;
}

function render(box, provider, data, ui) {
  const list = (data?.lists?.[provider] || []).slice();
  const byLeft = (x, y) => (leftShare(y) ?? -1) - (leftShare(x) ?? -1);
  const live = list.find((a) => a.active) || data?.[provider] || null;
  const rest = list.filter((a) => !a.active);
  const visible = rest.filter((a) => !a.hidden);
  const subs = visible.filter((a) => !a.isKey && !NEEDS.has(a.state)).sort(byLeft);
  const keys = visible.filter((a) => a.isKey).sort(byLeft);
  const needs = visible.filter((a) => !a.isKey && NEEDS.has(a.state));
  const hidden = rest.filter((a) => a.hidden);
  const sec = (title, rows, extra = '') => (rows.length ? `<div class="gp-sec"><span>${esc(title)}</span><span class="gp-sec-n">${rows.length}</span>${extra}</div>${rows.map((a) => row(provider, a, ui)).join('')}` : '');
  const form = ui.adding === 'key' ? `<form class="gp-form" autocomplete="off">
      <div class="gp-form-h">Add a Console org's API credits</div>
      <label>Name<input name="label" maxlength="48" placeholder="e.g. Studio" required></label>
      <label>Admin API key<input name="adminKey" type="password" placeholder="sk-ant-admin01-…" required></label>
      <label>Usage key <small>optional, lets Glass use this org for Claude Code</small><input name="usageKey" type="password" placeholder="sk-ant-api03-…"></label>
      <div class="gp-form-row"><label>Monthly credit ($)<input name="credit" type="number" min="1" value="200"></label><label>Resets on day<input name="resetDay" type="number" min="1" max="31" value="1"></label></div>
      <p class="gp-note">The keys go straight to Glass (Windows Credential Manager); Apaki does not keep them.</p>
      <div class="gp-form-act"><button type="button" class="gp-btn" data-a="cancel-add">Cancel</button><button type="submit" class="gp-btn primary">Add key</button></div>
    </form>` : '';
  box.innerHTML = `
    <div class="gp-head"><span class="gp-h">${NAMES[provider]}</span><span class="gp-brand">Myrlin Glass</span>
      <button class="gp-icon" data-a="refresh" title="Ask Glass to check usage now">${ICON.refresh}</button></div>
    <div class="gp-body">
      ${live ? `<div class="gp-sec"><span>Live on this PC</span></div>${row(provider, { ...live, active: true }, ui)}` : `<p class="gp-empty">No ${NAMES[provider]} account is live on this PC.</p>`}
      ${sec('Subscriptions', subs)}
      ${provider === 'claude' ? sec('API keys · billed per token', keys) : ''}
      ${sec('Needs signing in', needs)}
      ${hidden.length ? `<button class="gp-sec gp-toggle" data-a="toggle-hidden" aria-expanded="${ui.showHidden}"><span>Hidden</span><span class="gp-sec-n">${hidden.length}</span><span class="gp-chev">${ui.showHidden ? 'hide' : 'show'}</span></button>${ui.showHidden ? hidden.map((a) => row(provider, a, ui)).join('') : ''}` : ''}
      ${form}
    </div>
    <div class="gp-foot">
      <button class="gp-btn" data-a="add-login">${ICON.plus}Add a ${NAMES[provider]} ${provider === 'claude' ? 'subscription' : 'account'}</button>
      ${provider === 'claude' ? `<button class="gp-btn" data-a="add-key">${ICON.plus}Add an API key</button>` : ''}
    </div>
    ${ui.msg ? `<div class="gp-msg${ui.msg.ok ? '' : ' err'}">${esc(ui.msg.text)}</div>` : ''}`;
}

export function openGlassPanel(anchor, provider, data, actions) {
  const again = open?.provider === provider;
  if (open && !again) closeGlassPanel();
  const ui = again ? open.ui : { renaming: null, confirm: null, menu: null, adding: null, showHidden: false, msg: null };
  const box = again ? open.el : document.createElement('div');
  const keep = again ? box.querySelector('.gp-body')?.scrollTop || 0 : 0;
  if (!again) box.className = 'glass-panel';
  const find = (id) => (data?.lists?.[provider] || []).find((a) => a.id === id) || (data?.[provider]?.id === id ? data[provider] : null);
  const paint = () => {
    render(box, provider, data, ui);
    box.querySelector('.gp-body').scrollTop = keep;
    wire();
  };
  const say = (text, ok = true) => { ui.msg = { text, ok }; paint(); };
  const wire = () => {
    box.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.a;
        const id = b.closest('.gp-row')?.dataset.id;
        const acct = id ? find(id) : null;
        if (a === 'menu' && acct) { ui.menu = ui.menu === acct.id ? null : acct.id; ui.confirm = null; paint(); box.querySelector('.gp-menu button')?.focus({ preventScroll: true }); return; }
        if (a !== 'remove') { ui.menu = null; ui.confirm = null; }
        if (a === 'refresh') { actions.send('glass', { refresh: true }); say('Asked Glass to check usage now.'); return; }
        if (a === 'use' && acct) { actions.onSwitch(provider, acct.id); say(`Switching ${NAMES[provider]} to ${acct.name}…`); return; }
        if (a === 'login') { actions.send('glassLogin', { provider, email: acct?.email || '' }); say('A sign-in window is opening; finish it there and the account shows here.'); return; }
        if (a === 'rename' && acct) { ui.renaming = acct.id; paint(); const inp = box.querySelector('.gp-rename'); inp?.focus(); inp?.select(); return; }
        if ((a === 'hide' || a === 'show') && acct) { actions.send('glassHide', { provider, account: acct.id, hidden: a === 'hide' }); say(a === 'hide' ? `Hiding ${acct.name}; it stays in Workbook.` : `Showing ${acct.name} again.`); return; }
        if (a === 'remove' && acct) {
          if (ui.confirm !== acct.id) { ui.confirm = acct.id; paint(); setTimeout(() => { if (ui.confirm === acct.id) { ui.confirm = null; if (open?.el === box) paint(); } }, 4000); return; }
          ui.confirm = null;
          ui.menu = null;
          actions.send('glassApiRemove', { label: acct.label || acct.name });
          say(`Removing ${acct.name}…`);
          return;
        }
        if (a === 'toggle-hidden') { ui.showHidden = !ui.showHidden; paint(); return; }
        if (a === 'add-login') { actions.send('glassLogin', { provider }); say('A sign-in window is opening; sign in with the new account and it shows here.'); return; }
        if (a === 'add-key') { ui.adding = 'key'; paint(); box.querySelector('.gp-form input')?.focus(); return; }
        if (a === 'cancel-add') { ui.adding = null; paint(); }
      };
    });
    const inp = box.querySelector('.gp-rename');
    if (inp) {
      const done = (save) => {
        const id = ui.renaming;
        ui.renaming = null;
        const name = inp.value.replace(/\s+/g, ' ').trim();
        const acct = find(id);
        if (save && acct && name && name !== (acct.label || acct.name)) {
          actions.send('glassRename', { provider, account: acct.id, name });
          say(acct.isKey ? `Renaming the key to ${name}…` : `Renaming in Workbook to ${name}…`);
        } else paint();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); done(false); } });
      inp.addEventListener('blur', () => { if (ui.renaming) done(true); });
      inp.onclick = (e) => e.stopPropagation();
    }
    const form = box.querySelector('.gp-form');
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const label = String(f.get('label') || '').trim();
        const adminKey = String(f.get('adminKey') || '').trim();
        if (!label || !adminKey) return;
        actions.send('glassApiAdd', { label, adminKey, usageKey: String(f.get('usageKey') || '').trim(), credit: Number(f.get('credit')) || 200, resetDay: Number(f.get('resetDay')) || 1 });
        form.reset(); // the keys leave the page at once
        ui.adding = null;
        say(`Adding ${label}…`);
      };
    }
    // A "more" menu that would run past the bottom of the list opens upward.
    const m = box.querySelector('.gp-menu');
    const body = box.querySelector('.gp-body');
    if (m && body && m.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) m.classList.add('up');
    box.onclick = () => { if (ui.menu) { ui.menu = null; ui.confirm = null; paint(); } };
    box.querySelectorAll('.gp-row').forEach((r) => {
      r.onclick = (e) => {
        if (ui.menu) { e.stopPropagation(); ui.menu = null; ui.confirm = null; paint(); return; }
        const acct = find(r.dataset.id);
        if (acct && !acct.active && !NEEDS.has(acct.state) && !ui.renaming) { actions.onSwitch(provider, acct.id); say(`Switching ${NAMES[provider]} to ${acct.name}…`); }
      };
    });
  };
  paint();
  if (!again) {
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    const w = 420;
    box.style.width = `${w}px`;
    box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    box.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
    box.style.maxHeight = `${Math.max(260, r.top - 24)}px`;
    const onDown = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closeGlassPanel(); };
    const onKey = (e) => {
      if (e.key !== 'Escape' || box.querySelector('.gp-rename')) return;
      e.preventDefault();
      if (ui.menu) { ui.menu = null; ui.confirm = null; paint(); return; } // Escape closes the row menu first
      closeGlassPanel();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    open = { el: box, provider, ui, cleanup: () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); } };
  } else {
    open.provider = provider;
  }
  return {
    /** A glass_op result: what Glass said, in the panel's message line. */
    result(e) { if (open?.el === box) say(e.ok ? (e.message || 'Done.') : `Glass said: ${e.message || 'it did not work'}`, e.ok); },
  };
}
