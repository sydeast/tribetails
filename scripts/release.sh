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
#   1. npm run check  - typecheck, lint, test, build. This is also what
#                       produces the dist/ that step 5 uploads, so it is not
#                       optional theatre: skipping it ships a stale bundle.
#  1c. android build  - assemble the signed release APK BEFORE anything ships,
#                       so a build failure costs nothing. Same rule as step 1.
#   2. indexes        - BEFORE the code that queries them. A query with no
#                       index fails at RUNTIME, not at build.
#   3. index wait     - deploying an index returns before it is Enabled. The
#                       CLI will not block for you, so this step does.
#   4. rules          - from mytribe only; safe-deploy refuses a drifted mirror.
#   5. functions      - BEFORE the clients that call them, same reason as 2 in
#                       reverse: a client calling a function that is not there
#                       fails at runtime.
#   6. hosting        - admin, then portal.
#  6b. android        - upload the APK built in 1c to App Distribution, in the
#                       SAME run as the web. Android was outside this script
#                       until 2026-07-28 and had drifted 200 versionCodes
#                       behind the web while the source trees stayed at parity.
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
#   RELEASE_YES=1                       do not prompt (CI). Preconditions still
#                                       apply; nothing is bypassed.
#   RELEASE_SKIP_ANDROID=1              ship the web without the Android client.
#                                       Off by default: shipping them together
#                                       is the point of steps 1c and 6b.
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
  DRY_RUN="$DRY_RUN" bash "$SAFE_DEPLOY" "$prefix" -- firebase deploy --only "$targets"
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
if [ "$DRY_RUN" = "1" ]; then
  ylw "DRY_RUN=1: every firebase command below will be PRINTED, not run."
fi

confirm "Release this commit to production (auntieos-ttpc)?"
fi  # end of the guards skipped under RELEASE_PREFLIGHT_ONLY

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
HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short HEAD)"

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
ANDROID_DIR="$ROOT/auntieos-admin/android"
ANDROID_APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
ANDROID_BUILT=0
# Tracked separately from ANDROID_BUILT: an APK that assembled but failed to
# upload (see the non-fatal warning in 6b) shipped nothing, and the closing
# tag must say so rather than claim every client landed.
ANDROID_DISTRIBUTED=0

STEP="assembling the Android release APK"
if [ "${RELEASE_SKIP_ANDROID:-0}" = "1" ]; then
  ylw "SKIPPED (RELEASE_SKIP_ANDROID=1). The web ships without the Android"
  ylw "  client, which is the drift that put Android 200 versionCodes behind."
elif [ "$PREFLIGHT_ONLY" = "1" ]; then
  ylw "SKIPPED (preflight only)."
elif [ ! -d "$ANDROID_DIR" ]; then
  ylw "SKIPPED: no $ANDROID_DIR on this machine."
else
  if [ "$DRY_RUN" = "1" ]; then
    ylw "DRY_RUN=1: would delete any stale APK and run ./gradlew :app:assembleRelease"
  else
    # The rm lives INSIDE this branch, not above the if. A rehearsal that
    # assembles nothing but deletes the signed APK a real run left on disk has
    # changed the machine to prove nothing, and 6b's retry line would then point
    # at a file that is gone. rm only where a build replaces what it removed.
    rm -f "$ANDROID_APK"
    # Fails at execution time, naming the missing piece, when the keystore or
    # the Mapbox token is absent. Refuse the release rather than ship a web
    # half: a partial release is how the two clients diverged in the first
    # place.
    ( cd "$ANDROID_DIR" && ./gradlew :app:assembleRelease --no-daemon ) || {
      red "REFUSED: the Android release APK did not build."
      red "  Nothing has been deployed yet, which is why this step runs here."
      red "  Release signing needs KEYSTORE_PATH, KEYSTORE_PASSWORD, KEY_ALIAS"
      red "  and KEY_PASSWORD in auntieos-admin/android/local.properties, and"
      red "  MAPBOX_DOWNLOADS_TOKEN in ~/.gradle/gradle.properties."
      red "  To ship the web alone anyway: RELEASE_SKIP_ANDROID=1."
      exit 1
    }
    [ -f "$ANDROID_APK" ] || {
      red "REFUSED: gradle succeeded but $ANDROID_APK is not there."
      exit 1
    }
    ANDROID_BUILT=1
    grn "android: assembled $(basename "$ANDROID_APK") ($(du -h "$ANDROID_APK" | cut -f1))"
  fi
