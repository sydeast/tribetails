#!/usr/bin/env bash
# Tests for release-bg.sh. Run:
#   bash scripts/release-bg.test.sh
#
# WHY THIS EXISTS
# The wrapper's whole job is to launch a release safely when nobody can answer a
# prompt. Two of its behaviours are load-bearing and neither is visible from
# reading the output of a successful run:
#
#   - it must REFUSE when the release changes Firestore indexes, because step 3
#     asks the operator to confirm every index reads Enabled, and code shipped
#     against a still-building index fails at runtime rather than at build;
#   - it must refuse to start a second release while one is running, because two
#     would race on .release-state and the loser's failures would be read as
#     defects in the code.
#
# A wrapper that quietly did the wrong thing in either case would be worse than
# the hand-assembled command it replaces, which at least fails loudly.
#
# The real script under test is launched against a stub release.sh, so the
# launch path (detach, log, pidfile) runs for real and nothing deploys.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

has() { printf '%s' "$1" | grep -qF "$2"; }

# ---------------------------------------------------------------------------
# make_repo: a throwaway repo holding the real wrapper and a fake release.
#
# The stub release.sh records that it ran, and sleeps long enough that a test
# can observe a release "in progress" without the suite waiting on it.
# ---------------------------------------------------------------------------
make_repo() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/scripts" "$dir/mytribe"

  cp "$HERE/release-bg.sh" "$dir/scripts/"
  # The wrapper sources the resume rule it shares with release.sh (#840).
  cp "$HERE/release-progress.sh" "$dir/scripts/"

  cat > "$dir/scripts/release.sh" <<'STUB'
#!/usr/bin/env bash
echo "STUB release ran"
echo "RELEASE_YES=${RELEASE_YES:-unset}"
# Reading stdin proves the wrapper detached it: from /dev/null this is an
# instant EOF, from a terminal it would suspend the job.
if read -r _line; then echo "stdin: got data"; else echo "stdin: eof"; fi
sleep "${STUB_SLEEP:-0}"
echo "STUB release done"
STUB
  chmod +x "$dir/scripts/release.sh"

  printf '{"indexes":[]}\n' > "$dir/mytribe/firestore.indexes.json"

  # The same ignores the real repo has. The resume rule requires a clean tree,
  # so without these the untracked .release-state alone would read as dirty.
  printf '.release-state\n.release-progress\n.release-logs/\n' > "$dir/.gitignore"

  ( cd "$dir"
    git init -q -b main .
    git config user.email t@t.test
    git config user.name Test
    git config commit.gpgsign false
    git add -A
    git commit -qm first
  ) >/dev/null 2>&1

  # The baseline a real release would have written: the commit last shipped.
  ( cd "$dir" && git rev-parse HEAD > .release-state ) 2>/dev/null

  printf '%s' "$dir"
}

