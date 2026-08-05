import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';

export const Args = z.object({
  invoiceId: z.string().min(1),
  kinfolkId: z.string().optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported, unlike the interface it
 * replaced, because the contract guard freezes it and decision 2 generates the
 * portal's type from it.
 *
 * `amountCents` IS THE REMAINING BALANCE, not the invoice total: on a part-paid
 * invoice those differ, and this is the figure Stripe was actually asked to
 * charge. `.positive()` because the handler refuses a zero-or-less balance
 * before it ever reaches Stripe. A checkout for nothing is not a response
 * this callable has.
 *
 * `checkoutUrl` is `.min(1)` even though the handler writes `session.url ?? ''`:
 * an empty URL is a Stripe response this code cannot use, and shipping it
 * would reach the household as a Pay button that opens nothing. The guard
 * reports it instead of letting it pass unremarked.
 */
export const Result = z
  .object({
    /** Stripe-hosted Checkout URL, opened via the platform's browser. */
    checkoutUrl: z.string().min(1),
    sessionId: z.string().min(1),
    /** What Stripe was asked to charge: the REMAINING balance, integer cents. */
    amountCents: z.number().int().positive(),
    /** ISO-4217, lowercase. Always 'usd' today; shipped so no client hardcodes it. */
    currency: z.string().min(1),
  })
  .strict();

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
export async function payInvoiceHandler(req: CallableRequest<unknown>): Promise<z.infer<typeof Result>> {
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

  // WHAT THE HOUSEHOLD IS CHARGED IS THE REMAINING BALANCE, not the total, and
  // on a part-paid invoice those differ. `amountDueCents` is the integer figure
  // the settlement pass writes (`lib/invoiceMath.ts`); the float dollar
  // `amountDue` is its projection and is all an older invoice carries. Read in
  // that order so a real card charge is never a re-rounding of a re-rounding.
  const amountCents =
    integerCentsOrNull(inv['amountDueCents']) ?? Math.round(numericFrom(inv['amountDue']) * 100);
  if (amountCents <= 0) throw new HttpsError('failed-precondition', 'Invoice is fully paid.');

  const stripe = await getStripe();
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

  return validateResponse('payInvoice', Result, {
    checkoutUrl: session.url ?? '',
    sessionId: session.id,
    amountCents,
    currency: 'usd',
  });
}

/**
 * An integer count of cents, or null when the field is absent or is not one.
 * Null rather than 0, so the caller falls back to the dollar field instead of
 * refusing a real balance as "fully paid".
 */
function integerCentsOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
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
