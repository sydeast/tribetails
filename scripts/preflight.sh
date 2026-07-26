#!/usr/bin/env bash
# preflight.sh: does this machine have what the repo needs?
#
# Checks every tool BEFORE anything tries to use it, and for each missing one
# prints the install command for this platform. Nothing here mutates the repo.
#
# WHY THIS IS SEPARATE FROM bootstrap.sh
# bootstrap installs; preflight only reports. Keeping them apart means you can
# ask "what am I missing" on a machine you are not ready to change, and it means
# bootstrap can call this first and refuse to start rather than failing halfway
# with a message about something three steps removed from the real cause.
#
# WHAT THIS EXISTS TO PREVENT, verified rather than imagined: with no `node` on
# PATH, the first version of bootstrap.sh printed two green success lines and
# then died at exit 127 without ever naming Node, because the version probe was
# `node -v 2>/dev/null | sed ...` under `set -euo pipefail` and the redirect ate
# the only clue. Two ticks and silence reads as success.
#
# Exit codes: 0 everything required is present, 1 something required is missing.
# Optional tools never fail the run; they are reported and the reason is given.

set -uo pipefail   # deliberately NOT -e: this script's whole job is to keep
                   # going and report EVERY problem, not to stop at the first.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

grn() { printf '  \033[32m%-9s\033[0m %s\n' "$1" "$2"; }
red() { printf '  \033[31m%-9s\033[0m %s\n' "$1" "$2"; }
ylw() { printf '  \033[33m%-9s\033[0m %s\n' "$1" "$2"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

MISSING=0
NOTES=()

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *)      OS=other ;;
esac

# how_to <tool>: the install line for this platform, or a URL when there is no
# one-liner. Kept in one place so an error message can always name a next step.
how_to() {
  case "$1:$OS" in
    node:mac)      echo "brew install node@22   (or: nvm install 22)" ;;
    node:linux)    echo "nvm install 22   (see https://github.com/nvm-sh/nvm)" ;;
    npm:*)         echo "ships with Node. Installing Node installs npm." ;;
    java:mac)      echo "brew install --cask temurin@21" ;;
    java:linux)    echo "sudo apt install openjdk-21-jdk" ;;
    firebase:*)    echo "npm install -g firebase-tools" ;;
    gh:mac)        echo "brew install gh" ;;
    gh:linux)      echo "see https://github.com/cli/cli#installation" ;;
    git:mac)       echo "xcode-select --install" ;;
    git:linux)     echo "sudo apt install git" ;;
    *)             echo "see the tool's own install docs" ;;
  esac
}

# require <tool> <what it is needed for> [--optional]
# Reports presence and version. A missing REQUIRED tool sets MISSING.
require() {
  local tool="$1" why="$2" optional="${3:-}"
  local version
  if command -v "$tool" >/dev/null 2>&1; then
    # `|| true` so a tool that exits non-zero on --version cannot kill the probe.
    version="$( { "$tool" --version 2>&1 || true; } | head -1 )"
    grn "$tool" "$version"
    return 0
  fi
  if [ "$optional" = "--optional" ]; then
    ylw "$tool" "not installed. Only needed for: $why"
    NOTES+=("$tool is optional: $why. Install with: $(how_to "$tool")")
  else
    red "$tool" "MISSING. Needed for: $why"
    NOTES+=("$tool is REQUIRED: $why. Install with: $(how_to "$tool")")
    MISSING=1
  fi
  return 1
}

hdr "Required"
require git  "everything"
require node "building and testing every JS project"
require npm  "installing dependencies"

# Node MAJOR version, checked only once we know node exists. A newer Node runs
# the suites; the deployed functions runtime is what .nvmrc pins.
if command -v node >/dev/null 2>&1; then
  WANT="$(tr -dc '0-9' < .nvmrc 2>/dev/null || echo 22)"
  HAVE="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  if [ -n "$HAVE" ] && [ "$HAVE" -lt "$WANT" ] 2>/dev/null; then
    red "node ver" "v$HAVE is OLDER than the deployed runtime v$WANT"
    NOTES+=("Node v$HAVE is older than v$WANT. Run: nvm install $WANT && nvm use")
    MISSING=1
  elif [ -n "$HAVE" ] && [ "$HAVE" != "$WANT" ]; then
    ylw "node ver" "v$HAVE, deployed runtime is v$WANT. Suites run; deploys use v$WANT."
  else
    grn "node ver" "v$HAVE matches .nvmrc"
  fi
