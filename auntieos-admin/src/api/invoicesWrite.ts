import { call } from '../lib/fns';
import { reminderOutcomeOf, type ReminderOutcome } from '../lib/invoiceReminder';
import type {
  ArchiveInvoiceArgs,
  ArchiveInvoiceResult,
  CreateInvoiceArgs,
  CreateInvoiceResult,
  CreateQuoteArgs,
  CreateQuoteResult,
  GenerateReceiptArgs,
  GenerateReceiptResult,
  GetInvoiceLedgerArgs,
  GetInvoiceLedgerResult,
  ListUninvoicedSessionsArgs,
  ListUninvoicedSessionsResult,
  MarkInvoicePaidArgs,
  MarkInvoicePaidResult,
  RecordPaymentArgs,
  RecordPaymentResult,
  RepairInvoicePaymentsArgs,
  RepairInvoicePaymentsResult,
  ResendQuoteArgs,
  ResendQuoteResult,
  ReviewAndSendDraftInvoiceArgs,
  ReviewAndSendDraftInvoiceResult,
  RunAutoApplyArgs,
  RunAutoApplyResult,
  SendInvoiceReminderArgs,
  SendInvoiceReminderResult,
  SetSessionDoNotInvoiceArgs,
  SetSessionDoNotInvoiceResult,
  UnarchiveInvoiceArgs,
  UnarchiveInvoiceResult,
  UpdateInvoiceArgs,
  UpdateInvoiceArgsPatch,
  UpdateInvoiceResult,
  UpdateInvoiceResultTotals,
} from '../contracts/invoiceContracts.generated';

/**
 * The write side of the Invoices screen.
 *
 * EVERY SHAPE BELOW COMES FROM THE CONTRACTS MODULE (ADR-0001). This file used
 * to carry its own transcription of each callable's zod Args and Result,
 * re-read against the handler by hand whenever somebody remembered to. Those
 * transcriptions are gone: the types are imported from
 * `contracts/invoiceContracts.generated.ts`, which is projected from the server
 * schemas and which CI regenerates and diffs, so a schema change either lands
 * with its client fallout or fails the build.
 *
 * What survives here is what a generated type cannot say: WHEN a callable
 * refuses, WHAT it does to a household, and which of two legitimate-looking
 * payloads is the one that does not lose money. That is the division ADR-0001
 * draws, and the reason the prose below no longer lists field names.
 *
 * `markInvoicePaid` and `reviewAndSendDraftInvoice` used to route through
 * `postInvoiceEvent`, the generic admin invoice-mutation callable, as a
 * workaround: a real backend call, but the generic primitive rather than a
 * purpose-built endpoint, with no payment audit trail and no draft-send
 * validation. Both now call their own dedicated callables, neither of which
 * needs `familyId` from the caller: each loads the invoice server-side and
 * reads `kinfolkId` off the doc itself.
 */

/**
 * createInvoice (admin): mints a new `invoices/{id}` doc, kinfolk gets notified
 * `invoice.new`.
 *
 * `CreateInvoiceArgs.lineItems` is ADDITIVE: omit it and the callable behaves
 * exactly as it always did, storing `total` / `amountDue` verbatim and writing
 * no cents field at all.
 *
 * SUPPLY IT AND `total` / `amountDue` MUST EQUAL THE SUM OF THE LINES. The
 * server REFUSES a disagreement (`invoice_total_mismatch`) rather than silently
 * overwriting the caller's figure, so both must come from the same
 * `lib/invoiceMath.ts` computation the composer already runs to show a live
 * total while the operator types. Never hand-enter a total beside line items.
 *
 * ── #825: THE RETRY, AND WHAT EARNS IT ────────────────────────────────────
 *
 * `idempotencyKey` is OPTIONAL on the wire and the automatic retry is switched
 * on ONLY when one is present. `CallOptions.idempotent` in `lib/fns.ts` is a
 * claim about the SERVER — "this callable either changes nothing, or dedupes
 * the second attempt itself" — and without a key this callable dedupes nothing,
 * so turning the retry on unconditionally would be the claim made falsely. The
 * key is minted by the SCREEN, once per submission, never per click: see
 * `lib/moneyIdempotency.ts`.
 */
