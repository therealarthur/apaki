#!/usr/bin/env bash
# lib-ios.sh: helpers shared by the iOS pipeline scripts (apaki/mobile, 2026-10-10). Sourced, never run.
#
#   mac-update.sh      pull the branch, npm ci, build the page, cap sync
#   ios-device.sh      build and install on a USB-connected iPhone
#   ios-testflight.sh  archive and upload to TestFlight (also the cloud workflow's one build step)
#
# Written for macOS's own bash 3.2 (no associative arrays, no mapfile) and for GitHub's macOS runners.
# Exit codes of the scripts: 0 done, 1 something failed, 2 a prerequisite is missing (no team id, no
# device, no API key): fix what the message says and run it again.

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$MOBILE_DIR/ios"
XCODEPROJ="$IOS_DIR/App/App.xcodeproj"
SIGNING_XCCONFIG="$IOS_DIR/App/Signing.xcconfig"
SIGNING_LOCAL_XCCONFIG="$IOS_DIR/App/Signing.local.xcconfig"
DERIVED="$IOS_DIR/DerivedData"
BUNDLE_ID="io.myrlin.apaki"
DEFAULT_BRANCH="feat/apaki-mobile"
MIN_FREE_GB="${APAKI_MIN_FREE_GB:-5}"

say()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
# A missing prerequisite: print the message block (stdin) and stop with exit 2.
need_fail() { printf 'cannot continue: %s\n' "$1" >&2; shift; for l in "$@"; do printf '  %s\n' "$l" >&2; done; exit 2; }

repo_root() { git -C "$MOBILE_DIR" rev-parse --show-toplevel 2>/dev/null || true; }

require_mac() {
  [ "$(uname -s)" = "Darwin" ] || die "this runs on a Mac (it needs Xcode); you are on $(uname -s)."
  command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found: install Xcode, open it once, and run: sudo xcode-select -s /Applications/Xcode.app"
  xcodebuild -version >/dev/null 2>&1 || die "xcodebuild does not run (Xcode license or first-launch setup pending): open Xcode once, or run: sudo xcodebuild -license accept"
  command -v node >/dev/null 2>&1 || die "node not found (Node 20 or newer is needed)."
}

# xcconfig_get KEY: the value of KEY in Signing.local.xcconfig, else Signing.xcconfig ("" when unset or empty).
xcconfig_get() {
  local key="$1" f val=""
  for f in "$SIGNING_LOCAL_XCCONFIG" "$SIGNING_XCCONFIG"; do
    [ -f "$f" ] || continue
    val="$(awk -v k="$key" '
      { line=$0; sub(/\/\/.*/, "", line) }
      match(line, "^[ \t]*" k "[ \t]*=") { v=substr(line, RLENGTH+1); gsub(/^[ \t]+|[ \t]+$/, "", v); last=v; found=1 }
      END { if (found) print last }' "$f")"
    # Signing.local.xcconfig wins when it sets the key at all.
    if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  done
  return 0
}

# team_id: APAKI_TEAM_ID, else DEVELOPMENT_TEAM from the xcconfig files. "" when none.
team_id() {
  if [ -n "${APAKI_TEAM_ID:-}" ]; then printf '%s' "$APAKI_TEAM_ID"; else xcconfig_get DEVELOPMENT_TEAM; fi
}

valid_team() { case "$1" in [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]) return 0 ;; *) return 1 ;; esac; }

# The lines that explain what to do when there is no team id (used by need_team and the device script).
team_help() {
  cat <<'EOF'
Set your Apple team id once, in apaki/mobile/ios/App/Signing.xcconfig:
    DEVELOPMENT_TEAM = ABCDE12345
  (for this Mac only: the same line in ios/App/Signing.local.xcconfig, or run with APAKI_TEAM_ID=ABCDE12345)
Where to find it:
    paid team:  developer.apple.com > Account > Membership details > Team ID
    free team:  sign in with your Apple ID in Xcode > Settings > Accounts, then build once in Xcode, or run:
                security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
                and read OU=... (the 10 characters)
No Apple Developer Program yet? A free Apple ID works for your own iPhone over USB: apaki/mobile/README.md, "Ship it".
EOF
}

