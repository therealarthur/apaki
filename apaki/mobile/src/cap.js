/**
 * cap.js: the native plugins the Apaki app uses (apaki/mobile, 2026-10-10).
 *
 * The page has no bundler: build-app.mjs copies @capacitor/core's own ES
 * module next to this file (vendor/capacitor-core.js), and registerPlugin
 * gives a proxy that calls the native side through Capacitor's bridge. The
 * official plugins' native halves come from npm (haptics, status bar,
 * keyboard, splash, app, network); the Apaki ones are Swift files in
 * ios/App/App (and Java in android/, see README.md):
 *
 *   ApakiKeys      the device key in the Secure Enclave, and a small store in
 *                  the Keychain (pairings, the account): kept for good
 *   ApakiNet       the WebSocket to the relay and the account API, natively,
 *                  to wss://apaki.myrlin.io and https://apaki.myrlin.io/v1/ only
 *   ApakiPasskeys  passkeys with PRF through ASAuthorization (iOS 18+)
 *   ApakiScanner   the camera QR scanner for pairing codes
 *   ApakiApp       build facts (debug or release, the demo mode in debug)
 */

import { Capacitor, registerPlugin } from './vendor/capacitor-core.js';

export { Capacitor };

/** True inside the iOS or Android app, false in a browser. */
export const isApp = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform();
export const has = (name) => Capacitor.isPluginAvailable(name);

export const Keys = registerPlugin('ApakiKeys');
export const Net = registerPlugin('ApakiNet');
export const Passkeys = registerPlugin('ApakiPasskeys');
export const Scanner = registerPlugin('ApakiScanner');
export const AppInfo = registerPlugin('ApakiApp');

export const App = registerPlugin('App');
export const Haptics = registerPlugin('Haptics');
export const StatusBar = registerPlugin('StatusBar');
export const Keyboard = registerPlugin('Keyboard');
export const Network = registerPlugin('Network');
export const SplashScreen = registerPlugin('SplashScreen');