export async function createInvoice(
  input: CreateInvoiceArgs,
): Promise<Pick<CreateInvoiceResult, 'invoiceId'>> {
  const res = await call<CreateInvoiceArgs, CreateInvoiceResult>('createInvoice', input, {
    idempotent: input.idempotencyKey !== undefined,
  });
  return { invoiceId: res.invoiceId };
}

/**
 * createQuote (admin): a quote is an invoice the server always mints in QUOTE
 * status, whatever `status` the caller sends.
 *
 * `CreateQuoteArgs.lineItems` and `CreateQuoteArgs.invoiceDiscountCents` are
 * ADDITIVE, exactly as they are on `createInvoice`. Omit them and the
 * caller's `total` / `amountDue` are stored verbatim. Supply them and the
 * server owns the money: every figure is recomputed from the lines, and a
 * total that disagrees is refused (`invoice_total_mismatch`) rather than
 * silently overwritten. Use the same `lib/invoiceMath.ts` computation the
 * composer runs to show a live total while the operator types.
 *
 * ── #825: THE RETRY, AND WHAT EARNS IT ────────────────────────────────────
 *
 * `idempotencyKey` is OPTIONAL on the wire and the automatic retry is switched
 * on ONLY when one is present. `CallOptions.idempotent` in `lib/fns.ts` is a
 * claim about the SERVER — "this callable either changes nothing, or dedupes
 * the second attempt itself" — and without a key this callable dedupes nothing,
 * so turning the retry on unconditionally would be the claim made falsely. The
 * key is minted by the SCREEN, once per submission, never per click: see
 * `lib/moneyIdempotency.ts`.
 */
export async function createQuote(
  input: CreateQuoteArgs,
): Promise<Pick<CreateQuoteResult, 'invoiceId'>> {
  const res = await call<CreateQuoteArgs, CreateQuoteResult>('createQuote', input, {
    idempotent: input.idempotencyKey !== undefined,
  });
  return { invoiceId: res.invoiceId };
}

/**
 * sendInvoiceReminder (admin): on-demand resend of the `invoice.reminder`
 * notification for one invoice, right now. Throws (fail loud, never
 * swallowed) `failed-precondition` if the invoice is already paid, `not-found`
 * if the id is wrong.
 */
export async function sendInvoiceReminder(invoiceId: string): Promise<ReminderOutcome> {
  // #832: a reminder inside the server's window is answered `sent: false`, not
  // thrown, so the caller can say when the earlier one went out.
  const res = await call<SendInvoiceReminderArgs, SendInvoiceReminderResult>('sendInvoiceReminder', { invoiceId });
  return reminderOutcomeOf(res, Date.now());
}

/**
 * generateReceipt (admin): stamps `receiptIssuedAt`/`receiptIssuedBy` and
 * dispatches the `invoice.receipt` notification. Throws `not-found` if the
 * invoice is missing rather than silently creating one.
 */
export async function generateReceipt(invoiceId: string): Promise<void> {
  await call<GenerateReceiptArgs, GenerateReceiptResult>('generateReceipt', { invoiceId });
}

