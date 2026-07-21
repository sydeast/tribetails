#!/usr/bin/env python3
"""Clean the raw Google-Maps vet scrape (GoogleVetAustinMetro.csv) into a
vet_clinics seed. Fail loud: if a row has no name it is reported, not silently
dropped. No prod writes here, this only emits clean JSON + a report.

Fields kept (operator decision 2026-06-08): name, address, phone, website,
isEmergency (derived from category), googleMapsUrl. Seed rows are verified=true.
"""
import csv
import json
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "GoogleVetAustinMetro.csv"
OUT = Path(__file__).resolve().parent.parent / "vet_bank_seed.json"

PHONE_RE = re.compile(r"\(\d{3}\)\s*\d{3}-\d{4}")
REVIEW_RE = re.compile(r"^\(\d[\d,]*\)$")  # review count e.g. "(1,233)"
RATING_RE = re.compile(r"^\d(\.\d)?$")  # rating e.g. "4.3"
HOURS_RE = re.compile(r"\b(AM|PM|Opens?|Closed|24 hours)\b", re.IGNORECASE)
STOPWORDS = {"website", "directions", "·", ""}


def looks_like_address(v: str) -> bool:
    """The scrape leaks the address into different columns per row, so match by
    shape rather than position: a string with both a digit and a letter that is
    not a phone, url, rating, review-count, hours blurb, or UI label."""
    v = (v or "").strip()
    if v.lower() in STOPWORDS or v.startswith("·"):
        return False
    if v.startswith("http") or PHONE_RE.search(v):
        return False
    if REVIEW_RE.match(v) or RATING_RE.match(v) or HOURS_RE.search(v):
        return False
    has_digit = any(c.isdigit() for c in v)
    has_alpha = any(c.isalpha() for c in v)
    return has_digit and has_alpha and len(v) >= 5


def clean_phone(v: str) -> str:
    m = PHONE_RE.search(v or "")
    return m.group(0).strip() if m else ""


def main() -> int:
    if not SRC.exists():
        print(f"FATAL: source not found: {SRC}", file=sys.stderr)
        return 1

    rows = list(csv.DictReader(SRC.open(encoding="utf-8")))
    clinics: list[dict] = []
    skipped: list[dict] = []
    seen: dict[str, int] = {}  # dedupe key -> index in clinics

    for i, r in enumerate(rows):
        name = (r.get("qBF1Pd") or "").strip()
        if not name:
            # blank spacer rows in the scrape; report only if it had any content
            if any((v or "").strip() not in ("", "·") for v in r.values()):
                skipped.append({"row": i, "reason": "no name", "raw": r})
            continue

        maps_url = (r.get("hfpxzc href") or "").strip()
        website = (r.get("lcr4fd href") or "").strip()
        category = (r.get("W4Efsd") or "").strip()
        is_emergency = "emergency" in category.lower() or "emergency" in name.lower()

        # phone: prefer the UsdlK column, fall back to scanning every field
        phone = clean_phone(r.get("UsdlK", ""))
        if not phone:
            for v in r.values():
                phone = clean_phone(v or "")
                if phone:
                    break

        # address: scan all fields for an address-shaped value (column shifts)
        address = ""
        for v in r.values():
            v = (v or "").strip()
            if looks_like_address(v):
                address = v
                break

        clinic = {
            "name": name,
            "address": address,
            "phone": phone,
            "website": website if website.startswith("http") else "",
            "isEmergency": is_emergency,
            "googleMapsUrl": maps_url if maps_url.startswith("http") else "",
            "verified": True,
            "source": "google-austin-metro-2026-06",
        }

        key = re.sub(r"\s+", " ", name.lower()).strip()
        if key in seen:
            # merge: keep the row with the most filled fields
            existing = clinics[seen[key]]
            if sum(1 for x in clinic.values() if x) > sum(1 for x in existing.values() if x):
                clinics[seen[key]] = clinic
            continue
        seen[key] = len(clinics)
        clinics.append(clinic)

    OUT.write_text(json.dumps(clinics, indent=2, ensure_ascii=False), encoding="utf-8")

    no_addr = [c["name"] for c in clinics if not c["address"]]
    no_phone = [c["name"] for c in clinics if not c["phone"]]
    print(f"rows read:        {len(rows)}")
    print(f"clinics cleaned:  {len(clinics)} (deduped)")
    print(f"emergency/24hr:   {sum(1 for c in clinics if c['isEmergency'])}")
    print(f"missing address:  {len(no_addr)}")
    print(f"missing phone:    {len(no_phone)}")
    print(f"skipped rows:     {len(skipped)}")
    print(f"-> wrote {OUT}")
    if no_addr:
        print("\n  NO ADDRESS (need manual review):")
        for n in no_addr:
            print(f"    - {n}")
    if no_phone:
        print("\n  NO PHONE:")
        for n in no_phone:
            print(f"    - {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
