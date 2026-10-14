#!/usr/bin/env bash
# build-whisper-mac.sh: builds whisper.cpp's whisper-cli for macOS with Metal, from a pinned release.
#
# WHY (Arthur, 2026-10-13, macOS port phase 2): the mic button runs the free English Whisper model through whisper.cpp's
# command line, locally (nothing leaves the Mac). The Windows package gets whisper-cli.exe by hand; the Mac app carries its
# own so that only the model (about 141 MB, optional) is left to fetch: package-apaki-mac.sh calls this script and
# puts the result in the app's Contents/Resources/voice, where it is signed with the rest and the engine finds it
# (src/platform.js bundledVoiceDir, engine.js whisperBin).
#
# Reproducible: the release tag AND the commit it must point to are pinned below, and the script refuses to build any other.
# One static program: Metal's shader library is embedded in the binary (GGML_METAL_EMBED_LIBRARY, compiled by the GPU driver
# at first use, so no Xcode Metal toolchain and no loose .metallib file), ggml and whisper are linked in (no .dylib to sign
# or lose), and the only things it loads are system libraries (checked below). The CPU part is built for a generic Apple
# Silicon (GGML_NATIVE=OFF), so a program built on a newer chip still runs on an M1.
#
# Usage: bash apaki/scripts/build-whisper-mac.sh --out DIR [--cache DIR]
#   --out DIR    where it leaves bin/Release/whisper-cli (the layout of the Windows voice folder) and LICENSE-whisper.cpp
#   --cache DIR  where the source clone and the build live (default: a temp folder, removed at the end)
# Needs: macOS, Xcode command line tools, cmake, git. (A GitHub macOS runner has all of them.)

set -euo pipefail

WHISPER_TAG="v1.9.5"
WHISPER_COMMIT="d1be6fde11ac6e0407606b4e42fe72d34add8037"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"
DEPLOYMENT_TARGET="13.0"

out=""; cache=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; case "$1" in /*) out="$1" ;; *) out="$PWD/$1" ;; esac ;;
    --cache) shift; case "$1" in /*) cache="$1" ;; *) cache="$PWD/$1" ;; esac ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'build-whisper-mac: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

die() { printf 'build-whisper-mac: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ -n "$out" ] || die "--out DIR is required"
[ "$(uname -s)" = "Darwin" ] || die "this builds the macOS program and runs on a Mac (uname says $(uname -s))."
command -v cmake >/dev/null 2>&1 || die "cmake is not installed (brew install cmake)"
command -v git >/dev/null 2>&1 || die "git is not installed"

own_cache=0
if [ -z "$cache" ]; then cache="$(mktemp -d "${TMPDIR:-/tmp}/apaki-whisper.XXXXXX")"; own_cache=1; fi
mkdir -p "$cache" "$out/bin/Release"
src="$cache/whisper.cpp-$WHISPER_TAG"
build="$cache/whisper-build-$WHISPER_TAG"

if [ ! -d "$src/.git" ]; then
  say "whisper.cpp $WHISPER_TAG: cloning"
  rm -rf "$src"
  git clone --quiet --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$src"
fi
got="$(git -C "$src" rev-parse HEAD)"
[ "$got" = "$WHISPER_COMMIT" ] || die "tag $WHISPER_TAG points to $got, not the pinned $WHISPER_COMMIT. Nothing was built. (If the release was moved on purpose, check why, then update WHISPER_COMMIT here.)"
say "  commit verified: $got"

say "whisper.cpp: cmake (Metal, static, generic Apple Silicon)"
cmake -S "$src" -B "$build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF >/dev/null
say "whisper.cpp: building whisper-cli"
cmake --build "$build" --config Release --target whisper-cli -j "$(sysctl -n hw.ncpu)" >/dev/null

bin="$(find "$build" -type f -name whisper-cli -perm -u+x | head -1)"
[ -n "$bin" ] || die "the build did not produce whisper-cli"
cp "$bin" "$out/bin/Release/whisper-cli"
chmod 755 "$out/bin/Release/whisper-cli"
cp "$src/LICENSE" "$out/LICENSE-whisper.cpp"

# Only system libraries (and the system's Metal, Accelerate, Foundation frameworks): nothing here that needs signing or shipping.
others="$(otool -L "$out/bin/Release/whisper-cli" | tail -n +2 | awk '{ print $1 }' | grep -v -E '^(/usr/lib/|/System/Library/)' || true)"
[ -z "$others" ] || die "whisper-cli loads libraries from outside the system: $others"
"$out/bin/Release/whisper-cli" --help >/dev/null 2>&1 || "$out/bin/Release/whisper-cli" -h >/dev/null 2>&1 || die "the built whisper-cli does not run"
say "  whisper-cli: $(du -h "$out/bin/Release/whisper-cli" | awk '{ print $1 }'), runs, loads system libraries only"

printf '# voice\n\nwhisper.cpp %s (commit %s), built for macOS with Metal by apaki/scripts/build-whisper-mac.sh: bin/Release/whisper-cli is the speech-to-text program behind the mic button; LICENSE-whisper.cpp is its MIT licence. The speech model (ggml-base.en.bin, about 141 MB) is not here: it is downloaded on request into ~/Library/Application Support/Myrlin Apaki/voice/models (menu: Myrlin Apaki, Download Voice Model). Part of the app bundle; safe to delete only with the app. See ../../_WHY_THIS_IS_HERE.md\n' "$WHISPER_TAG" "$WHISPER_COMMIT" > "$out/_WHY_THIS_IS_HERE.md"
[ "$own_cache" = 1 ] && rm -rf "$cache"
exit 0
