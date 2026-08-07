> STATUS 2026-06-09 (de-stale): list + actions shipped both platforms. createInvoice / sendInvoiceReminder / generateReceipt / reviewAndSendDraftInvoice deployed + wired (no "not wired" pills; the local `FF_` flags are gone); New-invoice CTA (`invoicesCreate` flag, default on) + kinfolk household facet picker + search + Create-quote all live. GAPS: (1) kin/pet sub-line under the household name in invoice rows (no kin join either platform); (2) the middle stat stays "Billed total" because `Invoice` has no `paidDate`, so "paid this month" needs a Payment->Invoice paid-date aggregation. PARITY: android lacks the "Quotes" filter tab (5 vs 6) + the web receipt kill-switch flag. Spec line refs stale.

# Invoices — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-invoices-2026-05-27.html`
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/invoices/InvoicesScreen.kt` (+ `InvoiceFilters.kt`)
**Current code (android):** parity target — the Android `Invoice` model is mirrored (`FirestoreClient.kt` l.883 KDoc: "Mirrors the Android `Invoice` model"); a matching Android invoices screen must reach parity.
**Shared components:** `StatCard`, `DenScreenHeading`, `DenPanel`, `AuntieAvatar`, `AuntieSearchField`, `AuntieChip`, `AuntieStatusPill` in `…/web/ui/components/` (used `InvoicesScreen.kt` ll.36-51).
**Data model:** `Invoice` in `…/web/data/FirestoreClient.kt` ll.886-907.

> ⚠️ Code correction vs. the assignment complaint: the complaint says "rows are missing real Kinfolk first/last name + info (not migrated/joined)" and "needs filtering by Kinfolk name, not just a bare search." The shipped code already does both. `Invoice` carries `kinfolkId` + `kinfolkName` (`FirestoreClient.kt` ll.889-890), the row binds `kinfolkName` (with avatar seeded on `kinfolkId`) at `InvoicesScreen.kt` ll.381-396, and `matchesQuery` already searches `kinfolkName` + `client` + invoice number + amount (ll.96-103). So the bare-search complaint is partly already addressed. What is genuinely missing vs. a "real Kinfolk first/last + info" join is: the row shows only the household-level `kinfolkName` string, never the kin (pets) or a resolved first/last split, and the search has no dedicated "by Kinfolk" affordance. This spec scopes the remaining real gaps and does not re-author work that already shipped.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`$640`, `$1,920`, `+12%`, `the Sparrows · 6 days past`, `#TT-2048`, `Lorna Wren`, `Biscuit, Gravy`, `linked to 6 visits`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Summary strip — three stat cards
- **Current:** three `StatCard`s in a row, weights `1.4f / 1f / 1f` (`InvoicesScreen.kt` ll.245-276): Outstanding (sum `amountDue` of outstanding), **Billed total** (sum of `total`), Overdue (count). Outstanding/Overdue go feature when nonzero. All bound to real `Invoice` fields.
- **Desired:** mock `.summary{grid-template-columns:1.4fr 1fr 1fr}` = Outstanding (orange feature wash), **"Paid this month"** with a teal percent-delta subline, Overdue (coral). The mock's `$640` / `$1,920` / `+12%` / `the Sparrows · 6 days past` are placeholder per Rule 1.
- **Fix:** weights + ordering already match. The middle card is the real gap: the code deliberately shows **"Billed total"** not "Paid this month" because there is no paid-date on `Invoice` (the KDoc-honest note at ll.260-264 says paid date lives on `Payment.date`, not joined). Keep that honest fallback; do **not** print a hardcoded "$1,920 / +12%". Outstanding subline already names "across N invoices"; the "2 sent today" half of the mock subline has no data source (no per-invoice sent-timestamp) — leave it off, don't fake it.
  - **Dependency:** a **monthly paid-total aggregation** (sum of payments in the current month, joined invoice→payment or summed from the payments collection) + a prior-month figure to compute the teal `% delta`. Until it exists, the card stays "Billed total." Backend → data layer → web/desktop/Android, with a unit test on the aggregation and a component test on the delta tinting.

## 2. Filter tabs + search row
- **Current:** `FilterRow` (`InvoicesScreen.kt` ll.279-308): chip tabs `All / Unpaid / Paid / Overdue / Drafts` (enum ll.80-86) + an `AuntieSearchField` placeholder "Search invoice #, kinfolk, or amount...". `matchesQuery` searches invoice number, `kinfolkName`, `client`, formatted amount (ll.96-103). `matchesFilter` uses the shared `InvoiceFilters.kt` helpers so list/detail agree.
- **Desired:** mock `.filters` = the same five tabs + a search box "Search invoice #, kinfolk, or amount…". Structurally already matched.
- **Fix:** tabs + search are present and real. The remaining complaint ("filter by Kinfolk name, not just a bare search") is the only true delta: the search already matches kinfolk name as one OR-term, but there is no **dedicated Kinfolk facet** (e.g. pick a household and pin the list to it). If that is wanted, add a kinfolk filter that resolves a real `kinfolkId` from the kinfolk stream (same pattern as `CommunicateScreen` RecipientPicker) and filters `Invoice.kinfolkId == picked`. Do not build a free-text "name" filter that re-implements the existing search.
  - **Dependency:** a **kinfolk lookup** for the facet picker (reuse `kinfolkStream()`); the filter itself is client-side once the id is chosen. Tests: unit on the `kinfolkId` predicate; UI test that picking a household narrows the rows; parity on all three platforms.

