> STATUS 2026-06-09 (de-stale): SENT report shipped: live stream + SENT artifact view (web/desktop), cover title, kin name/species join, real-template checklist (`resolveSentChecklist`, not hardcoded), GPS RouteMap, pet-mood (ALWAYS_ON), comment thread (ALWAYS_ON), delivery receipt, View-as-kinfolk + Share link (all live, flags gone). GAPS: (1) android still pops back on send instead of showing the SENT artifact in place, web/desktop stay; fix the `sentSuccessfully -> onBack` effect (~android l.124). (2) GPS distance/time stat row not rendered on any platform though `GpsSummary` carries the values. DECISION carryover: `vetInfo` still in the KinTale condition catalog (removal pending, see spec 12).

# KinTale Report — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kintale-report-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleReportScreen.kt`
**Current code (web, VM):** `…/screens/kintales/KinTaleReportViewModel.kt`
**Current code (android):** parity target — Android equivalent must match (Rule 2).
**Shared components:** `DenScreenHeading`, `DenPanel`, `AuntieBanner`, `AuntieStatusPill`, `AuntieAvatar`, `AuntieChip`, `AuntieKeyValueRow`, `AuntieNoteCallout`, `MultilineField`, `GhostButton`, `PrimaryButton`, `ServicePill`, `EmptyHint`, `ScreenScaffold` in `…/web/ui/components/`.

> ⚠️ Mock-file correction: none. `KinTaleReportScreen.kt` KDoc (ll.66-82) and the mock header both name `KinTaleReportScreen.kt` + `KinTaleReportViewModel.kt`. Agree.

> ⚠️ Complaint-vs-code note: no specific complaint in the brief. The shipped screen already implements both the DRAFT editor mode and the SENT read-only "published artifact" mode from the mock, and correctly gates the mock's three SUGGESTION sections (View-as-kinfolk, pet-mood, comment thread) dark behind local flags. Deltas are the cover-headline gap and the gated SUGGESTIONs.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`A good morning on the trail`, `From Auntie Dee for the Wrens`, `Photos · 5 attached`, `Biscuit` / `Gravy` / `Dog · Labrador`, `dist 1.4 mi / time 32 min`, `Sent at May 27, 9:41 AM`, the reply-thread names + text) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Header + status pill + Back
- **Current:** `DenScreenHeading` (ll.101-131): kicker "KinTale · Visit Recap", title "KinTale", accentTail "Update.", subtitle "Tell the story of today's visit…", trailing = a Sent/Draft `AuntieStatusPill` (driven by live `report.status`) + Back GhostButton. Real.
- **Desired:** mock `.bar`: Back + "KinTale Update" title + "View as kinfolk" (SUGGESTION) + Sent status pill.
- **Fix:** none functional. "View as kinfolk" is correctly gated (see item 6). Mirror on Android.

## 2. Live report wiring (the VM fix — already landed)
- **Current:** `KinTaleReportViewModel` (whole file) reads the report via a **live stream** `reportForSessionStream` (ll.62-63) collected with the P0-FLICKER remember idiom (Screen ll.93-94), not a one-shot `.first()`. Send no longer pops the screen — it flips to the in-place SENT artifact view (`justSent`, ll.55, 130-133). The VM KDoc (ll.17-27) documents both as fixes to prior audit bugs. Photos resolve to real media (`mediaStream` entityType "VISIT_LOG", ll.71-72).
- **Desired:** mock's DRAFT→SENT lifecycle.
- **Fix:** none. This is the correct wired behavior. Integration-test the live status flip and the in-place artifact swap; parity on Android.

## 3. Cover hero — the headline gap
- **Current:** `ReportCover` (ll.385-414): orange→pink gradient, "KINTALE · VISIT RECAP" eyebrow, then a "From {authorDisplayName} for {kinfolkName}" line. The code comment (ll.403-404) explicitly states **"No headline/title field exists on the report contract today, so the recipient line carries the cover."** No headline is faked.
- **Desired:** mock `.cover` has a big **headline** (`A good morning on the trail`) above the from-line.
- **Fix (full-stack):** add a real **`title`/`headline` field to `KinCareReport`** (model + write path, all platforms) so the cover can show an auntie-authored headline. Until it exists, **keep the recipient line as the cover** (as today) — do NOT print the mock's placeholder headline. This is the same dependency as 10-kintale-composer item 2 (the composer would author it). **Dependency:** `KinCareReport.title`.

## 4. Narrative / Photos / Checklist sections
- **Current:**
  - Narrative: `DenPanel("KinTale Narrative")` from real `report.bodyCopy`, placeholder text when blank (ll.302-316). Real.
  - Photos: `PhotosPanel` (ll.422-454) resolves **real `MediaFile` docs** to `PhotoTile`s with real thumbnails + video duration pips (`PhotoTile` ll.457-488). If `mediaFileIds` say photos exist but none resolved, it fails loud with a hint (ll.439-444) rather than faking tiles. Real.
  - Checklist: `ChecklistSections` (ll.598-674) renders only **checked** `FieldResponse` items (Precise semantics), grouped per-kin + an "Overall visit checklist" with the verbatim "Things that apply to the whole visit" callout. Item labels resolve from `DefaultKinTaleTemplate`. Real.
