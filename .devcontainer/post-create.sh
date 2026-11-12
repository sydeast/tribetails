#!/usr/bin/env bash
# post-create.sh: finish a fresh codespace so every gate can run.
#
# Runs once per codespace (or once per prebuild). Installs only what the
# devcontainer features cannot: the Android SDK, the pinned firebase-tools,
# Claude Code, and machine-wide Gradle limits. Then hands off to the repo's own
# scripts/bootstrap.sh, which already knows how to set hooks, write
# local.properties for BOTH Gradle builds, and install every npm unit.
#
# Fails loud, in the same style as bootstrap.sh: every step announces itself
# and an early exit names the step it died in.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STEP="starting up"
finish() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    printf '\n\033[31mpost-create FAILED during: %s (exit %s)\033[0m\n' "$STEP" "$code" >&2
  fi
}
trap finish EXIT
say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

# Keep these in step with the Gradle builds and CI.
ANDROID_PLATFORM="android-37.0"        # compileSdk in both build.gradle.kts files
CMDLINE_TOOLS_BUILD="13114758"       # installed as cmdline-tools/latest
FIREBASE_TOOLS_VERSION="15.18.0"     # pinned in ci.yml, emulator behaviour moves in minors

SDK="${ANDROID_HOME:-$HOME/android-sdk}"

# ---------------------------------------------------------------------------
STEP="installing unzip"
if ! command -v unzip >/dev/null 2>&1; then
  say "$STEP"
  sudo apt-get update -qq
  sudo apt-get install -y -qq unzip >/dev/null
fi

# ---------------------------------------------------------------------------
STEP="installing Android command-line tools"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  say "$STEP into $SDK"
  mkdir -p "$SDK/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cmdline-tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip"
  unzip -q "$tmp/cmdline-tools.zip" -d "$tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
else
  say "Android command-line tools already present"
fi
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

# ---------------------------------------------------------------------------
# Licences first: with them accepted, AGP downloads whatever build-tools
# version it wants on the first build, so that version is not pinned here.
STEP="accepting Android SDK licences"
say "$STEP"
# `yes` dies of SIGPIPE once sdkmanager stops reading, which pipefail would
# report as a failure, so pipefail is off for this one line only.
set +o pipefail
yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null
set -o pipefail

STEP="installing Android SDK packages"
say "$STEP (platform-tools, platforms;$ANDROID_PLATFORM)"
# cmdline-tools is not listed: the zip above already sits at cmdline-tools/latest,
# and listing it makes sdkmanager install a second copy at latest-2.
"$SDKMANAGER" --sdk_root="$SDK" --install \
  "platform-tools" \
  "platforms;$ANDROID_PLATFORM" >/dev/null

# ---------------------------------------------------------------------------
# Machine-wide Gradle limits. The repo's gradle.properties sets parallel=true
# and a 2 GB heap per build; that is right for one build, but several agents
# each starting one is what saturated the Mac. These caps apply to every
# Gradle build in the codespace without touching committed files.
STEP="writing ~/.gradle/gradle.properties"
say "$STEP"
mkdir -p "$HOME/.gradle"
CORES="$(nproc)"
WORKERS=$(( CORES / 2 )); [ "$WORKERS" -lt 2 ] && WORKERS=2
GP="$HOME/.gradle/gradle.properties"
touch "$GP"
set_prop() {
  local key=$1 val=$2
  if grep -q "^${key}=" "$GP"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$GP"
  else
    echo "${key}=${val}" >> "$GP"
  fi
}
set_prop org.gradle.workers.max "$WORKERS"
set_prop org.gradle.caching true
set_prop kotlin.daemon.jvmargs "-Xmx1g"
echo "    workers.max=$WORKERS on a $CORES-core machine"

# ---------------------------------------------------------------------------
STEP="installing firebase-tools@$FIREBASE_TOOLS_VERSION and Claude Code"
say "$STEP"
npm install -g --no-audit --no-fund \
  "firebase-tools@$FIREBASE_TOOLS_VERSION" \
  "@anthropic-ai/claude-code" >/dev/null

# ---------------------------------------------------------------------------
# The repo's own setup: preflight, hooksPath, local.properties for both Gradle
# builds (it reads ANDROID_HOME, which devcontainer.json sets), npm ci for every
# install unit. Not duplicated here on purpose.
STEP="scripts/bootstrap.sh"
say "running $STEP"
bash scripts/bootstrap.sh

# ---------------------------------------------------------------------------
STEP="finishing"
if [ -z "${MAPBOX_DOWNLOADS_TOKEN:-}" ]; then
  printf '\n\033[33m%s\033[0m\n' \
    "MAPBOX_DOWNLOADS_TOKEN is not set, so Android Gradle builds will fail." \
    "Add it at github.com/settings/codespaces (scope it to sydeast/tribetails)," \
    "then rebuild or restart the codespace. Web and functions work without it."
fi

say "codespace ready"
cat <<'EOF'
    npm run dev:admin        admin web  (port 5174)
    npm run dev:portal       portal web (port 5173)
    npm run test:functions   functions unit tests
    npm run test:rules       Firestore rules tests (boots the emulator)
    npm run test:android     admin Android unit tests (needs the Mapbox token)
    claude                   Claude Code (sign in on first run)
EOF
