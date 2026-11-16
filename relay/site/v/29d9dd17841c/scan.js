/**
 * scan.js: reading the pairing QR inside the page, for browsers that have
 * BarcodeDetector (Chrome and Edge on Android). Everywhere else the phone's
 * camera app opens the QR's link, which is the whole pairing step anyway.
 * The camera runs only while the scanner shows and stops the moment a code
 * is found or the person cancels.
 */

export function canScan() {
  return typeof window.BarcodeDetector === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Shows the back camera in `video` until it sees an Apaki pairing link;
 * resolves with that link. Rejects when the signal aborts or the camera is
 * refused.
 */
export async function scanCode(video, { signal } = {}) {
  const formats = await window.BarcodeDetector.getSupportedFormats?.().catch(() => null);
  if (formats && !formats.includes('qr_code')) throw new Error('This browser cannot read QR codes. Open the code with your camera app instead.');
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  try {
    video.srcObject = stream;
    await video.play().catch(() => {});
    while (!signal?.aborted) {
      const codes = await detector.detect(video).catch(() => []);
      const hit = codes.map((c) => c.rawValue || '').find((v) => /#(?:[^#]*&)?p=[A-Za-z0-9_-]+/.test(v));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 180));
    }
    throw new Error('stopped');
  } finally {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  }
}
