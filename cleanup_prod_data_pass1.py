"""Prod data cleanup pass 1 — status backfill, NaN scrub, ISO unify."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT    = Path(__file__).resolve().parent
SERVICE_ACCOUNT = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"

VALID_STATUSES = {"SCHEDULED", "ON_MY_WAY", "ARRIVED", "DEPARTED", "COMPLETED", "CANCELLED"}


def derive_status(session: dict) -> str | None:
    """Derive canonical status from legacy fields. Returns None if no change needed.

    Rules:
    - Existing status (if in VALID_STATUSES and non-blank) wins — never overwrite.
    - completedAt non-blank → COMPLETED.
    - submitted truthy → COMPLETED.
    - statusSent == "Sent" → COMPLETED.
    - Otherwise → SCHEDULED.
    """
    existing = (session.get("status") or "").strip()
    if existing in VALID_STATUSES:
        return None
    if (session.get("completedAt") or "").strip():
        return "COMPLETED"
    if session.get("submitted"):
        return "COMPLETED"
    if (session.get("statusSent") or "").strip().lower() == "sent":
        return "COMPLETED"
    return "SCHEDULED"


def needs_nan_scrub(kinfolk: dict) -> bool:
    notes = kinfolk.get("internalNotes")
    return isinstance(notes, str) and notes.strip() == "NaN"


_ISO_ZULU = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_LOCAL_DT = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$")


def normalize_iso_zulu(raw: str) -> str | None:
    """Convert '2026-04-16 13:34' (local naive) → '2026-04-16T13:34:00Z'.

    Returns None if already ISO-Zulu OR can't parse.
    Treats naive local timestamps as Zulu (consistent w/ rest of corpus — user accepted).
    """
    if not isinstance(raw, str):
        return None
    if _ISO_ZULU.match(raw):
        return None
    m = _LOCAL_DT.match(raw)
    if not m:
        return None
    return f"{m.group(1)}T{m.group(2)}:00Z"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- Firebase init (mirrors migrate_visit_logs_to_kin_care_reports.py) ----------

def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[cleanup] Refusing to run: no --allow-prod and no FIRESTORE_EMULATOR_HOST set.")
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(f"[cleanup] Refusing prod write: GCLOUD_PROJECT='{proj}' != expected '{EXPECTED_PROJECT}'. "
                     f"Set explicitly: GCLOUD_PROJECT={EXPECTED_PROJECT}")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[cleanup] Service account JSON not found at {SERVICE_ACCOUNT}.")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def backup_collection(db, collection_name: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out = out_dir / f"{collection_name}_pre_cleanup_{ts}.json"
    docs = [{"id": d.id, **d.to_dict()} for d in db.collection(collection_name).stream()]
    out.write_text(json.dumps(docs, indent=2, default=str))
    print(f"[cleanup] backup {collection_name}: {len(docs)} docs -> {out}")
    return out


def pass_status_backfill(db, dry_run: bool) -> tuple[int, int]:
    print("\n[cleanup] PASS 1: status backfill on kin_care_sessions")
    docs = list(db.collection("kin_care_sessions").stream())
    changed = 0
    for snap in docs:
        new_status = derive_status(snap.to_dict())
        if new_status is None:
            continue
        if dry_run:
            print(f"  [DRY] kin_care_sessions/{snap.id}: status -> {new_status}")
        else:
            db.collection("kin_care_sessions").document(snap.id).update({"status": new_status})
        changed += 1
    print(f"[cleanup]   scanned={len(docs)} changed={changed}")
    return len(docs), changed


def pass_nan_scrub(db, dry_run: bool) -> tuple[int, int]:
    print("\n[cleanup] PASS 2: NaN scrub on kinfolk.internalNotes")
    docs = list(db.collection("kinfolk").stream())
    changed = 0
    for snap in docs:
        if not needs_nan_scrub(snap.to_dict()):
            continue
        if dry_run:
            print(f"  [DRY] kinfolk/{snap.id}: internalNotes 'NaN' -> ''")
        else:
            db.collection("kinfolk").document(snap.id).update({"internalNotes": ""})
        changed += 1
    print(f"[cleanup]   scanned={len(docs)} changed={changed}")
    return len(docs), changed


def pass_iso_unify(db, dry_run: bool) -> tuple[int, int]:
    print("\n[cleanup] PASS 3: ISO-Zulu unify on the_411.lastUpdated")
    docs = list(db.collection("the_411").stream())
    changed = 0
    for snap in docs:
        d = snap.to_dict()
        new_val = normalize_iso_zulu(d.get("lastUpdated", ""))
        if new_val is None:
            continue
        if dry_run:
            print(f"  [DRY] the_411/{snap.id}: lastUpdated '{d.get('lastUpdated')}' -> '{new_val}'")
        else:
            db.collection("the_411").document(snap.id).update({"lastUpdated": new_val})
        changed += 1
    print(f"[cleanup]   scanned={len(docs)} changed={changed}")
    return len(docs), changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-prod", action="store_true")
    ap.add_argument("--skip-backup", action="store_true", help="skip backup (dry-run only)")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    if not args.dry_run and not args.skip_backup:
        backup_dir = PROJECT_ROOT / "backups"
        for col in ("kin_care_sessions", "kinfolk", "the_411"):
            backup_collection(db, col, backup_dir)

    s1 = pass_status_backfill(db, args.dry_run)
    s2 = pass_nan_scrub(db, args.dry_run)
    s3 = pass_iso_unify(db, args.dry_run)

    print()
    print(f"[cleanup] FINAL mode={'DRY' if args.dry_run else 'WRITE'}")
    print(f"  status_backfill: scanned={s1[0]} changed={s1[1]}")
    print(f"  nan_scrub:       scanned={s2[0]} changed={s2[1]}")
    print(f"  iso_unify:       scanned={s3[0]} changed={s3[1]}")


if __name__ == "__main__":
    main()
