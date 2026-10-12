/**
 * phone-boot.mjs: starts Apaki's phone client in the demo harness (phone.html),
 * the way apaki/web/src/boot.js starts it once the channel to the PC is open,
 * minus the channel. The harness shim (shim.mjs, loaded first) stands in for
 * the PC; this
 *   - puts the phone's own shim (apaki/web/src/shim.js, installShim) between the
 *     window and that pretend engine, through a stand-in for link.js, so the phone
 *     runs on its real shim: desktopTabs reach "On your desktop" (desktop.js), and
 *     ops and events take the same path as on a phone (2026-10-12),
 *   - says this is the phone shell (window.apakiShell = 'web', before app.js reads it),
 *   - hides the pairing screen and gives the message box the phone's hint,
 *   - loads Apaki's own window code (app.js, unchanged),
 *   - turns it into the phone app (apaki/web/src/native.js initNative), and
 *   - names the pretend PC at the top of the list as connected.
 *
 * window.__apakiLink is the small handle boot.js exposes and desktop.js reads.
 * supports('follow') is false, as on every PC today: the PC side of follow is
 * planned (apaki/ui/app.js followDesktop), so opening a desktop conversation on
 * the phone takes it over, and the desktop pane says so.
 *
 * Pairing (2026-10-12, the pairing scene): with ws=pair-phone the phone starts on
 * its "Connect to your PC" screen, and window.__demo.phone.pairing('code' | 'done')
 * moves it on. The markup is boot.js's own (welcome and pairingScreen), copied here
 * because boot.js runs only with a real channel; demo.test.mjs checks the copy still
 * matches boot.js.
 *
 * Added 2026-10-12 for the product page's phone clips (Claude Code, Opus 5.5).
 */

import { installShim } from '/ui/shim.js';
import { effortGrid } from '/ui/menu.js';

const PC_NAME = 'Studio PC';
const q = new URLSearchParams(location.search);
const ws = q.get('ws') || 'phone';

/* The phone's own shim, over a stand-in for link.js that talks to the harness engine. */
const harness = window.__TAURI__;
const link = {
  onEvent: null,
  onReopen: null,
  send: (msg) => harness.core.invoke('engine_send', { msg }),
};
await harness.event.listen('engine', (e) => link.onEvent?.(e.payload));
installShim(link);

window.apakiShell = 'web';
window.__apakiLink = {
  state: () => 'open',
  pcName: () => PC_NAME,
  drop: () => {},
  wake: () => {},
  supports: (f) => f !== 'follow',
  cap: () => 'full',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** boot.js show(): the pairing screen with this content, over the app. */
function show(html) {
  $('pairBody').innerHTML = html;
  $('pairScreen').hidden = false;
  document.body.classList.remove('linked');
}

/** boot.js welcome() for a phone with no PC yet (no account), and pairingScreen() before and after the code. */
const SCREENS = {
  welcome: () => `<div class="pair-kicker">Phone</div>
    <h1>Connect to your PC</h1>
    <ol class="pair-steps">
      <li><span>Open Myrlin Apaki on your PC.</span></li>
      <li><span>Click <b>Phone</b> at the bottom of its sidebar, then <b>Pair a phone</b>.</span></li>
      <li><span>Point this phone's camera at the code and open the link.</span></li>
    </ol>
    <button class="pair-btn" data-k="scan">Scan the code here</button>`,
  reaching: () => `<div class="pair-kicker">Pairing</div><h1>Reaching ${esc(PC_NAME)}</h1><div class="pair-wait">${effortGrid('max', { live: true })}</div><p>Your PC is about to show a code to compare.</p>`,
  code: (sas = '482913') => `<div class="pair-kicker">Pairing</div>
      <h1>Check the code</h1>
      <div class="pair-code" data-sas="${esc(sas)}"><span>${esc(sas.slice(0, 3))}</span><span>${esc(sas.slice(3))}</span></div>
      <p><b>${esc(PC_NAME)}</b> shows a code too. If both match, click <b>Allow</b> there.</p>
      <p class="pair-note">The code proves nobody sits between this phone and your PC.</p>`,
};

const startOnPairing = ws === 'pair-phone';
if (startOnPairing) show(SCREENS.welcome());
else { $('pairScreen').hidden = true; document.body.classList.add('linked'); }
document.body.classList.add('demo-touch');
const box = $('paneTpl')?.content.querySelector('textarea');
if (box) box.placeholder = 'Message Claude, / for commands';

await import('/ui/app.js');
const native = await import('/ui/native.js');
native.initNative({ onPcTap: () => {} });
native.setPc(PC_NAME, 'open');

window.__demo.phone = {
  showChat: () => native.showChat(),
  showList: () => native.showList(),
  /** The pairing screens: 'welcome', 'reaching', 'code', then 'done' (the PC allowed it: the app, connected). */
  pairing(step, sas) {
    if (step === 'done') {
      $('pairScreen').hidden = true;
      document.body.classList.add('linked');
      return;
    }
    show((SCREENS[step] || SCREENS.welcome)(sas));
  },
};
