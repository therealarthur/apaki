# Apaki FAQ

Written 2026-10-12 by Claude Code (Opus 5.5) for Arthur. Answers come from [FEATURES.md](../../FEATURES.md), [SECURITY.md](../SECURITY.md) and [remote/CLOUD.md](../remote/CLOUD.md); "coming" means planned, not built.

## The basics

**What is Apaki?**
A Windows desktop app for Claude Code. It lists every Claude Code session on your PC, opens them in tabs of up to six panes, has Myrlin Glass built in for your accounts, gives Claude a browser pane, and lets your phone use the same sessions through an end to end encrypted relay.

**Is it made by Anthropic?**
No. Apaki is a Myrlin Labs project and is not affiliated with or endorsed by Anthropic or OpenAI. It runs the Claude Code you sign in to with your own account or API key.

**Does it change Claude Code?**
No. It runs Claude Code unmodified through Anthropic's Agent SDK, with Claude Code's own system prompt and every settings source. Your `CLAUDE.md`, skills, plugins, hooks, MCP servers and slash commands work as they do in a terminal, and sessions stay in Claude Code's own files.

**Can I keep using the terminal?**
Yes. Open a session in Apaki, continue it in a terminal with `/resume`, and come back. Sessions open in terminal windows show in Apaki's list within about two seconds, marked working or waiting.

**Which platforms?**
The desktop app is for Windows. On the phone side there is the iPhone app (TestFlight for now, the App Store later) and the web app, which runs in any phone browser.

## Cost and accounts

**What does it cost?**
Apaki is free, and so is pairing a phone through our relay. Your Claude and Codex usage is billed by Anthropic and OpenAI as usual.

**Will there be a paid plan?**
Apaki Cloud is planned as a paid option on our hosted relay: any-browser sign-in that saves nothing, a Cloud button on the desktop that lists your machines, and phone push notifications. A relay you run yourself gets the same features at no cost. What Cloud sells is hosting and the account service, never Claude or Codex access.

**Do I need an Apaki account?**
No. Pairing a phone needs only the code on your PC. An account (a passkey, no email, no password) is optional; it lets another phone see your PCs, once you allow it on each PC.

## Myrlin Glass and billing

**What is Myrlin Glass?**
The usage tracker for your Claude Code and Codex accounts. In Apaki it is the card at the bottom of the sidebar: the live accounts, what each has left, and a click to switch.

**Can one conversation use an API key while others use my subscription?**
Yes. Billing is per conversation. A conversation that moves to an Anthropic API key keeps its context, because it continues in the same session file; you can move it back.

**What is keep-warm?**
For conversations on an API key, Apaki can ping idle sessions so the prompt cache stays warm, with a daily cap. Measured on Opus 5.5, 68 minutes after the first turn: $0.125 for the next turn with keep-warm, $0.478 without.

## Phone access and privacy

**What leaves my PC?**
Claude Code talks to Anthropic as it always does. Search, its index and its embedding model run on your PC. With phone access on, encrypted frames pass through the relay; with it off (the default), Apaki makes no connection to our relay or site.

**Can the relay read my sessions?**
No. It forwards sealed frames and cannot open, change or replay them. It does see IP addresses, connection times and data sizes. Details in [security.md](security.md).

**What can a paired phone do?**
What you choose on the PC: Full (as at the PC, including having Claude run commands and edit files), No shell, or Chat only. Billing, account switching and pairing stay on the PC.

**I lost my phone.**
Remove it in the Phone sheet on your PC; it cannot reconnect without a new code. If it was signed in to your Apaki account and the account is linked to that PC, remove the account there too.

**Can I run my own relay?**
Yes, on your own Cloudflare account; the free plan is enough for a few people. See [self-hosting.md](self-hosting.md).

## Coming

**Codex?**
Codex sessions are listed and searchable now, read-only. Opening them as panes next to Claude's, with Codex's own pickers, questions and approvals, is coming ([remote/CODEX.md](../remote/CODEX.md)).

**Worktrees?**
Coming: start a conversation in a new git worktree, see work by repository and branch, and view changes, commit, push or open a pull request from the pane, on the desktop and the phone ([remote/WORKTREES.md](../remote/WORKTREES.md)).

**Notifications?**
Today Apaki plays a sound when a session finishes or needs an answer, and shows a count of ready tabs on the taskbar. OS notifications and phone push are planned.
