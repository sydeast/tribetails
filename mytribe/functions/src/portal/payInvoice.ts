import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { settingsForInvoice, stripeCheckoutMethodTypes } from '../lib/paymentMethods';
import { readLivePayMethodSettings } from '../lib/payMethodSnapshot';
import {
  CHECKOUT_ROUND_FIELD,
  CHECKOUT_ROUND_METADATA_KEY,
  checkoutRoundOf,
} from '../lib/invoiceCheckoutDedupe';
import { CheckoutIdempotencyKeyArg } from '../lib/moneyIdempotency';

export const Args = z.object({
  invoiceId: z.string().min(1),
  kinfolkId: z.string().optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  /**
   * #825: mint one per SUBMISSION, not per tap, and Stripe answers a retry with
   * the session the first attempt created instead of opening a second one.
   *
   * THIS KEY IS HANDED TO STRIPE, NOT CHECKED HERE, and that is the only place
   * it can work: the duplicate a replay makes is a second Checkout Session in
   * STRIPE's database, and both sessions stay payable. Nothing this server
   * writes can stop that session being created. Only Stripe can, and this is
   * how it is asked to.
   *
   * IT SITS IN FRONT OF TWO OTHER LAYERS, not instead of them. The reuse below
   * hands back a session this invoice already has open, which needs a previous
   * call to have finished and stored one; this key covers the call that did
   * not, where Stripe made the session and the reply was lost coming back.
   * `stripeWebhook`'s #826 refusal is the last layer and the only one still
   * available once a card has been charged, and it RECONCILES rather than
   * rejects, because a charge that happened cannot be refused.
   *
   * OPTIONAL, so the portal and the desktop console adopt it separately.
   */
  idempotencyKey: CheckoutIdempotencyKeyArg,
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
 * the invoice's kinfolkId.
 *
 * `stripeWebhook` marks the invoice paid off whichever of the two events a
 * successful card payment delivers first — `checkout.session.completed` or
 * `payment_intent.succeeded` — and dedupes the other against it. Both need the
 * metadata below, and they read it from DIFFERENT objects, which is why it is
 * stamped twice.
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

  // WHICH SETTLEMENT ROUND THIS SESSION BELONGS TO (issue #826).
  //
  // The count of Stripe payments that have already settled this invoice. It is
  // what lets the webhook tell "the household opened checkout twice for one
  // bill" from "the bill came back and they paid it again": two sessions minted
  // before either settled carry the SAME round, and the first to land moves the
  // invoice past it. `lib/invoiceCheckoutDedupe.ts` carries the full argument.
  //
  // Stripe metadata values are strings, hence `String(...)`.
  const checkoutRound = checkoutRoundOf(inv[CHECKOUT_ROUND_FIELD]);

  // The identifiers the webhook resolves the household and invoice from.
  // Declared ONCE and passed to both places below, because the two copies
  // drifting apart is the same defect in a subtler form.
  const checkoutMetadata = {
    invoiceId: args.invoiceId,
    // familyId is what the webhook resolves on; kinfolkId kept for back-compat.
    familyId: kinfolkId,
    kinfolkId,
    uid,
    source: 'mytribe-portal',
    [CHECKOUT_ROUND_METADATA_KEY]: String(checkoutRound),
  };

  // WHICH RAILS THIS SESSION ACCEPTS (issue #409). Card was hardcoded here.
  // Klarna and Affirm are Stripe payment method types rather than separate
  // integrations, so offering them is one more string in this array: no new
  // secret, no new webhook, the same PaymentIntent and the same
  // `stripeWebhook` settlement on the other side.
  //
  // Read off the invoice's own frozen options when it has them, so a bill
  // issued while Affirm was on keeps offering Affirm after the operator
  // turns it off. Live settings otherwise, which is every invoice issued
  // before the snapshot existed. Card is always in the list
  // (`stripeCheckoutMethodTypes` says why), so this cannot produce a
  // checkout that has no way to take a card.
  //
  // Fail-soft on the settings read alone: an unreachable settings doc means
  // card-only checkout, never a household unable to pay a bill.
  const liveSettings = await readLivePayMethodSettings().catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.settings.unreadable',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { invoiceId: args.invoiceId },
    });
    return {};
  });
  const methodTypes = stripeCheckoutMethodTypes(settingsForInvoice(inv, liveSettings));

  const stripe = await getStripe();
  /**
   * #825: the key rides as a REQUEST OPTION, Stripe's second argument, which is
   * where Stripe's own idempotency lives. Given one, Stripe replays the stored
   * response for 24 hours rather than creating a second session.
   *
   * ── WHAT THIS CATCHES THAT THE SESSION REUSE ABOVE CANNOT (#826 / #825) ──
   *
   * They are not two spellings of one fix. The reuse can only hand back a
   * session it can FIND, and it finds it through `pendingCheckoutSessionId`,
   * which is written AFTER `sessions.create` returns. So the reuse covers the
   * case where the first call finished: two taps, a reload, a second device.
   *
   * It is blind to the case where the first call did NOT finish. Stripe creates
   * the session, and then the container is killed, or the Firestore write
   * fails, or the reply is dropped on the way back and the client sees
   * `functions/internal`. Nothing was stored, so the retry's lookup finds
   * nothing, mints a second session, and the household now has two live
   * checkouts for one bill. That is exactly the window #825 exists to close,
   * and the key closes it inside Stripe, before a second session exists at all.
   *
   * `stripeWebhook`'s refusal is the third and last layer, and the only one
   * that still applies once a card has actually been charged. It reconciles
   * rather than rejects, because a charge that happened cannot be refused.
   *
   * ── WHY THE ROUND AND THE AMOUNT ARE IN THE KEY ─────────────────────────
   *
   * Because Stripe REFUSES a key reused with a different body, and #826's reuse
   * deliberately mints a FRESH session when the amount or the round has moved.
   * Left alone, those two rules would collide in a case that really happens: a
   * household taps Pay, the reply is lost, the operator records a partial Venmo
   * payment, and the household taps again holding the same key. The body now
   * carries a smaller `unit_amount`, and a bare caller key would earn a Stripe
   * error on a bill somebody is trying to settle.
   *
   * So the Stripe-facing key is derived from the caller's key plus the two
   * things `findReusableSession` treats as making a session unusable. Same
   * submission, unchanged balance: same derived key, and Stripe replays the
   * first session. Balance moved: a different derived key, a fresh session,
   * which is what #826 wanted anyway. The two rules can no longer disagree,
   * because they now turn on the same facts.
   *
   * THE RETURN URLS ARE NOT IN THE KEY, and that is the one reuse condition
   * left out. They are constant per client (the web portal sends
   * `/invoices/{id}`, the KMP portal sends `/portal/payment-success`) and the
   * key is minted client-side per submission, so one key cannot arrive with two
   * different url pairs. Folding two full URLs into a 255-character key to
   * restate something the key's own provenance already guarantees would buy
   * nothing.
   *
   * `suffix` IS FOR THE FALLBACK, which sends a different body for a different
   * reason: the card-only retry below drops the method types Stripe just
   * rejected. It carries its own derived key so that graceful fallback does not
   * become a hard error either.
   */
  // Deliberately un-annotated. `Stripe.RequestOptions` resolves to two
  // incompatible declarations in this package (a cjs copy and an esm copy, each
  // with its own private `StripeContext`), so naming the type makes the call
  // below unassignable to itself. An object literal is checked against
  // whichever declaration the call site actually uses, which is the one that
  // matters.
  const requestOptions = (suffix: string) =>
    args.idempotencyKey === undefined
      ? undefined
      : { idempotencyKey: `${args.idempotencyKey}_r${checkoutRound}_${amountCents}${suffix}` };
  const createSession = (paymentMethodTypes: string[], keySuffix: string) =>
    stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: paymentMethodTypes as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
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
      // Rides `checkout.session.completed`.
      metadata: checkoutMetadata,
      // Rides `payment_intent.succeeded`, and IS THE ONE THAT MATTERS. Stripe
      // does not copy Session metadata onto the PaymentIntent it creates — that
      // is precisely why the SDK exposes this as a separate parameter
      // (`SessionCreateParams.PaymentIntentData.metadata`). Without it the
      // PaymentIntent event arrives with `metadata: {}`, `stripeWebhook` cannot
      // resolve the household, and a household that really was charged keeps an
      // invoice reading outstanding and keeps getting reminder emails.
      payment_intent_data: { metadata: checkoutMetadata },
    }, requestOptions(keySuffix));

  // WHEN STRIPE REFUSES A METHOD TYPE, THE HOUSEHOLD STILL GETS TO PAY.
  //
  // Klarna and Affirm have to be activated on the operator's own Stripe
  // account, and there is no way for this server to know whether she has
  // done it: the toggle lives here, the activation lives in her Stripe
  // dashboard. When they disagree Stripe answers with an invalid-request
  // error naming the type, and the honest response to that is a card-only
  // checkout plus a warn line an operator can be shown, NOT a Pay button
  // that throws on a bill somebody is trying to settle.
  //
  // Only that one error is caught. A declined key, a network failure, a bad
  // amount: all of those still surface, because retrying them card-only
  // would fail identically and hide the real cause.
  // REUSE THE SESSION THIS INVOICE ALREADY HAS OPEN, when there is one and it
  // still fits (issue #826).
  //
  // NOT the fix, and it must not be read as one: a household that already
  // finished one checkout has no open session left to be handed, so this closes
  // no window on its own. What it does is stop the window opening in the first
  // place for the ordinary case — two taps on Pay, a reload, a second device —
  // by handing back the SAME session and therefore the same PaymentIntent,
  // which the existing `stripePayments/{intentId}` ledger already dedupes. The
  // refusal that actually holds the money shut lives in `stripeWebhook`.
  //
  // WHAT STRIPE GUARANTEES, since the reuse rests on it. `Session.status` is
  // `open | complete | expired`, and `Session.url` is documented "only present
  // when the session is active" — so an already-paid or expired session cannot
  // be handed out by accident, it comes back without a URL to hand. Stripe
  // expires a session at `expires_at` (24h after creation by default), and the
  // `checkout.session.expired` event that clears our stored id can lag that
  // moment, so the timestamp is checked here rather than trusted to the webhook.
  //
  // EVERY OTHER CONDITION IS ABOUT HANDING BACK THE WRONG PAGE. The amount must
  // still be the balance (a session minted before a partial payment charges the
  // old, larger figure); the return URLs must be the caller's own (the web
  // portal sends `/invoices/{id}` and the KMP portal sends
  // `/portal/payment-success`, so reusing one client's session from the other
  // would land the household on a screen their app does not have); and the
  // round must match, or the session belongs to a settlement that has closed.
  //
  // Fail-soft throughout: any doubt, including an unreadable session, mints a
  // fresh one. A household must never be unable to pay a bill because a stale
  // id could not be inspected.
  const reusable = await findReusableSession(stripe, {
    sessionId: typeof inv['pendingCheckoutSessionId'] === 'string' ? (inv['pendingCheckoutSessionId'] as string) : null,
    invoiceId: args.invoiceId,
    amountCents,
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
    checkoutRound,
    uid,
  });
  if (reusable) {
    logEvent({
      severity: 'info',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.reused',
      uid,
      extra: { invoiceId: args.invoiceId, kinfolkId, amountCents, sessionId: reusable.id, checkoutRound },
    });
    return validateResponse('payInvoice', Result, {
      checkoutUrl: reusable.url ?? '',
      sessionId: reusable.id,
      amountCents,
      currency: 'usd',
    });
  }

  let session;
  try {
    session = await createSession(methodTypes, '');
  } catch (err) {
    const extraTypes = methodTypes.filter((t) => t !== 'card');
    if (extraTypes.length === 0 || !isUnsupportedMethodTypeError(err)) throw err;
    logEvent({
      severity: 'warn',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.methodtype.rejected',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { invoiceId: args.invoiceId, rejectedTypes: extraTypes, retriedWith: ['card'] },
    });
    session = await createSession(['card'], '_card');
  }

  await firestore.collection('invoices').doc(args.invoiceId).set({
    pendingCheckoutSessionId: session.id,
    pendingAt: new Date(),
  }, { merge: true });

  logEvent({
    severity: 'info',
    function: 'payInvoice',
    event: 'portal.invoice.checkout.created',
    uid,
    extra: {
      invoiceId: args.invoiceId,
      kinfolkId,
      amountCents,
      sessionId: session.id,
      checkoutRound,
      paymentMethodTypes: session.payment_method_types ?? methodTypes,
    },
  });

  return validateResponse('payInvoice', Result, {
    checkoutUrl: session.url ?? '',
    sessionId: session.id,
    amountCents,
    currency: 'usd',
  });
}

