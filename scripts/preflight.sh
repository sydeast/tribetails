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

# local.properties, per Gradle build that needs an SDK.
#
# It is gitignored (machine-specific path, and on a real machine also signing
# passwords), so a git worktree NEVER inherits one from the main tree and Gradle
# refuses to configure without it:
#
#   SDK location not found. Define a valid SDK location with an ANDROID_HOME
#   environment variable or by setting the sdk.dir path in your project's local
#   properties file
#
# bootstrap.sh has written these all along, and its own header already names
# this case. What was missing is anyone running it in a worktree: three separate
# agents hit that error on 2026-08-07 and each worked around it by exporting
# ANDROID_HOME for one command, which fixes that command and leaves the next one
# broken. Reporting it here turns a step someone has to remember into one the
# machine check names.
#
# TWO builds, not three. auntieos-admin/web is a Gradle build with NO android
# target (no androidTarget(), no com.android plugin), so it needs no sdk.dir and
# a local.properties there is vestigial. Listing it would invent a requirement
# that does not exist.
for ANDROID_LOCAL in auntieos-admin/android/local.properties mytribe/local.properties; do
  if [ -f "$ANDROID_LOCAL" ]; then
    grn "localprops" "$ANDROID_LOCAL present"
  else
    ylw "localprops" "$ANDROID_LOCAL missing. Gradle cannot configure without it."
    NOTES+=("$ANDROID_LOCAL is missing, so Android builds and unit tests fail with 'SDK location not found'. Run: scripts/bootstrap.sh (safe to re-run, never overwrites an existing file).")
  fi
done

# THE PYTHON CODEBASE, which nothing else in this repo sets up.
#
# `auntieos-admin/web/firebase.json` declares a second functions codebase,
# `reconcile`, on a pinned Python runtime. Deploying it needs an interpreter of
# exactly that version AND a venv beside its source, and the Firebase CLI builds
# neither: it discovers endpoints by RUNNING the code out of
# `functions-python/venv`, so a missing venv stops the deploy with
#
#   Error: Failed to find location of Firebase Functions SDK: Missing virtual
#   environment at venv directory. Did you forget to run 'python3.13 -m venv venv'?
#
# On 2026-08-05 that ended a release after 25 minutes of successful function
# deploys, on a machine that had Python 3.14 and no 3.13. bootstrap.sh does not
# create this venv and never has; it was set up by hand once and nothing
# recorded that.
#
# OPTIONAL, DELIBERATELY. The reconcile codebase only ships under
# RELEASE_INCLUDE_ADMIN_FUNCTIONS=1, so a machine that never deploys it is not
# broken for lacking this. Failing here would fail every ordinary release and CI.
#
# THE VERSION IS READ FROM firebase.json, not written here. A runtime bump would
# otherwise leave this check quietly validating the old interpreter, which is
# the same failure it exists to prevent.
PYFN="auntieos-admin/web/functions-python"
PYCFG="auntieos-admin/web/firebase.json"
if [ -d "$PYFN" ] && [ -f "$PYCFG" ] && command -v node >/dev/null 2>&1; then
  # "python313" -> "3.13". Empty when the codebase is gone or is not Python.
  PYVER="$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const fns = Array.isArray(cfg.functions) ? cfg.functions : [cfg.functions];
      const py = fns.find((f) => f && typeof f.runtime === "string" && f.runtime.startsWith("python"));
      if (!py) process.exit(0);
      const m = /^python(\d)(\d+)$/.exec(py.runtime);
      if (m) console.log(m[1] + "." + m[2]);
    } catch {}
  ' "$PYCFG" 2>/dev/null)"

  if [ -n "$PYVER" ]; then
    PYBIN="python$PYVER"
    VENVPY="$PYFN/venv/bin/$PYBIN"
    if ! command -v "$PYBIN" >/dev/null 2>&1; then
      ylw "$PYBIN" "not found. Only needed to deploy the 'reconcile' codebase."
      NOTES+=("$PYBIN is missing, so the 'reconcile' Python functions cannot deploy (RELEASE_INCLUDE_ADMIN_FUNCTIONS=1). Install with: brew install python@$PYVER")
    elif [ ! -d "$PYFN/venv" ]; then
      ylw "reconcile" "no venv. The Firebase CLI runs this codebase to find its endpoints."
      NOTES+=("$PYFN has no venv. Run: (cd $PYFN && $PYBIN -m venv venv && venv/bin/pip install -r requirements.txt)")
    elif [ ! -x "$VENVPY" ]; then
      # A venv built by a DIFFERENT interpreter has no bin/python<pinned>, so
      # this catches the runtime having moved out from under an old venv.
      ylw "reconcile" "venv exists but was not built with $PYBIN"
      NOTES+=("$PYFN/venv does not carry $PYBIN, so it was built by another interpreter. Rebuild: (cd $PYFN && rm -rf venv && $PYBIN -m venv venv && venv/bin/pip install -r requirements.txt)")
    elif [ -f "$PYFN/requirements.txt" ] && ! "$VENVPY" -c 'import firebase_functions' >/dev/null 2>&1; then
      ylw "reconcile" "venv present but its requirements are not installed"
      NOTES+=("$PYFN/venv cannot import firebase_functions. Run: $PYFN/venv/bin/pip install -r $PYFN/requirements.txt")
    else
      grn "reconcile" "$PYBIN and its venv are ready"
    fi
  fi
