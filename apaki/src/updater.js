// updater.js: injected into Myrlin Apaki's window on every platform (apaki/src/updater.rs adds it as a plugin init script).
//
// WHY it is a script here and not a change to apaki/ui (same reason as mac.js): everything in apaki/ui/*.js and *.css is
// also the phone page (apaki/scripts/build-web.mjs hashes it), and a PC only shows a pairing code when the site serves
// the exact page its own sources build. The updater is desktop shell business, so it lives in the shell and the phone
// page is not touched by it.
//
// What it shows: nothing, until an update has been downloaded and verified. Then one quiet card floats over the lower
// left of the window, in the same frosted style as the sign-in card:
//
//     Update ready
//     Myrlin Apaki 0.2.0 is downloaded. Restart to use it; anything running keeps going.        [Later] [Restart]
//
// Restart installs it (updater.rs update_install) and the app comes back by itself. Later hides the card until the app is
// opened the next time (the update stays downloaded and is installed on the next restart anyway). No status pill, no dot,
// no sound; nothing is shown while checking or downloading, and a failed check is only logged by the shell.
//
// The state comes from the shell: the command update_status on load, and the event apaki-update after that.
(() => {
  if (window.__apakiUpdater || window.top !== window) return;
  window.__apakiUpdater = true;

  const LATER_KEY = 'apaki.update.later';
  const CSS = `
    .apaki-update {
      position: fixed; z-index: 23; left: calc(var(--rail, 312px) + 22px); bottom: 18px; width: min(460px, calc(100vw - var(--rail, 312px) - 44px));
      display: flex; align-items: center; gap: 14px; padding: 12px 14px 12px 16px; border-radius: 14px;
      background: hsla(var(--w, 0, 0%, 100%), .94); -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5);
      border: 1px solid var(--hairline-strong, #D5D8EF); box-shadow: 0 18px 44px -24px rgba(var(--shadow-rgb, 44, 53, 120), .55);
      font-family: var(--font-body, system-ui, sans-serif); animation: rise var(--dur-fast, 150ms) var(--ease-out, ease-out);
    }
    body.rail-collapsed .apaki-update { left: 22px; width: min(460px, calc(100vw - 44px)); }
    .apaki-update[hidden] { display: none; }
    .apaki-update .au-t { flex: 1; min-width: 0; display: grid; gap: 2px; font-size: var(--fs-small, 13px); line-height: 1.4; color: var(--soft, #55566B); }
    .apaki-update .au-t b { font-size: var(--fs-body, 15px); color: var(--ink, #171717); }
    .apaki-update .au-note.bad { color: var(--action-strong, #B8502B); }
    .apaki-update .au-act { display: flex; gap: 8px; flex: none; }
    .apaki-update button {
      height: 34px; padding: 0 14px; border-radius: 10px; font: inherit; font-size: var(--fs-small, 13px); font-weight: 750; cursor: pointer;
      border: 1px solid var(--btn2-line, var(--hairline-strong, #D5D8EF)); background: transparent; color: var(--ink, #171717);
      transition: background var(--dur-fast, 150ms) var(--ease-hover, ease), opacity var(--dur-fast, 150ms) var(--ease-hover, ease);
    }
    .apaki-update button:hover { background: var(--ghost-hover, hsla(232, 60%, 62%, .1)); }
    .apaki-update button.primary { border-color: transparent; color: #fff; background: linear-gradient(135deg, var(--btn-a, #2C3578), var(--btn-b, #5A3FB0)); }
    .apaki-update button.primary:hover { opacity: .92; }
    .apaki-update button:disabled { opacity: .6; cursor: default; }
    .apaki-update button:focus-visible { outline: 2px solid hsla(var(--pearl-stop-blue, 217, 91%, 60%), .55); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .apaki-update { animation: none; } .apaki-update button { transition: none; } }
  `;

  let card = null;
  let busy = false;

  const tauri = () => window.__TAURI__;
  const invoke = (cmd, args) => tauri().core.invoke(cmd, args);

  function ensureCard() {
    if (card) return card;
    const style = document.createElement('style');
    style.id = 'apaki-update-style';
    style.textContent = CSS;
    document.head.appendChild(style);
    card = document.createElement('div');
    card.className = 'apaki-update';
    card.setAttribute('role', 'status');
    card.hidden = true;
    card.innerHTML = '<div class="au-t"><b>Update ready</b><span class="au-sub"></span></div>'
      + '<div class="au-act"><button type="button" class="au-later">Later</button><button type="button" class="primary au-go">Restart</button></div>';
    card.querySelector('.au-later').addEventListener('click', () => {
      try { sessionStorage.setItem(LATER_KEY, card.dataset.version || '1'); } catch { /* private mode: it shows again next time */ }
      card.hidden = true;
    });
    card.querySelector('.au-go').addEventListener('click', install);
    document.body.appendChild(card);
    return card;
  }

  function render(s) {
    if (!s || s.state !== 'ready') {
      if (card && !busy) card.hidden = true;
      return;
    }
    let later = null;
    try { later = sessionStorage.getItem(LATER_KEY); } catch { later = null; }
    if (later && later === s.version) return;
    const c = ensureCard();
    c.dataset.version = s.version || '';
    c.querySelector('.au-sub').textContent = `Myrlin Apaki ${s.version} is downloaded. Restart to use it; anything running keeps going.`;
    c.querySelector('.au-sub').classList.remove('au-note', 'bad');
    c.hidden = false;
  }

  async function install() {
    if (busy) return;
    busy = true;
    const go = card.querySelector('.au-go');
    const later = card.querySelector('.au-later');
    go.disabled = true;
    later.disabled = true;
    go.textContent = 'Restarting…';
    try {
      await invoke('update_install');
      // Windows: the installer takes over and this window ends. macOS: the app restarts itself.
    } catch (e) {
      busy = false;
      go.disabled = false;
      later.disabled = false;
      go.textContent = 'Try again';
      const sub = card.querySelector('.au-sub');
      sub.textContent = `The update could not be installed (${String(e).slice(0, 160)}). Nothing was changed.`;
      sub.classList.add('au-note', 'bad');
    }
  }

  function start() {
    if (!tauri()?.core?.invoke) return;
    const listen = tauri().event?.listen;
    if (listen) listen('apaki-update', (e) => render(e.payload)).catch(() => {});
    invoke('update_status').then(render).catch(() => {});
    // For scripts and checks (cdp-*.mjs): ask now, or read the state.
    window.__apakiUpdate = { status: () => invoke('update_status'), check: () => invoke('update_check').then((s) => { render(s); return s; }) };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
