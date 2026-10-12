/*
 * theme.js: the home page's light or dark theme, set on <html data-theme> before the page paints
 * (loaded in <head> without defer). It follows the system setting and changes with it, as the
 * desktop app does on Auto. Without scripts the page stays light. Written 2026-10-12 for
 * apaki.myrlin.io (relay/site), Claude Code (Opus 5.5).
 */
(function () {
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() { root.setAttribute('data-theme', mq && mq.matches ? 'dark' : 'light'); }
  apply();
  root.classList.add('js');
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }
})();
