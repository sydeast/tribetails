#!/usr/bin/env python3
"""Merge per-source breed scrapes into one document per breed.

Input : raw/pilot_raw.json (or any raw file passed as --in), a list of
        per-(breed, source) records whose `attrs` keys are ALREADY mapped to
        canonical attribute names (see SCHEMA.md for the source->canonical map).
Output: breeds_dogs.json and breeds_cats.json (merged, one doc per breed).

Merge rule (per the spec):
  - For each canonical attribute, take the FIRST source's value (sources are
    visited in a fixed per-species priority order) as the primary `value`.
  - Every DIFFERING value from a later source is appended to `alternatives`,
    each carrying its own `source`/`sourceKey`/`scale` provenance.
  - If a later source repeats an existing value, it is NOT duplicated; the
    source is recorded under `agreedBy` on the matching entry instead.
  - Doc-level `hasAlternativeValues` is true iff ANY attribute has >=1
    alternative.

Fail-loud: unknown species or malformed records raise, they are never skipped
silently.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

# Source visit order per species. The first source that supplies an attribute
# provides the primary value; later sources contribute alternatives.
SOURCE_PRIORITY = {
    "dog": ["wamiz", "rkc", "chewy"],
    "cat": ["tica", "wamiz", "chewy"],
}


def _eq(a, b):
    """Order-insensitive equality for lists; plain equality otherwise."""
    if isinstance(a, list) and isinstance(b, list):
        return sorted(map(json.dumps, a)) == sorted(map(json.dumps, b))
    return a == b


def merge_breed(records: list[dict]) -> dict:
    species = records[0]["species"]
    if species not in SOURCE_PRIORITY:
        raise ValueError(f"Unknown species {species!r} for {records[0].get('id')!r}")
    order = SOURCE_PRIORITY[species]

    by_source = {r["source"]: r for r in records}
    ordered_sources = [s for s in order if s in by_source]
    # Any source not in the priority list is appended (fail-loud surprise guard).
    for r in records:
        if r["source"] not in order:
            raise ValueError(f"Source {r['source']!r} not in priority for {species}")

    attributes: dict[str, dict] = {}
    content: dict[str, dict] = {}
    sources_meta: dict[str, dict] = {}

    for src in ordered_sources:
        rec = by_source[src]
        sources_meta[src] = {
            "url": rec.get("url"),
            **({"profileId": rec["profileId"]} if "profileId" in rec else {}),
            **({"group": rec["group"]} if "group" in rec else {}),
            "scraped": True,
        }
        # attributes
        for key, field in rec.get("attrs", {}).items():
            entry = {"value": field["value"], "source": src, "sourceKey": field.get("sourceKey")}
            if "scale" in field:
                entry["scale"] = field["scale"]
            if key not in attributes:
                attributes[key] = {**entry, "alternatives": []}
                continue
            slot = attributes[key]
            # does it match the primary or an existing alternative?
            candidates = [slot] + slot["alternatives"]
            match = next((c for c in candidates if _eq(c["value"], field["value"])), None)
            if match is not None:
                match.setdefault("agreedBy", [])
                if src not in match["agreedBy"]:
                    match["agreedBy"].append(src)
            else:
                slot["alternatives"].append(entry)
        # long-form content, kept per-source
        for ckey, ctext in rec.get("content", {}).items():
            content.setdefault(ckey, {})[src] = ctext

    has_alternatives = any(a["alternatives"] for a in attributes.values())

    return {
        "id": records[0]["id"],
        "name": records[0]["name"],
        "species": species,
        "sources": sources_meta,
        "hasAlternativeValues": has_alternatives,
        "attributes": attributes,
        "content": content,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", default="raw/pilot_raw.json")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    here = Path(__file__).parent
    raw = json.loads((here / args.infile).read_text())
    records = raw["records"]

    by_id: dict[str, list] = {}
    for r in records:
        by_id.setdefault(r["id"], []).append(r)

    docs = [merge_breed(recs) for recs in by_id.values()]
    dogs = sorted([d for d in docs if d["species"] == "dog"], key=lambda d: d["id"])
    cats = sorted([d for d in docs if d["species"] == "cat"], key=lambda d: d["id"])

    outdir = here / args.outdir
    (outdir / "breeds_dogs.json").write_text(json.dumps({"breeds": dogs}, indent=2, ensure_ascii=False))
    (outdir / "breeds_cats.json").write_text(json.dumps({"breeds": cats}, indent=2, ensure_ascii=False))

    n_alt = sum(d["hasAlternativeValues"] for d in docs)
    print(f"Merged {len(docs)} breeds -> {len(dogs)} dogs, {len(cats)} cats "
          f"({n_alt} with alternative values).")


if __name__ == "__main__":
    main()
