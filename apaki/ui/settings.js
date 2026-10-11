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
 * initSettings({ button, sheet, send, theme, themeUi, sound, indexText, warm, compact })
 * returns { handle(e), refresh() }; handle takes the engine's warmState and autoCompact events.
 * warm: false (the phone client) leaves keep-warm out: it is billing.
 * compact: false (the phone client) leaves "Auto-compact at" out: it is the PC's, kept by
 * the engine (apaki/engine/prefs.js) and passed to every Claude Code it starts.
 */

import { esc } from './markdown.js';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function seg(name, options, value) {
  return `<div class="seg" role="radiogroup" data-seg="${name}">${options.map((o) => `<button role="radio" aria-checked="${o.value === value}" class="${o.value === value ? 'on' : ''}" data-v="${o.value}">${o.icon ? `<svg viewBox="0 0 16 16" aria-hidden="true">${o.icon}</svg>` : ''}${esc(o.label)}</button>`).join('')}</div>`;
}

/** The choices of "Auto-compact", in the order shown (the engine's COMPACT_CHOICES; 'off' is the default, 'default' leaves it to Claude Code). */
const COMPACT_LABELS = [{ value: 'off', label: 'Off' }, { value: 200000, label: '200k' }, { value: 300000, label: '300k' }, { value: 500000, label: '500k' }, { value: 'default', label: 'Claude Code default' }];

export function initSettings({ button, sheet, send, theme, themeUi, sound, indexText, warm: showWarm = true, compact: showCompact = true }) {
  let warm = null;
  // The engine's answer to autoCompact: { value, choices, standard }; null until it arrives.
  let compact = null;
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
      ${showCompact ? `<section class="set-row set-stack">
        <div class="set-t"><b>Auto-compact</b><small>Off: a conversation keeps its whole context until the window is full, and you summarize it when you choose (Compact now on the context meter, or /compact). A size: Claude Code summarizes it on its own once its context reaches that size; a lower size costs less per call, since every call re-reads the history. Left to Claude Code, a 1M-token window such as Opus's compacts near 967k. Applies to conversations as they next start.</small></div>
        ${seg('compact', COMPACT_LABELS, compact?.value ?? null)}
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
        if (which === 'compact') { const value = v === 'default' || v === 'off' ? v : Number(v); compact = { ...(compact || {}), value }; send('autoCompact', { value }); }
        paint();
      };
    });
    root.querySelector('[data-k=done]').onclick = () => close?.();
  }

  let close = null;
  function open() {
    if (showWarm) send('warmState');
    if (showCompact) send('autoCompact');
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
    handle(e) {
      if (e.ev === 'warmState') { warm = e; paint(); }
      if (e.ev === 'autoCompact') { compact = e; paint(); }
    },
    refresh: paint,
  };
}
