# apaki-relay

The relay that lets a phone reach Myrlin Apaki on a PC from anywhere. It is a
Cloudflare Worker plus one Durable Object per room, and it only forwards
opaque, end-to-end encrypted frames between the PC socket and the phone
sockets of a room. It holds no keys, parses no payloads and stores nothing
about what passes through; it keeps cost counters for the current UTC day
(see Cost, with anyone able to use it).
(Since 2026-10-10 it also keeps optional Apaki accounts: a name, passkey
public keys and one vault it cannot open per account; see Accounts below.
None of that is a key to any room.)

The crypto lives on the two ends: `apaki/remote/protocol.js`, documented in
`apaki/remote/PROTOCOL.md`.

**Live at `apaki.myrlin.io` since 2026-10-10**, for anyone's Apaki: every
install makes its own room (its id is a hash of a secret only that PC holds),
so one relay serves many people without accounts and without being able to
read or join any of them. The same Worker serves the phone page (`site/`).
Apaki points at it by default; `APAKI_RELAY_URL` and `APAKI_WEB_URL` point an
Apaki at a copy you run yourself (see the end).

## Endpoints

```
GET /                          the front page (site/index.html): what this is, and every published phone page
GET /v/<version>/              a published phone page; each version is its own folder and never changes
GET /health                    one line saying what this is
GET /.well-known/security.txt  where to report a security problem (RFC 9116; site/.well-known/)
GET /v1/rooms/<roomId>/pc      WebSocket for the PC; subprotocols "apaki.v1" and "apaki-token.<token>"
GET /v1/rooms/<roomId>/phone   WebSocket for a phone; subprotocol "apaki.v1"
GET /v1/rooms/<roomId>/presence  { pc: true/false }: is that room's PC connected now (JSON, see Accounts)
/v1/account/...                Apaki accounts (JSON; see Accounts)
```

- `roomId` is 22 base64url characters: the first 16 bytes of
  `SHA-256("apaki/v1 room" || token)`. The Worker recomputes it from the token
  a PC socket offers, so only the holder of the token can be the PC of a room,
  with no registration step and nothing stored. A wrong or missing token gets
  HTTP 403 before anything reaches the Durable Object, and the DO never sees
  the token. Phones only ever know the room id.
- The token travels as a WebSocket subprotocol because browsers cannot set
  headers on WebSockets and URLs end up in logs.
- A newer PC socket with the token replaces the older one (close 4000): that is
  a PC restart, or a half dead socket.

## Wire format

- Phone socket: binary frames are protocol frames, untouched.
- PC socket: every binary frame starts with the phone's connection id (u32,
  big endian), added by the relay on the way in and removed on the way out.
  Connection ids are random per connection and only mean something inside the
  room. A frame for a gone connection comes back as `{ t: 'leave', conn }`.
- Text frames are control messages (JSON):

| Direction | Message |
|---|---|
| relay to PC | `{ t: 'ready', role: 'pc', phones: [conn...], limits }`, `{ t: 'join', conn }`, `{ t: 'leave', conn }` |
| relay to phone | `{ t: 'ready', role: 'phone', conn, pc: true/false, limits }`, `{ t: 'pc', up: true/false }` |
| relay to anyone | `{ t: 'bye', code, reason }` right before the relay closes the socket |
| PC to relay | `{ t: 'kick', conn }` closes that phone connection (4003) |
| anyone | `ping`, answered `pong` by the runtime without waking the room |

`limits` is `{ maxFrame, maxPhones, framesPerSec, bytesPerSec, idleMs }` so a
client can pace itself. Phones may not send other text (close 1003). Frames a
phone sends while no PC is connected are dropped; the phone was told
`pc: false` and hears `{ t: 'pc', up: true }` when the PC is back.

**Client contract:** send `ping` right after the socket opens and then at
least every 30 seconds, and treat `{ t: 'bye' }` as the close. The first ping
matters: workerd (1.20261006, seen locally) does not finish a server-side
close on a hibernated socket that has never sent a message, so without it the
close frame can arrive minutes late.

