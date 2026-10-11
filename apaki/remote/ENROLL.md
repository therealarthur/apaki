# Apaki phone enrollment and phone keys, version 2 (2026-10-11)

Arthur, 2026-10-11: "its not intuitive at all with how to connect the phone and
keep it connected - when a user clicks sign in with phone it should use the
phones passkey to see what desktops are connected to that phone and then when
chosen the phone establishes a secure connection over relay. scanning the
desktop phone pariing code should add that phone as a passkey as well". He
approved this design the same day ("ok sounds good - do it"), with new phones
following each PC's mode.

This extends ACCOUNTS.md (version 1) and PROTOCOL.md. Nothing in version 1
goes away; an older page or PC keeps working as before.

## What the user sees

1. First phone, at the PC: the PC shows its QR code. The phone scans it, both
   show the same code, the person clicks Allow on the PC (as today). Then the
   phone offers "Next time, sign in with Face ID": one tap creates the Apaki
   passkey (or signs in with an existing one) and this PC is added to the
   account at once, with no second Allow on the PC. A phone that is already
   signed in skips the question: the PC is added by itself.
2. Every later time, on any phone with that passkey: open the site or the app,
   sign in with Face ID, see the PCs with online/offline, tap one, connected.
   With one PC online and nothing else to choose, it connects by itself.
3. A phone the PC has not seen before (a new iPhone with the synced passkey):
   - Connected PC (the default): it connects; the PC shows "New phone
     connected: <name>" with Block.
   - Private PC: it waits; the PC shows "<name> wants to connect" with Allow
     and Block. A phone scanned in person, or allowed by a click, is never
     asked again.
4. The PC's Phone sheet lists, under each account, the phones that used it
   (name, first and last seen, state) with Block, Allow and Forget.

## Words

- account device: the ECDSA key in the account's vault (ACCOUNTS.md). One per
  account; every phone signed in to the account connects to a PC as it.
- phone key: a new ECDSA P-256 key pair made once per phone (per browser
  profile, per app install). Its private half is non-extractable and never
  leaves the phone: not in the vault, not to the server. It tells phones of
  one account apart, so the PC can apply its rule per phone.
- phoneId: deviceIdFor(raw phone public key), the same id function as devices.

## Protocol additions

All inside the encrypted channel (PROTOCOL.md). Binary values base64url, no
padding. Signatures are ECDSA P-256 with SHA-256 in raw r||s form (64 bytes),
which is what WebCrypto produces and verifies.

### hello

The PC adds to every hello:

- `nonce`: 16 random bytes, new for each connection.
- features: `'phone-key'` (it checks phone keys on account connections) and
  `'enroll'` (it accepts account-link with enroll, below). Both in Private and
  Connected.

### via, version 2 (phone -> PC, on account connections)

```
{ t: 'via', name, pub, sig }
pub = raw 65-byte phone public key
sig = sign(phoneKey, UTF8("apaki/v1 via") || nonce || pub || UTF8(name))
```

Sent right after a hello with `asAccount: true` and the `phone-key` feature.
The name is the phone's display name (deviceName on the page), at most 64
characters. Version 1 `{ t: 'via', name }` (no pub) still works where noted.

### The PC's answer on an account connection

Until a valid version 2 via arrives, an account connection is held: the PC
sends hello and nothing else (no ready event, no cached events) and answers
no op. Then, by the phone's record under that account device:

| Record | Connected | Private |
|---|---|---|
| blocked | encrypted close, reason BLOCKED | same |
| enrolled or allowed | `{ t: 'phone-ok' }`, then ready + cache | same |
| auto | `{ t: 'phone-ok' }`, ... | held: ask (as unknown) |
| none (new) | add as auto, `{ t: 'phone-ok' }`, notice on the PC | add as pending, `{ t: 'phone-wait', timeoutMs }`, Allow/Block card on the PC |

