# Myrlin Apaki on macOS

Status: phase 2 (2026-10-13) on top of phase 1 (2026-10-12), built by GitHub's macOS runners and run on an Apple Silicon Mac (a Mac Mini, macOS 26.2).
Phase 1: the window, the engine host, the session list (Claude Code transcripts under `~/.claude` and Codex threads), panes, tabs, search, settings and phone
access. Phase 2 adds the built-in browser pane and Claude's browser tools, the `BROWSER` shim, voice (whisper.cpp with Metal), Mac wording in the window, and
the signing and notarization pipeline (switched off until a Developer ID certificate exists). What is still Windows-only says so in one line and is listed
under "Phase 2: what is done, what is left" below.

## Build and run

On a Mac with the Xcode command line tools, Rust (cargo), Node and npm:

```
bash apaki/scripts/package-apaki-mac.sh
```

That prepares the resources, runs `tauri build`, and leaves `apaki/dist/Myrlin Apaki.app` and `apaki/dist/Myrlin Apaki_<version>_aarch64.dmg`
(ad-hoc signed, or Developer ID signed and notarized when `APAKI_SIGN_IDENTITY` and the App Store Connect key are given, see "Signing and notarization").
Options: `--prepare-only`, `--bundle-only`, `--skip-index`, `--no-dmg`, `--no-voice`, `--updater`, `--clean-target`, `--out DIR`; the script's header
documents them. The voice program (whisper.cpp, built with cmake) adds about 0.3 GB while it builds. Free disk space is checked before each big step (`APAKI_MIN_FREE_GB`, default 5).

Disk a full release build needs (measured on the Mac Mini, cold caches), for planning the Mac and CI:

| What | Size |
| - | - |
| `apaki/target` (Tauri release build, includes `release/bundle`: the .app 433 MB and the .dmg 161 MB again) | 1.9 GB |
| `index/target` (tantivy, ONNX Runtime) | 0.85 GB |
| cargo's crate cache (`CARGO_HOME`) | 0.31 GB |
| `apaki/build-mac` (Node 108 MB, engine and production node_modules 345 MB, icons, npm cache, the Node tarball) | 0.6 GB |
| `apaki/dist` (the finished .app 467 MB and .dmg 161 MB) | 0.63 GB |
| ONNX Runtime download (`~/Library/Caches/ort.pyke.io`, outside the clone) | 0.08 GB |

That is about 4.4 GB at the peak, so 5 GB free is the least to start with. After the build `--clean-target` removes both target folders, and `apaki/build-mac` and
`CARGO_HOME` can go too (regenerated, with downloads); what stays is `apaki/dist`, about 0.8 GB with the clone. A rebuild after a source change (cargo's cache and
`build-mac` kept) needs about 2.6 GB. Running the app adds `~/.claude/latch`: about 250 MB (search index, embedding model, logs) plus the transcript archive, which copies every
transcript gzipped (about 390 MB for 1.6 GB of transcripts; `APAKI_ARCHIVE_DIR` moves it, `APAKI_NO_ARCHIVE=1` turns it off). A GitHub macOS runner has the room.

Checks that run on any OS: `npm test` (the platform switches, the Keychain sealer against a fake `security`, and the rest) and, in `apaki/`,
`cargo test` (bundle folders and PATH helpers in `src/mac.rs`). On a Mac, `node apaki/scripts/mac-smoke.mjs --root "<app>/Contents/Resources/engine" --phone`
drives a scratch engine through the session list, a pane's history, search, and phone access against the real relay with scratch keys
(never a prompt; its own throwaway keychain file). `node apaki/scripts/mac-browser-smoke.mjs --app "<path>/Myrlin Apaki.app" [--mouse both] [--voice --model <file>]`
runs the finished app with a scratch `CLAUDE_CONFIG_DIR` and drives its built-in browser the way Claude does (see "The browser on macOS"); CI runs it on every build.

## What the Mac app is made of

Tauri's own bundler makes the .app and the .dmg. Releases will be built by GitHub Actions on a version tag and the apps will update through
Tauri's updater plugin from GitHub Releases, which only works for apps Tauri's bundler made, so nothing is assembled by hand. The script only
prepares what the app carries and then runs the build, so a CI job calls the same script.