fi

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
STEP="resolving the Android distribution audience"
ANDROID_GROUPS="${RELEASE_ANDROID_GROUPS:-}"
ANDROID_TESTERS="${RELEASE_ANDROID_TESTERS:-}"
if [ "$ANDROID_BUILT" = "1" ] && [ -z "$ANDROID_GROUPS" ] && [ -z "$ANDROID_TESTERS" ]; then
  # Nothing configured, so fall back to every tester on the project. For an
  # internal tool that IS the audience, and it keeps the roster in the Firebase
  # console instead of hardcoded here where it would rot.
  ANDROID_TESTERS="$(
    firebase appdistribution:testers:list --project "$PROJECT" --json 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=(JSON.parse(s).result||{}).testers||[];console.log(t.map(x=>String(x.name).split("/").pop()).filter(Boolean).join(","))}catch(e){console.log("")}})'
  )"
  # awk NF rather than `tr , newline | wc -l`: with no trailing newline wc
  # counts separators, so one tester reports as 0 and two report as 1.
  [ -n "$ANDROID_TESTERS" ] && ylw "android: no audience configured; using all $(printf '%s' "$ANDROID_TESTERS" | awk -F, '{print NF}') project tester(s)."
fi
if [ "$ANDROID_BUILT" = "1" ] && [ -z "$ANDROID_GROUPS" ] && [ -z "$ANDROID_TESTERS" ]; then
  red "REFUSED: the Android build has nobody to go to."
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
if [ "$DRY_RUN" = "1" ]; then
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
if [ "$FUNCTIONS_CHANGED" -eq 0 ]; then
  STEP="checking whether a declared secret changed since the last release"
  SINCE="$(TZ=UTC git show -s --format=%cd --date=iso-strict-local "$LAST_RELEASED" 2>/dev/null || true)"
  SINCE_N="$(printf '%s' "$SINCE" | tr -d ':-' | cut -c1-15)"
  SECRET_DECLARED="$(node "$ROOT/scripts/declared-secrets.js" 2>/dev/null || true)"
  NEWER_SECRETS=""
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

if [ "$FUNCTIONS_CHANGED" -eq 0 ]; then
  ylw "SKIPPED: mytribe/functions is unchanged since the last release"
  ylw "  ($(git rev-parse --short "$LAST_RELEASED")). The deployed functions are"
  ylw "  already this code. Redeploying would mint ~200 Cloud Run revisions and"
  ylw "  burn regional CPU quota to change nothing."
  ylw "  Force with RELEASE_FORCE_FUNCTIONS=1."
