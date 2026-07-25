# Task 5.1 micro-plan: invoice line items, editing, archive, un-invoiced visits (#18, #19)

> Expansion of `2026-07-24-react-port-restoration.md` Task 5.1, per that plan's
> requirement that every Phase 5 task be micro-stepped into its own TDD plan
> before any code is written.

**These are NEW BUILDS, not restorations.** The parent plan's Reality Correction
2 says the archive never had line items, an un-invoiced-visits picker, or invoice
archive, and this was re-verified here: grepping the 2026-05-27 mocks
(`ui-ideas/auntieos-invoice-detail-2026-05-27.html`,
`auntieos-invoices-2026-05-27.html`) for `line item`, `qty`, `unit price` and
`Description` returns ZERO hits. There is no prior design to port. The design
below is therefore new, and is constrained by existing Den conventions rather
than by a wasm original.

---

## 0. Findings that constrain the design (verified, with citations)

### 0.1 The money units are split, and the codebase's own docs disagree

- `mytribe/functions/src/admin/createInvoice.ts:27-28` stores `total` and
  `amountDue` as **floating-point DOLLARS** (`z.number().nonnegative()`).
  `invoicePdf.ts`, `getMyInvoices.ts`, `payInvoice.ts:58`, `onInvoicesWrite.ts`
  and the admin stat strip all read dollars.
- `auntieos-admin/src/api/expenses.ts:10-12` states the convention is **integer
  cents** (`amountCents`), "never a float dollar amount", formatted through
  `lib/dashboardInsights.ts#formatCents:298`, and claims it is "the same money
  convention the invoice backend uses". **That claim is false today.**
- `mytribe/functions/src/admin/expenses.ts:34` confirms integer cents on the
  expenses side.

**Ruling: integer cents is the arithmetic domain for everything new.** The legacy
dollar scalars survive as a SERVER-DERIVED PROJECTION of the cents figures, never
as an input. Written down in code so the next person does not edit one of the two.

### 0.2 A stored total can genuinely disagree with its lines

`mytribe/firestore.rules:219-226` is `allow update: if isAuntie()` on `invoices`,
and `postInvoiceEvent` merges an arbitrary payload onto the doc. Both bypass any
callable. So "stored total drifts from the sum of its lines" is a reachable state,
not a hypothetical, and the visible-disagreement requirement needs a real UI
surface.

### 0.3 `markInvoicePaid` zeroes `amountDue` even on a partial payment

`markInvoicePaid.ts:128` sets `amountDue: 0` unconditionally; the true figure
lives only in the `payments` subcollection. Any recompute of `amountDue` must sum
that subcollection rather than trusting the scalar.

### 0.4 The PDF has a stale comment that this task invalidates

`mytribe/functions/src/lib/invoicePdf.ts:15-17`: renders "no fabricated line
items - the flat `invoices` doc has no itemized array". Once the array exists the
PDF must render it. In scope.

### 0.5 Deployed indexes already cover the queries

From `mytribe/firestore.indexes.json`: `kin_care_sessions (status ASC, startTime
DESC)`, `kin_care_sessions (kinfolkId ASC, startTime DESC)`, `invoices
(archivedAt ASC, date DESC)`. **No new index is required**; where a second
predicate is needed it is applied in memory over a bounded page, and said out loud.

### 0.6 `archivedAt` stays a client-side presence check

Decided, and to be stated IN CODE, not only here: every invoice that exists today
lacks the field entirely. Firestore `== null` matches only documents that HAVE the
field set to null, so a server predicate returns zero rows and does it silently.
This task starts WRITING the field, which does not retroactively give it to legacy
docs. Converting to a server predicate requires a backfill migration first, which
is not this task. `unarchiveInvoice` writes `archivedAt: null` rather than
deleting the field, so that a future backfill has one shape to converge on, and
because `isArchivedInvoice` (`src/api/invoices.ts:68-70`) already treats null as
"not archived".

