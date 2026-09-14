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
#
# THE `||` FALLBACK ALONE WAS NOT ENOUGH, and on Linux it reported a defect that
# did not exist. This used to be `stat -f %m "$1" 2>/dev/null || stat -c %Y`. On
# GNU stat, `-f` is not "format", it is `--file-system`, so that first command
# does not simply fail: it prints the whole FILESYSTEM REPORT for the file's
# mount to stdout, then exits non-zero over the unrecognised `%m` operand, and
# the fallback's real answer is appended to that. The caller got a multi-line
# blob with the volume's free-block count inside it, and a live runner's free
# blocks change between two calls seconds apart. So a dry run that had not
# touched `.release-state` at all was reported as having MUTATED it, with
# identical checksums and two "mtimes" that differed only in how much disk the
# runner had left. It fired for the first time on 2026-09-11, on the hosted
# ubuntu runner, because this job only runs when a release or workflow file is
# touched and the self-hosted macs had always taken it before.
#
# The fix is to stop trusting exit status and check the ANSWER. An mtime is a
# bare integer; anything else means that stat was the wrong one. GNU is tried
# first because its failure on BSD puts nothing on stdout.
mtime() {
  local m
  m="$(stat -c %Y "$1" 2>/dev/null)" || m=''
  case "$m" in
    '' | *[!0-9]*) m="$(stat -f %m "$1" 2>/dev/null)" ;;
  esac
  case "$m" in
    '' | *[!0-9]*)
      echo "mtime: neither GNU nor BSD stat answered for $1" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$m"
}

