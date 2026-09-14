#!/usr/bin/env bash
# release.sh: the production run. One ordered procedure that ships what is on
# main, in the order the dependencies require, and then PROVES the live sites
# actually changed.
#
# WHY THIS EXISTS
# The runbook used to list four safe-deploy.sh invocations as a reference menu
# and leave the sequencing to prose ("Order matters"). That is not a run, and it
# failed exactly the way an unwritten procedure fails: on 2026-07-26 the live
# admin was 33 hours and ~19 merged PRs behind main because `npm run build` had
# been treated as if it shipped. Build writes dist/ on your disk. It uploads
# NOTHING. Deploy is a separate act, and until it existed as one named command
# it got rebuilt from memory each time, differently.
#
# WHAT IT DOES, in this order and for these reasons:
#   0. preconditions  - clean tree, on main, synced with origin. Shipping
#                       uncommitted or stale code is the classic incident.
#  0b. ci verdict    - ask GitHub whether CI is green for THIS commit. Step 1
#                       does not run e2e and never did, so until this existed a
#                       red e2e job could not stop a release. One didn't, on
#                       2026-08-01.
#  0c. client config - fill each web app's VITE_* build config from Google
#                       Secret Manager, BEFORE step 1 builds them. `vite build`
#                       compiles these values INTO the bundle, so after the
#                       build it is too late: there is no server process to
#                       inject them into later. See scripts/client-secrets.mjs.
#   1. npm run check  - typecheck, lint, test, build. This is also what
#                       produces the dist/ that step 5 uploads, so it is not
#                       optional theatre: skipping it ships a stale bundle.
#  1c. android build  - assemble BOTH signed release APKs (the AuntieOS
#                       operator app and the Kinfolk Portal app) BEFORE
#                       anything ships, so a build failure costs nothing. Same
#                       rule as step 1.
#   2. indexes        - BEFORE the code that queries them. A query with no
#                       index fails at RUNTIME, not at build.
#   3. index wait     - deploying an index returns before it is Enabled. The
#                       CLI will not block for you, so this step does.
#   4. rules          - from mytribe only; safe-deploy refuses a drifted mirror.
#   5. functions      - BEFORE the clients that call them, same reason as 2 in
#                       reverse: a client calling a function that is not there
#                       fails at runtime.
#   6. hosting        - admin, then portal.
#  6b. android        - upload the APKs built in 1c to App Distribution, in the
#                       SAME run as the web. Android was outside this script
#                       until 2026-07-28 and had drifted 200 versionCodes
#                       behind the web while the source trees stayed at parity.
#                       It then shipped only ONE of the two Android apps until
#                       2026-08-04, leaving the Kinfolk Portal's client in the
#                       same hole the fix was written against.
#   7. verify         - fetch the live bundles and compare to what was just
#                       built. This is the step whose absence hid the stale
#                       admin for 33 hours. A release that cannot prove it
#                       landed has told you nothing.
#
# USAGE
#   npm run deploy                      the whole run
#   DRY_RUN=1 npm run deploy            rehearse it: print every firebase command,
#                                       run none, WRITE NOTHING, claim nothing
#
#   RELEASE_SKIP_CHECK=1                skip step 1 (only when you just ran it)
#   RELEASE_SKIP_CI_GATE=1              release without CI's verdict for HEAD.
#                                       For when the gate is genuinely
#                                       unavailable (no gh, no network, GitHub
#                                       down), not for when it says no.
#   RELEASE_INCLUDE_ADMIN_FUNCTIONS=1   also ship the AuntieOS functions
#                                       codebases (default/reconcile). Off by
#                                       default because they live in a second
#                                       tree with their own deploy semantics;
#                                       the run SAYS when it skipped them.
#                                       Each codebase deploy is retried on a
#                                       transient error (dropped request, 5xx,
#                                       rate limit): RELEASE_FUNCTIONS_ROUNDS
#                                       attempts, RELEASE_FUNCTIONS_SETTLE apart.
#   RELEASE_NO_RESUME=1                 run every step even when an earlier run of
#                                       this SAME commit already completed it.
#                                       Without it a rerun skips what
#                                       .release-progress records as done for
#                                       HEAD (indexes, rules, fleet-verified
#                                       mytribe functions, admin codebases) and
#                                       says so.
#   RELEASE_YES=1                      do not prompt (CI). Preconditions still
#                                       apply; nothing is bypassed.
#   RELEASE_SKIP_CLIENT_SECRETS=1       skip step 0c and build both web apps
#                                       from whatever their own .env files hold.
#                                       The sibling of RELEASE_SKIP_SECRET_CHECK,
#                                       and the same warning applies: on a
#                                       machine with no .env that is an empty
#                                       string compiled into the bundle.
#   RELEASE_SKIP_ANDROID=1              ship the web without the Android client.
#                                       Off by default: shipping them together
#                                       is the point of steps 1c and 6b.
#   RELEASE_FUNCTIONS_ALL=1             deploy every function, not only the ones
#                                       this release can reach. Use it when you
#                                       do not trust the narrowing.
#   RELEASE_FUNCTIONS_BATCH=N           functions per firebase deploy (25). The
#   RELEASE_FUNCTIONS_ROUNDS=N          number of retry rounds for casualties (3).
#   RELEASE_FUNCTIONS_SETTLE=S          seconds between batches (30). All three
#                                       exist because whole-fleet deploys died
#                                       partway. The CPU-quota reading of that
#                                       is now closed (400 vCPU since
#                                       2026-08-03, fleet ~90 since #219); see
#                                       the runbook for what is left.
#   RELEASE_FUNCTIONS_FORCE=1           pass --force to the functions deploy.
#                                       Needed when a change RAISES the minimum
#                                       bill (memory, cpu, minInstances); without
#                                       it firebase-tools refuses every batch.
#                                       Also lets firebase DELETE functions it
#                                       cannot find in source, so read the diff.
#   RELEASE_PREDEPLOY_KEEP=N            prune to N revisions per service before a
#                                       LARGE functions deploy (3; 0 disables).
#   RELEASE_RETRY_KEEP=N                prune depth between retry rounds (2).
#   RELEASE_PRUNE_BRANCHES=0            skip deleting merged remote branches
#                                       after the tag (on by default).
#   BRANCH_PRUNE_MIN_AGE_DAYS=N         how long a merged branch stays quiet
#                                       before the prune will take it (1).
#   RELEASE_ANDROID_GROUPS=a,b          App Distribution group aliases to send
#   RELEASE_ANDROID_TESTERS=a@b,c@d     to. Neither set means every tester on
#                                       the project; nobody at all REFUSES the
#                                       release, because the CLI's own default
#                                       is to upload and reach no one.
#
# Every deploy here goes through scripts/safe-deploy.sh, which pins the project,
# refuses a bare deploy, and refuses rules from the wrong tree. This script adds
# ORDER and PROOF on top of those guards; it does not replace any of them.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SAFE_DEPLOY="$ROOT/scripts/safe-deploy.sh"

# The one shared project. safe-deploy.sh pins this for every deploy it runs;
# declared here too because the secret preflight and the prune query it directly
# rather than through safe-deploy. Omitting it made the preflight die on
# `PROJECT: unbound variable` under set -u the first time it ran for real.
PROJECT="auntieos-ttpc"

# DRY_RUN=1 IS A REHEARSAL, and a rehearsal has exactly two obligations: leave
# the machine exactly as it found it, and claim nothing it did not do. Read once
# here rather than as `${DRY_RUN:-0}` at each use, because that is a property of
# the whole script and a per-site default is how one site gets missed.
#
# One did. On 2026-08-01 `DRY_RUN=1 RELEASE_YES=1 npm run deploy` deployed
# nothing, wrote HEAD into .release-state anyway, and signed off with "Commit
# e4f0245 is live and verified." The real release that followed read that file,
# found mytribe/functions unchanged since it, and SKIPPED the functions deploy.
# So a brand new admin bundle went live against a backend with no
# getInvoiceLedger, no listInvites, no transitionBookingStatus and no
# getBusinessClosures. User-facing, until a forced redeploy.
#
# That is the same class of lie step 7 exists to catch (hosting reporting success
# while browsers get the old bundle) and that the runbook opens with (`npm run
# build` read as a shipped build), except told by the release run about itself.
# So: every mutation below is either DRY_RUN-guarded or is not a mutation, and
# the closing banner reports a rehearsal as a rehearsal.
DRY_RUN="${DRY_RUN:-0}"

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

STEP="starting up"

# THE COMMIT THIS RUN RELEASES, pinned once, here (#840 review).
#
# The release runs 20 to 40 minutes, and the agent shell and the operator's
# terminal share ONE checkout. Anything that re-reads HEAD later (the progress
# record, .release-state, the tag) would name whatever happened to be checked
# out at that moment, and could mark commit B done for work commit A deployed.
# So HEAD is read once, every later use reads RELEASE_SHA, and banner() refuses
# at the next step boundary if HEAD has moved (release_head_guard).
#
# npm run deploy:bg passes RELEASE_SHA in the environment: the commit it made
# its resume decision for. Step 0 refuses if that is not the commit checked out.
RELEASE_SHA="${RELEASE_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
if [ -z "$RELEASE_SHA" ]; then
  red "REFUSED: cannot read HEAD, so this run cannot say which commit it releases."
  exit 1
fi
RELEASE_SHORT="$(git rev-parse --short "$RELEASE_SHA" 2>/dev/null || printf '%s' "${RELEASE_SHA:0:7}")"
export RELEASE_SHA
# Off until step 0 has compared HEAD with RELEASE_SHA itself, so a mismatch at
# launch gets step 0's specific refusal rather than the generic one; on from
# there until the release is over, so the closing banners do not re-check.
RELEASE_HEAD_GUARD=0
# A fingerprint of the working tree, taken just before the first deploy (step 2)
# and compared by release_head_guard from then on. Empty until then.
RELEASE_TREE_BASELINE=""
# `git status --short` at the moment the baseline was taken, printed beside the
# current one when a change is refused.
RELEASE_TREE_BASELINE_STATUS=""
# Deploys run since the checkout was last checked (see release_note_deploy).
RELEASE_UNCHECKED_DEPLOYS=""
# Set by release_head_refuse when a deploy may have shipped something other than
# RELEASE_SHA, so the stop message can say which codebase and which commit.
RELEASE_MIXED_TARGET=""
RELEASE_MIXED_WITH=""

# The generated .env.production.local files (step 0c) exist only for the length
# of this run. They are gitignored and hold nothing a browser cannot already
# read out of the deployed bundle, but leaving them behind would mean the next
# `npm run build` on this machine silently used a previous release's values
# instead of the developer's own .env, which is a confusing way to debug
# nothing. Removing them through the script that wrote them keeps ONE list of
# where they are.
cleanup_client_env() {
  node "$ROOT/scripts/client-secrets.mjs" --clean >/dev/null 2>&1 || true
}

# Any exit that is not the clean end of this script names the step it died in.
# A release that stops silently mid-way leaves production half-shipped, which is
# worse than not starting: functions ahead of hosting is a state nobody chose.
#
# The stop message names what DID ship for this commit (#840), read from the
# progress file below, so "partially shipped" is a list rather than a shrug.
trap 'code=$?; cleanup_client_env; if [ "$code" -ne 0 ]; then red ""; red "RELEASE STOPPED during: $STEP"; progress_report_stop || true; fi' EXIT

# ---------------------------------------------------------------------------
# Progress for THIS commit, so a stopped release resumes instead of redoing the
# half that already shipped (#840).
# ---------------------------------------------------------------------------
#
# WHY. On 2026-09-13 a release shipped indexes, rules and all 279 mytribe
# functions, verified the fleet, then died on one dropped Secret Manager request
# while deploying the admin codebases. .release-state is written only at the very
# end, so the rerun would redeploy all 279 functions again: ~30 minutes and
# another round of Cloud Run revisions, for code already live and verified.
#
# .release-progress holds one "<full sha> <step>" line per step that completed
# for the commit being released (RELEASE_SHA, pinned above, never a later read
# of HEAD). A rerun skips a recorded step only when:
#   - the line names that EXACT commit (a different commit never skips),
#   - the tree is clean (step 0 refuses a dirty one anyway; this does not lean
#     on that), and
#   - RELEASE_NO_RESUME=1 is not set.
# Only completion that was proven is recorded: step 5 only when the fleet verify
# PASSED, never on "could not verify". Hosting and Android are recorded so the
# stop message can name them, and are never skipped: they are cheap, and step 7
# verifies hosting against the bundle THIS run built.
#
# Written under the same DRY_RUN rule as .release-state, because it is the same
# kind of file: an input that makes a later run skip work.
#
# The file format and the skip rule (progress_mark, progress_done) live in
# scripts/release-progress.sh, shared with scripts/release-bg.sh so the two
# cannot disagree about when a step may be skipped. It sets PROGRESS_FILE.
# shellcheck source=scripts/release-progress.sh
. "$ROOT/scripts/release-progress.sh"

progress_label() {
  case "$1" in
    indexes)                   printf 'firestore indexes (steps 2-3)' ;;
    indexes-confirmed)         printf 'firestore indexes confirmed Enabled by the operator at the step 3 prompt' ;;
    rules)                     printf 'firestore rules (step 4)' ;;
    functions-mytribe)         printf 'functions:mytribe, fleet verified (step 5)' ;;
    functions-mytribe-none)    printf 'functions:mytribe, nothing to deploy (step 5)' ;;
    functions-mytribe-unverified) printf 'functions:mytribe, deployed, not verified (step 5)' ;;
    functions-admin-default)   printf 'functions:default, admin codebase' ;;
    functions-admin-reconcile) printf 'functions:reconcile, admin codebase' ;;
    hosting-admin)             printf 'hosting:app, operator admin (step 6)' ;;
    hosting-portal)            printf 'hosting:kinfolk_portal (step 6)' ;;
    android-*)                 printf 'android %s, distributed (step 6b)' "${1#android-}" ;;
    *)                         printf '%s' "$1" ;;
  esac
}

# progress_report_stop: the rest of the stop message. Names every step recorded
# for RELEASE_SHA, so an operator reading a failed run knows what is live.
progress_report_stop() {
  local sha="$RELEASE_SHA" short="$RELEASE_SHORT" line_sha key done_list="" unverified_list=""
  if [ -n "$sha" ] && [ -f "$PROGRESS_FILE" ]; then
    while read -r line_sha key; do
      if [ "$line_sha" != "$sha" ] || [ -z "$key" ]; then
        continue
      fi
      # A deploy whose verify did not pass is not "completed and live" on this
      # file's evidence, so it gets its own heading rather than a line under it.
      case "$key" in
        *-unverified)
          unverified_list="$unverified_list
    - $(progress_label "$key")" ;;
        *)
          done_list="$done_list
    - $(progress_label "$key")" ;;
      esac
    done < "$PROGRESS_FILE"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    red "DRY_RUN=1: nothing was deployed by this run."
    return 0
  fi
  if [ -n "$done_list" ]; then
    red "Completed and LIVE for $short:$done_list"
  fi
  if [ -n "$unverified_list" ]; then
    red "Deployed, NOT verified, for $short:$unverified_list"
  fi
  if [ -n "$RELEASE_MIXED_TARGET" ]; then
    red "$RELEASE_MIXED_TARGET may be PARTLY from $RELEASE_MIXED_WITH,"
    red "  not from $RELEASE_SHORT ($RELEASE_SHA). firebase builds and uploads it from"
    red "  the working tree at deploy time, and the checkout had changed by the time"
    red "  that deploy finished. Nothing is recorded for it against $RELEASE_SHORT, so"
    red "  a rerun on $RELEASE_SHORT deploys it again."
  fi
  if [ -n "$done_list" ] || [ -n "$unverified_list" ]; then
    red "Nothing after those has shipped, and the step named above may be"
    red "PARTIALLY shipped. Fix the cause and re-run on this same commit: the"
    red "recorded backend steps are skipped (RELEASE_NO_RESUME=1 runs them all)."
  else
    red "No deploy step completed for $short. Production may still be PARTIALLY"
    red "shipped by the step named above. Check what completed above before retrying."
  fi
}

