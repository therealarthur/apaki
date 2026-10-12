# Myrlin Apaki

A desktop app for working with Claude Code, plus `latch` for the terminal. It
runs the real Claude Code underneath, shows every session on your computer in
one window, lets each conversation bill your subscription or an API key, and
follows Myrlin Glass as it switches accounts.

Written 2026-10-10 from what is built and tested.

## What makes it different

- It is Claude Code, not a lookalike. Apaki drives Claude Code through
  Anthropic's Agent SDK with Claude Code's own system prompt and every setting
  source, so your CLAUDE.md, skills, plugins, hooks, MCP servers and slash
  commands (about 140 on the machine it was built on) work as they do in the
  terminal. Sessions stay in Claude Code's own files: open one in Apaki,
  continue it in a terminal with `/resume`, and back.
- Your local sessions can run on API credits. Any existing Claude Code
  conversation can continue on an Anthropic Console API key instead of your
  subscription, in the same session file, so nothing forks. In the terminal,
  `latch` does the same, and its relay mode keeps the real Claude Code window
  while each message runs headless on the key. Pick the billing per
  conversation, or let it follow Myrlin Glass.
- Myrlin Glass is built in. The corner card shows the live Claude account
  (an API key is labelled as one, with dollars left) and the live Codex
  account, each with what is left and a meter. Click to switch; when Glass
  switches on its own, open conversations move with it before their next
  message.
- It keeps your prompt cache warm. Coming back to a long conversation after
  an hour normally means paying to write the whole thing to the cache again.
  Apaki can ping idle sessions that bill an API key so the cache stays warm,
  with a daily cap. Measured on Opus 5.5: 68 minutes after the first turn, a
  kept-warm conversation read 62,518 tokens from cache and its next turn cost
  $0.125; the same conversation left alone had to write 59,314 tokens again
  and cost $0.478.
- Every session on the machine, live. All of Claude Code's transcripts are
  listed, including ones that started headless (claude -p, workers, relayed
  windows). Sessions open in terminal windows appear and drop out within about
  2 seconds. Search finds sessions by words and by meaning, using a local
  index and a local embedding model; nothing is uploaded to search.
- Your phone, through a relay that cannot read anything. Scan a QR code,
  compare a 6-digit code, and the phone becomes a remote window onto the
  Apaki on your PC. Everything is end-to-end encrypted between the two
  (P-256 key exchange, AES-256-GCM, fresh keys per connection); the hosted
  relay at apaki.myrlin.io forwards sealed frames it cannot read and keeps
  nothing about your conversations, and your Claude and Codex logins never
  leave the PC. Anyone's
  Apaki can use it: each install gets its own room, and an account is
  optional.
- Sign in on any phone with a passkey and your PCs are there. An Apaki
  account is a passkey (Face ID or a fingerprint, no password, no email) and
  a vault of your PCs that only that passkey can open: the key comes from
  the passkey itself (WebAuthn PRF), so apaki.myrlin.io stores only
  ciphertext and public keys and cannot open the vault. The page that opens
  it on your phone comes from apaki.myrlin.io, as with any web app (the
  native app will ship its own copy). Pair a PC once from any
  phone and, after you allow the account on the PC (nothing is added
  without that), every phone signed in to the account can reach it; remove
  the account on the PC and they all stop at once. The Phone sheet says how:
  "Sign in at apaki.myrlin.io on your phone to reach this PC from any
  device".
- Connected or Private, chosen on the PC. Connected is the default: Apaki
  accounts work as above. Private is a switch in the Phone sheet: every
  phone needs an OK on the PC (one you scan a code with is added at once, any
  other waits for Allow or Block, accounts included), an account is only
  added right after you pair a phone, accounts already linked are removed
  or kept (their phones are asked again), and the phone page stops asking
  the relay which of its PCs are online. Phones still run the page from
  apaki.myrlin.io in both modes until the native app ships. Under each
  account the Phone sheet lists the phones that connected through it, each
  with Block, Allow and Forget; in Connected a new phone gets in and the PC
  shows "New phone connected" with Block.
- It feels like an app on the phone. The sessions list is home with a large
  title, a conversation slides in from the right and a swipe from the left
  edge goes back, menus and sheets rise from the bottom and close with a
  swipe down, pull down to refresh, and it installs to the Home Screen and
  opens full screen.
- Your PC checks the phone page before trusting it. The page your phone runs
  is a reproducible build of Apaki's own code, published at an address that
  never changes. Before showing a pairing code, Apaki builds that page itself
  and compares every file with what the site serves; if a file it fetches
  differs, or it cannot reach the site, it will not show a code (the Phone
  sheet offers "Pair without checking the page" for an unreachable site,
  saying what it risks). While phone access is on, the PC fetches the pages
  it verified again every hour, the way a phone browser asks for them, and
  turns phone access off with the reason if a file changed. The checks run
  from your PC's network, so they cannot prove what one phone is sent.
  Details and limits: apaki/SECURITY.md.

## Conversations

