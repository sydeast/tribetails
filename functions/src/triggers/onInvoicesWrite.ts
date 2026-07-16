import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

type InvoiceDoc = {
  kinfolkId?: string;      // family id, stamped by AuntieOS + portal writers
  status?: string;         // free-text: e.g. open | paid | past_due | overdue | draft
  amountDue?: number;      // numeric balance owed; <= 0 means settled
  total?: number;
  currency?: string;
  dueDate?: string;
  invoiceDueDate?: string;
};

/**
 * Watches the FLAT top-level `invoices/{invoiceId}` collection (AuntieOS
 * Android + web write here). Fires a notification when an invoice crosses
 * into a "paid" or "past due" state via ANY write path (admin UI direct
 * write, callable, or the Stripe webhook). Other transitions are handled
 * elsewhere:
 *   - new invoice doc creation → postInvoiceEvent fires invoice.new
 *   - generic update          → postInvoiceEvent fires invoice.updated
 *   - charge failure          → stripeWebhook fires invoice.charge.failed
 *
 * The real flat docs carry a free-text `status` plus a numeric `amountDue`;
 * there is no quote/accepted lifecycle or paymentStatus enum, so the state is
 * derived from those two fields.
 */

type Lifecycle = 'paid' | 'past_due' | 'other';

/** Resolves a coarse lifecycle from the real free-text status + amountDue. */
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

export async function onInvoicesWriteHandler(event: InvoicesWriteEvent): Promise<void> {
  const before = event.data?.before.data() as InvoiceDoc | undefined;
  const after = event.data?.after.data() as InvoiceDoc | undefined;
  if (!after) return;

  const beforeLifecycle = resolveLifecycle(before);
  const afterLifecycle = resolveLifecycle(after);
  if (beforeLifecycle === afterLifecycle) return;

  let key: 'invoice.payment.applied' | 'invoice.overdue' | null = null;
  if (afterLifecycle === 'paid' && beforeLifecycle !== 'paid') key = 'invoice.payment.applied';
  else if (afterLifecycle === 'past_due' && beforeLifecycle !== 'past_due') key = 'invoice.overdue';
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