# release_tree_fingerprint: print one line that changes when a tracked file
# changes, an untracked non-ignored file appears or goes, or such a file's
# CONTENTS change (hashed with git hash-object). Returns non-zero and prints
# nothing when git could not answer, after one retry a second later: a held
# .git/index.lock from another git command in the same checkout is the usual
# cause, and it clears quickly. A failure is never folded into "changed".
#
# Cost, measured 2026-09-14: 0.07 to 0.08s on the real checkout (3,976 tracked
# files, 0 untracked), and 0.09 to 0.15s on a clone with 500 untracked 4KB files.
#
# WHAT IS IGNORED, AND SO DOES NOT MOVE IT. Checked with `git check-ignore -v`
# on 2026-09-14, and nothing more than this:
#   auntieos-admin/.env.production.local   auntieos-admin/.gitignore  *.local
#   mytribe/web/.env.production.local      mytribe/.gitignore         .env.*.local
#   mytribe/functions/lib/                 mytribe/functions/.gitignore  /lib
#   auntieos-admin/dist/, mytribe/web/dist/   dist/ in each tree's .gitignore
#   both Android build dirs                build/ in each tree's .gitignore
#   .release-logs/, .release-state, .release-functions, .release-progress   root
#   firebase-debug.log (and firestore-debug.log, ui-debug.log)
#       under mytribe/ and auntieos-admin/ via *.log; at the ROOT only since
#       #840 added them. Before that, a Firebase CLI call run from the root left
#       an unignored log that refused the release; the two that run after the
#       baseline (appdistribution) now also run from mytribe/.
# Anything else `npm run check` writes has NOT been checked. If it writes an
# unignored file, the baseline is taken after it, so it cannot refuse a release
# by itself; only a change after step 2 does.
release_tree_fingerprint() {
  local attempt status diff untracked
  for attempt in 1 2; do
    if status="$(git -C "$ROOT" status --porcelain 2>/dev/null)" &&
       diff="$(git -C "$ROOT" diff HEAD --no-ext-diff 2>/dev/null)" &&
       untracked="$(git -C "$ROOT" ls-files --others --exclude-standard -z 2>/dev/null |
                    (cd "$ROOT" && xargs -0 git hash-object -- 2>/dev/null))"; then
      printf '%s\n--\n%s\n--\n%s\n' "$status" "$diff" "$untracked" | cksum
      return 0
    fi
    if [ "$attempt" = "1" ]; then
      sleep 1
    fi
  done
  return 1
}

# release_note_deploy <target>: record that a deploy of <target> is about to run.
# Called by deploy(), by each functions batch and by each admin attempt, just
# before the firebase call. A passing release_head_guard clears the list: every
# deploy in it ran against a checkout that was still RELEASE_SHA at the check
# that followed. On a refusal, the list is exactly the deploys that may have used
# the changed checkout, whichever check caught it (#840 third review).
release_note_deploy() {
  case " $RELEASE_UNCHECKED_DEPLOYS " in
    *" $1 "*) ;;
    *) RELEASE_UNCHECKED_DEPLOYS="${RELEASE_UNCHECKED_DEPLOYS:+$RELEASE_UNCHECKED_DEPLOYS }$1" ;;
  esac
}

# release_forget_deploy <target>: drop the progress records a deploy of <target>
# would have written, so a rerun deploys it again instead of resuming over it.
release_forget_deploy() {
  case "$1" in
    firestore:indexes)     progress_forget indexes; progress_forget indexes-confirmed ;;
    firestore:rules)       progress_forget rules ;;
    functions:mytribe)     progress_forget functions-mytribe
                           progress_forget functions-mytribe-none
                           progress_forget functions-mytribe-unverified ;;
    functions:default)     progress_forget functions-admin-default ;;
    functions:reconcile)   progress_forget functions-admin-reconcile ;;
    hosting:app)           progress_forget hosting-admin ;;
    hosting:kinfolk_portal) progress_forget hosting-portal ;;
  esac
}

# release_head_refuse <where> <headline> <moved-to> <kind>: stop the release
# because the checkout changed (kind "changed") or git could not read it (kind
# "unreadable"). Names the deploys that ran since the last passing check as
# possibly built from the changed checkout, drops their records, and leaves the
# stop message to repeat them with both commits.
release_head_refuse() {
  local where="$1" headline="$2" moved_to="$3" kind="$4" t named=""
  STEP="checking the checkout has not changed since the release started"
  red "REFUSED: $headline"
  red "  Caught $where."
  red "  This run is releasing $RELEASE_SHORT ($RELEASE_SHA)."
  if [ -n "$moved_to" ]; then
    red "  HEAD is now $moved_to."
  fi
  if [ -n "$RELEASE_UNCHECKED_DEPLOYS" ]; then
    for t in $RELEASE_UNCHECKED_DEPLOYS; do
      release_forget_deploy "$t"
      named="${named:+$named, }$t"
    done
    RELEASE_MIXED_TARGET="$named"
    if [ "$kind" = "unreadable" ]; then
      RELEASE_MIXED_WITH="a checkout git could not read"
    else
      RELEASE_MIXED_WITH="${moved_to:-the edited working tree}"
    fi
    red "  Deployed since the last passing check, so possibly from the changed checkout:"
    red "    $named"
    red "  Nothing is recorded for them against $RELEASE_SHORT; a rerun deploys them again."
  else
    red "  Every deploy so far passed a check against $RELEASE_SHORT after it ran, and"
    red "  .release-progress records them against $RELEASE_SHORT."
  fi
  if [ "$kind" = "unreadable" ]; then
    red "  git failed twice, a second apart, so this run cannot show the checkout is"
    red "  unchanged. That is not evidence it changed. Usually another git command"
    red "  holds .git/index.lock: check nothing else runs git here, then re-run."
  else
    red "  Something checked out, committed, pulled or edited files in this checkout"
    red "  while the release ran. To resume, re-run once main is back at"
    red "  $RELEASE_SHORT with a clean tree. A new commit gets a full run of its own:"
    red "  a different commit never resumes."
  fi
  exit 1
}

# release_head_guard <where>: refuse if HEAD is no longer RELEASE_SHA or, once
# step 2 has taken the baseline, if the working tree has changed or git cannot
# read it. <where> is named in the refusal. On a pass, clears the list of
# unchecked deploys.
#
# Called from banner() at every step boundary; before and after every functions
# batch; after the rules deploy; before every admin codebase attempt and after
# its deploy; before step 5 is recorded; before the admin codebases; and before
# .release-state.
release_head_guard() {
  local where="${1:-at a step boundary}" now fp current
  [ "${RELEASE_HEAD_GUARD:-1}" = "1" ] || return 0
  [ -n "${RELEASE_SHA:-}" ] || return 0
  now="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [ "$now" != "$RELEASE_SHA" ]; then
    release_head_refuse "$where" "HEAD moved during the release." "${now:-unreadable}" changed
  fi
  if [ -n "$RELEASE_TREE_BASELINE" ]; then
    if ! fp="$(release_tree_fingerprint)"; then
      release_head_refuse "$where" "git could not read the working tree, so the checkout could not be checked." "" unreadable
    fi
    if [ "$fp" != "$RELEASE_TREE_BASELINE" ]; then
      # Plain tests, not ${var:-default}: macOS bash 3.2 misparses a quote
      # character inside a default word, even within double quotes.
      if ! current="$(git -C "$ROOT" status --short 2>/dev/null)"; then
        current="(unreadable)"
      elif [ -z "$current" ]; then
        current="(clean: only the contents of an untracked file changed)"
      fi
      red "git status --short when the release started deploying:"
      if [ -n "$RELEASE_TREE_BASELINE_STATUS" ]; then
        red "$RELEASE_TREE_BASELINE_STATUS"
      else
        red "(clean)"
      fi
      red "git status --short now:"
      red "$current"
      release_head_refuse "$where" "the working tree changed during the release (git status before and now, above)." "" changed
    fi
  fi
  RELEASE_UNCHECKED_DEPLOYS=""
  return 0
}

banner() {
  release_head_guard "at the start of step: $*"
  printf '\n'
  cyan "─────────────────────────────────────────────────────────────"
  cyan "  $*"
  cyan "─────────────────────────────────────────────────────────────"
}

# confirm <prompt>: ask unless RELEASE_YES=1. A "no" is a clean stop, not an
# error, because deciding not to ship is a legitimate outcome of a release run.
confirm() {
  if [ "${RELEASE_YES:-0}" = "1" ]; then
    ylw "RELEASE_YES=1: continuing without prompting."
    # Who answered, so a record never says "confirmed" when nobody looked.
    CONFIRM_BY="RELEASE_YES"
    return 0
  fi
  printf '\033[33m%s [y/N] \033[0m' "$1"
  read -r reply </dev/tty || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS])
      CONFIRM_BY="operator"
      return 0
      ;;
    *)
      cleanup_client_env
      trap - EXIT
      ylw "Stopped at your request. Nothing further was deployed."
      exit 0
      ;;
  esac
}

# deploy <prefix> <targets>: one guarded deploy, announced before it runs.
deploy() {
  local prefix="$1" targets="$2"
  release_note_deploy "$targets"
  cyan "deploy: $prefix -> $targets"
  DRY_RUN="$DRY_RUN" bash "$SAFE_DEPLOY" "$prefix" -- firebase deploy --only "$targets"
}

# ---------------------------------------------------------------------------
# Deploying functions a batch at a time. See step 5 for why this exists at all.
# ---------------------------------------------------------------------------

# WHY 25. Nobody has found the enforced ceiling, so this is set from what has
# actually landed rather than from a model. The full fleet fails at 197-201
# successes against a 200 vCPU regional quota, which is the ceiling naming
# itself. Batches of 20 and 26 are what every hand recovery used, on 2026-07-28
# and repeatedly on 2026-08-01, and they landed. 25 sits in that measured range
# with roughly 8x headroom under the wall, so two or three batches can still be
# settling concurrently and fit. It is deliberately not "as large as we think we
# can get away with": the cost of being wrong is a half-deployed backend, and the
# cost of being conservative is minutes.
FN_BATCH="${RELEASE_FUNCTIONS_BATCH:-25}"

# 3 rounds, each half the batch size of the last (floor 5). A quota refusal means
# too many at once, so retrying the SAME width is retrying the thing that failed.
FN_ROUNDS="${RELEASE_FUNCTIONS_ROUNDS:-3}"

# Cloud Run releases the allocation as revisions settle, and the one batch that
# failed outright on 2026-08-01 (26 by name, 0 landed) was fired immediately
# after a full deploy had just abandoned ~200 starting revisions. So: wait.
FN_SETTLE="${RELEASE_FUNCTIONS_SETTLE:-30}"

# OFF BY DEFAULT, AND IT SHOULD STAY THAT WAY.
#
# `--force` is how you get past firebase-tools refusing a deploy that raises the
# minimum bill (memory, cpu, minInstances). It is not free: the same flag also
# lets firebase DELETE any function it cannot find in the source. Every deploy
# here passes an explicit `--only functions:mytribe:<name>,...` list, which
# bounds what it could act on, but the honest reading is that this trades a
# guardrail for an unblock. So it is an opt-in per run, never a default, and the
# batch that hits the refusal prints the flag and the reason rather than leaving
# an operator to find it.
FN_FORCE_FLAG=""
if [ "${RELEASE_FUNCTIONS_FORCE:-0}" = "1" ]; then
  FN_FORCE_FLAG="--force"
fi

# Set when firebase-tools refuses the deploy for raising the minimum bill, which
# is a verdict rather than a capacity problem, so the retry rounds stop instead
# of re-sending the identical rejected request twice more.
FN_REFUSED_BILL=0
FN_RETRY_KEEP="${RELEASE_RETRY_KEEP:-2}"

# Set only by a fleet verify that PASSED. Step 5 records itself in
# .release-progress on this and nothing weaker (#840).
FLEET_VERIFIED=0

# deploy_one_function_batch <names-file> <failed-file>
# Deploys one batch by explicit name and appends every function firebase did not
# confirm to <failed-file>. Returns non-zero if any did not land.
deploy_one_function_batch() {
  local names_file="$1" failed_file="$2"
  local targets="" name count log
  count="$(awk 'NF{n++} END{print n+0}' "$names_file")"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    targets="${targets:+$targets,}functions:mytribe:$name"
  done < "$names_file"

  log="$names_file.log"

  # THE DEPLOY READS THE CHECKOUT ITSELF (#840 review). mytribe/firebase.json
  # runs `npm run build` as a predeploy on EVERY functions deploy, so each batch
  # compiles lib/ from whatever the working tree holds at that moment, not from
  # RELEASE_SHA. A HEAD that moves between batch 3 and batch 4 ships batch 4 from
  # the other commit, and the fleet verify cannot tell (it checks names and
  # timestamps). So the checkout is checked before each batch, and again after
  # it, when a failure means this batch may have shipped the other commit.
  #
  # THE WINDOW THAT IS LEFT. The check before a batch and firebase's predeploy
  # build are seconds apart, and a change made and undone entirely inside one
  # deploy is invisible to both checks. Nothing in this script can close that;
  # not using a checkout that something else is working in during a release can.
  release_head_guard "before a functions batch"
  cyan "deploy: mytribe -> $count function(s): $(awk 'NF{printf "%s%s", (n++?" ":""), $0}' "$names_file")"
  local rc=0
  release_note_deploy functions:mytribe
  # shellcheck disable=SC2086
  DRY_RUN="$DRY_RUN" bash "$SAFE_DEPLOY" mytribe -- firebase deploy $FN_FORCE_FLAG --only "$targets" 2>&1 | tee "$log" || rc=$?
  release_head_guard "after a functions batch"
  if [ "$rc" -eq 0 ]; then
    return 0
  fi

  # RAISING A LIMIT IS ITS OWN FAILURE, AND IT IS NOT A RATE LIMIT.
  #
  # firebase-tools refuses any deploy that raises the floor of the bill, and it
  # says so in one line and then exits:
  #
  #   Error: Pass the --force option to deploy functions that increase the
  #   minimum bill
  #
  # Every batch fails identically and instantly. On 2026-08-04 that took down a
  # whole release: the fleet moved from 256MiB to 512MiB (the fix for a cold
  # start that was OOMing and returning 503 on every callable), all 9 batches
  # refused, all 3 rounds refused, and the closing diagnostic then told the
  # operator it was "almost certainly a RATE limit" and to retry smaller and
  # slower. Smaller and slower cannot fix a deploy that is being refused on
  # principle. That misdirection is corrected below and named here.
  #
  # It is caught HERE, per batch, rather than only at the end, so the run stops
  # on the first batch instead of grinding through 27 doomed deploys.
  if grep -q 'increase the minimum bill' "$log" 2>/dev/null; then
    red "REFUSED by firebase-tools: this deploy raises the minimum bill."
    red "  Nothing in this batch landed, and retrying smaller will not help."
    red "  Something in mytribe/functions asks for more than it used to:"
    red "  memory, cpu, minInstances, or a new always-on trigger. That is a"
    red "  deliberate change, so it takes a deliberate flag:"
    red ""
    red "    RELEASE_FUNCTIONS_FORCE=1 npm run deploy"
    red ""
    red "  Read the diff before you set it. --force also lets firebase DELETE"
    red "  functions it cannot find in the source, and the bill it is warning"
    red "  about is a real recurring cost, not a formality."
    # EVERY NAME IN THIS BATCH IS STALE, and saying so is what makes the release
    # fail. An earlier version returned here without recording them, so the
    # caller saw an empty pending list, concluded the fleet had landed, and
    # reported a successful release that had deployed nothing. A refusal that
    # reports success is worse than the refusal.
    awk 'NF' "$names_file" >> "$failed_file"
    # Nothing about a smaller batch changes this answer, so stop the rounds
    # rather than spending two more on the same refusal.
    FN_REFUSED_BILL=1
    return 1
  fi

  # WHICH ONES ACTUALLY DIED, read from firebase's own per-function lines
  # ("functions[getMyHome(us-central1)] Successful update operation."). Only
  # CONFIRMED successes are subtracted, so if the format ever changes this
  # parses nothing, treats the whole batch as failed, and retries too much
  # rather than too little. There is no version of this that silently drops a
  # function on the floor.
  awk '/functions\[/ && /[Ss]uccessful/ {
         if (match($0, /functions\[[^]]*\]/)) {
           s = substr($0, RSTART + 10, RLENGTH - 11)
           sub(/\(.*/, "", s)
           print s
         }
       }' "$log" | sort -u > "$log.ok"

  if [ -s "$log.ok" ]; then
    grep -vxF -f "$log.ok" "$names_file" >> "$failed_file" || true
    ylw "batch: $(awk 'NF{n++} END{print n+0}' "$log.ok") of $count landed; the rest will be retried."
  else
    awk 'NF' "$names_file" >> "$failed_file"
    ylw "batch: none of the $count landed (or firebase reported no per-function"
    ylw "  result this run). All of them will be retried."
  fi
  return 1
}