Close codes in `bye` (and on the close frame), from `CLOSE` in `src/lib.js`:

| Code | Meaning | Suggested reaction |
|---|---|---|
| 4000 | replaced by a newer PC connection | PC: wait a few minutes (Apaki waits 5) |
| 4003 | the PC dropped this phone connection | do not reconnect at once |
| 4008 / 4009 | too many frames or bytes per second / frame too large | slow down, reconnect |
| 4029 | room full | retry later |
| 4404 | no PC in this room (since 2026-10-10): after `NO_PC_MS` without one, or a frame sent while there is none | reconnect and wait for the PC as before |
| 4408 | idle | reconnect |
| 4503 | the relay used today's budget | wait; retry every 30 minutes until 00:00 UTC |
| 4504 | this address used its share of the day (since 2026-10-10) | same as 4503 |
| 4505 | this room used its share of the day (since 2026-10-10) | same as 4503 |

4404, 4504 and 4505 are not yet in `apaki/remote/protocol.js` `RELAY_CLOSE`;
today's clients treat them as an ordinary close and reconnect with their usual
backoff, which the Worker refuses with HTTP 429 until 00:00 UTC.

## Limits

Defaults in `src/lib.js` (`DEFAULT_LIMITS`); each can be overridden with a
Worker var of the same name.

| Limit | Default | On breach |
|---|---|---|
| `MAX_FRAME_BYTES` | 132 KiB (a full protocol record plus the 4-byte header fits) | close 4009 |
| `MAX_PHONES` per room | 8 | the socket is accepted, gets `bye`, close 4029 |
| `CONNECTS_PER_MINUTE` per room | 60 | HTTP 429 |
| `PHONE_FPS` / `PC_FPS` frames per second per socket | 60 / 600, burst 2 s | close 4008 |
| `PHONE_BPS` / `PC_BPS` bytes per second per socket | 2 MiB / 8 MiB, burst 2 s | close 4008 |
| `IDLE_MS` with no frame and no ping | 10 minutes | close 4408 |
| `NO_PC_MS` a phone in a room without its PC | 1 minute; at once if it sends a frame | close 4404 |
| `MAX_SOCKETS_PER_IP` open WebSockets per address, over all rooms | 32 | HTTP 429 |
| `IP_SHARE_USD` what one address may cost per UTC day | $0.30 | HTTP 429 until 00:00 UTC; its open sockets close 4504 |
| `ROOM_SHARE_USD` what one room may cost per UTC day | $0.50 | HTTP 429 until 00:00 UTC; the room's sockets close 4505 |
| `DAILY_BUDGET_USD` what the whole relay may cost per UTC day | $3 | HTTP 503 until 00:00 UTC; every room closes 4503 |
| `LEASE_MS` how long an open socket counts without its room renewing it | 30 minutes | (housekeeping) |

"Address" means an IPv4 address, or an IPv6 /64 (one home network or one
phone gets a whole /64 and can use any address in it); `clientKey` in
`src/lib.js`. The per-minute connection limit (the `CONNECTS` binding, 20 a
minute) uses the same key since 2026-10-10.

Rate counters live in memory and reset when a room hibernates, which only
happens when it is quiet anyway.

## Cost

- WebSocket Hibernation API: while a room is idle the Durable Object is
  evicted from memory; pings are answered by the runtime and do not wake it.
- One alarm per room every `IDLE_MS` while it has sockets (the idle check);
  rooms with nobody connected cost nothing.
- A phone waiting in a room without its PC is closed after a minute (or at
  once if it sends a frame) and reconnects to wait again, so a room with no PC
  cannot be kept awake.
- The DO class is SQLite backed (`new_sqlite_classes` in the migration), which
  is what the Workers free plan supports. It stores its alarm and, since
  2026-10-10, its cost for the current UTC day, which it deletes at 00:00 UTC
  once the room is empty.

## Threat model

**What the relay operator (us, Cloudflare, or anyone who takes over the
Worker) can see:**

