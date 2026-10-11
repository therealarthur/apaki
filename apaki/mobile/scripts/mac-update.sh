#!/usr/bin/env bash
# mac-update.sh: one command on the Mac after a push (apaki/mobile, 2026-10-10).
#
#   scripts/mac-update.sh [--no-pull] [--clean] [branch]
#
#   1. git fetch, check out the branch (default feat/apaki-mobile, or the current one) and fast-forward it
#      to origin. It never discards local work: if the branch cannot fast-forward it stops and says why.
#   2. npm ci in apaki/mobile (skipped when package-lock.json is unchanged since the last install;
#      --clean forces it).
#   3. the web bundle: node scripts/build-app.mjs (a normal build, never the demo).
#   4. cap sync ios: copies the bundle and plugin config into the Xcode project.
#
#   --no-pull   skip step 1 (ios-device.sh and ios-testflight.sh call it that way)
#
# Safe to run any number of times. Exit 0 done, 1 failed. Needs Node 20+ and the repo cloned on the Mac.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-ios.sh"

PULL=1; CLEAN=0; BRANCH=""
for a in "$@"; do
  case "$a" in
    --no-pull) PULL=0 ;;
    --clean)   CLEAN=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*)        die "unknown option $a (see: scripts/mac-update.sh --help)" ;;
    *)         BRANCH="$a" ;;
  esac
done

require_mac
need_disk
REPO="$(repo_root)"
[ -n "$REPO" ] || die "$MOBILE_DIR is not inside a git checkout."

if [ "$PULL" = 1 ]; then
  say "pulling"
  current="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  [ -n "$BRANCH" ] || BRANCH="${APAKI_BRANCH:-}"
  if [ -z "$BRANCH" ]; then
    if [ "$current" = "HEAD" ]; then BRANCH="$DEFAULT_BRANCH"; else BRANCH="$current"; fi
  fi
  before="$(git -C "$REPO" rev-parse --short HEAD)"
  git -C "$REPO" fetch --quiet origin "$BRANCH" || die "git fetch origin $BRANCH failed (network, or the branch is not on origin)."
  if [ "$current" != "$BRANCH" ]; then
    git -C "$REPO" checkout --quiet "$BRANCH" 2>/dev/null \
      || git -C "$REPO" checkout --quiet -b "$BRANCH" "origin/$BRANCH" \
      || die "cannot check out $BRANCH (local changes in the way? run: git -C $REPO status)."
  fi
  if ! git -C "$REPO" merge --ff-only --quiet "origin/$BRANCH"; then
    die "$BRANCH cannot fast-forward to origin/$BRANCH (local commits or edits conflict). Look at: git -C $REPO status. To take origin's version and drop local work: git -C $REPO reset --hard origin/$BRANCH"
  fi
  after="$(git -C "$REPO" rev-parse --short HEAD)"
  if [ "$before" = "$after" ]; then info "$BRANCH already at $after"; else info "$BRANCH $before -> $after"; git -C "$REPO" log --oneline "$before..$after" | head -8 | sed 's/^/    /'; fi
else
  info "skipping the pull (--no-pull); building what is checked out: $(git -C "$REPO" rev-parse --short HEAD)"
fi

if [ "$CLEAN" = 1 ]; then ensure_deps force; else ensure_deps; fi
build_page

# cap sync rewrites some generated files; say so if it touched anything git tracks.
changed="$(git -C "$REPO" status --short -- "$MOBILE_DIR/ios" "$MOBILE_DIR/android" | grep -v '^??' || true)"
if [ -n "$changed" ]; then warn "tracked files changed (cap sync, or local edits):"; printf '%s\n' "$changed" | sed 's/^/    /' >&2; fi
say "done: page built and synced into ios/ ($(git -C "$REPO" rev-parse --short HEAD))"
