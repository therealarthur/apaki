# Releasing Myrlin Apaki

Written 2026-10-13. One version tag builds every app from one commit. Arthur's decisions (2026-10-12): GitHub Actions builds on a
version tag, on Windows and macOS runners (free for this public repository); the keys it needs are repository secrets; no Windows
code signing for now; the desktop apps update themselves through Tauri's updater from GitHub Releases; iOS stays on TestFlight;
every app keeps in step.

## To release

```
node apaki/scripts/version.mjs set 0.2.0     # apaki/VERSION and every place that carries it; refuses a mess
git commit -am "Apaki 0.2.0"
git tag v0.2.0
git push origin master v0.2.0
```

Watch it with `gh run watch`. The workflow makes a **draft** GitHub Release named "Myrlin Apaki 0.2.0" with the Windows installer,
the macOS `.dmg`, the two update archives with their signatures, `latest.json` and `SHA256SUMS.txt`. Nothing reaches users until
the draft is published (`gh release edit v0.2.0 --draft=false`, or the Releases page). The updater reads
`https://github.com/therealarthur/apaki/releases/latest/download/latest.json`, which GitHub serves only for a published,
non-prerelease release. **Draft first is deliberate**: whether Anthropic's Agent SDK terms allow distributing builds that offer
Claude subscription login is Arthur's call, so nothing is published without him.

## The one version

`apaki/VERSION` is the only file edited, through `apaki/scripts/version.mjs`. It writes `tauri.conf.json` (Windows and macOS), `Cargo.toml` and
`Cargo.lock`, the package files (latch, the Capacitor project), the iOS `MARKETING_VERSION` and the Android `versionName`, refuses a
version that is not semantic, refuses to run while the places already disagree (`--force` repairs), and writes nothing if one place
cannot be found. `version.mjs check` fails naming any place that disagrees; the workflow runs it first and `npm test` checks it.
The engine reads the same file and reports it in the window's `ready` event and the phone's `hello`.

iOS and Android show x.y.z only (a pre-release suffix is dropped there). The iOS **build number** (`CURRENT_PROJECT_VERSION`) is not
the version: every TestFlight upload raises it, and the workflow commits the new number to master.

The first version is 0.1.0, so iOS moves from the 1.0 it has been uploaded as to 0.1.0. If App Store Connect refuses a marketing
version lower than the 1.0 builds already in TestFlight, start the shared version at 1.0.0 (`version.mjs set 1.0.0`).

## What the workflow does (`.github/workflows/release.yml`)