- Tabs and splits: up to six panes per tab, drag sessions onto a pane edge to
  split, drag panes by their grip to move or swap them.
- Replies render like Claude Code: markdown with nested and task lists,
  tables, quotes, highlighted code, tool lines with their results, red and
  green diffs. Replies render as they stream.
- Queue and steer while Claude works. Enter queues the next message instead
  of interrupting; Steer folds it into the running turn at Claude's next step.
- Model, effort and permission mode per conversation (Opus 5.5 at xhigh
  effort by default), with questions and plan approvals as real dialogs.
- Permission prompts, as in Claude Code. In Ask permissions and Auto-accept
  edits, a tool Claude Code would ask about waits for you: a sheet shows the
  tool and what it will do (the command, the file and the change, the page),
  with Allow once, Always allow and Deny, plus a box for a note that goes to
  Claude with the denial. Always allow saves the rule Claude Code itself
  suggested, the same way Claude Code saves it. Enter allows once and Esc
  denies. A prompt is answered once, goes away if the turn ends or Claude Code
  cancels the call, and comes back if the window reconnects. On a phone it is
  the same sheet; a phone can answer only for its own conversations, and only
  a phone with Full access can save a rule. Bypass permissions still skips
  prompts.
- Claude's todo list is a checklist in the conversation, as in Claude Code:
  done items struck through, the item being worked on in bold. Later todo
  updates in the same turn change that checklist in place instead of adding a
  new one, and old conversations show it the same way, on the phone too.
- Rename a session by double-clicking its tab. The name is saved in the
  session the way `/rename` saves it, so Claude Code, latch and Apaki all show
  the same one.
- Your last prompt stays pinned at the top while you read the reply; click it
  to jump back. Hover a message to see when it was written.
- Ctrl+F finds text in the focused pane, steps through the matches and opens
  collapsed tool output that holds one.
- Voice dictation with a local Whisper model.
- Light and dark themes, following Windows or set by hand.

## Subagents, shells and background work

- A Tasks button on each conversation lists its running subagents, background
  shells, monitors and workflows with their type, model, time, tool uses,
  tokens, the tool in use and Claude's one-line progress summary.
- Open any of them in a viewer that follows it live (a subagent's own
  conversation, a shell's output), as a split or a tab, or drag it where you
  want it. Stop one, or send a foreground task to the background (Ctrl+B in
  Claude Code).
- In the session list, every session shows how many subagents it has had;
  expand the list and open any of them, including sessions running in
  terminals.

## Claude shows you things

- Artifacts: when Claude has something to show (a page, a document, an SVG,
  an image, a PDF), it opens in a viewer beside the conversation, with every
  revision kept. HTML runs in a sandbox with no network and no access to the
  app. Cards in the conversation reopen them later.
- Claude's habit of opening files and pages in your OS browser is caught and
  shown in Apaki instead; tools that open a browser (vite --open, Python's
  webbrowser) open there too.
- A built-in browser Claude can drive: open a page, read it as an outline
  with numbered links, buttons and fields, click, type, go back, take a
  screenshot. You watch the same page beside the conversation. Pages in it
  have no access to the app or your sessions.

## Never lose your place

- The whole workspace is saved continuously: tabs, splits and their sizes,
  each pane's session and settings, unsent drafts, queued messages, scroll
  position, open viewers, the window's size and place. After a crash it opens
  exactly as it was, and says which conversations were working when it closed.
- The saved workspace is kept twice (in the app and in a file on disk), and
  the newer copy wins.

## For the terminal: latch

- A full-screen session picker with search inside every conversation, views
  for sessions open in terminals and for your own folders.
- Continues any session on an API key in a Claude Code style terminal UI over
  the Agent SDK, or in the real Claude Code window with relay mode.
- Keep-warm from the command line: `latch warm on`, `latch warm status`.

## Phone access details

- Pairing needs the one-time secret in the QR, which stays in the link's
  fragment and never reaches a server. The PC approves each phone after both
  screens show the same code.
- A phone works in conversations and the session list, with the same
  Claude Code a desktop pane has. What Claude may do for it is chosen on
  the PC per phone, at Allow and later in the Phone sheet: Full (Claude can
  run commands and edit files, as on the PC), No shell (no commands, file
  edits, browser or added MCP tools; reading, searching and answering stay)
  or Chat only (plan mode, nothing runs). The PC enforces it whatever the
  phone page does: the tools are removed from the pane's Claude Code and
  refused by a hook that holds in every permission mode. Every phone can
  read the PC's conversations. Phone panes never start in the desktop's
  bypassPermissions default. Billing, account switching, pairing and
  settings are controls only the PC has.
- Remove a phone on the PC and it can never reconnect without a new QR. If
  it was signed in to an Apaki account linked to that PC, remove the account
  there too.
- An account connects with the same handshake as a paired phone, as one
  device the PC lists by name ("Apaki account (Arthur)", with which phone is
  using it right now). Signing in needs the passkey; the server only checks
  it and hands back the sealed vault.
- The relay is one Cloudflare Worker anyone can run on their own account
  with two commands; Apaki points at it with two settings.