/**
 * markInvoicePaid (admin): records a payment, WHICH MAY BE PARTIAL, and writes a
 * `payments` subcollection entry (amount/method/reference/paidAt/recordedBy) in
 * the SAME batch as the invoice's money fields, so a manual payment is never
 * recorded without its audit trail.
 *
 * THE SERVER DERIVES THE INVOICE'S STATE FROM THE SUM OF ITS RECORDED PAYMENTS,
 * not from the single `amount` sent here. A payment that does not cover the
 * total leaves the invoice OPEN with a real remaining balance and returns
 * `state: 'partial'`; only a settling payment marks it paid. Until 2026-07-25
 * this callable wrote `paid` with `amountDue: 0` for ANY amount, which is how
 * $20 against a $40 invoice made the remaining $20 uncollectable: the invoice
 * dropped out of Outstanding and the next call was refused as already-paid.
 *
 * Omit `amount` to settle whatever is still outstanding. It is DOLLARS, unlike
 * every `*Cents` field in the result, which are integer cents.
 *
 * An OVERPAYMENT settles the invoice, leaves `amountDueCents` at 0 (never
 * negative, which is this codebase's credit signal) and reports the excess as
 * `overpaidCents` for the operator to act on deliberately.
 *
 * Throws `failed-precondition` when the invoice is already settled, when it is
 * marked paid with no recorded payments to reconcile against, when it is still a
 * draft or quote, or when it is cancelled or a credit. `not-found` if the id is
 * wrong. The `invoice.payment.applied` notification is dispatched by the
 * backend's `onInvoicesWrite` trigger off the resulting write, not by this
 * callable, and it does not fire for a partial because the invoice is not paid.
 *
 * ── #825: THE RETRY, AND WHAT EARNS IT ────────────────────────────────────
 *
 * `idempotencyKey` is OPTIONAL on the wire and the automatic retry is switched
 * on ONLY when one is present. `CallOptions.idempotent` in `lib/fns.ts` is a
 * claim about the SERVER — "this callable either changes nothing, or dedupes
 * the second attempt itself" — and without a key this callable dedupes nothing,
 * so turning the retry on unconditionally would be the claim made falsely. The
 * key is minted by the SCREEN, once per submission, never per click: see
 * `lib/moneyIdempotency.ts`.
 */
export async function markInvoicePaid(
  invoiceId: string,
  input: Omit<MarkInvoicePaidArgs, 'invoiceId'> = {},
): Promise<MarkInvoicePaidResult> {
  return call<MarkInvoicePaidArgs, MarkInvoicePaidResult>(
    'markInvoicePaid',
    { invoiceId, ...input },
    { idempotent: input.idempotencyKey !== undefined },
  );
}

/**
 * recordPayment (admin): appends a row to the ROOT `payments` collection, the
 * DISPLAY ledger the Payments screens read.
 *
 * IT IS NOT `markInvoicePaid` AND IT DOES NOT CALL IT. That one is the money
 * authority: it writes `invoices/{id}/payments` and re-derives the invoice's
 * settlement from the sum of every recorded payment. This one writes a row that
 * the settlement arithmetic never reads, which is precisely why the two cannot
 * double-count each other.
 *
 * THE ORDER IS LOAD-BEARING when both are wanted. Call `markInvoicePaid` FIRST
 * and treat its failure as fatal (nothing is written and no payment happened),
 * then call this one BEST-EFFORT: a display row that fails to write loses a
 * line on a list, while a settlement that fails loses the balance. That is the
 * sequence `InvoiceDetailViewModel.recordPayment` has run on Android since
 * W2-2, and this app now runs the same one.
 *
 * BLANK IS NOT OMITTED HERE, unlike `markInvoicePaid`. Every string on this
 * request has a `.default('')`, so an empty method or reference is a valid
 * stored value rather than a refusal. `amount` is DOLLARS as a float, the
 * legacy shape of this collection.
 *
 * ── THE FEE FIELDS, 2026-08-04 ────────────────────────────────────────────
 *
 * `tip` IS THE GROSS TIP and `fee` is the processor's cut, stored beside it.
 * That pairing is the whole point: the previous system stored the NET tip and
 * the migration dropped the fee, so invoice #1029 reads Amount $137.50,
 * Applied $127.50, Tip $7.29 and cannot be made to add up. Operator ruling:
 * "store both, and display the latter. itll help with taxes": the gross tip is
 * income, the fee is a deductible expense, and a net-only record loses both.
 *
 * `amount` IS THE WHOLE TRANSACTION, tip included. Not the part that settles an
 * invoice. The identity a reader checks is `amount = applied + tipGross +
 * unapplied`, and the fee is deliberately outside it: it comes off what the
 * business banks, not off what the household owed.
 *
 * `apply` MOVES AN INVOICE BALANCE and nothing else here does. `invoiceId`
 * stays a display link. THIS PANEL DOES NOT SEND IT: it calls `markInvoicePaid`
 * first, which has already settled the invoice, so an apply here would collect
 * the same money twice. One payment applies to one invoice; there is no split.
 *
 * `autoApply` puts the leftover into `families/{id}.accountBalanceCents`, the
 * EXISTING account credit the portal already shows, and the invoice trigger
 * spends it on the next bill. `sendConfirmationEmail` enqueues the existing
 * `invoice.payment.applied` notification. Both default off.
 *
 * ── #825: THE RETRY, AND WHAT EARNS IT ────────────────────────────────────
 *
 * `idempotencyKey` is OPTIONAL on the wire and the automatic retry is switched
 * on ONLY when one is present. `CallOptions.idempotent` in `lib/fns.ts` is a
 * claim about the SERVER — "this callable either changes nothing, or dedupes
 * the second attempt itself" — and without a key this callable dedupes nothing,
 * so turning the retry on unconditionally would be the claim made falsely. The
 * key is minted by the SCREEN, once per submission, never per click: see
 * `lib/moneyIdempotency.ts`.
 */
