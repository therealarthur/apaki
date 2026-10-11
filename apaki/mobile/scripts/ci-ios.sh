#!/usr/bin/env bash
# ci-ios.sh: the two small steps the GitHub workflow runs around ios-testflight.sh (apaki/mobile, 2026-10-10).
# Kept in a script so they can be tried by hand, not only in the cloud.
#
#   scripts/ci-ios.sh check       fail with a clear message when a repository secret is missing. The workflow
#                                 passes the secrets in as environment variables of the same names:
#                                   APPLE_TEAM_ID  ASC_KEY_ID  ASC_ISSUER_ID  ASC_KEY_P8
#   scripts/ci-ios.sh write-key   write ASC_KEY_P8 (the .p8 file's text, or that text in base64) to a private
#                                 temp file and hand its path to the next steps as ASC_KEY_PATH (GITHUB_ENV).
#                                 The key is never printed; the workflow deletes the file at the end.
#
# Only names are ever printed, never values.

set -euo pipefail

names="APPLE_TEAM_ID ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8"

case "${1:-}" in
  check)
    missing=""
    for n in $names; do
      v="${!n:-}"
      [ -n "$v" ] || missing="$missing $n"
    done
    if [ -n "$missing" ]; then
      msg="TestFlight upload not set up: add the repository secret(s)${missing} (Settings > Secrets and variables > Actions > New repository secret). Nothing was built and nothing was uploaded; no macOS minutes were used."
      if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::error title=Missing repository secrets::%s\n' "$msg"; else printf 'error: %s\n' "$msg" >&2; fi
      {
        echo "### TestFlight upload not run"
        echo
        echo "These repository secrets are missing:${missing}"
        echo
        echo "- \`APPLE_TEAM_ID\`: the 10 character Apple team id (developer.apple.com > Account > Membership details)"
        echo "- \`ASC_KEY_ID\`: the App Store Connect API key's Key ID"
        echo "- \`ASC_ISSUER_ID\`: the Issuer ID shown above the key list (App Store Connect > Users and Access > Integrations)"
        echo "- \`ASC_KEY_P8\`: the full text of the downloaded AuthKey_<KEY_ID>.p8 file (or that text in base64)"
        echo
        echo "Nothing was built or uploaded. Steps: apaki/mobile/README.md, \"Ship it\"."
      } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
      exit 1
    fi
    echo "all four secrets are present: $names"
    ;;
  write-key)
    [ -n "${ASC_KEY_P8:-}" ] || { echo "error: ASC_KEY_P8 is empty" >&2; exit 1; }
    [ -n "${ASC_KEY_ID:-}" ] || { echo "error: ASC_KEY_ID is empty" >&2; exit 1; }
    dir="${RUNNER_TEMP:-$(mktemp -d)}"
    key="$dir/AuthKey_${ASC_KEY_ID}.p8"
    umask 077
    case "$ASC_KEY_P8" in
      *"BEGIN PRIVATE KEY"*) printf '%s\n' "$ASC_KEY_P8" > "$key" ;;
      *) printf '%s' "$ASC_KEY_P8" | base64 --decode > "$key" 2>/dev/null || { rm -f "$key"; echo "error: ASC_KEY_P8 is neither a PEM key nor base64 of one" >&2; exit 1; } ;;
    esac
    grep -q "BEGIN PRIVATE KEY" "$key" || { rm -f "$key"; echo "error: ASC_KEY_P8 does not contain a private key (expected the text of AuthKey_<KEY_ID>.p8)" >&2; exit 1; }
    chmod 600 "$key"
    echo "wrote the API key file for key $ASC_KEY_ID (contents not shown)"
    if [ -n "${GITHUB_ENV:-}" ]; then echo "ASC_KEY_PATH=$key" >> "$GITHUB_ENV"; else echo "ASC_KEY_PATH=$key"; fi
    ;;
  *)
    sed -n '2,13p' "$0"; exit 1 ;;
esac
