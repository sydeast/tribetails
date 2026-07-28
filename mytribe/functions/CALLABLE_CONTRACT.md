# Cross-app callable contract (AO-8)

MyTribe callables are the contract. Three clients hand-mirror them: the AuntieOS
admin (React `auntieos-admin/src/api/*.ts`), the Compose app (`web/composeApp`
`FirestoreClient.kt`), and android (`AuntieRepository.kt`). This file is the
single human source those mirrors are built from.

`functions/test/callableContract.test.ts` freezes the REQUEST field set of the
widget callables below and fails on drift. When you change a shape on purpose:
edit that test's frozen set, edit this file, and edit all three client mirrors in
the same change. Response shapes are not zod-introspectable, so this doc is their
review anchor.

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

Coverage reality, so nobody over-trusts this: the admin invokes ~50 MyTribe
callables; the above 12 are frozen. The measured surface, not the stale "~26":

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
validated enums and never parsed dates. `status` in particular is whatever the
caller sent, so classify it through a shared enumerator rather than deciding
"paid" by ruling out the other states (the AO-12 defect).

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
  `status` is IGNORED: the server always stamps `status: 'QUOTE'`, so no client can
  mint a quote that fails to read as one.
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
- res `{ ok: true, invoiceId: string, totals: { subtotalCents: number, totalCents: number, paidCents: number, amountDueCents: number } }`
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
  `src/lib/invoiceEditPolicy.ts`:
  - `draft` / `quote`: fully editable.
  - `open` / `zero`: fully editable while the `payments` subcollection is EMPTY.
    Once a payment exists, the money freezes and only metadata may change.
  - `paid` / `cancelled` / `credit` / `redeemed`: no edits at all.
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
- res `{ sessions: Array<{ sessionId: string, kinfolkId: string, serviceType: string, durationMinutes: number, startTime: string /* ISO */, unitCents: number | null }>, unpriceable: Array<{ sessionId: string, serviceType: string }>, rateCardLoaded: boolean, scanned: number, truncated: boolean }`
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
- Capped at 500 rows. `scanned` and `truncated` report the page honestly, so an
  empty result is distinguishable from a truncated one.

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

## Booking notes (admin + kinfolk)

Two threads on one visit, at
`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`. They are separate
SUBCOLLECTIONS, not one collection with a flag, because `firestore.rules` draws
the kinfolk boundary at the path (`notes` is member-readable, `internalNotes` is
`isAuntie()` only) and denies every client write to both. That path-level
boundary is why these are callables at all.
Both are mirrored by the React admin (`src/api/bookingsWrite.ts`) and android
(`BookingNotesRepository`).

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
