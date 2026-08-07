#!/usr/bin/env bash
# Tests for preflight.sh's install-sync check. Run:
#   bash scripts/preflight.test.sh
#
# WHY THIS EXISTS
# On 2026-08-04 a release died 90 seconds into `npm run check` with nine
# TS2307/TS7006 errors naming `@googleapis/calendar`. PR #250 had swapped
# `googleapis` for it, and the checkout the release ran from had never
# installed it. Everything that looked was green: clean tree, lockfile present,
# CI passing. CI cannot catch this at all, because CI installs from scratch
# every run; only a long-lived checkout can drift.
#
# The check that would have caught it is small, and the risk in it is not that
# it misses drift. It is that it FAILS A FRESH CLONE, where node_modules is
# absent by definition and bootstrap.sh calls preflight before it installs
# anything. That would refuse to start the very thing that fixes it. So the
# absent case and the stale case are tested as separate, opposite outcomes.
#
# TWO INSTALL UNITS, since PR25a (real npm workspaces)
# mytribe/functions deploys as a self-contained Cloud Functions artifact and
# is NOT a workspace member: it keeps its own package.json, lockfile, and
# node_modules, checked exactly as before. mytribe/web, auntieos-admin, and
# packages/geo ARE workspace members: they share ONE root package.json,
# package-lock.json, and (normally hoisted) node_modules. preflight.sh checks
# these as two independent things, labelled "functions" and "workspace" in
# its output, so this file builds a synthetic repo with both shapes and
# exercises each one separately.
#
# Each case builds a synthetic repo in $TMPDIR and runs the real script
# against it.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/preflight.sh"
PASS=0
FAIL=0

ok()  { printf '\033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }

# make_repo: mytribe/functions (own manifest + lockfile, standalone) plus a
# workspace root (root package.json + package-lock.json) with mytribe/web,
# auntieos-admin, and packages/geo each declaring the same synthetic
# dependency. node_modules is left to each case, since that is the variable
# under test.
make_repo() {
  local dir
  dir="$(mktemp -d)"
  # preflight.sh resolves the repo root from its OWN location
  # (`dirname "${BASH_SOURCE[0]}"/..`) and cds there, so running the real script
  # from a synthetic cwd would still check the real repo. The copy is what makes
  # this a test of the script rather than a test of this machine.
  mkdir -p "$dir/scripts"
  cp "$SCRIPT" "$dir/scripts/preflight.sh"

  # mytribe/functions: NOT a workspace member. Own manifest, own lockfile.
  mkdir -p "$dir/mytribe/functions"
  cat > "$dir/mytribe/functions/package.json" <<'PJ'
{ "name": "synthetic-functions", "dependencies": { "left-pad": "^1.3.0" } }
PJ
  cat > "$dir/mytribe/functions/package-lock.json" <<'LOCK'
{
  "name": "synthetic-functions",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/left-pad": { "version": "1.3.0" }
  }
}
LOCK

  # The workspace root: covers mytribe/web, auntieos-admin, and packages/geo.
  cat > "$dir/package.json" <<'PJ'
{ "name": "synthetic-root", "private": true,
  "workspaces": ["packages/*", "auntieos-admin", "mytribe/web"] }
PJ
  cat > "$dir/package-lock.json" <<'LOCK'
{
  "name": "synthetic-root",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/left-pad": { "version": "1.3.0" }
  }
}
LOCK
  for p in mytribe/web auntieos-admin packages/geo; do
    mkdir -p "$dir/$p"
    cat > "$dir/$p/package.json" <<'PJ'
{ "name": "synthetic", "dependencies": { "left-pad": "^1.3.0" } }
PJ
  done

  printf '%s' "$dir"
}

# install_dep <repo> <project> <version>: a node_modules entry INSIDE that
# project's own directory. Used for mytribe/functions' standalone install,
# and (for the workspace-drift case) to simulate a NESTED install that a
# version conflict would leave behind in one workspace member's own
# node_modules, ahead of the hoisted root copy.
install_dep() {
  mkdir -p "$1/$2/node_modules/left-pad"
  printf '{ "name": "left-pad", "version": "%s" }\n' "$3" \
    > "$1/$2/node_modules/left-pad/package.json"
}

# install_workspace_dep <repo> <version>: a node_modules entry at the
# WORKSPACE ROOT — the hoisted shape a real `npm install` leaves for
# mytribe/web, auntieos-admin, and packages/geo, which share this one
# node_modules rather than each getting their own.
install_workspace_dep() {
  mkdir -p "$1/node_modules/left-pad"
  printf '{ "name": "left-pad", "version": "%s" }\n' "$2" \
    > "$1/node_modules/left-pad/package.json"
}