- that a room exists, when a PC and phones connect and disconnect, how many
  phones a room has;
- IP addresses and rough location of the PC and the phones (Cloudflare
  terminates the TLS);
- frame sizes and timing, so roughly how much is going on (typing, a reply
  streaming, a file moving);
- the room id, and in each reconnect the phone's device id (a hash of its
  public key), so it can tell the same phone coming back.

**What it cannot see or do:**

- read any content: prompts, replies, file names, artifacts, session lists;
  everything is AES-256-GCM under keys from an authenticated ECDH exchange
  between the PC and the phone;
- see or use credentials: Claude and Codex logins never leave the PC; the
  phone holds only its own device key and a per-device secret;
- pair a phone: that needs the one-time secret, which only exists in the QR
  (in the URL fragment, never sent to a server);
- pose as the PC to a phone (needs the PC's private key) or as a paired phone
  to the PC (needs the device's private key and secret);
- change, replay, reorder or drop frames without the session noticing (it
  closes; the client reconnects);
- claim the PC side of a room (needs the room token; the room id is its hash).

**What it can do as a relay:** refuse service. It can drop or delay frames,
close sockets, or inject the plaintext alerts and control messages, and the
clients will see failures. The same server also serves the phone page, which
is a larger power; see the next section and apaki/SECURITY.md.

### The weak spot: the website supplies the code, and how the PC checks it

The phone runs whatever JavaScript the site serves. Whoever controls that
site (or its hosting, or its DNS) could serve a version that sends the
phone's device secret and decrypted messages somewhere else. That is the
limit of any web app that does end-to-end encryption, so Apaki does not take
the site's word for it (since 2026-10-10):

- **Reproducible pages.** The phone page is built from Apaki's own window
  code by `apaki/scripts/build-web.mjs`: text files with LF endings, every
  file hashed, one version id for the whole build. The same code builds the
  same bytes on any machine.
- **One address per version, never changed.** `build-web.mjs --release`
  publishes a build at `site/v/<version>/` with a `manifest.json` of its
  files' SHA-256 hashes, and refuses to publish over a version that differs.
  Earlier versions stay, so a PC on an older Apaki still opens its own page.
  These files are served `immutable`.
- **The PC checks before every pairing code** (`apaki/engine/remote-page.js`).
  It builds the version it expects from its own files, fetches every file of
  that version from the site and compares the hashes. Only an exact match
  gets a pairing code, and the code opens that exact version
  (`https://apaki.myrlin.io/v/<version>/#p=...`). A changed or missing file
  means no code, and the Phone sheet says why. A swap the site also serves to
  PCs shows up the next time any Apaki pairs.
- **What the check cannot catch:** a site that serves the right files to PCs
  and other files to browsers (a PC's fetch is easy to tell from a phone's),
  a site that makes the check fail (an unreachable site still gets a code
  today; see apaki/SECURITY.md, hardening item 1), and every page load after
  pairing. Running your own copy (below), or the native app, removes this.
- **Installable PWA.** It works offline. It does not pin the code: the page
  is fetched from the network on every open and the service worker updates
  itself (apaki/web/src/sw.js), so a changed page at the same address is used
  without notice. Only a native app can pin its code.
- **Open source.** With the client, the protocol and this relay published,
  anyone can build the bundle and compare hashes with the `manifest.json` of
  each version. The repository (therealarthur/claude-latch) is private today,
  so this one applies once it is published.
- **Least power on the phone** (in place): the device key is non-extractable
  (WebCrypto keeps it out of reach of page scripts; IndexedDB stores the key
  object, not the bytes), and the PC decides what a phone may do
  (`apaki/engine/remote-policy.js`: an allowlist of conversation and
  session-list commands; never billing, pairing or folders). Conversations
  run Claude Code as a desktop pane does, so Claude can run commands and edit
  files there (tools are approved automatically in every permission mode, see
  apaki/engine/engine.js).
- **A strict page policy** (in place): the phone page's
  Content-Security-Policy allows only its own files, its own origin's account
  API and a WebSocket to the one relay it was built for (`connect-src 'self'
  wss://apaki.myrlin.io`), so script injected into the page (by a reply, say)
  cannot run, and fetches and sockets reach only this origin and the relay.
  That does not limit the site itself, and the policy does not cover
  navigation or WebRTC.

### Stolen or lost phone

A paired phone is a key to the PC's Apaki: whoever holds it unlocked, with
the web client's storage intact, can connect. Defences:

- **Revocation:** remove the phone in Apaki on the PC. Its record (public key
  and secret) is deleted, every later reconnect is refused with
  `unknown-device`, and any live connection is closed (the PC sends `kick`).
- The phone's lock screen and browser profile protect the stored key: the
  device's private key cannot be copied off as bytes, though page code can use
  it; its psk is stored as data.
- Pairing again needs a fresh QR from the PC screen, so a removed phone cannot
  quietly come back.

### Abuse of the relay

Anyone who knows a room id (it is in the QR and on paired phones) can open up
to `MAX_PHONES` phone sockets in that room and send junk to the PC. The PC
rejects it (no valid handshake) and can `kick` such connections, and the
per-room connection rate and per-socket frame and byte rates bound the load.
Cloudflare's own DDoS protection sits in front. New connections are also
limited per IP address (20 a minute, the `CONNECTS` rate limit binding), and
since 2026-10-10 one address holds at most 32 open sockets over all rooms.
`ALLOWED_ORIGINS` is set to the phone page's own origin, so other websites
cannot use their visitors' browsers against rooms (it adds nothing against a
script outside a browser).

Such a stranger also spends from the room's share of the day (below), but the
usage it causes is charged to its own address first, and an address's share
($0.30) is smaller than a room's ($0.50): one address cannot use up a room's
share on its own. Two or more addresses together can, and then that room is
refused until 00:00 UTC. That is a denial of service on one known room,
which crowding the room already allowed while the stranger stayed connected.

### Cost, with anyone able to use it

The Worker runs on an account with Workers Paid, which has no spend cap, so
the relay guards its own budget. Every room counts the frames it receives
and the time its object stays awake, and about every 1000 frames or minute
awake reports them to one `Budget` object, which prices them at Cloudflare's
overage rates (`PRICES` in `src/lib.js`: $0.15 per million Durable Object
requests with 20 WebSocket messages per request, $12.50 per million GB-s at
128 MB, $0.30 per million Worker requests, $1.00 per million rows written)
for the current UTC day. Past
`DAILY_BUDGET_USD` ($3) rooms close their sockets with code 4503 and new
connections get HTTP 503 until 00:00 UTC; the PC then tries again every 30
minutes. The count ignores the plan's included amounts, so it overcounts.
Expected: one person's heavy day (about 2 hours of replies streaming to a
phone) is about 14k requests and 900 GB-s, inside what the plan includes;
twenty such people would be about $3 a month over it. The worst case is
about $3 a day. The account's budget alert (Cloudflare Notifications)
emails at $10 of monthly spend.

