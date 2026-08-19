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
    elif [ "$t" -le 0 ] || [ "$t" -gt "$MAX_ALLOWED" ]; then
      bad "$name: job '$job' has timeout-minutes $t, outside 1..$MAX_ALLOWED"
    else
      ok "$name: $job is capped at ${t}m"
    fi
  done <<EOF
$(job_timeouts "$f")
EOF

  if [ "$found" -eq 0 ]; then
    bad "$name: found no jobs at all, so this test proved nothing about it"
  fi
done

echo
echo "--- the e2e job, the known offender, also caps the step itself"
# A JOB timeout tears the run down and skips the `if: failure()` artifact
# upload, so the traces that would explain the hang are never collected. A STEP
# timeout fails like any other failing step and the upload still runs. #456 asks
# for evidence, so the step cap is the load-bearing one.
if awk '
    /^  admin-e2e:/ { in_job = 1 }
    in_job && /^      - name: E2E$/ { in_step = 1; next }
    in_step && /^        timeout-minutes: [0-9]+$/ { found = 1 }
    in_step && /^      - / { in_step = 0 }
    END { exit(found ? 0 : 1) }
  ' "$WORKFLOWS/ci.yml"; then
  ok "ci.yml: the E2E step has its own timeout-minutes"
else
  bad "ci.yml: the E2E step lost its timeout-minutes, so a hang there kills the job before the artifacts upload"
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
