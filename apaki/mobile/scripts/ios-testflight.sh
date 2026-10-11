#!/usr/bin/env bash
# ios-testflight.sh: archive the Apaki iOS app and upload it to TestFlight in one go (apaki/mobile, 2026-10-10).
# Run on the Mac, or by the GitHub workflow (.github/workflows/ios-testflight.yml), which calls this same script.
#
#   scripts/ios-testflight.sh [--unsigned | --archive-only | --ipa] [--skip-web] [--no-commit] [--no-push] [--keep]
#
#   (default)       build number + 1, Release archive signed with your team, export with
#                   ios/ExportOptions-AppStore.plist (app-store-connect, destination upload): the build goes to
#                   App Store Connect and shows up under TestFlight after Apple has processed it (5 to 30 minutes)
#   --unsigned      the same Release archive with code signing OFF and nothing exported or uploaded: proves the
#                   project archives. Needs no team, no key, no account.
#   --archive-only  a signed archive, then stop (checks signing without uploading)
#   --ipa           export an installable ad hoc .ipa (ios/ExportOptions-AdHoc.plist) instead of uploading;
#                   install it with scripts/ios-device.sh --ipa. Needs a paid team and registered devices.
#   --skip-web      do not rebuild the page and cap sync first
#   --no-commit     after an upload, do not commit the new build number
#   --no-push       commit the new build number but do not push it
#   --keep          keep ios/build/Apaki.xcarchive after a successful upload (it is deleted otherwise)
#
# What it needs (signed modes), all from the environment, never from the repo:
#   ASC_KEY_ID      the App Store Connect API key's Key ID
#   ASC_ISSUER_ID   the Issuer ID shown above the key list
#   ASC_KEY_PATH    path to the key file AuthKey_<KEY_ID>.p8 (Apple lets you download it once; keep it out of the repo)
#   the team id     DEVELOPMENT_TEAM in ios/App/Signing.xcconfig, or APAKI_TEAM_ID
#   Create the key: App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys.
#   Access Admin is the safe choice (the key also creates the signing certificates and profiles because of
#   -allowProvisioningUpdates); App Manager can upload but may not be allowed to create certificates.
# Missing something: it names it and exits 2 before building anything. A failed step exits 1.
# The build number is CURRENT_PROJECT_VERSION in Signing.xcconfig; App Store Connect refuses one it has already
# seen for the version, so a successful upload raises it and commits that one file (and pushes it).

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-ios.sh"

MODE=upload; SKIP_WEB=0; COMMIT=1; PUSH=1; KEEP=0
for a in "$@"; do
  case "$a" in
    --unsigned) MODE=unsigned ;;
    --archive-only) MODE=archive ;;
    --ipa) MODE=ipa ;;
    --skip-web) SKIP_WEB=1 ;;
    --no-commit) COMMIT=0 ;;
    --no-push) PUSH=0 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown option $a (see: scripts/ios-testflight.sh --help)" ;;
  esac
done

require_mac

# ---- prerequisites (before anything is built) -----------------------------------------------------------------
if [ "$MODE" != unsigned ]; then
  missing=()
  [ -n "$(team_id)" ] || missing+=("missing the Apple team id: set DEVELOPMENT_TEAM in apaki/mobile/ios/App/Signing.xcconfig (or APAKI_TEAM_ID); a 10 character id, developer.apple.com > Account > Membership details")
  [ -n "${ASC_KEY_ID:-}" ] || missing+=("missing ASC_KEY_ID: the API key's Key ID (App Store Connect > Users and Access > Integrations > App Store Connect API)")
  [ -n "${ASC_ISSUER_ID:-}" ] || missing+=("missing ASC_ISSUER_ID: the Issuer ID, shown above the key list on that same page")
  if [ -z "${ASC_KEY_PATH:-}" ]; then
    missing+=("missing ASC_KEY_PATH: path to the downloaded AuthKey_<KEY_ID>.p8 (downloadable once; keep it outside the repo, for example ~/.appstoreconnect/private_keys/)")
  elif [ ! -f "$ASC_KEY_PATH" ]; then
    missing+=("ASC_KEY_PATH points to $ASC_KEY_PATH, which is not a file")
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'cannot continue: not set up for a TestFlight upload. Nothing was built and nothing was uploaded.\n' >&2
    for m in "${missing[@]}"; do printf '  %s\n' "$m" >&2; done
    printf '  Set the ASC_ variables in your shell (never in a file in the repo); the full steps are in apaki/mobile/README.md, "Ship it".\n' >&2
    printf '  To check that the project archives without any account: scripts/ios-testflight.sh --unsigned\n' >&2
    exit 2
  fi
  TEAM="$(team_id)"
  valid_team "$TEAM" || die "the team id '$TEAM' is not 10 letters and digits (check DEVELOPMENT_TEAM in Signing.xcconfig or APAKI_TEAM_ID)."
  case "$ASC_KEY_PATH" in *.p8) ;; *) warn "ASC_KEY_PATH does not end in .p8; the API key file is AuthKey_<KEY_ID>.p8." ;; esac
  ASC_AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
