import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { paymentAppliedNoticeOwnedByWriter } from '../lib/paymentAppliedOwner';
import { invoiceStateOf, type InvoiceState } from '../lib/invoiceEditPolicy';

type InvoiceDoc = {
  kinfolkId?: string;      // family id, stamped by AuntieOS + portal writers
  status?: string;         // free-text: e.g. open | paid | past_due | overdue | draft
  amountDue?: number;      // numeric balance owed
  total?: number;
  currency?: string;
  dueDate?: string;
  invoiceDueDate?: string;
};

/**
 * Watches the FLAT top-level `invoices/{invoiceId}` collection (AuntieOS
 * Android + web write here). Fires a notification when an invoice is paid via
 * ANY write path (admin UI direct write, callable, or the Stripe webhook).
 * Overdue notices come from `invoiceOverdueCron` only (#871). #866: a paid transition is skipped when the write stamped a
 * new `paymentAppliedNoticeOwner`, because that writer sends the confirmation
 * itself, or decided nobody is told (lib/paymentAppliedOwner.ts). Other
 * transitions are handled elsewhere:
 *   - new invoice doc creation → postInvoiceEvent fires invoice.new
 *   - generic update          → postInvoiceEvent fires invoice.updated
 *   - charge failure          → stripeWebhook fires invoice.charge.failed
 */

/**
 * #884: THE STATES A PAID NOTICE MAY COME FROM. `invoice.payment.applied` fires
 * only when the write moves the invoice from one of these into `paid`, both read
 * by `invoiceStateOf` (lib/invoiceEditPolicy.ts), the one classifier.
 *
 * Before #884 the trigger had its own rule, `amountDue <= 0` unless draft or
 * cancelled, and a created doc's "before" read as not paid. So a $0 comped
 * invoice, an amount-less quote and an unlabeled credit each announced
 * "Payment applied" on create, and so did an edit that lowered the total.
 *
 * WHY ONLY `open`, decided from the payment code:
 *   - `quote` and `draft`: markInvoicePaid refuses them (`isDraftOrQuote`), and
 *     so does the apply path. Draft to paid is a review of a draft whose payments
 *     already cover it; no money moves in that write.
 *   - `cancelled` and `credit`: refused (`refusedLifecycle`). `redeemed` is a
 *     credit already turned into account balance; it is never paid.
 *   - `zero` (total 0): payInvoice refuses a $0 balance, and the credit draw
 *     needs a positive `amountDue`. The only payers that accept an overpayment
 *     of a $0 bill (markInvoicePaid, recordPayment's apply) stamp their own
 *     owner, so the trigger would stand down anyway. A zero doc that turns paid
 *     without a payment (a total added to a bill payments already cover) is not
 *     a payment, so it sends nothing.
 *   - `paid` to `paid` is not a transition.
 *   - Created docs have no "before", so they never send, whatever state they are
 *     created in. A migrated or imported paid invoice is history, not news.
 *
 * `open` includes an `overdue` or `past_due` label with a balance: the classifier
 * reads the money, so paying off an overdue bill still sends.
 *
 * TWO LEGACY SHAPES, read as the classifier reads them (ADR-0002), not patched
 * with a second rule here:
 *   - A doc with a `total` and no `amountDue` (`{ status: 'open', total: 40 }`)
 *     classifies `paid`, because a missing balance is no evidence of one. So
 *     paying one off is paid to paid here. The one payer that accepts that
 *     shape is the credit draw (onInvoiceAutoApply treats `amountDue` null as
 *     collectable; payInvoice refuses it; markInvoicePaid and recordPayment
 *     stamp their own owner), and since the #884 review the draw sends its own
 *     notice, so no real payment depends on this trigger reading that shape.
 *     The shared rule for a missing `amountDue` is #902.
 *   - A doc with `amountDue: 0` and no `total` classifies `zero`. Every payer
 *     writes `status: 'paid'` in the write that pays it, so that write reads
 *     `paid`, but from `zero`, and sends nothing unless the payer owns its notice.
 */
export const PAYMENT_APPLIED_FROM_STATES: readonly InvoiceState[] = ['open'];

/** #884: true when this write moved the invoice into `paid` from a state a payment pays. */
export function isPaidTransition(before: InvoiceDoc | undefined, after: InvoiceDoc | undefined): boolean {
  if (!before || !after) return false;
  return PAYMENT_APPLIED_FROM_STATES.includes(invoiceStateOf(before)) && invoiceStateOf(after) === 'paid';
}

