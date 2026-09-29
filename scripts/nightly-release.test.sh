#!/usr/bin/env bash
# Tests for .github/workflows/nightly-release.yml. Run:
#   bash scripts/nightly-release.test.sh
#
# WHY THIS EXISTS
# The nightly release cannot be run anywhere but GitHub, and it cannot be run
# there at all until the operator has created the Workload Identity pool and
# the repository secrets (#851). So the properties that make it safe have to be
# checked from the file itself, and each one here is a mistake that has either
# already happened on this workflow or was named in a review of it:
#
#   - the auth step must come BEFORE "Check the runner can authenticate". That
#     check looks for the credentials file the auth step writes, so the other
#     order refuses every run (#850 review).
#   - GH_TOKEN must be set on the JOB, not only on the release step, or the
#     same check cannot see it (#850 review).
#   - `off` must stay a no-op. Every step but checkout, the mode decision, the
#     cleanup and the summary carries a mode condition.
#   - everything the restore step writes (keystores, local.properties,
#     gradle.properties) is deleted by an always() step.
#   - the provider and service account come from repository variables, never a
#     project number written into the file.
#   - the Python the workflow installs is the runtime firebase.json deploys the
#     reconcile codebase on. A mismatch is the 2026-08-05 release failure.
#   - every secret and variable the workflow reads has a `gh secret set` or
#     `gh variable set` line in the runbook, and none of the operator's commands
#     there contains a `!`, which interactive zsh turns into history expansion.
#
# The YAML is read line by line rather than with a parser, for the reason
# workflow-budget.test.sh gives: this runs on a bare runner with no pip install,
# and the properties live at fixed indentation in a file whose shape is stable.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WF="$ROOT/.github/workflows/nightly-release.yml"
INTERNALS="$ROOT/docs/runbooks/release-internals.md"
RUNBOOK="$ROOT/docs/RUNBOOK.md"
PYCFG="$ROOT/auntieos-admin/web/firebase.json"

PASS=0
FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

if [ ! -f "$WF" ]; then
  bad "no $WF, so nothing here was checked"
  echo
  echo "nightly release tests: $PASS passed, $FAIL failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# steps: one "index<TAB>label<TAB>if" line per step of the release job, in
# order. label is the step's name, or its `uses:` when it has none. Steps are
# the six-space `- ` items under the job's `steps:`; their keys are at eight.
# ---------------------------------------------------------------------------
steps() {
  awk '
    /^    steps:[[:space:]]*$/ { in_steps = 1; next }
    in_steps && /^    [^ ]/    { in_steps = 0 }
    !in_steps                  { next }
    /^      - / {
      flush()
      n++; label = ""; cond = ""
      line = $0
      sub(/^      - /, "        ", line)
      take(line)
      next
    }
    /^        [a-z-]+:/ { take($0) }
    END { flush() }
    function take(l,   v) {
      if (l ~ /^        name:/) { v = l; sub(/^        name:[[:space:]]*/, "", v); label = v }
      else if (l ~ /^        uses:/ && label == "") { v = l; sub(/^        uses:[[:space:]]*/, "", v); label = v }
      else if (l ~ /^        if:/) { v = l; sub(/^        if:[[:space:]]*/, "", v); cond = v }
    }
    function flush() { if (n > 0 && label != "") printf "%d\t%s\t%s\n", n, label, cond; label = "" }
  ' "$WF"
}
STEPS="$(steps)"

# step_index <label prefix>: the index of the first step whose label starts
# with it, or empty.
step_index() {
  printf '%s\n' "$STEPS" | awk -F'\t' -v want="$1" 'index($2, want) == 1 { print $1; exit }'
}

echo "--- the job and its steps could be read"
COUNT="$(printf '%s\n' "$STEPS" | awk 'NF { n++ } END { print n + 0 }')"
if [ "$COUNT" -ge 10 ]; then
  ok "read $COUNT steps from the release job"
else
  bad "read only $COUNT steps from the release job, so the checks below prove nothing"
  printf '%s\n' "$STEPS"
fi

