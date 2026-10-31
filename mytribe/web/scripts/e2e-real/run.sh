#!/usr/bin/env bash
# The portal's real-services Cypress run (#1194, operator ruling D3, 2026-10-01).
# `npm run e2e:real` from mytribe/web. See auntieos-admin/docs/runbooks/e2e.md,
# "The portal's real-services run". Mirrors auntieos-admin/scripts/e2e-real/run.sh.
#
# Order matters and each step is a lock:
#   1. build mytribe/functions, because the emulator serves lib/, not src/;
#   2. start the Stripe webhook forwarder, when the Stripe CLI and test keys are
#      present, because its signing secret has to be in the secrets file before
#      the emulator boots;
#   3. preflight: fill unset Cloudinary, smtp2go and Google OAuth E2E_*
#      variables from Secret Manager by the admin's allowlist (#1264), then
#      write mytribe/functions/.secret.local from the environment,
#      or refuse (non-test Stripe key, a business or private phone number, a
#      spec that could press Google Calendar Disconnect);
#   4. boot auth + Firestore + functions under a demo- project id, so no
#      secret lookup can reach production Secret Manager;
#   5. run cypress.real.config.ts against a dev server pointed at all three;
#   6. stop the forwarder and delete the secrets file whatever happened.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WEB_DIR" || exit 1
MYTRIBE_DIR="$(cd "$WEB_DIR/.." && pwd)"
FUNCTIONS_DIR="$MYTRIBE_DIR/functions"
SECRETS_FILE="$FUNCTIONS_DIR/.secret.local"
FIREBASE_CONFIG="$MYTRIBE_DIR/e2e.real.firebase.json"
REAL_DIR="$WEB_DIR/cypress/.real"
LOG="$REAL_DIR/emulators.log"
STRIPE_LOG="$REAL_DIR/stripe-listen.log"

# One place for both. A demo- id is the lock; the port is the one
# e2e.real.firebase.json serves functions on, checked below so they cannot drift.
export E2E_PROJECT_ID="demo-mytribe-e2e"
export E2E_FUNCTIONS_PORT="5498"
CONFIG_PORT="$(node -p "require('$FIREBASE_CONFIG').emulators.functions.port")"
if [ "$CONFIG_PORT" != "$E2E_FUNCTIONS_PORT" ]; then
  echo "e2e.real.firebase.json serves functions on $CONFIG_PORT, run.sh expects $E2E_FUNCTIONS_PORT" >&2
  exit 1
fi
WEBHOOK_URL="http://127.0.0.1:$E2E_FUNCTIONS_PORT/$E2E_PROJECT_ID/us-central1/stripeWebhook"

# CREDENTIALS ARE NOT HIDDEN. Same reasoning as the admin run.sh: with no ADC,
# firebase-tools hands the emulator the `firebase login` account instead, so
# hiding them protects nothing. The demo- id and a secrets file with every
# declared key in it are what keep production out. CI authenticates only for
# the explicit Secret Manager read (#1264) and drops the credentials before
# this script runs.

STRIPE_PID=""
cleanup() {
  if [ -n "$STRIPE_PID" ]; then
    kill "$STRIPE_PID" 2>/dev/null || true
  fi
  # Only a file an e2e-real preflight wrote. The preflight refuses to replace
  # any other.
  if [ -f "$SECRETS_FILE" ] && head -1 "$SECRETS_FILE" | grep -q 'scripts/e2e-real/preflight.mjs'; then
    rm -f "$SECRETS_FILE"
  fi
}
trap cleanup EXIT

mkdir -p "$REAL_DIR"
: > "$LOG"
export E2E_SERVER_LOG="$LOG"
# The seed's per-call deadline (cypress/seed.ts). Every seeded account runs the
# real beforeSignIn and onAuthUserCreate inside its signUp, and the first of
# each cold-starts; the admin measured ~3s each on a loaded laptop.
export E2E_SEED_TIMEOUT_MS="${E2E_SEED_TIMEOUT_MS:-60000}"

echo "== e2e-real (portal): building mytribe/functions"
npm --prefix "$FUNCTIONS_DIR" run build

