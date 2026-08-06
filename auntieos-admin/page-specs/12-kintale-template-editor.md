> STATUS 2026-06-09 (de-stale): the FieldCondition per-item CONDITION EDITOR is SHIPPED both platforms (web `ConditionsEditor` ~l.613, android `ChecklistConditionsEditor` ~l.283); the spec's "genuinely TBD" item AND the web file KDoc ~l.98 are STALE and must be marked DONE. GENUINE CLEANUP (operator 2026-06-09): remove the `vetInfo` entry from `conditionAttributeCatalog` + `readAttribute` on both platforms (web `KinTaleConditionEngine.kt` l.70/95, android `KinTaleTemplateEngine.kt` l.63/92), KinTales do not use vet; update the parity test. PARITY GAP: android `ChecklistEditorScreen` lacks the `petMoodEnabled`/`reviewBoosterEnabled` toggles + `MoodOptionsEditor` that web has.

# KinTale Template Editor — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-kintale-template-editor-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleTemplateEditorScreen.kt`
**Current code (android):** parity target — the mock header (ll.13-14) names an existing Android editor (`ui/kintales/KinTaleTemplateEngine.kt`) which already exposes mood options; web must reach parity (Rule 2).
**Shared components:** `AuntieBreadcrumbs`, `AuntieStatusPill`, `AuntieChip`, `AuntieToggle`, `AuntieIconButton`, `AuntieDashedAddButton`, `BottomBorderField`, `MultilineField`, `PrimaryButton`, `ScreenScaffold`, `ShimmerCard`, `StatusToast` in `…/web/ui/components/`. Model: `KinTaleTemplate`, `ChecklistItem`, `MoodOption`, `DefaultKinTaleTemplate` in `…/web/data/`.

> ⚠️ Mock-file correction: none. `KinTaleTemplateEditorScreen.kt` KDoc (ll.72-90) names the mock `auntieos-kintale-template-editor-2026-05-27.html`. Agree.

> ⚠️ Complaint-vs-code note: no specific complaint in the brief. This screen is the most complete match in the set: the shipped editor already implements every real section plus all three of the mock's SUGGESTION items (Pet-mood toggle, Review-booster toggle, Mood-options editor, per-item Condition affordance) — and, notably, **wires the first three to real `KinTaleTemplate` model fields** (`petMoodEnabled` / `reviewBoosterEnabled` / `moodOptions`) rather than gating them dark. Deltas are minor.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Default KinTale`, `Overnight stay recap`, `Cat sit drop-in`, the per-pet/per-visit item labels `Peed`/`Pooed`/`Fed`/…, the mood emoji+labels `Happy`/`Playful`/…, the counts `6` / `8`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). The default checklist/mood labels happen to be reproduced verbatim from `DefaultKinTaleTemplate` / `KinTaleTemplateEngine` — but they must always render from the **loaded template draft**, never typed in. If a data source does not exist, gate the element dark with a visible "Not wired" banner (fail loud, per CLAUDE.md), never hardcode.

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Breadcrumbs + EditorHeader
- **Current:** `AuntieBreadcrumbs("KinTales" / "Templates" / draft name)` (ll.128-135) + `EditorHeader` (ll.331-393): "THE DEN · KINTALE TEMPLATES" kicker, "Editing {name}" headline, an "Unsaved changes"/"Saved" `AuntieStatusPill` (driven by real `dirty`), Save `PrimaryButton`, and a destructive close `AuntieIconButton`. Real.
- **Desired:** mock `.head`: "Editing · Default KinTale · unsaved changes" subtitle, Save, close (X).
- **Fix:** none functional. The "unsaved changes" state is bound to the real `dirty` flag (ll.367-368), not a hardcoded string. Mirror on Android.

## 2. Template picker
- **Current:** `TemplatePicker` (ll.395-455): lists real `templatesStream` templates, marks Default/Inactive via real `isDefault`/`isActive` pills, selecting one loads it as the draft, and "New template" seeds a fresh draft from `DefaultKinTaleTemplate`. Empty-state text when no templates saved. Real.
- **Desired:** mock template list with Default/Inactive tags + "New template".
- **Fix:** none. The mock's three sample templates are placeholder per Rule 1; current binds to the real stream. Mirror on Android; component-test the default/inactive pill branches.

