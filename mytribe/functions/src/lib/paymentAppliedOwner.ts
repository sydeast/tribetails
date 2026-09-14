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
 */
export const PAYMENT_APPLIED_OWNER_FIELD = 'paymentAppliedNoticeOwner';

/** Who took ownership. The id after the colon is for a reader tracing one payment; nothing parses it. */
export type PaymentAppliedOwnerSource = 'stripe' | 'recordPayment' | 'markInvoicePaid';

/** The stamp value: `stripe:<eventId>`, `recordPayment:<paymentId>` or `markInvoicePaid:<paymentId>`. */
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
 * The `markInvoicePaid` owner stamp a `recordPayment` for `kinfolkId` may claim
 * on this invoice, or null. Claimable means: the invoice is paid, belongs to that
 * household, was paid off by `markInvoicePaid`, and nobody has claimed that stamp.
 */
export function claimableMarkInvoicePaidOwner(
  invoice: Record<string, unknown> | undefined,
  kinfolkId: string,
): string | null {
  if (!invoice || kinfolkId === '' || invoice['kinfolkId'] !== kinfolkId) return null;
  const owner = invoice[PAYMENT_APPLIED_OWNER_FIELD];
  if (typeof owner !== 'string' || !owner.startsWith('markInvoicePaid:')) return null;
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
