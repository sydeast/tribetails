# Form Schema List — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-formschema-list-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/admin/formschemas/FormSchemaListScreen.kt`
**Repository:** `FormSchemaRepository` / `CloudFormSchemaRepository` in `…/web/data/FormSchemaRepository.kt` — `listSchemas` (callable `listFormSchemas`); models `FormSchema(id, name, description?, version, sections[], …)` (ll.50-58), `FormSchemaSummary(id, name, version, updatedAt, updatedBy)` (ll.76-82)
**The duplicate to consolidate with:** `…/web/screens/settings/DynamicFieldsCard.kt` (CRUD over the `dynamic_fields` collection via `FirestoreClient.dynamicFieldsStream/createDynamicField/updateDynamicField/archiveDynamicField`); model `DynamicField(name, label, fieldType, appliesTo, options, required, helpText, …)` (FirestoreClient ll.1163+)
**Shared components:** `DenScreenHeading`, `DenPanel`, `AuntieChip`, `AuntieSearchField`, `AuntieStatusPill`, `AuntieIconButton`, `GhostButton`, `PrimaryButton`, `EmptyHint`, `AuntieBanner`.

> Mock-file confirmation: `FormSchemaListScreen.kt` (KDoc ll.59-70) mirrors `auntieos-formschema-list-2026-05-27.html`. No correction needed.
>
> **Critical code correction:** `FirestoreClient.kt` (l.1155) KDoc says the Dynamic Fields CRUD UI lives in `screens/admin/DynamicFieldsManagerScreen.kt`. **That file does not exist** (verified by glob/grep). The actual Dynamic Fields CRUD UI is `screens/settings/DynamicFieldsCard.kt`, embedded in the Settings screen. Trust the code: the duplicate to consolidate is the Settings card, not a phantom manager screen.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (schema names, version numbers, updated dates, updated-by names) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Consolidate the duplicate dynamic-fields systems (backlog 14.1 — the core complaint)
- **Current:** there are **two separate, incompatible dynamic-field systems** in the codebase:
  - **A) Form Schemas** (this screen): `form_schemas` collection via the Cloud Function `listFormSchemas`/`getFormSchema`/`saveFormSchema`/`deleteFormSchema` (`FormSchemaRepository`). Model = `FormSchema` → `sections[]` → `fields[]` (`FormFieldSpec(key, label, type, options?, …)`). Authored in `FormSchemaListScreen` + `FormSchemaEditorScreen`. **No `appliesTo`/placement** field on the model.
  - **B) Dynamic Fields** (`DynamicFieldsCard.kt` in Settings): `dynamic_fields` collection via `FirestoreClient.dynamicFieldsStream/createDynamicField/updateDynamicField/archiveDynamicField`. Model = flat `DynamicField(name [snake_case key], label, fieldType, appliesTo [kinfolk|kin|session|booking], options, required, helpText, displayOrder, archived)`. This one **has** the `appliesTo` placement concept the FormSchema system lacks.
  - These are the "Format Schemas" and "Dynamic Fields Manager" the backlog says are the same feature built twice (14.1). They use **different collections, different models, different callables, and different UIs** — neither is the single working system.
