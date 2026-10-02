#!/usr/bin/env bash
# The real-services Cypress run (#1089, operator ruling D3, 2026-10-01).
# `npm run e2e:real` from auntieos-admin. See docs/runbooks/e2e.md,
# "The real-services run".
#
# Order matters and each step is a lock:
#   1. build mytribe/functions, because the emulator serves lib/, not src/;
#   2. preflight: write mytribe/functions/.secret.local from the environment,
#      or refuse (non-test Stripe key, a business or private phone number, a
#      spec that could press Google Calendar Disconnect);
#   3. boot auth + Firestore + functions under a demo- project id, so no
#      secret lookup can reach production Secret Manager;
#   4. run cypress.real.config.ts against a dev server pointed at all three;
#   5. delete the secrets file whatever happened.
set -euo pipefail

ADMIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ADMIN_DIR" || exit 1
FUNCTIONS_DIR="$(cd "$ADMIN_DIR/../mytribe/functions" && pwd)"
SECRETS_FILE="$FUNCTIONS_DIR/.secret.local"
REAL_DIR="$ADMIN_DIR/cypress/.real"
LOG="$REAL_DIR/emulators.log"

# One place for both. A demo- id is the lock; the port is the one
# e2e.real.firebase.json serves functions on, checked below so they cannot drift.
export E2E_PROJECT_ID="demo-auntieos-e2e"
export E2E_FUNCTIONS_PORT="5398"
CONFIG_PORT="$(node -p "require('./e2e.real.firebase.json').emulators.functions.port")"
if [ "$CONFIG_PORT" != "$E2E_FUNCTIONS_PORT" ]; then
  echo "e2e.real.firebase.json serves functions on $CONFIG_PORT, run.sh expects $E2E_FUNCTIONS_PORT" >&2
  exit 1
fi

# CREDENTIALS ARE NOT HIDDEN, and that is why the two locks above carry the
# weight. On a developer machine firebase-tools finds Application Default
# Credentials and warns that "non-emulated services will access production";
# hiding them does not help, because with no ADC it hands the emulator the
# `firebase login` account's credentials instead (env.js,
# getCredentialsEnvironment, firebase-tools 15.18.0). Checked 2026-10-02. What
# keeps production out is the demo- id (no real project to address) and a
# secrets file with every declared key in it (no Secret Manager lookup at all).
# CI has neither ADC nor a login.

cleanup() {
  # Only a file this run wrote. preflight.mjs refuses to replace any other.
  if [ -f "$SECRETS_FILE" ] && head -1 "$SECRETS_FILE" | grep -q 'scripts/e2e-real/preflight.mjs'; then
    rm -f "$SECRETS_FILE"
  fi
}
trap cleanup EXIT

mkdir -p "$REAL_DIR"
: > "$LOG"
export E2E_SERVER_LOG="$LOG"
# The seed's per-call deadline (e2e/seed.ts). 10s is right for bare emulators;
# here every seeded account runs the real beforeSignIn blocking function and
# onAuthUserCreate inside the signUp call, and the first of each cold-starts.
# Measured at ~3s each on a loaded laptop, which put the first signUp past 10s.
export E2E_SEED_TIMEOUT_MS="${E2E_SEED_TIMEOUT_MS:-60000}"

echo "== e2e-real: building mytribe/functions"
npm --prefix "$FUNCTIONS_DIR" run build

echo "== e2e-real: preflight"
node scripts/e2e-real/preflight.mjs "$FUNCTIONS_DIR" "$ADMIN_DIR/cypress/e2e-real" "$REAL_DIR/vendors.json"

echo "== e2e-real: type-checking specs"
npm run e2e:cy:tsc

echo "== e2e-real: emulators (auth, firestore, functions) under $E2E_PROJECT_ID"
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
echo "== e2e-real: exit $status"
exit "$status"
