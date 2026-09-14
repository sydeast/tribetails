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
21 on the invoice side (19 at W3-1, plus `getInvoiceLedger` in A1 and
`listPayments` beside it). **The
BOOKING family joined it on 2026-08-01 (ADR-0003's follow-up, once the
precondition ADR-0003 named was met):** `getMyBookings`, `requestBooking`,
`requestBookingCancellation`, `addBookingNote`, `addInternalBookingNote`,
`createMultiDateBookingRequest`, `rescheduleBooking`, `manageBookingSeries`,
`batchUpdateBookings` each export a `Result` (and, all but `getMyBookings`,
an `Args`), validate outbound the same way, and are generated into the
Contracts module through `scripts/contracts/registry.ts`'s
`BOOKING_CONTRACT_REGISTRY`, exactly as the 21 invoice callables are through
`INVOICE_CONTRACT_REGISTRY`. For those 30, this doc is documentation and the
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
  (`sectionDefinitions[]`, plus `expectNew` added under issue #468 so a create
  refuses an id that is already taken instead of upserting over it),
  `importSeedTemplates` (`dryRun`, `onlyIds[]`, `overwriteIds[]`, issue #468,
  frozen from birth because the React admin and the Android Templates screen
  both hand-mirror it), `broadcastMessage` (a `.superRefine` ZodEffects wrapping
  a nested `criteria`; it took an optional `idempotencyKey` in #814, shaped
  `bcast_<millis>_<suffix>`, which becomes the `broadcasts/{id}` document id,
  the row is now written BEFORE the fan-out so there is something for a second
  attempt to collide with, and a deduped reply carries `deduped: true` with the
  stored counts. An all-failed attempt leaves the row at `fanoutState: 'failed'`
  and is the one state a same-key retry may re-run from, because nobody heard
  anything). #825 gave the same treatment to the four MONEY callables —
  `recordPayment` (`pay_`), `markInvoicePaid` (`ipay_`), `createInvoice`
  (`inv_`) and `createQuote` (`quot_`) — and to `payInvoice`, whose key is
  handed to STRIPE as a request option rather than checked here, because the
  duplicate a replay makes is a second Checkout Session in Stripe's database
  and both stay payable. All five are optional, so every frozen shape stays a
  SUPERSET. The four Firestore ones use a TRANSACTION rather than #814's bare
  `create()` claim: each moves a second thing beside its anchor row (a family
  balance, an invoice's settlement, a sequence value from
  `counters/invoiceNumber`), so the read that finds a prior attempt and the
  writes it cancels have to share one snapshot. See
  `src/lib/moneyIdempotency.ts`. The `shapeSignature` walker unwraps optional/nullable/
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

### getLocalWeather (W16 Weather Watchdog / W17 Heat Stroke Index)
- req `{}`
- res `{ ok: true, city: string, state: string, tempF: number|null, humidityPct: number|null, shortForecast: string, isDaytime: boolean, alerts: Array<{ event: string, severity: string, headline: string }>, observedAtMs: number, source: 'NWS', cached: boolean }`

Deployed since the A8 widget round and mirrored by android from the start; the
React admin joined as the third mirror on 2026-08-01 (`src/api/weather.ts`),
which is why it is written down here now.

`tempF` and `humidityPct` are genuinely NULLABLE, not "absent means zero". NWS's
hourly endpoint is a separate fetch the handler treats as a bonus, so a reading
can be missing, and a client that defaulted either to 0 would render a freezing
day and flip every risk verdict on the card. Both mirrors keep the null.

THE SERVER RETURNS CONDITIONS, NEVER A VERDICT. The paw-burn level and the
canine heat index are computed client-side from identical thresholds
(`auntieos-admin/src/lib/weatherRisk.ts` and android `ui/home/WeatherRisk.kt`),
so the phone and the browser cannot disagree about whether it is safe to walk.

Two failures the clients must surface rather than swallow: `failed-precondition`
`weather_location_not_set` (Settings holds no service area; both mirrors turn
this one into a sentence naming Settings rather than showing the raw code) and
`geocode_failed`. Everything else is reported verbatim. NO EXTERNAL SECRET IS
OUTSTANDING: api.weather.gov is keyless, and the `MAPBOX_ACCESS_TOKEN` used to
geocode the service area once and cache it is the same one `optimizeRoute`
already runs on.

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
- req `{ familyId: string, kinfolkName?: string, invoiceNumber: string, client?: string, address?: string, date?: string, terms?: string, dueDate?: string, discount?: string, total: number, amountDue: number, status?: string, sessionIds?: string[], lineItems?: Array<{ description: string /* 1..200 */, qty: number /* >0, <=999 */, unitCents: number /* int 0..10_000_000 */, discountCents?: number /* int >=0 */ }> /* max 100 */, invoiceDiscountCents?: number /* int >=0 */, idempotencyKey?: string /* #825, `inv_<millis>_<suffix>`; becomes the `invoices/{key}` document id, and a replay never reaches the number counter */ }`
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

