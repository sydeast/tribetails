#!/usr/bin/env bash
# bootstrap.sh: take a fresh clone to a state where every gate can run.
#
# Everything here used to be a paragraph in the runbook telling a human to
# remember something. A step a person has to remember is a step that gets
# skipped, and two of these have already been skipped in practice: a clone with
# no hooksPath commits straight past the credential scan, and a worktree with no
# local.properties cannot build Android at all.
#
# Safe to re-run. Every step is idempotent and says what it did.
#
# FAIL LOUD, NEVER SILENTLY. The first version of this script probed Node with
# `node -v 2>/dev/null | sed ...` under `set -euo pipefail`. On a machine with no
# Node the pipeline failed, `set -e` killed the script, and the redirect ate the
# only clue: it printed two green success lines, exited 127, and installed
# nothing. Two ticks and silence reads as success, which is the exact failure
# mode CLAUDE.md bans. Every step below announces itself, and any exit that is
# not the clean end of the script says which step it died in.
#
#   scripts/preflight.sh   check the machine, change nothing
#   scripts/bootstrap.sh   check, then set the repo up
#   SKIP_PREFLIGHT=1       set up without the tool check (not recommended)
#   FORCE_INSTALL=1        reinstall dependencies that are already present

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# The SAME comparison preflight.sh reports with, so step 3 can decide WHICH
# install units are actually stale rather than trusting a single aggregate
# exit code (drift in one unit must not force a reinstall of a sibling that
# was already fine -- a root reinstall over a mytribe/functions-only drift
# wastes minutes for nothing).
# shellcheck source=scripts/lib/dep-drift.sh
. "$ROOT/scripts/lib/dep-drift.sh"

STEP="starting up"
finish() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    red ""
    red "bootstrap FAILED during: $STEP (exit $code)"
    red "Run scripts/preflight.sh to see what this machine is missing."
  fi
}
trap finish EXIT

# ---------------------------------------------------------------------------
# 0. Preflight.
# ---------------------------------------------------------------------------
# Refuse to start rather than failing three steps later with a message about
# something removed from the real cause.
#
# EXCEPT WHEN THE ONLY THING WRONG IS DEPENDENCY DRIFT. On 2026-09-13 preflight
# correctly reported that node_modules did not match a lockfile a Dependabot
# PR had moved (vitest 4 -> 5, ~20 other packages) and this step refused to
# start on the strength of that report, which stopped the ONE thing that
# fixes drift (installing) because of the drift itself. The operator ran
# `npm ci` and `npm ci --prefix mytribe/functions` by hand to get past it.
#
# preflight.sh now exits 2, not 1, for exactly that case (see its own exit-code
# comment and scripts/lib/dep-drift.sh), so this step can tell "only drift" from
# "something installing will not fix" and act differently: proceed to step 3
# for the first, still refuse for the second. PREFLIGHT_RC is read again after
# step 3 installs, to prove the drift is actually gone rather than assuming it.
STEP="preflight (checking installed tools)"
PREFLIGHT_RC=0
if [ -z "${SKIP_PREFLIGHT:-}" ]; then
  set +e
  bash scripts/preflight.sh
  PREFLIGHT_RC=$?
  set -e
  case "$PREFLIGHT_RC" in
    0)
      printf '\n'
      ;;
    2)
      ylw ""
      ylw "preflight: the only failure above is dependency drift (node_modules"
      ylw "  out of sync with a lockfile). That is exactly what installing fixes,"
      ylw "  so continuing rather than refusing to start the fix for it."
      printf '\n'
      ;;
    *)
      red ""
      red "Not setting anything up until the required tools are installed."
      red "Override with SKIP_PREFLIGHT=1 if you know what you are doing."
      exit 1
      ;;
  esac
else
  ylw "preflight: SKIPPED (SKIP_PREFLIGHT is set)"
fi

# WHICH units, specifically, does step 3 need to FORCE past their own
# mtime-staleness heuristic? Only the ones preflight's more thorough,
# actual-version comparison found in "drift" -- never every unit, and never
# by trusting PREFLIGHT_RC alone (that is a single aggregate answer for
# "was anything wrong", not "which of the three was it"). Re-running the
# SAME functions preflight.sh just ran costs a few JSON reads, not an
# install; asking again here is cheaper than parsing preflight's stdout back
# apart to recover what it already knew.
FORCE_FUNCTIONS=""
FORCE_WORKSPACE=""
FORCE_ADMINFN=""
if [ "$PREFLIGHT_RC" = "2" ]; then
  standalone_pkg_drift "mytribe/functions" || true
  if [ "$DEP_DRIFT_STATE" = "drift" ]; then FORCE_FUNCTIONS=1; fi

  workspace_pkg_drift "$ROOT" || true
  if [ "$DEP_DRIFT_STATE" = "drift" ]; then FORCE_WORKSPACE=1; fi

  if [ -d "auntieos-admin/web/functions" ]; then
    standalone_pkg_drift "auntieos-admin/web/functions" || true
    if [ "$DEP_DRIFT_STATE" = "drift" ]; then FORCE_ADMINFN=1; fi
  fi