echo
echo "--- Google Cloud auth runs before the credential check (#850 review)"
AUTH="$(step_index 'Authenticate to Google Cloud')"
GCLOUD="$(step_index 'Set up gcloud')"
CHECK="$(step_index 'Check the runner can authenticate')"
if [ -n "$AUTH" ] && [ -n "$CHECK" ] && [ "$AUTH" -lt "$CHECK" ]; then
  ok "the auth step ($AUTH) precedes the credential check ($CHECK)"
else
  bad "the auth step (${AUTH:-missing}) does not precede the credential check (${CHECK:-missing})"
fi
if [ -n "$GCLOUD" ] && [ -n "$AUTH" ] && [ -n "$CHECK" ] && [ "$GCLOUD" -gt "$AUTH" ] && [ "$GCLOUD" -lt "$CHECK" ]; then
  ok "setup-gcloud ($GCLOUD) runs after auth and before the check"
else
  bad "setup-gcloud (${GCLOUD:-missing}) is not between auth and the credential check"
fi
if grep -Eq '^        uses: google-github-actions/auth@v[0-9]+' "$WF" &&
   grep -Eq '^        uses: google-github-actions/setup-gcloud@v[0-9]+' "$WF"; then
  ok "auth and setup-gcloud are pinned to a major version, like every other action here"
else
  bad "google-github-actions/auth or setup-gcloud is missing or not pinned to a major"
fi

echo
echo "--- the provider and service account come from repository variables"
if grep -Eq '^          workload_identity_provider: \$\{\{ vars\.NIGHTLY_WIF_PROVIDER \}\}$' "$WF" &&
   grep -Eq '^          service_account: \$\{\{ vars\.NIGHTLY_SERVICE_ACCOUNT \}\}$' "$WF"; then
  ok "the auth step reads vars.NIGHTLY_WIF_PROVIDER and vars.NIGHTLY_SERVICE_ACCOUNT"
else
  bad "the auth step does not take its provider and account from the two repository variables"
fi
if grep -Eq 'projects/[0-9]+/' "$WF"; then
  bad "a project number is written into the workflow: $(grep -En 'projects/[0-9]+/' "$WF" | head -1)"
else
  ok "no project number is hardcoded in the workflow"
fi
VARS_CHECK="$(step_index 'Check the release variables are set')"
if [ -n "$VARS_CHECK" ] && [ -n "$AUTH" ] && [ "$VARS_CHECK" -lt "$AUTH" ]; then
  ok "a missing variable is named before the auth step runs"
else
  bad "no 'Check the release variables are set' step before auth"
fi

echo
echo "--- GH_TOKEN is on the job, and gh is asked about github.com only"
JOB_ENV_TOKEN="$(awk '
  /^  release:/ { in_job = 1; next }
  in_job && /^  [^ ]/ { in_job = 0 }
  in_job && /^    env:[[:space:]]*$/ { in_env = 1; next }
  in_env && /^    [^ ]/ { in_env = 0 }
  in_env && /^      GH_TOKEN: \$\{\{ github\.token \}\}[[:space:]]*$/ { found = 1 }
  END { print found + 0 }
' "$WF")"
if [ "$JOB_ENV_TOKEN" = "1" ]; then
  ok "GH_TOKEN is set from github.token in the job-level env"
else
  bad "GH_TOKEN is not in the release job's own env block"
fi
if grep -q 'gh auth status --hostname github.com' "$WF"; then
  ok "the workflow checks gh with --hostname github.com"
else
  bad "the workflow never runs 'gh auth status --hostname github.com'"
fi

echo
echo "--- permissions"
for perm in 'contents: write' 'id-token: write' 'actions: read' 'checks: read' 'pull-requests: read'; do
  if awk -v want="      $perm" '
      /^    permissions:[[:space:]]*$/ { in_p = 1; next }
      in_p && !/^      / { in_p = 0 }
      in_p && $0 == want { found = 1 }
      END { exit(found ? 0 : 1) }
    ' "$WF"; then
    ok "the job grants $perm"
  else
    bad "the job does not grant $perm"
  fi
done

