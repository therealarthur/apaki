/**
 * glasscard.js: Myrlin Glass in the rail's bottom-left corner.
 *
 * Arthur, 2026-10-09: "on the bottom left it shows the status/ui of glass
 * (like the selected api key/subscription that is active on the system, and
 * the selected chatgpt/codex account thats logged in)". One row per
 * provider: the live Claude account (a key is tagged API key, so it never
 * reads as a subscription) and the live Codex account, each with how much is
 * left and a thin meter. Clicking a row lists that provider's accounts;
 * picking one asks Glass to switch (`glass swap ... --user-asked`), which
 * moves every session on this PC, the same as Glass's own widget.
 *
 * The data is the engine's `glass` event (engine.js glassView); a switch is
 * the `glassSwap` op and comes back as `glass_swap`.
 *
 * initGlassCard({ root, send, menu, note, readOnly }) returns { handle(e) }.
 * readOnly (the phone client) shows the card without the switch menus.
 */

import { esc } from './markdown.js';
import { glassPanelProvider, openGlassPanel } from './glasspanel.js';

const PROVIDERS = { claude: 'Claude', codex: 'Codex' };
// At or under this share left the meter turns peach.
const LOW = 15;
const STATE_HINT = { needsLogin: 'sign in again in Glass', noSubscription: 'no subscription', stale: 'usage out of date', unknown: 'not checked yet' };
const usable = (a) => a.state === 'ok' || a.state === 'stale';

const money = (n) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;

/** What is left, in words: dollars for a key, a percentage for a subscription. */
export function leftText(a) {
  if (a.isKey) return a.leftUsd != null ? `${money(a.leftUsd)} left` : '';
  return a.headroom != null ? `${a.headroom}% left` : '';
}

/** The share left, 0 to 100, for the meter; null when Glass does not know. */
export function leftShare(a) {
  if (a.isKey && a.leftUsd != null && a.creditUsd) return Math.max(0, Math.min(100, (100 * a.leftUsd) / a.creditUsd));
  return a.headroom == null ? null : Math.max(0, Math.min(100, a.headroom));
}

