#!/usr/bin/env bash
# Tests for bootstrap.sh's handling of preflight's verdict (#841). Run:
#   bash scripts/bootstrap.test.sh
#
# WHY THIS EXISTS
# On 2026-09-13 `npm run setup` refused to reinstall because its OWN preflight
# check failed on the very dependency drift installing would fix: the release
# Mac's node_modules predated a Dependabot bump preflight had already
# correctly named. The operator ran `npm ci` and `npm ci --prefix
# mytribe/functions` by hand.
#
# preflight.sh now exits 2, not 1, when the ONLY thing wrong is dependency
# drift (see scripts/lib/dep-drift.sh and scripts/preflight.test.sh).
# bootstrap.sh reads that distinction: exit 2 proceeds to install — forcing
# it, since a drift-only preflight has just proven the install's own mtime
# staleness check wrong for this tree — and re-checks preflight afterward;
# any other failure (exit 1) still refuses to start, unchanged.
#
# HOW: a synthetic repo, the real bootstrap.sh + preflight.sh + lib copied in
# byte for byte, with npm stubbed (a real `npm ci` needs the network and this
# is only testing the preflight GATE, not npm itself) but node, git, java,
# and firebase left REAL, the same split preflight.test.sh relies on: this
# machine already has every required tool, so a case that touches only the
# two install units is a drift-only failure and nothing else is.
#
# The npm stub's `ci` MATERIALIZES node_modules from the lockfile it runs
# against (using real node, reading the same two files the real drift check
# reads), so the re-run of the REAL preflight.sh after "installing" sees a
# genuinely clean state rather than a check that always reports fixed no
# matter what shipped.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

ok()  { printf '\033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }

# make_repo: mytribe/functions (own manifest + lockfile) plus a workspace root
# (root package.json + package-lock.json), the same two install-unit shapes
# preflight.test.sh builds. node_modules is left to each case.
make_repo() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/scripts/lib" "$dir/stubs"
  cp "$HERE/bootstrap.sh" "$dir/scripts/bootstrap.sh"
  cp "$HERE/preflight.sh" "$dir/scripts/preflight.sh"
  cp "$HERE/lib/dep-drift.sh" "$dir/scripts/lib/dep-drift.sh"

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

  cat > "$dir/package.json" <<'PJ'
{ "name": "synthetic-root", "private": true,
  "workspaces": ["packages/*", "auntieos-admin", "mytribe/web"] }
PJ
  cat > "$dir/package-lock.json" <<'LOCK'
{
  "name": "synthetic-root",
  "lockfileVersion": 3,
  "packages": {}
}
LOCK

  # A git repo: bootstrap step 1 runs `git config core.hooksPath`.
  ( cd "$dir"
    git init -q .
    git config user.email t@t.test
    git config user.name Test
  ) >/dev/null 2>&1

  printf '%s' "$dir"
}

# install_dep <repo> <project> <version>: a node_modules entry INSIDE that
# project's own directory, at the given version. Used to simulate a STALE
# install (present, but not what the lockfile pins) without ever touching
# this worktree's own real node_modules.
install_dep() {
  mkdir -p "$1/$2/node_modules/left-pad"
  printf '{ "name": "left-pad", "version": "%s" }\n' "$3" \
    > "$1/$2/node_modules/left-pad/package.json"
}

# write_npm_stub <repo>: npm is stubbed because a real `npm ci` needs the
# network and this file is testing the preflight GATE, not npm itself. `ci`
# still does real work: it reads the same package.json/package-lock.json the
# drift check reads (via real node, not stubbed) and materializes
# node_modules to match, so the SUBSEQUENT re-run of the real preflight.sh
# genuinely sees clean rather than a check that always claims success.
write_npm_stub() {
  cat > "$1/stubs/npm" <<'STUB'
#!/usr/bin/env bash
# Logs the cwd too, not just the args: install_if_stale runs `(cd "$dir" &&
# npm ci ...)`, so the directory is what distinguishes one install unit's
# call from another's, never the argv the stub sees.
echo "STUB npm $* (cwd=$PWD)" >> "${NPM_CALL_LOG:-/dev/null}"
if [ "${1:-}" = "ci" ]; then
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.cwd();
    let pj, lock;
    try {
      pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
    } catch { process.exit(0); }
    const want = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    const locked = lock.packages || {};
    for (const name of Object.keys(want)) {
      const entry = locked["node_modules/" + name];
      if (!entry || !entry.version) continue;
      const dest = path.join(dir, "node_modules", name);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "package.json"),
        JSON.stringify({ name, version: entry.version }));
    }
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", ".package-lock.json"),
      fs.readFileSync(path.join(dir, "package-lock.json")));
  '
fi
exit 0
STUB
  chmod +x "$1/stubs/npm"
}

