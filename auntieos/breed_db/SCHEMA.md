# Breed DB — schema & merge model

Reference data for dog & cat breeds, merged from 6 sources into one Firestore
doc per breed. **Full dataset: 478 dogs + 103 cats = 581 breeds** (118 with data
from all 3 of their sources, 126 from 2, 337 single-source). 243 breeds carry
cross-source alternative values.

Pipeline: `scrape_breeds.py` (crawl → raw/) → `build_db.py` (normalise, match,
merge → breeds_*.json + reports/coverage.md) → `seed_breeds.py` (Firestore).
The pilot files (`raw/pilot_raw.json`, `merge_breeds.py`) are kept as the
original 3-breed reference; the production path is the three scripts above.

## Sources & visit order

The **first** source (in this order) that supplies an attribute provides the
primary value; later sources contribute alternatives.

| Species | Order | Sources |
|---|---|---|
| dog | 1 → 2 → 3 | `wamiz` (wamiz.co.uk/dog) → `rkc` (royalkennelclub.com) → `chewy` (chewy.com/education/dog-breeds) |
| cat | 1 → 2 → 3 | `tica` (tica.org/breed) → `wamiz` (wamiz.co.uk/cat) → `chewy` (chewy.com/education/cat-breeds) |

Not every source has every breed (e.g. Chewy lists only ~18 cat breeds; the
Abyssinian doc therefore has just `tica` + `wamiz`). Missing sources are simply
absent from `sources` — never a blocker.

## Document shape

```jsonc
{
  "id": "affenpinscher",          // slug, used as the Firestore doc id
  "name": "Affenpinscher",
  "species": "dog",               // "dog" | "cat"
  "sources": {                    // provenance per source that had this breed
    "wamiz": { "url": "...", "profileId": 134, "scraped": true },
    "rkc":   { "url": "...", "group": "toy", "scraped": true },
    "chewy": { "url": "...", "scraped": true }
  },
  "hasAlternativeValues": true,   // true if ANY attribute has >=1 alternative
  "attributes": { /* see below */ },
  "content": { /* long-form prose, kept per-source */ }
}
```

### Attribute object (the per-field merge)

```jsonc
"lifeExpectancy": {
  "value": "Between 12 and 14 years",   // primary = first source's value
  "source": "wamiz",
  "sourceKey": "Life expectancy",        // original label on the source page
  "alternatives": [                      // every DIFFERING value, with provenance
    { "value": "Over 12 years", "source": "rkc",   "sourceKey": "Lifespan" },
    { "value": "12 to 15 years","source": "chewy", "sourceKey": "Life Expectancy" }
  ]
}
```

- Chewy 1–5 ratings carry `"scale": "1-5"`.
- If a later source repeats an identical value it is **not** duplicated; the
  source is added to an `agreedBy: [...]` list on the matching entry.
- Multi-valued attributes (temperament, coat colour, eye colour) are arrays;
  height/weight are `{female, male}` objects (Chewy sometimes gives a single
  combined range string).
- `content` holds prose (description, history, common illnesses, TICA "at a
  glance") as `{ canonicalKey: { source: text } }` — kept separate from the
  merged attribute facts.

## Source field → canonical attribute mapping

| Canonical attribute | Wamiz | RKC | TICA | Chewy |
|---|---|---|---|---|
| `lifeExpectancy` | Life expectancy | Lifespan | — | Life Expectancy |
| `temperament` | Temperament | — | `temperament-*` class | Temperament |
| `size` | Size | Size | `size-*` class | — |
| `adultHeight` | Adult size | — | — | Height |
| `adultWeight` | Adult weight | — | — | Weight |
| `coatColour` | Coat colour | — | — | Coat Color |
| `coatType` | Type of coat | Coat length | `coat-length-*` class | — |
| `eyeColour` | Eye colour | — | — | — |
| `shedding` | Shedding | Sheds | — | Shedding Level (1-5) |
| `grooming` | — | Grooming | `grooming-*` class | Grooming Needs (1-5) |
| `exercise` | — | Exercise | `activity-level-*` class | Exercise Needs (1-5) |
| `classification` | — | — | `classification-*` class | — |
| `sizeOfHome` | — | Size of home | — | — |
| `townOrCountry` | — | Town or country | — | — |
| `sizeOfGarden` | — | Size of garden | — | — |
| `vulnerableNativeBreed` | — | Vulnerable native breed | — | — |
| `otherNames` | Other name | — | — | — |
| Chewy-only ratings (1-5) | — | — | — | maintenanceLevel, friendliness, healthIssuesRating, trainingNeeds, playfulness, energyLevel, barkingTendencies, vocalLevel, goodForApartments, sensitiveToColdWeather, sensitiveToWarmWeather, goodForFirstTimeOwners, goodWithKids, goodWithCats, goodWithDogs, goodWithOtherCats, goodWithOtherDogs, likesToBePickedUp, likesToBePet |

"Purchase price" is intentionally dropped from every source, per instructions.

## Decisions I made (flag if you'd prefer otherwise)

1. **`shedding` / `grooming` / `exercise` merge categorical + numeric values.**
   e.g. Affenpinscher shedding = `"Heavy"` (Wamiz) with alternatives `"Yes"`
   (RKC) and `2/5` (Chewy). They mean the same thing but are expressed
   differently; per your "same(ish) key → primary + alternatives" rule they're
   merged, and the differing scales are preserved via `scale`. If you'd rather
   keep each source's format as a separate attribute, say so.
2. **TICA `activity-level` is folded into `exercise`** (same concept). Likewise
   TICA `coat-length` and RKC `Coat length` fold into `coatType`.
3. **Collections:** `dog_breeds` and `cat_breeds` (snake_case, matching repo
   collections like `kin_care_reports`). Doc id = breed slug.
4. **Chewy characteristic ratings are captured as real 1–5 numbers** (from each
   slider's `aria-valuenow`), not just the visible labels — 17 ratings/breed.

## Open questions for the full crawl

- **Master breed lists:** dog names from Wamiz dog A–Z + RKC A–Z + Chewy index
  (union); cat names from TICA + Wamiz cat + Chewy index. Want the **union** of
  all names across sources (recommended), or only breeds present on the primary
  source?
- **TICA "at a glance" is a short prose blurb only** — TICA does not expose
  numeric trait values, just the taxonomy classes (size/activity/grooming/
  coat-length/classification + a one-line temperament). Captured as-is.
- **Name matching across sources:** sources spell/scope breeds differently
  (e.g. Wamiz "Abyssinian Cat" vs TICA "Abyssinian"; Chewy "bengal-cat" slug).
  I normalise to a slug and match on it. A few breeds won't auto-match (e.g.
  RKC groups, coat-variant splits). I'll produce an **unmatched report** rather
  than guess.

## Files
- `raw/pilot_raw.json` — raw per-source scrapes (the crawler's output format)
- `merge_breeds.py` — merge logic (primary + alternatives)
- `breeds_dogs.json`, `breeds_cats.json` — merged docs
- `seed_breeds.py` — Firestore seeder (dry-run default; `--allow-prod` to write)