**Budget fairness (2026-10-10).** Before this, one client on one address
could open a few hundred rooms, keep them awake with small frames and use up
the $3 in about three hours, which switched phone access off for everyone
until 00:00 UTC (apaki/SECURITY.md, section 1.7 and hardening item 5). Now:

- **Per address** (an IPv4 address or an IPv6 /64), one small `Gate` object
  counts what that address cost today and how many sockets it holds open. At
  most 32 open sockets over all rooms (HTTP 429), and at most $0.30 a day,
  a tenth of the budget: past it, that address alone is refused until
  00:00 UTC (HTTP 429, account and presence requests `429 share`) and its
  open sockets close with 4504. Every other address goes on.
- **Per room**, the room keeps its own cost for the day: at most $0.50. Past
  it, that room alone is closed (4505) and refused (HTTP 429) until 00:00 UTC.
- **Who pays.** Frames, and the awake time since the room's previous event,
  are charged to the address of the socket that sent them; the idle check is
  charged to the room's PC. Each address's part goes to its own Gate, the
  whole to the room's share and to the `Budget`.
- **Only rooms with their PC are metered.** A phone in a room without its PC
  is closed after a minute, or at once when it sends a frame (4404), so a room
  with no PC cannot be kept awake and costs only its connections. A PC alone
  costs its idle check every `IDLE_MS` (its pings are answered by the
  runtime), which is counted as before, and any frames it sends.