echo
echo "--- off stays a no-op"
# The only steps allowed to run with mode=off.
UNGATED_OK='actions/checkout@|Decide what this run does|Delete the restored signing material|Summary'
UNGATED_BAD=""
while IFS="$(printf '\t')" read -r idx label cond; do
  [ -n "$idx" ] || continue
  if printf '%s' "$label" | grep -Eq "^($UNGATED_OK)"; then
    continue
  fi
  case "$cond" in
    *"steps.decide.outputs.mode != 'off'"*|*"steps.decide.outputs.mode == 'preflight'"*|*"steps.decide.outputs.mode == 'full'"*) ;;
    *) UNGATED_BAD="$UNGATED_BAD
    step $idx '$label' (if: ${cond:-none})" ;;
  esac
done <<EOF
$STEPS
EOF
if [ -z "$UNGATED_BAD" ]; then
  ok "every step but checkout, decide, cleanup and summary is gated on the mode"
else
  bad "these steps would run with NIGHTLY_RELEASE off:$UNGATED_BAD"
fi
if grep -q '\*) mode="off" ;;' "$WF"; then
  ok "an unset or unknown NIGHTLY_RELEASE decides mode=off"
else
  bad "the mode decision no longer defaults to off"
fi

echo
echo "--- restored material is deleted in an always() step, after the release"
CLEAN="$(step_index 'Delete the restored signing material')"
CLEAN_IF="$(printf '%s\n' "$STEPS" | awk -F'\t' -v i="${CLEAN:-0}" '$1 == i { print $3 }')"
RELEASE_IDX="$(step_index 'Release to production')"
RESTORE="$(step_index 'Restore the Android signing material')"
if [ -n "$CLEAN" ] && [ "$CLEAN_IF" = "always()" ]; then
  ok "the cleanup step runs if: always()"
else
  bad "no cleanup step with if: always() (found '${CLEAN_IF:-none}')"
fi
if [ -n "$CLEAN" ] && [ -n "$RELEASE_IDX" ] && [ "$CLEAN" -gt "$RELEASE_IDX" ]; then
  ok "the cleanup step comes after the release step"
else
  bad "the cleanup step does not come after the release step"
fi
if [ -n "$RESTORE" ] && [ -n "$CHECK" ] && [ "$RESTORE" -gt "$CHECK" ]; then
  ok "signing material is restored only after the credential check"
else
  bad "the restore step (${RESTORE:-missing}) is not after the credential check"
fi
# The body of the cleanup step, for the paths it must remove.
CLEAN_BODY="$(awk '
  /^      - name: Delete the restored signing material/ { on = 1; next }
  on && /^      - / { on = 0 }
  on { print }
' "$WF")"
for path in 'auntieos-release.keystore' 'auntieos-admin/android/local.properties' \
            'mytribe/local.properties' '.android/debug.keystore' 'gradle.properties' 'gha-creds-'; do
  if printf '%s' "$CLEAN_BODY" | grep -qF "$path"; then
    ok "cleanup removes $path"
  else
    bad "cleanup does not remove $path"
  fi
done
# Everything the restore step writes must be something cleanup removes.
RESTORE_BODY="$(awk '
  /^      - name: Restore the Android signing material/ { on = 1; next }
  on && /^      - / { on = 0 }
  on { print }
' "$WF")"
for path in 'auntieos-release.keystore' 'auntieos-admin/android/local.properties' \
            'mytribe/local.properties' '.android/debug.keystore' 'gradle.properties'; do
  if printf '%s' "$RESTORE_BODY" | grep -qF "$path"; then
    ok "the restore step writes $path (and cleanup removes it)"
  else
    bad "the restore step no longer writes $path, so this test and the cleanup are out of date"
  fi
done
if printf '%s' "$RESTORE_BODY" | grep -q 'RUNNER_TEMP/auntieos-release.keystore'; then
  ok "the release keystore is written to RUNNER_TEMP, outside the checkout"
else
  bad "the release keystore is not written under RUNNER_TEMP"
fi