# deploy_function_names <names-file>: batch, retry, prune, give up loudly.
# <names-file> is rewritten as it goes and holds the STALE names on failure, so
# the caller can name them. Returns 0 only when every name landed.
deploy_function_names() {
  local pending="$1"
  local round=1 batch="$FN_BATCH" remaining chunkdir failed chunks i chunk

  while :; do
    remaining="$(awk 'NF{n++} END{print n+0}' "$pending")"
    [ "$remaining" -eq 0 ] && return 0
    [ "$round" -gt "$FN_ROUNDS" ] && return 1
    # A minimum-bill refusal is a verdict, not a capacity problem. Retrying it
    # smaller is retrying the identical rejected request.
    [ "${FN_REFUSED_BILL:-0}" = "1" ] && return 1

    if [ "$round" -gt 1 ]; then
      batch=$(( batch / 2 ))
      [ "$batch" -lt 5 ] && batch=5
      ylw ""
      ylw "round $round of $FN_ROUNDS: $remaining function(s) have not landed."
      ylw "  Retrying them in batches of $batch."
      if [ "$FN_RETRY_KEEP" != "0" ] && [ "$DRY_RUN" != "1" ]; then
        ylw "  Pruning to $FN_RETRY_KEEP revisions per service first. Recovery did"
        ylw "  this between attempts on 2026-08-01; whether it is what made the"
        ylw "  retries land is NOT established (keep-2 took 1250 revisions to 487"
        ylw "  and the deploy behind it still lost 26). The smaller batch is the"
        ylw "  half of this with evidence behind it."
        bash "$ROOT/scripts/prune-run-revisions.sh" "$FN_RETRY_KEEP" ||
          ylw "  prune reported problems (see above). Retrying anyway."
      fi
    fi

    chunkdir="$FN_WORK/round$round"
    mkdir -p "$chunkdir"
    awk -v n="$batch" -v d="$chunkdir" \
      'NF { if ((c % n) == 0) f = sprintf("%s/%03d", d, int(c / n)); print > f; c++ }' "$pending"

    failed="$chunkdir/failed"
    : > "$failed"
    chunks="$(ls "$chunkdir" | grep -c '^[0-9]' || true)"
    i=0
    for chunk in "$chunkdir"/[0-9]*; do
      case "$chunk" in *.log|*.log.ok) continue ;; esac
      i=$((i + 1))
      cyan ""
      cyan "functions batch $i of $chunks (round $round of $FN_ROUNDS)"
      deploy_one_function_batch "$chunk" "$failed" || true
      # Settling matters between batches and nowhere else, and a rehearsal that
      # sleeps five minutes to print commands is a rehearsal nobody runs.
      if [ "$i" -lt "$chunks" ] && [ "$FN_SETTLE" -gt 0 ] && [ "$DRY_RUN" != "1" ]; then
        ylw "settling for ${FN_SETTLE}s so Cloud Run releases the allocation ..."
        sleep "$FN_SETTLE"
      fi
    done

    sort -u "$failed" -o "$failed"
    cp "$failed" "$pending"
    round=$((round + 1))
  done
}

# ---------------------------------------------------------------------------
# The admin functions codebases, retried when the failure is transient (#840).
# ---------------------------------------------------------------------------

# classify_deploy_failure <log>: permanent | transient | unknown, read from the
# text a failed firebase deploy printed.
#
# THE HEADER IS THE SAME EITHER WAY, which is why this reads past it. On
# 2026-09-13 the admin deploy printed
#
#   Error: Failed to validate secret versions:
#   - FirebaseError Failed to make request to https://secretmanager.googleapis.com/v1/projects/auntieos-ttpc/secrets/CLOUDINARY_API_KEY/versions/latest
#
# for a secret that HAD an enabled version: one dropped request, and
# `functions:secrets:get` worked minutes later. A secret that genuinely is not
# there fails under the same header, saying "not found" or "has no versions", and
# retrying that is retrying a verdict.
#
# So a permanent marker anywhere in the log wins, then a transient marker, and
# anything else is unknown. Unknown is NOT retried: a compile error or a refused
# config does not improve by asking again, and stopping is the safe answer to an
# error nobody has classified.
#
# Kept at column 0 and self-contained so release.test.sh can lift it out of this
# file and test it directly, with no test-only path in the script.
classify_deploy_failure() {
  local log="$1"
  if [ ! -s "$log" ]; then
    printf 'unknown'
    return 0
  fi
  if grep -Eqi 'not found|NOT_FOUND|has no versions|PERMISSION_DENIED|permission denied|increase the minimum bill' "$log"; then
    printf 'permanent'
  elif grep -Eqi 'Failed to make request|HTTP Error: (429|5[0-9][0-9])|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|DEADLINE_EXCEEDED|Service Unavailable|Bad Gateway|Gateway Timeout|Internal error encountered' "$log"; then
    printf 'transient'
  else
    printf 'unknown'
  fi
}

# deploy_admin_codebase <target>: one admin codebase through safe-deploy, retried
# the way step 5 retries its batches: up to RELEASE_FUNCTIONS_ROUNDS attempts,
# RELEASE_FUNCTIONS_SETTLE seconds apart, and only while the failure reads as
# transient. Returns 0 when the deploy succeeded.
deploy_admin_codebase() {
  local target="$1" attempt=1 log class
  log="$(mktemp)"
  while :; do
    # The admin codebases upload from the working tree too (default is plain
    # JS), so every attempt starts from a checked checkout, retries included.
    release_head_guard "before $target attempt $attempt"
    release_note_deploy "$target"
    cyan "deploy: auntieos-admin -> $target (attempt $attempt of $FN_ROUNDS)"
    if DRY_RUN="$DRY_RUN" bash "$SAFE_DEPLOY" auntieos-admin -- firebase deploy --only "$target" 2>&1 | tee "$log"; then
      rm -f "$log"
      return 0
    fi
    class="$(classify_deploy_failure "$log")"
    case "$class" in
      permanent)
        red "$target: NOT retrying. The error reads as a verdict, not a blip: a"
        red "  secret that is not found or has no versions, a permission refusal,"
        red "  or a minimum-bill refusal. Asking again gets the same answer."
        rm -f "$log"
        return 1
        ;;
      unknown)
        red "$target: NOT retrying. The error above is not one this script knows"
        red "  to be transient (dropped request, 5xx, rate limit), so it stops"
        red "  rather than guess. If it was a blip, re-run: finished steps skip."
        rm -f "$log"
        return 1
        ;;
    esac
    if [ "$attempt" -ge "$FN_ROUNDS" ]; then
      red "$target: still failing after $attempt attempt(s), every one transient."
      rm -f "$log"
      return 1
    fi
    ylw "$target: transient failure (dropped request, 5xx or rate limit)."
    if [ "$FN_SETTLE" -gt 0 ] && [ "$DRY_RUN" != "1" ]; then
      ylw "  Retrying in ${FN_SETTLE}s."
      sleep "$FN_SETTLE"
    else
      ylw "  Retrying now."
    fi
    attempt=$((attempt + 1))
  done
}

# report_removed_functions <fleet-file>: name every function the last release
# shipped (.release-functions) that is no longer in <fleet-file>, the functions
# the built lib/ exports now. Reads two files and prints; deletes nothing and
# deploys nothing. A function so the resumed step 5, which deploys nothing, can
# still say it (#840), with the same text the deploy path always printed.
report_removed_functions() {
  local fleet="$1" manifest="$ROOT/.release-functions" gone g
  if [ ! -s "$manifest" ] || [ ! -s "$fleet" ]; then
    return 0
  fi
  gone="$(grep -vxF -f "$fleet" "$manifest" 2>/dev/null || true)"
  [ -n "$gone" ] || return 0
  ylw "functions: these were deployed by the last release and are no longer"
  ylw "  in the code. Nothing here deletes them, so they are still serving:"
  for g in $gone; do ylw "    firebase functions:delete $g --project $PROJECT"; done
}

# verify_deployed_fleet <names-file> <started-epoch-ms>: did the deploy deliver?
#
# ISSUE #503. On 2026-08-11 a hand-run deploy lost one 25-function batch and did
# not stop. The 24 that already existed quietly kept serving their previous
# revision, so nothing 404d and no screen broke; the run reported success and
# nobody knew for eight days. The one mark it left was twilioVoice, which was new
# that afternoon and inside the lost block, so it was simply never created, and
# with it PR #349s P0 business-hours fix never reached production.
#
# The batch loop above already refuses when firebase TELLS it a batch failed.
# This is the other half: checking the fleet itself rather than the deploy
# tools account of it. It asks only about the names THIS run deployed, because a
# narrowed release deploys a subset on purpose and the rest of the fleet is
# legitimately older.
#
# It runs HERE, inside step 5, and not at the end. Step 5 is placed where it is
# so the clients cannot ship ahead of the backend; a verify that ran after
# hosting would defeat exactly that.
#
# WHEN IT CANNOT ANSWER the release still has to be possible, same as every other
# gate in this file. Exit 2 from the checker means could not verify, not failed:
# an empty or truncated fleet read is indistinguishable from a real zero
# (ADR-0004), so it is reported and the release continues. Exit 1 means the fleet
# was read and it disagrees, and that stops the run.
verify_deployed_fleet() {
  local names_file="$1" started_ms="$2" dump

  if [ "$DRY_RUN" = "1" ]; then
    ylw "DRY_RUN=1: skipping the fleet verify. Nothing deployed, so there is"
    ylw "  nothing to find, and every name would read as missing."
    return 0
  fi
  if [ "${RELEASE_SKIP_FLEET_VERIFY:-0}" = "1" ]; then
    ylw "SKIPPED the fleet verify (RELEASE_SKIP_FLEET_VERIFY=1). The deploy tools"
    ylw "  own account of what landed is the only evidence this run has."
    return 0
  fi

  STEP="verifying the functions deploy actually delivered"
  dump="$FN_WORK/fleet-after.json"
  cyan ""
  cyan "verifying the fleet, because a deploy that loses a batch says nothing (#503)"
  if ! (cd "$ROOT/mytribe" && npx firebase functions:list --json) > "$dump" 2>/dev/null; then
    ylw "could not read the deployed fleet back. NOT treating that as a failed"
    ylw "  deploy: an unreadable answer is not evidence either way. Check by hand:"
    ylw "    npm --prefix mytribe/functions run runtime-options:diff -- <dump>"
    return 0
  fi

  set +e
  npm --prefix "$ROOT/mytribe/functions" run --silent runtime-options:cli -- \
    --verify-deploy --names "$names_file" --since "$started_ms" --deployed "$dump"
  local rc=$?
  set -e

  case "$rc" in
    0)
      grn "fleet verified: everything this run deployed is live and current."
      FLEET_VERIFIED=1
      ;;
    1)
      red ""
      red "REFUSED: the functions deploy reported success and the fleet disagrees."
      red "  The rest of this release has NOT run, so the clients have not been"
      red "  shipped ahead of a backend that is missing pieces. Redeploy the names"
      red "  listed above, then run this again."
      exit 1
      ;;
    *)
      ylw "could not verify the fleet (see above). The deploy itself reported"
      ylw "  success and this run continues; nothing here says it failed."
      ;;
  esac
}
# ---------------------------------------------------------------------------
# 0. Preconditions.
# ---------------------------------------------------------------------------
banner "0. Preconditions"

# RELEASE_PREFLIGHT_ONLY=1 runs steps 0 and 1b and then STOPS, deploying
# nothing. It exists because this script was previously only executable in the
# exact situation it guards for — clean tree, on main, in sync — which meant its
# own code paths could not be exercised anywhere else, and the secret preflight
# shipped with a `PROJECT: unbound variable` that only appeared the first time it
# ran for real. The tree/branch/sync guards are skipped in this mode precisely
# because nothing in it can ship: it is unreachable from any deploy.
PREFLIGHT_ONLY="${RELEASE_PREFLIGHT_ONLY:-0}"
if [ "$PREFLIGHT_ONLY" = "1" ]; then
  ylw "RELEASE_PREFLIGHT_ONLY=1: checking preflight only. Nothing will deploy."
fi

STEP="checking the working tree is clean"
if [ "$PREFLIGHT_ONLY" != "1" ]; then
if [ -n "$(git status --porcelain)" ]; then
  red "REFUSED: the working tree has uncommitted changes."
  red "  A release ships what is COMMITTED on main. Uncommitted work either"
  red "  belongs in the release (commit it, land it) or does not (stash it)."
  red "  Shipping a dirty tree makes the deployed bundle unreproducible."
  git status --short >&2
  exit 1
fi
grn "tree: clean"

STEP="checking the current branch"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  red "REFUSED: on branch '$BRANCH', not main."
  red "  Production ships from main. Land the work first, then release."
  exit 1
fi
grn "branch: main"

# The sync check must verify the FACT (local == origin), not one transport's
# ability to ask. The 1Password SSH agent drops out regularly here, and on
# 2026-07-27 it killed a release whose code was fine and already in sync: git
# over SSH could not authenticate, so the check could not run, so the run
# refused. The runbook already says `gh` uses an HTTPS token and is unaffected,
# and is the right cross-check when the agent is down. Now the script knows
# that too. This is not a bypass: it still proves local == origin, over a
# transport that works. If BOTH transports fail we still refuse, because an
# unverifiable sync is exactly the state that strands a merged PR off main.
STEP="checking main is in sync with origin"
LOCAL="$(git rev-parse HEAD)"
if [ "$LOCAL" != "$RELEASE_SHA" ]; then
  red "REFUSED: HEAD is $(git rev-parse --short HEAD), but this run was started for $RELEASE_SHORT."
  red "  RELEASE_SHA names the commit a run releases; npm run deploy:bg sets it at"
  red "  launch, and HEAD has moved since. Start the release again from the"
  red "  commit you mean to ship (and unset RELEASE_SHA if you exported it)."
  exit 1
fi
REMOTE=""
if git fetch origin main --quiet 2>/dev/null; then
  REMOTE="$(git rev-parse origin/main)"
  SYNC_VIA="git"
else
  ylw "git fetch failed (SSH agent down?). Falling back to gh over HTTPS."
  SLUG="$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  REMOTE="$(gh api "repos/$SLUG/commits/main" --jq .sha 2>/dev/null || true)"
  SYNC_VIA="gh"
fi

if [ -z "$REMOTE" ]; then
  red "REFUSED: cannot determine origin/main by any available transport."
  red "  git fetch failed AND gh could not answer."
  red "  If the 1Password SSH agent dropped, quit and reopen 1Password."
  red "  An unverifiable sync is refused rather than assumed: that is how a"
  red "  merged PR ends up not on main and nobody notices."
  exit 1
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  red "REFUSED: local main and origin/main disagree (checked via $SYNC_VIA)."
  red "  local:  $LOCAL"
  red "  origin: $REMOTE"
  red "  Deploying either one silently picks a winner. Pull (or push) first."
  exit 1
fi
grn "sync: main == origin/main ($RELEASE_SHORT, via $SYNC_VIA)"

# What is actually about to ship, so the operator can recognise it. A release
# whose contents are a surprise is one nobody can sanity-check.
STEP="summarising the release"
cyan ""
cyan "HEAD: $(git log -1 --format='%h %s' "$RELEASE_SHA" | cut -c1-100)"
if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: every firebase command below will be PRINTED, not run."
fi

confirm "Release this commit to production (auntieos-ttpc)?"
fi  # end of the guards skipped under RELEASE_PREFLIGHT_ONLY
# From here on, every step boundary refuses if HEAD has left RELEASE_SHA.
RELEASE_HEAD_GUARD=1

# ---------------------------------------------------------------------------
# 0b. What CI thinks of THIS commit, before anything is built or shipped.
# ---------------------------------------------------------------------------
banner "0b. CI verdict for HEAD"

