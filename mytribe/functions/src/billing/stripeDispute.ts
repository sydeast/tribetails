import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications/dispatcher';
import type { Severity } from '../lib/schema';

/**
 * Chargebacks: `charge.dispute.created` and `charge.dispute.closed`.
 *
 * A DISPUTE IS NOT A REFUND, and the standing no-refunds ruling does not reach
 * it. A refund is granted by the operator; a dispute is imposed by the
 * cardholder's issuing bank and happens whether or not the operator would ever
 * agree. Until this handler existed the money left the Stripe balance, Stripe
 * deducted a dispute fee, and the invoice kept reading paid with a root
 * `payments` row asserting the money arrived. Nothing anywhere reconciled the
 * two, and the only trace was in the Stripe dashboard.
 *
 * ## What this does NOT do: it does not un-pay the invoice
 *
 * The paid state is left exactly as it stands, deliberately, and this is the
 * load-bearing decision in this file.
 *
 *  - **The money did arrive.** A dispute is a PROVISIONAL withdrawal pending an
 *    issuer ruling. Flipping the invoice back to outstanding asserts the
 *    household owes money again, which may never become true — a won dispute
 *    reinstates the funds and the assertion was a lie for its whole lifetime.
 *  - **`amountDue: 0` is what stops the dunning.** `invoiceRemindersCron` reads
 *    `amountDue <= 0` as settled. Un-paying the invoice therefore restarts
 *    reminder emails and overdue notices at a household over an action their
 *    BANK took. That is a collections decision, taken automatically, by a
 *    webhook, against a household that may be entirely in the right.
 *  - **A reversal is a thing the operator did not do.** Writing a negative
 *    `payments` row would invent a repayment event that never happened and
 *    corrupt `paidCentsFromPayments` for every reader of the ledger. The rule
 *    is fail loud, never fake — and inventing a reversal is faking in the
 *    other direction.
 *  - **Even a LOST dispute stays the operator's call.** Where money owed back
 *    goes is settled policy (account balance, never a refund) and it is a human
 *    decision about a specific household, not a webhook's.
 *
 * So the honest answer is a FLAG plus a loud record: `stripeDisputes/{id}` as
 * the durable operator-facing record, `disputeStatus` on the invoice so no
 * screen can render "paid" without also being able to render "disputed", a
 * `critical` audit entry (the same severity the charge-failure branch uses),
 * and a business-stream notification. The operator decides what the money does.
 *
 * ## Identity: the dispute object carries its OWN metadata, not the payment's
 *
 * This is the trap that sank the card rail in its first form, in a new place.
 * `payInvoice` stamps `familyId`/`invoiceId` on the Checkout Session and on the
 * PaymentIntent. Stripe does not copy either onto a Dispute: `Dispute.metadata`
 * (node_modules/stripe/cjs/resources/Disputes.d.ts) is the dispute's own,
 * always `{}` here. A dispute handler behind `stripeWebhook`'s metadata gate
 * would therefore 202 every chargeback and warn `stripe.metadata.missing`,
 * which names the wrong problem. Resolution goes through the PaymentIntent
 * instead, in two steps, and records which one answered.
 */

/**
 * The Dispute fields read here, mirrored from the pinned SDK
 * (`node_modules/stripe/cjs/resources/Disputes.d.ts`, `interface Dispute`).
 * Typed loose rather than as `Stripe.Dispute` for the same reason
 * `stripeWebhook` types its event object loose: what arrives is JSON off the
 * wire, and a field the SDK declares required is still absent on a replayed or
 * hand-crafted payload.
 *
 * `amount` is the DISPUTED amount in integer minor units, which the SDK notes
 * "can differ" from the charge — a partial dispute is a real shape. It is
 * therefore recorded as its own figure and never assumed equal to the payment.
 */
interface DisputeObject {
  id?: string;
  amount?: number;
  currency?: string;
  /** `string | Charge`; unexpanded (as delivered) it is the id string. */
  charge?: unknown;
  /** `string | PaymentIntent | null`; unexpanded it is the id string. */
  payment_intent?: unknown;
  reason?: string;
  status?: string;
  is_charge_refundable?: boolean;
}

/** The shape of a webhook event this module accepts. */
export interface DisputeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: unknown };
}

