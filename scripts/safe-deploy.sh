#!/usr/bin/env bash
# safe-deploy.sh: the one door production Firebase deploys go through.
#
# WHY THIS EXISTS
# auntieos-admin/ and mytribe/ both deploy into ONE Firebase project
# (auntieos-ttpc). Both trees' firebase.json declare a firestore.rules file, so
# `firebase deploy --only firestore` from EITHER tree overwrites the project's
# LIVE rules with whatever that tree happens to hold. mytribe/firestore.rules is
# the source of truth; auntieos-admin/web/firestore.rules is a mirror. An agent
# on this machine has `firebase deploy *` pre-authorized, so pushing stale rules
# from the admin tree, or shipping everything with a bare deploy, or aiming at
# the wrong project, is one command away. This wrapper makes those impossible.
#
# It enforces four things and then execs firebase from the right tree:
#   1. rules can be pushed ONLY from mytribe, and ONLY when the mirror is
#      byte-identical to mytribe's copy (else the stale admin copy could win);
#   2. --project is always pinned to auntieos-ttpc; a different --project is
#      refused (a wrong project is as dangerous as wrong rules);
#   3. a bare `firebase deploy` (no --only) is refused (it ships hosting, every
#      functions codebase, rules AND indexes at once);
#   4. every refusal prints, in red, WHAT was refused and WHY, and exits non-zero.
#
# USAGE
#   scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets> [flags]
#   <prefix> is auntieos-admin or mytribe.
#
# DRY_RUN=1 prints the firebase command it would run instead of running it, so a
# deploy is never triggered by accident. Example:
#   DRY_RUN=1 scripts/safe-deploy.sh mytribe -- firebase deploy --only hosting:kinfolk_portal

set -euo pipefail

PROJECT="auntieos-ttpc"

# ---------------------------------------------------------------------------
# Output helpers. Refusals go to stderr in red; progress to stdout.
# ---------------------------------------------------------------------------
red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

# refuse <what> [why lines...]: red header + red reason lines, then exit 1.
refuse() {
  red "REFUSED: $1"
  shift || true
  for line in "$@"; do
    red "  $line"
  done
  exit 1
}

usage() {
  echo "Usage: scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets> [flags]"
  echo "  <prefix>: auntieos-admin | mytribe"
  echo "  rules deploy only from mytribe; --project is pinned to $PROJECT."
  echo "  DRY_RUN=1 prints the command instead of running it."
}

# ---------------------------------------------------------------------------
# Locate the repo root so paths resolve from any working directory.
# ---------------------------------------------------------------------------
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  refuse "not inside the tribetails git repo." \
    "safe-deploy resolves every path from the repo root and cannot run outside it."
fi

SRC_RULES="$ROOT/mytribe/firestore.rules"
MIRROR_RULES="$ROOT/auntieos-admin/web/firestore.rules"

# ---------------------------------------------------------------------------
# Parse the wrapper's own arguments: <prefix> -- <deploy args...>
# ---------------------------------------------------------------------------
PREFIX="${1:-}"
case "$PREFIX" in
  auntieos-admin) PREFIX_DIR="$ROOT/auntieos-admin" ;;
  mytribe)        PREFIX_DIR="$ROOT/mytribe" ;;
  -h|--help|help|"")
    usage
    # An empty/help invocation is a usage error, not a successful deploy.
    exit 2
    ;;
  *)
    refuse "unknown prefix '$PREFIX'." \
      "Expected 'auntieos-admin' or 'mytribe'." \
      "Usage: scripts/safe-deploy.sh <prefix> -- firebase deploy --only <targets>"
    ;;
esac
shift

if [ "${1:-}" != "--" ]; then
  refuse "missing '--' separator between the prefix and the firebase command." \
    "Usage: scripts/safe-deploy.sh $PREFIX -- firebase deploy --only <targets>"
fi
shift

# Everything after '--' is the caller's command. Under set -u an empty array
# expanded as \"\${arr[@]}\" errors on bash 3.2, so we index by count instead.
RAW=( "$@" )
N=${#RAW[@]}
if [ "$N" -eq 0 ]; then
  refuse "no command given after '--'." \
    "Expected: firebase deploy --only <targets>"
fi

# Accept either 'firebase deploy ...' (as a user types it) or a bare 'deploy ...'.
IDX=0
if [ "${RAW[0]}" = "firebase" ]; then
  IDX=1
fi
if [ "$N" -le "$IDX" ] || [ "${RAW[$IDX]}" != "deploy" ]; then
  refuse "this wrapper only runs 'firebase deploy'." \
    "Got: ${RAW[*]}" \
    "Usage: scripts/safe-deploy.sh $PREFIX -- firebase deploy --only <targets>"
fi
FIRST_FLAG=$((IDX + 1))

# ---------------------------------------------------------------------------
# Walk the deploy flags. Rebuild the command we will actually run (FINAL),
# recording --only and --project as we go. --project is dropped here and the
# pinned one is re-appended at the end, so the project is ALWAYS auntieos-ttpc.
# ---------------------------------------------------------------------------
FINAL=( deploy )
ONLY_VALUE=""
HAS_ONLY=0
HAS_PROJECT=0
PROJECT_VALUE=""

i=$FIRST_FLAG
while [ "$i" -lt "$N" ]; do
  tok="${RAW[$i]}"
  case "$tok" in
    --only=*)
      HAS_ONLY=1
      ONLY_VALUE="${tok#--only=}"
      FINAL+=( "$tok" )
      ;;
    --only)
      HAS_ONLY=1
      j=$((i + 1))
      if [ "$j" -lt "$N" ]; then
        ONLY_VALUE="${RAW[$j]}"
        FINAL+=( "--only" "${RAW[$j]}" )
        i=$j
      else
        FINAL+=( "--only" )
      fi
      ;;
    --project=*|-P=*)
      HAS_PROJECT=1
      PROJECT_VALUE="${tok#*=}"
      ;;
    -P?*)
      # Concatenated short form: `firebase deploy -Pother` sets project 'other'.
      # commander accepts this, so the guard MUST catch it too, or the project
      # pin is bypassable. Everything after the -P is the value.
      HAS_PROJECT=1
      PROJECT_VALUE="${tok#-P}"
      ;;
    --project|-P)
      HAS_PROJECT=1
      j=$((i + 1))
      if [ "$j" -lt "$N" ]; then
        PROJECT_VALUE="${RAW[$j]}"
        i=$j
      fi
      ;;
    *)
      FINAL+=( "$tok" )
      ;;
  esac
  i=$((i + 1))
