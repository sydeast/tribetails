> STATUS 2026-06-09 (de-stale): all 7 spec items SHIPPED both platforms. The `FF_INVOICE_CLIENT_PAYMENTS` + `FF_INVOICE_HEADER_ACTIONS` gates are retired; real per-invoice payment join (`Payment.invoiceId`), Record Payment dialog (prefills + stamps `invoiceId`/`invoiceNumber`), generateReceipt, sendInvoiceReminder, generateInvoicePdf all live; linked-sessions panel bidirectional + fail-loud. ONLY GAP: the DRAFT "Review and send" affordance (`reviewAndSendDraftInvoice`) is on the ANDROID detail screen but missing from the WEB detail screen (web only has the list-row action). NOTE: `payInvoice` callable exists but has no detail-screen surface (kinfolk-side, not in this spec).

# Invoice Detail — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-invoice-detail-2026-05-27.html` (the mock's own header comment, ll.13-46, says it mirrors `InvoiceDetailScreen.kt` verbatim).
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/invoices/InvoiceDetailScreen.kt` (+ `InvoiceDetailState.kt`)
**Current code (android):** parity target — `Invoice` / `Payment` models are mirrored from Android (`FirestoreClient.kt` ll.883, 1048 KDocs); a matching Android detail screen must reach parity.
**Shared components:** `DenPanel`, `StatCard`, `AuntieStatusPill`, `AuntieKeyValueRow`, `AuntieChip`, `AuntieDialog`, `AuntieIconButton`, `AuntieBanner`, `StatusToast` (used `InvoiceDetailScreen.kt` ll.47-67).
**Data models:** `Invoice` `FirestoreClient.kt` ll.886-907; `Payment` ll.1051-1069.

> ⚠️ Code correction vs. the assignment complaint: the complaint says "payments should be linked to the invoice here (Payment has no invoiceId today); needs a Record Payment action." Both halves are already partly false. **`Payment` DOES carry `invoiceId` + `invoiceNumber`** (`FirestoreClient.kt` ll.1065-1068, written by `match_payments_to_invoices.py` for confident single-invoice matches), and **a `recordPayment` callable exists** (`FirestoreClient.kt` l.294). However: (a) this detail screen does **not** use `Payment.invoiceId` — it joins payments by **kinfolk only** via `paymentsForKinfolk()` (`InvoiceDetailState.kt` ll.62-72) behind `FF_INVOICE_CLIENT_PAYMENTS = false` (`InvoiceDetailScreen.kt` ll.79-84), and otherwise shows raw `paymentsHistory` text or a fail-loud "no linked payment" banner; and (b) there is **no Record Payment action on this screen** (it lives only on `PaymentsScreen`). So the real deltas are: switch the payments panel from the kinfolk heuristic to the existing `invoiceId` link, and add a Record-Payment entry point here.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`#TT-2048`, `Lorna Wren`, `$280.00`, `$0.00`, `Net 7`, `123 Riverside Ln`, `2026-05-18`, `Paid in full via card on 2026-05-24. Ref #PMT-77310`, `Dog Walking`, `auto`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Header status badge
- **Current:** accent-tinted full-width bar (`InvoiceDetailScreen.kt` ll.242-268): "Invoice #{invoiceNumber}" + `kinfolkName` (when non-blank) + a status pill PAID/OVERDUE/OUTSTANDING with icon. Status from `invoiceStatusFor()` (`InvoiceDetailState.kt` ll.44-49: PAID when `amountDue <= 0`, OVERDUE when still-owed and `dueDate < today`, else OUTSTANDING). All real.
- **Desired:** mock `.badgebar.paid/.out` = inv-no + kinfolk line + a PAID/OUTSTANDING status word. Already matched (the mock adds a third OVERDUE-equivalent the code already supports).
- **Fix:** no change. The mock's kin photo minis beside the name are self-flagged SUGGESTION (mock ll.99, 214) — the real screen prints `kinfolkName` text only; leave it. The mock's separate dashed "header actions" bar (Receipt / Send reminder, mock ll.226-233) is also self-flagged SUGGESTION and already exists in code dark behind `FF_INVOICE_HEADER_ACTIONS = false` (`InvoiceDetailScreen.kt` ll.76-77, 298-327) — keep dark.

## 2. Amount stat row
- **Current:** two `StatCard`s (`InvoiceDetailScreen.kt` ll.271-294): "Total" (`formatMoney(total)`, trend = `date`) and "Amount due" (feature, tone by status, trend "paid in full" / "past due {dueDate}" / "due {dueDate}"). Real.
- **Desired:** the mock folds totals into the **Amounts card** rows (Total / Amount due accent-tinted) rather than two stat cards. The code's stat-card treatment is a richer variant; the data is identical and real.
- **Fix:** no data change. Optional styling alignment to the mock's row-style amounts is cosmetic; the bound values (`total`, `amountDue`, status) are already real. No dependency.

## 3. Billing panel
- **Current:** `DenPanel("Billing")` (`InvoiceDetailScreen.kt` ll.330-338): Client, Date, Due date, Terms (only if non-blank), Address (only if non-blank), via `DetailRow`. Blanks render "-". Real fields.
- **Desired:** mock `.card` Billing = Client / Date / Due date / Terms (conditional) / Address (conditional). Verbatim match (mock ll.235-246).
- **Fix:** none.

## 4. Amounts panel
- **Current:** `DenPanel("Amounts")` (`InvoiceDetailScreen.kt` ll.341-359): Total (Total style), Amount due (accent success/error), Discount (only when non-blank and not "0%"/"0.00%"). Real.
- **Desired:** mock Amounts = Total / Amount due (accent) / Discount (conditional). Verbatim match (mock ll.248-258).
- **Fix:** none.

