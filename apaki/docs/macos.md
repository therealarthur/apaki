# Myrlin Apaki on macOS

Status: phase 1 (2026-10-12), built and run on an Apple Silicon Mac (a Mac Mini, macOS 26.2). The window, the engine host, the
session list (Claude Code transcripts under `~/.claude` and Codex threads), panes, tabs, search, settings and phone access work.
What is Windows-only today says so in one line and is listed for phase 2 below.

## Build and run

On a Mac with the Xcode command line tools, Rust (cargo), Node and npm:

```
bash apaki/scripts/package-apaki-mac.sh
```

That prepares the resources, runs `tauri build`, and leaves `apaki/dist/Myrlin Apaki.app` and `apaki/dist/Myrlin Apaki_<version>_aarch64.dmg`
(ad-hoc signed). Options: `--prepare-only`, `--bundle-only`, `--skip-index`, `--no-dmg`, `--clean-target`, `--out DIR`; the script's header
documents them. Free disk space is checked before each big step (`APAKI_MIN_FREE_GB`, default 5).

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
(never a prompt; its own throwaway keychain file).

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
| the icon | `icon.icns` | made by the script from `apaki/icons/source/apaki-icon-mac-1024.png` (the 1024 tile inset to 824 on a transparent canvas, the macOS icon grid) |

`apaki/tauri.macos.conf.json` (merged automatically on macOS) holds the window: native title bar over the page (`titleBarStyle: Overlay`,
hidden title, traffic lights at 20, 17). `apaki/tauri.macos.bundle.conf.json` is passed to `tauri build --config` and holds the bundle: targets,
`bundle.resources` (maps `build-mac/engine` and `build-mac/node` into `Contents/Resources`), the icon, the ad-hoc signing identity. It is a
separate file so a plain `cargo build` or `cargo test` on a Mac needs none of the staging folders. `main.rs` finds the engine and Node in
`Contents/MacOS/../Resources` (`mac::bundle_dirs`) as well as next to the executable (the Windows layout).

### What was left alone on purpose: apaki/ui

Everything in `apaki/ui/*.js` and `*.css` is also the phone page (`apaki/scripts/build-web.mjs` hashes it), and a PC only shows a pairing code
when the site serves the exact page its own sources build (`remote-page.js`). A change under `apaki/ui` changes the page version on every platform,
so Windows would stop pairing until a new page is published (`build-web.mjs --release`, deploy the relay). The Mac's small differences live in
the shell instead (`src/mac.js`, injected as a plugin init script), and the page check passes on the Mac against the published
version (2f75d4687fea, 57 files, checked 2026-10-12). `ui/phone.js` is the one UI file edited (the Keychain wording): it is desktop-only and not part of the phone page.

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

## Phase 2

1. Browser pane: a WKWebView based browser with its own driver (no CDP): Playwright's WebKit remote protocol, or a small JS bridge; `browser.rs` gets a macOS implementation behind the same `features()` contract.
2. Voice: a whisper.cpp build for macOS (Metal), bundled and signed; the model download.
3. Myrlin Glass for macOS (separate app), or Apaki's own account switching; the live-login watcher for the Keychain.
4. The BROWSER shim as a shell script (`apaki-open`), once the browser pane exists.
5. Signing and notarization (below). The updater and the GitHub Actions workflow for both platforms are done (2026-10-13, `releasing.md`).
6. CoreML provider for the meaning index; model and index location review for a small disk.
7. `hooks/prompt-relay.js` and `latch --relay` on a Mac; the `openTerminal` op once the console toggle lands.
8. UI wording (Explorer, Windows, PC) together with the next phone page publish; Cmd hints inside `setTip` content (only the hover text is rewritten now).
9. An Intel (x64) build: the script already maps the Node checksum and the SDK package; untested.
10. A real screenshot pass: see below.

## Signing and notarization (phase 2)

There is no Developer ID certificate yet, so the app is ad-hoc signed (`signingIdentity: "-"`): it runs on the Mac that built it and on a Mac where the
quarantine flag is removed or the app is opened with right click, Open the first time. A downloaded copy is otherwise refused by Gatekeeper.

What a signed and notarized build needs:

- A **Developer ID Application** certificate for the team **F3772W8T7L**, exported as a .p12 for CI (`APPLE_CERTIFICATE` base64, `APPLE_CERTIFICATE_PASSWORD`),
  and `APPLE_SIGNING_IDENTITY` ("Developer ID Application: <name> (F3772W8T7L)"). Tauri signs the app and, with those variables set, notarizes it.
- **notarytool with the App Store Connect API key**: `APPLE_API_ISSUER` (issuer id), `APPLE_API_KEY` (key id), `APPLE_API_KEY_PATH` (the .p8). Tauri runs
  `notarytool submit --wait` and staples the ticket to the app and the .dmg when these are set (the build log already says it skips notarization without them).
- **Hardened runtime** (Tauri turns it on for a real identity) and an **entitlements file** (`bundle.macOS.entitlements`) with
  `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory` (Node's V8 and the Bun-built `claude` binary need
  them), and `com.apple.security.cs.disable-library-validation` only if a binary loads an unsigned dylib (none does today: ONNX Runtime is linked statically).
- **Every Mach-O in the resources must be signed too.** Notarization rejects unsigned or differently signed executables anywhere in the bundle, and Tauri
  signs only the main binary and the bundle. `node`, `claude` (from the Agent SDK package, signed by Anthropic, so it must be re-signed), and `latch-index`
  need `codesign --force --options runtime --timestamp --entitlements <file> -s "<identity>"` in `package-apaki-mac.sh` after the resources are staged (signatures survive the copy
  into the bundle), or they can move to `bundle.externalBin`, which Tauri signs itself.
- The Tauri updater needs its own minisign key pair (`TAURI_SIGNING_PRIVATE_KEY`), unrelated to the Apple certificate. Done 2026-10-13: the updater plugin is in the app,
  `package-apaki-mac.sh --updater` leaves the `.app.tar.gz` and its `.sig`, and the release workflow builds, signs and publishes them (`apaki/docs/releasing.md`).
  Until a Developer ID certificate exists, an update the app downloads itself replaces the ad-hoc signed `.app` in place (no quarantine flag, so Gatekeeper does not stop
  it); only the first download, from a browser, needs the right-click, Open step.
- Notarization needs network access to Apple; the first submissions can take several minutes.

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