else
  TEAM=""; ASC_AUTH=()
fi

need_disk
CURRENT="$(xcconfig_get CURRENT_PROJECT_VERSION)"
case "$CURRENT" in ''|*[!0-9]*) die "CURRENT_PROJECT_VERSION in Signing.xcconfig is '$CURRENT', not a whole number." ;; esac
VERSION="$(xcconfig_get MARKETING_VERSION)"
if [ "$MODE" = unsigned ]; then BUILD="$CURRENT"; else BUILD="${APAKI_BUILD_NUMBER:-$((CURRENT + 1))}"; fi
say "Apaki $VERSION, build $BUILD, mode: $MODE${TEAM:+, team $TEAM}"

# ---- the page -----------------------------------------------------------------------------------------------
if [ "$SKIP_WEB" = 0 ]; then
  ensure_deps
  build_page
else
  info "skipping the page build (--skip-web)"
fi

# ---- archive ------------------------------------------------------------------------------------------------
ARCHIVE="$IOS_DIR/build/Apaki.xcarchive"
EXPORT="$IOS_DIR/build/export"
LOG="$IOS_DIR/build-archive.log"
rm -rf "$ARCHIVE" "$EXPORT"; mkdir -p "$IOS_DIR/build"
sign_args=()
if [ "$MODE" = unsigned ]; then
  sign_args=(CODE_SIGNING_ALLOWED=NO)
else
  sign_args=(-allowProvisioningUpdates "${ASC_AUTH[@]}" DEVELOPMENT_TEAM="$TEAM")
fi
say "xcodebuild archive (Release, iOS device) (log: ${LOG#"$MOBILE_DIR"/})"
set +e
xcodebuild -project "$XCODEPROJ" -scheme App -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" -archivePath "$ARCHIVE" CURRENT_PROJECT_VERSION="$BUILD" \
  "${sign_args[@]}" archive > "$LOG" 2>&1
rc=$?
set -e
if [ "$rc" != 0 ]; then show_errors "$LOG"; signing_hints "$LOG"; die "the archive failed."; fi
[ -d "$ARCHIVE" ] || die "xcodebuild said it archived but $ARCHIVE is missing."
APP="$ARCHIVE/Products/Applications/App.app"
got_id="$(plutil -extract CFBundleIdentifier raw -o - "$APP/Info.plist")"
got_ver="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist")"
got_build="$(plutil -extract CFBundleVersion raw -o - "$APP/Info.plist")"
[ "$got_build" = "$BUILD" ] || die "the archive has build $got_build, expected $BUILD (is CURRENT_PROJECT_VERSION set in the target instead of Signing.xcconfig?)."
[ -f "$APP/public/index.html" ] || die "the archived app has no web page (public/index.html): the page build or cap sync did not run."
if grep -q '"demo": *true' "$APP/public/app/build.js" 2>/dev/null; then die "the archived page is a DEMO build; run without --skip-web."; fi
info "archive: $got_id $got_ver ($got_build), $(du -sh "$ARCHIVE" | awk '{print $1}')"
if [ "$MODE" = unsigned ]; then
  say "done: the project archives (unsigned, nothing exported or uploaded). The archive is at ${ARCHIVE#"$MOBILE_DIR"/}; rm -rf it to get the space back."
  exit 0
fi
if [ "$MODE" = archive ]; then
  say "done: signed archive at ${ARCHIVE#"$MOBILE_DIR"/} (not exported, not uploaded)"
  exit 0
fi