- **Every connection is priced in full**, before it reaches the room: a
  Worker request, four Durable Object requests (the Budget, the address's
  Gate when it opens and again when it closes, the room), four rows written
  and three wakes of the room (when it opens, when it closes, and the room's
  cleanup at 00:00 UTC): about $0.000053, $53 per million. A presence
  question is about $0.000019 (it wakes the room), an account request about
  $0.0000048. A refused attempt is counted too: it cost.
- **The global guard stays** as the last line for everyone together.
- **No request per frame.** Usage waits on each socket's attachment (it
  survives hibernation) and goes out with the room's reports and with each
  socket's close.

What this buys, plainly: one address can now spend at most a tenth of the
day. Ten addresses acting together (ten IPv4 addresses or ten IPv6 /64s, a
few VPN exits) can still use up the $3 and switch the relay off until
00:00 UTC; the global guard still caps the spend at $3 a day. On legitimate
use: a heavy day for one person is about $0.016 (including some fifty
connections), a room awake all day with steady traffic about $0.15, and a
phone left open on "waiting for your PC" while the PC is off reconnects every
minute or so (it is closed after a minute, then waits out its retry delay),
about $0.05 a day. An always-connected PC costs about $0.0023
a day in idle checks, so some 1,300 connected PCs would use the whole $3 on
their own: raise `DAILY_BUDGET_USD` (and the shares) as users grow.

What the relay keeps for this, only for the current UTC day: per address, a
dollar count and a random id per open socket (the Gate is named by the
address key and stores no address and no room id; a minute after 00:00 UTC
it deletes itself if no socket is open); per room, its dollar count (deleted
at 00:00 UTC once the room is empty). Two small wakes are not counted: a
Gate's day-end cleanup (about $16 per million addresses a day) and the
lease renewals from the idle check (one Gate request per address about every
20 minutes per room).

## Accounts

Since 2026-10-10 a person can make an Apaki account with a passkey (no email,
no password) and sign in on any browser to reach their PCs, with the same end
to end encryption as a paired phone. The contract between this server and the
phone page is `apaki/remote/ACCOUNTS.md`; the code is `src/account.js` (routes
and the `Account` Durable Object, one per account), `src/account-lib.js`
(tokens, input checks) and `src/webauthn.js` (WebAuthn, CBOR and COSE with
WebCrypto only, no dependencies). Tests: `tests/accounts.spec.mjs`, with a
software authenticator that makes real ES256, RS256 and EdDSA passkeys.

```
POST   /v1/account/challenge          { purpose: register | signin | add }   (add needs a session)
POST   /v1/account/register           { token, name, credential }            -> { session, account }
POST   /v1/account/signin             { token, credential }                  -> { session, account, vault }
GET    /v1/account                    (session)                              -> { account, vault }
PUT    /v1/account/vault              { ver, vault } (session)               -> { ver }, or 409 stale with the current vault
POST   /v1/account/passkeys           { token, credential } (session)        -> { account }
DELETE /v1/account/passkeys/<credId>  (session)                              -> { account }  (never the last one)
POST   /v1/account/rename             { name } (session)                     -> { account }
POST   /v1/account/signout-all        (session)                              -> { ok: true }
DELETE /v1/account                    (session)                              -> { ok: true }
GET    /v1/rooms/<roomId>/presence                                           -> { pc: true/false }
```

**What the server stores, per account:** the display name (1 to 48
characters), each passkey's public key, algorithm, signature counter, label,
transports and dates (at most 10 passkeys), a session generation number, the
vault blob `{ ver, iv, ct, wraps }` (at most 64 KiB), and the challenges it
accepted until their 5 minutes run out (so none can be used twice).