# WHY THIS EXISTS
# Step 1 runs `npm run check`: typecheck, lint, contracts:check, test, build. It
# does NOT run `npm run e2e`, and never did. So the Playwright suite could not
# stop a release no matter how red it was. That suite is the only thing in this
# repo that drives the admin in a REAL browser, against the real
# firestore.rules, through the real sign-in form.
#
# On 2026-08-01 it did not stop one. That release went out from a commit whose
# `React admin e2e` job was red on main, and this script said nothing, because
# nothing here had ever looked.
#
# WHY IT ASKS CI RATHER THAN RUNNING E2E HERE
# Three ways to close this, and the other two are worse for measured reasons.
#
#   Put `npm run e2e` inside `npm run check`. `check` is also what CI runs and
#   what every contributor runs before pushing. e2e needs the auth and Firestore
#   emulators on 9399 and 8385, a downloaded Chromium and a JDK, so this makes a
#   busy port or a missing browser fail everybody's `check`, and it makes a
#   release that cannot START because a dev emulator is holding a port. That is
#   a new failure mode traded for the one being fixed, spread over more people.
#
#   Run it as its own release step. Same emulator and port exposure, narrower,
#   plus 42-49s of wall clock over three measured runs
#   (auntieos-admin/docs/runbooks/e2e.md). The minute is affordable. The problem
#   is that it answers a different question: a local pass says this machine
#   agrees today. The runbook's own "CI red, local green" entry says these two
#   disagree in practice, and CI is the authority for what is red on MAIN, which
#   is the thing that was red.
#
#   Ask CI. One HTTPS request, no emulator, no port, no browser, and it covers
#   every other job for free: a red Android, portal or functions job now stops
#   the release too, not just e2e. `gh` uses an HTTPS token, so it answers when
#   the 1Password SSH agent is down, the same reason step 0 already falls back
#   to it.
#
# The third one, then. It is a gate on the verdict, not a second opinion.
#
# WHEN THE GATE CANNOT ANSWER the release must still be possible: an unreachable
# GitHub is not a reason to be unable to ship a fix. So an unavailable gate
# REFUSES and names RELEASE_SKIP_CI_GATE=1 in the refusal, the same shape as the
# functions skip naming RELEASE_FORCE_FUNCTIONS=1. Refusing rather than warning
# is deliberate: a warning in a two-hundred-line release log is not a decision
# anybody made, and this script's whole posture is that an unknown is reported,
# never rounded up.

# The job is named "React admin e2e" in .github/workflows/ci.yml. Matched as a
# substring so renaming the prefix does not silently disable the gate; if the
# word leaves the name altogether the gate reports that it found no e2e verdict,
# which is loud, rather than reporting a clean one, which would be a lie.
CI_E2E_MATCH='e2e'
CI_E2E_LOOKBACK=15

# ci_check_runs <sha>: one "name<TAB>status<TAB>conclusion" line per check run.
# The API's default filter is `latest`, one run per check name, so a re-run
# supersedes the run it replaced rather than both being counted.
ci_check_runs() {
  gh api "repos/{owner}/{repo}/commits/$1/check-runs?per_page=100" \
    --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv' 2>/dev/null || true
}

# ci_verdict <status> <conclusion>: pass | pending | fail.
# `skipped` and `neutral` are passes HERE because a path-filtered job that had
# nothing to do is not a failure. That is not the same as calling a skipped e2e
# a green e2e. See the lookback below, which is where that distinction is made.
ci_verdict() {
  if [ "$1" != "completed" ]; then printf 'pending'; return; fi
  case "$2" in
    success|skipped|neutral) printf 'pass' ;;
    *)                       printf 'fail' ;;
  esac
}

# ci_e2e_conclusion <sha>: the e2e job's conclusion for that commit, "pending"
# if it is still running, or empty if the job produced no check run at all.
ci_e2e_conclusion() {
  local line
  line="$(ci_check_runs "$1" | grep -i "$CI_E2E_MATCH" | head -1 || true)"
  [ -n "$line" ] || return 0
  printf '%s' "$line" | awk -F'\t' '{ if ($2 != "completed") print "pending"; else print $3 }'
}

# ci_refuse <headline> [lines...]: refuse, naming the override.
# Under RELEASE_PREFLIGHT_ONLY it reports what a real release WOULD have done
# and continues, because preflight ships nothing and is normally run from a
# branch GitHub has never seen a commit of. Refusing there would make the one
# mode that exists to exercise this code the one mode that cannot reach it.
ci_refuse() {
  local headline="$1"; shift
  if [ "$PREFLIGHT_ONLY" = "1" ]; then
    ylw "preflight: a real release would REFUSE here."
    ylw "  $headline"
    for l in "$@"; do ylw "  $l"; done
    return 0
  fi
  red "REFUSED: $headline"
  for l in "$@"; do red "  $l"; done
  red ""
  red "  If the gate is genuinely UNAVAILABLE rather than saying no (gh absent,"
  red "  not authenticated, GitHub unreachable), release without it:"
  red "    RELEASE_SKIP_CI_GATE=1 npm run deploy"
  red "  Do not use it to walk past a red check. That is the 2026-08-01 release."
  exit 1
}

STEP="reading CI's verdict for HEAD"
HEAD_SHA="$RELEASE_SHA"
HEAD_SHORT="$RELEASE_SHORT"

# Tracked so the closing summary can say what this run actually established
# instead of listing the steps it walked past. Same rule as the release tag,
# which names a skipped functions deploy rather than claiming everything shipped.
CI_GATE_READ=0
CHECK_RAN=0

if [ "${RELEASE_SKIP_CI_GATE:-0}" = "1" ]; then
  ylw "SKIPPED (RELEASE_SKIP_CI_GATE=1). Nothing has checked whether CI is green"
  ylw "  for $HEAD_SHORT, e2e included. That judgement is yours now."
elif ! command -v gh >/dev/null 2>&1; then
  ci_refuse "gh is not installed, so CI's verdict for $HEAD_SHORT cannot be read." \
    "Install it and sign in:  brew install gh && gh auth login"
else
  CI_RUNS="$(ci_check_runs "$HEAD_SHA")"

  if [ -z "$CI_RUNS" ]; then
    # "No check runs" and "could not ask" are the same output from the API's
    # point of view and different facts, so this refuses on both rather than
    # picking one. Either way nothing has judged this commit.
    ci_refuse "GitHub reports no check runs at all for $HEAD_SHORT." \
      "Either CI has not started for this commit, or gh could not reach GitHub," \
      "or it is not authenticated (check with: gh auth status)." \
      "A commit no job has judged is not a commit to ship."
  else
    CI_FAILED=""
    CI_PENDING=""
    CI_TOTAL=0
    while IFS=$'\t' read -r ci_name ci_status ci_concl; do
      [ -n "$ci_name" ] || continue
      CI_TOTAL=$((CI_TOTAL + 1))
      case "$(ci_verdict "$ci_status" "$ci_concl")" in
        fail)    CI_FAILED="$CI_FAILED
      $ci_name ($ci_concl)" ;;
        pending) CI_PENDING="$CI_PENDING
      $ci_name ($ci_status)" ;;
      esac
    done <<< "$CI_RUNS"

    if [ -n "$CI_FAILED" ]; then
      ci_refuse "CI is not green for $HEAD_SHORT." \
        "These checks did not pass:$CI_FAILED" \
        "" \
        "Fix them on main and release the commit that fixes them. A release is" \
        "not where you find out a job was red."
    elif [ -n "$CI_PENDING" ]; then
      ci_refuse "CI has not finished for $HEAD_SHORT." \
        "Still running:$CI_PENDING" \
        "" \
        "Wait for it. Shipping against a run in flight ships against an unknown," \
        "and half of what this script does is refuse to round an unknown up."
    else
      grn "ci: all $CI_TOTAL checks green for $HEAD_SHORT"
    fi

    # THE PATH FILTER IS THE SUBTLE PART, and it is the difference between a
    # gate and a placebo. `React admin e2e` only runs when the paths it watches
    # change (auntieos-admin/e2e/**, src/**, the rules mirror, the lockfile), so
    # on a functions-only commit GitHub reports it SKIPPED. Skipped is not a
    # verdict, and the loop above deliberately counts it as a pass so a
    # legitimately-not-run job does not block a release.
    #
    # Which leaves the exact hole the incident went through: break e2e, land one
    # more commit that touches nothing the filter watches, and HEAD now carries a
    # skipped e2e and no memory of the red one. So when HEAD has no e2e RESULT,
    # walk back along first-parent history for the most recent commit that has
    # one, and use it, naming which commit it came from, because a verdict
    # borrowed from three commits ago should look borrowed.
    STEP="reading the e2e verdict"
    E2E_CONCL="$(ci_e2e_conclusion "$HEAD_SHA")"
    E2E_SHA="$HEAD_SHA"
    if [ -z "$E2E_CONCL" ] || [ "$E2E_CONCL" = "skipped" ]; then
      E2E_CONCL=""
      for sha in $(git rev-list --first-parent --max-count="$CI_E2E_LOOKBACK" "$HEAD_SHA~1" 2>/dev/null || true); do
        c="$(ci_e2e_conclusion "$sha")"
        if [ -n "$c" ] && [ "$c" != "skipped" ]; then
          E2E_CONCL="$c"
          E2E_SHA="$sha"
          break
        fi
      done
    fi

    if [ -z "$E2E_CONCL" ]; then
      # Not a refusal. A repo can legitimately go this long without touching the
      # admin, and refusing here would block releases for a suite that had
      # nothing to say. But it is not a pass either, and it does not print like
      # one: nothing in this run knows whether the browser suite is green.
      ylw "e2e: NO VERDICT for $HEAD_SHORT or the $CI_E2E_LOOKBACK commits before"
      ylw "  it. The Playwright suite has not judged anything near this commit, so"
      ylw "  nothing here can tell you the admin works in a browser."
      ylw "  Run it yourself if this release touches the admin:  npm run e2e"
    elif [ "$E2E_CONCL" = "pending" ]; then
      ylw "e2e: still running on $(git rev-parse --short "$E2E_SHA"). No verdict yet."
    elif [ "$E2E_CONCL" != "success" ]; then
      ci_refuse "the e2e suite is '$E2E_CONCL' for the admin code in $HEAD_SHORT." \
        "The verdict is from $(git rev-parse --short "$E2E_SHA"), the most recent" \
        "commit whose 'React admin e2e' job actually ran. Nothing since then" \
        "touched the paths that re-trigger it, so it still stands for HEAD." \
        "" \
        "Reproduce it locally with:  npm run e2e" \
        "This is the check that was red and unheard on 2026-08-01."
    elif [ "$E2E_SHA" = "$HEAD_SHA" ]; then
      grn "e2e: green on $HEAD_SHORT"
    else
      grn "e2e: green as of $(git rev-parse --short "$E2E_SHA"); nothing since then"
      grn "     changed a path the suite watches."
    fi
    CI_GATE_READ=1
  fi
fi

# ---------------------------------------------------------------------------
# 0c. Client build config, BEFORE the build that compiles it in.
# ---------------------------------------------------------------------------
banner "0c. Client build config (VITE_*)"

# THE ORDER IS THE WHOLE POINT, and it is why this is 0c and not 6a. `vite build`
# INLINES import.meta.env.VITE_* into the JavaScript at build time. There is no
# server process to inject a value into afterwards, so a value that arrives
# after step 1 arrives after the only moment it could have mattered, and the
# bundle that ships carries an empty string where a Sentry DSN or a Mapbox token
# was supposed to be. Nothing fails. The site just quietly does less.
#
# Until 2026-08-24 the only source for these was a gitignored .env on one
# laptop, and nothing in the repo listed which variables existed at all.
# Operator ruling: "SECRETS MANAGER, ALL OUR SHIT IS IN THERE."
#
# PRECEDENCE (Vite's own, see scripts/client-secrets.mjs for the mechanics):
#   process.env  >  <app>/.env.production.local  >  <app>/.env.local, .env
# This step writes the middle one from Secret Manager, so the store beats a
# developer's local files for a RELEASE build while local development keeps
# working with no gcloud, no credentials and no network.
STEP="resolving client build config from Secret Manager"
if [ "${RELEASE_SKIP_CLIENT_SECRETS:-0}" = "1" ]; then
  ylw "SKIPPED (RELEASE_SKIP_CLIENT_SECRETS=1). Both web bundles will be built"
  ylw "  from whatever each app's own .env files hold."
else
  # --release is what VITE_SENTRY_RELEASE becomes: derived here rather than
  # stored, because a release tag kept by hand in a .env is a tag that names the
  # last release someone remembered to edit it for.
  #
  # THE EXIT CODE IS READ, not just its truthiness, because there are three
  # answers and only one of them is good: resolved (0), refused (1), and could
  # not look at all (3). Collapsing the third into the first is the same mistake
  # step 1b's comment warns about: "no secrets found" and "could not look" must
  # never print the same.
  CLIENT_RC=0
  node "$ROOT/scripts/client-secrets.mjs" --write \
    --project "$PROJECT" --release "$RELEASE_SHORT" || CLIENT_RC=$?
  case "$CLIENT_RC" in
    0)
      grn "client config: every declared VITE_* value resolved, and written where"
      grn "  only a production build reads it"
      ;;
    3)
      ylw "client config: NOT CHECKED. Neither Secret Manager nor the apps' own"
      ylw "  .env files could be read, so nothing here judged what the build will"
      ylw "  compile in. The names it could not verify are listed above."
      ;;
    *)
      red ""
      red "REFUSED: the web apps declare client build config that has no value."
      red "  The names and the exact commands are listed above. Refusing here,"
      red "  before anything is built, because a bundle compiled without them"
      red "  deploys perfectly and then does less than it says it does."
      red ""
      red "  To ship anyway, knowing what is missing: RELEASE_SKIP_CLIENT_SECRETS=1"
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 1. Build and verify, which is also what produces the artifacts we upload.
# ---------------------------------------------------------------------------
banner "1. Check (typecheck, lint, test, build)"

STEP="running npm run check"
if [ "$PREFLIGHT_ONLY" = "1" ]; then
  ylw "SKIPPED (preflight only). Using whatever is already built."
elif [ "${RELEASE_SKIP_CHECK:-0}" = "1" ]; then
  ylw "SKIPPED (RELEASE_SKIP_CHECK=1). The dist/ directories about to be"
  ylw "uploaded are whatever was last built, which may not match HEAD."
else
  npm run check
  CHECK_RAN=1
  grn "check: passed, and dist/ now matches HEAD"
fi

# ---------------------------------------------------------------------------
# 1b. Every DECLARED secret must exist, BEFORE anything deploys.
# ---------------------------------------------------------------------------
banner "1b. Secret preflight"

# Firebase validates declared secrets before uploading, and a secret that is
# declared but never SET fails the whole codebase deploy, not just the function
# declaring it. On 2026-07-26 that killed a release five minutes in, AFTER
# indexes and rules had already shipped, leaving production half-moved. The
# names come from the built __endpoints, the same structure the CLI validates,
# so this check agrees with the validator rather than approximating it.
STEP="checking declared secrets exist"
if [ "${RELEASE_SKIP_SECRET_CHECK:-0}" = "1" ]; then
  ylw "SKIPPED (RELEASE_SKIP_SECRET_CHECK=1)."
elif ! DECLARED="$(node "$ROOT/scripts/declared-secrets.js" 2>/dev/null)" || [ -z "$DECLARED" ]; then
  # Could not read the endpoints (functions not built, e.g. under
  # RELEASE_SKIP_CHECK). Say so plainly instead of reporting a clean check:
  # "no secrets found" and "could not look" must never print the same.
  ylw "could not read declared secrets (are the functions built?). Not checked."
