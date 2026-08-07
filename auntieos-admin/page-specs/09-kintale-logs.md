> STATUS 2026-06-09 (de-stale): all 6 items shipped both platforms. Android path confirmed: `ui/admin/KinTaleLogsScreen.kt`. List search is LIVE, not gated (`FF_KINTALE_LIST_SEARCH` no longer exists; drop that dependency bullet). Triage (assign / mark-duplicate / archive) + needs-triage orphan section + Failed/Drafts/Sent buckets all shipped. ONLY GAP: android logs heading lacks the "Edit templates" button web has (minor parity). Note: `communicationType` is a Tribal-Intel doc-type field, NOT on `KinCareReport`; the KinTale title uses `KinCareReport.title`, so no misuse here.

# KinTale Logs (KinTales) — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kintale-logs-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleLogsScreen.kt`
**Current code (android):** parity target — no path confirmed in this pass; Android equivalent must match (Rule 2).
**Shared components:** `DenScreenHeading`, `DenPanel`, `AuntieChip`, `AuntieBanner`, `AuntieStatusPill`, `AuntieIconTile`, `AuntieEntityRow`, `AuntieDialog`, `AuntieSearchField`, `GhostButton`, `ShimmerCard`, `StatusToast` in `…/web/ui/components/`.

> ⚠️ Mock-file correction: none. `KinTaleLogsScreen.kt` (ll.103-113 KDoc) explicitly states it "Mirrors ui-ideas/auntieos-kintale-logs-2026-05-27.html". Assignment and code agree.

> ⚠️ Complaint-vs-code correction: the brief describes this screen as "an unorganized long table/row list" that "should follow the mock's card layout." That is NOT what the current code does. The shipped `KinTaleLogsScreen.kt` already renders the mock's structure: a `DenScreenHeading`, a warning-toned `NeedsTriageSection` orphan panel (ll.326-370), then `Failed → Drafts → Sent` `BucketGroup` `DenPanel`s (ll.216-225, 676-690), each with a card-style `ReportRow` (status-icon tile, Fraunces name, serviceType · timestamp submeta, media/channel pips, status pill — ll.700-759). The "long unorganized table" likely describes a PRIOR state already remediated. The deltas below are therefore small polish items against an already-mock-aligned screen, plus the one genuinely-dark affordance (list search). Do not "rebuild to cards"; it is already cards.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Needs triage · 3 orphans`, `legacy_79`, `Lorna Wren`, `Bess Sparrow`, `Marisol Rowan`, `May 27 · 17:45`, the `2`/`6`/`3` counts) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Heading + "Edit templates" action
- **Current:** `DenScreenHeading(kicker="The Den · KinTales", title="KinTales", subtitle="Every recap that goes home to a Kinfolk after care", trailing=GhostButton "Edit templates")` (ll.137-148). Opens `KinTaleTemplateEditorScreen` inline (ll.116-120). Matches the mock verbatim.
- **Desired:** mock `.head` = ClipboardList icon tile + kicker + Fraunces title + subtitle + "Edit templates" GhostButton (Settings icon). Identical.
- **Fix:** none functional. Optional: the mock heading carries a leading ClipboardList icon tile; `DenScreenHeading` here has no leading icon. If parity matters, add the icon tile slot. Pure styling; mirror on Android. No data dependency.

