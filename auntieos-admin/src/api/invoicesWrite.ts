import { call } from '../lib/fns';
import type {
  ArchiveInvoiceArgs,
  ArchiveInvoiceResult,
  CreateInvoiceArgs,
  CreateInvoiceResult,
  CreateQuoteArgs,
  CreateQuoteResult,
  GenerateReceiptArgs,
  GenerateReceiptResult,
  ListUninvoicedSessionsArgs,
  ListUninvoicedSessionsResult,
  MarkInvoicePaidArgs,
  MarkInvoicePaidResult,
  RepairInvoicePaymentsArgs,
  RepairInvoicePaymentsResult,
  ReviewAndSendDraftInvoiceArgs,
  ReviewAndSendDraftInvoiceResult,
  SendInvoiceReminderArgs,
  SendInvoiceReminderResult,
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
 */
export async function createInvoice(
  input: CreateInvoiceArgs,
): Promise<Pick<CreateInvoiceResult, 'invoiceId'>> {
  const res = await call<CreateInvoiceArgs, CreateInvoiceResult>('createInvoice', input);
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
 */
export async function createQuote(
  input: CreateQuoteArgs,
): Promise<Pick<CreateQuoteResult, 'invoiceId'>> {
  const res = await call<CreateQuoteArgs, CreateQuoteResult>('createQuote', input);
  return { invoiceId: res.invoiceId };
}

/**
 * sendInvoiceReminder (admin): on-demand resend of the `invoice.reminder`
 * notification for one invoice, right now. Throws (fail loud, never
 * swallowed) `failed-precondition` if the invoice is already paid, `not-found`
 * if the id is wrong.
 */
export async function sendInvoiceReminder(invoiceId: string): Promise<void> {
  await call<SendInvoiceReminderArgs, SendInvoiceReminderResult>('sendInvoiceReminder', { invoiceId });
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
 */
export async function markInvoicePaid(
  invoiceId: string,
  input: Omit<MarkInvoicePaidArgs, 'invoiceId'> = {},
): Promise<MarkInvoicePaidResult> {
  return call<MarkInvoicePaidArgs, MarkInvoicePaidResult>('markInvoicePaid', { invoiceId, ...input });
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
 * (paid, cancelled, credit, redeemed), `invoice_money_locked` (a payment exists,
 * so the money is frozen while the metadata stays open), or
 * `invoice_money_invalid` (a discount larger than what it is taken off).
 * `not-found` if the id is wrong. Branch on the CODE, never the message.
 */
export async function updateInvoice(
  invoiceId: string,
  patch: UpdateInvoiceArgsPatch,
): Promise<UpdateInvoiceResultTotals> {
  const res = await call<UpdateInvoiceArgs, UpdateInvoiceResult>('updateInvoice', { invoiceId, patch });
  return res.totals;
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
 * listUninvoicedSessions (admin): completed visits in a date window that no
 * invoice has claimed yet, priced from the rate card where that is possible.
 * Reads only; writes nothing.
 *
 * `from` and `to` are INCLUSIVE `YYYY-MM-DD` days, and the server also enforces
 * an ordering rule between them that the generated type cannot express (a zod
 * `.refine`), so a pair that typechecks can still be refused. It compares them
 * lexically against `kin_care_sessions.startTime`, which is an ISO STRING rather
 * than a Timestamp, and filters both the completed status and the
 * already-invoiced check IN MEMORY. That is not laziness on the server's part:
 * `status` casing is unenforced, and `invoiceId` is ABSENT rather than empty on
 * most sessions, so either predicate applied server-side would silently drop
 * real work instead of billing for it.
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
  from: string,
  to: string,
): Promise<ListUninvoicedSessionsResult> {
  return call<ListUninvoicedSessionsArgs, ListUninvoicedSessionsResult>('listUninvoicedSessions', {
    from,
    to,
  });
}