need_team() {
  local t; t="$(team_id)"
  if [ -z "$t" ]; then
    printf 'cannot continue: no Apple team id is set, so the app cannot be signed.\n' >&2
    team_help | sed 's/^/  /' >&2
    exit 2
  fi
  valid_team "$t" || die "the team id '$t' is not 10 letters and digits (check DEVELOPMENT_TEAM in Signing.xcconfig or APAKI_TEAM_ID)."
}

free_gb() { df -Pk "$MOBILE_DIR" | awk 'NR==2 { printf "%d", $4/1048576 }'; }

# need_disk: stop when less than MIN_FREE_GB (5) is free; builds here take about 1 to 2 GB.
need_disk() {
  local g; g="$(free_gb)"
  if [ "$g" -lt "$MIN_FREE_GB" ]; then
    die "only ${g} GB free (need at least ${MIN_FREE_GB} GB). Free space: rm -rf $IOS_DIR/DerivedData $IOS_DIR/build, and 'xcrun simctl delete unavailable'."
  fi
  info "disk: ${g} GB free"
}

# ensure_deps [force]: npm ci in apaki/mobile when node_modules is missing or package-lock.json changed.
ensure_deps() {
  local lock="$MOBILE_DIR/package-lock.json" stamp="$MOBILE_DIR/node_modules/.apaki-lock-hash" h
  command -v npm >/dev/null 2>&1 || die "npm not found."
  h="$(shasum -a 256 "$lock" | awk '{print $1}')"
  if [ "${1:-}" != "force" ] && [ -d "$MOBILE_DIR/node_modules/@capacitor/ios" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$h" ]; then
    info "npm ci: skipped, package-lock.json is unchanged since the last install (mac-update.sh --clean forces it)"
    return 0
  fi
  say "npm ci"
  ( cd "$MOBILE_DIR" && npm ci --no-audit --no-fund ) || die "npm ci failed (see above)."
  printf '%s' "$h" > "$stamp"
}

# build_page: the normal (never demo) web bundle, then cap sync ios.
build_page() {
  say "building the app page (node scripts/build-app.mjs)"
  ( cd "$MOBILE_DIR" && node scripts/build-app.mjs ) || die "the page build failed (see above)."
  say "cap sync ios"
  ( cd "$MOBILE_DIR" && npx --no-install cap sync ios ) || die "cap sync failed (see above)."
}

# asc_args: fill the ASC_AUTH array with xcodebuild's App Store Connect API key flags when all three
# ASC_ variables are set and the key file exists (else it stays empty and Xcode's signed-in account is used).
asc_args() {
  ASC_AUTH=()
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ] && [ -f "${ASC_KEY_PATH:-}" ]; then
    ASC_AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  fi
}

# show_errors LOG: the error lines of an xcodebuild log, then its tail, so a failure explains itself.
show_errors() {
  local log="$1"
  grep -E "error:|\*\* (BUILD|ARCHIVE|EXPORT) FAILED" "$log" | sort -u | head -30 >&2 || true
  printf -- '    (full log: %s)\n' "$log" >&2
}

# signing_hints LOG: turn the usual signing failures in an xcodebuild log into the fix.
signing_hints() {
  local log="$1"
  if grep -q "Personal development teams.*Associated Domains\|do not support the Associated Domains" "$log"; then
    warn "a free personal team cannot sign Associated Domains. Re-run with --personal (no passkeys or Universal Links in that build), or use a paid team."
  fi
  if grep -q "No Account for Team\|No signing certificate\|Failed to create provisioning profile\|No profiles for" "$log"; then
    warn "Xcode has no account for this team on this Mac. Open Xcode > Settings > Accounts, sign in with the Apple ID of the team, then run this again (for a paid team the ASC_ API key variables work instead)."
  fi
  if grep -q "Failed Registering Bundle Identifier\|is not available. Please enter a different string" "$log"; then
    warn "the bundle id $BUNDLE_ID is taken by another team (or this free team registered too many App IDs this week). Use the paid team, or change PRODUCT_BUNDLE_IDENTIFIER in Signing.xcconfig."
  fi
  if grep -q "Developer Mode disabled\|developer disk image\|device is locked\|passcode" "$log"; then
    warn "the iPhone must be unlocked and in Developer Mode (Settings > Privacy & Security > Developer Mode)."
  fi
}
