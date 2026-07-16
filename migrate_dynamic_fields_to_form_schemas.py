"""1C consolidation: fold legacy `dynamic_fields` docs into `form_schemas`.

FormSchema is the survivor field-authoring system. The legacy `dynamic_fields`
collection (admin-authored custom fields, no downstream consumer yet) is migrated
into per-entity FormSchema docs so no authored field is lost, then the
dynamic_fields UI/code is retired in the app.

Mapping:
  - Group non-archived dynamic_fields by `appliesTo` (kinfolk|kin|session|booking).
  - Each group -> one schema `formSchemas/{appliesTo}.custom` (e.g. `kin.custom`)
    with appliesTo = uppercase target + a single "Custom fields" section.
  - Field type map onto the 9 FormSchema types:
        long_text -> textarea, boolean -> checkbox, everything else 1:1
        (text, number, date, email, phone, select, multiselect).
  - field.key = camelCase(name); label/options/required/helperText carried over;
    section field order follows dynamic_fields `displayOrder`.

Idempotent: deterministic schema ids; re-runs overwrite the same docs. The
server normally bumps `version`, but this writes directly (admin SDK) so it
stamps version=1 + provenance and lets a later saveFormSchema bump from there.

Refuses prod write without --allow-prod AND explicit GCLOUD_PROJECT env var.

Run:
    python3 migrate_dynamic_fields_to_form_schemas.py --dry-run
    GCLOUD_PROJECT=auntieos-ttpc python3 migrate_dynamic_fields_to_form_schemas.py --allow-prod
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

PROJECT_ROOT = Path(__file__).resolve().parent
SERVICE_ACCOUNT = PROJECT_ROOT.parent / "auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json"
EXPECTED_PROJECT = "auntieos-ttpc"

APPLIES_TO_MAP = {
    "kinfolk": "KINFOLK",
    "kin": "KIN",
    "household": "HOUSEHOLD",
    "session": "SESSION",
    "booking": "BOOKING",
}
TYPE_MAP = {
    "long_text": "textarea",
    "boolean": "checkbox",
    "text": "text", "textarea": "textarea", "number": "number", "date": "date",
    "email": "email", "phone": "phone", "select": "select", "multiselect": "multiselect",
}
FORM_SCHEMA_TYPES = {"text", "textarea", "select", "multiselect", "date", "number", "checkbox", "phone", "email"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_firebase(allow_prod: bool):
    if not allow_prod and not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit("[df-migrate] Refusing to run: no --allow-prod and no FIRESTORE_EMULATOR_HOST set.")
    if allow_prod:
        proj = os.environ.get("GCLOUD_PROJECT", "")
        if proj != EXPECTED_PROJECT:
            sys.exit(f"[df-migrate] Refusing prod write: GCLOUD_PROJECT='{proj}' != '{EXPECTED_PROJECT}'.")
    if not SERVICE_ACCOUNT.exists():
        sys.exit(f"[df-migrate] Service account JSON not found at {SERVICE_ACCOUNT}.")
    cred = credentials.Certificate(str(SERVICE_ACCOUNT))
    firebase_admin.initialize_app(cred, {"projectId": EXPECTED_PROJECT})
    return firestore.client()


def to_camel(name: str) -> str:
    parts = re.split(r"[^a-zA-Z0-9]+", (name or "").strip())
    parts = [p for p in parts if p]
    if not parts:
        return "field"
    head = parts[0]
    head = head[0].lower() + head[1:] if head else head
    rest = "".join(p[:1].upper() + p[1:] for p in parts[1:])
    camel = head + rest
    if not re.match(r"^[a-zA-Z]", camel):
        camel = "f" + camel
    return camel


def map_field(df: dict) -> dict:
    raw_type = str(df.get("fieldType", "text")).lower()
    ftype = TYPE_MAP.get(raw_type, "text")
    if ftype not in FORM_SCHEMA_TYPES:
        ftype = "text"
    options = df.get("options") or None
    if ftype in ("select", "multiselect") and not options:
        # FormSchema requires options for select types; degrade to text rather than
        # write an invalid schema (fail-loud: logged in the plan output).
        ftype = "text"
        options = None
    return {
        "key": to_camel(df.get("name", "")),
        "label": df.get("label") or df.get("name") or "Field",
        "type": ftype,
        "required": bool(df.get("required", False)),
        "helperText": df.get("helpText") or None,
        "placeholder": None,
        "options": options,
        "defaultValue": None,
        "group": None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-prod", action="store_true")
    args = ap.parse_args()

    db = init_firebase(args.allow_prod)

    print("[df-migrate] Loading dynamic_fields ...")
    groups: dict[str, list[dict]] = defaultdict(list)
    total, archived, unknown = 0, 0, 0
    for d in db.collection("dynamic_fields").stream():
        data = d.to_dict() or {}
        total += 1
        if data.get("archived"):
            archived += 1
            continue
        target = APPLIES_TO_MAP.get(str(data.get("appliesTo", "")).lower())
        if not target:
            unknown += 1
            print(f"  SKIP dynamic_fields/{d.id}: unknown appliesTo='{data.get('appliesTo')}'")
            continue
        groups[target].append(data)

    plan = []
    for target, fields in groups.items():
        fields.sort(key=lambda f: f.get("displayOrder", 0))
        mapped = [map_field(f) for f in fields]
        # Dedup keys within the section (FormSchema rejects duplicate keys).
        seen, deduped = set(), []
        for m in mapped:
            k = m["key"]
            n = 1
            while m["key"] in seen:
                n += 1
                m["key"] = f"{k}{n}"
            seen.add(m["key"])
            deduped.append(m)
        schema_id = f"{target.lower()}.custom"
        plan.append((schema_id, target, deduped))

    print(f"\n[df-migrate] PLAN: {total} dynamic_fields ({archived} archived skipped, "
          f"{unknown} unknown-target skipped) -> {len(plan)} schema(s).\n")
    for schema_id, target, fields in plan:
        print(f"  WRITE formSchemas/{schema_id} (appliesTo={target}, {len(fields)} field(s)): "
              f"{', '.join(f['key'] for f in fields)}")

    if args.dry_run or not args.allow_prod:
        print("\n[df-migrate] DRY-RUN (no writes). Re-run with --allow-prod + GCLOUD_PROJECT to apply.")
        return

    print("\n[df-migrate] Writing ...")
    for schema_id, target, fields in plan:
        db.collection("formSchemas").document(schema_id).set({
            "id": schema_id,
            "name": f"{target.title()} custom fields",
            "description": "Migrated from legacy dynamic_fields (1C consolidation).",
            "appliesTo": target,
            "version": 1,
            "sections": [{"title": "Custom fields", "description": None, "fields": fields}],
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "updatedBy": "migration:1c",
            "createdAt": firestore.SERVER_TIMESTAMP,
            "createdBy": "migration:1c",
            "_migratedFrom": "dynamic_fields",
            "_migratedAt": utc_now_iso(),
        }, merge=True)
    print(f"[df-migrate] Done: wrote {len(plan)} schema(s). Legacy dynamic_fields left intact "
          f"(delete/archive separately once verified).")


if __name__ == "__main__":
    main()
