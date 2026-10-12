/**
 * phone-boot.mjs: starts Apaki's phone client in the demo harness (phone.html),
 * the way apaki/web/src/boot.js starts it once the channel to the PC is open,
 * minus the channel: the harness shim (shim.mjs, loaded first) already stands
 * in for the PC, so this only
 *   - says this is the phone shell (window.apakiShell = 'web', before app.js reads it),
 *   - hides the pairing screen and gives the message box the phone's hint,
 *   - loads Apaki's own window code (app.js, unchanged),
 *   - turns it into the phone app (apaki/web/src/native.js initNative), and
 *   - names the pretend PC at the top of the list as connected.
 *
 * window.__apakiLink is the small handle boot.js exposes and desktop.js reads
 * (does the PC offer 'follow', what may this phone do); here: everything, Full.
 * Added 2026-10-12 for the product page's phone clip (Claude Code, Opus 5.5).
 */

const PC_NAME = 'Studio PC';

window.apakiShell = 'web';
window.__apakiLink = {
  state: () => 'open',
  pcName: () => PC_NAME,
  drop: () => {},
  wake: () => {},
  supports: () => true,
  cap: () => 'full',
};

const screen = document.getElementById('pairScreen');
if (screen) screen.hidden = true;
document.body.classList.add('linked', 'demo-touch');
const box = document.getElementById('paneTpl')?.content.querySelector('textarea');
if (box) box.placeholder = 'Message Claude, / for commands';

await import('/ui/app.js');
const native = await import('/ui/native.js');
native.initNative({ onPcTap: () => {} });
native.setPc(PC_NAME, 'open');
window.__demo.phone = { showChat: () => native.showChat(), showList: () => native.showList() };
