#!/usr/bin/env python3
"""Build merged Firestore docs from the raw per-source scrapes.

Steps:
  1. Load raw/scrape_*.json; keep records that have attributes OR content.
  2. Normalise each breed to a match key (handles "Abyssinian Cat" vs
     "Abyssinian", RKC's "Retriever (Labrador)" vs "Labrador Retriever", and
     "-cat"/"-dog"/"-imp" slug suffixes). Group within species.
  3. Merge each group: first source (by per-species priority) is the primary
     value; differing later values become `alternatives`; identical values are
     recorded under `agreedBy`. Doc-level `hasAlternativeValues` flag set.
  4. Write breeds_dogs.json / breeds_cats.json and reports/coverage.md.

Drops a known-bad index entry (wamiz 'chihuahua-a-poils-court' resolves to the
Fila Brasileiro page) rather than seed corrupt data -- noted in the report.
"""
from __future__ import annotations
import json, re, glob
from pathlib import Path
from collections import defaultdict

HERE = Path(__file__).parent
RAW = HERE / "raw"
REPORTS = HERE / "reports"; REPORTS.mkdir(exist_ok=True)
SOURCE_PRIORITY = {"dog": ["wamiz", "rkc", "chewy"], "cat": ["tica", "wamiz", "chewy"]}
DROP = {("wamiz", "chihuahua-a-poils-court")}  # mislabeled index entry -> wrong breed

def namekey(name: str, species: str, source: str = "") -> str:
    n = name or ""
    m = re.match(r"^(.*?)\s*\((.*?)\)\s*$", n)
    if m and source == "rkc":          # RKC group style: "Retriever (Labrador)" -> "Labrador Retriever"
        n = f"{m.group(2)} {m.group(1)}"
    else:                               # elsewhere a paren is an alt-name: drop it
        n = re.sub(r"\s*\(.*?\)", "", n)
    n = n.lower().replace("&", " and ")
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    n = re.sub(r"\s+(cat|dog)$", "", n)
    n = n.replace("short haired", "shorthair").replace("long haired", "longhair")
    n = re.sub(r"\s+(cat|dog)$", "", n).strip()
    return n

def _eq(a, b):
    if isinstance(a, list) and isinstance(b, list):
        return sorted(map(json.dumps, a)) == sorted(map(json.dumps, b))
    return a == b

def load_records():
    recs = []
    for f in glob.glob(str(RAW / "scrape_*.json")):
        for slug, r in json.loads(Path(f).read_text()).items():
            if (r.get("source"), slug) in DROP: continue
            if not (r.get("attrs") or r.get("content")): continue
            recs.append(r)
    return recs

def merge_group(records):
    species = records[0]["species"]
    order = SOURCE_PRIORITY[species]
    records = sorted(records, key=lambda r: order.index(r["source"]))
    primary = records[0]
    # id: prefer the primary source's slug, cleaned of -cat/-dog/-imp
    cid = re.sub(r"-(cat|dog)$", "", primary["slug"])
    cid = re.sub(r"-imp(orted)?$", "", cid)
    name = re.sub(r"\s*\(.*?\)\s*$", "", primary.get("name", "")).strip() or primary["slug"]
    name = re.sub(r"\s+Cat$", "", name)

    attributes, content, sources_meta = {}, {}, {}
    for rec in records:
        src = rec["source"]
        sources_meta[src] = {"url": rec.get("url"), "scraped": True}
        if "profileId" in rec: sources_meta[src]["profileId"] = rec["profileId"]
        if "group" in rec: sources_meta[src]["group"] = rec["group"]
        for key, field in (rec.get("attrs") or {}).items():
            entry = {"value": field["value"], "source": src, "sourceKey": field.get("sourceKey")}
            if "scale" in field: entry["scale"] = field["scale"]
            if key not in attributes:
                attributes[key] = {**entry, "alternatives": []}; continue
            slot = attributes[key]
            match = next((c for c in [slot] + slot["alternatives"] if _eq(c["value"], field["value"])), None)
            if match is not None:
                match.setdefault("agreedBy", [])
                if src not in match["agreedBy"]: match["agreedBy"].append(src)
            else:
                slot["alternatives"].append(entry)
        for ck, cv in (rec.get("content") or {}).items():
            content.setdefault(ck, {})[src] = cv

    return {
        "id": cid, "name": name, "species": species,
        "sources": sources_meta,
        "hasAlternativeValues": any(a["alternatives"] for a in attributes.values()),
        "attributes": attributes, "content": content,
    }

