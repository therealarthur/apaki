/**
 * scan-native.js: scan.js for the Apaki app (apaki/mobile, 2026-10-10).
 *
 * The web client scans the pairing QR in the page where BarcodeDetector
 * exists (Chrome on Android) and otherwise sends people to the camera app.
 * The app always has a scanner: ApakiScanner shows the native camera full
 * screen (AVFoundation's QR reader on iOS), returns the first code that is
 * an Apaki pairing link, and closes. The camera runs only while it shows.
 * Same API as apaki/web/src/scan.js: canScan(), scanCode(video, { signal }).
 */

import { Scanner } from './cap.js';

export function canScan() {
  return true;
}

/**
 * Opens the native scanner; resolves with the pairing link. Rejects with
 * Error('stopped') when cancelled (here or on the page), and with a
 * NotAllowedError when the camera is not allowed.
 */
export async function scanCode(video, { signal } = {}) {
  // The page's own <video> stays empty: the native scanner covers the screen.
  if (video) video.hidden = true;
  const abort = () => { Scanner.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort);
  try {
    const { value } = await Scanner.scan({ hint: 'Point at the code Apaki shows on your PC' });
    // The same test as the web scanner (scan.js): a link with the pairing payload in its fragment.
    if (!value || !/#(?:[^#]*&)?p=[A-Za-z0-9_-]+/.test(value)) throw new Error('That is not an Apaki pairing code. Show a new code on your PC and scan it again.');
    return value;
  } catch (e) {
    if (e?.code === 'cancelled' || signal?.aborted) {
      // Cancelled in the native scanner: leave the page's scan screen the way its own Cancel does.
      if (!signal?.aborted) document.querySelector('[data-k=stopscan]')?.click();
      throw new Error('stopped');
    }
    if (e?.code === 'denied') {
      const err = new Error('The camera is not allowed for Apaki. Allow it in Settings, or open the code with the Camera app.');
      err.name = 'NotAllowedError';
      throw err;
    }
    throw e instanceof Error ? e : new Error(String(e?.message || e));
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
