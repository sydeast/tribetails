# Tribal Intel (renamed from "Training Documents" / "Training Dogs") — current → desired delta

> **LOCKED — Decision 3:** this screen is renamed **Tribal Intel**. Update the nav label, `Destination` title, route slug, screen heading, and all user-facing copy accordingly.

**Desired (source of truth):** `ui-ideas/auntieos-training-documents-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/trainingdocs/TrainingDocumentsScreen.kt` (+ `TrainingDocumentsViewModel.kt`)
**Model:** `TrainingDocument` in `…/web/data/FirestoreClient.kt` (ll.1098-1106) — `title, content, communicationType, kinfolkRef, uploadedAt, notes`
**Read path:** `FirestoreClient.trainingDocsStream()` (FirestoreClient l.322) — READ ONLY
**Propagation targets (already exist):** `Dossier` (FirestoreClient ll.916-928, `rawSummary` + `lastReconcileSourceLogIds` + `needsMoreSamples`), `Kin411` (ll.991-1006), `HouseholdData` (ll.938+)
**Shared components:** `DenScreenHeading`, `DenPanel`, `GlassSurface`, `StatCard`, `AuntieSearchField`, `AuntieChip`, `AuntieBanner`, `AuntieEmptyState`, `BottomBorderField`, `MultilineField`, `AuntieDashedAddButton`, `PrimaryButton`, `GhostButton`.