**What it does not store or see:** anything that opens the vault. The vault
is encrypted on the phone under a key that only the user's passkey can
produce (the WebAuthn PRF extension: the secret never leaves the
authenticator), so the server cannot read the list of PCs, the account's
device key or any PC's secret, and neither can anyone who copies its storage.
It stores no email, phone number, password or IP address. The Worker writes
no logs and platform logs are off; whoever runs the Cloudflare account could
turn logging on, and Cloudflare sees every request as the TLS endpoint.

**Threat model, in plain words:**

- Whoever holds the user's passkey (their iCloud Keychain or Google Password
  Manager, unlocked) can open the account and reach its PCs. That is the
  feature. A PC removes the "Apaki account" device in its Phone sheet to cut
  every account phone off at once; `signout-all` ends every session.
- The relay operator (us, Cloudflare, or someone who takes over the Worker)
  sees that an account exists, its name, how many passkeys it has, when it is
  used and from which IP, and the size of the vault. It cannot sign in as the
  user (it would need a passkey assertion) and cannot open the vault. It could
  refuse service, delete an account, or hand back an older vault; the phone
  does not detect that today (apaki/SECURITY.md, hardening item 6).
- Like the QR flow, a phone that signs in runs the page this site serves, so
  the weak spot is the same as for pairing (see above): a swapped page could
  read the vault on any signed-in phone without a passkey prompt, because the
  vault key is kept on the phone (apaki/web/src/store.js).
- Sessions are bearer tokens (30 days) signed with `ACCOUNT_KEY`; stealing the
  key lets someone mint sessions, which reach the account's metadata and the
  encrypted vault but still not the vault's contents or any PC; it also lets
  someone delete accounts and overwrite vaults. Rotating the key signs
  everyone out.

**How it checks a passkey** (`src/webauthn.js`): the client data type, the
challenge the relay issued, the origin (`ACCOUNT_ORIGIN`, not cross-origin),
SHA-256 of the RP id (the origin's host name), user presence and user
verification flags, the credential id in the attested data, the signature
over `authenticatorData || SHA-256(clientDataJSON)`, and a counter that never
goes back once it is nonzero. Attestation is "none" and not checked. Each
account object runs one request at a time, so a challenge is spent once, a
counter only grows and the vault version is a real compare-and-swap.

**Limits and hardening:** JSON only (415 otherwise), 16 KiB bodies (64 KiB for
the vault, 413 above), an `Origin` header other than `ACCOUNT_ORIGIN` is
refused (403), every answer is `cache-control: no-store`, errors are
`{ error, code }`. Account requests count toward the daily budget (503
`budget`) and the per-IP limit under their own key, `acct:<ip>`, and presence
under `pres:<ip>`, so neither eats the socket budget (429 `rate`). Since
2026-10-10 both also count toward their address's share of the day (429
`share`, see Cost), and an IPv6 client is keyed by its /64.

**Set up:** the token key is a Worker secret, 32 random bytes in base64url:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
cd relay && npx wrangler secret put ACCOUNT_KEY      # paste the line
```

Without it the account routes answer 503 `no-key` (rooms and presence keep
working). `ACCOUNT_ORIGIN` (a var in `wrangler.jsonc`, default
`https://apaki.myrlin.io`) must be the phone page's origin; changing it
orphans every passkey made for the old one. Someone running their own copy
sets it to `https://<your hostname>`.

## Private relay

apaki/SECURITY.md (section 4, hardening item 12) proposes a Private mode:
QR pairing only, no account, and a relay that serves no code and holds no
accounts. The same Worker does that with `RELAY_ONLY` set, deployed as a
second Worker from the `private` environment in `wrangler.jsonc`:

- `RELAY_ONLY=1`: the Worker answers rooms (`/v1/rooms/<id>/pc|phone`),
  presence, and `/` and `/health` as one line. Every `/v1/account` route is
  404 (the code never reaches the account handler). Any value other than
  empty, `0`, `false`, `off` or `no` turns it on.
