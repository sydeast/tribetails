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
# Each case builds a synthetic repo in $TMPDIR with the three project
# directories preflight looks for, and runs the real script against it.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/preflight.sh"
PASS=0
FAIL=0

ok()  { printf '\033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }

# make_repo: the three project dirs preflight walks, each with a package.json
# and a lockfile. node_modules is left to each case, since that is the variable
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
  for p in mytribe/functions mytribe/web auntieos-admin; do
    mkdir -p "$dir/$p"
    cat > "$dir/$p/package.json" <<'PJ'
{ "name": "synthetic", "dependencies": { "left-pad": "^1.3.0" } }
PJ
    cat > "$dir/$p/package-lock.json" <<'LOCK'
{
  "name": "synthetic",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/left-pad": { "version": "1.3.0" }
  }
}
LOCK
  done
  printf '%s' "$dir"
}

# install <repo> <project> <version>: a node_modules entry at a chosen version.
install_dep() {
  mkdir -p "$1/$2/node_modules/left-pad"
  printf '{ "name": "left-pad", "version": "%s" }\n' "$3" \
    > "$1/$2/node_modules/left-pad/package.json"
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
if grep -q "not installed yet" "$D1/out"; then
  ok "a fresh clone is told to run setup"
else
  bad "a fresh clone was not told what to do"
fi

# ----------------------------------------------------------- matching is silent
D2="$(make_repo)"
for p in mytribe/functions mytribe/web auntieos-admin; do install_dep "$D2" "$p" "1.3.0"; done
RC="$(run_preflight "$D2")"
if [ "$RC" = "0" ] && grep -q "install matches it" "$D2/out"; then
  ok "an install that matches the lockfile passes and says so"
else
  bad "a correct install did not pass cleanly; got rc=$RC"
  tail -20 "$D2/out"
fi

# ------------------------------------------------- a declared package is absent
# The 2026-08-04 case exactly: node_modules exists, but a dependency in
# package.json was never installed.
D3="$(make_repo)"
for p in mytribe/functions mytribe/web auntieos-admin; do install_dep "$D3" "$p" "1.3.0"; done
rm -rf "$D3/mytribe/functions/node_modules/left-pad"
RC="$(run_preflight "$D3")"
if [ "$RC" = "1" ]; then
  ok "a partially installed project FAILS preflight"
else
  bad "a missing dependency did not fail preflight; got rc=$RC"
  tail -20 "$D3/out"
fi
if grep -q "left-pad" "$D3/out"; then
  ok "the missing package is named, so the fix is one command"
else
  bad "the failure did not name the missing package"
fi

# ------------------------------------------------------------- version drift
# Installed, but not what the lockfile pins. This is the shape a `git pull` over
# a warm checkout leaves behind.
D4="$(make_repo)"
for p in mytribe/functions mytribe/web auntieos-admin; do install_dep "$D4" "$p" "1.3.0"; done
install_dep "$D4" "auntieos-admin" "1.2.0"
RC="$(run_preflight "$D4")"
if [ "$RC" = "1" ]; then
  ok "a version that disagrees with the lockfile FAILS preflight"
else
  bad "version drift did not fail preflight; got rc=$RC"
  tail -20 "$D4/out"
fi
if grep -q "1.2.0" "$D4/out" && grep -q "1.3.0" "$D4/out"; then
  ok "both the installed and the pinned version are reported"
else
  bad "the drift message did not name both versions"
fi

# ------------------------------------------------------- a missing lockfile still fails
D5="$(make_repo)"
for p in mytribe/functions mytribe/web auntieos-admin; do install_dep "$D5" "$p" "1.3.0"; done
rm -f "$D5/mytribe/web/package-lock.json"
RC="$(run_preflight "$D5")"
if [ "$RC" = "1" ]; then
  ok "a missing lockfile still fails, as it did before this check existed"
else
  bad "a missing lockfile stopped failing; got rc=$RC"
fi

rm -rf "$D1" "$D2" "$D3" "$D4" "$D5"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
