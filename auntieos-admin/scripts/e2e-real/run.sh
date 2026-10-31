#!/usr/bin/env bash
# The real-services Cypress run (#1089, operator ruling D3, 2026-10-01).
# `npm run e2e:real` from auntieos-admin. See docs/runbooks/e2e.md,
# "The real-services run".
#
# Order matters and each step is a lock:
#   1. build mytribe/functions, because the emulator serves lib/, not src/,
#      and check the admin's own codebase (web/functions, plain JS, no build)
#      is installed: the emulator serves both (#1201);
#   2. preflight: fill any unset Cloudinary, smtp2go or Google OAuth E2E_*
#      variable from Secret Manager by allowlisted name (secret-manager.mjs,
#      #1264; the only Secret Manager read in the run), then write a
#      .secret.local into EACH codebase from the environment, or refuse (non-test Stripe key, a business or private
#      phone number, a spec that could press Google Calendar Disconnect);
#   3. boot auth + Firestore + functions under a demo- project id, so no
#      secret lookup can reach production Secret Manager;
#   4. run cypress.real.config.ts against a dev server pointed at all three;
#   5. classify the run (classify-run.mjs, D3-e): cypress/.real/verdict.json
#      says stop, warn or pass, and this script exits 1 on stop, 0 otherwise;
#   6. whatever happened: empty the Cloudinary e2e/ folder
#      (cloudinary-cleanup.mjs) and delete both secrets files. Neither can
#      change the exit code the run already has.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ADMIN_DIR" || exit 1
FUNCTIONS_DIR="$(cd "$ADMIN_DIR/../mytribe/functions" && pwd)"
# The admin's own codebase: signCloudinaryUpload and generateAuntieCopy, the
# targets of /api/cloudinary/sign-upload and /api/generate (#1201).
ADMIN_FUNCTIONS_DIR="$ADMIN_DIR/web/functions"
# One per codebase: the emulator reads the file in each function's own source
# directory, so a key in one does nothing for the other.
SECRETS_FILES=("$FUNCTIONS_DIR/.secret.local" "$ADMIN_FUNCTIONS_DIR/.secret.local")
REAL_DIR="$ADMIN_DIR/cypress/.real"
LOG="$REAL_DIR/emulators.log"
RESULTS="$REAL_DIR/results.json"
VERDICT="$REAL_DIR/verdict.json"

# One place for both. A demo- id is the lock; the port is the one
# e2e.real.firebase.json serves functions on, checked below so they cannot drift.
export E2E_PROJECT_ID="demo-auntieos-e2e"
export E2E_FUNCTIONS_PORT="5398"

# CREDENTIALS ARE NOT HIDDEN, and that is why the two locks above carry the
# weight. On a developer machine firebase-tools finds Application Default
# Credentials and warns that "non-emulated services will access production";
# hiding them does not help, because with no ADC it hands the emulator the
# `firebase login` account's credentials instead (env.js,
# getCredentialsEnvironment, firebase-tools 15.18.0). Checked 2026-10-02. What
# keeps production out is the demo- id (no real project to address) and a
# secrets file with every declared key in it (no Secret Manager lookup at all).
# CI authenticates through Workload Identity only for the explicit read in
# secret-manager.mjs (#1264), and drops those credentials before this script
# runs, so its emulator has neither ADC nor a login.

# Runs on every exit, early refusals included, and keeps the exit code it was
# handed: a failed cleanup is printed, never turned into the run's verdict.
on_exit() {
  local status=$?
  set +e
  # A run that stopped before Cypress still leaves a verdict for the release
  # to read. No results file classifies as `stop`.
  if [ -d "$REAL_DIR" ] && [ ! -f "$VERDICT" ]; then
    node "$SCRIPT_DIR/classify-run.mjs" --results "$RESULTS" --log "$LOG" --out "$VERDICT" --cypress-exit "$status" >/dev/null
  fi
  # Uploads from this run (D3: "an e2e/ folder, emptied at the end of each run").
  if ! node "$SCRIPT_DIR/cloudinary-cleanup.mjs"; then
    echo "== e2e-real: Cloudinary cleanup FAILED, e2e/ may still hold this run's uploads. Exit code unchanged ($status)." >&2
  fi
  # Only a file this run wrote. preflight.mjs refuses to replace any other.
  local secrets_file
  for secrets_file in "${SECRETS_FILES[@]}"; do
    if [ -f "$secrets_file" ] && head -1 "$secrets_file" | grep -q 'scripts/e2e-real/preflight.mjs'; then
      rm -f "$secrets_file"
    fi
  done
  exit "$status"
}

