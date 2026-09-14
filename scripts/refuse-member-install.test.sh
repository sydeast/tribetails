#!/usr/bin/env bash
# Tests for scripts/lib/refuse-member-install.js, the shared preinstall guard
# every npm workspace member without its own lockfile calls (#862). Run:
#   bash scripts/refuse-member-install.test.sh
#
# WHY THIS EXISTS
# `npm ci` run INSIDE mytribe/web exited 0 on 2026-09-14 and silently dropped
# @tiptap/* and @vitejs/plugin-react from what that app could resolve --
# tests then failed with a missing-module error that looked like broken code.
# The fix is a preinstall hook in every lockfile-less member, but a hook that
# fires on the wrong commands is worse than no hook: it would refuse a
# perfectly normal root `npm ci`, or CI, or bootstrap.sh, and train everyone
# to reach for `--ignore-scripts` instead of fixing anything. The behavioral
# cases below run the REAL npm CLI against a synthetic workspace (zero
# external dependencies, so it needs no network and carries no lockfile
# drift risk) rather than asserting on the guard script's source, because
# npm's own behavior here -- what cwd a workspace member's lifecycle script
# runs with, whether INIT_CWD is recomputed for a nested npm invocation,
# whether `npm ci` clears node_modules before ANY lifecycle script gets a
# chance to object -- is exactly what a change to a future npm version could
# quietly break underneath a source-only check.
#
# TWO SEPARATE THINGS THIS FILE CHECKS
#   1. WIRING (static, against the REAL repo): every workspace member that
#      has no lockfile of its own carries the right "preinstall" line.
#      Members are discovered from the root package.json's "workspaces"
#      field with the SAME single-trailing-"*"-segment expansion
#      scripts/lib/workspace-drift.js uses (duplicated here in ~15 lines
#      rather than imported, since that script runs its comparison as soon
#      as it is required, not on demand -- see its own header comment). A
#      member added later and left unwired is exactly the silent gap
#      workspace-drift.js's own comment warns a hardcoded list would create;
#      this check is what catches that for the guard too.
#   2. BEHAVIOR (real npm, synthetic fixture): a depth-1 and a depth-2
#      workspace member, wired the same way, prove the guard fires only for
#      an install literally begun inside a member and never for the commands
#      this repo or its automation actually run.
#
# `npm ci`'S OWN DESTRUCTIVE STEP, SEPARATE FROM WHAT THIS GUARD CAN CONTROL.
# `npm ci` unconditionally clears node_modules before reify runs, and
# lifecycle scripts (including this guard) run INSIDE reify -- confirmed
# against real npm 10.9.8 and 11.9.0 in #862's own investigation, where a
# refused `npm ci` inside a real member left the real repo's root
# node_modules with 2 of its 477 entries. No preinstall hook anywhere,
# tested on either npm version, can run before that clear.
# `npm install` has no such unconditional clear and is proven below (case
# 2f) to leave node_modules byte-for-byte untouched on refusal. Both still
# refuse loudly (exit nonzero) instead of the original defect's silent exit 0
# with a smaller tree, and the fix printed is the same either way: `npm ci`
# at the root. Case 2e below asserts the `npm ci` refusal itself; it does
# NOT assert `npm ci` leaves node_modules untouched, because it does not.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GUARD_SRC="$HERE/lib/refuse-member-install.js"
PASS=0
FAIL=0

ok()  { printf '\033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }

if [ ! -f "$GUARD_SRC" ]; then
  bad "scripts/lib/refuse-member-install.js does not exist"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
ok "scripts/lib/refuse-member-install.js exists"

# ---------------------------------------------------------------------------
# 1. WIRING: every real workspace member without its own lockfile calls the
#    shared guard, at the right relative depth.
# ---------------------------------------------------------------------------
WIRING_OUT="$(mktemp)"
node - "$ROOT" > "$WIRING_OUT" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];

const rootPj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const patterns = Array.isArray(rootPj.workspaces) ? rootPj.workspaces : [];

// Same expansion rule as scripts/lib/workspace-drift.js: only a single
// trailing "*" segment is resolved; anything else is out of scope for this
// duplicate check (workspace-drift.js itself refuses on it).
const dirs = [];
for (const pat of patterns) {
  const segments = pat.split('/');
  const last = segments[segments.length - 1];
  if (last !== '*') {
    dirs.push(pat);
    continue;
  }
  const base = segments.slice(0, -1).join('/');
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, base), { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(base ? path.join(base, e.name) : e.name);
  }
}