fi

hdr "Repo"

# mytribe/functions is NOT an npm workspace member (PR25a): Cloud Functions
# deploy as a self-contained artifact with their own package.json and
# lockfile, and hoisting their deps into the root tree would ship a broken
# deploy. It keeps its own lockfile and install, checked exactly as before.
p="mytribe/functions"

# `npm ci` REFUSES to run without a lockfile. Catch that here rather than
# three minutes into an install.
if [ -f "$p/package-lock.json" ]; then
  grn "$(basename "$p")" "lockfile present"
else
  red "$(basename "$p")" "NO package-lock.json. 'npm ci' cannot run in $p"
  NOTES+=("$p has no package-lock.json. Use 'npm install' there, or restore the lockfile.")
  MISSING=1
fi

# IS WHAT IS INSTALLED WHAT THE LOCKFILE SAYS?
#
# A lockfile can be present and correct while node_modules is neither. On
# 2026-08-04 PR #250 swapped `googleapis` for `@googleapis/calendar`, the
# release ran on a checkout that had never installed it, and `npm run check`
# died 90 seconds in with nine TS2307/TS7006 errors naming a module rather
# than naming the real problem. Nothing before that point looked wrong: the
# tree was clean, the lockfile was present, CI was green (CI installs from
# scratch, so CI can never see this).
#
# NO node_modules AT ALL IS NOT A FAILURE. That is the state of a fresh clone,
# and bootstrap.sh runs this script before it installs anything. Failing there
# would refuse to start the very thing that fixes it. Only a PARTIAL or STALE
# install fails, because that is the state that lies.
if [ ! -d "$p/node_modules" ]; then
  ylw "$(basename "$p")" "not installed yet. 'npm run setup' will do it."
  NOTES+=("$p has no node_modules. Run 'npm run setup' (or 'npm ci' in $p).")
elif ! command -v node >/dev/null 2>&1; then
  ylw "$(basename "$p")" "installed, but node is missing so it cannot be verified"
