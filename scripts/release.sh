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
#   1. npm run check  - typecheck, lint, test, build. This is also what
#                       produces the dist/ that step 5 uploads, so it is not
#                       optional theatre: skipping it ships a stale bundle.
#   2. indexes        - BEFORE the code that queries them. A query with no
#                       index fails at RUNTIME, not at build.
#   3. index wait     - deploying an index returns before it is Enabled. The
#                       CLI will not block for you, so this step does.
#   4. rules          - from mytribe only; safe-deploy refuses a drifted mirror.
#   5. functions      - BEFORE the clients that call them, same reason as 2 in
#                       reverse: a client calling a function that is not there
#                       fails at runtime.
#   6. hosting        - admin, then portal.
#   7. verify         - fetch the live bundles and compare to what was just
#                       built. This is the step whose absence hid the stale
#                       admin for 33 hours. A release that cannot prove it
#                       landed has told you nothing.
#
# USAGE
#   npm run deploy                      the whole run
#   DRY_RUN=1 npm run deploy            print every firebase command, run none
#
#   RELEASE_SKIP_CHECK=1                skip step 1 (only when you just ran it)
#   RELEASE_INCLUDE_ADMIN_FUNCTIONS=1   also ship the AuntieOS functions
#                                       codebases (default/reconcile). Off by
#                                       default because they live in a second
#                                       tree with their own deploy semantics;
#                                       the run SAYS when it skipped them.
#   RELEASE_YES=1                       do not prompt (CI). Preconditions still
#                                       apply; nothing is bypassed.
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

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

STEP="starting up"
# Any exit that is not the clean end of this script names the step it died in.
# A release that stops silently mid-way leaves production half-shipped, which is
# worse than not starting: functions ahead of hosting is a state nobody chose.
trap 'code=$?; if [ "$code" -ne 0 ]; then red ""; red "RELEASE STOPPED during: $STEP"; red "Production may be PARTIALLY shipped. Check what completed above before retrying."; fi' EXIT

banner() {
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
    return 0
  fi
  printf '\033[33m%s [y/N] \033[0m' "$1"
  read -r reply </dev/tty || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *)
      trap - EXIT
      ylw "Stopped at your request. Nothing further was deployed."
      exit 0
      ;;
  esac
}

# deploy <prefix> <targets>: one guarded deploy, announced before it runs.
deploy() {
  local prefix="$1" targets="$2"
  cyan "deploy: $prefix -> $targets"
  DRY_RUN="${DRY_RUN:-0}" bash "$SAFE_DEPLOY" "$prefix" -- firebase deploy --only "$targets"
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
grn "sync: main == origin/main ($(git rev-parse --short HEAD), via $SYNC_VIA)"

# What is actually about to ship, so the operator can recognise it. A release
# whose contents are a surprise is one nobody can sanity-check.
STEP="summarising the release"
cyan ""
cyan "HEAD: $(git log -1 --format='%h %s' | cut -c1-100)"
if [ "${DRY_RUN:-0}" = "1" ]; then
  ylw "DRY_RUN=1: every firebase command below will be PRINTED, not run."
fi

confirm "Release this commit to production (auntieos-ttpc)?"
fi  # end of the guards skipped under RELEASE_PREFLIGHT_ONLY

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

if [ "$PREFLIGHT_ONLY" = "1" ]; then
  trap - EXIT
  banner "Preflight only: stopping here"
  grn "Steps 0 and 1b ran. Nothing was deployed."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2 & 3. Indexes, then WAIT for them.
# ---------------------------------------------------------------------------
banner "2. Firestore indexes"

STEP="deploying firestore indexes"
deploy mytribe firestore:indexes
grn "indexes: submitted"

banner "3. Wait for indexes to finish building"

# The CLI returns as soon as the index is ACCEPTED, not when it is Enabled.
# Shipping the querying code against a still-building index is the failure this
# whole ordering exists to prevent, and it is invisible at build time.
if [ "${DRY_RUN:-0}" = "1" ]; then
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

# ---------------------------------------------------------------------------
# 4. Rules.
# ---------------------------------------------------------------------------
banner "4. Firestore rules"

# safe-deploy refuses this outright unless the admin mirror is byte-identical to
# mytribe's copy, so a drifted mirror stops the release here rather than
# overwriting live rules with a stale file.
STEP="deploying firestore rules"
deploy mytribe firestore:rules
grn "rules: deployed"

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
if [ "${RELEASE_FORCE_FUNCTIONS:-0}" = "1" ]; then
  ylw "functions: forced (RELEASE_FORCE_FUNCTIONS=1)"
elif [ -n "$LAST_RELEASED" ] && git cat-file -e "$LAST_RELEASED^{commit}" 2>/dev/null; then
  if git diff --quiet "$LAST_RELEASED" HEAD -- mytribe/functions 2>/dev/null; then
    FUNCTIONS_CHANGED=0
  fi
fi

if [ "$FUNCTIONS_CHANGED" -eq 0 ]; then
  ylw "SKIPPED: mytribe/functions is unchanged since the last release"
  ylw "  ($(git rev-parse --short "$LAST_RELEASED")). The deployed functions are"
  ylw "  already this code. Redeploying would mint ~200 Cloud Run revisions and"
  ylw "  burn regional CPU quota to change nothing."
  ylw "  Force with RELEASE_FORCE_FUNCTIONS=1."
else
  deploy mytribe functions:mytribe
  grn "functions:mytribe: deployed"
fi

STEP="deploying the admin functions codebases"
if [ "${RELEASE_INCLUDE_ADMIN_FUNCTIONS:-0}" = "1" ]; then
  # Two codebases, declared in auntieos-admin/web, deployed one at a time
  # because safe-deploy refuses a bare `--only functions` (it would ship both
  # at once) and refuses mixing functions with non-functions targets.
  deploy auntieos-admin functions:default
  deploy auntieos-admin functions:reconcile
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

STEP="deploying the kinfolk portal (hosting:kinfolk_portal)"
deploy mytribe hosting:kinfolk_portal
grn "portal: deployed"

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

if [ "${DRY_RUN:-0}" = "1" ]; then
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
# confirmed serving. Never touches the revision a service is serving, and keeps
# RELEASE_KEEP_REVISIONS (default 10) per service, so rollback stays possible.
STEP="pruning old Cloud Run revisions"
KEEP="${RELEASE_KEEP_REVISIONS:-10}"
if [ "${DRY_RUN:-0}" = "1" ]; then
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
STEP="recording the released commit"
git rev-parse HEAD > "$ROOT/.release-state"

trap - EXIT
STEP="done"
banner "Released"
grn "Commit $(git rev-parse --short HEAD) is live and verified."
grn ""
grn "If something looks wrong, the previous hosting release can be rolled back"
grn "from the Firebase console (Hosting -> release history). Functions and"
grn "indexes do NOT roll back with it; they need their own revert and redeploy."
