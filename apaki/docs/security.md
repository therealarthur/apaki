# Apaki's security, in plain words

Written 2026-10-12 by Claude Code (Opus 5.5) for Arthur, from [SECURITY.md](../SECURITY.md) (the full review, with file and line references), [remote/PROTOCOL.md](../remote/PROTOCOL.md), [remote/ACCOUNTS.md](../remote/ACCOUNTS.md) and [remote/ENROLL.md](../remote/ENROLL.md). Where this page and those disagree, they are right.

## What stays on your PC

Apaki is a desktop app. Your sessions, your Claude and Codex logins, the search index and the embedding model behind it all stay on your PC. Claude Code talks to Anthropic as it always does; Apaki does not change that path. Phone access is off until you turn it on, and until then Apaki makes no connection to our relay or our site.

## Phone access

When you turn phone access on, your PC opens one outgoing connection to the relay. It never accepts an incoming one. Your phone connects to the same relay, and the two ends talk through it with end to end encryption: a P-256 key exchange, AES-256-GCM, and fresh keys for every connection.

Pairing takes a QR code and a six digit code. The QR carries a one-time secret in the part of the link after `#`, which browsers never send to a server. Your phone and your PC both show a six digit code; you compare them and click Allow on the PC. Nothing is saved until you do.

### What the relay cannot do

- Read your prompts, replies, files or session list.
- Change, replay or reorder a frame. Any of those makes the connection fail.
- Pair a phone, pose as your PC or your phone, or open a connection to your PC.
- Get your Claude or Codex logins. They never leave the PC.

### What the relay can see

- IP addresses, when your PC and phones connect and leave, and how much data moves, and when.
- With an Apaki account: the account's name, its passkeys' public keys, and one encrypted vault it cannot open.

The relay code keeps no logs, and platform logging is off in its configuration. That is a setting, not a guarantee: whoever holds the Cloudflare account could turn logging on, and Cloudflare sees every request as the TLS endpoint. You have to take that part on trust, or run your own relay ([self-hosting.md](self-hosting.md)).

## Where the trust sits: the phone page

On a phone browser, the Apaki client is a web page that `apaki.myrlin.io` serves, like any web app. A changed page could do whatever a paired phone can do. Apaki narrows that in three ways:

- **Your PC checks the page.** Before it shows a pairing code, Apaki builds the phone page from its own code and compares every file with what the site serves. If a file differs, it shows no code. If the site cannot be reached, it shows none either, unless you choose "Pair without checking the page", which says what it risks. While phone access is on, it fetches the pages it checked again every hour, the way a phone browser asks for them, and turns phone access off if a file changed.
- **Every version has its own address and never changes.** `/v/<version>/` holds one build, with a list of its files' hashes. The build is reproducible, so anyone can rebuild a version from the source and compare.
- **The iPhone app carries its own copy.** It loads none of the client code from our site, and keeps its device key in the Secure Enclave.

The PC's check cannot prove what one particular phone was served later. If you would rather not trust our site at all, use the iPhone app or run your own relay and page.

## What a paired phone can do

A paired phone works in conversations as you would at the PC, so with full access Claude can run commands and edit files for it. You decide on the PC what each phone may do:

- **Full:** what you can do in a conversation at the PC.
- **No shell:** no commands, no file edits, no browser pane and no added MCP tools; reading, searching and answering stay.
- **Chat only:** plan mode; nothing runs.

The PC enforces this whatever the phone sends: the tools are removed from that pane's Claude Code and refused by a hook that holds in every permission mode. Phone panes never start in the desktop's bypass-permissions default. Billing, account switching, pairing and settings are controls only the PC has.

Remove a phone in the Phone sheet and it cannot reconnect without a new QR code. If that phone was signed in to an Apaki account linked to the PC, remove the account there too.

## Apaki accounts (optional)

An account is a passkey: Face ID or a fingerprint, with no email and no password. It holds a vault listing your PCs, encrypted with a key that only your passkey can produce (the WebAuthn PRF extension), so the server stores ciphertext and public keys and cannot open it. Anyone who holds your passkey can reach the PCs in your account, which is why an account reaches a PC only after you allow it on that PC.

Each PC chooses a mode in its Phone sheet:

- **Connected** (the default): a new phone signed in to your account gets in, and the PC tells you with a Block button.
- **Private:** every phone needs an OK on the PC. A phone you scan the code with is added at once; any other waits for Allow or Block.

## Reporting a problem

Write to security@myrlin.io, or see [/.well-known/security.txt](https://apaki.myrlin.io/.well-known/security.txt). The full review, including what is not done yet, is [SECURITY.md](../SECURITY.md).
