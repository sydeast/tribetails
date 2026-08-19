"""Backfill training_documents.targetType = 'HOUSEHOLD' on rows that carry no target.

WHY (issue #461, operator ruling 2026-08-18: "kinfolk data go to kinfolks
dossiers, kin data goes into the kins 411s. and then household gets its own
bank"):

The nightly reconcile job now routes a Tribal Intel note to exactly ONE record
by its `targetType`. Rows written before the three targets existed (the NDJSON
migration import, and anything predating PR #427) carry only a household anchor
and no `targetType` at all.

THE DECISION FOR THOSE ROWS IS HOUSEHOLD. The only thing such a row names is the
household, so the household bank is the widest honest reading of it; filing it
into one person's dossier or one pet's 411 would claim a scope the document
never stated. That is also what such a row does today (it fans out household
wide), so no row changes what it is ABOUT, only which single record it lands in.

The pipeline does NOT depend on this script: `reconcile_comms.resolve_target_type`
applies the same rule at read time, so an unmigrated row already routes to the
bank. What the backfill buys is a row that SAYS what it is, so the Tribal Intel
list, the two clients' target chips, and the pipeline all read the value rather
than three copies of the same inference. Run it or don't; correctness does not
change either way.

Deliberately narrow: it writes `targetType` and nothing else. It never touches a
row that already carries any `targetType` value, never invents a `targetKinId`,
and never rewrites an anchor.

Idempotent: a second run finds nothing to do. Writes a `_targetTypeBackfillAt`
marker so backfilled rows stay identifiable. Never touches `_demo:true` docs.

DO NOT auto-run. The operator runs migrations. This script has NOT been run
against production as part of the PR that ships it; it is a runbook step.

  Dry run (default):   python3 backfill_tribal_intel_target_type.py
  Commit to prod:      GCLOUD_PROJECT=auntieos-ttpc python3 backfill_tribal_intel_target_type.py --allow-prod
  Force dry run:       python3 backfill_tribal_intel_target_type.py --allow-prod --dry-run
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
COLLECTION       = "training_documents"

# The one value this script ever writes. Imported from the pipeline so the script
# and the nightly job cannot drift into disagreeing about what an untargeted row
# becomes; if the ruling ever changes, it changes in one place.
try:
    from reconcile_comms import LEGACY_UNTARGETED_TARGET
except ImportError:  # pragma: no cover - only when run outside the package dir
    LEGACY_UNTARGETED_TARGET = "HOUSEHOLD"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def needs_backfill(d: dict) -> bool:
    """True when the row carries no usable targetType.

    A blank or whitespace-only value counts as absent: it is the same nothing a
    missing key is, and both route through LEGACY_UNTARGETED_TARGET already. Any
    non-blank value is left ALONE even if it is a string this product does not
    recognise — an unknown value is somebody else's data, not our call to
    overwrite, and the pipeline already treats it as household.
    """
    return not str(d.get("targetType") or "").strip()


def init_firebase(allow_prod: bool):
    if allow_prod and os.environ.get("GCLOUD_PROJECT") != EXPECTED_PROJECT:
        sys.exit(f"[targetType] Refusing prod write: GCLOUD_PROJECT != '{EXPECTED_PROJECT}'.")
    # `.is_file()`, not `.exists()`: a DIRECTORY at this path passes an exists()
    # check and then dies inside credentials.Certificate() with a bare
    # IsADirectoryError (the same guard backfill_kincare_reconcile_status.py carries).
    if SERVICE_ACCOUNT.is_file():
        cred = credentials.Certificate(str(SERVICE_ACCOUNT))
        print(f"[targetType] auth: service account {SERVICE_ACCOUNT.name}")
    elif os.environ.get("ALLOW_ADC") == "1":
        cred = credentials.ApplicationDefault()
        print("[targetType] auth: application default credentials (ALLOW_ADC=1)")
    else:
        hint = " (that path is a DIRECTORY, not a file)" if SERVICE_ACCOUNT.is_dir() else ""
        sys.exit(
            f"[targetType] Service account not found: {SERVICE_ACCOUNT}{hint}\n"
            f"[targetType] Either place the key there, or re-run with ALLOW_ADC=1 "
            f"to use gcloud application default credentials."
        )
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-prod", action="store_true", help="commit writes to prod")
    ap.add_argument("--dry-run", action="store_true",
                    help="force a dry run; ALWAYS wins over --allow-prod, whatever the flag order")
    ap.add_argument("--limit", type=int, default=0, help="cap docs backfilled (0 = all)")
    args = ap.parse_args()
    # --dry-run wins, deliberately: the safe answer must not depend on argv order.
    dry = args.dry_run or not args.allow_prod

    db = init_firebase(args.allow_prod and not args.dry_run)
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
            anchor = str(d.get("targetKinfolkId") or d.get("kinfolkRef") or "(no anchor)")
            samples.append(f"  {doc.id}: targetType (absent) -> '{LEGACY_UNTARGETED_TARGET}'  anchor={anchor}")
        if not dry:
            doc.reference.update({
                "targetType": LEGACY_UNTARGETED_TARGET,
                "_targetTypeBackfillAt": now,
            })
        if args.limit and backfilled >= args.limit:
            break

    mode = "DRY RUN (no writes)" if dry else "PROD WRITE COMMITTED"
    print(f"\n[targetType] {mode}  (collection: {COLLECTION})")
    print(f"  total docs scanned            : {total}")
    print(f"  already have a targetType     : {already}")
    print(f"  _demo (skipped)               : {demo}")
    print(f"  UNTARGETED (-> {LEGACY_UNTARGETED_TARGET:<9}) : {backfilled}")
    print("\n  sample mappings:")
    print("\n".join(samples) if samples else "    (none)")
    if dry:
        print("\n[targetType] Dry run only. Re-run with --allow-prod "
              "(and GCLOUD_PROJECT=auntieos-ttpc) to commit.")


if __name__ == "__main__":
    main()
