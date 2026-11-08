#!/usr/bin/env bash
# Tests for .githooks/pre-commit, section 3 (the functions test gate). Run:
#   bash scripts/pre-commit-hook.test.sh                 # the hook in this tree
#   bash scripts/pre-commit-hook.test.sh <path/to/hook>  # any other version
#
# WHY THIS EXISTS (#1712)
# On 2026-11-06 the hook ran the whole mytribe/functions suite on any staged
# path under it, merge commits included, with its output sent to /dev/null.
# Under machine load the index-loading tests timed out, commits were refused
# for code nobody had touched, and the builder saw only "tests FAIL". Five
# commits went in with --no-verify and five merges were routed through the
# GitHub API instead.
#
# Each case builds a throwaway repo holding the hook under test and stub test
# runners, then makes a REAL `git commit`, so MERGE_HEAD and the index are
# git's own. The stubs record every invocation, which is what the cases assert
# on: which tests ran, not how long they took.
#
#   stub vitest   `run` runs every *.test.ts; `related <paths>` runs each named
#                 test file plus every test that imports a named source file.
#                 A test FAILS when its content says FAILME or a source file it
#                 imports says BROKEN. A test that says SLOWME TIMES OUT when
#                 STUB_LOADED=1, standing in for the index-loading tests under
#                 load.
#   stub admin    `npm test` in auntieos-admin/web/functions records ADMIN_RUN
#                 and fails when a file named FAIL_ADMIN exists.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="${1:-$HERE/../.githooks/pre-commit}"
HOOK="$(cd "$(dirname "$HOOK")" && pwd)/$(basename "$HOOK")"
[ -f "$HOOK" ] || { echo "no hook at $HOOK"; exit 2; }
echo "hook under test: $HOOK"

PASS=0
FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
has() { printf '%s' "$1" | grep -qF -- "$2"; }

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/vitest" <<'STUB'
#!/usr/bin/env bash
# Stub vitest. Runs from mytribe/functions, like the real one.
echo "vitest $*" >> "$STUB_LOG"
mode="$1"; shift
files=""
if [ "$mode" = run ]; then
  files="$(find test src -name '*.test.ts' 2>/dev/null | sort)"
else
  for a in "$@"; do
    case "$a" in --*) continue ;; esac
    case "$a" in
      *.test.ts) files="$files"$'\n'"$a" ;;
      *) stem="${a%.*}"
         files="$files"$'\n'"$(grep -rlF -e "../$stem'" test src 2>/dev/null | grep '\.test\.ts$')" ;;
    esac
  done
  files="$(printf '%s\n' "$files" | grep . | sort -u)"
fi
if [ -z "$files" ]; then
  echo "No affected test files found, exiting with code 0"
  exit 0
fi
rc=0; n=0
while IFS= read -r t; do
  n=$((n+1))
  echo "ran $t" >> "$STUB_LOG"
  if grep -q FAILME "$t"; then
    echo " FAIL  $t > adds > two and two"; echo "AssertionError: expected 3 to be 4"; rc=1; continue
  fi
  if grep -q SLOWME "$t" && [ "${STUB_LOADED:-0}" = 1 ]; then
    echo " FAIL  $t > loads the function index"; echo "Error: Test timed out in 10000ms."; rc=1; continue
  fi
  for imp in $(grep -oE "\.\./src/[A-Za-z0-9_/]+" "$t" | sed 's#^\.\./##'); do
    if grep -q BROKEN "$imp.ts" 2>/dev/null; then
      echo " FAIL  $t > adds > two and two"; echo "AssertionError: expected 3 to be 4"; rc=1; continue 2
    fi
  done
  echo " ✓ $t"
done <<EOF
$files
EOF
echo " Test Files  $n run"
exit $rc
STUB
chmod +x "$STUB_DIR/vitest"

