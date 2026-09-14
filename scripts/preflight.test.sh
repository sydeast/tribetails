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
#
# EXIT CODES, since #841. A drift-only failure (an install that does not
# match its lockfile) exits 2, not 1: bootstrap.sh needs to tell that apart
# from a failure installing dependencies cannot fix (a missing tool, a
# missing lockfile), because on 2026-09-13 it refused to even START an
# install over exactly the drift installing would have fixed. This machine
# already has every REQUIRED tool (that is what makes case 1 below assert
# rc=0 for a fresh clone), so a case here that touches only the two install
# units is a drift-only failure and expects rc=2; a missing lockfile is not
# something `npm ci` can fix on its own and still expects rc=1.

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
  mkdir -p "$dir/scripts/lib"
  cp "$SCRIPT" "$dir/scripts/preflight.sh"
  # preflight.sh sources the shared drift comparison rather than carrying its
  # own copy (see #841), which in turn shells out to the two Node scripts
  # beside it; without all three the real script dies on a missing file
  # instead of exercising the check under test.
  cp "$HERE"/lib/*.sh "$HERE"/lib/*.js "$dir/scripts/lib/"

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
  # packages/issue-recorder is included here (a REAL fourth workspace member,
  # matching this repo's actual layout) so that any test relying on a
  # hardcoded three-member list would miss it. Members are discovered from
  # the root "workspaces" field above, expanding "packages/*", never from a
  # list carried in this test or in preflight.sh itself.
  for p in mytribe/web auntieos-admin packages/geo packages/issue-recorder; do
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
if [ "$RC" = "2" ]; then
  ok "a partially installed functions tree FAILS preflight, as drift-only (rc=2)"
else
  bad "a missing functions dependency did not fail preflight as drift-only; got rc=$RC"
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
if [ "$RC" = "2" ]; then
  ok "a partially installed workspace FAILS preflight, as drift-only (rc=2)"
else
  bad "a missing workspace dependency did not fail preflight as drift-only; got rc=$RC"
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
if [ "$RC" = "2" ]; then
  ok "functions version drift FAILS preflight, as drift-only (rc=2)"
else
  bad "functions version drift did not fail preflight as drift-only; got rc=$RC"
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
if [ "$RC" = "2" ]; then
  ok "workspace version drift FAILS preflight, as drift-only (rc=2)"
else
  bad "workspace version drift did not fail preflight as drift-only; got rc=$RC"
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
if [ "$RC" = "2" ]; then
  ok "a nested install that disagrees with the root lockfile FAILS preflight, as drift-only (rc=2)"
else
  bad "a nested-vs-root mismatch did not fail preflight as drift-only; got rc=$RC"
  tail -20 "$D4C/out"
fi
if grep -q "9.9.9" "$D4C/out"; then
  ok "the nested install's own version is named, not the hoisted one"
else
  bad "the nested install mismatch did not name the installed version"
fi
# A workspace MEMBER (mytribe/web, auntieos-admin, packages/geo) never has its
# own lockfile, and that is normal, since the three share the root's. Running
# `npm ci` INSIDE one anyway is a real, separate incident: it exits 0 and
# SILENTLY DROPS whatever that member does not carry in its own (nonexistent)
# lockfile. So the fix for workspace drift must always be plain `npm ci` (at
# the root), and must never suggest running npm inside any of the three
# members. Checked against every workspace-drift fixture built above
# (D3B, D4B, D4C), not just this one.
for f in "$D3B/out" "$D4B/out" "$D4C/out"; do
  if grep -qE -- '--prefix (mytribe/web|auntieos-admin|packages/geo|packages/issue-recorder)\b' "$f"; then
    bad "a workspace drift report named npm ci --prefix inside a workspace member ($f)"
  else
    ok "workspace drift never suggests npm ci --prefix inside a member ($f)"
  fi
done

# ------------------------------------------- a member outside the old hardcoded list
# The workspace check used to be told its members by a hardcoded list
# (mytribe/web, auntieos-admin, packages/geo) passed in by the caller. A real
# fourth member -- packages/issue-recorder, which make_repo above always
# creates -- would have gone unchecked forever under that list. Drifting ONLY
# it proves the member list is actually built from the root package.json's
# "workspaces" field (packages/* expanded), not from anything hardcoded.
D4D="$(make_repo)"
install_matching "$D4D"
cat > "$D4D/packages/issue-recorder/package.json" <<'PJ'
{ "name": "synthetic", "dependencies": { "left-pad": "^1.3.0", "recorder-only-dep": "^2.0.0" } }
PJ
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(p, "utf8"));
  lock.packages["node_modules/recorder-only-dep"] = { version: "2.0.0" };
  fs.writeFileSync(p, JSON.stringify(lock));
' "$D4D/package-lock.json"
mkdir -p "$D4D/node_modules/recorder-only-dep"
printf '{ "name": "recorder-only-dep", "version": "1.0.0" }\n' \
  > "$D4D/node_modules/recorder-only-dep/package.json"
RC="$(run_preflight "$D4D")"
if [ "$RC" = "2" ] && grep -q "packages/issue-recorder/recorder-only-dep" "$D4D/out"; then
  ok "drift in a workspace member NOT on the old hardcoded list is still caught"
else
  bad "packages/issue-recorder drift went uncaught; got rc=$RC"
  tail -20 "$D4D/out"
fi

# ------------------------------------------------- a declared dependency with
# ------------------------------------------------- no lockfile entry at all
# package.json and package-lock.json disagreeing with EACH OTHER (not with
# node_modules) used to be silently skipped: the drift loop only ever walked
# declared dependencies that already had a lockfile entry, so one with none
# at all reported clean. Tested against both install units.
D4E="$(make_repo)"
install_matching "$D4E"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const pj = JSON.parse(fs.readFileSync(p, "utf8"));
  pj.dependencies["ghost-pkg"] = "^1.0.0";
  fs.writeFileSync(p, JSON.stringify(pj));
' "$D4E/mytribe/functions/package.json"
RC="$(run_preflight "$D4E")"
if [ "$RC" = "2" ] && grep -q "ghost-pkg (declared, but not in package-lock.json)" "$D4E/out"; then
  ok "a functions dependency declared but not in the lockfile is caught as drift"
else
  bad "an unlocked declared functions dependency went uncaught; got rc=$RC"
  tail -20 "$D4E/out"
fi

D4F="$(make_repo)"
install_matching "$D4F"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const pj = JSON.parse(fs.readFileSync(p, "utf8"));
  pj.dependencies["ghost-pkg"] = "^1.0.0";
  fs.writeFileSync(p, JSON.stringify(pj));
' "$D4F/mytribe/web/package.json"
RC="$(run_preflight "$D4F")"
if [ "$RC" = "2" ] && grep -q "mytribe/web/ghost-pkg (declared, but not in package-lock.json)" "$D4F/out"; then
  ok "a workspace member dependency declared but not in the lockfile is caught as drift"
else
  bad "an unlocked declared workspace dependency went uncaught; got rc=$RC"
  tail -20 "$D4F/out"
fi

# --------------------------------------------------------- transitive-only drift
# Only DIRECT dependencies used to be compared, so a transitive bump (the
# shape a Dependabot GROUP update takes -- it can move a nested dependency's
# version without touching the direct package.json entry at all) went
# undetected. node_modules/.package-lock.json is npm's own record of every
# installed package, transitive included; diffing it against the real
# lockfile catches this without walking the dependency tree by hand.
D4G="$(make_repo)"
install_matching "$D4G"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(p, "utf8"));
  lock.packages["node_modules/left-pad/node_modules/nested-thing"] = { version: "2.0.0" };
  fs.writeFileSync(p, JSON.stringify(lock));
' "$D4G/mytribe/functions/package-lock.json"
# The installed marker reflects the OLD lockfile: left-pad matches (1.3.0),
# but the transitive nested-thing is still what the PREVIOUS install left,
# not what the lockfile above now pins.
cat > "$D4G/mytribe/functions/node_modules/.package-lock.json" <<'LOCK'
{ "packages": {
  "node_modules/left-pad": { "version": "1.3.0" },
  "node_modules/left-pad/node_modules/nested-thing": { "version": "1.0.0" }
} }
LOCK
RC="$(run_preflight "$D4G")"
if [ "$RC" = "2" ] && grep -q "nested-thing (1.0.0, lockfile says 2.0.0)" "$D4G/out"; then
  ok "a transitive-only version bump is caught even though the direct dependency matches"
else
  bad "transitive-only drift went uncaught; got rc=$RC"
  tail -20 "$D4G/out"
fi

# --------------------------------------------------- optional platform packages
# npm's own lockfile carries every optional platform-specific binary a
# dependency graph could ever need (esbuild, rollup, @napi-rs/*, ...), and
# never installs the ones that do not match THIS machine. A real, freshly
# `npm ci`'d checkout on macOS arm64 has dozens of such entries "missing" on
# purpose. Counting them as drift would refuse a perfectly clean tree; a
# NON-optional missing package must still be caught.
D4K="$(make_repo)"
install_matching "$D4K"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(p, "utf8"));
  lock.packages["node_modules/optional-linux-thing"] = { version: "1.0.0", optional: true, os: ["linux"] };
  lock.packages["node_modules/wrong-cpu-thing"] = { version: "1.0.0", cpu: ["ia32"] };
  lock.packages["node_modules/required-thing"] = { version: "1.0.0" };
  fs.writeFileSync(p, JSON.stringify(lock));
' "$D4K/mytribe/functions/package-lock.json"
# The installed marker is what a real `npm ci` on THIS machine actually
# wrote: left-pad, and none of the three new entries -- npm skipped the
# first two on purpose (wrong platform), and required-thing failed to
# install for a real reason this check must still catch.
cat > "$D4K/mytribe/functions/node_modules/.package-lock.json" <<'LOCK'
{ "packages": {
  "node_modules/left-pad": { "version": "1.3.0" }
} }
LOCK
RC="$(run_preflight "$D4K")"
if [ "$RC" = "2" ] && grep -q "required-thing (not installed)" "$D4K/out"; then
  ok "a non-optional missing package is still caught as drift"
else
  bad "a non-optional missing package went uncaught; got rc=$RC"; tail -20 "$D4K/out"
fi
if grep -q "optional-linux-thing" "$D4K/out"; then
  bad "an optional: true, os-excluded package was reported as drift"
else
  ok "an optional: true, os-excluded package absent from this platform is not drift"
fi
if grep -q "wrong-cpu-thing" "$D4K/out"; then
  bad "a cpu-excluded package (no optional flag) was reported as drift"
else
  ok "a cpu-excluded package absent from this platform is not drift, even without optional: true"
fi

# The same fixture, but through the STANDALONE FALLBACK path (no
# node_modules/.package-lock.json marker at all): the direct-dependency walk
# must apply the identical optional/platform exemption.
D4L="$(make_repo)"
install_matching "$D4L"
rm -f "$D4L/mytribe/functions/node_modules/.package-lock.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const pj = JSON.parse(fs.readFileSync(p, "utf8"));
  pj.dependencies["optional-linux-thing"] = "^1.0.0";
  fs.writeFileSync(p, JSON.stringify(pj));
' "$D4L/mytribe/functions/package.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(p, "utf8"));
  lock.packages["node_modules/optional-linux-thing"] = { version: "1.0.0", optional: true, os: ["linux"] };
  fs.writeFileSync(p, JSON.stringify(lock));
' "$D4L/mytribe/functions/package-lock.json"
RC="$(run_preflight "$D4L")"
if [ "$RC" = "0" ] && ! grep -qi "optional-linux-thing" "$D4L/out"; then
  ok "the direct-dependency fallback also treats an os-excluded optional package as not drift"
else
  bad "the fallback path reported an os-excluded optional package as drift or failed; rc=$RC"
  tail -20 "$D4L/out"
fi

# --------------------------------------------- a member's package.json is garbage
# A workspace member is correctly skipped when its package.json does not
# EXIST (a partial or synthetic tree may declare a workspace pattern with
# nothing under it yet). A member whose package.json EXISTS but cannot be
# parsed used to be caught by the exact same `catch { continue }` as the
# legitimate "doesn't exist" case, silently dropping that member (and every
# dependency it declares) from the check entirely. That is a real member
# this check cannot trust, not an absent one, and must refuse (unreadable),
# not skip.
D4M="$(make_repo)"
install_matching "$D4M"
printf 'this is not json' > "$D4M/mytribe/web/package.json"
RC="$(run_preflight "$D4M")"
if [ "$RC" = "1" ] && grep -qi "cannot be checked" "$D4M/out"; then
  ok "a workspace member with garbage package.json is UNREADABLE, refuses (rc=1)"
else
  bad "a garbage member package.json did not refuse as unreadable; got rc=$RC"
  tail -20 "$D4M/out"
fi
if grep -q "workspace.*install matches it" "$D4M/out"; then
  bad "a workspace with a garbage member's package.json was reported as clean"
fi

# ------------------------------------------------ an unexpandable glob pattern
# Only a single trailing "*" SEGMENT is expanded ("packages/*"). Any other
# shape (a mid-path "*", "**", a partial-segment glob, a "!" negation) used
# to be silently mishandled -- treated as a literal directory name that
# almost certainly does not exist, expanding to NOTHING rather than to the
# right set of directories. A wrong expansion that finds no members looks
# identical to "no members declared" and would report a workspace with real,
# drifted dependencies as perfectly clean. It must refuse instead.
for pat in 'packages/*/nested' 'pkg-*' '**' '!packages/excluded'; do
  D4N="$(make_repo)"
  install_matching "$D4N"
  node -e '
    const fs = require("fs");
    const p = process.argv[1], pat = process.argv[2];
    const pj = JSON.parse(fs.readFileSync(p, "utf8"));
    pj.workspaces.push(pat);
    fs.writeFileSync(p, JSON.stringify(pj));
  ' "$D4N/package.json" "$pat"
  RC="$(run_preflight "$D4N")"
  if [ "$RC" = "1" ] && grep -qi "cannot be checked" "$D4N/out"; then
    ok "an unexpandable workspaces pattern ('$pat') refuses rather than silently matching nothing"
  else
    bad "an unexpandable workspaces pattern ('$pat') did not refuse; got rc=$RC"
    tail -20 "$D4N/out"
  fi
  rm -rf "$D4N"