### createQuote
- req: identical to `createInvoice` (including optional `lineItems` and
  `invoiceDiscountCents`), plus `sendToKinfolk?: boolean` (default false) and
  `idempotencyKey?: string` (#825), shaped `quot_<millis>_<suffix>` rather than
  `createInvoice`'s `inv_`: both callables write the same `invoices`
  collection, and a distinct prefix is what stops a key minted for one from
  answering at the other.
- res `{ ok: true, invoiceId: string }`
- A quote is NOT a separate model, it is an invoice in QUOTE status. The caller's
  `status` is IGNORED: the server always stamps `status: 'quote'` (lowercase
  since the state stamp; the admin chip still renders 'QUOTE' because it derives
  from the classifier, which lowercases), so no client can mint a quote that
  fails to read as one.
- `sendToKinfolk: true` dispatches the issued-quote notification immediately.
- `lineItems` and `invoiceDiscountCents` are ADDITIVE, with the same semantics as
  `createInvoice`: omit them and the caller's `total` / `amountDue` are stored
  verbatim; supply them and the server owns the money, refusing a disagreement
  rather than silently dropping the lines. Fixed issue #118.
- Audit `BILLING_QUOTE_CREATED`, payload carrying `itemized`, `lineCount`, and
  `sendToKinfolk`.

### acceptQuote / denyQuote
- req `{ invoiceId: string, kinfolkId?: string }` (both)
- res `{ ok: true, invoiceId: string, status: InvoiceState }` (both)
- THE HOUSEHOLD'S ANSWER TO A QUOTE, and the only emitters of the
  `quote.accepted` / `quote.denied` catalog keys. Until 2026-08-18 neither
  callable existed: the catalog carried both keys, `createQuote`'s header
  claimed the flow was "handled elsewhere", and nothing anywhere emitted
  either. Issue #385.
- Auth: the caller must be the household's PRIMARY member
  (`requireKinfolkPrimary`, the same gate `payInvoice` and `redeemCredit` use)
  and the invoice's `kinfolkId` must be one of theirs, or `permission-denied`.
- The decision is recorded on the invoice as `quoteDecision`
  (`accepted` | `denied`), `quoteDecidedAt`, `quoteDecidedByUid`, inside ONE
  transaction that re-reads `quoteDecision` first, so two racing taps cannot
  both land.
- ACCEPT re-stamps the doc: `status` / `invoiceStatus` move off `quote` and the
  Invoice State Classifier decides what they become (normally `open`, or `zero`
  for a quote billed at nothing). That is what makes the invoice payable.
- DENY leaves `status: quote` on purpose. `cancelled` means the OPERATOR
  withdrew a bill, which is a different fact, and it would also drop the row out
  of every `getMyInvoices` bucket, off the household's screen as the immediate
  result of their own tap.
- Refusals, all `failed-precondition` with a `details.code`:
  `quote_not_a_quote` (the doc is not in QUOTE status),
  `quote_already_decided` (a decision is terminal; a revision is a NEW quote via
  `createQuote`), `quote_expired` (accept only, when the quote's `dueDate` has
  passed in the business's own time zone: a quote is good THROUGH its due day,
  and an undated quote never expires). Declining an expired quote is allowed.
- Audit `BILLING_QUOTE_ACCEPTED` / `BILLING_QUOTE_DENIED`, actorRole `PRIMARY`.
  The notification is best-effort: a dispatch failure is logged and swallowed,
  so a notification outage cannot undo a decision that was already recorded.

### markInvoicePaid
- req `{ invoiceId: string /* 1..200 */, amount?: number /* DOLLARS, MAY BE PARTIAL; defaults to what the recorded payments leave outstanding */, method?: string /* 1..200 */, reference?: string /* 1..200 */, paidAt?: string /* ISO-8601, defaults to now */, idempotencyKey?: string /* #825, `ipay_<millis>_<suffix>`; becomes the id of the `invoices/{invoiceId}/payments/{key}` row, so a retried PARTIAL lands once */ }`
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
- req `{ amount: number /* DOLLARS, float, the legacy shape of this collection. THE WHOLE TRANSACTION, gross tip included */, kinfolkId?: string /* <=120, default '' */, kinfolkName?: string, client?: string, address?: string, date?: string /* free text */, paymentMethod?: string, referenceNumber?: string, email?: string, tip?: number /* default 0. GROSS: what the client tipped, BEFORE the processor fee */, fee?: number /* default 0. The processor's cut, off the business's proceeds. NOT part of amount */, notes?: string /* STAFF ONLY */, invoiceId?: string /* '' = standalone payment. A DISPLAY LINK, never an apply */, invoiceNumber?: string, apply?: { invoiceId: string, invoiceNumber?: string, amount: number } /* the "Apply: $" box. ONE invoice; omitted = no balance is touched */, autoApply?: boolean /* default false */, sendConfirmationEmail?: boolean /* default false */, idempotencyKey?: string /* #825, `pay_<millis>_<suffix>`; becomes the `payments/{key}` row id, so a retry records neither a second payment nor a second account credit */ }` (every `?` defaults to `''`/`0`/`false`; `apply` and `idempotencyKey` are omitted, not defaulted)
- res `{ ok: true, paymentId: string, kinfolkId: string /* what was actually stored; the sandbox id for a test admin */, amountCents: number, tipCents: number, feeCents: number, tipBasis: 'gross'|'net'|'unknown', appliedCents: number, unappliedCents: number /* SIGNED */, proceedsCents: number, tipNetCents: number /* SIGNED */, autoApply: boolean, application: { invoiceId, invoiceNumber, paymentId, appliedCents, state, totalCents, paidCents, amountDueCents, overpaidCents }|null, creditedToAccountCents: number, confirmationEmailSent: boolean }`
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
- **THE FEE TRANCHE, 2026-08-04.** The operator is paid through Venmo/PayPal and
  is charged a processor fee she takes out of the tip. Nothing here stored a fee,
  so invoice #1029 reads Amount $137.50, Applied $127.50, Tip $7.29 and cannot be
  made to add up: $2.71 is a fee nobody recorded. Operator ruling: *"store both,
  and display the latter. itll help with taxes"*: the gross tip is income and
  the fee is a deductible expense.
  - `tip` KEEPS ITS NAME AND CHANGES ITS MEANING to the GROSS tip. Safe only
    because the server now stamps `tipBasis: 'gross'` beside it. **ABSENT
    `tipBasis` READS AS `'unknown'`, NEVER AS `'net'`**: this collection was
    written by a legacy migration, by `stripeWebhook.ts` and by this callable
    before today, so absence is not evidence. No gross is ever back-computed
    from a net tip whose fee was dropped; it cannot be.
  - The doc stores BOTH denominations (`fee` + `feeCents`, `tipCents`,
    `amountCents`) the same way `markInvoicePaid`'s subcollection row does.
  - The identity: `amount = applied + tipGross + unapplied`. The fee is NOT in
    it. It comes off `proceedsCents`, on the business's side of the ledger.
  - `apply` IS THE ONLY THING THAT MOVES AN INVOICE BALANCE, and it names ONE
    invoice (operator ruling, 2026-08-04: *"this is not something i want"*, on
    being offered a multi-invoice split). It writes the same
    `invoices/{id}/payments` row `markInvoicePaid` writes, plus
    `sourcePaymentId`, in the SAME BATCH as the payment row. `invoiceId` is
    still only a display link: the React admin sets it on a row it writes AFTER
    `markInvoicePaid` has settled the invoice, and applying there would collect
    twice.
  - `autoApply` puts the unapplied remainder into
    `families/{kinfolkId}.accountBalanceCents`, the EXISTING credit ledger
    `redeemCredit` fills and the portal already renders, not a new one, and
    `onInvoiceAutoApply` spends it on the next collectable invoice.
  - `sendConfirmationEmail` enqueues the EXISTING `invoice.payment.applied`
    notification. No new catalog key: a second key for the same event would give
    the household two switches for one message. Best-effort and reported
    honestly in `confirmationEmailSent`; the money has already landed, so a
    throw here would offer a retry that collects again.
  - Refuses `tip_exceeds_amount` (`invalid-argument`) and every `apply_*` code
    (`failed-precondition`) BEFORE writing anything.
- req `{ invoiceId: string /* 1..200 */ }` (`.strict()`)
- res `{ ok: true, invoiceId: string, skipped: ''|'invoice_missing'|'invoice_not_collectable'|'no_household'|'no_credit', appliedCents: number, amountDueCents: number, accountBalanceCents: number }`
- Spends a household's ACCOUNT CREDIT on one named invoice, now. The on-demand
  half of *"will automatically apply any Unapplied amount to future invoices"*;
  `triggers/onInvoiceAutoApply.ts` runs the same pass by itself when an invoice
  BECOMES collectable.
- **IT EXTENDS THE EXISTING CREDIT MECHANISM RATHER THAN ADDING ONE.**
  `families/{id}.accountBalanceCents` was already written by `redeemCredit`, read
  by `getMyInvoices` and rendered by the portal, and never spent by anything.
  This is the consumer that closes that loop. See `lib/accountCredit.ts`.
- `skipped` IS NOT AN ERROR CHANNEL. Every value is a normal outcome ("no credit
  on file", "already settled"). It throws only `not-found` for an unknown invoice
  and `permission-denied` for a sandbox admin reaching outside their tribe.
- IDEMPOTENT: the balance is decremented as it is spent, so a second run finds
  nothing. NEVER overdraws and never creates an overpayment: the draw is the
  smaller of what is owed and what is held.
- Refuses the same invoices `markInvoicePaid` does (draft, quote, cancelled,
  credit, already settled), by importing its guards rather than restating them.

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
- res `{ invoiceId: string, payments: Array<{ paymentId: string, amountCents: number, method: string|null, reference: string|null, paidAt: string|null /* ISO */, recordedBy: string|null, sourcePaymentId: string|null /* the ROOT payments row an apply came in on */ }>, paidCents: number, totalCents: number, amountDueCents: number, ledgerPayments: Array<{ paymentId: string, amountCents: number /* gross tip INCLUDED */, amountResolved: boolean /* false = the units could not be read; the 0 is a floor, not a figure */, tipCents: number /* GROSS when tipBasis says so */, feeCents: number, tipBasis: 'gross'|'net'|'unknown', reconciles: boolean /* false = a migrated row whose fee was dropped */, appliedCents: number, unappliedCents: number /* SIGNED */, proceedsCents: number, autoApply: boolean, appliedInvoiceId: string, appliedInvoiceNumber: string /* the "Applied to #n" column */, method: string, reference: string, date: string /* FREE TEXT */, notes: string /* STAFF ONLY */, recordedBy: string|null }>, unlinkedKinfolkPayments: Array<{ /* same row shape as ledgerPayments */ }>, unresolvedAmountCount: number /* rows with amountResolved: false, across BOTH root lists */, sessions: Array<{ sessionId: string, serviceType: string, status: string, startTime: string /* ISO */, completedAt: string|null, durationMinutes: number|null, linkedBack: boolean }>, missingSessionIds: string[], orphanSessionIds: string[], truncated: boolean }`
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
  - `unlinkedKinfolkPayments` is ROOT `payments` rows for the same HOUSEHOLD
    that name NO invoice at all — money that arrived and no bill claims. Same
    row shape as `ledgerPayments`, counted in NOTHING, and NOT this invoice's
    payments. Queried by `kinfolkId` with the blank test done IN MEMORY, because
    `where('invoiceId','==','')` skips docs missing the field and a legacy
    import row is exactly that shape. Empty when the invoice names no household,
    rather than degenerating into an unfiltered scan.
  - It exists so the STAFF ANDROID invoice screen can stop reading the root
    `payments` collection directly. It built the same list itself, in Kotlin,
    off a `Payment.amount` whose dollars-or-cents meaning lives in a sibling
    `amountSource` field the Kotlin model does not carry — so a $137.50 Stripe
    payment printed as $13,750.00 there for months after `resolveLedgerAmountCents`
    fixed the web ledger. A client that never calls the resolver cannot apply it.
    Android shows this list under a visible "NOT INVOICE-LINKED" warning and only
    when `ledgerPayments` is empty; the React panel does not render it.
  - Both ship because a Stripe card payment lands ONLY in the root ledger. A
    panel rendering the subcollection alone would report a settled invoice as
    having no payment at all; a panel rendering the ledger alone presents a
    display record as the money.
- **AN UNREADABLE ROW IS FLAGGED, NEVER GUESSED**, the same rule `listPayments`
  ships against the same reader. `resolveLedgerAmountCents` returns
  `{ amountCents: 0, resolved: false }` for an `unresolved` Stripe event or an
  `amount` that is not a usable number; the row now ships `amountResolved:
  false`, the response ships `unresolvedAmountCount` across BOTH root lists, and
  the handler still emits one `ledger.amount.unresolved` warn per invoice. The
  warn shipped alone at first, on the claim that there was nowhere non-breaking
  in this response to put a per-row flag — `listPayments` disproved that, and
  meanwhile both staff surfaces printed `$0.00` on rows nobody could read.
  Neither does now: the React table's Amount cell and Android's payment row say
  the figure could not be read, and the React panel's caveat banner names the
  rows.
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

### listPayments
- req `{ limit?: number /* int 1..500, default 100 */, startAfterId?: string /* 1..200, the previous page's nextCursor */ }` (`.strict()`)
- res `{ payments: Array<{ paymentId: string, kinfolkId: string, kinfolkName: string, amountCents: number /* gross tip INCLUDED, units RESOLVED server-side */, amountResolved: boolean /* false = the units could not be read; the 0 is a floor, not a figure */, tipCents: number, feeCents: number, tipBasis: 'gross'|'net'|'unknown', reconciles: boolean, appliedCents: number, unappliedCents: number /* SIGNED */, proceedsCents: number, autoApply: boolean, invoiceId: string, invoiceNumber: string, appliedInvoiceId: string, appliedInvoiceNumber: string, method: string, reference: string, date: string /* FREE TEXT, '' on a Stripe row */, notes: string /* STAFF ONLY */, recordedBy: string|null }>, truncated: boolean, nextCursor: string|null, unresolvedAmountCount: number }`
- Read only. No `ok` field, same as `getInvoiceLedger` and
  `listUninvoicedSessions`.
- **THE ROOT `payments` COLLECTION, ACROSS HOUSEHOLDS.** `getInvoiceLedger`
  answers "what was paid against THIS invoice" and is per-invoice by
  construction — its request is `{ invoiceId }` and its handler opens by reading
  that invoice — so an id-less mode would be exactly the unfiltered scan it
  declines for a household-less invoice. This is a different question and it is
  a different callable; the two share the unit rule
  (`lib/paymentMoney.ts#resolveLedgerAmountCents`), which is the part that must
  not be duplicated.
- **IT EXISTS SO THE STAFF ANDROID PAYMENT LIST CAN STOP READING THE COLLECTION
  DIRECTLY.** `AdminDataViewModel.loadPayments` called
  `InvoiceRepository.getPayments()`, a raw `scopedQuery("payments")`, into a
  `Payment` model with neither `amountCents` nor `amountSource` — so a
  `stripe-event` row's already-cents `amount` was unreadable there in principle
  and any screen rendering it would have been 100x out. No composable collected
  that flow, so nothing shipped wrong; the trap was that the first one to
  collect it would inherit the defect silently.
- **ORDERED AND CURSORED BY DOCUMENT ID, never by a date, and that is forced.**
  `date` is `FieldValue.serverTimestamp()` on `stripeWebhook.ts` rows and the
  operator's free text on `recordPayment.ts` rows, and Firestore orders by TYPE
  first, so `orderBy('date')` sorts by writer rather than by when the money
  arrived. `createdAt` exists only on `recordPayment.ts` rows and `orderBy`
  drops documents missing the field, so it would silently omit every Stripe and
  legacy row. Document id is on every document by construction — the same
  reasoning `repairInvoicePayments` states for its sweep.
- **`truncated` IS A FACT, NOT AN INFERENCE.** The handler reads `limit + 1`
  documents and returns `limit`; the extra one is never projected. `nextCursor`
  is non-null exactly when `truncated` is true. This is deliberately unlike
  `getInvoiceLedger.unlinkedKinfolkPayments`, which bounds its read and has no
  field that can say so.
- **AN UNREADABLE ROW IS FLAGGED, NEVER GUESSED.** `resolveLedgerAmountCents`
  returns `{ amountCents: 0, resolved: false }` for an `unresolved` Stripe event
  or an `amount` that is not a usable number; the row ships `amountResolved:
  false`, the page ships `unresolvedAmountCount`, and the handler emits one
  `payments.amount.unresolved` warn per call. A client rendering `$0.00` without
  reading the flag is stating something nobody checked.
- **NO `client`, `address` OR `email`**, though the collection stores all three.
  They are household PII, nothing renders them off this list, and
  `kinfolkId`/`kinfolkName` already identify whose money a row is. Adding a
  field later is additive; un-publishing one is not.
- GATE: `resolveInvoiceWriteActor`, the ADR-0002 invoice-surface gate, same as
  `getInvoiceLedger` and `recordPayment`. Staff pass unscoped; a TEST ADMIN
  passes and the query is constrained to `kinfolkId == testTribeId` server-side.
  `wrapAdminCallable` would refuse a token `firestore.rules` already grants a
  direct read of these documents, making the callable narrower than the client
  read it replaces. An equality filter plus `orderBy(documentId())` needs no
  composite index.
- Errors: `invalid-argument` on a malformed request (the schema is `.strict()`,
  so an extra key is refused rather than dropped, and a blank `startAfterId` is
  refused rather than silently restarting the page loop).
- Mirrors: `InvoiceRepository.listPayments` on Android. No React mirror: no web
  surface renders this list. Types come from the generated contracts module.

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
  kintales_only, home_access: boolean },
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
- **`requiresAuntieAck` is gone from this response** (2026-08-01). It was set true
  only when an invite carried `billing_full`, and NOTHING ever performed the
  acknowledgement or read the flag as a gate: `acceptInvite` applied
  `proposedPermissions` verbatim either way. Per the operator ruling a household
  PRIMARY may grant a SECONDARY any permission except admin, billing included, so
  no acknowledgement is owed. Removed rather than enforced, because a field that
  means nothing invites a later reader to "fix" it by building the gate the
  operator does not want. Documents written before the change still carry the
  field; the projection drops it.

### listAllInvites (Wave 1 item 3, net-new 2026-08-09)
- req `{ limit?: number /* int 1..500, default 200 */ }` — no household argument,
  deliberately: this IS the every-household read.
- res `{ invites: Array<listInvites row & { householdName: string }>, scanned: number,
  households: number }`
- GATE: `wrapAdminCallable`, same as `listInvites`. There is no kinfolk path and
  there could not be one: a household reading every other household's invites is
  the tenancy breach the gate exists to prevent.
- Errors: `invalid-argument` with `details.validationErrors` for a bad `limit`.
  There is no `not-found`, because there is no id to get wrong.
- **The row projection is `listInvites`'s, imported not restated.**
  `mapInviteDoc` and `sortInvitesNewestFirst` are shared, so `effectiveStatus`
  and `redeemable` have one implementation and cannot drift between the two
  callables. `householdName` is the ONLY added field.
- **`householdName` is computed server-side, and is never blank.** `tribeId`
  alone is unreadable in a list spanning every household. The React admin has
  `householdLabel` in `src/api/directory.ts`, but Android has no port of it (the
  only Kotlin copy is in the superseded `web/composeApp` tree), so client-side
  derivation would mean a third and fourth copy of the sibilant-plural rule
  ("Brooks" -> "the Brookses"). Same argument `effectiveStatus` makes: the
  server does it once. Fallbacks are LOUD and name the id —
  `(household not found: <id>)` when the `kinfolk` doc is gone,
  `(unnamed household: <id>)` when it exists with no name,
  `(invite carries no household id)` when the invite itself has no `tribeId`.
  An orphaned invite is exactly the row the operator needs, so it is kept and
  labelled rather than filtered out for want of a name.
- One `getAll` per DISTINCT household, not one read per invite.
- Unfiltered query capped by `limit`, then sorted newest-first in memory. No
  composite index, same as `listInvites`. `scanned` is the pre-sort row count, so
  a capped page is distinguishable from a total.
- **`inviteId` is a bearer token**, exactly as under `listInvites`. It reaches
  neither `logEvent` nor the audit payload here (counts only), and no client may
  render or offer to copy the claim URL.
- Read only apart from one best-effort `OPERATOR_CROSSTENANT_ACCESS` audit entry.
  That entry carries NO `familyId`: the read spans every household, and naming
  one of them would misreport its scope.
- Mirrors: `auntieos-admin/src/api/members.ts#listAllInvites` +
  `src/screens/Invites.tsx`; Android `MembersRepository.listAllInvites` +
  `ui/members/InvitesScreen.kt`. The three move together.
- **This screen mints nothing.** Per the invite ruling the admin's only invite is
  inviting a PRIMARY to the portal, which is household-scoped; the PRIMARY
  invites the secondary from MyTribe. An admin-wide surface has no household to
  mint into, and must never grow a button that pretends otherwise.

### listRecoveryCandidates (net-new 2026-08-18, issue #378)
- req `{ familyId: string, oldUid?: string }`
- res `{ candidates: Array<{ uid, email, secondaryLabel: string | null, role, status }> }`
- GATE: `wrapAdminCallable`. Recovery is an operator action end to end; there is
  no kinfolk path.
- **The list `executePrimaryRecovery` will accept, and the same code answers
  both.** `src/lib/recoveryCandidates.ts` is imported by the gate and by this
  read, so a dialog built on this cannot offer a choice the execute call then
  refuses.
- Eligible means: a member doc on `families/{familyId}/members` that is not
  SUSPENDED, whose Firebase Auth account exists and has `emailVerified === true`,
  and whose uid is not `oldUid`. `email` is the AUTH account's address,
  lowercased — never the member doc's `email` field, which is whatever was typed
  at invite time and proves nothing.
- A member with no Auth account is skipped rather than fatal: one stale roster
  row must not make a household unrecoverable.
- An empty array is a real answer, not an error. It means nobody on the
  household can safely be handed it yet.
- Read only apart from one best-effort `OPERATOR_CROSSTENANT_ACCESS` audit entry,
  the same one `listInvites` writes for its household-scoped read. Counts only,
  no addresses. This answers more than the roster does (which addresses Auth
  considers verified), so it is audited rather than treated as free.
- Mirrors: `auntieos-admin/src/api/members.ts#listRecoveryCandidates` +
  the recovery dialog in `src/screens/HouseholdMembers.tsx`. No Android mirror
  yet; Android has no recovery surface to mirror it into.

### executePrimaryRecovery (pre-existing; destination gated 2026-08-18, issue #378)
- req `{ familyId: string, newEmail: string, oldUid?: string, recoveryRequestId?: string }`
- res `{ inviteId: string }`
- GATE: `wrapAdminCallable`.
- **`newEmail` is a closed set, not a typed address.** It must match a
  `listRecoveryCandidates` entry for the same `familyId`/`oldUid`. Anything else
  is `failed-precondition`, with a message naming the eligible addresses (or,
  when there are none, the step that creates one). This is the only send in the
  system that GRANTS an account rather than describing one — the mail carries a
  claim URL into a pre-stamped `EMAIL_SENT` invite holding `FULL_PERMISSIONS` —
  so a typo or a stolen session used to be enough to hand over a household,
  billing included. There is deliberately no flag or override that restores the
  old behaviour.
- **A refused call writes nothing.** The old PRIMARY's suspension now happens
  after the gate, not before it, so a rejection suspends nobody, mints no invite
  and sends no mail.
- Audit: `AUTH_RECOVERY_TRIGGERED` at `severity: 'critical'` either way.
  `status: 'SUCCESS'` when the link went out, `status: 'FAILURE'` with
  `payload.reason: 'not_a_verified_household_member'` when it was blocked, so a
  refused attempt is as visible in review as a completed one.
- The mail and the invite doc both carry the resolved Auth address, so they
  cannot disagree about which inbox holds the household.
- Mirrors: `auntieos-admin/src/api/membersWrite.ts#executePrimaryRecovery` +
  `src/screens/HouseholdMembers.tsx`.

### acceptInvite (pre-existing, verification added 2026-08-01)
- req `{ inviteId: string }`
- res `{ familyId: string }`
- GATE: `wrapCallable`. The caller's token email must equal `invitedEmail`, AND
  **the token must carry `email_verified === true`**.
- Errors: `not-found` for an unknown invite; `failed-precondition` for a
  revoked / expired / consumed invite AND for an unverified email;
  `permission-denied` for an email mismatch. The revoked check runs BEFORE the
  email check, so the two codes together cannot tell a stranger whether they
  guessed the invited address.
- **Email verification (RULING: "secondary needs email verification as well").**
  `firestore.rules` already required a verified email to so much as READ an
  `inviteRequests` doc (WARNING-17), while this callable handed out household
  membership on the strength of the same unproven address. The two now agree.
  - A brand-new invitee is unaffected: `claimInviteSignup` mints the account with
    `emailVerified: true`, so their very first token already passes.
  - An invitee who ALREADY holds an unverified Firebase account is refused, and on
    the way out the callable mints a verification link
    (`generateEmailVerificationLink`) and mails it to the INVITED address through
    the `invite.verify-email` template. The message names the address and says
    what to do; it is not a bare denial. Rate-limited 5/hour per uid and per
    address, and a send failure is swallowed so the refusal stays
    `failed-precondition` instead of becoming an opaque `internal`.
  - A refused accept writes NOTHING: no member doc, no `clients` arrayUnion, no
    invite flip. The invite stays redeemable for its full TTL.
  - **Clients MUST force an ID-token refresh before retrying.** Clicking the
    verification link flips the Firebase user record, but a token minted earlier
    still carries `email_verified: false` for up to an hour, so a plain retry is
    refused again and reads as a broken verification link.
  - Needs `SMTP2GO_API_KEY` + `EMAIL_FROM` (already created, already bound to the
    other invite functions) and the `invite.verify-email` document in the
    Firestore `emailTemplates` collection. The operator edits email templates in
    the admin UI; there is no seed script for them (operator ruling 2026-09-13, #847).

### mintInvite (PRIMARY-only since 2026-08-04)
- req `{ familyId: string, invitedEmail: string /* email */, proposedRole?: 'PRIMARY' }`
- res `{ inviteId: string }`
- GATE: `wrapAdminCallable`.
- **This mints a PRIMARY claim and nothing else.** RULING: the primary kinfolk
  invites the secondary; the admin does not, and the admin's only invite is
  inviting the primary to the portal. The secondary path is
  `addSecondaryContact`, called by the primary from the portal.
- `proposedRole` is a `z.literal('PRIMARY')`, defaulted. Sending `'SECONDARY'`
  is `invalid-argument`, deliberately: it used to be the DEFAULT, and silently
  upgrading such a call to a PRIMARY claim would hand out the larger grant of
  the two without the caller asking.
- `proposedPermissions` and `secondaryLabel` were removed from the schema
  2026-08-04. Both are still accepted-and-ignored (non-strict `z.object`) so an
  older client keeps working. The doc is written with `FULL_PERMISSIONS`, the
  same set `inviteKinfolkToPortal` writes for the same grant: a PRIMARY's
  entitlements come from the role (`requirePerm` returns before it reads the
  flags), and `acceptInvite` copies `proposedPermissions` verbatim onto the
  member doc, so a restricted set only ever produced a primary who READ as
  restricted on the roster.
- Writes one `inviteRequests` doc with an `INVITE_TTL_DAYS` (14) expiry, sends
  `invite.primary`, flips the doc to `EMAIL_SENT`, and audits
  `MEMBERSHIP_INVITE_SENT`.
- Sibling: `inviteKinfolkToPortal` sends the same grant to the address on the
  `kinfolk` record and skips a household that already has an ACTIVE primary.
  `mintInvite` takes a typed address, for a household whose record carries the
  wrong one or none, and does NOT check for an existing primary.

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
  path is `updateSecondaryPermissions`, which accepts the same five flags.
  `wrapAdminCallable` gates the WHOLE callable, every flag alike; it has never
  been a `billing_full`-specific control and is not one now. It says who may use
  the operator console, not what a household PRIMARY may grant.
- Errors: `not-found` when `families/{familyId}/members/{targetUid}` does not
  exist; `failed-precondition` (`target not SECONDARY`) when the target is the
  household's PRIMARY.
- **The target must be a SECONDARY** (guard added 2026-08-04, matching
  `updateSecondaryPermissions`). RULING: "admin can edit permissions but not
  like primary's access to full billing, home access, kin edit, etc." A
  PRIMARY's entitlements are inherent to the role: `requirePerm` and
  `hasKinfolkPerm` both answer for a PRIMARY before they read `permissions`. A
  write against a PRIMARY therefore moved a field no enforcement path consults,
  while the audit log recorded a billing revocation that never took effect.
  Clients must render a primary's entitlements as granted by role, not as
  toggles.
- **`kintales_only` is not in the argument schema at all**, so no caller on any
  path can turn it off. Clients render it locked on.
- Every key present is a field-level merge (`permissions.<k>`), so a partial
  object is the normal call. Each flag is audited separately; `billing_full` uses
  `PERM_BILLING_GRANTED` / `PERM_BILLING_REVOKED` at severity `warn`, everything
  else `PERM_GRANTED` / `PERM_REVOKED` at `info`.
- Cannot escalate the caller: it writes only household member permission flags
  under `families/*`, and admin authority is the `admin` custom claim, which this
  callable never reads or writes. There is no path from here to staff access.

### updateSecondaryPermissions (pre-existing, `billing_full` added 2026-08-01)
- req `{ familyId: string, targetUid: string, permissions: { billing_full?, messaging_direct?, messaging_group?, kin_edit?, home_access?: boolean } }`
- res `{ ok: true }`
- GATE: `wrapCallable`, then `isStaff` OR (`loadMember` + `requirePrimary`). The
  target must be an ACTIVE member whose role is SECONDARY, so a PRIMARY has no
  self-target here at all.
- Errors: `permission-denied` for a non-primary non-staff caller, or a missing /
  inactive member doc; `failed-precondition` when the target is not a SECONDARY.
- **`billing_full` is accepted** (RULING: "Primary kinfolk is allowed to set the
  permissions of the secondary, including billing if they want ... besides admin,
  primary kinfolk can set permissions for the secondary"). It was previously
  absent from the schema, and because the schema is a non-strict `z.object` a
  caller who sent it got `{ ok: true }` with no write and no audit entry: neither
  honoured nor refused. `home_access` was already accepted here; `firestore.rules`
  was the half of that disagreement that was wrong, and has been relaxed to match.
- **`kintales_only` is still not in the schema**, matching `setMemberPermissions`,
  every mint path, and the rules. No caller on any path turns it off.
- Field-level merges (`permissions.<k>`), so a partial object is the normal call.
  Each flag is audited separately, and `billing_full` uses `PERM_BILLING_GRANTED`
  / `PERM_BILLING_REVOKED` at severity `warn` exactly as `setMemberPermissions`
  does, so "who gave this secondary billing" is one query across both callables
  rather than two.
- Cannot escalate anyone: it writes only `permissions.*` under
  `families/{familyId}/members/{targetUid}`. `role` and `status` are not in the
  schema, there is no `admin` member permission, and admin authority is the
  `admin` custom claim, which this callable never reads or writes.

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

### listHouseholdContacts / saveHouseholdContact / removeHouseholdContact (net-new 2026-09-12)

A household's secondary CONTACTS: people it can be reached through who hold no
portal account. Operator ruling, 2026-09-12, verbatim: "a secondary contact does
not have to be a portal user. primary kinfolk user will invite a second kinfolk
to the household to manage and receive notifications." Two actions with two
outcomes, and until these three the codebase had only the second:
`addSecondaryContact` is named for the contact and mints an invite.

A contact is NOT a member and NOT an invite. It has no uid, no role, no
`MemberPermissions` and no `inviteRequests` row, because there is nothing for it
to sign in to and so nothing to authorise. Stored at
`families/{kinfolkId}/contacts/{contactId}`, which `firestore.rules` closes to
every client in both directions: these callables are the only door.

- `listHouseholdContacts`
  - req `{ kinfolkId?: string }`
  - res `{ contacts: Array<{ contactId: string, name: string, label: string,
    phone: string | null, email: string | null, createdAt: string | null /* ISO-8601 */,
    updatedAt: string | null }> }`, sorted by name.
  - A stored row with no `name` reads `(unnamed contact)` rather than being
    dropped: the operator has to be able to see a half-written record in order
    to fix or delete it.
- `saveHouseholdContact`
  - req `{ kinfolkId?: string, contactId?: string, name: string /* 1..80 */,
    label?: string | null /* <= SECONDARY_LABEL_MAX (24), default "Folk" */,
    phone?: string | null /* <= 32 */, email?: string | null /* valid address, lowercased */ }`
  - res `{ contactId: string, created: boolean }`
  - `contactId` absent CREATES; present EDITS that contact, and answers
    `not-found` when it is not on this household.
  - `''` and `null` mean the same thing on the way in and BOTH persist as
    `null`, so a stale phone number can actually be cleared. An edit writes the
    four editable fields plus `updatedAt`/`updatedBy` and never resends
    `createdAt`/`createdBy`, so it cannot rewrite a record's provenance.
- `removeHouseholdContact`
  - req `{ kinfolkId?: string, contactId: string }`
  - res `{ ok: true }`
  - HARD, unlike `removeMember`: no account to suspend, no sign-in history to
    keep, so the row is gone and none is left behind.
- GATE, all three: `wrapCallable` + `resolveKinfolkAccess` +
  `requireKinfolkPrimary`, the same pair `listMembers` and `addSecondaryContact`
  use. Staff or the household PRIMARY; an ACTIVE SECONDARY is denied. Secrets
  `SENTRY_DSN` and `AUNTIE_OPERATOR_UIDS` (the second because `isStaff` reads it,
  and without it an allowlisted operator with no `admin` claim is denied in
  production while every unit test passes).
- EVERY ARGUMENT SCHEMA IS `.strict()`. A caller sending `permissions`,
  `invitedEmail`, `role` or `uid` is refused with `invalid-argument` naming the
  key, rather than having it silently stripped. That refusal is the wall between
  a contact and an invite, and it is enforced here rather than only in a screen.
- NEVER LOGGED: a contact's name, phone or email. `logEvent` carries the
  household id, the contact id and counts, matching `listMembers`' refusal to
  surface `displayName`.
- Clients, ADMIN: `auntieos-admin/src/api/householdContacts.ts` (web) and
  `MembersRepository.listHouseholdContacts / saveHouseholdContact /
  removeHouseholdContact` (Android). Both drive the household members screen.
- Clients, PORTAL (#818, the household keeping its own list):
  `mytribe/web/src/api/tribeApi.ts` and `PortalApi.listHouseholdContacts /
  saveHouseholdContact / removeHouseholdContact` (Android). Both drive the
  "Contacts Without an Account" card on the Tribe Profile screen, directly under
  "Invite a Kinfolk" so the two gestures read apart. `kinfolkId` is OPTIONAL from
  the portal and required from the admin: the admin always targets a household it
  picked off a list, while a household targets itself and the server resolves it
  from `clients/{uid}.kinfolkIds`. THE GATE WAS NOT WIDENED for the portal: an
  ACTIVE SECONDARY is still denied on all three. The portal card therefore reads
  `permission-denied` for what it is and says the primary keeps the list, rather
  than drawing a broken panel over a working server.

### saveTribeProfile / saveHomeAccess: `customFields` merge by key (#873)
- `saveTribeProfile`
  - req `{ kinfolkId?: string, displayName?: string /* 1..120 */, customFields?: CustomField[] /* max 40 */, removeCustomFieldKeys?: string[] /* 1..80 each, max 40 */ }`
  - res `{ ok: true, emergencyContactIgnored?: true }`
  - writes `families/{kinfolkId}.displayName` / `.customFields`
- `saveHomeAccess`
  - req `{ kinfolkId?: string, gateCode?: string | null, keyLocation?: string | null, wifiPassword?: string | null, customFields?: CustomField[] /* max 40 */, removeCustomFieldKeys?: string[] /* 1..80 each, max 40 */ }`
  - res `{ ok: true }`
  - writes `families/{kinfolkId}/homeAccess/current`
- `CustomField` `{ key: string /* 1..80 */, label: string /* 1..80 */, value: string /* <= 1000 */ }`
- MERGE, NEVER REPLACE. Until #873 both callables replaced `customFields` whole. The portal clients, in schema mode, rebuilt the list from the form schema's keys, so every stored row outside the schema (office-set rows shown as "Set by your Auntie", rows from an older schema, hand-added rows) was deleted on the household's next save. Now (`src/lib/customFieldsMerge.ts`):
  - a sent row replaces the stored row with the same key, in the stored row's position; later stored copies of that key fold into it;
  - a sent key with no stored row is appended, in sent order; a key sent twice, the last copy wins;
  - a stored row the client did not send is kept as stored, value and position;
  - a sent `value: ''` is a real clear: the row stays with an empty value. A sent `''` for a key with no stored row writes nothing, so an old client's untouched, never-set schema field no longer lands as an empty row;
  - a stored row is deleted ONLY when its key is in `removeCustomFieldKeys`. Omitting a row never deletes it;
  - a stored entry with no string `key` is carried through verbatim.
  - A key both sent and named for removal is refused with `invalid-argument` and nothing is written.
- OLD CLIENTS are safe by construction: they never send `removeCustomFieldKeys`, so the worst an old schema-mode client can do is overwrite the rows it sends. What they lose: an old client that blanks a vet or after-hours card field omits that row, and the omission no longer deletes it. The row stays until a current client saves. That is the safe direction for a data-loss fix.
- `''` IS A CLEAR, NOT A NO-OP, because both old clients seed their schema form from every stored row: an untouched field echoes its stored value, and only a field the household emptied arrives as `''`. Treating `''` as "leave it" would silently undo those clears under "Saved.".
- CLIENTS send the stored rows in order with only their own edits applied, name every blank card field that has a stored row in `removeCustomFieldKeys`, and never send an untouched schema field with no stored row as `''`. The full list (not a diff) is sent so the same payload is also right against a server that still replaces the list whole. Web `editCustomFields` / `schemaFieldRow` in `mytribe/web/src/api/tribeApi.ts`; Android `editCustomFields` / `schemaFieldRow` in `TribeScreen.kt` and the `removeCustomFieldKeys` parameter on `PortalApi.saveTribeProfile / saveHomeAccess`.
- EMERGENCY CONTACT ROWS (#829). `saveTribeProfile` strips sent `emergencyContact*` rows (an old client's contact edit goes through the #829 path), keeps the stored copy in place for the migration, and ignores those keys in `removeCustomFieldKeys`. `saveHomeAccess` strips them from what is sent AND from the merged result, as it did when the list was replaced whole: nothing reads a copy there.
- GATE: `saveTribeProfile` `resolveKinfolkAccess` (any household member or staff; contact edits need `home_access`). `saveHomeAccess` `resolveKinfolkAccess` + `requireKinfolkPerm(..., 'home_access')`. Secrets `SENTRY_DSN`, `AUNTIE_OPERATOR_UIDS`.
- Not in `test/callableContract.test.ts`'s frozen set and not in `scripts/contracts/registry.ts`, so there is no generated mirror; `contracts:check` is unchanged.
- Already-lost rows: `scripts/reportTruncatedCustomFields.ts` (read-only). No before-state is recorded (PROFILE_UPDATED audit carries field names only, `saveHomeAccess` writes no audit), so it lists lists that look like the old schema rebuild, with the portal-save evidence for each.

### saveEmergencyContacts / listEmergencyContacts (#829)
- `saveEmergencyContacts`
  - req `{ kinfolkId?: string, contacts: Array<{ name: string /* 1..80 */, phone: string /* valid, stored E.164 */, relationship?: string | null /* <= 40, '' and null persist as null */ }> }` (strict, max 2)
  - res `{ contacts: EmergencyContactDTO[] }`
  - Replaces `kinfolk/{id}.emergencyContacts` whole, index 0 called first. A contact matched by phone, then name, keeps `recordedAt`.
  - Refuses `[]` with `failed-precondition` "A household needs at least one Emergency Contact".
  - Refuses a contact whose phone matches the primary's `phoneNumber`/`secondaryPhone` or any member's `phone`, or whose name matches a member name (case and spacing ignored), with `failed-precondition` "An Emergency Contact has to be someone outside the household."
- `listEmergencyContacts`
  - req `{ kinfolkId?: string }`, res `{ contacts: EmergencyContactDTO[], canEdit: boolean, legacy: boolean }`
  - `legacy: true` means the doc has no array yet and the flat `emergencyContact*` triple was projected as one contact.
- `EmergencyContactDTO` `{ name, phone, relationship: string | null, recordedAt: string | null, updatedAt: string | null }` (ISO-8601)
- GATE: `resolveKinfolkAccess` + `requireKinfolkPerm(..., 'home_access')` for save; any ACTIVE member (or staff, or a legacy primary with no member doc) for list, with `canEdit` from `hasKinfolkPerm(..., 'home_access')`. Secrets `SENTRY_DSN`, `AUNTIE_OPERATOR_UIDS`.
- NEVER a recipient: no audience builder reads these fields (`test/emergencyContactsNeverMessaged.test.ts`). NEVER logged: name or phone.
- Clients: `auntieos-admin/src/api/emergencyContacts.ts`, Android `AuntieRepository.listEmergencyContacts / saveEmergencyContacts`, desktop `FirestoreClient.listEmergencyContacts / saveEmergencyContacts`, `mytribe/web/src/api/tribeApi.ts`, `PortalApi.listEmergencyContacts / saveEmergencyContacts`.

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
- req `{ name: string, phone?: string, address?: string, website?: string, isEmergency?: boolean, acknowledgedMatchIds?: string[] }`
- res `{ status: 'created' | 'needs_choice', clinicId: string, created: boolean, pending: boolean, candidates: Array<{ id, name, address, phone, isEmergency, verified, reason: 'name'|'phone'|'similar' }> }`
- **A NEAR MATCH IS A CHOICE, NOT A SUBSTITUTION** (operator ruling 2026-08-01).
  This used to normalize the name, find the first match, and return THAT
  clinic's id with `created: false`: the caller asked to create and silently got
  someone else's record. Two practices genuinely can share a name in different
  cities, so it could point a household at a different phone number on the
  record read in an emergency.
- On a match the callable returns `status: 'needs_choice'`, `clinicId: ''`, the
  `candidates`, and **writes nothing**. The client renders them. Selecting an
  existing clinic is entirely client-side (it already holds the id and calls
  nothing). Creating anyway means re-calling with those ids in
  `acknowledgedMatchIds`.
- **`acknowledgedMatchIds` is deliberately NOT a `confirmCreate: true` boolean.**
  A boolean can be set by any client that never rendered anything, which would
  defeat the ruling. The only way to learn these ids is to have been handed them
  by the previous call, so echoing them back is server-checkable evidence the
  user saw the match. The check is recomputed against the CURRENT candidate set,
  so a match that appeared in between re-triggers the question rather than
  letting a caller create over a clinic it was never shown. Do not simplify this
  to a boolean.
- Match rule (`lib/vetClinicMatch.ts`): identical normalized name, OR the same
  dialable phone digits, OR one normalized name containing the other. Wider than
  the old normalized-name-only rule on purpose: now that a match only offers a
  choice, a false positive costs one tap while a false negative costs a
  permanent duplicate in a catalog shared with the portal. Archived clinics are
  excluded; pending ones are included and flagged `verified: false`.
- `isEmergency` added 2026-07-25 for the AuntieOS picker's emergency-vet field.
  Optional, defaults false, so every payload the kinfolk portal has ever sent
  stays valid. Frozen as the superset in `test/callableContract.test.ts`.
- Staff callers (`isStaff`, RULING O-6) land `verified: true` / `pending: false`:
  an operator typing a clinic into a household record IS the curation step.
  Kinfolk submissions still land `verified: false` for operator approval.

### updateVetClinic (admin-gated)
- req `{ clinicId: string, name: string, phone?: string, address?: string, website?: string, hours?: string /* opening hours, on the CLINIC not the household */, notes?: string, isEmergency?: boolean, verified?: boolean /* omit to leave alone */ }`
- res `{ ok: true, clinicId: string, householdCount: number }`
- Added 2026-08-01 (punchlist B4). Before it there was no server-side update at
  all: both Kotlin trees wrote `vet_clinics` directly under `firestore.rules`
  `write: if isAuntie()`, and the React admin could not edit a clinic at all. A
  clinic entered with a wrong phone number could not be corrected from the live
  admin, and that number is what somebody reads in an emergency.
- **WHOLE-RECORD SAVE, not a patch.** An omitted optional field is CLEARED. The
  clients edit a form seeded from the current row, and a patch shape could never
  clear a wrong address.
- **THERE IS NO FAN-OUT, and that is the point.** `household_data` holds the
  canonical household vet (operator ruling 2026-08-01) as a CLINIC ID, and
  resolves name/phone/address/hours through this row at read time. There is
  exactly one copy of a clinic's details in the product, so a correction is not
  propagated to households: it simply IS what every linked household reads from
  the next render on. Nothing is written to any household doc.
  - `householdCount` reports REACH so the operator can see how far a change
    lands. It never drives a write.
  - A household linked through BOTH slots counts once.
  - A blank `clinicId` matches nothing. Load-bearing: an unlinked household
    carries an empty id, so a missing guard would make one clinic edit appear to
    touch every unlinked household in the tribe.
- Errors (`details.code`): `vet_clinic_not_found` (`not-found`),
  `vet_clinic_duplicate_name` (`failed-precondition`) when a rename would collide
  with another row under the SAME normalized-name rule `submitVetClinic` dedupes
  by. Refused rather than merged: merging two clinics is a decision about which
  households move, and this callable has no mandate to make it.
- Audited `VET_CLINIC_UPDATED` (`SUCCESS`; `warn` when households were rewritten,
  else `info`). Refusals audit `VET_CLINIC_WRITE_REFUSED` at `warn` /
  `status: 'FAILURE'`. A success-only trail cannot answer "who tried to rename a
  clinic onto another one".
- Mirrors: `auntieos-admin/src/api/vetClinicsWrite.ts`, Android
  `AuntieRepository.updateVetClinic`. Frozen in `test/callableContract.test.ts`.

### archiveVetClinic (admin-gated)
- req `{ clinicId: string, archived: boolean /* false unarchives */ }`
- res `{ ok: true, clinicId: string, archived: boolean, householdCount: number }`
- Added 2026-08-01 (punchlist B4). One callable for set and clear.
- **ARCHIVE, NOT DELETE, and there is deliberately no hard-delete callable.**
  `household_data` points at a clinic by id with no referential integrity and
  nothing sweeping for orphans, so a hard delete would (1) leave those
  households resolving to nothing, so their vet could never be corrected or even
  displayed again, and (2) destroy the record of what households were told to
  dial.
  The two Kotlin trees hard-delete today (`AuntieRepository.kt:2215`,
  `FirestoreInterop.wasmJs.kt:1064`); the Android one is repointed here.
- Archiving does NOT touch the households. Their denormalized name/phone/address
  are left exactly as they were: the doorstep read must not go blank because the
  operator tidied the catalog. An archived clinic disappears from `getVetClinics`
  and from both pickers; a household already on it keeps reading its number.
- Rejecting a pending kinfolk submission is this call with `archived: true`. The
  row stays, still carrying `submittedBy`, and is invisible everywhere a rejected
  submission should be.
- Errors (`details.code`): `vet_clinic_not_found` (`not-found`),
  `vet_clinic_already_archived` / `vet_clinic_not_archived`
  (`failed-precondition`) on a redundant flip. Refused rather than treated as a
  no-op success: two operators tidying the same catalog should be told the row
  already moved.
- Audited `VET_CLINIC_ARCHIVED` (`SUCCESS`; `warn` when the archived clinic is
  still referenced by a household, else `info`), refusals as above.
- Mirrors: `auntieos-admin/src/api/vetClinicsWrite.ts`, Android
  `AuntieRepository.archiveVetClinic`. Frozen in `test/callableContract.test.ts`.

### removeBusinessTag (admin-gated)
- req `{ scope: 'household' | 'pet', name: string (trimmed, 1..40) }`
- res `{ ok: true, scope, name: string, recordsTouched: number, vocabRemoved: boolean }`
- Added 2026-09-10 (#713). **DELETE IS A CASCADE, not a vocabulary edit.**
  Operator ruling: "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY." Removing
  a tag used to filter the `business_settings` list and nothing else, so every
  household and pet already carrying the name kept it as a neutral chip.
- Writes, and nothing else:
  `scope 'household'` -> `kinfolk/{id}.tags` then `business_settings/business_settings.householdTags`;
  `scope 'pet'` -> `kin/{id}.tags` then `business_settings/business_settings.petTags`.
  The same name may sit in BOTH vocabularies ("Meds Needed" on a household and on
  a pet), so a household delete never reaches into `kin`. There is no third copy:
  the nested `families/{kinfolkId}/kin/{kinId}` doc carries no `tags` field and
  `onFamilyKinWrite`'s flat-mirror payload does not include one.
- **Assignments first, vocabulary last.** A failure partway leaves the row in the
  list, so the operator presses Remove again and the retry finishes. The reverse
  order would orphan assignments with nothing left to remove them by.
- Matching is case-insensitive over normalized names, so the scan is in memory:
  `where('tags','array-contains',name)` and `FieldValue.arrayRemove` both match
  exactly and would leave "vip" behind, which reads as the delete not working.
  Writes are whole-list replaces chunked at 400 per batch.
- Idempotent. A name already off the list is not an error (that is exactly what a
  half-finished earlier run leaves behind): the strip runs anyway and
  `vocabRemoved` reports `false`.
- Audited `BUSINESS_TAG_REMOVED` (`SUCCESS`; `warn` when records were touched,
  else `info`). The payload carries the record ids, because which households held
  the tag is unrecoverable once the batch commits.
- Mirrors: `auntieos-admin/src/api/settingsWrite.ts`, Android
  `AuntieRepository.removeBusinessTag`. Frozen in `test/callableContract.test.ts`.

## Blocked time windows (admin-gated)
- req `{ date: 'YYYY-MM-DD', startTime: 'HH:mm', endTime: 'HH:mm', notes?: string
  (<=500), startTimeMs?: number, endTimeMs?: number, overrideVisitConflict?: boolean }`
- res `{ ok: true, docId: string }`
- Writes one private, unavailable `booking_time_slots` row (`slotType: 'BLOCKED'`,
  `source: 'INTERNAL_MANUAL'`, `syncState: 'LOCAL_ONLY'`, ISO-string stamps), which
  the Schedule busy overlays and the kinfolk availability checks already read.
- Refuses `startTime >= endTime` and any non-`HH:mm` clock.
- `startTimeMs`/`endTimeMs` are the SAME window as real instants, and they exist
  because the stored document has no timezone field: without them the server
  cannot compare a zoneless wall clock against `kin_care_sessions` and simply
  does not overlap-check the block. Optional so the desktop admin's older
  three-field call keeps working unchanged; every client that can name the
  operator's zone sends them. When sent, the window is checked by
  `guardVisitOverlapConflict` and refused with
  `details { code: 'visit_overlap_conflict' }`, which `overrideVisitConflict: true`
  may knowingly go past (audited as `VISIT_OVERLAP_CONFLICT_OVERRIDDEN`).
- CALLERS: React admin `components/BlockTimeDialog.tsx`, desktop admin
  `screens/schedule/BlockTimeDialog.kt`, android
  `BookingRepository.createBlockedTimeSlot`.
- req `{ slotId: string }`
- res `{ ok: true, slotId: string }`
- The other half of block time, and the half that had no callable at all.
  `firestore.rules` denies every client write to `booking_time_slots`
  (`allow write: if false`), so the only unblock affordance that existed
  (android's, a client `.delete()`) had never once worked in production.
- `not-found` when the slot is gone.
- REFUSES A CALENDAR MIRROR: a row whose `source` is anything other than
  `INTERNAL_MANUAL` (in practice `GOOGLE_BUSY_IMPORT`) is refused
  `failed-precondition` with `details { code: 'imported_busy_slot', source }`,
  because deleting it would not free the time - the next
  `syncGoogleCalendarBusyEvents` run writes the same event straight back. The
  message names the real remedy (clear it in Google Calendar, or turn sync off).
  NOT overridable; there is no flag. A row carrying NO `source` IS deletable:
  the collection predates the field and an unlabelled row is a manual block.
- Audited as `DELETE_BLOCKED_TIME_SLOT`, with the window it removed on the
  payload - once the document is gone the audit entry is the only record that
  the block ever existed.
- CALLERS: React admin `screens/Schedule.tsx` (Unblock on the day agenda),
  android `BookingRepository.deleteBlockedTimeSlot`.
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
  serviceId, serviceName, priceCents }]`, `billing?`, `communication?`); the
  legacy single-visit shape (`serviceType`, `startTimeMs`, ...) has no live
  caller but the server still accepts it.
- A VISIT CARRIES NO ADDRESS (operator ruling, 2026-08-04). `visits[]` held a
  free-text `location` until then, and `createMultiDateBookingRequest` mirrored
  it; addresses come from the household doc and are read live from it. Neither
  parsing schema is `.strict()`, so a cached client still sending the key has
  it stripped rather than being refused.
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
  `cancelRequestedAt`/`cancelRequestReason`/`cancelRequestedByUid` plus (since
  #438) `cancelRequestStatus: 'pending'` on the visit; only the business
  cancels for real, via `batchUpdateBookings`, `manageBookingSeries`, or
  `admin/resolveBookingCancellationRequest`. A second request while one is
  still pending is a no-op (`alreadyPending: true`), not an error.
- A fresh ask after a DECLINE is allowed, and clears the previous answer
  (`cancelResponseNote` / `cancelResolvedAt` / `cancelResolvedByUid`), the same
  way `requestBookingReschedule` clears its own.
- A request written before #438 carries the stamp and no status. Everything
  that reads this field treats a bare stamp as pending, because those are the
  asks that sat unread from 2026-07-02 until #438 built the queue.
- Only `requested`/`confirmed` visits are cancelable; anything else is
  `failed-precondition`.
- kinfolk portal only.

- req `{ kinfolkId?: string, batchId: string, visitId: string, proposedStartTimeMs: number, proposedEndTimeMs?: number, reason?: string }`
  (`proposedStartTimeMs` is an integer epoch-ms in the future and at most a year out)
- res `{ ok: true, visitId: string, proposedStartTimeMs: number, proposedEndTimeMs: number | null }`
- #399 item 2, and the same kind of thing as the cancellation ask above: a
  PROPOSAL, not a move. Stamps `rescheduleRequestedAt` /
  `rescheduleRequestedByUid` / `rescheduleRequestReason` /
  `rescheduleRequestedStartTime` / `rescheduleRequestedEndTime` /
  `rescheduleRequestStatus: 'pending'` on the kinCares doc and writes neither
  `startTime` nor `status`. Only `admin/resolveBookingRescheduleRequest` moves
  a visit.
- `proposedEndTimeMs` is OPTIONAL and NOT nullable. Omitted means "keep the
  visit's current duration", derived server-side; the contract generator
  refuses `.nullable().optional()` on a request because Kotlin's one nullable
  type cannot tell an absent key from a present null.
- A second proposal while one is pending is `already-exists`, not a silent
  overwrite: the office may already be acting on the time it was shown. A fresh
  proposal after a decline IS allowed, and clears the previous answer.
- Only `requested`/`confirmed` visits qualify; anything else is
  `failed-precondition`.
- `onBookingsWrite` fires `kincare.reschedule.requested` to the business on the
  flag's first appearance, and again when a declined request goes back to
  pending.
- kinfolk portal only.
- req `{ kinfolkId: string, batchId: string, visitId: string, decision: 'accept' | 'decline', note?: string }`
- res `{ ok: true, visitId: string, decision: 'accept' | 'decline', startTimeMs: number | null, sessionUpdated: boolean }`
- GATE: `wrapAdminCallable` (admin claim, or the AUNTIE_OPERATOR_UIDS fallback).
- ACCEPTING MOVES BOTH RECORDS. The kinCares doc under
  `families/{kinfolkId}/bookings/{batchId}` is what the portal reads; the flat
  `kin_care_sessions` row is what the admin schedule reads, and
  `rescheduleBooking` only ever wrote the second, so a visit moved through that
  callable alone still reads at its old time in the portal. The mirror id is
  the visit's own `sessionId` when it carries one, else `vis_{visitId}`, and it
  is written ONLY when the doc exists (a still-pending request has none), which
  is `batchUpdateBookings`'s rule. `sessionUpdated` reports which happened.
- Timestamps on the kinCares doc, ISO strings on the flat row. That is not an
  inconsistency to tidy: the two collections genuinely store different shapes.
- `guardCompanyHolidayConflict` runs on the NEW window before any write, the
  same guard `rescheduleBooking` applies to its own.
- A decline REQUIRES a note; `invalid-argument` without one. Declining writes
  the answer and moves nothing.
- `failed-precondition` when no request is pending on the visit.
- req `{ limit?: number }` (integer 1..100, default 50)
- res `{ requests: RescheduleRequestDto[] }`
- GATE: `wrapAdminCallable`.
- A collection-group query over `kinCares` on
  `rescheduleRequestStatus == 'pending'`, ordered by `rescheduleRequestedAt`
  ascending so the household that has waited longest is answered first. NEEDS
  THE COMPOSITE INDEX declared in `mytribe/firestore.indexes.json`; the release
  deploys `firestore:indexes` before functions.
- Exists as a callable because the React admin's `useCollection` wraps a single
  `collection(db, path)` and has no collection-group variant (see the note in
  `auntieos-admin/src/api/bookings.ts` reserving an "incoming requests"
  surface). `auntieos-admin/src/components/VisitRequestsSection.tsx` is that
  surface, and it renders the cancellation queue below in the same list.

### resolveBookingCancellationRequest
- req `{ kinfolkId: string, batchId: string, visitId: string, decision: 'accept' | 'decline', note?: string }`
- res `{ ok: true, visitId: string, decision: 'accept' | 'decline', status: string | null, sessionUpdated: boolean, rescheduleRequestClosed: boolean }`
- GATE: `wrapAdminCallable` (admin claim, or the AUNTIE_OPERATOR_UIDS fallback).
- #438. Until this landed, `cancelRequestedAt` had been written to visits since
  2026-07-02 with NO admin surface reading it: no queue, no badge, no list. The
  portal told the household their request was sent and the office never saw it.
- ACCEPTING CANCELS BOTH RECORDS. The kinCares doc goes to `status: 'cancelled'`
  and the flat `kin_care_sessions` row to `status: 'CANCELLED'`. Lowercase on
  the subcollection, uppercase on the flat row, because the two collections
  genuinely use different status vocabularies (see `batchUpdateBookings`). The
  mirror id is the visit's own `sessionId` when it carries one, else
  `vis_{visitId}`, and it is written ONLY when the doc exists (a still-pending
  request has none). `sessionUpdated` reports which happened. Writing one side
  of the pair is the trap PR #436 documents: the household and the office then
  disagree about a visit one of them thinks is cancelled.
- Accepting also closes any reschedule request still pending on the same visit
  (`rescheduleRequestClosed`), because `listRescheduleRequests` filters on its
  own status and would otherwise keep asking an operator to move a visit that
  no longer happens.
- A decline REQUIRES a note; `invalid-argument` without one. Declining writes
  the answer and changes no status, on either record.
- `failed-precondition` when no ask is waiting. A bare `cancelRequestedAt` with
  no status IS waiting; those pre-#438 requests are resolvable here.
- `onBookingsWrite` tells the household the outcome through the catalog:
  `kincare.booking.cancel` on an accept (the status change reaches it already)
  and `kincare.cancel.declined` on a decline, which is the only way a decline
  (a decision that changes nothing) ever reaches them.

### listCancelRequests
- req `{ limit?: number }` (integer 1..100, default 50)
- res `{ requests: CancelRequestDto[] }`
- GATE: `wrapAdminCallable`.
- A collection-group query over `kinCares` ordered by `cancelRequestedAt`
  ascending, oldest first. NEEDS THE COLLECTION-GROUP FIELD OVERRIDE declared in
  `mytribe/firestore.indexes.json`; automatic single-field indexes are
  collection-scoped only.
- The resolved rows are filtered OUT IN MEMORY rather than by a `where` clause,
  and the query reads up to 200 docs to do it. This is deliberate: a request
  written before #438 has no `cancelRequestStatus` field at all, Firestore has
  no "field is missing" predicate, and an equality filter would therefore hide
  exactly the July backlog the queue exists to drain. The scan cap logs a
  warning when it is reached.
- Same surface as `listRescheduleRequests`: both queues render as one list in
  `auntieos-admin/src/components/VisitRequestsSection.tsx`, and the Android
  admin renders the same pair on its schedule screen.
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
  against prod 2026-08-01. The repair is
  `mytribe/scripts/backfillKinTaleCreatedAtProvenance.ts`: an imported row's
  `createdAt` becomes the ORIGINAL creation instant recovered from the previous
  system, the ingest instant keeps `_migratedAt`, and a new `createdAtSource`
  field (`live` / `original` / `import`) says which of the two `createdAt`
  actually is. After it the ordering becomes real, and orphans, sorted by when
  their visits were really written up in 2025 and early 2026, drift off the page
  as new reports accumulate. (An earlier ruling on 2026-08-01 redated imported
  rows to the ingest stamp instead. The operator reversed it on 2026-08-04 and
  that script is deleted.) This callable is one
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

## Notifications inbox (recipient or admin)

The flat top-level `notifications` collection, written only by
`notifications/dispatcher.ts`. No client writes it directly; these six callables
are the whole mutation surface, and all six share one gate: a caller may act on a
notification whose `recipientUid` is their own uid, and an admin (admin claim,
`role === 'admin'`, or the `AUNTIE_OPERATOR_UIDS` staff gate) may act on any.

**A skip is not an error.** A missing doc, a doc with no `recipientUid`, and
another recipient's doc are all skipped without a write and without throwing, and
the count in the response says so. That is what lets a client whose list has gone
partially stale act on everything it legitimately can. It also means a returned
`0` is a real answer the client MUST surface: the React admin reports "Nothing was
archived. The notification may already be gone." rather than reading the resolve
as success. Argument keys are NOT uniform across the family, and the mismatch is
deliberate rather than an oversight, so a mirror that guesses will fail zod: the
read pair takes `notificationId`, the archive family takes `id` / `ids`.

### markNotificationRead / markNotificationUnread
- req `{ notificationId: string /* 1..200 */ }`
- res `{ ok: true }`
- Read stamps `readAt` (serverTimestamp); unread clears it with
  `FieldValue.delete()`, so on the wire it is ABSENT rather than blank. Clients
  model it as optional, never as an empty-string sentinel.

### bulkMarkNotificationsRead
- req `{ ids: string[] /* 1..200 entries, each 1..200 chars */ }`
- res `{ ok: true, marked: number }`
- `marked` counts what actually changed, so it is smaller than `ids.length` when
  the selection contained rows that were already read. **A client that sends
  already-read ids therefore gets a partial count back for a batch in which
  nothing went wrong**, which is why the React admin sends only the unread subset
  of its selection and labels the control with that count.
- Audited as `NOTIFICATIONS_BULK_READ`.

### archiveNotification / bulkArchiveNotifications
- req `{ id: string /* 1..200 */ }` and `{ ids: string[] /* 1..200 entries */ }`
- res `{ archived: number }` (0 or 1 for the single form)
- Merge-writes `archivedAt` (serverTimestamp) + `archivedByUid`. **Archiving is
  not deletion**: every field survives and the row is still readable, it simply
  drops out of the client's active feed.
- Audited as `NOTIFICATIONS_ARCHIVE`, including when the count is 0, so a refusal
  leaves evidence rather than silence.

### unarchiveNotification / bulkUnarchiveNotifications
- req `{ id: string /* 1..200 */ }` and `{ ids: string[] /* 1..200 entries */ }`
- res `{ unarchived: number }` (0 or 1 for the single form)
- Merge-writes `archivedAt: null`. **Null, not `FieldValue.delete()`**, for the
  same reason `unarchiveInvoice` does it: Firestore's `== null` matches only
  documents that HAVE the field, so an explicit null is the shape a future
  server-side "active only" predicate could use, while a deleted field is
  unreachable by any predicate. This deliberately diverges from
  `markNotificationUnread` above, whose field has no such predicate in its future.
  Both clients already read null and absent alike (Android's `archivedAt: String?`
  filtered with `isNullOrBlank()`, the React admin's single
  `isNotificationArchived` predicate), so neither needed a change to make a
  restored row reappear.
- `archivedByUid` is NOT cleared. It records who filed the row away, which stays
  true after a restore, and clearing it would erase the only trace on the document
  that an archive ever happened.
- Audited as `NOTIFICATIONS_UNARCHIVE`, a separate event rather than a flag inside
  the archive event's payload: the trail is queried by `event`, and folding the
  two together would make "what was filed away last week" answerable only by
  parsing payloads.
- **Why these exist.** Until 2026-08-01 `archivedAt` could only ever be stamped:
  no callable cleared it and no client listed archived rows, so Archive was a
  one-way door and a misfiled notification was unreachable from every surface.
  The Invoices screen already refuses that shape (`unarchiveInvoice` plus a
  three-state archive facet); a notification should not be the harder thing to
  undo.

- req `{ kinfolkId?: string, limit?: number, before?: number }`
  (`limit` is an integer 1..50, default 12, counted in KinTALES not photos;
  `before` is the previous page's `nextBefore`)
- res `{ photos: PhotoDto[], portraits: PortraitDto[], hasMore: boolean, nextBefore: number | null }`
  where `PhotoDto = { id, url, contentType: string | null, taleId, taleTitle, takenAtMs: number | null }`
  and `PortraitDto = { kinId, kinName, url }`
- GATE: `resolveKinfolkAccess`, then the `kinfolkId ==` predicate on the query.
  This reads the FLAT `kin_care_reports` collection, so unlike a subcollection
  read the path itself scopes nothing; those two together are the whole tenant
  boundary and both are asserted in `test/getMyKinPhotos.test.ts`.
- #399 item 1. Nothing could answer "all of this household's photos" before:
  `getMyKinTaleMedia` resolves the media of ONE tale whose id the caller
  already has.
- TWO SOURCES, and they are different kinds of thing. `photos` is the archive,
  `kin_care_reports.mediaFileIds` resolved through `media_files.storageUrl`
  (the same mapping `mediaDocToThumb` does for the feed's thumbnails).
  `portraits` is the ONE current photo per Kin on
  `families/{kinfolkId}/kin/{kinId}.photoUrl`, overwritten in place by
  `confirmKinPhotoUpload` with no history kept.
- NO PER-KIN FILTER, deliberately. `media_files` carries no reliable per-Kin
  key: `kinId` appears only on legacy and sandbox documents, `taggedKinIds` is
  written by one admin surface only, and `entityType` casing is inconsistent in
  production. A filter this callable could not honour is worse than no filter.
- PAGINATION IS BY TALE. A tale can carry twenty photos or none, so a
  photo-count page would either split a visit across pages or need a second
  cursor inside one. `nextBefore` is the last tale's `sentAtMs`, the same
  opaque cursor `getMyKinTales` uses.
- `portraits` is populated on the FIRST page only (no `before`), and is empty
  after that: they have no timestamp to sort into the archive by, and repeating
  them under every scroll shows the same faces over and over.
- `sentAt > ''` keeps DRAFTs out, same as `getMyKinTales`: a photo on a tale the
  Auntie has not sent is not the household's to see. A media record that is
  missing or carries no `storageUrl` is simply absent, never a placeholder
  tile, and a file attached to two tales appears once, credited to the more
  recent.
- kinfolk portal only. `mytribe/web/src/screens/Gallery.tsx` is the surface.
## Card on file (kinfolk, primary only)
The four callables behind the portal's Billing Details "Manage" button
(`src/portal/billing.ts`, issue #399 item 3). Card state has no generated
contract: the registry in `scripts/contracts/registry.ts` publishes the invoice
and booking surfaces, and its header is explicit that adding a line is a
decision to publish. This surface reaches one client tree beyond the React
portal (the portal Android app, which hand-decodes JSON), so it is documented
here and hand-mirrored, like the rest of the account callables.
GATE, all four: the resolved `kinfolkId` must be in the CALLER's own
`clients/{uid}.kinfolkIds`, then `requireKinfolkPrimary`. Deliberately NOT
`resolveKinfolkAccess`: that resolver grants staff a cross-tenant resolution by
design, and every write here lands on `clients/{uid}` — the caller's own doc — so
an operator who stepped into a household would attach a card to their own
account under the household's name. `getMyAccount` already reports that state as
`impersonated: true`; this is its server-side half.
- req `{ kinfolkId?: string }`
- res `{ hasPaymentMethod: boolean, card: { brand, last4, expMonth, expYear } | null, updatedAtMs: number | null }`
- Reads the mirror on `clients/{uid}`; touches Stripe not at all.
- `card` is null both when there is no card AND when one exists whose display
  fields are incomplete. `hasPaymentMethod` is the separate flag that tells the
  two apart, so no client renders "Visa •••• undefined".
- req `{ kinfolkId?: string, successUrl: string /* url */, cancelUrl: string /* url */ }`
- res `{ checkoutUrl: string, sessionId: string }`
- Stripe Checkout in `mode: 'setup'`: collects a card, charges nothing. NOT the
  Stripe Billing Portal, which needs a portal configuration created in the
  Stripe dashboard that nothing in this repo can create or verify.
- Creates the `stripeCustomerId` on `clients/{uid}` lazily, on first use.
- Session metadata carries `purpose: 'save-card'`, `uid`, `familyId`,
  `kinfolkId`. `stripeWebhook` reads `purpose` in a branch that sits AHEAD of
  its metadata gate, because a setup session has no `invoiceId`.
- req `{ kinfolkId?: string }`
- res `{ hasPaymentMethod, card, updatedAtMs, changed: boolean }`
- Lists the customer's cards at Stripe, newest first, and mirrors the head onto
  `clients/{uid}`. Clears the mirror when Stripe holds none.
- THE PRIMARY COMPLETION PATH, not the webhook: the React portal calls it when
  the browser returns to `?billing=saved`, and the Android app calls it from
  "Refresh card" (that client leaves for an external browser and gets no return
  trip). The webhook branch is the backstop for a closed tab.
- Idempotent. A household with no `stripeCustomerId` gets its stored state back
  and Stripe is never called.
- req `{ kinfolkId?: string }`
- res `{ ok: true, alreadyEmpty: boolean }`
- `paymentMethods.detach` then clears the mirror. Removes an INSTRUMENT: no
  invoice, charge, or ledger row is touched, and unpaid invoices stay exactly
  as they were.
- Stripe's `resource_missing` is tolerated (already detached elsewhere) and the
  mirror is still cleared; any other Stripe fault throws `unavailable` and the
  mirror is left alone, so the screen never shows a card that is gone or hides
  one that is not.

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

## Marketing blasts (admin-gated)

Scheduled campaigns to kinfolk, as against `broadcastMessage`, which sends now.
Two hand-built clients mirror these shapes: the React admin
(`auntieos-admin/src/api/marketingBlasts.ts`) and AuntieOS Android
(`android/.../ui/marketing/MarketingBlast.kt`). `scheduleMarketingBlast`'s
request is frozen by recursive signature in `test/callableContract.test.ts`.

The audience is ONE shape across this whole codebase: `audienceCriteria.ts`'s
`CriteriaSchema`, already shared by `broadcastMessage` and `saveAudienceSegment`.
A blast adds a third path, an explicit `audienceUids` list, which is the shape
the callable originally took.

### scheduleMarketingBlast (shape changed 2026-09-12)
- req `{ key: 'newsletter.announcement'|'survey.event'|'marketing.optin', fireAtMs: number /* epoch ms, not >60s in the past */, segmentId?: string | criteria?: Criteria | audienceUids?: string[] /* EXACTLY ONE */, data: Record<string, unknown>, title?: string, idempotencyKey?: string /* blast_<millis>_<suffix> */ }`
- res `{ ok: true, blastId: string, key: string, matched: number, noLinkedAccount: number, dispatched: number, suppressed: number, failed: number, deduped: boolean, pending: boolean }`
- **`idempotencyKey` (#814, 2026-09-12).** One key per SUBMISSION, held across
  every attempt at it, and it becomes the `marketingBlasts/{id}` document id.
  The row is written before the fan-out (see below), so it is also the
  idempotency record: a second attempt claims the same id, loses the `create()`,
  and is answered from the stored row with `deduped: true` instead of queueing a
  second set of scheduled notifications. `pending` is true while the first
  attempt's fan-out is still running, and the counts are then a snapshot rather
  than a total. A different caller's key is refused `already-exists` rather than
  handed somebody else's campaign. Optional: a payload without one behaves
  exactly as it did before. Both clients that adopt it also opt into ONE retry
  on a transport failure (`call(..., { idempotent: true })` / the Android
  choke point), which is only safe because of this key.
- The fan-out stays inside the callable, at `timeoutSeconds: 540` (raised from
  the 60s default in #814, matching `broadcastMessage`). A client that gives up
  at 20 seconds does not stop the container, so the budget that matters is this
  one. The row carries `fanoutState: 'running' | 'complete'`; a row still saying
  'running' after the invocation ended is a fan-out that was killed part-way,
  which is a different fact from a blast that queued nothing.
- **The shape change.** It used to take ONLY `audienceUids`, which is why nothing
  ever called it: a screen would have had to enumerate up to 5000 auth uids
  client-side, and no client can read the `kinfolk` collection's uid column that
  way. `segmentId` / `criteria` are resolved server-side by
  `admin/marketingAudience.ts` against the same `CriteriaSchema` a broadcast uses.
  Exactly one of the three; two is refused rather than resolved by handler
  precedence, and zero is refused rather than defaulted to everyone.
- `data` is the MERGE CONTEXT for the operator's own template for `key`
  (`emailTemplates/{key}`, authored in Template Bank), not the message copy. The
  three marketing catalog rows declare no fixed merge tokens, so the field is a
  free-form record on purpose.
- Each recipient still passes the marketing opt-in gate inside
  `enqueueNotification`: a household that never opted in resolves to every
  channel off and is counted in `suppressed`, never silently dropped. `failed`
  is kept separate from `suppressed` because they are different facts.
- `failed-precondition` `no_recipients` when the audience resolves to no linked
  account, and `audience_too_large` past 5000 resolved recipients.
- The `marketingBlasts/{id}` row is written BEFORE the fan-out, and its id rides
  on every scheduled copy as `data.blastId`. That is the whole mechanism behind
  cancel; writing the row afterwards (as it used to) left every queued copy
  anonymous and uncancellable.

### previewMarketingBlastAudience (net-new 2026-09-12)
- req `{ key: <same enum>, segmentId?: string | criteria?: Criteria | audienceUids?: string[] /* EXACTLY ONE */ }`
- res `{ ok: true, description: string, matched: number, noLinkedAccount: number, suppressedByPrefs: number, reachable: number }`
- Writes nothing. Deliberately does NOT throw on an empty audience the way
  scheduling does: "this reaches nobody" is the most useful thing a preview can
  say, and it can only say it by returning.
- `suppressedByPrefs` runs the dispatcher's OWN `resolveChannels` per recipient,
  so the number is a prediction of the send rather than an estimate of it.
- Four counted facts, none derived from another by subtraction, so a screen
  rendering them is never showing arithmetic dressed as data.

### listMarketingBlasts (net-new 2026-09-12)
- req `{ limit?: number /* 1-200, default 100 */ }`
- res `{ ok: true, blasts: Array<{ id, key, title, fireAtMs, status: 'scheduled'|'sent'|'cancelled', audienceDescription, matched, noLinkedAccount, dispatched, suppressed, failed, cancelledAtMs: number|null, createdAtMs }> }`
- `status` is DERIVED on read from `fireAtMs` vs now and `cancelledAt`, never
  stored: a stored status would be wrong from the moment the 5-minute sweep
  fired, and nothing runs afterwards to correct it.
- `matched` falls back to a pre-change row's `audienceCount`, so a blast written
  before this change reports a real number instead of a confident zero.
- There is deliberately no open rate and no in-flight "sending" count. Nothing in
  this codebase records an email open, and a blast is promoted by a cron, so
  neither number exists to return.

### cancelMarketingBlast (net-new 2026-09-12)
- req `{ blastId: string }`
- res `{ ok: true, blastId: string, cancelled: number /* queued notifications deleted */ }`
- Deletes every pending `scheduledNotifications` doc carrying
  `data.blastId == blastId`, in batches of 400 (a 5000-recipient blast is far
  past Firestore's 500-write limit), then stamps `cancelledAt`.
- Equality on a nested field is served by Firestore's automatic single-field
  index. `mytribe/firestore.indexes.json` has no `fieldOverrides` entry for
  `scheduledNotifications`, so no index change is needed; adding an exemption on
  that collection's `data` field later would break this query.
- `failed-precondition` `already_fired` when the fire time has passed. Refused
  loudly rather than stamping a row "cancelled" over mail that already went out.
  `already_cancelled` on a second attempt.
