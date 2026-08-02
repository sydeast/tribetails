#!/usr/bin/env bash
# Tests for release.sh. Run:
#   bash scripts/release.test.sh
#
# WHY THIS EXISTS
# release.sh is the only thing here that touches production, and until
# 2026-08-01 it had no test at all. Both defects that shipped that day are the
# kind a test catches on the first run:
#
#   - a DRY_RUN=1 rehearsal wrote HEAD into .release-state, so the real release
#     behind it compared mytribe/functions against code that had never shipped,
#     found no diff, and skipped the functions deploy. The new admin bundle went
#     live calling getInvoiceLedger, listInvites, transitionBookingStatus and
#     getBusinessClosures against a backend that had none of them.
#   - the same rehearsal signed off with "Commit e4f0245 is live and verified."
#
# Neither is subtle once anything looks. Nothing looked.
#
# HOW IT RUNS THE REAL SCRIPT WITHOUT DEPLOYING ANYTHING
# Each case builds a throwaway git repo in $TMPDIR, copies scripts/ into it,
# gives it a `main` that is in sync with a local bare `origin`, and puts stubs
# for gh, gcloud, firebase, curl and npm at the FRONT of PATH. So the script
# under test is the real one, byte for byte, running its real branches; only the
# outside world is fake. There is no test-only code path in release.sh, which
# is the point: a flag that disarms the script in tests tests a different script.
#
# The gh stub is driven by fixture files named after commit shas, so a case can
# say "this commit's e2e job was red" and mean it.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_SCRIPTS="$HERE"
PASS=0
FAIL=0

ok()   { echo "ok: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# mtime <file>: seconds since epoch. BSD stat and GNU stat disagree on the flag,
# and this test has to run on the operator's mac and on an ubuntu runner.
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }

