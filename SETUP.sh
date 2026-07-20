#!/bin/bash
# Assembles the Tribe Tails monorepo and pushes it to a private GitHub repo.
#
# Written 2026-07-20. Run once, from anywhere:
#     bash /Users/sydeast/Projects/testai/CascadeProjects/tribetails/SETUP.sh
#
# Safe to re-run: every step is guarded and skips work already done.
#
# The three source repos are only READ. Nothing is moved or deleted, so they
# remain intact as backups until you choose to archive them.

set -euo pipefail

ROOT=/Users/sydeast/Projects/testai/CascadeProjects
MONO="$ROOT/tribetails"
AUNTIEOS=/Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS
MYTRIBE="$ROOT/MyTribe"
ADMIN="$ROOT/auntieos-admin"

cd "$MONO"

echo "==> 1/4  Root commit"
if ! git rev-parse HEAD >/dev/null 2>&1; then
  git add README.md SETUP.sh
  git commit -q -m "Tribe Tails monorepo root

Grafts the three codebases together so a cross-cutting change is one commit
instead of three that can drift apart."
  echo "    root commit created"
else
  echo "    already has commits, skipping"
fi

# git subtree add refuses if the prefix already exists, which makes this
# idempotent for free.
graft() {
  local prefix=$1 src=$2
  if [ -d "$prefix" ]; then
    echo "    $prefix already grafted, skipping"
    return
  fi
  local branch
  branch=$(git -C "$src" symbolic-ref --short HEAD)
  echo "    grafting $prefix from $src ($branch, $(git -C "$src" rev-list --count HEAD) commits)"
  git subtree add --prefix="$prefix" "$src" "$branch"
}

echo "==> 2/4  Grafting the three codebases (history preserved)"
graft mytribe        "$MYTRIBE"
graft auntieos       "$AUNTIEOS"
graft auntieos-admin "$ADMIN"

echo "==> 3/4  Secret sweep before anything leaves this machine"
# Fail LOUD rather than push a credential. Firebase Web API keys (AIzaSy...) are
# deliberately NOT in this list: they are public by design, identifying the
# project while access is controlled by Firestore rules and App Check.
if git grep -nIE "sk-ant-[A-Za-z0-9_-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY-----|SG\.[A-Za-z0-9_-]{20}|xox[baprs]-" \
     $(git rev-list --all) -- 2>/dev/null | grep -v "\.example" | head -5; then
  echo ""
  echo "!!! ABORTING: the pattern(s) above look like real credentials in history."
  echo "!!! Nothing has been pushed. Investigate before continuing."
  exit 1
fi
echo "    clean, no credential patterns in any commit"

echo "==> 4/4  GitHub"
if git remote get-url origin >/dev/null 2>&1; then
  echo "    remote already set: $(git remote get-url origin)"
else
  gh repo create tribetails --private --source=. --remote=origin
  echo "    created private repo and set origin"
fi

git push -u origin "$(git symbolic-ref --short HEAD)"

echo ""
echo "Done. $(git rev-list --count HEAD) commits at $(git remote get-url origin)"
echo ""
echo "The three original repos were only read, never modified. Once you have"
echo "confirmed the monorepo looks right, you can archive them:"
echo "    $MYTRIBE"
echo "    $AUNTIEOS"
echo "    $ADMIN"