# THE STRIPE WEBHOOK FORWARDER (D3-b: "webhook secret from `stripe listen` per
# run"). Paying an invoice is settled by stripeWebhook, which Stripe cannot
# reach on 127.0.0.1, so `stripe listen` relays test-mode events to the
# emulator and signs them with a secret of its own. That secret has to be in
# .secret.local before the emulator boots, so the forwarder starts here, before
# the preflight, and the secret is read from its first line of output.
#
# Skipped, with the reason printed, when the CLI or the test key is missing.
# The pay spec then skips on the `stripeWebhook` flag the preflight writes.
unset STRIPE_TEST_WEBHOOK_SECRET
KEY="${STRIPE_TEST_SECRET_KEY:-}"
if [ -z "$KEY" ]; then
  echo "== e2e-real (portal): no STRIPE_TEST_SECRET_KEY, so no webhook forwarder; the Stripe spec skips"
elif ! command -v stripe >/dev/null 2>&1; then
  echo "== e2e-real (portal): Stripe CLI not on PATH, so no webhook forwarder; the Stripe spec skips"
else
  case "$KEY" in
    sk_test_*|rk_test_*) ;;
    *)
      # Refused here as well as in the preflight, because the CLI would be
      # handed the key before the preflight ever saw it.
      echo "REFUSED: STRIPE_TEST_SECRET_KEY is not a test-mode key; not starting stripe listen" >&2
      exit 1
      ;;
  esac
  echo "== e2e-real (portal): stripe listen -> $WEBHOOK_URL"
  : > "$STRIPE_LOG"
  # The key goes in the environment, not on the command line, so it is not in
  # the process list. Only the two events stripeWebhook settles a card payment
  # from are forwarded.
  STRIPE_API_KEY="$KEY" stripe listen \
    --events checkout.session.completed,payment_intent.succeeded \
    --forward-to "$WEBHOOK_URL" >"$STRIPE_LOG" 2>&1 &
  STRIPE_PID=$!
  secret=""
  for _ in $(seq 1 30); do
    secret="$(grep -o 'whsec_[A-Za-z0-9]*' "$STRIPE_LOG" | head -1 || true)"
    [ -n "$secret" ] && break
    if ! kill -0 "$STRIPE_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ -z "$secret" ]; then
    echo "stripe listen did not print a signing secret within 30s. Its output:" >&2
    cat "$STRIPE_LOG" >&2
    exit 1
  fi
  export STRIPE_TEST_WEBHOOK_SECRET="$secret"
  echo "== e2e-real (portal): webhook forwarder up (signing secret read from stripe listen)"
fi

# #1264: the Cloudinary, smtp2go and Google OAuth values from Secret Manager,
# by the admin's allowlist (one list for both runs), for any E2E_* variable
# still unset. Same failure rule: no gcloud or a refused read leaves it unset
# and the vendor skips. Printed as `export` lines and evaluated, never written
# to disk. In CI the workflow has already read them.
echo "== e2e-real (portal): vendor values from Secret Manager"
sm_exports="$(node "$MYTRIBE_DIR/../auntieos-admin/scripts/e2e-real/secret-manager.mjs" --shell)"
eval "$sm_exports"
unset sm_exports

echo "== e2e-real (portal): preflight"
node scripts/e2e-real/preflight.mjs "$FUNCTIONS_DIR" "$WEB_DIR/cypress/e2e-real" "$REAL_DIR/vendors.json"

echo "== e2e-real (portal): type-checking specs"
npm run e2e:cy:tsc

echo "== e2e-real (portal): emulators (auth, firestore, functions) under $E2E_PROJECT_ID"
# Output is teed into $LOG because the Cypress tasks read it: a trigger that
# fails after the screen has its answer is only visible there. bash's own
# PIPESTATUS, so the verdict is firebase's exit code and not tee's.
set +e
firebase emulators:exec \
  --project "$E2E_PROJECT_ID" \
  --only auth,firestore,functions \
  --config "$FIREBASE_CONFIG" \
  "npm run e2e:real:run" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
set -e
echo "== e2e-real (portal): exit $status"
exit "$status"
