# Apaki accounts, version 1 (2026-10-10)

Arthur: "if a user has a login with us they can login to their account to see
connections and just connect that way". An Apaki account lets a phone (or any
browser) that was never paired sign in with a passkey, see the user's PCs and
connect to them, with the same end to end encryption as a paired phone
(PROTOCOL.md). Choices (2026-10-10): passkey only, no email or password; a
new phone connects at once, and the server cannot.

## Trust

- The server (the relay Worker on apaki.myrlin.io) stores, per account: a
  display name, the passkeys' public keys, and one opaque vault blob. It never
  sees a key that opens the vault, the list of PCs, or any PC's secrets.
- The vault is encrypted with a key that only the user's passkey can produce
  (the WebAuthn PRF extension; the PRF secret never leaves the authenticator).
  So the server, the relay, or anyone who steals the database cannot connect
  to a PC or even learn which PCs an account has.
- The vault holds an "account device": an ECDSA P-256 device identity plus,
  per PC, a device record that PC accepted. It connects with the normal
  reconnect handshake (PROTOCOL.md, Reconnect); the PC sees it as one paired
  device named "Apaki account (<name>)" and can remove it like any phone.
- What an account adds to the attack surface: whoever holds the user's
  passkey (their iCloud Keychain or Google Password Manager) can reach the
  account's PCs. That is the point of the feature; removing the account
  device on a PC cuts every account phone off from that PC at once.
- Like the QR flow, the phone runs the page apaki.myrlin.io serves. The PC
  checks that page before it shows a QR (remote-page.js); a phone that signs
  in trusts the page it loaded, as a phone opening a QR link does.

## Server: routes

All JSON. POST bodies need `content-type: application/json`; a request with an
`Origin` header other than ACCOUNT_ORIGIN is refused (403). Errors are
`{ error, code }` with a 4xx/5xx status. Authenticated routes take
`Authorization: Bearer <session>`.

| Route | Body | Answer |
|---|---|---|
| `POST /v1/account/challenge` | `{ purpose: 'register' \| 'signin' \| 'add' }` (add needs a session) | `{ challenge, token, rpId, rpName, accountId? (register), exclude? (add: credential ids) }` |
| `POST /v1/account/register` | `{ token, name, credential: { id, clientDataJSON, attestationObject, transports? } }` | `{ session, account }` |
| `POST /v1/account/signin` | `{ token, credential: { id, clientDataJSON, authenticatorData, signature, userHandle } }` | `{ session, account, vault }` |
| `GET /v1/account` | (session) | `{ account, vault }` |
| `PUT /v1/account/vault` | `{ ver, vault: { iv, ct, wraps: { <credId>: { iv, ct } } } }` (session) | `{ ver }`, or 409 `{ code: 'stale', ver, vault }` |
| `POST /v1/account/passkeys` | `{ token (purpose add), credential (as register) }` (session) | `{ account }` |
| `DELETE /v1/account/passkeys/<credId>` | (session) | `{ account }`; the last passkey cannot be removed; its wrap leaves the vault |
| `POST /v1/account/rename` | `{ name }` (session) | `{ account }` |
| `POST /v1/account/signout-all` | (session) | `{ ok: true }`: every session of the account stops working |
| `DELETE /v1/account` | (session) | `{ ok: true }`: everything the server holds for the account is deleted |
| `GET /v1/rooms/<roomId>/presence` | | `{ pc: boolean }`: whether that room's PC is connected to the relay now |

Binary values (challenge, ids, WebAuthn buffers, vault fields) are base64url
without padding. `account` is `{ id, name, created, ver, passkeys: [{ id, label,
created, lastUsed, transports }] }`. `vault` is `null` or `{ ver, iv, ct, wraps }`.
Limits: name 1 to 48 characters, vault body at most 64 KiB, at most 10 passkeys.

Tokens are `base64url(JSON) "." base64url(HMAC-SHA-256(ACCOUNT_KEY, "apaki/v1 account token" ‖ that first part))`:

- challenge token `{ k: 'c', p: purpose, c: challenge, a?: accountId, exp }`, 5 minutes;
- session `{ k: 's', a: accountId, g: generation, exp }`, 30 days; valid while the account's generation is `g`.

Each challenge is used once (the account object remembers spent challenges
until they expire). ACCOUNT_KEY is a Worker secret (32 random bytes,
base64url); without it the account routes answer 503 `no-key`.
ACCOUNT_ORIGIN (default `https://apaki.myrlin.io`) is the only origin
accepted in clientDataJSON; the RP id is its host name.

WebAuthn checks: clientDataJSON `type` (`webauthn.create` / `webauthn.get`),
`challenge` equal to the token's, `origin` equal to ACCOUNT_ORIGIN, not
`crossOrigin`; authenticator data RP id hash = SHA-256(rpId), flags UP and UV
set (AT on create); the credential id in the attested data equals
`credential.id`. Attestation is requested as `none` and not checked. Keys:
ES256 (COSE alg -7), RS256 (-257), EdDSA (-8). Assertions are verified over
`authenticatorData ‖ SHA-256(clientDataJSON)` (ES256 signatures arrive DER
encoded). A signature counter that is nonzero must grow. The userHandle names
the account (it is the 16-byte account id, the WebAuthn user.id).

Every account route counts toward the relay's daily budget and the per-IP
CONNECTS limit, like a new relay connection.

## Client: the vault

```
salt   = SHA-256("apaki/v1 vault prf")              PRF eval.first on every create/get
KEK    = HKDF(prfOutput, accountIdBytes, "apaki/v1 vault kek", 32)        per passkey
VK     = 32 random bytes                                                  per account
wraps[credId] = { iv, ct: AES-256-GCM(KEK, iv, aad = "apaki/v1 vault wrap" ‖ credIdBytes, VK) }
vault  = { iv, ct: AES-256-GCM(VK, iv, aad = "apaki/v1 vault" ‖ accountIdBytes, JSON) }
JSON   = { v: 1, name, device: exportIdentity(accountDevice), pcs: [{ roomId, relay, pcPub, pcName, deviceId, psk, addedAt }] }
```

A signed-in phone keeps, in IndexedDB: the account id and name, the session,
VK as a non-extractable AES key, the vault version, and the account device
as non-extractable CryptoKeys. It can then add PCs without another passkey
prompt and connects without the server. On start it fetches the vault and
merges PCs other phones added. A PC this phone paired itself keeps its own
pairing (its own device id) and is not replaced by the account's.

Adding a passkey: unlock VK with a current passkey, create the new one, read
the new one's PRF output with a get, wrap VK for it. A passkey whose
authenticator has no PRF cannot unlock the vault; the page says so (iOS 18,
Android Chrome and current desktop browsers have it).

## PC: linking an account

Over an open channel (PROTOCOL.md), any paired device may link the account:

```
phone -> PC   { t: 'account-link', reqId, pub, name }      pub: the account device's public key
PC -> phone   { t: 'account-linked', reqId, deviceId, psk, pcName }   or { ..., error }
phone -> PC   { t: 'account-unlink', reqId, deviceId }     removes that account device (only kind 'account')
phone -> PC   { t: 'via', name }                           which phone is behind the connection (shown on the PC)
```

The PC adds a device `{ id: deviceIdFor(pub), pub, name: 'Apaki account (<name>)', kind: 'account' }`
with a fresh random psk, shows it in its Phone sheet (who linked it, and
which phone each account connection comes from), and can remove it. A PC at
most keeps 8 account devices. An older Apaki ignores these messages; the
phone then says the PC needs an update.
