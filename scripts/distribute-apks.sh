#!/usr/bin/env bash
# distribute-apks.sh: push both debug-signed test APKs to Firebase App Distribution.
# Run this yourself (the auto-mode classifier blocks the agent from distributing).
#   bash scripts/distribute-apks.sh
# Testers get an email install link. Both APKs are DEBUG-signed test builds
# (no release keystore in the build env); fine for sideload/testing, not Play.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
PROJECT="auntieos-ttpc"
TESTERS="${TESTERS:-neesdees@gmail.com}"

AUNTIEOS_APK="$ROOT/auntieos-admin/android/app/build/outputs/apk/release/app-release.apk"
AUNTIEOS_APP="1:153396971788:android:6bcb7c5411aeda837f2129"

MYTRIBE_APK="$ROOT/mytribe/build/outputs/apk/release/kinfolk-portal-release.apk"
MYTRIBE_APP="1:153396971788:android:4e9868bbb96301277f2129"

echo "==> AuntieOS operator app (v277)"
firebase appdistribution:distribute "$AUNTIEOS_APK" \
  --app "$AUNTIEOS_APP" --testers "$TESTERS" --project "$PROJECT" \
  --release-notes "AuntieOS operator v277 (0.2.0.277) 2026-07-22 - live-test Auntie Time + GPS live tracking. Debug-signed."

echo "==> MyTribe Kinfolk app (v2)"
firebase appdistribution:distribute "$MYTRIBE_APK" \
  --app "$MYTRIBE_APP" --testers "$TESTERS" --project "$PROJECT" \
  --release-notes "MyTribe Kinfolk v2 (0.2.0) 2026-07-22 test build. Debug-signed."

echo "Done. Check your inbox ($TESTERS) for the App Distribution install links."