type Lifecycle = 'paid' | 'past_due' | 'other';

/**
 * Resolves a coarse lifecycle from the real free-text status + amountDue.
 *
 * #884: its `paid` result no longer decides `invoice.payment.applied` (see
 * isPaidTransition).
 *
 * #871: it no longer sends anything either. The trigger's overdue notice is
 * gone (see invoiceWriteNoticeKey); what is left is #884's precedence, kept on
 * purpose: a write that moves the label to past due is never re-read as a
 * payment. Unchanged, so that reading stays exactly what #884 tested.
 */
export function resolveLifecycle(doc: InvoiceDoc | undefined): Lifecycle {
  if (!doc) return 'other';
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : '';
  const amountDue = typeof doc.amountDue === 'number' ? doc.amountDue : null;
  if (status === 'paid' || (amountDue != null && amountDue <= 0 && status !== 'cancelled' && status !== 'draft')) {
    return 'paid';
  }
  if (status === 'past_due' || status === 'past due' || status === 'overdue') {
    return 'past_due';
  }
  return 'other';
}

type InvoicesWriteEvent = FirestoreEvent<
  Change<DocumentSnapshot> | undefined,
  { invoiceId: string }
>;

/**
 * The notice this trigger sends for one write, or null. PURE, and exported so
 * the state stamp backfill's notification guard asks exactly this question
 * about its own writes (#884 second review).
 *
 * #871: THIS TRIGGER NEVER SENDS `invoice.overdue`. It used to, when a write
 * moved the free-text status to `past_due`/`past due`/`overdue`. No server
 * writer stamps those labels (the state stamp writes only the eight classifier
 * states), so the branch could fire only on a hand-written label, and it read
 * the label rather than the money or the due date: a cancelled bill relabelled
 * `overdue` would have been chased. Overdue is a function of the clock, which no
 * write carries. `invoiceOverdueCron` (scheduled/invoiceRemindersCron.ts) is the
 * one sender.
 */
export function invoiceWriteNoticeKey(
  before: InvoiceDoc | undefined,
  after: InvoiceDoc | undefined,
): 'invoice.payment.applied' | null {
  if (!after) return null;
  // #884's precedence, kept: a write that labels the invoice past due sends
  // nothing, and is never re-read as a payment. `{ status: 'overdue', total: 40 }`
  // with no `amountDue` classifies paid, but nobody paid anything.
  if (resolveLifecycle(after) === 'past_due' && resolveLifecycle(before) !== 'past_due') return null;
  if (isPaidTransition(before, after)) {
    // #866: the write that paid it named another sender (lib/paymentAppliedOwner.ts).
    if (paymentAppliedNoticeOwnedByWriter(before, after)) return null;
    return 'invoice.payment.applied';
  }
  return null;
}

export async function onInvoicesWriteHandler(event: InvoicesWriteEvent): Promise<void> {
  const before = event.data?.before.data() as InvoiceDoc | undefined;
  const after = event.data?.after.data() as InvoiceDoc | undefined;
  if (!after) return;

  const key = invoiceWriteNoticeKey(before, after);
  if (!key) return;

  const invoiceId = event.params.invoiceId;
  const kinfolkId = typeof after.kinfolkId === 'string' ? after.kinfolkId : '';
  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onInvoicesWrite',
      event: 'invoice.kinfolkId.missing',
      extra: { invoiceId, key },
    });
    return;
  }
  const recipientUid = await resolveKinfolkUid(kinfolkId);
  const baseData = {
    kinfolkId,
    invoiceId,
    amountDue: after.amountDue ?? null,
    currency: after.currency ?? null,
    dueDate: after.dueDate ?? after.invoiceDueDate ?? null,
  };

  try {
    await enqueueNotification({
      key,
      recipientUid: recipientUid ?? '',
      data: baseData,
      targetType: 'invoice',
      targetId: invoiceId,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onInvoicesWrite',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, invoiceId, key, err: (err as Error)?.message },
    });
  }
}

export const onInvoicesWrite = onDocumentWritten(
  {
    document: 'invoices/{invoiceId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onInvoicesWrite', onInvoicesWriteHandler),
);