> Mock-file confirmation: the mock header (ll.12-16) names `TrainingDocumentsScreen.kt` + `TrainingDocumentsViewModel.kt` + the `TrainingDocument` model. No correction needed. The mock is built as a *mirror of the current read-only screen plus SUGGESTION items* — it is NOT yet a mock of the desired AI-generator tool (see item 1).

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`Welcome & Onboarding Basics`, `Onboarding`, `2026-05-12`, `the Wrens`, `Reviewed each quarter`, the `4`/`3`/`4` summary counts) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Wrong purpose — repurpose into the AI-generator upload tool (backlog 12.1, the core complaint)
- **Current:** the shipped screen is a **read-only library viewer**. `TrainingDocumentsScreen.kt` streams `TrainingDocument` docs (ll.81-85), renders a search box, a 3-stat summary (`SummaryRow` ll.208-237), and `DocCard`s with title/commType chip/content-with-Show-More/notes/kinfolkRef (`DocCard` ll.246-327). There is **no write path**: `FirestoreClient` exposes `trainingDocsStream()` only, with **no create/update/delete callable** for `TrainingDocument` (confirmed: the screen's own KDoc ll.353-361 and the gated `AddDocumentForm` ll.362-503 say exactly this).
- **Desired (backlog 12.1):** this should be the **AI-generator upload tool** where Auntie manually feeds in info the system can't auto-grab (in-person conversations, photos, scanned notes). It must let Auntie:
  - **type notes**, **take/upload screenshots**, and **attach files**;
  - **attach each entry to a Kinfolk or Kin** (target picker, not free-text `kinfolkRef`);
  - have that information **propagate into the client's folk note** — i.e. the **411 (`Kin411`) and dossiers (`Dossier`)**, and the **AI-generated profile blurbs**.
  - Context: texts/emails/notes/kincare are auto-grabbed by the reconcile pipeline; in-person info is not — this tool is the manual feed.
- **Fix (full-stack — this is a feature build, not a restyle):**
  1. **Backend (the blocker):** build a `createTrainingDocument` / `updateTrainingDocument` / `deleteTrainingDocument` callable. The current `AddDocumentForm` (ll.362-503) is intentionally inert with a fail-loud Error banner ("Not wired yet", ll.382-397) and a hard-disabled Save (l.499) — keep it disabled until this exists. Do NOT let Save pretend to persist.
  2. **Attachments:** add screenshot/file upload (Cloud Storage path on the doc) — `TrainingDocument` has no media field today; extend the model + write path. Gate the upload UI dark with a Not-wired banner until the storage path exists.
  3. **Target picker:** replace the free-text `kinfolkRef` (DocCard l.317, form l.437) with a real Kinfolk **and** Kin selector bound to the directory streams. (Mock's "Related to: the Wrens" = placeholder.)
  4. **Propagation (the point of the feature):** on save, the new entry must feed the reconcile pipeline that already writes `Dossier.rawSummary` / `Kin411.rawSummary` (the models carry `lastReconcileSourceLogIds` + `needsMoreSamples`, FirestoreClient ll.916-928, 991-1006). Wire the training-doc as a reconcile source so dossiers/411/AI blurbs update. This is server-side work; surface "queued for reconcile" honestly, never fake an updated dossier.
  5. **Name (LOCKED — Decision 3): rename to "Tribal Intel."** Update the nav label, `Destination` title, route slug, screen heading, and user-facing copy from "Training Documents"/"Training Dogs" to **Tribal Intel**.

## 2. "Add document" trigger + Add/Edit form — honestly gated (keep gating until backend exists)
- **Current:** the Add button and form are gated behind `FF_TRAINING_DOC_CREATE = false` (`TrainingDocumentsScreen.kt` ll.69-71, 102-119). When off, the trigger does not render; the form is unreachable. This is correct fail-loud behavior — no dead Save button ships.
- **Desired:** mock `.add` button + `.formwrap` panel, with the mock's own red `.warn` banner stating no write callable exists.
- **Fix:** keep gated until item 1's callables exist. When wired, flip the flag, bind the form fields to the create callable, and add the target picker + attachments from item 1. Unit-test the callable; integration-test the create→reconcile path.

## 3. Comm. Type quick-filter chips — honestly gated
- **Current:** gated behind `FF_TRAINING_DOC_COMM_FILTER = false` (ll.73-78, 167-194). The `TrainingDocumentsViewModel` (full file) filters by free-text search only (`filter()` ll.67-74 matches title/content/communicationType); it exposes no commType hook. When dark, the chips do not render (no misleading affordance).
- **Desired:** mock `.filters` pills (Onboarding / Care Protocols / Safety), tagged SUGGESTION.
- **Fix:** convenience only. When wired, the chip selection should feed a VM commType filter (the screen ll.190-194 already shows the intended local narrowing). Low priority vs item 1. The commType source should be the **real category list** once one exists (see Template Bank dependency), not free text.

## 4. Summary stats + DocCard rendering (already real — keep)
- **Current:** `SummaryRow` (ll.208-237) computes Total / Comm. types (distinct) / With content from the real `allDocs`. `DocCard` (ll.246-327) renders real fields with a 200-char Show More/Less expander, "Notes:" and "Related to:" prefixes, and a literal `-` for a missing `uploadedAt` (l.279). The VM drops content-less junk seed rows (`TrainingDocumentsViewModel` ll.42-45). All real data.
- **Desired:** mock `.summary` row + `.dcard` list.
- **Fix:** none functionally. These become the *library/history view* alongside the new generator tool (item 1). Keep.

---

## Out of scope / leave as-is
- Search, summary stats, DocCard expander, empty/empty-search states, junk-row filtering — all real and correct.
- The fail-loud "Not wired" banner inside `AddDocumentForm` (ll.382-397) and the disabled Save — keep until the backend exists; this is the policy-correct state.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **`createTrainingDocument` / `updateTrainingDocument` / `deleteTrainingDocument` callables** → the whole repurpose (item 1). Without them the screen stays read-only and Save stays disabled (never fake it).
2. **Attachment storage** (screenshot/file upload → Cloud Storage ref on the model) → the "take/upload screenshots, attach files" requirement. Extend `TrainingDocument`.
3. **Kinfolk + Kin target picker** bound to directory streams → replaces free-text `kinfolkRef` (item 1.3).
4. **Reconcile-pipeline wiring** → on save, feed `Dossier`/`Kin411` rawSummary + AI blurbs (item 1.4). The reconcile models already exist (`lastReconcileSourceLogIds`); wire training-docs in as a source. Surface "queued", never a fake updated dossier.
5. **Real category/commType list** → for the comm-type chips (item 3), shared with Template Bank's category dependency.
6. **Name (LOCKED — Decision 3):** renamed **Tribal Intel** (nav label, route, title, copy).

Every value rendered on this screen must trace to `trainingDocsStream()` (or the new write/reconcile sources above). If it can't, it ships dark with a Not-wired banner — not hardcoded.
