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
 *   keyboard     no accessory bar, a kb-open class while it is up
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
import { RELAY, SITE, SITE_HOST, hapticStyle, isDark, pairingPayloadFrom, relaySocketAllowed } from './codec.js';
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
    AppInfo.setBackground({ color: ground }).catch(() => {});
  };
  new MutationObserver(() => requestAnimationFrame(sync)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('apaki-theme', () => requestAnimationFrame(sync));
  sync();
}

function keyboard() {
  if (!has('Keyboard')) return;
  if (platform() === 'ios') Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('kb-open'));
  Keyboard.addListener('keyboardWillHide', () => document.body.classList.remove('kb-open'));
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
  globalThis.apakiApp = Object.freeze({ platform: platform(), site: SITE, siteHost: SITE_HOST, relay: RELAY, keysInKeychain: !demo, build: Object.freeze({ ...build }) });
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