export const DISPUTE_EVENT_TYPES = ['charge.dispute.created', 'charge.dispute.closed'] as const;

/**
 * The WHOLE `charge.dispute.` family routes here, not just the two acted on.
 *
 * Every dispute event carries a Dispute object whose `metadata` is its own and
 * is empty here, because Stripe does not copy the PaymentIntent's onto it. A
 * sibling left to fall through would therefore reach the metadata gate and log
 * `stripe.metadata.missing`: a warning naming a defect that is not there, on a
 * chargeback. That is the exact signal this file exists to stop producing, so
 * the promise is kept for the events not handled yet, not only for the two that
 * are.
 *
 * Worth knowing about the three ignored: `funds_withdrawn` is the event saying
 * the money actually left the balance and `funds_reinstated` says it came back,
 * so `disputeStatus` alone does not tell an operator whether the balance has
 * been debited. Acting on those is a follow-up; today they are logged by name
 * rather than mislabelled.
 */
export function isDisputeEvent(type: string): boolean {
  return type.startsWith('charge.dispute.');
}

/** The two acted on. The rest of the family is logged and ignored. */
export function isHandledDisputeEvent(type: string): boolean {
  return (DISPUTE_EVENT_TYPES as readonly string[]).includes(type);
}

/** Where the household/invoice attribution came from. Stored, never guessed. */
type SubjectSource = 'payment-claim' | 'payment-intent-metadata' | 'unresolved';

interface DisputeSubject {
  familyId: string | null;
  invoiceId: string | null;
  source: SubjectSource;
}

function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

/**
 * Household + invoice for a disputed PaymentIntent.
 *
 * 1. `stripePayments/{paymentIntentId}`, the per-PaymentIntent claim the paid
 *    path writes. It already carries `familyId` and `invoiceId`, it is local,
 *    and it is the SAME record that decided which event applied the payment —
 *    so a dispute attributes to exactly the invoice the money was applied to,
 *    with no second source to drift.
 * 2. The PaymentIntent's own metadata, one Stripe retrieve. This is the route
 *    for a payment taken before the claim existed, and for one whose claim was
 *    written by a code path that predates it.
 * 3. Nothing. Recorded as `unresolved` with the ids that ARE known, never
 *    attributed to a plausible-looking household.
 */
async function resolveDisputeSubject(paymentIntentId: string | null): Promise<DisputeSubject> {
  if (!paymentIntentId) return { familyId: null, invoiceId: null, source: 'unresolved' };

  const claimSnap = await db().doc(`stripePayments/${paymentIntentId}`).get();
  const claim = claimSnap.data() as { familyId?: unknown; invoiceId?: unknown } | undefined;
  if (typeof claim?.familyId === 'string' && typeof claim?.invoiceId === 'string') {
    return { familyId: claim.familyId, invoiceId: claim.invoiceId, source: 'payment-claim' };
  }

  try {
    const stripe = await getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const metadata = (pi as { metadata?: Record<string, string> | null }).metadata ?? {};
    const familyId = metadata['familyId'] ?? metadata['kinfolkId'] ?? null;
    const invoiceId = metadata['invoiceId'] ?? null;
    if (familyId && invoiceId) {
      return { familyId, invoiceId, source: 'payment-intent-metadata' };
    }
  } catch {
    // Network hiccup, bad id, Stripe outage. Falls through to unresolved,
    // which is recorded as unresolved — the dispute record still lands.
  }

  return { familyId: null, invoiceId: null, source: 'unresolved' };
}

/**
 * Records one dispute event. Returns the HTTP status the webhook should answer.
 *
 * Idempotent the way every other branch of this webhook is: the event id is
 * reserved in `stripeEvents/{event.id}` inside the same transaction as the
 * writes, and the audit entry and the notification are gated on that
 * reservation, so a Stripe retry re-reads the ledger and short-circuits instead
 * of double-notifying. `created` and `closed` carry different event ids and
 * dedupe independently, which is what lets both apply.
 */