# install_matching <repo>: both install units at the version their lockfile
# pins, so the Repo section is fully green and a later assertion is isolated
# to whatever that case changes on top of this baseline.
install_matching() {
  install_dep "$1" "mytribe/functions" "1.3.0"
  install_workspace_dep "$1" "1.3.0"
}

run_preflight() {
  ( cd "$1" && bash "$1/scripts/preflight.sh" ) > "$1/out" 2>&1
  printf '%s' "$?"
}

# ------------------------------------------------------- absent is not a failure
D1="$(make_repo)"
RC="$(run_preflight "$D1")"
if [ "$RC" = "0" ]; then
  ok "a fresh clone with no node_modules does not fail preflight"
else
  bad "preflight failed a fresh clone, which would stop bootstrap from installing"
  tail -20 "$D1/out"
fi
if grep -q "functions.*not installed yet" "$D1/out"; then
  ok "a fresh clone is told the functions tree needs setup"
else
  bad "the functions tree was not told what to do"
fi
if grep -q "workspace.*not installed yet" "$D1/out"; then
  ok "a fresh clone is told the workspace needs setup"
else
  bad "the workspace was not told what to do"
fi

# ----------------------------------------------------------- matching is silent
D2="$(make_repo)"
install_matching "$D2"
RC="$(run_preflight "$D2")"
if [ "$RC" = "0" ]; then
  ok "a fully matching install exits 0"
else
  bad "a correct install did not exit 0; got rc=$RC"
  tail -20 "$D2/out"
fi
if grep -q "functions.*install matches it" "$D2/out"; then
  ok "the functions install matches its lockfile and says so"
else
  bad "the functions match was not reported"
fi
if grep -q "workspace.*install matches it" "$D2/out"; then
  ok "the workspace install matches its lockfile and says so"
else
  bad "the workspace match was not reported"
fi

# ------------------------------------------------- a declared package is absent
# The 2026-08-04 case exactly: node_modules exists, but a dependency in
# package.json was never installed. Tested against BOTH install units, since
# each runs independent code in preflight.sh.
D3="$(make_repo)"
install_matching "$D3"
rm -rf "$D3/mytribe/functions/node_modules/left-pad"
RC="$(run_preflight "$D3")"
if [ "$RC" = "1" ]; then
  ok "a partially installed functions tree FAILS preflight"
else
  bad "a missing functions dependency did not fail preflight; got rc=$RC"
  tail -20 "$D3/out"
fi
if grep -q "left-pad" "$D3/out"; then
  ok "the missing functions package is named, so the fix is one command"
else
  bad "the failure did not name the missing functions package"
fi

D3B="$(make_repo)"
install_matching "$D3B"
rm -rf "$D3B/node_modules/left-pad"
RC="$(run_preflight "$D3B")"
if [ "$RC" = "1" ]; then
  ok "a partially installed workspace FAILS preflight"
else
  bad "a missing workspace dependency did not fail preflight; got rc=$RC"
  tail -20 "$D3B/out"
fi
if grep -q "left-pad" "$D3B/out"; then
  ok "the missing workspace package is named, so the fix is one command"
else
  bad "the failure did not name the missing workspace package"
fi

# ------------------------------------------------------------- version drift
# Installed, but not what the lockfile pins. This is the shape a `git pull` over
# a warm checkout leaves behind. Tested against both install units.
D4="$(make_repo)"
install_matching "$D4"
install_dep "$D4" "mytribe/functions" "1.2.0"
RC="$(run_preflight "$D4")"
if [ "$RC" = "1" ]; then
  ok "functions version drift FAILS preflight"
else
  bad "functions version drift did not fail preflight; got rc=$RC"
  tail -20 "$D4/out"
fi
if grep -q "1.2.0" "$D4/out" && grep -q "1.3.0" "$D4/out"; then
  ok "both the installed and the pinned functions version are reported"
else
  bad "the functions drift message did not name both versions"
fi

D4B="$(make_repo)"
install_matching "$D4B"
install_workspace_dep "$D4B" "1.2.0"
RC="$(run_preflight "$D4B")"
if [ "$RC" = "1" ]; then
  ok "workspace version drift FAILS preflight"
else
  bad "workspace version drift did not fail preflight; got rc=$RC"
  tail -20 "$D4B/out"
