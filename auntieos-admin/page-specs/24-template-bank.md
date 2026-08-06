# Template Bank — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-template-bank-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/admin/TemplateBankScreen.kt`
**Service:** `TemplateService` in `…/web/data/TemplateService.kt` — `listTemplates` / `saveTemplate` (callables `listTemplates`, `saveTemplate`); `EmailTemplate(templateId, subject, body, html?, title, description?, tags[], category?)` (ll.28-37)
**Related screen:** Template Assignment (`TemplateAssignmentScreen.kt`) — see 25-template-assignment.md; backlog 13.1 asks to merge/relate the two.
**Shared components:** `DenScreenHeading`, `DenPanel`, `StatCard`, `AuntieChip`, `AuntieDialog`, `AuntieEmailPreviewCard`, `AuntieEmptyState`, `BottomBorderField`, `MultilineField`, `AuntieSearchField`, `GhostButton`, `PrimaryButton`.

> Mock-file confirmation: the mock header (ll.11-19) names `TemplateBankScreen.kt` + the `EmailTemplate` model. No correction needed. The shipped screen is **ahead of** the mock on several SUGGESTION items (card tap → read-only view, working New template, live preview in editor) — the mock's `// SUGGESTION` notes (ll.25-32) are already implemented in code.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (template subjects/bodies, category names, tag chips, the stat counts) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Category must pull from a real category list, not optional free text (backlog 13.2 — the core complaint)
- **Current:** category is **free text**. In the editor (`TemplateEditorOverlay` ll.506-649) it is a `BottomBorderField` labelled "Category (optional)" (ll.597-602) only shown in create mode; in edit mode there is no category control at all. The filter chips use a **hardcoded** `FILTER_OPTIONS = listOf("All", "Onboarding", "Bookings", "Invoicing", "Re-engagement")` (l.64), which do NOT come from the stored categories. The stat strip counts `categoriesPresent` from `it.category` distinct values (ll.117-118). `TemplateService` has **no `listCategories` callable** — categories are whatever free text was typed, so duplicates/typos/casing drift are inevitable (exactly backlog 13.2's concern).
- **Desired:** category chosen from the **existing category list** (a selector), consistent between the filter chips and the editor.
- **Fix (full-stack):**
  1. **Backend:** add a real category source — either a `listCategories` callable / `template_categories` collection, or derive a canonical, deduped, normalized category list server-side. Until it exists, do NOT pretend the hardcoded `FILTER_OPTIONS` are the real categories; keep them but label them as a fixed taxonomy, and gate any "managed categories" UI dark.
  2. **Editor:** replace the free-text category field (ll.597-602) with a single-select chip/dropdown bound to the real list, available in **both create and edit** mode (today edit mode can't set category at all).
  3. **Filter chips:** drive `FILTER_OPTIONS` from the real category list, not the literal at l.64. Unit-test the category source; integration-test filter↔editor consistency. Parity on all platforms.

## 2. Real rich editor with HTML / images / links + live preview (backlog 13.3-13.6)
- **Current:** the body/HTML editors are plain text. `TemplateEditorOverlay` uses `MultilineField` for "Body (Handlebars supported)" (ll.610-616), "HTML (optional)" (ll.617-623), and "Description" (ll.624-630). There IS a working live preview — `AuntieEmailPreviewCard` in the editor's right column (ll.637-645) and in the read-only viewer (ll.478-487), with `highlightTokens = true`. So backlog 13.5 (live preview) is **already done**; 13.3/13.4 (real editor widget + formatting tools / images / links) are **not** — it is raw text boxes.
- **Desired:** a proper rich editor for client-facing templates: **HTML formatting, images, and links**, rendered in the live preview.
- **Fix:**
  1. **Component:** build/adopt a rich-text/HTML editor component (formatting toolbar: bold/italic/lists/links, image insert) that writes to the `html` field. The `body` (plaintext/Handlebars) stays for the text fallback. Image insert needs a Cloud Storage upload path (gate dark with a Not-wired banner until that exists — do not fake an upload).
  2. **Preview:** `AuntieEmailPreviewCard` already renders `html` (ll.481-482, 641); ensure it renders inserted images/links faithfully. Keep `highlightTokens` for merge fields.
  - **Dependency:** image upload storage path; a Compose-friendly HTML/rich-text editor. Parity across platforms (Wasm/JVM/Android editors must match). Component + UI tests for the toolbar; visual-regression the preview.

## 3. Add instructions / directions (backlog 13.7)
- **Current:** the only guidance is the panel subtitle "Tap a card to read it, or Edit to change the subject, body, and HTML." (l.203) and the editor hint about Firestore/Handlebars/SendGrid (l.536). No task-level directions on what the Template Bank is for or how to use it.
- **Desired:** clear directions/instructions on the screen.
- **Fix:** add a short directions block (e.g. a `DenPanel`/banner intro) explaining the bank's purpose and the create/edit/assign flow. Author the operator-facing copy with Auntie (do not invent customer-facing copy here). No backend dependency.

## 4. Templates assigned to categories incl. drag-and-drop, incl. seeded templates (backlog 13.8)
- **Current:** category is set only via the free-text field in create mode (item 1); there is **no drag-and-drop** anywhere (backlog notes DnD is disabled app-wide and should be enabled here first), and no way to re-categorize a **seeded** template (edit mode has no category control at all).
- **Desired:** assign categories to templates by **drag-and-drop** (drag a template card onto a category bucket), and allow editing the category on **seeded** templates too.
- **Fix (full-stack):**
  1. Make category editable on every template (create + edit, item 1.2) so seeded templates can be re-categorized. This flows through the existing `saveTemplate` upsert (ll.312-320) — verify seeded docs are writable (they are upserted by `templateId`).
  2. Add a drag-and-drop interaction: category buckets/columns as drop targets; dropping a card calls `saveTemplate` with the new `category`. This is the first DnD surface in the app — build a reusable DnD primitive. Gate behind a flag until the category source (item 1) is real, so cards drop onto real categories, not typo'd free text.
  - **Dependency:** real category list (item 1) + a DnD primitive + `saveTemplate` already handles the write. Integration-test drop→persist; parity on all platforms (DnD on Android/desktop too).

## 5. Card tap → readable view + working New template (already real — keep)
- **Current:** a card tap opens a **read-only** `TemplateViewOverlay` (ll.280, 293-303, 418-490) rendering key/category/subject/body/html/description/tags + an inbox preview — fixing the old "viewing a template is unreadable" complaint (13.6). "New template" opens the editor in create mode and persists via `saveTemplate` (ll.130-153, 312-320) with a key-collision guard (ll.526-571). All real.
- **Desired:** mock cards + New action.
- **Fix:** none functionally. Keep. The mock's SUGGESTION list (search box, count chips, category pill on card, live preview) is already implemented in code.

## 6. SUGGESTION search box — honestly gated
- **Current:** the in-card search is gated behind `FF_TEMPLATE_SEARCH = false` (ll.66-70, 228-239). `EmailTemplate` carries no search index and `TemplateService` has no search callable, so when on it only narrows the loaded list by title/templateId client-side.
- **Desired:** mock `.sug` search input.
- **Fix:** keep gated; it is a client-side convenience. Low priority.

---

## Out of scope / leave as-is
- Card-tap read-only view, working New template, key-collision guard, live preview in editor + viewer, stat strip, error banner — all real; do not regress.
- SendGrid/Handlebars backend reality (templates in Firestore, SendGrid as dumb pipe) is correct and documented in the editor hint.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Real category source** (`listCategories` callable / `template_categories` collection or server-deduped list) → replaces free-text category + hardcoded `FILTER_OPTIONS` (items 1, 3, 4). Shared with Training Docs comm-type and Communicate template selection.
2. **Rich HTML/rich-text editor component + image upload storage path** → backlog 13.3/13.4 (item 2). Gate image insert dark until storage exists.
3. **Reusable drag-and-drop primitive** → category assignment by DnD, incl. seeded templates (item 4); first DnD surface in the app.
4. **Category editable in edit mode (incl. seeded)** → flows through existing `saveTemplate`; verify seeded-doc writability (item 1.2/4.1).
5. **Merge with Template Assignment (LOCKED — Decision 2):** ONE Templates screen, two tabs — **"Bank"** (author templates, this spec) + **"Assignment"** (bind templates). A binding = template ↔ trigger event. See 25-template-assignment.md.

Every value rendered on this screen must trace to `TemplateService.listTemplates()` (or the new category source). If it can't, it ships dark with a Not-wired banner — not hardcoded.
