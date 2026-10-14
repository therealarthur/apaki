#!/usr/bin/env bash
# package-apaki-mac.sh: builds Myrlin Apaki.app and its .dmg for macOS (Apple Silicon first).
#
# WHY (Arthur, 2026-10-12, "start working on the mac port"): the Windows package (package-apaki.ps1) bundles the
# window, a Node runtime, the engine with its node_modules, latch-index, Glass and voice. This is the Mac's, and it
# is a thin wrapper around the Tauri bundler on purpose: releases will be built by GitHub Actions on a version tag
# and the desktop apps will update themselves through Tauri's updater plugin, which only works for apps that Tauri's
# own bundler made. So this script only PREPARES what the app carries (as bundle.resources) and then runs
# `tauri build`; it assembles no .app by hand. A CI job can call the same script.
#
# What it prepares, all under apaki/build-mac (gitignored):
#   node/node            the official Node runtime for darwin (tarball, sha256 pinned below and verified)
#   engine/              the engine and latch together, like the Windows package: src/, bin/, apaki/engine,
#                        apaki/remote, apaki/bin, apaki/ui, apaki/web (the phone page check builds the page from
#                        them), apaki/icons/source, apaki/scripts/build-web.mjs, hooks/, package.json, and
#                        node_modules with PRODUCTION dependencies only (npm ci --omit=dev; the Agent SDK's
#                        darwin claude binary comes with it), and index/target/release/latch-index built here
#   voice/               whisper.cpp for macOS with Metal (build-whisper-mac.sh, pinned release): bin/Release/whisper-cli
#   icons/icon.icns      made from apaki/icons/source/apaki-icon-mac-1024.png with sips and iconutil
#   .tools/              the Tauri CLI from npm (not cargo install: a prebuilt binary, nothing to compile)
# tauri.macos.bundle.conf.json (next to tauri.conf.json) maps engine/, node/ and voice/ into Contents/Resources of the
# .app; main.rs finds them there. Then `tauri build` makes the .app and the .dmg.
#
# Signing (phase 2, 2026-10-13; apaki/docs/macos.md, "Signing and notarization"). Every Mach-O in the resources (node,
# the Agent SDK's claude, latch-index, whisper-cli, node-pty's pty.node and spawn-helper, anything else the scan finds)
# is signed here with the hardened runtime BEFORE the bundle is built, because Tauri signs only the app's own binary and
# the notary service rejects any unsigned executable inside. Existing entitlements are kept (node and claude need JIT)
# minus get-task-allow, which notarization refuses.
#   APAKI_SIGN_IDENTITY   unset or "-": ad-hoc (what a build without a certificate gets: runs on the Mac that built it and
#                         where the quarantine flag is cleared). "Developer ID Application: Name (TEAMID)": Developer ID,
#                         with a secure timestamp; Tauri then signs the .app, the .dmg is signed here.
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH   the App Store Connect API key (id, issuer, the .p8 file). With a Developer ID
#                         identity AND these, the .app is notarized by Tauri (notarytool, then stapled before the .dmg and
#                         the update archive are made) and the .dmg is notarized and stapled here. Without them the build is
#                         signed but not notarized, and says so.
#
# Usage: bash apaki/scripts/package-apaki-mac.sh [options]
#   --prepare-only   build the resources and stop (a CI job can cache or split the steps)
#   --bundle-only    skip the preparation; build the .app and .dmg from what is in apaki/build-mac
#   --skip-index     reuse index/target/release/latch-index instead of building it
#   --no-dmg         the .app only
#   --no-voice       leave whisper.cpp out (the mic stays off until a whisper-cli is installed by hand); a quicker build
#   --updater        also the update archive Tauri's updater downloads (Myrlin-Apaki_<version>_<arch>.app.tar.gz and its .sig,
#                    in --out). Needs the signing key in TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
#                    the release workflow passes them from repository secrets (apaki/docs/releasing.md)
#   --clean-target   delete apaki/target and index/target when done (a small disk; the products are copied out first)
#   --out DIR        where the finished .app and .dmg go (default apaki/dist)
# Environment: CARGO_HOME and CARGO_TARGET_DIR are respected; APAKI_MIN_FREE_GB (default 5) is the free disk space
# the script insists on before each big step.
#
# Runs on macOS with: Xcode command line tools, Rust (cargo), Node and npm (only to run npm ci and the Tauri CLI;
# the app itself runs on the Node it carries).