fi

hdr "Required for the emulator suites (test:rules, e2e) and Android"

# Java is checked by RUNNING it, not by `command -v`. macOS ships a
# /usr/bin/java stub that exists on a machine with no JDK at all and only fails
# when executed ("Unable to locate a Java Runtime"). A presence check passes
# there and the user then hits "Could not start Firestore Emulator", which names
# neither Java nor the fix. Gradle needs 17 or newer.
JAVA_MIN=17
if java -version >/dev/null 2>&1; then
  JAVA_VER_RAW="$(java -version 2>&1 | head -1)"
  # "21.0.11" -> 21, and legacy "1.8.0_x" -> 8
  JAVA_MAJOR="$(printf '%s' "$JAVA_VER_RAW" | sed -n 's/.*"\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p' | awk '{print ($1==1)?$2:$1}')"
  if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt "$JAVA_MIN" ] 2>/dev/null; then
    red "java" "$JAVA_VER_RAW is older than the required $JAVA_MIN"
    NOTES+=("Java $JAVA_MAJOR is too old; Gradle needs $JAVA_MIN or newer. Install with: $(how_to java)")
    MISSING=1
  else
    grn "java" "$JAVA_VER_RAW"
  fi
else
  # Distinguish "not there at all" from "the macOS stub is there but empty",
  # because the second looks installed and is the more confusing failure.
  if command -v java >/dev/null 2>&1; then
    red "java" "found at $(command -v java) but it does NOT run. No JDK is installed."
  else
    red "java" "MISSING. Needed for: Firebase emulators and Gradle"
  fi
  NOTES+=("Java is REQUIRED: Firebase emulators and Gradle builds. Without it the emulator fails with a message that never mentions Java. Install with: $(how_to java)")
  MISSING=1
fi

require firebase "test:rules, e2e, and every deploy"

hdr "Optional"
require gh "reading and opening pull requests from the terminal" --optional

# Android SDK. Not a PATH tool, so it is probed by directory.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ]; then
  case "$OS" in
    mac)   SDK="$HOME/Library/Android/sdk" ;;
    linux) SDK="$HOME/Android/Sdk" ;;
    *)     SDK="" ;;
  esac
fi
if [ -n "$SDK" ] && [ -d "$SDK" ]; then
  grn "androidsdk" "$SDK"
else
  ylw "androidsdk" "not found${SDK:+ at $SDK}. Only needed for Android builds."
  NOTES+=("Android SDK not found. Install Android Studio, or set ANDROID_HOME. Web and functions do not need it.")
fi

# gradlew must exist AND be executable, or ./gradlew is a bare "no such file".
if [ -x auntieos-admin/android/gradlew ]; then
  grn "gradlew" "present and executable"
elif [ -f auntieos-admin/android/gradlew ]; then
  ylw "gradlew" "present but NOT executable. Run: chmod +x auntieos-admin/android/gradlew"
  NOTES+=("auntieos-admin/android/gradlew is not executable. Run: chmod +x auntieos-admin/android/gradlew")
else
  ylw "gradlew" "missing"
fi

hdr "Repo"
for p in mytribe/functions mytribe/web auntieos-admin; do
  # `npm ci` REFUSES to run without a lockfile. Catch that here rather than
  # three minutes into an install.
  if [ -f "$p/package-lock.json" ]; then
    grn "$(basename "$p")" "lockfile present"
  else
    red "$(basename "$p")" "NO package-lock.json. 'npm ci' cannot run in $p"
    NOTES+=("$p has no package-lock.json. Use 'npm install' there, or restore the lockfile.")
    MISSING=1
  fi
done

if [ ${#NOTES[@]} -gt 0 ]; then
  hdr "What to do"
  for n in "${NOTES[@]}"; do printf '  - %s\n' "$n"; done
fi

printf '\n'
if [ "$MISSING" -eq 1 ]; then
  printf '\033[31mPreflight FAILED. Install the REQUIRED items above, then re-run.\033[0m\n'
  exit 1
fi
printf '\033[32mPreflight passed. Run: npm run setup\033[0m\n'
