# Claude Desktop: feature inventory (hand kept)

Seeded 2026-10-11 by Claude Code (Sonnet 5.5) from apaki/docs/research/2026-10-11-market.md
(sections 1.3, 2.1, 2.2 and 3.1; every claim there carries its URL and the date it
was opened). Claude Desktop has no machine readable surface, so this file is the
record. `npm run parity:extract` turns each bullet below into a surface item
`claude-desktop:feature:<slug>` in snapshots/claude-desktop/<installed version>.json,
and the ledger (apaki/parity/features.json) points at those ids.

Installed version when seeded: 2.31226.1.0 (Windows Store package "Claude", read
from the package name only; no app data was read and the app was not opened).

## How to keep this file

- One bullet per feature, in this exact shape: a backticked slug, a colon, one
  line of plain text. Anything else in the file (this text, TODO lists) is ignored
  by the extractor.
- Add a bullet when the app gains a feature; delete the bullet when it loses one
  (the diff then reports the id as removed and lists ledger features that need a
  look). Re-word a bullet when the feature changes (the diff reports it as changed).
- After an app update: note the new version at the top, edit the bullets, run
  `npm run parity:extract`, then `npm run parity:diff`.
- Never open, close or read the running app to fill this in. Docs, release notes,
  issue trackers and Arthur's own use are the sources.

## Code tab: sessions and panes

- `code-tab-sidebar`: Sidebar of the app's own Code sessions; sessions started in a terminal come in through /resume in the prompt box, not automatically. Source: code.claude.com/docs/en/desktop, market.md 3.1.
- `split-panes`: Split panes with drag and drop layout.
- `browser-pane`: A browser pane beside the conversation.
- `integrated-terminal`: An integrated terminal pane.
- `file-editor`: A file editor pane.
- `diff-view`: A diff view of the session's changes.
- `side-chat`: Side chat (Ctrl+;) that can read the main thread.
- `model-effort-menus`: Model and effort menus with shortcuts (Ctrl+Shift+I, Ctrl+Shift+E).
- `usage-ring`: A usage ring showing plan usage.
- `os-notification-on-finish`: An OS notification when a session finishes or needs a decision.
- `shortcut-cheat-sheet`: A keyboard shortcut cheat sheet (Ctrl+/).
- `scheduled-tasks`: Scheduled tasks.
- `ssh-and-wsl-sessions`: Sessions on SSH hosts and in WSL.
- `worktrees`: Tasks can start in a git worktree (market.md cites Claude Desktop with Codex, Conductor and Emdash as doing this).

## Remote, phone and cloud

- `remote-control`: Drive a local Claude Code session from claude.ai/code or the Claude app: QR pairing, images and files, push when a task finishes or needs a decision, reconnect after sleep. Needs the machine on and claude running; API keys are not supported; not end to end encrypted. Source: code.claude.com/docs/en/remote-control.
- `mobile-code-tab`: The Code tab in the Claude phone app (Remote Control client). Source: code.claude.com/docs/en/mobile.
- `dispatch`: Message a task in the Claude app and Desktop spawns a Code session (Pro and Max only). Source: code.claude.com/docs/en/mobile.
- `code-on-the-web`: Claude Code on the web: cloud sessions on GitHub repos that keep running with the laptop off.
- `cowork`: Cowork, which runs a local VM (an open issue reports about 10 GB).
- `claude-in-chrome`: A native messaging bridge to Chrome (Hacker News 2026-04-23 reported it installed undisclosed).

## Known absent (open requests, 2026-10-11)

Multi-account switching (#18435, 881 thumbs-up), multi-window (#30154), detachable
windows (#27725), automatic sync with the CLI's session list (#28791). Apaki covers
the first through Myrlin Glass. If one of these ships, add a bullet above.

## TODO: not yet inventoried

- Settings screens (appearance, notifications, connectors, extensions).
- Projects and artifacts as the desktop app shows them.
- Voice, dictation and attachment behavior in the Code tab.
- Keyboard shortcut list beyond Ctrl+/, Ctrl+;, Ctrl+Shift+I, Ctrl+Shift+E.
- Release notes since 2.31226.1.0 (read the changelog, not the app).
