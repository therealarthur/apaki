# Apaki on a phone (the web client)

Opening the pairing QR with the phone's camera app opens this page. It pairs
(the phone and the PC show the same 6-digit code, the PC user allows it) and
then runs Apaki's own window code (apaki/ui, unchanged) over the relay: the
sessions list in a drawer, one conversation at a time, the same light and
dark themes. The PC does all the work with its own Claude and Codex logins.
The relay and this site never see a credential or a message: everything
between the phone and the PC is end-to-end encrypted (apaki/remote).

Track B part 2, 2026-10-09 (Claude Code, Opus 5.5, for Arthur).

## Pieces

- `src/boot.js`: start. Reads the QR fragment (`#p=...`, never sent to any
  server) and takes it out of the address bar, pairs, or reconnects to the PC
  used last; then loads `app.js`.
- `src/link.js`: the WebSocket to the relay, the `PhoneSession`
  (`apaki/remote/protocol.js`) and the messages inside it
  (`apaki/remote/wire.js`). Reconnects by itself with backoff, and at once
  when the page is visible again.
- `src/shim.js`: the slice of `window.__TAURI__` that `app.js` uses
  (`core.invoke('engine_send')`, `event.listen('engine')`, window buttons as
  no-ops), backed by the link. Re-attaches open panes after a reconnect.
- `src/store.js`: paired PCs in IndexedDB. The phone's key pair is stored as
  non-extractable CryptoKey objects.
- `src/phonekey.js`: the phone key's signatures (via, enroll) and the small
  decisions around it: what to do after a scan, when to connect by itself,
  what the page remembers per PC. No DOM, so the Node test runner checks it.
- `src/scan.js`: in-page QR scanning where `BarcodeDetector` exists (Chrome
  and Edge on Android); everywhere else the camera app opens the link.
- `src/web.css`: the phone layout over Apaki's `app.css` (drawer, tap
  targets, safe areas, one pane).
- `src/shell.html`: the pairing card, the reconnect line and the drawer scrim,
  put into Apaki's `index.html` by the build.
- `src/sw.js`, `src/manifest.webmanifest`, `icons/`: the installable PWA.
  The icons are the Myrlin M, made from `apaki/icons/source/apaki-icon-1024.png`
  (192 and 512 px as they are; 180 px for iOS flattened onto the tile's own
  gradient); the favicon is `apaki/icons/source/apaki-icon.svg`.

## The phone key and enrollment (2026-10-11)

Contract: `apaki/remote/ENROLL.md` (version 2). Tests:
`test/apaki-web-phone.test.js`.

- **The phone key.** One ECDSA P-256 key pair per phone (per browser profile,
  per app install), made the first time it is needed and kept. The private key
  is non-extractable: on the web a CryptoKey in IndexedDB (`store.getPhoneKey`,
  record `phone` in the existing `account` store, because the database version
  must never be raised again, see `store.js`); in the iOS app a Secure Enclave
  key made by `ApakiKeys.createKey`, its id and public key in the Keychain
  (`native-store.js`; `pruneKeys` keeps it). It is not in the account's vault
  and never leaves the phone. It tells the phones of one account apart, so a
  PC can ask, allow or block this phone and not the whole account.
- **Signed via.** On an account connection to a PC whose hello lists
  `phone-key`, the page sends `{ t: 'via', name, pub, sig }`, with `sig` the
  ECDSA signature over `"apaki/v1 via" || nonce || pub || name` (the nonce is
  in the PC's hello). A PC without `phone-key` gets the older via, which is
  `{ t: 'via', name }`. The PC then answers `phone-ok`, or `phone-wait` while its person
  decides (the page shows "Waiting for permission"), or closes: a close that
  starts "This phone was blocked on" ends that connection for good, is
  remembered per PC (`apaki.blocked@<room>` in localStorage, until a
  connection works again or the PC is forgotten) and the page does not
  reconnect to that PC through the account by itself; "Nobody allowed this
  phone on ..." offers Ask again. The page does not start the app until the
  PC has said `phone-ok`.
- **Enrollment.** Right after a scan completes and the PC's hello lists
  `enroll`, the page adds the account to that PC with no second Allow: signed
  in, it sends `account-link` with `enroll: true` and `phone: { pub, sig }` at
  once and a toast says the PC was added; not signed in, a sheet offers "Next
  time, sign in with Face ID" (create the passkey, or "I already have an Apaki
  passkey", the button tap being the WebAuthn gesture) and then does the
  same. "Not now" is remembered per PC (`apaki.enrollNotNow@<room>`). A Private
  PC takes the enroll link too. A PC that does not list `enroll` keeps the
  older way (a Connected PC asks its person once).
- **Home, signed in.** The PCs with online or offline. With exactly one PC
  online and every other one known to be offline, the page connects by itself,
  unless the person just tapped Disconnect or came back from a blocked close
  (one visit, `sessionStorage`), or has the PC list open.
- If the phone key cannot be made (storage failing), the page works as before:
  the older via, no enroll, nothing held.

## Build, try locally, deploy

```
node apaki/scripts/build-web.mjs --relay wss://relay.example     # into apaki/web/dist
node apaki/scripts/build-web.mjs --relay ws://127.0.0.1:8787 --serve 8790
```

The build copies every top-level module and stylesheet of `apaki/ui` (except
`phone.js`, the desktop's Phone sheet), so modules added to the window later
come along, and it stops with an error if any relative import does not
resolve inside the build.

The relay address is baked into the page's Content-Security-Policy
(`connect-src` allows that one origin and nothing else); without `--relay` or
`APAKI_RELAY_URL` the build uses the placeholder `wss://relay.apaki.invalid`.
The PC side reads the same addresses from `APAKI_RELAY_URL` and
`APAKI_WEB_URL` (the address the QR opens). To try it all on one PC: run the
relay (`cd relay; npm run dev`), start Apaki with those two variables set, serve
the build as above, and open the QR's link in a browser. `apaki/scripts/cdp-remote.mjs`
does exactly that over CDP with a headless browser as the phone, and
`apaki/scripts/relay-tap.mjs` records what the relay sees and checks that a
marker from the conversation never appears in it.

Deploying is a separate, explicit step: `apaki/web/dist` is static files for
any static host (HTTPS is required for WebCrypto and the service worker).

## What a phone cannot do

Change billing, pair or remove phones, use the PC's dictation, edit folders,
or run Ask Claude or Dig deeper: the engine refuses those commands from a
phone (apaki/engine/remote-policy.js). Within its conversations a phone has
the same Claude Code a desktop pane has, with the permission mode the pane is
set to, so Claude can run commands and edit files there as on the PC (see
apaki/SECURITY.md).