done

# ---------------------------------------------------------------------------
# GUARD 1: wrong project. As dangerous as wrong rules, so refuse outright.
# ---------------------------------------------------------------------------
if [ "$HAS_PROJECT" -eq 1 ] && [ "$PROJECT_VALUE" != "$PROJECT" ]; then
  refuse "a deploy aimed at project '$PROJECT_VALUE'." \
    "This wrapper only ever deploys to '$PROJECT', the one shared project." \
    "Drop --project (it is pinned for you) or pass --project $PROJECT."
fi

# ---------------------------------------------------------------------------
# GUARD 2: bare deploy. No --only means ship EVERYTHING.
# ---------------------------------------------------------------------------
if [ "$HAS_ONLY" -eq 0 ]; then
  refuse "a bare 'firebase deploy' with no --only." \
    "A bare deploy ships hosting, every functions codebase, firestore rules AND" \
    "indexes in one shot. Name what you mean, e.g. --only hosting:app," \
    "--only functions:mytribe, or --only firestore:indexes."
fi

# ---------------------------------------------------------------------------
# GUARD 3: pushing firestore rules. A bare 'firestore' target pushes rules AND
# indexes; 'firestore:rules' pushes rules. 'firestore:indexes' does NOT, so it
# is allowed from either tree. Rules may go out ONLY from mytribe, and ONLY when
# the mirror still matches, so the stale admin copy can never win.
# ---------------------------------------------------------------------------
PUSHES_RULES=0
IFS=',' read -ra ONLY_PARTS <<< "$ONLY_VALUE" || true
for part in "${ONLY_PARTS[@]+"${ONLY_PARTS[@]}"}"; do
  case "$(printf '%s' "$part" | tr '[:upper:]' '[:lower:]')" in
    firestore|firestore:rules) PUSHES_RULES=1 ;;
  esac
done

if [ "$PUSHES_RULES" -eq 1 ]; then
  if [ "$PREFIX" != "mytribe" ]; then
    refuse "pushing firestore.rules from the '$PREFIX' tree." \
      "firestore.rules is shared by both trees on project $PROJECT; only 'mytribe'," \
      "the source of truth, may deploy it. Deploying from '$PREFIX' would overwrite" \
      "live rules with this tree's copy." \
      "To change rules: edit mytribe/firestore.rules, copy it to" \
      "auntieos-admin/web/firestore.rules, then deploy from mytribe."
  fi
  if [ ! -f "$SRC_RULES" ] || [ ! -f "$MIRROR_RULES" ]; then
    refuse "cannot verify the firestore.rules mirror before a rules deploy." \
      "Expected both files to exist:" \
      "  $SRC_RULES" \
      "  $MIRROR_RULES"
  fi
  if ! cmp -s "$SRC_RULES" "$MIRROR_RULES"; then
    refuse "pushing firestore.rules while the mirror has DRIFTED." \
      "mytribe/firestore.rules and auntieos-admin/web/firestore.rules are not" \
      "byte-identical, so it is unclear which rules are current. Reconcile first:" \
      "  cp \"$SRC_RULES\" \"$MIRROR_RULES\"" \
      "then re-run. mytribe is the source of truth."
  fi
fi

# ---------------------------------------------------------------------------
# Allowed. Pin the project, then run (or print, under DRY_RUN) from the tree.
# ---------------------------------------------------------------------------
FINAL+=( --project "$PROJECT" )

cyan "safe-deploy: prefix '$PREFIX' -> $PREFIX_DIR"
cyan "safe-deploy: about to run: firebase ${FINAL[*]}"

if [ "${DRY_RUN:-0}" = "1" ]; then
  ylw "DRY_RUN=1: not executing. Would cd '$PREFIX_DIR' and run:"
  printf '  firebase %s\n' "${FINAL[*]}"
  exit 0
fi

cd "$PREFIX_DIR" || refuse "cannot cd into $PREFIX_DIR."
exec firebase "${FINAL[@]}"
