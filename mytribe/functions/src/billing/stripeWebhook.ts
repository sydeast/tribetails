import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { verifyStripeWebhook } from '../lib/stripe';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const sig = req.headers['stripe-signature'] as string | undefined;
  if (!sig) { res.status(400).json({ error: 'missing-signature' }); return; }
  let event;
  try {
    event = verifyStripeWebhook(req.rawBody, sig);
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
    // invoices use `amount_paid`, PaymentIntents use `amount_received`. Prefer
    // these over re-deriving from our local invoice doc (NOTE-57).
    amount_paid?: number;
    amount_received?: number;
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
  const isPaidEvent = event.type === 'invoice.paid' || event.type === 'payment_intent.succeeded';
  const isFailedEvent = event.type === 'invoice.payment_failed' || event.type === 'payment_intent.payment_failed';
  if (!isPaidEvent && !isFailedEvent) {
    res.status(202).json({ ok: true, ignored: true });
    return;
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
    const invoiceSnap = await tx.get(ref);
    const invoice = invoiceSnap.data() as { lastStripeEventAtMs?: number } | undefined;
    // The state stamp's payment standing reads the `payments` SUBCOLLECTION
    // (Stripe's own mirror docs live in the ROOT `payments` collection, so on
    // a card-only invoice this sums to zero; a manually-recorded partial shows
    // up here and keeps the doc honestly repairable). Read now, before the
    // first write: a Firestore transaction refuses reads after writes.
    const subPaymentsSnap = isPaidEvent ? await tx.get(ref.collection('payments')) : null;
    const lastEventMs = invoice?.lastStripeEventAtMs ?? 0;
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
      const eventAmount =
        typeof eventObject.amount_paid === 'number' && eventObject.amount_paid > 0
          ? eventObject.amount_paid
          : typeof eventObject.amount_received === 'number' && eventObject.amount_received > 0
            ? eventObject.amount_received
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
      const paymentRef = db().collection('payments').doc(event.id);
      tx.set(paymentRef, {
        kinfolkId: familyId,
        invoiceId,
        amount,
        amountResolved,
        amountSource: eventAmount !== null ? 'stripe-event' : localAmount !== null ? 'local-invoice' : 'unresolved',
        paymentMethod: 'stripe',
        referenceNumber,
        date: FieldValue.serverTimestamp(),
        stripeEventId: event.id,
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
  { region: 'us-central1', secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN'] },
  wrapHttp('stripeWebhook', stripeWebhookHandler),
);