# wait_for_pidfile_clear <dir>: let a launched stub finish, without sleeping in
# the test body for longer than it needs.
wait_for_stub() {
  local dir="$1" i=0
  while [ "$i" -lt 100 ]; do
    if grep -q "STUB release done" "$dir"/.release-logs/release-*.log 2>/dev/null; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# 1. The happy path: launches, logs, records a pid, and hands the release the
#    answers it cannot ask for.
# ---------------------------------------------------------------------------
D1="$(make_repo)"
OUT1="$(cd "$D1" && bash scripts/release-bg.sh 2>&1)"
RC1=$?

if [ "$RC1" -eq 0 ] && has "$OUT1" "release started: pid"; then
  ok "launches and reports its pid"
else
  bad "did not launch; rc=$RC1"; printf '%s\n' "$OUT1"
fi

LOG1="$(ls "$D1"/.release-logs/release-*.log 2>/dev/null | head -1)"
if [ -n "$LOG1" ]; then
  ok "writes a timestamped log under .release-logs/"
else
  bad "no log file written"
fi

if has "$OUT1" ".release-logs/release-"; then
  ok "prints the log path it just created"
else
  bad "did not tell the operator where to watch"; printf '%s\n' "$OUT1"
fi

wait_for_stub "$D1"

if grep -q "RELEASE_YES=1" "$LOG1" 2>/dev/null; then
  ok "passes RELEASE_YES=1, since a detached run cannot answer a prompt"
else
  bad "release would have blocked on the confirm"; cat "$LOG1" 2>/dev/null
fi

# The SIGTTIN fix, asserted rather than assumed: stdin must be /dev/null, so a
# read returns EOF instantly instead of stopping the job on the terminal.
if grep -q "stdin: eof" "$LOG1" 2>/dev/null; then
  ok "detaches stdin, so a tty read cannot suspend the run"
else
  bad "stdin was not detached"; cat "$LOG1" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# 2. Changed indexes must refuse. This is the one case where skipping the
#    prompt would ship code against an index that is still building.
# ---------------------------------------------------------------------------
D2="$(make_repo)"
( cd "$D2"
  printf '{"indexes":[{"collectionGroup":"bookings"}]}\n' > mytribe/firestore.indexes.json
  git add -A && git commit -qm "add an index" ) >/dev/null 2>&1
OUT2="$(cd "$D2" && bash scripts/release-bg.sh 2>&1)"
RC2=$?

if [ "$RC2" -ne 0 ] && has "$OUT2" "REFUSED"; then
  ok "refuses when the release changes Firestore indexes"
else
  bad "launched despite changed indexes; rc=$RC2"; printf '%s\n' "$OUT2"
fi

if [ -z "$(ls "$D2"/.release-logs/release-*.log 2>/dev/null)" ]; then
  ok "a refusal starts nothing at all"
else
  bad "a refused run still launched a release"
fi

if has "$OUT2" "npm run deploy" && has "$OUT2" "RELEASE_BG_FORCE=1"; then
  ok "names both ways forward instead of just saying no"
else
  bad "refusal did not say what to do instead"; printf '%s\n' "$OUT2"
fi

# The override exists for the operator who has already looked at the console.
OUT2B="$(cd "$D2" && RELEASE_BG_FORCE=1 bash scripts/release-bg.sh 2>&1)"
if has "$OUT2B" "release started: pid" && has "$OUT2B" "on your say-so"; then
  ok "RELEASE_BG_FORCE=1 proceeds, and says that it skipped the check"
else
  bad "force override did not work or did not announce itself"; printf '%s\n' "$OUT2B"
fi
wait_for_stub "$D2"

# ---------------------------------------------------------------------------
# 3. An unknown baseline reads as "changed". A missing .release-state means the
#    index diff has nothing to compare against, and "cannot tell" must not
#    resolve to "fine" for the question that protects a runtime failure.
# ---------------------------------------------------------------------------
D3="$(make_repo)"
rm -f "$D3/.release-state"
OUT3="$(cd "$D3" && bash scripts/release-bg.sh 2>&1)"
RC3=$?

if [ "$RC3" -ne 0 ] && has "$OUT3" "REFUSED"; then
  ok "an unknown baseline refuses rather than assuming indexes are unchanged"
else
  bad "launched with no baseline to compare against; rc=$RC3"; printf '%s\n' "$OUT3"
fi

# ---------------------------------------------------------------------------
# 4. One release at a time. Two would race on .release-state, and the second
#    one's failures would be read as defects in the code.
# ---------------------------------------------------------------------------
D4="$(make_repo)"
( cd "$D4" && STUB_SLEEP=5 bash scripts/release-bg.sh >/dev/null 2>&1 )
OUT4="$(cd "$D4" && bash scripts/release-bg.sh 2>&1)"
RC4=$?

if [ "$RC4" -ne 0 ] && has "$OUT4" "already running"; then
  ok "refuses to start a second release while one is running"
else
  bad "started a concurrent release; rc=$RC4"; printf '%s\n' "$OUT4"
fi

if has "$OUT4" "tail -f" && has "$OUT4" "kill "; then
  ok "points at the running release rather than just refusing"
else
  bad "did not say how to watch or stop the running release"; printf '%s\n' "$OUT4"
fi

# And once it has finished, the stale pidfile must not block the next one.
wait_for_stub "$D4"
sleep 1
OUT4B="$(cd "$D4" && bash scripts/release-bg.sh 2>&1)"
if has "$OUT4B" "release started: pid"; then
  ok "a finished release leaves no lock behind"
else
  bad "stale pidfile blocked the next release"; printf '%s\n' "$OUT4B"
fi
wait_for_stub "$D4"

# ---------------------------------------------------------------------------
# 5. Runs from the repo root whatever the caller's cwd. release.sh reads and
#    writes .release-state relative to the root, and this repo has already
#    shipped a release from the wrong directory once.
# ---------------------------------------------------------------------------
D5="$(make_repo)"
mkdir -p "$D5/mytribe/functions/src"
OUT5="$(cd "$D5/mytribe/functions/src" && bash "$D5/scripts/release-bg.sh" 2>&1)"

if has "$OUT5" "release started: pid" && [ -n "$(ls "$D5"/.release-logs/release-*.log 2>/dev/null)" ]; then
  ok "launched from a subdirectory still writes to the repo root"
else
  bad "cwd leaked into where the release ran"; printf '%s\n' "$OUT5"
fi
wait_for_stub "$D5"

# ---------------------------------------------------------------------------
# 6. A RESUMED release (#840). The operator's documented command is deploy:bg.
#    When an earlier run of this exact commit passed the index step and stopped
#    later, .release-state still names the previous release, so the index diff
#    says "changed". The wrapper must let that resume through, and only that.
# ---------------------------------------------------------------------------

# index_change_repo: a repo whose HEAD adds an index since .release-state.
index_change_repo() {
  local d
  d="$(make_repo)"
  ( cd "$d"
    printf '{"indexes":[{"collectionGroup":"bookings"}]}\n' > mytribe/firestore.indexes.json
    git add -A && git commit -qm "add an index" ) >/dev/null 2>&1
  printf '%s' "$d"
}

D6="$(index_change_repo)"
( cd "$D6" && printf '%s indexes\n' "$(git rev-parse HEAD)" > .release-progress )
OUT6="$(cd "$D6" && bash scripts/release-bg.sh 2>&1)"
RC6=$?
if [ "$RC6" -eq 0 ] && has "$OUT6" "release started: pid" && has "$OUT6" "resumed: an earlier run"; then
  ok "a resumed run with changed indexes proceeds, and says it is resuming"
else
  bad "a resumed run was refused; rc=$RC6"; printf '%s\n' "$OUT6"
fi
if has "$OUT6" "on your say-so"; then
  bad "a resumed run claimed RELEASE_BG_FORCE"
else
  ok "a resumed run is not reported as forced"
fi
wait_for_stub "$D6"

# The record names the PREVIOUS commit: a different sha never resumes.
D7="$(index_change_repo)"
( cd "$D7" && printf '%s indexes\n' "$(git rev-parse HEAD~1)" > .release-progress )
OUT7="$(cd "$D7" && bash scripts/release-bg.sh 2>&1)"
RC7=$?
if [ "$RC7" -ne 0 ] && has "$OUT7" "REFUSED" && [ -z "$(ls "$D7"/.release-logs/release-*.log 2>/dev/null)" ]; then
  ok "index progress recorded for a different commit still refuses"
else
  bad "a different commit's progress let changed indexes through; rc=$RC7"; printf '%s\n' "$OUT7"
fi

D8="$(index_change_repo)"
( cd "$D8" && printf '%s indexes\n' "$(git rev-parse HEAD)" > .release-progress )
OUT8="$(cd "$D8" && RELEASE_NO_RESUME=1 bash scripts/release-bg.sh 2>&1)"
RC8=$?
if [ "$RC8" -ne 0 ] && has "$OUT8" "REFUSED"; then
  ok "RELEASE_NO_RESUME=1 still refuses changed indexes"
else
  bad "RELEASE_NO_RESUME=1 let changed indexes through; rc=$RC8"; printf '%s\n' "$OUT8"
fi

D9="$(index_change_repo)"
( cd "$D9" && printf '%s indexes\n' "$(git rev-parse HEAD)" > .release-progress && printf 'x\n' > stray.txt )
OUT9="$(cd "$D9" && bash scripts/release-bg.sh 2>&1)"
RC9=$?
if [ "$RC9" -ne 0 ] && has "$OUT9" "REFUSED"; then
  ok "a dirty tree never resumes, so changed indexes still refuse"
else
  bad "a dirty tree let changed indexes through; rc=$RC9"; printf '%s\n' "$OUT9"
fi

echo
echo "release-bg tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