| Job | Runs on | What |
| - | - | - |
| meta | ubuntu | the tag must be `v<apaki/VERSION>` and `version.mjs check` must pass |
| test | windows-latest | `npm test` (the suite is written for Windows: on Linux and macOS about twenty tests fail over paths and PowerShell behaviour they check on purpose; the runner's long temp folder is set because its default short name confuses the worktree tests) |
| windows | windows-latest | `package-apaki-win.ps1 -Updater`: the NSIS installer and its signature; then `smoke-win-installer.ps1` installs it silently on the runner, looks inside (files, the engine's version, node-pty, Claude Code, the search binary, PATH, App Paths), starts the app and checks it reaches its engine, and uninstalls |
| macos | macos-latest (Apple Silicon), `macos-build.yml` called from the release | `package-apaki-mac.sh --updater`: whisper.cpp (Metal), every Mach-O signed, the `.app`, the `.dmg` and the update archive with its signature. Ad-hoc signed until the Developer ID secrets exist, then Developer ID signed and notarized (`macos.md`). Then the finished app is opened on the runner and its browser driven (`mac-browser-smoke.mjs`, clicks as real mouse events and through the bridge script), and the bundled `whisper-cli` transcribes a spoken sentence |
| release | ubuntu | `latest.json` from the two signatures, `SHA256SUMS.txt`, the draft release with all files |
| phone-page | ubuntu | builds the phone page from the tagged sources (`build-web.mjs --release`) into **master's** copy of `relay/site` (which holds every earlier page), commits `relay/site/v/<version>/` to master with the workflow's own token, and deploys the relay (`npx wrangler deploy --env=""` from `relay/`). A PC checks the live page byte for byte, so a release whose page is not live would break pairing |
| ios | macos (the existing workflow) | `ios-testflight.yml` called for the same commit; the build number it raises is committed to master (the tag's commit is on no branch) |

A tag with `-ci` in it (`v0.0.0-ci.1`) is a test of the pipeline: it builds, runs the smoke test and drafts a **prerelease** named
as a test, and skips everything that changes something outside GitHub: no commit to master, no relay deploy, no TestFlight. Clean up
with `gh release delete v0.0.0-ci.1 --cleanup-tag --yes`. The app version in a test build is still `apaki/VERSION`.

The macOS build alone (no tag, no draft, nothing published) has two more ways in, because `macos-build.yml` is its own workflow:
push a branch named `mac-ci/<anything>` and it builds and tests the Mac app on every push (`gh run list --branch mac-ci/<anything>`;
download the result with `gh run download <id> -n macos`), or run it by hand from the Actions tab once the file is on master
(GitHub lists a manual workflow only from the default branch). Delete the branch afterwards.

### Secrets

Settings, Secrets and variables, Actions (`gh secret list --repo therealarthur/apaki`). Values live only there and in
`~/.claude/credentials.md` (never in the repository).

| Secret | What | Used by |
| - | - | - |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the updater's minisign key. The public half is `plugins.updater.pubkey` in `apaki/tauri.conf.json` | windows, macos |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | a token scoped to this account's Workers deploys (Workers Scripts Write, Account Settings Read; Workers Routes Write and Zone Read on myrlin.io) | phone-page |
| `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | the App Store Connect API key for TestFlight, and the same key for notarizing the Mac app and its `.dmg` (`notarytool`) | ios, macos |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | NOT SET YET. A "Developer ID Application" certificate exported as a `.p12` (the file in base64, and its password). Without them the Mac app is ad-hoc signed; with them it is signed and, given the `ASC_*` key, notarized. Exact steps: `macos.md`, "Signing and notarization" | macos |

`GITHUB_TOKEN` (the workflow's own, `contents: write` only in the jobs that need it) makes the release and pushes to master.

## How updating works for a person

- A packaged app asks the feed 45 seconds after it starts and every 4 hours (`apaki/src/updater.rs`). An app run from a source
  checkout never asks (`APAKI_UPDATE_ENDPOINT=<address>` points any build at another feed, for testing or self-hosting).
- The plugin refuses anything whose signature does not verify against the public key in the app, and anything signed for a
  different version than the feed announces (`requireSignedVersion`), so neither a swapped file nor an old signed build replayed as
  a new one installs.
- A verified update is downloaded in the background. Then one quiet card appears over the lower left of the window: "Update ready"
  with Later and Restart (`apaki/src/updater.js`, no status pill, nothing while it checks or downloads). Nothing installs without Restart.
- Restart on Windows runs the NSIS installer in passive mode and exits the app; the installer's hooks ask the background engine
  to retire once idle, move files that are still running aside, copy, and start the new app (`windows.md`). On macOS the new `.app`
  replaces the old one in place and the app restarts. Running turns survive either way: the engine host outlives the window and
  moves to the new files by itself (`host.js` codeStamp).

### The signing key

Made with `tauri signer generate` (2026-10-13). Lose the private key and no installed Apaki can take an update signed with a new
key; rotating means shipping one update signed with the old key that carries the new public key. Keep the copy in the credentials
file. The Apple Developer ID certificate (macOS) and a Windows code signing certificate are separate things that do not exist yet
(`macos.md`, `windows.md`).

## The version contract between a PC and its phones

A PC's `hello` carries `appVersion` and `minPhoneApp` (`apaki/remote/compat.js`); a native phone app under `minPhoneApp` shows
"Update the Apaki app" (Continue anyway keeps it usable), tells the PC its own version (`{ t: 'client' }`) and the PC's Phone sheet
says "Its Apaki app (x) is older than this PC wants (y)". Raise `MIN_PHONE_APP` by hand in the commit that makes the protocol or
the app's native side need a newer app; a test keeps it from going above the PC's own version. The web page has no app version
and is never flagged.

## Decisions and things only Arthur can do

- Publish the first draft (see above), after deciding the Agent SDK terms question.
- Apple: a Developer ID Application certificate for the Mac app and two repository secrets (`macos.md`, "Signing and notarization";
  everything else is wired). Until then the first download needs right-click, Open; later updates do not.
- Windows: a code signing certificate, until then SmartScreen warns on the first download.
- iOS marketing version: see "The one version".
- The release job pushes to master with the workflow's token; master has no branch protection today. If protection is added, allow
  the workflow's token to push or the phone page and the TestFlight build number will not be recorded.
