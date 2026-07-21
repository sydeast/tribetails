"""Seed the_dossier and the_411 from existing visit_logs data.

For each Kinfolk: reads all their visit_logs auntie_notes, calls Claude to
generate a Dossier profile, writes one row to the_dossier (id:643).

For each Kin: same process, writes one row to the_411 (id:644).

Idempotent: checks for existing rows by kinfolk_id / kin_id before inserting.
Use --force to overwrite existing profiles.

Run:
    python3 seed_profiles.py
    python3 seed_profiles.py --force
    python3 seed_profiles.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baserow_auth import BaserowClient, _load_env  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent
VOICE_RULES_PATH = PROJECT_ROOT.parent / "auntie_voice_rules.md"


def _fetch_all(bw: BaserowClient, table_id: int) -> list[dict]:
    out: list[dict] = []
    page = 1
    while True:
        resp = bw.get(f"/database/rows/table/{table_id}/?user_field_names=true&size=200&page={page}")
        out.extend(resp["results"])
        if not resp.get("next"):
            break
        page += 1
    return out


def _call_claude(env: dict, system: str, user: str) -> str:
    from anthropic import Anthropic
    client = Anthropic(api_key=env["ANTHROPIC_API_KEY"])
    resp = client.messages.create(
        model=env.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
        max_tokens=1500,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()


# ---- Dossier generation ---------------------------------------------------

DOSSIER_SYSTEM = """\
You are Auntie, building your own internal Kinfolk Dossier from your past visit notes.
Extract everything you actually know about this family from the real notes below.
Be specific and concrete — only include what's actually in the notes, no assumptions.
Write in your voice (first person, warm, specific) as if writing notes to yourself.
No em dashes. No corporate language.
"""

def _generate_dossier(kinfolk_name: str, notes_corpus: list[str], env: dict) -> dict:
    """Call Claude to extract a Dossier profile. Returns a dict of field values."""
    notes_text = "\n\n---\n\n".join(notes_corpus)
    user_msg = f"""\
KINFOLK: {kinfolk_name}

Here are all of Auntie's past visit notes for this household:

{notes_text}

---

From these notes, extract and write the following sections. Be specific, be real, reference actual moments from the notes. If you don't have info for a section, write "Not yet documented."

COMMUNICATION STYLE:
(How does this Kinfolk communicate? What have I observed about how they reach out, what they respond to, what they care about knowing?)

HOUSEHOLD NOTES:
(What do I know about this home — layout, routines, quirks, what to watch for?)