mkdir -p "$REAL_DIR"
# A results or verdict file from an earlier run must never be read as this one's.
rm -f "$RESULTS" "$VERDICT"
trap on_exit EXIT

# After the trap, so this refusal also leaves a `stop` verdict behind.
CONFIG_PORT="$(node -p "require('./e2e.real.firebase.json').emulators.functions.port")"
if [ "$CONFIG_PORT" != "$E2E_FUNCTIONS_PORT" ]; then
  echo "e2e.real.firebase.json serves functions on $CONFIG_PORT, run.sh expects $E2E_FUNCTIONS_PORT" >&2
  exit 1
fi

: > "$LOG"
export E2E_SERVER_LOG="$LOG"
# The seed's per-call deadline (e2e/seed.ts). 10s is right for bare emulators;
# here every seeded account runs the real beforeSignIn blocking function and
# onAuthUserCreate inside the signUp call, and the first of each cold-starts.
# Measured at ~3s each on a loaded laptop, which put the first signUp past 10s.
export E2E_SEED_TIMEOUT_MS="${E2E_SEED_TIMEOUT_MS:-60000}"

echo "== e2e-real: building mytribe/functions"
npm --prefix "$FUNCTIONS_DIR" run build

# Not a root workspace, so the root `npm ci` does not install it. Refused here
# by name rather than left to the emulator, which would report every function
# in the codebase as failing to load.
if [ ! -d "$ADMIN_FUNCTIONS_DIR/node_modules" ]; then
  echo "$ADMIN_FUNCTIONS_DIR/node_modules does not exist. Install it first: npm ci --prefix web/functions" >&2
  exit 1
fi

# #1264: the Cloudinary, smtp2go and Google OAuth values from Secret Manager
# (auntieos-ttpc), by allowlisted name, for any E2E_* variable still unset. On
# this machine that is gcloud's own login. No gcloud, no login or a refused
# read leaves the variable unset and the vendor skips. Nothing is written to
# disk: the script prints `export` lines and they are evaluated here. In CI the
# workflow has already read them and set E2E_SECRET_MANAGER=done.
echo "== e2e-real: vendor values from Secret Manager"
sm_exports="$(node "$SCRIPT_DIR/secret-manager.mjs" --shell)"
eval "$sm_exports"
unset sm_exports

echo "== e2e-real: preflight"
node scripts/e2e-real/preflight.mjs "$ADMIN_DIR/cypress/e2e-real" "$REAL_DIR/vendors.json" "$FUNCTIONS_DIR" "$ADMIN_FUNCTIONS_DIR"

echo "== e2e-real: type-checking specs"
npm run e2e:cy:tsc

echo "== e2e-real: emulators (auth, firestore, functions: mytribe + default) under $E2E_PROJECT_ID"
# Output is teed into $LOG because the Cypress tasks read it: a trigger that
# fails after the screen has its answer is only visible there. bash's own
# PIPESTATUS, so the verdict is firebase's exit code and not tee's.
set +e
firebase emulators:exec \
  --project "$E2E_PROJECT_ID" \
  --only auth,firestore,functions \
  --config e2e.real.firebase.json \
  "npm run e2e:real:run" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
set -e
echo "== e2e-real: Cypress exit $status"

# D3-e. Our integration failing stops the release; a vendor outage (a 5xx or
# timeout while its status page lists an incident) only warns. The classifier
# writes $VERDICT and exits 1 on stop, 0 on warn (after a WARNING block) and
# on pass. Its exit code is this run's.
echo "== e2e-real: classifying the run"
set +e
node "$SCRIPT_DIR/classify-run.mjs" --results "$RESULTS" --log "$LOG" --out "$VERDICT" --cypress-exit "$status"
verdict_status=$?
set -e
exit "$verdict_status"
