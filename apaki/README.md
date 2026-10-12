<!--
  Myrlin Apaki's product README. Written 2026-10-12 by Claude Code (Opus 5.5) for Arthur.
  Images: docs/media (made by apaki/demo/site-media.mjs and brand-images.mjs from the demo harness, invented data).
  PLACEHOLDER(Arthur): the download, TestFlight and repository links, and the license section.
-->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/wordmark-dark.png">
    <img src="docs/media/wordmark-light.png" alt="Myrlin Apaki" width="360">
  </picture>
</p>

<p align="center"><b>Every Claude Code session on your PC, in one window.</b><br>
Free, open source, and yours to run.</p>

<p align="center">
  <a href="https://apaki.myrlin.io">Website</a> ·
  <!-- PLACEHOLDER(Arthur): GitHub releases of the public repository. -->
  <a href="https://github.com/therealarthur/claude-latch/releases/latest">Download for Windows</a> ·
  <a href="https://apaki.myrlin.io/app/">Web app</a> ·
  <a href="docs/self-hosting.md">Self-host</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="docs/faq.md">FAQ</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.webp">
  <img src="docs/media/hero-light.webp" alt="Apaki with four Claude Code conversations in a grid, three of them writing replies at once">
</picture>

Apaki is a desktop app for Claude Code on Windows. It lists every Claude Code session on your PC, including the ones running in terminals, and opens them in tabs of up to six panes. Myrlin Glass is built in, so you can see how much each Claude and Codex account has left and switch with a click. Claude gets a browser pane of its own. And your phone can pick up the same sessions through an end to end encrypted relay, which you can run yourself.

Underneath, it is the real Claude Code: Apaki drives it through Anthropic's Agent SDK with Claude Code's own system prompt and every settings source, so your `CLAUDE.md`, skills, plugins, hooks, MCP servers and slash commands behave as they do in a terminal. Sessions stay in Claude Code's own files. Open one in Apaki, continue it in a terminal with `/resume`, and come back.

Every picture on this page is the real app running on made-up demo data ([how it is recorded](demo/README.md)).

## Myrlin Glass, built in

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/glass-swap-dark.webp">
  <img src="docs/media/glass-swap-light.webp" alt="Opening the Myrlin Glass panel and switching Claude to a team subscription, then to an API key" width="760">
</picture>

The card at the bottom of the sidebar shows the live Claude and Codex accounts, each with what it has left. Click to switch subscriptions, or move a conversation to an Anthropic API key when a limit is close. The conversation keeps its context: it continues in the same Claude Code session file on the key, so nothing forks, and you can move it back. When Glass switches by itself, open conversations follow it before their next message.

Billing is per conversation, so one pane can run on your subscription while another runs on a key. For API-key sessions Apaki can also keep the prompt cache warm while you are away, with a daily cap. Measured on Opus 5.5, 68 minutes after the first turn: the next turn of a kept-warm conversation cost $0.125 and read 62,518 tokens from cache; the same conversation left alone had to write 59,314 tokens again and cost $0.478.

## Every session on the PC, found for you

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/sessions-dark.webp">
  <img src="docs/media/sessions-light.webp" alt="A search for payment page randomly failing, with the matching sessions found by meaning">
</picture>

Apaki reads Claude Code's transcripts, so the list has everything: sessions you started in a terminal, headless runs (`claude -p`), workers. A session open in a terminal window shows up within about two seconds, marked working or waiting. Search finds sessions by words and by meaning, with a local index and a local embedding model; nothing is uploaded. When you cannot remember which session it was, Ask Claude reads the best matches and says why each one fits.

Codex sessions are listed and searchable today, read-only. Opening them in panes is coming ([CODEX.md](remote/CODEX.md)).

## Tabs, panes, and a Claude that listens while it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/steer-dark.webp">
  <img src="docs/media/steer-light.webp" alt="A message queued, then another steered into the running turn while a subagent works" width="760">
</picture>

- Up to six panes per tab. Shift-click a session to open it beside the others, or drag it onto a pane's edge.
- Each pane has its own model, effort and permission mode, with questions and plan approvals as real dialogs.
- Enter queues your next message while Claude works; Ctrl+Enter steers it into the running turn.
- What Claude Code reports shows in the conversation: hook output, API retries, usage warnings, compaction.
- A Tasks button lists each conversation's subagents and background shells and opens any of them live.
- Close the window and the sessions keep running. The workspace (tabs, splits, drafts, queued messages, scroll positions) is saved as you work and comes back exactly as it was after a crash.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/history-dark.webp">
  <img src="docs/media/history-light.webp" alt="A long transcript with a Stop hook's feedback, an API retry and a usage warning shown as system lines">
</picture>

## A browser pane that Claude drives

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/browser-dark.webp">
  <img src="docs/media/browser-light.webp" alt="A conversation on the left and a checkout page in Apaki's browser pane on the right, with Claude typing into it">
</picture>