else
  EXISTING="$(gcloud secrets list --project "$PROJECT" --format='value(name)' 2>/dev/null || true)"
  if [ -z "$EXISTING" ]; then
    ylw "could not list Secret Manager secrets; skipping the comparison."
  else
    MISSING=""
    for s in $DECLARED; do
      printf '%s\n' "$EXISTING" | grep -qx "$s" || MISSING="$MISSING $s"
    done
    if [ -n "$MISSING" ]; then
      red "REFUSED: the code declares secrets that do not exist in Secret Manager:"
      for s in $MISSING; do red "    $s"; done
      red ""
      red "  Firebase validates every declared secret before it uploads anything,"
      red "  so these would fail the ENTIRE functions deploy, not just the"
      red "  functions that declare them. Refusing now, before any deploy, so"
      red "  production is not left half-shipped."
      red ""
      red "  Create each one from mytribe/ (it prompts, so the value stays out"
      red "  of your shell history):"
      for s in $MISSING; do
        red "    firebase functions:secrets:set $s --project $PROJECT"
      done
      exit 1
    fi
    grn "secrets: all $(printf '%s\n' "$DECLARED" | wc -l | tr -d ' ') declared secrets exist"
  fi
fi

# ---------------------------------------------------------------------------
# 1c. Assemble the Android release, BEFORE anything ships.
# ---------------------------------------------------------------------------
banner "1c. Android release build"

# WHY ANDROID IS IN THE RELEASE AT ALL.
#
# The three clients were built to parity: the same callables, the same
# contracts, the same invoice state table, kept honest by tests in all three
# trees. That discipline held everywhere except the last step. This script
# shipped functions and two hosting targets and never touched Android, so
# parity was real in the source tree and fiction in production. By 2026-07-28
# the newest APK was versionCode 318 against a web build of 518: 47 commits and
# ~13,400 added lines that no user could run.
#
# That is not merely stale. On 2026-07-28 the deployed Firestore rules revoked
# client-direct invoice writes (invoices allow create/update/delete: if false,
# ADR-0002), and the Android writer moved to callables in PR #105. Any APK
# built before #105 therefore gets PERMISSION_DENIED on every invoice create,
# edit and delete. A client that cannot ship is a client that silently rots
# against a server that keeps moving.
#
# WHY IT BUILDS HERE AND DISTRIBUTES LATER.
#
# Same rule step 1 follows for dist/: build everything before shipping
# anything. An APK that fails to assemble AFTER hosting has gone out breaks
# parity in the other direction and leaves the web ahead of Android, which is
# the exact state this step exists to end. So the assembly runs before the
# first deploy, where its failure costs nothing, and the upload runs beside
# hosting in step 6b.
#
# CI cannot do this: release signing needs the keystore, which lives in
# local.properties (gitignored, per machine) alongside the Mapbox downloads
# token. This script runs where those already are.
#
# THERE ARE TWO ANDROID APPS, AND UNTIL 2026-08-04 THIS STEP SHIPPED ONE.
#
# Everything above was written against a single hardcoded ANDROID_DIR of
# auntieos-admin/android. So it ended the drift for the operator app and left
# the Kinfolk Portal's Android client in the identical hole, reading the same
# comment. Both apps are registered and ACTIVE in auntieos-ttpc:
#
#   auntieos  com.tribetails.auntieos  auntieos-admin/android, module :app
#   mytribe   com.kinfolk.portal       mytribe/, Kotlin Multiplatform, ROOT module
#
# The portal shipped its web half every release while its Android half sat at
# versionCode 2 / 0.2.0, because nothing here built it. The operator ruling is
# parity: each operating system has a web app and an Android app, and both go
# out in the same run. Desktop is deliberately held off: the compose.desktop
# block in mytribe/build.gradle.kts is not a release target and is not built.
#
# THE TWO BUILDS ARE NOT THE SAME SHAPE, which is the part worth writing down.
# auntieos-admin/android is a conventional multi-module build with an :app
# submodule, so its task is :app:assembleRelease and its APK lands under
# app/build/. mytribe applies com.android.application to the ROOT project, so
# there is no :app to address: the task is the root project's :assembleRelease
# and the output lands in mytribe/build/outputs/apk/release/ named from
# rootProject.name, which is "kinfolk-portal" and not "mytribe". Guessing
# either from the other is how this breaks again, so both are spelled out.
#
# THE BOOKKEEPING IS PER APP FOR THE SAME REASON IT WAS EVER SPLIT. built and
# distributed were kept as two scalars so the closing tag could not claim a
# client landed when only its build had. With two apps, one pair of scalars
# tells that same lie one level up: a tag reading "android: distributed" when
# one of two went out. So they are arrays, index-aligned with the table below,
# and step 9 prints a line per app.
#
# Parallel indexed arrays rather than one associative array: macOS ships bash
# 3.2, where `declare -A` does not exist, and this script runs on the
# operator's mac.
ANDROID_NAMES=(auntieos mytribe)
ANDROID_LABELS=(
  "AuntieOS operator (com.tribetails.auntieos)"
  "Kinfolk Portal (com.kinfolk.portal)"
)
ANDROID_DIRS=(
  "$ROOT/auntieos-admin/android"
  "$ROOT/mytribe"
)
ANDROID_TASKS=(
  ":app:assembleRelease"
  ":assembleRelease"
)
ANDROID_APKS=(
  "$ROOT/auntieos-admin/android/app/build/outputs/apk/release/app-release.apk"
  "$ROOT/mytribe/build/outputs/apk/release/kinfolk-portal-release.apk"
)
# RELEASE_ANDROID_APP_ID stays honoured for auntieos alone. It predates the
# second app and every use of it means that one; silently widening it to both
# would point the portal's upload at the operator app's Firebase entry.
ANDROID_APP_IDS=(
  "${RELEASE_ANDROID_APP_ID_AUNTIEOS:-${RELEASE_ANDROID_APP_ID:-1:153396971788:android:6bcb7c5411aeda837f2129}}"
  "${RELEASE_ANDROID_APP_ID_MYTRIBE:-1:153396971788:android:4e9868bbb96301277f2129}"
)
# What to say when one of them fails to assemble. Per app, because the two need
# entirely different things on the machine and a generic "check your keystore"
# sends you to the wrong tree half the time.
ANDROID_BUILD_HINTS=(
"  Release signing needs KEYSTORE_PATH, KEYSTORE_PASSWORD, KEY_ALIAS and
  KEY_PASSWORD in auntieos-admin/android/local.properties, and
  MAPBOX_DOWNLOADS_TOKEN in ~/.gradle/gradle.properties."
'  Needs the Android SDK: sdk.dir in mytribe/local.properties, or ANDROID_HOME
  in the environment. This app signs with the Android DEBUG keystore
  (~/.android/debug.keystore, see the signingConfigs block in
  mytribe/build.gradle.kts), so a machine with no debug keystore fails here
  too; Android Studio creates one, or `keytool` does.'
)
ANDROID_COUNT=${#ANDROID_NAMES[@]}

ANDROID_BUILT=()
ANDROID_DISTRIBUTED=()
ANDROID_IDX=0
while [ "$ANDROID_IDX" -lt "$ANDROID_COUNT" ]; do
  ANDROID_BUILT[$ANDROID_IDX]=0
  # Tracked separately from ANDROID_BUILT: an APK that assembled but failed to
  # upload (see the non-fatal warning in 6b) shipped nothing, and the closing
  # tag must say so rather than claim that client landed.
  ANDROID_DISTRIBUTED[$ANDROID_IDX]=0
  ANDROID_IDX=$((ANDROID_IDX + 1))
done
# Whether ANY app produced an APK. Drives the audience resolution below and the
# 6b entry condition; the per-app arrays decide what actually gets uploaded.
ANDROID_ANY_BUILT=0

STEP="assembling the Android release APKs"
ANDROID_IDX=0
while [ "$ANDROID_IDX" -lt "$ANDROID_COUNT" ]; do
  ANDROID_NAME="${ANDROID_NAMES[$ANDROID_IDX]}"
  ANDROID_DIR="${ANDROID_DIRS[$ANDROID_IDX]}"
  ANDROID_TASK="${ANDROID_TASKS[$ANDROID_IDX]}"
  ANDROID_APK="${ANDROID_APKS[$ANDROID_IDX]}"
  # PER-APP SKIP. Warranted now and not before: with one app the only failure
  # mode was "ship the web alone", which RELEASE_SKIP_ANDROID already covered.
  # With two, a build broken in ONE app would otherwise force that same
  # all-or-nothing switch and drop the healthy client with it, turning one
  # broken app into two unshipped ones, which is the drift this step exists
  # against. So each app has its own off switch and the run names which app it
  # skipped.
  ANDROID_SKIP_VAR="RELEASE_SKIP_ANDROID_$(printf '%s' "$ANDROID_NAME" | tr '[:lower:]' '[:upper:]')"

  cyan "1c.$((ANDROID_IDX + 1)) ${ANDROID_LABELS[$ANDROID_IDX]}"
  if [ "${RELEASE_SKIP_ANDROID:-0}" = "1" ]; then
    ylw "SKIPPED (RELEASE_SKIP_ANDROID=1). The web ships without the Android"
    ylw "  clients, which is the drift that put Android 200 versionCodes behind."
  elif [ "${!ANDROID_SKIP_VAR:-0}" = "1" ]; then
    ylw "SKIPPED ($ANDROID_SKIP_VAR=1). The other Android app still ships."
  elif [ "$PREFLIGHT_ONLY" = "1" ]; then
    ylw "SKIPPED (preflight only)."
  elif [ ! -d "$ANDROID_DIR" ]; then
    ylw "SKIPPED: no $ANDROID_DIR on this machine."
  elif [ "$DRY_RUN" = "1" ]; then
    ylw "DRY_RUN=1: would delete any stale APK and run ./gradlew $ANDROID_TASK"
    ylw "  in $ANDROID_DIR"
  else
    # The rm lives INSIDE this branch, not above the if. A rehearsal that
    # assembles nothing but deletes the signed APK a real run left on disk has
    # changed the machine to prove nothing, and 6b's retry line would then point
    # at a file that is gone. rm only where a build replaces what it removed.
    rm -f "$ANDROID_APK"
    # Fails at execution time, naming the missing piece, when a keystore, the
    # Mapbox token or the SDK is absent. Refuse the release rather than ship a
    # web half: a partial release is how the clients diverged in the first
    # place.
    ( cd "$ANDROID_DIR" && ./gradlew "$ANDROID_TASK" --no-daemon ) || {
      red "REFUSED: the $ANDROID_NAME Android release APK did not build."
      red "  Nothing has been deployed yet, which is why this step runs here."
      red "${ANDROID_BUILD_HINTS[$ANDROID_IDX]}"
      red "  To ship without this app: $ANDROID_SKIP_VAR=1."
      red "  To ship the web with no Android at all: RELEASE_SKIP_ANDROID=1."
      exit 1
    }
    [ -f "$ANDROID_APK" ] || {
      red "REFUSED: gradle succeeded but $ANDROID_APK is not there."
      red "  The task ran but wrote its APK somewhere else, so the path in this"
      red "  script is wrong for $ANDROID_NAME. Distributing nothing is correct;"
      red "  distributing a stale APK from a previous build would be worse."
      exit 1
    }
    ANDROID_BUILT[$ANDROID_IDX]=1
    ANDROID_ANY_BUILT=1
    grn "android/$ANDROID_NAME: assembled $(basename "$ANDROID_APK") ($(du -h "$ANDROID_APK" | cut -f1))"
  fi
  ANDROID_IDX=$((ANDROID_IDX + 1))
done

# WHO THE BUILD ACTUALLY REACHES, decided before anything ships.
#
# `appdistribution:distribute` takes --testers or --groups. Given NEITHER it
# uploads the binary, attaches the release notes, prints
#
#   no testers or groups specified, skipping
#
# as a WARNING, and exits 0. A release that reports success and reaches nobody
# is the exact silent drift steps 1c and 6b exist to end, and it is worse than
# the old behaviour because a green Android line now claims it shipped.
# Observed on the first real run of this step, 2026-07-28.
#
# So the audience is resolved HERE, where an empty one can still refuse the
# whole release, rather than at 6b where the web has already gone out.
#
# ONE audience for both apps. App Distribution's tester roster is per project,
# not per app, and the two apps go to the same internal people; splitting the
# audience per app would invent a second roster to keep in sync with the first.
STEP="resolving the Android distribution audience"
ANDROID_GROUPS="${RELEASE_ANDROID_GROUPS:-}"
ANDROID_TESTERS="${RELEASE_ANDROID_TESTERS:-}"
# Declared here rather than in 6b because step 9 reads it. 6b fills it in from
# whichever audience flags it ends up passing.
ANDROID_AUDIENCE_DESC=""
if [ "$ANDROID_ANY_BUILT" = "1" ] && [ -z "$ANDROID_GROUPS" ] && [ -z "$ANDROID_TESTERS" ]; then
  # Nothing configured, so fall back to every tester on the project. For an
  # internal tool that IS the audience, and it keeps the roster in the Firebase
  # console instead of hardcoded here where it would rot.
  # Run from mytribe/, where *.log is ignored. The Firebase CLI writes
  # firebase-debug.log into its working directory and keeps it on a failure
  # (or with DEBUG set); from the root, that file used to land in the
  # working-tree baseline taken before step 2 (#840 third review).
  ANDROID_TESTERS="$(
    ( cd "$ROOT/mytribe" && firebase appdistribution:testers:list --project "$PROJECT" --json 2>/dev/null ) |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=(JSON.parse(s).result||{}).testers||[];console.log(t.map(x=>String(x.name).split("/").pop()).filter(Boolean).join(","))}catch(e){console.log("")}})'
  )"
  # awk NF rather than `tr , newline | wc -l`: with no trailing newline wc
  # counts separators, so one tester reports as 0 and two report as 1.
  [ -n "$ANDROID_TESTERS" ] && ylw "android: no audience configured; using all $(printf '%s' "$ANDROID_TESTERS" | awk -F, '{print NF}') project tester(s)."
fi
if [ "$ANDROID_ANY_BUILT" = "1" ] && [ -z "$ANDROID_GROUPS" ] && [ -z "$ANDROID_TESTERS" ]; then
  red "REFUSED: the Android builds have nobody to go to."
  red "  The project has no App Distribution testers and no group was named,"
  red "  so the upload would succeed, warn 'no testers or groups specified',"
  red "  and reach no one. Nothing has deployed yet."
  red "  Fix by adding a tester:"
  red "    firebase appdistribution:testers:add EMAIL --project $PROJECT"
  red "  or name an audience for this run:"
  red "    RELEASE_ANDROID_GROUPS=alias   (or RELEASE_ANDROID_TESTERS=a@b,c@d)"
  red "  To ship the web alone anyway: RELEASE_SKIP_ANDROID=1."
  exit 1
fi

if [ "$PREFLIGHT_ONLY" = "1" ]; then
  cleanup_client_env
  trap - EXIT
  banner "Preflight only: stopping here"
  grn "Steps 0 and 1b ran. Nothing was deployed."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2 & 3. Indexes, then WAIT for them.
# ---------------------------------------------------------------------------
# The working-tree baseline, taken after step 1 has built (so its outputs are
# already there) and before anything deploys. From here on a changed tree
# refuses at the next check, the same as a moved HEAD.
if ! RELEASE_TREE_BASELINE="$(release_tree_fingerprint)"; then
  red "REFUSED: git could not read the working tree (twice, a second apart), so"
  red "  this run cannot take the baseline it checks the checkout against."
  red "  Nothing has deployed. Usually another git command holds .git/index.lock:"
  red "  check nothing else runs git in this checkout, then re-run."
  exit 1
fi
RELEASE_TREE_BASELINE_STATUS="$(git -C "$ROOT" status --short 2>/dev/null || true)"
banner "2. Firestore indexes"

STEP="deploying firestore indexes"
RESUMED_INDEXES=0
if progress_done indexes; then
  RESUMED_INDEXES=1
fi

# THE WRAPPER AND THIS STEP MUST AGREE (#840 review). npm run deploy:bg decides
# at launch that this run RESUMES steps 2 and 3, which is the only reason it did
# not refuse a detached run with changed indexes. If the record has changed since
# (deleted, tree gone dirty, RELEASE_NO_RESUME), deploying indexes here would
# let step 3's prompt answer itself under RELEASE_YES=1, which is exactly what
# the wrapper exists to prevent. So stop, before anything deploys.
if [ "${RELEASE_BG_EXPECTS_INDEX_RESUME:-0}" = "1" ] && [ "$RESUMED_INDEXES" = "0" ]; then
  red "REFUSED: RELEASE_BG_EXPECTS_INDEX_RESUME=1 says this run resumes steps 2 and 3"
  red "  (npm run deploy:bg sets it when it lets changed indexes through on a"
  red "  resume), but .release-progress no longer lets $RELEASE_SHORT resume the"
  red "  index step (the reason, if there is one, is printed above). Deploying"
  red "  indexes now would let step 3's 'are all indexes Enabled?' answer itself."
  red "  Run it in the foreground and answer step 3 yourself:  npm run deploy"
  red "  or, if the variable was left set in your shell:  unset RELEASE_BG_EXPECTS_INDEX_RESUME"
  exit 1
