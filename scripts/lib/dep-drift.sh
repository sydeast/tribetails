#!/usr/bin/env bash
# dep-drift.sh: is what's installed in node_modules what package-lock.json
# says it should be?
#
# ONE comparison, TWO callers, so they cannot drift from each other the way
# the thing they check drifts:
#   - scripts/preflight.sh reports drift. Changes nothing.
#   - scripts/release.sh (step 0a) REFUSES on drift, before anything is
#     built, because on 2026-09-13 a release tested `mytribe/web` against a
#     node_modules that predated a Dependabot bump (vitest 4 -> 5, ~20 other
#     packages, stripe in mytribe/functions) and failed a test CI had already
#     passed on the same commit. preflight.sh already caught this; nothing
#     asked it before step 1 spent three minutes on a tree it could not trust.
#
# Sourced, not executed: this file defines functions and reads its own
# location to find the two scripts below; it touches nothing on disk.
# `. scripts/lib/dep-drift.sh` from a script that has already `cd`ed to the
# repo root (both callers do).
#
# THE ACTUAL COMPARISON lives in two Node scripts beside this file
# (standalone-drift.js, workspace-drift.js), not inlined here: the logic
# needs real JSON parsing, a marker-vs-lockfile diff, and three distinct
# failure shapes, which reads a lot more plainly as JavaScript than as a
# `node -e` string wedged inside a bash heredoc.
#
# WHY TWO SHAPES. Since PR25a mytribe/web, auntieos-admin, packages/geo, and
# packages/issue-recorder are real npm workspaces sharing ONE root
# package.json/package-lock.json/node_modules; mytribe/functions and
# auntieos-admin/web/functions are each self-contained Cloud Functions
# artifacts with their OWN package.json, lockfile, and node_modules. A
# standalone root and a workspace root compare different files, so they are
# two functions (and two scripts), not one with a flag.
#
# Every function sets two globals rather than printing, so a caller decides
# for itself whether "drift" is a note (preflight) or a refusal (release):
#
#   DEP_DRIFT_STATE   one of:
#     ok         - not installed at all. A fresh clone looks exactly like
#                  this, and `npm run setup`/`npm ci` is the fix, so this is
#                  NOT a failure; failing here would refuse to start the very
#                  thing that installs it.
#     no-node    - node_modules exists, but there is no `node` on PATH to
#                  read it with. Not a failure: it means unverified, not
#                  broken.
#     no-lock    - no package-lock.json at all. `npm ci` cannot run here;
#                  this IS a failure, and installing does not fix it (there
#                  is nothing to install from).
#     unreadable - a package.json, package-lock.json, or
#                  node_modules/.package-lock.json exists but could not be
#                  read or parsed (garbage JSON, truncated file, ...). This
#                  IS a failure: a comparison that cannot even read its own
#                  inputs must not report "clean" by default, which is what
#                  a swallowed parse error used to do. DEP_DRIFT_DETAIL
#                  names what could not be read.
#     clean      - the install matches the lockfile.
#     drift      - the install does NOT match the lockfile; DEP_DRIFT_DETAIL
#                  names up to 4 offending packages. This IS a failure, and
#                  it is the one `npm ci` fixes.
#   DEP_DRIFT_DETAIL  populated for unreadable and drift; empty otherwise.
#
# Return value: 0 for ok/no-node/clean (nothing broken, or nothing that can
# be checked), 1 for no-lock/unreadable/drift (broken), so
# `if standalone_pkg_drift "$d"; then ... else ... fi` reads the way every
# other check in these scripts does.

DEP_DRIFT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _dep_drift_run <script.js> <arg>: shared plumbing for both functions below.
# Runs the Node script, merging stderr into the captured output (never
# discarding it: a swallowed error is exactly how "unreadable" used to look
# identical to "clean") and reads its EXIT CODE, not just its stdout, because
# the JS distinguishes "read fine, nothing drifted" (exit 0, empty stdout)
# from "could not even read the inputs" (exit 2), a distinction a
# `$(...)`-only capture throws away.
_dep_drift_run() {
  local script="$1" arg="$2"
  local out rc
  out="$(node "$DEP_DRIFT_LIB_DIR/$script" "$arg" 2>&1)"
  rc=$?
  case "$rc" in
    0)
      if [ -z "$out" ]; then
        DEP_DRIFT_STATE="clean"
        return 0
      fi
      DEP_DRIFT_STATE="drift"
      DEP_DRIFT_DETAIL="$out"
      return 1
      ;;
    2)
      DEP_DRIFT_STATE="unreadable"
      DEP_DRIFT_DETAIL="$out"
      return 1
      ;;
    *)
      DEP_DRIFT_STATE="unreadable"
      DEP_DRIFT_DETAIL="${out:-$script exited $rc unexpectedly}"
      return 1
      ;;
  esac
}

# standalone_pkg_drift <dir>
# <dir> carries its OWN package.json + package-lock.json + node_modules
# (mytribe/functions, auntieos-admin/web/functions).
standalone_pkg_drift() {
  local dir="$1"
  DEP_DRIFT_STATE=""
  DEP_DRIFT_DETAIL=""

  if [ ! -f "$dir/package-lock.json" ]; then
    DEP_DRIFT_STATE="no-lock"
    return 1
  fi
  if [ ! -d "$dir/node_modules" ]; then
    DEP_DRIFT_STATE="ok"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    DEP_DRIFT_STATE="no-node"
    return 0
  fi

  _dep_drift_run standalone-drift.js "$dir"
}

# workspace_pkg_drift <root>
# <root> carries the ONE package.json/package-lock.json/node_modules that
# every npm workspace member shares. Members are discovered from <root>'s own
# package.json "workspaces" field (see workspace-drift.js) rather than passed
# in, so a member added later is checked without this file changing.
workspace_pkg_drift() {
  local root="$1"
  DEP_DRIFT_STATE=""
  DEP_DRIFT_DETAIL=""

  if [ ! -f "$root/package-lock.json" ]; then
    DEP_DRIFT_STATE="no-lock"
    return 1
  fi
  if [ ! -d "$root/node_modules" ]; then
    DEP_DRIFT_STATE="ok"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    DEP_DRIFT_STATE="no-node"
    return 0
  fi

  _dep_drift_run workspace-drift.js "$root"
}
