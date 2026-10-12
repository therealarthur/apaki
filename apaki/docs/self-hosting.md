# Run your own Apaki relay

Written 2026-10-12 by Claude Code (Opus 5.5) for Arthur. The reference for everything here is [relay/README.md](../../relay/README.md); this page is the short path through it.

Apaki works without any relay: the desktop app needs nothing from us. The relay only matters for phone access. By default Apaki uses ours at `apaki.myrlin.io`, which is free. Running your own means that the phone page your phones load, and the server that passes their encrypted frames along, are yours.

## What you run

One Cloudflare Worker, from the [`relay/`](../../relay/) folder of this repository. It does three things on one hostname:

- the relay: one Durable Object per PC (a "room"), forwarding sealed frames between the PC and its phones;
- the phone page: every published version of the web client, at `/v/<version>/`, plus the web app's entry at `/app/`;
- optional Apaki accounts (passkey sign-in and a vault the server cannot open).

The Workers free plan is enough for a few people, and on the free plan it cannot bill at all: past the free limits, requests fail instead. A daily budget guard (`DAILY_BUDGET_USD`, $3 by default) closes rooms for the rest of the UTC day if the estimated spend gets there.

## What you need

- A Cloudflare account and a hostname on a zone in it, for example `relay.example.com`.
- Node 20 or newer, and this repository.
- Wrangler, which `npm install` in `relay/` brings in. Log in once with `npx wrangler login`.

## Steps

1. **Point the Worker at your hostname.** In `relay/wrangler.jsonc`, set `routes` to your hostname, and set `ALLOWED_ORIGINS` and `ACCOUNT_ORIGIN` to `https://<your hostname>`.

2. **Optional: accounts.** Accounts need a signing secret for their session tokens. Without it the account routes answer 503 and everything else works.

   ```
   cd relay
   npx wrangler secret put ACCOUNT_KEY     # 32 random bytes, base64url
   ```

3. **Publish the phone page for your relay.** The page names the one relay it may connect to, so it is built for your hostname:

   ```
   node ../apaki/scripts/build-web.mjs --release --relay wss://relay.example.com
   ```

   This adds `relay/site/v/<version>/` and rewrites `relay/site/app/index.html`. Each version lives at its own address and never changes.

4. **Deploy.**

   ```
   npx wrangler deploy --env=""
   ```

   `--env=""` picks the top-level configuration; `wrangler.jsonc` also has a `private` environment (below).

5. **Point Apaki at it.** Apaki reads two environment variables when it starts:

   ```
   setx APAKI_RELAY_URL wss://relay.example.com
   setx APAKI_WEB_URL https://relay.example.com/
   ```

   Quit Apaki and start it again. The Phone sheet now pairs through your relay.

## Keeping it current

Any change to the window's code, the phone client or the protocol makes a new phone page version, and an Apaki on that code refuses to pair until your site has it. After updating Apaki, run step 3 and step 4 again. Older versions stay published, so phones paired with an older Apaki keep working.

## The home page in `relay/site`

`relay/site/` also holds Apaki's product home page (`index.html`, `site.css` and `assets/`, about 26 MB of recordings). If you do not want it on your host, delete those three; the next release writes a one-line front page that points at `/app/`.

## A relay with no pages and no accounts

`wrangler.jsonc` has a second environment, `private`: the same Worker with `RELAY_ONLY` on, no static assets and no account storage, so it serves no code and holds no accounts. Phone sockets are accepted only without an `Origin` header, which means native apps and no web page. Give it a hostname (the commented route in that environment) and deploy it with:

```
npx wrangler deploy --env private
```

## What you can see as the operator

Running the relay puts you where we are on `apaki.myrlin.io`. You can see IP addresses, room ids, when PCs and phones connect, and the size and timing of frames. You cannot read the frames, change them without breaking the connection, pair a phone, or connect to a PC. The relay code writes no logs and `observability` is off in `wrangler.jsonc`; whoever holds the Cloudflare account can turn logging on. More in [security.md](security.md) and the full review, [SECURITY.md](../SECURITY.md).

## Limits you can change

`relay/src/lib.js` (`DEFAULT_LIMITS`) lists them; each can be overridden as a var in `wrangler.jsonc`, for example `"MAX_PHONES": "8"` (phone connections per room at once) or `"DAILY_BUDGET_USD": "1"`.