# ---------------------------------------------------------------------------
# make_repo: a synthetic tribetails, echoed back as its path.
# ---------------------------------------------------------------------------
make_repo() {
  local dir
  dir="$(mktemp -d)"

  mkdir -p "$dir/repo" "$dir/stubs" "$dir/fixtures"
  local r="$dir/repo"

  mkdir -p "$r/scripts" "$r/mytribe/functions" "$r/mytribe/web/dist" \
           "$r/auntieos-admin/web" "$r/auntieos-admin/dist" \
           "$r/auntieos-admin/android/app/build/outputs/apk/release"

  cp "$REPO_SCRIPTS"/*.sh "$r/scripts/" 2>/dev/null
  cp "$REPO_SCRIPTS"/*.js "$r/scripts/" 2>/dev/null
  cp "$REPO_SCRIPTS"/*.py "$r/scripts/" 2>/dev/null

  # safe-deploy refuses a rules deploy unless these two are byte-identical.
  printf 'rules_version = "2";\n' > "$r/mytribe/firestore.rules"
  cp "$r/mytribe/firestore.rules" "$r/auntieos-admin/web/firestore.rules"

  # What step 7 compares against the (stubbed) live sites.
  printf '<script src="/assets/index-deadbeef.js"></script>\n' > "$r/auntieos-admin/dist/index.html"
  cp "$r/auntieos-admin/dist/index.html" "$r/mytribe/web/dist/index.html"

  printf 'export const health = 1;\n' > "$r/mytribe/functions/index.ts"

  # The same two entries the real .gitignore carries for these, because step 0
  # refuses a dirty tree and .release-state and the APK are both untracked
  # by design. Without this the test would be testing the dirty-tree guard.
  printf '.release-state\nauntieos-admin/android/app/build/\n' > "$r/.gitignore"

  ( cd "$r"
    git init -q -b main .
    git config user.email t@t.test
    git config user.name  Test
    git config commit.gpgsign false
    git add -A
    git commit -qm "first"
    printf 'a\n' > note.txt && git add -A && git commit -qm "second"
    printf 'b\n' >> note.txt && git add -A && git commit -qm "third"
    git init -q --bare "$dir/origin.git"
    git remote add origin "$dir/origin.git"
    git push -q origin main
  ) >/dev/null 2>&1

  printf '%s' "$dir"
}

# write_stubs <dir>: the fake outside world.
write_stubs() {
  local dir="$1"

  # gh: answers check-runs from $GH_FIXTURES/<sha>, one "name<TAB>status<TAB>
  # conclusion" line per check run. No fixture means the commit has no checks.
  # GH_UNAVAILABLE=1 makes gh itself fail, which is the "gate is down" case.
  cat > "$dir/stubs/gh" <<'STUB'
#!/usr/bin/env bash
[ "${GH_UNAVAILABLE:-0}" = "1" ] && exit 1
for a in "$@"; do
  case "$a" in
    *commits/*check-runs*)
      sha="${a#*commits/}"; sha="${sha%%/*}"
      [ -f "$GH_FIXTURES/$sha" ] && cat "$GH_FIXTURES/$sha"
      exit 0
      ;;
  esac
done
exit 0
STUB

  # Everything gcloud is asked here is a read that this test has no answer for.
  # Failing is the honest stub: release.sh and prune-run-revisions.sh both have
  # a documented "could not ask" path, and this exercises it.
  printf '#!/usr/bin/env bash\nexit 1\n' > "$dir/stubs/gcloud"

  # A real deploy would land here. It must be reached only by the wet-run case,
  # and it records that it was, so a DRY_RUN case that leaks through is caught.
  cat > "$dir/stubs/firebase" <<'STUB'
#!/usr/bin/env bash
echo "STUB firebase $*"
[ -n "${FIREBASE_CALL_LOG:-}" ] && echo "$*" >> "$FIREBASE_CALL_LOG"
exit 0
STUB

  # Step 7 fetches the live sites. Serve exactly what dist/ holds, so the
  # verification passes for the reason it would in a good release.
  cat > "$dir/stubs/curl" <<'STUB'
#!/usr/bin/env bash
echo '<script src="/assets/index-deadbeef.js"></script>'
STUB

  printf '#!/usr/bin/env bash\necho "STUB npm $*"\nexit 0\n' > "$dir/stubs/npm"

  chmod +x "$dir"/stubs/*
}

# run_release <dir> [VAR=VAL ...]: run the script under test, stdout+stderr
# captured to $dir/out, exit code echoed.
run_release() {
  local dir="$1"; shift
  local rc
  (
    cd "$dir/repo"
    export PATH="$dir/stubs:$PATH"
    export GH_FIXTURES="$dir/fixtures"
    export "$@" >/dev/null 2>&1 || true
    env "$@" bash scripts/release.sh
  ) > "$dir/out" 2>&1
  rc=$?
  printf '%s' "$rc"
}

# Green everything, for cases that are not about CI.
fixture_all_green() {
  printf 'React admin\tcompleted\tsuccess\nReact admin e2e\tcompleted\tsuccess\nMyTribe functions\tcompleted\tsuccess\n' > "$1"
}

# ---------------------------------------------------------------------------
# 1. A dry run must not touch .release-state. This is the defect, exactly.
# ---------------------------------------------------------------------------
D="$(make_repo)"; write_stubs "$D"
HEAD_SHA="$(cd "$D/repo" && git rev-parse HEAD)"
FIRST_SHA="$(cd "$D/repo" && git rev-list --max-parents=0 HEAD)"
fixture_all_green "$D/fixtures/$HEAD_SHA"

printf '%s\n' "$FIRST_SHA" > "$D/repo/.release-state"
# Backdated so an identical rewrite would still change the mtime and be caught.
touch -t 202001010000 "$D/repo/.release-state"
BEFORE_SUM="$(cksum < "$D/repo/.release-state")"
BEFORE_MTIME="$(mtime "$D/repo/.release-state")"

RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D/out")"

if [ "$RC" -ne 0 ]; then
  bad "dry run completes (exit 0); got $RC"; echo "$OUT" | tail -20
else
  ok "dry run completes"
fi

AFTER_SUM="$(cksum < "$D/repo/.release-state")"
AFTER_MTIME="$(mtime "$D/repo/.release-state")"
if [ "$BEFORE_SUM" = "$AFTER_SUM" ] && [ "$BEFORE_MTIME" = "$AFTER_MTIME" ]; then
  ok "dry run leaves .release-state byte-identical and untouched (mtime $AFTER_MTIME)"
else
  bad "dry run MUTATED .release-state (sum $BEFORE_SUM -> $AFTER_SUM, mtime $BEFORE_MTIME -> $AFTER_MTIME)"
fi

if printf '%s' "$OUT" | grep -q "is live and verified"; then
  bad "dry run claims the commit is live and verified"
else
  ok "dry run does not claim the commit is live"
fi
if printf '%s' "$OUT" | grep -qi "^Tagged\|pushed it to origin"; then
  bad "dry run claims it tagged and pushed"
else
  ok "dry run does not claim it tagged anything"
fi
if printf '%s' "$OUT" | grep -q "NOTHING SHIPPED"; then
  ok "dry run says plainly that nothing shipped"
else
  bad "dry run does not say that nothing shipped"
fi
if (cd "$D/repo" && git tag -l | grep -q .); then
  bad "dry run created a git tag"
else
  ok "dry run created no git tag"
fi

# ---------------------------------------------------------------------------
# 2. A dry run must not delete the signed APK a real run left on disk.
# ---------------------------------------------------------------------------
APK="$D/repo/auntieos-admin/android/app/build/outputs/apk/release/app-release.apk"
printf 'not really an apk\n' > "$APK"
RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1)"
if [ -f "$APK" ]; then
  ok "dry run leaves an already-built APK on disk"
else
  bad "dry run DELETED the signed APK it did not rebuild"
fi
rm -f "$APK"

# ---------------------------------------------------------------------------
# 3. The wet path still records what shipped. The guard above must not have
#    turned the real write off along with the rehearsal's.
# ---------------------------------------------------------------------------
D2="$(make_repo)"; write_stubs "$D2"
HEAD2="$(cd "$D2/repo" && git rev-parse HEAD)"
fixture_all_green "$D2/fixtures/$HEAD2"
RC="$(run_release "$D2" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1)"
OUT="$(cat "$D2/out")"
if [ "$RC" -ne 0 ]; then
  bad "a real run completes; got $RC"; echo "$OUT" | tail -20
elif [ "$(cat "$D2/repo/.release-state" 2>/dev/null)" = "$HEAD2" ]; then
  ok "a real run records the released commit in .release-state"
else
  bad "a real run did not record the released commit"
fi
if printf '%s' "$OUT" | grep -q "is live and verified"; then
  ok "a real run does report the release"
else
  bad "a real run does not report the release"
fi

# ---------------------------------------------------------------------------
# 4. The CI gate. A red check on HEAD stops the release.
# ---------------------------------------------------------------------------
D3="$(make_repo)"; write_stubs "$D3"
HEAD3="$(cd "$D3/repo" && git rev-parse HEAD)"
PARENT3="$(cd "$D3/repo" && git rev-parse HEAD~1)"

printf 'React admin\tcompleted\tsuccess\nReact admin e2e\tcompleted\tfailure\n' > "$D3/fixtures/$HEAD3"
RC="$(run_release "$D3" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D3/out")"
if [ "$RC" -eq 0 ]; then
  bad "a red e2e on HEAD does not stop the release"
elif printf '%s' "$OUT" | grep -q "React admin e2e" && printf '%s' "$OUT" | grep -q "RELEASE_SKIP_CI_GATE=1"; then
  ok "a red e2e on HEAD refuses, names the job, and names the override"
else
  bad "refused but did not name the job or the override"; echo "$OUT" | tail -20
fi

# ---------------------------------------------------------------------------
# 5. The path filter. HEAD reports e2e SKIPPED because nothing it watches
#    changed; the last commit that actually ran it was red. That verdict still
#    stands for HEAD, and rounding "skipped" up to "green" is the hole the
#    2026-08-01 release went through.
# ---------------------------------------------------------------------------
printf 'React admin\tcompleted\tsuccess\nReact admin e2e\tcompleted\tskipped\n' > "$D3/fixtures/$HEAD3"
printf 'React admin e2e\tcompleted\tfailure\n' > "$D3/fixtures/$PARENT3"
RC="$(run_release "$D3" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D3/out")"
if [ "$RC" -eq 0 ]; then
  bad "an inherited red e2e (skipped on HEAD) does not stop the release"
elif printf '%s' "$OUT" | grep -qi "e2e suite is 'failure'"; then
  ok "an e2e red on an earlier commit still refuses, and says which commit"
else
  bad "did not refuse on the inherited red e2e"; echo "$OUT" | tail -20
fi

# ---------------------------------------------------------------------------
# 6. Skipped on HEAD, green on the commit that last ran it: that is a pass, and
#    it has to be, or every functions-only release blocks on a suite with
#    nothing to say.
# ---------------------------------------------------------------------------
printf 'React admin e2e\tcompleted\tsuccess\n' > "$D3/fixtures/$PARENT3"
RC="$(run_release "$D3" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D3/out")"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "e2e: green as of"; then
  ok "a skipped e2e inherits the last real verdict and passes on green"
else
  bad "a green inherited e2e did not pass"; echo "$OUT" | tail -20
fi

# ---------------------------------------------------------------------------
# 7. CI still running is not a pass.
# ---------------------------------------------------------------------------
printf 'React admin e2e\tin_progress\t\n' > "$D3/fixtures/$HEAD3"
RC="$(run_release "$D3" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D3/out")"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "has not finished"; then
  ok "a run still in flight refuses"
else
  bad "an unfinished CI run did not refuse"; echo "$OUT" | tail -20
fi

# ---------------------------------------------------------------------------
# 8. An UNAVAILABLE gate refuses by default, and the named override gets past
#    it. Both halves matter: a gate that cannot be overridden makes a GitHub
#    outage into an inability to ship a fix.
# ---------------------------------------------------------------------------
rm -f "$D3/fixtures/$HEAD3" "$D3/fixtures/$PARENT3"
RC="$(run_release "$D3" DRY_RUN=1 RELEASE_YES=1 GH_UNAVAILABLE=1)"
OUT="$(cat "$D3/out")"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "no check runs"; then
  ok "a gate that cannot answer refuses"
else
  bad "an unavailable gate did not refuse"; echo "$OUT" | tail -20
fi

RC="$(run_release "$D3" DRY_RUN=1 RELEASE_YES=1 GH_UNAVAILABLE=1 RELEASE_SKIP_CI_GATE=1)"
OUT="$(cat "$D3/out")"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "RELEASE_SKIP_CI_GATE=1"; then
  ok "RELEASE_SKIP_CI_GATE=1 releases past an unavailable gate, and says so"
else
  bad "the override did not get past an unavailable gate"; echo "$OUT" | tail -20
fi

echo
echo "release tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