RELATIONSHIP WITH AUNTIE:
(How long have we worked together? What's our dynamic? What do they trust me with? Any special moments or inside understandings?)

IMPORTANT LIFE CONTEXT:
(Job, schedule, family situation, stressors, any big life things I know about that affect how I show up for them?)

PREFERRED CONTACT METHOD:
(Text, call, app? Any preferences they've shown?)

RAW SUMMARY:
(Write a flowing narrative paragraph that captures everything I know about this Kinfolk family — who they are, what they care about, how they relate to their Kin, how they relate to me. This is my personal profile for them, written in my voice.)
"""
    raw = _call_claude(env, DOSSIER_SYSTEM, user_msg)

    def _extract(label: str, raw: str, next_label: str | None = None) -> str:
        start = raw.find(f"{label}:")
        if start == -1:
            return "Not yet documented."
        start = raw.find("\n", start) + 1
        if next_label:
            end = raw.find(f"{next_label}:", start)
            return raw[start:end].strip() if end != -1 else raw[start:].strip()
        return raw[start:].strip()

    labels = [
        "COMMUNICATION STYLE",
        "HOUSEHOLD NOTES",
        "RELATIONSHIP WITH AUNTIE",
        "IMPORTANT LIFE CONTEXT",
        "PREFERRED CONTACT METHOD",
        "RAW SUMMARY",
    ]

    return {
        "communication_style":      _extract("COMMUNICATION STYLE", raw, "HOUSEHOLD NOTES"),
        "household_notes":          _extract("HOUSEHOLD NOTES", raw, "RELATIONSHIP WITH AUNTIE"),
        "relationship_with_auntie": _extract("RELATIONSHIP WITH AUNTIE", raw, "IMPORTANT LIFE CONTEXT"),
        "important_life_context":   _extract("IMPORTANT LIFE CONTEXT", raw, "PREFERRED CONTACT METHOD"),
        "preferred_contact_method": _extract("PREFERRED CONTACT METHOD", raw, "RAW SUMMARY"),
        "raw_summary":              _extract("RAW SUMMARY", raw),
    }


# ---- 411 generation -------------------------------------------------------

FOUR11_SYSTEM = """\
You are Auntie, building your own internal Kin 411 from your past visit notes.
Extract everything you actually know about this specific Kin from the real notes below.
Be specific and concrete — only include what's actually observed, no assumptions or guesses.
Write in your voice (first person, warm, observational) as if writing notes to yourself.
No em dashes. No corporate language.
"""

def _generate_411(kin_name: str, species: str, kinfolk_name: str, notes_corpus: list[str], env: dict) -> dict:
    notes_text = "\n\n---\n\n".join(notes_corpus)
    user_msg = f"""\
KIN: {kin_name} ({species}, part of {kinfolk_name}'s household)

Here are all of Auntie's past visit notes for this household (extract what's specific to {kin_name}):

{notes_text}

---

From these notes, extract and write the following sections about {kin_name} specifically. Reference actual moments from the notes. If you don't have info for a section, write "Not yet documented."

PERSONALITY:
(What's this Kin's energy, temperament, how do they greet me, what's their general vibe?)

DIETARY DETAILS:
(What do they eat, how much, any picky habits, who eats first if multi-kin household, supplement or meds mixed in food?)

MEDICAL NOTES:
(Any conditions, medications, mobility issues, vet notes, things to watch for?)

QUIRKS AND PREFERENCES:
(What do they love? What do they hate? What are their specific little habits and personality things?)

SAFETY NOTES:
(Anything I need to know to keep them safe — escape risk, resource guarding, fear triggers, what to do if something goes wrong?)

RELATIONSHIP WITH OTHER KIN:
(How do they interact with the other Kin in the household?)

RAW SUMMARY:
(Write a flowing narrative paragraph that captures everything I know about {kin_name} — their personality, their quirks, what makes them special, what I always remember when I think about them. Written in my voice.)
"""
    raw = _call_claude(env, FOUR11_SYSTEM, user_msg)

    def _extract(label: str, raw: str, next_label: str | None = None) -> str:
        start = raw.find(f"{label}:")
        if start == -1:
            return "Not yet documented."
        start = raw.find("\n", start) + 1
        if next_label:
            end = raw.find(f"{next_label}:", start)
            return raw[start:end].strip() if end != -1 else raw[start:].strip()
        return raw[start:].strip()

    return {
        "personality":                _extract("PERSONALITY", raw, "DIETARY DETAILS"),
        "dietary_details":            _extract("DIETARY DETAILS", raw, "MEDICAL NOTES"),
        "medical_notes":              _extract("MEDICAL NOTES", raw, "QUIRKS AND PREFERENCES"),
        "quirks_and_preferences":     _extract("QUIRKS AND PREFERENCES", raw, "SAFETY NOTES"),
        "safety_notes":               _extract("SAFETY NOTES", raw, "RELATIONSHIP WITH OTHER KIN"),
        "relationship_with_other_kin":_extract("RELATIONSHIP WITH OTHER KIN", raw, "RAW SUMMARY"),
        "raw_summary":                _extract("RAW SUMMARY", raw),
    }


# ---- Main -----------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Seed the_dossier and the_411 profiles")
    parser.add_argument("--force", action="store_true", help="Overwrite existing profiles")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be done, write nothing")
    args = parser.parse_args(argv)

    env = _load_env()
    bw = BaserowClient(env=env)

    # Load all source data
    print("Loading data from Baserow...")
    kinfolk_rows = _fetch_all(bw, int(env["BASEROW_TABLE_KINFOLK"]))
    kin_rows     = _fetch_all(bw, int(env["BASEROW_TABLE_KIN"]))
    visit_logs   = _fetch_all(bw, int(env["BASEROW_TABLE_VISIT_LOGS"]))
    dossier_rows = _fetch_all(bw, int(env["BASEROW_TABLE_THE_DOSSIER"]))
    four11_rows  = _fetch_all(bw, int(env["BASEROW_TABLE_THE_411"]))

    kinfolk_lookup = {r["id"]: (r.get("Display Name") or "") for r in kinfolk_rows}
    existing_dossier_kf_ids = {int(r.get("kinfolk_id") or 0) for r in dossier_rows}
    existing_411_kin_ids    = {int(r.get("kin_id") or 0) for r in four11_rows}

    # Group visit_log notes by kinfolk_id
    notes_by_kinfolk: dict[int, list[str]] = {}
    for log in visit_logs:
        kfid = int(log.get("kinfolk_id") or 0)
        note = (log.get("auntie_notes") or "").strip()
        if kfid and note:
            notes_by_kinfolk.setdefault(kfid, []).append(note)

    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")

    # === DOSSIER ===
    print(f"\n{'='*50}")
    print("SEEDING THE DOSSIER")
    print(f"{'='*50}")

    for kf in kinfolk_rows:
        kfid = kf["id"]
        name = kf.get("Display Name") or f"Kinfolk {kfid}"
        notes = notes_by_kinfolk.get(kfid, [])

        if not notes:
            print(f"\n  [{name}] — no visit notes, skipping")
            continue

        if kfid in existing_dossier_kf_ids and not args.force:
            print(f"\n  [{name}] — Dossier exists, skipping (use --force to overwrite)")
            continue

        print(f"\n  [{name}] — {len(notes)} visit notes → generating Dossier...")

        if args.dry_run:
            print("    DRY RUN — would write Dossier row")
            continue

        profile = _generate_dossier(name, notes, env)

        row = {
            "display_name": name,
            "kinfolk_id": kfid,
            "last_updated": now,
            **profile,
        }

        if kfid in existing_dossier_kf_ids:
            # Find and update existing row
            existing = next(r for r in dossier_rows if int(r.get("kinfolk_id") or 0) == kfid)
            bw.patch_jwt(
                f"/database/rows/table/{env['BASEROW_TABLE_THE_DOSSIER']}/{existing['id']}/?user_field_names=true",
                row,
            )
            print(f"    ✅ Updated Dossier row {existing['id']}")
        else:
            result = bw.post_token(
                f"/database/rows/table/{env['BASEROW_TABLE_THE_DOSSIER']}/?user_field_names=true",
                row,
            )
            print(f"    ✅ Created Dossier row {result['id']}")

    # === THE 411 ===
    print(f"\n{'='*50}")
    print("SEEDING THE 411")
    print(f"{'='*50}")

    for kin in kin_rows:
        kid = kin["id"]
        name = kin.get("Name") or f"Kin {kid}"
        species = kin.get("species") or ""
        kfid = int(kin.get("kinfolk_id") or 0)
        kinfolk_name = kinfolk_lookup.get(kfid, "")
        notes = notes_by_kinfolk.get(kfid, [])  # use household notes as corpus

        if not notes:
            print(f"\n  [{name}] — no visit notes for household, skipping")
            continue

        if kid in existing_411_kin_ids and not args.force:
            print(f"\n  [{name}] — 411 exists, skipping (use --force to overwrite)")
            continue

        print(f"\n  [{name} ({species})] — {len(notes)} household notes → generating 411...")

        if args.dry_run:
            print("    DRY RUN — would write 411 row")
            continue

        profile = _generate_411(name, species, kinfolk_name, notes, env)

        row = {
            "display_name": name,
            "kin_id": kid,
            "species": species,
            "breed": kin.get("breed") or "",
            "last_updated": now,
            **profile,
        }

        if kid in existing_411_kin_ids:
            existing = next(r for r in four11_rows if int(r.get("kin_id") or 0) == kid)
            bw.patch_jwt(
                f"/database/rows/table/{env['BASEROW_TABLE_THE_411']}/{existing['id']}/?user_field_names=true",
                row,
            )
            print(f"    ✅ Updated 411 row {existing['id']}")
        else:
            result = bw.post_token(
                f"/database/rows/table/{env['BASEROW_TABLE_THE_411']}/?user_field_names=true",
                row,
            )
            print(f"    ✅ Created 411 row {result['id']}")

    print("\n\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
