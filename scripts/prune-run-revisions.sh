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

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=auntieos-ttpc
REGION=us-central1
KEEP="${1:-10}"
PARALLEL="${PRUNE_PARALLEL:-6}"

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

echo "deleting $TO_DELETE revisions ($PARALLEL at a time, retrying rate limits) ..."

# Input is PIPED, not `xargs -a`: that flag is GNU-only and macOS ships BSD
# xargs, which rejects it. An earlier version used it, xargs exited immediately
# with a usage error, and the run reported success over having deleted nothing.
export PROJECT REGION
xargs -P "$PARALLEL" -I{} sh -c '
  name="$1"
  for attempt in 1 2 3 4 5; do
    if gcloud run revisions delete "$name" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>/tmp/prune_err.$$; then
      exit 0
    fi
    # 429 means slow down, not stop. Anything else is a real failure.
    if grep -q "429" /tmp/prune_err.$$ 2>/dev/null; then
      sleep $((attempt * 3))
      continue
    fi
    cat /tmp/prune_err.$$ >> '"$WORK"'/errors.log 2>/dev/null
    echo "$name" >> '"$WORK"'/failed.txt
    rm -f /tmp/prune_err.$$
    exit 0
  done
  echo "$name" >> '"$WORK"'/failed.txt
  rm -f /tmp/prune_err.$$
' _ {} < "$WORK/to_delete.txt"

AFTER=$(gcloud run revisions list --project "$PROJECT" --region "$REGION" --format='value(metadata.name)' 2>/dev/null | wc -l | tr -d ' ')
REMOVED=$((BEFORE - AFTER))
FAILED=0
[ -f "$WORK/failed.txt" ] && FAILED=$(wc -l < "$WORK/failed.txt" | tr -d ' ')

echo "before: $BEFORE   after: $AFTER   removed: $REMOVED   failed: $FAILED"

# A prune that deleted nothing must never read as success: that is how the first
# version of this hid a run in which xargs had not executed at all.
if [ "$REMOVED" -le 0 ] && [ "$TO_DELETE" -gt 0 ]; then
  red "NOTHING WAS DELETED despite $TO_DELETE candidates. Do not treat this as pruned."
  [ -s "$WORK/errors.log" ] && head -3 "$WORK/errors.log" >&2
  exit 1
fi

[ "$FAILED" -gt 0 ] && ylw "$FAILED revisions could not be deleted; they will be retried next release."
grn "prune: $REMOVED revisions removed, $AFTER remaining."
