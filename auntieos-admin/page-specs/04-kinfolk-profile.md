# Kinfolk profile — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kinfolk-profile-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/KinfolkProfileScreen.kt`
**Current code (android):** `android/app/src/main/java/com/tribetails/auntieos/ui/directory/KinfolkProfileScreen.kt`
**Shared components:** `SectionHeader`, `AuntieAvatar`, `AuntieChip`, `AuntieKeyValueRow`, `AuntieEntityRow`, `AuntieNoteCallout`, `AuntieIconButton`, `AuntieBanner`, `PrimaryButton` (`…/web/ui/components/`).

> No mock-file correction: the screen's panels (Contact, Home & access, Emergency, Vet Clinic, Dossier, Kin, Auntie's notes, Recent KinTales, Upcoming visits, Invoices) line up with `auntieos-kinfolk-profile-2026-05-27.html`. Note the mock collapses Phone/Email/Address/Entry/Emergency-vet into ONE "Household" panel; the shipped code splits them across several panels — see item 2.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Lorna Wren`, `the Wrens · Riverside`, `kinfolk since Jan 2025`, `★ 14 months`, `(555) 014-2231`, `Biscuit & Gravy hit the trail`, `#TT-2048`, `$280`, `12 total`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Long single-column scroll → TABS (Auntie complaint: "long scroll should be tabs")
- **Current:** `KinfolkProfileScreen` (`KinfolkProfileScreen.kt` ll.84-247) renders a **single vertical stack** inside `ScreenScaffold`: Hero → ContactOverride banner → Contact panel → Home & access → Emergency → Vet Clinic → Dossier → Kin → Auntie's notes → Recent KinTales → Upcoming visits → Invoices, each separated by `Spacer(18.dp)`. That is ~10 stacked panels = a very long scroll, exactly Auntie's complaint.
- **Desired (mock):** the mock shortens the page with a **two-column** layout (`.cols{grid-template-columns:1fr 1.2fr}`, ll.67, 145-209) — left column = Kin + Household + Auntie's notes; right column = Recent KinTales + Upcoming visits + Invoices. Auntie's stated fix goes further: a **tabbed** profile (e.g. Overview / Kin / KinTales / Visits / Invoices / Household) so each section is one tap, not a scroll.
- **Fix:**
  1. Introduce a tab strip at the top of the profile (reuse `SegmentedPicker` or a new `AuntieTabBar`) with deliberate tab groupings. Suggested: **Overview** (hero + contact + home/access + emergency + vet + dossier + notes), **Kin**, **KinTales**, **Visits**, **Invoices**. Do not author new tab-label copy without sign-off — reuse the panel titles already in the screen (TODO if new labels needed).
  2. Keep every existing panel's real data binding; tabs only re-parent the panels, they do not change data.
  3. At wide widths, optionally honor the mock's 2-column split within a tab; at narrow widths fall back to single column (mock `@media(max-width:860px)` collapses to 1 column, ll.121).
  4. Mirror the tabbed structure on Android (`ui/directory/KinfolkProfileScreen.kt`, which today is also a single `Column` of `ProfileField`s). Component/UI-test tab switching preserves panel data; no data dependency for this item.