- **Desired (backlog 14.1/14.2):** **one** working dynamic-fields system. Purpose (14.2): admin-defined fields that attach to **Kinfolk, Kin, KinTales, and pet-profile pages**, powering the precare checklist (backlog 5.5). This previously worked under Settings → Business Settings; restore that.
- **Fix (full-stack — a consolidation, decide the survivor):**
  1. **Decision (❓CONFIRM):** pick ONE backing system. The `DynamicField` model (system B) already carries `appliesTo` (placement) + `fieldType` + `options` + `required` and is the simpler flat model that downstream consumer screens read; the `FormSchema` system (A) has the richer sectioned editor + Cloud-Function validation + versioning. Recommend keeping the **`FormSchema`/Cloud-Function backend** (validated, versioned, server-authoritative) and folding the `appliesTo`/placement concept (item 14.4, see 27-formschema-editor.md) into it — then **retire `dynamic_fields` + `DynamicFieldsCard`** with a migration. Do NOT leave both live.
  2. **Migrate** existing `dynamic_fields` docs into the chosen system (or vice versa) so no admin-authored field is lost — fail loud if a migration can't map a field, don't drop it silently.
  3. **Remove the loser's UI** and update the `FirestoreClient` KDoc (l.1155) that still references the non-existent `DynamicFieldsManagerScreen.kt`.
  - **Dependency:** a model/collection unification + a data migration + a consumer-screen audit (every screen that reads `dynamic_fields` or `form_schemas` must point at the survivor). Tri-platform; integration-test the migration; e2e-test that a field authored here renders on the precare checklist (5.5).

## 2. Sortable list + clickable rows + New schema (already real — keep)
- **Current:** the list is a real sortable table — `SortCol` Name/Version/UpdatedAt/UpdatedBy with `HeaderCell` toggles (ll.71, 248-272, 370-403), default most-recent-first (ll.114-115, 131-151), blank-`updatedAt`-last semantics. Rows are clickable into the editor (`SchemaRow` ll.294-368, `onOpenEditor(row.id)`), and "New schema" routes through the non-blank `NEW_SCHEMA_ID = "new"` sentinel (ll.90, 168-183) that fixed the create-route flicker bug. Bound to the real `repository.listSchemas()` with a fail-loud error banner + Retry (ll.120-127, 189-203). All real.
- **Desired:** mock's sortable Name/Version/Updated/Updated-by table + New schema action.
- **Fix:** none functionally. Keep. After consolidation (item 1) this list should show the unified system's entries and ideally group/filter by `appliesTo` placement.

## 3. SUGGESTION search / count chip / row-delete — honestly gated
- **Current:** three local flags ship dark: `FF_SCHEMA_SEARCH` (ll.94, 226-246, with a visible "Suggestion" pill when on), `FF_SCHEMA_COUNT_CHIP` (ll.95, 209-216), `FF_SCHEMA_ROW_DELETE` (ll.96, 271, 348-366 — inert because no delete callable is wired from the list; real delete lives in the editor). All correct fail-loud.
- **Desired:** mock's search box, row-count chip, per-row actions.
- **Fix:** keep gated. Row-delete must stay inert from the list (delete belongs in the editor via `deleteFormSchema`); search/count chips are client-side conveniences. Low priority vs item 1.

---

## Out of scope / leave as-is
- Sorting, clickable rows, New-schema sentinel routing, fail-loud load error + Retry, the three gated SUGGESTION flags — all real; do not regress.
- The duplicate `NEW_SCHEMA_ID` vs `FORM_SCHEMA_NEW_SENTINEL` constants (noted in ll.73-90) should be collapsed into one shared declaration during the consolidation.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Unify the two dynamic-field systems** (`form_schemas`/`FormSchema` vs `dynamic_fields`/`DynamicField`) into one (item 1, ❓CONFIRM survivor). Fold `appliesTo`/placement into the survivor.
2. **Data migration** between the two collections so no admin-authored field is lost (fail loud on unmappable fields).
3. **Consumer-screen audit + repoint** — every screen reading either collection (Kinfolk/Kin/KinTales/pet-profile, precare checklist 5.5) must read the survivor.
4. **Retire the loser's UI + fix the stale `FirestoreClient` KDoc** pointing at the non-existent `DynamicFieldsManagerScreen.kt`.
5. **Collapse duplicate `NEW_SCHEMA_ID`/`FORM_SCHEMA_NEW_SENTINEL` constants** into one shared declaration.

Every value rendered on this screen must trace to `repository.listSchemas()` (or the unified system's stream after consolidation). If it can't, it ships dark with a Not-wired banner — not hardcoded.