# make_repo: main with both functions trees, a passing test per source file, a
# source file no test reaches, and an index-loading test that times out under
# load. Prints the repo path.
make_repo() {
  local d
  d="$(mktemp -d "$STUB_DIR/repo.XXXXXX")"
  (
    cd "$d" || exit 1
    git init -q -b main
    git config user.email hook-test@example.invalid
    git config user.name "hook test"
    git config commit.gpgsign false
    git config core.hooksPath .githooks
    mkdir -p .githooks mytribe/functions/src/lib mytribe/functions/test \
      mytribe/functions/node_modules/.bin \
      auntieos-admin/web/functions/node_modules auntieos-admin/web/src docs
    cp "$HOOK" .githooks/pre-commit
    chmod +x .githooks/pre-commit
    printf 'node_modules/\n' > .gitignore
    cp "$STUB_DIR/vitest" mytribe/functions/node_modules/.bin/vitest

    printf '{ "name": "f", "private": true, "scripts": { "test": "vitest run" } }\n' > mytribe/functions/package.json
    printf 'export const add = (a: number, b: number) => a + b;\n' > mytribe/functions/src/lib/math.ts
    printf "import { add } from '../src/lib/math';\n// expect(add(2, 2)).toBe(4)\n" > mytribe/functions/test/math.test.ts
    printf 'export const lonely = 1;\n' > mytribe/functions/src/lib/lonely.ts
    printf 'export const FUNCTIONS = {};\n' > mytribe/functions/src/index.ts
    # Loads src/index.ts by path, the way the real index tests do, so no
    # import names it. SLOWME: times out under load.
    printf "// SLOWME\nconst SRC_INDEX = resolve(ROOT, 'src/index.ts');\n" > mytribe/functions/test/indexLoad.test.ts

    printf '{ "name": "a", "private": true, "scripts": { "test": "sh ./t.sh" } }\n' > auntieos-admin/web/functions/package.json
    # shellcheck disable=SC2016
    printf 'echo ADMIN_RUN >> "$STUB_LOG"\nif [ -f FAIL_ADMIN ]; then echo "not ok 1 - claims are set"; echo "Error: expected admin claim"; exit 1; fi\necho "ok 1 - claims are set"\n' > auntieos-admin/web/functions/t.sh
    printf 'module.exports = {};\n' > auntieos-admin/web/functions/index.js
    printf '<div></div>\n' > auntieos-admin/web/src/App.html
    printf '# docs\n' > docs/README.md

    git add -A
    git commit -q --no-verify -m init
  ) >/dev/null 2>&1
  echo "$d"
}

# commit_in <repo> <msg>: runs a real commit, prints the hook's output, and
# leaves the exit code in $RC and the stub log in $LOGTXT.
commit_in() {
  local d="$1"
  : > "$d/.stub.log"
  OUT="$(cd "$d" && STUB_LOG="$d/.stub.log" git commit -q -m "$2" 2>&1)"
  RC=$?
  LOGTXT="$(cat "$d/.stub.log")"
}

full_run() { printf '%s\n' "$LOGTXT" | grep -qx 'vitest run'; }

# ---------------------------------------------------------------------------
# (a) Merge commit that brings in functions files the branch never touched.
#     Expected: no functions tests at all. The old hook ran the full suite and,
#     under load, was refused.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(
  cd "$d" || exit 1
  git checkout -q -b feature
  echo '<p></p>' >> auntieos-admin/web/src/App.html
  git commit -q --no-verify -am "admin web change"
  git checkout -q main
  printf 'export const add = (a: number, b: number) => b + a;\n' > mytribe/functions/src/lib/math.ts
  echo '// main' >> auntieos-admin/web/functions/index.js
  git commit -q --no-verify -am "main changes both functions trees"
  git checkout -q feature
  git merge -q --no-commit --no-ff main
) >/dev/null 2>&1
export STUB_LOADED=1
commit_in "$d" "merge main"
if [ "$RC" -eq 0 ] && [ -z "$LOGTXT" ]; then
  ok "(a) merge bringing in untouched functions files runs no functions tests and commits"
else
  bad "(a) merge bringing in untouched functions files: rc=$RC, runs: $(printf '%s' "$LOGTXT" | tr '\n' ';')"
fi

# (a2) The same merge, but the branch had also changed math.ts and the merge
#      conflicted there. The resolution is new code, so its tests run.
d="$(make_repo)"
(
  cd "$d" || exit 1
  git checkout -q -b feature
  printf 'export const add = (x: number, y: number) => x + y;\n' > mytribe/functions/src/lib/math.ts
  git commit -q --no-verify -am "branch edits math"
  git checkout -q main
  printf 'export const add = (a: number, b: number) => b + a;\n' > mytribe/functions/src/lib/math.ts
  git commit -q --no-verify -am "main edits math"
  git checkout -q feature
  git merge -q main
  printf 'export const add = (p: number, q: number) => p + q;\n' > mytribe/functions/src/lib/math.ts
  git add mytribe/functions/src/lib/math.ts
) >/dev/null 2>&1
STUB_LOADED=0 commit_in "$d" "merge main, resolve math"
if [ "$RC" -eq 0 ] && printf '%s' "$LOGTXT" | grep -qx 'ran test/math.test.ts' && ! full_run; then
  ok "(a2) a conflict resolution in a functions file runs that file's tests, not the suite"
else
  bad "(a2) conflict resolution: rc=$RC, runs: $(printf '%s' "$LOGTXT" | tr '\n' ';')"
fi

# ---------------------------------------------------------------------------
# (b) A staged functions file whose test fails. Still blocks, and the failing
#     test and its error reach the terminal.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(cd "$d" && printf 'export const add = (a: number, b: number) => a + b - 1; // BROKEN\n' > mytribe/functions/src/lib/math.ts && git add -A) >/dev/null 2>&1
STUB_LOADED=0 commit_in "$d" "break math"
if [ "$RC" -ne 0 ]; then ok "(b) a failing related test blocks the commit"; else bad "(b) a failing related test did NOT block the commit"; fi
if has "$OUT" "test/math.test.ts > adds > two and two" && has "$OUT" "AssertionError: expected 3 to be 4"; then
  ok "(b) the failing test name and its error are printed"