- Allow on the card: state allowed, `{ t: 'phone-ok' }`, ready + cache.
- Block: state blocked, encrypted close with reason BLOCKED.
- Nobody answers within LINK_APPROVAL_MS: encrypted close "Nobody allowed this
  phone on <PC> in time."; the pending record is dropped, so the next try asks
  again.
- A bad signature, a pub that is not a P-256 point, or a second via with a
  different pub on the same connection: close with an error, nothing stored.
- No version 2 via within VIA_GRACE_MS (8 s) of hello: an older page. Connected
  lets it in as before (version 1 via names it; shown as "older page"); Private
  closes it with "Update the page: this PC asks about each phone."
- At most 20 phone records per account device; past that, the oldest record
  that is not blocked is dropped.

BLOCKED (close reason text): "This phone was blocked on <PC>. Ask the person
at the PC to allow it in its Phone sheet."

### Enrollment: account-link with enroll (phone -> PC)

```
{ t: 'account-link', reqId, pub, name, wait: true, enroll: true, phone: { pub, sig } }
phone.sig = sign(phoneKey, UTF8("apaki/v1 enroll") || nonce || phone.pub || accountPub)
```

The PC adds the account device at once (no card, in both modes) when all hold:

- the connection is a direct pairing (its device kind is not 'account');
- that device was paired at most ENROLL_WINDOW_MS (15 minutes) ago, in person,
  through Allow on this PC;
- `enroll: true`, and phone.sig verifies against phone.pub with this
  connection's nonce.

The account device gets the pairing phone's access (cap) and lifetime; the
pairing phone's key is recorded under it as enrolled. The answer is
`{ t: 'account-linked', reqId, deviceId, psk, pcName }` as in ACCOUNTS.md.
Outside those conditions account-link behaves as version 1: Connected holds it
for Allow; Private refuses it (in Private an account is only added in person,
right after a scan).

## Private mode, as of version 2

Version 1 Private refused account connections entirely. Version 2 Private
lets an account device connect, but every phone behind it needs an in-person
OK on this PC: scanned there (enrolled) or allowed with a click. Phones that
Connected let in by themselves (auto) are asked again after a switch to
Private. Switching to Private still offers to remove account devices
(remoteMode removeAccounts).

## PC: state and window ops

Each account device record (remote-store, state.json) gains
`phones: [{ id, pub, name, state, firstSeen, lastSeen }]`,
state one of enrolled, allowed, auto, pending, blocked. Merged across two
engines like devices (syncFromDisk): by id; a blocked record wins; otherwise
the newer lastSeen.

Window ops (engine -> remote.js):

- `remotePhoneDecision { accountDeviceId, phoneId, action }`, action allow,
  block or forget (forget drops the record; that phone is new again next time).
- `remoteNoticeDismiss { id }`.

Status (pushStatus) adds, per account device, `phones` (as above, plus
`online`), and at the top level `phoneRequest` (the pending Private card:
accountDeviceId, phoneId, name, account, exp) and `notices` (newest first, at
most 5: `{ id, kind: 'new-phone', accountDeviceId, phoneId, name, account, at }`).

## Phone: what the page does

- Makes its phone key once (non-extractable; IndexedDB on the web, the
  native store in the app) and keeps it.
- On every account connection: sends version 2 via. On `phone-wait` shows
  "Allow this phone on <PC>" until `phone-ok` or a close. On a BLOCKED close
  shows it and stops reconnecting to that PC through the account.
- After a pairing completes and hello arrives with the `enroll` feature:
  signed in already: sends account-link with enroll at once (quiet; a toast
  says the PC was added). Not signed in: offers "Next time, sign in with Face
  ID" (create the passkey) and "I already have an Apaki passkey" (sign in),
  then sends account-link with enroll. "Not now" is remembered per PC.
- Home, signed in: the account's PCs with online/offline (presence route);
  one online PC and no other choice: connects by itself, unless the person
  just disconnected.

## Not in version 2

Link from an old phone (Signal style) for passkeys that do not sync; push
notifications for questions; the desktop app signing in to the account.