done

# ------------------------------------------------------------- unreadable inputs
# A garbage or truncated JSON file used to be swallowed by a bare `catch {
# process.exit(0) }`, which printed nothing and looked EXACTLY like "clean".
# It must instead be its own state that refuses, distinct from both clean and
# ordinary drift.
D4H="$(make_repo)"
install_matching "$D4H"
printf 'this is not json' > "$D4H/mytribe/functions/package-lock.json"
RC="$(run_preflight "$D4H")"
if [ "$RC" = "1" ] && grep -qi "cannot be checked" "$D4H/out"; then
  ok "a garbage functions lockfile is UNREADABLE, refuses (rc=1), and says so"
else
  bad "a garbage functions lockfile did not refuse as unreadable; got rc=$RC"
  tail -20 "$D4H/out"
fi
if grep -q "functions.*install matches it" "$D4H/out"; then
  bad "a garbage functions lockfile was reported as a CLEAN, matching install"
else
  ok "a garbage functions lockfile is never reported as clean"
fi

D4I="$(make_repo)"
install_matching "$D4I"
printf 'this is not json' > "$D4I/package-lock.json"
RC="$(run_preflight "$D4I")"
if [ "$RC" = "1" ] && grep -qi "cannot be checked" "$D4I/out"; then
  ok "a garbage root lockfile is UNREADABLE, refuses (rc=1), and says so"
