/**
 * #866: WHO SENDS `invoice.payment.applied` FOR THE WRITE THAT PAID AN INVOICE.
 *
 * Three places can send it: the Stripe webhook, `recordPayment` (the admin's
 * Send Confirmation toggle), and the `onInvoicesWrite` trigger when an invoice
 * turns paid. Before #866 the trigger sent on every paid transition, so a card
 * payment or a confirmed admin payment reached the household twice, and an
 * UNTICKED admin payment still told the household through the trigger.
 *
 * THE RULE. A writer that owns the notice for its payment stamps
 * `paymentAppliedNoticeOwner` in the SAME write that turns the invoice paid.
 * The trigger stands down when, and only when, that write changed the stamp.
 * The ownership table lives beside the catalog entry in
 * `notifications/catalog.ts`.
 *
 * WHY A STAMP IN THE SAME WRITE, AND NOT A SHARED DEDUPE IDENTITY.
 *   - The admin toggle has to be able to mean "nobody tells the household".
 *     A shared identity only merges two sends into one; it cannot make the
 *     trigger send nothing when the admin sent nothing.
 *   - The stamp commits atomically with the paid transition, so the trigger's
 *     `after` snapshot always carries it. There is no ordering race to lose,
 *     whichever of the owner's enqueue and the trigger runs first.
 *   - Retries stay covered by what already exists: a Stripe retry stops at
 *     `stripeEvents/{id}` before any enqueue, a `recordPayment` replay returns
 *     before its confirmation, and a doubled trigger delivery is caught by the
 *     dispatcher ledger (#832) on `invoice:<id>`.
 *
 * WHY "CHANGED IN THIS WRITE" AND NOT "PRESENT". The stamp stays on the doc. A
 * bill paid by card, reopened by an edit, and then paid off by account credit
 * still carries the card's stamp, and the credit draw stamps nothing because
 * the trigger is its only sender. Reading mere presence would silence exactly
 * that notice.
 *
 * #884: AN OWNER THAT SENDS NOTHING. `updateInvoice` can settle a bill without
 * a payment: an edit that lowers the total to what has already been paid. No
 * money moved, so nobody is told, and the audit entry (`settledByEdit`) is the
 * office's record. It stamps `updateInvoice:<uuid>` in the write that turns the
 * invoice paid, so the trigger stands down by the same rule. Two details:
 *   - The id is fresh on every settling edit. A constant would read as
 *     unchanged on a second settle-by-edit after a reopen, and the trigger
 *     would send.
 *   - It stamps only when the edit moves the invoice INTO paid. An edit to an
 *     invoice that is already paid must not overwrite a `markInvoicePaid:<id>`
 *     stamp that `recordPayment` has yet to claim.
 * The trigger also sends only on a transition from `open` into `paid`
 * (`PAYMENT_APPLIED_FROM_STATES` in triggers/onInvoicesWrite.ts), so a created
 * doc, a $0 invoice, a quote or a credit never needs a stamp to stay silent.
 *
 * #884 review: THE CREDIT DRAW OWNS ITS NOTICE TOO. `drawAccountCredit` stamps
 * `accountCredit:<paymentId>` in the write that pays the bill off and sends the
 * notice itself after the commit. It used to leave that to the trigger, but a
 * legacy invoice with a `total` and no `amountDue` already reads `paid` to
 * invoiceStateOf, and the credit draw is the one payer that accepts that shape,
 * so the trigger saw paid to paid and a real payment went unannounced. The
 * earlier paragraph's "the credit draw stamps nothing" describes #866; the
 * rule it illustrates (changed in this write, not present) is unchanged.
 */
export const PAYMENT_APPLIED_OWNER_FIELD = 'paymentAppliedNoticeOwner';

/**
 * #884 second review: THE CREDIT DRAW'S NOTICE STAYS PENDING UNTIL IT IS OUT.
 *
 * The draw sends after its commit. A crash between the two used to lose the
 * notice for good: a redelivered pass finds the bill paid and draws nothing, and
 * `onInvoicesWrite` stands down on the `accountCredit:*` owner. On main the
 * trigger sent from its own at-least-once event. So, as the Stripe webhook does
 * with `stripeEvents/{id}` (#866):
 *   - the settling write stamps PENDING with the owner (`accountCredit:<id>`)
 *     and PENDING_AT, in the same commit as the payment;
 *   - a delivered notice clears PENDING to '' and stamps SENT_AT; a notice that
 *     can reach nobody clears it and stamps SKIPPED ('no-recipients');
 *   - a redelivered pass that finds the bill paid, and `notificationScheduledSweep`
 *     once PENDING is older than the grace period, resend from the stamp.
 * Every send carries the payment row id and a long ledger window, so the
 * dispatcher delivers one copy however many of those three race.
 * '' rather than a deleted field, so the sweep's range query needs no index
 * and no FieldValue sentinel.
 */
export const PAYMENT_APPLIED_PENDING_FIELD = 'paymentAppliedNoticePending';
export const PAYMENT_APPLIED_PENDING_AT_FIELD = 'paymentAppliedNoticePendingAtMs';
export const PAYMENT_APPLIED_SENT_AT_FIELD = 'paymentAppliedNoticeSentAt';
export const PAYMENT_APPLIED_SKIPPED_FIELD = 'paymentAppliedNoticeSkippedReason';

