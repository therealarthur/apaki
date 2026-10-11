# Apaki Cloud: remote anywhere, version 1 plan (2026-10-11)

Arthur, 2026-10-11: phone pairing must work out of the box, persist through
app closes and phone restarts, and be unlinkable. On top of that, optionally:
"we can set your phone as a passkey and anywhere you have your phone, you can
go to the website, use your phone as a passkey to securely connect from any
machine using our website (and that even if you forget to log out, it auto
logs out after inactivity (configurable but default is 30 minutes) AND it
doesnt save. on the browser. it ONLY saves when you download the desktop app
and set it up (so you can use the desktop app locally or click a cloud button
to see the remote machines you have using your passkey, and then connec to
them to work on the local sessions there." Also: free and self-hostable,
with something we can charge for.

This builds on ACCOUNTS.md (passkey accounts, zero-knowledge vault) and
ENROLL.md (phone keys, enrollment, Connected and Private). Status: plan.

## Three ways in, one protocol

| Way in | Needs an account | Saves anything | Default |
|---|---|---|---|
| Phone app or phone page paired by QR | no | yes, on the phone (Secure Enclave key in the app; IndexedDB on the web) | on, free, out of the box |
| Any browser, signed in with your phone's passkey | yes | nothing: memory only, gone on reload, close or sign-out | off until the account is made |
| Desktop app, Cloud button | yes | yes, on that PC, sealed (DPAPI), like remote secrets | off until signed in |

All three end in the same end to end channel (PROTOCOL.md) between a client
and a PC. The server stores what ACCOUNTS.md lists (public keys, one locked
vault) and nothing else.

## 1. Phone pairing (free, default, unchanged)

What exists: QR, matching code, Allow on the PC, enrollment (ENROLL.md). The
pairing lives on the phone until Remove (PC) or Unlink (phone). The app keeps
its keys in the Secure Enclave and Keychain, so app restarts, phone restarts
and updates keep it. Unlink on the phone forgets that PC; a new QR links again.

## 2. Any browser, nothing saved

- Sign in: "Sign in with your phone" uses WebAuthn with the account's
  passkey. On a computer that has no passkey of its own the browser shows its
  standard QR; the phone scans it and approves with Face ID (FIDO cross-device
  sign-in, built into Chrome, Edge and Safari). The PRF output unlocks the
  vault exactly as ACCOUNTS.md describes.
- Nothing persists in the browser: the session token, the vault key, the
  account device key and a per-session phone key live in memory only. No
  IndexedDB, localStorage, sessionStorage, cookies or service worker cache
  for account data on this path (the page's static files may be cached; they
  hold no secrets). A reload, a closed tab or a sign-out ends it.
- The per-session key is made fresh each sign-in, so each browser session is
  its own "phone" to the PC: Connected shows "Browser session (Chrome on
  Windows) connected" with Block; Private asks Allow or Block, as ENROLL.md
  does for any new phone. Its record is marked kind 'browser' and is dropped
  from the PC's list after 7 days unless blocked.
- Auto sign-out after inactivity: default 30 minutes; the account setting
  allows 5, 15, 30, 60 or 240 minutes (stored server-side as a plain
  preference, it is not a secret). Inactivity means no input in the page.
  Before signing out it warns for 60 seconds ("Still there?"). Sign-out
  closes the channels, drops every key reference, and reloads the page so no
  JS heap is left holding them.
- The same applies to the session token on the server: 30 days today for
  phones; a browser session's token lasts 12 hours at most and is revoked at
  sign-out.

## 3. Desktop app, Cloud button

- Sign in once in Apaki (Settings or the Cloud button): the passkey prompt
  runs in Apaki's own web view (Windows Hello, or the phone over the
  cross-device QR). The account session, the vault key and the account
  device key are saved on this PC, sealed with DPAPI like the phone access
  secrets; nothing goes to the server that ACCOUNTS.md does not already list.
- The Cloud button shows the account's machines with online or offline
  (presence route) and, for each, Connect.
- Version 1: Connect opens that machine in its own Apaki tab running the
  phone client, from a page version Apaki checked against the site first
  (remote-page.js does this for pairing already), in a web view with Apaki's
  own storage. The remote machine's sessions show and work there as on a
  phone, with its access level.
- Version 2: remote sessions as ordinary panes next to local ones (the engine
  holds the channel and routes a pane's ops to the remote PC). Not in v1.

## Free, self-hosted, and what is paid

- Everything is open source and runs on your own relay: `relay/` deploys to
  your Cloudflare account (free plan works; one command, plus a Deploy button
  in the README). Apaki points at any relay (APAKI_RELAY_URL / Settings). A
  self-hosted relay has every feature, with no billing code switched on.
- On our hosted relay at apaki.myrlin.io:
  - free: phone pairing by QR (it costs us almost nothing: idle sockets sleep;
    see relay/README.md, Cost);
  - paid (Apaki Cloud): the passkey account, any-browser access, the desktop
    Cloud button, and later push notifications to the phone when Claude asks
    or finishes. The relay checks an entitlement on the account routes only
    when BILLING is on (our deployment); without it, the routes answer as
    they do now.
- Billing: Stripe Checkout and a webhook into the Account object
  (entitlement and expiry). No card data touches our code. Price to be
  decided with the market research (apaki/docs/research/2026-10-11-market.md).
- Before charging: Anthropic's Agent SDK docs say third parties may not offer
  claude.ai login or rate limits without approval, and OpenAI has similar
  terms questions for Codex; get approval or legal advice first. What we sell
  is hosting and the account service, not Claude or Codex access.

## Security properties to keep (and test)

1. Nobody but the user's devices can read content: the relay forwards
   ciphertext; the vault opens only with the passkey's PRF.
2. The server cannot add a device to a PC: pairing needs the person at the PC;
   an account reaches a PC only through a link made in person (ENROLL.md).
3. A browser session leaves nothing behind: tests assert no account data in
   any storage API after sign-in, use and sign-out, and that inactivity signs
   out.
4. The desktop app only opens page versions it verified.
5. Revocation: Block or Remove on the PC, Unlink on the phone, sign out
   everywhere on the account, each cuts access at once.

## Build order

1. Browser memory-only mode and auto sign-out (apaki/web/src), with storage
   tests. 2. Browser sessions as kind 'browser' on the PC (remote.js) with the
   7 day expiry. 3. Desktop sign-in and Cloud button (engine + window), v1
   tab with a verified page. 4. Relay BILLING switch and Stripe (later, after
   the terms check). 5. Security review pass by a fresh reviewer.
