#!/usr/bin/env bash
# ios-device.sh: build the Apaki iOS app signed with your team and install it on an iPhone plugged into
# this Mac over USB-C (apaki/mobile, 2026-10-10). Run on the Mac.
#
#   scripts/ios-device.sh [--debug|--release] [--personal] [--device NAME_OR_ID] [--no-launch] [--skip-web]
#   scripts/ios-device.sh --ipa FILE [--device NAME_OR_ID]     install a ready-made .ipa (no build, no team id)
#   scripts/ios-device.sh --list                               show the iPhones this Mac can see
#
#   --debug       (default) Debug configuration: Web Inspector on, the demo and test-link switches available
#   --release     Release configuration: what TestFlight ships
#   --personal    sign with a FREE personal Apple team: leaves out Associated Domains, which such a team cannot
#                 sign, so passkeys and Universal Links are off in that build (README, "Ship it")
#   --device X    pick the phone by name, UDID or CoreDevice id when more than one is connected
#   --skip-web    do not rebuild the page and cap sync first (mac-update.sh --no-pull is run otherwise)
#
# What it needs: the team id in ios/App/Signing.xcconfig (or APAKI_TEAM_ID), the iPhone plugged in, unlocked,
# trusted, with Developer Mode on, and Xcode signed in to the team's Apple ID (Settings > Accounts) or the
# ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH variables set (ios-testflight.sh explains them).
# With no team or no phone it says what to do and exits 2; a failed build exits 1.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-ios.sh"

CONFIG=Debug; PERSONAL=0; WANT=""; LAUNCH=1; SKIP_WEB=0; IPA=""; LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) CONFIG=Debug ;;
    --release) CONFIG=Release ;;
    --personal) PERSONAL=1 ;;
    --device) [ $# -ge 2 ] || die "--device needs a name or id"; WANT="$2"; shift ;;
    --ipa) [ $# -ge 2 ] || die "--ipa needs a file"; IPA="$2"; shift ;;
    --no-launch) LAUNCH=0 ;;
    --skip-web) SKIP_WEB=1 ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see: scripts/ios-device.sh --help)" ;;
  esac
  shift
done

require_mac
if [ "$LIST" = 1 ]; then xcrun devicectl list devices 2>&1 | grep -v -e "provisioning paramter" -e "devicectl manage create"; exit 0; fi

# ---- find the phone ---------------------------------------------------------------------------------------
# Lines: identifier, udid, name, tunnelState, transport, pairingState, developerMode, os, model (tab separated).
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
xcrun devicectl list devices --json-output "$tmp/devices.json" >/dev/null 2>&1 \
  || die "xcrun devicectl list devices failed (Xcode 15 or newer is needed)."
node -e '
  const fs = require("fs");
  const d = (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result || {}).devices || [];
  for (const x of d) {
    const hw = x.hardwareProperties || {}, cp = x.connectionProperties || {}, dp = x.deviceProperties || {};
    if (hw.platform && hw.platform !== "iOS") continue;
    if (hw.reality && hw.reality !== "physical") continue;
    // "-" for a missing field: read would otherwise collapse the tabs around an empty one.
    console.log([x.identifier, hw.udid, dp.name, cp.tunnelState, cp.transportType,
      cp.pairingState, dp.developerModeStatus, dp.osVersionNumber, hw.marketingName].map((v) => v || "-").join("\t"));
  }' "$tmp/devices.json" > "$tmp/devices.tsv"

DEV_ID=""; DEV_UDID=""; DEV_NAME=""; DEV_TRANSPORT=""; DEV_OS=""; DEV_MODEL=""; unreachable=""; devmode_off=""
while IFS="$(printf '\t')" read -r id udid name tunnel transport pairing devmode os model; do
  [ -n "$id" ] || continue
  if [ -n "$WANT" ] && [ "$WANT" != "$id" ] && [ "$WANT" != "$udid" ] && [ "${name#*"$WANT"}" = "$name" ]; then continue; fi
  if [ "$pairing" = "paired" ] && [ "$tunnel" != "unavailable" ]; then
    if [ "$devmode" = "disabled" ]; then devmode_off="$name"; continue; fi
    # First usable phone wins, a wired one over a Wi-Fi one.
    if [ -z "$DEV_ID" ] || { [ "$transport" = "wired" ] && [ "$DEV_TRANSPORT" != "wired" ]; }; then
      DEV_ID="$id"; DEV_UDID="$udid"; DEV_NAME="$name"; DEV_TRANSPORT="$transport"; DEV_OS="$os"; DEV_MODEL="$model"
    fi
  else
    unreachable="$unreachable${unreachable:+, }$name ($tunnel)"
  fi
done < "$tmp/devices.tsv"