else
  # THE AUTOMATIC PRE-DEPLOY PRUNE IS GONE. Read this before re-adding it,
  # because the reasoning that put it here was measured, confident and wrong.
  #
  # Three deploys died mid-run on "Quota exceeded for total allowable CPU per
  # project per region" (2026-07-26, and twice on 2026-07-28), each leaving
  # ~20 functions on their previous revision. The diagnosis was that Cloud Run
  # revisions accumulate and each holds CPU, so this step pruned to 2 per
  # service to make room. The arithmetic was stated as measured rather than
  # modelled: a wall near 900 revisions, keep-2 leaving a floor of 460 plus
  # ~217 minted.
  #
  # On 2026-07-28 that prune ran, landed within one revision of its prediction
  # (676 against a predicted 677), and the deploy failed anyway with the same
  # 20 functions. Three measurements say why the model was wrong:
  #
  #   - run.googleapis.com/active_revisions reported usage 230 against 230
  #     services, one apiece, while 676 revisions existed. Idle revisions are
  #     not counted, so deleting them frees nothing that was being counted.
  #   - 36 revisions pin min-instances=1; the other 640 scale to zero. At rest
  #     the project holds ~36 CPU, nowhere near a ceiling.
  #   - the casualties are always the deploy's last concurrent batch (crons,
  #     triggers, sweeps), and redeploying those same names as a batch of 20
  #     succeeds minutes later with no quota change in between.
  #
  # That points at concurrent container starts during a bulk deploy rather
  # than at revision inventory. Be careful how much of that to believe: what
  # is PROVEN is only that the prune was insufficient and that the resource it
  # reclaims is not the one being counted. The mechanism is inference.
  #
  # But the cost was never in doubt. The prune spent ~250 revisions of
  # rollback depth immediately before the riskiest step in the release, to buy
  # headroom there is no evidence it bought. Step 8 still prunes for
  # retention, after verification, where spending that depth is safe.
  #
  # THE OBVIOUS OBJECTION: step 8 runs after this step, so it cannot help the
  # deploy standing here. True of this run, and it is the whole reason the
  # question keeps coming back. It is answered ACROSS runs, not within one: a
  # step 8 whose keep actually fires (3, since 2026-08-01; 10 could not delete
  # a single revision at 926) leaves the inventory at its floor every release,
  # so the next release starts from ~714 rather than from 926 and climbing.
  # That is the only way an after-the-fact sweep helps a deploy that precedes
  # it, and it is enough, because the headroom a pre-deploy prune would buy has
  # been measured and was not there. The durable fix remains a quota increase:
  # Cloud Run Admin API, "Total CPU allocation, per project per region".
  #
  # Setting RELEASE_PREDEPLOY_KEEP=N restores the old behaviour for one run.
  # It is opt-in because it is unproven, not because it is dangerous.
  STEP="reclaiming Cloud Run quota before the functions deploy"
  if [ -n "${RELEASE_PREDEPLOY_KEEP:-}" ] && [ "$DRY_RUN" != "1" ]; then
    ylw "RELEASE_PREDEPLOY_KEEP=$RELEASE_PREDEPLOY_KEEP: pruning before the deploy."
    ylw "  Opt-in and unproven (see the comment above). This spends rollback"
    ylw "  depth to buy headroom that may not exist."
    bash "$ROOT/scripts/prune-run-revisions.sh" "$RELEASE_PREDEPLOY_KEEP" || {
      # Deploy anyway. A prune that could not run is not proof the quota is
      # short, and refusing to ship on a housekeeping failure is worse than
      # trying. If the quota really is short, the deploy says so plainly.
      ylw "pre-deploy prune reported problems (see above). Deploying anyway;"
      ylw "  if the CPU quota is exhausted the functions step will say so."
    }
  fi

  STEP="deploying the mytribe functions codebase"
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
# 6b. The third client, shipped in the same run as the other two.
# ---------------------------------------------------------------------------
banner "6b. Android"

# App Distribution is the channel: the operator admin is an internal tool with
# named testers. The tester list is managed in the Firebase console; this
# uploads to whoever is already on it.
#
# The release note carries the commit, so a tester's build always names the
# code it came from. versionName already embeds the short SHA (build.gradle.kts
# builds it from gitShortSha), so the APK is self-identifying even off-console.
STEP="distributing the Android release"
if [ "$ANDROID_BUILT" != "1" ]; then
  ylw "SKIPPED: no APK was assembled in step 1c."