| Piece | Where | Made by |
| - | - | - |
| the window (Rust, UI embedded) | `Contents/MacOS/myrlin-apaki` | `tauri build` |
| Node 22 runtime, checksum pinned in the script | `Contents/Resources/node/node` | the script (official tarball, sha256 verified) |
| the engine and latch | `Contents/Resources/engine/` (`src`, `bin`, `apaki/engine`, `apaki/remote`, `apaki/bin`, `apaki/ui`, `apaki/web`, `hooks`, `package.json`) | the script |
| production `node_modules` (includes the Agent SDK's darwin `claude`) | `Contents/Resources/engine/node_modules` | `npm ci --omit=dev` |
| the conversation search | `Contents/Resources/engine/index/target/release/latch-index` | `cargo build --release` of `index/` (CPU embedder) |
| speech to text | `Contents/Resources/voice/bin/Release/whisper-cli` | `build-whisper-mac.sh` (whisper.cpp v1.9.5, Metal, static) |
| the `BROWSER` shim | `Contents/Resources/engine/apaki/bin/apaki-open` | the script (a shell script, kept executable) |
| the icon | `icon.icns` | made by the script from `apaki/icons/source/apaki-icon-mac-1024.png` (the 1024 tile inset to 824 on a transparent canvas, the macOS icon grid) |

`apaki/tauri.macos.conf.json` (merged automatically on macOS) holds the window: native title bar over the page (`titleBarStyle: Overlay`,
hidden title, traffic lights at 20, 17). `apaki/tauri.macos.bundle.conf.json` is passed to `tauri build --config` and holds the bundle: targets,
`bundle.resources` (maps `build-mac/engine`, `build-mac/node` and `build-mac/voice` into `Contents/Resources`), the icon, the ad-hoc signing identity and the entitlements
file (`apaki/entitlements.plist`). `apaki/Info.plist`, next to `tauri.conf.json`, is merged into the app's Info.plist (microphone and Apple Events texts, plain `http://` in web content). It is a
separate file so a plain `cargo build` or `cargo test` on a Mac needs none of the staging folders. `main.rs` finds the engine and Node in
`Contents/MacOS/../Resources` (`mac::bundle_dirs`) as well as next to the executable (the Windows layout).

### What was left alone on purpose: apaki/ui

Everything in `apaki/ui/*.js` and `*.css` is also the phone page (`apaki/scripts/build-web.mjs` hashes it), and a PC only shows a pairing code
when the site serves the exact page its own sources build (`remote-page.js`). A change under `apaki/ui` changes the page version on every platform,
so Windows would stop pairing until a new page is published (`build-web.mjs --release`, deploy the relay). The Mac's small differences live in
the shell instead (`src/mac.js`, injected as a plugin init script), and the page check passes on the Mac against the published
version (2f75d4687fea, 57 files, checked 2026-10-12). `ui/phone.js` is the one UI file edited (the Keychain wording): it is desktop-only and not part of the phone page.

**Phase 2 changed that on purpose (2026-10-13), for the wording only:** `apaki/ui/platform.js` reads `<html data-platform="mac">` (set by `mac.js`) when a string is drawn, and a
handful of strings in `sessionlist.js`, `settings.js`, `app.js`, `glasscard.js`, `glasspanel.js` and `phone.js` say Finder, macOS and "this Mac" there. On Windows and on the phone page
(no flag) every string is the one it was, but the page version changes like with any edit under `apaki/ui`: the Windows window checks the page against what the site serves, so the
next release must publish its phone page (the release workflow's `phone-page` job does, before anyone is told to update).

## Inventory of Windows-specific assumptions, and what was done

Status: done = changed and tested; ok = already portable; degrades = says so in one line; phase 2 = later.

### Rust (`apaki/src`, `apaki/Cargo.toml`, `index/`)

| Where | Assumption | Plan and status |
| - | - | - |
| `main.rs` `#![cfg_attr(..., windows_subsystem = "windows")]` | no console window on Windows | ok (no effect elsewhere) |
| `main.rs` `node_path`, `repo_root` | `<exe dir>\node\node.exe`, `<exe dir>\engine` | done: also `Contents/Resources` of a .app (`mac::bundle_dirs`, tested) |
| `main.rs` `connect_or_start` | `latch-index.exe` name; launchd's short PATH has no Homebrew, `~/.local/bin` | done: `cfg!(windows)` name was already there; the host gets a PATH with the usual tool folders (`mac::host_path`) |
| `main.rs` `log_path`, `host.rs` `home` | `USERPROFILE` or `HOME` | ok |
| `host.rs` `spawn_host` | Windows creation flags | ok: the non-Windows branch (own process group) was already there; a host started by a Mac window keeps running when the window closes |
| `host.rs` `same_root` | `\\?\` prefix, backslashes, case | ok: a looser compare that works for POSIX paths too |
| `browser.rs` | the built-in browser is a bare WebView2 driven over the DevTools protocol (`webview2-com`, `windows` crates, `cfg(windows)`) | done (phase 2): `browser_mac.rs`, a WKWebView per tab behind the same `features()`, commands and events; the Windows module is unchanged. See "The browser on macOS" below |
| `Cargo.toml` | WebView2 crates | ok: already `target.'cfg(windows)'` |
| `tauri.conf.json` | `decorations: false` (the page draws the window buttons); CSP `http://ipc.localhost` (Windows' IPC origin) | done: macOS window in `tauri.macos.conf.json`; the CSP also lists `ipc:`, which macOS uses |
| `capabilities/default.json` | `set-overlay-icon` (taskbar), `set-badge-count` (dock) | ok: both were already granted; `ui/app.js` `updateBadge` already calls `setBadgeCount` on a Mac |
| `build.rs`, `icons/icon.ico` | exe icon resource | ok (Windows only); the Mac icon is `.icns` |
| `index/Cargo.toml`, `semantic.rs` | ONNX Runtime with the DirectML GPU provider | done: DirectML features and the `ort::ep::DirectML` call are `cfg(windows)`; a Mac embeds on the CPU (bge-small); on the Mac Mini the meaning search was answering ("semantic true") a few minutes after the first start. CoreML is phase 2 |

### Engine and latch (`apaki/engine`, `src`, `hooks`)

| Where | Assumption | Plan and status |
| - | - | - |
| `remote-store.js` | secrets sealed with DPAPI through `powershell.exe` | done: macOS login Keychain (`keychain.js`): a random 256-bit key held as a generic password (`io.myrlin.apaki.remote`), `secret.json` sealed with AES-256-GCM (scheme `keychain-aes`), the key moved through `security -i` on stdin and never an argument. The Windows path is unchanged; `secretStoreFor()` chooses and is tested for every platform. A locked or missing Keychain reads as the same "locked" state DPAPI uses (phone access retries, "Start over" is offered, nothing is replaced). Saving while the Keychain is locked falls back to a user-only file (mode 600), as before |
| `engine.js` `VOICE_DIR`, `WHISPER` | `%LOCALAPPDATA%\Programs\Myrlin Apaki\voice`, `whisper-cli.exe` | done (phase 2): `~/Library/Application Support/Myrlin Apaki/voice` (`platform.js`) for the model and anything installed by hand; the app carries a signed whisper.cpp (Metal) in `Contents/Resources/voice`, found when the per-user folder has none; the model is downloaded on request. See "Voice on macOS" below |
| `engine.js` `GLASS_CLI`, `src/auth.js` | `%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe` | done: the usual Mac places are tried (`/Applications/Myrlin Glass.app/Contents/MacOS/glass`, `~/Applications`, Homebrew), the first that exists, else the first (reported "not installed"). Degrades: "Myrlin Glass is not installed on this Mac (Glass is a Windows app for now). Apaki works without it". Phase 2: Glass for macOS |
| `engine.js` `revealFile`, `revealFolder` | `explorer.exe /select,` | done: `open -R <file>` (Finder), `open <folder>` (`platform.js`, tested) |
| `engine.js` `openOutside` | `rundll32 url.dll,FileProtocolHandler` | done: `open` |
| `worktrees.js` `terminalCommand` (`worktreeTerminal`, and the shared choice for Open in a terminal) | `wt.exe`, `cmd.exe` | done: `open -a iTerm <dir>` when iTerm is installed, else `open -a Terminal <dir>`; `APAKI_TERMINAL_APP` names another app. The `openTerminal` op itself is not in this branch of the engine yet (the engine's comment says it comes with the console toggle); when it lands it uses the same function |
| `engine.js` `signIn` | `cmd /c start ... claude auth login` | done: a new Terminal window running `claude auth login` (`osascript`, `platform.js`); Linux still prints the command |
| `tasks.js` `TEMP_ROOT` | `%TEMP%\claude` | done: `/tmp/claude-<uid>` (Claude Code's folder on a Mac, seen on the Mac Mini; `$TMPDIR` is `/var/folders/...` there, which was wrong) |
| `transcript-archive.js` | `D:\apaki-archive` when D: exists | ok: elsewhere `~/.claude/latch/archive`. Note for a Mac: the archive is a slim gzip copy of every transcript (about 390 MB for 1.6 GB of transcripts) and the first run copies them all; `APAKI_ARCHIVE_DIR` moves it, `APAKI_NO_ARCHIVE=1` turns it off. Also fixed here: the session list parsed the whole manifest once per archived-only conversation (22 s per list, host at 100 percent CPU, found on the Mac; now once per version of the file) |
| `codex-client.js` `findCodex` | npm layout of Windows (`codex.cmd` beside `node_modules/@openai/codex`) | done: the macOS and Linux npm layout (`<prefix>/bin/codex` symlink into `lib/node_modules/@openai/codex`), tested; found Codex on the Mac Mini and listed its 149 threads |
| `src/launch.js` `claudeBinary` | `%APPDATA%\npm\...\claude.exe` first | ok: falls through to the Agent SDK's bundled `claude-agent-sdk-darwin-arm64/claude` (shipped in the app) |
| `engine.js` `browserEnv`, `OPEN_SHIM` | the BROWSER shim is `apaki-open.cmd`, Windows only | done (phase 2): `apaki/bin/apaki-open`, a shell script (LF, executable) beside `apaki-open.mjs`, chosen by `platform.js openShimName`; Claude Code and Codex get `BROWSER` pointing at it, so tools that honour it land in the conversation's browser pane |
| `engine.js` `windowsHide`, `detached` options | Windows console windows | ok (ignored elsewhere) |
| `host-ctl.js`, `host.js` | process checks, detach | ok (`process.kill(pid, 0)`, `detached`) |
| `open-catch.js`, `codex-map.js` | recognises `start`, `Start-Process`, `explorer`, PowerShell wrappers | ok: also recognises `open` and `xdg-open`; no change needed |
| `artifacts.js` `file://` decode | drive letters | ok: already per platform |
| `asksearch.js` `short` | shortens `C:\Users\x` to `~` | done (phase 2): also `/Users/x` and `/home/x`; the search prompt names the Mac and builds its paths with the platform separator (tested) |
| `places.js` | drives, reserved names | ok: already per platform |
| `src/auth.js` live login `~/.claude/.credentials.json` | Glass swaps the login by rewriting that file; Claude Code on a Mac keeps its own OAuth login in the Keychain | degrades: Glass follow does not apply (no Glass); the engine asks `claude auth status`, which reads the Keychain, so the sign-in state is right |
| `hooks/prompt-relay.js` | `%LOCALAPPDATA%` paths (Glass, the Quota swap log, the Apaki engine folder), `taskkill`, `claude.exe` | phase 2 (`latch --relay` and terminal windows; Apaki panes do not use it) |
| `scripts/*.ps1`, `cdp-*.mjs`, `window-shot.ps1` | Windows install, packaging and WebView2 CDP dev tools | phase 2 where useful (the Mac has `package-apaki-mac.sh` and `mac-smoke.mjs`) |
| line endings | CRLF in history and parsing | ok: readers split on `\n` and trim `\r`; new shell scripts are LF (`.gitattributes`) |

### The window (`apaki/ui`, shell)

| Where | Assumption | Plan and status |
| - | - | - |
| title bar | no OS title bar; the page draws minimize, maximize and close (`#winctl`) and drag regions | done: native traffic lights over the page (`titleBarStyle: Overlay`); `mac.js` hides `#winctl`, leaves 84 px at the start of the brand row (and of the tab row when the sidebar is hidden) and drops the Myrlin mark beside the wordmark so the wordmark stays whole. Drag regions and double-click zoom work as before (the capabilities were granted already). Checked in a headless browser with `mac.js` injected the way the shell does it; the real window could not be screenshotted (see below) |
| taskbar overlay | Windows overlay icon with the number of tabs ready | done: the UI already calls `setBadgeCount` on a Mac (dock badge), and the capability exists. Not observed on screen |
| shortcuts | Ctrl+T, Ctrl+W, Ctrl+B, Ctrl+F, Ctrl+Enter, Ctrl+1..6, Ctrl+Tab | ok: every handler already accepts Ctrl or Cmd. A menu bar (`mac.rs`) supplies Edit (copy and paste need it in a web view), Quit (Cmd+Q) and Close Window (Cmd+Shift+W); Cmd+W is deliberately left to the page, which closes the focused pane with it. Hover tips say Cmd where the Mac uses it (`mac.js`); Ctrl+Tab stays, as Cmd+Tab is the system's |
| wording | "Show folder in Explorer", "Follows Windows", "this PC", "taskbar" | done (phase 2): `apaki/ui/platform.js` reads the flag `mac.js` sets (`<html data-platform="mac">`) when a string is drawn; a Mac says Finder, macOS, "this Mac" (sessionlist, settings, theme tooltip, Glass card and panel, Phone sheet, sign-in card). Windows and the phone page keep their words byte for byte (the phone page has no flag), but the page version changes with this edit like with any `apaki/ui` change, so it ships with the next release's phone page publish. "Taskbar" appears only in code comments |
| first click, fullscreen, window restore sizes | | not exercised without a screen; see "What could not be checked" |

## What degrades, in the words the app uses

| Feature | Message or behaviour on a Mac |
| - | - |
| built-in browser pane | works (phase 2). Only a platform with neither WebView2 nor WKWebView says "Apaki's built-in browser needs Windows or macOS for now." |
| voice | works once the speech model is on the Mac: the mic stays off until then; Apaki menu, "Download Voice Model..." fetches it (about 141 MB). "Voice is not installed (<path>)" if asked without |
| Myrlin Glass | "Myrlin Glass is not installed on this Mac (Glass is a Windows app for now). Apaki works without it; sign in with Claude Code instead." |
| BROWSER shim | works (phase 2): `apaki-open`. A tool that does not honour `BROWSER` (the macOS `open` command itself, npm's `open` package) still opens the system browser; Apaki's hooks turn the `open <url>` commands Claude runs into the browser pane |
| sign-in | a Terminal window runs `claude auth login` |
| Windows-only shell actions | Explorer, rundll32, `wt.exe` and `cmd.exe` calls are replaced as in the tables above; nothing Windows-only is left on the paths the window uses |

## The browser on macOS (phase 2, 2026-10-13)

`apaki/src/browser_mac.rs` is the Mac twin of the WebView2 module in `browser.rs`, behind the same `features()` (`["browser"]`), the same commands
(open, go, nav, place, focus, focusApp, snapshot, cdp, state, list, close, theme) and the same events to the window (created, reveal, state, focus, key,
closeRequested, closed). The window (`ui/browser.js`) and the engine (`browser-tools.js`, `browser-page.js`) are the very same files on both systems; the
Windows module is untouched and the Mac one is `cfg(target_os = "macos")`.

- **One WKWebView per tab, made by Apaki, not by Tauri.** Tauri puts its IPC bridge into every webview it creates, and a page from the internet must have none of
  that. So each tab is a plain `WKWebView` (objc2) with its own configuration: no script message handlers, no custom schemes, nothing of Tauri in it. It is a
  sibling view above the window's page, in a persistent website data store of its own (macOS 14 and later; the default store before that), so its cookies and logins
  are not shared with Apaki's page and survive a restart.
- **Placement.** The window sends the bounds of the pane's body in physical pixels, relative to its page (`place`). The shell divides by the window's backing scale
  and converts through the page view's own flipped or unflipped coordinates into the content view, where the tab's view goes. A tab that is not on screen is hidden
  (not destroyed), and is drawn invisibly for as long as a picture of it is being taken. Checked on the runner and on the Mac Mini by asking the shell for the frames
  (`debug`): a pane placed at (200, 120, 500 x 300) physical pixels lands exactly there, and the pane the window makes for a page sits below the tab row.
- **No DevTools protocol.** `cdp` answers the seven protocol calls the engine makes: `Page.getFrameTree` and `Page.createIsolatedWorld` (a counter per committed
  document), `Runtime.evaluate` (`callAsyncJavaScript` in a named `WKContentWorld`, an isolated world like the one the engine asks WebView2 for; the result comes back as
  JSON), `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent` and `Page.captureScreenshot` (`takeSnapshot`, encoded as PNG or JPEG, resized once if
  the picture came out at another size than asked; never wider than 1900 px).
- **Clicks** are real `NSEvent` mouse events sent to the view when the page is on screen (trusted events, so pages that insist on one work), else the same pointer
  and mouse events dispatched by the bridge script (`src/browser_mac_bridge.js`: hover, focus the way a click moves it, click, double click, shadow DOM and same-origin
  frames). **Typing and keys** always go through the bridge (`execCommand`, `KeyboardEvent`, form submission on Enter), which does not need the page to have the window's
  keyboard focus: Claude typing never takes the keyboard away from you. `APAKI_BROWSER_MOUSE=js` forces the bridge for clicks. The bridge was also run in Chromium
  against a page with a link, a form, a textarea, an editable region, a checkbox, a shadow root and a frame before it ever ran in WebKit.
- **Lesson learned (kept here so it is not learned twice):** WebKit throws away a named content world, with everything the scripts kept in it, as soon as nothing holds
  the world object. The engine's page library keeps its refs in `window.__apaki`, so the first version found "Ref 1 is not on the page any more" after every read. The
  world is now held for the life of the app.
- **What the page can do:** links and scripts that want a new window load in the same tab; `alert`, `confirm`, `prompt` and the file chooser are sheets on the window;
  a page that closes itself closes its tab; a page whose web process died is reloaded; Cmd or Ctrl with W, T, L, Tab and 1 to 6 reach the window (`key` events) while a
  page has the keyboard, and everything else that is a menu command (copy, paste, quit) goes to the menu bar. Safari's Web Inspector can attach (Develop menu, macOS 13.3
  and later). Plain `http://` addresses work through `NSAllowsArbitraryLoadsInWebContent` in `apaki/Info.plist`.
- **What it does not do (Windows does):** no downloads (a response WebKit cannot show is cancelled and the load reports it), no right-click through the engine (a real
  right-click by the person works), addresses of other apps (`mailto:`, custom schemes) are not opened from a page, a certificate the system rejects cannot be clicked
  through, and WebKit refuses some addresses (a restricted port such as 9) by committing a blank page, which is reported as an error.
- **Diagnosing:** the command `debug` returns the window's, the page's and every tab's frame, the click counters and the last 80 callbacks WebKit made.

How it was checked: `apaki/scripts/mac-browser-smoke.mjs` opens the built app with a scratch `CLAUDE_CONFIG_DIR`, so the window connects to the script instead of an engine,
and the script becomes the engine: it builds Claude's real browser tools (the `browser-tools.js` the app ships) on the connection and drives a small site: open, read with
refs, click a link, back, type and submit, tick a checkbox, pick a dropdown option, press a button, fill a textarea, screenshot (PNG and the phone's JPEG), a 404, an
address nothing listens on, tabs (open, switch, close), then the pane the window made for the page and where it sat, and finally `BROWSER` (`apaki-open`, also through
Python's `webbrowser`). It runs twice, clicks as real events and clicks through the bridge. Results of the last run are in "Checks" below.

## Voice on macOS (phase 2, 2026-10-13)

The mic button records 16 kHz audio in the window and the engine runs whisper.cpp's `whisper-cli` on it, as on Windows (`engine.js`, `transcribe`).

- **Program:** `apaki/scripts/build-whisper-mac.sh` builds `whisper-cli` from a pinned whisper.cpp release (v1.9.5; the script refuses a tag that no longer points
  at the pinned commit): static, Metal with the shader library embedded (no loose `.metallib`), generic Apple Silicon code (so a build made on a newer chip runs on an
  M1), no BLAS, loading system libraries only (checked). About 45 seconds on a runner, 7.6 MB. `package-apaki-mac.sh` runs it, signs the result with the rest and
  maps `build-mac/voice` to `Contents/Resources/voice` (`bin/Release/whisper-cli`, the layout of the Windows voice folder). `--no-voice` leaves it out for a quick build.
  On the Mac Mini (M4, macOS 26.2) it transcribed a spoken sentence in 0.2 to 0.3 s with Metal on; the first run after install takes several seconds (the GPU driver
  compiles the shaders once).
- **Where the engine looks:** the per-user voice folder first (`~/Library/Application Support/Myrlin Apaki/voice`, `APAKI_VOICE_DIR` moves it, a `whisper-cli` placed there
  by hand wins), then the app's own (`platform.js bundledVoiceDir`). The model is always in the per-user folder.
- **Model:** nothing downloads at first run (the Windows decision, `windows.md`). The Apaki menu has **Download Voice Model...**, which sends the engine the op `voiceModel`
  (`engine/voice-model.js`): `ggml-base.en.bin` (147,964,211 bytes) from Hugging Face into `voice/models`, written to a `.part` file, checked against the pinned SHA-256
  (the checksum Hugging Face publishes), then renamed; a mismatch deletes it. The window shows a note at the start and the end, and gets a fresh `ready` event so the mic
  turns on. The same download ran on the Mac Mini (2 seconds). Placing the file by hand works as on Windows; `APAKI_WHISPER_MODEL` points at another model.
- **Permissions:** `apaki/Info.plist` carries `NSMicrophoneUsageDescription` (macOS asks the first time the mic is used) and `apaki/entitlements.plist` carries
  `com.apple.security.device.audio-input` for the hardened runtime. Untested: the microphone prompt itself (no one at the Mac's screen), only the transcription.
- macOS 12 is the app's minimum, but the Metal build needs macOS 13: on 12 the mic may not work (the rest of the app does).

## Checks (what ran, 2026-10-13)

- **CI, `macos-build.yml`, every push of the branch `mac-ci/phase2`** on GitHub's `macos-latest` (Apple Silicon, macOS 15): builds everything, signs it, then opens the
  finished app and runs `mac-browser-smoke.mjs` (57 checks: 3 for `BROWSER`, 27 for each of the two click modes) and the voice check (model downloaded and checked, a
  sentence made with `say`, transcribed). The runner's display is 1x and 1024 x 674.
- **The Mac Mini** (macOS 26.2, M4, the display at 1x, 1320 x 860 window): the CI dmg was copied there, opened from a scratch folder, and the same smoke test ran against
  it: both click modes, the browser feature, the pane placed 112 pt below the top of the page, native clicks counted. The voice check ran there too, with the model
  downloaded by the app's own downloader. Scratch files were removed afterwards.
- **Windows:** `cargo check`, `cargo test` and `npm test` on this PC (the Windows module and every other path are unchanged).
- **Not checked:** a retina display (the scale is 2 there; the arithmetic is the same and `place` divides by the window's backing scale, but both machines above are 1x),
  macOS 12 to 14, Intel, a person using the pane with the mouse and keyboard, a Developer ID signature and notarization (no certificate yet).

## Signing and notarization (phase 2, 2026-10-13)

**Status: wired, switched off by a missing certificate.** On the Mac Mini, `security find-identity -v -p codesigning` lists only an iPhone Developer, an iPhone
Distribution (team F3772W8T7L) and an Apple Development identity: there is no "Developer ID Application". Nothing was created, revoked or changed in the Apple developer
account. Until the certificate exists, the build is ad-hoc signed with the hardened runtime and says so in the log (a notice named "Ad-hoc signed"); a downloaded copy
needs right-click, Open the first time, and an update the app downloads itself does not.

What is already in place:

- `macos-build.yml` imports a Developer ID certificate into a temporary keychain when the repository secrets **`APPLE_CERTIFICATE`** and **`APPLE_CERTIFICATE_PASSWORD`**
  exist, picks the "Developer ID Application" identity from it and passes it to `package-apaki-mac.sh` as `APAKI_SIGN_IDENTITY`. With the App Store Connect key that is
  already there (**`ASC_KEY_ID`**, **`ASC_ISSUER_ID`**, **`ASC_KEY_P8`**, the TestFlight job's) it also notarizes.
- `package-apaki-mac.sh` signs **every Mach-O in the resources** before the bundle is built, because Tauri signs only the app's own program and the notary service rejects
  any unsigned executable inside: Node, the Agent SDK's `claude`, `latch-index`, `whisper-cli`, node-pty's `pty.node` and `spawn-helper` (found by scanning, not by name; a
  build with fewer than five fails). The hardened runtime is on, a secure timestamp is added for a real identity, and the entitlements each program already had (Node
  and `claude` need JIT) are kept **minus `com.apple.security.get-task-allow`**, which Node's own build carries and notarization refuses. `claude` is a Bun program signed by Anthropic;
  re-signing it was checked (it still runs, in CI, ad-hoc); if that ever stops working the script puts Anthropic's own signature back and says so.
- Tauri signs the app with `apaki/entitlements.plist` (`device.audio-input` for the mic, `automation.apple-events` so "Sign in" and "Open in terminal" can start a
  Terminal window) and, given the API key, runs `notarytool` and staples the ticket **before** the `.dmg` and the update archive are made from the app. The script then
  signs the `.dmg`, notarizes it with `xcrun notarytool submit --wait` (the notary log is printed if Apple says no) and staples it, and finally checks the app:
  `codesign --verify --deep --strict`, no `get-task-allow`, `stapler validate`, `spctl --assess`. The workflow checks every Mach-O again and validates the stapled tickets.
- A build with a certificate but without the API key is signed and not notarized, and says so.

**What Arthur has to do** (a person with the Account Holder role; only that role can create Developer ID certificates; nothing here can be done with the API):

1. developer.apple.com > Account > Certificates, Identifiers & Profiles > Certificates > **+** > **Developer ID Application** (the G2 Sub-CA). It asks for a certificate signing
   request: on a Mac, Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority > save to disk (the private key stays in that Mac's login
   keychain). Upload it, download the `.cer`, double-click it to add it to the login keychain (the team is F3772W8T7L).
2. Keychain Access > My Certificates > "Developer ID Application: <name> (F3772W8T7L)" > right-click > Export > `.p12`, with a password.
3. Add two repository secrets (Settings > Secrets and variables > Actions, or `gh secret set`): **`APPLE_CERTIFICATE`** = the `.p12` file in base64 (`base64 -i DeveloperID.p12 | pbcopy`)
   and **`APPLE_CERTIFICATE_PASSWORD`** = its password. Record them in `~/.claude/credentials.md`.
4. Push a `mac-ci/<anything>` branch (or a `-ci` tag, `releasing.md`) and read the "Developer ID certificate" step ("signing with: Developer ID Application: ...") and the
   end of "Build the app" (the notary's `status: Accepted`, `stapler validate`). If notarytool answers 401, the App Store Connect key (`ASC_KEY_ID` `6XX38HM892`) lacks the
   access notarization needs: create a team key with the Developer role and replace `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`.
5. Release as usual (`releasing.md`). After the first signed release, the first download is a normal double-click; the Gatekeeper warning is gone.

Notes: the Tauri updater key (`TAURI_SIGNING_PRIVATE_KEY`) is separate and unchanged. Notarization needs network access to Apple and the first submissions can take several
minutes. An app already installed ad-hoc updates in place to the signed one (the updater replaces the `.app`; it has no quarantine flag).

## Phase 2: what is done, what is left

1. Browser pane: **done** (above).
2. Voice: **done** (above); the microphone prompt is untested.
3. Myrlin Glass for macOS (separate app), or Apaki's own account switching; the live-login watcher for the Keychain: open (out of scope).
4. The BROWSER shim: **done** (`apaki-open`).
5. Signing and notarization: **wired; waiting for the Developer ID certificate** (above). The updater and the GitHub Actions workflow for both platforms are done (`releasing.md`).
6. CoreML provider for the meaning index; model and index location review for a small disk: open (out of scope).
7. `hooks/prompt-relay.js` and `latch --relay` on a Mac; the `openTerminal` op once the console toggle lands: open.
8. UI wording: **done** (the table above); Cmd hints inside `setTip` content (only the hover text is rewritten now): open.
9. An Intel (x64) build: the script maps the Node checksum and the SDK package, but whisper.cpp, the entitlement check and the smoke test were only run on Apple Silicon: open.
10. A real screenshot pass of the window on a Mac (see below): open. The browser's own pictures are checked by the smoke test, which does not need Screen Recording permission.

## What the Windows packaging needed to change to the same shape (done 2026-10-13, see `windows.md`)

This is the list as it was written before the work; `windows.md` describes what was built (an NSIS installer from `tauri build`, the
hooks, the install folder, and why Glass and voice stay with the local installer). Before it, `package-apaki.ps1` and `install-apaki.ps1` assemble a folder by hand (`myrlin-apaki.exe`, `engine\`, `node\node.exe`, `bin\*.cmd`, `setup\glass`, `setup\voice`,
VC++ DLLs) and an installer script copies it. The updater needs Tauri's bundler there too:

- `tauri.windows.bundle.conf.json`, passed with `tauri build --config` exactly like the Mac one: `bundle.active`, target `nsis` (the updater supports NSIS and MSI),
  `nsis.installMode: "currentUser"` (installs to `%LOCALAPPDATA%\Programs\Myrlin Apaki`, the folder everything already assumes, including the voice folder), and
  `bundle.resources` mapping a staged `apaki/build-win/engine` to `engine` and `build-win/node` to `node`. `main.rs` already looks for `<exe dir>\engine` and
  `<exe dir>\node\node.exe`, and Tauri puts resources next to the exe, so the app needs no change.
- A `package-apaki-win.ps1` (or a shared `.mjs`) that only prepares the staging folder (node.exe, engine, production node_modules, `latch-index.exe` with its four
  VC++ DLLs, hooks) and runs `tauri build`; the Mac script's functions are the template.
- What the installer script does that NSIS has to take over: stop the background host before files are replaced and start it after (`host-ctl.js quit --when-idle`, in
  `installerHooks` pre and post install; the host already retires itself on a stamp mismatch), the PATH entry for the `apaki`, `latch` and `glass` commands (a hook, or
  drop the commands and keep the shortcuts), the App Paths registry key, the Desktop and Start menu shortcuts (NSIS makes the Start menu one), the WebView2 bootstrapper
  (`webviewInstallMode`), and the optional bundled Glass and voice installs (resources under `setup\`, copied by a hook only when absent, never over what is there).
- Existing installs made by `install-apaki.ps1` are in the same folder, so the NSIS installer upgrades them in place; the uninstall entry is new.
- The updater replaces files while the host may be running: the pre-install hook above is what keeps that safe.

## What could not be checked on the Mac Mini

The window was launched with `open` over ssh (the display is on and the user is logged in), and its state was checked from outside: the process, the on-screen window
(CoreGraphics: 1320 x 860 at the centre of the 2560 x 1440 display), the engine host's connection, the window's own saved workspace, and the engine log line
`history: read <id>.jsonl (14 lines kept)` for a pane restored from a session. `screencapture` over ssh answers "could not create image from display": the ssh
session has no Screen Recording permission. To get pictures, grant Screen Recording to `/usr/libexec/sshd-keygen-wrapper` (System Settings, Privacy and Security) or run the
capture from Terminal on the Mac, then `sips -Z 1280` before looking. The login Keychain is locked in an ssh session ("User interaction is not allowed"), so the real
Keychain item could not be created there; the same code path ran for real against a throwaway keychain file. At the Mac's own screen the first phone-access use may show the
Keychain unlock prompt once.