## 5. Payments panel — the real delta (use Payment.invoiceId, not the kinfolk heuristic)
- **Current:** `DenPanel("Payments")` (`InvoiceDetailScreen.kt` ll.361-425): shows raw `invoice.paymentsHistory` text when present; a kinfolk-level heuristic list (`paymentsForKinfolk`, `InvoiceDetailState.kt` ll.62-72) only when `FF_INVOICE_CLIENT_PAYMENTS = true` (default false) behind a "NOT INVOICE-LINKED" warning; otherwise a fail-loud "NO LINKED PAYMENT" banner. The heuristic + banners are honest given the screen never reads `Payment.invoiceId`.
- **Desired:** the mock's "Payment History" card (ll.260-266) is just the raw `paymentsHistory` free-text. The richer intent (a structured list of payments applied to *this* invoice) is the substance of the complaint.
- **Fix:** replace the kinfolk-level heuristic with the **real per-invoice join that already exists in the data**: filter `paymentsStream()` by `payment.invoiceId == invoice._id` (the confident link written by `match_payments_to_invoices.py`, `FirestoreClient.kt` ll.1065-1068). That turns the dark `FF_INVOICE_CLIENT_PAYMENTS` heuristic into a real, invoice-scoped list — render each via the existing `PaymentRow` (ll.441-476). Keep the raw `paymentsHistory` text as a secondary record. Keep a fail-loud empty ("No payment recorded against this invoice yet") when no payment has `invoiceId == this`.
  - **Dependency:** add an **`invoiceId` filter to the payments read** (a `paymentsForInvoice(payments, invoiceId)` pure helper alongside `paymentsForKinfolk`, or a server-side `where invoiceId ==` query). The link field is already populated, so this is a data-layer + wiring change, not a new backend write. Parity across web/desktop/Android; unit test the filter, integration test against a fixture where a payment's `invoiceId` matches.

## 6. Record Payment action (MISSING on this screen)
- **Current:** none. Recording a payment is only reachable from `PaymentsScreen` (`PaymentsScreen.kt` ll.91-104, `RecordPaymentDialog` ll.418-554), which calls the real `recordPayment` callable (`FirestoreClient.kt` l.294).
- **Desired:** the complaint asks for a Record Payment action *here*, so a payment can be logged against the open invoice in context.
- **Fix (full-stack wiring, callable already exists):** add a "Record payment" action to the detail header that opens a record-payment dialog **prefilled** from the invoice (`kinfolkId`, `kinfolkName`, `amount` defaulting to `amountDue`, and crucially `invoiceId = invoice._id` + `invoiceNumber`). On save, call the existing `recordPayment`. This both adds the missing action and writes the `invoiceId` link so item 5's join is populated going forward.
  - **Dependency:** `Payment` already has `invoiceId`/`invoiceNumber` and `recordPayment` exists, so the only real work is (a) extend the record-payment path to accept/write `invoiceId` (the current `RecordPaymentDialog` builds a `Payment` without `invoiceId`, `PaymentsScreen.kt` ll.445-456) and (b) surface the dialog here. Backend write is already there; this is data-layer + wiring + frontend + parity. Tests: unit on the prefilled `Payment` (asserts `invoiceId` set), integration on the write round-trip, UI test on the dialog open/save from the detail screen.

## 7. Linked Sessions panel
- **Current:** `LinkedSessionsSection` (`InvoiceDetailScreen.kt` ll.540-612) + `LinkSessionsDialog` (ll.478-538): attribution chip ("auto" for `greedy_by_date`, "manual"), edit pencil, real session rows (serviceType + date + status pill), empty state "No linked sessions yet." + "Link sessions", a fail-loud "CANNOT LINK" banner when `kinfolkId` is blank, and a chip multi-select editor that writes via `updateInvoiceSessionIds` + bidirectional `updateSessionInvoiceId` (ll.196-218; callables `FirestoreClient.kt` ll.49-51). Fully real and wired.
- **Desired:** mock's Linked Sessions card + Link Sessions dialog (ll.268-348) — verbatim match per the mock's own comment (ll.26-31).
- **Fix:** none. This is the most complete part of the screen; do not touch.

---

## Out of scope / leave as-is
- Loading shimmer, Err banner, NotFound banner (`InvoiceDetailScreen.kt` ll.111-143) — fail-loud, correct.
- `invoiceStatusFor` / `isIsoDateBefore` status logic (`InvoiceDetailState.kt`) — shared, audited.
- The mock's SUGGESTION elements (kin photo minis, dashed header action bar) — already gated dark or intentionally omitted; do not promote.
- Global search / notification bell are shell-level (`web/.../ui/shell/AppShell.kt`), not this screen.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **`paymentsForInvoice(payments, invoiceId)` filter** (or a server-side `where invoiceId ==` query) → turn the dark kinfolk-heuristic payments panel into a real per-invoice list using the already-populated `Payment.invoiceId`. Retire `FF_INVOICE_CLIENT_PAYMENTS`.
2. **Record-payment-with-invoice-link on this screen** → extend the existing `recordPayment` path to set `invoiceId`/`invoiceNumber` and surface a prefilled dialog from the detail header. Callable exists; work is data-layer + wiring + UI + parity.
3. **Invoice header action callables** — `generateReceipt`, `sendInvoiceReminder` (`InvoiceDetailScreen.kt` l.77 TODO) → light up the dark `FF_INVOICE_HEADER_ACTIONS` bar.

Every value on this screen must trace to `invoicesStream()` / `paymentsStream()` / `sessionsForKinfolkStream()` (`FirestoreClient.kt`) or a new real source. If it can't, it ships dark with a Not-wired banner — not hardcoded.
