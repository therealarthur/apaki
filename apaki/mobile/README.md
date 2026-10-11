# Apaki for iOS and Android

The dedicated phone app for Myrlin Apaki (2026-10-10, Claude Code, Opus 5.5,
for Arthur). Arthur: "build the dedicated ios partner app. should be pretty
much exactly like the desktop app but optimized for ios/android" and "when
pairing a phone, the paired phone should be good to go forever."

It is the phone web client (apaki/web, which runs Apaki's own window code
from apaki/ui) bundled inside a Capacitor app, plus the parts only a native
app does well: pairings that iOS never clears, the device key in the Secure
Enclave, a native QR scanner, passkeys for the Apaki account, haptics, the
status bar, keyboard and splash, and reconnecting the moment the app comes
back.

Screenshots (iOS 26.4 Simulator, iPhone 17 Pro) are in `screenshots/`:

| File | What |
|---|---|
| `ios-pairing-code.png` | the pairing code screen (demo mode) |
| `ios-sessions-list.png`, `-dark.png` | the sessions list, light and dark (demo mode) |
| `ios-conversation.png`, `-dark.png` | a conversation (demo mode) |
| `ios-first-launch.png` | first launch, nothing paired |
| `ios-real-relay-code.png` | the real relay, wss://apaki.myrlin.io: the 6-digit code from a stand-in PC |
| `ios-real-relay-paired.png` | paired with that stand-in (it approved itself) |
| `ios-real-relay-reconnect.png` | reconnected after the app was restarted |
| `ios-real-relay-after-wipe.png` | reconnected after the WebView's storage was deleted: the pairing lives in the Keychain |

## How it is put together

```
apaki/mobile/
  src/                 the app's own page modules (copied to www/app/ by the build)
    entry.js           first script: installs the native shell, then imports boot.js
    native-shell.js    network, passkeys, haptics, status bar, keyboard, lifecycle, links, splash
    native-store.js    store.js for the app: Keychain records, Secure Enclave device keys and the phone key
    native-socket.js   the WebSocket link.js uses, opened natively (ApakiNet)
    native-http.js     fetch for the account API, natively (ApakiNet)
    passkeys.js        navigator.credentials answered by ASAuthorization (ApakiPasskeys)
    scan-native.js     scan.js for the app: the native camera scanner (ApakiScanner)
    codec.js           pure helpers (records <-> JSON, links, allowlists), tested in Node
    cap.js             the Capacitor plugin handles
    mobile.css         no rubber band, no selectable chrome, the composer on the keyboard
    demo/              the pretend PC (debug demo builds only)
  scripts/
    build-app.mjs      builds www/ from apaki/scripts/build-web.mjs plus src/
    ios-sim.sh         build, Simulator, demo, screenshots (on the Mac)
    relay-test-pc.mjs  a throwaway stand-in PC for tests against the real relay
    make-assets.py     icons and launch screens from apaki/icons/source
    mac-update.sh      on the Mac after a push: pull, npm ci, page build, cap sync
    ios-device.sh      build, sign and install on a USB-connected iPhone
    ios-testflight.sh  archive and upload to TestFlight (also what the cloud workflow runs)
    ci-ios.sh, lib-ios.sh   the workflow's secret check and key file step; helpers the scripts share
  ios/                 the Xcode project (Capacitor 8, Swift Package Manager)
    App/Signing.xcconfig   the one signing config: team id, bundle id, version, build number
    ExportOptions-AppStore.plist, ExportOptions-AdHoc.plist   xcodebuild -exportArchive options (no secrets)
    App/App/Apaki*.swift   the Apaki plugins and the view controller that registers them
  android/             the Android project (official plugins wired; see Android below)
  test/                node --test, also run by npm test at the repo root
```

The page is the site's phone client from the same commit, built by
`build-web.mjs` with the relay `wss://apaki.myrlin.io`, then changed in four
ways by `build-app.mjs`:

1. `index.html` starts `app/entry.js` (which imports `boot.js` after the shell is in place) and loads `app/mobile.css`.
2. The Content-Security-Policy is the site's, tighter: `connect-src 'self'`. The WebView connects to nothing; the native side does (below).
3. Three web modules are swapped for app ones with the same exports: `store.js` (Keychain), `scan.js` (native scanner) and, in demo builds only, `link.js` (the pretend PC). The build stops if an app module misses an export the web one has, so a new export on the web side cannot break the app silently.
4. No service worker, no web manifest; `app/build.js` records the page version, commit and whether it is a demo build.

