"""Backfill kin_care_reports.reconcileStatus = 'pending' on docs missing the field.

WARNING-32 (verified 2026-06-22): the nightly reconcile pass now queries every
comm collection — INCLUDING kin_care_reports — with
`.where('reconcileStatus','==','pending').limit(budget)`, matching the other
four collections. Legacy kin_care_reports docs created before reconcileStatus
existed have NO such field, so the equality filter would skip them forever and
they would never be folded into the dossier / the_411.

This one-off pass sets reconcileStatus='pending' on every kin_care_reports doc
that is MISSING the field (it never touches docs that already have ANY value —
applied / skipped / error / in_progress / partial / pending are all left alone),
so the field-equality query reaches them on the next nightly run.

Idempotent: a second run finds nothing to do (every doc now has the field).
Reversible-ish: writes a `_reconcileStatusBackfillAt` marker so backfilled docs
are identifiable. Never touches `_demo:true` docs.

DO NOT auto-run. The operator runs migrations.

  Dry run (default):   python3 backfill_kincare_reconcile_status.py
  Commit to prod:      GCLOUD_PROJECT=auntieos-ttpc python3 backfill_kincare_reconcile_status.py --allow-prod
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

# This script lives in web/functions-python/, so the service account JSON (kept
# one level above the AuntieOS root) is three parents up — same path the
# canonical reconcile_comms.py resolves.
PROJECT_ROOT     = Path(__file__).resolve().parent.parent.parent
SERVICE_ACCOUNT  = PROJECT_ROOT / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"
COLLECTION       = "kin_care_reports"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def needs_backfill(d: dict) -> bool:
    """True only when reconcileStatus is entirely ABSENT.

    A present-but-empty-string value is left alone (treat as operator intent /
    not our call to overwrite). The reconcile pass's pending query keys off the
    exact string 'pending', so a missing field is the only case that starves a
    doc forever; that is the only case we repair here.
    """
    return "reconcileStatus" not in d


def init_firebase(allow_prod: bool):
    if allow_prod and os.environ.get("GCLOUD_PROJECT") != EXPECTED_PROJECT:
        sys.exit(f"[reconcileStatus] Refusing prod write: GCLOUD_PROJECT != '{EXPECTED_PROJECT}'.")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[reconcileStatus] Service account not found: {SERVICE_ACCOUNT}")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-prod", action="store_true", help="commit writes to prod")
    ap.add_argument("--limit", type=int, default=0, help="cap docs backfilled (0 = all)")
    args = ap.parse_args()
    dry = not args.allow_prod

    db = init_firebase(args.allow_prod)
    now = utc_now_iso()

    total = already = demo = backfilled = 0
    samples: list[str] = []

    for doc in db.collection(COLLECTION).stream():
        total += 1
        d = doc.to_dict() or {}
        if d.get("_demo") is True:
            demo += 1
            continue
        if not needs_backfill(d):
            already += 1
            continue
        backfilled += 1
        if len(samples) < 12:
            samples.append(f"  {doc.id}: reconcileStatus (absent) -> 'pending'")
        if not dry:
            doc.reference.update({
                "reconcileStatus": "pending",
                "_reconcileStatusBackfillAt": now,
            })
        if args.limit and backfilled >= args.limit:
            break

    mode = "DRY RUN (no writes)" if dry else "PROD WRITE COMMITTED"
    print(f"\n[reconcileStatus] {mode}  (collection: {COLLECTION})")
    print(f"  total docs scanned         : {total}")
    print(f"  already have the field     : {already}")
    print(f"  _demo (skipped)            : {demo}")
    print(f"  MISSING field (-> pending) : {backfilled}")
    print("\n  sample mappings:")
    print("\n".join(samples) if samples else "    (none)")
    if dry:
        print("\n[reconcileStatus] Dry run only. Re-run with --allow-prod "
              "(and GCLOUD_PROJECT=auntieos-ttpc) to commit.")


if __name__ == "__main__":
    main()