for (const dir of dirs) {
  const pjPath = path.join(root, dir, 'package.json');
  if (!fs.existsSync(pjPath)) continue;
  const lockPath = path.join(root, dir, 'package-lock.json');
  if (fs.existsSync(lockPath)) continue; // has its own lockfile: out of scope for this guard
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  const depth = dir.split('/').length;
  const want = 'node ' + '../'.repeat(depth) + 'scripts/lib/refuse-member-install.js';
  const got = pj.scripts && pj.scripts.preinstall;
  console.log((got === want ? 'OK ' : 'BAD ') + dir + '|' + JSON.stringify(want) + '|' + JSON.stringify(got));
}
NODE

if [ ! -s "$WIRING_OUT" ]; then
  bad "no lockfile-less workspace members were found at all -- the expansion is broken, or every member has grown its own lockfile"
else
  while IFS= read -r line; do
    case "$line" in
      OK\ *)
        ok "wiring: ${line#OK }"
        ;;
      BAD\ *)
        bad "wiring: ${line#BAD }"
        ;;
    esac
  done < "$WIRING_OUT"
fi
rm -f "$WIRING_OUT"

# ---------------------------------------------------------------------------
# 2. BEHAVIOR: real npm against a synthetic, dependency-free workspace.
# ---------------------------------------------------------------------------
# make_fixture: a root plus a depth-1 member ("admin", mirrors auntieos-admin)
# and a depth-2 member ("apps/web", mirrors mytribe/web / packages/geo). No
# "dependencies" anywhere, so `npm ci`/`npm install` never touch the network
# and there is nothing for a lockfile to drift from.
make_fixture() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/scripts/lib" "$dir/admin" "$dir/apps/web" "$dir/local-pkg"
  cp "$GUARD_SRC" "$dir/scripts/lib/refuse-member-install.js"
  cat > "$dir/package.json" <<'PJ'
{ "name": "fixture-root", "private": true, "workspaces": ["admin", "apps/web"] }
PJ
  # A real (non-workspace) local package, installable via `file:../local-pkg`
  # from admin. Used only by case 2f, to give it something that WOULD change
  # admin/package.json and the root lockfile if the guard did not stop it --
  # a bare `npm install` with nothing to add is a no-op whether or not any
  # guard exists, which is exactly why the marker-only version of this case
  # used to pass even with the guard disabled.
  cat > "$dir/local-pkg/package.json" <<'PJ'
{ "name": "local-pkg", "version": "1.0.0" }
PJ
  cat > "$dir/admin/package.json" <<'PJ'
{ "name": "fixture-admin", "private": true,
  "scripts": { "preinstall": "node ../scripts/lib/refuse-member-install.js" } }
PJ
  cat > "$dir/apps/web/package.json" <<'PJ'
{ "name": "fixture-web", "private": true,
  "scripts": { "preinstall": "node ../../scripts/lib/refuse-member-install.js" } }
PJ
  printf '%s\n' "$dir"
}

# run_npm <dir> <args...>: runs npm with cwd=<dir>, capturing combined
# output and the real exit code (not a piped copy of it -- this shell is
# zsh-compatible bash, and a piped `| tail` would throw the exit code away).
run_npm() {
  local dir="$1"; shift
  ( cd "$dir" && npm "$@" --no-audit --no-fund --foreground-scripts )
}

D1="$(make_fixture)"

# 2a. Root `npm install` (first run, no lockfile yet): must not refuse.
OUT="$(run_npm "$D1" install 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "root npm install succeeds (fixture, first install)"
else
  bad "root npm install failed (rc=$RC)"; printf '%s\n' "$OUT"
fi

# 2b. Root `npm ci`: must not refuse.
OUT="$(run_npm "$D1" ci 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "root npm ci succeeds"
else
  bad "root npm ci failed (rc=$RC)"; printf '%s\n' "$OUT"
fi
MARKER_BEFORE="$(cat "$D1/node_modules/.package-lock.json" 2>/dev/null)"

# 2c. `npm install -w <member>` from the root: must not refuse, for both
#     depths.
OUT="$(run_npm "$D1" install -w admin 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "npm install -w admin (run from root) succeeds"
else
  bad "npm install -w admin (run from root) failed (rc=$RC)"; printf '%s\n' "$OUT"
fi
OUT="$(run_npm "$D1" install -w apps/web 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "npm install -w apps/web (run from root) succeeds"
else
  bad "npm install -w apps/web (run from root) failed (rc=$RC)"; printf '%s\n' "$OUT"
fi