fi

if [ "$RESUMED_INDEXES" = "1" ]; then
  # Worded from what the record proves. An operator typing "y" at step 3 is
  # recorded separately from RELEASE_YES (or deploy:bg, or RELEASE_BG_FORCE)
  # answering it, and only the first is a confirmation anyone made.
  if progress_has indexes-confirmed; then
    ylw "RESUMED: an earlier run of $RELEASE_SHORT deployed the indexes, and the"
    ylw "  operator confirmed them Enabled at step 3. Skipping steps 2 and 3."
  else
    ylw "RESUMED: an earlier run of $RELEASE_SHORT deployed the indexes. Step 3 was"
    ylw "  answered by RELEASE_YES=1 there, not by a look at the console. If this"
    ylw "  release changed indexes, check they read Enabled. Skipping steps 2 and 3."
  fi
  ylw "  RELEASE_NO_RESUME=1 redoes them."
else
  deploy mytribe firestore:indexes
  grn "indexes: submitted"
fi

# Filled by confirm() below: "operator" or "RELEASE_YES". Empty when step 3
# asked nothing (a resume, or a dry run).
CONFIRM_BY=""
banner "3. Wait for indexes to finish building"

# The CLI returns as soon as the index is ACCEPTED, not when it is Enabled.
# Shipping the querying code against a still-building index is the failure this
# whole ordering exists to prevent, and it is invisible at build time.
if [ "$RESUMED_INDEXES" = "1" ]; then
  ylw "RESUMED: skipped, see step 2."