# ---------------------------------------------------------------------------
# make_repo: a synthetic tribetails, echoed back as its path.
# ---------------------------------------------------------------------------
make_repo() {
  local dir
  dir="$(mktemp -d)"

  mkdir -p "$dir/repo" "$dir/stubs" "$dir/fixtures"
  local r="$dir/repo"

  # Both Android APK output directories. There are two Android apps and their
  # builds are not the same shape: auntieos-admin/android has an :app submodule
  # and writes app/build/outputs/…/app-release.apk, while mytribe applies
  # com.android.application at the ROOT and writes build/outputs/…/
  # kinfolk-portal-release.apk, named from rootProject.name. A fixture that
  # only knows the first one cannot catch the release shipping only the first
  # one, which is what it did until 2026-08-04.
  mkdir -p "$r/scripts" "$r/mytribe/functions" "$r/mytribe/web/dist" \
           "$r/auntieos-admin/web" "$r/auntieos-admin/dist" \
           "$r/auntieos-admin/android/app/build/outputs/apk/release" \
           "$r/mytribe/build/outputs/apk/release"

  cp "$REPO_SCRIPTS"/*.sh "$r/scripts/" 2>/dev/null
  cp "$REPO_SCRIPTS"/*.js "$r/scripts/" 2>/dev/null
  # .mjs too, since step 0c runs scripts/client-secrets.mjs. Without this the
  # step under test would fail for the uninteresting reason that the file it
  # runs is not there.
  cp "$REPO_SCRIPTS"/*.mjs "$r/scripts/" 2>/dev/null
  cp "$REPO_SCRIPTS"/*.py "$r/scripts/" 2>/dev/null
  # scripts/lib/: step 0a sources scripts/lib/dep-drift.sh, which in turn
  # shells out to the two Node scripts beside it. Same reason as the .mjs
  # copy above -- without this the step under test dies on a missing file
  # rather than exercising the drift check itself.
  mkdir -p "$r/scripts/lib"
  cp "$REPO_SCRIPTS"/lib/*.sh "$REPO_SCRIPTS"/lib/*.js "$r/scripts/lib/" 2>/dev/null

  # 0a reads a root lockfile and mytribe/functions' own lockfile. Empty
  # (no dependencies declared) so a fully-synthetic repo with no real
  # node_modules reports "not installed yet" rather than "no lockfile at
  # all"; the drift-specific cases below add a real, mismatched install on
  # top of this baseline.
  printf '{ "name": "synthetic-functions", "dependencies": {} }\n' \
    > "$r/mytribe/functions/package.json"
  printf '{ "name": "synthetic-functions", "lockfileVersion": 3, "packages": {} }\n' \
    > "$r/mytribe/functions/package-lock.json"
  printf '{ "name": "synthetic-root", "private": true, "workspaces": ["packages/*", "auntieos-admin", "mytribe/web"] }\n' \
    > "$r/package.json"
  printf '{ "name": "synthetic-root", "lockfileVersion": 3, "packages": {} }\n' \
    > "$r/package-lock.json"

  # safe-deploy refuses a rules deploy unless these two are byte-identical.
  printf 'rules_version = "2";\n' > "$r/mytribe/firestore.rules"
  cp "$r/mytribe/firestore.rules" "$r/auntieos-admin/web/firestore.rules"

  # What step 7 compares against the (stubbed) live sites.
  printf '<script src="/assets/index-deadbeef.js"></script>\n' > "$r/auntieos-admin/dist/index.html"
  cp "$r/auntieos-admin/dist/index.html" "$r/mytribe/web/dist/index.html"

  printf 'export const health = 1;\n' > "$r/mytribe/functions/index.ts"

  # A SYNTHETIC BUILT FUNCTIONS CODEBASE, because step 5 no longer deploys a
  # codebase name: it enumerates the deployable functions from the artifact the
  # Firebase CLI loads (lib/index.js, exports carrying __endpoint) and deploys
  # them by name in batches. Six functions is enough to have more than one batch
  # and enough to have a shared module: alpha and beta both require lib/shared,
  # so a change there must widen to both, and a change to gamma must not.
  mkdir -p "$r/mytribe/functions/src/portal" "$r/mytribe/functions/src/admin" \
           "$r/mytribe/functions/src/lib" \
           "$r/mytribe/functions/lib/portal" "$r/mytribe/functions/lib/admin" \
           "$r/mytribe/functions/lib/lib"

  printf 'exports.tag = "v1";\n' > "$r/mytribe/functions/lib/lib/shared.js"
  for f in alpha beta; do
    cat > "$r/mytribe/functions/lib/portal/$f.js" <<STUBFN
const shared = require('../lib/shared');
exports.$f = { __endpoint: { platform: 'gcfv2' }, tag: shared.tag };
STUBFN
  done
  cat > "$r/mytribe/functions/lib/portal/gamma.js" <<'STUBFN'
exports.gamma = { __endpoint: { platform: 'gcfv2' } };
STUBFN
  for f in delta epsilon zeta; do
    cat > "$r/mytribe/functions/lib/admin/$f.js" <<STUBFN
exports.$f = { __endpoint: { platform: 'gcfv2' } };
STUBFN
  done
  cat > "$r/mytribe/functions/lib/index.js" <<'STUBFN'
exports.alpha = require('./portal/alpha').alpha;
exports.beta = require('./portal/beta').beta;
exports.gamma = require('./portal/gamma').gamma;
exports.delta = require('./admin/delta').delta;
exports.epsilon = require('./admin/epsilon').epsilon;
exports.zeta = require('./admin/zeta').zeta;
STUBFN

  # The sources those compile from. Only their PATHS matter to the mapping, but
  # they have to be real files in git for a diff to name them.
  printf 'export const tag = "v1";\n' > "$r/mytribe/functions/src/lib/shared.ts"
  for f in alpha beta; do
    printf "export const %s = { tag: 1 };\n" "$f" > "$r/mytribe/functions/src/portal/$f.ts"
  done
  printf 'export const gamma = {};\n' > "$r/mytribe/functions/src/portal/gamma.ts"
  for f in delta epsilon zeta; do
    printf "export const %s = {};\n" "$f" > "$r/mytribe/functions/src/admin/$f.ts"
  done
  printf 'export { alpha } from "./portal/alpha";\n' > "$r/mytribe/functions/src/index.ts"
  printf '{ "name": "mytribe-functions", "scripts": { "build": "tsc" } }\n' \
    > "$r/mytribe/functions/package.json"

  # A FAKE gradlew per Android app, so the two-app path can be run wet without
  # an Android SDK. It writes the APK the task it was given is supposed to
  # produce, and refuses any other task: that is what makes it a test of the
  # task names rather than of a shell loop. GRADLE_FAIL=<task> makes one of them
  # fail, which is how the refusal case is exercised.
  for gw in "$r/auntieos-admin/android/gradlew" "$r/mytribe/gradlew"; do
    cat > "$gw" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  :app:assembleRelease) out="app/build/outputs/apk/release/app-release.apk" ;;
  :assembleRelease)     out="build/outputs/apk/release/kinfolk-portal-release.apk" ;;
  *) echo "stub gradlew: no such task $1 in $PWD" >&2; exit 1 ;;
esac
if [ "${GRADLE_FAIL:-}" = "$1" ]; then
  echo "stub gradlew: FAILING $1 on request" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
printf 'apk built by %s\n' "$1" > "$out"
echo "STUB gradlew $*"
STUB
    chmod +x "$gw"
  done

  # The same entries the real .gitignore carries for these, because step 0
  # refuses a dirty tree and .release-state and the APK are both untracked
  # by design. Without this the test would be testing the dirty-tree guard.
  printf '.release-state\n.release-functions\nauntieos-admin/android/app/build/\nmytribe/build/\nnode_modules/\n' > "$r/.gitignore"

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
  #
  # FIREBASE_QUOTA_MAX=N models the incident: the first N functions of a deploy
  # are accepted and the rest refused, which is what 197-of-223 and 201-of-227
  # looked like on 2026-08-01. The stub prints firebase's own per-function result
  # lines, because that is what release.sh reads to work out which names to retry.
  #
  # The cause was misread for a week as the Cloud Run CPU ceiling. It is a
  # per-minute mutation RATE on cloudfunctions.googleapis.com (see the 429 text
  # below), so the real thing does not refuse a hard first-N; it refuses whatever
  # arrives after the minute's budget is spent, and the CLI retries it. A hard
  # first-N is still the right shape for these tests: it produces a deterministic
  # set of casualties, which is what the retry logic under test consumes.
  cat > "$dir/stubs/firebase" <<'STUB'
#!/usr/bin/env bash
echo "STUB firebase $*"
[ -n "${FIREBASE_CALL_LOG:-}" ] && echo "$*" >> "$FIREBASE_CALL_LOG"

only=""
want_only=0
for a in "$@"; do
  if [ "$want_only" = "1" ]; then only="$a"; want_only=0; continue; fi
  case "$a" in
    --only) want_only=1 ;;
    --only=*) only="${a#--only=}" ;;
  esac
done

case "$only" in
  functions:mytribe:*) ;;
  *) exit 0 ;;
esac

names="$(printf '%s' "$only" | tr ',' '\n' | sed 's/^functions:mytribe://')"
limit="${FIREBASE_QUOTA_MAX:-9999}"
n=0
rc=0
for f in $names; do
  n=$((n + 1))
  if [ "$n" -le "$limit" ]; then
    echo "✔  functions[$f(us-central1)] Successful update operation."
  else
    echo "⚠  functions[$f(us-central1)] Deployment error."
    # The real text, captured 2026-08-03 from a single-batch deploy of all 227.
    # It is a per-minute RATE on cloudfunctions.googleapis.com, not the Cloud Run
    # CPU ceiling this stub used to claim. Nothing in release.sh parses it (the
    # per-function result lines above are what it reads), so this is here to stop
    # the fixture teaching the wrong cause to the next person who reads it.
    echo "HTTP Error: 429, Quota exceeded for quota metric 'Per project mutation requests' and limit 'Per project mutation requests per minute per region' of service 'cloudfunctions.googleapis.com'"
    rc=1
  fi
done
exit $rc
STUB

  # Step 7 fetches the live sites. Serve exactly what dist/ holds, so the
  # verification passes for the reason it would in a good release.
  cat > "$dir/stubs/curl" <<'STUB'
#!/usr/bin/env bash
echo '<script src="/assets/index-deadbeef.js"></script>'
STUB

  # Step 0c writes each app's client build config into a file only a PRODUCTION
  # build reads, and the release removes it again when it finishes. So "did the
  # build actually get it" cannot be answered after the run; it is answered
  # here, by the thing standing in for the build.
  cat > "$dir/stubs/npm" <<'STUB'
#!/usr/bin/env bash
echo "STUB npm $*"
if [ -n "${NPM_CLIENT_ENV_LOG:-}" ]; then
  for f in auntieos-admin/.env.production.local mytribe/web/.env.production.local; do
    [ -f "$f" ] && sed "s|^|$f |" "$f" >> "$NPM_CLIENT_ENV_LOG"
  done
fi
exit 0
STUB

  chmod +x "$dir"/stubs/*
}

# secret_store <dir> NAME=VALUE ...: replace the gcloud stub with one that
# answers the two reads scripts/client-secrets.mjs makes, out of a directory of
# files named after secrets. Everything else gcloud is asked still fails, the
# way the shared stub does, so a case about client config does not accidentally
# start answering the revision prune or the function-secret preflight.
#
# The VALUES are obvious nonsense on purpose. A test fixture holding something
# that looked like a real DSN or a real pk.* token would be a real key in git
# the moment somebody pasted one in "to make it realistic".
secret_store() {
  local dir="$1"; shift
  mkdir -p "$dir/secrets"
  rm -f "$dir/secrets"/*
  local kv
  for kv in "$@"; do
    printf '%s' "${kv#*=}" > "$dir/secrets/${kv%%=*}"
  done
  cat > "$dir/stubs/gcloud" <<'STUB'
#!/usr/bin/env bash
[ -n "${GCLOUD_SECRETS_DIR:-}" ] || exit 1
case "$1 $2 $3" in
  "secrets list --project")
    for f in "$GCLOUD_SECRETS_DIR"/*; do [ -e "$f" ] && basename "$f"; done
    exit 0
    ;;
  "secrets versions access")
    name=""
    for a in "$@"; do case "$a" in --secret=*) name="${a#--secret=}" ;; esac; done
    [ -n "$name" ] && [ -f "$GCLOUD_SECRETS_DIR/$name" ] || exit 1
    cat "$GCLOUD_SECRETS_DIR/$name"
    exit 0
    ;;
esac
exit 1
STUB
  chmod +x "$dir/stubs/gcloud"
}

# Everything a release needs, so a case can take exactly one thing away.
FULL_STORE=(
  ADMIN_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/0
  PORTAL_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/1
  PORTAL_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token
  ADMIN_WEB_APPCHECK_SITE_KEY=6LcEXAMPLE-not-a-real-site-key
  ADMIN_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token-admin
)

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
# 2. A dry run must not delete a signed APK a real run left on disk. Checked
#    for BOTH apps: the rm is per app now, so a rehearsal that spares one and
#    deletes the other is exactly as wrong as the original defect.
# ---------------------------------------------------------------------------
APK="$D/repo/auntieos-admin/android/app/build/outputs/apk/release/app-release.apk"
APK_MT="$D/repo/mytribe/build/outputs/apk/release/kinfolk-portal-release.apk"
printf 'not really an apk\n' > "$APK"
printf 'not really an apk either\n' > "$APK_MT"
RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1)"
if [ -f "$APK" ]; then
  ok "dry run leaves the already-built auntieos APK on disk"
else
  bad "dry run DELETED the signed auntieos APK it did not rebuild"
fi
if [ -f "$APK_MT" ]; then
  ok "dry run leaves the already-built mytribe APK on disk"
else
  bad "dry run DELETED the signed mytribe APK it did not rebuild"
fi

# The rehearsal has to NAME both gradle invocations, with the right task for
# each. :app:assembleRelease does not exist in mytribe (no :app submodule) and
# :assembleRelease is not what auntieos-admin/android needs, so a dry run that
# prints one task twice is printing a command a real run would not issue.
OUT="$(cat "$D/out")"
if printf '%s' "$OUT" | grep -q "gradlew :app:assembleRelease" &&
   printf '%s' "$OUT" | grep -q "gradlew :assembleRelease"; then
  ok "dry run names both Android builds, each with its own gradle task"
else
  bad "dry run does not rehearse both Android builds"
  printf '%s' "$OUT" | grep -i "assembleRelease" || echo "  (no assembleRelease line at all)"
fi
rm -f "$APK" "$APK_MT"

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

# ---------------------------------------------------------------------------
# The functions deploy. Everything below exists because of 2026-08-01, when five
# whole-fleet deploys each died partway against a 200 vCPU regional quota that
# ~227 one-vCPU services cannot fit inside:
#
#     forced                197 ok / 26 failed      release retry   197 / 30
#     stray package script  131 ok / 95 failed      PREDEPLOY_KEEP=2 201 / 26
#     targeted retry of 26    0 ok / 26 failed
#
# Recovery was always the same: name the casualties, redeploy them small. So the
# release does that itself now, and these cases hold it to it.
# ---------------------------------------------------------------------------

# commit_change <dir> <repo-relative path> <line>: land a change on main and
# push it, so step 0's sync check still passes.
commit_change() {
  local dir="$1" file="$2" line="$3"
  ( cd "$dir/repo"
    printf '%s\n' "$line" >> "$file"
    git add -A
    git commit -qm "change $file"
    git push -q origin main
  ) >/dev/null 2>&1
}

# commit_all <dir>: land and push WHATEVER is sitting uncommitted in the repo,
# for cases that set up several files at once (a declared dependency, a
# mismatched install) rather than one line in one file.
commit_all() {
  ( cd "$1/repo"
    git add -A
    git commit -qm "test: dependency drift setup"
    git push -q origin main
  ) >/dev/null 2>&1
}

# arm_ci <dir>: give the current HEAD a green CI fixture.
arm_ci() {
  fixture_all_green "$1/fixtures/$(cd "$1/repo" && git rev-parse HEAD)"
}

# fn_deploys <call-log>: one line per functions deploy, holding just the names.
fn_deploys() {
  grep -o -- '--only functions:mytribe:[^ ]*' "$1" 2>/dev/null |
    sed 's/--only //; s/functions:mytribe://g' || true
}

# ---------------------------------------------------------------------------
# 9. A real run deploys functions BY NAME, in batches, and never hands firebase
#    the whole codebase in one target. That single target is the incident.
# ---------------------------------------------------------------------------
D4="$(make_repo)"; write_stubs "$D4"; arm_ci "$D4"
RC="$(run_release "$D4" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0 \
  FIREBASE_CALL_LOG="$D4/calls")"
OUT="$(cat "$D4/out")"

if [ "$RC" -ne 0 ]; then
  bad "a real run with the functions step completes; got $RC"; echo "$OUT" | tail -25
else
  ok "a real run with the functions step completes"
fi

if grep -q -- '--only functions:mytribe ' "$D4/calls" 2>/dev/null ||
   grep -q -- '--only functions:mytribe$' "$D4/calls" 2>/dev/null; then
  bad "the release still deploys the whole codebase in one target"
else
  ok "the release never deploys '--only functions:mytribe' as one target"
fi

BATCHES="$(fn_deploys "$D4/calls" | wc -l | tr -d ' ')"
DEPLOYED="$(fn_deploys "$D4/calls" | tr ',' '\n' | sort -u | grep -c . || true)"
if [ "$BATCHES" = "2" ] && [ "$DEPLOYED" = "6" ]; then
  ok "6 functions went out as 2 batches of at most 4"
else
  bad "expected 2 batches covering 6 functions; got $BATCHES batch(es), $DEPLOYED function(s)"
  fn_deploys "$D4/calls"
fi

if [ "$(cat "$D4/repo/.release-functions" 2>/dev/null | sort | tr '\n' ' ')" = "alpha beta delta epsilon gamma zeta " ]; then
  ok "a real run records the fleet it shipped in .release-functions"
else
  bad "the shipped fleet was not recorded"; cat "$D4/repo/.release-functions" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# 10. The quota refuses part of a batch. The release must NOT die on it: work
#     out which names did not land, retry those, and finish.
# ---------------------------------------------------------------------------
D5="$(make_repo)"; write_stubs "$D5"; arm_ci "$D5"
RC="$(run_release "$D5" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=6 RELEASE_FUNCTIONS_SETTLE=0 RELEASE_RETRY_KEEP=0 \
  FIREBASE_QUOTA_MAX=4 FIREBASE_CALL_LOG="$D5/calls")"
OUT="$(cat "$D5/out")"

if [ "$RC" -eq 0 ]; then
  ok "a partial quota refusal does not fail the release"
else
  bad "a partial quota refusal failed the release (rc=$RC)"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "round 2 of 3"; then
  ok "the casualties are retried in a second, smaller round"
else
  bad "no retry round ran after the quota refusal"; echo "$OUT" | tail -25
fi
RETRIED="$(fn_deploys "$D5/calls" | tail -1)"
if [ "$RETRIED" = "gamma,zeta" ]; then
  ok "the retry names exactly the two functions firebase did not confirm"
else
  bad "the retry batch was '$RETRIED', not the two casualties"; fn_deploys "$D5/calls"
fi
if printf '%s' "$OUT" | grep -q "is live and verified"; then
  ok "a release that recovered from the quota still reports the release"
else
  bad "the recovered release did not report success"; echo "$OUT" | tail -25
fi

# ---------------------------------------------------------------------------
# 11. A quota that never lifts. Rounds run out, and then the release REFUSES,
#     names every stale function, and stops BEFORE hosting: shipping the clients
#     ahead of the backend is the thing step 5's position exists to prevent.
# ---------------------------------------------------------------------------
D6="$(make_repo)"; write_stubs "$D6"; arm_ci "$D6"
RC="$(run_release "$D6" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=6 RELEASE_FUNCTIONS_SETTLE=0 RELEASE_RETRY_KEEP=0 \
  FIREBASE_QUOTA_MAX=0 FIREBASE_CALL_LOG="$D6/calls")"
OUT="$(cat "$D6/out")"

if [ "$RC" -ne 0 ]; then
  ok "a quota that never lifts fails the release rather than shipping half of it"
else
  bad "an undeployable fleet still reported a release"; echo "$OUT" | tail -25
fi
MISSING=0
for f in alpha beta gamma delta epsilon zeta; do
  # The list prints in red, so the line ends in an escape, not in the name.
  printf '%s' "$OUT" | grep -q "    $f" || MISSING=1
done
if [ "$MISSING" -eq 0 ]; then
  ok "the refusal names every function that is stale"
else
  bad "the refusal did not name all six stale functions"; echo "$OUT" | tail -30
fi
if grep -q 'hosting' "$D6/calls" 2>/dev/null; then
  bad "hosting shipped even though the backend did not"
else
  ok "hosting does not ship when the functions did not"
fi
if [ -f "$D6/repo/.release-state" ]; then
  bad "a failed functions deploy still recorded the commit as released"
else
  ok "a failed functions deploy records nothing as released"
fi

# ---------------------------------------------------------------------------
# 12. Only what changed. A one-function change must not touch the other five.
# ---------------------------------------------------------------------------
D7="$(make_repo)"; write_stubs "$D7"
(cd "$D7/repo" && git rev-parse HEAD) > "$D7/repo/.release-state"
commit_change "$D7" "mytribe/functions/src/portal/gamma.ts" "// one line"
arm_ci "$D7"
RC="$(run_release "$D7" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_SETTLE=0 FIREBASE_CALL_LOG="$D7/calls")"
OUT="$(cat "$D7/out")"
if [ "$RC" -eq 0 ] && [ "$(fn_deploys "$D7/calls")" = "gamma" ]; then
  ok "a one-function change deploys exactly that function"
else
  bad "a one-function change deployed '$(fn_deploys "$D7/calls")' (rc=$RC)"; echo "$OUT" | tail -25
fi

# ---------------------------------------------------------------------------
# 13. Shared code is not one function's business. src/lib/shared.ts is required
#     by alpha and beta, so it must widen to both and stop there. A per-file
#     mapping that named one function would be the clever wrong answer.
# ---------------------------------------------------------------------------
D8="$(make_repo)"; write_stubs "$D8"
(cd "$D8/repo" && git rev-parse HEAD) > "$D8/repo/.release-state"
commit_change "$D8" "mytribe/functions/src/lib/shared.ts" "// touched"
arm_ci "$D8"
RC="$(run_release "$D8" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_SETTLE=0 FIREBASE_CALL_LOG="$D8/calls")"
GOT="$(fn_deploys "$D8/calls" | tr ',' '\n' | sort | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$GOT" = "alpha beta " ]; then
  ok "a shared-module change widens to every function that loads it, and no further"
else
  bad "a shared-module change deployed '$GOT' (rc=$RC)"; cat "$D8/out" | tail -25
fi

# ---------------------------------------------------------------------------
# 14. What it cannot attribute, it does not guess. Editing the src/index.ts
#     barrel can repoint an export at a different module while touching neither,
#     and no dependency walk can see that, so it falls back to the whole fleet.
# ---------------------------------------------------------------------------
D9="$(make_repo)"; write_stubs "$D9"
(cd "$D9/repo" && git rev-parse HEAD) > "$D9/repo/.release-state"
commit_change "$D9" "mytribe/functions/src/index.ts" 'export { beta } from "./portal/beta";'
arm_ci "$D9"
RC="$(run_release "$D9" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=6 RELEASE_FUNCTIONS_SETTLE=0 FIREBASE_CALL_LOG="$D9/calls")"
GOT="$(fn_deploys "$D9/calls" | tr ',' '\n' | sort -u | grep -c . || true)"
OUT="$(cat "$D9/out")"
if [ "$RC" -eq 0 ] && [ "$GOT" = "6" ] &&
   printf '%s' "$OUT" | grep -q "falling back to the whole fleet"; then
  ok "an unattributable change deploys the whole fleet and says why"
else
  bad "an index.ts change deployed $GOT function(s) (rc=$RC) without the fallback"
  echo "$OUT" | tail -25
fi

# ---------------------------------------------------------------------------
# 15. A test-only change reaches no deployed function. It used to cost a
#     227-function deploy, which is 227 new Cloud Run revisions to change nothing.
# ---------------------------------------------------------------------------
D10="$(make_repo)"; write_stubs "$D10"
mkdir -p "$D10/repo/mytribe/functions/test"
printf 'it("works", () => {});\n' > "$D10/repo/mytribe/functions/test/alpha.test.ts"
( cd "$D10/repo" && git add -A && git commit -qm "add a test" && git push -q origin main ) >/dev/null 2>&1
(cd "$D10/repo" && git rev-parse HEAD) > "$D10/repo/.release-state"
commit_change "$D10" "mytribe/functions/test/alpha.test.ts" 'it("also works", () => {});'
arm_ci "$D10"
RC="$(run_release "$D10" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_SETTLE=0 FIREBASE_CALL_LOG="$D10/calls")"
OUT="$(cat "$D10/out")"
if [ "$RC" -eq 0 ] && [ -z "$(fn_deploys "$D10/calls")" ] &&
   printf '%s' "$OUT" | grep -q "nothing to deploy"; then
  ok "a test-only change deploys no functions at all, and says so"
else
  bad "a test-only change deployed '$(fn_deploys "$D10/calls")' (rc=$RC)"; echo "$OUT" | tail -25
fi

# ---------------------------------------------------------------------------
# 16. A dry run is still inert, batching and all. Nothing reaches firebase and
#     the new manifest is not written, for the same reason .release-state is not.
# ---------------------------------------------------------------------------
D11="$(make_repo)"; write_stubs "$D11"; arm_ci "$D11"
RC="$(run_release "$D11" DRY_RUN=1 RELEASE_YES=1 FIREBASE_CALL_LOG="$D11/calls")"
if [ "$RC" -eq 0 ] && [ -z "$(fn_deploys "$D11/calls")" ]; then
  ok "a dry run runs the batching and deploys no function"
else
  bad "a dry run reached firebase with '$(fn_deploys "$D11/calls")' (rc=$RC)"
fi
if [ -f "$D11/repo/.release-functions" ]; then
  bad "a dry run wrote .release-functions"
else
  ok "a dry run does not write .release-functions"
fi

# ---------------------------------------------------------------------------
# 17. No built lib means no names, and no names must mean no deploy. Falling
#     back to '--only functions:mytribe' here would be falling back to the
#     incident.
# ---------------------------------------------------------------------------
D12="$(make_repo)"; write_stubs "$D12"; arm_ci "$D12"
rm -f "$D12/repo/mytribe/functions/lib/index.js"
( cd "$D12/repo" && git add -A && git commit -qm "drop the build" && git push -q origin main ) >/dev/null 2>&1
arm_ci "$D12"
RC="$(run_release "$D12" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 FIREBASE_CALL_LOG="$D12/calls")"
OUT="$(cat "$D12/out")"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "build:functions"; then
  ok "an unenumerable fleet refuses and names the build that fixes it"
else
  bad "an unenumerable fleet did not refuse (rc=$RC)"; echo "$OUT" | tail -20
fi
if [ -z "$(fn_deploys "$D12/calls")" ] && ! grep -q 'hosting' "$D12/calls" 2>/dev/null; then
  ok "an unenumerable fleet deploys nothing at all"
else
  bad "something shipped without a function list"; cat "$D12/calls"
fi

# ---------------------------------------------------------------------------
# 18. A function deleted from the source is still serving. Deploying by explicit
#     name never removes anything, so the run has to SAY so; the alternative is
#     nobody ever noticing.
# ---------------------------------------------------------------------------
D13="$(make_repo)"; write_stubs "$D13"; arm_ci "$D13"
printf 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\nomega\n' > "$D13/repo/.release-functions"
RC="$(run_release "$D13" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_SETTLE=0 FIREBASE_CALL_LOG="$D13/calls")"
OUT="$(cat "$D13/out")"
if printf '%s' "$OUT" | grep -q "functions:delete omega"; then
  ok "a function that left the code is reported with the command that removes it"
else
  bad "an orphaned deployed function was not reported"; echo "$OUT" | tail -25
fi

# ---------------------------------------------------------------------------
# 19. Cloud Run service names back to export names, which is the direction
#     recovery needs. Doing this by eye against src/index.ts resolved 79 of 95 on
#     2026-08-01; a partial answer leaves exactly the functions nobody redeployed,
#     so anything short of all of them must refuse.
# ---------------------------------------------------------------------------
D14="$(make_repo)"; write_stubs "$D14"
printf 'alpha\nZETA\n' > "$D14/svc-ok"
if OUT="$(cd "$D14/repo" && node scripts/function-targets.js --from-services "$D14/svc-ok" 2>/dev/null)" &&
   [ "$OUT" = "$(printf 'alpha\nzeta')" ]; then
  ok "lowercase Cloud Run service names resolve back to their exports"
else
  bad "service names did not resolve; got '$OUT'"
fi
printf 'alpha\nnosuchservice\n' > "$D14/svc-bad"
if (cd "$D14/repo" && node scripts/function-targets.js --from-services "$D14/svc-bad" >/dev/null 2>&1); then
  bad "an unresolvable service name still returned a partial list"
else
  ok "an unresolvable service name refuses rather than answering partially"
fi

# ---------------------------------------------------------------------------
# 20. BOTH Android apps ship, and the tag says so per app.
#
#     There are two registered, active Android apps in auntieos-ttpc, and until
#     2026-08-04 release.sh hardcoded one directory and one APK path, so the
#     Kinfolk Portal client was never built and never distributed while its web
#     half shipped every release. The comment block the fix lived under said it
#     existed to end exactly that drift.
#
#     These cases run the real two-app path wet against the fake gradlew, and
#     assert on the two things that can silently regress: whether both uploads
#     actually happened, to the two DIFFERENT Firebase app ids, and whether the
#     tag reports them separately. A tag reading "android: distributed" when one
#     of two went out is the same lie the split BUILT/DISTRIBUTED bookkeeping
#     was written against, one level up.
# ---------------------------------------------------------------------------
AUNTIEOS_APP_ID="1:153396971788:android:6bcb7c5411aeda837f2129"
MYTRIBE_APP_ID="1:153396971788:android:4e9868bbb96301277f2129"

D15="$(make_repo)"; write_stubs "$D15"
HEAD15="$(cd "$D15/repo" && git rev-parse HEAD)"
fixture_all_green "$D15/fixtures/$HEAD15"
RC="$(run_release "$D15" RELEASE_YES=1 RELEASE_ANDROID_TESTERS=a@b.test \
      FIREBASE_CALL_LOG="$D15/calls")"
OUT="$(cat "$D15/out")"
CALLS="$(cat "$D15/calls" 2>/dev/null || true)"

if [ "$RC" -ne 0 ]; then
  bad "a release with both Android apps completes; got $RC"; echo "$OUT" | tail -25
else
  ok "a release with both Android apps completes"
fi
if [ -f "$D15/repo/auntieos-admin/android/app/build/outputs/apk/release/app-release.apk" ] &&
   [ -f "$D15/repo/mytribe/build/outputs/apk/release/kinfolk-portal-release.apk" ]; then
  ok "step 1c assembles both APKs, each at its own output path"
else
  bad "step 1c did not assemble both APKs"
  printf '%s' "$OUT" | grep -i "android" | head -20
fi
if printf '%s' "$CALLS" | grep -q "appdistribution:distribute.*$AUNTIEOS_APP_ID" &&
   printf '%s' "$CALLS" | grep -q "appdistribution:distribute.*$MYTRIBE_APP_ID"; then
  ok "step 6b uploads both APKs, each to its own Firebase app id"
else
  bad "step 6b did not upload both APKs to their own app ids"
  printf '%s' "$CALLS" | grep appdistribution || echo "  (no distribute call at all)"
fi
# The APK argument has to match the app id it went out under. Crossing them
# would upload the operator app to the portal's Firebase entry, and every check
# above would still pass.
if printf '%s' "$CALLS" | grep "app-release.apk" | grep -q -- "$AUNTIEOS_APP_ID" &&
   printf '%s' "$CALLS" | grep "kinfolk-portal-release.apk" | grep -q -- "$MYTRIBE_APP_ID"; then
  ok "each APK goes to the app id that belongs to it"
else
  bad "an APK was uploaded under the other app's id"
  printf '%s' "$CALLS" | grep appdistribution
fi
TAGMSG="$(cd "$D15/repo" && git tag -l 'release/*' --format='%(contents)')"
if printf '%s' "$TAGMSG" | grep -q "android (auntieos): distributed" &&
   printf '%s' "$TAGMSG" | grep -q "android (mytribe): distributed"; then
  ok "the tag reports each Android app separately"
else
  bad "the tag does not report both Android apps"
  printf '%s\n' "$TAGMSG"
fi

# ---------------------------------------------------------------------------
# 21. The per-app skip ships the healthy app and says which one it dropped.
#     Without it, one broken Android build would force RELEASE_SKIP_ANDROID=1
#     and drop the other client with it: one broken app becomes two unshipped
#     ones, which is the drift, not a fix for it.
# ---------------------------------------------------------------------------
D16="$(make_repo)"; write_stubs "$D16"
HEAD16="$(cd "$D16/repo" && git rev-parse HEAD)"
fixture_all_green "$D16/fixtures/$HEAD16"
RC="$(run_release "$D16" RELEASE_YES=1 RELEASE_ANDROID_TESTERS=a@b.test \
      RELEASE_SKIP_ANDROID_MYTRIBE=1 FIREBASE_CALL_LOG="$D16/calls")"
CALLS="$(cat "$D16/calls" 2>/dev/null || true)"
TAGMSG="$(cd "$D16/repo" && git tag -l 'release/*' --format='%(contents)')"
if [ "$RC" -eq 0 ] &&
   printf '%s' "$CALLS" | grep -q "appdistribution:distribute.*$AUNTIEOS_APP_ID" &&
   ! printf '%s' "$CALLS" | grep -q "$MYTRIBE_APP_ID"; then
  ok "a per-app skip still ships the other Android app"
else
  bad "a per-app skip did not ship the other Android app (rc $RC)"
  printf '%s' "$CALLS" | grep appdistribution || echo "  (no distribute call at all)"
fi
if printf '%s' "$TAGMSG" | grep -q "android (auntieos): distributed" &&
   printf '%s' "$TAGMSG" | grep -q "android (mytribe): skipped"; then
  ok "the tag names the skipped Android app rather than claiming both shipped"
else
  bad "the tag hides the skipped Android app"
  printf '%s\n' "$TAGMSG"
fi

# ---------------------------------------------------------------------------
# 22. EITHER Android build failing refuses the release before anything ships.
#     The whole reason 1c runs where it does is that a build failure there
#     costs nothing. That has to hold for the second app too, or the portal's
#     APK gets the "assembles after hosting went out" treatment the first one
#     was moved here to avoid.
# ---------------------------------------------------------------------------
D17="$(make_repo)"; write_stubs "$D17"
HEAD17="$(cd "$D17/repo" && git rev-parse HEAD)"
fixture_all_green "$D17/fixtures/$HEAD17"
RC="$(run_release "$D17" RELEASE_YES=1 RELEASE_ANDROID_TESTERS=a@b.test \
      GRADLE_FAIL=:assembleRelease FIREBASE_CALL_LOG="$D17/calls")"
OUT="$(cat "$D17/out")"
CALLS="$(cat "$D17/calls" 2>/dev/null || true)"
if [ "$RC" -eq 0 ]; then
  bad "a failed mytribe Android build did not stop the release"
elif printf '%s' "$OUT" | grep -q "REFUSED: the mytribe Android release APK did not build" &&
     printf '%s' "$OUT" | grep -q "RELEASE_SKIP_ANDROID_MYTRIBE=1"; then
  ok "a failed mytribe Android build refuses, names the app, and names its skip"
else
  bad "the refusal does not name the app that failed or how to skip it"
  printf '%s' "$OUT" | tail -20
fi
if printf '%s' "$CALLS" | grep -q "deploy"; then
  bad "a failed Android build refused only AFTER deploying something"
  printf '%s\n' "$CALLS" | head
else
  ok "nothing was deployed before the Android build refused"
fi

# ---------------------------------------------------------------------------
# 21. The minimum-bill refusal. Not a rate limit, and the old advice made it
# worse: on 2026-08-04 a 256MiB -> 512MiB fleet change was refused by
# firebase-tools once per batch, all 9 batches, all 3 rounds, and the closing
# diagnostic told the operator to retry smaller and slower. It cannot be
# retried smaller. These cases hold that line in both directions.
# ---------------------------------------------------------------------------
D15="$(make_repo)"; write_stubs "$D15"; arm_ci "$D15"

# A firebase that refuses exactly the way the real one did.
cat > "$D15/stubs/firebase" <<'STUB'
#!/usr/bin/env bash
echo "STUB firebase $*"
[ -n "${FIREBASE_CALL_LOG:-}" ] && echo "$*" >> "$FIREBASE_CALL_LOG"
case "$*" in
  *functions:mytribe:*)
    for a in "$@"; do
      # --force is the whole point: with it, the deploy is allowed through.
      if [ "$a" = "--force" ]; then echo "✔  functions[alpha(us-central1)] Successful update operation."; exit 0; fi
    done
    echo "Error: Pass the --force option to deploy functions that increase the minimum bill"
    exit 1 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$D15/stubs/firebase"

RC="$(run_release "$D15" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0)"
if grep -q 'raises the minimum bill' "$D15/out"; then
  ok "the minimum-bill refusal is named, not reported as a rate limit"
else
  bad "a minimum-bill refusal was not identified as one"
fi
if grep -q 'RELEASE_FUNCTIONS_FORCE=1' "$D15/out"; then
  ok "the refusal prints the flag that resolves it"
else
  bad "the refusal did not name RELEASE_FUNCTIONS_FORCE=1"
fi
if [ "$RC" != "0" ]; then
  ok "a refused functions deploy still fails the release"
else
  bad "a release whose functions were refused reported success"
fi

# The flag, when set, actually reaches firebase.
D16="$(make_repo)"; write_stubs "$D16"; arm_ci "$D16"
cp "$D15/stubs/firebase" "$D16/stubs/firebase"
run_release "$D16" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0 \
  RELEASE_FUNCTIONS_FORCE=1 FIREBASE_CALL_LOG="$D16/calls" >/dev/null
if grep -q -- '--force' "$D16/calls" 2>/dev/null; then
  ok "RELEASE_FUNCTIONS_FORCE=1 passes --force to the functions deploy"
else
  bad "RELEASE_FUNCTIONS_FORCE=1 did not reach firebase as --force"
fi

# And is genuinely off by default, since it also permits deletion.
D17="$(make_repo)"; write_stubs "$D17"; arm_ci "$D17"
run_release "$D17" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0 \
  FIREBASE_CALL_LOG="$D17/calls" >/dev/null
if grep -q -- '--force' "$D17/calls" 2>/dev/null; then
  bad "--force was passed without RELEASE_FUNCTIONS_FORCE being set"
else
  ok "--force is off unless asked for"
fi

# ---------------------------------------------------------------------------
# 18. The fleet verify (#503). The batch loop refuses when firebase SAYS a batch
# failed; this covers the case where it says nothing and the fleet disagrees.
# ---------------------------------------------------------------------------

# npm is stubbed to exit 0 everywhere else, so each case here overrides just the
# verify-deploy invocation and leaves every other npm call alone.
stub_npm_verify() {
  local dir="$1" rc="$2"
  cat > "$dir/stubs/npm" <<STUB
#!/usr/bin/env bash
echo "STUB npm \$*"
case "\$*" in
  *--verify-deploy*)
    echo "STUB verify-deploy rc=$rc"
    exit $rc ;;
esac
exit 0
STUB
  chmod +x "$dir/stubs/npm"
}

# A fleet read has to succeed for the checker to be consulted at all.
stub_npx_fleet() {
  printf '#!/usr/bin/env bash\necho "{\\"result\\":[]}"\nexit 0\n' > "$1/stubs/npx"
  chmod +x "$1/stubs/npx"
}

D18="$(make_repo)"; write_stubs "$D18"; arm_ci "$D18"
stub_npm_verify "$D18" 1
stub_npx_fleet "$D18"
RC18="$(run_release "$D18" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0)"
if [ "$RC18" != "0" ]; then
  ok "a fleet that disagrees with a successful deploy fails the release"
else
  bad "the release passed while the fleet verify refused"
fi
if grep -q "the fleet disagrees" "$D18/out"; then
  ok "the refusal says the deploy reported success and the fleet disagrees"
else
  bad "the fleet-verify refusal was not explained"
fi
if [ ! -f "$D18/repo/.release-state" ] || \
   [ "$(cat "$D18/repo/.release-state")" != "$(cd "$D18/repo" && git rev-parse HEAD)" ]; then
  ok "a refused fleet verify does not record the commit as released"
else
  bad ".release-state recorded a release the fleet verify refused"
fi

# Could-not-verify is NOT could-not-deploy. An unreadable answer is not evidence.
D19="$(make_repo)"; write_stubs "$D19"; arm_ci "$D19"
stub_npm_verify "$D19" 2
stub_npx_fleet "$D19"
RC19="$(run_release "$D19" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0)"
if [ "$RC19" = "0" ]; then
  ok "a fleet the verify could not read does not fail the release"
else
  bad "could-not-verify was treated as a failed deploy"
fi

# And the escape hatch, for the same reason every other gate here has one.
D20="$(make_repo)"; write_stubs "$D20"; arm_ci "$D20"
stub_npm_verify "$D20" 1
stub_npx_fleet "$D20"
RC20="$(run_release "$D20" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 \
  RELEASE_FUNCTIONS_BATCH=4 RELEASE_FUNCTIONS_SETTLE=0 \
  RELEASE_SKIP_FLEET_VERIFY=1)"
if [ "$RC20" = "0" ] && grep -q "RELEASE_SKIP_FLEET_VERIFY=1" "$D20/out"; then
  ok "RELEASE_SKIP_FLEET_VERIFY=1 skips the verify and says so"
else
  bad "RELEASE_SKIP_FLEET_VERIFY=1 did not skip the fleet verify"
fi
# ---------------------------------------------------------------------------
# Step 0c: the client build config the web bundles compile in.
#
# WHY THIS IS A RELEASE TEST AND NOT ONLY A UNIT TEST. The resolver's own
# branches are covered without gcloud in scripts/client-secrets.test.mjs. What
# only a release test can show is the ORDER: that the values are there when the
# build runs, that a missing one stops the run BEFORE anything is deployed, and
# that the file they were written into does not outlive the release.
# ---------------------------------------------------------------------------

# A store with everything: the release completes, and each app's build sees its
# OWN values. The two Sentry DSNs are different on purpose: auntieos-admin and
# mytribe-web are separate Sentry projects, which is the whole reason the config
# is written per app instead of exported once.
D="$(make_repo)"; write_stubs "$D"
secret_store "$D" "${FULL_STORE[@]}"
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1 \
        GCLOUD_SECRETS_DIR="$D/secrets" NPM_CLIENT_ENV_LOG="$D/clientenv")"
OUT="$(cat "$D/out")"
SEEN="$(cat "$D/clientenv" 2>/dev/null || true)"

if [ "$RC" -eq 0 ]; then
  ok "a release with every client secret stored completes"
else
  bad "a stored-complete release failed (rc $RC)"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "every declared VITE_\* value resolved"; then
  ok "step 0c says it resolved the client config"
else
  bad "step 0c never reported resolving the client config"
fi
if printf '%s' "$SEEN" | grep -q "auntieos-admin/.env.production.local VITE_SENTRY_DSN='https://examplepublickey@o0.ingest.us.sentry.io/0'"; then
  ok "the admin build sees the admin DSN, from the store"
else
  bad "the admin build did not see the admin DSN"; printf '%s\n' "$SEEN"
fi
if printf '%s' "$SEEN" | grep -q "mytribe/web/.env.production.local VITE_MAPBOX_PUBLIC_TOKEN='pk.example-not-a-real-token'"; then
  ok "the portal build sees the Mapbox token, from the store"
else
  bad "the portal build did not see the Mapbox token"; printf '%s\n' "$SEEN"
fi
if printf '%s' "$SEEN" | grep -q "auntieos-admin/.env.production.local VITE_MAPBOX_PUBLIC_TOKEN='pk.example-not-a-real-token-admin'"; then
  ok "the admin build sees its OWN Mapbox token, not the portal's"
else
  bad "the admin build did not see its own Mapbox token"; printf '%s\n' "$SEEN"
fi
# The one that a single exported environment could not have got right.
if printf '%s' "$SEEN" | grep -q "mytribe/web/.env.production.local VITE_SENTRY_DSN='https://examplepublickey@o0.ingest.us.sentry.io/1'"; then
  ok "each app gets its OWN VITE_SENTRY_DSN, not one shared value"
else
  bad "the portal did not get its own DSN"; printf '%s\n' "$SEEN"
fi
if printf '%s' "$SEEN" | grep -q "VITE_SENTRY_RELEASE='$(cd "$D/repo" && git rev-parse --short HEAD)'"; then
  ok "VITE_SENTRY_RELEASE is the commit being released, derived not stored"
else
  bad "VITE_SENTRY_RELEASE did not name the released commit"; printf '%s\n' "$SEEN"
fi
if [ -f "$D/repo/auntieos-admin/.env.production.local" ] ||
   [ -f "$D/repo/mytribe/web/.env.production.local" ]; then
  bad "the generated client config outlived the release"
else
  ok "the generated client config does not outlive the release"
fi
if printf '%s' "$SEEN" | grep -q "APPCHECK_DEBUG"; then
  bad "the App Check debug token reached a release build"
else
  ok "the App Check debug token never reaches a release build"
fi

# A REQUIRED value the store does not have. This is the refusal, and it has to
# happen before anything ships.
D="$(make_repo)"; write_stubs "$D"
secret_store "$D" ADMIN_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/0 \
                  PORTAL_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/1 \
                  ADMIN_WEB_APPCHECK_SITE_KEY=6LcEXAMPLE-not-a-real-site-key \
                  ADMIN_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token-admin
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
FCALLS="$D/firebase-calls"
RC="$(run_release "$D" RELEASE_YES=1 GCLOUD_SECRETS_DIR="$D/secrets" FIREBASE_CALL_LOG="$FCALLS")"
OUT="$(cat "$D/out")"

if [ "$RC" -ne 0 ]; then
  ok "a missing required client secret fails the release"
else
  bad "a missing required client secret did NOT fail the release"
fi
if printf '%s' "$OUT" | grep -q "VITE_MAPBOX_PUBLIC_TOKEN"; then
  ok "the refusal names the variable that has no value"
else
  bad "the refusal never named VITE_MAPBOX_PUBLIC_TOKEN"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "PORTAL_WEB_MAPBOX_PUBLIC_TOKEN"; then
  ok "the refusal names the Secret Manager secret to create"
else
  bad "the refusal never named the secret"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "gcloud secrets create PORTAL_WEB_MAPBOX_PUBLIC_TOKEN"; then
  ok "the refusal prints the command that fixes it"
else
  bad "the refusal printed no fix command"; echo "$OUT" | tail -25
fi
if [ -s "$FCALLS" ]; then
  bad "the refused release still called firebase"; cat "$FCALLS"
else
  ok "nothing was deployed before the client-config refusal"
fi

# A secret that EXISTS and is EMPTY. This is the failure the whole step is
# named after: the release would have compiled an empty string into the bundle
# and shipped it looking healthy.
D="$(make_repo)"; write_stubs "$D"
secret_store "$D" ADMIN_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/0 \
                  PORTAL_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/1 \
                  ADMIN_WEB_APPCHECK_SITE_KEY=6LcEXAMPLE-not-a-real-site-key \
                  ADMIN_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token-admin \
                  PORTAL_WEB_MAPBOX_PUBLIC_TOKEN=
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
RC="$(run_release "$D" RELEASE_YES=1 GCLOUD_SECRETS_DIR="$D/secrets")"
OUT="$(cat "$D/out")"

if [ "$RC" -ne 0 ]; then
  ok "a stored-but-empty client secret fails the release"
else
  bad "an EMPTY client secret shipped"
fi
if printf '%s' "$OUT" | grep -q "VITE_MAPBOX_PUBLIC_TOKEN (portal).*is empty"; then
  ok "the refusal says empty, not missing, and names the app"
else
  bad "the refusal did not distinguish empty from missing"; echo "$OUT" | tail -25
fi

# The admin App Check site key, which was warn-only until the reCAPTCHA
# Enterprise key existed and is required now that it does (minted and registered
# 2026-08-24). Its consumer is still unmerged (#587), which changes nothing here:
# the release resolves from the declaration, not from grepping usage.
D="$(make_repo)"; write_stubs "$D"
secret_store "$D" ADMIN_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/0 \
                  PORTAL_WEB_SENTRY_DSN=https://examplepublickey@o0.ingest.us.sentry.io/1 \
                  PORTAL_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token \
                  ADMIN_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token-admin
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
RC="$(run_release "$D" RELEASE_YES=1 GCLOUD_SECRETS_DIR="$D/secrets")"
OUT="$(cat "$D/out")"

if [ "$RC" -ne 0 ]; then
  ok "a missing admin App Check site key fails the release"
else
  bad "a missing admin App Check site key did NOT fail the release"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "VITE_ADMIN_APPCHECK_SITE_KEY (admin) <- ADMIN_WEB_APPCHECK_SITE_KEY"; then
  ok "the refusal names the build variable AND the secret behind it"
else
  bad "the refusal did not name both names"; echo "$OUT" | tail -25
fi
# The names are two namespaces and the operator acts on the second one. A
# refusal that told them to create a secret called VITE_... would have them
# store a value nothing ever fetches, which is the mistake that was already
# made once by hand.
if printf '%s' "$OUT" | grep -q "gcloud secrets create VITE_"; then
  bad "the refusal told the operator to create a VITE_-prefixed secret"
else
  ok "the refusal never names a VITE_-prefixed secret to create"
fi

# NEITHER SENTRY DSN IS SET, which is the live state of this product: both were
# checked on 2026-08-24 and both are empty, in the .env files and in the store.
# Web Sentry has never been switched on. A release must ship, name them, and not
# read as though something is broken.
D="$(make_repo)"; write_stubs "$D"
secret_store "$D" ADMIN_WEB_APPCHECK_SITE_KEY=6LcEXAMPLE-not-a-real-site-key \
                  PORTAL_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token \
                  ADMIN_WEB_MAPBOX_PUBLIC_TOKEN=pk.example-not-a-real-token-admin
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1 GCLOUD_SECRETS_DIR="$D/secrets")"
OUT="$(cat "$D/out")"

if [ "$RC" -eq 0 ]; then
  ok "a release with no Sentry DSN at all still ships"
else
  bad "an unset Sentry DSN stopped the release (rc $RC)"; echo "$OUT" | tail -25
fi
if [ "$(printf '%s' "$OUT" | grep -c "WARNING: VITE_SENTRY_DSN")" = "2" ]; then
  ok "both apps' missing DSNs are named, once each"
else
  bad "the missing DSNs were not both named"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "WARNING: VITE_SENTRY_DSN.*never been"; then
  ok "the warning says web Sentry has never been configured, not that it broke"
else
  bad "the warning does not say this is an accepted state"; echo "$OUT" | tail -25
fi

# The escape hatch, and it has to SAY it was used.
D="$(make_repo)"; write_stubs "$D"
secret_store "$D"
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1 RELEASE_SKIP_CLIENT_SECRETS=1 \
        GCLOUD_SECRETS_DIR="$D/secrets")"
OUT="$(cat "$D/out")"

if [ "$RC" -eq 0 ]; then
  ok "RELEASE_SKIP_CLIENT_SECRETS=1 skips step 0c"
else
  bad "RELEASE_SKIP_CLIENT_SECRETS=1 did not skip the refusal (rc $RC)"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "SKIPPED (RELEASE_SKIP_CLIENT_SECRETS=1)"; then
  ok "the skipped step says it was skipped"
else
  bad "the skip was silent"; echo "$OUT" | tail -25
fi

# A machine that cannot reach Secret Manager AND cannot read the apps' .env
# files (the shared stubs: gcloud exits 1, and the synthetic repo has no vite to
# load .env through). It knows nothing about these values, and the one thing it
# must not do is say they are fine. This is the shape of the 2026-07-26 secret
# incident in miniature: a check that prints green when it did not run.
D="$(make_repo)"; write_stubs "$D"
fixture_all_green "$D/fixtures/$(cd "$D/repo" && git rev-parse HEAD)"
RC="$(run_release "$D" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D/out")"

if [ "$RC" -eq 0 ]; then
  ok "an unreadable store does not fail the release"
else
  bad "an unreadable store failed the release (rc $RC)"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "client config: NOT CHECKED"; then
  ok "an unreadable store says the client config was NOT CHECKED"
else
  bad "an unreadable store did not say it could not look"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "every declared VITE_\* value resolved"; then
  bad "an unreadable store reported the client config as resolved"
else
  ok "an unreadable store never claims the client config resolved"
fi

# ---------------------------------------------------------------------------
# 23. Dependency drift (step 0a, #841). On 2026-09-13 a release tested
#     mytribe/web against a node_modules that predated a Dependabot bump
#     (vitest 4 -> 5, ~20 other packages, stripe in mytribe/functions) and
#     failed a test CI had already passed on the same commit. These cases
#     hold step 0a to refusing BEFORE step 1 runs, naming the drifted
#     directory and the exact `npm ci` command that fixes it, and to letting
#     a clean install (or one release.sh is not going to ship) straight
#     through.
# ---------------------------------------------------------------------------

# declare_dep <dir> <name> <version>: add <name> to <dir>'s package.json AND
# pin it in <dir>'s package-lock.json at <version>, so a later mismatched
# node_modules entry is real drift (a declared, locked dependency) rather
# than an "absent" package nobody asked for.
declare_dep() {
  local dir="$1" name="$2" version="$3"
  node -e '
    const fs = require("fs");
    const [, pjPath, lockPath, name, version] = process.argv;
    const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
    pj.dependencies = pj.dependencies || {};
    pj.dependencies[name] = "^" + version;
    fs.writeFileSync(pjPath, JSON.stringify(pj));
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.packages = lock.packages || {};
    lock.packages["node_modules/" + name] = { version };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
  ' "$dir/package.json" "$dir/package-lock.json" "$name" "$version"
}

# install_pkg <dir> <name> <version>: node_modules/<name> at <version>, in
# <dir>'s OWN node_modules: the standalone shape mytribe/functions and
# auntieos-admin/web/functions both use.
install_pkg() {
  mkdir -p "$1/node_modules/$2"
  printf '{ "name": "%s", "version": "%s" }\n' "$2" "$3" > "$1/node_modules/$2/package.json"
}

D20="$(make_repo)"; write_stubs "$D20"
declare_dep "$D20/repo/mytribe/functions" stripe 18.5.0
commit_all "$D20"
install_pkg "$D20/repo/mytribe/functions" stripe 17.0.0
arm_ci "$D20"
RC="$(run_release "$D20" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 FIREBASE_CALL_LOG="$D20/calls")"
OUT="$(cat "$D20/out")"
if [ "$RC" -ne 0 ]; then
  ok "dependency drift in mytribe/functions refuses the release"
else
  bad "dependency drift did not refuse the release"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "mytribe/functions" && printf '%s' "$OUT" | grep -q "stripe"; then
  ok "the refusal names the drifted directory and package"
else
  bad "the refusal did not name mytribe/functions or stripe"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "npm ci --prefix mytribe/functions"; then
  ok "the refusal prints the exact npm ci command that fixes it"
else
  bad "the refusal did not print the fix command"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -qi "1\. Check"; then
  bad "step 1 ran despite the dependency drift refusal"
else
  ok "step 1 never ran; the release stopped at step 0a, before anything built"
fi
if [ -n "$(cat "$D20/calls" 2>/dev/null)" ]; then
  bad "something reached firebase despite the drift refusal"
else
  ok "nothing was deployed before the drift refusal"
fi
# Step 0a sits BEFORE the "release this commit?" confirm now, precisely so an
# operator who says yes is not then told no. RELEASE_YES=1 prints "continuing
# without prompting" the moment confirm() runs; its total absence here proves
# confirm never ran at all, i.e. the refusal really did land before it.
if printf '%s' "$OUT" | grep -q "continuing without prompting"; then
  bad "the release prompted for confirmation before refusing on dependency drift"
else
  ok "the release never reaches the confirm prompt when drift refuses it"
fi

# ---------------------------------------------------------------------------
# 24. The workspace root drifting (vitest's half of the incident) refuses the
#     same way, naming the plain `npm ci` that fixes the root install.
# ---------------------------------------------------------------------------
D21="$(make_repo)"; write_stubs "$D21"
# vitest is declared by a WORKSPACE MEMBER (mytribe/web), pinned in the ROOT
# lockfile, and installed (mismatched) in the ROOT node_modules: the exact
# hoisted shape a real `npm install` leaves, and the half of the 2026-09-13
# incident the standalone mytribe/functions case above does not cover.
mkdir -p "$D21/repo/mytribe/web"
printf '{ "name": "mytribe-web", "dependencies": { "vitest": "^5.0.0" } }\n' \
  > "$D21/repo/mytribe/web/package.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(p, "utf8"));
  lock.packages = lock.packages || {};
  lock.packages["node_modules/vitest"] = { version: "5.0.0" };
  fs.writeFileSync(p, JSON.stringify(lock));
' "$D21/repo/package-lock.json"
commit_all "$D21"
install_pkg "$D21/repo" vitest 4.1.11
arm_ci "$D21"
RC="$(run_release "$D21" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 FIREBASE_CALL_LOG="$D21/calls")"
OUT="$(cat "$D21/out")"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "vitest"; then
  ok "workspace root drift refuses the release and names the package"
else
  bad "workspace root drift did not refuse (rc $RC)"; echo "$OUT" | tail -25
fi
# Strip ANSI color codes before anchoring on a whole line: red() wraps the
# printed line in an escape prefix/suffix, so `^...$` never matches the raw
# text otherwise.
PLAIN="$(printf '%s' "$OUT" | sed -E $'s/\x1b\\[[0-9;]*m//g')"
if printf '%s' "$PLAIN" | grep -qE '^ *npm ci *$'; then
  ok "the workspace refusal prints the plain 'npm ci' fix, not a --prefix'd one"
else
  bad "the workspace refusal did not print bare 'npm ci'"; echo "$OUT" | tail -25
fi
# A workspace MEMBER never has its own lockfile, and that is normal, not a
# defect, since the three of them share the root's. `npm ci` run INSIDE one
# (e.g. `npm ci --prefix mytribe/web`) is a real, separate incident: it exits
# 0 and SILENTLY DROPS whatever that member does not carry in its own
# (nonexistent) lockfile, which is not the same tree `npm ci` at the root
# produces. So the fix this step prints must never suggest running npm
# inside mytribe/web, auntieos-admin, or packages/geo, only at the root.
if printf '%s' "$OUT" | grep -qE -- '--prefix (mytribe/web|auntieos-admin|packages/geo)\b'; then
  bad "the workspace refusal named npm ci --prefix inside a workspace MEMBER"
  echo "$OUT" | tail -25
else
  ok "the fix never suggests npm ci --prefix inside a workspace member"
fi

# ---------------------------------------------------------------------------
# 24b. A garbage/truncated lockfile is UNREADABLE, not clean. A caught-and-
#      swallowed parse error used to print nothing and look identical to no
#      drift at all, which would have let a release ship against a tree
#      nothing had actually verified.
# ---------------------------------------------------------------------------
D21B="$(make_repo)"; write_stubs "$D21B"
# node_modules must actually EXIST for the check to read anything at all: an
# absent node_modules is the ordinary "not installed yet" state and returns
# before ever opening the lockfile, which would make this test pass for the
# wrong reason (never reaching the corrupt file).
mkdir -p "$D21B/repo/mytribe/functions/node_modules"
printf 'this is not json' > "$D21B/repo/mytribe/functions/package-lock.json"
commit_all "$D21B"
arm_ci "$D21B"
RC="$(run_release "$D21B" RELEASE_YES=1 RELEASE_SKIP_ANDROID=1 FIREBASE_CALL_LOG="$D21B/calls")"
OUT="$(cat "$D21B/out")"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi "cannot be checked\|not valid JSON"; then
  ok "an unreadable (garbage) lockfile refuses the release rather than reporting clean"
else
  bad "a garbage lockfile did not refuse the release; rc=$RC"; echo "$OUT" | tail -25
fi
if printf '%s' "$OUT" | grep -q "mytribe/functions matches its lockfile"; then
  bad "a garbage lockfile was reported as matching (clean)"
else
  ok "a garbage lockfile is never reported as matching"
fi
if [ -n "$(cat "$D21B/calls" 2>/dev/null)" ]; then
  bad "something reached firebase despite the unreadable-lockfile refusal"
else
  ok "nothing was deployed before the unreadable-lockfile refusal"
fi

# ---------------------------------------------------------------------------
# 25. No drift -> the release proceeds. Every case above this one that ran
#     with no drift declared (an absent node_modules, reported "not installed
#     yet") already passed, which covers the common case; this is the OTHER
#     passing state, a real install that matches its lockfile, asserted
#     explicitly so a future change cannot silently stop reporting it while
#     those other cases stay green for an unrelated reason.
# ---------------------------------------------------------------------------
D22="$(make_repo)"; write_stubs "$D22"
declare_dep "$D22/repo/mytribe/functions" stripe 18.5.0
mkdir -p "$D22/repo/mytribe/web"
printf '{ "name": "mytribe-web", "dependencies": { "vitest": "^5.0.0" } }\n' \
  > "$D22/repo/mytribe/web/package.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(p, "utf8"));
  lock.packages = lock.packages || {};
  lock.packages["node_modules/vitest"] = { version: "5.0.0" };
  fs.writeFileSync(p, JSON.stringify(lock));
' "$D22/repo/package-lock.json"
commit_all "$D22"
install_pkg "$D22/repo/mytribe/functions" stripe 18.5.0
install_pkg "$D22/repo" vitest 5.0.0
arm_ci "$D22"
RC="$(run_release "$D22" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D22/out")"
if [ "$RC" -eq 0 ] &&
   printf '%s' "$OUT" | grep -q "mytribe/functions matches its lockfile" &&
   printf '%s' "$OUT" | grep -q "workspace root (every npm workspace member) matches its lockfile"; then
  ok "a clean, fully-installed tree reports matching both units and does not block the release"
else
  bad "a clean install did not report as matching"; echo "$OUT" | tail -25
fi

# ---------------------------------------------------------------------------
# 26. auntieos-admin/web/functions drift is checked ONLY under
#     RELEASE_INCLUDE_ADMIN_FUNCTIONS=1, the flag that actually builds and
#     deploys it (step 5's neighbour). Off, this run is not touching that
#     codebase, so its drift must not block releases that never read it.
# ---------------------------------------------------------------------------
add_admin_functions() {
  local dir="$1"
  mkdir -p "$dir/auntieos-admin/web/functions"
  printf '{ "name": "auntieos-functions", "dependencies": {} }\n' \
    > "$dir/auntieos-admin/web/functions/package.json"
  printf '{ "name": "auntieos-functions", "lockfileVersion": 3, "packages": {} }\n' \
    > "$dir/auntieos-admin/web/functions/package-lock.json"
}

D23="$(make_repo)"; write_stubs "$D23"
add_admin_functions "$D23/repo"
declare_dep "$D23/repo/auntieos-admin/web/functions" "@anthropic-ai/sdk" 0.124.0
commit_all "$D23"
install_pkg "$D23/repo/auntieos-admin/web/functions" "@anthropic-ai/sdk" 0.100.0
arm_ci "$D23"
RC="$(run_release "$D23" DRY_RUN=1 RELEASE_YES=1)"
OUT="$(cat "$D23/out")"
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "NOT CHECKED"; then
  ok "admin-functions drift is not checked when RELEASE_INCLUDE_ADMIN_FUNCTIONS is off"
else
  bad "an unchecked admin-functions codebase blocked (or stopped saying so); rc=$RC"
  echo "$OUT" | tail -25
fi

RC="$(run_release "$D23" DRY_RUN=1 RELEASE_YES=1 RELEASE_INCLUDE_ADMIN_FUNCTIONS=1)"
OUT="$(cat "$D23/out")"
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -q "auntieos-admin/web/functions" &&
   printf '%s' "$OUT" | grep -q "npm ci --prefix auntieos-admin/web/functions"; then
  ok "the same drift refuses once RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 actually ships it"
else
  bad "RELEASE_INCLUDE_ADMIN_FUNCTIONS=1 did not catch the admin-functions drift"
  echo "$OUT" | tail -25
fi

echo
echo "release tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
