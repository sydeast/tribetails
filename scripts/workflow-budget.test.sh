#!/usr/bin/env bash
# Tests for the runner-minute guarantees in .github/workflows/. Run:
#   bash scripts/workflow-budget.test.sh
#
# WHY THIS EXISTS
# Issue #456: the `React admin e2e` job sat `in_progress` for over 45 minutes on
# a main run and over four hours on a pull request run, against a 3-to-6 minute
# norm. Nothing stopped it, because GitHub's default `timeout-minutes` is 360
# and no job in either workflow file set one. A single four-hour hang is around
# 270 runner-minutes spent learning nothing.
#
# A timeout on every job is a one-line fix that decays silently: the next job
# somebody adds inherits the six-hour default again, and nothing says so. So the
# guarantee is asserted here rather than only written down.
#
# The second assertion is about the concurrency group, and it is the less
# obvious one. scripts/release.sh gates a release on the check runs for the
# commit it is shipping, and `ci_verdict` there treats `success|skipped|neutral`
# as a pass and everything else, `cancelled` included, as a fail. So any
# arrangement that lets one push to main cancel another push to main hands the
# release gate a verdict it refuses, and the merge has to be re-run. Sharing a
# concurrency group across main's runs does that even with
# `cancel-in-progress: false`, because a group holds one running plus one
# pending run and drops the pending one when a third arrives. Keying pushes by
# `github.run_id` is what makes each one its own group. This test fails if that
# key goes away.
#
# The YAML is read line by line rather than with a parser, deliberately: this
# has to run on a bare runner with no pip install, and the two properties it
# checks live at fixed indentation in a file whose shape is stable.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKFLOWS="$ROOT/.github/workflows"

PASS=0
FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# The ceiling above which a timeout stops being a timeout. Every job in this
# repo is measured in single-digit minutes; the largest deliberate ceiling is
# the dispatch-only Kotlin job at 30. Anything past this is either a mistake or
# a decision that should be argued for in the file and then raised here.
MAX_ALLOWED=60

# ---------------------------------------------------------------------------
# job_ceiling <workflow file> <job>: the ceiling that job is held to.
#
# This is the "and then raised here" half of the sentence above, and it is a
# named list rather than a raised MAX_ALLOWED because a job in it is still
# capped: it is checked against the number beside it, so a nightly release that
# grows a second hour still fails this test. Everything not named keeps the
# single-digit-minutes ceiling the rest of the repo lives under.
#
# Adding an entry means writing the argument in the workflow file first. The
# one entry here:
#
#   nightly-release.yml / release   A release deploys ~280 functions in batches
#                                   of 25 with a 30 second settle between them,
#                                   because of the Cloud Run quota wall this
#                                   project has already hit. That is roughly an
#                                   hour before hosting and Android are touched,
#                                   and nightly-release.yml argues its 180 in a
#                                   comment on the line itself. MAX_ALLOWED is
#                                   here to catch a ceiling nobody chose; this
#                                   one was chosen.
#
# Without this the guard failed every pull request that touched the `scripts`
# filter from the day nightly-release.yml merged, which is how it was found: two
# dependabot action bumps went red on a test whose own subject they never
# touched.
# ---------------------------------------------------------------------------
job_ceiling() {
  case "$1 $2" in
    'nightly-release.yml release') echo 180 ;;
    *)                             echo "$MAX_ALLOWED" ;;
  esac
}

# ---------------------------------------------------------------------------
# job_timeouts <file>: one "job<TAB>timeout" line per job, timeout empty if the
# job declares none.
#
# Job keys are the two-space-indented mapping keys under a top-level `jobs:`,
# and a job's own settings are the four-space-indented keys beneath it. Lines
# inside a block scalar (the paths-filter `filters: |` blob) are indented far
# deeper than four spaces, so they cannot be mistaken for either.
# ---------------------------------------------------------------------------
job_timeouts() {
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; next }
    /^[^[:space:]#]/      { if (in_jobs) { flush(); in_jobs = 0 } }
    !in_jobs              { next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      flush()
      job = $1
      sub(/:$/, "", job)
      t = ""
      next
    }
    /^    timeout-minutes:[[:space:]]/ {
      if (job != "") { t = $2 }
      next
    }
    END { flush() }
    function flush() { if (job != "") { printf "%s\t%s\n", job, t; job = "" } }
  ' "$1"
}

