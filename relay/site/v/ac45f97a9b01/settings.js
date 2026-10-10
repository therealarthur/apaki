/**
 * settings.js: the Settings sheet behind the gear in the rail's bottom-left
 * corner (Arthur, 2026-10-09: "there should also be a settings icon and phone
 * icon bottom left").
 *
 * It holds what used to sit in the footer as loose switches (theme, ding) and
 * the keep-warm switch that was only reachable as /warm: every choice is a
 * small segmented control, so there is no toggle knob to read as a status
 * dot. The search index line moved here too, with the footer keeping its
 * short form.
 *
 * initSettings({ button, sheet, send, theme, themeUi, sound, indexText, warm })
 * returns { handle(e), refresh() }; handle takes the engine's warmState event.
 * warm: false (the phone client) leaves keep-warm out: it is billing.
 */

import { esc } from './markdown.js';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function seg(name, options, value) {
  return `<div class="seg" role="radiogroup" data-seg="${name}">${options.map((o) => `<button role="radio" aria-checked="${o.value === value}" class="${o.value === value ? 'on' : ''}" data-v="${o.value}">${o.icon ? `<svg viewBox="0 0 16 16" aria-hidden="true">${o.icon}</svg>` : ''}${esc(o.label)}</button>`).join('')}</div>`;
}

export function initSettings({ button, sheet, send, theme, themeUi, sound, indexText, warm: showWarm = true }) {
  let warm = null;
  let root = null;

  function warmLine() {
    if (!warm) return 'Reading keep-warm…';
    const parts = [`Up to ${warm.hours} h after a conversation's last message`, `cap ${money(warm.dailyCapUsd)} a day`, `${money(warm.spentToday)} spent today`];
    if (warm.on) parts.push(warm.keeper ? `keeping ${warm.sessions} warm` : 'starts with the next message on a key');
    return parts.join(' · ');
  }

  function html() {
    const t = theme?.get?.() || 'auto';
    const themeOpts = Object.entries(themeUi).map(([value, ui]) => ({ value, label: ui.label, icon: ui.icon }));
    const ttl = warm && warm.ttl !== '1h' ? `<div class="set-warn">Needs "promptCacheTtl": "1h" in ~/.claude/settings.json (now ${esc(warm.ttl)}); with 5-minute caches the pings would cost more than they save.</div>` : '';
    const verdict = warm?.verdict ? `<div class="set-sub">Refresh check: ${esc(warm.verdict)}</div>` : '';
    return `<div class="settings">
      <h2>Settings</h2>
      <section class="set-row">
        <div class="set-t"><b>Theme</b><small>${t === 'auto' ? `Follows Windows, ${esc(theme?.effective?.() || 'light')} right now.` : 'Set here, whatever Windows uses.'}</small></div>
        ${seg('theme', themeOpts, t)}
      </section>
      <section class="set-row">
        <div class="set-t"><b>Ding</b><small>A soft chime when a conversation finishes or asks you something.</small></div>
        ${seg('ding', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], sound.on() ? 'on' : 'off')}
      </section>
      ${showWarm ? `<section class="set-row">
        <div class="set-t"><b>Keep cache warm</b><small>On API keys: a one-word request every 52 minutes keeps a conversation's prompt cache, so coming back reads it from cache instead of paying to write it again. ${esc(warmLine())}.</small>${ttl}${verdict}</div>
        ${seg('warm', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], warm?.on ? 'on' : 'off')}
      </section>` : ''}
      <section class="set-row set-info">
        <div class="set-t"><b>Search index</b><small class="set-index">${esc(indexText())}</small></div>
      </section>
      <div class="row"><button class="primary" data-k="done">Done</button></div>
    </div>`;
  }

  function paint() {
    if (!root) return;
    root.innerHTML = html();
    wire();
  }

  function wire() {
    root.querySelectorAll('.seg button').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.v;
        const which = b.parentElement.dataset.seg;
        if (which === 'theme') theme?.set?.(v);
        if (which === 'ding') sound.set(v === 'on');
        if (which === 'warm') { warm = { ...(warm || {}), on: v === 'on' }; send('warmState', { on: v === 'on' }); }
        paint();
      };
    });
    root.querySelector('[data-k=done]').onclick = () => close?.();
  }

  let close = null;
  function open() {
    if (showWarm) send('warmState');
    sheet('<div class="settings-host"></div>', (r, done) => {
      root = r.querySelector('.settings-host');
      close = () => { root = null; close = null; window.removeEventListener('keydown', onKey, true); done(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close?.(); } };
      window.addEventListener('keydown', onKey, true);
      paint();
    });
  }

  if (button) button.onclick = open;

  return {
    open,
    handle(e) { if (e.ev === 'warmState') { warm = e; paint(); } },
    refresh: paint,
  };
}
