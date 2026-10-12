# Contributing to Apaki

Written 2026-10-12 by Claude Code (Opus 5.5) for Arthur. It describes the repository as it is; if a step here stops matching the scripts, the scripts are right.

## How the repository is laid out

| Folder | What it is |
|-|-|
| `apaki/ui/` | The desktop window: HTML, CSS and plain ES modules, no framework and no build step. The phone client reuses it unchanged. |
| `apaki/engine/` | The engine: a Node process that runs Claude Code through the Agent SDK, one per pane, plus sessions, search, the browser tools and phone access. The window talks to it through the Tauri shell. |
| `apaki/src/`, `apaki/Cargo.toml` | The Tauri shell (Rust): the window, the built-in browser, the engine host. |
| `apaki/remote/` | The phone protocol (`protocol.js`, `wire.js`) and the design notes: PROTOCOL, ACCOUNTS, ENROLL, CLOUD, CODEX, WORKTREES. |
| `apaki/web/` | The phone client's own parts (pairing, the link to the PC, the phone layout). `apaki/scripts/build-web.mjs` builds the phone page from these and `apaki/ui`. |
| `apaki/mobile/` | The iPhone and Android apps (Capacitor) around the phone client. See its README. |
| `apaki/demo/` | The demo harness that runs the real window on invented data and records it for the site and this README. |
| `apaki/parity/` | The feature ledger (`features.json`) and the Claude Code and Codex protocol snapshots. |
| `relay/` | The relay Cloudflare Worker, and `relay/site/`, the static site it serves (home page, `/app/`, every phone page version). |
| `src/`, `bin/` | `latch`, the terminal app on the same engine. |
| `index/` | `latch-index`, the Rust full-text index of every transcript. |
| `test/` | Node tests for all of the above. `relay/tests/` has the relay's own. |

## Running the tests

```
npm install
npm test                      # node --test: everything under test/
cd relay && npm install && npm test   # the Worker under local workerd, with real pairings
node --test apaki/demo/demo.test.mjs  # the demo harness keeps its data invented
```

The tests need no Cloudflare account, no Claude login and no network.

## Building the Windows app

You need Rust (stable, MSVC), Node 20 or newer, and `npm install` in the repository root on Windows x64 (it installs the Agent SDK's `claude.exe`).

```
powershell -File apaki/scripts/package-apaki.ps1      # builds apaki/dist/Myrlin Apaki
powershell -File "apaki/dist/Myrlin Apaki/install-apaki.ps1"
```

The package is self-contained: the window, the engine with its own Node, `latch`, the index, and Myrlin Glass and the voice model for a PC that has neither. `package-apaki.ps1` explains each part at the top.

## The phone page

```
node apaki/scripts/build-web.mjs --serve 8790                      # build and serve it locally
node apaki/scripts/build-web.mjs --release --relay wss://apaki.myrlin.io   # publish a version into relay/site
```

A published version never changes, and a PC refuses to pair until the site serves exactly the version it builds. Commit `relay/site/v/<version>/` and `relay/site/app/` together.

## The recordings

Everything on [apaki.myrlin.io](https://apaki.myrlin.io) and in the README is the real window on made-up data:

```
node apaki/demo/capture.mjs ffmpeg=<path to ffmpeg>     # stills and clips into D:\apaki-media (or ~/apaki-media)
node apaki/demo/site-media.mjs ffmpeg=<path to ffmpeg>  # the site's and README's media from those
node apaki/demo/brand-images.mjs ffmpeg=<path to ffmpeg>  # the wordmark and the link preview
```

[demo/README.md](../demo/README.md) lists the scenes and how to add one. Keep the data invented: no real names, paths, accounts or emails.

## Writing for this project

- Say what the code does, and say "coming" for what it does not do yet. [parity/features.json](../parity/features.json) records what is supported, partial or planned.
- Comments explain why. New files start with a short header saying what they are for.
- No em dashes and no double hyphens in prose, comments or commit messages.
- Security-relevant changes (`apaki/remote`, `apaki/engine/remote*.js`, `relay/`) should say what they change about [SECURITY.md](../SECURITY.md), and update it.

## Reporting a security problem

Please do not open a public issue. Write to security@myrlin.io ([security.txt](https://apaki.myrlin.io/.well-known/security.txt)).