- No static assets: the environment's assets folder is `private-no-assets/`,
  which uploads nothing (its `.assetsignore` ignores everything). So there is
  no front page, no phone page of any version and no security.txt on that
  hostname; every request reaches the Worker. (Environments inherit `assets`
  and `routes` from the top level, which is why both are set there.)
- Its own Worker (`apaki-relay-private`), so its own rooms, `Budget` (its own
  $3 a day, on top of the public relay's), Gates and per-minute limit
  (namespace 4504). No `ACCOUNTS` binding and no `Account` class migration:
  wrangler warns that `ACCOUNTS` and `ACCOUNT_ORIGIN` are missing there,
  which is the point.
- `ALLOWED_ORIGINS` is `(none)`: phone sockets are accepted only without an
  `Origin` header. Native apps send none and every browser sends one, so no
  web page (the hosted one included) can open sockets there. That fits the
  Private tier: until the native app ships, nothing uses it.
- Not deployed, no hostname yet. Suggested: `private.apaki.myrlin.io`, as a
  custom domain (the commented route in `wrangler.jsonc`).

Then "the private relay serves no code and holds no accounts" is true of that
hostname by construction: there is nothing to serve and no account route.
It still sees the same metadata as any relay (addresses, room ids, timing,
sizes).

## Develop and test

```
cd relay
npm install
npm test          # starts the Worker locally (workerd via wrangler) and runs tests/relay.spec.mjs and tests/accounts.spec.mjs
npm run dev       # wrangler dev on http://127.0.0.1:8787
npm run check     # bundle only (wrangler deploy --dry-run), no upload
npx wrangler deploy --dry-run --env private --outdir .wrangler/dry-run-private   # the same for the Private relay
```

The tests include the budget fairness rules (sockets per address, the shares
per address and per room, phones without a PC, the global guard), the
Private relay (started from the `private` environment) and security.txt. They
pick client addresses by sending `CF-Connecting-IP`, which local workerd
passes through; Cloudflare overwrites it with the real address.

The tests also run a full pairing and a reconnect with `protocol.js` on both
sides of the local relay. They need no Cloudflare account and no network.

## Deploy, release, and run your own

The hosted copy is the `apaki-relay` Worker on `apaki.myrlin.io` (custom
domain, no workers.dev address), deployed 2026-10-10. Its `ABOUT` var says
what it is and that it is safe to delete (paired phones then stop reaching
their PCs until Apaki points at another relay).

Releasing a new phone page: any change to the window's code (apaki/ui), the
phone's parts (apaki/web) or the protocol makes a new version, and a PC on
that Apaki refuses to pair until the site has it.

```
node apaki/scripts/build-web.mjs --release      # adds relay/site/v/<version>/ (commit it)
cd relay && npx wrangler deploy --env=""        # uploads only the new files
```

`--env=""` picks the top-level configuration (the public relay) explicitly:
since `wrangler.jsonc` has a `private` environment, a plain
`npx wrangler deploy` still deploys the public relay but warns. The first
deploy after 2026-10-10 also applies migration v4 (the `Gate` class).

The Private relay, once it has a hostname (uncomment its route first):

```
cd relay && npx wrangler deploy --env private   # Worker apaki-relay-private: relay only, no assets, no accounts
```

`package-apaki.ps1` warns when the build it packages has no published page.

Running your own (anyone, on any Cloudflare account):

```
cd relay
# wrangler.jsonc: set "routes" to your hostname and ALLOWED_ORIGINS to https://<your hostname>
node ../apaki/scripts/build-web.mjs --release --relay wss://<your hostname>
npx wrangler deploy --env=""
# a relay without pages or accounts instead: set the route in env "private" and npx wrangler deploy --env private
# then start Apaki with APAKI_RELAY_URL=wss://<your hostname> and APAKI_WEB_URL=https://<your hostname>/
```

The Workers free plan is enough for a few people (SQLite-backed Durable
Objects are on it), and there it cannot bill at all: past the free limits
requests fail instead.