### Native plugins (ios/App/App)

| Plugin | Does |
|---|---|
| `ApakiKeys` | `createKey`: a P-256 signing key in the Secure Enclave (`.privateKeyUsage`, after first unlock, this device only); only its wrapped handle is stored, in the Keychain. `sign`: ECDSA P-256 / SHA-256, 64-byte r and s. The Simulator has no Secure Enclave, so there the key is a CryptoKit key in the Keychain (`secureEnclave: false`). Plus a small store in the Keychain: `vaultGet/Set/Remove/List`. |
| `ApakiNet` | WebSockets to `wss://apaki.myrlin.io/v1/rooms/<22-char id>/phone` only, and HTTPS to `https://apaki.myrlin.io/v1/...` only (no cookies, no cache, no redirects). Pings every socket when the app returns to the foreground and reports a dead one at once. |
| `ApakiPasskeys` | Passkeys with PRF through `ASAuthorizationPlatformPublicKeyCredentialProvider` (iOS 18+), relying party `apaki.myrlin.io` only. |
| `ApakiScanner` | Full-screen camera, AVFoundation's QR reader, returns the first Apaki pairing link. |
| `ApakiApp` | Debug or release, the demo mode and test link (Debug builds only), the WebView's ground colour. |

`ApakiViewController` registers them (Capacitor's way for plugins inside the
app). Official plugins: `@capacitor/app` (lifecycle, links), `haptics`,
`keyboard`, `network`, `splash-screen`, `status-bar`.

### What the web client gained (changes outside apaki/mobile)

All small and additive; the web client behaves exactly as before in a browser.

| File | Change | Why |
|---|---|---|
| `apaki/remote/protocol.js` | `deviceSign`: a device may sign through its own `sign(bytes)` instead of a WebCrypto key; `PhoneSession` accepts such a device | the Secure Enclave key is not a WebCrypto key |
| `apaki/web/src/boot.js` | a new pairing asks `store.newDevice()` for its key when the store has it; `__apakiLink.wake`; the device name says "Apaki app" | Secure Enclave keys; reconnect on foreground; the PC's Phone sheet names the app |
| `apaki/web/src/account.js` | in the app (`globalThis.apakiApp.keysInKeychain`) the vault key and account device are exportable; presence checks the site's host | the Keychain stores bytes, not CryptoKeys; the app's page is not on apaki.myrlin.io |
| `apaki/remote/PROTOCOL.md` | a paragraph on the app's saved state (Keychain, Secure Enclave, `sign(bytes)`) | the protocol doc says where a phone keeps its secrets |
| `relay/site/.well-known/apple-app-site-association`, `assetlinks.json`, `relay/site/_headers` | association files with placeholders, served as JSON | passkeys and pairing links in the apps (not deployed) |

Tests: `test/device-signer.test.js` pairs and reconnects a device that signs by itself.

## Security

