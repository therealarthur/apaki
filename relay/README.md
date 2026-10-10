# apaki-relay

The relay that lets a phone reach Myrlin Apaki on a PC from anywhere. It is a
Cloudflare Worker plus one Durable Object per room, and it only forwards
opaque, end-to-end encrypted frames between the PC socket and the phone
sockets of a room. It holds no keys, parses no payloads and stores nothing.

The crypto lives on the two ends: `apaki/remote/protocol.js`, documented in
`apaki/remote/PROTOCOL.md`.

**Not deployed yet.** Deploying is a separate, explicit step (see the end).

## Endpoints

```
GET /                          one line saying what this is
GET /v1/rooms/<roomId>/pc      WebSocket for the PC; subprotocols "apaki.v1" and "apaki-token.<token>"
GET /v1/rooms/<roomId>/phone   WebSocket for a phone; subprotocol "apaki.v1"
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

Rate counters live in memory and reset when a room hibernates, which only
happens when it is quiet anyway.

## Cost

- WebSocket Hibernation API: while a room is idle the Durable Object is
  evicted from memory; pings are answered by the runtime and do not wake it.
- One alarm per room every `IDLE_MS` while it has sockets (the idle check);
  rooms with nobody connected cost nothing.
- The DO class is SQLite backed (`new_sqlite_classes` in the migration), which
  is what the Workers free plan supports. It stores nothing but its alarm.

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

**What it can do:** refuse service. It can drop or delay frames, close
sockets, or inject the plaintext alerts and control messages, and the
clients will see failures. That is all.

### The weak spot: the website supplies the code

The phone runs whatever JavaScript the web client's site serves. Whoever
controls that site (or its hosting, or its DNS) could serve a version that
sends the phone's device secret and decrypted messages somewhere else. That
is the limit of any web app that does end-to-end encryption. Mitigations
(the first three are for the web client, which is not built yet):

- **Versioned, immutable bundles with published hashes.** Serve each release
  of the web client from a path that never changes (for example
  `/v/<version>/`) and publish its SHA-256 in the repo and in the Apaki app.
  Apaki can show the expected hash next to the QR, and the client can load its
  modules with Subresource Integrity.
- **Installable PWA.** Once installed, the phone keeps the version it
  installed; a changed bundle is a visible update, not a silent swap.
- **Open source.** With the client, the protocol and this relay published,
  anyone can build the bundle and compare hashes. The repository
  (therealarthur/claude-latch) is private today, so this one applies only once
  it is published.
- **Least power on the phone** (in place): the device key is non-extractable
  (WebCrypto keeps it out of reach of page scripts; IndexedDB stores the key
  object, not the bytes), and the PC decides what a phone may do.

### Stolen or lost phone

A paired phone is a key to the PC's Apaki: whoever holds it unlocked, with
the web client's storage intact, can connect. Defences:

- **Revocation:** remove the phone in Apaki on the PC. Its record (public key
  and secret) is deleted, every later reconnect is refused with
  `unknown-device`, and any live connection is closed (the PC sends `kick`).
- The phone's lock screen and browser profile protect the stored key; it
  cannot be copied off the phone as bytes.
- Pairing again needs a fresh QR from the PC screen, so a removed phone cannot
  quietly come back.

### Abuse of the relay

Anyone who knows a room id (it is in the QR and on paired phones) can open up
to `MAX_PHONES` phone sockets in that room and send junk to the PC. The PC
rejects it (no valid handshake) and can `kick` such connections, and the
per-room connection rate and per-socket frame and byte rates bound the load.
Cloudflare's own DDoS protection sits in front. `ALLOWED_ORIGINS` can limit
phone sockets to the web client's origin (this does not add security against
a script outside a browser, it only stops other websites from using visitors'
browsers).

## Develop and test

```
cd relay
npm install
npm test          # starts the Worker locally (workerd via wrangler) twice and runs tests/relay.spec.mjs
npm run dev       # wrangler dev on http://127.0.0.1:8787
npm run check     # bundle only (wrangler deploy --dry-run), no upload
```

The tests also run a full pairing and a reconnect with `protocol.js` on both
sides of the local relay. They need no Cloudflare account and no network.

## Deploy (later, on request)

The Workers free plan is enough. `wrangler deploy` from this folder creates
the `apaki-relay` Worker with its Durable Object; a custom domain (for example
`relay.apaki.myrlin.io`, see the commented `routes` in `wrangler.jsonc`)
keeps the URL stable. The `ABOUT` var says what the Worker is and that it is
safe to delete. Nothing has been deployed by this change.
