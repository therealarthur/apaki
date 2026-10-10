# Apaki remote protocol, version 1

How a phone pairs with Myrlin Apaki on a PC and then talks to it through an
untrusted relay. Implementation: `protocol.js` in this folder (isomorphic ESM,
WebCrypto only, no dependencies; runs in Node 20+ and mobile Safari/Chrome).
Tests: `test/apaki-remote-protocol.test.js` (in memory) and
`relay/tests/relay.spec.mjs` (through a local relay). The relay itself and the
threat model are in `relay/README.md`.

## Goals

- "Scan this QR code" connects a phone to the Apaki on your PC. No accounts:
  the pairing is the identity.
- The PC does all the work with its own Claude and Codex logins. The relay
  never sees credentials or content and holds no keys. The website serves the
  phone page, so this holds for the site only while it serves the published
  page (apaki/SECURITY.md, section 1.3).
- A phone without the QR cannot pair. A relay, a network attacker, or someone
  who only knows the room id cannot read, change, replay or reorder anything.
- Forward secrecy: every connection uses fresh ephemeral keys.
- The PC can drop a phone; that phone can no longer connect.

## Parties and long-lived secrets

| Item | Who holds it | What it is |
|---|---|---|
| PC identity | PC (on disk, private) | ECDSA P-256 key pair. `createPcIdentity`, saved with `exportIdentity` |
| Room token | PC only (on disk, private) | 256 random bits, base64url (43 chars). Never in the QR |
| Room id | PC, paired phones, relay | First 16 bytes of `SHA-256("apaki/v1 room" ‖ token)`, base64url (22 chars) |
| Device identity | phone (IndexedDB) | ECDSA P-256 key pair, **non-extractable**; IndexedDB stores the CryptoKey objects by structured clone |
| Device id | both | First 16 bytes of `SHA-256("apaki/v1 device id" ‖ devicePub)`, base64url |
| Device psk | both (private) | 32 bytes from the pairing key schedule; mixed into every reconnect |
| Pairing secret | the QR only | 128 random bits, one use, about 2 minutes |

All public keys travel as uncompressed P-256 points (65 bytes). Signatures are
ECDSA P-256 / SHA-256 in IEEE P1363 form (64 bytes, what WebCrypto produces).
HKDF is HKDF-SHA-256 with `HKDF(ikm, salt, info, length)`. Every hash, MAC,
signature and key has its own label (`apaki/v1 ...`).

Because the room id is a hash of the token, the relay can check that a socket
claiming the PC side holds the token without storing anything, and nobody
can squat a room. Phones learn only the room id.

## The QR

The QR encodes a URL: `https://apaki.myrlin.io/v/<version>/#p=<payload>`,
where `<version>` is the phone page this PC built and checked on the site
(`apaki/engine/remote-page.js`; see relay/README.md). The payload is in the
**fragment**, which browsers never send to any server. The web client
reads it, then calls `history.replaceState` so the secret leaves the address
bar and history.

Payload (binary, base64url):

```
v(1) = 1
exp(4, u32 BE, unix seconds)
roomId(16)
secret(16)
pcPub(65)
relayLen(1) relay(utf8)    wss://... (ws:// only for loopback)
nameLen(1)  name(utf8)     the PC's name, at most 64 bytes
```

About 220 characters for a typical relay URL and PC name.

## Pairing (3 frames plus the PC's acceptance)

```
phone                                           PC
 ePhone, nPhone fresh
 commit = SHA-256("apaki/v1 pair commit" ‖ nPhone ‖ ePhone)
 PAIR1 = 01 ‖ ePhone ‖ commit ‖ HMAC(Kmac, 01 ‖ ePhone ‖ commit)  ──►
                                                 checks: an offer is active, not expired,
                                                 not used, MAC valid; then marks it used
                                                 ePc, nPc fresh
                                    ◄──  PAIR2 = 02 ‖ ePc ‖ nPc ‖ AEAD(khPc, sigPc)
 verifies sigPc with the pcPub from the QR
 PAIR3 = 03 ‖ AEAD(khPhone, nPhone ‖ devPub ‖ sigPhone ‖ nameLen ‖ name)  ──►
                                                 checks the commitment and sigPhone
 both show SAS                                   both show SAS; the PC user approves
                                    ◄──  RECORD(CONTROL { t: 'paired', deviceId, pcName })
 saves the pairing record                        saves the device record
```

Key schedule:

```
Kmac   = HKDF(secret, roomIdBytes, "apaki/v1 pair mac", 32)
pskQr  = HKDF(secret, roomIdBytes, "apaki/v1 pair psk", 32)
dh     = ECDH(ePc, ePhone)
th2    = SHA-256("apaki/v1 pair transcript" ‖ roomIdBytes ‖ pcPub ‖ PAIR1 ‖ ePc ‖ nPc)
ikm    = dh ‖ pskQr
khPc   = HKDF(ikm, th2, "apaki/v1 pair hs pc", 32)
khPhone= HKDF(ikm, th2, "apaki/v1 pair hs phone", 32)
sigPc  = Sign_pcIdentity("apaki/v1 pair pc sig" ‖ th2)
th3    = SHA-256(th2 ‖ PAIR2 ‖ nPhone ‖ devPub ‖ name)
sigPhone = Sign_device("apaki/v1 pair phone sig" ‖ th3)
SAS    = u32BE(HKDF(nPhone, th2, "apaki/v1 pair sas", 4)) mod 1 000 000, 6 digits
thF    = SHA-256(th3 ‖ sigPhone)
traffic keys = HKDF(ikm, thF, "apaki/v1 pair traffic {pc key|pc iv|phone key|phone iv|session id}")
devicePsk    = HKDF(ikm, thF, "apaki/v1 device psk", 32)
```

The handshake AEAD is AES-256-GCM with a zero IV; each handshake key encrypts
exactly one message. The AAD is the frame's cleartext header.

Why each piece is there:

- **MAC under the QR secret** (PAIR1): a phone without the QR cannot even start.
  A failed guess does not burn the QR; a valid one does, at once, so a QR pairs
  exactly one phone (two racing phones: one wins, the other gets `used`).
- **pskQr in the key schedule**: the secret was never on the network, so
  recorded pairing traffic stays safe even if ECDH were broken later.
- **PC signature over th2, with pcPub from the QR**: nobody can pose as the PC,
  not even someone who photographed the QR. pcPub is also in th2, so a wrong
  key fails to decrypt PAIR2.
- **Device signature over th3**: proves the phone holds the device key it registers.
- **SAS with a commitment**: the phone commits to nPhone before it sees the PC's
  values, so an attacker who learned the QR cannot steer the code. If such an
  attacker wins the race, the PC shows a code while the owner's phone shows
  "already used", and the owner rejects.
- **Approval**: the PC stores nothing and sends no data until its user approves
  (within 3 minutes). Rejecting sends an alert and forgets the device.

## Reconnect (3 frames)

```
phone                                            PC
 HELLO1 = 11 ‖ deviceId ‖ ePhone ‖ nPhone ‖ HMAC(Khello, 11 ‖ deviceId ‖ ePhone ‖ nPhone)  ──►
                                                  looks the device up (unknown or removed: alert unknown-device)
                                     ◄──  HELLO2 = 12 ‖ ePc ‖ nPc ‖ AEAD(khPc, sigPc)
 HELLO3 = 13 ‖ AEAD(khPhone, sigPhone)  ──►
                                                  verifies sigPhone with the stored devPub,
                                                  checks the device is still paired
```

```
Khello = HKDF(devicePsk, roomIdBytes, "apaki/v1 hello mac", 32)
th2    = SHA-256("apaki/v1 hello transcript" ‖ roomIdBytes ‖ pcPub ‖ devPub ‖ HELLO1 ‖ ePc ‖ nPc)
ikm    = ECDH(ePc, ePhone) ‖ devicePsk
khPc / khPhone = HKDF(ikm, th2, "apaki/v1 hello hs pc" / "... phone", 32)
sigPc  = Sign_pcIdentity("apaki/v1 hello pc sig" ‖ th2)
th3    = SHA-256(th2 ‖ HELLO2)
sigPhone = Sign_device("apaki/v1 hello phone sig" ‖ th3)
traffic keys = HKDF(ikm, SHA-256(th3 ‖ sigPhone), "apaki/v1 hello traffic {...}")
```

Mutual authentication with both static keys, plus the device psk, over fresh
ephemerals (forward secrecy). A replayed HELLO1 gets an answer but cannot be
completed without the device key; an old HELLO3 does not decrypt under the new
keys. The phone may send records right after HELLO3; if the PC refuses
HELLO3 it answers with an alert instead of data.

## Records

```
RECORD = 20 ‖ AES-256-GCM(key_dir, nonce_dir(counter), aad = 20, plaintext)
nonce_dir(n) = iv_dir XOR n (u32 BE in the last 4 bytes), TLS 1.3 style
plaintext = type(1) ‖ body
  01 JSON     body = UTF-8 JSON, at most 131 071 bytes
  02 CHUNK    body = stream(u32) ‖ seq(u32) ‖ flags(1, bit 0 = last) ‖ data (at most 131 062 bytes)
  03 CONTROL  body = UTF-8 JSON: { t: 'paired', deviceId, pcName } or { t: 'close', reason }
```

One key and one IV per direction; counters are implicit and strict, so a
replayed, dropped or reordered record fails to decrypt and the session closes.
Limits: record plaintext 128 KiB, frame on the wire 128 KiB + 17 bytes,
handshake frames 512 bytes, 2^31 - 1 records per direction (then reconnect).
Chunks carry artifact files: split a file into chunks of one stream id with
increasing seq, mark the last one.

