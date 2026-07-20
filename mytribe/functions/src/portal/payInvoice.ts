import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  invoiceId: z.string().min(1),
  kinfolkId: z.string().optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

interface PayInvoiceResult {
  /** Stripe-hosted Checkout URL, open this in the platform's browser. */
  checkoutUrl: string;
  sessionId: string;
  amountCents: number;
  currency: string;
}

/**
 * Creates a Stripe Checkout Session for a flat-collection `invoices/{invoiceId}` doc.
 *
 * Cross-platform: returns a URL the client opens via the platform's browser
 * (web: window.location, JVM: Desktop.browse, android: ACTION_VIEW intent).
 *
 * Auth: caller must be a kinfolk whose `clients/{uid}.kinfolkIds` includes
 * the invoice's kinfolkId. The webhook (`stripeWebhook`) marks the invoice
 * paid via `payment_intent.succeeded` event with metadata.
 */
export async function payInvoiceHandler(req: CallableRequest<unknown>): Promise<PayInvoiceResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);
  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowedIds.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');

  const invoiceSnap = await firestore.collection('invoices').doc(args.invoiceId).get();
  if (!invoiceSnap.exists) throw new HttpsError('not-found', 'Invoice not found.');
  const inv = invoiceSnap.data() as Record<string, unknown>;
  const kinfolkId = (typeof inv['kinfolkId'] === 'string' ? (inv['kinfolkId'] as string) : null);
  if (!kinfolkId) throw new HttpsError('failed-precondition', 'Invoice not linked to a tribe.');
  if (!allowedIds.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access to this invoice.');
  await requireKinfolkPrimary(uid, kinfolkId, req.auth?.token?.admin === true, 'payInvoice');

  const amountDue = numericFrom(inv['amountDue']);
  if (amountDue <= 0) throw new HttpsError('failed-precondition', 'Invoice is fully paid.');

  const amountCents = Math.round(amountDue * 100);
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: `Invoice #${args.invoiceId}`,
            description: typeof inv['client'] === 'string' ? (inv['client'] as string) : `Tribe ${kinfolkId}`,
          },
        },
      },
    ],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    metadata: {
      invoiceId: args.invoiceId,
      // familyId is what the webhook resolves on; kinfolkId kept for back-compat.
      familyId: kinfolkId,
      kinfolkId,
      uid,
      source: 'mytribe-portal',
    },
  });

  await firestore.collection('invoices').doc(args.invoiceId).set({
    pendingCheckoutSessionId: session.id,
    pendingAt: new Date(),
  }, { merge: true });

  logEvent({
    severity: 'info',
    function: 'payInvoice',
    event: 'portal.invoice.checkout.created',
    uid,
    extra: { invoiceId: args.invoiceId, kinfolkId, amountCents, sessionId: session.id },
  });

  return {
    checkoutUrl: session.url ?? '',
    sessionId: session.id,
    amountCents,
    currency: 'usd',
  };
}

function numericFrom(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export const payInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('payInvoice', payInvoiceHandler),
);
