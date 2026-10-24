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
 * readOnly keeps account management on the desktop; can controls phone swaps and settings.
 */

import { esc } from './markdown.js';
import { pc } from './platform.js';
import { glassPanelProvider, openGlassPanel } from './glasspanel.js';
import { heroFor, heroRingHtml, paintRings, resetAtText, ringPairHtml, sevOf } from './usage-rings.js';

import { PROVIDER_NAMES as PROVIDERS, displayProviders } from './glass-providers.js';
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

/** The row's tooltip: every usage window Glass tracks, and why an account is not usable. */
function rowTitle(provider, a) {
  if (!a) return `${PROVIDERS[provider]}: no account is signed in. Click to choose one.`;
  const lines = [`${PROVIDERS[provider]}: ${a.name}${a.isKey ? ' (API key, billed per token)' : a.plan ? ` (${a.plan})` : ''}`];
  if (a.isKey && a.leftUsd != null) lines.push(`${money(a.leftUsd)}${a.creditUsd ? ` of ${money(a.creditUsd)}` : ''} left this month${a.detail ? ` · ${a.detail}` : ''}`);
  else for (const w of a.windows || []) lines.push(`${w.label}: ${w.percent}% used${w.resetsAt ? `, resets ${resetAtText(w.resetsAt)}` : ''}`);
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
  // A subscription shows its 5-hour and weekly rings with the time to each reset (2026-10-12, usage-rings.js);
  // an API key, which has no windows, keeps the dollars and the thin meter.
  const rings = a && !a.isKey && !busy ? ringPairHtml(a.windows || []) : '';
  return `<button class="gc-row${rings ? ' rings' : ''}${busy ? ' busy' : ''}${low ? ' low' : ''}${a && !usable(a) ? ' warn' : ''}" data-p="${provider}" title="${esc(rowTitle(provider, a))}">
    <span class="gc-prov">${PROVIDERS[provider]}</span><span class="gc-name">${name}</span><span class="gc-left">${esc(left)}</span>
    ${rings || `<span class="gc-meter" aria-hidden="true"><i data-v="${share == null ? 0 : (share / 100).toFixed(3)}"></i></span>`}</button>`;
}

/**
 * The row in Glass's own manner (2026-10-13, apaki/docs/style.md; Arthur: borrow Glass's clearer UI "as much as
 * possible"): one hero ring per provider with the share used large in its centre (the outer ring the short window, the
 * inner the weekly one), the provider in its colour (Claude clay, Codex green, a key in Apaki's periwinkle), the
 * account's name, and one line: the window that matters with the time to its reset, amber from 75% and red from 90%.
 * Every window, the exact times and the switch stay in the panel a click opens ("show additional details when the
 * user clicks in"). A key's ring is the share of its credit spent, its line the dollars left.
 */
export function heroRowHtml(provider, a, busy = false) {
  const key = Boolean(a?.isKey);
  const prov = `${PROVIDERS[provider]}${key ? ' · API key' : ''}`;
  let hero;
  if (!a) hero = { ring: heroRingHtml({ outer: null }), line: '<span class="g-faint">Click to choose an account</span>', sev: '' };
  else if (key) {
    const share = leftShare(a);
    const spent = share == null ? null : 100 - Math.round(share);
    hero = { ring: heroRingHtml({ outer: spent, center: spent == null ? '$' : String(spent), dim: !usable(a) }), line: esc(leftText(a)), sev: spent == null ? '' : sevOf(spent) };
  } else hero = heroFor(a.windows || [], { headroom: a.headroom, dim: !usable(a) });
  // An account Glass cannot use says why instead of its usage.
  const why = a && !usable(a) ? (STATE_HINT[a.state] || a.detail || a.state) : '';
  const line = busy ? 'Switching…' : why ? esc(why) : hero.line;
  const lineCls = busy ? '' : why ? (a.state === 'stale' ? ' is-warn' : ' is-bad') : hero.sev ? ` sev-${hero.sev}` : '';
  const plan = a && !key && a.plan ? `<span class="gc-plan">${esc(a.plan)}</span>` : '';
  const name = a ? `<span class="gc-n">${esc(a.name)}</span>${plan}` : '<span class="gc-n gc-none">Not signed in</span>';
  return `<button class="gc-row hero${key ? ' is-key' : ''}${busy ? ' busy' : ''}${a && !usable(a) ? ' warn' : ''}" data-p="${provider}" title="${esc(rowTitle(provider, a))}">`
    + `${hero.ring}<span class="g-txt"><span class="gc-prov">${esc(prov)}</span><span class="gc-name">${name}</span>`
    + `<span class="g-line${lineCls}">${line}</span></span>`
    // Says the row opens the account chooser (2026-10-18, Arthur: "doesnt let you choose and swap claude/codex
    // credentials on the myrlin glass section"; the switch was there, behind a row that did not look clickable).
    + `<span class="g-go" aria-hidden="true">Switch<svg viewBox="0 0 12 12"><path d="m4.5 3 3 3-3 3"/></svg></span></button>`;
}