elif [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: skipping the index wait."
else
  ylw "Index builds are ASYNCHRONOUS. The deploy above returned when Firestore"
  ylw "ACCEPTED the indexes, not when they finished building. Code deployed"
  ylw "against a still-building index fails at runtime, silently."
  ylw ""
  ylw "Check every index reads Enabled before continuing:"
  ylw "  https://console.firebase.google.com/project/auntieos-ttpc/firestore/indexes"
  confirm "Are all indexes Enabled?"
fi
if [ "$RESUMED_INDEXES" != "1" ]; then
  progress_mark indexes
  if [ "$CONFIRM_BY" = "operator" ]; then
    progress_mark indexes-confirmed
  fi
fi

# ---------------------------------------------------------------------------
# 4. Rules.
# ---------------------------------------------------------------------------
banner "4. Firestore rules"

# safe-deploy refuses this outright unless the admin mirror is byte-identical to
# mytribe's copy, so a drifted mirror stops the release here rather than
# overwriting live rules with a stale file.
STEP="deploying firestore rules"
if progress_done rules; then
  ylw "RESUMED: an earlier run of $RELEASE_SHORT deployed the rules. Skipping."
  ylw "  RELEASE_NO_RESUME=1 redeploys them."
else
  deploy mytribe firestore:rules
  grn "rules: deployed"
  # The rules deploy read firestore.rules from the working tree, so the checkout
  # is checked before recording it; a refusal here drops the record.
  release_head_guard "after deploying firestore:rules"
  progress_mark rules
fi

# ---------------------------------------------------------------------------
# 5. Functions, before the clients that call them.
# ---------------------------------------------------------------------------
banner "5. Functions"

# WHY THIS IS CONDITIONAL, which is the fix for a cycle that blocked a release
# for hours on 2026-07-27. Redeploying the codebase mints a NEW Cloud Run
# revision for every one of its ~200 functions even when not a line changed.
# Revisions are never reclaimed on their own, and each one holds CPU against the
# regional "total allowable CPU" quota. A release that redeploys unchanged
# functions therefore burns ~200 revisions of quota to accomplish nothing, and
# once the quota is exhausted the functions step FAILS — so the release blocks
# itself, on work it did not need to do, before it ever reaches hosting.
#
# The last released commit is recorded in .release-state (gitignored, per
# machine). If nothing under mytribe/functions changed since then, the deployed
# functions are already this code and the step is skipped and SAYS so. Anything
# unknown (no state file, unreadable commit) deploys, because the safe default
# when you cannot prove code is current is to ship it.
STEP="deploying the mytribe functions codebase"
STATE_FILE="$ROOT/.release-state"
LAST_RELEASED=""
[ -f "$STATE_FILE" ] && LAST_RELEASED="$(cat "$STATE_FILE" 2>/dev/null || true)"

FUNCTIONS_CHANGED=1
# Declared here rather than in the branch that fills it, because the deploy
# below reads it to decide whether this is a secret rebind (a handful of
# functions) or a code change (as many as the diff reaches), and under set -u an
# unset variable there would kill the release at its riskiest step.
NEWER_SECRETS=""
# What the closing tag and the .release-functions manifest report. Empty means
# this run deployed no functions, which is a fact both of them must be able to
# state rather than round up.
FUNCTIONS_SHIPPED_DESC=""
FLEET_LIST=""

# RESUMED (#840): this exact commit's functions were deployed AND fleet-verified
# by an earlier run that then stopped. Checked before the .release-state diff,
# because .release-state still names the PREVIOUS release, so that diff says
# "changed" and would redeploy everything that is already live.
# RELEASE_FORCE_FUNCTIONS=1 means "deploy them", so it wins over a resume.
#
# Two records resume it, and they say different things: functions-mytribe (a
# deploy whose fleet verify PASSED) and functions-mytribe-none (the diff reached
# no deployed function, so nothing was deployed). functions-mytribe-unverified
# never resumes anything; it exists so the stop message can say it.
RESUMED_FUNCTIONS=0
RESUMED_FUNCTIONS_NONE=0
if [ "${RELEASE_FORCE_FUNCTIONS:-0}" != "1" ]; then
  if progress_done functions-mytribe; then
    RESUMED_FUNCTIONS=1
  elif progress_done functions-mytribe-none; then
    RESUMED_FUNCTIONS=1
    RESUMED_FUNCTIONS_NONE=1
  fi
fi

if [ "${RELEASE_FORCE_FUNCTIONS:-0}" = "1" ]; then
  ylw "functions: forced (RELEASE_FORCE_FUNCTIONS=1)"
elif [ -n "$LAST_RELEASED" ] && git cat-file -e "$LAST_RELEASED^{commit}" 2>/dev/null; then
  if git diff --quiet "$LAST_RELEASED" "$RELEASE_SHA" -- mytribe/functions 2>/dev/null; then
    FUNCTIONS_CHANGED=0
  fi
fi

# A CHANGED SECRET IS A CHANGED DEPLOY, even though it changes no file.
#
# This is the second half of the skip above, and without it the skip has a hole
# an operator falls into silently. `firebase functions:secrets:set` mints a new
# Secret Manager VERSION and binds nothing: these are gcfv2 functions, which pin
# the version resolved at DEPLOY time. So the sequence "set the secret, run the
# release" leaves the runtime reading the old value, or no value, forever. The
# git diff above sees an unchanged tree and skips the one step that would have
# bound it, and the release reports success.
#
# That is not hypothetical. It is the Google Calendar report: both OAuth secrets
# set several times, the feature still rejecting with `google_oauth_not_configured`,
# and every release since saying "functions unchanged, skipped".
#
# So when the code is unchanged, ask whether any DECLARED secret has an enabled
# version newer than the last released commit, and deploy if one does. Timestamps
# are normalised to YYYYMMDDTHHMMSS (git's committer time forced to UTC, gcloud's
# createTime already UTC) because one carries an offset and the other a fraction,
# and comparing those as raw strings is wrong in a way that looks right.
if [ "$FUNCTIONS_CHANGED" -eq 0 ] && [ "$RESUMED_FUNCTIONS" = "0" ]; then
  STEP="checking whether a declared secret changed since the last release"
  SINCE="$(TZ=UTC git show -s --format=%cd --date=iso-strict-local "$LAST_RELEASED" 2>/dev/null || true)"
  SINCE_N="$(printf '%s' "$SINCE" | tr -d ':-' | cut -c1-15)"
  SECRET_DECLARED="$(node "$ROOT/scripts/declared-secrets.js" 2>/dev/null || true)"
  if [ -z "$SINCE_N" ] || [ -z "$SECRET_DECLARED" ]; then
    # Same posture as step 1b's "could not list": an unknown is reported, never
    # rendered as a clean answer. Skipping stays the behaviour so a machine
    # without gcloud does not start doing the ~200-function deploy every run,
    # but the override is named so nobody has to guess it.
    ylw "could not check whether a secret changed (are the functions built, is"
    ylw "  gcloud signed in?). If you have just run functions:secrets:set, this"
    ylw "  release will NOT bind it. Force with RELEASE_FORCE_FUNCTIONS=1."
  else
    for s in $SECRET_DECLARED; do
      LATEST="$(gcloud secrets versions list "$s" --project "$PROJECT" \
        --filter='state:ENABLED' --sort-by=~createTime --limit=1 \
        --format='value(createTime)' 2>/dev/null || true)"
      LATEST_N="$(printf '%s' "$LATEST" | tr -d ':-' | cut -c1-15)"
      [ -z "$LATEST_N" ] && continue
      if [[ "$LATEST_N" > "$SINCE_N" ]]; then
        NEWER_SECRETS="$NEWER_SECRETS $s"
      fi
    done
  fi
  if [ -n "$NEWER_SECRETS" ]; then
    FUNCTIONS_CHANGED=1
    ylw "functions: code unchanged, but these secrets have a version newer than"
    ylw "  the last release, and a set secret is not mounted until a deploy"
    ylw "  resolves it:"
    for s in $NEWER_SECRETS; do ylw "    $s"; done
    ylw "  Deploying, because skipping would leave the new value unbound."
  fi
fi

if [ "$RESUMED_FUNCTIONS" = "1" ]; then
  FUNCTIONS_CHANGED=1
  if [ "$RESUMED_FUNCTIONS_NONE" = "1" ]; then
    ylw "RESUMED: SKIPPED the mytribe functions. An earlier run of $RELEASE_SHORT"
    ylw "  found nothing to deploy: no deployed function loads what changed."
    FUNCTIONS_SHIPPED_DESC="resumed: nothing to deploy, per an earlier run of this commit"
  else
    ylw "RESUMED: SKIPPED the mytribe functions. An earlier run of"
    ylw "  $RELEASE_SHORT deployed them and the fleet verify PASSED."
    ylw "  Redeploying would mint Cloud Run revisions to change nothing."
    FUNCTIONS_SHIPPED_DESC="resumed: deployed and fleet-verified by an earlier run of this commit"
  fi
  ylw "  RELEASE_NO_RESUME=1 (or RELEASE_FORCE_FUNCTIONS=1) deploys them again."
  # FLEET_LIST feeds .release-functions at the end. Read it from the lib/ that
  # step 1 just built from this same commit; if that fails the manifest is left
  # as it was, which is what the unchanged-skip below does too.
  FLEET_LIST="$(node "$ROOT/scripts/function-targets.js" 2>/dev/null || true)"
  # The removed-functions check normally runs inside the deploy branch below,
  # so a resume would skip it. It only reads lib/ and the manifest, so it runs
  # here too, from the same list.
  if [ -n "$FLEET_LIST" ]; then
    RESUME_FLEET="$(mktemp)"
    printf '%s\n' "$FLEET_LIST" > "$RESUME_FLEET"
    report_removed_functions "$RESUME_FLEET"
    rm -f "$RESUME_FLEET"
  else
    ylw "  Could not enumerate the functions, so functions removed from the code"
    ylw "  since the last release were not re-checked. To list them:"
    ylw "    node scripts/function-targets.js | grep -vxF -f /dev/stdin .release-functions"
  fi
elif [ "$FUNCTIONS_CHANGED" -eq 0 ]; then
  ylw "SKIPPED: mytribe/functions is unchanged since the last release"
  ylw "  ($(git rev-parse --short "$LAST_RELEASED")). The deployed functions are"
  ylw "  already this code. Redeploying would mint ~200 Cloud Run revisions and"
  ylw "  burn regional CPU quota to change nothing."
  ylw "  Force with RELEASE_FORCE_FUNCTIONS=1."
else
  # THE FLEET DID NOT FIT, AND NO AMOUNT OF PRUNING MADE IT FIT.
  #
  # Both halves of that arithmetic have since moved, and the batching outlived
  # them; read to the end before deciding this comment still argues for it.
  #
  # mytribe/functions is ~227 exports, each its own Cloud Run service, and at
  # the time each drew 1 vCPU. A deploy starts a NEW revision beside the serving
  # one, so `--only functions:mytribe` asked us-central1 for roughly double the
  # fleet at once against a CpuAllocPerProjectRegion of 200 vCPU. On 2026-08-01,
  # five full deploys each died partway:
  #
  #     forced (RELEASE_FORCE_FUNCTIONS=1)   197 ok   26 failed
  #     stray (wrong cwd, package script)    131 ok   95 failed
  #     release retry                        197 ok   30 failed
  #     release with PREDEPLOY_KEEP=2        201 ok   26 failed
  #     targeted redeploy of just those 26     0 ok   26 failed
  #
  # Note where the successes stop: 197, 201, 197, against a stated 200. That
  # looked like the ceiling printing itself. Revisions went 702 -> 926 -> 1250
  # across the day because every attempt mints ~227 more, and pruning to 487 did
  # not make the next full deploy fit.
  #
  # IT WAS THE WRONG QUOTA. MEASURED 2026-08-03.
  #
  # Deploying all 227 in ONE batch and reading the error text instead of
  # inferring it gives:
  #
  #   HTTP Error: 429, Quota exceeded for quota metric 'Per project mutation
  #   requests' and limit 'Per project mutation requests per minute per region'
  #   of service 'cloudfunctions.googleapis.com'
  #
  # Different service from CpuAllocPerProjectRegion, and a RATE rather than a
  # ceiling. That is why every capacity measurement came back clean: idle
  # revisions were not counted, the project sat at ~36 vCPU at rest while
  # deploys failed, and a retry of the same names landed minutes later with no
  # quota change, which is the per-minute window resetting. 197/201/197 against
  # a stated 200 vCPU was a coincidence of scale, not the ceiling printing
  # itself.
  #
  # THE SINGLE BATCH LANDED. All 227, ~9 minutes, 13 functions hit the 429
  # across 14 retry waves, the CLI backed off and retried, all 227 finished
  # successfully. A whole-fleet deploy is not impossible and never was, for the
  # stated reason.
  #
  # Batching stays as the default because pacing mutations is the right shape of
  # fix for a per-minute rate limit, and staying under it beats hitting it and
  # recovering: retries cost wall-clock, and exhausting the CLI's backoff still
  # ends with named casualties. It also carries the per-function result parsing
  # and the named-casualty retry below. What it is NOT is the only way to get
  # the fleet deployed.
  #
  # THERE IS NO DURABLE FIX TO ASK FOR. 'Per project mutation requests per
  # minute per region' on cloudfunctions.googleapis.com is 60, and the console
  # types it as a System limit with Adjustable = No, in every region. Reads get
  # 1,200, which is why only a deploy ever notices. The Quota adjuster does not
  # cover it either; it manages adjustable rows only.
  #
  # So 60 a minute is the shape of the world, and batching is how to live in it.
  # The 400 vCPU Cloud Run increase approved the same day is real headroom aimed
  # at the wrong meter; #219 (fleet default cpu 0.25, 38 overrides) makes CPU
  # comfortable regardless, at ~90 vCPU of draw.
  #
  # Every recovery that day had the same shape and it always worked: name the
  # casualties and redeploy them as a small batch through safe-deploy. So the
  # release now does by design what recovery did by hand. `firebase deploy
  # --only functions:mytribe:a,functions:mytribe:b,...` takes an explicit list,
  # and scripts/function-targets.js produces that list from the built lib/, the
  # same artifact the Firebase CLI itself loads.
  STEP="enumerating the mytribe functions"
  FN_WORK="$(mktemp -d)"

  if ! node "$ROOT/scripts/function-targets.js" > "$FN_WORK/fleet"; then
    red "REFUSED: the deployable functions could not be enumerated (see above)."
    red "  Deploying them needs their names, and this script will not fall back"
    red "  to '--only functions:mytribe': that is the whole-fleet deploy the CPU"
    red "  quota refused five times on 2026-08-01."
    red "  Usually this means lib/ is not built:  npm run build:functions"
    exit 1
  fi
  FLEET_COUNT="$(awk 'NF{n++} END{print n+0}' "$FN_WORK/fleet")"

  # WHAT LEFT PRODUCTION SINCE LAST TIME. Deploying by explicit name never
  # deletes anything, where `--only functions:mytribe` would have offered to
  # remove functions that no longer exist in the source. That is a real hole this
  # batching opens, so it is reported rather than left for someone to find: the
  # manifest below records the fleet at the end of every successful release, and
  # a name that has since left the code is named here with the command that
  # removes it. Reported, never done automatically: deleting a live function is
  # not something a release should decide on its own.
  report_removed_functions "$FN_WORK/fleet"

  # WHICH OF THEM THIS RELEASE ACTUALLY HAS TO TOUCH.
  #
  # A one-function change has no business redeploying 227 services. .release-state
  # already names the last released commit, so `git diff --name-status` names the
  # changed files, and function-targets.js maps those to functions through the
  # module graph of the BUILT lib/ (statically, so lazy requires are in it).
  #
  # The mapping is not per-file-per-function: src/lib/logger.ts is in all 227
  # closures and src/lib/auditEvents.ts in 196, so a shared-code change correctly
  # widens to almost everything. Anything it cannot attribute (the src/index.ts
  # barrel, a delete, a rename, a package.json dependency, a require it cannot
  # read statically) exits 3, says why, and this falls back to the full fleet.
  # A correct slow deploy beats a clever wrong one, and every uncertain case
  # resolves towards deploying MORE functions, never fewer.
  STEP="working out which functions this release changes"
  cp "$FN_WORK/fleet" "$FN_WORK/targets"
  FN_SCOPE="every function"

  if [ "${RELEASE_FUNCTIONS_ALL:-0}" = "1" ]; then
    ylw "functions: RELEASE_FUNCTIONS_ALL=1, deploying the whole fleet."
  elif [ "${RELEASE_FORCE_FUNCTIONS:-0}" = "1" ]; then
    ylw "functions: forced, so the whole fleet is deployed rather than a subset."
  elif [ -n "$NEWER_SECRETS" ]; then
    # The code is unchanged and a secret is newer, so what needs rebinding is
    # exactly the functions that DECLARE that secret. declared-secrets.js already
    # answers that from the same __endpoint structure, per function.
    STEP="finding the functions that declare the changed secrets"
    : > "$FN_WORK/bysecret"
    SECRET_LOOKUP_OK=1
    for s in $NEWER_SECRETS; do
      node "$ROOT/scripts/declared-secrets.js" --by-function "$s" 2>/dev/null |
        awk -F'\t' -v want="$s" '$2 == want { print $1 }' >> "$FN_WORK/bysecret" ||
        SECRET_LOOKUP_OK=0
    done
    sort -u "$FN_WORK/bysecret" -o "$FN_WORK/bysecret"
    if [ "$SECRET_LOOKUP_OK" = "1" ] && [ -s "$FN_WORK/bysecret" ]; then
      cp "$FN_WORK/bysecret" "$FN_WORK/targets"
      FN_SCOPE="the functions declaring$NEWER_SECRETS"
    else
      ylw "functions: could not tell which functions declare those secrets."
      ylw "  Deploying the whole fleet, because an unbound secret is silent."
    fi
  elif [ -n "$LAST_RELEASED" ] && git cat-file -e "$LAST_RELEASED^{commit}" 2>/dev/null; then
    git diff --name-status "$LAST_RELEASED" "$RELEASE_SHA" -- mytribe/functions > "$FN_WORK/changed" 2>/dev/null || true
    if node "$ROOT/scripts/function-targets.js" \
         --changed-from "$FN_WORK/changed" --base "$LAST_RELEASED" > "$FN_WORK/narrowed"; then
      cp "$FN_WORK/narrowed" "$FN_WORK/targets"
      FN_SCOPE="what changed since $(git rev-parse --short "$LAST_RELEASED")"
    else
      # Exit 3 (and anything else) means the fleet is known but this change could
      # not be attributed. The reason is already on the log, above.
      ylw "functions: falling back to the whole fleet for the reason above."
    fi
  else
    ylw "functions: no usable .release-state, so there is nothing to diff against."
    ylw "  Deploying the whole fleet, which is the safe direction."
  fi

  FN_COUNT="$(awk 'NF{n++} END{print n+0}' "$FN_WORK/targets")"
  cyan "functions: deploying $FN_COUNT of $FLEET_COUNT ($FN_SCOPE)"

  if [ "$FN_COUNT" -eq 0 ]; then
    # Not a skip and not a failure: the diff was real (that is why this branch
    # ran) and no deployed function loads any of it. Test-only and docs-only
    # commits land here, and they used to cost a 227-function deploy.
    grn "functions: nothing to deploy. No deployed function loads the code that"
    grn "  changed since the last release."
    FUNCTIONS_SHIPPED_DESC="nothing to deploy ($FN_SCOPE reaches no deployed function)"
    # Its own record, never functions-mytribe: nothing was deployed or verified,
    # and the resume, the stop message and the tag must not say it was.
    release_head_guard "before recording step 5 (nothing to deploy)"
    progress_mark functions-mytribe-none
  else
    # PRUNE BEFORE, NOT ONLY AFTER, and be honest about what it buys.
    #
    # The 2026-08-01 evidence is that pruning is NOT a quota fix: keep-2 took the
    # inventory from 1250 to 487 and the deploy that followed still lost 26
    # functions. The batching above is the quota fix. What the prune is good for
    # is retention, and doing it here rather than only at step 8 means a run that
    # is about to mint hundreds of revisions starts from the floor instead of
    # from wherever a previous failed release left the inventory.
    #
    # So it defaults ON at the same depth step 8 keeps (3), which makes it a
    # near no-op in steady state: step 8 already left the inventory at that floor
    # after the last successful release, so this only bites when something went
    # wrong in between, which is exactly when it is worth doing. It spends no
    # rollback depth that step 8 was not going to spend an hour later anyway.
    #
    # And it only runs for a LARGE deploy. A narrowed release of four functions
    # has no business sweeping the whole project's revision history first.
    # RELEASE_PREDEPLOY_KEEP=0 turns it off.
    STEP="reclaiming Cloud Run revisions before the functions deploy"
    PREDEPLOY_KEEP="${RELEASE_PREDEPLOY_KEEP:-3}"
    PREDEPLOY_MIN="${RELEASE_PREDEPLOY_MIN_TARGETS:-50}"
    if [ "$PREDEPLOY_KEEP" != "0" ] && [ "$FN_COUNT" -ge "$PREDEPLOY_MIN" ] && [ "$DRY_RUN" != "1" ]; then
      ylw "pruning to $PREDEPLOY_KEEP per service before deploying $FN_COUNT functions."
      ylw "  Retention, not headroom: the quota fix is the batching below."
      bash "$ROOT/scripts/prune-run-revisions.sh" "$PREDEPLOY_KEEP" || {
        # A prune that could not run is not proof the quota is short, and
        # refusing to ship on a housekeeping failure is worse than trying.
        ylw "pre-deploy prune reported problems (see above). Deploying anyway."
      }
    elif [ "$PREDEPLOY_KEEP" = "0" ]; then
      ylw "pre-deploy prune disabled (RELEASE_PREDEPLOY_KEEP=0)."
    elif [ "$DRY_RUN" != "1" ]; then
      cyan "pre-deploy prune skipped: $FN_COUNT functions is under the $PREDEPLOY_MIN"
      cyan "  threshold, so there is nothing worth reclaiming depth for."
    fi

    STEP="deploying the mytribe functions in batches"
    # deploy_function_names REWRITES its argument: the file is the pending list,
    # and on success it is empty. Snapshot the names first, because the verify
    # below needs to know what this run claimed to deploy.
    cp "$FN_WORK/targets" "$FN_WORK/deployed-names"
    FN_DEPLOY_STARTED_MS="$(( $(date +%s) * 1000 ))"
    if deploy_function_names "$FN_WORK/targets"; then
      grn "functions:mytribe: all $FN_COUNT deployed"
      FUNCTIONS_SHIPPED_DESC="$FN_COUNT of $FLEET_COUNT, batched in $FN_BATCH ($FN_SCOPE)"
      verify_deployed_fleet "$FN_WORK/deployed-names" "$FN_DEPLOY_STARTED_MS"
      # functions-mytribe ONLY on a verify that passed. "Could not verify" and a
      # skipped verify record functions-mytribe-unverified instead, which the
      # stop message names and no rerun skips on. A dry run records nothing.
      # Checked first: a record naming RELEASE_SHA must not be written from a
      # checkout that has left it.
      release_head_guard "before recording step 5"
      if [ "$FLEET_VERIFIED" = "1" ]; then
        progress_forget functions-mytribe-unverified
        progress_mark functions-mytribe
      else
        progress_mark functions-mytribe-unverified
        FUNCTIONS_SHIPPED_DESC="$FUNCTIONS_SHIPPED_DESC, fleet NOT verified"
      fi
    else
      red "REFUSED: $(awk 'NF{n++} END{print n+0}' "$FN_WORK/targets") function(s) did not deploy after $FN_ROUNDS round(s)."
      red "  These are STALE: production is still serving their previous revision."
      red "  The rest of this release has not run, so the clients have NOT been"
      red "  shipped ahead of the backend. That is the whole reason step 5 is here."
      red ""
      while IFS= read -r n; do [ -n "$n" ] && red "    $n"; done < "$FN_WORK/targets"
      red ""
      red "  Retry just these, smaller and slower:"
      red "    RELEASE_FUNCTIONS_BATCH=5 RELEASE_FUNCTIONS_SETTLE=60 npm run deploy"
      red "  Or by hand, having pruned first:"
      red "    scripts/prune-run-revisions.sh 2"
      red "    scripts/safe-deploy.sh mytribe -- firebase deploy --only \\"
      red "      \"$(awk 'NF{printf "%sfunctions:mytribe:%s", (n++?",":""), $0}' "$FN_WORK/targets")\""
      red ""
      red "  READ THE ERROR ABOVE BEFORE BELIEVING ANY OF THE NEXT PARAGRAPH."
      red "  This block used to assert a rate limit outright. On 2026-08-04 the"
      red "  real error was 'Pass the --force option to deploy functions that"
      red "  increase the minimum bill', printed once per batch, and the advice"
      red "  to retry smaller and slower was worse than useless: every retry was"
      red "  refused for the same reason. Two causes, two different fixes:"
      red ""
      red "    'increase the minimum bill'  -> RELEASE_FUNCTIONS_FORCE=1, and"
      red "                                    read the diff first. Not a limit"
      red "                                    at all, a deliberate cost change."
      red "    HTTP 429 / 'Per project mutation requests per minute per region'"
      red "                                 -> a RATE limit. Retrying smaller and"
      red "                                    slower is the fix, as above."
      red ""
      red "  Cloud Run CPU is NOT either of them: 400 vCPU since 2026-08-03"
      red "  against ~90 of draw. Do not go asking for more of it."
      exit 1
    fi
  fi

  # Kept for the manifest written after verification, so the NEXT release can
  # name any function that has since left the code. Read from the artifact here
  # rather than re-derived later, because by then lib/ may have been rebuilt.
  FLEET_LIST="$(cat "$FN_WORK/fleet")"
  rm -rf "$FN_WORK"
fi

# No banner of its own, so the checkout check is called here directly.
release_head_guard "before the admin codebases"
STEP="deploying the admin functions codebases"
if [ "${RELEASE_INCLUDE_ADMIN_FUNCTIONS:-0}" = "1" ]; then
  # Two codebases, declared in auntieos-admin/web, deployed one at a time
  # because safe-deploy refuses a bare `--only functions` (it would ship both
  # at once) and refuses mixing functions with non-functions targets.
  #
  # RETRIED, AND RECORDED, SINCE #840. These two had no retry while step 5's
  # batches did, so on 2026-09-13 one dropped Secret Manager request stopped a
  # release whose indexes, rules and 279 functions had already shipped.
  for ADMIN_CODEBASE in default reconcile; do
    STEP="deploying the admin functions codebases (functions:$ADMIN_CODEBASE)"
    if progress_done "functions-admin-$ADMIN_CODEBASE"; then
      ylw "RESUMED: an earlier run of $RELEASE_SHORT deployed functions:$ADMIN_CODEBASE."
      ylw "  Skipping. RELEASE_NO_RESUME=1 redeploys it."
      continue
    fi
    if ! deploy_admin_codebase "functions:$ADMIN_CODEBASE"; then
      red "REFUSED: functions:$ADMIN_CODEBASE did not deploy (see above)."
      exit 1
    fi
    # The deploy built from the checkout, so check it before recording it.
    release_head_guard "after deploying functions:$ADMIN_CODEBASE"
    progress_mark "functions-admin-$ADMIN_CODEBASE"
  done
  STEP="deploying the admin functions codebases"
  grn "admin functions: deployed"
else
  # Named, not silent. A release that quietly omits a target reads as complete
  # when it is not, which is the same class of lie as an unverified deploy.
  ylw "SKIPPED: the AuntieOS functions codebases (default, reconcile)."
  ylw "  They live in the second tree (auntieos-admin/web) and are off by"
  ylw "  default. Include them with RELEASE_INCLUDE_ADMIN_FUNCTIONS=1."
fi

# ---------------------------------------------------------------------------
# 6. Hosting.
# ---------------------------------------------------------------------------
banner "6. Hosting"

STEP="deploying the operator admin (hosting:app)"
deploy auntieos-admin hosting:app
grn "admin: deployed"
progress_mark hosting-admin

STEP="deploying the kinfolk portal (hosting:kinfolk_portal)"
deploy mytribe hosting:kinfolk_portal
grn "portal: deployed"
progress_mark hosting-portal

# ---------------------------------------------------------------------------
# 6b. The other two clients, shipped in the same run as the web.
# ---------------------------------------------------------------------------
banner "6b. Android"

# App Distribution is the channel: both apps are internal tools with named
# testers. The tester list is managed in the Firebase console, per project and
# not per app; this uploads to whoever is already on it.
#
# The release note carries the commit, so a tester's build always names the
# code it came from. The AuntieOS versionName also embeds the short SHA (its
# build.gradle.kts builds it from gitShortSha), so that APK is self-identifying
# even off-console. The Kinfolk Portal APK is NOT: its versionCode and
# versionName are hardcoded literals, so every build of it reports as
# "0.2.0 (2)" whatever the code. Until that is derived from git the way the
# operator app's is, the release note is the only thing telling two of its
# builds apart, and Android will not treat a newer one as an upgrade.
STEP="distributing the Android releases"
if [ "$ANDROID_ANY_BUILT" != "1" ]; then
  ylw "SKIPPED: no APK was assembled in step 1c."
else
  ANDROID_NOTES="$(git log -1 --format='%h %s' "$RELEASE_SHA")"

  # The audience was resolved and proven non-empty in 1c. Passing it is what
  # turns an upload into a distribution: without one of these two flags the
  # CLI warns and exits 0, having shipped to nobody. Built once and reused for
  # every app, because the roster is per project.
  ANDROID_AUDIENCE_ARGS=()
  if [ -n "$ANDROID_GROUPS" ]; then
    ANDROID_AUDIENCE_ARGS+=(--groups "$ANDROID_GROUPS")
    ANDROID_AUDIENCE_DESC="groups $ANDROID_GROUPS"
  fi
  if [ -n "$ANDROID_TESTERS" ]; then
    ANDROID_AUDIENCE_ARGS+=(--testers "$ANDROID_TESTERS")
    ANDROID_AUDIENCE_DESC="${ANDROID_AUDIENCE_DESC:+$ANDROID_AUDIENCE_DESC, }$(printf '%s' "$ANDROID_TESTERS" | awk -F, '{print NF}') tester(s)"
  fi

  ANDROID_IDX=0
  while [ "$ANDROID_IDX" -lt "$ANDROID_COUNT" ]; do
    ANDROID_NAME="${ANDROID_NAMES[$ANDROID_IDX]}"
    ANDROID_APK="${ANDROID_APKS[$ANDROID_IDX]}"
    ANDROID_APP_ID="${ANDROID_APP_IDS[$ANDROID_IDX]}"

    if [ "${ANDROID_BUILT[$ANDROID_IDX]}" != "1" ]; then
      # Said out loud rather than passed over. One app shipping is not "android
      # shipped", and a run that only prints the app that went out reads as if
      # both did.
      ylw "android/$ANDROID_NAME: nothing was assembled in 1c; not distributing."
      ANDROID_IDX=$((ANDROID_IDX + 1))
      continue
    fi

    if [ "$DRY_RUN" = "1" ]; then
      ylw "DRY_RUN=1: would upload $ANDROID_APK to $ANDROID_AUDIENCE_DESC"
    else
      cyan "android/$ANDROID_NAME: distributing to $ANDROID_AUDIENCE_DESC"
      # From mytribe/, where *.log is ignored: the CLI keeps firebase-debug.log
      # in its working directory on a failure, and from the root that log made
      # a merely-warned upload failure refuse the release at step 7, after both
      # hostings were live (#840 third review). The APK path is absolute.
      if ( cd "$ROOT/mytribe" && firebase appdistribution:distribute "$ANDROID_APK" \
        --app "$ANDROID_APP_ID" \
        --project "$PROJECT" \
        --release-notes "$ANDROID_NOTES" \
        "${ANDROID_AUDIENCE_ARGS[@]}" ); then
        grn "android/$ANDROID_NAME: distributed to $ANDROID_AUDIENCE_DESC"
        ANDROID_DISTRIBUTED[$ANDROID_IDX]=1
        progress_mark "android-$ANDROID_NAME"
      else
        # The APK is built and signed on disk either way. Failing the release
        # here would report a landed web deploy as broken; saying nothing would
        # recreate the silent drift. So: loud, non-fatal, with the retry, and
        # the retry carries the audience because that is the part forgotten.
        #
        # The loop CONTINUES past a failure rather than breaking: the second
        # app's upload has nothing to do with the first one's, and stopping
        # here would let one bad upload silently un-ship the other client.
        ylw "android/$ANDROID_NAME: distribution FAILED. The signed APK is still at:"
        ylw "  $ANDROID_APK"
        ylw "  Retry with:"
        ylw "  (cd mytribe && firebase appdistribution:distribute '$ANDROID_APK' \\"
        ylw "    --app $ANDROID_APP_ID --project $PROJECT \\"
        ylw "    --release-notes '$ANDROID_NOTES' ${ANDROID_AUDIENCE_ARGS[*]})"
      fi
    fi
    ANDROID_IDX=$((ANDROID_IDX + 1))
  done
fi

# ---------------------------------------------------------------------------
# 7. Prove it landed.
# ---------------------------------------------------------------------------
banner "7. Verify"

# The step whose absence is the reason this script exists. Hosting can report a
# successful release while the browser still gets the old bundle (wrong target,
# stale dist, CDN). Comparing the hashed asset the live site references against
# the one just built is the cheapest possible proof, and it is exact: vite
# content-hashes every bundle filename.
verify_site() {
  local name="$1" url="$2" dist_index="$3"
  STEP="verifying $name"

  if [ ! -f "$dist_index" ]; then
    ylw "$name: no local $dist_index to compare against; skipping."
    return 0
  fi

  local want live
  want="$(grep -o 'assets/index-[^"]*\.js' "$dist_index" | head -1)"
  live="$(curl -fsS --max-time 30 "$url" | grep -o 'assets/index-[^"]*\.js' | head -1 || true)"

  if [ -z "$live" ]; then
    ylw "$name: could not read a bundle reference from $url. Check by hand."
    return 0
  fi

  if [ "$want" = "$live" ]; then
    grn "$name: LIVE matches this build ($live)"
  else
    red "$name: LIVE DOES NOT MATCH THIS BUILD."
    red "  built: $want"
    red "  live:  $live"
    red "  The deploy reported success but the site serves a different bundle."
    red "  Check the hosting target in .firebaserc and re-run before walking away."
    return 1
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: nothing was deployed, so there is nothing to verify."
else
  VERIFY_FAILED=0
  verify_site "admin"  "https://auntie.tribetails.com/"  "$ROOT/auntieos-admin/dist/index.html" || VERIFY_FAILED=1
  verify_site "portal" "https://kinfolk.tribetails.com/" "$ROOT/mytribe/web/dist/index.html"   || VERIFY_FAILED=1
  if [ "$VERIFY_FAILED" -ne 0 ]; then
    STEP="verification"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 8. Reclaim Cloud Run revision quota.
