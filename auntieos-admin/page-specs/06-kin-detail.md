# Kin detail / edit — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kin-detail-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/KinEditScreen.kt`
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/directory/EditKinScreen.kt` (+ `AddKinScreen.kt`)
**Shared components:** `BottomBorderField`, `MultilineField`, `AuntieChip`, `AuntieAvatar`, `AuntieSaveBar`, `AuntieStatusPill`, `GlassSurface`, `AuntieBreadcrumbs`, `StatusToast`, `GhostButton` (`…/web/ui/components/`). Dynamic-form source: `…/web/data/FormSchemaRepository.kt` + `…/web/screens/admin/formschemas/`.

> ⚠️ Screen-found note: Auntie's prompt said "FIND it (likely `KinEditScreen.kt`)." **Confirmed: the kin detail/edit code is `KinEditScreen.kt`** (the Directory route `EditKin` / `NewKin` maps to `KinEditScreen`, see `DirectoryScreen.kt` ll.127-143). There is no separate read-only "KinDetailScreen" on web — `KinEditScreen` is the only Kin screen.
>
> ⚠️ Mock-vs-code mismatch: the **mock is a read-only DETAIL view** (photo hero, Care checklist with "renders in tale" badges sourced from the per-pet ChecklistItem template, Medical block with vet office shown read-only "from the Wrens (household)", auto-generated 411, KinTales, Upcoming). The **shipped code is an EDIT form** (free-text inputs, Identity/Care/Health/Office panels). So this delta covers BOTH: (a) the edit-form fixes Auntie listed, and (b) the gap that there is no read-only detail view matching the mock. The mock confirms the directional fixes: checklist = dynamic template (not free text), vet = read-only from household.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Biscuit`, `Labrador Retriever · 5 yrs · neutered male · 68 lbs`, `the Wrens`, `Gravy`, `Chicken` allergy, `985•1410•••` microchip, `Riverside Animal Hospital`, the five care-checklist items, the 411 prose, `8 total` KinTales) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = the corrected end state (Auntie's complaints + mock). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built before the slot can show real data.

---

## 1. Species + Breed must be DROPDOWNS, not free-text (Auntie complaint)
- **Current:** both are plain free-text `BottomBorderField`s in the Identity panel (`KinEditScreen.kt` ll.220-221). `species` defaults to "Dog" (l.76, l.129); `breed` is open text. Nothing constrains the values, so spelling/casing varies and downstream species-tinting/grouping can't rely on them.
- **Desired:** Species is a controlled dropdown (Dog / Cat / etc.); Breed is a dropdown (ideally filtered by the chosen species).
- **Fix (full-stack):**
  1. Add a `species` picker (reuse `SegmentedPicker` for a small fixed set, or a real dropdown component if the list is long). Add a `breed` dropdown whose options depend on the selected species.
  2. **Dependency — breed catalog:** there is no species/breed reference list in the data layer today. Either ship a curated static catalog (per species) in shared code, or a Firestore-backed `breeds` collection so it's editable. Allow a free-text "Other" escape hatch so rare breeds aren't blocked (capture it without corrupting the controlled set). Do not silently drop a typed value.
  3. Migration: existing free-text `species`/`breed` values must map onto the catalog (or be flagged "Other") — no data loss, no fabricated normalization.
  4. Mirror the pickers on Android add/edit screens; unit-test the species→breed filtering; component-test the "Other" path.

## 2. Vet is household-only, shown read-only on the Kin (Auntie complaint) [STATUS 2026-06-09: WEB DONE, ANDROID PARITY REMAINING]
- **Operator intent (2026-06-09):** the household single-source for vet is `HouseholdData` (`primaryVet*` regular + `emergencyVet*`), per the canonical decision in `04-kinfolk-profile.md` item 3; `Kinfolk.vetClinic*` is deprecated and migrated into it. A per-kin VET is unnecessary; retire `Kin.vetInfo`. Per-kin MEDICAL stays, it is a separate thing: `Kin.medicationHealthNotes` + `Kin.vaccinations` (plus enriched `Kin411.medicalNotes`). No new medical field needed.
- **Web: editable per-kin vet box already gone.** `KinEditScreen.kt:372` renders a read-only `Vet (from {household})` line (KinEditScreen.kt:93,363 comments confirm "single-source on the owning Kinfolk"). It reads `Kinfolk.vetClinic*` TODAY; under the HouseholdData decision it repoints to `HouseholdData.primaryVet*` in the same slice.
- **Android: REMAINING (parity gap).** `AddKinScreen.kt:137-146` still has editable per-kin "Vet Clinic Name" / "Vet Phone" inputs (saved via `DirectoryViewModel.updateKinVetClinicName`/`updateKinVetPhone`). That is the double-authoring to delete. Replace with the same read-only "from {household}" line as web. The android PROFILE is already correct (`KinfolkProfileScreen.kt:333-337` household vet; per-kin line removed at 437-438).
- **Retire `Kin.vetInfo`:** stop authoring it; no migration (operator: per-kin vet is unnecessary, nothing to preserve). Leave the field in the model for now (data-safe). Two live read-side consumers to clear in the android-parity slice:
  - KinTale condition catalog: `vetInfo` is a selectable KIN_ATTRIBUTE an operator could gate a checklist item on (`conditionAttributeCatalog` + `readAttribute`, web `KinTaleConditionEngine.kt:70,95` / android `KinTaleTemplateEngine.kt:63`). KinTales never DISPLAY vet info and do not need it (operator 2026-06-09). REMOVE the `vetInfo` entry from the catalog + the `readAttribute` branch on both platforms; the engine parity test stays green (it asserts catalog keys == readable keys).
  - `KinCareDetailScreen` (web l.631 / android l.441) still shows `Kin411.vetName/vetPhone` (per-kin vet). Switch to the household vet (`Kinfolk.vetClinic*`) or drop, both platforms.
- **Tests:** android UI test that Add-Kin has no vet inputs; read-only inheritance parity test; KinCare-detail shows household vet.

## 3. Required: Name + Species + Gender; label "Gender" not "Sex" (Auntie complaint)
- **Current:**
  - Only **Name** is required (`canSave = name.isNotBlank()`, `KinEditScreen.kt` l.149). Species defaults to "Dog" and is never validated; the sex field is fully optional.
  - The field is labelled **"Sex"** (l.226) and bound to `Kin.sex` (model l.861).
- **Desired:** Name, Species, and **Gender** are all required. The label reads "Gender" (not "Sex").
- **Fix (full-stack):**
  1. Relabel the field to **"Gender"** in the UI (web + Android). Decide whether to also rename the model field `sex` → `gender` (a schema rename touching Firestore docs + read/write paths on all platforms + a migration) or keep the storage key `sex` and only change the label — pick deliberately and document it; do not leave label and model silently diverged in a confusing way.
  2. Make Gender a controlled input (it's effectively an enum: Male/Female/Unknown + neutered status is separate via the existing `spayedNeutered` chip). A picker, not free text, so requiredness is meaningful.
  3. Add real required-validation: `speciesError`/`genderError` and fold into `canSave` alongside `name`. Surface per-field on blur (same blur-validation work as 05-kinfolk-edit item 4 — shared `BottomBorderField` upgrade).
  4. Mirror on Android add/edit Kin screens; extend Kin form tests (currently `canSave` only checks name).
  - **Dependency:** none new for Name/Species/Gender requiredness (fields exist); the `sex`→`gender` rename, if chosen, is a schema migration across platforms.

## 4. Profile-pic upload not working (Auntie complaint) — it's absent on Kin
- **Current:** there is **no** Kin photo at all. The hero avatar uses a seeded initial gradient / paw glyph, with an inline comment: *"No photo URL on the Kin model, so the seeded initial gradient stands in"* (`KinEditScreen.kt` ll.329-336). The `Kin` model has **no `profilePictureUrl` field** (`FirestoreClient.kt` ll.854-880). So "upload not working" = the upload doesn't exist on Kin.
- **Desired:** mock hero shows a circular **pet photo** (`.hero .photo`, ll.45-47). Auntie expects an uploadable Kin profile picture.
- **Fix (full-stack — this is a real feature build):**
  1. **Backend/model:** add `profilePictureUrl` to the `Kin` model + write path (all platforms). Storage via the existing media pipeline (the app already uploads images for Kinfolk avatars / KinTale media — reuse that Cloudinary/Firebase path, never invent a new one).
  2. **Upload UI:** add a photo-upload affordance to the Kin hero (tap avatar → pick/upload → show progress → store URL). Fail loud on upload error (Cloudinary-style banner per CLAUDE.md), never silently no-op.
  3. **Read everywhere:** once Kin has a photo, render it in the Kin hero AND the Directory kin chips / Kinfolk-profile Kin rows (which today fall back to the paw glyph for the same reason — see 03-directory item 6, 04-kinfolk-profile item 5).
  4. Mirror on Android; integration-test the upload→store→render round-trip on all platforms; verify the existing Kinfolk avatar upload (if any) is the shared mechanism, not a fork.
  - **Dependency:** Kin `profilePictureUrl` field + reuse of the existing media-upload pipeline.

## 5. Drop the free-text pre-care field — checklist from dynamic form fields (Auntie complaint)
- **Current:** the Office panel has a free-text **"Pre-care checklist"** `MultilineField` bound to `Kin.checklist` (`KinEditScreen.kt` l.273, model l.875) — an unstructured blob.
- **Desired:** the care checklist is a **structured, per-pet list of ChecklistItems** driven by the dynamic form-field system, not free text. The mock shows this explicitly: a "Care checklist · per visit" panel of discrete toggleable items, several tagged **"renders in tale"** (mock ll.122-129), and the mock comment states "Care checklist = the per-pet ChecklistItem template (the 'Moments' source)" (mock l.9). A FormSchema/dynamic-form system already exists in the codebase (`…/web/data/FormSchemaRepository.kt`, `…/web/screens/admin/formschemas/FormSchemaEditorScreen.kt`).
- **Fix (full-stack):**
  1. Remove the free-text `checklist` field from the Kin edit form.
  2. Replace with a structured per-pet **ChecklistItem** list, sourced from / aligned to the existing dynamic form-field/FormSchema system. Each item = label + optional hint + a "renders in tale" flag (so checked items can flow into a KinTale, matching the mock's "renders in tale" badge).
  3. **Dependency — ChecklistItem model + wiring:** confirm whether a `ChecklistItem`/per-pet-checklist model already exists under the FormSchema system; if not, add it (model + repository + write path). Wire the Kin screen to read/write that structured list instead of `Kin.checklist`. Migrate existing free-text `checklist` blobs (or preserve them read-only) — no data loss.
  4. The "renders in tale" linkage ties into the KinTale composer (`…/web/screens/kintales/KinTaleComposeScreen.kt`) — checked, tale-flagged items should be available to the composer. Scope the linkage deliberately.
  5. Mirror on Android; unit-test the checklist read/write; integration-test the "renders in tale" flow.
  - **Dependency:** a structured per-pet ChecklistItem source (likely via FormSchemaRepository) + migration off the free-text `Kin.checklist`.

## 6. (Gap) No read-only Kin DETAIL view matching the mock
- **Current:** the only Kin screen is the editor (`KinEditScreen`). There is no read-only detail page; tapping a kin from Directory or the Kinfolk profile opens the edit form directly (`DirectoryScreen.kt` l.327, `KinfolkProfileScreen.kt` l.212).
- **Desired:** the mock is a read-only **detail** view: photo hero with identity line + owner/littermate links + alert tags, Care checklist (read state + "renders in tale"), Medical (allergies/meds/microchip/rabies + read-only household vet), auto-generated 411, the kin's KinTales, and Upcoming visits.
- **Fix (full-stack):**
  1. **LOCKED — Decision 9:** Kin keeps its **own dedicated screen** (do NOT fold into the Kinfolk profile); kin stays **FK-tied to its Kinfolk**. Build the dedicated read-only Kin detail view per the mock, with an "Edit kin" CTA into `KinEditScreen` (mock has both a "New KinTale" and "Edit kin" button, ll.114-115). Note: web currently ships only `KinEditScreen` (no separate read-only detail) — if you expect one to already exist, verify the deployed build/platform before rebuilding.
  2. If building the detail view, its data feeds:
     - **411 / dossier:** already real via `kin411Stream` (`FirestoreClient.kt` l.130, `Kin411` model l.991) — render Personality/Loves/Dislikes/Routine with the "auto-generated · N visits" stamp, with needs-more-samples fail-loud states.
     - **Kin's KinTales:** **Dependency** — a per-kin reports/tales feed (`reportsByKin(kinId)`); not wired today.
     - **Upcoming visits for this kin:** **Dependency** — sessions filtered by `kinId`/`kinIds`; not wired today.
     - **Medical block:** allergies / microchip / rabies tag are **not** distinct Kin fields today (only `medicationHealthNotes`, `vaccinations` free-text exist). **Dependency** — either add structured allergy/microchip/rabies fields or derive from the free-text notes; do not fabricate "Chicken"/"985•1410•••".
  3. Mirror on Android; gate every unwired feed with a "NOT WIRED" banner until its source lands.

---

## Out of scope / leave as-is
- Identity panel basics (Name/Species/Breed/Age/Weight/Color + Spayed-neutered & Reactive chips) — keep the fields; just upgrade Species/Breed to pickers (item 1) and Gender requiredness/label (item 3).
- Care panel (Stays-as / Feeding brand / Routine / Training commands) — real free-text fields, keep.
- Health panel medications & vaccinations free-text — keep (but remove the Vet-info box, item 2).
- Archive Kin block (audit-aware) — real, keep (ll.289-307, 395-427).
- `AuntieSaveBar` + Den hero/breadcrumb styling — keep.
- `kin411Stream` 411 source — real, reuse for the detail view (item 6).

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Species/Breed catalog** (static curated set or Firestore `breeds`, species-filtered, with an "Other" escape) → Species & Breed dropdowns + migration of existing free-text values.
2. **Vet: single-source on `HouseholdData` (canonical decision in 04 item 3).** REMAINING: repoint profile + the read-only Kin vet line + web inheritance from `Kinfolk.vetClinic*` to `HouseholdData.primaryVet*`/`emergencyVet*`; repoint the vet-bank picker to write HouseholdData; deprecate + migrate `Kinfolk.vetClinic*`; android Add-Kin drop per-kin vet (`AddKinScreen.kt:137-146`); retire `Kin.vetInfo`; remove `vetInfo` from the KinTale condition catalog (KinTales do not use vet); switch `KinCareDetailScreen` vet read to HouseholdData. Per-kin MEDICAL stays. Cross-cuts 04-kinfolk-profile.
3. **Gender requiredness + "Gender" label** (+ optional `sex`→`gender` schema rename/migration); Species & Gender required in `canSave`; per-field blur validation (shared with 05-kinfolk-edit).
4. **Kin `profilePictureUrl` + upload** via the existing media pipeline (fail-loud on error), rendered in hero + Directory chips + profile rows. Shared with 03/04.
5. **Structured per-pet ChecklistItem source** (via FormSchemaRepository) replacing free-text `Kin.checklist`, with "renders in tale" linkage to the KinTale composer + migration.
6. **(Detail view) per-kin KinTales feed** + **per-kin Upcoming-visits feed** + **structured allergy/microchip/rabies fields** — only if the read-only Kin detail screen is built (item 6). Gate dark until each lands.

Every value rendered/saved on this screen must trace to a real `Kin`/`Kin411`/`Kinfolk` field or a new real source above. Required fields fail loud on blur and on save; vet shows read-only from the household; unwired detail feeds ship behind a "NOT WIRED" banner — never hardcoded.