---

## 1. The money model

### 1.1 Storage shape (new fields on `invoices/{id}`)

```
lineItems: Array<{
  description: string,     // 1..200
  qty: number,             // > 0, <= 999, at most 2 decimal places
  unitCents: number,       // integer, 0 .. 10_000_000
  discountCents?: number,  // integer, >= 0, per line
}>
invoiceDiscountCents: number   // integer, >= 0, whole-invoice discount
subtotalCents: number          // derived
totalCents: number             // derived
amountDueCents: number         // derived
total: number                  // DERIVED PROJECTION of totalCents / 100
amountDue: number              // DERIVED PROJECTION of amountDueCents / 100
```

`total` and `amountDue` keep their existing meaning and units so the portal, the
PDF, the Stripe path and `onInvoicesWrite` keep working untouched. They are
written ONLY by the same server code that computes the cents figures, from the
same source, in one place, so they cannot drift from each other.

### 1.2 The arithmetic rule

All SUMS are integer addition on cents, which is exact. The only multiplication is
`qty * unitCents`, which is rounded ONCE, half-up, at the line level, before any
summation:

```
lineAmountCents(li)  = Math.round(li.qty * li.unitCents) - (li.discountCents ?? 0)
subtotalCents        = sum of lineAmountCents        (exact integer addition)
totalCents           = subtotalCents - invoiceDiscountCents
paidCents            = sum of the payments subcollection, each Math.round(amount * 100)
amountDueCents       = totalCents - paidCents
```

`qty` is capped at 999 and `unitCents` at 10,000,000, so the product is at most
1e10, far inside the 2^53 exact-integer range: the multiply is exact and the round
is deterministic, not a floating-point hazard. No dollar value is ever added to
another dollar value.

Negative results are REFUSED at validation rather than clamped: a discount larger
than the subtotal is an operator error, and silently flooring it at zero would
hide it. `failed-precondition`, naming both numbers.

### 1.3 Where the math lives

One pure module, mirrored, because two clients and one server must agree:

- `mytribe/functions/src/lib/invoiceMath.ts` (authority)
- `auntieos-admin/src/lib/invoiceMath.ts` (preview only)

The server recomputes from the stored lines on every write and IGNORES any total
the client sends. The web copy exists solely so the operator sees a live total
while typing. A test in each tree asserts the same fixture table produces the same
figures, the `bookingNoteCutoff.ts` precedent for one rule with two call sites.

### 1.4 How a lines-vs-total disagreement surfaces

`computeInvoiceTotals` returns the DERIVED figures. `InvoiceDetail` compares them
against the STORED `totalCents`/`total` and, when they differ, renders a
`Banner tone="error"` naming BOTH numbers and where each came from. It does not
reconcile in either direction, does not auto-correct, and does not hide either
figure. Per 0.2 this is a reachable state, and per the `StatCard` incident
(`DenScreenKit.tsx:178-186`, a dash and not a zero) inventing agreement would be
the same class of lie.

An invoice with NO `lineItems` (every invoice that exists today) is not a
disagreement and shows no banner: there is nothing to disagree with. The detail
panel says so explicitly rather than rendering an empty items table that would
read as "nothing was billed".

---

## 2. The edit-gating rule

Stated once, enforced SERVER-SIDE in
`mytribe/functions/src/lib/invoiceEditPolicy.ts`, mirrored in the web only to
decide whether to show the Edit affordance.

| State | Metadata (number, date, dueDate, terms) | Money (lineItems, discounts) |
|---|---|---|
| `draft` | editable | editable |
| `quote` | editable | editable |
| `open` (incl. overdue) | editable | editable ONLY while the `payments` subcollection is empty |
| `zero` | editable | editable ONLY while the `payments` subcollection is empty |
| `paid` | refused | refused |
| `cancelled` | refused | refused |
| `credit` / `redeemed` | refused | refused |