else
  bad "a garbage root lockfile did not refuse as unreadable; got rc=$RC"
  tail -20 "$D4I/out"
fi

D4J="$(make_repo)"
install_matching "$D4J"
printf 'this is not json' > "$D4J/mytribe/functions/node_modules/.package-lock.json"
RC="$(run_preflight "$D4J")"
if [ "$RC" = "1" ] && grep -qi "cannot be checked" "$D4J/out"; then
  ok "a garbage install marker (node_modules/.package-lock.json) is UNREADABLE, refuses"
else
  bad "a garbage install marker did not refuse as unreadable; got rc=$RC"
  tail -20 "$D4J/out"
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
# auntieos-admin/web/functions (#841): the SAME standalone shape as
# mytribe/functions, for the "default" Firebase Functions codebase. Checked
# only when the directory exists.
#
# TREATED THE SAME AS mytribe/functions, not as a warning: bootstrap.sh
# installs this codebase too now, regardless of RELEASE_INCLUDE_ADMIN_
# FUNCTIONS, so its drift is exactly as fixable by `npm run setup` as
# mytribe/functions' is. It used to only warn (never setting MISSING), which
# meant preflight never exited 2 for it, `npm run setup` never installed it,
# and the real repo carried real, unnoticed drift here (@anthropic-ai/sdk,
# firebase-admin). release.sh's own step 0a still only REFUSES a release over
# this when RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 is actually shipping it (see
# release.test.sh); preflight has no such flag to read.
# ---------------------------------------------------------------------------
add_admin_functions() {
  local dir="$1"
  mkdir -p "$dir/auntieos-admin/web/functions"
  cat > "$dir/auntieos-admin/web/functions/package.json" <<'PJ'
{ "name": "synthetic-admin-functions", "dependencies": { "left-pad": "^1.3.0" } }
PJ
  cat > "$dir/auntieos-admin/web/functions/package-lock.json" <<'LOCK'
{
  "name": "synthetic-admin-functions",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/left-pad": { "version": "1.3.0" }
  }
}
LOCK
}

