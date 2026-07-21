"""Seed placeholder dossier + the_411 docs for kin/kinfolk with no source data.

Phase 3 of 2026-05-17-411-dossier-autogen-pipeline.

For every kinfolk that has no dossier → write a placeholder with needsMoreSamples=True.
For every kin that has no the_411   → write a placeholder with needsMoreSamples=True.
Also flags any EXISTING dossier/the_411 whose rawSummary is empty.

Guardrails:
- --dry-run is default; pass --allow-prod to write.
- Refuses if GCLOUD_PROJECT != "auntieos-ttpc" when --allow-prod is set.
- Idempotent: docs that already exist AND already carry _placeholder=True are skipped.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT = Path(__file__).resolve().parent
SERVICE_ACCOUNT = (
    PROJECT_ROOT.parent
    / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
)
EXPECTED_PROJECT = "auntieos-ttpc"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    """Mirror pattern from cleanup_prod_data_pass1.py."""
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit(
            "[seed] Refusing to run: no --allow-prod and no "
            "FIRESTORE_EMULATOR_HOST set."
        )
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(
                f"[seed] Refusing prod write: GCLOUD_PROJECT='{proj}' != "
                f"expected '{EXPECTED_PROJECT}'. "
                f"Set explicitly: GCLOUD_PROJECT={EXPECTED_PROJECT}"
            )
    if not SERVICE_ACCOUNT.exists():
        sys.exit(
            f"[seed] Service account JSON not found at {SERVICE_ACCOUNT}."
        )
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


# ---------------------------------------------------------------------------
# Pass A — dossiers
# ---------------------------------------------------------------------------

def pass_dossiers(db, dry_run: bool) -> dict[str, int]:
    """
    1. For each kinfolk, create a placeholder dossier if none exists.
    2. Flag existing dossiers whose rawSummary is empty but lack _placeholder.
    """
    print("\n[seed] PASS A: dossiers")

    now = utc_now_iso()

    kinfolk_snaps = list(db.collection("kinfolk").stream())
    print(f"[seed]   kinfolk loaded: {len(kinfolk_snaps)}")

    created = 0
    flagged = 0
    skipped = 0

    for kf_snap in kinfolk_snaps:
        kfid = kf_snap.id

        # Check if a dossier already exists for this kinfolk
        existing = (
            db.collection("dossiers")
            .where("kinfolkId", "==", kfid)
            .limit(1)
            .stream()
        )
        existing_list = list(existing)

        if not existing_list:
            # No dossier at all — create placeholder
            doc_id = f"dossier_{kfid}"
            placeholder = {
                "kinfolkId": kfid,
                "rawSummary": "",
                "lastReconciledAt": "",
                "lastReconcileSourceLogIds": [],
                "needsMoreSamples": True,
                "_placeholder": True,
                "_placeholderAt": now,
                "_reason": "no_source_data_yet",
            }
            if dry_run:
                print(f"  [DRY] CREATE dossiers/{doc_id} (kinfolkId={kfid})")
            else:
                db.collection("dossiers").document(doc_id).set(placeholder)
            created += 1
        else:
            # Dossier exists — check if already a placeholder or needs flagging
            existing_doc = existing_list[0]
            data = existing_doc.to_dict()

            already_placeholder = data.get("_placeholder", False)
            raw_summary = (data.get("rawSummary") or "").strip()

            if already_placeholder and raw_summary == "":
                # Already correctly marked — idempotent skip
                skipped += 1
                continue

            if raw_summary == "" and not already_placeholder:
                # Seeded-but-empty: flag it
                update = {
                    "needsMoreSamples": True,
                    "_placeholder": True,
                    "_placeholderAt": now,
                    "_reason": "no_source_data_yet",
                }
                if dry_run:
                    print(
                        f"  [DRY] FLAG  dossiers/{existing_doc.id} "
                        f"(kinfolkId={kfid}, rawSummary empty)"
                    )
                else:
                    db.collection("dossiers").document(existing_doc.id).update(update)
                flagged += 1
            else:
                skipped += 1

    print(
        f"[seed]   dossiers: kinfolk_scanned={len(kinfolk_snaps)} "
        f"placeholders_created={created} flags_updated={flagged} skipped={skipped}"
    )
    return {"created": created, "flagged": flagged, "skipped": skipped}


# ---------------------------------------------------------------------------
# Pass B — the_411
# ---------------------------------------------------------------------------

def pass_the_411(db, dry_run: bool) -> dict[str, int]:
    """
    1. For each kin, create a placeholder the_411 if none exists.
    2. Flag existing the_411 docs whose rawSummary is empty but lack _placeholder.
    """
    print("\n[seed] PASS B: the_411")

    now = utc_now_iso()

    kin_snaps = list(db.collection("kin").stream())
    print(f"[seed]   kin loaded: {len(kin_snaps)}")

    created = 0
    flagged = 0
    skipped = 0

    for kin_snap in kin_snaps:
        kid = kin_snap.id

        # Check if a the_411 already exists for this kin
        existing = (
            db.collection("the_411")
            .where("kinId", "==", kid)
            .limit(1)
            .stream()
        )
        existing_list = list(existing)

        if not existing_list:
            # No the_411 at all — create placeholder
            doc_id = f"411_{kid}"
            placeholder = {
                "kinId": kid,
                "rawSummary": "",
                "lastUpdated": now,
                "lastReconciledAt": "",
                "lastReconcileSourceLogIds": [],
                "needsMoreSamples": True,
                "_placeholder": True,
                "_placeholderAt": now,
                "_reason": "no_source_data_yet",
            }
            if dry_run:
                print(f"  [DRY] CREATE the_411/{doc_id} (kinId={kid})")
            else:
                db.collection("the_411").document(doc_id).set(placeholder)
            created += 1
        else:
            # the_411 exists — check if already a placeholder or needs flagging
            existing_doc = existing_list[0]
            data = existing_doc.to_dict()

            already_placeholder = data.get("_placeholder", False)
            raw_summary = (data.get("rawSummary") or "").strip()

            if already_placeholder and raw_summary == "":
                # Already correctly marked — idempotent skip
                skipped += 1
                continue

            if raw_summary == "" and not already_placeholder:
                # Seeded-but-empty: flag it
                update = {
                    "needsMoreSamples": True,
                    "_placeholder": True,
                    "_placeholderAt": now,
                    "_reason": "no_source_data_yet",
                }
                if dry_run:
                    print(
                        f"  [DRY] FLAG  the_411/{existing_doc.id} "
                        f"(kinId={kid}, rawSummary empty)"
                    )
                else:
                    db.collection("the_411").document(existing_doc.id).update(update)
                flagged += 1
            else:
                skipped += 1

    print(
        f"[seed]   the_411: kin_scanned={len(kin_snaps)} "
        f"placeholders_created={created} flags_updated={flagged} skipped={skipped}"
    )
    return {"created": created, "flagged": flagged, "skipped": skipped}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description=(
            "Seed placeholder dossier + the_411 docs for kin/kinfolk that "
            "have no source data, so UI banners (needsMoreSamples=True) fire "
            "instead of silent gaps."
        )
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print what would be created/updated without writing (default: False).",
    )
    ap.add_argument(
        "--allow-prod",
        action="store_true",
        default=False,
        help=(
            "Authorise writes to prod. Requires GCLOUD_PROJECT=auntieos-ttpc "
            "to be set in the environment."
        ),
    )
    args = ap.parse_args()

    # Must explicitly pick a mode — refuse ambiguous invocation
    if not args.dry_run and not args.allow_prod:
        sys.exit(
            "[seed] You must pass either --dry-run or --allow-prod. "
            "To preview changes: --dry-run. To write: --allow-prod (+ set "
            f"GCLOUD_PROJECT={EXPECTED_PROJECT})."
        )

    mode = "DRY-RUN" if args.dry_run else "WRITE"
    print(f"[seed] mode={mode}")

    db = init_firebase(args.allow_prod)

    stats_d = pass_dossiers(db, args.dry_run)
    stats_4 = pass_the_411(db, args.dry_run)

    print()
    print(f"[seed] FINAL  mode={mode}")
    print(
        f"  dossiers : placeholders_created={stats_d['created']} "
        f"flags_updated={stats_d['flagged']} skipped={stats_d['skipped']}"
    )
    print(
        f"  the_411  : placeholders_created={stats_4['created']} "
        f"flags_updated={stats_4['flagged']} skipped={stats_4['skipped']}"
    )


if __name__ == "__main__":
    main()