## Alerts

`ALERT = 7f ‖ code(1)`: `bad-frame, version, expired, used, no-offer, bad-mac,
unknown-device, bad-signature, rejected, timeout, closed, bad-record,
bad-commit, internal`. Alerts are plaintext and unauthenticated: a hint for
the UI (for example "this phone was removed, scan a new code"), never trusted
for anything else. A relay could inject one, which is only a denial of
service (it could drop frames anyway).

## Over the relay

```
wss://<relay>/v1/rooms/<roomId>/pc      subprotocols: apaki.v1, apaki-token.<token>
wss://<relay>/v1/rooms/<roomId>/phone   subprotocols: apaki.v1
```

`roomUrl(relay, roomId, role)` and `relaySubprotocols(role, token)` build these.
Set `binaryType = 'arraybuffer'`. Binary frames on a phone socket are protocol
frames as they are. On the PC socket each binary frame starts with the phone's
connection id (u32 BE): `encodePcFrame(conn, frame)` / `decodePcFrame(bytes)`.
The PC runs one `PcSession` per connection id. Text frames are relay control
messages, read with `parseRelayControl` (see its comment for the list). Send
`ping` right after open and at least every 30 s; treat `{ t: 'bye' }` as the
close. On `{ t: 'pc', up: true }` a phone starts a new handshake.

## Revocation

The PC deletes the device record, so `getDevice(id)` returns null and every
later HELLO1 gets `unknown-device` (a device removed during a reconnect is
refused at HELLO3). The PC also closes any open `PcSession` whose
`device.id` is that id and sends `{ t: 'kick', conn }` to the relay for its
connection. The device psk and public key are gone from the PC, so the phone
cannot come back without scanning a new QR.

Pairing lifetimes and staying paired (2026-10-10): a device record may
carry `expiresAt` (ISO time; absent means never). The PC user picks it at
Allow (forever by default, or 1, 7 or 30 days) and may change it later. When
it passes, the PC removes the device exactly as above, and an open channel
gets the encrypted close `"This phone's pairing expired, so it was removed
on the PC."` (an older phone page matches "removed"; a newer one matches
"expired" first). The phone learns its expiry inside the channel: `hello`
carries `expiresAt` (null: never) and `{ t: 'lifetime', expiresAt }` follows
a change. Because `unknown-device` is a plaintext alert, a phone keeps its
saved pairing when it gets one and tries again slowly; it treats it as final
only once its own `expiresAt` has passed. Only an encrypted close, or the
person, makes a phone forget a PC.

## Saved state

PC (keep private, for example next to Apaki's other settings):

```
{ identity: exportIdentity(pcIdentity),          // { v, kind: 'apaki-identity', pub, jwk }
  room: { roomId, token },
  relay: 'wss://...',
  devices: [ { id, pub, psk, name, pairedAt } ] } // from the 'paired' event
```

Phone (IndexedDB): the device identity `{ privateKey, publicKey, pub }` as
CryptoKey objects, and the pairing record
`{ v, roomId, relay, pcPub, pcName, deviceId, psk, pairedAt }`.

## Inside the channel (wire.js, since part 2)

The records carry JSON messages that make the phone a remote window of the
engine (`apaki/engine/remote.js` on the PC, `apaki/web/src/link.js` on the
phone; both use `wire.js`):

```
phone -> PC   { t: 'cmd', cmd }               one engine command, the same shape the desktop window sends
PC -> phone   { t: 'hello', v, pcName, ops }  right after the channel opens; ops = what this phone may send
                                              (since 2026-10-10 also features, expiresAt; asAccount for an account device)
              { t: 'lifetime', expiresAt }    the PC user changed how long this phone stays paired (null: forever)
              { t: 'evs', list }              engine events, batched (25 ms or 64 KiB, whichever comes first)
either way    { t: 'big', stream, bytes }     a message larger than one record, then CHUNK records of
                                              that stream (seq 0, 1, ...; the last one flagged)
```

What a phone may send is an allowlist in `apaki/engine/remote-policy.js`
(sessions, search, open, attach, send, interrupt, answer, model, effort,
mode, commands, close, and artifactGet where the engine has it). Pane and
request ids get the phone's prefix (`phone:<deviceId>:...`), so a phone only
ever acts on its own panes, and only events about them (plus the folder,
Glass and index broadcasts) go back to it. A phone that reconnects sends
`attach` for each pane it had open: same pane, same Claude Code process, its
history sent again.

## Known limits

- The relay sees the device id in HELLO1 (it already sees connections, IPs,
  timing and sizes; see `relay/README.md`).
- Whoever controls the website could ship code that leaks a phone's psk and
  messages. The PC checks, file by file, that the site serves exactly the
  page it builds itself before it shows a pairing code; what that cannot
  catch (a site singling out one phone) is in `relay/README.md`.
- A stolen, unlocked phone with the web client open is a paired device until
  the PC removes it.