fi

# ---------------------------------------------------------------------------
# 1. Pre-commit hook.
# ---------------------------------------------------------------------------
# git will not take hooksPath from a committed file, by design: a repo that
# could install its own hooks would run arbitrary code on clone. So it is set
# per clone, HERE, where running the script is an explicit act. It is
# deliberately NOT wired into an npm `prepare` script, because that would make a
# plain `npm install` on any untrusted clone silently enable repo-supplied hooks,
# reinstating through npm exactly the hazard git refuses to allow.
STEP="configuring the pre-commit hook"
if [ "$(git config core.hooksPath || true)" = ".githooks" ]; then
  grn "hooks: already pointed at .githooks"
else
  git config core.hooksPath .githooks
  grn "hooks: core.hooksPath set to .githooks"
fi

# ---------------------------------------------------------------------------
# 2. Android SDK path.
# ---------------------------------------------------------------------------
# local.properties is gitignored (machine-specific paths, and on a real machine
# also signing passwords), so no fresh clone or git worktree has one and Gradle
# refuses to configure without it.
#
# NEVER OVERWRITE. `sdk.dir` is only the part a newcomer is missing; a working
# copy also carries KEYSTORE_PATH / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD
# for release signing and an optional SENTRY_DSN, all read by
# app/build.gradle.kts. An earlier draft wrote the file unconditionally, which
# would have replaced all of that with one line.
#
# TWO Gradle builds, so two local.properties. The operator app lives in
# auntieos-admin/android; the Kinfolk Portal's Android client is the android
# target of the Kotlin Multiplatform build rooted at mytribe/, and needs its own
# sdk.dir just as much. Writing only the first left a fresh clone able to build
# one of the two apps, which is the same shape of bug the release script itself
# carried until 2026-08-04.
STEP="writing the Android SDK path"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ]; then
  case "$(uname -s)" in
    Darwin) SDK="$HOME/Library/Android/sdk" ;;
    Linux)  SDK="$HOME/Android/Sdk" ;;
    *)      SDK="" ;;
  esac
fi

for ANDROID_LOCAL in auntieos-admin/android/local.properties mytribe/local.properties; do
  if [ -f "$ANDROID_LOCAL" ]; then
    grn "android: $ANDROID_LOCAL already present, left untouched"
  elif [ -n "$SDK" ] && [ -d "$SDK" ]; then
    cat > "$ANDROID_LOCAL" <<EOF
# Generated by scripts/bootstrap.sh. Gitignored, machine-specific.
sdk.dir=$SDK

# Release signing, read by auntieos-admin/android/app/build.gradle.kts. Debug
# builds and unit tests do NOT need these; the release build fails loud and
# names whichever is missing. The mytribe app ignores them and signs with the
# Android debug keystore instead; see its build.gradle.kts.
#KEYSTORE_PATH=
#KEYSTORE_PASSWORD=
#KEY_ALIAS=
#KEY_PASSWORD=

# Optional: Android crash reporting. Empty disables it.
#SENTRY_DSN=
EOF
    grn "android: wrote $ANDROID_LOCAL -> $SDK (debug builds and unit tests ready)"
  else
    ylw "android: no SDK found${SDK:+ at $SDK}, skipping $ANDROID_LOCAL."
    ylw "  Install Android Studio or set ANDROID_HOME, then re-run this script."
    ylw "  Web and functions do not need it; only Gradle builds do."
  fi
done

# ---------------------------------------------------------------------------
# 3. Dependencies.
# ---------------------------------------------------------------------------
# Since PR25a, mytribe/web, auntieos-admin, and packages/* are real npm
# workspaces: ONE install at the repo root covers every member. mytribe/
# functions and auntieos-admin/web/functions are deliberately NOT workspace
# members (Cloud Functions deploy as a self-contained artifact with their
# own lockfile, and hoisting their deps into the root tree would ship a
# broken deploy), so each keeps its own standalone prefix install. Every
# STANDALONE lockfile unit release.sh's step 0a checks gets installed here
# (#841 follow-up): auntieos-admin/web/functions used to be left out, so
# `npm run setup` could never fix its drift and it carried real, unnoticed
# drift in the live repo (@anthropic-ai/sdk, firebase-admin).
#
# Installs run ONE AT A TIME on purpose: parallel npm processes race on the
# shared cache and fail with EACCES renaming into ~/.npm/_cacache.
#
# Not --silent: when an install fails, the reason is the only useful output.
#
# "Installed" is decided by STALENESS, not by the mere existence of the
# directory. npm writes node_modules/.package-lock.json on every install, so if
# package-lock.json is NEWER than that file, what is on disk predates the
# lockfile and is not what this commit expects.
#
# The old check looked only for the directory, and on 2026-07-26 that hid a real
# failure for an hour: a dependency-upgrade PR moved vite 6 -> 8, node_modules
# still held 6.4.3, and `npm run build` died with "'rolldownOptions' does not
# exist in type 'BuildEnvironmentOptions'" — a type error in code that was
# correct. `npm run setup` was run and cheerfully reported the project already
# installed, because it only checked that a directory existed.
STEP="installing dependencies"