export async function handleStripeDisputeEvent(event: DisputeEvent): Promise<number> {
  if (!isHandledDisputeEvent(event.type)) {
    // A sibling in the family: `updated` (evidence churn), `funds_withdrawn` or
    // `funds_reinstated` (the accounting mirrors of created/closed). Routed here
    // only so it does not reach the metadata gate and get labelled a missing-
    // metadata defect. Named in the log so an operator who subscribes one of
    // them sees it arriving and ignored, rather than seeing nothing.
    logEvent({
      severity: 'info',
      function: 'stripeWebhook',
      event: 'stripe.dispute.unhandledType',
      extra: { eventId: event.id, eventType: event.type },
    });
    return 202;
  }
  const dispute = event.data.object as DisputeObject;
  const disputeId = idOf(dispute.id);
  if (!disputeId) {
    // No id means no key to record under and no way to dedupe. Loud, and 200
    // rather than an error status: a retry re-delivers the same idless payload.
    logEvent({
      severity: 'error',
      function: 'stripeWebhook',
      event: 'stripe.dispute.idMissing',
      extra: { eventId: event.id, eventType: event.type },
    });
    return 200;
  }

  const opened = event.type === 'charge.dispute.created';
  const paymentIntentId = idOf(dispute.payment_intent);
  const chargeId = idOf(dispute.charge);
  const subject = await resolveDisputeSubject(paymentIntentId);
  const disputeStatus = typeof dispute.status === 'string' ? dispute.status : null;

  // The disputed amount, integer minor units, exactly as Stripe sends it. A
  // non-numeric value is recorded as absent and flagged, never as 0: a
  // `amountCents: 0` would claim the bank pulled nothing back.
  const amountCents = typeof dispute.amount === 'number' ? dispute.amount : null;

  const eventCreatedMs = ((event.created ?? 0) as number) * 1000;
  const dedupeRef = db().doc(`stripeEvents/${event.id}`);
  const disputeRef = db().doc(`stripeDisputes/${disputeId}`);
  const invoiceRef = subject.invoiceId ? db().collection('invoices').doc(subject.invoiceId) : null;

  const applied = await db().runTransaction(async (tx) => {
    // Every read before the first write: a Firestore transaction refuses reads
    // after writes.
    const dedupeSnap = await tx.get(dedupeRef);
    if (dedupeSnap.exists) return false;
    const priorSnap = await tx.get(disputeRef);
    const prior = priorSnap.data() as { lastEventCreatedMs?: number } | undefined;
    const priorMs = prior?.lastEventCreatedMs ?? 0;

    // Stripe guarantees no ordering between the two events describing ONE
    // dispute, and `closed` overwriting `created` is fine while the reverse is
    // not: a late `created` merged over a closed dispute would put the record
    // back into `needs_response` and tell the operator to go fight a dispute
    // that is already settled. Same shape as the paid path's out-of-order
    // guard — reserve the id so retries stop, mutate nothing.
    if (eventCreatedMs > 0 && eventCreatedMs < priorMs) {
      tx.create(dedupeRef, {
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        disputeId,
        appliedOutcome: 'SKIPPED_OUT_OF_ORDER',
      });
      return false;
    }

    tx.create(dedupeRef, {
      type: event.type,
      receivedAt: FieldValue.serverTimestamp(),
      eventCreatedMs,
      disputeId,
      ...(subject.familyId ? { familyId: subject.familyId } : {}),
      ...(subject.invoiceId ? { invoiceId: subject.invoiceId } : {}),
      appliedOutcome: opened ? 'DISPUTE_OPENED' : 'DISPUTE_CLOSED',
    });

    tx.set(
      disputeRef,
      {
        disputeId,
        paymentIntentId,
        chargeId,
        familyId: subject.familyId,
        invoiceId: subject.invoiceId,
        // Which of the two routes attributed this, so an operator reading a
        // wrongly-attached dispute can tell WHICH source was wrong.
        subjectSource: subject.source,
        amountCents,
        // Mirrors the payments doc's convention: absent is absent, and the doc
        // says so rather than leaving a reader to infer it from a zero.
        amountResolved: amountCents !== null,
        currency: typeof dispute.currency === 'string' ? dispute.currency : null,
        reason: typeof dispute.reason === 'string' ? dispute.reason : null,
        status: disputeStatus,
        isChargeRefundable: typeof dispute.is_charge_refundable === 'boolean'
          ? dispute.is_charge_refundable
          : null,
        lastEventId: event.id,
        lastEventType: event.type,
        lastEventCreatedMs: eventCreatedMs,
        updatedAt: FieldValue.serverTimestamp(),
        ...(opened ? { openedAt: FieldValue.serverTimestamp() } : { closedAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );

    if (invoiceRef) {
      // A FLAG, and nothing else. `status`, `amountDue`, `paidAt` and the state
      // stamp are all untouched on purpose — see the header. These fields are
      // not part of `InvoiceStateDoc`, so the stamp cannot disagree with them
      // and does not need recomputing here.
      tx.set(
        invoiceRef,
        {
          disputeStatus,
          disputeId,
          disputeAmountCents: amountCents,
          disputeUpdatedAt: FieldValue.serverTimestamp(),
          ...(opened ? { disputedAt: FieldValue.serverTimestamp() } : {}),
        },
        { merge: true },
      );
    }
    return true;
  });

  if (!applied) {
    logEvent({
      severity: 'info',
      function: 'stripeWebhook',
      event: 'stripe.dedup.skipped',
      extra: { id: event.id, type: event.type, reason: 'dispute-replay-or-out-of-order' },
    });
    return 200;
  }

  // Money left the balance and nothing in this system saw it until now. Logged
  // at `error` so it lands in the error stream, not only in an audit collection
  // somebody has to think to open. An unattributed dispute is worse still: it
  // says money is gone AND that we cannot say whose.
  logEvent({
    severity: 'error',
    function: 'stripeWebhook',
    event: opened ? 'stripe.dispute.created' : 'stripe.dispute.closed',
    ...(subject.familyId ? { familyId: subject.familyId } : {}),
    extra: {
      disputeId,
      paymentIntentId,
      chargeId,
      invoiceId: subject.invoiceId,
      subjectSource: subject.source,
      status: disputeStatus,
      reason: dispute.reason ?? null,
      amountCents,
      eventId: event.id,
    },
  });

  // `won` is the one dispute outcome that is good news: the funds are
  // reinstated and the invoice's paid state, left alone this whole time, was
  // right all along. Everything else stays `critical`.
  const won = !opened && disputeStatus === 'won';
  const lost = !opened && disputeStatus === 'lost';
  const severity: Severity = won ? 'info' : 'critical';
  const status: 'SUCCESS' | 'FAILURE' | 'PENDING' = opened ? 'PENDING' : won ? 'SUCCESS' : lost ? 'FAILURE' : 'PENDING';

  await writeAuditEntry({
    status,
    event: opened ? AUDIT_EVENTS.BILLING_PAYMENT_DISPUTED : AUDIT_EVENTS.BILLING_PAYMENT_DISPUTE_CLOSED,
    severity,
    actorRole: 'SYSTEM',
    ...(subject.familyId ? { familyId: subject.familyId } : {}),
    ...(subject.invoiceId ? { targetId: subject.invoiceId, targetCollection: 'invoices' } : {}),
    payload: {
      disputeId,
      stripeEventId: event.id,
      paymentIntentId,
      chargeId,
      invoiceId: subject.invoiceId,
      subjectSource: subject.source,
      disputeStatus,
      reason: dispute.reason ?? null,
      amountCents,
    },
  });

  try {
    await enqueueNotification({
      key: 'invoice.payment.disputed',
      data: {
        ...(subject.familyId ? { kinfolkId: subject.familyId } : {}),
        ...(subject.invoiceId ? { invoiceId: subject.invoiceId } : {}),
        disputeId,
        disputeStatus: disputeStatus ?? 'unknown',
        disputeReason: dispute.reason ?? 'not stated',
        disputeAmount: amountCents !== null ? `$${(amountCents / 100).toFixed(2)}` : 'an unknown amount',
        stripeEventId: event.id,
      },
    });
  } catch (err) {
    // The audit entry above is the durable record and it has already landed, so
    // a dispatch failure loses the ping, not the fact. `error`, not `warn`,
    // because the recipient roster failing here is the difference between the
    // operator learning about a chargeback and not.
    logEvent({
      severity: 'error',
      function: 'stripeWebhook',
      event: 'notification.dispatch.failed',
      extra: {
        familyId: subject.familyId,
        invoiceId: subject.invoiceId,
        key: 'invoice.payment.disputed',
        err: (err as Error)?.message,
      },
    });
  }

  return 200;
}
