"""Prod data cleanup pass 2 — orphan backfill (#4b) + 411_14 kinId fix (#9b).

Two passes:
1. Orphan backfill: read visit_logs (still in prod) for the 7 orphan IDs (79-85),
   create stub kin_care_sessions/{journalId}, repoint kin_care_reports/legacy_{id}
   to point at the new sessions + flip sentVia from "legacy_orphan" → "legacy_visit_logs".
2. 411_14 kinId update: "11" → "14" (per user decision: doc-ID is canonical).

Idempotent — re-runs are no-ops.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT     = Path(__file__).resolve().parent
SERVICE_ACCOUNT  = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"

ORPHAN_VISIT_LOG_IDS = ["79", "80", "81", "82", "83", "84", "85"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[pass2] Refusing to run: no --allow-prod and no FIRESTORE_EMULATOR_HOST set.")
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(f"[pass2] Refusing prod write: GCLOUD_PROJECT='{proj}' != '{EXPECTED_PROJECT}'. "
                     f"Set explicitly: GCLOUD_PROJECT={EXPECTED_PROJECT}")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[pass2] Service account JSON not found at {SERVICE_ACCOUNT}.")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def backup_collection(db, collection_name: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out = out_dir / f"{collection_name}_pre_pass2_{ts}.json"
    docs = [{"id": d.id, **d.to_dict()} for d in db.collection(collection_name).stream()]
    out.write_text(json.dumps(docs, indent=2, default=str))
    print(f"[pass2] backup {collection_name}: {len(docs)} docs -> {out}")
    return out


def build_stub_session(visit_log: dict, journal_id: str) -> dict:
    """Stub session matching KinCareSession schema (Models.kt:253)."""
    return {
        "kinId":                 "",
        "kinfolkId":             visit_log.get("kinfolkId", "") or "",
        "kinIds":                [],
        "kinfolkName":           "",
        "sourceBookingId":       "",
        "startTime":             "",
        "endTime":               "",
        "serviceType":           visit_log.get("serviceType", "") or "",
        "serviceDurationMinutes": 0,
        "notes":                 "",
        "kinfolkNotes":          "",
        "status":                "COMPLETED",
        "onMyWayAt":             "",
        "arrivedAt":             visit_log.get("arrival", "") or "",
        "departedAt":            visit_log.get("departure", "") or "",
        "completedAt":           visit_log.get("submitted", "") or "",
        "visitRouteId":          "",
        "etaMinutesAway":        0,
        "gpsSummary":            None,
        "reportIds":             [f"legacy_{visit_log['_visit_log_id']}"],
        "sentReportCount":       1,
        "autoCompleteEligible":  True,
        "createdAt":             visit_log.get("submitted", "") or utc_now_iso(),
        "updatedAt":             utc_now_iso(),
        # provenance
        "_backfilledFrom":       f"visit_logs/{visit_log['_visit_log_id']}",
        "_backfilledAt":         utc_now_iso(),
        "_reason":               "orphan_visit_log_pre_cutover",
    }


def pass_orphan_backfill(db, dry_run: bool) -> tuple[int, int]:
    print("\n[pass2] PASS A: orphan backfill (#4b)")
    created_sessions = 0
    repointed_reports = 0

    for vl_id in ORPHAN_VISIT_LOG_IDS:
        vl_snap = db.collection("visit_logs").document(vl_id).get()
        if not vl_snap.exists:
            print(f"  [SKIP] visit_logs/{vl_id} not found")
            continue
        vl = vl_snap.to_dict()
        journal_id = (vl.get("journalId") or "").strip()
        if not journal_id:
            print(f"  [SKIP] visit_logs/{vl_id} has no journalId")
            continue
        vl["_visit_log_id"] = vl_id

        # Idempotency: skip if session already exists
        existing = db.collection("kin_care_sessions").document(journal_id).get()
        report_id = f"legacy_{vl_id}"
        if existing.exists:
            print(f"  [SKIP] kin_care_sessions/{journal_id} already exists")
        else:
            stub = build_stub_session(vl, journal_id)
            if dry_run:
                print(f"  [DRY] CREATE kin_care_sessions/{journal_id} (from visit_logs/{vl_id}, "
                      f"kinfolkId='{stub['kinfolkId']}', report={report_id})")
            else:
                db.collection("kin_care_sessions").document(journal_id).set(stub)
            created_sessions += 1

        # Repoint the report (idempotent: skip if already linked)
        rep_snap = db.collection("kin_care_reports").document(report_id).get()
        if not rep_snap.exists:
            print(f"  [SKIP] kin_care_reports/{report_id} missing")
            continue
        rep = rep_snap.to_dict()
        if rep.get("sessionId") == journal_id and rep.get("sentVia") == "legacy_visit_logs":
            print(f"  [SKIP] kin_care_reports/{report_id} already linked")
            continue
        if dry_run:
            print(f"  [DRY] UPDATE kin_care_reports/{report_id} sessionId='' -> '{journal_id}', "
                  f"sentVia='legacy_orphan' -> 'legacy_visit_logs'")
        else:
            db.collection("kin_care_reports").document(report_id).update({
                "sessionId": journal_id,
                "sentVia":   "legacy_visit_logs",
                "updatedAt": utc_now_iso(),
            })
        repointed_reports += 1

    print(f"[pass2]   sessions_created={created_sessions} reports_repointed={repointed_reports}")
    return created_sessions, repointed_reports


def pass_411_14_fix(db, dry_run: bool) -> int:
    print("\n[pass2] PASS B: 411_14 kinId fix (#9b)")
    snap = db.collection("the_411").document("411_14").get()
    if not snap.exists:
        print("  [SKIP] the_411/411_14 not found")
        return 0
    current = snap.to_dict().get("kinId")
    if current == "14":
        print("  [SKIP] the_411/411_14 kinId already '14'")
        return 0
    if dry_run:
        print(f"  [DRY] UPDATE the_411/411_14 kinId='{current}' -> '14'")
    else:
        db.collection("the_411").document("411_14").update({
            "kinId":       "14",
            "lastUpdated": utc_now_iso(),
        })
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-prod", action="store_true")
    ap.add_argument("--skip-backup", action="store_true")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    if not args.dry_run and not args.skip_backup:
        backup_dir = PROJECT_ROOT / "backups"
        for col in ("kin_care_sessions", "kin_care_reports", "the_411", "visit_logs"):
            backup_collection(db, col, backup_dir)

    a = pass_orphan_backfill(db, args.dry_run)
    b = pass_411_14_fix(db, args.dry_run)

    print()
    print(f"[pass2] FINAL mode={'DRY' if args.dry_run else 'WRITE'}")
    print(f"  orphan_backfill: sessions_created={a[0]} reports_repointed={a[1]}")
    print(f"  411_14_fix:      changed={b}")


if __name__ == "__main__":
    main()