# 2d. `npm ci -w <member>` from the root: must not refuse.
OUT="$(run_npm "$D1" ci -w admin 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "npm ci -w admin (run from root) succeeds"
else
  bad "npm ci -w admin (run from root) failed (rc=$RC)"; printf '%s\n' "$OUT"
fi
# Restore the full tree: `npm ci -w` scopes to just that member, same as a
# real root ci -w would leave every OTHER member's install unrestored.
run_npm "$D1" ci >/dev/null 2>&1

# 2e. `npm ci` run INSIDE each member: must refuse (nonzero exit), and must
#     name the fix.
OUT="$(run_npm "$D1/admin" ci 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q 'To restore dependencies: `npm ci` at the repo root'; then
  ok "npm ci INSIDE admin (depth 1) refuses and names the repo-root fix"
else
  bad "npm ci INSIDE admin did not refuse as expected (rc=$RC)"; printf '%s\n' "$OUT"
fi
run_npm "$D1" ci >/dev/null 2>&1   # restore: npm ci clears root node_modules even when refused

OUT="$(run_npm "$D1/apps/web" ci 2>&1)"; RC=$?
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q 'To restore dependencies: `npm ci` at the repo root'; then
  ok "npm ci INSIDE apps/web (depth 2) refuses and names the repo-root fix"
else
  bad "npm ci INSIDE apps/web did not refuse as expected (rc=$RC)"; printf '%s\n' "$OUT"
fi
run_npm "$D1" ci >/dev/null 2>&1   # restore

# 2f. `npm install <a real new dependency>` run INSIDE a member: must
#     refuse, AND must leave that member's OWN package.json and the root
#     lockfile unchanged. A bare `npm install` with nothing to add (the
#     previous version of this case) is a no-op whether or not any guard
#     exists, so it never actually exercised the guard; installing a real
#     local `file:` dependency is something that DOES rewrite
#     admin/package.json (adding the new dependency) and the root
#     package-lock.json when nothing stops it -- confirmed by temporarily
#     gutting scripts/lib/refuse-member-install.js to `process.exit(0)` and
#     re-running this exact case by hand: both files changed, this case
#     failed as expected, and the real guard was restored and diffed
#     byte-identical afterward. `npm install` still has no unconditional
#     clear the way `npm ci` does, so node_modules itself is also checked.
ADMIN_PJ_BEFORE="$(cat "$D1/admin/package.json")"
LOCK_BEFORE="$(cat "$D1/package-lock.json")"
MARKER_BEFORE="$(cat "$D1/node_modules/.package-lock.json" 2>/dev/null)"
OUT="$(run_npm "$D1/admin" install file:../local-pkg 2>&1)"; RC=$?
ADMIN_PJ_AFTER="$(cat "$D1/admin/package.json")"
LOCK_AFTER="$(cat "$D1/package-lock.json")"
MARKER_AFTER="$(cat "$D1/node_modules/.package-lock.json" 2>/dev/null)"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q 'To restore dependencies: `npm ci` at the repo root'; then
  ok "npm install file:../local-pkg INSIDE admin refuses and names the repo-root fix"
else
  bad "npm install file:../local-pkg INSIDE admin did not refuse as expected (rc=$RC)"; printf '%s\n' "$OUT"
fi
if [ "$ADMIN_PJ_BEFORE" = "$ADMIN_PJ_AFTER" ]; then
  ok "npm install INSIDE admin left admin/package.json unchanged (no dependency was added)"
else
  bad "npm install INSIDE admin added the dependency to admin/package.json despite refusing"
fi
if [ "$LOCK_BEFORE" = "$LOCK_AFTER" ]; then
  ok "npm install INSIDE admin left the root package-lock.json unchanged"
else
  bad "npm install INSIDE admin changed the root package-lock.json despite refusing"
fi
if [ "$MARKER_BEFORE" = "$MARKER_AFTER" ]; then
  ok "npm install INSIDE admin left the root install marker untouched"
else
  bad "npm install INSIDE admin changed the root node_modules install marker"
fi

# 2g. bootstrap.sh's own pattern -- `cd` to the workspace root (from
#     wherever the caller started) and THEN run `npm ci` -- must not refuse.
OUT="$(cd /tmp && ( cd "$D1" && npm ci --no-audit --no-fund --foreground-scripts ) 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "bootstrap.sh's cd-to-root-then-npm-ci pattern succeeds"
else
  bad "bootstrap.sh's cd-to-root-then-npm-ci pattern failed (rc=$RC)"; printf '%s\n' "$OUT"
fi

rm -rf "$D1"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
