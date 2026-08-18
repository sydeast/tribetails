import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { syncStripeCardToClient, SETUP_SESSION_PURPOSE } from '../portal/billing';

/**
 * The `checkout.session.completed` event a card-save produces, as opposed to
 * the one an invoice payment produces (issue #399, item 3).
 *
 * `createBillingSetupSession` opens the session in `mode: 'setup'`, so Stripe
 * charges nothing and the session carries a `setup_intent` and a `customer`
 * instead of an `invoiceId`. `stripeWebhook`'s metadata gate resolves the
 * household from `metadata.invoiceId`, which a setup session has never had, so
 * without a branch ahead of that gate every saved card would arrive as a
 * `stripe.metadata.missing` warning naming the wrong problem.
 */
export interface SetupSessionEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

interface SetupSessionObject {
  id?: string;
  mode?: string;
  customer?: string | { id?: string } | null;
  status?: string;
  metadata?: Record<string, string> | null;
}

function sessionObjectOf(event: SetupSessionEvent): SetupSessionObject {
  const obj = event.data.object;
  return (obj && typeof obj === 'object' ? obj : {}) as SetupSessionObject;
}

/**
 * True for a completed Checkout Session this codebase opened to save a card.
 *
 * Both conditions are required. `mode === 'setup'` is Stripe's own word for
 * "collected an instrument, charged nothing", and the `purpose` metadata is
 * ours: it proves the session came from `createBillingSetupSession` rather
 * than from some future setup flow that stores its result somewhere else.
 */
export function isSetupSessionEvent(event: SetupSessionEvent): boolean {
  if (event.type !== 'checkout.session.completed') return false;
  const session = sessionObjectOf(event);
  return session.mode === 'setup' && session.metadata?.purpose === SETUP_SESSION_PURPOSE;
}

/** The Stripe customer id, whether Stripe expanded the object or not. */
function customerIdOf(session: SetupSessionObject): string | null {
  const c = session.customer;
  if (typeof c === 'string' && c.length > 0) return c;
  if (c && typeof c === 'object' && typeof c.id === 'string' && c.id.length > 0) return c.id;
  return null;
}

/**
 * Mirrors the card the household just saved onto their `clients/{uid}` doc.
 *
 * Returns the HTTP status `stripeWebhook` should answer with. Everything that
 * is not actionable answers 202: Stripe retries any non-2xx, and a retry
 * cannot fix a session whose metadata never named a uid.
 */
export async function handleSetupSessionCompleted(event: SetupSessionEvent): Promise<number> {
  const session = sessionObjectOf(event);
  const uid = session.metadata?.uid;
  const customerId = customerIdOf(session);

  if (!uid || !customerId) {
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.setup.unresolvable',
      extra: { eventId: event.id, sessionId: session.id ?? null, hasUid: Boolean(uid), hasCustomer: Boolean(customerId) },
    });
    return 202;
  }

  // Deduped against the portal's own `syncMyPaymentMethod`, which normally
  // runs first: the sync reports `changed: false` when the stored id already
  // matches, so this branch is a no-op write rather than a second card.
  const snap = await db().collection('clients').doc(uid).get();
  if (!snap.exists) {
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.setup.clientMissing',
      extra: { eventId: event.id, uid },
    });
    return 202;
  }
  const previous = snap.data()?.['stripePaymentMethodId'];
  const result = await syncStripeCardToClient(
    uid,
    customerId,
    typeof previous === 'string' ? previous : null,
  );

  logEvent({
    severity: 'info',
    function: 'stripeWebhook',
    event: 'stripe.setup.cardStored',
    uid,
    extra: {
      eventId: event.id,
      sessionId: session.id ?? null,
      hasPaymentMethod: result.hasPaymentMethod,
      changed: result.changed,
    },
  });
  return 200;
}
