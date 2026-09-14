#!/usr/bin/env bash
# release-bg.sh — start the production release detached, and say where to watch.
#
#   npm run deploy:bg
#
# WHY THIS EXISTS
# `npm run deploy` is correct and hard to launch. Every attempt on 2026-08-03
# hit a different sharp edge, none of them the release's fault:
#
#   - it runs 20 to 40 minutes, so any wrapper with a timeout kills it partway;
#   - backgrounded with `&`, step 0's confirm reads /dev/tty, the job takes
#     SIGTTIN and suspends with `[1] + suspended (tty input)`, which looks like
#     a hang and is not one;
#   - `echo "release pid $!"` is fine in a script and broken when pasted into
#     interactive zsh, where history expansion eats the closing quote and drops
#     you at `dquote>`;
#   - the log path gets improvised each time, so the previous run's output is
#     wherever it happened to land.
#
# One word, none of that. Everything below is the fix for one of those, in
# order.

set -uo pipefail

# From the repo root, whatever the caller's cwd is. release.sh reads and writes
# .release-state relative to the root, and a release started from the wrong
# directory is the class of mistake this repo has already made.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }

# The resume rule release.sh skips steps on (#840), shared rather than copied so
# this wrapper and the release cannot disagree about it.
# shellcheck source=scripts/release-progress.sh
. "$ROOT/scripts/release-progress.sh" || {
  red "REFUSED: cannot load scripts/release-progress.sh."
  exit 1
}

# The commit this wrapper decides about, pinned once and handed to release.sh
# as RELEASE_SHA, which refuses at step 0 if HEAD has moved since. Every read
# below uses it, and so does the resume rule (#840 review).
RELEASE_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$RELEASE_SHA" ]; then
  red "REFUSED: cannot read HEAD."
  exit 1
fi
export RELEASE_SHA
# Only this wrapper may say a run is expected to resume the index step; an
# inherited value from the operator's shell must not.
unset RELEASE_BG_EXPECTS_INDEX_RESUME

LOG_DIR="$ROOT/.release-logs"
PIDFILE="$LOG_DIR/current.pid"
mkdir -p "$LOG_DIR"

# ONE AT A TIME. Two concurrent releases would race on .release-state and on the
# deploys themselves, and the second one's failures would be blamed on the code.
if [ -f "$PIDFILE" ]; then
  RUNNING="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$RUNNING" ] && ps -p "$RUNNING" >/dev/null 2>&1; then
    red "REFUSED: a release is already running (pid $RUNNING)."
    red "  Watch it:  tail -f $(ls -t "$LOG_DIR"/release-*.log 2>/dev/null | head -1)"
    red "  Stop it:   kill $RUNNING"
    exit 1
  fi
  rm -f "$PIDFILE"
fi

# THE INDEX PROMPT IS NOT NOISE, SO DO NOT BLANKET-SKIP IT.
#
# release.sh asks twice: once to confirm the commit, once to confirm every
# Firestore index reads Enabled. The second exists because index builds are
# asynchronous and code deployed against a still-building index fails at
# RUNTIME, silently. A detached run cannot answer either, so it passes
# RELEASE_YES=1 -- which is safe for the first question (running this script IS
# the answer) and is only safe for the second when this release changes no
# indexes.
#
# So that is checked rather than assumed. If the indexes changed, this refuses
# and tells you to run it in the foreground, where you can look at the console
# and answer for yourself.
LAST_RELEASED=""
[ -f "$ROOT/.release-state" ] && LAST_RELEASED="$(cat "$ROOT/.release-state" 2>/dev/null)"

INDEXES_CHANGED=0
if [ -n "$LAST_RELEASED" ] && git rev-parse --verify --quiet "$LAST_RELEASED^{commit}" >/dev/null 2>&1; then
  if ! git diff --quiet "$LAST_RELEASED" "$RELEASE_SHA" -- '*firestore.indexes.json' 2>/dev/null; then
    INDEXES_CHANGED=1
  fi
