# Phone access and accounts: what our servers can do to your PC, and how to prove it

Security review of Myrlin Apaki's phone access: the relay, the phone page and
Apaki accounts. Written 2026-10-10 by Claude Code (Opus 5.5) for Arthur, from
the code in this repository at commit 1a55d53. Every `file:line` refers to
that commit. While this was written, another session had uncommitted edits in
apaki/engine/remote.js and apaki/engine/remote-store.js (backups, recovery,
and optional pairing lifetimes of 1, 7 or 30 days); they shift some remote.js
line numbers once committed but change none of the findings. The only live
checks were GET requests to https://apaki.myrlin.io.

Read with: apaki/remote/PROTOCOL.md (the handshake), apaki/remote/ACCOUNTS.md
(accounts), relay/README.md (the relay and its threat model).

Arthur's question: "is this built in such a way where we can really say our
servers dont touch and cannot connect to or do anything to the pc even though
its the way you might be accessing the interface? how do we "prove" this? are
we doing something similar to signal? and maybe for the account creation its
different, its ok if we have one service that is incredibly secure and
private, adn then another one that might be more feature rich and QoL easy"

## The short answer

- **"Our servers cannot connect to the PC": true.** Nothing on our side ever
  opens a connection to a PC. The PC keeps one outgoing WebSocket to the
  relay and listens on nothing (apaki/engine/remote.js:7-9, 212-238).
- **"Our servers cannot read or tamper with what passes through": true.** The
  relay forwards frames it cannot read. A changed, replayed, reordered or
  injected frame fails to decrypt and the session closes. The relay cannot
  pair a phone, pose as the PC or a phone, or claim a PC's room. On its own,
  the worst it can do is refuse service and watch metadata.
- **"Our servers cannot do anything to the PC": not true today.** The phone
  runs a web page that apaki.myrlin.io serves, fresh, every time it opens. A
  paired phone can make Claude Code on the PC run any command, with no
  approval on the PC, in every permission mode (apaki/engine/engine.js:134,
  553). So whoever controls apaki.myrlin.io (us, someone who takes over the
  Cloudflare account or the domain, Cloudflare itself, or someone who can
  compel any of them) could serve a page that uses a paired phone's keys to
  run commands on the PC. The PC's page check catches a careless, global swap
  at pairing time. It does not stop a careful attacker (section 1.3).
- **Accounts:** the server cannot open the vault. But the page the server
  serves does open it, and after the first sign-in it can do so without any
  passkey prompt (section 1.4).

The honest claim today: the relay is blind and powerless; the phone page is
the trust point, as in every web app with end-to-end encryption. That limit is
the reason Signal has no web client.

**How to prove the stronger claim.** You cannot prove a negative about a server
you run. You take the server out of the trust path and make what remains
checkable: a native app that bundles its code (no server serves it code), open
source with reproducible builds, a public log of every build, limits the PC
enforces on each phone, a formal model and an audit of the handshake, and a
bug bounty. Section 3 says what each step lets us claim.

**Is it like Signal?** The cryptography is the same family and adequate for
this job: one live channel between two of your own devices. It is not the
Signal Protocol, and what it lacks (prekeys, ratchets) matters little here.
The real difference is distribution: Signal ships only signed native apps and
refuses a web client; our phone client today is a web page from our own server
(section 2).

**Two tiers: yes.** A Private mode (QR pairing only, no account, the native app
or your own page, the PC refuses account links, the relay holds nothing) and a
Connected mode (passkey account, presence, sync, later push) that trusts our
web page for web users and your passkey provider for everyone. The switch
belongs on the PC. Recommended design in section 4.

## 1. What our servers can and cannot do today

### 1.1 The pieces

One Cloudflare Worker on one hostname, apaki.myrlin.io, does three jobs
(relay/wrangler.jsonc:10-26):

| Job | Code | What it stores |
|---|---|---|
| Relay: one Durable Object per room, forwarding frames between the PC socket and phone sockets | relay/src/index.js | an idle alarm per room and one daily cost counter (index.js:134-149, 375-377) |
| Account API: passkey sign-in, one encrypted vault per account, presence | relay/src/account.js, webauthn.js, account-lib.js | per account: name, passkey public keys and metadata, a session generation, the vault ciphertext, spent challenges (account.js:371-375) |
| Site: the front page and every published phone page at /v/<version>/ | relay/site, served as static assets (wrangler.jsonc:16-18) | the files |

Underneath, Cloudflare terminates TLS for all three, and the myrlin.io zone
and registrar decide where the name points. In this review "the server" means
anyone who controls the Cloudflare account, the zone, or Cloudflare's edge.

### 1.2 What holds (checked in the code)

- **No inbound path to the PC.** remote.js opens one outbound WebSocket
  (remote.js:212-238). Until a handshake completes, a frame from the relay can
  only make the PC create a session object that times out after 30 s
  (remote.js:347-364).
- **Relay control messages are inert.** The PC acts on ready, join, leave, bye
  and pong only (remote.js:263-285). A hostile relay can make the PC open and
  drop connection slots and reconnect, nothing else.
- **Only the token holder is the PC of a room.** The Worker hashes the offered
  token and compares it with the room id before anything reaches the room
  (relay/src/index.js:97-101).
- **Pairing needs the QR secret and the PC user.** PAIR1 is MACed under a key
  from the QR secret, which travels only in the URL fragment
  (PROTOCOL.md:42-49, 108-110). The PC stores nothing until its user approves
  after comparing a 6-digit code (remote.js:403-410, 724-741).
- **Mutual authentication on every reconnect.** HELLO needs the device's
  private key and its psk; the PC signs with the identity key the phone pinned
  from the QR (PROTOCOL.md:124-151).
- **Records** are AES-256-GCM with strict implicit counters, so a replayed,
  dropped or reordered record ends the session (PROTOCOL.md:153-169).
- **Removing a phone works.** The PC deletes the device record and psk, closes
  its connections and asks the relay to kick them (remote.js:744-765).