export async function recordPayment(
  input: RecordPaymentArgs,
): Promise<RecordPaymentResult> {
  return call<RecordPaymentArgs, RecordPaymentResult>('recordPayment', input, {
    idempotent: input.idempotencyKey !== undefined,
  });
}
/**
 * runAutoApply (admin): spends a household's account credit on ONE named
 * invoice, now.
 *
 * The on-demand half of "will automatically apply any Unapplied amount to
 * future invoices". `onInvoiceAutoApply` runs the same pass by itself when an
 * invoice becomes collectable, but that only fires on the TRANSITION, so this
 * exists for the two ordinary cases it cannot reach: auto-apply switched on
 * after the invoice was already sent, and a trigger that failed.
 *
 * IT DRAWS ON THE EXISTING CREDIT LEDGER, `families/{id}.accountBalanceCents`,
 * the balance `redeemCredit` fills. There is no second ledger.
 *
 * SAFE TO PRESS TWICE: the balance is decremented as it is spent, so a second
 * run finds nothing and answers `skipped: 'no_credit'`. Every `skipped` value
 * is a normal outcome and NOT an error. The callable throws only for an
 * unknown invoice or a sandbox admin reaching outside their tribe.
 */
export async function runAutoApply(invoiceId: string): Promise<RunAutoApplyResult> {
  return call<RunAutoApplyArgs, RunAutoApplyResult>('runAutoApply', { invoiceId });
}

/**
 * getInvoiceLedger (admin): the read half of an invoice's money and of the work
 * behind it. Writes nothing.
 *
 * THIS EXISTS BECAUSE NO CLIENT CAN READ THE SUBCOLLECTION. `firestore.rules`
 * carries no rule for `invoices/{id}/payments`, the parent `/invoices/{id}`
 * match does not extend to it, and the file has no catch-all, so a direct read
 * is denied to every client including a signed-in Auntie. That subcollection is
 * where `markInvoicePaid` records what was collected, so without this callable
 * an operator has no way to see what has been paid against a bill.
 *
 * THREE LISTS COME BACK AND THEY ARE NOT INTERCHANGEABLE:
 *   `payments`        the subcollection. THE AUTHORITY. `paidCents` is their
 *                     sum, and the invoice's balance derives from it.
 *   `ledgerPayments`  ROOT `payments` rows naming this invoice: `recordPayment`
 *                     display rows and Stripe card payments. Counted in
 *                     NOTHING. A Stripe payment lands only here, which is why
 *                     showing the subcollection alone would report a settled
 *                     invoice as having no payments.
 *   `sessions`        the visits the invoice claims.
 *
 * `missingSessionIds` and `orphanSessionIds` report the two halves of a broken
 * link (the invoice naming a session that does not exist, and a session naming
 * this invoice that the invoice does not claim back). They are reported and
 * never repaired: which side is right is the operator's call.
 *
 * Throws `not-found` for an unknown id and `permission-denied` for an invoice
 * outside a sandbox admin's tribe.
 */
