/**
 * native-shell.js: what the Apaki app adds around the phone web client
 * (apaki/mobile, 2026-10-10). Arthur: "build the dedicated ios partner app.
 * should be pretty much exactly like the desktop app but optimized for
 * ios/android." The page is the same phone client the site serves (boot.js,
 * Apaki's own window code); this file installs, before it starts:
 *
 *   network      the relay socket and the account API through the native
 *                side, to apaki.myrlin.io only (native-socket.js, native-http.js)
 *   passkeys     navigator.credentials answered by ASAuthorization (passkeys.js)
 *   haptics      navigator.vibrate(ms), which native.js calls, plays a native impact
 *   status bar   light or dark text following Apaki's theme; the WebView's
 *                own background follows it too, so no white edge shows
 *                (2026-10-11: and the keyboard's light or dark look)
 *   keyboard     no accessory bar, a kb-open class while it is up; on iOS
 *                (2026-10-11) the page moves its own layout up by the
 *                keyboard's height (--kb), see keyboard() below
 *   lifecycle    back in the foreground or back online: reconnect now
 *   links        a pairing link (Universal Link or apaki://) opens the pairing
 *   splash       hidden once the first screen has drawn
 *   back button  Android's back closes a sheet, then the conversation
 *
 * globalThis.apakiApp tells the shared web code it runs in the app (account.js
 * keeps its keys exportable so the Keychain can hold them; boot.js asks the
 * store for a Secure Enclave device key).
 */

import { App, AppInfo, Haptics, Keyboard, Net, Network, Passkeys, SplashScreen, StatusBar, has, platform } from './cap.js';
import { RELAY, SITE, SITE_HOST, hapticStyle, isDark, kbInset, pairingPayloadFrom, relaySocketAllowed } from './codec.js';
import { makeSocketClass } from './native-socket.js';
import { makeFetch } from './native-http.js';
import { installPasskeys } from './passkeys.js';

const USED_LINK = 'apaki.app.usedLink';

/** Reconnect now: link.js's wake() (boot.js exposes it), or the online event link.js listens to. */
function wake() {
  const l = window.__apakiLink;
  if (typeof l?.wake === 'function') l.wake();
  else window.dispatchEvent(new Event('online'));
}

function haptics() {
  if (!has('Haptics')) return;
  const vibrate = (pattern) => {
    const style = hapticStyle(pattern);
    if (style) Haptics.impact({ style }).catch(() => {});
    return true;
  };
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
}