problems=0
if [ -z "$DEV_ID" ]; then
  problems=1
  printf 'cannot continue: no iPhone is connected%s.\n' "${WANT:+ that matches \"$WANT\"}" >&2
  [ -z "$devmode_off" ] || printf '  %s is plugged in but Developer Mode is off: Settings > Privacy & Security > Developer Mode, switch it on, restart the phone when asked.\n' "$devmode_off" >&2
  [ -z "$unreachable" ] || printf '  Known to this Mac but not reachable now: %s\n' "$unreachable" >&2
  cat >&2 <<'EOF'
  1. Plug the iPhone into this Mac with USB-C and unlock it.
  2. Tap "Trust This Computer" on the phone and enter its passcode.
  3. Turn on Developer Mode: Settings > Privacy & Security > Developer Mode, then restart the phone.
  4. Run this again. xcrun devicectl list devices should show the phone as connected or available (paired).
EOF
fi

if [ -z "$IPA" ]; then
  if [ -z "$(team_id)" ]; then
    problems=1
    printf 'cannot continue: no Apple team id is set, so the app cannot be signed.\n' >&2
    team_help | sed 's/^/  /' >&2
  fi
fi
[ "$problems" = 0 ] || exit 2
[ -n "$IPA" ] || need_team

say "phone: $DEV_NAME ($DEV_MODEL, iOS $DEV_OS, ${DEV_TRANSPORT:-?})"

# ---- build ------------------------------------------------------------------------------------------------
if [ -n "$IPA" ]; then
  [ -f "$IPA" ] || die "no such file: $IPA"
  say "unpacking $IPA"
  unzip -q -o "$IPA" -d "$tmp/ipa" || die "cannot unzip $IPA (is it an .ipa?)"
  APP="$(ls -d "$tmp/ipa"/Payload/*.app 2>/dev/null | head -1)"
  [ -n "$APP" ] || die "no Payload/*.app inside $IPA"
else
  TEAM="$(team_id)"
  need_disk
  if [ "$SKIP_WEB" = 0 ]; then "$HERE/mac-update.sh" --no-pull; else info "skipping the page build (--skip-web)"; fi
  asc_args
  extra=()
  if [ "$PERSONAL" = 1 ]; then extra+=(APAKI_ENTITLEMENTS=AppPersonal.entitlements); info "personal team: Associated Domains left out (no passkeys, no Universal Links)"; fi
  if [ "${#ASC_AUTH[@]}" -gt 0 ]; then info "signing through the App Store Connect API key $ASC_KEY_ID"; else info "signing through the Apple ID signed in to Xcode (Settings > Accounts)"; fi
  LOG="$IOS_DIR/build-device.log"
  say "xcodebuild $CONFIG for $DEV_NAME with team $TEAM (log: ${LOG#"$MOBILE_DIR"/})"
  set +e
  xcodebuild -project "$XCODEPROJ" -scheme App -configuration "$CONFIG" \
    -destination "platform=iOS,id=$DEV_UDID" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates ${ASC_AUTH[@]+"${ASC_AUTH[@]}"} \
    DEVELOPMENT_TEAM="$TEAM" ${extra[@]+"${extra[@]}"} build > "$LOG" 2>&1
  rc=$?
  set -e
  if [ "$rc" != 0 ]; then
    show_errors "$LOG"; signing_hints "$LOG"
    die "the build failed."
  fi
  info "$(tail -1 "$LOG")"
  APP="$DERIVED/Build/Products/$CONFIG-iphoneos/App.app"
  [ -d "$APP" ] || die "the build reported success but $APP is missing."
fi

# ---- install and launch -----------------------------------------------------------------------------------
say "installing on $DEV_NAME"
if ! xcrun devicectl device install app --device "$DEV_ID" "$APP" > "$tmp/install.log" 2>&1; then
  cat "$tmp/install.log" >&2
  if grep -qi "locked\|passcode" "$tmp/install.log"; then warn "unlock the iPhone and run this again."; fi
  if grep -qi "profile\|trust\|signature\|integrity" "$tmp/install.log"; then warn "if the phone refuses the app: Settings > General > VPN & Device Management > your Apple ID > Trust, then run this again."; fi
  die "the install failed."
fi
tail -3 "$tmp/install.log" | sed 's/^/    /'

if [ "$LAUNCH" = 1 ]; then
  say "launching $BUNDLE_ID"
  if ! xcrun devicectl device process launch --device "$DEV_ID" --terminate-existing "$BUNDLE_ID" > "$tmp/launch.log" 2>&1; then
    cat "$tmp/launch.log" >&2
    warn "installed, but it did not launch (a locked phone, or an untrusted developer). Unlock the phone and open Apaki by hand; on a free team trust the developer first: Settings > General > VPN & Device Management."
  fi
fi
say "done: Apaki ($CONFIG) is on $DEV_NAME"
if [ "$PERSONAL" = 1 ]; then info "a free personal team's app expires after 7 days: run this script again to renew it."; fi