export async function getInvoiceLedger(invoiceId: string): Promise<GetInvoiceLedgerResult> {
  return call<GetInvoiceLedgerArgs, GetInvoiceLedgerResult>('getInvoiceLedger', { invoiceId });
}

/**
 * repairInvoicePayments (admin): finds, and optionally repairs, invoices wrecked
 * by the pre-2026-07-25 partial-payment write, which marked an invoice paid with
 * a zero balance however little was actually collected.
 *
 * `detect` (the default) READS AND REPORTS ONLY. Run it first: it lists every
 * affected invoice with what it currently claims and what its recorded payments
 * say it should be, and writes nothing. `repair` restores the balance.
 *
 * The repair is IDEMPOTENT and NEVER LOWERS A BALANCE: it only ever raises an
 * understated one, so re-running it is safe and the worst it can do is decline
 * to fix something. Pages explicitly, one page per call, via `nextCursor`.
 */
export async function repairInvoicePayments(
  input: RepairInvoicePaymentsArgs = {},
): Promise<RepairInvoicePaymentsResult> {
  return call<RepairInvoicePaymentsArgs, RepairInvoicePaymentsResult>('repairInvoicePayments', input);
}

/**
 * reviewAndSendDraftInvoice (admin): flips a DRAFT invoice to open and
 * dispatches the `invoice.new` notification to the household. Throws
 * `failed-precondition` if the invoice isn't currently a draft, or if it's
 * missing a total, household, or invoice number (fail loud on an incomplete
 * draft rather than sending it anyway), `not-found` if the id is wrong.
 */
export async function reviewAndSendDraftInvoice(invoiceId: string): Promise<void> {
  await call<ReviewAndSendDraftInvoiceArgs, ReviewAndSendDraftInvoiceResult>('reviewAndSendDraftInvoice', {
    invoiceId,
  });
}

/**
 * updateInvoice (admin): edits an invoice's descriptive fields, its line items,
 * or both, and returns the money the server actually computed.
 *
 * THERE IS NO `total` IN `UpdateInvoiceArgsPatch`, AND THAT IS THE POINT. The
 * server's `patch` is `.strict()` and carries no total either, so a client that
 * tries to assert what an invoice is worth gets `invalid-argument` instead of
 * having its number quietly dropped. Every money figure is recomputed
 * server-side from the line items and the recorded payments, which is what makes
 * the total a household sees necessarily the sum of the lines it is shown.
 *
 * `lineItems` is the FULL replacement list, not a delta, and its PRESENCE is
 * what the server reads as "this patch touches money". Omit the key entirely on
 * a metadata-only edit rather than echoing back what is already stored.
 *
 * At least one field must be present. An empty patch is refused rather than
 * absorbed as a no-op, because it would stamp `updatedAt` and write an audit
 * entry describing a change that never happened. That is a zod `.refine`, which
 * the generated type cannot express, so it is a runtime refusal rather than a
 * compile error.
 *
 * IT WILL NOT RECOMPUTE AN UN-ITEMIZED INVOICE, which is the guard that matters
 * most on today's data: every invoice in the collection has zero line items, so
 * without it, correcting a due date would silently rewrite a real $40 invoice to
 * $0. A metadata patch against such an invoice leaves the money untouched.
 *
 * Throws `failed-precondition` with `details.code` of `invoice_not_editable`
 * (paid, cancelled, credit, redeemed), `quote_accepted_locked` (the household
 * ACCEPTED this quote, so the agreed figures are frozen — issue #448),
 * `invoice_money_locked` (a payment exists, so the money is frozen while the
 * metadata stays open), or `invoice_money_invalid` (a discount larger than what
 * it is taken off). `not-found` if the id is wrong. Branch on the CODE, never
 * the message.
 */