fi
if grep -q "1.2.0" "$D4B/out" && grep -q "1.3.0" "$D4B/out"; then
  ok "both the installed and the pinned workspace version are reported"
else
  bad "the workspace drift message did not name both versions"
fi

# --------------------------------------------- own-dir install wins over root
# Node resolution checks a workspace member's OWN node_modules before falling
# back to the hoisted root — the shape npm leaves when a version conflict
# forces a nested install. The lockfile only carries the hoisted entry, so a
# nested copy that disagrees with it must still be caught.
D4C="$(make_repo)"
install_matching "$D4C"
install_dep "$D4C" "auntieos-admin" "9.9.9"
RC="$(run_preflight "$D4C")"
if [ "$RC" = "1" ]; then
  ok "a nested install that disagrees with the root lockfile FAILS preflight"
else
  bad "a nested-vs-root mismatch did not fail preflight; got rc=$RC"
  tail -20 "$D4C/out"
fi
if grep -q "9.9.9" "$D4C/out"; then
  ok "the nested install's own version is named, not the hoisted one"
else
  bad "the nested install mismatch did not name the installed version"
fi

# ------------------------------------------------- a missing lockfile still fails
D5="$(make_repo)"
install_matching "$D5"
rm -f "$D5/mytribe/functions/package-lock.json"
RC="$(run_preflight "$D5")"
if [ "$RC" = "1" ]; then
  ok "a missing functions lockfile still fails, as it did before this check existed"
else
  bad "a missing functions lockfile stopped failing; got rc=$RC"
fi

D5B="$(make_repo)"
install_matching "$D5B"
rm -f "$D5B/package-lock.json"
RC="$(run_preflight "$D5B")"
if [ "$RC" = "1" ]; then
  ok "a missing root (workspace) lockfile fails preflight"
else
  bad "a missing root lockfile stopped failing; got rc=$RC"
fi

# ---------------------------------------------------------------------------
# The Python codebase.
#
# `auntieos-admin/web/firebase.json` declares a second functions codebase on a
# pinned Python runtime, and the Firebase CLI discovers its endpoints by RUNNING
# the code out of `functions-python/venv`. Nothing in this repo creates that
# venv, so on 2026-08-05 a release died after 25 minutes of successful deploys
# with "Missing virtual environment at venv directory".
#
# Every case here is a WARNING rather than a failure: the codebase only ships
# under RELEASE_INCLUDE_ADMIN_FUNCTIONS=1, so a machine that never deploys it is
# not broken. The tests assert both halves of that: the right message, and
# exit 0 anyway. Each case installs a fully matching functions + workspace
# baseline first (install_matching), so the RC these tests check is isolated
# to the python check rather than incidental drift elsewhere in the Repo
# section.
# ---------------------------------------------------------------------------

# add_python_codebase <repo> [runtime]: the firebase.json and source directory
# the check reads. Runtime defaults to the real one.
add_python_codebase() {
  local dir="$1" runtime="${2:-python313}"
  mkdir -p "$dir/auntieos-admin/web/functions-python"
  cat > "$dir/auntieos-admin/web/firebase.json" <<JSON
{ "functions": [
  { "source": "functions", "codebase": "default", "runtime": "nodejs22" },
  { "source": "functions-python", "codebase": "reconcile", "runtime": "$runtime" }
] }
JSON
  printf 'firebase-functions==0.5.0\n' > "$dir/auntieos-admin/web/functions-python/requirements.txt"
}

# a venv skeleton built by <version>, without needing that interpreter present.
fake_venv() {
  mkdir -p "$1/auntieos-admin/web/functions-python/venv/bin"
  printf '#!/bin/sh\nexit 0\n' > "$1/auntieos-admin/web/functions-python/venv/bin/python$2"
  chmod +x "$1/auntieos-admin/web/functions-python/venv/bin/python$2"
}

# --------------------------------------------------------------- no venv at all
D6="$(make_repo)"
install_matching "$D6"
add_python_codebase "$D6"
RC="$(run_preflight "$D6")"
if [ "$RC" = "0" ]; then
  ok "a missing python venv WARNS and does not fail preflight"
else
  bad "a missing python venv failed preflight; the reconcile codebase is opt-in"
fi
# Only assert the message when the pinned interpreter is actually on this
# machine; without it the run correctly stops at the earlier branch instead.
if command -v python3.13 >/dev/null 2>&1; then
  if grep -q "no venv" "$D6/out"; then
    ok "a missing python venv is named, with the command that creates it"
  else
    bad "a missing python venv was not reported"
  fi
  if grep -q "python3.13 -m venv venv" "$D6/out"; then
    ok "the fix command carries the pinned interpreter"
  else
    bad "the fix command did not name python3.13"
  fi
