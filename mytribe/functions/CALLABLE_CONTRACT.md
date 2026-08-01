# Cross-app callable contract (AO-8)

MyTribe callables are the contract. Three clients hand-mirror them: the AuntieOS
admin (React `auntieos-admin/src/api/*.ts`), the Compose app (`web/composeApp`
`FirestoreClient.kt`), and android (`AuntieRepository.kt`). This file is the
single human source those mirrors are built from.

`functions/test/callableContract.test.ts` freezes the REQUEST field set of the
widget callables below and fails on drift. When you change a shape on purpose:
edit that test's frozen set, edit this file, and edit all three client mirrors in
the same change.

**Responses on the INVOICE MONEY SURFACE are machine-checked as of 2026-07-28
(ADR-0001 step W3-1).** Every callable that reads or writes an invoice, a
payment or a quote exports a `Result` zod schema beside its `Args`, parses its
outbound value through it (`src/lib/callableResponse.ts`), and has that shape
frozen by the same recursive walker the deep request shapes use. That set is
20 on the invoice side (19 at W3-1, plus `getInvoiceLedger` added in A1). **The
BOOKING family joined it on 2026-08-01 (ADR-0003's follow-up, once the
precondition ADR-0003 named was met):** `getMyBookings`, `requestBooking`,
`requestBookingCancellation`, `addBookingNote`, `addInternalBookingNote`,
`createMultiDateBookingRequest`, `rescheduleBooking`, `manageBookingSeries`,
`batchUpdateBookings` each export a `Result` (and, all but `getMyBookings`,
an `Args`), validate outbound the same way, and are generated into the
Contracts module through `scripts/contracts/registry.ts`'s
`BOOKING_CONTRACT_REGISTRY`, exactly as the 20 invoice callables are through
`INVOICE_CONTRACT_REGISTRY`. For those 29, this doc is documentation and the
schema is the authority. Every OTHER callable's response is still doc-only
and this file remains its review anchor; closing that gap is a later PR.

A response that fails its own schema is LOGGED AT ERROR AND RETURNED UNCHANGED,
never refused. The response is built after the write commits, these writes are
non-idempotent and carry no client request id, and every client renders a
failure as a retry affordance, so throwing would turn a description bug into a
double collection. The failure surfaces as `callable.response.contractViolation`
at `severity: 'error'` plus a Sentry exception naming the field PATHS (never the
values: these responses carry household names and addresses). The schemas are
`.strict()`, so an ADDED field is reported rather than absorbed.

Frozen request shapes:

- Widget callables (AO-35/39/40/41): `optimizeRoute`, `logExpense`, `listExpenses`,
  `adjustSupply`, `upsertSupply`, `upsertExpiration`. (`listSupplies` /
  `listExpirations` take no args.)
- Money + state mutations (added 2026-07-21): `createInvoice`, `createQuote`,
  `markInvoicePaid`, `assignTemplate`. Flat shapes, so a top-level key freeze is
  accurate.
- Billing data repair (added 2026-07-25): `repairInvoicePayments`. Frozen because
  its `mode` field is what separates a read-only report from a billing mass
  write.
- Operator preferences (added 2026-07-25): `saveDashboardLayout`. One field, but
  the VALUE is the contract (a "key:size" token), so the guard freezes the token
  regex alongside the key set.
