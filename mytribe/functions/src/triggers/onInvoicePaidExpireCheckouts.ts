import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  CLOSED_CHECKOUT_SESSIONS_FIELD,
  sessionsToClose,
  type SweepDoc,
} from '../lib/checkoutSessionSweep';

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

/** The two Stripe calls this needs, typed on what is read so a test can stub them. */
export interface CheckoutSessionsApi {
  retrieve: (id: string) => Promise<unknown>;
  expire: (id: string) => Promise<unknown>;
}

function statusOf(raw: unknown): string {
  const s = (raw ?? {}) as { status?: unknown };
  return typeof s.status === 'string' ? s.status : '';
}

function isNotFound(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; raw?: { code?: unknown } };
  return e.code === 'resource_missing' || e.raw?.code === 'resource_missing' || e.statusCode === 404;
}

export type SessionOutcome = 'expired' | 'already-closed' | 'not-found' | 'failed';

export async function closeCheckoutSession(api: CheckoutSessionsApi, id: string): Promise<SessionOutcome> {
  let session: unknown;
  try {
    session = await api.retrieve(id);
  } catch (err) {
    return isNotFound(err) ? 'not-found' : 'failed';
  }
  if (statusOf(session) !== 'open') return 'already-closed';
  try {
    await api.expire(id);
    return 'expired';
  } catch {
    // Completed or expired between the two calls, or a real failure. Ask again.
    try {
      return statusOf(await api.retrieve(id)) === 'open' ? 'failed' : 'already-closed';
    } catch (err) {
      return isNotFound(err) ? 'not-found' : 'failed';
    }
  }
}

export async function onInvoicePaidExpireCheckoutsHandler(
  event: InvoicesWriteEvent,
  deps: { sessions?: () => Promise<CheckoutSessionsApi> } = {},
): Promise<void> {
  const before = event.data?.before.data() as SweepDoc | undefined;
  const after = event.data?.after.data() as SweepDoc | undefined;
  const ids = sessionsToClose(before, after);
  if (ids.length === 0) return;

  const invoiceId = event.params.invoiceId;
  let api: CheckoutSessionsApi;
  try {
    api = deps.sessions
      ? await deps.sessions()
      : await getStripe().then((s) => ({
          retrieve: (id: string) => s.checkout.sessions.retrieve(id),
          expire: (id: string) => s.checkout.sessions.expire(id),
        }));
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'onInvoicePaidExpireCheckouts',
      event: 'stripe.checkout.sweep.unavailable',
      extra: { invoiceId, sessionIds: ids, err: (err as Error)?.message },
    });
    return;
  }

  const closed: string[] = [];
  const outcomes: Record<string, SessionOutcome> = {};
  for (const id of ids) {
    const outcome = await closeCheckoutSession(api, id);
    outcomes[id] = outcome;
    if (outcome !== 'failed') closed.push(id);
  }

  if (closed.length > 0) {
    try {
      await db()
        .collection('invoices')
        .doc(invoiceId)
        .set(
          {
            [CLOSED_CHECKOUT_SESSIONS_FIELD]: FieldValue.arrayUnion(...closed),
            checkoutSessionsClosedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (err) {
      // The sessions are closed at Stripe either way; a re-run re-reads them
      // as not open and records them then.
      logEvent({
        severity: 'warn',
        function: 'onInvoicePaidExpireCheckouts',
        event: 'stripe.checkout.sweep.stamp.failed',
        extra: { invoiceId, closed, err: (err as Error)?.message },
      });
    }
  }

  const failed = ids.filter((id) => outcomes[id] === 'failed');
  logEvent({
    severity: failed.length > 0 ? 'error' : 'info',
    function: 'onInvoicePaidExpireCheckouts',
    event: failed.length > 0 ? 'stripe.checkout.sweep.partial' : 'stripe.checkout.sweep.done',
    extra: { invoiceId, outcomes },
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
