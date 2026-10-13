/**
 * theme.js: Apaki's colour theme (2026-10-10).
 *
 * A classic script loaded in <head> before the stylesheet paints, so the
 * window never flashes the wrong theme. It sets <html data-theme="light|dark">
 * from the saved choice: "auto" (follow Windows, the default), "light" or
 * "dark". app.js drives the footer switch through window.apakiTheme.
 */
(function () {
  const KEY = 'apaki.theme';
  const CHOICES = ['auto', 'light', 'dark'];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'auto';
  try { choice = localStorage.getItem(KEY) || 'auto'; } catch { /* storage unavailable */ }
  if (!CHOICES.includes(choice)) choice = 'auto';

  const effective = () => (choice === 'auto' ? (media.matches ? 'dark' : 'light') : choice);
  const apply = () => {
    document.documentElement.dataset.theme = effective();
    document.documentElement.dataset.themeChoice = choice;
  };
  // A short crossfade when the theme changes after load, none at startup and
  // none under reduced motion.
  const applyAnimated = () => {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!calm && document.startViewTransition) document.startViewTransition(apply);
    else apply();
  };

  apply();
  media.addEventListener('change', () => { if (choice === 'auto') applyAnimated(); });

  window.apakiTheme = {
    choices: CHOICES,
    get: () => choice,
    effective,
    set(next) {
      if (!CHOICES.includes(next) || next === choice) return;
      choice = next;
      try { localStorage.setItem(KEY, next); } catch { /* not saved */ }
      applyAnimated();
      window.dispatchEvent(new CustomEvent('apaki-theme', { detail: next }));
    },
  };
})();
