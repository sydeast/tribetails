#!/usr/bin/env bash
# Tests for prune-run-revisions.sh. Run:
#   bash scripts/prune-run-revisions.test.sh
#
# WHY THIS EXISTS
# On 2026-08-03 step 8 of a real release printed:
#
#   plan: 903 revisions, 240 serving, keep newest 3/service, delete 197
#   before: 903   after: 0   removed: 903   failed: 30
#   prune: 903 revisions removed, 0 remaining.
#
# It had deleted at most 197 and the region still held 240 serving revisions,
# which the prune is incapable of touching. The count came from re-listing the
# region afterwards and subtracting, and that listing came back empty. So the
# script reported a total wipe of a project it had barely trimmed, in green, and
# the release signed off on it.
#
# `gcloud run revisions list` returning nothing is not an exception here: it
# prints nothing and EXITS 0 (reproduced under a shell with no network, after a
# multi-minute stall). Checking the exit status would not have caught it.
#
# So the counts now come from the deletions the workers actually completed, and
# these tests hold that line: what is reported removed can never exceed what was
# planned, and a listing that comes back empty cannot inflate anything, because
# nothing re-lists.
#
# The stub gcloud is the whole outside world. The script under test is the real
# one, byte for byte.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# ---------------------------------------------------------------------------
# make_env: a throwaway directory holding the fixtures, the stub, and the logs.
#
# Fixtures are two services of six revisions each, newest last by timestamp,
# with the newest of each serving traffic. At keep=1 that protects exactly the
# serving revision and plans the other five per service: 12 revisions, 10 to
# delete. Small enough to assert on by hand, and shaped like the real thing.
# ---------------------------------------------------------------------------
make_env() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/stubs"

  : > "$dir/revisions.csv"
  for svc in alpha beta; do
    for i in 1 2 3 4 5 6; do
      echo "$svc-00$i,$svc,2026-08-0${i}T00:00:00Z" >> "$dir/revisions.csv"
    done
  done
  printf 'alpha,alpha-006\nbeta,beta-006\n' > "$dir/serving.csv"

  # The stub answers the two reads from fixture files and records every call, so
  # a test can assert on HOW MANY times the region was listed, not just on what
  # came back. DELETE_FAIL holds names that fail for a non-429 reason;
  # DELETE_ALL_FAIL=1 fails every one.
  cat > "$dir/stubs/gcloud" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"run revisions list"*)
    echo "revisions-list" >> "$CALL_LOG"
    # After the deletions have started, the region listing comes back EMPTY and
    # exits 0. This is the 2026-08-03 failure, reproduced. Anything that
    # subtracts this from the opening count reads it as a total wipe.
    [ -s "$DELETE_LOG" ] && exit 0
    cat "$FIXTURES/revisions.csv"
    exit 0
    ;;
  *"run services list"*)
    echo "services-list" >> "$CALL_LOG"
    cat "$FIXTURES/serving.csv"
    exit 0
    ;;
  *"run revisions delete"*)
    name=""
    for a in "$@"; do
      case "$a" in
        delete) continue ;;
        -*|run|revisions) continue ;;
        *) [ -z "$name" ] && name="$a" ;;
      esac
    done
    if [ "${DELETE_ALL_FAIL:-0}" = "1" ]; then
      echo "FAILED_PRECONDITION: stub refuses $name" >&2
      exit 1
    fi
    if [ -n "${DELETE_FAIL:-}" ] && printf '%s\n' "$DELETE_FAIL" | grep -qx "$name"; then
      echo "FAILED_PRECONDITION: stub refuses $name" >&2
      exit 1
    fi
    echo "$name" >> "$DELETE_LOG"
    exit 0
    ;;
esac
exit 0
STUB
  chmod +x "$dir/stubs/gcloud"

  printf '%s' "$dir"
}

# run_prune <dir> <keep>: the real script, stubs first on PATH.
run_prune() {
  local dir="$1" keep="$2"
  : > "$dir/calls.log"
  : > "$dir/deleted.log"
  PATH="$dir/stubs:$PATH" \
  FIXTURES="$dir" CALL_LOG="$dir/calls.log" DELETE_LOG="$dir/deleted.log" \
    bash "$HERE/prune-run-revisions.sh" "$keep" 2>&1
}