else
  ANDROID_APP_ID="${RELEASE_ANDROID_APP_ID:-1:153396971788:android:6bcb7c5411aeda837f2129}"
  ANDROID_NOTES="$(git log -1 --format='%h %s')"

  # The audience was resolved and proven non-empty in 1c. Passing it is what
  # turns an upload into a distribution: without one of these two flags the
  # CLI warns and exits 0, having shipped to nobody.
  ANDROID_AUDIENCE_ARGS=()
  ANDROID_AUDIENCE_DESC=""
  if [ -n "$ANDROID_GROUPS" ]; then
    ANDROID_AUDIENCE_ARGS+=(--groups "$ANDROID_GROUPS")
    ANDROID_AUDIENCE_DESC="groups $ANDROID_GROUPS"
  fi
  if [ -n "$ANDROID_TESTERS" ]; then
    ANDROID_AUDIENCE_ARGS+=(--testers "$ANDROID_TESTERS")
    ANDROID_AUDIENCE_DESC="${ANDROID_AUDIENCE_DESC:+$ANDROID_AUDIENCE_DESC, }$(printf '%s' "$ANDROID_TESTERS" | awk -F, '{print NF}') tester(s)"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    ylw "DRY_RUN=1: would upload $ANDROID_APK to $ANDROID_AUDIENCE_DESC"
  else
    cyan "android: distributing to $ANDROID_AUDIENCE_DESC"
    if firebase appdistribution:distribute "$ANDROID_APK" \
      --app "$ANDROID_APP_ID" \
      --project "$PROJECT" \
      --release-notes "$ANDROID_NOTES" \
      "${ANDROID_AUDIENCE_ARGS[@]}"; then
      grn "android: distributed to $ANDROID_AUDIENCE_DESC"
      ANDROID_DISTRIBUTED=1
    else
      # The APK is built and signed on disk either way. Failing the release
      # here would report a landed web deploy as broken; saying nothing would
      # recreate the silent drift. So: loud, non-fatal, with the retry, and
      # the retry carries the audience because that is the part forgotten.
      ylw "android: distribution FAILED. The signed APK is still at:"
      ylw "  $ANDROID_APK"
      ylw "  Retry with:"
      ylw "  firebase appdistribution:distribute '$ANDROID_APK' \\"
      ylw "    --app $ANDROID_APP_ID --project $PROJECT \\"
      ylw "    --release-notes '$ANDROID_NOTES' ${ANDROID_AUDIENCE_ARGS[*]}"
    fi
  fi
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
  ylw "DRY_RUN=1: NOT writing .release-state. It records what is DEPLOYED, and"
  ylw "  this run deployed nothing. Writing it would make the next real release"
  ylw "  skip the functions deploy for code that never shipped."
else
  git rev-parse HEAD > "$ROOT/.release-state"
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
  TAG="release/$(date +%Y.%m.%d)-$(git rev-parse --short HEAD)"

  # Named honestly from the same state the run already tracked, not a
  # blanket "shipped everything": a skipped or failed piece says so here too.
  SHIPPED="hosting: admin + kinfolk portal
firestore: indexes + rules (mytribe)"
  if [ "$FUNCTIONS_CHANGED" -eq 1 ]; then
    SHIPPED="$SHIPPED
functions: mytribe"
  else
    SHIPPED="$SHIPPED
functions: mytribe (skipped, unchanged since the last release)"
  fi
  if [ "${RELEASE_INCLUDE_ADMIN_FUNCTIONS:-0}" = "1" ]; then
    SHIPPED="$SHIPPED
functions: auntieos-admin (default, reconcile)"
  fi
  if [ "$ANDROID_DISTRIBUTED" -eq 1 ]; then
    SHIPPED="$SHIPPED
android: distributed ($ANDROID_AUDIENCE_DESC)"
  elif [ "$ANDROID_BUILT" -eq 1 ]; then
    SHIPPED="$SHIPPED
android: built, distribution did not confirm (see 6b above)"
  else
    SHIPPED="$SHIPPED
android: skipped"
  fi

  TAG_MSG="$(git log -1 --format='%h %s')

Shipped:
$SHIPPED"

  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    ylw "tag: $TAG already exists locally; not recreating it."
  elif ! git tag -a "$TAG" -m "$TAG_MSG"; then
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

trap - EXIT
STEP="done"

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
  ylw "  $(git rev-parse --short HEAD) is not live as a result of this run, and"
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
grn "Commit $(git rev-parse --short HEAD) is live and verified."
if [ "$TAG_PUSHED" -eq 1 ]; then
  grn "Tagged $TAG and pushed it to origin."
fi
grn ""
grn "If something looks wrong, the previous hosting release can be rolled back"
grn "from the Firebase console (Hosting -> release history). Functions and"
grn "indexes do NOT roll back with it; they need their own revert and redeploy."