echo
echo "--- the reconcile venv uses the runtime firebase.json deploys"
PYRUNTIME="$(sed -n 's/.*"runtime":[[:space:]]*"python\([0-9]\)\([0-9][0-9]*\)".*/\1.\2/p' "$PYCFG" | head -1)"
WFPY="$(sed -n "s/^          python-version: '\([0-9.]*\)'.*/\1/p" "$WF" | head -1)"
if [ -n "$PYRUNTIME" ] && [ "$PYRUNTIME" = "$WFPY" ] && grep -q "python$PYRUNTIME -m venv venv" "$WF"; then
  ok "setup-python installs $WFPY and builds the venv with python$PYRUNTIME, matching firebase.json"
else
  bad "firebase.json deploys python '${PYRUNTIME:-?}' but the workflow installs '${WFPY:-?}'"
fi

echo
echo "--- every npm root release.sh checks is installed"
for root in 'npm ci$' 'npm ci --prefix mytribe/functions' 'npm ci --prefix auntieos-admin/web/functions' 'npm install -g firebase-tools@'; do
  if grep -Eq "^          $root" "$WF"; then
    ok "the install step runs: $root"
  else
    bad "the install step does not run: $root"
  fi
done

echo
echo "--- the release tag has an author"
TAGGER="$(step_index 'Name the release tagger')"
if [ -n "$TAGGER" ] && [ -n "$RELEASE_IDX" ] && [ "$TAGGER" -lt "$RELEASE_IDX" ] &&
   grep -q 'git config user.email' "$WF"; then
  ok "git user.name and user.email are set before release.sh's annotated tag"
else
  bad "no git identity before the release, so step 9's git tag -a fails and the next night re-ships"
fi

echo
echo "--- the runbook covers every secret and variable, with commands safe to paste"
SECTION="$(awk '
  /^## Hosted nightly release/ { on = 1; print; next }
  on && /^## / { on = 0 }
  on { print }
' "$INTERNALS" 2>/dev/null)"
if [ -n "$SECTION" ]; then
  ok "docs/runbooks/release-internals.md has a 'Hosted nightly release' section"
else
  bad "docs/runbooks/release-internals.md has no '## Hosted nightly release' section"
fi
for s in $(grep -o 'secrets\.[A-Z0-9_]*' "$WF" | sed 's/secrets\.//' | sort -u); do
  if printf '%s' "$SECTION" | grep -q "gh secret set $s "; then
    ok "the runbook sets secret $s"
  else
    bad "the workflow reads secrets.$s but the runbook has no 'gh secret set $s'"
  fi
done
for v in $(grep -o 'vars\.[A-Z0-9_]*' "$WF" | sed 's/vars\.//' | sort -u); do
  # CI_RUNNER is the repo-wide runner override, deleted by ruling
  # D-2026-09-11-NO-SELF-HOSTED-RUNNERS and deliberately never set.
  [ "$v" = "CI_RUNNER" ] && continue
  if printf '%s' "$SECTION" | grep -q "gh variable set $v "; then
    ok "the runbook sets variable $v"
  else
    bad "the workflow reads vars.$v but the runbook has no 'gh variable set $v'"
  fi
done
# The commands the operator pastes are the fenced blocks. A `!` in any of them
# is history expansion in interactive zsh.
BANG="$(printf '%s\n' "$SECTION" | awk '/^```/ { f = !f; next } f && /!/ { print NR": "$0 }')"
if [ -z "$BANG" ]; then
  ok "no command in the section contains a '!'"
else
  bad "commands in the section contain '!', which zsh expands:"
  printf '    %s\n' "$BANG"
fi

echo
echo "--- the RUNBOOK anchor the workflow links to still exists"
if grep -qx '### The nightly release stays off until it can authenticate' "$RUNBOOK" &&
   grep -q 'RUNBOOK.md#the-nightly-release-stays-off-until-it-can-authenticate' "$WF"; then
  ok "RUNBOOK.md keeps the heading the workflow's summary links to"
else
  bad "the RUNBOOK heading or the workflow's link to it changed"
fi
if grep -A20 -x '### The nightly release stays off until it can authenticate' "$RUNBOOK" | grep -q 'Hosted nightly release'; then
  ok "that RUNBOOK section points at 'Hosted nightly release'"
else
  bad "the RUNBOOK section does not point at the 'Hosted nightly release' setup"
fi

echo
echo "nightly release tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
