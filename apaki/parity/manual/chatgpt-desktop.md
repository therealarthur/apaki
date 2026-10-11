# ChatGPT desktop app (with Codex): feature inventory (hand kept)

Seeded 2026-10-11 by Claude Code (Sonnet 5.5) from apaki/docs/research/2026-10-11-market.md
(sections 1.3, 2.1 and 3.1) and apaki/remote/CODEX.md. OpenAI folded the Codex
app into the ChatGPT desktop app in 2026 (market.md 1.3), so this one file covers
both; the Windows package on this PC is still named "OpenAI.Codex". The app has no
machine readable surface, so this file is the record. `npm run parity:extract`
turns each bullet below into a surface item `chatgpt-desktop:feature:<slug>` in
snapshots/chatgpt-desktop/<installed version>.json, and the ledger
(apaki/parity/features.json) points at those ids. The Codex protocol itself
(app-server) is tracked separately by the codex product.

Installed version when seeded: 26.1002.7124.0 (Windows Store package
"OpenAI.Codex", read from the package name only; no app data was read and the
app was not opened).

## How to keep this file

- One bullet per feature: a backticked slug, a colon, one line of plain text.
  Anything else in the file is ignored by the extractor.
- Add a bullet when the app gains a feature, delete it when the app loses one,
  re-word it when the feature changes. Then `npm run parity:extract` and
  `npm run parity:diff`.
- Never open, close or read the running app to fill this in (CODEX.md: do not
  touch the ChatGPT or Codex desktop apps' running processes or files beyond
  reading). Docs, release notes, issue trackers and Arthur's own use are the sources.

## Threads, projects and the prompt box

- `projects-threads-sidebar`: Projects and threads sidebar. Source: learn.chatgpt.com/docs/app (section names only).
- `local-or-worktree-per-thread`: Each thread starts Local or in a git worktree. Source: market.md 2.1; Hacker News "dictation and worktree support built in".
- `model-picker`: Model picker (model/list, per model reasoning efforts).
- `effort-picker`: Reasoning effort picker.
- `approval-presets`: Approval and sandbox presets: read-only, auto (workspace write, ask on request), full access (danger-full-access, approvals never).
- `attach-files-and-images`: Attach files and images to a message, paste and drag in.
- `voice-dictation`: Voice dictation into the prompt box.
- `queued-followups`: Follow-up messages queued while a turn runs (app-server bugs #45019 and #44781 concern this).
- `slash-commands`: Slash commands such as new, model, approvals, review, compact, diff, mention, status, init, mcp.
- `request-user-input`: Codex's own version of AskUserQuestion (item/tool/requestUserInput); questions can auto-resolve after a time (#28969 complains of 60 seconds).
- `approval-prompts`: Approve once, approve for the session, deny, for commands, file changes and extra permissions.
- `review-mode`: Review mode for a diff or branch (review/start).
- `thread-fork-and-revert`: Fork a thread and revert to an earlier turn.

## Panels and surrounding features

- `side-panel`: A side panel that shows diffs, files, images, terminal output and web pages (CODEX.md asks Apaki for the same versatility).
- `browser`: A built in browser. Source: learn.chatgpt.com/docs/app.
- `automations`: Automations (scheduled or triggered runs); described as Codex's most distinctive capability.
- `computer-use`: Computer use.
- `notifications`: Notifications when a thread finishes or needs a decision.

## Remote and accounts

- `remote-connections`: Codex remote from the ChatGPT phone app: QR pairing, steer, approve, review diffs and screenshots on a Mac or Windows host; the host must be awake and online; Windows cannot control another computer. Source: learn.chatgpt.com/docs/remote-connections, launch 2026-05-14.
- `cloud-tasks`: Codex cloud tasks (ChatGPT sign-in required).

## Known absent (open requests, 2026-10-11)

Multi-account auth profiles (#4432, #20500, #12029), standalone Windows installer
(#13993), tabbed sessions (#12098). Apaki covers account switching through Myrlin Glass.

## TODO: not yet inventoried

- Settings screens, personalities, memory, plugins and skills UI.
- The exact slash command list in the app (CODEX.md lists the documented set).
- Release notes since 26.1002.7124.0 (read the changelog, not the app).
