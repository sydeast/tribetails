> STATUS 2026-06-09 (de-stale): the Household Data screen is fully shipped both platforms (30 fields, 5 sections, lazy-create, fail-loud load errors, last-saved stamp). VET DECISION (canonical record in 04 item 3): HouseholdData is now the household vet single-source (`primaryVet*` regular + `emergencyVet*` emergency); `Kinfolk.vetClinic*` is deprecated but STILL live-written by KinfolkEditScreen, read by the profile, and counted by the vet-bank picker, so migrating those reads/writes onto HouseholdData is the open cross-cutting work (specs 04/06/07). GAPS: phone-format validation (`isValidPhone`) not wired on the 5 vet/provider phone fields either platform; the Kinfolk address read-through panel (Decision 7) not built (blocked on 05 item 3). No new intent decisions.

# Household data — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-household-data-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/HouseholdDataScreen.kt`
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/directory/HouseholdDataScreen.kt` (+ `HouseholdDataViewModel.kt`)
**Shared components:** `BottomBorderField`, `MultilineField`, `GlassSurface`, `SectionHeader`, `PrimaryButton`, `GhostButton`, `StatusToast`, `AuntieBanner` (`…/web/ui/components/`). Data: `HouseholdData` model in `…/web/data/FirestoreClient.kt` (one doc per kinfolk in `household_data`).

> ⚠️ Mock caveat: this mock's own comment (ll.11-37) says it **mirrors the current `HouseholdDataScreen.kt` exactly** — same 5 sections, same ~30 fields, same labels, same fail-loud load error. So the mock is a snapshot of the **current** screen, not a redesign. The only mock additions are two clearly-tagged SUGGESTIONS (a read-only dossier "needsMoreSamples" context band and a "Last saved" stamp) — **both already implemented** in the shipped screen (ll.243-253 banner, ll.369-377 stamp). **Auntie's complaint (service address + access info is required, belongs with identity) is the real DESIRED change and is NOT in this mock.**
>
> ⚠️ Important data distinction: the "service address + access info" Auntie refers to (street address, gate/door code, parking, Wi-Fi, entry notes) lives on the **`Kinfolk`** model and is edited on the **Kinfolk edit** screen (Home & access section) — see 05-kinfolk-edit. This **HouseholdData** screen is a SEPARATE ~30-field dossier (vet, item locations, routines, emergency/safety, service providers) and does **not** contain the service address / gate code / entry-notes fields at all. So the complaint primarily lands on 05-kinfolk-edit; the relevant question here is whether the household-data dossier should converge with the Kinfolk Home-and-access fields (see item 1).

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna Wren Household`, and any sample field values) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = the corrected end state (Auntie's complaint + mock). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built before the slot can show real data.

---

## 1. Service address + access info is required and belongs with Identity (Auntie complaint)
- **Current:**
  - On THIS screen: the `household_data` dossier has NO service-address / gate-code / parking / Wi-Fi / entry-notes fields. Its 5 sections are Veterinary Info, Household Items & Locations, Routines & Preferences, Emergency & Safety, Service Providers (`HouseholdDataScreen.kt` ll.256-340) — all free-text, all optional, no validation, single Save.
  - The actual "service address + access info" lives on `Kinfolk` (`serviceAddress`, `gateCode`, `parkingInstructions`, `entryNotes`, `wifiName`, `wifiPassword` — `FirestoreClient.kt` ll.612-617) and is edited under the **Optional** "Home & access" section of the **Kinfolk edit** screen (`KinfolkEditScreen.kt` ll.412-431). It is not required there.
- **Desired:** the household's service address and access info are **required** and grouped with the household's core **identity**, not buried as an optional section.
- **Fix (full-stack — primarily on the Kinfolk edit screen, cross-cuts 05-kinfolk-edit item 3):**
  1. Make `Kinfolk.serviceAddress` (and the deliberate subset of access info that should be mandatory) **required**, and relocate it under the Identity grouping on the Kinfolk edit screen. See 05-kinfolk-edit item 3 for the concrete validator/placement work — do not duplicate the field onto this household-data screen.
  2. **Convergence (LOCKED — Decision 7): ONE source, read-through.** `Kinfolk` owns the service address + access info (required, under Identity); this screen **reads through** to it (shows it, does not re-author). The `HouseholdData` dossier keeps its extended fields (vet, locations, routines), but address/access has a single owner on `Kinfolk` — never two editable copies.
  3. If this screen surfaces the Kinfolk address/access info, it should read from the same `Kinfolk` doc (single source of truth), not a duplicate copy in `household_data` — no double-authoring.
  4. Mirror on Android (`HouseholdDataScreen.kt` + `HouseholdDataViewModel.kt` already exist); the existing `HouseholdDataViewModelTest.kt` must be extended for any new required/validation behavior.
  - **Dependency:** the requiredness + relocation work on `Kinfolk` (05-kinfolk-edit). **Decision 7 LOCKED:** household-data **reads through** `Kinfolk`'s single-source address/access — no separate authoring.

## 2. Field visibility / accessibility (carry-over)
- **Current:** every field here is the same low-contrast `BottomBorderField` / `MultilineField` primitive critiqued in 05-kinfolk-edit (0.5px resting hairline, dim uppercased label).
- **Desired:** higher-visibility, accessible fields (same as 05).
- **Fix:** inherits the shared `BottomBorderField` a11y/visibility overhaul from 05-kinfolk-edit item 1 — when that primitive is fixed, this 30-field form benefits automatically. No screen-specific work beyond verifying the dense `Row`-of-two layouts still read well at the improved contrast. a11y review on the long form.

## 3. Optional validation on vet/provider phone numbers (gap)
- **Current:** none of the phone fields here (`primaryVetPhone`, `emergencyVetPhone`, `groomerPhone`, `trainerPhone`, `poisonControlNumber`) are validated — they're plain `BottomBorderField`s. So a malformed vet/groomer/trainer phone saves silently.
- **Desired:** phone fields should validate format (consistent with the rest of the app's `isValidPhone`).
- **Fix:** apply `isValidPhone` (when non-blank) to the phone fields here, with per-field blur messaging (shared with 05-kinfolk-edit item 4). These are reference numbers Auntie may dial in the field, so a bad number is a real failure. Mirror on Android; extend tests. Not an Auntie-stated complaint, but a consistency/correctness item surfaced by the audit.

---

## Out of scope / leave as-is
- The 5-section dossier structure (Veterinary / Items & Locations / Routines / Emergency & Safety / Service Providers) — real, matches the mock, keep.
- Lazy-create of the `household_data` doc on first save (l.182, `existing ?: HouseholdData(...)`) — real, keep.
- Fail-loud load-error branch (ll.231-238) — correct, keep.
- The dossier "needsMoreSamples" context band (ll.243-253) and "Last saved" stamp (ll.369-377) — already implemented (the mock's two SUGGESTIONS); keep.
- `kinfolkName` resolution from the stream when caller passes blank (ll.72-81) — real, keep.
- Save toast + audit behavior — keep.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Required service-address + access-info on `Kinfolk`, relocated under Identity** (the actual fix for Auntie's complaint) — done on the Kinfolk edit screen, see 05-kinfolk-edit item 3. Cross-platform + validator tests.
2. **Convergence (LOCKED — Decision 7): ONE source, read-through.** `Kinfolk` owns address/access; this screen reads through. Migrate any divergent household-data address fields onto `Kinfolk`; no double-authoring.
3. **Shared `BottomBorderField` a11y/visibility overhaul** (from 05-kinfolk-edit) applied to this 30-field form.
4. **Phone-format validation** on the vet/provider phone fields here (`isValidPhone` when non-blank + blur messaging). Mirror Android, extend `HouseholdDataViewModelTest`.

Every value rendered/saved on this screen must trace to a real `HouseholdData` (or single-source `Kinfolk`) field. Required fields fail loud; the address has one owner, not two — never duplicated or fabricated.