else
  # Every name in package.json against what is on disk, and each one's version
  # against the lockfile's resolved entry. Reports the first few by name: an
  # operator who can read "@googleapis/calendar" fixes this in one command.
  DRIFT="$(node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
    let pj, lock;
    try { pj = read("package.json"); lock = read("package-lock.json"); }
    catch { process.exit(0); }
    const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    const locked = lock.packages || {};
    const bad = [];
    for (const name of Object.keys(want)) {
      const p = path.join(root, "node_modules", name, "package.json");
      if (!fs.existsSync(p)) { bad.push(name + " (absent)"); continue; }
      const want2 = locked["node_modules/" + name];
      if (!want2 || !want2.version) continue;
      let got;
      try { got = JSON.parse(fs.readFileSync(p, "utf8")).version; } catch { continue; }
      if (got !== want2.version) bad.push(name + " (" + got + ", lockfile says " + want2.version + ")");
    }
    if (bad.length) console.log(bad.slice(0, 4).join(", ") + (bad.length > 4 ? ", +" + (bad.length - 4) + " more" : ""));
  ' "$p" 2>/dev/null)"
  if [ -z "$DRIFT" ]; then
    grn "$(basename "$p")" "lockfile present, install matches it"
  else
    red "$(basename "$p")" "install does NOT match the lockfile: $DRIFT"
    NOTES+=("$p is installed but out of sync with its lockfile ($DRIFT). Run: npm ci --prefix $p")
    MISSING=1
  fi
fi

# mytribe/web, auntieos-admin, and packages/geo ARE npm workspace members
# (PR25a): one lockfile and one node_modules at the repo root cover all
# three, and it's how both apps reach @tribetails/geo. Checked as ONE
# workspace, not per-app: `npm ci` at the root installs (or fails) for all
# three together.
if [ -f package-lock.json ]; then
  grn "workspace" "root package-lock.json present (mytribe/web, auntieos-admin, packages/geo)"
else
  red "workspace" "NO root package-lock.json. 'npm ci' cannot run for mytribe/web, auntieos-admin, or packages/geo"
  NOTES+=("Root package-lock.json is missing. Run 'npm install' at the repo root.")
  MISSING=1
fi

if [ ! -d node_modules ]; then
  ylw "workspace" "not installed yet. 'npm run setup' will do it."
  NOTES+=("Root node_modules is missing. Run 'npm run setup' (or 'npm ci' at the repo root).")
elif ! command -v node >/dev/null 2>&1; then
  ylw "workspace" "installed, but node is missing so it cannot be verified"
else
  # Same idea as the functions check above, run over the three workspace
  # package.jsons against the ROOT lockfile. Node resolution is approximated,
  # not modeled exactly: check each app's own node_modules first (npm nests
  # a dep there only when a version conflict forces it), then fall back to
  # the hoisted root node_modules.
  DRIFT="$(node -e '
    const fs = require("fs"), path = require("path");
    const dirs = ["mytribe/web", "auntieos-admin", "packages/geo"];
    let lock;
    try { lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")); }
    catch { process.exit(0); }
    const locked = lock.packages || {};
    const bad = [];
    for (const dir of dirs) {
      let pj;
      try { pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }
      catch { continue; }
      const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
      for (const name of Object.keys(want)) {
        // @tribetails/geo itself is a workspace symlink to packages/geo, not
        // a versioned install; it has no lockfile "version" to drift against.
        if (name === "@tribetails/geo") continue;
        let found = path.join(dir, "node_modules", name, "package.json");
        if (!fs.existsSync(found)) found = path.join("node_modules", name, "package.json");
        if (!fs.existsSync(found)) { bad.push(dir + "/" + name + " (absent)"); continue; }
        const entry = locked[dir + "/node_modules/" + name] || locked["node_modules/" + name];
        if (!entry || !entry.version) continue;
        let got;
        try { got = JSON.parse(fs.readFileSync(found, "utf8")).version; } catch { continue; }
        if (got !== entry.version) bad.push(dir + "/" + name + " (" + got + ", lockfile says " + entry.version + ")");
      }
    }
    if (bad.length) console.log(bad.slice(0, 4).join(", ") + (bad.length > 4 ? ", +" + (bad.length - 4) + " more" : ""));
  ' 2>/dev/null)"
  if [ -z "$DRIFT" ]; then
    grn "workspace" "lockfile present, install matches it"
  else
    red "workspace" "install does NOT match the lockfile: $DRIFT"
    NOTES+=("The workspace install is out of sync with root package-lock.json ($DRIFT). Run: npm ci")
    MISSING=1
  fi
fi

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
