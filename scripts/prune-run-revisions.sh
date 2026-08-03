#!/usr/bin/env bash
# prune-run-revisions.sh [keep] — delete old Cloud Run revisions in us-central1.
#
# WHY THIS EXISTS
# Cloud Run keeps every revision forever, and each one holds CPU against the
# project's regional "total allowable CPU" quota. Nothing reclaimed them here,
# so they reached 7,266 across 228 services and exhausted us-central1. That
# failed 18 functions in the middle of a release on 2026-07-26, then blocked the
# retry the next day, then blocked it AGAIN when the release redeployed
# unchanged functions and minted 200 more. Deploys were impossible until ~5,300
# revisions were deleted by hand.
#
# WHAT IT WILL NOT DO
#   - never deletes a revision a service is currently SERVING;
#   - keeps the newest <keep> per service (default 10) so rollback stays real;
#   - refuses to delete anything at all if the plan somehow contains a serving
#     revision, rather than deleting "most of" a bad plan.
#
# RATE LIMITS ARE EXPECTED. The Cloud Run Admin API returns 429 under load; a
# first attempt at 20-way parallelism lost 960 deletions to it. Concurrency is
# therefore modest and 429s are RETRIED with a backoff rather than counted as
# failures, because they are not failures, they are being asked to slow down.
#
#   scripts/prune-run-revisions.sh          # keep 10 per service
#   scripts/prune-run-revisions.sh 5        # keep 5
#   DRY_RUN=1 scripts/prune-run-revisions.sh
#   PRUNE_MAX_SECONDS=0 scripts/prune-run-revisions.sh 3   # no time budget

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=auntieos-ttpc
REGION=us-central1
KEEP="${1:-10}"
PARALLEL="${PRUNE_PARALLEL:-6}"

# WALL-CLOCK BUDGET. 0 disables.
#
# THE COST OF A DELETION IS NOT FIXED, AND THAT IS THE WHOLE REASON FOR A BUDGET.
#
# Measured 2026-08-03, both ends of the range on the same day:
#
#   uncontended   296 deletions, under 5 minutes, 0 failures   (~6s each at P=6)
#   during a release   still running at 55 minutes, killed; a second run the same
#                      day lost 30 of 197 outright
#
# So the honest statement is that this is fast when it is the only thing talking
# to the API and slow when it is not. An earlier version of this comment claimed
# ~90 seconds per deletion as if it were a constant, having generalised from the
# contended case alone. It is not a constant, and the fast case is the common one.
#
# The budget is therefore NOT here because the work is inherently long. It is
# here because the duration is unpredictable and this step runs inside a release,
# where an unbounded tail is what makes an operator reach for ctrl-c. On
# 2026-08-03 one was killed at 55 minutes for looking stuck. It was not stuck; it
# was contended, and nothing in its output could say so.
#
# The prune does not have to finish. It re-plans from the live inventory every
# run, so anything skipped is simply first in line next time, and the depth it
# leaves is bounded by how far behind it gets rather than by any single run.
#
# 900 (15 min) is three times the measured uncontended cost of a full backlog,
# so it never truncates a healthy run and does cap a pathological one. Set 0 for
# unbounded when burning down a backlog by hand, where you do want it to finish.
#
# ASYNC DELETES WERE CONSIDERED AND REJECTED, and the measurement is why.
# `gcloud run revisions delete --async` returns once the request is accepted
# rather than once the revision is gone, which would turn the deleted count back
# into an accepted count, the exact distinction this script exists to keep. It
# was worth pricing when a deletion looked like 90 seconds. At 6 seconds it buys
# nothing worth that. There is also no `gcloud run operations` surface, so an
# async delete offers no completion signal to check afterwards.
MAX_SECONDS="${PRUNE_MAX_SECONDS:-900}"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