Ask Claude to try a page and it opens beside the conversation instead of in another Chrome tab. Claude reads it as an outline with numbered links, buttons and fields, then clicks, types, goes back and takes screenshots, and you watch the same page. Pages in the pane have no access to the app or your sessions. When Claude or a tool tries to open your system browser (`vite --open`, Python's `webbrowser`), the page opens in Apaki. Documents, SVG, images and PDFs that Claude wants to show you open in a viewer with every revision kept.

## Your sessions on your phone

<table>
  <tr>
    <td width="68%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/phone-pair-dark.webp">
        <img src="docs/media/phone-pair-light.webp" alt="Apaki's Phone sheet: a phone asks to connect and both screens show the code 482 913">
      </picture>
    </td>
    <td width="32%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/phone-loop-dark.webp">
        <img src="docs/media/phone-loop-light.webp" alt="The Apaki phone app: opening a session and sending a message to Claude Code on the PC">
      </picture>
    </td>
  </tr>
</table>

Open the Phone sheet and scan its code with the Apaki iPhone app or your phone's camera. Both screens show the same six digits; you allow the phone on the PC, and it stays paired until you remove it. The phone gets the session list, the conversations and the same Claude Code that runs on the PC.

- Free, with no account. End to end encrypted between the phone and the PC.
- You decide on the PC what each phone may do: Full, No shell, or Chat only. The PC enforces it. Billing, account switching and pairing stay on the PC.
- Optional Apaki account: a passkey, with no email and no password. Sign in on another phone and your PCs are there, once you allow it on the PC.
- Coming with Apaki Cloud: sign in from any browser with your phone's passkey, with nothing saved in that browser and an automatic sign-out after 30 minutes without input ([CLOUD.md](remote/CLOUD.md)).

## What the relay can and cannot see

The relay forwards sealed frames between your phone and your PC. It cannot read your prompts, replies, files or session list, cannot change them without the connection failing, and cannot pair a phone or connect to your PC (the PC only ever makes one outgoing connection). Your Claude and Codex logins never leave the PC. The relay does see IP addresses, connection times and how much data moves.

The web version of the phone client is code served by apaki.myrlin.io, so your PC checks it: before it shows a pairing code it builds that page from its own code and compares every file with what the site serves, and it checks again every hour while phone access is on. The iPhone app carries its own copy of the code. If you would rather not trust our site, run your own relay.

[Security in plain words](docs/security.md) · [The full security review](SECURITY.md) · [The protocol](remote/PROTOCOL.md)

## Coming next

| | |
|-|-|
| Codex in panes | Codex threads next to Claude's, with Codex's own pickers, questions and approvals. [CODEX.md](remote/CODEX.md) |
| Worktrees | Start a conversation in a new git worktree; see work by repository and branch; view changes, commit, push and open a pull request from the pane. [WORKTREES.md](remote/WORKTREES.md) |
| Apaki Cloud | Any-browser sign-in that saves nothing, a Cloud button on the desktop listing your machines, and phone push when Claude asks or finishes. A paid option on our hosted relay; a relay you run gets every feature. [CLOUD.md](remote/CLOUD.md) |

## Install

<!-- PLACEHOLDER(Arthur): the download and TestFlight links. -->
- **Windows:** [download the latest release](https://github.com/therealarthur/claude-latch/releases/latest). The package carries Claude Code, Node and Myrlin Glass; sign in with Claude Code's own login (`claude auth login`, offered at the end of the install) or use an Anthropic API key. WebView2 is part of Windows 11 and is installed if it is missing.
- **iPhone:** in TestFlight, by invite for now. The App Store comes later.
- **Any phone browser:** [apaki.myrlin.io/app](https://apaki.myrlin.io/app/), then pair it from the Phone sheet on your PC.

## Run your own relay

The relay is one Cloudflare Worker, and the free plan is enough for a few people. [docs/self-hosting.md](docs/self-hosting.md) walks through it; the reference is [relay/README.md](../relay/README.md).

```
cd relay
npm install
node ../apaki/scripts/build-web.mjs --release --relay wss://relay.example.com
npx wrangler deploy --env=""
```

Then start Apaki with `APAKI_RELAY_URL=wss://relay.example.com` and `APAKI_WEB_URL=https://relay.example.com/`.

## Build from source and contribute

See [docs/contributing.md](docs/contributing.md): how the repository is laid out, how to run the tests, how to package the Windows app, and how the recordings above are made.

## More reading

- [FEATURES.md](../FEATURES.md): everything that is built, in more detail
- [docs/faq.md](docs/faq.md): questions people ask
- [SECURITY.md](SECURITY.md), [remote/PROTOCOL.md](remote/PROTOCOL.md), [remote/ACCOUNTS.md](remote/ACCOUNTS.md), [remote/ENROLL.md](remote/ENROLL.md): the security review and the protocols
- [mobile/README.md](mobile/README.md): the iPhone and Android apps
- [demo/README.md](demo/README.md): the demo harness that records the real UI on invented data

## License

<!-- PLACEHOLDER(Arthur): not chosen yet. The market research (docs/research/2026-10-11-market.md, section 4.3) suggests Apache-2.0 for the app, engine and clients and AGPL-3.0 for relay/ and the account service. -->
To be announced with the public repository.

---

Apaki is a Myrlin Labs project. It is independent and not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic.