Rationale: correcting a sent-but-unpaid invoice is ordinary invoicing practice, so
`open` is not frozen outright. The moment money has actually changed hands, the
figures are a record of a real transaction and are frozen. `credit`/`redeemed` are
money owed TO the household and are their own flow.

`zero` tracks `open` rather than being frozen, which is a correction made during
implementation: `zero` is what an invoice with no lines classifies as, so freezing
it would mean a blank invoice could never receive its FIRST line item. It is not a
settled state, it is an empty one.

`hasPayments` is read from the `payments` SUBCOLLECTION, never from the `amountDue`
scalar, because of 0.3: that scalar is zeroed even by a partial payment, so it
cannot answer the question this rule turns on.

Enforcement detail: the state is decided by a server-side enumerator that mirrors
`auntieos-admin/src/lib/invoiceFormat.ts#invoiceState`, POSITIVELY enumerating
every state with no `default` branch, so the AO-12 "not proven otherwise, so call
it paid" defect is not reintroduced on the server. Rejections are
`failed-precondition` with `details { code: 'invoice_not_editable' }` so clients
branch on the code, not the message (the `booking_note_cutoff` precedent).

---

## 3. Callables (all `wrapAdminCallable`, zod-validated)

Each gets a `CALLABLE_CONTRACT.md` entry, a shape assertion in
`test/callableContract.test.ts`, and tests covering happy, invalid-arg,
unauthenticated and non-admin. `wrapAdminCallable` throws `unauthenticated`
("Sign in required.") then `permission-denied` ("Admin claim required."), per
`src/lib/wrapAdminCallable.ts:23-28`.

1. **`updateInvoice`**: patch of metadata and/or `lineItems` +
   `invoiceDiscountCents`. Server recomputes all five money fields and ignores any
   client-sent total. Gated by section 2. Audit `BILLING_INVOICE_UPDATED` (new key).
2. **`archiveInvoice`**: stamps `archivedAt` (serverTimestamp) + `archivedBy`.
   `failed-precondition` when the invoice is not draft/quote and still has
   `amountDue > 0`, unless `force: true`, which is audited distinctly.
3. **`unarchiveInvoice`**: writes `archivedAt: null` (see 0.6) + clears `archivedBy`.
4. **`listUninvoicedSessions`**: `{ kinfolkId?, from, to }` over `kin_care_sessions`,
   returning COMPLETED sessions with no `invoiceId`, each carrying `serviceType`,
   duration, and a rate-card prefill from `business_settings.serviceRates`.
   Uses the deployed indexes (0.5); the second predicate is filtered in memory over
   a bounded page and the response says how many rows it scanned so the caller can
   tell a real empty from a truncated one.

`createInvoice` gains optional `lineItems` additively; the contract-test freeze
moves to the new superset, keeping every legacy payload valid.

**Rate-card caveat:** `business_settings.serviceRates` is a `Map<String, String>`
(per android `LocationModels.kt:154`), so the prefill is a string parse. A rate
that does not parse yields NO prefill and says so on the row, rather than a
fabricated 0. Never invent a number for a failed read.

---

## 4. Micro-steps (TDD: test first at every step)

### Phase A: the money module (no I/O, pure)
- [x] A1. `functions/test/invoiceMath.test.ts`: fixture table (empty lines,
      one line, fractional qty, per-line discount, invoice discount, discount >
      subtotal, non-finite input, rounding boundary at .005). RED observed.
      NOTE: tests live in `functions/test/`, not beside the source; the vitest
      config's `include` is `test/**/*.test.ts`.
- [x] A2. `functions/src/lib/invoiceMath.ts` to green. 22 tests.
- [x] A3. Mirrored into `auntieos-admin/src/lib/invoiceMath{.ts,.test.ts}`,
      same 22-case fixture table in both trees. 22 tests.