- Invoice write funnel W2-1 (added 2026-07-28, ADR-0002): `linkInvoiceSessions`,
  `recordPayment`. Frozen from birth: android's W2-2 mirror is built FROM these
  shapes rather than reverse-engineered later. Both are flat (`sessionIds` is an
  array of plain strings, like `createQuote`'s).
- Booking status transitions (added 2026-08-01, A3): `transitionBookingStatus`.
  Frozen from birth for the same reason the W2-1 pair was: it replaces a direct
  client write on two clients at once, so two hand-built mirrors are aimed at
  the shape the day it lands. The VALUES are frozen alongside the keys (the
  action set, each action's target status, each action's allowed-from set, and
  both refusal detail codes), because both clients send and branch on them and
  `shapeKeys` cannot see inside an enum.

The booking family (`getMyBookings`, `requestBooking`,
`requestBookingCancellation`, `addBookingNote`, `addInternalBookingNote`,
`createMultiDateBookingRequest`, `rescheduleBooking`, `manageBookingSeries`,
`batchUpdateBookings`) is NOT in the `shapeKeys`/`shapeSignature` list above;
it does not need to be. `contracts:check` regenerates the whole Contracts
module from these 9 `Args`/`Result` pairs and fails on any byte of diff, which
catches every rename or added/removed field `shapeKeys` would and also catches
the RESPONSE side, which `shapeKeys` never could. `requestBooking`'s `Args` is
a deliberate superset of the two shapes its handler actually parses
(`MultiArgs`/`LegacyArgs`, still separate and unexported); see the comment
beside `export const Args` in `src/portal/requestBooking.ts` for why that is
safe and what it costs.

Coverage reality, so nobody over-trusts this: the admin invokes ~50 MyTribe
callables; the above 13 are frozen by `shapeKeys`/`shapeSignature`, and the 28
invoice + booking callables are frozen more strongly by `contracts:check`
(overlapping zero: no callable is on both lists). The measured surface, not
the stale "~26":

- Nested / effects shapes (added 2026-07-21), frozen by RECURSIVE signature:
  `saveFormSchema` (3-level `schema.sections[].fields[]`), `saveTemplate`
  (`sectionDefinitions[]`), `broadcastMessage` (a `.superRefine` ZodEffects wrapping
  a nested `criteria`). The `shapeSignature` walker unwraps optional/nullable/
  default/effects and descends arrays, so a rename at ANY depth (e.g.
  `schema.sections[].fields[].required`) fails the guard.
- The remaining ~34 are lower-complexity (2 to 3 flat fields); freeze as they churn.

Two freeze levels now exist: `shapeKeys` (top-level, for flat shapes) and
`shapeSignature` (recursive dotted key-paths, for nested/effects shapes). Both
catch an added / removed / renamed field; neither checks a value-TYPE change
(string vs number on the same key). See
`auntieos-admin/docs/2026-07-18-AO5-AO8-shared-contract-design.md` for the
shared-package vs. guarded-mirror options.

## Widget callables (admin-gated)

### optimizeRoute (AO-35)
- req `{ date: string /* YYYY-MM-DD */ }`
- res `{ stops: Array<{ order: number, sessionId: string, kinfolkId: string, household: string, address: string, arrivalEta: string /* HH:MM */ }>, totalMiles: number, totalMinutes: number, unroutable: Array<{ sessionId: string, household: string, reason: string }> }`

### logExpense (AO-40)
- req `{ kind: 'gas'|'parking'|'supplies'|'other', amountCents: number, note?: string, occurredAt?: string /* ISO */ }`
- res `{ id: string }`

### listExpenses (AO-40)
- req `{ sinceIso?: string }` (default: last 30 days)
- res `{ expenses: Array<{ _id: string, kind: string, amountCents: number, note: string, occurredAt: string }>, weekTotalCents: number, monthTotalCents: number }`

### listSupplies (AO-41)
- req `{}`
- res `{ supplies: Array<{ _id: string, name: string, onHand: number, par: number, unit: string }>, lowCount: number }`

### adjustSupply (AO-41)
- req `{ supplyId: string, delta: number }`
- res `{ onHand: number }` (clamped at 0)

### upsertSupply (AO-41)
- req `{ supplyId?: string, name: string, onHand: number, par: number, unit: string }`
- res `{ id: string }`

### listExpirations (AO-39)
- req `{}`
- res `{ expirations: Array<{ _id: string, label: string, dateIso: string, kinfolkId: string, kind: string }> }` (server-sorted by dateIso asc)

### upsertExpiration (AO-39)
- req `{ expirationId?: string, label: string, dateIso: string, kind: 'gateCode'|'vetRecord'|'card'|'license'|'other', kinfolkId?: string }`
- res `{ id: string }`

## Tribal Intel document mining (admin-gated)

`training_documents` is `allow write: if false` in `firestore.rules`, so these
three are the ONLY write path. Mirrored by the React admin
(`auntieos-admin/src/lib/tribalIntelDraftSchema.ts` for the rules,
`src/api/tribalIntelWrite.ts` for the wire call) and by android
(`AuntieRepository.createTrainingDocument` and siblings).
Two `.refine`s ride on both create and update, and both mirrors enforce them
client-side so the operator sees the failure before the round trip:
1. `title` OR `content` OR at least one attachment must be non-blank.
2. `targetKinId` is required when `targetType` is `KIN`.
A save leaves the doc at `reconcileStatus: 'pending'`. The nightly reconcile pass
is what folds it into the household Dossier and the pet Kin411, so client copy
must say "next reconcile pass", never "instantly".

### createTrainingDocument
- req `{ title: string /* <=200 */, content: string /* <=20000 */, notes: string /* <=4000 */, communicationType: string /* <=120, clients send 'note' */, targetType: 'KINFOLK'|'KIN', targetKinfolkId: string /* 1..120 */, targetKinId?: string /* <=120, required when targetType is KIN */, attachments: Array<{ storageUrl: string /* url */, cloudinaryPublicId: string /* 1..300 */, fileType: string /* <=20 */, mimeType: string /* <=120 */, fileName: string /* <=300 */ }> /* <=25 */ }`
- res `{ ok: true, docId: string }`

### updateTrainingDocument
- req: identical to createTrainingDocument plus `docId: string /* 1..200 */`
- res `{ ok: true, docId: string }`
- Re-queues `reconcileStatus: 'pending'`. Does NOT re-stamp `uploadedAt`, so an
  edited row keeps its place in an `uploadedAt desc` list.

### deleteTrainingDocument
- req `{ docId: string /* 1..200 */ }`
- res `{ ok: true, docId: string }`
- Hard-deletes the source note only. Text a prior reconcile pass already folded
  into a Dossier or Kin411 is NOT unmerged; the handler's audit payload records
  that, and every client's delete confirm must state it before committing.

## Invoices (admin-gated; the W2-1 pair also admits a scoped test admin, see each section's GATE line)

All three write the FLAT top-level `invoices` collection, the same one the
kinfolk portal (`portal/getMyInvoices.ts`), the Stripe webhook and the
`onInvoicesWrite` trigger read.

**MONEY UNITS, read this before mirroring any of them.** `total` and `amountDue`
on an invoice doc are DOLLARS as floating-point numbers. That is the legacy shape
of this collection, and it is NOT the convention used elsewhere in this file:
`logExpense` takes integer `amountCents`. Do not assume one from the other.

`date`, `dueDate`, `status` and `discount` are FREE TEXT (`z.string()`), never
validated enums and never parsed dates. `status` in particular WAS whatever the
caller sent; since the state stamp (below, 2026-07-28) every callable write
canonicalizes it, and the one-shot backfill has since run against production
(18/18 docs stamped), so the stored value is reliable. The kinfolk portal
reads it verbatim (see the getMyInvoices note below); the admin and Android
retire legs ship as their own PRs, and any client classifier that remains
enumerates positively — never deciding "paid" by ruling out the other states
(the AO-12 defect).

### The persisted state stamp: `status` + `editScope` (ADR-0002)

Every money-touching invoice callable persists the Invoice State Classifier's
output onto the doc IN THE SAME WRITE that moves the money
(`src/lib/invoiceStateStamp.ts`, derived through `src/lib/invoiceEditPolicy.ts`
and the `payments` SUBCOLLECTION):

- `status` — one of exactly eight lowercase values, frozen in
  `test/callableContract.test.ts`:
  `quote | draft | cancelled | credit | redeemed | paid | zero | open`.
  This CANONICALIZES the field: a composer's `'QUOTE'`/`'sent'`/`''` stores as
  what every client classifier already resolved it to (`'quote'`/`'open'`/by
  the money). The point was always that clients could retire their read-side
  classifiers and render this field; the kinfolk portal did exactly that on
  2026-07-28 (W2-5, below), and the admin and Android W2-5 legs ship as their
  own PRs.
- `editScope` — `all | metadataOnly | none`, the edit affordance for the doc's
  state and payment standing (part-paid stays `all`; settled money freezes to
  `metadataOnly`; paid/cancelled/credit/redeemed freeze to `none`, except the
  corrupt paid-with-partial-evidence shape, which stays `all` so it remains
  repairable).

Who stamps: `createInvoice`, `createQuote`, `updateInvoice`, `markInvoicePaid`,
`postInvoiceEvent`, `reviewAndSendDraftInvoice`, `repairInvoicePayments`
(repair mode), `redeemCredit`, `stripeWebhook` (paid events). Who deliberately
does NOT: `archiveInvoice`/`unarchiveInvoice` (`archivedAt` is not a classifier
input), `sendInvoiceReminder`, `generateReceipt`, `payInvoice` (their writes
cannot change state; a writer that cannot change state does not stamp). Pure
readers (`getMyInvoices`, `getMyInvoicePdf`, `generateInvoicePdf`) never write
state at all.

Docs that predate the stamp got it from a one-shot runbook backfill
(`mytribe/scripts/backfillInvoiceStateStamp.ts`, DRY RUN by default), since
run against production (18/18 docs stamped, zero notification-guard refusals
— see PR #106). Every production doc now carries the stamp, so clients may
rely on it.

**getMyInvoices consumes the stamp (W2-5, 2026-07-28).** The portal reader's
response ships the doc's stored `status` VERBATIM — all eight states, no
longer its old 5-state `resolveStatus` money heuristic — plus the stored
`editScope` (or `null` when a doc carries none; the portal has no edit UI, the
field ships for stamp parity). The three response buckets are decided by a
TABLE over that stored string, not by re-classifying the money:
open/draft/quote/zero → `open`, paid → `paid`, credit/redeemed → `credits`,
cancelled → excluded entirely. A doc with no readable stamp fail-softs to
`open` (string-only — money is NEVER consulted) and is reported once per call
at warn (`portal.invoices.stampMissing`). Mirror:
`mytribe/web/src/api/invoicesApi.ts` (updated field-for-field with the
handler until ADR-0001 codegen replaces the hand-mirror).

### createInvoice
- req `{ familyId: string, kinfolkName?: string, invoiceNumber: string, client?: string, address?: string, date?: string, terms?: string, dueDate?: string, discount?: string, total: number, amountDue: number, status?: string, sessionIds?: string[], lineItems?: Array<{ description: string /* 1..200 */, qty: number /* >0, <=999 */, unitCents: number /* int 0..10_000_000 */, discountCents?: number /* int >=0 */ }> /* max 100 */, invoiceDiscountCents?: number /* int >=0 */ }`
- res `{ ok: true, invoiceId: string }`
- Every `?` field above is a zod `.default('')` / `.default([])` or genuinely
  optional, so an omitted key validates. The freeze in
  `test/callableContract.test.ts` is the full SUPERSET, not the required subset.
- The freeze MOVED from the flat `shapeKeys` table to the recursive
  `shapeSignature` table in Task 5.1: `lineItems` is an array of objects, and a
  top-level key freeze would have gone on passing while `lineItems[].unitCents`
  was renamed underneath it.
- The SERVER mints the doc id; the composer does not invent one. Stamps
  `kinfolkId` from `familyId` (this is why the portal can see the invoice at all),
  plus `_id`, `createdAt`, `updatedAt`.
- `lineItems` IS ADDITIVE. Omit it and the behaviour is unchanged: the caller's
  `total` / `amountDue` are stored verbatim and NO cents field is written at all.
  That absence is load-bearing rather than cosmetic. `updateInvoice` reads the
  PRESENCE of `lineItems` to decide whether recomputing the money is safe, so
  writing an empty array onto an un-itemized invoice would re-arm the bug that
  guard exists to prevent: a later due-date edit would recompute a real invoice
  down to $0.
- Supply `lineItems` and the SERVER owns the money. It writes `lineItems`,
  `invoiceDiscountCents`, `subtotalCents`, `totalCents`, `amountDueCents`, and
  the legacy dollar `total` / `amountDue` as a projection of that same
  computation (`lib/invoiceMath.ts`). `paidCents` is 0 by construction: an
  invoice cannot have a payment recorded against it before it exists.
- A `total` or `amountDue` that DISAGREES with the sum of the lines is REFUSED:
  `failed-precondition`, `details.code` of `invoice_total_mismatch` or
  `invoice_amount_due_mismatch`, naming both figures. It is not silently
  overwritten, because quietly substituting the server's number would hide a
  client bug while changing what a household is billed. Unlike `updateInvoice`,
  this callable cannot simply omit `total` from its request: the field is
  required by the legacy shape and every un-migrated caller sends it.
- Invalid money (a line discount larger than its line, an invoice discount
  larger than the subtotal) is `failed-precondition` with
  `details.code: 'invoice_money_invalid'`.
- `lineItems: []` is an ITEMIZED invoice worth zero, deliberately distinct from
  an ABSENT `lineItems`. It writes the cents fields, which is what lets a blank
  invoice later receive its first line through `updateInvoice`.
- Audit `BILLING_INVOICE_CREATED`, payload carrying `itemized` and `lineCount`.
  The `invoice.new` notification is best-effort: a dispatch failure is logged and
  swallowed, so a notification outage cannot fail an invoice that was already
  written.
- `createQuote` was deliberately NOT given line items in Task 5.1; it keeps the
  flat freeze and the legacy shape.

### createQuote
- req: identical to `createInvoice`, plus `sendToKinfolk?: boolean` (default false)
- res `{ ok: true, invoiceId: string }`
- A quote is NOT a separate model, it is an invoice in QUOTE status. The caller's
  `status` is IGNORED: the server always stamps `status: 'quote'` (lowercase
  since the state stamp; the admin chip still renders 'QUOTE' because it derives
  from the classifier, which lowercases), so no client can mint a quote that
  fails to read as one.
- `sendToKinfolk: true` dispatches the issued-quote notification immediately.

### markInvoicePaid
- req `{ invoiceId: string /* 1..200 */, amount?: number /* DOLLARS, MAY BE PARTIAL; defaults to what the recorded payments leave outstanding */, method?: string /* 1..200 */, reference?: string /* 1..200 */, paidAt?: string /* ISO-8601, defaults to now */ }`
- res `{ ok: true, invoiceId: string, paymentId: string, state: 'unpaid'|'partial'|'settled'|'overpaid', totalCents: number, paidCents: number, amountDueCents: number, overpaidCents: number }`
- Writes an `invoices/{invoiceId}/payments/{paymentId}` entry (amount,
  amountCents, method, reference, paidAt, recordedBy) in the SAME batch as the
  invoice's money fields, so "marked paid, with no record of who recorded it" is
  unrepresentable.
- **THE STATE IS DERIVED FROM THE SUM OF EVERY RECORDED PAYMENT**, not from the
  `amount` in this request. A partial leaves the invoice `status: 'open'` with a
  real `amountDue`, so it stays in Outstanding and the balance can still be
  collected; only a settling payment writes `paid`. Fixed 2026-07-25: the flip
  used to set `status: 'paid', amountDue: 0` unconditionally, so $20 against a
  $40 invoice read as settled, dropped out of Outstanding, and the second call
  was then REFUSED as already-paid, leaving the balance uncollectable.
- Writes integer cents alongside the legacy float dollars: `totalCents`,
  `paidCents`, `amountDueCents`, `overpaidCents`. The dollar `amountDue` is a
  projection of `amountDueCents` written in the same pass, never an input.
- OVERPAYMENT: settles the invoice, `amountDueCents` CLAMPS AT 0 (never
  negative, which is this codebase's credit signal and would silently turn an
  over-collected invoice into a credit owed back to the household), and the
  excess is reported as `overpaidCents` for the operator to act on. It is never
  converted into a credit automatically.
- A PARTIAL stamps `lastPaymentAt`/`lastPaymentBy`; only a settling payment
  stamps `paidAt`/`paidBy`.
- Error surface, all fail-loud, with `details.code` for clients to branch on:
  `not-found` for an unknown id; `failed-precondition` `invoice_already_settled`
  when the recorded payments already cover the total; `failed-precondition`
  `invoice_already_paid` when the invoice is marked paid and carries NO recorded
  payments to reconcile against (the Stripe path records into the ROOT `payments`
  collection, so believing the label is what stops a double-collection there);
  `failed-precondition` `invoice_not_payable` for a cancelled invoice or a
  credit; `failed-precondition` when the invoice is still a draft or quote.
  An invoice LABELLED paid whose recorded payments fall short is deliberately NOT
  refused: that is the 2026-07-25 corruption, and it is the invoice whose balance
  is owed.
- The `invoice.payment.applied` notification is deliberately NOT enqueued here.
  `onInvoicesWrite` fires it off the resulting Firestore write, so this callable,
  the Stripe webhook and a direct admin write each notify exactly once. It does
  NOT fire for a partial, because the invoice is not paid.
- req `{ mode?: 'detect'|'repair' /* default 'detect' */, limit?: number /* int 1..500, default 200 */, startAfterId?: string /* 1..200 */ }`
- res `{ ok: true, mode, scanned: number, findings: Array<{ invoiceId, invoiceNumber, kinfolkId, totalCents, paidCents, claimedAmountDueCents, correctAmountDueCents, understatedCents, status }>, repaired: number, skipped: Record<reason, number>, nextCursor: string|null }`
- Finds, and optionally repairs, invoices wrecked by the pre-2026-07-25
  partial-payment write: a doc claiming less is owed than its own `payments`
  subcollection says. `detect` READS AND REPORTS ONLY and is the default;
  `repair` must be named explicitly.
- IDEMPOTENT, and it NEVER LOWERS A BALANCE: only an understated balance is
  raised, so re-running is safe and the worst case is that it declines to fix
  something. An overstated balance is reported (`would_lower_balance`), never
  silently reduced.
- Detection is BY ARITHMETIC, not by status, because status casing is unenforced
  and Firestore equality skips documents missing the field. Pages by document id
  for the same completeness reason; loop until `nextCursor` is null.

### updateInvoice
- req `{ invoiceId: string /* 1..200 */, patch: { invoiceNumber?: string /* 1..60 */, date?: string /* YYYY-MM-DD */, dueDate?: string /* YYYY-MM-DD */, terms?: string /* <=2000 */, kinfolkName?: string /* <=200 */, client?: string /* <=200 */, address?: string /* <=500 */, discount?: string /* legacy FREE TEXT, <=200 */, lineItems?: Array<{ description: string /* 1..200 */, qty: number /* >0, <=999 */, unitCents: number /* int, 0..10_000_000 */, discountCents?: number /* int, >=0 */ }> /* <=100 */, invoiceDiscountCents?: number /* int, >=0 */ } }`
- res `{ ok: true, invoiceId: string, totals: { subtotalCents: number, totalCents: number, paidCents: number, amountDueCents: number /* SIGNED, and NOT what was persisted; read the next bullet */ } }`
- **`totals` IS NOT THE INVOICE'S STORED MONEY**, and until W3-1 (2026-07-28)
  nothing said so: not this doc, not the React admin's `InvoiceTotalsResult`
  mirror. It is the raw signed `computeInvoiceTotals` arithmetic; the DOC is
  written from `settleInvoice`, which clamps the balance at 0 and moves the
  excess into an `overpaidCents` field this response does not carry. Two live
  consequences:
  1. An edit dropping an itemized invoice BELOW what was already collected
     answers with a NEGATIVE `totals.amountDueCents` while the doc stores
     `amountDueCents: 0` + `overpaidCents`. A negative balance is this
     codebase's credit signal everywhere else, so do not feed this figure to a
     classifier.
  2. On an UN-ITEMIZED invoice patched without lines (the money is
     deliberately not recomputed, and every invoice predating the line-item
     editor is un-itemized), `totals` is the ZERO-LINE computation:
     `subtotalCents: 0`, `totalCents: 0`, `paidCents` as recorded, and
     `amountDueCents: -paidCents`. The invoice is untouched and still worth
     what it was worth; `totals` simply does not describe it.
  The W3-1 response schema DESCRIBES this rather than correcting it, because
  three clients are deployed against it. Clamping the wire, or adding
  `overpaidCents` to it, is a shape change and belongs to its own PR.
- **There is no `total` or `amountDue` in the request, and `patch` is `.strict()`.**
  The server recomputes every money field from the stored line items and the
  recorded payments and IGNORES anything else. A client that tries to assert what
  an invoice is worth gets `invalid-argument`, not a silently dropped field.
- An EMPTY patch is `invalid-argument`, not a no-op: it would stamp `updatedAt`
  and write an audit entry describing a change that never happened.
- Money is stored in INTEGER CENTS (`unitCents`, `subtotalCents`, `totalCents`,
  `amountDueCents`). The legacy dollar scalars `total` / `amountDue` are rewritten
  in the same pass as a PROJECTION of those cents figures. Never send them, never
  edit one of the two by hand. See `src/lib/invoiceMath.ts`.
- An invoice with NO line items, patched without any, does NOT get its money
  recomputed. "Sum of zero lines" is not the same statement as "worth nothing",
  and every invoice predating this callable is un-itemized.
- Edit gating, enforced HERE and not in any UI, because `firestore.rules` grants
  `allow update: if isAuntie()` on this whole collection. Rule in
  `src/lib/invoiceEditPolicy.ts` (the 2026-07-25 three-standing rule; this
  section previously described the older any-payment-freezes version):
  - `draft` / `quote`: fully editable.
  - `open` / `zero`: fully editable until the `payments` subcollection SETTLES
    the invoice. A PART-PAID invoice stays fully editable — freezing on the
    first payment of any size is what once left a part-collected balance
    unrepairable. Once settled, the money freezes and only metadata may change.
  - `paid`: no edits — EXCEPT a doc labelled paid whose recorded payments fall
    short of its total (the pre-fix corruption), which stays fully editable so
    it can be repaired.
  - `cancelled` / `credit` / `redeemed`: no edits at all.
- Error surface, all `failed-precondition`, clients branch on `details.code`:
  `invoice_not_editable` (a settled or withdrawn invoice),
  `invoice_money_locked` (a payment exists, so lines and discounts are frozen),
  `invoice_money_invalid` (a discount larger than what it discounts; the message
  names both figures). Plus `not-found` for an unknown id.
- W2-1 (ADR-0002) added the four descriptive fields android's whole-model
  merge-set writes that the patch could not previously express: `kinfolkName`,
  `client`, `address`, `discount`. `discount` here is the LEGACY FREE-TEXT
  display field ("10%"); it never enters the arithmetic (`invoiceDiscountCents`
  is the computed one), so it does not count as touching money and stays
  editable on a settled invoice. Still deliberately absent from the patch:
  `status` (the classifier owns it, ADR-0002), `sessionIds`/`_attribution`
  (`linkInvoiceSessions` owns the link), `archivedAt`/`archivedBy`
  (`archiveInvoice`/`unarchiveInvoice`), and `kinfolkId` (re-homing an invoice
  to another household is not an edit).

### linkInvoiceSessions
- req `{ invoiceId: string /* 1..200 */, sessionIds: string[] /* each 1..200, max 200; duplicates collapsed */ }`
- res `{ ok: true, invoiceId: string, sessionIds: string[], added: string[], removed: string[], status: string /* classifier state */, editScope: 'all'|'metadataOnly'|'none' }`
- W2-1 (ADR-0002): replaces android's two direct writes,
  `AuntieRepository.updateInvoiceSessionIds` (invoice side) and the per-session
  `updateSessionInvoiceId` loop. ONE TRANSACTION owns both directions: the
  invoice's `sessionIds` and every touched session's `invoiceId` change
  together or not at all. Android's loop logged and continued on a per-session
  failure, which could leave the invoice claiming a session that still pointed
  elsewhere.
- `sessionIds` is the invoice's FULL new set, not a delta. The delta is derived
  server-side inside the transaction against the stored set. Link and unlink
  are one operation; `[]` unlinks everything.
- Attribution stamps are android's, byte for byte: the invoice gets
  `_attribution: 'manual'` (on an unlink too: the operator curated the set
  either way); an added session gets `'manual'`; a removed session gets
  `'manual_unlink'` with `invoiceId: ''`, an EMPTY STRING, never a field delete,
  because `listUninvoicedSessions` treats absent/empty/whitespace as one
  unclaimed state. `_attributionAt` is an ISO-8601 STRING (android's `Invoice`
  model decodes it as a non-null Kotlin String; a Timestamp there is the
  Class B decode crash). `updatedAt` is a server Timestamp, both models
  tolerate it.
- Persists the classifier's `status` + `editScope` onto the invoice on every
  write (ADR-0002 decision 2). Linking changes none of the classifier's
  inputs, so this normalizes (a stored `'QUOTE'` re-stamps as `'quote'`; every
  reader lowercases before comparing). Linking is NOT gated on `editScope`:
  attributing sessions to a paid or cancelled invoice moves no money and
  android permits it today.
- GATE: staff (admin claim) pass unscoped; a TEST ADMIN (`testTribeId` claim,
  `lib/testMode.ts`) passes scoped: the invoice and every touched session
  must carry `kinfolkId == testTribeId`, else `permission-denied` with nothing
  written. There is deliberately NO invoice/session kinfolk-equality check on
  the staff path: legacy rows carry blank kinfolkIds and android performs no
  such check today.
- Errors: `not-found` for an unknown invoice; `failed-precondition` /
  `session_not_found` (with `details.missing`) when any named session does not
  exist. Atomic: nothing written.
- Audit `BILLING_INVOICE_SESSIONS_LINKED` with the full added/removed delta.

### recordPayment
- req `{ amount: number /* DOLLARS, float, the legacy shape of this collection */, kinfolkId?: string /* <=120, default '' */, kinfolkName?: string, client?: string, address?: string, date?: string /* free text */, paymentMethod?: string, referenceNumber?: string, email?: string, tip?: number /* default 0 */, notes?: string, invoiceId?: string /* '' = standalone payment */, invoiceNumber?: string }` (every `?` defaults to `''`/`0`)
- res `{ ok: true, paymentId: string, kinfolkId: string /* what was actually stored; the sandbox id for a test admin */ }`
- W2-1 (ADR-0002): replaces `AuntieRepository.createPayment`, the direct create
  on the ROOT `payments` collection. This is the DISPLAY LEDGER the payment
  screens read (`getPayments`, `getPaymentsForKinfolk`, the invoice detail's
  linked-payments join on `invoiceId`); the server's settlement arithmetic
  never reads it, so it cannot double-count against `markInvoicePaid`.
- **NOT `markInvoicePaid`, and does not call it.** That callable is the money
  authority: it writes the `invoices/{id}/payments` SUBCOLLECTION and
  re-derives the invoice's settlement, and it refuses drafts/quotes/credits/
  settled invoices. Android's record-payment flow calls the two as separate
  steps (money first, display row second, best-effort); this callable is the
  second step only. A payment row here can exist with NO invoice at all (the
  admin Payments tab's standalone flow).
- **THE REACT ADMIN CALLS IT TOO, as of A1.** Its invoice detail panel called
  only `markInvoicePaid`, so a payment taken through the web admin settled the
  invoice and never reached the ledger the Payments screens read, while
  Android's identical action wrote both. It now runs the same two steps in the
  same order: `markInvoicePaid` first and fatal on failure (nothing was written,
  no payment happened), this callable second and best-effort (the money has
  already moved, so throwing would offer a retry that collects twice; the
  failure is reported to the operator instead).
- **`amount` HERE IS THIS PAYMENT, NOT THE INVOICE'S RUNNING TOTAL.**
  `markInvoicePaid`'s `paidCents` is cumulative, so echoing it into this
  request books a $40 ledger row for a $20 second payment. The admin sends the
  operator's typed amount, or the difference against the cumulative figure
  `getInvoiceLedger` already returned, and writes NO row at all when neither is
  available rather than guessing a figure onto a payment record.
- Field set mirrors android's `Payment` model verbatim; the server adds
  `recordedBy` + `createdAt` (serverTimestamp). No `id` field inside the doc
  (android's `@DocumentId` never serialized one).
- Writes NO invoice doc, so no classifier state is persisted here: `status`/
  `editScope` live on invoices, and the invoice side of a payment is
  `markInvoicePaid`'s write.
- GATE: staff unscoped; a test admin's row is STAMPED
  `kinfolkId = testTribeId` no matter what the request says. This is the server-side
  version of the `scopedKinfolkId` copy android does client-side today.
- Audit `BILLING_PAYMENT_RECORDED` (distinct from `BILLING_INVOICE_PAID`,
  which covers the settling subcollection write).

### archiveInvoice
- req `{ invoiceId: string /* 1..200 */, force?: boolean }`
- res `{ ok: true, invoiceId: string }`
- Stamps `archivedAt` (serverTimestamp) + `archivedBy`. Archiving is NOT deletion
  and NOT cancellation: every field survives, and the kinfolk portal is unaffected.
  It means the operator has stopped working the invoice, so it drops out of the
  admin's default list and out of the outstanding / billed totals.
- `failed-precondition` / `invoice_still_owing` when a SENT invoice still has a
  balance, because archiving it removes it from the total that would remind anyone
  to collect it. `draft` and `quote` are exempt (neither was ever claimed from
  anyone). `force: true` overrides and is audited at `warn` with `forced: true`,
  since it is a decision to write off real money.
- `failed-precondition` / `invoice_already_archived` rather than restamping.

### unarchiveInvoice
- req `{ invoiceId: string /* 1..200 */ }`
- res `{ ok: true, invoiceId: string }`
- Writes `archivedAt: null` rather than DELETING the field, so a restored invoice
  carries the same shape a future backfill would give every legacy invoice, and
  because the admin's `isArchivedInvoice` already reads null as "not archived".
- `failed-precondition` / `invoice_not_archived` when it was never archived: that
  write would look like a no-op but would change which Firestore predicates the
  document matches.
- **Why the admin still filters archived rows CLIENT-side.** Every invoice that
  predates this callable has no `archivedAt` at all, and Firestore's `== null`
  matches only documents that HAVE the field. A `where('archivedAt','==',null)`
  predicate would therefore return ZERO invoices, silently. The deployed
  `invoices (archivedAt ASC, date DESC)` index cannot be used for the exclusion
  until a backfill stamps the field onto legacy docs. See
  `src/lib/invoiceArchive.ts`.

### listUninvoicedSessions
- req `{ from: string /* YYYY-MM-DD, inclusive */, to: string /* YYYY-MM-DD, inclusive */ }`
- res `{ sessions: Array<{ sessionId: string, kinfolkId: string, serviceType: string, durationMinutes: number, startTime: string /* ISO */, unitCents: number | null }>, unpriceable: Array<{ sessionId: string, serviceType: string }>, unplaceable: Array<{ sessionId: string, kinfolkId: string }>, rateCardLoaded: boolean, scanned: number, truncated: boolean }`
- Read only. Completed visits in the window that no invoice has claimed, priced
  from `business_settings.serviceRates` where that is possible.
- `unitCents` is NULL, never 0, when the visit cannot be priced, and the session
  also appears in `unpriceable`. A silent zero would bill a household nothing for
  real work and look deliberate on the invoice. `rateCardLoaded` separates "this
  service is not on the card" from "there is no card", which are different
  operator problems.
- **The unclaimed test is done IN MEMORY and this is not an optimisation to
  undo.** `createKinCareSession` and `approveBookingSeriesCore` never write
  `invoiceId` at all, and Firestore equality SKIPS documents that lack the field,
  so `where('invoiceId','==','')` would silently miss most sessions. Unlinking
  writes `''` rather than deleting. Absent, empty and whitespace are one state.
- **`status` is also filtered in memory**, even though `kin_care_sessions
  (status ASC, startTime DESC)` is deployed. The field is a raw string with no
  validator and its casing is unenforced, so a server equality would invisibly
  drop every visit stored as `completed`, which on this callable means not
  billing for work that was done.
- The window is a LEXICAL range on `startTime`, which is an ISO-8601 STRING on
  this collection, not a Timestamp. Firestore orders every timestamp after every
  string, so a `Timestamp` bound here returns nothing and does not error.
- **`unplaceable` is the escape hatch that lexical window leaves open.** An empty
  `startTime` sorts before every real date, so a billable visit stored with one
  is unreachable by ANY window the operator picks, here and in `optimizeRoute`
  and the calendar push alike. A second equality read (`startTime == ''`, served
  by the automatic single-field index) finds exactly those and reports them, with
  the same completed + unclaimed filters so only money-on-the-table is raised.
  Widening the dates cannot surface them, which is why the admin banner tells the
  operator to repair the visit rather than to search again. A session MISSING the
  field entirely remains unreachable, since Firestore cannot query for absence;
  no writer produces that shape (`createKinCareSession` requires `min(1)`,
  `approveBookingSeriesCore` refuses an unreadable `startTime` outright) and prod
  carries none, verified 2026-07-30 across all 100 sessions.
- Capped at 500 rows. `scanned` and `truncated` report the page honestly, so an
  empty result is distinguishable from a truncated one.

### getInvoiceLedger
- req `{ invoiceId: string /* 1..200 */ }` (`.strict()`)
- res `{ invoiceId: string, payments: Array<{ paymentId: string, amountCents: number, method: string|null, reference: string|null, paidAt: string|null /* ISO */, recordedBy: string|null }>, paidCents: number, totalCents: number, amountDueCents: number, ledgerPayments: Array<{ paymentId: string, amountCents: number, tipCents: number, method: string, reference: string, date: string /* FREE TEXT */, notes: string, recordedBy: string|null }>, sessions: Array<{ sessionId: string, serviceType: string, status: string, startTime: string /* ISO */, completedAt: string|null, durationMinutes: number|null, linkedBack: boolean }>, missingSessionIds: string[], orphanSessionIds: string[], truncated: boolean }`
- Read only. Writes nothing, stamps no classifier state, repairs nothing. No `ok`
  field, same as `listUninvoicedSessions`: a pure read answers with data or
  throws, and has no partial success to report.
- **THIS EXISTS BECAUSE NO CLIENT CAN READ THE SUBCOLLECTION.**
  `firestore.rules` carries no rule for `invoices/{invoiceId}/payments`, the
  parent `/invoices/{invoiceId}` match does not extend to a subcollection, and
  the file has no catch-all, so a direct read is denied to EVERY client
  including a signed-in Auntie. That subcollection is where `markInvoicePaid`
  records what was collected, so before A1 there was no path by which any
  invoice screen could show what had been paid. The React admin's detail panel
  showed neither the payments nor the linked visits.
- **THREE LISTS, AND THEY ARE NOT INTERCHANGEABLE.** Money on this surface lives
  in two collections with two jobs:
  - `payments` is the `invoices/{id}/payments` SUBCOLLECTION, THE AUTHORITY.
    `paidCents` is their sum, computed with `invoiceMath.ts#paidCentsFromPayments`
    (stored `amountCents` first, the legacy float `amount` rounded once when a
    pre-2026-07-25 row carries only dollars), and `amountDueCents` is
    `settleInvoice` over it, clamped at 0.
  - `ledgerPayments` is ROOT `payments` rows whose `invoiceId` names this
    invoice: the DISPLAY ledger written by `recordPayment`, `stripeWebhook.ts`
    and the historical `match_payments_to_invoices.py`. Counted in NOTHING here.
    Summing the two would double-count a payment recorded through the standard
    two-step flow, which writes one row in each.
  - Both ship because a Stripe card payment lands ONLY in the root ledger. A
    panel rendering the subcollection alone would report a settled invoice as
    having no payment at all; a panel rendering the ledger alone (what Android
    does today) presents a display record as the money.
- **THE SESSION LINK IS REPORTED IN BOTH DIRECTIONS, AND NEVER REPAIRED.**
  `sessions` resolves the invoice's own `sessionIds`; `linkedBack` is false when
  that session's `invoiceId` does not point here; `missingSessionIds` is an id
  the invoice claims with no session doc behind it; `orphanSessionIds` is a
  session naming this invoice that the invoice does not claim back.
  `linkInvoiceSessions` writes both directions in one transaction now, but
  Android's pre-ADR-0002 loop wrote them separately and logged-and-continued on
  a per-session failure, so a half-written link is a shape live data carries. A
  session with a broken backlink is still billable as uninvoiced work, so it can
  be billed twice. Which side is right decides which invoice a visit is charged
  on, so it is surfaced for the operator rather than silently resolved.
- `durationMinutes` is `.nullable()`, never defaulted to 0, for the same reason
  `listUninvoicedSessions.unitCents` is: a visit with no recorded length is not a
  zero-length visit, and on a billing panel that is the difference between "not
  recorded" and "billed for nothing".
- `method` / `reference` / `paidAt` / `recordedBy` on a subcollection row are
  `.nullable()` rather than optional, because `markInvoicePaid` writes an
  explicit `null` when the operator left the field blank.
- Capped at 200 sessions (the same cap `linkInvoiceSessions` puts on the set it
  writes, so a legally-linked visit is never hidden) and 100 ledger rows.
  `truncated` says when the session list is a page rather than the whole set.
- GATE: `resolveInvoiceWriteActor`, the ADR-0002 invoice-surface gate, despite
  the name naming the write funnel it was built for. Staff pass unscoped; a TEST
  ADMIN passes scoped and gets `permission-denied` on an invoice whose
  `kinfolkId` is not their `testTribeId`. `wrapAdminCallable` would lock the
  sandbox out of its own invoice detail.
- Errors: `not-found` for an unknown invoice; `invalid-argument` on a malformed
  request (the schema is `.strict()`, so an extra key is refused rather than
  dropped).
- Mirrors: `auntieos-admin/src/api/invoicesWrite.ts#getInvoiceLedger` and
  `src/components/InvoiceLedger.tsx`. Types come from the generated contracts
  module (ADR-0001), not from a hand transcription.

## Household members and invites (admin-gated; B1)

The write half of this surface predates the read half by months:
`mintInvite`, `inviteKinfolkToPortal` and `revokeInvite` all wrote
`inviteRequests`, `setMemberPermissions` and `removeMember` wrote
`families/{familyId}/members/{uid}`, and the nightly `expireStaleInvites`
swept the collection, but no callable could read `inviteRequests` back.
`listInvites` closes that, and the AuntieOS admin's Members-and-invites screen
(`auntieos-admin/src/screens/HouseholdMembers.tsx`, Android
`ui/members/HouseholdMembersScreen.kt`) is the first surface for any of it.

The AuntieOS `kinfolk/{kinfolkId}` doc id IS the MyTribe `families/{familyId}`
id, so `familyId` and `kinfolkId` are the same value on every call below.

### listInvites (B1, net-new 2026-08-01)
- req `{ familyId: string /* 1..200, the kinfolk/family doc id */, limit?: number /* int 1..200, default 100 */ }`
- res `{ invites: Array<{ inviteId: string, tribeId: string, invitedEmail: string,
  secondaryLabel: string | null, proposedRole: 'PRIMARY' | 'SECONDARY',
  proposedPermissions: { billing_full, messaging_direct, messaging_group, kin_edit,
  kintales_only, home_access: boolean }, requiresAuntieAck: boolean,
  status: 'PENDING' | 'EMAIL_SENT' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED',
  effectiveStatus: same union, redeemable: boolean,
  createdAt: string | null /* ISO-8601 */, sentToInviteeAt: string | null,
  expiresAt: string | null, revokedAt: string | null, acceptedUid: string | null }>,
  scanned: number }`
- GATE: `wrapAdminCallable` (admin claim, or the `AUNTIE_OPERATOR_UIDS`
  transition allowlist per RULING O-6). No kinfolk path: a household reads its
  own roster through `listMembers`, never the invite documents.
- Errors: `not-found` when `familyId` names no `kinfolk` doc (mirrors
  `resolveKinfolkAccess` hardening 1, so a typo says so instead of returning a
  plausible empty list); `invalid-argument` with `details.validationErrors` for a
  bad `familyId` / `limit`.
- **`effectiveStatus` is the field the UI renders, not `status`.**
  `expireStaleInvites` runs at 02:00 America/New_York, so a PENDING/EMAIL_SENT
  invite past its `expiresAt` still READS as live in Firestore for up to a day.
  `effectiveStatus` reconciles that at read time, and `redeemable` is the single
  boolean a client gates the Revoke button on. Terminal statuses
  (ACCEPTED/REVOKED/EXPIRED) are never re-derived, matching `acceptInvite`'s own
  precedence.
- Equality-only query (`tribeId ==`) capped by `limit`, then sorted newest-first
  in memory. There is no `tribeId`+`createdAt` composite index and this ships
  without adding one; `scanned` reports the pre-sort row count so an empty list is
  distinguishable from a capped page.
- **`inviteId` is a bearer token.** The claim link is
  `${CLAIM_LINK_BASE_URL}?invite=${inviteId}`, so the document id doubles as the
  secret. It is returned because `revokeInvite` takes it and because
  `firestore.rules` already grants `isAuntie()` a read of the whole document, but
  it is deliberately absent from `logEvent` (count only), and **no client may
  render or offer to copy the claim URL**. Possession of the id alone still does
  not redeem: `acceptInvite` additionally requires the caller's VERIFIED token
  email to equal `invitedEmail`.
- Read only apart from one best-effort `OPERATOR_CROSSTENANT_ACCESS` audit entry,
  mirroring `resolveKinfolkAccess`: staff reaching into a household they have no
  member doc for is cross-tenant by definition.

### mintInvite (pre-existing, documented here 2026-08-01)
- req `{ familyId: string, invitedEmail: string /* email */, secondaryLabel?: string /* <=24, default 'Folk' */, proposedRole?: 'PRIMARY' | 'SECONDARY' /* default SECONDARY */, proposedPermissions: { billing_full, messaging_direct, messaging_group, kin_edit, kintales_only, home_access: boolean } }`
- res `{ inviteId: string }`
- GATE: `wrapAdminCallable`.
- `proposedPermissions` requires ALL SIX booleans; a partial object is a Zod
  failure. The server then FORCES `kintales_only: true` regardless of what was
  sent, so clients render that toggle locked on rather than as a control that
  appears to do something.
- `secondaryLabel` is sanitised server-side (`[<>{} -]` stripped, trimmed, capped
  at `SECONDARY_LABEL_MAX` = 24, empty falling back to `'Folk'`), so the stored
  label can differ from what was typed.
- Writes one `inviteRequests` doc with an `INVITE_TTL_DAYS` (14) expiry, sends
  `invite.primary` / `invite.secondary`, flips the doc to `EMAIL_SENT`, and audits
  `MEMBERSHIP_INVITE_SENT`.

### revokeInvite (pre-existing, documented here 2026-08-01)
- req `{ inviteId: string }`
- res `{ ok: true }`
- GATE: `wrapAdminCallable`. Not scoped to a family: any admin may revoke any
  invite by id.
- Errors: `not-found` for an unknown `inviteId`.
- Sets `status: 'REVOKED'` + `revokedAt` unconditionally, including on an already
  ACCEPTED invite, which does NOT un-join the member (use `removeMember` for
  that). Audits `MEMBERSHIP_INVITE_REVOKED`.

### inviteKinfolkToPortal (pre-existing, documented here 2026-08-01)
- req `{ kinfolkId: string /* 1..200 */ }`
- res `{ kinfolkId: string, status: 'sent' | 'already_active' | 'no_email', inviteId?: string }`
- GATE: `wrapAdminCallable`.
- Errors: `not-found` when `kinfolkId` names no `kinfolk` doc; `invalid-argument`
  with `details.validationErrors` otherwise.
- **The two non-`sent` outcomes are SUCCESS responses, not failures**, so a client
  must branch on `status` and say which happened. `no_email` means the kinfolk
  record carries no email; `already_active` means the household already has a
  claimed ACTIVE PRIMARY and was deliberately not re-spammed. Rendering either as
  "invite sent" is a fabricated success.
- Idempotent and safe for an invite-all sweep. Ensures the `families/{kinfolkId}`
  envelope exists, then mints a PRIMARY invite with `FULL_PERMISSIONS`.

### setMemberPermissions (pre-existing, documented here 2026-08-01)
- req `{ familyId: string, targetUid: string, permissions: { billing_full?, messaging_direct?, messaging_group?, kin_edit?, home_access?: boolean } }`
- res `{ ok: true }`
- GATE: `wrapAdminCallable`. This is the ADMIN path; the primary-of-the-household
  path is `updateSecondaryPermissions`, which cannot touch `billing_full`.
- Errors: `not-found` when `families/{familyId}/members/{targetUid}` does not exist.
- **`kintales_only` is not in the argument schema at all**, so no caller on any
  path can turn it off. Clients render it locked on.
- Every key present is a field-level merge (`permissions.<k>`), so a partial
  object is the normal call. Each flag is audited separately; `billing_full` uses
  `PERM_BILLING_GRANTED` / `PERM_BILLING_REVOKED` at severity `warn`, everything
  else `PERM_GRANTED` / `PERM_REVOKED` at `info`.
- Cannot escalate the caller: it writes only household member permission flags
  under `families/*`, and admin authority is the `admin` custom claim, which this
  callable never reads or writes. There is no path from here to staff access.

### removeMember (pre-existing, documented here 2026-08-01)
- req `{ familyId: string, targetUid: string }`
- res `{ ok: true }`
- GATE: `wrapAdminCallable`.
- Errors: `not-found` when the member doc does not exist.
- SOFT delete: sets the member `status: 'SUSPENDED'`, removes `familyId` from
  `clients/{targetUid}.kinfolkIds`, and revokes the user's refresh tokens. The
  member doc is retained. Audits `MEMBERSHIP_MEMBER_REMOVED` at severity `warn`.

### listMembers (pre-existing, admin + household primary; documented here 2026-08-01)
- req `{ kinfolkId?: string }`
- res `{ members: Array<{ uid: string, secondaryLabel: string | null, role: 'PRIMARY' | 'SECONDARY', status: 'INVITED' | 'ACTIVE' | 'SUSPENDED', permissions: { billing_full, messaging_direct, messaging_group, kin_edit, kintales_only, home_access: boolean }, invitedEmail: string | null }> }`
- GATE: `wrapCallable` + `resolveKinfolkAccess` + `requireKinfolkPrimary`. An
  operator may target any household (audited cross-tenant); a household PRIMARY
  may read only their own; a SECONDARY is denied. An operator MUST pass
  `kinfolkId` (they have no default household).
- `displayName` is deliberately NOT surfaced (it can hold PII) and no address is
  fabricated from another field, so `invitedEmail` is null when the member doc
  carries no `email`.
- Read only.

### expireStaleInvites (scheduled, NOT a callable)
- `onSchedule('every day 02:00', 'America/New_York')`. There is no client trigger,
  and no admin "expire now" button exists or should be built: nothing in the
  functions tree exposes it over HTTPS. Clients reconcile expiry for display via
  `listInvites.effectiveStatus` instead of asking the server to sweep.
- Flips PENDING/EMAIL_SENT invites past `expiresAt` to `EXPIRED` (500 per run),
  audits `MEMBERSHIP_INVITE_EXPIRED`, and enqueues `invite.expired`.

## Company holidays / closures (C1)

`business_settings.companyHolidays` (`lib/closureRecurrence.ts`) is durable,
recurrence-aware closure data an operator enters in Settings > Time off. Until
C1 it was read by nothing: no write path checked it, so marking a US national
holiday closed still left the day bookable. `lib/companyHolidayConflict.ts` is
the guard that closes that; every callable below now calls it, unconditionally
(no override parameter, unlike the sibling `guardBookingBusyConflict` — see
that module's header for why a company holiday never gets a bypass):

- `requestBooking` (both the multi-visit and legacy single-visit shapes)
- `createMultiDateBookingRequest` (an `overrideBusyConflict: true` payload does
  NOT bypass this; that field is busy-import-only)
- `createKinCareSession`
- `approveBookingSeriesCore` (re-checked per visit, isolated, at APPROVE time —
  a closure added after the request was submitted still stops the session)
- `rescheduleBooking` (the new window is a fresh slot request)

**Rejection shape** (all of the above): `failed-precondition`, message names
every conflicting visit's date and holiday, `details: { code:
'company_holiday_conflict', conflicts: [{ visitIndex, dateIso, holidayName }] }`.

**Existing bookings on a day later marked closed are NOT touched.** Adding a
closure never cancels or reschedules a `kin_care_sessions` doc that already
exists on that date — see the C1 PR body for the reasoning. The admin's Time
Off editor surfaces upcoming sessions that already fall on a configured
closure so the operator can act on them manually.

### getBusinessClosures
- req `{ fromDate: string (YYYY-MM-DD), toDate: string (YYYY-MM-DD) }`, range
  capped at 120 days, `toDate >= fromDate`.
- res `{ closures: Array<{ date: string, name: string }> }`, sorted by date.
- The kinfolk portal's ONE way to learn which dates are closed:
  `business_settings` is admin-only in `firestore.rules`
  (`allow read: if isAuntie() || isTestAdmin();`), so `mytribe/web` cannot read
  `companyHolidays` directly the way the admin apps do. This resolves
  recurring entries into concrete dates server-side through the same
  `closureRecurrence.ts` math `companyHolidayConflict.ts` uses, so what the
  booking wizard marks and what `requestBooking` will actually refuse can
  never decode into two different calendars.

## Shared catalogs

### getVetClinics
- req `{}`
- res `{ clinics: Array<{ id: string, name: string, phone: string, address: string, website: string, googleMapsUrl: string, isEmergency: boolean }> }`
- Returns APPROVED clinics only: a doc is withheld iff `verified === false`. A
  missing `verified` field reads as approved (legacy curated data). The AuntieOS
  admin reads `vet_clinics` directly instead, so it still sees pending entries.

### submitVetClinic
- req `{ name: string, phone?: string, address?: string, website?: string, isEmergency?: boolean }`
- res `{ clinicId: string, created: boolean, pending: boolean }`
- Deduped by normalized name (lowercased, whitespace collapsed). A match returns
  the EXISTING id with `created: false`, so a caller selects that clinic rather
  than writing a duplicate.
- `isEmergency` added 2026-07-25 for the AuntieOS picker's emergency-vet field.
  Optional, defaults false, so every payload the kinfolk portal has ever sent
  stays valid. Frozen as the superset in `test/callableContract.test.ts`.
- Staff callers (`isStaff`, RULING O-6) land `verified: true` / `pending: false`:
  an operator typing a clinic into a household record IS the curation step.
  Kinfolk submissions still land `verified: false` for operator approval.

## Calendar sync (admin-gated)

### syncGoogleCalendarBusyEvents
- req `{ lookAheadDays?: number }` (default 30, clamped 1..90)
- res `{ imported: number, scanned: number, ranAt: string /* ISO-8601 */ }`
- Reads the SHARED calendar named by `business_settings.calendarSyncId` through
  the pinned service account
  `auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com` (ADC, no
  OAuth, no token storage, no key in any client bundle) and upserts each busy
  interval into `booking_time_slots` as a private BLOCKED slot
  (`hideDetailsFromKinfolk: true`, deduped by `externalEventId`, so re-running
  is idempotent). There is NO calendar id in the request: the callable resolves
  it server-side, so a client cannot sync a calendar the operator did not save.
- `ranAt` added 2026-07-25 alongside the receipt below. Additive: android's
  `syncGoogleBusyEventsViaServer` reads only `imported` and is unaffected.

**The last-run receipt.** Every run merges four flat fields onto the SAME
`business_settings` doc the calendar id was read from, and both clients read them
back on load:
- `calendarSyncLastRunAt: string` (ISO-8601), `calendarSyncLastStatus: 'ok' | 'error'`,
  `calendarSyncLastImported: number`, `calendarSyncLastError: string` (`''` when ok)
- A FAILED run is stamped too, with its cause. Without that, a sync that broke
  and a sync that never ran look identical after a reload, and the operator
  presses Run Sync again to find out which it was.
- The stamp write is best-effort: if it fails, the run's own error is what
  surfaces (it is the more useful one) and the stamp loss is logged.
- Field names frozen in `test/callableContract.test.ts`; both clients read them
  off a document they already load, so a rename here is silent breakage.

**Error surface**, all fail-loud and all naming the fix:
- `failed-precondition` / `calendar_id_not_configured`: no `calendarSyncId` saved
  anywhere in `business_settings`.
- `failed-precondition` with `details { code: 'calendar_id_invalid' }`: the saved
  id is not address-shaped, or is `primary`. Checked BEFORE the Google call,
  because Google answers a typo with `notFound` and answers the service
  account's own `primary` calendar with an empty busy list, and both would reach
  the operator as "Imported 0 busy blocks", which reads as a clear calendar
  rather than a wrong id. The rule lives in `src/lib/calendarSyncId.ts` and is
  MIRRORED client-side so the operator is told before the round trip:
  `auntieos-admin/src/lib/calendarSyncId.ts` and android's
  `ui/admin/scheduling/CalendarSyncId.kt`. Those two are a courtesy; this
  callable is the enforcement.
- `permission-denied`: the calendar is not shared with the service account, or
  Google returned a per-calendar `errors` entry. The message names the exact
  service account, the calendar id, and the "See only free/busy (hide details)"
  share level, and calls out that `notFound` covers both a typo and a share to
  the wrong address.
- `unavailable` / `gcal_<status>`: any other Google failure.

## Google Calendar over OAuth, the editable half (admin-gated, Task 7.2)

A DIFFERENT FEATURE from the free/busy sync above, sharing nothing but the word
calendar. That one READS availability off a shared calendar as a service account
and needs no secret. This one WRITES our visits onto a calendar belonging to a
Google account the operator signs into, and is the only part of the app gated on
an external secret.

**Operator setup, in order.** In Google Cloud Console for project
`auntieos-ttpc`, under APIs and Services, Credentials, create an OAuth client ID
of type Web application whose authorized redirect URI is EXACTLY
`https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback`. Then
from `mytribe/`:

```
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID --project auntieos-ttpc
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project auntieos-ttpc
firebase deploy --only functions:mytribe
```

Both names are declared in the `secrets: [...]` of every function that needs them
and both are READ in `src/lib/googleOAuth.ts`; `test/googleCalendarOAuth.test.ts`
asserts the declaration on each function, because a secret nothing reads does
nothing and a secret nothing declares is never mounted.
`node scripts/declared-secrets.js --by-function GOOGLE_OAUTH` prints the five
pairs out of the built artifact, which is the structure the Firebase CLI itself
validates.

**The third command is not a one-off.** These are gcfv2 functions, so each pins
the secret VERSION resolved at deploy time. `functions:secrets:set` mints a new
version and binds it to nothing: the running function keeps the old value, or no
value at all, until a deploy resolves the name again. A secret set without a
redeploy is indistinguishable from a secret never set, from every client, which
is why `google_oauth_not_configured` names the deploy alongside the command and
why the admin's Calendar section calls those two steps out together. `npm run
deploy` covers it: release step 5 refuses to skip the functions deploy when a
declared secret is newer than the last release.

**Where the refresh token lives.** `integrations_config/googleCalendar`, a
document `firestore.rules` denies to EVERY client, read and write, including a
signed-in Auntie. Only these functions read it, through the Admin SDK. No
callable returns it: every response goes through `publicConnection`, whose key
set is frozen in `test/callableContract.test.ts`. Disconnect revokes at Google
BEFORE clearing our copy.

### startGoogleCalendarConnect
- req `{}`
- res `{ authUrl: string, expiresAt: string, redirectUri: string }`
- Mints a one-time `state` nonce in `google_oauth_states/{nonce}` against the
  caller's uid, valid 15 minutes, and returns the consent URL for the client to
  open (popup on web, Custom Tab on android). The plan sketched this as an HTTP
  endpoint; it is a CALLABLE because a browser navigation carries no ID token, so
  an HTTP start could not tell an Auntie from a stranger.
- `failed-precondition` with `details { code: 'google_oauth_not_configured' }`
  when either secret is unset. The message names which one and the exact command.

### googleOAuthCallback (HTTPS, not callable)
- Google's redirect target. Not authenticated, because Google performs it; the
  one-time state stands in. An unknown, expired or already-spent state is refused
  before any code is exchanged, which is what stops a stranger attaching THEIR
  Google account to this business.
- Stamps `connectLastAttemptAt` / `connectLastStatus` / `connectLastError` on the
  connection doc on SUCCESS and on FAILURE, including a declined consent. The
  window it runs in gets closed, so the receipt is the only report that survives.
- Never echoes the code, the state or any token into the page it renders.

### getGoogleCalendarConnection
- req `{}`
- res `{ connection: PublicGoogleCalendarConnection, freeBusyCalendarId: string, redirectUri: string }`
- The poll target after the consent window opens, since neither client can read
  the outcome out of that window.
- `PublicGoogleCalendarConnection` = `{ connected, googleAccountEmail, connectedAt,
  scopes, writeCalendarId, enabledCalendarIds, disconnectedAt, disconnectedError,
  connectLastAttemptAt, connectLastStatus, connectLastError, calendarPushLastRunAt,
  calendarPushLastStatus, calendarPushLastPushed, calendarPushLastError }`. Key
  set frozen EXACTLY, not as a superset: an added field is how a token leaks.

### listGoogleCalendars
- req `{}`
- res `{ calendars: Array<{ id, summary, accessRole, primary }>, connection, freeBusyCalendarId }`
- Read-only calendars are returned and marked rather than filtered out, so a
  calendar missing from the picker means "the connection is broken", never "it
  was there but you cannot write to it".

### setGoogleCalendarTargets
- req `{ writeCalendarId: string, enabledCalendarIds: string[] }` (`.strict()`)
- res `{ connection: PublicGoogleCalendarConnection }`
- The write target is always forced into `enabledCalendarIds`.
- `failed-precondition` with `details { code: 'write_calendar_invalid' }` when the
  pick is empty, not calendar-id shaped, or IS the free/busy calendar. That last
  case is the ECHO LOOP: visits written into the calendar the free/busy sync
  imports from come straight back as BLOCKED slots over their own hour.
  `freebusy.query` returns start and end and nothing else, so no marker on the
  event could survive the round trip to be filtered on the way back; refusing the
  overlap is the only guard that works. `primary` is resolved against the
  connected account address first, so one calendar spelled two ways is caught.
- The rule lives in `src/lib/googleCalendarTargets.ts` and is MIRRORED in
  `auntieos-admin/src/lib/googleCalendarTargets.ts` and android's
  `ui/admin/scheduling/GoogleCalendarTargets.kt`. Those two are a courtesy; this
  callable is the enforcement. Note it deliberately DIFFERS from the free/busy
  rule: `primary` is legal here (the operator's own calendar) and refused there
  (the service account's permanently empty one).

### pushVisitsToGoogleCalendar
- req `{ lookAheadDays?: number }` (default 30, clamped 1..90, `.strict()`)
- res `{ pushed: number, removed: number, scanned: number, skipped: Array<{ sessionId, reason }>, ranAt: string }`
- NO CALENDAR ID IN THE REQUEST, same posture as the free/busy sync: the target
  comes from the saved connection, so a client cannot aim a household's visits at
  someone else's calendar.
- Operator-initiated only. No trigger and no schedule, following Task 7.1: a
  trigger would start writing to a real person's calendar on the next edit of any
  visit, once per field change.
- Idempotent through `kin_care_sessions.googleEventId`; writes back
  `googleEventId`, `googleCalendarId`, `googleCalendarSyncedAt` and
  `googleCalendarSource: 'AUNTIEOS_PUSH'`. A cancelled visit is REMOVED from the
  calendar rather than skipped. A visit with neither an end time nor a duration
  is skipped and named, never given an invented length. A 404/410 on update
  clears the stale id so the next run recreates the event.
- Stamps `calendarPushLastRunAt` / `calendarPushLastStatus` / `calendarPushLastPushed`
  / `calendarPushLastError` on SUCCESS and on FAILURE, same reasoning as 7.1's
  receipt. Best-effort: if the stamp write fails, the run's own error is what
  surfaces.
- `failed-precondition` / `google_calendar_not_connected` when nothing is
  connected; `failed-precondition` / `google_oauth_revoked` when Google answers
  `invalid_grant`, which retrying never fixes and only reconnecting does.

### mapboxSearch
- req `{ query: string, sessionToken: string, limit?: number, country?: string }`
- res `{ suggestions: Array<{ name: string, full_address: string, mapbox_id: string, place_formatted: string }>, signedBy: 'mapboxSearch' }`
- A query under 2 characters returns an empty list rather than an error.

### mapboxRetrieve
- req `{ mapboxId: string, sessionToken: string }`
- res `{ feature: unknown | null, signedBy: 'mapboxRetrieve' }` (raw Mapbox GeoJSON feature)
- Mapbox session billing: the caller generates ONE 32-hex `sessionToken`, reuses
  it across every keystroke's `mapboxSearch`, passes the SAME token to
  `mapboxRetrieve`, and only then rotates it. A fresh token per keystroke bills
  each keystroke as its own session.

## Booking requests & lifecycle (kinfolk + admin)

**Machine-checked as of 2026-08-01** (ADR-0003 follow-up). All six callables
below export `Args` (except `getMyBookings`, which has none, same situation
as `getMyInvoices`) and `Result`, outbound-validated, generated into the
Contracts module (`bookingContracts.generated.ts` /
`BookingContracts.generated.kt`). This section did not exist before this
follow-up; these six were never documented here, only reachable by reading
the handler.

### getMyBookings
- req `{ kinfolkId?: string }` (no zod schema; read raw off `req.data`, same
  precedent as `getMyInvoicesRequest`)
- res `{ liveVisit: BookingDto | null, upcoming: BookingDto[], recent: BookingDto[], envelopes: EnvelopeDto[] }`
- READ-ONLY. `BookingDto` is one `kinCares` (per-visit) doc; `EnvelopeDto` is
  one parent `bookings/{batchId}` envelope plus its `kinCares` children.
  `liveVisit` is the one visit currently `active`/`enRoute`, if any.
  `upcoming` also folds in AuntieOS-scheduled `kin_care_sessions` docs that
  have no booking envelope at all (a session created directly in the admin
  app), so a kinfolk sees those too; a session already linked to a booking via
  `sessionId` is not double-shown.
- kinfolk portal only; not called by the React admin or android (android
  reads the underlying Firestore docs directly for its own booking views).

### requestBooking
- req: see `src/portal/requestBooking.ts`'s `export const Args` for the full
  shape and why it is one schema covering two accepted payloads. The kinfolk
  portal only ever sends the multi-visit shape today (`kinfolkId?`, `kinIds?`,
  `notes?`, `pattern?`, `weeklyDays?`, `visits: [{ startTimeMs, endTimeMs,
  serviceId, serviceName, priceCents, location }]`, `billing?`,
  `communication?`); the legacy single-visit shape (`serviceType`,
  `startTimeMs`, ...) has no live caller but the server still accepts it.
- res `{ batchId: string, bookingIds: string[], bookingId: string }`. Both
  write paths return this identical shape; `bookingId` is always `batchId`
  (kept as a legacy alias, no caller has ever seen it absent).
- Writes ONE parent `families/{kinfolkId}/bookings/{batchId}` envelope plus
  one `kinCares/{visitId}` per visit, in a transaction. `priceCents` and
  `serviceName` in the response's underlying doc are resolved SERVER-SIDE
  from the `base_services` catalog when `serviceId` is known; a client price
  is never trusted (NOTE-56). May auto-confirm (see
  `business_settings.autoConfirmRepeatKinfolk`) for a repeat kinfolk;
  auto-confirm failure never fails the request, it just leaves the booking in
  the manual queue.
- kinfolk portal only.

### requestBookingCancellation
- req `{ kinfolkId?: string, batchId: string, visitId: string, reason?: string }`
- res `{ ok: true, visitId: string, alreadyPending: boolean }`
- Vendor-parity (2026-07-02): NOT a status change. Stamps
  `cancelRequestedAt`/`cancelRequestReason`/`cancelRequestedByUid` on the
  visit; only the business cancels for real, via `batchUpdateBookings` or
  `manageBookingSeries`. A second request on an already-pending visit is a
  no-op (`alreadyPending: true`), not an error.
- Only `requested`/`confirmed` visits are cancelable; anything else is
  `failed-precondition`.
- kinfolk portal only.

### createMultiDateBookingRequest
- req: see `src/admin/createMultiDateBookingRequest.ts`'s `export const Args`.
  Mirrors `requestBooking`'s multi-visit shape field for field (`kinfolkId`
  required here, unlike the portal's), plus `overrideBusyConflict?: boolean`.
- res `{ batchId: string, visitIds: string[], visitCount: number }`
- The ADMIN equivalent of `requestBooking`'s multi-visit path: same
  `writeEnvelope`/`resolveService`, authenticated as staff, targeting an
  arbitrary `kinfolkId`. `overrideBusyConflict: true` writes past a real
  `GOOGLE_BUSY_IMPORT` conflict and audits
  `BOOKING_BUSY_CONFLICT_OVERRIDDEN`; kinfolk have no equivalent override.
- React admin and android both call this.

### rescheduleBooking
- req `{ sessionId: string, startTime: string, endTime: string }`
- res `{ ok: true, sessionId: string }`
- Server-bound reschedule of a `kin_care_sessions` doc (Schedule
  drag-to-reschedule and Bookings bulk/per-card Reschedule share this).
  404s if the session doesn't exist. Audit records the actual before/after
  window.
- React admin and android both call this.

### manageBookingSeries
- req `{ action: 'APPROVE' | 'CANCEL', kinfolkId: string, batchId: string }`
- res `{ ok: true, action, batchId: string, affectedVisits: number, sessionsCreated: number, failedVisits: number }`
- Series-level approve/cancel on ONE parent booking envelope: flips every
  child `kinCares` visit's status and rolls the envelope status + counts in a
  single pass. APPROVE delegates to `approveBookingSeriesCore` (also used by
  `requestBooking`'s auto-confirm path); CANCEL flips every child to
  `cancelled` and mirrors onto any paired `kin_care_sessions` doc.
  `failedVisits > 0` reports `status: 'FAILURE'` on the audit entry even
  though the response still carries the partial counts; the envelope itself
  is only marked fully `cancelled` when every visit succeeded.
- android only, as of this follow-up (the React admin explicitly does not
  call this callable; it acts on the same nested envelope model through
  other means).

## Bulk booking transitions (admin-gated)

### batchUpdateBookings
**Machine-checked as of 2026-08-01** (ADR-0003 follow-up): `Args`/`Result`
exported from `admin/batchUpdateBookings.ts`, outbound-validated, generated
into the Contracts module. This doc stays the semantics reference; the schema
is the shape authority.
- req `{ ids: string[] /* each 1..200, max 100 */, action: 'APPROVE'|'REJECT'|'CANCEL' }`
- res `{ ok: true, action, updated: number, failed: Array<{ id: string, error: string }> }`
- **TWO CALLERS, TWO ID SPACES, resolved in the SAME request.** "A booking" is a
  different document on each platform, and `ids` may be a mix of both:
  - kinCares envelope visit ids, `families/{kinfolkId}/bookings/{batchId}/
    kinCares/{visitId}` (read by the kinfolk portal's `getMyBookings` via
    `collectionGroup('kinCares')`). Sent by the React admin's Bookings screen
    (`bookingBulk.ts`'s `envelopeVisitId`, never its `kin_care_sessions` row
    id) and by android's Notifications quick approve/deny (the notification's
    `targetId`, stamped as `visitId` by `onBookingsWrite.ts`). APPROVE writes
    `confirmed`, REJECT/CANCEL write `cancelled` (no distinct rejected state).
    On a hit, ALSO mirrors onto the paired `kin_care_sessions/vis_{visitId}`
    doc when one exists (`SCHEDULED`/`CANCELLED`), exactly as
    `manageBookingSeries`'s own CANCEL path already does. The React admin
    still writes `kin_care_sessions` directly from the client too; that write
    is now redundant, not required, and is left alone as the reference path.
  - `enhanced_bookings/{id}` top-level docs, android's OWN flat booking table
    (`ServiceModels.kt`'s `EnhancedBooking`; android and web do not share this
    collection, each platform carries its own row). Sent by android's
    Bookings/Schedule screen bulk bar (`ScheduleViewScreen.kt`'s
    `selectableIds`, built from `EnhancedBooking.id`). These docs carry no
    envelope linkage field, so a hit here is the WHOLE record and only its own
    `status` is written: APPROVE -> `ACCEPTED`, REJECT/CANCEL -> `REJECTED`.
    `updatedAt` is written as an ISO-8601 STRING here, never
    `FieldValue.serverTimestamp()` -- `EnhancedBooking.updatedAt` decodes as a
    Kotlin `String`, and a Timestamp there is a decode crash, not a type
    coercion.
  - Resolution order: `enhanced_bookings` (a direct `getAll`) first, then
    whatever remains against the `kinCares` collection group. An id found in
    neither reports `{ id, error: 'not-found' }`.
- Before 2026-08-01 the handler only ever tried the `kinCares` space. Every id
  android's Bookings screen bulk bar has ever sent was `enhanced_bookings`
  shaped, so every one came back `not-found` and the bulk action was a no-op
  wearing a success banner (android's own quick-approve/deny on Notifications
  already sent the right-shaped id and worked; the bulk screen's ids were the
  broken path). See `test/batchUpdateBookings.test.ts`.
- Idempotent per id: a doc already in the target status counts as `updated`
  without a redundant write. Per-id failures (unknown id, a write that throws)
  collect into `failed` rather than aborting the whole batch.
- Audit `BOOKING_BATCH_ACTION`, `targetCollection` reported as `kinCares`,
  `enhanced_bookings` or `mixed` depending on which id space(s) the batch
  actually resolved.
- Generated types: `BatchUpdateBookingsArgs`/`BatchUpdateBookingsResult` in
  each client's `bookingContracts.generated.ts` / `BookingContracts.generated.kt`.
  The React admin (`auntieos-admin/src/api/bookingsWrite.ts` +
  `src/lib/bookingBulk.ts`) and android
  (`data/repository/AuntieRepository.kt`) are repointed at these; no more
  hand-mirrored request/response types for this callable.

## Booking status transitions (admin-gated, A3)

`transitionBookingStatus` owns the four OPERATOR transitions on a flat
`kin_care_sessions` row, and is the only path to a terminal status: since A3,
`firestore.rules` refuses `status: COMPLETED | CANCELLED | CANCELED | REJECTED`
and any `completedAt` write from every client, on both create and update.

Before A3 these four were a bare client `updateDoc`
(`auntieos-admin/src/api/bookingsWrite.ts:84`, plus three equivalents on
Android) authorized by `isAuntie()` alone. Any status could be set from any
status and `activity_log` recorded none of it, on the surface that decides
whether a visit happened and therefore whether it is billable.

Mirrored by the React admin (`src/api/bookingsWrite.ts`) and android
(`KinCareRepository.transitionBookingStatus` + `BookingTransitionAction`). The
request shape, the action set, the target statuses and the refusal detail codes
are all frozen by `test/callableContract.test.ts`.

### transitionBookingStatus
- req `{ sessionId: string /* 1..120 */, action: 'APPROVE'|'REJECT'|'CANCEL'|'COMPLETE', completedAt?: string /* 1..40, COMPLETE only */, reason?: string /* 1..500, CANCEL and REJECT only */ }`
- res `{ ok: true, sessionId: string, action: string, from: string, status: string, changed: boolean }`
- `changed: false` means the row was already in the target status: success, no write
- `completedAt` is the CALLER's "now", matching what every reader of this
  collection already parses. Omitted, the server stamps its own ISO string
- `reason` is appended to the session's own `notes` as
  `[Booking cancelled] <reason>`. The audit payload records only
  `reasonSupplied: true`, never the text

**The state machine** (`src/lib/bookingTransitions.ts`):

| action | allowed from | lands on |
| --- | --- | --- |
| APPROVE | DRAFT, PENDING | SCHEDULED |
| REJECT | DRAFT, PENDING | CANCELLED |
| CANCEL | SCHEDULED, ON_MY_WAY, ARRIVED, DEPARTED | CANCELLED |
| COMPLETE | SCHEDULED, ON_MY_WAY, ARRIVED, DEPARTED | COMPLETED |

COMPLETED and CANCELLED are terminal: nothing transitions out of either. On
read, `CANCELED` and `REJECTED` fold onto `CANCELLED`; every write emits the
canonical spelling.

**REJECT vs CANCEL.** Both land on `CANCELLED`, because this collection has no
distinct "rejected" value and inventing one would break every existing reader
(the same asymmetry `batchUpdateBookings` documents on the sibling envelope
model). They are still two actions, distinguished by their source set: REJECT
declines a request that was NEVER approved, so nothing was promised to the
household and nothing is billable; CANCEL calls off a visit that WAS approved,
possibly one already in flight, which the household was told about and which may
be partly billable. The audit entry records the action chosen alongside the
status it came from, so the distinction survives the write.

**Rejections**, all `failed-precondition` except the first; clients branch on
`details.code`:
- unknown session: `not-found`
- illegal transition:
  `details { code: 'booking_transition_illegal', from, allowedFrom }`, message
  `"Cannot <ACTION> a booking in status <FROM>. Allowed from: ..."`
- unreadable stored status (blank, absent, or unrecognized):
  `details { code: 'booking_status_unknown' }`

**Every path is audited, refusals included.** Success and no-op emit
`BOOKING_STATUS_TRANSITION` at `severity: 'info'`; refusals emit
`BOOKING_TRANSITION_REFUSED` at `'warn'` with `status: 'FAILURE'`. A
success-only trail cannot answer "who tried to complete a cancelled visit",
which is the question the trail exists for.

**What did NOT move.** The in-visit lifecycle (`ON_MY_WAY` / `ARRIVED` /
`DEPARTED`, and Undo Arrival back to `SCHEDULED`) is still a direct client patch
from the field app, and `firestore.rules` still permits it. That app is
regularly offline mid-visit, and Firestore's offline write queue is what makes
those writes land at all.

## Booking notes (admin + kinfolk)

Two threads on one visit, at
`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`. They are separate
SUBCOLLECTIONS, not one collection with a flag, because `firestore.rules` draws
the kinfolk boundary at the path (`notes` is member-readable, `internalNotes` is
`isAuntie()` only) and denies every client write to both. That path-level
boundary is why these are callables at all.
**Machine-checked as of 2026-08-01** (ADR-0003 follow-up): both export
`Args`/`Result`, outbound-validated, generated into the Contracts module. The
React admin (`src/api/bookingsWrite.ts`) and android
(`BookingNotesRepository`) are repointed at the generated
`AddBookingNoteArgs`/`Result` and `AddInternalBookingNoteArgs`/`Result` types
instead of hand mirrors.

### addBookingNote
- req `{ kinfolkId: string, batchId?: string, visitId?: string, bookingId?: string, body: string }`
  (send `batchId`+`visitId`; `bookingId` is the legacy flat id, resolved
  best-effort by `resolveKinCareRef`)
- res `{ noteId: string }`
- writes `.../kinCares/{visitId}/notes`, `authorRole` stamped from the CALLER
  (`'admin'` or `'kinfolk'`), never sent by the client

### addInternalBookingNote
- req: identical to `addBookingNote`
- res `{ noteId: string }`
- writes `.../kinCares/{visitId}/internalNotes`, `authorRole` always `'admin'`

**The 3 hour cutoff, shared by both note callables.**
BOTH callables enforce it, through `src/lib/bookingNoteCutoff.ts`. Changed
2026-07-25: it used to be private to `addBookingNote`, so the internal thread
was guarded by client code alone and any other caller wrote straight past it.
- rejection `failed-precondition`, message
  `"Notes cannot be edited within 3 hours of booking start window."`,
  details `{ code: 'booking_note_cutoff' }`
- clients branch on `details.code`, not on the message text
- a visit with no readable `startTime` is NOT locked: there is no window to be
  inside of
- `test/bookingNoteCutoff.test.ts` freezes the boundary to the millisecond and
  asserts both callables reject identically
Clients mirror the rule for a courtesy lock so the operator is not surprised by
a rejection (`auntieos-admin/src/lib/bookingDetailFormat.ts`,
`ui/admin/scheduling/BookingNoteCutoff.kt`). Those are conveniences. The
callable is the enforcement.

## Integrations (admin-gated)

### getIntegrationsHealth
- req `{}` (no arguments, and the contract test freezes that: a field here would
  mean a client could ask for a narrowed report, which is a decision, not a tweak)
- res `{ checkedAt: string /* ISO */, declaredKnown: boolean, declaredError: string,
  integrations: Array<{ key: string, name: string, purpose: string,
  status: 'working'|'configured'|'missing'|'unknown', summary: string,
  secrets: Array<{ name: string, required: boolean, purpose: string, declared: boolean,
  resolves: boolean, length: number }>,
  liveness: { outcome: 'none'|'pass'|'fail'|'error', detail: string },
  remediation: string, externalStep: string, ownedBySection: string }> }`
- Read only. The seven services this system depends on: Stripe, Twilio, SMTP2GO,
  Cloudinary, Mapbox, Google Calendar, Sentry. Catalog and copy live in
  `src/lib/integrationCatalog.ts`; both clients render this answer and neither
  decides health for itself.
- **NO SECRET VALUE, AND NO PREFIX OF ONE, IS EVER RETURNED.** Per secret: booleans
  and a character count. Four characters of a Stripe key name the account mode and
  four of a Twilio SID name the account, so there is no safe prefix and none is
  sent. `length` is a count, not a sample, and it earns its place because a
  half-pasted key resolves exactly like a good one and fails every call.
  `test/getIntegrationsHealth.test.ts` serialises the whole response and searches
  it for every fake value AND every 4-character prefix.
- **The three questions are separate because they fail separately.** `declared`:
  some deployed function binds this name, walked from the built `__endpoint`s
  (`src/lib/declaredSecrets.ts`, the same walk `scripts/declared-secrets.js` uses,
  and the same structure the Firebase CLI validates). `resolves`: the name reached
  THIS function's environment. `liveness`: something was actually exercised.
- **This callable BINDS every secret it reports on**, and that binding is the
  mechanism rather than housekeeping: `process.env` in a Cloud Function carries
  only what that function declared, so an unbound name would be reported absent
  whether or not it exists. A frozen test asserts the binding matches the catalog.
  `AUNTIE_OPERATOR_UIDS` is bound too, because `wrapAdminCallable` goes through
  `isStaff`, which reads it.
- **Nothing paid is called just to say hello.** Liveness is claimed for exactly
  three, each free and local: Sentry (did `initSentry` really initialise, no event
  sent), Cloudinary (can a signed upload be signed, pure sha1, no network, and it
  is the actual failure mode rather than a proxy for it), Google Calendar (the
  stored connection, read through the SAME `readConnection` the Calendar section
  uses). Stripe, Twilio, SMTP2GO and Mapbox get `outcome: 'none'` and a sentence
  saying why, because an unexplained blank where a result should be reads as a
  failure.
- **`fail` and `error` are different, and `unknown` is the reason the enum has
  four members.** `fail` is a real known "not yet" (no Google account connected).
  `error` is the check itself breaking, and it renders `unknown`, never green and
  never `missing`: the credentials are fine, our ability to look is what broke,
  and sending an operator to reset a correct secret wastes the one action they
  had in them.
- `remediation` carries the exact `firebase functions:secrets:set NAME --project
  auntieos-ttpc` command plus the redeploy, and both clients print it VERBATIM. A
  client that paraphrased it would delete the only text that says what to do next.
  Empty when nothing is owed, so a remediation line always means something.
- `ownedBySection` is `googleCalendar` for the Google row and empty elsewhere.
  The OAuth connect flow already exists behind Settings > Google Calendar; this
  row reports and links, and does not rebuild it.
- `externalStep` names what this repo cannot do for the operator: Stripe Connect
  onboarding (needs a Connect client ID and secret no code here holds), the Twilio
  status-callback registration, the SMTP2GO event webhook. Named rather than
  half-built behind a button that cannot work.
- Mirrors: `auntieos-admin/src/api/integrations.ts` (React) and
  `android .../data/repository/IntegrationsRepository.kt`. Android keeps two
  DEVICE-ONLY probes beside this answer (its own Firestore round-trip and its own
  FCM registration token) because those are facts about the handset that no server
  can see; everything a server can know comes from here so the two clients cannot
  disagree.

## KinTale triage (admin-gated)

### listOrphanReports
- req `{}` (no arguments)
- res `{ reports: Array<{ _id: string, bodyCopy: string, sentVia: string,
  createdAt: string /* free-text ISO or blank */ }>, scanned: number }`
- Read only, admin-gated. An orphan is a `kin_care_reports` row carrying a
  migration provenance marker (`legacy_orphan` from Pass 1, `legacy_visit_logs`
  from the Pass 2 rename) with a blank `kinfolkId` and no `triageStatus`. It is
  completed care work with no session to bill it against, so it is money the
  operator cannot see until something surfaces it.
- **Not a filter over the KinTales list, on purpose.** That list is ordered
  `createdAt desc` and hard-capped at 200 so it never opens an unbounded
  listener, and whether an orphan lands inside that page is currently governed by
  a defect: `createdAt` holds two incompatible formats, free text on legacy rows
  (`"September 3, 2025 2:02pm"`) and ISO everywhere else. Firestore orders
  strings by UTF-8 byte, so every legacy row sorts above every ISO row in DESC,
  and legacy rows sort among themselves alphabetically by month name. Verified
  against prod 2026-08-01. After the operator's redating (legacy `createdAt`
  becomes the `_migratedAt` ingest stamp; `createdAt` then means created in
  AuntieOS) the ordering becomes real and orphans, pinned at the May 2026 ingest
  date, drift off the page as new reports accumulate. This callable is one
  bounded, unordered, single-predicate read, correct under both regimes and
  served by Firestore's automatic per-field index; a second predicate, or an
  `orderBy` on another field, would force a composite index. The rest of the
  orphan test runs in memory, the same way `listUninvoicedSessions` filters
  `status` and `invoiceId`.
- `scanned` is the row count read before the in-memory filter, so an empty
  `reports` is distinguishable from a query that matched nothing at all.
- The blank test treats an ABSENT field and an empty string identically, matching
  Android's `KinCareReport.isUntriagedOrphan()` (`data/model/Models.kt`). A
  divergence there would hand the two clients different orphan sets from one
  collection.
- Write side is `triageOrphanReport` (ASSIGN, DUPLICATE, ARCHIVE), which both
  clients share.

## Operator preferences

### saveDashboardLayout
- req `{ tokens: string[] /* each `^[a-zA-Z]+:(compact|wide)$`, max 30 */ }`
- res `{ ok: true, tokens: string[] }` (echoes what was stored, so the client
  reconciles its optimistic order against the server instead of assuming)
- Merge-writes `users/{uid}.dashboardWidgets` plus
  `dashboardWidgetsUpdatedAt`, on the CALLER's own document (`req.auth.uid`);
  a uid in the payload is ignored.
- `users/{uid}` is client-writable for an admin (`firestore.rules`:
  `allow read, write: if isAuntie()`), so this callable is not an access gate.
  It exists for two other reasons: the rule validates nothing, and the existing
  clients write the WHOLE user document (android's `saveUserProfile` is a full
  `set`, which is why `HomeViewModel` re-reads the profile before every layout
  save so theme and nav prefs are not clobbered). The `{ merge: true }`
  field-scoped write here removes that hazard.
- The KEY half of a token is matched loosely (`[a-zA-Z]+`) on purpose: clients
  ship on different cadences, and every client already drops keys it does not
  recognize when parsing. The SIZE half is closed, because all three renderers
  branch on exactly `compact` and `wide`. Frozen in
  `test/callableContract.test.ts`.
- Reads need no callable. `users/{uid}` is already admin-readable, so
  `auntieos-admin/src/api/dashboardLayout.ts` reads the field directly, the same
  access `src/api/account.ts` uses for the rest of that document. Android reads
  it through `AuntieRepository.observeUserProfile`.
- Mirrors: `auntieos-admin/src/lib/dashboardLayout.ts` (the token model, React),
  `android .../ui/home/DashboardLayout.kt`, and the superseded
  `web/composeApp/.../screens/home/DashboardLayout.kt`. One field, three
  parsers, so a layout arranged on any surface opens arranged on the others.

## Branding (admin-gated)

### confirmBrandAssetUpload
- req `{ kind: 'businessLogo' | 'portalLogo', secureUrl: string /* url, <=2000 */ | null }`
- res `{ kind, logoUrl: string, logoRemovedAt: string }`
- `secureUrl: null` is the REMOVE action, on the same callable. One callable
  rather than a `removeBrandAsset` sibling because set and clear write the same
  two fields on the same doc under the same gate, and a second callable would be
  a second place for the "what does cleared mean" rule to drift.
- **There is deliberately no matching signer.** AuntieOS's already-deployed
  `/api/cloudinary/sign-upload` (`web/functions/index.js`) is what mints the
  signature, and BOTH admin clients already call it with entityType `BUSINESS`
  and entityId `business_settings` to upload the logo today. Adding a MyTribe
  signer for the same upload is the exact shape of the `signCloudinaryUpload`
  collision recorded at the top of `src/index.ts`. See `src/lib/brandAsset.ts`.
- Writes are field-scoped and merged: `businessLogo` sets top-level `logoUrl` +
  `logoRemovedAt`; `portalLogo` sets `mytribePortal.logoUrl` +
  `mytribePortal.logoRemovedAt` as a NESTED map, so a logo change can never blank
  the portal's theme, banner, home layout or chat config.
- `invalid-argument` when `secureUrl` is not provably ours:
  `assertCloudinaryUrlInFolder` requires https, host `res.cloudinary.com`, our
  cloud name, an `/image/upload/` asset, and the signed folder
  `tribetails/business/business_settings`. This is the only check between a
  client-supplied string and the CLIENT-FACING portal header, which is why the
  admin never writes `logoUrl` directly even though `firestore.rules` would let
  it (`business_settings` is `allow write: if isAuntie()`).
- `logoRemovedAt` exists so a CLEARED logo stays distinguishable from one that
  was NEVER SET. Both are `logoUrl === ''`; without the stamp an operator who
  presses Remove sees the identical empty panel a fresh install shows and cannot
  tell the removal landed. Mirrored in `auntieos-admin/src/api/settings.ts` and
  rendered by `logoStateLabel` (`src/lib/settingsFormat.ts`).
- **The Cloudinary asset is NOT deleted**, only the reference. These functions
  hold no Cloudinary delete credential, a mistaken removal would otherwise be
  unrecoverable, and the URL may still be live in an already-sent email. The
  admin's copy says so rather than implying a deletion that does not happen.
- A removal never touches Cloudinary config, so a clear still works when signing
  is misconfigured. Otherwise a bad logo could be stranded on the portal with no
  way to take it down.
- Reads need no callable. `getMyHome` already returns `businessLogoUrl` (which is
  `mytribePortal.logoUrl`) and the whole `portal` config to the kinfolk portal on
  every Home and Account load; the portal was simply discarding it. Limits are
  duplicated in `auntieos-admin/src/lib/brandAssetFile.ts` (5 MB, PNG/JPEG/WebP,
  48px..4000px) and enforced there BEFORE upload; SVG is refused on both sides.
- req `{ channel: 'email'|'sms', to: string, subject?: string /* required on email */, body: string, transactional?: boolean /* default false */, mirrorToChannel?: boolean /* default false, sms only */ }`
- res `{ ok: true, channel: 'email'|'sms', providerMessageId: string, recipientRedacted: string, mirrored: boolean, mirrorSkippedReason: 'not_requested'|'no_existing_thread'|'write_failed'|null }`
Mirrored by `auntieos-admin/src/api/externalSend.ts` and android's
`AuntieRepository.sendExternalMessage` / `decodeExternalSendResult`.
- `mirrorToChannel` asks the server to ALSO record the send in `sms_messages`
  with `direction: 'outbound'`, so an Inbox Channels thread reads as a
  conversation rather than one-sided. Without it the reply lives only in
  `external_messages` and never appears in that list.
- **It is a request, not an instruction.** The server refuses unless the number
  ALREADY has a row in `sms_messages`, and the reason is a privacy posture, not a
  performance one: every other thing this callable writes stores the recipient
  REDACTED (`activity_log` via `writeAuditEntry`, and the `external_messages`
  record itself), while an `sms_messages` row stores `counterpartNumber` in the
  CLEAR. Mirroring into an existing thread adds no contact the collection did not
  already hold, put there by the person texting in through the
  signature-verified Twilio webhook. Mirroring to a new number would not. Full
  reasoning in `src/lib/smsChannelMirror.ts`.
- A caller therefore CANNOT smuggle a plaintext one-off contact into
  `sms_messages` by passing the flag. `ExternalSendPanel` (web) and
  `CommunicateViewModel` (android) send one-off texts to people who are not
  kinfolk and deliberately do not pass it at all.
- `invalid-argument` on `mirrorToChannel: true` with `channel: 'email'`. Refused
  rather than ignored: `emails` is a different collection with a different
  schema, and silently dropping the flag would let the operator's banner claim a
  row that was never written.
- **A mirror failure NEVER fails the call.** The provider send already happened,
  and reporting a failure to an operator who has already sent a text is how the
  same text gets sent twice. The mirror is attempted after the send and reported
  through `mirrored` / `mirrorSkippedReason`, which both clients render honestly.
- Clients branch on `mirrorSkippedReason` codes, never on message text. Absent
  `mirrored` (an older deployed function) reads as `false` in both mirrors, so a
  version skew understates rather than lies.
- The mirror row is keyed by the Twilio message SID, exactly as
  `twilioInboundSms` keys its own, so a retried send upserts one row instead of
  duplicating the reply in the operator's thread. Its schema is field-for-field
  the inbound one, because the Inbox readers, android's `observeSmsMessages` and
  `reconcile_comms.py` all parse that single shape.
- `reconcileStatus` is `'skipped'` when the row inherited a kinfolk link from the
  thread (already linked, so an LLM pass would re-derive a copied fact) and
  `'pending'` when it did not, so an unlinked reply still reaches the dossier by
  the same phone match every inbound row gets.
- Needs the composite index `sms_messages(counterpartNumber ASC, timestamp DESC)`
  added in `mytribe/firestore.indexes.json`. Without it deployed, the existing
  thread lookup fails and every mirror reports `write_failed` while the texts
  still send.