export async function updateInvoice(
  invoiceId: string,
  patch: UpdateInvoiceArgsPatch,
): Promise<UpdateInvoiceResultTotals> {
  const res = await call<UpdateInvoiceArgs, UpdateInvoiceResult>('updateInvoice', { invoiceId, patch });
  return res.totals;
}

/**
 * resendQuote (admin): sends a DECLINED quote back out once it has been revised
 * (issue #448).
 *
 * IT CLEARS THE HOUSEHOLD'S ANSWER, which is the whole point: both portals gate
 * their Accept/Decline buttons on there being no `quoteDecision`, so a resend is
 * what puts the quote back in front of the household as a live question. The
 * `invoice.new` notification fires again on the same key that issued it, and it
 * fires BEFORE the write, so there is no outcome where the quote reopens and
 * nobody is told.
 *
 * THIS IS NOT A NEW QUOTE. The invoice number, the line items and the linked
 * sessions all stay; only the answer is cleared, and `quoteResendCount` records
 * that the quote has been round before.
 *
 * Throws `failed-precondition` with `details.code` of `quote_accepted_locked`
 * (accepted, so it is a bill now), `quote_not_declined` (still waiting for an
 * answer — send a reminder instead), `quote_not_a_quote`, or `quote_expired`
 * (its due date has passed, so the household could only decline it again: give
 * it a new due date first, which is an ordinary edit). `not-found` if the id is
 * wrong. Branch on the CODE, never the message.
 */
export async function resendQuote(invoiceId: string): Promise<ResendQuoteResult['status']> {
  const res = await call<ResendQuoteArgs, ResendQuoteResult>('resendQuote', { invoiceId });
  return res.status;
}

/**
 * archiveInvoice (admin): stamps `archivedAt` / `archivedBy` so the invoice
 * drops out of the operator's working list and out of the outstanding and billed
 * totals.
 *
 * ARCHIVING IS NOT DELETION AND NOT CANCELLATION. The invoice keeps every field
 * it had, and the kinfolk portal is unaffected: the household still sees it and
 * can still pay it.
 *
 * `force` exists because archiving an invoice that money is still owed on
 * removes it from the very total that would remind anyone to collect it, which
 * is a decision to write off real money. Without `force` that is refused
 * (`failed-precondition`, `details.code: 'invoice_still_owing'`); with it the
 * audit entry records the write-off distinctly. A draft or a quote is exempt,
 * because neither was ever claimed from anyone.
 *
 * Re-archiving throws `invoice_already_archived` rather than succeeding
 * silently.
 */
export async function archiveInvoice(invoiceId: string, force = false): Promise<void> {
  await call<ArchiveInvoiceArgs, ArchiveInvoiceResult>('archiveInvoice', {
    invoiceId,
    ...(force ? { force: true } : {}),
  });
}

/**
 * unarchiveInvoice (admin): restores an archived invoice to the working list.
 *
 * Writes `archivedAt: null` rather than deleting the field, so a restored
 * invoice carries the same shape a future backfill would give every legacy
 * invoice, and because `isArchivedInvoice` already reads null as "not archived".
 * Throws `failed-precondition` when the invoice was not archived to begin with.
 */
export async function unarchiveInvoice(invoiceId: string): Promise<void> {
  await call<UnarchiveInvoiceArgs, UnarchiveInvoiceResult>('unarchiveInvoice', { invoiceId });
}