/**
 * How much life an open session must have left before it is worth handing back.
 *
 * A session that expires while the household is typing their card number is a
 * worse outcome than a second session, so the last few minutes of one are
 * treated as no session at all.
 */
const SESSION_REUSE_HEADROOM_MS = 5 * 60 * 1000;

/**
 * The open Checkout Session this invoice can be paid on, or null to mint a new
 * one. See the call site for the reasoning behind each condition.
 *
 * Typed on the fields it reads rather than on `Stripe.Checkout.Session`, so a
 * test can hand it a plain object without reconstructing sixty unused fields.
 */
async function findReusableSession(
  stripe: { checkout: { sessions: { retrieve: (id: string) => Promise<unknown> } } },
  want: {
    sessionId: string | null;
    invoiceId: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    checkoutRound: number;
    uid: string;
  },
): Promise<{ id: string; url: string } | null> {
  if (!want.sessionId) return null;
  let raw: unknown;
  try {
    raw = await stripe.checkout.sessions.retrieve(want.sessionId);
  } catch (err) {
    // A session Stripe cannot find or will not return is not a reason to refuse
    // a payment; it is a reason to make a new one.
    logEvent({
      severity: 'info',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.reuse.unreadable',
      uid: want.uid,
      errorMessage: (err as Error)?.message,
      extra: { invoiceId: want.invoiceId, sessionId: want.sessionId },
    });
    return null;
  }
  const s = (raw ?? {}) as {
    id?: unknown;
    url?: unknown;
    status?: unknown;
    expires_at?: unknown;
    amount_total?: unknown;
    success_url?: unknown;
    cancel_url?: unknown;
    metadata?: Record<string, unknown>;
  };
  if (s.status !== 'open') return null;
  if (typeof s.id !== 'string' || s.id === '') return null;
  if (typeof s.url !== 'string' || s.url === '') return null;
  if (typeof s.expires_at !== 'number' || s.expires_at * 1000 <= Date.now() + SESSION_REUSE_HEADROOM_MS) return null;
  if (s.amount_total !== want.amountCents) return null;
  if (s.success_url !== want.successUrl || s.cancel_url !== want.cancelUrl) return null;
  if (s.metadata?.['invoiceId'] !== want.invoiceId) return null;
  if (s.metadata?.[CHECKOUT_ROUND_METADATA_KEY] !== String(want.checkoutRound)) return null;
  return { id: s.id, url: s.url };
}

/**
 * Is this the specific Stripe refusal that means "the account has not
 * activated that payment method type"?
 *
 * Matched on the error TYPE plus the parameter Stripe names, not on the
 * message text: `invalid_request_error` on `payment_method_types` is the
 * shape Stripe returns for an unactivated or unavailable rail, and matching
 * on prose would break the moment Stripe rewords it. Anything else is a real
 * failure and is rethrown by the caller.
 */
function isUnsupportedMethodTypeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; param?: unknown; raw?: { param?: unknown } };
  if (e.type !== 'StripeInvalidRequestError' && e.type !== 'invalid_request_error') return false;
  const param = typeof e.param === 'string' ? e.param : typeof e.raw?.param === 'string' ? e.raw.param : '';
  return param.startsWith('payment_method_types');
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
