import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { verifyStripeWebhook, getStripe } from '../lib/stripe';
import { dollarsToCents } from '../lib/paymentMoney';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { FULL_CPU } from '../lib/runtimeOptions';

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const sig = req.headers['stripe-signature'] as string | undefined;
  if (!sig) { res.status(400).json({ error: 'missing-signature' }); return; }
  let event;
  try {
    event = await verifyStripeWebhook(req.rawBody, sig);
  } catch {
    logEvent({ severity: 'warn', function: 'stripeWebhook', event: 'stripe.signature.fail' });
    res.status(400).json({ error: 'bad-signature' });
    return;
  }
  const eventObject = event.data.object as {
    id?: string;
    payment_intent?: string;
    metadata?: Record<string, string>;
    // Stripe carries the authoritative paid amount on the event object itself:
    // invoices use `amount_paid`, PaymentIntents use `amount_received`, and a
    // Checkout Session uses `amount_total` (all three integer minor units).
    // Prefer these over re-deriving from our local invoice doc (NOTE-57).
    amount_paid?: number;
    amount_received?: number;
    amount_total?: number | null;
    // Checkout Session only. 'paid' | 'unpaid' | 'no_payment_required'.
    payment_status?: string;
  };
  const metadata = eventObject.metadata;
  // AuntieOS bookkeeping keys the family by `familyId`; the MyTribe portal's
  // payInvoice writes both `familyId` and `kinfolkId`. Read familyId first,
  // fall back to kinfolkId for any older Checkout sessions still in flight.
  const familyId = metadata?.familyId ?? metadata?.kinfolkId;
  const invoiceId = metadata?.invoiceId;
  if (!familyId || !invoiceId) {
    logEvent({ severity: 'warn', function: 'stripeWebhook', event: 'stripe.metadata.missing', extra: { type: event.type } });
    res.status(202).json({ ok: true, ignored: true });
    return;
  }
  // Reference number for the mirror payment doc: prefer the PaymentIntent id,
  // fall back to the event object id (Checkout Session id).
  const referenceNumber =
    (typeof eventObject.payment_intent === 'string' && eventObject.payment_intent) ||
    (typeof eventObject.id === 'string' && eventObject.id) ||
    event.id;
  // Canonical store is the FLAT top-level `invoices` collection.
  const ref = db().collection('invoices').doc(invoiceId);
  const dedupeRef = db().doc(`stripeEvents/${event.id}`);

  // Idempotency: Stripe retries failed deliveries. Without a dedupe ledger
  // the same event re-fires audits + notifications and can silently undo a
  // manual admin mark-paid if a late `payment_failed` retry arrives after a
  // successful `invoice.paid`. The transaction atomically (a) reserves the
  // event id, (b) reads the current invoice state, (c) checks the new event
  // is newer than the last-applied event of the opposite outcome. Skips any
  // event that is a replay or an out-of-order older event.
  const eventCreatedMs = ((event.created ?? 0) as number) * 1000;
  // `checkout.session.completed` is the canonical event for a `mode: 'payment'`
  // Checkout integration, which is what `payInvoice` creates. It was missing
  // here, so it fell through to the unhandled-type 202 below.
  const isPaidEvent =
    event.type === 'invoice.paid' ||
    event.type === 'payment_intent.succeeded' ||
    event.type === 'checkout.session.completed';
  const isFailedEvent = event.type === 'invoice.payment_failed' || event.type === 'payment_intent.payment_failed';
  if (!isPaidEvent && !isFailedEvent) {
    res.status(202).json({ ok: true, ignored: true });
    return;
  }

  // A Checkout Session can complete WITHOUT the money having been collected —
  // `payment_status: 'unpaid'` is how a delayed/async method reports "session
  // finished, funds pending". Unreachable while `payInvoice` hardcodes
  // `payment_method_types: ['card']`, and this is the guard that keeps it
  // unreachable rather than trusting that line never changes. Marking an
  // invoice paid for money that has not arrived is the one failure worse than
  // the one being fixed here. Scoped to the Session event: no other event type
  // carries this field, and an unscoped check would 202 every PaymentIntent.
  if (event.type === 'checkout.session.completed' && eventObject.payment_status !== 'paid') {
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.session.unpaid',
      extra: { invoiceId, familyId, eventId: event.id, paymentStatus: eventObject.payment_status ?? null },
    });
    res.status(202).json({ ok: true, ignored: true });
    return;
  }

  // The PaymentIntent id, resolved identically from either paid event shape: a
  // Checkout Session carries it in `payment_intent` (SDK type
  // `string | PaymentIntent | null` — unexpanded, as here, it is the string);
  // a PaymentIntent event IS the PaymentIntent, so its own `id` is the id.
  //
  // Both the fee hop and the payment-level claim below key off this ONE value,
  // and they must agree. Deliberately NOT `referenceNumber`: that falls back to
  // the Session id and then the event id, so the two events describing a single
  // payment would claim two DIFFERENT keys and both apply.
  const paymentIntentId =
    (typeof eventObject.payment_intent === 'string' && eventObject.payment_intent) ||
    (event.type.startsWith('payment_intent') && typeof eventObject.id === 'string' && eventObject.id) ||
    null;

  // Exactly-once per PAYMENT, where the ledger above is exactly-once per EVENT.
  // One successful card payment now delivers TWO events that both mean paid —
  // `checkout.session.completed` and `payment_intent.succeeded` — carrying two
  // different `event.id`s, so `stripeEvents/{event.id}` cannot dedupe them
  // against each other, and their `created` stamps are seconds-granular and
  // usually equal, so the out-of-order guard (a strict `<`) lets the second
  // through too. Unguarded, the second event writes a SECOND
  // `payments/{eventId}` mirror doc — double-counting real money in the root
  // ledger — plus a second BILLING_INVOICE_PAID audit entry and a second
  // `invoice.payment.applied` notification to the household.
  //
  // Paid events only, deliberately. A `payment_intent.payment_failed` must not
  // claim the id: a declined card the household then retries successfully has
  // to be able to apply.
  const paymentClaimRef =
    isPaidEvent && paymentIntentId ? db().doc(`stripePayments/${paymentIntentId}`) : null;

  // U6: the Stripe processor fee. The event carries no fee — it lives on the
  // charge's balance transaction, one hop past what the webhook payload ever
  // includes — so this takes one Stripe retrieve: the PaymentIntent, with a
  // nested expand straight to the balance transaction. Deliberately OUTSIDE
  // the transaction below: a Firestore transaction re-runs its callback on
  // contention, and a call this expensive must not be repeated per attempt or
  // hold the transaction open across network latency. A replay costs one
  // wasted read-only Stripe call, which is cheap next to that.
  //
  // Never let this fail the webhook (fail-loud, not fail-closed): the payment
  // is real whether or not the fee resolves. An unresolved fee is recorded as
  // unresolved and warned about (below, after the txn commits) — never faked.
  // A `feeCents: 0` would be a claim that Stripe charged nothing.
  let feeCents: number | null = null;
  let feeResolved = false;
  if (isPaidEvent) {
    if (paymentIntentId) {
      try {
        const stripe = await getStripe();
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge.balance_transaction'],
        });
        const charge = pi.latest_charge;
        const balanceTransaction = charge && typeof charge === 'object' ? charge.balance_transaction : null;
        const fee =
          balanceTransaction && typeof balanceTransaction === 'object' && typeof balanceTransaction.fee === 'number'
            ? balanceTransaction.fee
            : null;
        if (fee !== null) {
          feeCents = fee;
          feeResolved = true;
        }
      } catch {
        // Network hiccup, bad id, Stripe outage — any of it. feeResolved
        // stays false; the payment write below proceeds regardless.
      }
    }
  }

  // Set inside the transaction when a paid event resolved no real amount, so we
  // can warn AFTER the txn commits (NOTE-57). Declared here so a txn retry resets
  // it on each attempt's write path.
  let unresolvedAmount = false;
  const decision = await db().runTransaction(async (tx) => {
    unresolvedAmount = false;
    const dedupeSnap = await tx.get(dedupeRef);
    if (dedupeSnap.exists) {
      return { proceed: false, reason: 'replay' as const };
    }
    // Every read before the first write: a Firestore transaction refuses reads
    // after writes, so this sits with the other gets, not with its branch.
    const claimSnap = paymentClaimRef ? await tx.get(paymentClaimRef) : null;
    const invoiceSnap = await tx.get(ref);
    const invoice = invoiceSnap.data() as { lastStripeEventAtMs?: number } | undefined;
    // The state stamp's payment standing reads the `payments` SUBCOLLECTION
    // (Stripe's own mirror docs live in the ROOT `payments` collection, so on
    // a card-only invoice this sums to zero; a manually-recorded partial shows
    // up here and keeps the doc honestly repairable). Read now, before the
    // first write: a Firestore transaction refuses reads after writes.
    const subPaymentsSnap = isPaidEvent ? await tx.get(ref.collection('payments')) : null;
    const lastEventMs = invoice?.lastStripeEventAtMs ?? 0;
    if (claimSnap?.exists) {
      // The other event describing this same PaymentIntent already applied.
      // Reserve THIS event id so its own Stripe retries short-circuit at the
      // replay branch above, and mutate nothing else.
      tx.create(dedupeRef, {
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        familyId,
        invoiceId,
        appliedOutcome: 'SKIPPED_DUPLICATE_PAYMENT',
      });
      return { proceed: false, reason: 'duplicate-payment' as const };
    }
    if (eventCreatedMs > 0 && eventCreatedMs < lastEventMs) {
      // Out-of-order retry arriving after a newer event has already been
      // applied. Reserve the id to prevent future replays but don't mutate.
      tx.create(dedupeRef, {
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        familyId,
        invoiceId,
        appliedOutcome: 'SKIPPED_OUT_OF_ORDER',
      });
      return { proceed: false, reason: 'out-of-order' as const };
    }
    tx.create(dedupeRef, {
      type: event.type,
      receivedAt: FieldValue.serverTimestamp(),
      eventCreatedMs,
      familyId,
      invoiceId,
      appliedOutcome: isPaidEvent ? 'PAID' : 'FAILED',
    });
    if (paymentClaimRef) {
      // Claim the PaymentIntent in the same atomic write as the money it
      // describes, so the sibling event finds it on its way in.
      tx.create(paymentClaimRef, {
        appliedEventId: event.id,
        appliedEventType: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        familyId,
        invoiceId,
      });
    }
    // Match the flat-doc shape AuntieOS writes: free-text `status` + numeric
    // `amountDue`. The portal renders the stored `status` stamp (ADR-0002;
    // its money heuristic is retired) and the reminders cron still reads
    // `amountDue <= 0` as settled, so mark both.
    const patch: Record<string, unknown> = {
      lastStripeEventAtMs: eventCreatedMs,
      lastStripeEventId: event.id,
    };
    if (isPaidEvent) {
      patch.status = 'paid';
      patch.amountDue = 0;
      patch.paidAt = FieldValue.serverTimestamp();
      // The state stamp (ADR-0002), in the same transactional write as the
      // flip it describes. A failed event changes nothing the classifier
      // reads, so only the paid branch stamps.
      const paidCents = paidCentsFromPayments(
        (subPaymentsSnap?.docs ?? []).map((d) => d.data() as PaymentAmount),
      );
      Object.assign(patch, invoiceStateStampOf({ ...(invoiceSnap.data() ?? {}), ...patch }, paidCents));
    }
    tx.set(ref, patch, { merge: true });
    if (isPaidEvent) {
      // Mirror a flat `payments/{eventId}` doc to match AuntieOS bookkeeping.
      // Keyed by the (idempotent) event id so a Stripe retry cannot duplicate
      // a payment record.
      //
      // NOTE-57: prefer the AUTHORITATIVE amount carried on the Stripe event
      // (invoice `amount_paid` / PaymentIntent `amount_received`) over
      // re-deriving from our local invoice doc, which may be stale or missing.
      // Only if neither the event nor the local invoice yields a positive
      // amount do we fall back to recording null — and then we flag the doc
      // `amountResolved: false` and warn loudly (fail-loud), never silently.
      const invoiceForAmount = invoiceSnap.data() as { amountDue?: number; total?: number } | undefined;
      // `amount_total` is the Checkout Session's leg of the same ladder — the
      // authoritative figure on the event that now marks the invoice paid when
      // it wins the race. Without it a Session-first delivery would fall back
      // to the local invoice doc, which is the weaker source NOTE-57 exists to
      // avoid. Integer minor units, exactly like its two siblings.
      const eventAmount =
        typeof eventObject.amount_paid === 'number' && eventObject.amount_paid > 0
          ? eventObject.amount_paid
          : typeof eventObject.amount_received === 'number' && eventObject.amount_received > 0
            ? eventObject.amount_received
            : typeof eventObject.amount_total === 'number' && eventObject.amount_total > 0
              ? eventObject.amount_total
              : null;
      const localAmount =
        typeof invoiceForAmount?.amountDue === 'number' && invoiceForAmount.amountDue > 0
          ? invoiceForAmount.amountDue
          : typeof invoiceForAmount?.total === 'number' && invoiceForAmount.total > 0
            ? invoiceForAmount.total
            : null;
      const amount = eventAmount ?? localAmount;
      const amountResolved = amount !== null;
      if (!amountResolved) {
        unresolvedAmount = true;
      }
      // The event amount (`amount_paid` / `amount_received`) is already
      // integer cents, the currency's native unit — it passes through
      // unchanged. The local-invoice fallback is the flat doc's legacy dollar
      // float and is converted once, here, same as `recordPayment` does.
      const amountCents =
        eventAmount !== null ? eventAmount : localAmount !== null ? dollarsToCents(localAmount) : null;
      const paymentRef = db().collection('payments').doc(event.id);
      tx.set(paymentRef, {
        kinfolkId: familyId,
        invoiceId,
        amount,
        amountCents,
        amountResolved,
        amountSource: eventAmount !== null ? 'stripe-event' : localAmount !== null ? 'local-invoice' : 'unresolved',
        paymentMethod: 'stripe',
        referenceNumber,
        date: FieldValue.serverTimestamp(),
        stripeEventId: event.id,
        // `feeCents` is the field `recordPayment` already writes and
        // `getInvoiceLedger` already renders — no new field there. Present
        // ONLY when resolved: the Admin SDK rejects a literal `undefined`,
        // and an absent field reads correctly as "unknown", never as zero.
        ...(feeResolved ? { feeCents } : {}),
        feeResolved,
      });
    }
    return { proceed: true, reason: 'applied' as const };
  });

  if (unresolvedAmount) {
    // Fail-loud: a paid event recorded without a real amount needs operator
    // attention (the payments doc carries amountResolved:false).
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.amount.unresolved',
      extra: { invoiceId, familyId, eventId: event.id, type: event.type },
    });
  }

  // Gated on `decision.proceed`: a replay or out-of-order skip wrote nothing,
  // so an unresolved fee on THAT attempt is not news — only warn when a
  // payment doc actually landed without one.
  if (isPaidEvent && decision.proceed && !feeResolved) {
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.fee.unresolved',
      extra: { invoiceId, familyId, eventId: event.id, type: event.type },
    });
  }

  if (!decision.proceed) {
    logEvent({
      severity: 'info',
      function: 'stripeWebhook',
      event: 'stripe.dedup.skipped',
      extra: { id: event.id, type: event.type, reason: decision.reason },
    });
    res.status(200).json({ ok: true, dedup: true, reason: decision.reason });
    return;
  }

  if (isPaidEvent) {
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BILLING_INVOICE_PAID,
      severity: 'info', actorRole: 'SYSTEM', familyId,
      payload: { invoiceId, stripeEventId: event.id },
    });
    const recipientUid = await resolveKinfolkUid(familyId);
    try {
      await enqueueNotification({
        key: 'invoice.payment.applied',
        recipientUid: recipientUid ?? '',
        data: { kinfolkId: familyId, invoiceId, stripeEventId: event.id },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'stripeWebhook',
        event: 'notification.dispatch.failed',
        extra: { familyId, invoiceId, key: 'invoice.payment.applied', err: (err as Error)?.message },
      });
    }
  } else {
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.BILLING_INVOICE_FAILED,
      severity: 'critical', actorRole: 'SYSTEM', familyId,
      payload: { invoiceId, stripeEventId: event.id },
    });
    const recipientUid = await resolveKinfolkUid(familyId);
    try {
      await enqueueNotification({
        key: 'invoice.charge.failed',
        recipientUid: recipientUid ?? '',
        data: { kinfolkId: familyId, invoiceId, stripeEventId: event.id },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'stripeWebhook',
        event: 'notification.dispatch.failed',
        extra: { familyId, invoiceId, key: 'invoice.charge.failed', err: (err as Error)?.message },
      });
    }
  }
  res.status(200).json({ ok: true });
}

export const stripeWebhook = onRequest(
  // Stripe retries on any non-2xx, so shedding here turns into repeated
  // delivery of payment events. A full vCPU keeps 80-way concurrency.
  {
    region: 'us-central1',
    secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN'],
    ...FULL_CPU,
  },
  wrapHttp('stripeWebhook', stripeWebhookHandler),
);