else
  # No usable baseline means the diff cannot be trusted, and "cannot tell"
  # must read the same as "changed" for a question this one protects.
  INDEXES_CHANGED=1
fi

# A RESUMED RUN IS ALREADY PAST STEP 3 (#840). When an earlier run of this exact
# commit got past step 3 and stopped later, release.sh recorded the index step,
# and the rerun skips steps 2 and 3, so there is no prompt left for a detached
# run to skip. Whether a person or RELEASE_YES answered step 3 in that earlier
# run is recorded separately, and the rerun says which. The diff above still
# says "changed", because .release-state names the previous release until a run
# finishes. Without this, the operator's documented command (npm run deploy:bg)
# could not resume the 2026-09-13 release at all. progress_done is the same rule
# release.sh skips on: exact RELEASE_SHA, clean tree, RELEASE_NO_RESUME unset.
#
# release.sh decides again at step 2, possibly minutes later. The wrapper hands
# it RELEASE_BG_EXPECTS_INDEX_RESUME=1 so that if the two disagree, release.sh
# stops instead of deploying indexes nobody will confirm.
INDEXES_RESUMED=0
if [ "$INDEXES_CHANGED" = "1" ] && progress_done indexes; then
  INDEXES_RESUMED=1
fi

if [ "$INDEXES_CHANGED" = "1" ] && [ "$INDEXES_RESUMED" = "0" ] && [ "${RELEASE_BG_FORCE:-0}" != "1" ]; then
  red "REFUSED: this release changes Firestore indexes (or the baseline is unknown)."
  red ""
  red "  Step 3 asks you to confirm every index reads Enabled before the code"
  red "  that queries them ships. Index builds are asynchronous; a query against"
  red "  a still-building index fails at runtime and says nothing at build time."
  red "  A detached run cannot look at the console for you."
  red ""
  red "  Run it in the foreground and answer that question:"
  red "    npm run deploy"
  red ""
  red "  Or, if you have already confirmed the indexes are Enabled:"
  red "    RELEASE_BG_FORCE=1 npm run deploy:bg"
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
SHA="$(git rev-parse --short "$RELEASE_SHA" 2>/dev/null || echo unknown)"
LOG="$LOG_DIR/release-$STAMP-$SHA.log"

# stdin from /dev/null, not the terminal. This is the SIGTTIN fix: a background
# job that READS the tty gets stopped by the kernel, and release.sh reads it at
# step 0. With RELEASE_YES=1 it never reads, and /dev/null means that even if a
# future prompt appears it fails closed instead of suspending the whole run.
#
# setsid where available so the release survives the terminal closing. macOS
# ships no setsid, and nohup covers the common case there.
RUNNER="nohup"
command -v setsid >/dev/null 2>&1 && RUNNER="setsid"

# RELEASE_SHA is exported above. The resume expectation is passed only when this
# wrapper let changed indexes through on the strength of a resume.
if [ "$INDEXES_RESUMED" = "1" ]; then
  export RELEASE_BG_EXPECTS_INDEX_RESUME=1
fi
RELEASE_YES=1 $RUNNER bash "$ROOT/scripts/release.sh" </dev/null >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

grn "release started: pid $PID"
cyan "  commit:  $SHA  $(git log -1 --format=%s "$RELEASE_SHA" 2>/dev/null | cut -c1-60)"
cyan "  log:     $LOG"
cyan ""
cyan "  watch:   tail -f $LOG"
cyan "  status:  ps -p $PID"
cyan "  stop:    kill $PID"
if [ "$INDEXES_RESUMED" = "1" ]; then
  ylw "  resumed: an earlier run of $SHA deployed the indexes and got past step 3;"
  ylw "  this run skips steps 2 and 3 (RELEASE_NO_RESUME=1 redoes them)."
elif [ "$INDEXES_CHANGED" = "1" ]; then
  ylw "  RELEASE_BG_FORCE=1: index confirmation was skipped on your say-so."
fi
cyan ""
cyan "It runs 20 to 40 minutes and survives this shell closing."
