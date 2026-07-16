"""1D vet consolidation: lift legacy per-kin vet info onto the owning Kinfolk.

Vet is now single-source on the Kinfolk (household): `vetClinicName` /
`vetClinicPhone` / `vetClinicAddress`. The Kin shows it read-only. The legacy
per-kin sources are `kin.vetInfo` (free-text) and `the_411.{vetName,vetPhone}`.
This script lifts that data up so nothing is lost when the UI stops reading it.

Rules (fail-loud, never fake):
  - Idempotent: a Kinfolk that ALREADY has a non-blank `vetClinicName` is left
    untouched (single-source already established). If a per-kin source DIFFERS
    from the established household vet, it is reported for manual review, never
    silently overwritten.
  - For a Kinfolk with NO household vet: prefer a structured 411 (vetName +
    vetPhone) from any of its kin; else fall back to the first non-blank
    `kin.vetInfo` free-text blob (into vetClinicName). The chosen source is
    recorded in `_vetMigratedFrom` provenance.
  - If a household's kin carry MULTIPLE distinct vet sources, the first is
    applied and the rest are logged as conflicts for manual reconciliation.

Refuses prod write without --allow-prod AND explicit GCLOUD_PROJECT env var.

Run:
    # dry-run (no writes, prints the plan + conflicts)
    python3 migrate_kin_vet_to_kinfolk.py --dry-run

    # prod write (requires both)
    GCLOUD_PROJECT=auntieos-ttpc python3 migrate_kin_vet_to_kinfolk.py --allow-prod
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT = Path(__file__).resolve().parent
SERVICE_ACCOUNT = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[vet-migrate] Refusing to run: no --allow-prod and no FIRESTORE_EMULATOR_HOST set.")
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(f"[vet-migrate] Refusing prod write: GCLOUD_PROJECT='{proj}' != expected "
                     f"'{EXPECTED_PROJECT}'. Set explicitly: GCLOUD_PROJECT={EXPECTED_PROJECT}")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[vet-migrate] Service account JSON not found at {SERVICE_ACCOUNT}.")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def blank(v) -> bool:
    return not (isinstance(v, str) and v.strip())


def vet_source_for_kin(kin: dict, four11: dict | None) -> dict | None:
    """Return a {name, phone, origin} vet candidate for one kin, or None."""
    if four11:
        name, phone = four11.get("vetName", ""), four11.get("vetPhone", "")
        if not blank(name) or not blank(phone):
            return {"name": name.strip() if name else "", "phone": phone.strip() if phone else "",
                    "origin": f"the_411(vetName/vetPhone) kin={kin.get('_id')}"}
    info = kin.get("vetInfo", "")
    if not blank(info):
        return {"name": info.strip(), "phone": "", "origin": f"kin.vetInfo kin={kin.get('_id')}"}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="no writes; print plan only")
    ap.add_argument("--allow-prod", action="store_true", help="required for prod write")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    print("[vet-migrate] Loading kinfolk, kin, the_411 ...")
    kinfolk = {d.id: (d.to_dict() or {}) for d in db.collection("kinfolk").stream()}

    kin_by_kinfolk: dict[str, list[dict]] = defaultdict(list)
    for d in db.collection("kin").stream():
        data = d.to_dict() or {}
        data["_id"] = d.id
        kin_by_kinfolk[data.get("kinfolkId", "")].append(data)

    # the_411 keyed by kinId (field), fallback to doc id.
    four11_by_kin: dict[str, dict] = {}
    for d in db.collection("the_411").stream():
        data = d.to_dict() or {}
        four11_by_kin[data.get("kinId", d.id)] = data

    planned, skipped, conflicts = [], [], []

    for kf_id, kf in kinfolk.items():
        kins = kin_by_kinfolk.get(kf_id, [])
        candidates = []
        for kin in kins:
            cand = vet_source_for_kin(kin, four11_by_kin.get(kin["_id"]))
            if cand:
                candidates.append(cand)

        if not blank(kf.get("vetClinicName")):
            # Household vet already set: single-source established. Report any
            # per-kin source that differs, for manual review.
            for c in candidates:
                if c["name"] and c["name"].strip().lower() != kf["vetClinicName"].strip().lower():
                    conflicts.append((kf_id, f"household='{kf['vetClinicName']}' vs {c['origin']}='{c['name']}'"))
            skipped.append(kf_id)
            continue

        if not candidates:
            continue  # nothing to lift

        chosen = candidates[0]
        for c in candidates[1:]:
            if c["name"] and c["name"].strip().lower() != chosen["name"].strip().lower():
                conflicts.append((kf_id, f"chose {chosen['origin']}='{chosen['name']}', also saw {c['origin']}='{c['name']}'"))
        planned.append((kf_id, chosen))

    print(f"\n[vet-migrate] PLAN: {len(planned)} household(s) to backfill, "
          f"{len(skipped)} already set, {len(conflicts)} conflict(s) for manual review.\n")
    for kf_id, c in planned:
        print(f"  WRITE kinfolk/{kf_id}: vetClinicName='{c['name']}' vetClinicPhone='{c['phone']}'  <- {c['origin']}")
    for kf_id, msg in conflicts:
        print(f"  CONFLICT kinfolk/{kf_id}: {msg}")

    if args.dry_run or not args.allow_prod:
        print("\n[vet-migrate] DRY-RUN (no writes). Re-run with --allow-prod + GCLOUD_PROJECT to apply.")
        return

    print("\n[vet-migrate] Writing ...")
    for kf_id, c in planned:
        db.collection("kinfolk").document(kf_id).set({
            "vetClinicName": c["name"],
            "vetClinicPhone": c["phone"],
            "_vetMigratedFrom": c["origin"],
            "_vetMigratedAt": utc_now_iso(),
        }, merge=True)
    print(f"[vet-migrate] Done: {len(planned)} household(s) updated. "
          f"{len(conflicts)} conflict(s) left for manual review (NOT written).")


if __name__ == "__main__":
    main()