/** Glass's mark: two nested arcs in the providers' colours (the widget's own brand mark), drawn small. */
const GLASS_MARK = '<svg class="gc-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="t" cx="8" cy="8" r="6.4"/><circle class="t" cx="8" cy="8" r="3.4"/><circle class="c" cx="8" cy="8" r="6.4" pathLength="100"/><circle class="x" cx="8" cy="8" r="3.4" pathLength="100"/></svg>';

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

export function initGlassCard({ root, send, menu, note, readOnly = false, can = (op) => op !== 'glassSwap' || !readOnly }) {
  let last = null;
  let panel = null;
  let sequence = 0;
  const requests = new Map();
  const request = (op, args = {}) => {
    if (op !== 'glassProviders' && op !== 'glassSwap') return send(op, args);
    const reqId = `glass${++sequence}`;
    requests.set(reqId, { op, provider: args.provider });
    const failed = (message) => handle({ ev: 'error', reqId, message });
    try {
      return Promise.resolve(send(op, { ...args, reqId })).then((ok) => {
        if (ok === false) failed('The computer is disconnected. Try again after it reconnects.');
      }, (error) => failed(error.message));
    } catch (error) { failed(error.message); }
  };
  const panelActions = {
    send: request, readOnly, can,
    onSettings: () => { panel = openGlassPanel(root, 'settings', last, panelActions); if (can('glassProviders')) request('glassProviders'); },
    onSwitch: (provider, id) => {
      if (!can('glassSwap') || last?.[provider]?.id === id) return;
      busy.add(provider);
      render();
      request('glassSwap', { provider, account: id });
    },
  };
  const busy = new Set();
  const seen = { claude: null, codex: null, kimi: null };
  // The countdowns under the rings stay true: one redraw a minute, only while the window is visible.
  setInterval(() => { if (last && document.visibilityState === 'visible') render(); }, 60000);

  function render(flash = []) {
    if (!last) return;
    if (!last.installed) {
      root.hidden = false;
      root.innerHTML = '<div class="gc-head"><span class="gl">Myrlin Glass</span></div><div class="gc-off">Not installed on this ' + pc() + ', so Apaki bills the live login.</div>';
      return;
    }
    root.hidden = false;
    // Glass's hero rows (heroRowHtml, 2026-10-13); rowHtml above is the earlier two-ring row, kept for reference.
    root.innerHTML = `<div class="gc-head"><span class="gl">${GLASS_MARK}<b>Myrlin</b> Glass</span><button class="gp-btn gc-sub" data-settings title="Choose providers shown in Glass">Settings</button></div>${displayProviders(last).map((p) => heroRowHtml(p, last[p], busy.has(p))).join('')}${displayProviders(last).length ? '' : '<div class="gc-off">All providers are hidden.</div>'}`;
    root.querySelector('[data-settings]').onclick = panelActions.onSettings;
    // Fills from script, not style attributes in markup (the phone page's CSP refuses those).
    paintRings(root);
    for (const i of root.querySelectorAll('.gc-meter i[data-v]')) i.style.setProperty('--v', i.dataset.v);
    for (const b of root.querySelectorAll('.gc-row')) {
      const provider = b.dataset.p;
      if (flash.includes(provider)) b.classList.add('flash');
      if (!can('glassSwap')) { b.title = b.title.replace('Click to switch account', 'Click for usage details'); b.querySelector('.g-go').textContent = 'Details'; }
      // The Glass panel (glasspanel.js, 2026-10-10): sections, usage, switch, rename, sign in, hide, add.
      b.onclick = () => { panel = openGlassPanel(root, provider, last, panelActions); };
    }
  }

  function handle(e) {
    if (e.ev === 'error') {
      const pending = requests.get(e.reqId);
      if (!pending) return;
      e = { ...e, ev: pending.op === 'glassProviders' ? 'glass_providers' : 'glass_swap', provider: pending.provider, ok: false };
    }
    if (e.ev === 'glass_providers' || e.ev === 'glass_swap') requests.delete(e.reqId);
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
      if (open) panel = openGlassPanel(root, open === 'settings' || displayProviders(last).includes(open) ? open : 'settings', last, panelActions);
      return;
    }
    if (e.ev === 'glass_providers') {
      if (e.ok && last) handle({ ...last, visibleProviders: e.visibleProviders, knownProviders: e.knownProviders });
      panel?.result(e);
      if (!e.ok) note?.(`Glass settings: ${e.message}`, 'error');
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
