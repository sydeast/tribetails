"""Post-autogen sweep: (1) set needsMoreSamples flag based on citation count,
(2) scrub literal <summary>/</summary> tag bleed from rawSummary (artifact of
prior seed_profiles.py run that wrote tags into stored text).

Idempotent. Re-runs are no-ops.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT     = Path(__file__).resolve().parent
SERVICE_ACCOUNT  = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"

_CITATION_PATTERN = re.compile(r"\[\[source:[^\]]+\]\]")
_SUMMARY_OPEN  = re.compile(r"^\s*<summary>\s*\n?", re.IGNORECASE)
_SUMMARY_CLOSE = re.compile(r"\n?\s*</summary>\s*$", re.IGNORECASE)
SAMPLE_THRESHOLD = 3


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[post] Refusing: no --allow-prod and no FIRESTORE_EMULATOR_HOST.")
    if allow_prod and os.environ.get("GCLOUD_PROJECT") != EXPECTED_PROJECT:
        sys.exit(f"[post] Refusing prod write: GCLOUD_PROJECT != '{EXPECTED_PROJECT}'.")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[post] Service account not found: {SERVICE_ACCOUNT}")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def count_sources(text: str) -> int:
    if not text:
        return 0
    return len(_CITATION_PATTERN.findall(text))


def scrub_summary_tags(text: str) -> str:
    if not text:
        return text
    out = _SUMMARY_OPEN.sub("", text)
    out = _SUMMARY_CLOSE.sub("", out)
    return out


def sweep_collection(db, coll_name: str, dry_run: bool) -> tuple[int, int]:
    """Returns (scrubs, flag_updates)."""
    scrubs = 0
    flag_updates = 0
    for snap in db.collection(coll_name).stream():
        d = snap.to_dict() or {}
        raw = d.get("rawSummary", "")
        new_raw = scrub_summary_tags(raw)
        new_needs_more = count_sources(new_raw) < SAMPLE_THRESHOLD
        existing_needs_more = d.get("needsMoreSamples")

        update = {}
        if new_raw != raw:
            update["rawSummary"] = new_raw
            scrubs += 1
        if existing_needs_more != new_needs_more:
            update["needsMoreSamples"] = new_needs_more
            flag_updates += 1

        if not update:
            continue
        if dry_run:
            changes = ", ".join(f"{k}=…" if k == "rawSummary" else f"{k}={v}" for k, v in update.items())
            print(f"  [DRY] {coll_name}/{snap.id}: {changes}")
        else:
            db.collection(coll_name).document(snap.id).update({
                **update,
                "_postCleanupAt": utc_now_iso(),
            })
    return scrubs, flag_updates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-prod", action="store_true")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    print("\n[post] PASS A: dossiers sweep")
    a = sweep_collection(db, "dossiers", args.dry_run)
    print(f"[post]   tag_scrubs={a[0]} flag_updates={a[1]}")

    print("\n[post] PASS B: the_411 sweep")
    b = sweep_collection(db, "the_411", args.dry_run)
    print(f"[post]   tag_scrubs={b[0]} flag_updates={b[1]}")

    print()
    print(f"[post] FINAL mode={'DRY' if args.dry_run else 'WRITE'}")
    print(f"  dossiers: scrubs={a[0]} flags={a[1]}")
    print(f"  the_411:  scrubs={b[0]} flags={b[1]}")


if __name__ == "__main__":
    main()