- **The code that holds the keys ships in the app.** The page is the app's own copy, built from the same commit as the site's page; nothing is loaded from the network, so no server (not apaki.myrlin.io, not the relay) can change it. The PC's check of the site's page (`apaki/engine/remote-page.js`) still runs before it shows a QR; for the app, Apple's code signing plays that role.
- **One place on the network.** The WebView's CSP allows no connections at all (`connect-src 'self'`). The native side opens only `wss://apaki.myrlin.io/v1/rooms/<id>/phone` and `https://apaki.myrlin.io/v1/...`, checks it again in Swift, and follows no redirects. ATS (HTTPS only) stays on.
- **Pairings kept for good.** Device keys: Secure Enclave, not exportable, usable after the first unlock so a locked phone in a pocket can reconnect, never synced, never restored onto another phone. Pairing records (room, PC key, device id, psk) and the signed-in account: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. iOS clears neither under storage pressure; tested by deleting the WebView's storage (screenshot above). Keychain items outlive deleting the app, so a reinstall finds its pairings (and the PC can still remove the phone, as always).
- **The account's keys in the app.** A browser keeps the vault key and the account device as non-extractable CryptoKeys in IndexedDB. The app keeps them in the Keychain, so they are exportable inside the app's own page (they are shared through the vault by design anyway). The page is bundled code under a strict CSP, so no other script can reach them.
- **The relay's origin rule.** The relay accepts phone sockets only with `Origin: https://apaki.myrlin.io` (relay `ALLOWED_ORIGINS`, which "stops other websites from using their visitors' browsers"). The app's WebView is `capacitor://localhost`, so the native socket sends `Origin: https://apaki.myrlin.io`: the app is that page, shipped inside it. The protocol's security never depends on it. If you prefer the relay to tell the app apart, add an app origin to `ALLOWED_ORIGINS` and change `ApakiNetPlugin.siteOrigin` (a relay deploy).
- **Debug-only switches.** The demo mode (`-apakiDemo`) and the test link (`-apakiLink`) are read under `#if DEBUG` only, and a demo page refuses to run when the native side is not a Debug build. Web Inspector is on in Debug builds only (Capacitor's default). Capacitor's own logging is off (`loggingBehavior: none`), so nothing about records reaches the device log.
- **Custom scheme.** `apaki://pair#p=...` exists for testing. Any app could register the same scheme; PC QRs never use it (they are `https://apaki.myrlin.io/v/...` Universal Links), and a stolen pairing link is still caught by the 6-digit code (PROTOCOL.md).

## Build and run (on the Mac)

Needs Xcode 26 with an iOS Simulator runtime, Node 20+. About 1 GB of disk for
the build (`ios/DerivedData`) and the Simulator device.

```
cd apaki/mobile
npm install
scripts/ios-sim.sh build            # page + cap sync + xcodebuild (Debug, Simulator)
scripts/ios-sim.sh device           # makes "Apaki iPhone 17 Pro" once, boots it
scripts/ios-sim.sh install
scripts/ios-sim.sh launch
scripts/ios-sim.sh shot first-launch    # screenshots/first-launch.png, at most 1400 px
```

Demo mode (a pretend PC with sample sessions, nothing on the network, nothing
in the Keychain; Debug builds only):

```
scripts/ios-sim.sh build --demo && scripts/ios-sim.sh install
scripts/ios-sim.sh demo pair     # the 6-digit code screen
scripts/ios-sim.sh demo list     # the sessions list
scripts/ios-sim.sh demo chat     # a conversation
scripts/ios-sim.sh appearance dark
```

Against the real relay, without anyone's PC: run the stand-in PC on any
machine with Node (it makes a throwaway identity and room), then hand its link
to the app. It stops at the code unless given `--approve`.

```
node apaki/mobile/scripts/relay-test-pc.mjs --seconds 240 --links /tmp/link.txt
ssh mac 'cd .../apaki/mobile && scripts/ios-sim.sh link' < /tmp/link.txt
```

With Xcode open instead: `npx cap open ios`, pick a Simulator, Run.

Disk: `rm -rf ios/DerivedData` gets the build's space back; `xcrun simctl delete "Apaki iPhone 17 Pro"` removes the Simulator device.

## Test

```
cd apaki/mobile && npm test        # the app's tests
npm test                           # at the repo root: everything, including these
```

What they cover: the Keychain record format (`codec.test.js`), links and the
network allowlists, the socket, fetch and passkey bridges with stand-in
plugins, the demo engine (`app-bridges.test.js`), the app page build: CSP,
entry, swaps, no demo in a normal build (`build-app.test.js`), and a device
that signs by itself pairing and reconnecting against the real PcSession
(`device-signer.test.js`). The native side was tested in the Simulator as in
the screenshots; see "Not tested yet" below.

## Ship it (iOS)

The route: push from the PC, then on the Mac Mini (`ssh macmini.myrlin.dev`, clone at
`~/Projects/claude-latch-mobile`) run `scripts/mac-update.sh`, then either
`scripts/ios-device.sh` (your iPhone over USB-C) or `scripts/ios-testflight.sh`
(TestFlight). Or let a GitHub macOS runner do the TestFlight part (below). All
scripts run from `apaki/mobile`, print what they do, and stop with a plain message when
something is missing (exit 2: no team id, no phone, no API key; exit 1: a step failed).

Checked on the Mac (Xcode 26.4, 2026-10-10): `mac-update.sh`, the Simulator build, the
unsigned Release archive (`scripts/ios-testflight.sh --unsigned`: arm64, 24 seconds, 13 MB)
and the "no team, no phone, no key" messages. **Not run, because there is no team id and
no key yet:** a signed build, an install on a real iPhone, the export, the upload and the
cloud workflow. Expect a first-run snag or two there and read the message.

### a. One time

1. **Apple Developer Program** (USD 99 a year), needed for TestFlight, passkeys and Universal Links. Not needed for step b alone: a free Apple ID works there. Your **Team ID** is under developer.apple.com, Account, Membership details.
2. **Team id into one file**: `apaki/mobile/ios/App/Signing.xcconfig`, the line `DEVELOPMENT_TEAM = ABCDE12345`. Commit and push it. That is all signing needs: the project signs automatically, Debug and Release read this file, and the target keeps no signing setting of its own (do not pick a team in Xcode's Signing tab; that writes a second copy into the project file that overrides this one). For one Mac only, put the line in `ios/App/Signing.local.xcconfig` (git ignores it) or set `APAKI_TEAM_ID`.
3. **App ID** `io.myrlin.apaki` with **Associated Domains** on: the first signed build creates it for you (Xcode registers the App ID and switches the capability on), or make it by hand under Certificates, Identifiers & Profiles.
4. **App Store Connect app record**: My Apps, +, New App, platform iOS, bundle ID `io.myrlin.apaki` (the name may be taken; "Myrlin Apaki" is an option), a SKU of your choice.
5. **App Store Connect API key** (this is what lets a script, not you in Xcode, sign and upload): App Store Connect, Users and Access, Integrations, App Store Connect API, Team Keys, +. Give it the Admin role (the key creates the signing certificates and profiles through `-allowProvisioningUpdates`; I could not confirm from Apple's pages that App Manager is enough, so Admin is the safe choice). **Download the .p8 at once: Apple shows it once.** Note the Key ID (in the table) and the Issuer ID (above the table). Keep the file outside the repo:
   ```
   mkdir -p ~/.appstoreconnect/private_keys && chmod 700 ~/.appstoreconnect/private_keys
   # put AuthKey_<KEY_ID>.p8 there, chmod 600
   export ASC_KEY_ID=<KEY_ID>
   export ASC_ISSUER_ID=<the Issuer ID>
   export ASC_KEY_PATH=$HOME/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
   ```
   (put the three `export` lines in the Mac's `~/.zshenv` so SSH sessions see them). Nothing here is ever stored in the repo.
6. **Export compliance**: see step 8 of the TestFlight list further down (the answer goes in Info.plist once).

### b. USB-C to your own iPhone

On the phone: plug it into the Mac with USB-C, unlock it, tap Trust and enter the passcode, then Settings, Privacy & Security, **Developer Mode** on (the phone restarts). On the Mac: Xcode, Settings, Accounts, signed in with the Apple ID of the team (or the `ASC_` variables set as above). Then:

```
ssh macmini.myrlin.dev
cd ~/Projects/claude-latch-mobile/apaki/mobile
scripts/mac-update.sh                 # pull, npm ci, page, cap sync
scripts/ios-device.sh                 # Debug build, installed and launched on the phone
scripts/ios-device.sh --release       # the Release build (what TestFlight ships)
scripts/ios-device.sh --personal      # same, signed with a FREE personal team
scripts/ios-device.sh --list          # which phones the Mac sees
```

With no phone or no team id it says what to do and stops. If the phone refuses the app on a free team: Settings, General, VPN & Device Management, your Apple ID, Trust.

**A free personal team** (no paid membership) works for this USB route, with limits Apple sets, not this project: the app stops launching after **7 days** (run `ios-device.sh --personal` again to renew it), the team cannot use Associated Domains (so `--personal` leaves the entitlement out: **no passkeys and no Universal Links** in that build; scanning the PC's QR in the app still pairs), it cannot use TestFlight, and Apple caps how many App IDs a free team can register per week. These limits are from Apple's documentation of personal teams; I could not test them with no team id.

A .ipa built in the cloud (workflow target `ipa`, below) installs the same way, with no build on the Mac: `scripts/ios-device.sh --ipa ~/Downloads/Apaki.ipa`.

### c. TestFlight

On the Mac, with the team id set and the three `ASC_` variables exported:

```
scripts/mac-update.sh && scripts/ios-testflight.sh
```

It raises the build number by one, archives Release for iOS, exports with `ios/ExportOptions-AppStore.plist` (method `app-store-connect`, destination `upload`) and `-allowProvisioningUpdates` with the API key, which uploads the build to App Store Connect in the same step. Then it writes the new build number into `Signing.xcconfig`, commits that one file and pushes it (`--no-commit` or `--no-push` skip that), so the Mac and the workflow never reuse a number. Apple processes the build for about 5 to 30 minutes. Then in App Store Connect, TestFlight: answer the export compliance question (step 8 below), add testers (people with an App Store Connect role are internal testers and get the build at once; anyone else is an external tester, which needs a first Beta App Review), and they install the TestFlight app and the build from it. To see that the project archives before you have any account: `scripts/ios-testflight.sh --unsigned`.

**Or in the cloud**, with the Mac off: `.github/workflows/ios-testflight.yml`, manual only. Add four repository secrets (Settings, Secrets and variables, Actions): `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_P8` (the full text of the .p8 file). Then Actions, "Apaki iOS TestFlight", Run workflow (or `gh workflow run ios-testflight.yml -f target=testflight`), and pick the branch. A Linux job checks the four secrets first and fails with a message naming the missing ones, so no macOS minutes are spent until they are all there. The macOS job (`macos-26`, newest Xcode 26) then runs the same `ios-testflight.sh`, writing the key to a private temp file and deleting it at the end. Target `ipa` builds an ad hoc .ipa instead of uploading and keeps it for download for 14 days (needs the paid team and your iPhone's UDID registered in it; not tested).

GitHub only offers a manual workflow whose file is on the default branch: checked 2026-10-10, `gh workflow run ios-testflight.yml --ref feat/apaki-mobile` answers "workflow ios-testflight.yml not found on the default branch". So the workflow file needs to be on master before it can be run; it was not run (no secrets exist, and it was not merged). It passes `actionlint` 1.7.12 and parses as YAML.

**Cost of the cloud route.** The repo `therealarthur/claude-latch` is private (checked with `gh`), so Actions minutes count. From GitHub's billing pages (fetched 2026-10-10): a standard macOS runner (3-core or 4-core, billing SKU `actions_macos`) costs **USD 0.062 per minute**; a 2-core Linux runner USD 0.006; the included minutes each month are 2,000 on Free, 3,000 on Pro, 3,000 on Team and 50,000 on Enterprise Cloud; standard runners are free on public repos; larger runners (the `-large` and `-xlarge` labels) are never covered by included minutes. **Not verified:** the "macOS minutes count 10x against the allowance" rule. The current GitHub pages I fetched list per-minute prices and no multiplier table; third-party guides still say 10x for macOS (1x Linux, 2x Windows), which fits the prices (0.062 against 0.006 is about 10). If 10x applies, 2,000 free minutes are about 200 macOS minutes a month. Also **not measured:** how long a run takes. Here the unsigned archive took 24 seconds on an M4 with warm caches; a cold runner (checkout, `npm ci`, Swift package fetch, signing, upload) is my guess at 10 to 20 minutes, which at USD 0.062 is roughly USD 0.60 to 1.25 a run once the allowance is gone. The Mac Mini route costs no minutes.

### d. Associated Domains: the team id in the association file

Passkeys (the Apaki account) and pairing links that open the app need Apple to find your app in `https://apaki.myrlin.io/.well-known/apple-app-site-association`. That file still holds the placeholder `TEAMIDXXXX`, twice. With the paid team id:

```
sed -i '' 's/TEAMIDXXXX/ABCDE12345/g' relay/site/.well-known/apple-app-site-association   # macOS; on Linux drop the ''
```

Deploy the relay as usual, then `curl -i https://apaki.myrlin.io/.well-known/apple-app-site-association` must answer 200 with `content-type: application/json` and no redirect. Apple copies the file within about a day (`https://app-site-association.cdn-apple.com/a/v1/apaki.myrlin.io`). Do this before the first TestFlight build is tested, or passkeys and links will not work in it. The app side is already in `ios/App/App/App.entitlements` (`webcredentials:` and `applinks:`) and the App ID needs Associated Domains on (step 3 above). A free personal team cannot do any of this (b above).

## Release: what Arthur does

### iOS (TestFlight, then the App Store)

The short version is "Ship it" above; this is the same path with the App Store Connect details.

1. **Apple Developer Program** membership (USD 99 a year) for the account that will own the app. Note the **Team ID** (developer.apple.com, Membership).
2. **App ID** `io.myrlin.apaki` (Certificates, Identifiers & Profiles, Identifiers): enable **Associated Domains**. (Push Notifications later, see below.)
3. **Associated Domains file**: in `relay/site/.well-known/apple-app-site-association` replace `TEAMIDXXXX` (twice) with the Team ID, then deploy the relay as usual. Check it: `curl -i https://apaki.myrlin.io/.well-known/apple-app-site-association` must answer 200, `content-type: application/json`, no redirect; Apple's copy follows within about a day: `https://app-site-association.cdn-apple.com/a/v1/apaki.myrlin.io`. While developing on a device you can skip Apple's cache: add `?mode=developer` to both entries in `ios/App/App/App.entitlements` and turn on Developer Mode on the phone (Settings, Privacy & Security); take it out before a release build.
4. **Signing**: `DEVELOPMENT_TEAM` in `ios/App/Signing.xcconfig` (see "Ship it", a). Do not pick the team in Xcode's Signing tab: that writes a second copy into the project file that overrides the config file.
5. **Version**: `MARKETING_VERSION` (1.0) in `ios/App/Signing.xcconfig`. `CURRENT_PROJECT_VERSION` is there too; `scripts/ios-testflight.sh` raises it for every upload.
6. **App Store Connect**: My Apps, +, New App: platform iOS, name (for example "Myrlin Apaki"; "Apaki" may be taken), bundle ID `io.myrlin.apaki`, SKU of your choice.
7. **Build and upload**: `scripts/mac-update.sh && scripts/ios-testflight.sh` on the Mac (a normal build, never the demo; "Ship it", c), or the GitHub workflow. By hand in Xcode it is `npm run sync`, then Product, Archive, Distribute App, App Store Connect, Upload. The command-line form of what the script does:
   `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination generic/platform=iOS -archivePath build/Apaki.xcarchive -allowProvisioningUpdates archive` then `xcodebuild -exportArchive -archivePath build/Apaki.xcarchive -exportOptionsPlist ios/ExportOptions-AppStore.plist -exportPath build/export -allowProvisioningUpdates` (add `teamID` to a copy of the plist, and the `-authenticationKeyPath`, `-authenticationKeyID` and `-authenticationKeyIssuerID` flags; the script does both).
8. **Export compliance**: the app implements standard cryptography (ECDH P-256, AES-256-GCM, ECDSA, HKDF) for end-to-end encryption. App Store Connect asks about it on the first upload; answer for your situation (this is usually the mass-market exemption) and then add `ITSAppUsesNonExemptEncryption` to Info.plist with the matching value so later builds skip the question.
9. **App Privacy** (App Store Connect): the app itself collects nothing for tracking. With an Apaki account the server keeps the account's display name, its passkeys' public keys and an encrypted vault; the relay sees IP addresses and connection times. Declare what applies.
10. **TestFlight**: once the build is processed, add yourself as an internal tester; install TestFlight on the iPhone and the build from there. Then check on the device: scan a QR from your PC, Allow on the PC, quit and reopen the app, lock and unlock the phone; sign in to the account with a passkey (needs step 3 deployed).

### Android (Play Store)

The Android project is in `android/`: the official plugins, the icons (an
adaptive icon with the M over the tile gradient) and the splash, and the
Apaki plugins in Java next to `MainActivity` (which registers them):

| Plugin | Android version |
|---|---|
| `ApakiKeys` | an EC P-256 key per pairing in the Android Keystore (StrongBox when the phone has one); `SHA256withECDSA` gives DER, turned into the 64-byte r and s the protocol uses; the store is app-private SharedPreferences, each value sealed with AES-256-GCM under a Keystore key (the record's name as AAD). Backups and device transfers are off (`allowBackup="false"`, `data_extraction_rules.xml`): a copy could not be opened on another phone anyway. |
| `ApakiNet` | OkHttp 4.12: the same allowlist as iOS, `Origin: https://apaki.myrlin.io`, no redirects, a ping every 15 s so a socket killed by sleep is noticed |
| `ApakiScanner` | Google's code scanner (`play-services-code-scanner`): the system's own scanner screen, no camera permission |
| `ApakiApp` | debug from the app's debuggable flag; demo and test link from intent extras in debug builds |
| `ApakiPasskeys` | **not yet**: says passkeys are unavailable, so the page explains that accounts are not in the Android app yet. Android passkeys carry the origin `android:apk-key-hash:<signing certificate hash>`, which the account server does not accept today; it needs that origin added next to `https://apaki.myrlin.io` (a relay change) and `relay/site/.well-known/assetlinks.json` with the signing key's SHA-256, then Credential Manager with the PRF extension here. |

Status: the Java was compile-checked (javac against Android API 36, the real
OkHttp and Google scanner libraries, and Capacitor's plugin API), and the
signature and key encoding were checked against the JDK on 500 keys. **It has
not been built with Gradle or run**: the Mac keeps too little disk for the
Android SDK (about 10 GB). App Links (`https://apaki.myrlin.io/v/...`) and
`apaki://pair` open the app (the manifest's intent filters).

Also check the CSP on Android once it runs: Capacitor injects its bridge as a
document-start script on current WebViews; only an old WebView falls back to
an inline script, which `script-src 'self'` would block.

To build: Android Studio (SDK 36, its own JDK), `npm run sync`, `npx cap open
android`, Run on a phone or an emulator. Debug launches for tests:
`adb shell am start -n io.myrlin.apaki/.MainActivity --es apakiDemo chat`.
To publish: a Play Console developer account (USD 25 once), create the app,
use Play App Signing, put the app signing key's SHA-256 into
`relay/site/.well-known/assetlinks.json` (then deploy the relay), build the
bundle with your upload key (`./gradlew bundleRelease`), upload it, fill in
Data safety the same way as App Privacy above, then internal testing.

## Push notifications when a turn finishes (design, not built)

Goal: the phone is told when Claude finishes a turn on the PC while the app is
in the background, and neither the relay nor Apple sees what happened.

1. **Register.** The app asks iOS for an APNs device token (Push Notifications
   capability) and sends it to the PC inside the encrypted channel:
   `{ t: 'push-register', token, env: 'production' | 'sandbox' }` (wire.js).
   The PC stores it with that phone's device record; it forgets it when the
   phone is removed.
2. **Encrypt for the phone.** When a turn in one of the phone's panes ends
   while the phone is not connected, the PC builds the text ("Claude finished
   in <session title>") and seals it for that phone only:
   `pushKey = HKDF(devicePsk, roomIdBytes, "apaki/v1 push", 32)`,
   `ct = AES-256-GCM(pushKey, random iv, aad = "apaki/v1 push" || deviceId, JSON)`.
   The device psk never leaves the PC and the phone's Keychain.
3. **Send through the relay.** The PC sends `{ t: 'push', token, ct }` on its
   own relay socket (only the holder of the room token can, so nobody else can
   make a phone buzz). The relay Worker holds the APNs auth key as a secret and
   POSTs to `api.push.apple.com` (HTTP/2, JWT signed with the key) with a
   neutral alert ("Apaki: a turn finished"), `mutable-content: 1` and the
   ciphertext in a custom key. It keeps nothing, counts pushes per room in its
   daily budget, and caps the size (APNs allows 4 KB).
4. **Decrypt on the phone.** A Notification Service Extension in the app reads
   the pairing's psk from a Keychain access group it shares with the app,
   derives `pushKey`, opens `ct` and replaces the neutral text. If anything
   fails, the neutral text stays.

What each party sees: the relay sees the APNs token, the room it came from,
timing and size (it already sees connections, IPs and timing); Apple sees the
token, the neutral text and ciphertext; neither sees a title or a word of the
conversation. Arthur would need: the Push Notifications capability on the App
ID, an APNs auth key (.p8, its Key ID and the Team ID) stored as a relay
secret, the extension target with a Keychain access group, and the PC side
in `apaki/engine/remote.js`. Android would use FCM data messages the same way.
To check first: that a Worker's `fetch` reaches APNs over HTTP/2 (otherwise a
tiny forwarder elsewhere sends the request).

## Not tested yet

- **On a real iPhone**: the Secure Enclave path (the Simulator has none; the same code path with a Keychain key was tested end to end), the camera scanner (the Simulator has no camera), haptics, the keyboard pushing the composer.
- **Passkeys and Universal Links**: need the Team ID in the AASA file, the relay deployed and a signed build. The PRF salt is passed as WebAuthn's `eval.first`; Apple documents the native type as the WebAuthn values' counterpart, so a passkey made in Safari should open the same vault in the app. Check once on a device: sign in in Safari, then in the app, with the same passkey.
- **Android**: the Apaki plugins are written and compile-checked but the app is not built or run; accounts are not in the Android app yet (above).

## Tech choice

Capacitor 8 (current): the web client runs unchanged in WKWebView, maintained
plugins for haptics, status bar, splash, keyboard, app lifecycle and network,
Swift Package Manager (no CocoaPods), and no Rust iOS toolchain on the Mac's
tight disk. Tauri 2 mobile (the desktop's own stack) was considered; nothing
here needed it.