### Phase B: the edit policy (pure)
- [x] B1. `functions/test/invoiceEditPolicy.test.ts`: the full state matrix of
      section 2, including totality. RED observed.
- [x] B2. `invoiceEditPolicy.ts` + the server-side positive-enumeration state
      classifier to green. 17 tests.
- [ ] B3. Web mirror + a test asserting web and server agree on every state.
      NOT DONE. The server enforces the rule, so nothing is unguarded; what is
      missing is the client-side courtesy that decides whether to render the
      Edit affordance. Needed before D3.

### Phase C: callables
- [x] C1. `updateInvoice` + 25 tests (happy, recompute, dollar projection,
      un-itemized no-op guard, gating, money validation, invalid-arg,
      not-found, unauthenticated, non-admin through the wrapper).
- [x] C2/C3. `archiveInvoice` + `unarchiveInvoice` + 14 tests, sharing
      `src/lib/invoiceArchive.ts` so the two cannot disagree on "archived".
- [ ] C4. `listUninvoicedSessions`. NOT DONE. Blocks the picker (D4).
- [ ] C5. `createInvoice` additive `lineItems`; update the contract freeze.
      NOT DONE.
- [x] C6. `index.ts` exports; `CALLABLE_CONTRACT.md` entries for the three new
      callables (plus the repairs in section 7); `callableContract.test.ts`
      freezes: archive/unarchive flat, `updateInvoice` by RECURSIVE signature
      because its `patch` is nested and carries a `.refine`.
- [ ] C7. `invoicePdf.ts`: render real line items when present, keep the scalar
      summary when absent, and retire the stale comment at :15-17. NOT DONE.
      Nothing writes `lineItems` from a UI yet, so the stale comment is still
      literally true today; it stops being true the moment D2/D3 ship.

### Phase D: web
- [ ] D1. `src/api/invoicesWrite.ts` wrappers + zod mirrors + tests.
- [ ] D2. Line-item editor component (add/edit/remove/reorder, live derived total,
      totals never hand-entered) + tests.
- [ ] D3. `InvoiceDetail.tsx`: edit mode, archive/restore with confirm, the
      lines-vs-total disagreement banner (1.4), linked visit list from `sessionIds`.
- [ ] D4. `InvoiceCreate.tsx`: Blank vs From-KinCare entry paths, the picker,
      selection to prefilled lines, real `<input type="date">`.
- [ ] D5. `Invoices.tsx`: archive facet now that the field is really written;
      KEEP the presence check and update its comment to say why it stays (0.6).

### Phase E: android
Scoped per section 5. Split proposed, not assumed.

---

## 5. Android parity assessment

Surveyed against the real sources (all under
`auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/`).

**What Android already has, and has well:** a shared, total, `else`-free action
matrix `domain/InvoiceActions.kt:124-141` over a 7-member state enum (the same
AO-12-correct design as web); annotation-driven Firestore POJO decode
(`Models.kt:350-372`), so new fields cost a nested `@Keep` class and no decode
plumbing; a repeating-editable-row precedent in
`ui/admin/CoveragePackageScreen.kt:542-556`; a multi-select session picker in
`InvoiceDetailScreen.kt:739-784` with 12 tests; and a pure-math-module-plus-tests
precedent in `domain/CoveragePackage.kt`.

**Honest sizing:**

| Slice | Size | Why |
|---|---|---|
| (a) Read-only line items on detail | **Small** | Two read-only repeating-row renderers already exist to copy (`PaymentRow`, `LinkedSessionRow`); ~60 lines plus one `@Keep` class |
| (c) Archive / restore | **Small to Medium** | `archiveNotification` + `decodeArchivedCount` is a near-exact template; cost is the confirm dialog and, more so, making the list filter and the stat strip exclude archived rows so the totals do not lie |
| (d) Un-invoiced-visits picker | **Medium** | Picker precedent exists but outputs a `Set<String>`; this must output prefilled LINE ITEMS, so it depends on (b), plus a new date-range control Android's invoice surfaces do not have |
| (b) Full editable line-item editor | **Large** | Nothing in the Android invoice stack is currently editable-and-persisted; needs staged-draft list, per-row validation, dirty tracking, discard confirm, a cents/Double boundary (`Invoice.total` is `Double`, `Invoice.discount` is a `String`), changes to the shared action matrix and its totality test, and the same treatment in `NewInvoiceDialog.kt` against its 11 existing tests |

