/**
 * demo-setup.js: starts the Apaki app's debug demo (apaki/mobile,
 * 2026-10-10). entry.js calls it in a demo build, after checking the native
 * side is a Debug build, and before boot.js runs. The mode comes from the
 * launch arguments (xcrun simctl launch <device> io.myrlin.apaki -apakiDemo chat):
 *
 *   pair   the pairing screen with its 6-digit code (a made-up QR link)
 *   list   the sessions list of a paired PC (the default)
 *   chat   a conversation, opened from the list
 *
 * Nothing here touches the Keychain or the network (demo-store.js,
 * demo-link.js).
 */

import { encodePairingPayload } from '../../protocol.js';
import { seedPc } from './demo-store.js';
import { DEMO_PC } from './demo-engine.js';
import { b64e, RELAY } from '../codec.js';

const ROOM = b64e(new Uint8Array(16).map((_, i) => 40 + i));

export function setupDemo(mode = 'list') {
  // Every demo starts from a clean layout, so screenshots come out the same.
  for (const k of Object.keys(localStorage)) if (k.startsWith('apaki.workspace')) localStorage.removeItem(k);
  if (mode === 'pair') {
    const pcPub = b64e(new Uint8Array(65).map((_, i) => (i === 0 ? 4 : (i * 37) % 256)));
    const payload = encodePairingPayload({ relay: RELAY, roomId: ROOM, pcPub, secret: b64e(new Uint8Array(16).fill(7)), exp: Math.floor(Date.now() / 1000) + 120, name: DEMO_PC });
    history.replaceState(null, '', `${location.pathname}#p=${payload}`);
    return;
  }
  seedPc({ roomId: ROOM, pcName: DEMO_PC, relay: RELAY });
  if (mode === 'chat') openFirstSession();
}

/** Waits for the sessions list, then opens the first conversation the way a tap does. */
function openFirstSession() {
  const t0 = Date.now();
  const tick = () => {
    const row = document.querySelector('#sessions li[data-id]');
    if (row) { row.click(); return; }
    if (Date.now() - t0 < 8000) setTimeout(tick, 120);
  };
  setTimeout(tick, 300);
}
