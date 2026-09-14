#!/usr/bin/env bash
# dep-drift.sh: is what's installed in node_modules what package-lock.json
# says it should be?
#
# ONE comparison, TWO callers, so they cannot drift from each other the way
# the thing they check drifts:
#   - scripts/preflight.sh reports drift. Changes nothing.
#   - scripts/release.sh (step 0) REFUSES on drift, before anything is built,
#     because on 2026-09-13 a release tested `mytribe/web` against a
#     node_modules that predated a Dependabot bump (vitest 4 -> 5, ~20 other
#     packages, stripe in mytribe/functions) and failed a test CI had already
#     passed on the same commit. preflight.sh already caught this; nothing
#     asked it before step 1 spent three minutes on a tree it could not trust.
#
# Sourced, not executed: this file only defines functions and touches nothing
# on disk. `. scripts/lib/dep-drift.sh` from a script that has already `cd`ed
# to the repo root (both callers do).
#
# WHY TWO SHAPES. Since PR25a mytribe/web, auntieos-admin, and packages/geo are
# real npm workspaces sharing ONE root package.json/package-lock.json/
# node_modules; mytribe/functions and auntieos-admin/web/functions are each
# self-contained Cloud Functions artifacts with their OWN package.json,
# lockfile, and node_modules. A standalone root and a workspace root compare
# different files, so they are two functions, not one with a flag.
#
# Every function sets two globals rather than printing, so a caller decides
# for itself whether "drift" is a note (preflight) or a refusal (release):
#
#   DEP_DRIFT_STATE   one of:
#     ok      - not installed at all. A fresh clone looks exactly like this,
#               and `npm run setup`/`npm ci` is the fix, so this is NOT a
#               failure; failing here would refuse to start the very thing
#               that installs it.
#     no-node - node_modules exists, but there is no `node` on PATH to read it
#               with. Not a failure: it means unverified, not broken.
#     no-lock - no package-lock.json at all. `npm ci` cannot run here; this
#               IS a failure, and installing does not fix it (there is
#               nothing to install from).
#     clean   - the install matches the lockfile.
#     drift   - the install does NOT match the lockfile; DEP_DRIFT_DETAIL
#               names up to 4 offending packages. This IS a failure, and it
#               is the one `npm ci` fixes.
#   DEP_DRIFT_DETAIL  populated only when DEP_DRIFT_STATE=drift.
#
# Return value: 0 for ok/no-node/clean (nothing broken, or nothing that can be
# checked), 1 for no-lock/drift (broken), so `if standalone_pkg_drift "$d"; then
# ... else ... fi` reads the way every other check in these scripts does.

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

  # Every name in package.json against what is on disk, and each one's version
  # against the lockfile's resolved entry. Reports the first few by name: an
  # operator who can read "stripe" fixes this in one command.
  DEP_DRIFT_DETAIL="$(node -e '
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
  ' "$dir" 2>/dev/null)"

  if [ -z "$DEP_DRIFT_DETAIL" ]; then
    DEP_DRIFT_STATE="clean"
    return 0
  fi
  DEP_DRIFT_STATE="drift"
  return 1
}

# workspace_pkg_drift <root> <dir1> [dir2 ...]
# <root> carries the ONE package.json/package-lock.json/node_modules that
# <dir1>, <dir2>, ... (each with only its own package.json) share. Node
# resolution is approximated, not modeled exactly: check each member's own
# node_modules first (npm nests a dep there only when a version conflict
# forces it), then fall back to the hoisted root node_modules.
workspace_pkg_drift() {
  local root="$1"; shift
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

  DEP_DRIFT_DETAIL="$(node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const dirs = process.argv.slice(2);
    let lock;
    try { lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")); }
    catch { process.exit(0); }
    const locked = lock.packages || {};
    const bad = [];
    for (const dir of dirs) {
      let pj;
      try { pj = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8")); }
      catch { continue; }
      const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
      for (const name of Object.keys(want)) {
        // @tribetails/geo is a workspace symlink to packages/geo, not a
        // versioned install; it has no lockfile "version" to drift against.
        if (name === "@tribetails/geo") continue;
        let found = path.join(root, dir, "node_modules", name, "package.json");
        if (!fs.existsSync(found)) found = path.join(root, "node_modules", name, "package.json");
        if (!fs.existsSync(found)) { bad.push(dir + "/" + name + " (absent)"); continue; }
        const entry = locked[dir + "/node_modules/" + name] || locked["node_modules/" + name];
        if (!entry || !entry.version) continue;
        let got;
        try { got = JSON.parse(fs.readFileSync(found, "utf8")).version; } catch { continue; }
        if (got !== entry.version) bad.push(dir + "/" + name + " (" + got + ", lockfile says " + entry.version + ")");
      }
    }
    if (bad.length) console.log(bad.slice(0, 4).join(", ") + (bad.length > 4 ? ", +" + (bad.length - 4) + " more" : ""));
  ' "$root" "$@" 2>/dev/null)"

  if [ -z "$DEP_DRIFT_DETAIL" ]; then
    DEP_DRIFT_STATE="clean"
    return 0
  fi
  DEP_DRIFT_STATE="drift"
  return 1
}
