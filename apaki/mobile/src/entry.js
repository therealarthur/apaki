/**
 * entry.js: the first script of the Apaki app's page (apaki/mobile,
 * 2026-10-10). build-app.mjs points index.html here instead of boot.js.
 *
 * It installs the native shell (native-shell.js), then starts the phone
 * client exactly as the site does (../boot.js). In a demo build (debug
 * only, `npm run build:demo`) it first checks the native side is a Debug
 * build and sets up the pretend PC (demo/demo-setup.js).
 *
 * The page code is the app's own copy, built from the same commit as the
 * site's (build.json says which): no server can change the code that holds
 * the keys.
 */

import { BUILD } from './build.js';
import { AppInfo, isApp } from './cap.js';
import { installShell } from './native-shell.js';

function fail(text) {
  const body = document.getElementById('pairBody');
  if (body) body.innerHTML = `<div class="pair-kicker">Apaki</div><h1>Could not start</h1><p></p>`;
  const p = body?.querySelector('p');
  if (p) p.textContent = text;
}

async function start() {
  if (!isApp()) { fail('This is the page bundled in the Apaki app. On the web, open the pairing link from your PC instead.'); return; }
  let demoMode = null;
  if (BUILD.demo) {
    const info = await AppInfo.info().catch(() => ({}));
    // A demo build pretends to be a PC; it must never run as a Release app.
    if (!info.debug) { fail('This is a demo build. Demo builds run in Debug only.'); return; }
    demoMode = info.demo || 'list';
  }
  const payload = await installShell({ build: BUILD, demo: Boolean(BUILD.demo) });
  if (BUILD.demo) (await import('./demo/demo-setup.js')).setupDemo(demoMode);
  // Device keys of pairings that never finished; no pairing can be running yet.
  else await import('./native-store.js').then((m) => m.pruneKeys()).catch((e) => console.warn('apaki app: prune', e?.message));
  // Opened from a pairing link: hand it to boot.js the way a browser would (in the fragment).
  if (!BUILD.demo && payload) history.replaceState(null, '', `${location.pathname}${location.search}#p=${payload}`);
  await import('../boot.js');
}

start().catch((e) => {
  console.error(e);
  fail(`Apaki could not start: ${e?.message || e}`);
});