D5C="$(make_repo)"
install_matching "$D5C"
add_admin_functions "$D5C"
RC="$(run_preflight "$D5C")"
if [ "$RC" = "0" ] && grep -q "adminfn.*not installed yet" "$D5C/out"; then
  ok "a not-yet-installed admin-functions codebase WARNS and does not fail preflight"
else
  bad "an uninstalled admin-functions codebase failed preflight; got rc=$RC"
  tail -20 "$D5C/out"
fi

D5D="$(make_repo)"
install_matching "$D5D"
add_admin_functions "$D5D"
install_dep "$D5D" "auntieos-admin/web/functions" "1.2.0"
RC="$(run_preflight "$D5D")"
if [ "$RC" = "2" ] && grep -q "adminfn.*does NOT match the lockfile" "$D5D/out" &&
   grep -q "1.2.0" "$D5D/out" && grep -q "1.3.0" "$D5D/out"; then
  ok "admin-functions drift FAILS preflight, as drift-only (rc=2), and is named"
else
  bad "admin-functions drift either did not fail as drift-only or went unreported; got rc=$RC"
  tail -20 "$D5D/out"
fi

D5E="$(make_repo)"
install_matching "$D5E"
RC="$(run_preflight "$D5E")"
if [ "$RC" = "0" ] && ! grep -qi "adminfn" "$D5E/out"; then
  ok "a repo with no admin-functions codebase reports nothing about one"
else
  bad "reported an admin-functions codebase that does not exist; got rc=$RC"
  tail -20 "$D5E/out"
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