## 2. List-level search (gated dark — the one real gap)
- **Current:** `FF_KINTALE_LIST_SEARCH = false` (l.84). `AuntieSearchField` is wrapped in `if (FF_KINTALE_LIST_SEARCH)` (ll.154-164) so it ships **off**. The filter `matchesSearch` (ll.848-854) is an in-memory client-side filter over already-streamed reports; the KDoc + flag comment state there is **no server-side report-search callable**. This is correctly dark, not faked.
- **Desired:** mock shows a "Search KinTales by Kinfolk or body…" field tagged **SUGGESTION** (mock ll.216-223). The mock itself flags it as not-in-source.
- **Fix (full-stack):**
  1. **Decide scope:** client-side in-memory filter (works today, scales to the streamed set only) vs. a real server-side search callable (needed if the report set grows beyond what's streamed). The mock's own SUGGESTION tag plus the flag comment say no search backend exists.
  2. If shipping the in-memory filter: flip `FF_KINTALE_LIST_SEARCH` on **only** after promoting it to the central flag registry, and render a visible "client-side filter over loaded KinTales only" note so the operator isn't misled into thinking it searches the whole archive (fail loud about the limitation).
  3. If a true search is wanted: build the **report-search callable/backend** first; never ship a dead input. Parity on web/desktop/Android; unit-test `matchesSearch`, component-test the gated field, integration-test the wired query.
  - **Dependency:** central feature-flag entry for `auntieos.kintales.listSearch`; optionally a server-side report-search source.

## 3. Needs-triage orphan section
- **Current:** `NeedsTriageSection` (ll.326-370) = `DenPanel` titled "Needs triage" with subtitle "Pre-cutover visit_logs migrated without a Kinfolk link…" (verbatim mock copy), an orphan-count `AuntieChip` trailing, a warning `AuntieBanner`, then `OrphanRow`s. Each `OrphanRow` (ll.372-436) shows `_id · prettySentVia`, an `bodyPreview` (collapses whitespace, 80 chars, "…", "(empty body)" — ll.442-446), and three GhostButtons (Assign / Mark Duplicate / Archive), with the "Working…" pending swap (l.414). Orphans come from `isUntriagedOrphan()` partition (ll.316-324). Fully real, fully wired through audited callables (`assignKinfolkToOrphanReport`, `markOrphanReportAsDuplicate`, `archiveOrphanReportAsBadData` — ll.244-291).
- **Desired:** mock `.triage-banner` + `.orphan` rows. Identical structure.
- **Fix:** none. This is done and bound to real data. Confirm Android parity of the three audited triage callables + the pending-state UI; integration-test each triage path.

## 4. Bucket groups (Failed / Drafts / Sent) + report rows
- **Current:** buckets render in screen order `Failed → Drafts → Sent` (l.216), each a `BucketGroup` `DenPanel` with a mono count chip (ll.676-690). `ReportRow` (ll.700-759): status-icon `AuntieIconTile` (MailCheck/TriangleAlert/FileText by status — ll.705-709), Fraunces `kinfolkName` (italic/dim "Unnamed Kinfolk" when blank — ll.742-750), `SubMetaColumn` = serviceType · `visitTimestamp` (ll.766-778) then media-count + send-channel `Pip`s (ll.781-799), trailing `AuntieStatusPill` (status lowercased, '_'→' '). Bucket sort by `sortKey` (sentAt/updatedAt/visitDate/createdAt — ll.843-845). Row is tappable when `sessionId` is non-blank → `onOpenReport` (ll.710, 725-734). All real `reportsStream()` data.
- **Desired:** mock `.bucket` groups + `.row`s with `.sicon` tile, `.nm`, `.submeta`, `.pips`, `.pill`. Identical.
- **Fix:** none functional. Note the mock's `prettySentVia` collapses `legacy_*` provenance to "imported" (ll.807-811) which is honest, not faked. Mirror on Android; component-test the three status icon/tone branches and the unnamed-italic branch.

## 5. Triage dialogs (Assign / Mark Duplicate / Archive)
- **Current:** all three are real `AuntieDialog` overlays. `AssignKinfolkDialog` (ll.448-531) searches the live `kinfolkStream`, filters archived, fail-loud error banner. `MarkDuplicateDialog` (ll.533-612) picks a non-orphan master from `allReports`, joins id + name with a plain hyphen per the no-em-dash rule (l.603). `ArchiveBadDataDialog` (ll.614-658) enforces the min-5-char reason with the audit note. Matches mock dialog previews (mock ll.377-430).
- **Desired:** mock dialog grid. Identical.
- **Fix:** none. Confirm Android parity of the three dialogs and their validation; unit-test the 5-char rule and the duplicate-candidate filter.

## 6. Loading / empty / error states
- **Current:** Loading → 4 `ShimmerCard`s (ll.174-177). Error → persistent `AuntieBanner` (ll.180-190, fail-loud, no auto-dismiss). Empty → `AuntieEmptyState` "No KinTales found" (ll.822-828). All correct.
- **Desired:** mock has no explicit empty/error art; these are app-correct fail-loud additions.
- **Fix:** none.

---

## Out of scope / leave as-is
- The entire bucket/orphan/dialog architecture already mirrors the mock; do not "convert the table to cards" (there is no table).
- `prettySentVia` "imported" collapse for `legacy_*` markers (ll.807-811) — honest, keep.
- Off-source SUGGESTIONS in the mock (top search, refresh, result-count chip) are correctly absent or gated; do not add them ungated.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Central feature-flag entry `auntieos.kintales.listSearch`** (item 2) → unblocks the list search field. If a true archive search is desired (not just in-memory), build a **report-search callable** first; never ship a dead input.
2. **Android parity audit** for the three orphan-triage callables + the bucket/row card layout (Rule 2) — surface whichever platform lags.

Every value rendered on this screen already traces to the real `reportsStream()` / `kinfolkStream()`. The only not-yet-real surface is list search, which ships dark with a flag — not hardcoded.