/**
 * listUninvoicedSessions (admin): completed visits that no invoice has claimed
 * yet, priced from the rate card where that is possible. Reads only; writes
 * nothing.
 *
 * PASS THE HOUSEHOLD AND LEAVE THE DATES OUT (#408). That is the composer's
 * whole query: the operator picks a household and its outstanding work appears,
 * however old it is. The optional `from`/`to` pair narrows the read afterwards,
 * and exists for one situation, a `truncated` page. They are INCLUSIVE
 * `YYYY-MM-DD` days and the server enforces two rules the generated type cannot
 * express (both zod `.refine`s): send both or neither, and `from` must not be
 * after `to`.
 *
 * The server compares them lexically against `kin_care_sessions.startTime`,
 * which is an ISO STRING rather than a Timestamp, and filters the completed
 * status, the already-invoiced check and the do-not-invoice flag IN MEMORY.
 * That is not laziness on its part: `status` casing is unenforced, and
 * `invoiceId` is ABSENT rather than empty on most sessions, so either predicate
 * applied server-side would silently drop real work instead of billing for it.
 *
 * `excluded` is work the operator has decided never to bill
 * (`setSessionDoNotInvoice`). It is deliberately NOT in `sessions`, and it is
 * returned rather than hidden so the decision can be undone where it was taken.
 *
 * A session's `unitCents` is NULL WHEN IT COULD NOT BE PRICED, AND NULL IS NOT
 * ZERO. A service the rate card does not hold, a rate that will not parse, and a
 * rate of zero all arrive as null, and the caller's job is to make the operator
 * TYPE a price. A silent 0 would bill a household nothing for real work and look
 * deliberate on the invoice. `unpriceable` is the subset to prompt for;
 * `rateCardLoaded: false` means `business_settings.serviceRates` is missing
 * ENTIRELY, which is a settings problem rather than a per-visit one and needs a
 * different sentence. `scanned` counts rows read BEFORE filtering, so an empty
 * result over 400 scanned rows means something, and `truncated` says the
 * server's page cap was reached and the window may hold more.
 */
export async function listUninvoicedSessions(
  kinfolkId: string,
  window?: { from: string; to: string },
): Promise<ListUninvoicedSessionsResult> {
  return call<ListUninvoicedSessionsArgs, ListUninvoicedSessionsResult>('listUninvoicedSessions', {
    kinfolkId,
    ...(window ? { from: window.from, to: window.to } : {}),
  });
}
/**
 * setSessionDoNotInvoice (admin): takes completed work out of the un-invoiced
 * queue without billing for it, or puts it back.
 *
 * REVERSIBLE BY CONSTRUCTION: the same callable, with `doNotInvoice: false`,
 * undoes it. Nothing is deleted, no money moves, and the visit keeps every
 * field it had.
 *
 * IT REFUSES A VISIT AN INVOICE ALREADY BILLS FOR, naming that invoice
 * (`session_already_invoiced`), because marking a billed visit do-not-invoice
 * would say two contradictory things about the same work while the household
 * holds the version that charges them. Unlink it first.
 *
 * THE WHOLE SELECTION IS CHECKED BEFORE ANY OF IT IS WRITTEN, so a batch either
 * applies or does not; there is no half-applied selection to work out
 * afterwards. `changed` and `unchanged` split the result, the second being
 * visits somebody had already marked, which is a no-op worth counting honestly
 * rather than an error.
 */
export async function setSessionDoNotInvoice(
  sessionIds: readonly string[],
  doNotInvoice: boolean,
  reason = '',
): Promise<SetSessionDoNotInvoiceResult> {
  return call<SetSessionDoNotInvoiceArgs, SetSessionDoNotInvoiceResult>('setSessionDoNotInvoice', {
    sessionIds: [...sessionIds],
    doNotInvoice,
    reason,
  });
}