# install_if_stale <label> <dir> [force]: <force>, when non-empty, means
# preflight's own version comparison (not this function's mtime guess) found
# THIS UNIT specifically out of sync, and reinstalls it regardless of what
# the timestamps say. It is per-call, not the FORCE_INSTALL env var (which
# still means "reinstall everything, unconditionally"): drift in ONE unit
# must not force a reinstall of a sibling that was already fine, or a
# mytribe/functions-only bump would cost a full root reinstall for nothing.
install_if_stale() {
  local label="$1" dir="$2" force="${3:-}"
  local marker="$dir/node_modules/.package-lock.json"
  local lockfile="$dir/package-lock.json"
  local stale=0 reason=""
  if [ -d "$dir/node_modules" ]; then
    if [ ! -f "$marker" ]; then
      stale=1; reason="no install marker: npm never finished, or an ancient layout"
    elif [ "$lockfile" -nt "$marker" ]; then
      stale=1; reason="package-lock.json is newer than the install"
    fi
  fi
  if [ "$stale" -eq 0 ] && [ -n "$force" ]; then
    stale=1
    reason="preflight's own version comparison found it out of sync (its mtimes looked fine)"
  fi

  if [ "$stale" -eq 1 ] && [ -z "${FORCE_INSTALL:-}" ]; then
    ylw "deps: $label is STALE ($reason)"
    ylw "      reinstalling; this is the drift that makes correct code fail to build"
  fi

  if [ -d "$dir/node_modules" ] && [ "$stale" -eq 0 ] && [ -z "${FORCE_INSTALL:-}" ]; then
    grn "deps: $label already installed and current (FORCE_INSTALL=1 to reinstall)"
  else
    STEP="installing dependencies in $label"
    printf 'deps: installing %s ...\n' "$label"
    ( cd "$dir" && npm ci --no-audit --no-fund )
    grn "deps: $label done"
  fi
}

# mytribe/functions: standalone, own lockfile, own node_modules.
install_if_stale "mytribe/functions" "mytribe/functions" "$FORCE_FUNCTIONS"

# Workspace root: covers every npm workspace member in one install. `.` so
# install_if_stale's "$dir/package-lock.json" resolves to the root lockfile.
install_if_stale "workspace root (npm workspaces)" "." "$FORCE_WORKSPACE"

# auntieos-admin/web/functions: the SAME standalone shape as mytribe/
# functions, for the "default" Firebase Functions codebase. Installed only
# when the directory exists (mirrors preflight.sh's own guard), since a
# checkout of an older commit or a partial/synthetic tree may not have it.
if [ -d "auntieos-admin/web/functions" ]; then
  install_if_stale "auntieos-admin/web/functions" "auntieos-admin/web/functions" "$FORCE_ADMINFN"
fi

# ---------------------------------------------------------------------------
# 3b. Re-check preflight, now that step 0 let a drift-only failure through.
# ---------------------------------------------------------------------------
# Report, don't assume. Step 0 continued past preflight's drift report on the
# strength of "installing is the fix"; this proves that, rather than taking it
# on faith. If preflight still finds something wrong here, installing was NOT
# the whole fix (or something else broke in the meantime), and that is exactly
# the kind of failure this script exists to say loudly rather than paper over.
if [ "$PREFLIGHT_RC" = "2" ]; then
  STEP="re-checking preflight after installing past the dependency drift"
  ylw ""
  ylw "preflight: re-checking now that the drift-only install above ran..."
  set +e
  bash scripts/preflight.sh
  RECHECK_RC=$?
  set -e
  if [ "$RECHECK_RC" -eq 0 ]; then
    grn "preflight: clean now. The drift preflight reported is gone."
  else
    red ""
    red "preflight still reports a problem after installing dependencies."
    red "Installing was supposed to be the whole fix; see the report above for"
    red "what is still wrong."
    exit 1
  fi
  printf '\n'
fi

# ---------------------------------------------------------------------------
# 4. Prove it.
# ---------------------------------------------------------------------------
# A setup script that says "Ready" without checking has told you nothing. One
# typecheck is cheap and exercises the whole chain: node, npm, the install, and
# the project's own tsconfig.
STEP="verifying the install"
VERIFY_LOG="$(mktemp)"
printf 'verify: typechecking the admin ... '
if npm --prefix auntieos-admin run typecheck >"$VERIFY_LOG" 2>&1; then
  rm -f "$VERIFY_LOG"
  grn "OK"
else
  red "FAILED"
  red "Dependencies installed, but the admin does not typecheck. Last 20 lines:"
  tail -20 "$VERIFY_LOG" >&2
  rm -f "$VERIFY_LOG"
  exit 1
fi

STEP="done"
grn ""
grn "Ready. Next:"
grn "  npm run dev:admin     the operator admin on :5174"
grn "  npm run dev:portal    the kinfolk portal on :5173"
grn "  npm test              every suite"
grn "  npm run check         typecheck, lint, test, build"