- **Desired:** mock blocks for narrative, photo showcase, per-pet checks, overall checklist.
- **Fix:**
  1. **Per-kin name gap:** `ChecklistSections` shows the raw `kinId` as the per-pet heading (ll.655-657) because "the report carries no per-kin name/species." The mock shows "Biscuit · Dog · Labrador". **Fix:** join real kin name/species onto the checklist heading (a kin lookup by id), or keep the id and flag the missing join. Do not invent a pet name. **Dependency:** kin-name/species join for the report's `kinIds`.
  2. Photo "X attached" count binds to real media (ll.429-436) — keep. Mirror on Android.

## 5. GPS Route block
- **Current:** `DenPanel("GPS Route")` renders only `report.visitRouteId` as a mono string (ll.340-357), and is hidden when blank. The comment (ll.352-353) states the mock's distance/time stats "are not on the report contract, so they are not invented here." Honest.
- **Desired:** mock `.route` with an animated polyline + `dist / time` stats.
- **Fix (full-stack):** to match the mock's route render, resolve the `visitRouteId` to the real breadcrumb trail / `GpsSummary` and draw the shared `RouteMap` + real distance/time. Until that read is wired here, keep the id-only render — do not fabricate "1.4 mi / 32 min". **Dependency:** a `GpsSummary`/breadcrumb read keyed by `visitRouteId` on the report screen (the summary is computed on session-end in Auntie Time).

## 6. SUGGESTION sections (correctly gated dark)
- **Current:** three local flags ship dark (ll.62-64): `FF_VIEW_AS_KINFOLK`, `FF_PET_MOOD`, `FF_COMMENT_THREAD`. Each, when flipped on, renders a **Not-wired SUGGESTION banner** (View-as-kinfolk ll.285-299; pet-mood ll.327-337 with a real-field guard; comment thread ll.367-381) rather than faking data. The mock tags all three as SUGGESTION.
- **LOCKED — Decision 8:** KinTale **external share** ("primary kinfolk shares a KinTale with outside people") is a **CONFIRMED feature**, not a maybe. Build a `shareKinTaleExternal` callable + share-link and promote the View-as-kinfolk affordance (`FF_VIEW_AS_KINFOLK`). This is part of the Members/Invites/share re-home (spec 29 → Directory/MyTribe/here). `FF_PET_MOOD` / `FF_COMMENT_THREAD` stay gated until their backends exist.
- **Desired:** mock shows pet-mood pills, a delivery receipt, and a kinfolk reply thread, all SUGGESTION-tagged.
- **Fix (each is a real backend dependency):**
  1. **Pet mood pills** — `petMoodSelections` exists on the model but the default template ships `petMoodEnabled=false` and nothing reads it. To turn on: enable in the template editor (see 12) + bind the pills to real selections. Gate stays until then.
  2. **Comment / reply thread** — **no `Comment` model or reply callable exists** (memory: "KinTale comments threading" is planned-only). Full new backend: Comment model + reply callable + read stream, all platforms. Until built, stays dark.
  3. **Delivery receipt** — `DeliveryPanel` (ll.545-568) already renders real `sentAt`/`sentVia`/`deliveryReceiptId` when present, tagged SUGGESTION because the send pipeline doesn't reliably populate the receipt id (ll.542-544). **Fix:** make the send pipeline reliably write `deliveryReceiptId`, then drop the SUGGESTION tag. **Dependency:** send pipeline populates the receipt id.

---

## Out of scope / leave as-is
- DRAFT editor (`DraftBody` / `DraftEditorAndActions`, ll.178-245) with fail-loud save/send error banner — correct.
- Recipients / Visit-meta panels (ll.491-540) skip blank fields rather than faking — correct.
- The "no headline field" honest cover (ll.403-404) — keep until `title` lands.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **`KinCareReport.title`/headline field** (item 3) → the cover headline. Shared with 10-kintale-composer.
2. **Kin name/species join for `report.kinIds`** (item 4.1) → real per-pet checklist headings instead of raw ids.
3. **`GpsSummary`/breadcrumb read by `visitRouteId`** (item 5) → real route render + distance/time, instead of id-only.
4. **Comment model + reply callable + stream** (item 6.2) → the reply thread. Net-new backend.
5. **Pet-mood read + template enablement** (item 6.1) → mood pills.
6. **Send pipeline reliably writes `deliveryReceiptId`** (item 6.3) → drop the Delivery SUGGESTION tag.

Every value rendered already traces to the live `reportForSessionStream` / `mediaStream` or `DefaultKinTaleTemplate`. No mock placeholder is hardcoded; the gaps are honestly omitted or gated, and each becomes real only when its dependency above lands.
