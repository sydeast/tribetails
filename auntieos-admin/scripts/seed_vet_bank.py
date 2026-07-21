#!/usr/bin/env python3
"""Seed the cleaned Austin-metro vet list into the `vet_clinics` collection (the
shared "vet bank"). OPERATOR-RUN ONLY: this writes to PROD Firestore, so it is
dry-run by default and refuses to write without --apply.

Reads `vet_bank_seed.json` (produced by clean_vet_bank.py). Dedupes against the
existing catalog by normalized name (case/space-insensitive) so re-running is
safe and won't create duplicates. Seeded rows are verified=true (admin-curated).

Usage:
  python3 scripts/seed_vet_bank.py            # dry run: report what WOULD happen
  python3 scripts/seed_vet_bank.py --apply    # actually write the new clinics
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVICE_ACCOUNT = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"
SEED = PROJECT_ROOT / "vet_bank_seed.json"


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").lower()).strip()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write to Firestore (default: dry run)")
    args = ap.parse_args()

    if not SEED.exists():
        print(f"FATAL: {SEED} not found. Run clean_vet_bank.py first.", file=sys.stderr)
        return 1
    if not SERVICE_ACCOUNT.exists():
        print(f"FATAL: service account not found at {SERVICE_ACCOUNT}", file=sys.stderr)
        return 1

    rows = json.loads(SEED.read_text(encoding="utf-8"))
    print(f"seed rows: {len(rows)}")

    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    db = firestore.client()

    existing = {norm(d.to_dict().get("name", "")) for d in db.collection("vet_clinics").stream()}
    print(f"existing clinics in vet_clinics: {len(existing)}")

    to_add = [r for r in rows if norm(r["name"]) not in existing]
    skipped = len(rows) - len(to_add)
    print(f"already present (skip): {skipped}")
    print(f"NEW to add:             {len(to_add)}")

    if not args.apply:
        print("\nDRY RUN. Re-run with --apply to write. First 5 that would be added:")
        for r in to_add[:5]:
            tag = " [ER]" if r.get("isEmergency") else ""
            print(f"  + {r['name']}{tag}  {r.get('phone','')}")
        return 0

    ts = utc_now_iso()
    batch = db.batch()
    n = 0
    for r in to_add:
        ref = db.collection("vet_clinics").document()
        batch.set(ref, {
            "name": r["name"],
            "phone": r.get("phone", ""),
            "address": r.get("address", ""),
            "website": r.get("website", ""),
            "googleMapsUrl": r.get("googleMapsUrl", ""),
            "isEmergency": bool(r.get("isEmergency", False)),
            "verified": True,
            "submittedBy": "",
            "notes": "",
            "source": r.get("source", "google-austin-metro-2026-06"),
            "createdAt": ts,
            "updatedAt": ts,
        })
        n += 1
        if n % 400 == 0:  # Firestore batch limit is 500
            batch.commit()
            batch = db.batch()
    batch.commit()
    print(f"\nAPPLIED: wrote {n} new clinics to vet_clinics.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
