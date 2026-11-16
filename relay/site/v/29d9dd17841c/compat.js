/**
 * compat.js: the version contract between a PC's Apaki and the phone apps that talk to it (2026-10-13).
 *
 * WHY (Arthur, 2026-10-12: "every app keeps in step"): the desktop apps update themselves (Tauri's updater), but an
 * iPhone app only updates through TestFlight or the App Store, so a phone app can fall behind the PC it talks to. The
 * PC says what it needs and the phone checks itself, instead of failing in some odd way later.
 *
 *   PC -> phone   hello { appVersion, minPhoneApp }   (apaki/engine/remote.js, wire.js)
 *       appVersion    the PC's Apaki version (apaki/VERSION)
 *       minPhoneApp   the oldest phone app version this PC works with (MIN_PHONE_APP below)
 *   phone -> PC   { t: 'client', kind, version, build? }   once, right after hello, from the native app only
 *       kind          'ios' or 'android'
 *       version       the app's own version (CFBundleShortVersionString / versionName)
 *   The phone shows "Update the Apaki app" when its version is under minPhoneApp. The PC's Phone sheet shows the same
 *   for a phone that told it its version.
 *
 * Only a native app has an app version. The phone web page is served live and the PC checks it byte for byte, so it
 * is never behind; it sends no client message and is never flagged. An older PC says nothing, and then nothing is
 * flagged either (unknown is not old).
 *
 * MIN_PHONE_APP is raised by hand, in the commit that makes the protocol or the app's native side need a newer app,
 * never above the PC's own version (a test checks it). Isomorphic ESM, no dependencies (it is part of the phone page).
 */

/** The oldest phone app this PC works with. */
export const MIN_PHONE_APP = '0.1.0';

/** What the phone says when its app is too old. */
export const APP_UPDATE_TITLE = 'Update the Apaki app';

const NUM = /^\d+$/;

/**
 * "1.2.3", "1.2.3-ci.1", "1.2" and "1" (an app's marketing version has one to three parts) as
 * { major, minor, patch, pre: string[] }, or null for anything else. Build metadata after "+" is ignored.
 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : [];
  if (pre.some((p) => p === '')) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0), patch: Number(m[3] || 0), pre };
}

/** Compares two pre-release identifier lists by the semver rules (numbers numerically, numbers under words, shorter first). */
function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  // A release is newer than any pre-release of the same version.
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = NUM.test(x);
    const yn = NUM.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1 when `a` is older than, the same as, or newer than `b`; null when either is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

/**
 * Is a phone app `version` new enough for a PC that wants `min`?
 * 'ok' (at or above), 'old' (below), or 'unknown' (either side did not say, or said something that is not a version).
 */
export function phoneAppState(version, min) {
  const c = compareVersions(version, min);
  if (c === null) return 'unknown';
  return c < 0 ? 'old' : 'ok';
}

/** The text that explains an old app, for the phone ("This PC runs Apaki 0.3.0 and needs the app at 0.2.0 or newer. You have 0.1.0.") and for the PC. */
export function oldAppText({ version, min, pcVersion = null, pcName = 'This PC' } = {}) {
  const runs = pcVersion ? `${pcName} runs Apaki ${pcVersion} and needs` : `${pcName} needs`;
  return `${runs} the Apaki app at ${min} or newer. This phone has ${version}.`;
}
