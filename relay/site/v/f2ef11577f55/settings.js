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
 * initSettings({ button, sheet, send, theme, themeUi, sound, indexText, warm, compact, release })
 * returns { handle(e), refresh() }; handle takes the engine's warmState, autoCompact and releaseHidden events.
 * warm: false (the phone client) leaves keep-warm out: it is billing.
 * compact: false (the phone client) leaves "Auto-compact at" out: it is the PC's, kept by
 * the engine (apaki/engine/prefs.js) and passed to every Claude Code it starts.
 * release: false (the phone client) leaves "Free hidden conversations" out: also the PC's (the host closes the
 * Claude Code process of a conversation in a tab that has been hidden and idle; 2026-10-12).
 * autostart: { get(), set(on) } (promises of a boolean) for "Open at sign-in", the window shell's (src/autostart.rs,
 * 2026-10-15, after Arthur's PC came back from a crash without Apaki); null (the phone client) leaves it out.
 */

import { esc } from './markdown.js';
import { osName } from './platform.js';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function seg(name, options, value) {
  return `<div class="seg" role="radiogroup" data-seg="${name}">${options.map((o) => `<button role="radio" aria-checked="${o.value === value}" class="${o.value === value ? 'on' : ''}" data-v="${o.value}">${o.icon ? `<svg viewBox="0 0 16 16" aria-hidden="true">${o.icon}</svg>` : ''}${esc(o.label)}</button>`).join('')}</div>`;
}

/** The choices of "Auto-compact", in the order shown (the engine's COMPACT_CHOICES; 'off' is the default, 'default' leaves it to Claude Code). */
const COMPACT_LABELS = [{ value: 'off', label: 'Off' }, { value: 200000, label: '200k' }, { value: 300000, label: '300k' }, { value: 500000, label: '500k' }, { value: 'default', label: 'Claude Code default' }];

/** The choices of "Free hidden conversations", in the order shown (the engine's RELEASE_CHOICES, minutes; 0 is off). */
const RELEASE_LABELS = [{ value: 0, label: 'Off' }, { value: 5, label: '5 min' }, { value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '1 h' }];

export function initSettings({ button, sheet, send, theme, themeUi, sound, indexText, warm: showWarm = true, compact: showCompact = true, release: showRelease = true, autostart = null }) {
  let warm = null;
  // The engine's answer to autoCompact: { value, choices, standard }; null until it arrives.
  let compact = null;
  // The engine's answer to releaseHidden: { value (minutes), choices, standard }; null until it arrives.
  let release = null;
  let root = null;
  // Open at sign-in: true or false once the shell answers, 'n/a' when this window's shell cannot (an older build).
  let signIn = null;

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
        <div class="set-t"><b>Theme</b><small>${t === 'auto' ? `Follows ${osName()}, ${esc(theme?.effective?.() || 'light')} right now.` : `Set here, whatever ${osName()} uses.`}</small></div>
        ${seg('theme', themeOpts, t)}
      </section>
      <section class="set-row">
        <div class="set-t"><b>Ding</b><small>A soft chime when a conversation finishes or asks you something.</small></div>
        ${seg('ding', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], sound.on() ? 'on' : 'off')}
      </section>
      ${autostart ? `<section class="set-row">
        <div class="set-t"><b>Open at sign-in</b><small>${signIn === 'n/a' ? 'Restart Apaki once to use this.' : `Apaki opens when you sign in to ${osName()}, with your tabs as you left them. A conversation that was running when the PC stopped waits for your next message.`}</small></div>
        ${signIn === 'n/a' ? '' : seg('signin', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], signIn === null ? null : signIn ? 'on' : 'off')}
      </section>` : ''}
      ${showWarm ? `<section class="set-row">
        <div class="set-t"><b>Keep cache warm</b><small>On API keys: a one-word request every 52 minutes keeps a conversation's prompt cache, so coming back reads it from cache instead of paying to write it again. ${esc(warmLine())}.</small>${ttl}${verdict}</div>
        ${seg('warm', [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], warm?.on ? 'on' : 'off')}
      </section>` : ''}
      ${showCompact ? `<section class="set-row set-stack">
        <div class="set-t"><b>Auto-compact</b><small>Off: a conversation keeps its whole context until the window is full, and you summarize it when you choose (Compact now on the context meter, or /compact). A size: Claude Code summarizes it on its own once its context reaches that size; a lower size costs less per call, since every call re-reads the history. Left to Claude Code, a 1M-token window such as Opus's compacts near 967k. Applies to conversations as they next start.</small></div>
        ${seg('compact', COMPACT_LABELS, compact?.value ?? null)}
      </section>` : ''}
      ${showRelease ? `<section class="set-row set-stack">
        <div class="set-t"><b>Free hidden conversations</b><small>Each open conversation keeps a Claude Code process of its own (about 150 MB). One in a tab that is not showing, with nothing running and no question waiting, lets go of it after this long. It starts again, in about a second, with your next message there; nothing is lost and the cache is untouched.</small></div>
        ${seg('release', RELEASE_LABELS, release?.value ?? null)}
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
        if (which === 'release') { const value = Number(v); release = { ...(release || {}), value }; send('releaseHidden', { value }); }
        if (which === 'signin' && autostart) {
          const on = v === 'on';
          signIn = on;
          autostart.set(on).then((now) => { signIn = now === true; paint(); }).catch(() => { signIn = 'n/a'; paint(); });
        }
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
    if (showRelease) send('releaseHidden');
    if (autostart) autostart.get().then((on) => { signIn = on === true; paint(); }).catch(() => { signIn = 'n/a'; paint(); });
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
      if (e.ev === 'releaseHidden') { release = e; paint(); }
    },
    refresh: paint,
  };
}