def slugkey(slug: str) -> str:
    s = re.sub(r"-(cat|dog)$", "", slug)
    return re.sub(r"-imp(orted)?$", "", s)

def group_records(recs):
    """Union-find: two records are the same breed if they share a cleaned slug
    OR a normalised name (within the same species)."""
    parent = list(range(len(recs)))
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    def union(a, b): parent[find(a)] = find(b)
    by_slug, by_name = {}, {}
    for i, r in enumerate(recs):
        sp = r["species"]
        sk = (sp, slugkey(r["slug"]))
        nk = (sp, namekey(r.get("name", r["slug"]), sp, r["source"]))
        if sk in by_slug: union(i, by_slug[sk])
        else: by_slug[sk] = i
        if nk in by_name: union(i, by_name[nk])
        else: by_name[nk] = i
    comps = defaultdict(list)
    for i, r in enumerate(recs): comps[find(i)].append(r)
    return list(comps.values())

def main():
    recs = load_records()
    docs = [merge_group(g) for g in group_records(recs)]
    # de-dupe ids (rare slug collisions after cleaning)
    seen = {}
    for d in docs:
        if d["id"] in seen:
            base = d["id"]; k = 2
            while f"{base}--{k}" in seen: k += 1
            d["id"] = f"{base}--{k}"
        seen[d["id"]] = True

    dogs = sorted([d for d in docs if d["species"] == "dog"], key=lambda d: d["id"])
    cats = sorted([d for d in docs if d["species"] == "cat"], key=lambda d: d["id"])
    (HERE / "breeds_dogs.json").write_text(json.dumps({"breeds": dogs}, indent=2, ensure_ascii=False))
    (HERE / "breeds_cats.json").write_text(json.dumps({"breeds": cats}, indent=2, ensure_ascii=False))

    # ---- coverage report ----
    def cov(rows):
        from collections import Counter
        c = Counter()
        multi, single = [], []
        for d in rows:
            srcs = tuple(sorted(d["sources"]))
            c[len(srcs)] += 1
            (multi if len(srcs) > 1 else single).append(d)
        return c, multi, single

    lines = ["# Breed DB build report\n"]
    for label, rows in [("Dogs", dogs), ("Cats", cats)]:
        c, multi, single = cov(rows)
        lines.append(f"## {label}: {len(rows)} merged breeds")
        lines.append(f"- multi-source (2+): {len(multi)}")
        lines.append(f"- single-source only: {len(single)}")
        dist = ", ".join(f"{k} source(s): {v}" for k, v in sorted(c.items()))
        lines.append(f"- source-count distribution: {dist}")
        withalt = sum(d["hasAlternativeValues"] for d in rows)
        lines.append(f"- breeds with alternative values: {withalt}\n")
        lines.append(f"### {label} — single-source breeds (needs-review for cross-source matching)")
        for d in sorted(single, key=lambda x: x["id"]):
            src = list(d["sources"])[0]
            lines.append(f"- `{d['id']}` ({d['name']}) — only **{src}**")
        lines.append("")
    lines.append("## Dropped / known issues")
    lines.append("- `wamiz/chihuahua-a-poils-court` dropped: index entry resolves to the Fila Brasileiro page (mislabeled). Real Chihuahua retained.")
    lines.append("- TICA `tennessee-rex`, `toybob`: pages exist but carry no structured taxonomy yet — kept as content-only records.")
    (REPORTS / "coverage.md").write_text("\n".join(lines))

    print(f"Built {len(dogs)} dog + {len(cats)} cat breeds "
          f"({sum(d['hasAlternativeValues'] for d in docs)} with alternatives).")
    print(f"Report -> reports/coverage.md")

if __name__ == "__main__":
    main()
