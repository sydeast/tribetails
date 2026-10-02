import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { sessionsToClose, type SweepDoc } from '../lib/checkoutSessionSweep';
import {
  closeCheckoutSession,
  liveSessionsApi,
  recordCheckoutSweep,
  runCheckoutSweep,
  sweepRanAtKey,
  unreachableRun,
  type CheckoutSessionsApi,
  type SessionOutcome,
} from '../lib/checkoutSweepRun';

/**
 * WHEN AN INVOICE BECOMES PAID, CLOSE EVERY OPEN STRIPE CHECKOUT FOR IT
 * (operator ruling 2026-09-27, docket Q5: a paid invoice takes no payment).
 *
 * `payInvoice` refuses a paid invoice from now on. This closes the other door:
 * a session minted while the bill was still owed. Whatever marked the invoice
 * paid (the Stripe webhook, `markInvoicePaid`, `recordPayment`, the credit
 * draw), this trigger sees the write and asks Stripe to expire the sessions
 * `lib/checkoutSessionSweep.ts` lists.
 *
 * A THIRD trigger on `invoices/{id}`, beside `onInvoicesWrite` (who to tell)
 * and `onInvoiceAutoApply` (credit draw), because it is the only one that
 * needs the Stripe key, and binding a payment secret to the notification
 * trigger to save a function would widen who holds it.
 *
 * PER SESSION:
 *   open                 expire it. Stripe then refuses payment on it.
 *   complete / expired   nothing to do; recorded as closed.
 *   not found            recorded as closed: there is nothing left to pay on.
 *   any other failure    left off the closed list and logged at `error`. The
 *                        next write to the invoice retries it, and if a charge
 *                        does land, the webhook records it as an unapplied
 *                        payment for the admin (never credit, never refund).
 *
 * If the household completes a session between the retrieve and the expire,
 * Stripe refuses the expire. That payment is the race the webhook handles, so
 * the session is re-read and, no longer open, recorded as closed.
 *
 * NEVER THROWS. A rethrow would make Firestore retry the whole trigger; the
 * closed list already makes a later pass cheap and exact.
 */

type InvoicesWriteEvent = FirestoreEvent<Change<DocumentSnapshot> | undefined, { invoiceId: string }>;

export { closeCheckoutSession, type CheckoutSessionsApi, type SessionOutcome };

export async function onInvoicePaidExpireCheckoutsHandler(
  event: InvoicesWriteEvent,
  deps: { sessions?: () => Promise<CheckoutSessionsApi> } = {},
): Promise<void> {
  const before = event.data?.before.data() as SweepDoc | undefined;
  const after = event.data?.after.data() as SweepDoc | undefined;
  // The sweep's own record (#1113) is not an invoice change: do not sweep on it.
  if (sweepRanAtKey(after) !== sweepRanAtKey(before)) return;
  const ids = sessionsToClose(before, after);
  if (ids.length === 0) return;
  const invoiceId = event.params.invoiceId;
  let run;
  try {
    const api = await (deps.sessions ?? liveSessionsApi)();
    run = await runCheckoutSweep(api, ids);
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'onInvoicePaidExpireCheckouts',
      event: 'stripe.checkout.sweep.unavailable',
      extra: { invoiceId, sessionIds: ids, err: (err as Error)?.message },
    });
    run = unreachableRun(ids);
  }
  try {
    await recordCheckoutSweep(invoiceId, run);
  } catch (err) {
    // The sessions are closed at Stripe either way; a re-run re-reads them
    // as not open and records them then.
    logEvent({
      severity: 'warn',
      function: 'onInvoicePaidExpireCheckouts',
      event: 'stripe.checkout.sweep.stamp.failed',
      extra: { invoiceId, closed: run.closed, err: (err as Error)?.message },
    });
  }
  logEvent({
    severity: run.failed.length > 0 ? 'error' : 'info',
    function: 'onInvoicePaidExpireCheckouts',
    event: run.failed.length > 0 ? 'stripe.checkout.sweep.partial' : 'stripe.checkout.sweep.done',
    extra: { invoiceId, outcomes: run.outcomes },
  });
}
export const onInvoicePaidExpireCheckouts = onDocumentWritten(
  {
    document: 'invoices/{invoiceId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN', 'STRIPE_SECRET_KEY'],
  },
  wrapTrigger('onInvoicePaidExpireCheckouts', (event: InvoicesWriteEvent) => onInvoicePaidExpireCheckoutsHandler(event)),
);