- **The vault is unreadable to the server.** It is sealed under a key derived
  from the passkey's PRF output, which the server never receives
  (apaki/web/src/account.js:77-80, 256-267, 300-306).
- **The relay code logs nothing,** and Workers observability is off
  (relay/wrangler.jsonc:37-38; no console calls anywhere in relay/src).

### 1.3 Gap 1: the phone page is code we serve

What a modified page could do on a phone that is already paired, with no new
prompt and nothing unusual on screen:

1. **Connect as that phone.** The device private key is non-extractable but
   usable by any script on the origin, and the psk is stored as plain base64
   text in IndexedDB (apaki/remote/protocol.js:1118, apaki/web/src/store.js:5-13).
2. **Run commands on the PC.** Open a new conversation (in the home folder or
   any folder a listed session used) and tell Claude what to run. New phone
   panes take the desktop's default mode, which starts as bypassPermissions
   (engine.js:134, 229). A phone may set any mode, bypassPermissions included
   (remote-policy.js:45, 147, 201-204). In every mode the engine's permission
   callback answers "allow" (engine.js:553). Only AskUserQuestion and
   ExitPlanMode reach a person, and the phone answers those for its own panes
   (remote-policy.js:177-191, src/runner.js:174-198). What still applies: the
   PC user's own Claude Code deny rules and PreToolUse hooks (settingSources
   user, project, local, src/runner.js:151).
3. **Read every Claude Code session on the PC**: the list, and the full history
   of any session it opens, including ones open on the desktop or in a
   terminal, through takeover (remote-policy.js:132-150, engine.js:507-599).
4. **Leave a back door that survives removing the phone.** Send account-link
   with a key it made. The PC adds an "Apaki account (<any name>)" device with
   a fresh psk and no approval (remote.js:463-493). Removing the phone does not
   remove it; it does show in the Phone sheet.
5. **On a signed-in phone, empty the vault without a passkey prompt.** The vault
   key is a usable CryptoKey in IndexedDB (store.js:15-19, account.js:306).
   The vault holds the account device's private key as a JWK and the psk of
   every linked PC (account.js:257-263), which work from anywhere, without
   the phone.

Getting data out is not blocked: the page's Content-Security-Policy allows
connections to its own origin and the relay (apaki/scripts/build-web.mjs:107-120),
and both are the party in question.

**What the PC-side check (apaki/engine/remote-page.js) covers.** Before a pairing
code, the PC builds the page it expects from its own files, fetches each file
of that version from the site and compares SHA-256 hashes
(remote-page.js:48-81, remote.js:685-703). The CSP is a meta tag inside the
hashed index.html (build-web.mjs:128-129), so it is covered too. That catches a
site that serves changed files to everyone, the PC included, at the moment the
PC pairs.

**What it does not cover:**

- **It fails open.** Any HTTP error, timeout or network failure gives
  'unreachable' (remote-page.js:68-71, 75-79), and the PC still shows a code
  (remote.js:693-694). A server that answers the PC's check with a 503 skips it.
- **It checks what the PC was sent, not what the phone runs.** The PC fetches
  with Node's fetch, which looks nothing like a phone browser (user agent,
  headers, TLS fingerprint), from the IP address its relay socket uses. A
  server can serve good files to that and changed files to browsers. That is
  not "singling out one phone"; it is every phone at once, and no PC would
  notice. Today the static files are served without running the Worker, the
  same to everyone (wrangler.jsonc:16-18), so this takes a deploy, which users
  would not see.
- **It runs only at pairing.** Paired phones and account phones load the page
  again on every open, and nothing checks those loads. A phone that signs in
  to an account was never covered by any check.
- **Only bodies are hashed, not response headers.** Headers cannot loosen the
  meta CSP, so this matters little.
- **All versions share one origin.** Every /v/<version>/, every old version
  (they stay published forever, build-web.mjs:201-224) and the front page share
  apaki.myrlin.io, and with it IndexedDB and the passkeys. Checking one version
  constrains nothing else on the origin.

**What the service worker (apaki/web/src/sw.js) does.** For: offline start, and
the assets of one build cached together (sw.js:18-20, 39). Against a hostile
server: nothing. Navigations go to the network first (sw.js:35-37), so a
changed index.html at the same address is used at once. The worker updates
itself from the server and takes over immediately (skipWaiting and
clients.claim, sw.js:19, 26), and browsers re-check sw.js on navigation. The
README's "the phone keeps the version it installed" (relay/README.md:158-160)
is not what the code does. No web mechanism lets a site pin its own code
against its own future self, so this cannot be fixed inside the browser.

**What the CSP does.** `script-src 'self'` with no inline scripts
(build-web.mjs:109) is a real defence against a reply or an artifact injecting
script into the page. Against the server itself it does nothing. It also does
not govern top-level navigation or WebRTC, so "could not send anything
anywhere else" (relay/README.md:170-173) overclaims even for injected script.

**How likely.** This needs control of the Cloudflare account, the zone,
Cloudflare, or a court order. It is not a drive-by risk. But the question is
whether we can say "cannot", and today we cannot.

### 1.4 Gap 2: accounts

- **The page handles the secrets.** The PRF output (account.js:118-121, 300-305)
  and the decrypted vault (account.js:165-169) are ordinary JavaScript values;
  a modified page could keep them.
- **No passkey needed after sign-in.** The phone keeps the vault key as a
  non-extractable but usable CryptoKey, and the session token, in IndexedDB
  (store.js:15-19, account.js:306). Page code can fetch and open the vault at
  any time. relay/README.md:269-271 says a swapped page "could read the vault
  once the passkey opens it"; it does not need the passkey again.
- **The account device key is extractable.** The vault holds it as a JWK
  (account.js:257-263), unlike a QR-paired phone's key, which never exists as
  bytes.
- **The vault key never changes.** Removing a passkey removes its wrap
  (relay/src/account.js:519-540), but anyone who already had the vault key
  keeps reading every later version.
