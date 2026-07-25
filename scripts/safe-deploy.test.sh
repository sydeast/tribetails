#!/usr/bin/env bash
# Tests for safe-deploy.sh. This is the one door production deploys go through,
# so a regression to its guards is a production-overwrite waiting to happen. Run:
#   bash scripts/safe-deploy.test.sh
#
# Every "allow" case runs under DRY_RUN=1, so no test ever triggers a real
# deploy. Every "refuse" case asserts a non-zero exit AND the expected reason.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/safe-deploy.sh"
PASS=0
FAIL=0

# expect_refuse <desc> <substring-of-reason> -- <args...>
expect_refuse() {
  local desc="$1" needle="$2"; shift 2
  [ "$1" = "--" ] && shift
  local out rc
  out="$(DRY_RUN=1 bash "$GUARD" "$@" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $desc -> expected refusal (non-zero), got exit 0"; FAIL=$((FAIL+1)); return
  fi
  if ! printf '%s' "$out" | grep -qi "$needle"; then
    echo "FAIL: $desc -> refused (rc=$rc) but reason missing '$needle'"; echo "  got: $out"; FAIL=$((FAIL+1)); return
  fi
  echo "ok: $desc"; PASS=$((PASS+1))
}

# expect_allow <desc> <substring-of-final-cmd> -- <args...>
expect_allow() {
  local desc="$1" needle="$2"; shift 2
  [ "$1" = "--" ] && shift
  local out rc
  out="$(DRY_RUN=1 bash "$GUARD" "$@" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $desc -> expected allow (DRY_RUN exit 0), got rc=$rc"; echo "  got: $out"; FAIL=$((FAIL+1)); return
  fi
  if ! printf '%s' "$out" | grep -q "$needle"; then
    echo "FAIL: $desc -> allowed but final command missing '$needle'"; echo "  got: $out"; FAIL=$((FAIL+1)); return
  fi
  echo "ok: $desc"; PASS=$((PASS+1))
}

# --- refusals -------------------------------------------------------------
expect_refuse "admin cannot deploy rules"        "auntieos-admin" \
  -- auntieos-admin -- firebase deploy --only firestore
expect_refuse "admin cannot deploy firestore:rules" "auntieos-admin" \
  -- auntieos-admin -- firebase deploy --only firestore:rules
expect_refuse "admin cannot deploy rules,hosting combo" "auntieos-admin" \
  -- auntieos-admin -- firebase deploy --only firestore:rules,hosting:app
expect_refuse "bare deploy refused"              "bare" \
  -- mytribe -- firebase deploy
expect_refuse "wrong project (--project other) refused" "other" \
  -- mytribe -- firebase deploy --only hosting:kinfolk_portal --project other
expect_refuse "wrong project (-P other) refused" "other" \
  -- mytribe -- firebase deploy --only hosting:kinfolk_portal -P other
# The bypass the adversarial review caught: concatenated short flag.
expect_refuse "wrong project (-Pother concatenated) refused" "other" \
  -- mytribe -- firebase deploy --only hosting:kinfolk_portal -Pother
expect_refuse "unknown prefix refused"           "unknown prefix" \
  -- nonsense -- firebase deploy --only hosting:app
expect_refuse "missing -- separator refused"     "separator" \
  -- mytribe firebase deploy --only hosting:app
expect_refuse "case-variant FIRESTORE from admin refused" "auntieos-admin" \
  -- auntieos-admin -- firebase deploy --only FIRESTORE

# The AuntieOS functions live in a different tree from its hosting, so one
# deploy cannot serve both. Refuse rather than silently pick a tree and drop
# half the request.
expect_refuse "admin cannot mix hosting and functions in one deploy" "two trees" \
  -- auntieos-admin -- firebase deploy --only hosting:app,functions:default:generateAuntieCopy
# A bare `functions` from admin means BOTH codebases, Node and Python, which is
# the same everything-at-once hazard as a bare deploy.
expect_refuse "admin bare functions (no codebase) refused" "codebase" \
  -- auntieos-admin -- firebase deploy --only functions

# --- allows (DRY_RUN, never deploys) --------------------------------------
# AuntieOS functions are declared in auntieos-admin/web/firebase.json, not in
# auntieos-admin/firebase.json, so the deploy has to run one level down.
expect_allow "admin functions deploy runs from the web tree" "auntieos-admin/web" \
  -- auntieos-admin -- firebase deploy --only functions:default:generateAuntieCopy
expect_allow "admin python codebase also runs from the web tree" "auntieos-admin/web" \
  -- auntieos-admin -- firebase deploy --only functions:reconcile:nightly_reconcile
# Hosting still runs from the admin root, so the two must not be confused.
expect_allow "admin hosting still runs from the admin root, not web" "DRY_RUN" \
  -- auntieos-admin -- firebase deploy --only hosting:app
# MyTribe is untouched by any of this.
expect_allow "mytribe functions unchanged" "functions:mytribe:health" \
  -- mytribe -- firebase deploy --only functions:mytribe:health
expect_allow "indexes-only is NOT a rules push, allowed from admin" "firestore:indexes" \
  -- auntieos-admin -- firebase deploy --only firestore:indexes
expect_allow "hosting from admin allowed"        "hosting:app" \
  -- auntieos-admin -- firebase deploy --only hosting:app
expect_allow "rules from mytribe allowed when mirror matches" "firestore" \
  -- mytribe -- firebase deploy --only firestore
expect_allow "explicit correct project is de-duplicated, not doubled" "auntieos-ttpc" \
  -- mytribe -- firebase deploy --only functions:mytribe --project auntieos-ttpc

echo
echo "safe-deploy tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
