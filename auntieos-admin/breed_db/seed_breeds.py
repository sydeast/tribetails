#!/usr/bin/env python3
"""Seed merged breed docs into Firestore.

Reads breeds_dogs.json + breeds_cats.json and upserts each breed into its
collection. Project-agnostic: the project comes from GCLOUD_PROJECT (or
--project), defaulting to auntieos-ttpc only when you pass --allow-prod.

Follows the repo convention (see migrate_kin_vet_to_kinfolk.py): dry-run is the
default and prints the full plan; a real write requires BOTH --allow-prod and an
explicit project. Credentials are taken from GOOGLE_APPLICATION_CREDENTIALS or
the admin-SDK key already in the AuntieOS root -- nothing secret is hardcoded.

Usage:
    # dry-run, no writes, prints what WOULD be written
    python3 seed_breeds.py --dry-run

    # real write
    GCLOUD_PROJECT=auntieos-ttpc \\
    GOOGLE_APPLICATION_CREDENTIALS=../auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json/<keyfile> \\
    python3 seed_breeds.py --allow-prod
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_PROJECT = "auntieos-ttpc"
COLLECTIONS = {"dog": "dog_breeds", "cat": "cat_breeds"}


def load_docs() -> list[dict]:
    docs: list[dict] = []
    for fname in ("breeds_dogs.json", "breeds_cats.json"):
        path = HERE / fname
        if not path.exists():
            sys.exit(f"FATAL: {fname} not found -- run merge_breeds.py first. "
                     "(Fail loud: refusing to seed an empty/partial dataset.)")
        docs.extend(json.loads(path.read_text())["breeds"])
    if not docs:
        sys.exit("FATAL: no breeds to seed.")
    return docs


def plan(docs: list[dict]) -> None:
    for d in docs:
        coll = COLLECTIONS[d["species"]]
        n_attr = len(d["attributes"])
        n_alt = sum(len(a["alternatives"]) for a in d["attributes"].values())
        srcs = ",".join(d["sources"].keys())
        print(f"  {coll}/{d['id']:<22} attrs={n_attr:<3} alts={n_alt:<3} "
              f"hasAlt={str(d['hasAlternativeValues']):<5} sources=[{srcs}]")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="default behaviour; no writes")
    ap.add_argument("--allow-prod", action="store_true", help="perform the real write")
    ap.add_argument("--project", default=os.environ.get("GCLOUD_PROJECT"))
    args = ap.parse_args()

    docs = load_docs()
    print(f"Loaded {len(docs)} breed docs "
          f"({sum(d['species']=='dog' for d in docs)} dogs, "
          f"{sum(d['species']=='cat' for d in docs)} cats).\n")
    print("Plan:")
    plan(docs)

    if not args.allow_prod:
        print("\nDRY-RUN: nothing written. Re-run with --allow-prod and a project to write.")
        return

    project = args.project or DEFAULT_PROJECT
    print(f"\nWriting to project: {project}")

    import firebase_admin
    from firebase_admin import credentials, firestore

    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        cred = credentials.ApplicationDefault()
    else:
        sys.exit("FATAL: set GOOGLE_APPLICATION_CREDENTIALS to the admin-SDK key. "
                 "(Fail loud: refusing to guess credentials.)")

    firebase_admin.initialize_app(cred, {"projectId": project})
    db = firestore.client()
    now = datetime.now(timezone.utc).isoformat()

    written = 0
    batch = db.batch(); n = 0
    for d in docs:
        coll = COLLECTIONS[d["species"]]
        payload = {**d, "_seededAt": now, "_schemaVersion": 1}
        batch.set(db.collection(coll).document(d["id"]), payload, merge=True)
        n += 1; written += 1
        if n >= 400:
            batch.commit(); batch = db.batch(); n = 0
            print(f"  committed {written} ...")
    if n:
        batch.commit()
    print(f"Wrote {written} breed docs.")


if __name__ == "__main__":
    main()
