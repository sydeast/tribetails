# Firestore document-type audit, 2026-07-20

Closes the handoff item "audit every android model against real Firestore
document types rather than against past crashes". Every type below was read
from the live `auntieos-ttpc` database, not inferred from a model or a
past Sentry event.

Method: profile up to 60 documents per collection, record the set of runtime
types seen per field, then flag any field whose observed types disagree with
the Kotlin declaration that decodes it. All 44 non-empty collections were
profiled.

## Result: two live decode crashes, both now fixed

Firebase `toObject()` calls the Kotlin bean setter per field. A non-null
`String` setter carries an `Intrinsics.checkNotNullParameter`, so one bad
document throws and **blanks the entire query result**, not just its own row.
That blast radius is why both of these presented as "the list is empty" rather
than as a visible error.

### 1. `invoices.viewed` — Boolean where the models say String

Sentry `AUNTIEOS-ADMIN-1J`. Root cause was **seed data, not the model**.

- All 14 real invoices store `viewed` as `"Yes"` / `"No"`.
- Both Kotlin models declare `String` (android `Models.kt:342`,
  commonMain `FirestoreClient.kt:2718`).
- `scripts/seed_test_sandbox.ts` wrote it as a Firestore **boolean** on the 3
  sandbox invoices, so android's `getInvoices()` threw in test mode only.

Fixed by making the seed match production: `InvoiceDoc.viewed` is now typed
`'Yes' | 'No'`, the three seeded invoices write strings, and a seed test
asserts it. The 3 live sandbox documents were patched in place. The portal is
unaffected either way, because `getMyInvoices`'s `boolFrom` already accepted
both spellings.

### 2. `visit_logs.arrival` — null where the model said non-null

Not previously reported anywhere. 8 of 83 live `visit_logs` store
`arrival: null`, and `VisitLog.arrival` was a non-null `String`, so
`getVisitLogs()` blanked the whole screen for the operator.

Fixed by widening to `String?` (`Models.kt:375`) with a regression test. No
call site reads `.arrival`, and web/desktop never decode `visit_logs`, so the
change is contained to that one declaration.

## Everything else is already correct

Every other null-bearing field is already declared `String?` in the models that
decode it. The fields below carry nulls in production and are correctly
nullable today, so they are listed as verified-safe, not as work:

`kin`: feedingInstructions, walkingInstructions, medications, allergies,
emergencyNotes, sitterNotes. `kin_care_sessions`: comments, poopLogged,
arrival, length, medicationGivenFor, peeLogged, mealServedTo, otherActions.
`kin_care_reports`: arrivedAt. `the_411`: pottyRoutine, feedingFrequency,
vetName, feedingAmount, breed. `generated_drafts`: serviceType, kinNames,
kinfolkId, kinfolkName. `invoices`: paymentsHistory. `clients`: displayName.
`emailTemplates`: html.

No Timestamp-versus-String drift reaches any android decode path.

## A third crash class: fields missing from a model that overwrites the document

Both trees save these records with a whole-document write, android via
`.set(kin)` / `.set(kinfolk)` and commonMain via `platformUpdateKin` /
`platformUpdateKinfolk`. Neither merges. So a field that is absent from the
Kotlin model is not merely unread, it is **destroyed on every save**. This is
silent, and it is the inverse of a decode crash: nothing throws.

The commonMain `tags` comment already states the rule ("pass the record you
LOADED, and every other field round-trips instead of being wiped"), but that
guarantee only covers fields that exist on the model. Three did not:

| Field | Live coverage | Type | Was missing from |
|---|---|---|---|
| `kin.familyKinPath` | 24 of 24 | string | commonMain Kin, android Kin |
| `kin.updatedAt` | 23 of 24 | **Timestamp** | commonMain Kin, android Kin |
| `kinfolk.updatedAt` | 8 of 12 | **string** | commonMain Kinfolk, android Kinfolk |

Note the cross-collection drift: `updatedAt` is a Timestamp on `kin` and a
string on `kinfolk`. Both are now decoded through the tolerant path that already
existed for this exact situation, `FirestoreInstantStringSerializer` on
commonMain and the raw `Any?` + `firestoreInstantToIso()` pattern on android, so
neither spelling can throw.

`kin.photos` is deliberately still missing from commonMain, and it should stay
missing. It is a Baserow-era field, and the operator confirmed on 2026-07-20
that **Baserow and n8n are both dead**. The live data agrees: across the whole
database there is not one non-empty Baserow-shaped media field.

| Field | Live state |
|---|---|
| `kin.photos` | empty array on 1 of 24, absent on the rest |
| `the_411.gallery` | empty array on 8 of 23, absent on the rest |
| `kinfolk.media` | absent on all 12 |

Real media lives in the `media_files` collection. Porting `BaserowFile` to
commonMain to "fix" the round-trip would add a dead type to carry a field
nothing writes, so the model now says so explicitly rather than inviting the
next person to port it.

Related dead-code state, verified not assumed: MyTribe has **zero** n8n
references left, so the n8n retirement Phase B is already done there.
`android/.../data/api/BaserowApi.kt` is already a 4-line tombstone (retired
2026-05-02, package declaration only) and was left alone. The stale
`FirestoreClient` header warning that "the Baserow→Firestore migration is
incomplete and has failed multiple times" was corrected, since it now describes
a system that no longer exists. The remaining Baserow debris is legacy Python
scripts and `sotu-hosting/migrate-baserow-drafts.js`, none of it wired into a
build.

## A handoff finding that did not survive checking

The 07-20 handoff recorded that commonMain's `tags` had been left as a plain
`List<String>` while android got the hardened type, and called it a divergence.
It is not. commonMain decodes `tags` through `TolerantStringListSerializer`,
which is the web equivalent of android's raw `Any?` plus `decodeTagNames`.
Different mechanism, same tolerance, both safe. No work needed.

## Two findings that are NOT decode crashes

Both are real, neither is urgent, and neither is fixed here.

**`formSchemas.updatedAt` is a Timestamp on one document and a string on the
other two.** It never reaches a Firestore decode, because android reads form
schemas through the `listFormSchemas` callable. It is a backend consistency
problem, and it is the exact shape that becomes a crash the moment someone
adds a direct read.

**`invoices.status` holds `"Yes"` / `"No"` on all 14 real invoices.** It is not
a status. The seeded sandbox invoices instead use a *different* field,
`invoiceStatus`, carrying the real values (`open` / `paid` / `credit`), and
nothing reconciles the two. This is the likely mechanism behind AO-12, "admin
says PAID on a credit the portal calls CREDIT". Deciding which field is
canonical is a data-model call, and it needs the operator, so it is being
surfaced rather than guessed at.

## Verification

```sh
# Re-profile every collection for mixed field types
cd MyTribe/functions && node -e "…"   # see session transcript

# Gates
cd MyTribe/functions && ./node_modules/.bin/vitest run     # 1544 passed
cd AuntieOS/android && ./gradlew :app:testDebugUnitTest
```
