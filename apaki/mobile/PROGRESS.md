# Apaki mobile: progress

Branch `feat/apaki-mobile`. Newest first. 2026-10-10, Claude Code (Opus 5.5) for Arthur,
driving the Mac Mini over SSH (the Mac's own Claude login was at its weekly limit).

## 2026-10-10

### Done

- **iOS app builds and runs** in the iOS 26.4 Simulator (Xcode 26.4, Capacitor 8.5.3, Swift Package Manager). First build succeeded without changes.
- **Pairing that lasts**: device keys from `ApakiKeys` (Secure Enclave on a device, a Keychain key in the Simulator), pairings and the account in the Keychain (`native-store.js`). Tested against the real relay with a throwaway stand-in PC: paired, restarted the app, reconnected; deleted the WebView's whole storage, reconnected again (`screenshots/ios-real-relay-*.png`).
- **Real relay up to the 6-digit code** (`screenshots/ios-real-relay-code.png`): the native socket with the site's Origin is accepted by wss://apaki.myrlin.io, the Keychain key signs PAIR3, the stand-in PC shows the same code (284 649).
- **Demo mode** (Debug only): pairing code, sessions list, conversation, light and dark (`screenshots/ios-*.png`).
- **Native parts**: QR scanner (AVFoundation), passkeys with PRF (ASAuthorization, iOS 18), haptics through `navigator.vibrate`, status bar and WebView ground following the theme, keyboard (native resize, no accessory bar), splash hidden when the first screen draws, no rubber band, no selectable chrome, reconnect on foreground and network change, pairing links (Universal Links and `apaki://`).
- **Icons and splash** from `apaki/icons/source` (`scripts/make-assets.py`; the drawn M matches the 1024 master to 0.32/255).
- **Associated Domains**: entitlements in the app; `relay/site/.well-known/apple-app-site-association` and `assetlinks.json` with placeholders (not deployed).
- **Tests**: 21 in `apaki/mobile/test`, picked up by `npm test` at the root (181 of 181 pass there, with the root dependencies installed). The Release configuration compiles too (Simulator, unsigned).
- **Docs**: README.md (build, run, test, release steps for TestFlight and Play, Associated Domains, security, push design).

### Not done or not tested

- Real device: Secure Enclave, camera, haptics, keyboard behaviour (needs a signed build).
- Passkeys and Universal Links: need the Team ID in the AASA file and a relay deploy (Arthur).
- Android: built neither with Gradle nor run (no room for the SDK on the Mac). The Apaki plugins exist in Java (Keystore keys, sealed store, OkHttp socket, Google code scanner) and compile against Android API 36; Android passkeys need a relay change first (README).
- Push notifications: designed in README, not built.

### Log

- Release configuration built for the Simulator (unsigned) to check the non-Debug paths; Simulator shut down. Mac disk at the end: 11 GB free (ios/DerivedData 0.9 GB, the Simulator device, SwiftPM caches).
- Android: Apaki plugins in Java, registered in MainActivity; backups off; App Links and `apaki://` intent filters; OkHttp and the code scanner in Gradle. javac check against android.jar and the real libraries; DER to raw signatures checked against the JDK on 500 keys.
- Scaffolding (package.json, capacitor.config.json); `cap add ios` and `cap add android` on the Mac.
- protocol.js `deviceSign`; boot.js and account.js small hooks; app page build with swaps and a strict CSP.
- Swift plugins, view controller, Info.plist (camera text, `apaki` scheme, arm64), entitlements, project file entries.
- First Simulator build, demo screenshots, then a non-demo build against the real relay (`-apakiLink` launch argument for Debug builds, since `simctl openurl` stops at a prompt).
- Mac disk: 14 GB free at the start, 11 GB after the build (DerivedData about 0.5 GB, the Simulator device and caches).
