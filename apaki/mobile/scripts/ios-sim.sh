#!/usr/bin/env bash
# ios-sim.sh: build the Apaki iOS app and run it in the Simulator, on the Mac
# (apaki/mobile, 2026-10-10). Run from apaki/mobile.
#
#   scripts/ios-sim.sh build [--demo]     the page (build-app.mjs), cap sync, xcodebuild (Debug, Simulator)
#   scripts/ios-sim.sh device             create or find the "Apaki iPhone 17 Pro" Simulator and boot it
#   scripts/ios-sim.sh install            install the built app on it
#   scripts/ios-sim.sh demo pair|list|chat   launch the demo mode (a demo build, Debug only)
#   scripts/ios-sim.sh launch             launch normally
#   scripts/ios-sim.sh open <url>         open a link in the Simulator (custom schemes stop at a system prompt)
#   scripts/ios-sim.sh link < file        launch with a pairing link from stdin (Debug builds, -apakiLink)
#   scripts/ios-sim.sh shot <name>        screenshot into screenshots/<name>.png, at most 1400 px tall
#   scripts/ios-sim.sh appearance light|dark
#
# The build lands in ios/DerivedData (git ignores it; delete it to get the space back).

set -euo pipefail
cd "$(dirname "$0")/.."
DEVICE_NAME="Apaki iPhone 17 Pro"
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
BUNDLE="io.myrlin.apaki"
APP="ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app"

udid() {
  xcrun simctl list devices | grep "$DEVICE_NAME (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/'
}

case "${1:-}" in
  build)
    if [ "${2:-}" = "--demo" ]; then node scripts/build-app.mjs --demo; else node scripts/build-app.mjs; fi
    npx cap sync ios
    xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/DerivedData build > ios/build.log 2>&1 \
      || { grep -E "error:" ios/build.log | head -40; tail -20 ios/build.log; exit 1; }
    tail -1 ios/build.log
    ;;
  device)
    id=$(udid)
    if [ -z "$id" ]; then
      runtime=$(xcrun simctl list runtimes | grep -E "^iOS " | tail -1 | sed -E 's/.* - (com\.apple[^ ]+).*/\1/')
      id=$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$runtime")
      echo "created $DEVICE_NAME $id (delete it with: xcrun simctl delete $id)"
    fi
    xcrun simctl boot "$id" 2>/dev/null || true
    xcrun simctl bootstatus "$id" -b >/dev/null
    echo "$id"
    ;;
  install) xcrun simctl install "$(udid)" "$APP" ;;
  demo)
    xcrun simctl terminate "$(udid)" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl launch "$(udid)" "$BUNDLE" -apakiDemo "${2:-list}"
    ;;
  launch)
    xcrun simctl terminate "$(udid)" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl launch "$(udid)" "$BUNDLE"
    ;;
  open) xcrun simctl openurl "$(udid)" "$2" ;;
  link)
    # Debug builds: launch with a pairing link (no "Open in Apaki?" prompt to tap). Reads the link from stdin.
    read -r link
    xcrun simctl terminate "$(udid)" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl launch "$(udid)" "$BUNDLE" -apakiLink "$link"
    ;;
  shot)
    mkdir -p screenshots
    tmp=$(mktemp -d)
    xcrun simctl io "$(udid)" screenshot "$tmp/shot.png" >/dev/null 2>&1
    # Never more than 1400 px on a side: images over 2000 px break the tools that read them.
    sips -Z 1400 "$tmp/shot.png" --out "screenshots/$2.png" >/dev/null
    rm -rf "$tmp"
    echo "screenshots/$2.png"
    ;;
  appearance) xcrun simctl ui "$(udid)" appearance "$2" ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