/** Who took ownership. The id after the colon is for a reader tracing one payment; nothing parses it. */
export type PaymentAppliedOwnerSource =
  | 'stripe'
  | 'recordPayment'
  | 'markInvoicePaid'
  | 'updateInvoice'
  | 'accountCredit';

/**
 * The stamp value: `stripe:<eventId>`, `recordPayment:<paymentId>`,
 * `markInvoicePaid:<paymentId>`, `accountCredit:<paymentId>` (#884 review), or
 * `updateInvoice:<uuid>` (#884, sends nothing).
 */
export function paymentAppliedOwner(source: PaymentAppliedOwnerSource, id: string): string {
  return `${source}:${id}`;
}

/**
 * #866: written on the invoice by the `recordPayment` step that follows a
 * settling `markInvoicePaid`, holding the owner stamp it claimed.
 *
 * WHY A CLAIM. The office is told "paid" only by a payment that pays the invoice
 * off (operator ruling), and in the two-step admin flow the step that knows the
 * toggle (`recordPayment`) is not the step that paid the bill. The claim lets
 * exactly one `recordPayment` act for that settlement: a later payment linked
 * to the same invoice finds the stamp already claimed and sends nothing.
 */
export const PAYMENT_APPLIED_CLAIM_FIELD = 'paymentAppliedNoticeClaim';

/**
 * #866: when the owner stamp was written (ms epoch), beside it in the same write.
 * Only read to let an older admin client, which does not send the settlement id,
 * claim a settlement it made moments ago (OLD_CLIENT_CLAIM_WINDOW_MS).
 */
export const PAYMENT_APPLIED_OWNER_AT_FIELD = 'paymentAppliedNoticeOwnerAtMs';

/**
 * How recently a `markInvoicePaid` settlement must have been stamped for a
 * `recordPayment` WITHOUT `settledByInvoicePaymentId` to claim it. Installed
 * React and Android builds from before #866 call the two steps back to back, so
 * their step 2 lands seconds after step 1; 5 minutes covers a cold start and a
 * slow network with room to spare, and is far short of the days-later unrelated
 * payment that must not claim (the P3 case).
 */
export const OLD_CLIENT_CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * The stamp's time and the claiming call's time are both `Date.now()`, but on
 * different function instances whose clocks can disagree by a little. A stamp
 * that reads as up to this far in the future is still this call's own
 * settlement; one further ahead than that is not trusted.
 */
export const OLD_CLIENT_CLAIM_CLOCK_SKEW_MS = 5 * 1000;

/**
 * The `markInvoicePaid` owner stamp a `recordPayment` for `kinfolkId` may claim
 * on this invoice, or null. Claimable means: the invoice is paid, belongs to that
 * household, was paid off by `markInvoicePaid`, nobody has claimed that stamp,
 * and the stamp is this call's own settlement:
 *
 *   - `invoicePaymentId` given (current clients): the stamp must be exactly
 *     `markInvoicePaid:<invoicePaymentId>`.
 *   - not given (older installed clients): the stamp must have been written
 *     within OLD_CLIENT_CLAIM_WINDOW_MS of `nowMs`, by its own recorded time.
 *
 * WHY. Without that, any later payment linked to the invoice (days later, a
 * different payment) could claim a settlement whose own `recordPayment` step
 * never ran, and tell the office "paid" under the wrong payment.
 */
export function claimableMarkInvoicePaidOwner(
  invoice: Record<string, unknown> | undefined,
  kinfolkId: string,
  invoicePaymentId: string | undefined,
  nowMs: number,
): string | null {
  if (!invoice || kinfolkId === '' || invoice['kinfolkId'] !== kinfolkId) return null;
  const owner = invoice[PAYMENT_APPLIED_OWNER_FIELD];
  if (typeof owner !== 'string' || !owner.startsWith('markInvoicePaid:')) return null;
  if (invoicePaymentId) {
    if (owner !== paymentAppliedOwner('markInvoicePaid', invoicePaymentId)) return null;
  } else {
    const at = invoice[PAYMENT_APPLIED_OWNER_AT_FIELD];
    if (typeof at !== 'number' || !Number.isFinite(at) || nowMs - at > OLD_CLIENT_CLAIM_WINDOW_MS || at - nowMs > OLD_CLIENT_CLAIM_CLOCK_SKEW_MS) {
      return null;
    }
  }
  if (invoice[PAYMENT_APPLIED_CLAIM_FIELD] === owner) return null;
  const status = typeof invoice['status'] === 'string' ? invoice['status'].trim().toLowerCase() : '';
  return status === 'paid' ? owner : null;
}

/** True when the write from `before` to `after` stamped a new notice owner. */
export function paymentAppliedNoticeOwnedByWriter(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  const owner = after?.[PAYMENT_APPLIED_OWNER_FIELD];
  if (typeof owner !== 'string' || owner === '') return false;
  return before?.[PAYMENT_APPLIED_OWNER_FIELD] !== owner;
}
