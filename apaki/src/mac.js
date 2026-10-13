// mac.js: injected into Myrlin Apaki's window on macOS only (apaki/src/mac.rs adds it as a plugin init script).
//
// WHY it is a script here and not a change to apaki/ui (Arthur, 2026-10-12, macOS port): everything in apaki/ui/*.js
// and *.css is also the phone page (apaki/scripts/build-web.mjs hashes it), and a PC only shows a pairing code when
// the site serves the exact page its own sources build. Changing the window's UI for the Mac would therefore change
// the phone page's version on every platform, so Windows would stop pairing until a new page is published. The Mac's
// small differences live in the shell instead; the phone page and the Windows window stay byte for byte as they were.
//
// What it does:
//   1. <html data-platform="mac"> and the layout the native traffic lights need. The window has a native title bar
//      drawn over the page (titleBarStyle Overlay): the three buttons sit at the top left, so the brand row (and the
//      tab row when the sidebar is hidden) leaves room for them, and the page's own minimize/maximize/close buttons,
//      which draw the Windows chrome, are hidden.
//   2. Shortcut hints say Cmd where the Mac uses it. The key handlers already accept Cmd as well as Ctrl; only the
//      words in hover tips are changed ("Ctrl+T" shows as "Cmd+T"). Ctrl+Tab stays: Cmd+Tab is the system's app switcher.
(() => {
  if (window.__apakiMac) return;
  window.__apakiMac = true;

  const CSS = `
    html[data-platform="mac"] .winctl { display: none; }
    html[data-platform="mac"] .brand { padding-left: 86px; }
    html[data-platform="mac"] body.rail-collapsed .topbar { padding-left: 86px; }
    html[data-platform="mac"] body.rail-collapsed .rail-show { margin-left: 4px; }
  `;

  const apply = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.platform = 'mac';
    const style = document.createElement('style');
    style.id = 'apaki-mac-style';
    style.textContent = CSS;
    root.appendChild(style);
    return true;
  };
  if (!apply()) {
    const wait = new MutationObserver(() => { if (apply()) wait.disconnect(); });
    wait.observe(document, { childList: true });
  }

  // "Ctrl+" in a hover tip becomes "Cmd+" (not Ctrl+Tab / Ctrl+Shift+Tab: those really are Ctrl on a Mac).
  const swap = (s) => s.replace(/\bCtrl\+(?!(?:Shift\+)?Tab\b)/g, 'Cmd+');
  const fix = (e) => {
    for (let el = e.target; el && el !== document.body && el.nodeType === 1; el = el.parentElement) {
      for (const attr of ['title', 'data-tip']) {
        const v = el.getAttribute?.(attr);
        if (v && v.includes('Ctrl+')) el.setAttribute(attr, swap(v));
      }
    }
  };
  // Capture phase, registered before the page's own tooltip layer: it reads the text after this has run.
  document.addEventListener('pointerover', fix, true);
  document.addEventListener('focusin', fix, true);
})();