fi

# ------------------------------------------- a venv built by another interpreter
# The shape left behind when the runtime pin moves and the old venv stays.
D7="$(make_repo)"
install_matching "$D7"
add_python_codebase "$D7"
fake_venv "$D7" "3.11"
RC="$(run_preflight "$D7")"
if [ "$RC" = "0" ] && { ! command -v python3.13 >/dev/null 2>&1 || grep -q "not built with python3.13" "$D7/out"; }; then
  ok "a venv from a different interpreter is caught, and still does not fail"
else
  bad "a mismatched venv was not caught; got rc=$RC"
  grep -iE "reconcile|python" "$D7/out" | head -3
fi

# ----------------------------------------------- the version comes from the file
# The pin is read from firebase.json, so a runtime bump cannot leave this check
# validating the interpreter the repo no longer uses.
D8="$(make_repo)"
install_matching "$D8"
add_python_codebase "$D8" "python399"
RC="$(run_preflight "$D8")"
if grep -q "python3.99" "$D8/out"; then
  ok "the required python version is read from firebase.json, not hardcoded"
else
  bad "a changed runtime pin was not reflected in the report"
  grep -iE "reconcile|python" "$D8/out" | head -3
fi
if [ "$RC" = "0" ]; then
  ok "an uninstallable pinned interpreter still does not fail preflight"
else
  bad "a missing pinned interpreter failed preflight; got rc=$RC"
fi

# --------------------------------------------------- no python codebase declared
# A repo without one must say nothing at all rather than inventing a warning.
D9="$(make_repo)"
install_matching "$D9"
RC="$(run_preflight "$D9")"
if [ "$RC" = "0" ] && ! grep -qi "reconcile" "$D9/out"; then
  ok "a repo with no python codebase reports nothing about one"
else
  bad "reported a python codebase that is not declared; got rc=$RC"
fi

# ------------------------------------------------- local.properties, per build
# The worktree case. local.properties is gitignored, so `git worktree add` never
# inherits one and Gradle dies with "SDK location not found" on the first
# Android command. bootstrap.sh writes it and always has; what was missing is
# anyone running bootstrap in a worktree, so three agents hit this on
# 2026-08-07 and each exported ANDROID_HOME for a single command, which fixes
# that command and leaves the next one broken.
#
# NOT FATAL, deliberately. Android is one surface of several, and web and
# functions need no SDK at all. Failing here would block a portal-only change on
# a missing Android file, so this reports and names the fix instead.
D10="$(make_repo)"
install_matching "$D10"
mkdir -p "$D10/auntieos-admin/android" "$D10/mytribe"
RC="$(run_preflight "$D10")"
if [ "$RC" = "0" ]; then
  ok "a tree with no local.properties still PASSES preflight (Android is optional)"
else
  bad "a missing local.properties failed preflight; got rc=$RC"
  tail -20 "$D10/out"
fi
if grep -q "auntieos-admin/android/local.properties" "$D10/out" &&
   grep -q "mytribe/local.properties" "$D10/out"; then
  ok "both missing local.properties files are named, not just the first"
else
  bad "preflight did not name both missing local.properties files"
  tail -20 "$D10/out"
fi
# The fix has to be in the output, or the report is a riddle.
if grep -q "bootstrap.sh" "$D10/out"; then
  ok "the report names bootstrap.sh as the fix"
else
  bad "the report did not say how to fix it"
fi

# A bootstrapped tree must stop nagging, or the warning becomes noise people
# learn to scroll past.
D11="$(make_repo)"
install_matching "$D11"
mkdir -p "$D11/auntieos-admin/android" "$D11/mytribe"
echo "sdk.dir=/nonexistent" > "$D11/auntieos-admin/android/local.properties"
echo "sdk.dir=/nonexistent" > "$D11/mytribe/local.properties"
RC="$(run_preflight "$D11")"
if [ "$RC" = "0" ] && ! grep -q "local.properties missing" "$D11/out"; then
  ok "a bootstrapped tree reports no local.properties warning"
else
  bad "warned about local.properties that are present; got rc=$RC"
  tail -20 "$D11/out"
fi

rm -rf "$D1" "$D2" "$D3" "$D3B" "$D4" "$D4B" "$D4C" "$D5" "$D5B" "$D6" "$D7" "$D8" "$D9" "$D10" "$D11"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