## 2. Contact / Home / Emergency / Vet panels — grouping
- **Current:** split into four panels — Contact (`KinfolkProfileScreen.kt` ll.125-132), Home & access (ll.136-142), Emergency (ll.146-154, only when name/phone present), Vet Clinic (ll.157-166, only when vet fields present). All bound to real `Kinfolk` fields via `FactRow`/`AuntieKeyValueRow`, and `FactRow` hides blank values (ll.429-437) — honest.
- **Desired:** mock collapses these into a single "Household" panel (ll.162-169) with Phone / Email / Address / Entry / Emergency vet rows.
- **Fix:** grouping is a layout choice that should follow the tab decision in item 1 (these likely live under an "Overview" or "Household" tab). Keep the conditional rendering (don't show empty panels). No data dependency — all four panels already read real fields.

## 3. Vet info on Kinfolk (owner), read-only on Kin (Auntie complaint)

> STATUS 2026-06-09 (operator decisions, CANONICAL vet record):
> (1) The household single-source for vet is `HouseholdData` (`primaryVet*` = regular vet, `emergencyVet*` = emergency vet, which is a distinct clinic). NOT `Kinfolk.vetClinic*`. `HouseholdData` already has a full live editor on web + android (`HouseholdDataScreen`, route `household_data/{kinfolkId}`, `getHouseholdData`/`saveHouseholdData`) with a Veterinary Information card holding both. The current double-authoring is HOUSEHOLD-level: that card vs the vet-bank pick that writes `Kinfolk.vetClinic*` and renders on this profile.
> (2) Per-kin VET is retired (`Kin.vetInfo` unnecessary, no migration). Per-kin MEDICAL stays (`Kin.medicationHealthNotes`/`vaccinations`).
>
> Build slice (this REPLACES the pre-consolidation sub-items below, kept only for reference):
> - Profile shows regular + emergency vet read-only (two rows) sourced from `HouseholdData`.
> - The vet-bank picker writes `HouseholdData.primaryVet*` (regular) and a second `isEmergency`-filtered pick into `emergencyVet*`, instead of `Kinfolk.vetClinic*`.
> - Deprecate + migrate `Kinfolk.vetClinic*` -> `HouseholdData.primaryVet*`.
> - Kin read-only "Vet (from household)" line + the web inheritance (`KinEditScreen.kt:372`) repoint off `Kinfolk.vetClinic*` onto `HouseholdData`.
> - Android Add-Kin drops its per-kin vet inputs (`AddKinScreen.kt:137-146`).
> - Remove `vetInfo` from the KinTale condition catalog (KinTales do not display vet).
> - `KinCareDetailScreen` vet read points at `HouseholdData`.
> - Tri-platform + per-platform tests + the migration test.
- **Current:** **already correct on web.** Vet lives on Kinfolk as `vetClinicName` / `vetClinicPhone` / `vetClinicAddress` (`FirestoreClient.kt` Kinfolk model ll.625-627, commented "household-level Vet Clinic (lives on Kinfolk, not Kin)") and renders in the Vet Clinic panel here (ll.157-166). The mock confirms vet is household-level ("Emergency vet" sits in the Household panel, mock l.168).
  - **However:** the `Kin` model **also** carries a legacy `vetInfo: String` free-text field (`FirestoreClient.kt` l.874), and **Android's** profile renders per-kin vet info from `kin411` (`android/.../KinfolkProfileScreen.kt` l.341: `ProfileField("Vet Info", "${kin411?.vetName}...")`). So vet info is currently authored in **two** places, which is the root of Auntie's complaint.
- **Desired:** vet is entered ONCE on the Kinfolk (owner). On a Kin it shows **read-only**, inherited from the owning Kinfolk.
- **Fix (full-stack — this is the cross-cutting one):**
  1. Establish Kinfolk's `vetClinic*` fields as the **single source of truth**. On the Kin detail/edit screen, **remove the editable vet box** (see 06-kin-detail item 4) and instead show a read-only "Vet (from {household})" line sourced from the parent Kinfolk's `vetClinic*`.
  2. Decide the fate of the legacy `Kin.vetInfo` field and the per-kin `kin411` vetName/vetPhone (`FirestoreClient.kt` Kin411-style model ll.1000-1001): deprecate/migrate them into the household vet, or keep them read-only. Do not silently double-author. Whatever the call, it must be the same on web/desktop/Android.
  3. Make Android's profile read vet from the Kinfolk household vet, not from `kin411`, so the platforms agree.
  4. Migration + tests: a data migration to consolidate any per-kin vet info onto the owning Kinfolk; unit-test the read-only inheritance; integration-test that editing the Kinfolk vet reflects on every kin.
  - **Dependency:** the consolidation/migration of vet data from Kin/kin411 onto Kinfolk, plus the read-only inheritance path on the Kin screen.

## 4. Hero — avatar, identity, tenure tags, quick actions
- **Current:** `ProfileHero` (ll.279-384). Real `AuntieAvatar` (uses `profilePictureUrl` when present, else initials), `displayName`, `heroWhere()` subtitle ("the {lastName}s · {serviceAddress} · kinfolk since {joinDate}", ll.272-277 — gated on real fields), a status chip + a "since {joinDate}" chip (only when `joinDate` present) + real `tags`. Quick actions: Call / Text icon buttons (present only if `phoneNumber` set) but **`onClick` is a no-op** with inline "tel:/sms: launch not wired" SUGGESTION (ll.361, 367); Household + Edit are real nav.
- **Desired:** mock `.hero` (ll.131-143): avatar, name, "the Wrens · Riverside · kinfolk since Jan 2025", an `Active` tag + a "★ 14 months" loyalty/tenure tag, and Call / Text / **New KinTale** actions.
- **Fix:**
  1. **"★ 14 months" tenure tag** is PLACEHOLDER — it's a computed tenure from `joinDate` to now. The current "since {joinDate}" chip is the honest version; if the "N months" form is wanted, compute it from `joinDate` (do not hardcode "14 months"). If `joinDate` is blank, omit the chip (already does).
  2. **Call / Text quick actions:** **Dependency** — no verified `tel:`/`sms:` platform launcher exists, so the buttons are dead (ll.361, 367). Either add a platform launcher (expect/actual across web/desktop/Android) and wire it, or replace with a "copy number"/"open comms" action — don't leave a silent no-op button. Fail loud or make it work.
  3. **"New KinTale" primary action** in the mock hero is **missing** in code (current hero has Household + Edit, no compose-a-tale CTA). If desired, add a primary action that routes into the KinTale composer pre-scoped to this kinfolk. Wiring + nav across platforms.

## 5. Kin list panel
- **Current:** real. `Panel("Kin")` (ll.175-219) lists non-archived kin from `client.kinStream(kinfolkId)`, each as a `KinRow` (ll.506-558) with a paw-glyph avatar, a "species · breed · sex · age" detail line, and a 411 snippet appended from `client.kin411Stream(kin._id)` (with a needs-more-samples fallback). Tapping opens the Kin editor. "Add Kin" CTA is real nav.
- **Desired:** mock `.pet` rows (ll.150-159): circular **pet photo**, name, "Labrador · 5 yrs · loves sticks, hates the mailman", chevron.
- **Fix:**
  1. Subtitle already real (species/breed/sex/age + 411 snippet) — keep it.
  2. **Pet photo:** mock uses a circular photo; current uses a paw glyph because Kin has no photo field. **Dependency:** Kin `profilePictureUrl` + upload (shared with 06-kin-detail). Until then the glyph is the honest fallback.
  3. Note: `KinRow` opens its own `client.kin411Stream` per row (ll.507-508) — an N+1 listener pattern. Consider hoisting to a single batched 411 query (the Directory list already did this for kin chips). Not a visual delta, but a real perf item.

## 6. Recent KinTales / Upcoming visits / Invoices panels — NOT WIRED (correctly disclosed)
- **Current:** all three render a dashed **"NOT WIRED"** `AuntieBanner` (`NotWiredNotice`, ll.235-245, 571-582) because the screen subscribes to no tale/session/invoice stream — explicitly fail-loud per CLAUDE.md. This is the correct current behavior.
- **Desired:** mock fills these with real feeds — Recent KinTales (`12 total`, tale title + blurb + "SENT · TODAY 9:42A"), Upcoming visits (`next 7 days`, time + service + service-type pill), Invoices (`$0 outstanding`, "#TT-2048 · 6 visits · $280 · Paid"). All literals PLACEHOLDER.
- **Fix (full-stack — three real feeds, do NOT un-gate by hardcoding):**
  - **Dependency — KinTales for this kinfolk:** a `reportsByKinfolk(kinfolkId)` / `generatedDraftsByKinfolk` stream → render tale title + blurb + sent status/time. (Title/timestamp gaps noted on the Home spec apply here too.)
  - **Dependency — upcoming visits:** a `sessionsByKinfolk(kinfolkId)` filtered to upcoming, with service type + time. Mock's "next 7 days" is a window, not a literal.
  - **Dependency — invoices:** an `invoicesByKinfolk(kinfolkId)` stream + the kinfolk's `outstandingBalance` (already a Kinfolk field, `FirestoreClient.kt` l.602) for the "$X outstanding" caption.
  - Each: backend query/index → data layer → wiring → web+desktop+android → tests. Keep the NOT-WIRED banner until each lands.

## 7. Dossier panel
- **Current:** real and well-behaved. `DossierBody` (ll.469-503) reads `client.dossierStream`, shows a needs-more-samples banner, an empty-prose hint, or the reconcile-managed `rawSummary` + "Last enriched {date}". Honest fail-loud states throughout.
- **Desired:** the mock does not have a distinct Dossier panel (its narrative is folded into "Auntie's notes"). Keep the shipped Dossier panel — it's a real, additive feature.
- **Fix:** none. Place it under the appropriate tab (item 1).

---

## Out of scope / leave as-is
- `SectionHeader` breadcrumbs ("Directory / Kinfolk") + loading shimmer — already real.
- ContactOverride banner (Phase-4 read-side) — real, additive, keep.
- Auntie's notes (`internalNotes`) panel — real, conditional on content, keep.
- Dossier panel — real, keep (item 7).
- `FactRow` hiding blank values — correct, keep.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Tabbed profile structure** (re-parent existing panels into tabs; reuse `SegmentedPicker`/new `AuntieTabBar`). Mirror on Android. No data dependency, but cross-platform UI work + tests.
2. **Vet-info consolidation onto Kinfolk** (single source of truth) + read-only inheritance on the Kin screen + deprecate/migrate `Kin.vetInfo` & per-kin `kin411` vet fields + Android parity + migration + tests. (Cross-cuts 06-kin-detail.)
3. **`tel:`/`sms:` platform launcher** (expect/actual) so hero Call/Text quit being dead no-ops — or replace with copy/open-comms. All platforms.
4. **"New KinTale" CTA** routing into the composer pre-scoped to the kinfolk.
5. **KinTales-by-kinfolk feed** → Recent KinTales panel (+ tale title/timestamp gaps).
6. **Upcoming-visits-by-kinfolk feed** → Upcoming visits panel.
7. **Invoices-by-kinfolk feed** → Invoices panel (+ reuse `outstandingBalance`).
8. **Kin `profilePictureUrl` + upload** → real pet photos in Kin rows (shared with Directory + 06-kin-detail).
9. **(Perf) Batch the per-row `kin411Stream`** into a single query for the Kin panel.

Every value rendered on this screen must trace to a real stream (`kinfolkStream`, `kinStream`, `dossierStream`, `kin411Stream`) or a new real source above. If it can't, it ships dark with a "NOT WIRED" banner — not hardcoded.