## 3. Basic settings + Display sections
- **Current:** `EditorSection("Basic settings")` (ll.211-250): real `name` / `description` / `defaultEmailMessage` fields + "Make default" / "Active" toggles, all writing to the draft with `dirty=true`. `EditorSection("Display sections")` (ll.254-298): four real toggles (`photoShowcaseEnabled` / `checklistEnabled` / `visitNotesEnabled` / `nextAppointmentEnabled`) **plus** the two SUGGESTION toggles `petMoodEnabled` + `reviewBoosterEnabled` — and these two are **wired to real model fields** (ll.281-297), each carrying a "Suggestion" pill. Real.
- **Desired:** mock four display toggles + two SUGGESTION toggles.
- **Fix:** none functional — the web editor already exposes the two previously-deferred toggles and writes them to the shared model. Confirm Android already exposes the same (mock says Android had them); reconcile so all platforms match. Integration-test that the toggles persist on save.

## 4. Checklist editor (per-pet / per-visit)
- **Current:** `ChecklistEditor` (ll.457-521): two `EditorSection`s (PawPrint "Per-pet items {count}", House "Per-visit items {count}") with real `ChecklistItemRow`s. Each row (ll.523-600): editable item text, reorder up/down (`reorderWithinScope`, ll.807-822), delete, "Required" toggle, "Show even when unchecked" toggle — all writing to the draft. Add buttons append a fresh `ChecklistItem` with a unique key (`freshKey`, ll.824-828). Real.
- **Desired:** mock per-pet/per-visit item cards with reorder/delete + the two toggles.
- **Fix:** none functional. The verbatim item labels are placeholder-from-template per Rule 1. Mirror on Android; unit-test `reorderWithinScope` and `freshKey`; component-test add/delete.

## 5. Per-item Condition affordance (SUGGESTION — genuinely TBD)
- **Current:** `ConditionAffordance` (ll.602-622) shows on per-pet rows (`showConditionAffordance=true`, l.476): a teal SUGGESTION chip "+ Add condition … · editor TBD". The KDoc (ll.88-89) and inline comment (ll.593-595) state `FieldCondition` exists on the model but **the editor itself is genuinely TBD on both platforms** — so this is a non-wired affordance that does NOT fake backend data.
- **Desired:** mock `.cond` SUGGESTION chip "+ Add condition (e.g. only show for kin with meds) · editor TBD".
- **Fix (full-stack, genuinely new):** build the **`FieldCondition` editor** (UI + the draft write path that lets a condition be authored and persisted), all platforms. Until then the affordance correctly only advertises the future capability. **Dependency:** `FieldCondition` editor + write path.

## 6. Mood options editor (SUGGESTION — wired to a real field)
- **Current:** `MoodOptionsEditor` (ll.624-654) shows **only when `petMoodEnabled` is on** (gated by the toggle, ll.315-323), tagged "Suggestion". Each `MoodOptionRow` (ll.656-701) edits a real `MoodOption` (emoji + label) writing to `moodOptions` on the draft, with add/delete. `moodOptions` is a real shared-model field. Real.
- **Desired:** mock Mood-options editor with emoji + label rows, default 8 moods.
- **Fix:** none functional — it writes to the real `moodOptions` field. The mock's 8 default moods are placeholder-from-engine per Rule 1; bind to the loaded template's moods (as today). Confirm Android parity (mock says Android already has "Configure Mood Options"); reconcile. Integration-test mood persistence on save.

## 7. Save path
- **Current:** the Save handler (ll.142-171) creates (`createKinTaleTemplate`) or updates (`updateKinTaleTemplate`) the real doc, blocks on a blank name with a fail-loud toast, and toasts success/error. Real, audited via the client.
- **Desired:** mock Save button.
- **Fix:** none. Integration-test create vs. update branches; parity on Android.

---

## Out of scope / leave as-is
- The whole editor already mirrors the mock and wires every previously-deferred SUGGESTION (pet-mood, review-booster, mood-options) to real model fields. Do not gate those dark — they have real backing.
- The Condition editor is correctly TBD (no fake data) — keep advertising only.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **`FieldCondition` editor + write path** (item 5) → the only genuinely unbuilt feature here. Net-new UI + persistence, all platforms.
2. **Web/Android parity reconciliation** for Pet-mood, Review-booster, and Mood-options (items 3, 6): the mock says these were Android-only; web now has them. Confirm both platforms read/write the same shared-model fields and behave identically (Rule 2).

Every value rendered already traces to the live `templatesStream` / draft / `DefaultKinTaleTemplate`, and every toggle/field writes to a real `KinTaleTemplate` model field. The only not-yet-real surface is the `FieldCondition` editor, which correctly advertises-without-faking.