# run_bootstrap <repo> [VAR=VAL ...]: the real script, npm stubbed, ANDROID_HOME
# pointed at a path that cannot exist so step 2 (local.properties) never tries
# to write into directories this fixture does not have — this test is about
# the preflight gate, not Android.
run_bootstrap() {
  local dir="$1"; shift
  local rc
  (
    cd "$dir"
    export PATH="$dir/stubs:$PATH"
    export ANDROID_HOME=/nonexistent-for-bootstrap-test
    export "$@" >/dev/null 2>&1 || true
    env "$@" bash scripts/bootstrap.sh
  ) > "$dir/out" 2>&1
  rc=$?
  printf '%s' "$rc"
}

# ---------------------------------------------------------------------------
# 1. Drift-only: preflight exits 2, bootstrap proceeds, installs past it, and
#    the re-check afterward reports clean. This is the exact 2026-09-13 trap:
#    `npm run setup` used to refuse here.
# ---------------------------------------------------------------------------
D1="$(make_repo)"; write_npm_stub "$D1"
install_dep "$D1" "mytribe/functions" "1.2.0"   # stale: lockfile pins 1.3.0
RC="$(run_bootstrap "$D1" NPM_CALL_LOG="$D1/npm-calls")"
OUT="$(cat "$D1/out")"

if [ "$RC" -eq 0 ]; then
  ok "bootstrap proceeds past a drift-only preflight failure and completes"
else
  bad "bootstrap did not complete past drift-only preflight; rc=$RC"
  tail -30 "$D1/out"
fi
if printf '%s' "$OUT" | grep -q "the only failure above is dependency drift"; then
  ok "bootstrap explains why it is continuing rather than refusing"
else
  bad "bootstrap did not explain the drift-only continuation"; tail -30 "$D1/out"
fi
if grep -q "^STUB npm ci .*(cwd=.*/mytribe/functions)$" "$D1/npm-calls" 2>/dev/null; then
  ok "bootstrap actually ran npm ci in mytribe/functions to fix the drift"
else
  bad "bootstrap never ran npm ci in mytribe/functions"; cat "$D1/npm-calls" 2>/dev/null
fi
if printf '%s' "$OUT" | grep -q "preflight: clean now"; then
  ok "bootstrap re-checks preflight after installing and reports it clean"
else
  bad "bootstrap did not report a clean re-check"; tail -30 "$D1/out"
fi
if [ "$(cat "$D1/mytribe/functions/node_modules/left-pad/package.json" 2>/dev/null | grep -o '1\.[0-9.]*')" = "1.3.0" ]; then
  ok "the stale package now matches the lockfile on disk"
else
  bad "left-pad was not actually reinstalled to the lockfile's version"
fi

# ---------------------------------------------------------------------------
# 2. A hard failure (here: no package-lock.json at all — something `npm ci`
#    cannot fix by itself) still refuses to start, unchanged. Bootstrap must
#    not have run any install before refusing.
# ---------------------------------------------------------------------------
D2="$(make_repo)"; write_npm_stub "$D2"
rm -f "$D2/mytribe/functions/package-lock.json"
RC="$(run_bootstrap "$D2" NPM_CALL_LOG="$D2/npm-calls")"
OUT="$(cat "$D2/out")"

if [ "$RC" -ne 0 ]; then
  ok "bootstrap refuses to start on a hard preflight failure"
else
  bad "bootstrap proceeded despite a hard preflight failure"; tail -30 "$D2/out"
fi
if printf '%s' "$OUT" | grep -q "Not setting anything up until the required tools are installed"; then
  ok "bootstrap prints the refusal, not the drift-only continuation message"
else
  bad "bootstrap did not print the hard-failure refusal"; tail -30 "$D2/out"
fi
if printf '%s' "$OUT" | grep -q "the only failure above is dependency drift"; then
  bad "bootstrap claimed a hard failure was drift-only"
else
  ok "bootstrap did not misclassify the hard failure as drift-only"
fi
if grep -q '^STUB npm ci ' "$D2/npm-calls" 2>/dev/null; then
  bad "bootstrap ran npm ci before refusing on a hard failure"; cat "$D2/npm-calls"
else
  ok "nothing was installed (no npm ci) before the hard-failure refusal"
fi

# ---------------------------------------------------------------------------
# 3. A clean tree (no drift at all) proceeds normally, with no drift-only
#    messaging — the baseline the two cases above are contrasted against.
# ---------------------------------------------------------------------------
D3="$(make_repo)"; write_npm_stub "$D3"
RC="$(run_bootstrap "$D3" NPM_CALL_LOG="$D3/npm-calls")"
OUT="$(cat "$D3/out")"
if [ "$RC" -eq 0 ] && ! printf '%s' "$OUT" | grep -q "dependency drift"; then
  ok "a clean tree (nothing installed yet, nothing broken) proceeds with no drift messaging"
else
  bad "a clean tree either failed or wrongly reported drift; rc=$RC"
  tail -30 "$D3/out"
fi

rm -rf "$D1" "$D2" "$D3"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
