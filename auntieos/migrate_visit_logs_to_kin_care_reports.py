"""Migrate legacy visit_logs → canonical kin_care_reports.

Reads every doc in visit_logs, converts to KinCareReport shape, writes to
kin_care_reports w/ deterministic doc ID = "legacy_{visit_log.id}" so re-runs
are idempotent (Firestore .set() overwrites by ID).

Orphans (visit_logs whose journalId does NOT match any kin_care_sessions doc)
are STILL migrated, but tagged sentVia="legacy_orphan" with sessionId="" so
admin UI can fail-loud surface them. Per fail-loud policy: do not silently
drop docs.

Refuses prod write without --allow-prod AND explicit GCLOUD_PROJECT env var.
Pattern matches MyTribe/scripts/seedNotificationTemplates.ts gate.

Run:
    # dry-run (no writes, prints diff plan)
    python3 migrate_visit_logs_to_kin_care_reports.py --dry-run

    # prod write (requires both flags)
    GCLOUD_PROJECT=auntieos-ttpc python3 migrate_visit_logs_to_kin_care_reports.py --allow-prod
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT    = Path(__file__).resolve().parent
SERVICE_ACCOUNT = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"

EXPECTED_PROJECT = "auntieos-ttpc"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[migrate] Refusing to run: no --allow-prod and no FIRESTORE_EMULATOR_HOST set.")
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(f"[migrate] Refusing prod write: GCLOUD_PROJECT='{proj}' != expected '{EXPECTED_PROJECT}'. "
                     f"Set explicitly: GCLOUD_PROJECT={EXPECTED_PROJECT}")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[migrate] Service account JSON not found at {SERVICE_ACCOUNT}.")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def first_nonblank(*vals: str) -> str:
    for v in vals:
        if v and v.strip():
            return v
    return ""


def convert(visit_log_id: str, vl: dict, session_ids: set[str]) -> tuple[str, dict, bool]:
    """Returns (new_doc_id, kin_care_report_dict, is_orphan)."""
    journal_id = vl.get("journalId", "")
    is_orphan  = journal_id not in session_ids
    timestamp  = first_nonblank(vl.get("submitted", ""), vl.get("arrival", ""), vl.get("departure", ""))
    new_doc_id = f"legacy_{visit_log_id}"
    report = {
        "sessionId":         "" if is_orphan else journal_id,
        "kinfolkId":         vl.get("kinfolkId", ""),
        "kinfolkName":       "",  # journalId is FK, not name
        "kinIds":            [],
        "serviceType":       vl.get("serviceType", ""),
        "visitDate":         timestamp,
        "arrivedAt":         vl.get("arrival", ""),
        "departedAt":        vl.get("departure", ""),
        "visitRouteId":      "",
        "templateId":        "",
        "bodyCopy":          vl.get("auntieNotes", ""),
        "fieldResponses":    {},
        "petMoodSelections": {},
        "mediaFileIds":      [],
        "status":            "SENT",
        "sentAt":            timestamp,
        "sentVia":           "legacy_orphan" if is_orphan else "legacy_visit_logs",
        "deliveryReceiptId": vl.get("rawStagingRef", ""),
        "createdAt":         vl.get("submitted", ""),
        "updatedAt":         utc_now_iso(),
        # provenance — separate from deliveryReceiptId for clarity
        "_migratedFrom":     f"visit_logs/{visit_log_id}",
        "_migratedAt":       utc_now_iso(),
    }
    return new_doc_id, report, is_orphan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="no writes; print plan only")
    ap.add_argument("--allow-prod", action="store_true", help="required for prod write")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    # 1. Load all session IDs (FK target set)
    print("[migrate] Loading kin_care_sessions IDs ...")
    session_ids = {doc.id for doc in db.collection("kin_care_sessions").stream()}
    print(f"[migrate]   {len(session_ids)} sessions")

    # 2. Pre-flight: count existing kin_care_reports — must be 0 for clean migration
    existing = list(db.collection("kin_care_reports").limit(1).stream())
    if existing and not args.dry_run:
        sys.exit("[migrate] kin_care_reports is NOT empty. Aborting. Inspect first; re-run only if intentional overwrite.")

    # 3. Stream visit_logs
    print("[migrate] Streaming visit_logs ...")
    visit_logs = list(db.collection("visit_logs").stream())
    print(f"[migrate]   {len(visit_logs)} visit_logs")

    matched = 0
    orphans = []
    write_batch = db.batch() if not args.dry_run else None
    batch_count = 0

    for snap in visit_logs:
        vl = snap.to_dict()
        new_id, report, is_orphan = convert(snap.id, vl, session_ids)
        if is_orphan:
            orphans.append((snap.id, vl.get("journalId", "")))
        else:
            matched += 1
        if args.dry_run:
            tag = "ORPHAN" if is_orphan else "MATCH"
            print(f"  [{tag}] visit_logs/{snap.id} -> kin_care_reports/{new_id} (sessionId='{report['sessionId']}')")
        else:
            ref = db.collection("kin_care_reports").document(new_id)
            write_batch.set(ref, report)
            batch_count += 1
            if batch_count >= 400:
                write_batch.commit()
                write_batch = db.batch()
                batch_count = 0
    if write_batch is not None and batch_count > 0:
        write_batch.commit()

    print()
    print(f"[migrate] FINAL: total={len(visit_logs)} matched={matched} orphans={len(orphans)} mode={'DRY' if args.dry_run else 'WRITE'}")
    if orphans:
        print("[migrate] Orphans (journalId not in kin_care_sessions):")
        for vid, jid in orphans:
            print(f"  visit_logs/{vid}  journalId='{jid}'")


if __name__ == "__main__":
    main()