**PROPOSED SPLIT, for the coordinator to rule on rather than for me to assume:**
ship Android (a) + (c) with this task, since both are genuinely small and both are
read/act surfaces the operator needs the moment web starts writing these fields.
Defer (b) + (d) to a named follow-up task `5.1a Android line-item editor`, because
(b) is a Large build that also re-opens the shared action matrix, and (d) is
meaningless until (b) exists.

Doing (a) + (c) now avoids the specific harm of shipping web-only: an invoice
archived on web would otherwise still appear, unmarked, in the Android list and be
counted into the Android revenue tiles (`Stage2Step2Helpers.kt:117-130`). That is
a correctness bug, not a parity nicety, which is why (c) is not deferrable even
though (b) is.

**This is a proposal. It is not a unilateral out-of-scope declaration.**

---

## 7. CALLABLE_CONTRACT.md repairs done alongside (coordinator request)

Three structural defects in `mytribe/functions/CALLABLE_CONTRACT.md`, repaired
while this task held the file:

1. **Orphaned entries restored.** The `###` headings for `addBookingNote`,
   `addInternalBookingNote` and `saveDashboardLayout` had been lost in an edit,
   so their req/res bullets sat under `### mapboxRetrieve`. Restored, plus the
   two `##` section headings they belong under (`Booking notes`,
   `Operator preferences`) and a lead for the shared 3 hour cutoff block, whose
   opening "BOTH callables enforce it" had lost its antecedent.
2. **Broken references fixed, with a correction to the report.** The defect was
   described as two references to `docs/CALLABLE_CONTRACT.md`. There is only ONE
   such reference (`test/callableContract.test.ts:59`, not :73), now pointing at
   `functions/CALLABLE_CONTRACT.md`. The OTHER broken path is a different file
   entirely, `docs/2026-07-18-AO5-AO8-shared-contract-design.md`, referenced
   twice (`callableContract.test.ts:51` and `CALLABLE_CONTRACT.md:41`); it really
   lives at `auntieos-admin/docs/...`. All three fixed.
3. **Frozen-but-undocumented entries.** `createInvoice`, `createQuote` and
   `markInvoicePaid` now have full entries under a new `## Invoices` section.
   `saveDashboardLayout` is covered by repair 1 (its prose existed, only the
   heading was missing).
   **STILL UNDOCUMENTED, deliberately left:** `assignTemplate`, `saveFormSchema`,
   `saveTemplate`, `broadcastMessage`. Not cheap: the last three are the nested /
   effects shapes (a 3-level `schema.sections[].fields[]`, a
   `sectionDefinitions[]`, and a `.superRefine` wrapping a nested `criteria`), so
   documenting them accurately means reading four handlers and their nested zod
   trees, which is a separate piece of work from this invoice task.

## 6. Checks

Baseline re-taken on `main` (the first baseline was void, taken against
`feat/calendar-sync-panel`):

- web: `tsc` clean, 190 files / 3113 tests, `vite build` clean
- functions: `build` clean, `lint` 0 errors (734 pre-existing warnings),
  183 files / 1720 tests

Per-slice: `npx tsc --noEmit && npx vitest run && npx vite build` from
`auntieos-admin/`; `npm run build && npm run lint && npm test` from
`mytribe/functions/`; `./gradlew :app:compileDebugKotlin :app:testDebugUnitTest`
from `auntieos-admin/android/` if android is touched.