# ---------------------------------------------------------------------------
banner "8. Prune old Cloud Run revisions"

# Cloud Run keeps every revision forever and each holds CPU against the regional
# "total allowable CPU" quota. Nothing here ever reclaimed them, so they reached
# 7,266 across 228 services and exhausted us-central1, which failed 18 functions
# mid-release on 2026-07-26 and then blocked the retry the next day. Pruning by
# hand fixed that night; without a retention step it simply refills at roughly
# 200 revisions per release, and someone rediscovers this in a few months.
#
# Runs AFTER verification on purpose: the revisions being deleted are rollback
# targets, and they are only safe to drop once the thing that replaced them is
# confirmed serving. Never touches the revision a service is serving.
#
# This is RETENTION, not headroom. Read the step 5 comment before believing a
# prune can rescue a deploy from the CPU quota; it was measured and it cannot.
#
# WHY THE DEFAULT IS 3 AND NOT 10.
#
# A keep of N sets a FLOOR of N x services below which this step is arithmetically
# incapable of deleting anything. At 238 services, keep-10 floors at 2,380. The
# project has never been near 2,380 while in trouble: the 2026-07-28 deploy failed
# at 676 revisions and the 2026-08-01 one at 926. So this step ran on 2026-08-01
# against 926 revisions across 238 services, a mean of 3.9 apiece, nothing near
# ten, and deleted ZERO. Not a bug in the prune. A retention default set above
# every level the inventory has ever reached, which is a step that cannot fire.
#
# What the extra depth bought: nothing this repo uses. The documented rollback
# path for functions is revert-and-redeploy (the closing lines of this script say
# so, and so does the runbook); hosting rolls back from the console, separately.
# Revision-level rollback would be `gcloud run services update-traffic`, which is
# written down nowhere here and has never been run. So keep-10 was holding ~8
# revisions per service of theoretical depth nobody has used, at the price of
# never reclaiming a single one.
#
# Keep-3 floors at 714 across 238 services: it would have removed ~212 at the
# 926 that mattered, and it still leaves the two previous deploys plus the
# serving revision per service if anyone ever does want that traffic split.
#
# It stops at 3 rather than 2 or 1 deliberately. Recovery on 2026-08-01 took the
# inventory to 468 (~2 per service) before the last 26 functions would land, and
# it is tempting to make that the default. Don't: the runbook's own measurements
# say the prune is not what fixed it: the 2026-07-28 prune hit its predicted
# floor within one revision and the deploy failed anyway, and a batch retry of
# the same names succeeds minutes later with no quota change. Picking 2 would be
# quietly re-adopting a theory that was tested and failed. 3 is chosen as
# retention hygiene, and the only claim made for it is that the step can now fire.
STEP="pruning old Cloud Run revisions"
KEEP="${RELEASE_KEEP_REVISIONS:-3}"
if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: skipping the prune."
elif [ "${RELEASE_SKIP_PRUNE:-0}" = "1" ]; then
  ylw "SKIPPED (RELEASE_SKIP_PRUNE=1). Revisions accumulate; the CPU quota is"
  ylw "what eventually fails, and it fails a DEPLOY, not this script."
else
  bash "$ROOT/scripts/prune-run-revisions.sh" "$KEEP" || {
    # A failed prune must not fail a verified release. The deploy landed; this
    # is housekeeping, and reporting a good release as broken is its own harm.
    ylw "prune reported problems (see above). The release itself is fine."
  }
fi

# Record what shipped, so the next run can tell whether functions changed.
# Written only after verification passed: a commit recorded as released when it
# was not would make the NEXT release skip functions it should have deployed.
#
# WHICH IS EXACTLY WHAT A DRY RUN USED TO DO. This write was the one mutation in
# the script with no DRY_RUN guard, and .release-state is not a log. It is the
# input to step 5's skip. A rehearsal that writes it tells the next REAL release
# that this commit's functions are already deployed, so that release compares
# mytribe/functions against code that never shipped, finds no diff, and skips the
# deploy. 2026-08-01: a dry run recorded e4f0245, the release behind it skipped
# functions, and the new admin bundle went live calling getInvoiceLedger,
# listInvites, transitionBookingStatus and getBusinessClosures against a backend
# that had none of them.
#
# So the guard is not tidiness. The file records what is DEPLOYED, and a dry run
# deploys nothing, so a dry run has nothing to record.
STEP="recording the released commit"
if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: NOT writing .release-state or .release-functions. They record"
  ylw "  what is DEPLOYED, and this run deployed nothing. Writing them would make"
  ylw "  the next real release skip the functions deploy for code that never"
  ylw "  shipped, and believe a fleet it never saw."
else
  # The commit this run released, not whatever is checked out now; and refuse
  # rather than record if HEAD moved, since this step has no banner to check it.
  release_head_guard "before recording .release-state"
  STEP="recording the released commit"
  printf '%s\n' "$RELEASE_SHA" > "$ROOT/.release-state"
  # The fleet as it stood when it last shipped. Deploying by explicit name never
  # removes anything, so without this nothing would ever notice a function that
  # was deleted from the source and left running in production. Written under the
  # same rule and the same guard as .release-state: only what actually shipped.
  if [ -n "$FLEET_LIST" ]; then
    printf '%s\n' "$FLEET_LIST" > "$ROOT/.release-functions"
  fi
  # The release is recorded whole now, so per-step progress has nothing left to
  # say, and leaving it would only let a later rerun of this commit skip steps.
  rm -f "$PROGRESS_FILE"
fi

# ---------------------------------------------------------------------------
# 9. Tag what shipped.
# ---------------------------------------------------------------------------
banner "9. Tag the release"

# By this point the web is live and step 7 has PROVEN it, so the tag names a
# release that actually happened rather than one this run merely attempted.
# Anything short of here already stopped the script (set -e) before reaching
# this step, so there is no separate "did it really succeed" check to write.
STEP="tagging the release"
TAG=""
TAG_PUSHED=0
if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: skipping the release tag. Nothing shipped in this run, so"
  ylw "  there is nothing to tag or push."
else
  TAG="release/$(date +%Y.%m.%d)-$RELEASE_SHORT"

  # Named honestly from the same state the run already tracked, not a
  # blanket "shipped everything": a skipped or failed piece says so here too.
  SHIPPED="hosting: admin + kinfolk portal
firestore: indexes + rules (mytribe)"
  if [ "$FUNCTIONS_CHANGED" -eq 1 ]; then
    SHIPPED="$SHIPPED
functions: mytribe ($FUNCTIONS_SHIPPED_DESC)"
  else
    SHIPPED="$SHIPPED
functions: mytribe (skipped, unchanged since the last release)"
  fi
  if [ "${RELEASE_INCLUDE_ADMIN_FUNCTIONS:-0}" = "1" ]; then
    SHIPPED="$SHIPPED
functions: auntieos-admin (default, reconcile)"
  fi
  # A LINE PER APP, never one "android:" verdict for both. There are two
  # Android clients; a single line reading "distributed" when one of them
  # stayed on the shelf is the same lie this whole block is written against,
  # just one level up from the one the two scalars were split to prevent.
  ANDROID_IDX=0
  while [ "$ANDROID_IDX" -lt "$ANDROID_COUNT" ]; do
    if [ "${ANDROID_DISTRIBUTED[$ANDROID_IDX]}" -eq 1 ]; then
      SHIPPED="$SHIPPED
android (${ANDROID_NAMES[$ANDROID_IDX]}): distributed ($ANDROID_AUDIENCE_DESC)"
    elif [ "${ANDROID_BUILT[$ANDROID_IDX]}" -eq 1 ]; then
      SHIPPED="$SHIPPED
android (${ANDROID_NAMES[$ANDROID_IDX]}): built, distribution did not confirm (see 6b above)"
    else
      SHIPPED="$SHIPPED
android (${ANDROID_NAMES[$ANDROID_IDX]}): skipped"
    fi
    ANDROID_IDX=$((ANDROID_IDX + 1))
  done

  TAG_MSG="$(git log -1 --format='%h %s' "$RELEASE_SHA")

Shipped:
$SHIPPED"

  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    ylw "tag: $TAG already exists locally; not recreating it."
  elif ! git tag -a "$TAG" -m "$TAG_MSG" "$RELEASE_SHA"; then
    ylw "tag: could not create $TAG (see above)."
    ylw "  The release itself is fine; tag it by hand once you see why:"
    ylw "  git tag -a $TAG -m '...' && git push origin $TAG"
  elif ! git push origin "$TAG"; then
    ylw "tag: $TAG created locally but the push failed (see above)."
    ylw "  The release itself is fine. Push it by hand: git push origin $TAG"
  else
    TAG_PUSHED=1
    grn "tag: $TAG pushed"
  fi
fi

# BRANCH HYGIENE, AFTER THE TAG AND ONLY AFTER IT.
#
# It runs here, past the point where the release is already true, because that
# is what makes it safe to be non-fatal: nothing below this line can make a
# shipped release un-ship. The script never exits non-zero for the same reason.
#
# It only deletes remote branches already merged into main, skips open PR heads
# and anything merged more recently than its grace period, and writes a restore
# line per deletion first. See scripts/prune-merged-branches.sh for why the
# grace period exists (PR #231 merged mid-push and the branch still held work).
if [ "${RELEASE_PRUNE_BRANCHES:-1}" = "1" ]; then
  bash "$ROOT/scripts/prune-merged-branches.sh" || true
else
  ylw "branch prune disabled (RELEASE_PRUNE_BRANCHES=0)."
fi

cleanup_client_env
trap - EXIT
STEP="done"
RELEASE_HEAD_GUARD=0

# A DRY RUN GETS ITS OWN ENDING, because the one below is a claim and a dry run
# has not earned it. "Commit e4f0245 is live and verified" printed at the end of
# a rehearsal on 2026-08-01, under a "Released" banner, having deployed nothing
# and verified nothing: step 7 had already said "nothing was deployed, so there
# is nothing to verify" twenty lines earlier and the summary contradicted it.
# The whole point of step 7 is that a release which cannot prove it landed has
# told you nothing; a run that ASSERTS it landed without proving it is worse.
if [ "$DRY_RUN" = "1" ]; then
  banner "Dry run finished"
  ylw "NOTHING SHIPPED. Nothing was deployed, verified, tagged or recorded."
  ylw "  $RELEASE_SHORT is not live as a result of this run, and"
  ylw "  .release-state still names whatever last actually shipped."
  ylw ""
  # Listed from what actually ran, not from the steps this run walked past. A
  # summary that credits a skipped check is the smaller version of the same lie.
  ylw "What this run DID prove:"
  ylw "  - the preconditions hold (clean tree, on main, in sync with origin)"
  if [ "$CI_GATE_READ" = "1" ]; then
    ylw "  - CI's verdict for this commit was read and nothing was red"
  else
    ylw "  - NOT CI's verdict: the gate did not run in this rehearsal"
  fi
  if [ "$CHECK_RAN" = "1" ]; then
    ylw "  - npm run check passed"
  else
    ylw "  - NOT the build: npm run check did not run in this rehearsal"
  fi
  ylw "  - every firebase command above is the one a real release would run"
  ylw ""
  ylw "To release: re-run without DRY_RUN."
  exit 0
fi

banner "Released"
grn "Commit $RELEASE_SHORT is live and verified."
if [ "$TAG_PUSHED" -eq 1 ]; then
  grn "Tagged $TAG and pushed it to origin."
fi
grn ""
grn "If something looks wrong, the previous hosting release can be rolled back"
grn "from the Firebase console (Hosting -> release history). Functions and"
grn "indexes do NOT roll back with it; they need their own revert and redeploy."
