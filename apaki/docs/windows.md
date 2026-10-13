# Myrlin Apaki on Windows

Status: since 2026-10-13 the release build is Tauri's own NSIS installer, the same shape as the macOS app
(`apaki/docs/macos.md`). Releases are built by GitHub Actions (`.github/workflows/release.yml`, `apaki/docs/releasing.md`) and the
installed app updates itself through Tauri's updater.

## Build and install

```
powershell -File apaki\scripts\package-apaki-win.ps1            # prepares the resources, runs `tauri build`, leaves apaki\dist\Myrlin Apaki_<version>_x64-setup.exe
powershell -File apaki\scripts\package-apaki-win.ps1 -Updater    # also the update signature (needs TAURI_SIGNING_PRIVATE_KEY, see releasing.md)
```

Options: `-PrepareOnly`, `-BundleOnly`, `-SkipIndex`, `-NodeExe <path>` (a local build with a Node you already have; a release
build downloads the pinned one and checks its sha256), `-Out <dir>`. The script's header documents them. It needs Rust (MSVC),
Node and npm; the app itself runs on the Node it carries. A cold build takes about 10 minutes of compiling plus a few minutes of
NSIS compression, and about 4 GB of disk (`APAKI_MIN_FREE_GB`, default 5, is checked before each big step).

Run the installer (double-click, or `/S` for a silent install). It installs for the current user, no administrator prompt, into
`%LOCALAPPDATA%\Programs\Myrlin Apaki`: the folder `install-apaki.ps1` always used, so a PC that has the old install is upgraded in
place (the voice folder, Glass next door and `latch --relay`'s hook all look there). Tauri's stock template installs to
`%LOCALAPPDATA%\Myrlin Apaki`; `apaki/nsis/installer.nsi` is Tauri's template with that one line changed (its header says which
Tauri release it comes from, and a test fails when that stops matching the Tauri the build uses).

## What the installer carries

| Piece | In the install folder | Made by |
| - | - | - |
| the window (Rust, UI embedded) | `myrlin-apaki.exe` | `tauri build` |
| Node 22 runtime, sha256 pinned in the script | `node\node.exe` | the script |
| the engine and latch | `engine\` (`src`, `bin`, `apaki\engine`, `apaki\remote`, `apaki\bin`, `apaki\ui`, `apaki\web`, `apaki\VERSION`, `hooks`, `package.json`) | the script |
| production `node_modules` (includes the Agent SDK's `claude.exe` and node-pty's Windows binding, only that platform's) | `engine\node_modules` | `npm ci --omit=dev` |
| the conversation search and the four Visual C++ runtime DLLs it needs | `engine\index\target\release\latch-index.exe` | `cargo build --release` of `index\` |
| the commands | `bin\apaki.cmd`, `latch.cmd`, `glass.cmd` | the script |
| the installer's helper, for the uninstaller | `setup\apaki-installer.ps1` | the NSIS hooks |

`main.rs` finds the engine and Node next to the exe (`<exe dir>\engine`, `<exe dir>\node\node.exe`), so the app needed no change.
`tauri.windows.bundle.conf.json` is passed to `tauri build --config` (like the Mac's bundle file) and maps the staging folder
`apaki\build-win` (gitignored, regenerated) into the install folder.

## What the installer does around the copy (apaki\nsis\hooks.nsh and apaki-installer.ps1)

What `install-apaki.ps1` did that users need, now as NSIS hooks. None of it can fail the installation.

- **Before the files change:** asks the background engine host to exit once it is idle (`host-ctl.js quit --when-idle`, waits up to
  25 seconds) and remembers whether one ran. Anything still running from the install folder (the host's `node.exe`, `claude.exe`,
  `latch-index.exe`, a DLL) is renamed to `name.old-<time>` so the new file goes in beside it: Windows refuses to overwrite a
  running exe but allows a rename. Nothing is killed. A host that is busy with a turn keeps running from the moved-aside files,
  serves the next window, and retires once idle (it notices new files itself, `host.js` codeStamp). The leftovers are deleted at
  the end if nothing uses them.
- **After the files are in:** the `bin` folder goes on the user PATH (`apaki`, `latch`, `glass` in any new terminal),
  `App Paths\apaki.exe` is set (Win+R `apaki`), and the engine host starts again from the new files if one ran before.
- **Shortcuts and WebView2:** Tauri's template makes the Start menu shortcut (and the Desktop one for a silent or passive
  install) and installs the WebView2 runtime when a PC lacks it (Windows 11 has it).
- **Signing in:** a person at the screen on a first install (not an update, not a silent install) is asked whether to sign in to
  Claude when this PC has no login, and a console window runs `claude auth login`. It can also be done later (Sign in to Claude in
  Apaki's Glass panel, or `latch login`).
- **Uninstall:** the host is asked to exit, the commands leave the PATH, App Paths goes, and the `engine`, `node` and `bin`
  folders are removed. `voice\`, Myrlin Glass and `~\.claude\latch` (history, index, logs) stay.

An update runs the same installer in passive mode (a progress bar, no questions) from the app (`apaki/src/updater.rs`).

## Glass and voice: left to the local installer (decision, 2026-10-13)

Myrlin Glass and the whisper voice model are not in the installer, and nothing downloads them at first run.

- **Glass** is a separate app with its own repository and installer. A release built on a GitHub runner cannot reach its binaries
  (they are built from another repository), and bundling a copy would pin Glass's version to Apaki's. The app already works
  without it (`Myrlin Glass is not installed` in the Glass panel; billing stays on the live Claude login) and uses it as soon as it
  is at `%LOCALAPPDATA%\Programs\Myrlin Glass`, which is where its own installer puts it.
- **Voice** (whisper.cpp and the English model, about 150 MB) is optional and large. The mic button stays off until
  `<install folder>\voice` holds `bin\Release\whisper-cli.exe` and `models\ggml-base.en.bin`, and the installer never touches
  `voice\`, so it survives updates and uninstalls.

`package-apaki.ps1` and `install-apaki.ps1` still work and still bundle both for a PC that has them: that is the path for a
machine that wants Glass and voice installed in one go. They stay until the NSIS path has been the one in daily use for a while;
do not mix them on the same PC without reading the next section.

## Moving from install-apaki.ps1 to the installer

The folder is the same, so running the new installer over an `install-apaki.ps1` install replaces the files in place, keeps
`voice\` and Glass, and adds an uninstall entry (Settings, Apps). The PATH entry already exists and is not duplicated. The reverse
(`install-apaki.ps1` over an NSIS install) also works, but the uninstall entry then points at files the script replaced; use one
of the two.

## Not done

- **Code signing.** The installer and `myrlin-apaki.exe` are not signed, so SmartScreen warns on a downloaded installer ("Windows
  protected your PC", More info, Run anyway). An update the app downloads itself is not a browser download and is not warned about.
  Updates are verified with the updater signing key instead (releasing.md). A code signing certificate (Azure Trusted Signing or an
  OV/EV certificate) would remove the warning; `bundle.windows.signCommand` is where Tauri takes it.
- **Windows on ARM.** x64 only; an ARM PC runs it through emulation.
