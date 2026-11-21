import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { refuseAuntie } from '../lib/staffGate';
import { requireBillingActor } from '../lib/memberGate';
import { requirePortalReturnUrls, TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { settingsForInvoice, stripeCheckoutMethodTypes } from '../lib/paymentMethods';
import { readLivePayMethodSettings } from '../lib/payMethodSnapshot';
import {
  CHECKOUT_ROUND_FIELD,
  CHECKOUT_ROUND_METADATA_KEY,
  checkoutRoundOf,
} from '../lib/invoiceCheckoutDedupe';
import { CheckoutIdempotencyKeyArg } from '../lib/moneyIdempotency';
import { amountDueCentsOf } from '../lib/amountDueRule';
import {
  cardCheckoutRefusal,
  cardCheckoutRefusalSentence,
  INVOICE_CANNOT_TAKE_PAYMENT_CODE,
} from '../lib/cardPaymentApply';
import type { InvoiceDoc } from '../admin/markInvoicePaid';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import {
  INVOICE_CANCELLED_CODE,
  invoiceCancelled,
  invoiceIsPaid,
  PAID_INVOICE_REFUSAL,
  PAID_INVOICE_REFUSAL_CODE,
} from '../lib/invoicePaidGate';
import { INVOICE_WRITTEN_OFF_CODE, isWrittenOff } from '../lib/invoiceArchive';
import { OPEN_CHECKOUT_SESSIONS_FIELD } from '../lib/checkoutSessionSweep';
import {
  chargeTimeMsOf,
  checkoutSessionIdsToRead,
  finishedCheckoutOf,
  holdsPay,
  PAYMENT_BEING_RECORDED,
  PAYMENT_BEING_RECORDED_CODE,
} from '../lib/checkoutBeingRecorded';
import { hiddenFromHousehold } from '../lib/quoteDecision';
import { invoiceLeadName, invoiceNumberText } from '../lib/invoiceNaming';

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
  // #984: money. An Auntie is refused here by role, not by her tribe count.
  refuseAuntie(req.auth, 'payInvoice');

  const args = Args.parse(req.data);
  // #2366: Stripe sends the household to these two addresses, so they must be
  // the portal's own. Refused before anything is read or written.
  requirePortalReturnUrls(args);
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
  // #1906: an invoice the household may not see (an unsent draft, or an
  // archived quote) takes no payment, and is answered exactly as a missing one
  // so a guessed id learns nothing. MyTribe never offers it; this is the server
  // holding the same line for any other caller.
  if (hiddenFromHousehold(inv)) throw new HttpsError('not-found', 'Invoice not found.');
  // D-2026-09-28-BILLING-ACCESS-PAYS: paying is billing access, not primary-only.
  // The PRIMARY and a SECONDARY granted `billing_full` pay; `uid` rides in the
  // checkout metadata below so the webhook's audit names who actually paid.
  await requireBillingActor(uid, kinfolkId, req.auth?.token?.admin === true, 'payInvoice');

  // WHAT THE HOUSEHOLD IS CHARGED IS THE REMAINING BALANCE, not the total, and
  // on a part-paid invoice those differ. `amountDueCents` is the integer figure
  // the settlement pass writes (`lib/invoiceMath.ts`); the float dollar
  // `amountDue` is its projection and is all an older invoice carries. The
  // shared rule reads them in that order, so a real card charge is never a
  // re-rounding of a re-rounding.
  //
  // #902: AND IT IS THE SHARED RULE THAT READS THEM. A migrated invoice carries
  // a `total` and no balance at all, and this handler used to charge it 0 and
  // refuse. That was invisible while the portal showed the same bill as $0.00
  // with no Pay button; now that `getMyInvoices` ships the derived balance and
  // the household is offered a way to pay, a checkout that refused what the
  // screen just offered would be the disagreement this issue closes, moved one
  // step along.
  //
  // THE PAYMENT ROWS ARE READ. This handler charges a CARD: deriving a balance
  // from a status label alone, when the invoice's own rows could say the bill
  // was settled before `amountDue` existed, would risk charging a household
  // twice for one bill, and there are no refunds. Until #2410 they were read
  // only for an invoice that states no balance. They are read for every
  // invoice now, because the check below (`cardCheckoutRefusal`) needs them to
  // say what the webhook would do with the payment. A stated balance is still
  // charged as stated: the rule returns it untouched, rows or no rows.
  // #2090: the business wrote off what was left. Nothing is owed, so no
  // checkout is opened, and the household is told so in its own words.
  if (isWrittenOff(inv as Record<string, unknown>)) {
    throw new HttpsError('failed-precondition', 'There is nothing to pay on this invoice.', {
      code: INVOICE_WRITTEN_OFF_CODE,
    });
  }
  // #2276: a cancelled invoice is not collectable by any path
  // (`lib/amountDueRule.ts`). Cancelling does not zero a balance the document
  // states, so without this a cancelled bill that still stated one opened a
  // checkout, and the card payment then marked it paid. A withdrawn quote
  // never reaches here: it is answered as missing above.
  if (invoiceCancelled(inv)) {
    throw new HttpsError('failed-precondition', 'There is nothing to pay on this invoice.', {
      code: INVOICE_CANCELLED_CODE,
    });
  }
  const paymentRows = (await invoiceSnap.ref.collection('payments').get()).docs.map((d) => d.data() as PaymentAmount);
  const rowsPaidCents = paidCentsFromPayments(paymentRows);
  // A PAID INVOICE TAKES NO PAYMENT (operator ruling 2026-09-27, docket Q5).
  // Asked BEFORE the balance and before the session reuse below, because the
  // mark alone is enough: an invoice labelled paid whose stated balance still
  // reads positive is the partial-payment corruption the admin repairs, not a
  // bill the household can pay into. `lib/invoicePaidGate.ts` is the rule.
  if (invoiceIsPaid(inv, rowsPaidCents)) {
    logEvent({
      severity: 'info',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.refused.paid',
      uid,
      extra: { invoiceId: args.invoiceId, kinfolkId },
    });
    throw new HttpsError('failed-precondition', PAID_INVOICE_REFUSAL, { code: PAID_INVOICE_REFUSAL_CODE });
  }
  const amountCents = amountDueCentsOf(inv, rowsPaidCents);
  if (amountCents <= 0) throw new HttpsError('failed-precondition', 'Invoice is fully paid.');
  // #2410: NO CHECKOUT FOR A PAYMENT THE INVOICE COULD NOT TAKE. Since #2385
  // the webhook keeps such a payment off the invoice for the owner to decide
  // on, and tells the household nothing. Opening the checkout anyway charged
  // the card, left the invoice reading owed, and let the household pay it
  // again. So the webhook's own rule is asked here, before the session reuse,
  // the settings read and Stripe: an invoice that states a balance while
  // nothing is owed on its total (it has no total, or its payment rows already
  // cover it), a credit that states a balance, and a quote the household has
  // not accepted (#2264). `lib/cardPaymentApply.ts#cardCheckoutRefusal` has
  // the rule; `getMyInvoices` ships the same answer so the screens offer no
  // Pay on these.
  const refusal = cardCheckoutRefusal({
    invoiceId: args.invoiceId,
    doc: inv as InvoiceDoc,
    existingPayments: paymentRows,
    kinfolkId,
  });
  if (refusal !== null) {
    logEvent({
      severity: 'warn',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.refused.unpayable',
      uid,
      extra: { invoiceId: args.invoiceId, kinfolkId, reason: refusal, amountCents },
    });
    throw new HttpsError('failed-precondition', cardCheckoutRefusalSentence(refusal), {
      code: INVOICE_CANNOT_TAKE_PAYMENT_CODE,
    });
  }

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
   * left out. They are constant per client (since #2366 both the web portal
   * and the Android app send `/invoices/{id}?checkout=done` and
   * `/invoices/{id}`; an older Android build still sends
   * `/portal/payment-success`) and the key is minted client-side per
   * submission, so one key cannot arrive with two different url pairs.
   * Folding two full URLs into a 255-character key to restate something the key's own provenance already guarantees would buy
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
      allowed_payment_method_types: paymentMethodTypes as Stripe.Checkout.SessionCreateParams.AllowedPaymentMethodType[],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              // #2453: the household reads this on Stripe's page. Its number, never its id.
              name: checkoutLineName(inv['invoiceNumber']),
              // The household's name when the invoice carries one. No name, no line: a stored id is never shown.
              ...(typeof inv['client'] === 'string' && inv['client'].trim() !== ''
                ? { description: inv['client'] }
                : {}),
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
  // old, larger figure); the return URLs must be the caller's own (an
  // Android build from before #2366 sends `/portal/payment-success`, so
  // reusing its session from a current client would land the household on a
  // page that does not exist); and the round must match, or the session
  // belongs to a settlement that has closed.
  //
  // Fail-soft throughout: any doubt, including an unreadable session, mints a
  // fresh one. A household must never be unable to pay a bill because a stale
  // id could not be inspected.
  //
  // #2437: BUT FIRST, A CHECKOUT THAT HAS FINISHED AND WHOSE PAYMENT IS NOT ON
  // THE INVOICE YET. Between the household paying at Stripe and the webhook
  // recording it, the invoice still reads owed, and the reuse below treated a
  // finished session exactly like an expired one: it made a new checkout, and
  // a second payment is a second real charge. So every checkout stored on this
  // invoice is read once here (the pending one is the same read the reuse
  // makes, shared through `readSession`), and Pay is refused while one of them
  // is finished, paid and not yet claimed by the webhook.
  // `lib/checkoutBeingRecorded.ts` has the rule, the window after which a
  // payment that never lands stops holding Pay, and why any doubt opens the
  // checkout.
  const sessionReads = new Map<string, Promise<unknown>>();
  const readSession = (id: string): Promise<unknown> => {
    let read = sessionReads.get(id);
    if (read === undefined) {
      read = stripe.checkout.sessions.retrieve(id);
      sessionReads.set(id, read);
    }
    return read;
  };
  const recording = await paymentBeingRecorded(stripe, {
    sessionIds: checkoutSessionIdsToRead(inv),
    invoiceId: args.invoiceId,
    readSession,
    uid,
  });
  if (recording !== null) {
    logEvent({
      severity: 'info',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.refused.recording',
      uid,
      extra: { invoiceId: args.invoiceId, kinfolkId, amountCents, ...recording },
    });
    throw new HttpsError('failed-precondition', PAYMENT_BEING_RECORDED, { code: PAYMENT_BEING_RECORDED_CODE });
  }
  const reusable = await findReusableSession({ checkout: { sessions: { retrieve: readSession } } }, {
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

  // The list the session that came back was actually created with. After the
  // card-only retry that is `['card']`, so the filtered check below never
  // re-reports types the `rejected` line already named.
  let requestedTypes: readonly string[] = methodTypes;
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
    requestedTypes = ['card'];
    session = await createSession(['card'], '_card');
  }

  // WHAT STRIPE ACTUALLY OFFERS (issue #1192). Under
  // `allowed_payment_method_types` an unactivated Klarna or Affirm no longer
  // fails the create: Stripe leaves it out of the session's
  // `payment_method_types`. The household can still pay by card, the same
  // outcome the card-only retry above gives, so this is a warn line for the
  // operator, never a refusal. Runbook: docs/runbooks/stripe.md section 4a.
  const filteredTypes = methodTypesDroppedBy(requestedTypes, session);
  if (filteredTypes.length > 0) {
    logEvent({
      severity: 'warn',
      function: 'payInvoice',
      event: 'portal.invoice.checkout.methodtype.filtered',
      uid,
      extra: { invoiceId: args.invoiceId, filteredTypes, sessionId: session.id },
    });
  }

  // `pendingCheckoutSessionId` is the ONE session the reuse above can hand
  // back. `openCheckoutSessionIds` is EVERY session this invoice has minted,
  // because clients that send different return URLs (an older Android build)
  // each mint their own: when the invoice becomes paid, the sweep
  // (`triggers/onInvoicePaidExpireCheckouts.ts`) expires all of them at Stripe,
  // so a household with a second tab open cannot pay a settled bill.
  await firestore.collection('invoices').doc(args.invoiceId).set({
    pendingCheckoutSessionId: session.id,
    pendingAt: new Date(),
    [OPEN_CHECKOUT_SESSIONS_FIELD]: FieldValue.arrayUnion(session.id),
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
 * #2437: the finished card payment on one of this invoice's stored checkouts
 * that the webhook has not recorded yet, or null when there is none and a
 * checkout may open. `lib/checkoutBeingRecorded.ts` has the rule; this does
 * its reads.
 *
 *   the stored checkouts   one Stripe read each, at most
 *                          `MAX_CHECKOUT_SESSIONS_READ`, together. One that
 *                          cannot be read is skipped.
 *   recorded or not        `stripePayments/{paymentIntentId}`, the claim the
 *                          webhook writes with its decision.
 *   when it was charged    one more Stripe read, made only for a payment that
 *                          is finished and unclaimed: the PaymentIntent with
 *                          its charge. Unreadable means nothing is held.
 *
 * Nothing is written. The webhook alone records a payment.
 */
async function paymentBeingRecorded(
  stripe: { paymentIntents?: { retrieve: (id: string, params: { expand: string[] }) => Promise<unknown> } },
  want: {
    sessionIds: readonly string[];
    invoiceId: string;
    readSession: (id: string) => Promise<unknown>;
    uid: string;
  },
): Promise<{ sessionId: string; paymentIntentId: string; paidAtMs: number } | null> {
  if (want.sessionIds.length === 0) return null;
  const sessions = await Promise.all(want.sessionIds.map((id) => want.readSession(id).catch(() => null)));
  const seen = new Set<string>();
  for (const raw of sessions) {
    const finished = finishedCheckoutOf(raw, want.invoiceId);
    if (finished === null || seen.has(finished.paymentIntentId)) continue;
    seen.add(finished.paymentIntentId);
    const claim = await db().collection('stripePayments').doc(finished.paymentIntentId).get();
    if (claim.exists) continue;
    let paidAtMs: number | null = null;
    let unreadable: string | undefined;
    try {
      paidAtMs = chargeTimeMsOf(
        await stripe.paymentIntents!.retrieve(finished.paymentIntentId, { expand: ['latest_charge'] }),
      );
    } catch (err) {
      unreadable = (err as Error)?.message;
    }
    if (paidAtMs === null) {
      // A finished payment with no time to measure from holds nothing: with
      // no time there is no end to the hold either.
      logEvent({
        severity: 'warn',
        function: 'payInvoice',
        event: 'portal.invoice.checkout.recording.unreadable',
        uid: want.uid,
        errorMessage: unreadable,
        extra: { invoiceId: want.invoiceId, ...finished },
      });
      continue;
    }
    if (!holdsPay(paidAtMs, Date.now())) {
      // Charged, and still not recorded after the window: the webhook is late
      // or is not arriving. Pay is offered again, and this line is how the
      // operator finds out (docs/runbooks/stripe.md).
      logEvent({
        severity: 'warn',
        function: 'payInvoice',
        event: 'portal.invoice.checkout.recording.overdue',
        uid: want.uid,
        extra: { invoiceId: want.invoiceId, ...finished, paidAtMs },
      });
      continue;
    }
    return { ...finished, paidAtMs };
  }
  return null;
}

/**
 * Is this the specific Stripe refusal that means "the account has not
 * activated that payment method type"?
 *
 * Matched on the error TYPE plus the parameter Stripe names, not on the
 * message text: `invalid_request_error` on the method-types parameter is the
 * shape Stripe returns for an unactivated or unavailable rail, and matching
 * on prose would break the moment Stripe rewords it. Anything else is a real
 * failure and is rethrown by the caller.
 *
 * BOTH PARAMETER NAMES. Stripe API `2026-09-30.endive` (stripe-node 23)
 * replaced `payment_method_types` with `allowed_payment_method_types`, which
 * FILTERS the dynamically eligible set instead of listing it. An unactivated
 * rail should now be dropped silently, so this refusal and the card-only
 * retry may never fire again. Both are kept: the retry costs nothing when it
 * is idle, and the old name still matches if the API version is ever pinned
 * back.
 */
export function isUnsupportedMethodTypeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; param?: unknown; raw?: { param?: unknown } };
  if (e.type !== 'StripeInvalidRequestError' && e.type !== 'invalid_request_error') return false;
  const param = typeof e.param === 'string' ? e.param : typeof e.raw?.param === 'string' ? e.raw.param : '';
  return param.startsWith('allowed_payment_method_types') || param.startsWith('payment_method_types');
}

/**
 * The method types this server asked for that the created session does not
 * offer (issue #1192). Empty when Stripe returned no `payment_method_types`
 * to compare, so a missing field never reads as "everything was dropped".
 */
export function methodTypesDroppedBy(
  requested: readonly string[],
  session: { payment_method_types?: unknown },
): string[] {
  const offered = session.payment_method_types;
  if (!Array.isArray(offered)) return [];
  return requested.filter((t) => !offered.includes(t));
}

/**
 * An integer count of cents, or null when the field is absent or is not one.
 * Null rather than 0, so the caller falls back to the dollar field instead of
 * refusing a real balance as "fully paid".
 *
 * #902 MOVED THIS READ, it did not retire it. `lib/amountDueRule.ts` performs
 * exactly this check as `statedAmountDueCents`, on the same two fields in the
 * same order, for every reader of the collection at once. This copy and its
 * `numericFrom` are left in place and unused rather than deleted: they are half
 * of a payment path whose other half is `getMyInvoices.ts`, and payment code is
 * reported here, never removed. Named in #902's PR as orphaned, for whoever
 * retires the pair together.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function integerCentsOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

/**
 * #2453: the one line on Stripe's checkout page, "Invoice #1042". It used to
 * carry the invoice's stored id. An invoice with no number reads "Invoice with
 * no number". Stripe matches nothing on this name: the invoice is found by the
 * session's metadata.
 */
export function checkoutLineName(invoiceNumber: unknown): string {
  const n = invoiceNumberText(invoiceNumber);
  return n === '' ? invoiceLeadName('') : `Invoice #${n}`;
}