- **Rollback is not detected.** The phone accepts any vault whose version
  differs from the one it knows (apaki/web/src/account.js:324), and the
  version is not in the AES-GCM associated data (account.js:70-71). The server
  can hand back an older vault, for example one that still lists a PC the user
  removed from the account while that PC was offline. relay/README.md:266-268
  implies the phone notices; it does not.
- **Linking is automatic and unapproved.** A signed-in phone saves every PC it
  reaches with its own pairing to the account, quietly, on every connect
  (apaki/web/src/boot.js:362), and the PC accepts the account device with no
  approval (remote.js:463-493). Signing in on one phone extends the account to
  every PC that phone was paired with.
- **A session token alone** (no passkey) can delete the account, remove other
  passkeys, rename it, and overwrite the vault (relay/src/account.js:252-309).
  The server can mint sessions with ACCOUNT_KEY anyway. The impact is denial of
  service, not access.
- **What the account server cannot do by itself:** sign in as the user (needs an
  assertion), open the vault, put a PC into the vault (needs the vault key), or
  add a device to a PC (only a paired device can send account-link).

### 1.5 What a phone may do on the PC

The allowlist (apaki/engine/remote-policy.js:27-33): sessions, search, open,
attach, send, interrupt, answer, model, effort, mode, commands, close,
artifactGet, and since 1a55d53 steer (the same power as send) and
contextUsage. Everything else is refused, including billing, folders, Glass,
voice, Ask Claude, Dig deeper, openExternal, browserTool and every remote* op
(remote-policy.js:102-106, engine.js:948-957).

| Question | Answer | Where |
|---|---|---|
| Can a phone switch a conversation to bypassPermissions? | Yes, on open or with the mode op | remote-policy.js:45, 147, 201-204 |
| Do phone conversations start in bypassPermissions? | Yes, unless the desktop default was changed | engine.js:134, 229, 748 |
| Can a phone run tools without the PC user? | Yes, in every mode: the permission callback always allows | engine.js:553 |
| Can it approve plans and answer questions? | Yes, for its own panes | remote-policy.js:177-191 |
| Can it pick any folder? | No: a folder some listed session used, or home | remote-policy.js:137-141 |
| Can it read other sessions? | Yes, any session on the PC, with takeover | remote-policy.js:132-144, engine.js:510-519 |
| Can it touch desktop panes or other phones' panes? | Not directly (ids get the phone's prefix); it can take over their session | remote-policy.js:17-21, 58-82 |
| Can it add devices to the PC? | Yes, account devices, with no approval | remote.js:463-493 |
| What else does it receive? | Folder, Glass and index broadcasts (account names and usage) | remote-policy.js:42 |

In plain words: a paired phone is a remote control for Claude Code on the PC
with the same power as the person at the PC, minus billing and settings
buttons. That is the product. It also means "the shell and the file system
are out of its reach" (FEATURES.md:137-139, relay/README.md:164-169) is wrong:
Claude reaches both on the phone's behalf. The PC user's own Claude Code deny
rules and hooks are the only limit today. The desktop's approval dialog says
the phone "can then use the Claude Code sessions on this PC"
(apaki/ui/phone.js:121); it does not say the phone can run commands.

### 1.6 Metadata and logging

What the server side (relay, account API, Cloudflare) sees:

- IP addresses, rough location and User-Agent of the PC and every phone, on
  every page load, socket and API call.
- Room ids (they are in the socket path), when each PC and phone connects and
  leaves, how many phones a room has.
- Frame sizes and timing: typing, a reply streaming, a file moving.
- The device id in every reconnect (cleartext in HELLO1, PROTOCOL.md:128), so
  it can tell which phone came back. All phones of one account share the
  account device id, so it can also group them.
- Presence questions: whenever the phone shows its PC list it asks about every
  saved PC on this relay (boot.js:129-147, account.js:385-393), even without an
  account. That ties all of a phone's rooms to one IP at one moment.
- Accounts: name, number of passkeys and their provider (a label from the
  AAGUID, relay/src/account.js:353-369, account-lib.js:325-330), created and
  last-used times, vault size (roughly how many PCs) and every vault update.
- Each PC's page version and IP at every pairing (the page check).
- Correlation: an account signs in from an IP, then that IP opens sockets to
  rooms.

