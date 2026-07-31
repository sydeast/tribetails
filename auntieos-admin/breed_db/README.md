# Breed DB

Dog & cat breed reference data, scraped from 6 sources and merged into one
Firestore document per breed.

**Output:** `breeds_dogs.json` (478) + `breeds_cats.json` (103) = 581 breeds.

## Sources
- Dogs: Wamiz (wamiz.co.uk/dog) · Royal Kennel Club · Chewy
- Cats: TICA · Wamiz (wamiz.co.uk/cat) · Chewy

## Pipeline
```bash
cd breed_db
pip install --break-system-packages requests beautifulsoup4 lxml

# 1) crawl all sources -> raw/scrape_<source>_<species>.json  (resumable; safe to re-run)
#    BUDGET caps each run's wall-clock seconds; just re-run until "ALL_COMPLETE".
BUDGET=120 python3 scrape_breeds.py

# 2) normalise + match across sources + merge -> breeds_*.json + reports/coverage.md
python3 build_db.py

# 3) load into Firestore (dry-run prints the plan and writes nothing)
python3 seed_breeds.py --dry-run
#    real write (needs the admin-SDK key already in the AuntieOS root):
GCLOUD_PROJECT=auntieos-ttpc \
GOOGLE_APPLICATION_CREDENTIALS=../auntieos-ttpc-firebase-adminsdk-fbsvc-7afc8dd201.json/<keyfile> \
python3 seed_breeds.py --allow-prod
```

Collections: `dog_breeds`, `cat_breeds` (doc id = breed slug).

## Document model
See `SCHEMA.md`. Each attribute = `{value, source, sourceKey, alternatives[]}`;
docs carry a `hasAlternativeValues` boolean. Purchase price is excluded from
every source, per spec.

## Notes & limitations (see reports/coverage.md for the full list)
- Cross-source breed matching is name+slug based (best-effort, per request).
  337 breeds are single-source — mostly genuine (Wamiz's long tail of European
  breeds, RKC-only variants, Chewy-only US breeds), but a few are unmatched
  naming variants (e.g. Wamiz "Labrador" vs RKC/Chewy "Labrador Retriever").
  All single-source breeds are listed in coverage.md for manual review.
- Chewy lists only 18 cat breeds, so most cats merge from TICA + Wamiz only.
- Chewy trait ratings are captured as real 1–5 numbers (from `aria-valuenow`).
- TICA exposes structured data only as taxonomy classes + an "at a glance"
  blurb; two new breeds (Tennessee Rex, Toybob) have no taxonomy yet and are
  content-only.
- Dropped `wamiz/chihuahua-a-poils-court` (index entry resolves to the wrong
  breed page); the real Chihuahua is retained.

## Firestore write status
SEEDED in `auntieos-ttpc` on 2026-06-13: live `dog_breeds`/`cat_breeds` docs
carry `_seededAt: 2026-06-13T05:42:29Z` (verified by a direct read on
2026-07-31). This section previously said "not yet written to a live project",
which was stale and misled a debugging pass into hunting a data gap that did
not exist; the real 2026-07-31 dropdown bug was a client focus-wiring defect.
Re-running the seeder is a safe idempotent upsert: provide the admin-SDK key
path and run step 3 with `--allow-prod`.
