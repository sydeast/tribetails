# Form Schema Editor — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-formschema-editor-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/admin/formschemas/FormSchemaEditorScreen.kt` (+ `FormSchemaEditorViewModel.kt`, `FormSchemaHelpers.kt`)
**Repository:** `FormSchemaRepository` / `CloudFormSchemaRepository` in `…/web/data/FormSchemaRepository.kt` — `getSchema`/`saveSchema`/`deleteSchema` (callables `getFormSchema`/`saveFormSchema`/`deleteFormSchema`); models `FormSchema(id, name, description?, version, sections[], …)` (ll.50-58), `FormFieldSpec(key, label, type, options?, helperText?, placeholder?, defaultValue?, group?, required)` (ll.26+), `FormSectionSpec(title, description?, fields[])` (ll.39+)
**Validation:** `validateFormSchema` in `FormSchemaHelpers.kt` (ll.57-158) — client parity with backend Zod
**Shared components:** `DenScreenHeading`, `DenPanel`, `GlassSurface`, `BottomBorderField`, `MultilineField`, `AuntieChip`, `AuntieStatusPill`, `SegmentedPicker`, `AuntieIconButton`, `AuntieBanner`, `StatusToast`, `GhostButton`, `PrimaryButton`.

> Mock-file confirmation: `FormSchemaEditorScreen.kt` (KDoc ll.68-78) mirrors `auntieos-formschema-editor-2026-05-27.html`. No correction needed. (Note: the mock header lists the 9 types as `text, textarea, select, multiselect, date, number, checkbox, phone, email`; the real `FormSchema.SUPPORTED_TYPES` is `text, long_text, number, boolean, date, email, phone, select, multiselect` — trust the code's type list.)

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`tribeProfile`, `Tribe Profile`, `Small, Medium, Large`, sample field keys/labels, version numbers) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Backend should auto-generate snake_case field keys — user shouldn't type them (backlog 14.3 — core complaint)
- **Current:** the operator types the **field key by hand**. `FieldCard` (`FormSchemaEditorScreen.kt` ll.449-464) renders "Field key *" as a `BottomBorderField` bound to `viewModel.updateFieldKey` (`FormSchemaEditorViewModel.kt` l.110, `it.copy(key = key.trim())`). Validation (`FormSchemaHelpers.kt` ll.107-114, `FIELD_KEY_REGEX = ^[a-zA-Z][a-zA-Z0-9_]*$`) only *rejects* bad keys — it never *derives* one. So the admin must invent a regex-valid identifier per field (exactly backlog 14.3's complaint). Same for the **Schema ID** ("Schema ID *", ll.161-168, `updateId` VM l.90) — typed by hand.
- **Desired (backlog 14.3):** the user types the human **label**; the **backend auto-generates** the `snake_case` key. The user should not author identifiers.
- **Fix (full-stack):**
  1. **Backend:** have `saveFormSchema` derive the field `key` (and schema `id`) from the label/name server-side (slugify → snake_case, dedupe within section). The server already bumps `version`/`updatedAt`/`updatedBy` (FormSchemaRepository ll.46-47), so server-derived keys fit the server-authoritative pattern.
  2. **Client:** demote the "Field key" input — either remove it (label-only) or make it an auto-filled, optional advanced override that defaults to the slugified label. The current behavior (required manual key) must go. Keep `validateFormSchema` as a guard for the override case.
  3. Same treatment for Schema ID (derive from Name; keep immutable-once-persisted, ll.164-167).
  - **Dependency:** server-side key/id derivation in `saveFormSchema` + a stable dedupe rule. Tri-platform (Android editor must match); unit-test the slugifier; integration-test that a label-only field round-trips a server-generated key.

## 2. "Applies to" needs a concrete placement target (backlog 14.4 — core complaint)
- **Current:** the `FormSchema` model has **no placement/`appliesTo` concept at all**. `FormSchema`/`FormSectionSpec`/`FormFieldSpec` (FormSchemaRepository ll.26-58) carry no field saying *which page/entity/section* the schema attaches to. The editor (this screen) only authors id/name/description/sections/fields. The complaint that it "applies to kin folk / kin session / booking but not where" actually describes the **other** system — `DynamicField.appliesTo` (FirestoreClient l.1166, values `kinfolk|kin|session|booking`) — which has a coarse entity but still no sub-section placement. Either way: **no concrete placement target exists**, and the FormSchema editor has none.
- **Desired (backlog 14.4):** the admin chooses the **exact section/location** the field/schema appears under a given entity (Kinfolk / Kin / KinTales / pet-profile), and the UI **shows where it will go**.
- **Fix (full-stack — tied to the consolidation in 26-formschema-list.md item 1):**
  1. **Model:** add a placement target to the unified schema model — entity (kinfolk/kin/kintale/pet-profile) **plus** a named sub-section/anchor on that page (the "where", not just the "what"). The consumer pages must expose stable placement anchors to choose from.
  2. **Editor:** add a placement picker (entity → section/anchor) and render a short "this will appear under {entity} → {section}" confirmation so the admin sees the destination.
  3. **Backend:** `saveFormSchema` persists the placement; consumer screens read it to decide where to render the dynamic fields.
  - **Dependency:** placement-anchor registry on the consumer pages + a placement field on the model + consumer-screen render wiring. This is the same unification work as 26-formschema-list.md. Tri-platform; e2e-test placement→render on the precare checklist (backlog 5.5).

## 3. Live preview — honestly gated (backlog: FF_FORMSCHEMA_LIVE_PREVIEW dark, no preview renderer)
- **Current:** gated behind `FF_FORMSCHEMA_LIVE_PREVIEW = false` (`FormSchemaEditorScreen.kt` ll.61-66, 231-245). When on it renders only a fail-loud "Not wired yet" Suggestion banner — there is **no preview-render data path** in source (the mock tags the preview pane `data-suggestion`). Correct fail-loud behavior; no fake preview ships.
- **Desired:** mock's right-column live preview rendering the schema as a kinfolk would see it.
- **Fix (full-stack):**
  1. **Build a preview renderer:** a component that takes the in-flight `FormSchema` (sections + fields + types + options + required) and renders the actual kinfolk-facing form (reusing the runtime form renderer the consumer pages use, so the preview matches production). This is the missing data path.
  2. Wire it into the gated pane (ll.231-245), then flip `FF_FORMSCHEMA_LIVE_PREVIEW`. The preview must reflect placement (item 2) once that exists.
  - **Dependency:** a shared runtime form renderer the preview can call. Do not approximate with a hand-built mock layout — reuse the real renderer or the preview lies. Tri-platform; visual-regression the preview against the rendered form.

## 4. Real config tools per field (backlog 14.5)
- **Current:** the field config is fairly complete already — `FieldCard` (ll.396-531) offers key, label, the 9-type chip row (`FieldTypeChipRow` ll.533-556), conditional Options CSV (shown only when `typeRequiresOptions`, ll.476-485), helper text, placeholder, default value, group, and a Required Yes/No `SegmentedPicker` (ll.512-524). Reorder (up/down) + delete on sections and fields (ll.311-333, 424-447) are wired to VM mutators. Validation is inline + fail-loud (`ValidationBanner` ll.558-570). This already satisfies most of 14.5.
- **Desired (backlog 14.5):** field configuration (type, label, options, placement) that actually saves and renders.
- **Fix:** the missing pieces are **placement** (item 2) and the user **not** typing keys (item 1). Otherwise keep the existing config tools. The "actually renders" half = the consumer-screen render wiring from item 2.

## 5. Schema meta, sections, save/delete, dirty pill, validation (already real — keep)
- **Current:** schema id/name/description meta (ll.155-193), sectioned structure with at least-one-section / at-least-one-field enforcement (validation ll.80-99), create-vs-edit mode via `isCreateMode` (VM ll.30-31), immutable id on edit (ll.164-167), Save gated on `state.canSave` with a Saving state (ll.275-281), confirm-to-delete (ll.253-269), an "Unsaved" dirty pill (ll.109-115), success toast + persistent error banner forwarding backend Zod detail (ll.127-147). All real, all fail-loud.
- **Desired:** mock's meta inputs, sections, footer actions, validation banner, status toast.
- **Fix:** none functionally. Keep. The mock's other SUGGESTION items (dirty pill, collapse/expand on section cards) — dirty pill is already implemented; collapse/expand is optional polish.

---

## Out of scope / leave as-is
- Sectioned editor, reorder/delete, type chips, conditional options, required picker, validation parity with backend Zod, save/delete flow, dirty pill, status toast/banner — all real; do not regress.
- The supported-type list mismatch between mock and code (see header note) — trust `FormSchema.SUPPORTED_TYPES`.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Server-side snake_case key/id derivation in `saveFormSchema`** → stop making the admin type field keys + schema ids (item 1). Then demote/remove the manual key input.
2. **Placement target on the (unified) model + placement-anchor registry on consumer pages + render wiring** → the concrete "applies to where" (item 2); shared with 26-formschema-list.md consolidation.
3. **Shared runtime form-preview renderer** → unblocks the gated live preview (item 3, `FF_FORMSCHEMA_LIVE_PREVIEW`). Reuse the real consumer renderer, never approximate.
4. **Consumer-screen render wiring** → so authored fields actually appear under their placement on Kinfolk/Kin/KinTales/pet-profile + the precare checklist (5.5).

Every value rendered/saved on this screen must trace to `FormSchemaRepository` (`getSchema`/`saveSchema`) and the unified model. If a slot has no real data path (live preview, placement), it ships dark with a Not-wired banner — not hardcoded.