What is logged: the relay code writes nothing and Workers observability is off
(wrangler.jsonc:37-38). That is a setting, not a property. Anyone with the
Cloudflare account can stream live request logs (wrangler tail) or deploy a
version that logs, at any moment, and users would not see it. Cloudflare keeps
its own analytics as the TLS endpoint. Cloudflare also adds Network Error
Logging headers to every answer (seen live on 2026-10-10: `Nel` and
`Report-To` on https://apaki.myrlin.io/ and /v/cab37e8659c3/), so phones
report failed connections to Cloudflare. The URL fragment, which holds the
pairing secret, is never part of any request, so none of this sees it.

### 1.7 Denial of service and the budget guard

- A relay can drop, delay or close, and inject the unauthenticated plaintext
  alerts (PROTOCOL.md:171-178). Clients see failures. That is accepted.
- **Anyone can switch the hosted relay off for everyone, every day.** Past $3 of
  estimated spend per UTC day the guard closes every room and refuses new
  connections (relay/src/lib.js:57, index.js:106-108, 277-293). Rooms cost
  nothing to create (any random token is a valid room). The per-IP limit
  counts new connections per minute, not open ones (wrangler.jsonc:36). An
  awake room is priced at 0.128 GB x $12.50 per million GB-s, about $1.6e-6 a
  second (lib.js:75-83), and one frame every 10 s keeps a room awake for
  pricing (lib.js:86-93). So one client on one IP can open 200 rooms in 10
  minutes and, sending about 20 small frames a second in total, reach $3 in
  under 3 hours; a few IPs bring that well under an hour. Phone access is then
  off for all users until 00:00 UTC. Cloudflare's DDoS protection will not
  notice traffic that small.
- **Anyone who knows a room id can crowd the room.** Up to 8 phone sockets per
  room (lib.js:48) and 60 connections a minute per room (lib.js:49,
  index.js:219-221) let a few IPs keep the owner's phone out. Room ids are on
  every paired phone and in every QR ever shown.
- Presence tells anyone with a room id when the PC is online (rate limited,
  relay/src/account.js:319-335); a phone socket's ready message tells them the
  same.
- The budget check lets traffic through if the Budget object errors
  (index.js:119-128): availability over cost, which is the right way round
  given the $10 Cloudflare spend alert.

### 1.8 Summary

| Actor | Can | Cannot |
|---|---|---|
| Relay (honest code, hostile operator) | see metadata; refuse service; inject alerts | read or change content; pair; pose as the PC or a phone; connect to the PC |
| Account API | see account metadata; delete accounts; roll back or overwrite vaults; refuse sign-in | open the vault; put a PC in the vault; add a device to a PC; sign in as the user |
| Site (serves the page code) | whatever a paired or signed-in phone can do, on every phone that loads a changed page: run commands on PCs, read sessions, add hidden account devices, take vault contents | be caught by the PC check, if it serves the PC the right bytes or makes the check fail |
| Anyone else | switch the relay off daily (budget); crowd a known room; watch a known room's presence | anything more without a QR, a device key, or the passkey |
| A stolen, unlocked phone with the page's storage | everything that phone could do, until it is removed on the PC (and its account device, if it had one) | come back after removal without a new QR, unless through an account device |

## 2. Comparison

### 2.1 Signal

| Topic | Signal | Apaki | Verdict |
|---|---|---|---|
| Session setup | PQXDH (X25519 plus a post-quantum KEM), with prekeys so it works while the other side is offline | Interactive 3-message handshake: ephemeral ECDH P-256, ECDSA identity signatures, a PSK mixed in; both ends online (PROTOCOL.md:65-151) | Different job. Ours is close to TLS 1.3 with a PSK, or a Noise handshake, which fits a live channel. |
| Keys over time | Double Ratchet, and since October 2025 SPQR on top (the "Triple Ratchet"): new keys per message, healing after a key leaks | Fresh keys per connection (forward secrecy); the device psk and keys never change | Weaker after a compromise: a stolen psk plus a usable device key works until the phone is removed. A per-message ratchet buys little for a live session; rotating the psk on each reconnect would buy most of the healing. |
| Post-quantum | Yes, at setup and in the ratchet | No KEM. But the QR secret (never on the network) feeds the pairing keys, and the device psk feeds every reconnect (PROTOCOL.md:87-100, 137-140), so recorded traffic stays safe from a future quantum computer unless the QR itself was seen | Formally weaker, decent in practice. A hybrid KEM is a later item. |
| Checking the other side | Safety numbers (60 digits), comparable at any time; a warning when a key changes | The QR carries the PC's public key; a 6-digit code with a commitment at pairing (PROTOCOL.md:97, 116-120); keys never change afterwards (pairing again makes a new device) | Comparable for this use. The commitment leaves a man in the middle one guess in a million. There is no later "verify" screen, and none is needed while keys never change. |
| Adding devices | Linked devices by QR, scanned by the primary phone. In 2025 Russian state actors phished users into linking attacker devices this way | QR from the PC, code comparison, approval on the PC. But account-link adds devices with no approval (remote.js:463-493) | Pairing: comparable or stronger. Account-link: weaker, and the same kind of hole those campaigns used (a device added without the owner noticing). |
| Hiding who talks | Sealed sender hides the sender from Signal's server; IPs remain visible | The relay sees room ids, device ids and IPs | Weaker. Encrypting the device id in HELLO1 is cheap. |
| How clients ship | Signed native apps only. No web client, on purpose: a web page cannot be versioned, signed and pinned | The phone client is a web page from our server | The main gap. The native app closes most of it. |
| Reproducible builds | Android since 2016 (a Docker build plus an APK diff); iOS store binaries cannot be compared | The phone page is reproducible (build-web.mjs:80-105), but the repository is private (relay/README.md:161-163), so nobody else can check | Close once public; native next. |
| Outside analysis | Academic analyses; PQXDH machine-checked with ProVerif and CryptoVerif (2023, with a published fix); SPQR analysed with Cryspen | None | Weaker; fixable (section 3). |

Where the difference does not matter: prekeys and offline delivery (both ends
are online by design), group messaging, history across devices.

### 2.2 WhatsApp Web's Code Verify

Meta's answer to the same web problem: a browser extension checks the code the
browser actually runs against hashes WhatsApp publishes through Cloudflare, as
a third party. Ours compares against a full rebuild from source on the PC,
which is a stronger reference than a published hash, but it runs on the PC,
which never sees what the phone got. Theirs runs where the code runs. Phones
have no real extension story (some on iOS Safari, none on Android Chrome), so
the mobile equivalent of Code Verify is a native app.

### 2.3 Tailscale's Tailnet Lock

Tailscale's coordination server hands out node keys. With Tailnet Lock, nodes
accept only keys signed by trusted signing keys the customer holds, so a
compromised control plane cannot add a node. The Apaki analogue: the PC
already is the authority for QR pairing, because its user approves.
account-link breaks that rule today: any paired device, or code running on it,
adds a device. Requiring approval on the PC for every new device, account
devices included, gives the Tailnet Lock property: neither our servers nor code
they serve can add a device to your PC.

### 2.4 1Password

1Password's vault keys need the account password plus a 128-bit Secret Key
that its servers never see. Its staff have said publicly that the web client
has exactly our problem (a compromised server could serve a malicious client,
and a short, targeted serve to a few IP addresses could not be detected), that
they serve the index page from their own servers and use Subresource
Integrity, and that they want code-signed native clients for everything. Our
vault rests on one factor, the passkey's PRF output, whose safety is the
passkey provider's synced keychain, and it has the same web-client limit.

### 2.5 Proton

Proton serves web apps for end-to-end encrypted products and lives with the
same limit. Its answers: open-source clients, published third-party audits
(for example Cure53 on Proton Pass), and Key Transparency (beta since November
2023) so the server cannot silently swap a contact's public key. The parts we
can copy: open source, published audits, a transparency log.

### 2.6 Bottom line

Similar to Signal in the cryptography that matters here. Behind it in how the
client is shipped, in hiding metadata, and in outside verification. All three
can be fixed without changing the core handshake.

## 3. How to prove it

Three kinds of claim, strongest first:

- **Cannot**: follows from the code and the math. Shown by publishing the code,
  a formal model and an audit.
- **Would be caught**: a deviation leaves public evidence. Shown by a
  transparency log and independent watchers.
- **Do not**: a policy, such as "we do not log". It can only be trusted, so it
  should carry as little weight as possible.

The program, in order, with what we can say after each step:

0. **Today, once the wording is fixed (section 7).** "The relay cannot read or
   change your messages and never connects to your PC. The phone page is web
   code from apaki.myrlin.io; your PC checks it before pairing."
1. **Fix what are really bugs (S, days).** The page check fails closed; account
   links need approval on the PC; each phone gets a capability the PC enforces;
   the vault version goes into the associated data, rollbacks are refused and
   the vault key rotates when a passkey is removed. After: "Nothing is added to
   your PC without your approval on the PC. Your PC shows no pairing code
   unless it verified the exact page. You decide on the PC what each phone may
   make Claude do."
2. **Open source (S, a decision).** Publish therealarthur/claude-latch, or at
   least apaki/remote, apaki/web, apaki/engine/remote*.js and relay/. After:
   "Anyone can read the code that runs on your PC, on the phone and on our
   relay."
3. **Reproducible builds with a public record (S to M).** The web page already
   is reproducible. Add the git commit to each manifest.json (build-web.mjs:219
   writes the version, relay, date and file hashes only) and a CI job that
   rebuilds every published version from its commit and posts the result. For
   native: Android with a Signal-style Docker build and APK diff; iOS store
   binaries cannot be compared, so publish the build recipe. After: "Every
   phone page we have published is byte for byte the code in a public commit.
   Check it yourself."
4. **Transparency log (M).** Record every page version and every app build
   (hash, commit, time) in a public append-only log. Sigstore's Rekor is the
   obvious choice: CI signs with a keyless identity tied to the repository's
   workflow, and the log is witnessed. The PC refuses a page version that has
   no log entry, using an inclusion proof shipped with Apaki (works offline).
   Add a watcher that fetches the live pages from several networks, with real
   browser fingerprints, every hour, and raises an alert on any file not in the
   log. After: "Every page and app build we have shipped is in a public log.
   Serving anything else to browsers is detectable by anyone." It still does
   not prevent a targeted serve; it turns one into evidence.
5. **PC-side pinning (S).** The PC already pins the version it builds. Add:
   fail closed (step 1), and while phone access is on, re-check every published
   version it knows once an hour with browser-like requests; on any difference,
   turn phone access off and say why. After: "If our site ever changes a
   published page, every PC with phone access notices within an hour and stops
   trusting it."
6. **Native apps (L; being built on feat/apaki-mobile in
   Projects/claude-latch-mobile).** The app bundles the page code and loads
   nothing from apaki.myrlin.io. Device keys live in the Secure Enclave or
   Android StrongBox (both do P-256 signing), cannot be exported, and can
   require Face ID or a fingerprint for each connection. The psk goes in the
   Keychain or Keystore, this device only. A Private QR (an apaki:// link) only
   the app opens. After: "In the Apaki app, our servers send your phone no
   code. To change what it runs we would need our signing key and an app store
   release. The phone's key never leaves its secure hardware." Distribution
   still trusts Apple, Google and our signing key; steps 3 and 4 cover that for
   Android, and the log covers both.
7. **Formal model (M, a few weeks).** A Tamarin or ProVerif model of pairing
   (the QR as a confidential, authentic channel the attacker may also read; the
   code comparison as a human check; the approval), reconnect, removal and
   account-link. Properties: secrecy of traffic keys; agreement in both
   directions; forward secrecy after a long-term key leaks; no impersonation
   after a key leak (KCI); "a leaked QR cannot pair without the PC user seeing a
   code that does not match"; "no device is added without approval on the PC".
   Publish the model. After: "The handshake's security properties are
   machine-checked; the model is public."
8. **Independent audit (L, money).** Scope: protocol.js, wire.js, remote.js,
   remote-policy.js, the engine's permission handling, the relay with accounts
   and WebAuthn, the web client, the native app. Two to four weeks with a firm
   that does applied cryptography (Cure53, Trail of Bits, NCC Group and
   similar). Publish the report and the fixes. After: "Audited by <firm>,
   report published."
9. **Bug bounty (S to M).** Start with /.well-known/security.txt, a disclosure
   address and a hall of fame; add money after the audit. After: "We pay people
   who break it."

## 4. Two tiers: Private and Connected

### 4.1 Private

For: "nobody but me and my PC; I would rather scan a QR again than trust a
server."

- **What is stored where.** PC: its identity, the room token, and each phone's
  public key and psk, sealed with DPAPI (apaki/engine/remote-store.js). Phone:
  the device key in secure hardware and the pairing record (native app).
  Server: nothing persistent. No account object exists; the room keeps only
  its idle alarm.
- **What each server sees.** Relay: IPs, the room id, when things connect and
  leave, frame sizes and timing; after item 8 in section 5, not which phone.
  Account API: nothing, it is never called. Site: nothing; the native app does
  not load it, and a self-hosted page loads from your own host.
- **Threat model.** Our servers, Cloudflare and a coerced operator can refuse
  service and watch metadata. They cannot read, inject, pair, add a device or
  run anything on the PC, because they serve the client no code. A stolen
  phone needs its unlock and, if turned on, a biometric for each connection. A
  compromised apaki.myrlin.io web page does not touch Private users.
- **UX.** Scan a QR once per phone per PC. A new phone means a new QR. A fresh
  phone has no "my PCs" list. Online state comes from opening the room's socket
  (the relay's ready message says whether the PC is there), not from presence.
  A lost phone means removing it on the PC and pairing again.
- **Before the native app ships,** Private means the hosted web page plus the
  PC-side limits, or your own relay and page (APAKI_RELAY_URL and
  APAKI_WEB_URL, relay/README.md:337-345). The Phone sheet should say which:
  "This phone runs a web page from apaki.myrlin.io and trusts that site."

### 4.2 Connected

For: "sign in anywhere and my PCs are there; later, tell me when Claude needs
me."

- **What is stored where.** Server: account id, name, passkey public keys and
  metadata, session generation, the vault ciphertext with one wrap per
  passkey, spent challenges; later, push tokens. Phone: the session token, the
  vault key (non-extractable but usable), the account device key. Inside the
  vault: the account device's private key and, per linked PC, its room id,
  relay, public key and psk. PC: one account device per linked account.
- **What each server sees.** Everything in Private, plus: account name, passkey
  count and provider, sign-in times and IPs, vault size and update times, and
  the link between an account's sign-ins and the rooms its phones open. With
  push: each phone's push token and when the PC asks for a push (payloads
  encrypted end to end; Apple and Google see the token, the time and the size).
- **Threat model.** Everything in Private, plus: web users trust the page
  apaki.myrlin.io serves (narrowed by steps 1, 3, 4 and 5 of section 3, not
  removed). Everyone trusts their passkey provider, because the passkey both
  signs in and opens the vault, so whoever holds the passkey reaches every
  linked PC. The account server can refuse service, delete the account and,
  until fixed, roll back the vault. It cannot open the vault or reach a PC by
  itself.
- **UX.** Today's account flow: passkey sign-in, PCs listed with online state,
  PCs saved from any phone, removable per PC. One change: the first time an
  account is linked to a PC, the PC asks ("Arthur's Apaki account, added by
  iPhone (Safari): allow?").

### 4.3 Side by side

| | Private | Connected |
|---|---|---|
| Pairing | QR plus code, per phone | QR once from any phone, then any signed-in phone |
| Server state | none | account record and vault ciphertext |
| Client code from our server | none (native app) or your own host | the web page from apaki.myrlin.io, or the native app |
| Who can reach the PC | phones paired with its QR and approved on it | those, plus anyone holding the account's passkey |
| New device without approval on the PC | never | never (after item 2 in section 5) |
| Presence queries | none | yes |
| Push notifications | no | later, encrypted end to end |
| Strongest honest claim | "our servers cannot do anything to your PC" (with the native app) | "our servers cannot read your data or reach your PC by themselves; the web page is code we serve, recorded in a public log" |

### 4.4 Where the switch lives, and the minimal changes

The PC decides, because it is the thing being protected. The phone follows.

PC (authoritative):

1. apaki/engine/remote-store.js, state.json: `mode: 'private' | 'connected'`.
   Default for new installs: private. An install that already has account
   devices stays connected until the user changes it.
2. apaki/engine/remote.js:
   - a desktop op `remoteMode { mode }`; switching to private offers to remove
     the existing account devices;
   - `accountLink` (remote.js:472): in private, answer
     `{ error: 'This PC only accepts phones paired with its code.' }`; in
     connected, hold the request and ask on the PC with the same approve and
     deny flow pairing uses (remote.js:403-410, 724-741);
   - `opened` (remote.js:424): put `mode` in the hello so the phone can hide
     account features;
   - `pairStart` (remote.js:690-695): fail closed on 'unreachable', with an
     explicit "pair anyway" in the Phone sheet if an escape hatch is wanted;
   - per device, a capability `cap: 'full' | 'noshell' | 'chat'`, stored on the
     device record and passed to the policy.
3. apaki/engine/remote-policy.js, `checkPhoneCommand`: honour `ctx.cap` ('chat':
   plan mode only, mode changes refused; 'noshell': bypassPermissions refused).
4. apaki/engine/engine.js, `open` (engine.js:541-553): for phone panes with cap
   'noshell', pass disallowedTools for Bash, Write, Edit, NotebookEdit and the
   browser tools, and answer "deny" for them in canUseTool. The PC enforces
   this whatever code the phone runs.
5. apaki/ui/phone.js (the desktop Phone sheet): the mode switch, each phone's
   capability, the account approval card, which client each phone uses, and
   approval text that says the phone can have Claude run commands.

Phone:

6. apaki/web/src/boot.js: when hello.mode is private, or no account is signed
   in, skip account linking (boot.js:362) and presence (boot.js:129).
7. Native app: Private by default (no account UI until turned on), bundled
   code, hardware keys, apaki:// pairing links.

Relay (optional, recommended):

8. A second, relay-only Worker for Private: the same Room and Budget classes,
   no static assets, account routes off (one environment check before
   relay/src/index.js:80-82), on its own hostname, named in Private QRs. Then
   "the private relay serves no code and holds no accounts" is literally true
   of that hostname, and account traffic cannot affect it.

### 4.5 Recommendation

One product, two modes, switch on the PC, Private by default.

- **Now (days):** items 1 to 7 in section 5. They make Connected honest and give
  Private its PC-side half.
- **With the native app:** Private becomes native app, QR, no account, hardware
  keys. The hosted web page becomes a Connected convenience, labelled as
  trusting apaki.myrlin.io.
- **Then the proof program:** open source, reproducible builds tied to commits,
  the transparency log, the formal model, the audit, the bounty.

Why not two separate products: the protocol, the relay and the PC code are the
same; only what the PC accepts and which client the phone runs differ. One
switch on the PC keeps the change small and puts the control where the user
can see it.

## 5. Hardening list, in priority order

| # | Item | Effort | Tier | Claim it unlocks | Where |
|---|---|---|---|---|---|
| 1 | The page check fails closed when the site is unreachable or answers with an error | S | both | "No pairing code without a verified page" | remote.js:690-695, remote-page.js:68-79 |
| 2 | Approval on the PC for every account-link; refused in Private | S | both | "Nothing is added to your PC without your approval on the PC" | remote.js:452, 463-493 |
| 3 | Correct the overclaims (section 7), including the pairing approval text | S | both | everything we say is true | FEATURES.md, relay/README.md, build-web.mjs:256-259, apaki/ui/phone.js:121 |
| 4 | A per-phone capability enforced on the PC (full, no shell, chat only); phone panes do not silently inherit bypassPermissions; the Phone sheet shows each phone's mode | M | both | "You decide on the PC what each phone may make Claude do" | remote-policy.js, engine.js:134, 229, 541-553 |
| 5 | Budget fairness: cap open sockets per IP, count only rooms with a PC and a phone, give each IP and room a share of the daily budget | S to M | both | "One abuser cannot switch the relay off for everyone" | lib.js:57, index.js:88-108, 277-293 |
| 6 | Vault: version in the associated data, a lower version refused, the vault key rotated on passkey removal and sign-out-everywhere, the vault padded to fixed sizes | S to M | Connected | "The server cannot roll back your vault, and a removed passkey cannot read later versions" | apaki/web/src/account.js:70-71, 176-194, 318-335 |
| 7 | Hourly re-check of published pages with browser-like requests; on a difference, phone access off and an alert | S | both (web) | "A changed page is noticed within an hour" | remote.js:705-714 |
| 8 | Encrypt the device id in HELLO1 to the PC's key | M | Private | "The relay cannot tell which of your phones connects" | protocol.js, HELLO1 |
| 9 | Native app: bundled code, Secure Enclave or StrongBox keys, optional biometric per connection, apaki:// Private QR | L | Private | "Our servers send your phone no code" | Projects/claude-latch-mobile, feat/apaki-mobile |
| 10 | Open source, the commit in manifest.json, CI that reproduces every published page | S to M | both | "Every page we serve is a public commit, reproducible" | build-web.mjs:206-224 |
| 11 | Transparency log (Rekor) for pages and app builds; the PC requires an inclusion proof | M | both | "Every build we ship is publicly recorded" | build-web.mjs, remote-page.js |
| 12 | A relay-only Worker and hostname for Private | S to M | Private | "The private relay serves no code and holds no accounts" | relay/wrangler.jsonc, index.js:80-82 |
| 13 | Presence only when signed in, and only for the account's PCs | S | Private | "Without an account your phone never tells the relay about other PCs" | boot.js:129-147 |
| 14 | Rotate the device psk on every reconnect (both sides keep the next one) | M | both | "A stolen phone secret stops working the next time your real phone connects" | protocol.js, reconnect |
| 15 | A fresh passkey assertion for destructive account actions (delete, remove passkey) | S | Connected | "A stolen session cannot delete your account" | relay/src/account.js:277-309 |
| 16 | Formal model of pairing, reconnect and account-link | M | both | "Machine-checked handshake" | new |
| 17 | Independent audit | L | both | "Audited, report published" | all of the above |
| 18 | security.txt and a disclosure address, then a paid bounty | S to M | both | "We pay for breaks" | relay/site/.well-known |
| 19 | Turn off Cloudflare's Network Error Logging for the zone; publish exactly what Cloudflare and we can see | S | both | "Your phone reports to nobody but the relay" | Cloudflare zone settings |
| 20 | A hybrid post-quantum KEM in pairing and reconnect | M | both | "Post-quantum even if a QR was photographed" | protocol.js |

Already in progress (uncommitted in apaki/engine/remote.js, another session):
optional pairing lifetimes of 1, 7 or 30 days, after which the PC removes the
phone as if Remove was pressed. Forever stays the default. It shortens the
window for a lost or stolen phone; it does not change any finding above. Two
follow-ups fit it: give account devices a lifetime too, and in Private mode
offer a lifetime when approving a pairing.

## 6. What we can say publicly today

Exact wording, defensible line by line:

> Phone access is end-to-end encrypted between your phone and your PC. Your PC
> never accepts incoming connections: it keeps one outgoing connection to the
> Apaki relay. The relay forwards sealed frames. It cannot read your prompts,
> replies, files or session list, cannot change them without the connection
> failing, and cannot pair a phone or pose as your PC or your phone. Your
> Claude and Codex logins never leave your PC.
>
> The relay does see connection details: IP addresses, when your PC and phones
> connect, and how much data moves. Our relay code keeps no logs and platform
> logging is off; that part you have to take on trust.
>
> The phone page is web code served by apaki.myrlin.io, like any web app.
> Before your PC shows a pairing code, it builds the page from its own code and
> checks that the site serves exactly that. This catches a general change to
> the page; it cannot prove what one phone was served later. If you do not want
> to trust our site, you can run your own relay and page.
>
> A paired phone can do what you can do in a conversation in Apaki on your PC,
> including having Claude run commands and edit files. Billing, account
> switching, and pairing or removing phones are controls only the PC has.
> Remove a phone on your PC and it cannot reconnect; if that phone was signed in
> to your Apaki account, remove the account on that PC too.
>
> With an Apaki account, your list of PCs is encrypted under a key only your
> passkey can produce. apaki.myrlin.io stores the encrypted copy and cannot open
> it. Anyone who has your passkey can reach the PCs in your account.

Not yet: "our servers cannot do anything to your PC", "trustless", "the relay
can only refuse service" without the page caveat, "logs nothing" as a fact,
"the shell and the file system are out of reach", "a changed page is a visible
update".

## 7. Current wording that overclaims

Not edited (other sessions own these files). Suggested replacements:

**FEATURES.md**

- 44-46, "the hosted relay at apaki.myrlin.io forwards opaque frames, holds no
  keys and stores nothing": it stores account records (relay/src/account.js:371-375).
  Say: "the hosted relay at apaki.myrlin.io forwards sealed frames it cannot
  read and keeps nothing about your conversations".
- 52-53, "so apaki.myrlin.io stores ciphertext and public keys and can never
  connect to anything": the page that opens the vault comes from the same site.
  Say: "so apaki.myrlin.io stores only ciphertext and public keys and cannot
  open the vault. The page that opens it on your phone comes from
  apaki.myrlin.io, as with any web app."
- 54-55, "Pair a PC once from any phone and every phone signed in to the
  account can reach it": true, but today the PC is not asked
  (remote.js:463-493). After item 2, add "after you allow it on the PC".
- 61-65, "if one byte differs, it will not show a code": an unreachable site
  still gets a code (remote.js:693-694), and the check sees only what the PC is
  sent. Say: "if a file it fetches differs, it will not show a code. The check
  sees what the site sends your PC when you pair; it cannot see what a phone is
  sent later." After item 1, add "or if it cannot reach the site".
- 137-139, "A phone can only talk to its own conversations and the session
  list. Billing, account switching, settings, the shell and the file system are
  out of its reach.": Claude reaches the shell and files for the phone, in
  every permission mode (engine.js:553), and a phone can open any session. Say:
  "A phone works in conversations and the session list, with the same Claude
  Code a desktop pane has: Claude can run commands and edit files there, as on
  the PC. Billing, account switching, pairing and settings are controls only
  the PC has."
- 140, "Remove a phone on the PC and it can never reconnect without a new QR":
  add "If it was signed in to an Apaki account linked to that PC, remove the
  account there too."

**relay/README.md**

- 127-129, "What it can do: refuse service. ... That is all.": say "As a relay,
  what it can do is refuse service. ... The same server also serves the phone
  page, which is a larger power; see the next section."
- 153-154, "Every Apaki that pairs is checking the same address, so a site swap
  shows up at once.": say "A swap the site also serves to PCs shows up the next
  time any Apaki pairs."
- 155-157, "What the check cannot catch: a site that serves the right files to
  the PC and other files to one chosen phone. Doing that needs the operator to
  single the phone out": understated. Say "What the check cannot catch: a site
  that serves the right files to PCs and other files to browsers (a PC's fetch
  is easy to tell from a phone's), a site that makes the check fail (an
  unreachable site still gets a code today), and every page load after
  pairing."
- 158-160, "Installable PWA. Once installed, the phone keeps the version it
  installed; a changed bundle is a visible update, not a silent swap.": not
  what sw.js does. Say "Installable PWA. It works offline. It does not pin the
  code: the page is fetched from the network on every open and the service
  worker updates itself (apaki/web/src/sw.js:19-37), so a changed page at the
  same address is used without notice. Only a native app can pin its code."
- 164-169, "never billing, pairing, folders or anything that reaches the shell
  or the filesystem": say "never billing, pairing or folders. Conversations run
  Claude Code as a desktop pane does, so Claude can run commands and edit files
  (tools are approved automatically in every permission mode,
  apaki/engine/engine.js:553)."
- 170-173, "so even an injected script in the page could not send anything
  anywhere else": say "so script injected into the page (by a reply, say)
  cannot run, and fetches and sockets reach only this origin and the relay.
  That does not limit the site itself, and the policy does not cover
  navigation or WebRTC."
- 183-184, "it cannot be copied off the phone as bytes": say "the device's
  private key cannot be copied off as bytes, though page code can use it; its
  psk is stored as data."
- 254-255, "It keeps no email, phone number, password or IP address, and logs
  nothing (no bodies, no tokens, platform logs off).": say "It stores no email,
  phone number, password or IP address. The Worker writes no logs and platform
  logs are off; whoever runs the Cloudflare account could turn logging on, and
  Cloudflare sees every request as the TLS endpoint."
- 266-268, "hand back an older vault (the phone then sees an older version than
  it knows)": say "hand back an older vault; the phone does not detect this
  today (apaki/web/src/account.js:324)."
- 269-271, "a page swapped for one phone could read the vault once the passkey
  opens it": say "a swapped page could read the vault on any signed-in phone
  without a passkey prompt, because the vault key is kept on the phone
  (apaki/web/src/store.js:15-19)."
- 272-275: add that a stolen ACCOUNT_KEY also lets someone delete accounts and
  overwrite vaults.

**Same problem elsewhere**

- The live front page (https://apaki.myrlin.io/, written by
  apaki/scripts/build-web.mjs:256): "this site holds no keys and stores
  nothing" (it stores accounts); build-web.mjs:258: "A phone can only use its
  own conversations and the session list" (see FEATURES.md:137-139 above).
- apaki/ui/phone.js:121, the approval dialog: "It can then use the Claude Code
  sessions on this PC, billed to this PC's accounts." This is the consent
  point; say "It can then run Claude Code on this PC, including commands and
  file edits, billed to this PC's accounts."
- apaki/web/README.md:66-68: "or reach the shell or the filesystem" contradicts
  its own lines 69-70.
- apaki/remote/PROTOCOL.md:14-15: "The relay and the website never see
  credentials or content" holds only while the site serves the published page;
  say so.

## Sources outside this repository

- Signal, SPQR and the Triple Ratchet (2025-10-02): https://signal.org/blog/spqr/
- Signal, reproducible Android builds: https://signal.org/blog/reproducible-android/
  and https://github.com/signalapp/Signal-Android/blob/main/reproducible-builds/README.md
- Cryspen, analysis of PQXDH: https://cryspen.com/post/pqxdh/ and
  https://www.usenix.org/conference/usenixsecurity24/presentation/bhargavan
- Google Threat Intelligence, Russia-aligned actors abusing Signal linked
  devices (2025): https://cloud.google.com/blog/topics/threat-intelligence/russia-targeting-signal-messenger
- Meta, WhatsApp Code Verify (2022): https://engineering.fb.com/2022/03/10/security/code-verify/
- Tailscale, Tailnet Lock white paper: https://tailscale.com/kb/1230/tailnet-lock-whitepaper
- 1Password staff on the web client: https://1password.community/discussion/comment/604477
  and https://discussions.agilebits.com/discussion/comment/360996
- Proton Key Transparency: https://proton.me/support/key-transparency ; Proton
  Pass audit by Cure53: https://proton.me/blog/pass-open-source-security-audit