echo "--- every job carries a timeout-minutes"
for f in "$WORKFLOWS"/*.yml; do
  name="$(basename "$f")"
  found=0
  while IFS="$(printf '\t')" read -r job t; do
    [ -n "$job" ] || continue
    found=$((found+1))
    if [ -z "$t" ]; then
      bad "$name: job '$job' has no timeout-minutes, so it inherits GitHub's 360"
    elif ! printf '%s' "$t" | grep -Eq '^[0-9]+$'; then
      bad "$name: job '$job' has a non-numeric timeout-minutes '$t'"
    else
      ceiling="$(job_ceiling "$name" "$job")"
      if [ "$t" -le 0 ] || [ "$t" -gt "$ceiling" ]; then
        bad "$name: job '$job' has timeout-minutes $t, outside 1..$ceiling"
      elif [ "$ceiling" != "$MAX_ALLOWED" ]; then
        # Say the exception out loud. A named ceiling that silently stopped
        # being applied would read exactly like one that still was.
        ok "$name: $job is capped at ${t}m, against its own ${ceiling}m ceiling"
      else
        ok "$name: $job is capped at ${t}m"
      fi
    fi
  done <<EOF
$(job_timeouts "$f")
EOF

  if [ "$found" -eq 0 ]; then
    bad "$name: found no jobs at all, so this test proved nothing about it"
  fi
done

echo
echo "--- the e2e job, the known offender, also caps the steps that can stall"
# A JOB timeout tears the run down and skips the `if: failure()` artifact
# upload, so the traces that would explain the hang are never collected. A STEP
# timeout fails like any other failing step and the upload still runs. #456 asks
# for evidence, so the step caps are the load-bearing ones.
#
# `Install Chromium` is here because that is where #456 actually hung, three
# times, for six hours, four hours and forty-five minutes: `--with-deps` runs
# apt-get against the runner's Ubuntu mirror and neither had a deadline. The
# first version of this test only checked the E2E step, which was never the one
# that stalled.
step_has_timeout() {
  awk -v want="      - name: $2" '
    /^  admin-e2e:/ { in_job = 1 }
    in_job && $0 == want { in_step = 1; next }
    in_step && /^        timeout-minutes: [0-9]+$/ { found = 1 }
    in_step && /^      - / { in_step = 0 }
    END { exit(found ? 0 : 1) }
  ' "$1"
}

for step in "Install Chromium" "E2E"; do
  if step_has_timeout "$WORKFLOWS/ci.yml" "$step"; then
    ok "ci.yml: the '$step' step has its own timeout-minutes"
  else
    bad "ci.yml: the '$step' step has no timeout-minutes, so a stall there parks until the job cap and loses the artifacts"
  fi
done

echo
echo "--- every browser install carries its own deadline and says what stalled"
# A step `timeout-minutes` bounds the cost but prints only "The operation was
# canceled", which is what made three parked runs indistinguishable from a hung
# test. Wrapping the install in `timeout` gives exit 124, and the step turns
# that into a message naming apt and the mirror. Comment lines and `echo` lines
# are skipped: this file quotes the offending command in both.
UNGUARDED=0
while IFS= read -r line; do
  stripped="${line#"${line%%[![:space:]]*}"}"
  case "$stripped" in
    '#'*|'echo '*) continue ;;
  esac
  case "$stripped" in
    *'playwright install'*)
      case "$stripped" in
        *'timeout '*) ;;
        *)
          bad "ci.yml: a playwright install runs with no timeout wrapper: $stripped"
          UNGUARDED=$((UNGUARDED+1))
          ;;
      esac
      ;;
  esac
done < "$WORKFLOWS/ci.yml"
if [ "$UNGUARDED" -eq 0 ]; then
  ok "ci.yml: every playwright install is wrapped in timeout, so a stalled mirror fails with a named error"
fi

echo
echo "--- the e2e step caps fire before the job cap, not after"
# The step caps only produce evidence if one of them wins the race. If the sum
# of the step caps plus the uncapped setup can reach the job cap, the job cap
# fires first, the run is torn down, and the artifact upload never happens. The
# uncapped parts of this job (checkout, setup-node, setup-java, npm ci,
# firebase-tools, the upload and the post steps) have measured at about two
# minutes at their combined worst, so that is the headroom demanded here.
E2E_HEADROOM=2
read -r JOB_CAP STEP_CAP_SUM <<EOF
$(awk '
  /^[^[:space:]#]/                       { in_job = 0 }
  /^  [A-Za-z0-9_-]+:[[:space:]]*$/      { in_job = ($1 == "admin-e2e:") }
  in_job && /^    timeout-minutes:[[:space:]]/   { job = $2 }
  in_job && /^        timeout-minutes:[[:space:]]/ { steps += $2 }
  END { printf "%s %s\n", (job == "" ? 0 : job), steps + 0 }
' "$WORKFLOWS/ci.yml")
EOF
if [ "$JOB_CAP" -eq 0 ] || [ "$STEP_CAP_SUM" -eq 0 ]; then
  bad "ci.yml: could not read admin-e2e's caps (job '$JOB_CAP', steps '$STEP_CAP_SUM'), so this proved nothing"
elif [ "$JOB_CAP" -ge "$((STEP_CAP_SUM + E2E_HEADROOM))" ]; then
  ok "ci.yml: admin-e2e is capped at ${JOB_CAP}m against ${STEP_CAP_SUM}m of step caps, so a step cap fires first"
else
  bad "ci.yml: admin-e2e is capped at ${JOB_CAP}m but its steps can take ${STEP_CAP_SUM}m plus about ${E2E_HEADROOM}m of setup"
  bad "  The job cap would fire first, tear the run down, and skip the artifact upload."
  bad "  Raise timeout-minutes on the job, and redo the arithmetic in the comment above it."
fi

echo
echo "--- pushes to main are never cancelled by another push to main"
GROUP="$(grep -E '^  group:' "$WORKFLOWS/ci.yml" | head -1)"
if printf '%s' "$GROUP" | grep -q 'github.run_id'; then
  ok "ci.yml: non-pull-request runs are keyed by run_id, so each gets its own group"
else
  bad "ci.yml: the concurrency group no longer keys pushes by github.run_id"
  bad "  A shared group cancels main's runs, and scripts/release.sh reads"
  bad "  'cancelled' as a failing verdict and refuses to release that commit."
  printf '  group line: %s\n' "$GROUP"
fi

CANCEL="$(grep -E '^  cancel-in-progress:' "$WORKFLOWS/ci.yml" | head -1)"
if printf '%s' "$CANCEL" | grep -q "github.event_name == 'pull_request'"; then
  ok "ci.yml: cancel-in-progress is limited to pull requests"
else
  bad "ci.yml: cancel-in-progress is no longer limited to pull requests"
  printf '  line: %s\n' "$CANCEL"
fi

echo
echo "workflow budget tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