function resetText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const soon = d.getTime() - Date.now() < 20 * 3600 * 1000;
  return d.toLocaleString(undefined, soon ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The row's tooltip: every usage window Glass tracks, and why an account is not usable. */
function rowTitle(provider, a) {
  if (!a) return `${PROVIDERS[provider]}: no account is signed in. Click to choose one.`;
  const lines = [`${PROVIDERS[provider]}: ${a.name}${a.isKey ? ' (API key, billed per token)' : a.plan ? ` (${a.plan})` : ''}`];
  if (a.isKey && a.leftUsd != null) lines.push(`${money(a.leftUsd)}${a.creditUsd ? ` of ${money(a.creditUsd)}` : ''} left this month${a.detail ? ` · ${a.detail}` : ''}`);
  else for (const w of a.windows || []) lines.push(`${w.label}: ${w.percent}% used${w.resetsAt ? `, resets ${resetText(w.resetsAt)}` : ''}`);
  if (a.state !== 'ok' && a.detail) lines.push(a.detail);
  lines.push('Click to switch account');
  return lines.join('\n');
}

function rowHtml(provider, a, busy) {
  const share = a ? leftShare(a) : null;
  const low = share != null && share <= LOW;
  const tag = a?.isKey ? '<span class="key-tag">API key</span>' : a?.plan ? `<span class="gc-plan">${esc(a.plan)}</span>` : '';
  const name = a ? `<span class="gc-n">${esc(a.name)}</span>${tag}` : '<span class="gc-n gc-none">Not signed in</span>';
  const left = busy ? 'Switching…' : a ? leftText(a) : '';
  return `<button class="gc-row${busy ? ' busy' : ''}${low ? ' low' : ''}${a && !usable(a) ? ' warn' : ''}" data-p="${provider}" title="${esc(rowTitle(provider, a))}">
    <span class="gc-prov">${PROVIDERS[provider]}</span><span class="gc-name">${name}</span><span class="gc-left">${esc(left)}</span>
    <span class="gc-meter" aria-hidden="true"><i style="--v:${share == null ? 0 : (share / 100).toFixed(3)}"></i></span></button>`;
}

/** The menu of one provider's accounts: subscriptions, then API keys; ones Glass cannot use are dimmed. */
export function accountItems(provider, list = []) {
  const item = (a) => ({
    value: a.id,
    checked: a.active,
    disabled: usable(a) ? false : (a.detail || STATE_HINT[a.state] || a.state),
    html: `<span class="ml">${esc(a.name)}</span>${a.isKey ? '<span class="key-tag">API key</span>' : ''}`,
    hint: usable(a) ? [a.isKey ? '' : a.plan, leftText(a)].filter(Boolean).join(' · ') : (STATE_HINT[a.state] || a.state),
  });
  const byLeft = (x, y) => (usable(y) - usable(x)) || ((leftShare(y) ?? -1) - (leftShare(x) ?? -1));
  const subs = list.filter((a) => !a.isKey).sort(byLeft);
  const keys = list.filter((a) => a.isKey).sort(byLeft);
  const items = [];
  if (provider === 'claude') {
    if (subs.length) items.push({ heading: 'Claude subscriptions' }, ...subs.map(item));
    if (keys.length) items.push({ heading: 'Claude API keys · billed per token' }, ...keys.map(item));
  } else if (subs.length) items.push({ heading: `${PROVIDERS[provider]} accounts` }, ...subs.map(item));
  if (!items.length) items.push({ label: 'Glass has no accounts for this yet', value: '__none', disabled: true });
  items.push({ divider: true }, { label: 'Check usage now', value: '__refresh', hint: 'asks Glass' });
  return items;
}

export function initGlassCard({ root, send, menu, note, readOnly = false }) {
  let last = null;
  let panel = null;
  const panelActions = {
    send,
    onSwitch: (provider, id) => {
      if (last?.[provider]?.id === id) return;
      busy.add(provider);
      render();
      send('glassSwap', { provider, account: id });
    },
  };
  const busy = new Set();
  const seen = { claude: null, codex: null };

  function render(flash = []) {
    if (!last) return;
    if (!last.installed) {
      root.hidden = false;
      root.innerHTML = '<div class="gc-head"><span class="gl">Myrlin Glass</span></div><div class="gc-off">Not installed on this PC, so Apaki bills the live login.</div>';
      return;
    }
    root.hidden = false;
    root.innerHTML = `<div class="gc-head"><span class="gl">Myrlin Glass</span><span class="gc-sub">live on this PC</span></div>${rowHtml('claude', last.claude, busy.has('claude'))}${rowHtml('codex', last.codex, busy.has('codex'))}`;
    for (const b of root.querySelectorAll('.gc-row')) {
      const provider = b.dataset.p;
      if (flash.includes(provider)) b.classList.add('flash');
      if (readOnly) { b.disabled = true; b.title = b.title.replace('Click to switch account', 'Switch accounts on the PC'); continue; }
      // The Glass panel (glasspanel.js, 2026-10-10): sections, usage, switch, rename, sign in, hide, add.
      b.onclick = () => { panel = openGlassPanel(root, provider, last, panelActions); };
    }
  }

  function handle(e) {
    if (e.ev === 'glass') {
      // A row flashes when its live account changed (a swap here, in Glass, or by an agent).
      const flash = [];
      for (const p of Object.keys(PROVIDERS)) {
        const id = e[p]?.id ?? null;
        if (seen[p] !== null && seen[p] !== id) flash.push(p);
        seen[p] = id;
      }
      if (e.changed && !flash.includes('claude')) flash.push('claude');
      last = e;
      render(flash);
      // An open panel follows Glass: a rename, a hide, a new account, a swap.
      const open = glassPanelProvider();
      if (open) panel = openGlassPanel(root, open, last, panelActions);
      return;
    }
    if (e.ev === 'glass_op') { panel?.result(e); return; }
    if (e.ev === 'glass_swap') {
      busy.delete(e.provider);
      if (!e.ok) note?.(`Glass did not switch ${PROVIDERS[e.provider] || e.provider}: ${e.message}`, 'error');
      if (glassPanelProvider()) panel?.result({ ok: e.ok, message: e.ok ? `${PROVIDERS[e.provider]} switched.` : e.message });
      render();
    }
  }

  return { handle, get state() { return last; } };
}