else
  bad "(b) the failing test name and error were not printed. Output was:"; printf '%s\n' "$OUT" | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# (c) A staged functions file no test reaches, on a loaded machine. Passes,
#     without the full suite. The old hook ran everything and hit the timeout.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(cd "$d" && echo 'export const alone = 2;' >> mytribe/functions/src/lib/lonely.ts && git add -A) >/dev/null 2>&1
commit_in "$d" "lonely change"
if [ "$RC" -eq 0 ] && ! full_run && ! printf '%s' "$LOGTXT" | grep -q '^ran '; then
  ok "(c) an unrelated functions change commits without running the suite"
else
  bad "(c) unrelated functions change: rc=$RC, runs: $(printf '%s' "$LOGTXT" | tr '\n' ';')"
fi

# (c2) A docs-only change touches no tests at all.
d="$(make_repo)"
(cd "$d" && echo more >> docs/README.md && git add -A) >/dev/null 2>&1
commit_in "$d" "docs"
if [ "$RC" -eq 0 ] && [ -z "$LOGTXT" ]; then ok "(c2) a docs-only change runs no tests"; else bad "(c2) docs-only change: rc=$RC, runs: $LOGTXT"; fi

# ---------------------------------------------------------------------------
# (d) src/index.ts is loaded by path, not imported, so `vitest related` alone
#     finds nothing for it. The test that names it must still run, and when it
#     times out the hook must say it timed out.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(cd "$d" && echo 'export const more = 1;' >> mytribe/functions/src/index.ts && git add -A) >/dev/null 2>&1
commit_in "$d" "index change"
if [ "$RC" -ne 0 ] && printf '%s' "$LOGTXT" | grep -qx 'ran test/indexLoad.test.ts' && ! full_run; then
  ok "(d) a src/index.ts change runs the test that loads it by path, and only that"
else
  bad "(d) src/index.ts change: rc=$RC, runs: $(printf '%s' "$LOGTXT" | tr '\n' ';')"
fi
if has "$OUT" "timed out in 10000ms" && has "$OUT" "A test TIMED OUT"; then
  ok "(d) a timeout is printed and called a timeout"
else
  bad "(d) the timeout was not visible. Output was:"; printf '%s\n' "$OUT" | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# (e) package.json changes how every test runs: whole suite.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(cd "$d" && printf '{ "name": "f", "private": true, "scripts": { "test": "vitest run" }, "x": 1 }\n' > mytribe/functions/package.json && git add -A) >/dev/null 2>&1
STUB_LOADED=0 commit_in "$d" "package.json"
if [ "$RC" -eq 0 ] && full_run; then ok "(e) a package.json change runs the whole suite"; else bad "(e) package.json change: rc=$RC, runs: $LOGTXT"; fi

# ---------------------------------------------------------------------------
# (f) Fresh worktree with no node_modules: blocks and says it is the install.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(cd "$d" && rm -rf mytribe/functions/node_modules && echo '// x' >> mytribe/functions/src/lib/math.ts && git add -A) >/dev/null 2>&1
STUB_LOADED=0 commit_in "$d" "no install"
if [ "$RC" -ne 0 ] && has "$OUT" "mytribe/functions/node_modules is missing"; then
  ok "(f) a missing install blocks and names node_modules"
else
  bad "(f) missing install: rc=$RC. Output was:"; printf '%s\n' "$OUT" | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# (g) Admin functions tree: same merge rule, same visible failure.
# ---------------------------------------------------------------------------
d="$(make_repo)"
(cd "$d" && touch auntieos-admin/web/functions/FAIL_ADMIN && echo '// y' >> auntieos-admin/web/functions/index.js && git add auntieos-admin/web/functions/index.js) >/dev/null 2>&1
STUB_LOADED=0 commit_in "$d" "admin fn"
if [ "$RC" -ne 0 ] && has "$OUT" "not ok 1 - claims are set" && has "$OUT" "expected admin claim"; then
  ok "(g) a failing admin functions test blocks and is printed"
else
  bad "(g) admin functions failure: rc=$RC. Output was:"; printf '%s\n' "$OUT" | sed 's/^/    /'
fi
d="$(make_repo)"
(
  cd "$d" || exit 1
  git checkout -q -b feature
  echo '<p></p>' >> auntieos-admin/web/src/App.html
  git commit -q --no-verify -am "admin web change"
  git checkout -q main
  echo '// main' >> auntieos-admin/web/functions/index.js
  git commit -q --no-verify -am "main changes admin functions"
  git checkout -q feature
  touch auntieos-admin/web/functions/FAIL_ADMIN
  git merge -q --no-commit --no-ff main
) >/dev/null 2>&1
STUB_LOADED=0 commit_in "$d" "merge main"
if [ "$RC" -eq 0 ] && ! printf '%s' "$LOGTXT" | grep -q ADMIN_RUN; then
  ok "(g) a merge bringing in untouched admin functions files skips that suite"
else
  bad "(g) admin merge: rc=$RC, runs: $(printf '%s' "$LOGTXT" | tr '\n' ';')"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
