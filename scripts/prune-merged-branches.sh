#!/usr/bin/env bash
# prune-merged-branches.sh — delete remote branches already merged into main.
#
# WHY THIS EXISTS
# Nothing ever deleted a branch here. By 2026-08-04 origin held 197 of them and
# 180 were fully merged into main, so `git branch -r` was 90% archaeology. The
# cost is not storage, it is that every branch listing, every tab-complete and
# every "is this still live?" question got answered against a list where nine
# names in ten were dead. Pruning them by hand is the kind of chore that gets
# done once and never again, so it runs at the end of a release instead.
#
# WHAT IT WILL NOT DELETE
#   - main, or the branch the release is running from;
#   - anything whose tip is NOT an ancestor of origin/main, checked per branch
#     against the remote sha rather than trusting one `--merged` listing;
#   - the head of any OPEN pull request, when gh is available to say so;
#   - anything whose tip commit is newer than the grace period (below).
#
# THE GRACE PERIOD IS NOT PARANOIA, IT IS A BUG THAT ALREADY HAPPENED.
# On 2026-08-04, PR #231 merged while a second commit was still being pushed to
# its branch. The merge took the first commit only. The branch outlived its PR
# carrying real work that was not in main, and the fix was to cherry-pick from
# it. A prune with no grace period, run in that window, would have deleted the
# branch, and the ancestor check would NOT have saved it: the branch was merged,
# it just was not FINISHED. So a branch has to be quiet for a while before it
# counts as done. Default 1 day, override with BRANCH_PRUNE_MIN_AGE_DAYS.
#
# IT NEVER FAILS THE RELEASE. This is hygiene running after the tag is pushed
# and the release is already true. Exiting non-zero here would turn a cosmetic
# problem into an operator waking up to a red release that actually shipped.
#
#   scripts/prune-merged-branches.sh              # prune, honoring the defaults
#   DRY_RUN=1 scripts/prune-merged-branches.sh    # print the plan, delete nothing
#   BRANCH_PRUNE_MIN_AGE_DAYS=7 scripts/...       # a week of quiet before deleting
#   RELEASE_PRUNE_BRANCHES=0                      # release.sh skips this entirely

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# It operates on the repo this script LIVES in, not on whatever directory it was
# invoked from, so a release run from a subdirectory cannot prune something else.
# BRANCH_PRUNE_REPO overrides that, and exists for the tests, which need a
# scratch repo with a real remote to assert against.
cd "${BRANCH_PRUNE_REPO:-$ROOT}" || exit 0

MIN_AGE_DAYS="${BRANCH_PRUNE_MIN_AGE_DAYS:-1}"
DRY_RUN="${DRY_RUN:-0}"
RESTORE_FILE="${BRANCH_PRUNE_RESTORE_FILE:-$HOME/tribetails-branch-prune-$(date +%Y-%m-%d).txt}"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

# Refuse rather than guess. Every check below reads remote state, and a stale
# view is exactly how a live branch looks merged.
if ! git fetch --prune --quiet origin 2>/dev/null; then
  ylw "branch prune: could not fetch origin, skipping. Nothing was deleted."
  exit 0
fi

# OPEN PRs ARE READ FROM gh, AND ITS ABSENCE IS NOT TREATED AS "NONE OPEN".
# An empty list from a missing or unauthenticated gh looks identical to a repo
# with no open PRs, and one of those two readings deletes branches under review.
#
# BRANCH_PRUNE_OPEN_HEADS states the list directly, newline separated, and skips
# gh entirely. The tests use it, since a scratch repo has no GitHub side. Set it
# to the empty string to assert "I checked, none are open" on a machine without
# gh; leaving it unset is not that assertion and does not delete anything.
OPEN_HEADS=""
if [ -n "${BRANCH_PRUNE_OPEN_HEADS+x}" ]; then
  OPEN_HEADS="$BRANCH_PRUNE_OPEN_HEADS"
