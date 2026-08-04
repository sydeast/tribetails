#!/usr/bin/env bash
# Tests for prune-merged-branches.sh. Run:
#   bash scripts/prune-merged-branches.test.sh
#
# WHY THIS EXISTS
# This script deletes branches on a shared remote, and every one of its safety
# rules is invisible when it works. The failure it is written against is not
# "deleted too few", it is "deleted a branch someone still needed", which
# nobody notices until they look for the branch. So each guard gets a test that
# would fail if the guard were removed:
#
#   - merged and quiet          deleted
#   - merged but too recent     kept   (the PR #231 case: merged mid-push)
#   - not merged                kept
#   - merged but PR still open  kept
#   - main                      kept
#   - restore line written      before any deletion, one per branch
#
# Each test builds a throwaway repo with a real remote, so the assertions run
# against git rather than against a mock of it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prune-merged-branches.sh"
PASS=0
FAIL=0

ok()   { printf '\033[32mok\033[0m   %s\n' "$*"; PASS=$(( PASS + 1 )); }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAIL=$(( FAIL + 1 )); }

# A bare "origin" plus a working clone, both disposable.
setup_repo() {
  WORK="$(mktemp -d)"
  git init --quiet --bare "$WORK/origin.git"
  git clone --quiet "$WORK/origin.git" "$WORK/repo" 2>/dev/null
  cd "$WORK/repo" || exit 1
  git config user.email test@example.com
  git config user.name Test
  git config commit.gpgsign false
  echo one > file.txt
  git add file.txt
  git commit --quiet -m "first"
  git branch -M main
  git push --quiet origin main
}

teardown_repo() { cd "$ROOT" || exit 1; rm -rf "$WORK"; }

# Commits with a controllable author/commit date, so "too recent" is testable
# without waiting a day.
commit_on() {
  local branch="$1" days_ago="$2" stamp
  stamp="$(date -u -r $(( $(date +%s) - days_ago * 86400 )) +%Y-%m-%dT%H:%M:%S 2>/dev/null \
        || date -u -d "@$(( $(date +%s) - days_ago * 86400 ))" +%Y-%m-%dT%H:%M:%S)"
  git checkout --quiet -b "$branch" main
  echo "$branch" >> file.txt
  git add file.txt
  GIT_AUTHOR_DATE="$stamp" GIT_COMMITTER_DATE="$stamp" git commit --quiet -m "$branch"
  git push --quiet origin "$branch"
  git checkout --quiet main
}

run_prune() {
  BRANCH_PRUNE_OPEN_HEADS="${1:-}" \
  BRANCH_PRUNE_MIN_AGE_DAYS="${2:-1}" \
  BRANCH_PRUNE_RESTORE_FILE="$WORK/restore.txt" \
  BRANCH_PRUNE_REPO="$WORK/repo" \
  bash "$SCRIPT" >"$WORK/out.txt" 2>&1
}

remote_has() { git ls-remote --heads origin "$1" | grep -q "$1"; }

# ---------------------------------------------------------------- merged, old
setup_repo
commit_on old-merged 30
git merge --quiet --no-ff -m "merge old" old-merged && git push --quiet origin main
run_prune "" 1
remote_has old-merged && bad "merged branch older than the grace period survived" \
                      || ok "merged and quiet: deleted"

# ------------------------------------------------------- merged, but just now
commit_on fresh-merged 0
git merge --quiet --no-ff -m "merge fresh" fresh-merged && git push --quiet origin main
run_prune "" 1
remote_has fresh-merged && ok "merged inside the grace period: kept (the #231 case)" \
                        || bad "deleted a branch that merged moments ago"

# ------------------------------------------------------------------ unmerged
commit_on never-merged 30
run_prune "" 1
remote_has never-merged && ok "unmerged: kept" \
                        || bad "deleted a branch that is not in main"

# ------------------------------------------------------ merged, PR still open
commit_on open-pr 30
git merge --quiet --no-ff -m "merge open-pr" open-pr && git push --quiet origin main
run_prune "open-pr" 1
remote_has open-pr && ok "merged with an open PR: kept" \
                   || bad "deleted the head branch of an open PR"

# ---------------------------------------------------------------------- main
remote_has main && ok "main: kept" || bad "deleted main"

# ------------------------------------------------------------- restore lines
if grep -q "old-merged" "$WORK/restore.txt" 2>/dev/null; then
  ok "restore file records the deleted branch and its sha"
else
  bad "restore file has no line for a branch that was deleted"
fi
if grep -q "never-merged" "$WORK/restore.txt" 2>/dev/null; then
  bad "restore file names a branch that was never deleted"
else
  ok "restore file names only what was deleted"
fi

# ------------------------------------------------------------------- DRY_RUN
commit_on dry-run-me 30
git merge --quiet --no-ff -m "merge dry" dry-run-me && git push --quiet origin main
DRY_RUN=1 BRANCH_PRUNE_OPEN_HEADS="" BRANCH_PRUNE_MIN_AGE_DAYS=1 \
  BRANCH_PRUNE_RESTORE_FILE="$WORK/restore.txt" BRANCH_PRUNE_REPO="$WORK/repo" \
  bash "$SCRIPT" >/dev/null 2>&1
remote_has dry-run-me && ok "DRY_RUN=1: deletes nothing" \
                      || bad "DRY_RUN=1 deleted a branch"

# --------------------------------------------- unset open-heads with no gh
# The dangerous reading is "no open PRs" when the truth is "could not ask".
if ! command -v gh >/dev/null 2>&1; then
  commit_on no-gh 30
  git merge --quiet --no-ff -m "merge no-gh" no-gh && git push --quiet origin main
  env -u BRANCH_PRUNE_OPEN_HEADS BRANCH_PRUNE_MIN_AGE_DAYS=1 \
    BRANCH_PRUNE_RESTORE_FILE="$WORK/restore.txt" BRANCH_PRUNE_REPO="$WORK/repo" \
    bash "$SCRIPT" >/dev/null 2>&1
  remote_has no-gh && ok "no gh and no explicit list: deletes nothing" \
                   || bad "deleted branches without being able to check open PRs"
fi

teardown_repo

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
