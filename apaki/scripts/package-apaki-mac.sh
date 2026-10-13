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
#   icons/icon.icns      made from apaki/icons/source/apaki-icon-mac-1024.png with sips and iconutil
#   .tools/              the Tauri CLI from npm (not cargo install: a prebuilt binary, nothing to compile)
# tauri.macos.bundle.conf.json (next to tauri.conf.json) maps engine/ and node/ into Contents/Resources of the
# .app; main.rs finds them there. Then `tauri build` makes the .app and the .dmg, ad-hoc signed ("-"): there is no
# Developer ID certificate yet (apaki/docs/macos.md, "Signing and notarization", says what that needs).
#
# Usage: bash apaki/scripts/package-apaki-mac.sh [options]
#   --prepare-only   build the resources and stop (a CI job can cache or split the steps)
#   --bundle-only    skip the preparation; build the .app and .dmg from what is in apaki/build-mac
#   --skip-index     reuse index/target/release/latch-index instead of building it
#   --no-dmg         the .app only
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
do_prepare=1; do_bundle=1; skip_index=0; want_dmg=1; clean_target=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prepare-only) do_bundle=0 ;;
    --bundle-only) do_prepare=0 ;;
    --skip-index) skip_index=1 ;;
    --no-dmg) want_dmg=0 ;;
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
  if [ "$skip_index" = 1 ] && [ -x "$repo/index/target/release/latch-index" ]; then
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
  mirror "$app/remote" "$e/apaki/remote"
  mirror "$app/bin" "$e/apaki/bin"
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

prepare() {
  say "preparing the bundle resources in $stage"
  mkdir -p "$stage"
  printf '# build-mac\n\nBuild staging for the macOS app (apaki/scripts/package-apaki-mac.sh); gitignored, safe to delete, regenerated by the script. node/ (Node runtime), engine/ (engine, latch, node_modules, latch-index), icons/ (icon.icns) become Contents/Resources of the .app through bundle.resources in tauri.macos.bundle.conf.json. .cache/ holds the Node download, .npm-cache/ npm'"'"'s downloads, .tools/ the Tauri CLI.\n' > "$stage/_WHY_THIS_IS_HERE.md"
  prepare_node
  prepare_index
  prepare_engine
  prepare_icon
  prepare_tauri_cli
}

version() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$app/tauri.conf.json" | head -1; }

bundle() {
  [ -d "$stage/engine" ] && [ -x "$stage/node/node" ] && [ -f "$stage/icons/icon.icns" ] || die "nothing prepared in $stage; run without --bundle-only first"
  [ -x "$stage/.tools/node_modules/.bin/tauri" ] || prepare_tauri_cli
  need_free "tauri build (the Rust app)"
  local targets="app,dmg"
  [ "$want_dmg" = 1 ] || targets="app"
  say "tauri build --bundles $targets"
  # CI=true makes the bundler skip Finder scripting (AppleScript) for the .dmg layout: it needs a logged-in desktop and
  # an Automation permission, and hangs without them (an ssh session, a runner). The .dmg is plain but complete.
  ( cd "$app" && CI=true "$stage/.tools/node_modules/.bin/tauri" build --config tauri.macos.bundle.conf.json --bundles "$targets" )

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
  if [ -n "$dmg" ]; then cp "$dmg" "$out/"; fi
  printf '# dist\n\nThe finished macOS build of Myrlin Apaki (apaki/scripts/package-apaki-mac.sh): Myrlin Apaki.app and its .dmg, ad-hoc signed. Safe to delete; regenerated by the script. Install: open the .dmg and drag the app to Applications (a downloaded copy needs right-click, Open the first time, until it is signed with a Developer ID and notarized).\n' > "$out/_WHY_THIS_IS_HERE.md"

  say "verifying the app"
  local res="$out/Myrlin Apaki.app/Contents/Resources"
  codesign --verify --deep --strict "$out/Myrlin Apaki.app" && say "  codesign: the seal is valid (ad-hoc)"
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