elif command -v gh >/dev/null 2>&1; then
  if OPEN_HEADS="$(gh pr list --state open --limit 200 --json headRefName -q '.[].headRefName' 2>/dev/null)"; then
    :
  else
    ylw "branch prune: gh could not list open PRs, skipping. Nothing was deleted."
    exit 0
  fi
else
  ylw "branch prune: gh is not installed, so open PRs cannot be excluded."
  ylw "  Skipping. Nothing was deleted."
  exit 0
fi

CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
NOW="$(date +%s)"
CUTOFF=$(( NOW - MIN_AGE_DAYS * 86400 ))

CANDIDATES=()
SKIPPED_YOUNG=0
SKIPPED_OPEN=0

while read -r sha ref; do
  [ -n "$sha" ] || continue
  branch="${ref#refs/remotes/origin/}"

  case "$branch" in
    main|HEAD|"$CURRENT") continue ;;
  esac

  # Merged, checked against this exact sha. `git branch -r --merged` is a
  # listing; this is the assertion, and it is the one that decides.
  git merge-base --is-ancestor "$sha" origin/main 2>/dev/null || continue

  if printf '%s\n' "$OPEN_HEADS" | grep -qxF "$branch"; then
    SKIPPED_OPEN=$(( SKIPPED_OPEN + 1 ))
    continue
  fi

  tip_time="$(git log -1 --format=%ct "$sha" 2>/dev/null || echo 0)"
  if [ "$tip_time" -gt "$CUTOFF" ]; then
    SKIPPED_YOUNG=$(( SKIPPED_YOUNG + 1 ))
    continue
  fi

  CANDIDATES+=("$sha $branch")
done < <(git for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin)

COUNT="${#CANDIDATES[@]}"

# WHAT WAS HELD BACK IS PART OF THE REPORT. A prune that prints only its
# deletions reads as "everything mergeable is gone", which is the sentence an
# operator then acts on.
if [ "$SKIPPED_OPEN" -gt 0 ]; then
  ylw "branch prune: $SKIPPED_OPEN merged branch(es) kept, still open as PRs."
fi
if [ "$SKIPPED_YOUNG" -gt 0 ]; then
  ylw "branch prune: $SKIPPED_YOUNG merged branch(es) kept, newer than ${MIN_AGE_DAYS}d."
fi

if [ "$COUNT" -eq 0 ]; then
  grn "branch prune: nothing to delete."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: would delete $COUNT merged branch(es):"
  printf '  %s\n' "${CANDIDATES[@]}"
  exit 0
fi

# The restore file is written BEFORE anything is deleted, because it is only
# useful in the case where the rest of this script was a mistake. Every line is
# a complete recovery: git push origin <sha>:refs/heads/<branch>.
{
  echo "# tribetails branch prune $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# restore one with: git push origin <sha>:refs/heads/<branch>"
  printf '%s\n' "${CANDIDATES[@]}"
} >> "$RESTORE_FILE" 2>/dev/null || {
  ylw "branch prune: could not write $RESTORE_FILE, skipping. Nothing was deleted."
  exit 0
}

DELETED=0
FAILED=0
# Batched, because 180 separate pushes is 180 round trips. xargs keeps each
# command line to a sane length.
while IFS= read -r batch; do
  [ -n "$batch" ] || continue
  # shellcheck disable=SC2086
  if out="$(git push origin --delete $batch 2>&1)"; then
    DELETED=$(( DELETED + $(printf '%s\n' "$batch" | wc -w) ))
  else
    FAILED=$(( FAILED + $(printf '%s\n' "$batch" | wc -w) ))
    printf '%s\n' "$out" >&2
  fi
done < <(printf '%s\n' "${CANDIDATES[@]}" | awk '{print $2}' | xargs -n 30 echo)

if [ "$FAILED" -gt 0 ]; then
  red "branch prune: $DELETED deleted, $FAILED failed. See above."
  ylw "  Restore list: $RESTORE_FILE"
else
  grn "branch prune: $DELETED merged branch(es) deleted."
  grn "  Restore list: $RESTORE_FILE"
fi

# Always 0. See the header: this runs after the release is already true.
exit 0