# ---- export (and upload) ---------------------------------------------------------------------------------------
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if [ "$MODE" = ipa ]; then TEMPLATE="$IOS_DIR/ExportOptions-AdHoc.plist"; else TEMPLATE="$IOS_DIR/ExportOptions-AppStore.plist"; fi
plist="$tmp/ExportOptions.plist"
cp "$TEMPLATE" "$plist"
/usr/libexec/PlistBuddy -c "Add :teamID string $TEAM" "$plist" >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c "Set :teamID $TEAM" "$plist"
plutil -lint "$plist" >/dev/null || die "the ExportOptions plist is not valid: $TEMPLATE"
ELOG="$IOS_DIR/build-export.log"
if [ "$MODE" = ipa ]; then say "exporting an ad hoc .ipa (${TEMPLATE#"$MOBILE_DIR"/})"; else say "exporting and uploading to App Store Connect (${TEMPLATE#"$MOBILE_DIR"/})"; fi
set +e
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$plist" -exportPath "$EXPORT" \
  -allowProvisioningUpdates "${ASC_AUTH[@]}" > "$ELOG" 2>&1
rc=$?
set -e
if [ "$rc" != 0 ]; then
  show_errors "$ELOG"; signing_hints "$ELOG"
  if grep -qi "app record\|no app found\|Cannot determine the Apple ID\|does not exist" "$ELOG"; then
    warn "App Store Connect has no app record for $BUNDLE_ID yet: create it (My Apps > + > New App, bundle id $BUNDLE_ID) and run this again."
  fi
  if grep -qi "bundle version\|already been used\|must be higher\|previously used" "$ELOG"; then
    warn "App Store Connect has seen build $BUILD already: raise CURRENT_PROJECT_VERSION in Signing.xcconfig (or set APAKI_BUILD_NUMBER) and run again."
  fi
  die "the export failed; nothing was uploaded unless the log above says so."
fi
tail -4 "$ELOG" | sed 's/^/    /'

if [ "$MODE" = ipa ]; then
  IPA_FILE="$(ls "$EXPORT"/*.ipa 2>/dev/null | head -1)"
  [ -n "$IPA_FILE" ] || die "the export reported success but no .ipa is in ${EXPORT#"$MOBILE_DIR"/}."
  say "done: $IPA_FILE (install it over USB: scripts/ios-device.sh --ipa '$IPA_FILE')"
  exit 0
fi

say "uploaded: Apaki $got_ver ($BUILD) is at App Store Connect. It appears under TestFlight once Apple has processed it (5 to 30 minutes)."

# ---- remember the build number ------------------------------------------------------------------------------
sed -E "s/^([[:space:]]*CURRENT_PROJECT_VERSION[[:space:]]*=[[:space:]]*).*$/\1$BUILD/" "$SIGNING_XCCONFIG" > "$tmp/Signing.xcconfig"
cat "$tmp/Signing.xcconfig" > "$SIGNING_XCCONFIG"
info "Signing.xcconfig: CURRENT_PROJECT_VERSION = $BUILD"
REPO="$(repo_root)"
if [ "$COMMIT" = 1 ] && [ -n "$REPO" ]; then
  gitid=()
  [ -n "$(git -C "$REPO" config user.name || true)" ] || gitid+=(-c "user.name=Apaki build")
  [ -n "$(git -C "$REPO" config user.email || true)" ] || gitid+=(-c "user.email=noreply@users.noreply.github.com")
  git -C "$REPO" add -- "$SIGNING_XCCONFIG"
  if git -C "$REPO" ${gitid[@]+"${gitid[@]}"} commit -q -m "Apaki iOS: build $BUILD uploaded to TestFlight" \
       -m "Raised by scripts/ios-testflight.sh so the next upload, from the Mac or from the GitHub workflow, cannot reuse the number." -- "$SIGNING_XCCONFIG"; then
    info "committed the new build number"
    branch="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
    if [ "$PUSH" = 1 ] && [ "$branch" != HEAD ]; then
      git -C "$REPO" push -q origin "HEAD:refs/heads/$branch" \
        && info "pushed to origin/$branch" \
        || warn "could not push the build-number commit: run 'git pull --rebase' and 'git push' yourself before the next upload, or the next upload reuses $BUILD."
    else
      warn "build-number commit not pushed: push it before the next upload from another machine."
    fi
  else
    warn "could not commit the new build number; Signing.xcconfig now says $BUILD, commit it yourself."
  fi
else
  warn "Signing.xcconfig now says build $BUILD; commit and push it so the next upload does not reuse the number."
fi
if [ "$KEEP" = 0 ]; then rm -rf "$ARCHIVE" "$EXPORT"; fi
say "done"