## 3. Invoice row — who column (kinfolk name + kin/pets)
- **Current:** `InvoiceRow` who-column (`InvoicesScreen.kt` ll.376-397): `AuntieAvatar` seeded on `kinfolkId`/`kinfolkName`, primary line = `kinfolkName` (falls back to `client`, then "Unknown"), secondary line = `client` only when it differs from `kinfolkName`. Real fields, correct slots.
- **Desired:** mock `.who` = a tinted avatar (`.av.a/b/c/d`), bold household name, then a **kin row**: small circular pet photo minis (`.pic`) + a `<small>` list of **kin (pet) first names** (mock "Biscuit, Gravy" / "Marigold" / "Cocoa, Olive"). Mock values are placeholder per Rule 1.
- **Fix:** the household name + avatar already bind. The genuinely missing piece (and the real meat of the "missing real Kinfolk info / not joined" complaint) is the **kin (pets) sub-line**: the per-pet names/photos shown under the household are not on the `Invoice` model at all. Add the kin list under the name; **do not** invent pet names.
  - **Dependency:** a **kin (pet) join onto the invoice's kinfolk** — resolve the household's kin from the kin/`the_411` collection by `kinfolkId`, surface first names (+ optional photo). This is a real backend/data-layer join (backend → data layer → web/desktop/Android). Until the join exists, render the household name only and **omit** the kin line rather than faking "Biscuit, Gravy". The mock's photo minis are flagged decorative; the `kin` text line is the data requirement. Tests: unit on the join resolver, component test on the row with/without kin, integration over a real invoice+kin fixture.

## 4. Invoice row — meta column (due/paid + linked visits)
- **Current:** meta column (`InvoicesScreen.kt` ll.400-426): a humanized status line ("draft" / "N days overdue" / "due May 31" / "paid May 24" / "no date") via `daysOverdue` + `humanizeDate` (`InvoiceFilters.kt` ll.74-114), plus a teal "linked to N visits" line from `invoice.sessionIds.size`. All real.
- **Desired:** mock `.meta` = bold humanized date ("paid May 24" / "due May 31" / "6 days overdue") + a teal `.link` "linked to N visits". Already matched.
- **Fix:** no change. This already binds to real `dueDate` / `date` / `sessionIds`. Leave as-is.

## 5. Right column — amount, status pill, row action
- **Current:** amount in tone-colored `titleLarge`, an `AuntieStatusPill` (Draft/Overdue/Unpaid/Paid), and `RowAction` (`InvoicesScreen.kt` ll.429-480). Each action ships **dark** behind a local `FF_` flag with a "not wired" pill: review&send / send reminder / receipt (ll.70-77, 450-490) because no callable exists.
- **Desired:** mock `.right` = `.amt` + a colored `.pill` + a `.pay` button per state (Receipt / Send reminder / Review & send). The mock's buttons look live; the real screen correctly refuses to ship dead buttons.
- **Fix:** keep the fail-loud "not wired" pills until real callables exist. **Do not** wire the mock's buttons to no-op handlers.
  - **Dependency (the real blocker):** three callables that do not exist in the verified client surface — `sendInvoiceReminder`, `generateReceipt`, `reviewAndSendDraftInvoice` (`InvoicesScreen.kt` ll.71-77 TODOs), plus a central `FeatureFlags` prop per action. Each is full-stack (Function/callable → data layer → wiring → frontend) and must be parity-built + tested before the corresponding `FF_` flips on.

## 6. Header CTA — "New invoice"
- **Current:** `NewInvoiceCta` (`InvoicesScreen.kt` ll.199-223): behind `FF_INVOICE_CREATE = false` it renders a muted "New invoice · not wired yet" pill instead of a dead button.
- **Desired:** mock `.add` = a solid orange "＋ New invoice" button.
- **Fix:** keep the dark gate. **Dependency:** a `createInvoice` callable (l.74 TODO) + central flag. Full-stack + parity + tests before it goes live.

## 7. Empty state — fail-loud disclosure
- **Current:** `EmptyState` (`InvoicesScreen.kt` ll.492-517): a dashed Suggestion banner stating creation/sending/receipting need callables that don't exist, plus a neutral "No invoices on the books yet" empty. Correct.
- **Desired:** mock has no explicit empty variant. Leave the honest disclosure as-is.
- **Fix:** none.

---

## Out of scope / leave as-is
- Loading shimmer, error banner (fail-loud on `invoicesStream` error), and the "N of M shown" `DenPanel` subtitle (`InvoicesScreen.kt` ll.128-186) already correct.
- `InvoiceFilters.kt` classification helpers (paid/outstanding/overdue, `daysOverdue`, `humanizeDate`, `formatMoney`) are shared and audited; do not fork them.
- Global search / notification bell are **shell-level** (`web/.../ui/shell/AppShell.kt`), not this screen — noted once here for all invoice/payment specs.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Monthly paid-total aggregation** (current + prior month for the teal % delta) → unblocks the "Paid this month" middle card. Never hardcode "$1,920 / +12%".
2. **Kin (pet) join onto the invoice's kinfolk** → the kin first-name sub-line under the household name (the core "missing real Kinfolk info" gap). Omit the line until the join lands.
3. **Kinfolk facet filter source** (reuse `kinfolkStream()`) → a dedicated filter-by-household control beyond the existing free-text search.
4. **Invoice action callables** — `createInvoice`, `sendInvoiceReminder`, `generateReceipt`, `reviewAndSendDraftInvoice` + their central `FeatureFlags` props → light up the header CTA and per-row actions now shipping dark.

Every value rendered on this screen must trace to the real `invoicesStream()` (`FirestoreClient.kt` l.48) or a new real source. If it can't, it ships dark with a Not-wired banner — not hardcoded.
