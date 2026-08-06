> ARCHIVED SCREEN (2026-06-07). The Payments `.kt` screen was removed from nav
> and moved to `archive/removed-payments-screen/`. This spec describes a screen
> that no longer ships; do NOT build against it and do NOT count it as a
> fidelity gap. Payment data still surfaces through Invoice detail
> (record-payment) per `17-invoice-detail.md`.

# Payments — current → desired delta

**Desired (source of truth):** `ui-ideas/auntieos-payments-2026-05-27.html` (the mock's own header comment, ll.11-39, says it mirrors `PaymentsScreen.kt`).
**Current code (web):** `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/payments/PaymentsScreen.kt` (+ `PaymentsViewModel.kt`)
**Current code (android):** parity target — `Payment` is mirrored from Android (`FirestoreClient.kt` l.1048 KDoc); a matching Android payments surface must reach parity.
**Tests present:** `web/composeApp/src/commonTest/kotlin/com/tribetails/auntieos/web/screens/payments/PaymentsViewModelTest.kt` (ViewModel unit tests exist).
**Shared components:** `StatCard`, `DenScreenHeading`, `DenPanel`, `AuntieAvatar`, `AuntieStatusPill`, `AuntieDialog`, `AuntieSelectField`, `BottomBorderField`, `AuntieSearchField`, `AuntieChip` (used `PaymentsScreen.kt` ll.38-58).
**Data model:** `Payment` `FirestoreClient.kt` ll.1051-1069.

> ⚠️ Code correction vs. the assignment complaint: the complaint says "Payments should be a sub of Invoices (linked via Payment.invoiceId), not a standalone page." Two points. (1) The **`Payment.invoiceId` link already exists** (`FirestoreClient.kt` ll.1065-1068) and this screen already **renders + navigates it**: each row shows a tappable "Invoice #…" chip when `payment.invoiceId` is non-blank, calling `onOpenInvoice(payment.invoiceId)` (`PaymentsScreen.kt` ll.365-384, plumbed from the screen param l.72). So the data link is not missing — only the *information architecture* is. (2) The IA gap is real: `Payments` is a **top-level `Destination.Payments`** in the "More" nav group (`web/.../ui/shell/NavDestinations.kt` l.51), a sibling of Invoices rather than a child of it. This spec scopes the IA/nesting work and the screen-level deltas; it does not re-author the already-shipped `invoiceId` chip.

---

## ‼️ TWO NON-NEGOTIABLE RULES FOR EVERY ITEM BELOW

**RULE 1 — Mock values are PLACEHOLDER. Never hardcode them.**
Every literal in the mock (`$1,247.50`, `$92.50`, `5`, `Lorna Wren`, `2026-05-27`, `Ref: 1042`, `Spring cleaning week, thank you!`, `+ $20.00 tip`) is **illustrative sample data**, not a value to type into the UI. The mock defines **structure, layout, styling, and which field goes where** — nothing about the numbers/strings. Every displayed value must be bound to a real data source (Firestore stream, ViewModel, callable). If the data source does not exist yet, **do not hardcode and do not fabricate** — gate the element dark behind a feature flag with a visible "Not wired" banner (fail loud, per CLAUDE.md). When this spec quotes a mock value, read it as "this slot, fed by real data," never "print this string."

**RULE 2 — Every fix is full-stack + tri-platform parity + fully tested.**
Per the CLAUDE rules, no item here is "just UI." Each component/feature must be delivered end-to-end: **backend (Firestore/Functions/callables) → API/data layer → routes/wiring → frontend** — and brought to **parity across web (Wasm), desktop (JVM), and Android**, with **all applicable test types** (unit, component/UI, integration, end-to-end) completed per component. A delta is not "done" when the web card looks right; it's done when the data path is real, the desktop and Android equivalents match, and the tests pass.

Legend: **Current** = what's shipped (real). **Desired** = mock *structure* (values are placeholder per Rule 1). **Fix** = concrete change, named to real code. **Dependency** = data/backend path that must be built (Rule 1/2) before the slot can show real data.

---

## 1. Information architecture — Payments as a sub of Invoices (the headline delta)
- **Current:** `Destination.Payments` is a standalone top-level destination in the **"More"** nav group (`web/.../ui/shell/NavDestinations.kt` l.51), with its own slug `"payments"` (`web/.../ui/shell/Route.kt` l.21). It is a sibling of `Destination.Invoices` (in "Care Ops"), not nested under it. `PaymentsScreen` already takes an `onOpenInvoice` callback (`PaymentsScreen.kt` l.72), so the upward link to a specific invoice exists, but there is no Invoices→Payments parent/child relationship in nav.
- **Desired:** the complaint wants Payments presented as a **sub-section of Invoices** (billing lives in one place; payments are the receipts side of an invoice).
- **Fix (IA decision, deliberate — do not guess):** decide between (a) keeping `Payments` as a destination but **re-homing it under the Invoices/billing area** (e.g. a tab/segment within an Invoices hub, or moving it from "More" to sit directly beneath "Invoices" in Care Ops), vs. (b) folding the standalone Payments list into Invoices entirely and reaching individual payments via the invoice detail (see spec 17). Whichever is chosen, **preserve a route** so existing `#/payments` links don't 404 (mirror the redirect pattern; keep `routeToHash`/`parseHash` honest, `Route.kt` ll.35-57).
  - **Dependency:** nav-graph change in `NavDestinations.kt` + `Route.kt` (and the Android/desktop nav equivalents) — a routing/wiring change, no new backend. Tests: route round-trip unit tests (old slug still resolves), nav integration test on web + desktop + Android.

## 2. Per-row invoice link — already real, keep
- **Current:** `PaymentRow` renders a tappable "Invoice #{invoiceNumber|invoiceId}" link with a `Link` glyph **only when `payment.invoiceId` is non-blank**, routing via `onOpenInvoice(payment.invoiceId)` (`PaymentsScreen.kt` ll.365-384). The honest comment (ll.365-367) notes the link is the confident match from `match_payments_to_invoices.py`; absent when no confident match.
- **Desired:** the mock's listed SUGGESTION #4 (ll.32-34) explicitly says "Payment has no invoice field" and omits the link — the **code is ahead of the mock here**. Keep the real link.
- **Fix:** none — this is exactly the "linked via Payment.invoiceId" the complaint asks for, already shipped. Do not remove it to match the (stale) mock.

## 3. Summary strip
- **Current:** three `StatCard`s (`PaymentsScreen.kt` ll.230-262): Total received (`sum(amount+tip)`, feature), Tips (`sum(tip)`), Count (`payments.size`). All real.
- **Desired:** mock `.summary` three tiles Total Received / Tips / Count (ll.217-223). Verbatim match.
- **Fix:** none.

## 4. Record Payment dialog
- **Current:** `RecordPaymentDialog` (`PaymentsScreen.kt` ll.418-554) → `vm.recordPayment` → real `recordPayment` callable (`FirestoreClient.kt` l.294). Fields: Kinfolk ID (required), Kinfolk Name, Amount (required), Tip (optional), Method select (CASH/CHECK/CARD/TRANSFER), Date (YYYY-MM-DD, validated), Reference number, Notes. Fail-loud validation: "Kinfolk ID is required", "Amount must be greater than zero", real-date check. Fully wired.
- **Desired:** mock `RecordPaymentDialog` (ll.308-363) — verbatim field set per the mock's own comment (ll.18-21). The mock's `<select>` Method (SUGGESTION #5) is **already shipped** as `AuntieSelectField` (`PaymentsScreen.kt` ll.518-524).
- **Fix:** one cosmetic correction: the source labels "Tip ($), optional" / "Reference number, optional" / "Notes, optional" (ll.511, 543, 549) already use a comma, not an em dash — good, keep. **One real enhancement tied to spec 17:** when this dialog is opened in an invoice context, it should write `invoiceId`/`invoiceNumber` onto the `Payment` so the link in item 2 gets populated at record time (the current `Payment(...)` build, ll.445-456, omits `invoiceId`). See spec 17 item 6.
  - **Dependency:** none for the standalone dialog (callable exists). The invoice-context prefill is the spec-17 dependency.

## 5. Search + method filter (gated SUGGESTION)
- **Current:** `PaymentControls` (search + method tabs All/Cash/Check/Card/Transfer) ships **dark** behind `FF_PAYMENTS_SEARCH_FILTER = false` (`PaymentsScreen.kt` ll.60-64, 189-212, 264-296). When off, the full ledger renders (nothing hidden). Client-side narrowing only.
- **Desired:** mock tags the search box + method tabs as SUGGESTION (ll.29-31, 97-108, 225-234) — not in the original contract.
- **Fix:** keep gated. These are presentation-only; if desired, flip on behind a real central flag and component-test the narrowing. No backend dependency.

## 6. Payment row body + method chip
- **Current:** `PaymentRow` (`PaymentsScreen.kt` ll.298-386): avatar (kinfolkName→client→"Unknown"), subline date · method `AuntieStatusPill` (tone by method, ll.388-394) · "Ref: {ref}", optional notes, right-aligned amount + "+ tip". All real, matching the mock's row + method chip (SUGGESTION #3, already shipped).
- **Desired:** mock `.pay` row — verbatim match including the colored method chip.
- **Fix:** none.

## 7. Empty state + ledger ordering
- **Current:** `PaymentsEmptyState` (PiggyBank + "No payments recorded yet" + tap-to-log copy, ll.396-416). Ledger partitions valid-date rows (sorted desc) from undated (stable bottom), so a bad write can't scramble the sort (`PaymentsScreen.kt` ll.214-218). Real + audited.
- **Desired:** mock `PaymentsEmptyState` (ll.288-298). Verbatim.
- **Fix:** none.

---

## Out of scope / leave as-is
- `PaymentsViewModel` stream/error handling + record-payment validation (`PaymentsViewModel.kt`) and its existing `PaymentsViewModelTest.kt` — correct; extend tests, don't fork.
- `formatMoney` (`PaymentsScreen.kt` ll.556-561).
- Global search / notification bell are shell-level (`web/.../ui/shell/AppShell.kt`), not this screen.

## Dependency / full-stack work list (the real blockers — each needs backend → wiring → web+desktop+android → tests)
1. **Nav-graph re-homing** — present Payments as a sub of Invoices (move/nest in `NavDestinations.kt` + `Route.kt`, keep `#/payments` resolvable) across web/desktop/Android. Routing-only; the headline delta of this complaint.
2. **Write `invoiceId` at record time** (shared with spec 17) — so the already-shipped per-row invoice link is populated for payments logged in an invoice context. Callable exists; data-layer + wiring.
3. (Optional) **Central flag for the search/method-filter strip** — promote the gated `FF_PAYMENTS_SEARCH_FILTER` SUGGESTION if wanted; presentation-only.

Every value on this screen already traces to `paymentsStream()` (`FirestoreClient.kt` l.293) and writes via `recordPayment` (l.294). Nothing here is faked; the open work is IA/nesting plus the invoice-link write at record time.