command -v gcloud >/dev/null 2>&1 || { ylw "gcloud not installed; skipping prune."; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "reading revisions in $REGION ..."
gcloud run revisions list --project "$PROJECT" --region "$REGION" \
  --format='csv[no-heading](metadata.name,metadata.labels."serving.knative.dev/service",metadata.creationTimestamp)' \
  2>/dev/null > "$WORK/revisions.csv" || { ylw "could not list revisions; skipping."; exit 0; }

gcloud run services list --project "$PROJECT" --region "$REGION" \
  --format='csv[no-heading](metadata.name,status.traffic[].revisionName)' \
  2>/dev/null > "$WORK/serving.csv" || { ylw "could not list services; skipping."; exit 0; }

BEFORE=$(wc -l < "$WORK/revisions.csv" | tr -d ' ')
echo "revisions: $BEFORE   keeping newest $KEEP per service, plus every serving revision"

KEEP="$KEEP" python3 "$ROOT/scripts/plan_run_prune.py" "$WORK/revisions.csv" "$WORK/serving.csv" "$WORK/to_delete.txt" || {
  red "could not build a safe prune plan; deleting nothing."
  exit 1
}

TO_DELETE=$(wc -l < "$WORK/to_delete.txt" | tr -d ' ')
if [ "$TO_DELETE" -eq 0 ]; then
  grn "nothing to prune."
  exit 0
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  ylw "DRY_RUN=1: would delete $TO_DELETE revisions. First 5:"
  head -5 "$WORK/to_delete.txt"
  exit 0
fi

if [ "$MAX_SECONDS" = "0" ]; then
  echo "deleting $TO_DELETE revisions ($PARALLEL at a time, retrying rate limits, no time budget) ..."
else
  echo "deleting $TO_DELETE revisions ($PARALLEL at a time, retrying rate limits, ${MAX_SECONDS}s budget) ..."
fi

# CHUNKED, so the budget can be honoured BETWEEN chunks.
#
# Feeding the whole list to one xargs and gating the pipe does not work: the
# list is a few kilobytes, so every name fits in the pipe buffer and is written
# before the first deletion returns, which makes the gate a no-op. A barrier
# every 4*PARALLEL names costs a little idle time at each boundary and is the
# only place where a decision to stop can actually be taken.
mkdir -p "$WORK/chunks"
split -l "$((PARALLEL * 4))" "$WORK/to_delete.txt" "$WORK/chunks/c"

DEADLINE=0
[ "$MAX_SECONDS" != "0" ] && DEADLINE=$(( $(date +%s) + MAX_SECONDS ))
ATTEMPTED=0
STOPPED_EARLY=0

# Input is PIPED, not `xargs -a`: that flag is GNU-only and macOS ships BSD
# xargs, which rejects it. An earlier version used it, xargs exited immediately
# with a usage error, and the run reported success over having deleted nothing.
export PROJECT REGION
for chunk in "$WORK"/chunks/c*; do
  if [ "$DEADLINE" != "0" ] && [ "$(date +%s)" -ge "$DEADLINE" ]; then
    STOPPED_EARLY=1
    break
  fi
  ATTEMPTED=$((ATTEMPTED + $(wc -l < "$chunk" | tr -d ' ')))
  xargs -P "$PARALLEL" -I{} sh -c '
  name="$1"
  for attempt in 1 2 3 4 5; do
    if gcloud run revisions delete "$name" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>/tmp/prune_err.$$; then
      echo "$name" >> '"$WORK"'/deleted.txt
      rm -f /tmp/prune_err.$$
      exit 0
    fi
    # 429 means slow down, not stop. Anything else is a real failure.
    if grep -q "429" /tmp/prune_err.$$ 2>/dev/null; then
      sleep $((attempt * 3))
      continue
    fi
    # One line, so the summary below can group by it. gcloud puts the useful
    # sentence on the line starting ERROR:; anything else is a stack of context
    # around it. A failure that produced no output at all still records a
    # reason, because "30 failed" and nothing else is what this run printed on
    # 2026-08-03 and nobody could act on it.
    reason=$(grep -m1 "ERROR:" /tmp/prune_err.$$ 2>/dev/null | cut -c1-200)
    [ -z "$reason" ] && reason=$(grep -m1 . /tmp/prune_err.$$ 2>/dev/null | cut -c1-200)
    [ -z "$reason" ] && reason="gcloud failed and printed nothing"
    echo "$reason" >> '"$WORK"'/reasons.txt
    printf "%s\t%s\n" "$name" "$reason" >> '"$WORK"'/errors.log
    echo "$name" >> '"$WORK"'/failed.txt
    rm -f /tmp/prune_err.$$
    exit 0
  done
  echo "rate limited (429), still refused after 5 attempts" >> '"$WORK"'/reasons.txt
  printf "%s\trate limited (429), still refused after 5 attempts\n" "$name" >> '"$WORK"'/errors.log
  echo "$name" >> '"$WORK"'/failed.txt
  rm -f /tmp/prune_err.$$
' _ {} < "$chunk"
done

# COUNT THE DELETIONS THAT SUCCEEDED. DO NOT RE-LIST AND SUBTRACT.
#
# This used to recount the region afterwards and report BEFORE - AFTER as the
# number removed. On 2026-08-03 that printed "before: 903 after: 0 removed: 903"
# for a run whose own plan deleted 197, and step 8 signed off "903 revisions
# removed, 0 remaining" over a region that still held 240 serving revisions
# alone. Every number after the plan was invented.
#
# The recount fails SILENTLY. `gcloud run revisions list` can print nothing and
# still exit 0 (reproduced under a sandboxed shell with no network, where it
# returned empty after a multi-minute stall). So checking its exit status would
# not have caught this, and neither would a retry. Any accounting that
# subtracts a list from a list will read a lost
# listing as a total wipe, which is the most reassuring possible way to be
# wrong, and it is wrong in the direction that stops anyone looking.
#
# So the workers record what they actually deleted and that file is the count.
# It cannot over-report: a name lands in deleted.txt only after gcloud returned
# success for that name. It still catches the xargs-never-ran case the old
# guard existed for, because then nothing is recorded and the count is zero.
DELETED=0
[ -f "$WORK/deleted.txt" ] && DELETED=$(wc -l < "$WORK/deleted.txt" | tr -d ' ')
FAILED=0
[ -f "$WORK/failed.txt" ] && FAILED=$(wc -l < "$WORK/failed.txt" | tr -d ' ')

# Derived, and labelled as derived. Nothing else mints revisions while this
# runs (step 8 is after every deploy), so it is sound, but it is arithmetic on
# the opening listing rather than a fresh observation and must not read as one.
REMAINING=$((BEFORE - DELETED))

echo "before: $BEFORE   deleted: $DELETED   failed: $FAILED   remaining (derived): $REMAINING"

# STOPPING EARLY IS A RESULT, NOT AN ERROR, AND IT HAS TO BE SAID.
#
# A budget that silently trims the work would be a quieter version of the bug
# this script keeps having: a number that reads as complete when it is not. The
# skipped names are not lost, they are simply first in line next run, because
# the plan is rebuilt from the live inventory every time.
SKIPPED=$((TO_DELETE - ATTEMPTED))
if [ "$STOPPED_EARLY" = "1" ]; then
  ylw "stopped after $ATTEMPTED of $TO_DELETE: the ${MAX_SECONDS}s budget ran out."
  ylw "  $SKIPPED revisions were not attempted. They are re-planned next run."
  ylw "  PRUNE_MAX_SECONDS=0 runs to completion, for burning down a backlog."
fi

# Attempted, minus the two known outcomes, should be nothing. If it is not, some
# worker died without recording either, so the counts undercount and the caller
# should know that rather than read a clean total. Measured against what was
# ATTEMPTED rather than what was planned, or every budgeted run would report its
# own skipped names as workers that vanished.
UNACCOUNTED=$((ATTEMPTED - DELETED - FAILED))
if [ "$UNACCOUNTED" -ne 0 ]; then
  ylw "$UNACCOUNTED of $ATTEMPTED attempted recorded neither success nor failure."
  ylw "  Treat the counts above as a floor, not a total."
fi

# A prune that deleted nothing must never read as success: that is how the first
# version of this hid a run in which xargs had not executed at all. Keyed on
# ATTEMPTED, so a run whose budget expired before the first chunk says so above
# rather than being reported as a failure to delete.
if [ "$DELETED" -le 0 ] && [ "$ATTEMPTED" -gt 0 ]; then
  red "NOTHING WAS DELETED despite $TO_DELETE candidates. Do not treat this as pruned."
  [ -s "$WORK/errors.log" ] && head -3 "$WORK/errors.log" >&2
  exit 1
fi

# SAY WHY THEY FAILED.
#
# The 2026-08-03 run reported "failed: 30" and stopped there. Thirty deletions
# refused for an unstated reason reads as weather; it might have been one
# expired credential, or a serving revision the plan should never have listed,
# and neither the operator nor the next release could tell which. "They will be
# retried next release" is only true for causes that pass, and nothing here
# knew whether this was one.
#
# Grouped rather than listed: 30 copies of one message is one fact, and the
# per-revision detail is in errors.log for anyone who wants it.
if [ "$FAILED" -gt 0 ]; then
  ylw "$FAILED revisions could not be deleted; they will be retried next release."
  if [ -s "$WORK/reasons.txt" ]; then
    sort "$WORK/reasons.txt" | uniq -c | sort -rn | head -3 |
      awk '{ n=$1; $1=""; sub(/^ /, ""); printf "  %sx %s\n", n, $0 }' >&2
  fi
fi
grn "prune: $DELETED revisions removed, ~$REMAINING remaining."