function themeFollower() {
  const sync = () => {
    const root = document.documentElement;
    const ground = getComputedStyle(root).getPropertyValue('--ground').trim() || (root.dataset.theme === 'dark' ? '#121120' : '#FDFDFF');
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : isDark(ground);
    // Capacitor's names: DARK is light text for a dark background.
    if (has('StatusBar')) StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
    // The WebView, and since 2026-10-11 the window behind it (ApakiAppPlugin.swift), take Apaki's ground.
    AppInfo.setBackground({ color: ground }).catch(() => {});
    // 2026-10-11: the keyboard follows Apaki's theme too (a dark keyboard under a dark page even when iOS is light).
    if (has('Keyboard') && platform() === 'ios') Keyboard.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  };
  new MutationObserver(() => requestAnimationFrame(sync)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('apaki-theme', () => requestAnimationFrame(sync));
  sync();
}

/* ---------- the keyboard (2026-10-11) ----------
 * Arthur, testing the iOS app: "when the keypad opens up around the rounded
 * corners of the keypad theres some black triangles before the apps
 * background starts". The cause: Keyboard resize was "native", so the plugin
 * cut the WebView off at the keyboard's top edge, a straight line, about half
 * a second after the keyboard started moving (Keyboard.m _updateFrame, after
 * the animation plus 0.2 s). The iOS keyboard has rounded top corners, and
 * beside them the window behind the WebView showed through; a UIWindow is
 * black. Now, on iOS:
 *   - resize is "none" (capacitor.config.json): the WebView stays full
 *     screen and the keyboard slides over the page, so beside its corners is
 *     the page itself, the same grid and pearl as everywhere else;
 *   - the page moves its own layout up by the keyboard's height: --kb on
 *     <html> and the kb-inset class (web.css, "2026-10-11"), set on
 *     keyboardWillShow, so the composer rides up with the keyboard instead of
 *     waiting under it and jumping;
 *   - the open conversation keeps its distance from the end while that
 *     happens (the last message rises with the keyboard, as in Messages);
 *   - a field in a sheet or the PC screen is scrolled into view above it;
 *   - the window behind the WebView takes the theme's ground anyway
 *     (ApakiApp.setBackground, SceneDelegate), so nothing black can show.
 * The plugin removes WKWebView's own keyboard observers, so WebKit neither
 * shrinks the visual viewport nor scrolls the page for the keyboard; if a
 * WebKit ever does shrink it (boot.js then shrinks --vvh), only the rest of
 * the keyboard's height is ours to move (kbInset), so nothing moves twice.
 * Android keeps its own resizing (the WebView shrinks there): no --kb. */

/** How long the layout takes to follow the keyboard; UIKit's keyboard animation is 0.25 s (web.css --kb-ms). */
const KB_FOLLOW_MS = 320;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Each visible conversation and how far it is from its end, before the layout moves. */
function transcriptPins() {
  return [...document.querySelectorAll('.stage.on .pane .ground')]
    .filter((g) => g.clientHeight > 0)
    .map((g) => ({ g, fromEnd: Math.max(0, g.scrollHeight - g.scrollTop - g.clientHeight) }));
}

/** Holds each conversation at its distance from the end while the layout follows the keyboard. */
function holdPins(pins) {
  if (!pins.length) return;
  const until = performance.now() + (reducedMotion() ? 0 : KB_FOLLOW_MS);
  const step = () => {
    for (const { g, fromEnd } of pins) g.scrollTop = g.scrollHeight - g.clientHeight - fromEnd;
    if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** A field in a sheet, a menu or the PC screen that the keyboard now covers: scroll its own scroller so it shows above. */
function revealFocused(inset) {
  const el = document.activeElement;
  if (!el?.matches?.('input, textarea, [contenteditable="true"]') || el.closest('.composer')) return;
  let s = el.parentElement;
  while (s && s !== document.body) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) break;
    s = s.parentElement;
  }
  if (!s || s === document.body) return;
  const over = el.getBoundingClientRect().bottom - (window.innerHeight - inset - 16);
  if (over > 0) s.scrollBy({ top: over, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function keyboard() {
  if (!has('Keyboard')) return;
  const ios = platform() === 'ios';
  if (ios) Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  const root = document.documentElement;
  let height = 0;
  let inset = 0;
  const follow = (h) => {
    if (!ios) return;
    height = Math.max(0, Number(h) || 0);
    const vv = window.visualViewport;
    const next = kbInset(height, window.innerHeight, vv ? vv.height : NaN);
    if (next === inset) return;
    const pins = transcriptPins();
    inset = next;
    root.style.setProperty('--kb', `${inset}px`);
    document.body.classList.toggle('kb-inset', inset > 0);
    holdPins(pins);
  };
  Keyboard.addListener('keyboardWillShow', (info) => { document.body.classList.add('kb-open'); follow(info?.keyboardHeight); });
  // The height again once the keyboard is up (iOS also sends willShow again when it changes size: emoji, the predictions bar).
  Keyboard.addListener('keyboardDidShow', (info) => { follow(info?.keyboardHeight); if (ios) revealFocused(inset); });
  Keyboard.addListener('keyboardWillHide', () => { document.body.classList.remove('kb-open'); follow(0); });
  if (ios) window.visualViewport?.addEventListener('resize', () => { if (height) follow(height); });
}

function lifecycle() {
  if (has('App')) App.addListener('appStateChange', ({ isActive }) => { if (isActive) wake(); });
  if (has('Network')) Network.addListener('networkStatusChange', (s) => { if (s?.connected) wake(); });
}

/** Android's back: a sheet or menu first, then the conversation (native.js keeps it in history), then leave. */
function backButton() {
  if (platform() !== 'android' || !has('App')) return;
  App.addListener('backButton', ({ canGoBack }) => {
    if (document.querySelector('.menu, .sheet, .glass-panel, .task-panel')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    if (canGoBack) history.back();
    else App.minimizeApp().catch(() => {});
  });
}

/** The splash goes as soon as boot.js has drawn its first screen (or after 2 s whatever happens). */
function splashWhenReady() {
  if (!has('SplashScreen')) return;
  let done = false;
  const hide = () => {
    if (done) return;
    done = true;
    obs.disconnect();
    SplashScreen.hide({ fadeOutDuration: 180 }).catch(() => {});
  };
  const ready = () => document.body.classList.contains('linked') || !/Starting/.test(document.getElementById('pairBody')?.textContent || 'Starting');
  const obs = new MutationObserver(() => { if (ready()) requestAnimationFrame(() => requestAnimationFrame(hide)); });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  setTimeout(hide, 2000);
}

/**
 * The pairing link the app was opened with, once: the same launch URL comes
 * back after every reload, and a QR pairs one phone only once.
 */
async function launchPayload() {
  if (!has('App')) return null;
  App.addListener('appUrlOpen', ({ url }) => {
    const p = pairingPayloadFrom(url);
    if (!p) return;
    sessionStorage.setItem(USED_LINK, p);
    // A fresh page, like the browser opening the link; boot.js reads the fragment and takes it out.
    location.replace(`${location.pathname}?link=${Date.now()}#p=${p}`);
  });
  let url = null;
  try { url = (await App.getLaunchUrl())?.url || null; } catch { url = null; }
  // Debug builds only (ApakiApp.info reads -apakiLink under #if DEBUG): a link handed over at launch, for Simulator tests.
  if (!url) { try { url = (await AppInfo.info())?.link || null; } catch { url = null; } }
  const p = url ? pairingPayloadFrom(url) : null;
  if (!p || sessionStorage.getItem(USED_LINK) === p) return null;
  sessionStorage.setItem(USED_LINK, p);
  return p;
}

/**
 * Installs everything above. Returns the pairing payload the app was
 * launched with, if any, for entry.js to hand to boot.js.
 */
export async function installShell({ build = {}, demo = false } = {}) {
  document.body.classList.add('app', `app-${platform()}`);
  // The app's own version (CFBundleShortVersionString / versionName, written from apaki/VERSION by apaki/scripts/version.mjs) and
  // build number: the page tells the PC (boot.js tellClient) and checks it against what the PC wants (apaki/remote/compat.js).
  let facts = {};
  if (!demo) { try { facts = (await AppInfo.info()) || {}; } catch { facts = {}; } }
  globalThis.apakiApp = Object.freeze({ platform: platform(), site: SITE, siteHost: SITE_HOST, relay: RELAY, keysInKeychain: !demo, version: String(facts.version || ''), buildNumber: String(facts.build || ''), build: Object.freeze({ ...build }) });
  // The web client's "add to Home Screen" hint has nothing to do in the app.
  try { localStorage.setItem('apaki.installHint.v1', 'app'); } catch { /* no storage */ }
  if (!demo) {
    window.WebSocket = makeSocketClass(Net, relaySocketAllowed);
    window.fetch = makeFetch(Net, window.fetch.bind(window), SITE);
    await installPasskeys(Passkeys).catch((e) => console.warn('apaki app: passkeys unavailable', e?.message));
  }
  haptics();
  themeFollower();
  keyboard();
  lifecycle();
  backButton();
  splashWhenReady();
  return demo ? null : launchPayload();
}