set -euo pipefail

# Pinned Node runtime. To update: take the new version and its two darwin lines from
# https://nodejs.org/dist/<version>/SHASUMS256.txt (verify that file's signature, SHASUMS256.txt.sig).
NODE_VERSION="v22.23.3"
NODE_SHA256_ARM64="23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53"
NODE_SHA256_X64="8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8"
MIN_FREE_GB="${APAKI_MIN_FREE_GB:-5}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
app="$repo/apaki"
stage="$app/build-mac"
out="$app/dist"
do_prepare=1; do_bundle=1; skip_index=0; want_dmg=1; clean_target=0; want_updater=0; want_voice=1
sign_identity="${APAKI_SIGN_IDENTITY:--}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prepare-only) do_bundle=0 ;;
    --bundle-only) do_prepare=0 ;;
    --skip-index) skip_index=1 ;;
    --no-dmg) want_dmg=0 ;;
    --no-voice) want_voice=0 ;;
    --updater) want_updater=1 ;;
    --clean-target) clean_target=1 ;;
    --out) shift; case "$1" in /*) out="$1" ;; *) out="$PWD/$1" ;; esac ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'package-apaki-mac: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'package-apaki-mac: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script builds the macOS app and runs on a Mac (uname says $(uname -s))."
case "$(uname -m)" in
  arm64) node_arch="arm64"; node_sha="$NODE_SHA256_ARM64"; bundle_arch="aarch64" ;;
  x86_64) node_arch="x64"; node_sha="$NODE_SHA256_X64"; bundle_arch="x64" ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

free_gb() { df -k "$repo" | awk 'NR==2 { printf "%d", $4 / 1024 / 1024 }'; }
need_free() {
  local f; f="$(free_gb)"
  [ "$f" -ge "$MIN_FREE_GB" ] || die "only $f GB free on this disk (APAKI_MIN_FREE_GB=$MIN_FREE_GB); free some space or lower it. Step: $1"
  say "  disk: $f GB free before: $1"
}

# A folder copy that skips build output; --delete so nothing stale ships.
mirror() {
  mkdir -p "$2"
  rsync -a --delete --exclude '.git' --exclude 'target' --exclude 'dist' --exclude '*.log' --exclude '.DS_Store' "$1/" "$2/"
}

prepare_node() {
  say "node $NODE_VERSION (darwin-$node_arch)"
  local file="node-$NODE_VERSION-darwin-$node_arch.tar.gz" cache="$stage/.cache" got
  mkdir -p "$cache" "$stage/node"
  if [ ! -f "$cache/$file" ]; then
    curl -fsSL --retry 3 -o "$cache/$file.part" "https://nodejs.org/dist/$NODE_VERSION/$file"
    mv "$cache/$file.part" "$cache/$file"
  fi
  got="$(shasum -a 256 "$cache/$file" | awk '{ print $1 }')"
  if [ "$got" != "$node_sha" ]; then
    rm -f "$cache/$file"
    die "checksum mismatch for $file: got $got, pinned $node_sha. Deleted the download; nothing was installed."
  fi
  say "  sha256 verified: $got"
  local tmp; tmp="$(mktemp -d "$cache/node-extract.XXXXXX")"
  tar -xzf "$cache/$file" -C "$tmp" "node-$NODE_VERSION-darwin-$node_arch/bin/node" "node-$NODE_VERSION-darwin-$node_arch/LICENSE"
  rm -f "$stage/node/node"
  cp "$tmp/node-$NODE_VERSION-darwin-$node_arch/bin/node" "$stage/node/node"
  cp "$tmp/node-$NODE_VERSION-darwin-$node_arch/LICENSE" "$stage/node/LICENSE"
  chmod 755 "$stage/node/node"
  rm -rf "$tmp"
  printf '# node\n\nThe official Node.js %s runtime for macOS (%s), downloaded from nodejs.org and checked against a pinned sha256 by apaki/scripts/package-apaki-mac.sh. The engine and latch run on it. LICENSE is Node'"'"'s. See ../../_WHY_THIS_IS_HERE.md\n' "$NODE_VERSION" "$node_arch" > "$stage/node/_WHY_THIS_IS_HERE.md"
}

prepare_index() {
  if [ "$skip_index" = 1 ] && [ -x "$stage/engine/index/target/release/latch-index" ]; then
    say "latch-index: keeping the one already in the staging folder"
    return 0
  elif [ "$skip_index" = 1 ] && [ -x "$repo/index/target/release/latch-index" ]; then
    say "latch-index: reusing index/target/release/latch-index"
  else
    need_free "building latch-index"
    say "latch-index: cargo build --release (the conversation search; first build takes several minutes)"
    cargo build --release --locked --manifest-path "$repo/index/Cargo.toml"
  fi
  mkdir -p "$stage/engine/index/target/release"
  cp "$repo/index/target/release/latch-index" "$stage/engine/index/target/release/latch-index"
  chmod 755 "$stage/engine/index/target/release/latch-index"
}

prepare_engine() {
  say "engine: copying sources"
  local e="$stage/engine"
  mkdir -p "$e"
  cp "$repo/package.json" "$repo/package-lock.json" "$e/"
  mirror "$repo/src" "$e/src"
  mirror "$repo/bin" "$e/bin"
  mirror "$app/engine" "$e/apaki/engine"
  # The app's one version (apaki/VERSION, apaki/scripts/version.mjs): the engine reports it (engine/app-version.js).
  cp "$app/VERSION" "$e/apaki/VERSION"
  mirror "$app/remote" "$e/apaki/remote"
  mirror "$app/bin" "$e/apaki/bin"
  # The BROWSER shim for macOS is a shell script; the executable bit must survive into the bundle.
  chmod 755 "$e/apaki/bin/apaki-open"
  # The phone page check builds the page this Apaki expects from its own window code: it needs these sources.
  mirror "$app/ui" "$e/apaki/ui"
  mirror "$app/web" "$e/apaki/web"
  mirror "$app/icons/source" "$e/apaki/icons/source"
  mkdir -p "$e/apaki/scripts"
  cp "$app/scripts/build-web.mjs" "$e/apaki/scripts/build-web.mjs"
  if [ -d "$repo/hooks" ]; then mirror "$repo/hooks" "$e/hooks"; fi
  say "engine: npm ci --omit=dev (production dependencies only)"
  need_free "npm ci"
  ( cd "$e" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$stage/.npm-cache" )
  # npm's .bin links are symlinks to scripts the app never runs; the bundler copies files, not links.
  rm -rf "$e/node_modules/.bin"
  local claude="$e/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$node_arch/claude"
  [ -f "$claude" ] || die "missing $claude: npm did not install the Agent SDK's claude binary for darwin-$node_arch"
  chmod 755 "$claude"
  # The console (apaki/engine/console.js) runs on node-pty, a native module with a prebuilt binding per platform under
  # prebuilds/ (N-API, so any Node loads it). Only this Mac's goes into the app. npm ci ran with --ignore-scripts, which
  # skips node-pty's post-install step that makes its spawn-helper executable, so that is done here. Then check it loads
  # with the Node the app carries (the script only builds for the Mac it runs on), so an installed app never finds out later.
  local pty="$e/node_modules/node-pty" d
  [ -d "$pty" ] || die "node_modules/node-pty is missing from the production install; the console needs it"
  for d in "$pty"/prebuilds/*; do
    [ -d "$d" ] || continue
    [ "$(basename "$d")" = "darwin-$node_arch" ] || rm -rf "$d"
  done
  [ -f "$pty/prebuilds/darwin-$node_arch/pty.node" ] || die "node-pty has no darwin-$node_arch prebuild"
  chmod 755 "$pty/prebuilds/darwin-$node_arch/spawn-helper" "$pty/prebuilds/darwin-$node_arch/pty.node"
  [ "$("$stage/node/node" -e "require(process.argv[1]); process.stdout.write('ok')" "$pty" 2>&1)" = "ok" ] || die "node-pty does not load with the packaged Node"
  say "  console: node-pty loads with the packaged Node"
  printf '# engine\n\nApaki'"'"'s engine and latch, copied from the repo by apaki/scripts/package-apaki-mac.sh, with production node_modules and latch-index built for this Mac. Regenerated on every package run. See ../../_WHY_THIS_IS_HERE.md\n' > "$e/_WHY_THIS_IS_HERE.md"
}

prepare_icon() {
  say "icon: apaki-icon-mac-1024.png to icon.icns"
  local set="$stage/icons/icon.iconset" src="$app/icons/source/apaki-icon-mac-1024.png" n
  rm -rf "$set"; mkdir -p "$set"
  for n in 16 32 128 256 512; do
    sips -z "$n" "$n" "$src" --out "$set/icon_${n}x${n}.png" >/dev/null
    sips -z "$((n * 2))" "$((n * 2))" "$src" --out "$set/icon_${n}x${n}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$stage/icons/icon.icns"
  rm -rf "$set"
}

prepare_tauri_cli() {
  local ver
  ver="$(awk '/^name = "tauri"$/ { getline; gsub(/[^0-9.]/, "", $0); print; exit }' "$app/Cargo.lock")"
  [ -n "$ver" ] || ver="2"
  if [ ! -x "$stage/.tools/node_modules/.bin/tauri" ]; then
    say "tauri cli: @tauri-apps/cli@$ver (npm; a prebuilt binary)"
    mkdir -p "$stage/.tools"
    [ -f "$stage/.tools/package.json" ] || printf '{"private":true}\n' > "$stage/.tools/package.json"
    ( cd "$stage/.tools" && npm install --no-save --no-audit --no-fund --cache "$stage/.npm-cache" "@tauri-apps/cli@$ver" )
  fi
}

prepare_voice() {
  mkdir -p "$stage/voice"
  if [ "$want_voice" = 1 ]; then
    need_free "building whisper.cpp"
    bash "$here/build-whisper-mac.sh" --out "$stage/voice" --cache "$stage/.cache"
  else
    say "voice: left out (--no-voice); the mic stays off until a whisper-cli is installed by hand"
    printf '# voice\n\nLeft out of this build (--no-voice). See ../../_WHY_THIS_IS_HERE.md\n' > "$stage/voice/_WHY_THIS_IS_HERE.md"
  fi
}

# ---- signing (see the header) ----
is_real_identity() { [ "$sign_identity" != "-" ]; }

# Signs one Mach-O file: hardened runtime, the entitlements it already had (minus get-task-allow), a secure timestamp
# when the identity is a real one. Quiet; returns 1 when codesign refuses.
sign_file() {
  local f="$1" tmp ents=""
  tmp="$(mktemp "$stage/.cache/ents.XXXXXX")"
  if codesign -d --entitlements :- "$f" > "$tmp" 2>/dev/null && grep -q '<plist' "$tmp"; then
    /usr/libexec/PlistBuddy -c "Delete :com.apple.security.get-task-allow" "$tmp" >/dev/null 2>&1 || true
    ents="$tmp"
  fi
  local args=(--force --options runtime)
  is_real_identity && args+=(--timestamp)
  [ -n "$ents" ] && args+=(--entitlements "$ents")
  if codesign "${args[@]}" --sign "$sign_identity" "$f" >/dev/null 2>&1; then rm -f "$tmp"; return 0; fi
  rm -f "$tmp"; return 1
}

# The Agent SDK's claude is a single-file Bun program signed by Anthropic. It is re-signed like the rest, then run once
# (--version): if signing it broke it, Anthropic's own (valid, timestamped, hardened) signature is put back.
sign_claude() {
  local c="$1" keep="$1.apaki-orig"
  cp -p "$c" "$keep"
  if sign_file "$c" && "$c" --version >/dev/null 2>&1; then
    rm -f "$keep"; say "  claude: re-signed, and it still runs"
  else
    mv -f "$keep" "$c"; say "  claude: re-signing broke it or was refused; kept Anthropic's own signature"
  fi
}

sign_nested() {
  local label="ad-hoc"; is_real_identity && label="$sign_identity"
  say "signing every Mach-O in the resources ($label, hardened runtime)"
  local n=0 f claude="$stage/engine/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$node_arch/claude"
  mkdir -p "$stage/.cache"
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    if [ "$f" = "$claude" ]; then sign_claude "$f"; else sign_file "$f" || die "could not sign $f"; fi
    codesign --verify --strict "$f" 2>/dev/null || die "the signature on $f does not verify"
    n=$((n + 1))
  done < <(find "$stage/node" "$stage/engine" "$stage/voice" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -name '*.bundle' \) -print0)
  local need=5
  [ "$want_voice" = 1 ] || need=4
  [ "$n" -ge "$need" ] || die "only $n Mach-O files were found to sign; node, claude, latch-index, pty.node (and whisper-cli) are expected"
  say "  signed $n files"
}

prepare() {
  say "preparing the bundle resources in $stage"
  mkdir -p "$stage"
  printf '# build-mac\n\nBuild staging for the macOS app (apaki/scripts/package-apaki-mac.sh); gitignored, safe to delete, regenerated by the script. node/ (Node runtime), engine/ (engine, latch, node_modules, latch-index), icons/ (icon.icns) become Contents/Resources of the .app through bundle.resources in tauri.macos.bundle.conf.json. .cache/ holds the Node download, .npm-cache/ npm'"'"'s downloads, .tools/ the Tauri CLI.\n' > "$stage/_WHY_THIS_IS_HERE.md"
  prepare_node
  prepare_index
  prepare_engine
  prepare_voice
  prepare_icon
  prepare_tauri_cli
  sign_nested
}

version() { tr -d '\r\n ' < "$app/VERSION"; }

# Signs the .dmg with the Developer ID and, when asked, notarizes it with notarytool and staples the ticket to it. Fails
# the build when Apple does not accept it (the notary log is printed).
sign_dmg() {
  local dmg="$1" notarize="$2" log id
  say "dmg: signing $(basename "$dmg")"
  codesign --force --timestamp --sign "$sign_identity" "$dmg"
  [ "$notarize" = 1 ] || return 0
  say "dmg: notarizing (notarytool, --wait; the first submissions can take several minutes)"
  log="$(xcrun notarytool submit "$dmg" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait 2>&1)" || true
  printf '%s\n' "$log" | sed 's/^/  /'
  if ! printf '%s\n' "$log" | grep -q "status: Accepted"; then
    id="$(printf '%s\n' "$log" | awk '/^ *id:/ { print $2; exit }')"
    [ -n "$id" ] && xcrun notarytool log "$id" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" 2>&1 | sed 's/^/  notary log: /' || true
    die "Apple did not accept the .dmg"
  fi
  xcrun stapler staple "$dmg" | sed 's/^/  /'
  xcrun stapler validate "$dmg" | sed 's/^/  /'
}

bundle() {
  [ -d "$stage/engine" ] && [ -x "$stage/node/node" ] && [ -d "$stage/voice" ] && [ -f "$stage/icons/icon.icns" ] || die "nothing prepared in $stage; run without --bundle-only first"
  [ -x "$stage/.tools/node_modules/.bin/tauri" ] || prepare_tauri_cli
  need_free "tauri build (the Rust app)"
  local targets="app,dmg"
  [ "$want_dmg" = 1 ] || targets="app"
  local cfg=(--config tauri.macos.bundle.conf.json) notarize=0
  if is_real_identity; then
    # A Developer ID: Tauri signs the app with it (hardened runtime, apaki/entitlements.plist from the bundle config) and,
    # given the API key, notarizes and staples it before the .dmg and the update archive are made from it.
    local sign_conf="$stage/.cache/sign.conf.json"
    mkdir -p "$stage/.cache"
    printf '{"bundle":{"macOS":{"signingIdentity":%s}}}\n' "$("$stage/node/node" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$sign_identity")" > "$sign_conf"
    cfg+=(--config "$sign_conf")
    export APPLE_SIGNING_IDENTITY="$sign_identity"
    if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ] && [ -f "${ASC_KEY_PATH:-}" ]; then
      export APPLE_API_KEY="$ASC_KEY_ID" APPLE_API_ISSUER="$ASC_ISSUER_ID" APPLE_API_KEY_PATH="$ASC_KEY_PATH"
      notarize=1
      say "signing: Developer ID, and the app will be notarized (notarytool, API key $ASC_KEY_ID)"
    else
      say "signing: Developer ID, but no App Store Connect API key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH): the app is signed, NOT notarized"
    fi
  else
    say "signing: ad-hoc (no Developer ID certificate): runs here, and elsewhere after right click, Open"
  fi
  if [ "$want_updater" = 1 ]; then
    [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || die "--updater needs the updater signing key in TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD)"
    cfg+=(--config tauri.updater.conf.json)
  fi
  say "tauri build ${cfg[*]} --bundles $targets"
  # CI=true makes the bundler skip Finder scripting (AppleScript) for the .dmg layout: it needs a logged-in desktop and
  # an Automation permission, and hangs without them (an ssh session, a runner). The .dmg is plain but complete.
  ( cd "$app" && CI=true "$stage/.tools/node_modules/.bin/tauri" build "${cfg[@]}" --bundles "$targets" )

  local target="${CARGO_TARGET_DIR:-$app/target}" ver; ver="$(version)"
  local built_app="$target/release/bundle/macos/Myrlin Apaki.app"
  [ -d "$built_app" ] || die "the bundler did not produce $built_app"
  mkdir -p "$out"
  rm -rf "$out/Myrlin Apaki.app"
  ditto "$built_app" "$out/Myrlin Apaki.app"
  local dmg
  dmg="$(ls "$target"/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
  if [ "$want_dmg" = 1 ] && [ -z "$dmg" ]; then
    # The bundler's .dmg step failed or was skipped: a plain one with hdiutil (the app and an Applications link).
    say "the bundler made no .dmg; making one with hdiutil"
    local src; src="$(mktemp -d "$stage/.cache/dmg.XXXXXX")"
    ditto "$built_app" "$src/Myrlin Apaki.app"
    ln -s /Applications "$src/Applications"
    mkdir -p "$target/release/bundle/dmg"
    dmg="$target/release/bundle/dmg/Myrlin Apaki_${ver}_${bundle_arch}.dmg"
    hdiutil create -volname "Myrlin Apaki" -srcfolder "$src" -ov -format UDZO "$dmg" >/dev/null
    rm -rf "$src"
  fi
  if [ -n "$dmg" ]; then
    cp "$dmg" "$out/"
    if is_real_identity; then sign_dmg "$out/$(basename "$dmg")" "$notarize"; fi
  fi
  if [ "$want_updater" = 1 ]; then
    # What the updater downloads: the .app as a tar.gz and its signature, named with the version and the CPU (no spaces:
    # GitHub turns a space in an asset name into a dot, and the update feed must name the file exactly as it is served).
    local upd="$target/release/bundle/macos/Myrlin Apaki.app.tar.gz"
    [ -f "$upd" ] && [ -f "$upd.sig" ] || die "the bundler made no update archive with a signature ($upd and $upd.sig); is createUpdaterArtifacts set (tauri.updater.conf.json)?"
    cp "$upd" "$out/Myrlin-Apaki_${ver}_${bundle_arch}.app.tar.gz"
    cp "$upd.sig" "$out/Myrlin-Apaki_${ver}_${bundle_arch}.app.tar.gz.sig"
    say "update archive: Myrlin-Apaki_${ver}_${bundle_arch}.app.tar.gz (+ .sig)"
  fi
  local how="ad-hoc signed (a downloaded copy needs right-click, Open the first time, until it is signed with a Developer ID and notarized)"
  if is_real_identity && [ "$notarize" = 1 ]; then how="signed with a Developer ID, notarized and stapled"; elif is_real_identity; then how="signed with a Developer ID but NOT notarized"; fi
  printf '# dist\n\nThe finished macOS build of Myrlin Apaki (apaki/scripts/package-apaki-mac.sh): Myrlin Apaki.app and its .dmg, %s. Safe to delete; regenerated by the script. Install: open the .dmg and drag the app to Applications.\n' "$how" > "$out/_WHY_THIS_IS_HERE.md"

  say "verifying the app"
  local res="$out/Myrlin Apaki.app/Contents/Resources"
  codesign --verify --deep --strict "$out/Myrlin Apaki.app" && say "  codesign: the seal is valid ($how)"
  if is_real_identity; then
    codesign -dvv "$out/Myrlin Apaki.app" 2>&1 | grep -E "^(Authority|TeamIdentifier|Timestamp)" | sed 's/^/  /' || true
    codesign -d --entitlements :- "$out/Myrlin Apaki.app" 2>/dev/null | grep -q "get-task-allow" && die "the app requests get-task-allow, which notarization refuses"
    if [ "$notarize" = 1 ]; then
      xcrun stapler validate "$out/Myrlin Apaki.app" | sed 's/^/  /' || die "the app has no stapled notarization ticket"
      spctl --assess --type execute --verbose=2 "$out/Myrlin Apaki.app" 2>&1 | sed 's/^/  spctl: /' || die "Gatekeeper does not accept the app"
    fi
  fi
  # The engine's browser tools, the shell shim and the voice program must all be in the app.
  [ -x "$res/engine/apaki/bin/apaki-open" ] || die "the BROWSER shim (apaki-open) is missing or not executable in the app"
  if [ "$want_voice" = 1 ]; then [ -x "$res/voice/bin/Release/whisper-cli" ] || die "whisper-cli is missing or not executable in the app"; fi
  [ -f "$res/engine/apaki/engine/engine.js" ] || die "engine.js is not in the app"
  "$res/node/node" --version | sed 's/^/  bundled node: /'
  [ -x "$res/engine/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$node_arch/claude" ] || die "the Claude Code binary is missing or not executable in the app"
  [ -x "$res/engine/index/target/release/latch-index" ] || die "latch-index is missing or not executable in the app"
  du -sh "$out/Myrlin Apaki.app" | awk '{ print "  app size: " $1 }'
  if [ -n "$dmg" ]; then du -sh "$out/$(basename "$dmg")" | awk '{ print "  dmg size: " $1 }'; fi
  if [ "$clean_target" = 1 ]; then
    say "cleaning the cargo target folders"
    rm -rf "$app/target" "$repo/index/target"
  fi
  say "done: $out/Myrlin Apaki.app"
}

[ "$do_prepare" = 1 ] && prepare
[ "$do_bundle" = 1 ] && bundle
exit 0