# ---------------------------------------------------------------------------
# 1. The reported count is what was deleted, not a listing minus a listing.
# ---------------------------------------------------------------------------
D1="$(make_env)"
OUT1="$(run_prune "$D1" 1)"
RC1=$?

if printf '%s' "$OUT1" | grep -q "deleted: 10"; then
  ok "reports the 10 deletions it made"
else
  bad "wrong deleted count"; printf '%s\n' "$OUT1"
fi

# The bug in one assertion: 12 is the opening inventory, and the empty listing
# after the deletions makes "before minus after" equal exactly that.
if printf '%s' "$OUT1" | grep -qE "deleted: 12|removed: 12|12 revisions removed"; then
  bad "reported the whole inventory as removed; the recount inflated the count again"
else
  ok "an empty listing after the deletions does not inflate the count"
fi

if [ "$(wc -l < "$D1/deleted.log" | tr -d ' ')" = "10" ]; then
  ok "deleted exactly the 10 planned revisions"
else
  bad "deleted $(wc -l < "$D1/deleted.log" | tr -d ' ') revisions, expected 10"
fi

if grep -qE '^(alpha|beta)-006$' "$D1/deleted.log"; then
  bad "a SERVING revision was deleted"
else
  ok "never deletes a serving revision"
fi

# One listing, before the deletions. A second one is the whole failure mode: it
# is slow, it fails silently, and nothing it returns is worth a wrong number.
if [ "$(grep -c revisions-list "$D1/calls.log")" = "1" ]; then
  ok "lists the region once, and does not re-list to count"
else
  bad "listed the region $(grep -c revisions-list "$D1/calls.log") times"
fi

if printf '%s' "$OUT1" | grep -q "remaining (derived): 2"; then
  ok "remaining is derived from the deletions and labelled as derived"
else
  bad "remaining not reported as derived"; printf '%s\n' "$OUT1"
fi

if [ "$RC1" -eq 0 ]; then ok "a clean prune exits 0"; else bad "clean prune exited $RC1"; fi

# ---------------------------------------------------------------------------
# 2. Failures are subtracted from the total, not absorbed into it.
# ---------------------------------------------------------------------------
D2="$(make_env)"
OUT2="$(DELETE_FAIL="$(printf 'alpha-001\nalpha-002\nbeta-001\n')" run_prune "$D2" 1)"

if printf '%s' "$OUT2" | grep -q "deleted: 7" && printf '%s' "$OUT2" | grep -q "failed: 3"; then
  ok "three refusals report as 7 deleted, 3 failed"
else
  bad "partial failure miscounted"; printf '%s\n' "$OUT2"
fi

if printf '%s' "$OUT2" | grep -q "recorded neither success nor failure"; then
  bad "counts that add up were reported as unaccounted for"
else
  ok "counts that add up raise nothing"
fi

# ---------------------------------------------------------------------------
# 3. Deleting nothing must be loud. This is the guard the original had, and it
#    has to survive the rewrite: it caught a run in which xargs never executed
#    and the script reported success over having done nothing at all.
# ---------------------------------------------------------------------------
D3="$(make_env)"
OUT3="$(DELETE_ALL_FAIL=1 run_prune "$D3" 1)"
RC3=$?

if [ "$RC3" -ne 0 ]; then
  ok "a prune that deleted nothing exits non-zero"
else
  bad "a prune that deleted nothing exited 0"
fi

if printf '%s' "$OUT3" | grep -q "NOTHING WAS DELETED"; then
  ok "a prune that deleted nothing says so"
else
  bad "silent no-op prune"; printf '%s\n' "$OUT3"
fi

if printf '%s' "$OUT3" | grep -q "revisions removed"; then
  bad "still printed a success line after deleting nothing"
else
  ok "prints no success line after deleting nothing"
fi

# ---------------------------------------------------------------------------
# 4. A keep deep enough to protect everything deletes nothing, and that is not
#    a failure. Keep-10 against six revisions per service is the real default
#    that could never fire; it must exit clean rather than trip the guard above.
# ---------------------------------------------------------------------------
D4="$(make_env)"
OUT4="$(run_prune "$D4" 10)"
RC4=$?

if [ "$RC4" -eq 0 ] && printf '%s' "$OUT4" | grep -q "nothing to prune"; then
  ok "a keep above the inventory exits clean with nothing to prune"
else
  bad "keep-10 did not exit clean; rc=$RC4"; printf '%s\n' "$OUT4"
fi

echo
echo "prune tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
