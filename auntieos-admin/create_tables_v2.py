"""Create the three new Auntie OS v2 tables in Baserow database 201.

Tables:
  - training_documents  (voice training examples)
  - the_dossier         (living Kinfolk profiles)
  - the_411             (living Kin profiles)

Run:
    python3 create_tables_v2.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import BaserowClient, _load_env  # noqa: E402

DATABASE_ID = 201

TABLE_SPECS = [
    {
        "name": "training_documents",
        "primary_field_name": "title",
        "extra_fields": [
            {"name": "content",            "type": "long_text"},
            {"name": "communication_type", "type": "text"},
            {"name": "kinfolk_ref",        "type": "text"},
            {"name": "uploaded_at",        "type": "text"},
            {"name": "notes",              "type": "long_text"},
        ],
    },
    {
        "name": "the_dossier",
        "primary_field_name": "display_name",
        "extra_fields": [
            {"name": "kinfolk_id",                "type": "number", "number_decimal_places": 0},
            {"name": "communication_style",       "type": "long_text"},
            {"name": "household_notes",           "type": "long_text"},
            {"name": "relationship_with_auntie",  "type": "long_text"},
            {"name": "important_life_context",    "type": "long_text"},
            {"name": "preferred_contact_method",  "type": "text"},
            {"name": "last_updated",              "type": "text"},
            {"name": "raw_summary",               "type": "long_text"},
        ],
    },
    {
        "name": "the_411",
        "primary_field_name": "display_name",
        "extra_fields": [
            {"name": "kin_id",                        "type": "number", "number_decimal_places": 0},
            {"name": "species",                       "type": "text"},
            {"name": "breed",                         "type": "text"},
            {"name": "personality",                   "type": "long_text"},
            {"name": "dietary_details",               "type": "long_text"},
            {"name": "medical_notes",                 "type": "long_text"},
            {"name": "quirks_and_preferences",        "type": "long_text"},
            {"name": "safety_notes",                  "type": "long_text"},
            {"name": "relationship_with_other_kin",   "type": "long_text"},
            {"name": "last_updated",                  "type": "text"},
            {"name": "raw_summary",                   "type": "long_text"},
        ],
    },
]


def _delete_auto_rows(bw: BaserowClient, table_id: int) -> None:
    """Baserow auto-inserts 2 blank rows on table creation — remove them."""
    resp = bw.get(f"/database/rows/table/{table_id}/?size=10")
    ids = [r["id"] for r in resp.get("results", [])]
    if ids:
        bw.post_token(f"/database/rows/table/{table_id}/batch-delete/", {"items": ids})
        print(f"    ↳ deleted {len(ids)} auto-generated blank row(s)")


def create_table(bw: BaserowClient, db_id: int, spec: dict) -> int:
    """Create a table and all its fields. Returns the new table_id."""
    print(f"\nCreating table: {spec['name']}")

    # Create the table (primary field = first field by convention)
    table = bw.post_jwt(
        f"/database/tables/database/{db_id}/",
        {"name": spec["name"]},
    )
    table_id = table["id"]
    print(f"  table_id: {table_id}")

    # Rename the auto-created primary field to spec's primary_field_name.
    # Baserow creates "Name" as the primary text field automatically.
    fields_resp = bw.get(f"/database/fields/table/{table_id}/")
    # Baserow returns a bare list for this endpoint
    fields_list = fields_resp if isinstance(fields_resp, list) else fields_resp.get("results", [])
    primary_field = next((f for f in fields_list if f.get("primary")), None)
    if primary_field:
        bw.patch_jwt(
            f"/database/fields/{primary_field['id']}/",
            {"name": spec["primary_field_name"]},
        )
        print(f"  renamed primary field → '{spec['primary_field_name']}'")

    # Create extra fields
    for field in spec["extra_fields"]:
        payload = {"name": field["name"], "type": field["type"]}
        if field["type"] == "number":
            payload["number_decimal_places"] = field.get("number_decimal_places", 0)
        bw.post_jwt(f"/database/fields/table/{table_id}/", payload)
        print(f"  + {field['name']} ({field['type']})")

    _delete_auto_rows(bw, table_id)
    return table_id


def _env_var_name(table_name: str) -> str:
    return "BASEROW_TABLE_" + table_name.upper().replace(" ", "_")


def main() -> int:
    env = _load_env()
    bw = BaserowClient(env=env)

    created: dict[str, int] = {}
    for spec in TABLE_SPECS:
        var = _env_var_name(spec["name"])
        existing = env.get(var)
        if existing:
            print(f"\n⏭  {spec['name']} already exists (id {existing}), skipping.")
            created[spec["name"]] = int(existing)
            continue
        table_id = create_table(bw, DATABASE_ID, spec)
        created[spec["name"]] = table_id

    print("\n\n=== ADD THESE TO YOUR .env ===")
    for name, tid in created.items():
        var = _env_var_name(name)
        print(f"{var}={tid}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
