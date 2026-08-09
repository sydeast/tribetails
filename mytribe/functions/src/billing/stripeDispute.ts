import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications/dispatcher';
import type { Severity } from '../lib/schema';

/**
 * Chargebacks: the `charge.dispute.` family.
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
 * ## Two facts, two fields: `status` is not `fundsState`
 *
 * `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated` are not
 * lifecycle transitions, and folding them into `disputeStatus` would be a lie in
 * both directions. `status` mirrors STRIPE'S DISPUTE LIFECYCLE, the values
 * Stripe itself puts on the object (`needs_response`, `under_review`, `won`,
 * `lost`), which say where the contest stands. Whether the balance has actually
 * been debited is an ACCOUNTING fact about money, and the two genuinely
 * disagree: a dispute sits at `needs_response` for weeks with the money already
 * withdrawn, and a `won` dispute is not reinstated at the instant it closes.
 *
 * So the balance movement gets its own field, `fundsState`
 * (`'withdrawn' | 'reinstated'`), mirrored on the invoice as `disputeFundsState`,
 * exactly the naming relationship `status` already has with `disputeStatus`.
 * It carries no cents figure: the sum that actually leaves the balance is the
 * disputed amount PLUS Stripe's dispute fee, and `amountCents` on this record is
 * the disputed amount alone. A field named like a debit would be wrong by the
 * fee, and money code here does not publish a figure it did not read.
 *
 * The funds events get NO second operator notification. `invoice.payment.disputed`
 * already fired when the dispute opened (and fires again when it closes); the
 * withdrawal follows the opening by minutes, asks nothing new of the operator,
 * and a second ping for the same money event would train them to ignore the
 * first. Loudness is kept where it belongs instead: a `critical` audit entry
 * under its own event key, and an `error`-stream log line.
 *
 * ## Identity: the dispute object carries its OWN metadata, not the payment's
 *
 * This is the trap that sank the card rail in its first form, in a new place.
 * `payInvoice` stamps `familyId`/`invoiceId` on the Checkout Session and on the
 * PaymentIntent. Stripe does not copy either onto a Dispute: `Dispute.metadata`
 * (node_modules/stripe/cjs/resources/Disputes.d.ts) is the dispute's own,
 * always `{}` here. A dispute handler behind `stripeWebhook`'s metadata gate
 * would therefore 202 every chargeback and warn `stripe.metadata.missing`,
 * which names the wrong problem. Resolution goes through the PaymentIntent and
 * then the Charge instead, in three steps, and records which one answered.
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
  /**
   * `reason: string` in the SDK: a PLAIN STRING, deliberately not a union, and
   * the docstring's list (`fraudulent`, `product_not_received`, `duplicate`, …)
   * is prose rather than a type. Stripe adds categories on its own schedule, so
   * this is stored and mirrored verbatim with no allowlist anywhere in the path.
   * A reason this build has never heard of reaches the operator as sent.
   */
  reason?: string;
  status?: string;
  is_charge_refundable?: boolean;
  /**
   * The SDK declares `evidence_details: Dispute.EvidenceDetails` REQUIRED on
   * `interface Dispute` (Disputes.d.ts:64), and it is typed optional here for
   * the reason the whole interface is loose: a replayed or hand-crafted payload
   * is JSON off the wire and can omit what the SDK swears is always present.
   */
  evidence_details?: {
    due_by?: unknown;
    /** `has_evidence: boolean`, required, Disputes.d.ts:217. */
    has_evidence?: unknown;
    /** `past_due: boolean`, required, Disputes.d.ts:221. */
    past_due?: unknown;
    /** `submission_count: number`, required, Disputes.d.ts:225. */
    submission_count?: unknown;
  } | null;
}

/** The shape of a webhook event this module accepts. */
export interface DisputeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: unknown };
}

/** The dispute LIFECYCLE: what Stripe says about where the contest stands. */
export const DISPUTE_EVENT_TYPES = ['charge.dispute.created', 'charge.dispute.closed'] as const;

/** The BALANCE: what the money actually did. A separate lane, see the header. */
export const DISPUTE_FUNDS_EVENT_TYPES = [
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
] as const;

/**
 * The WHOLE `charge.dispute.` family routes here, not just the ones acted on.
 *
 * Every dispute event carries a Dispute object whose `metadata` is its own and
 * is empty here, because Stripe does not copy the PaymentIntent's onto it. A
 * sibling left to fall through would therefore reach the metadata gate and log
 * `stripe.metadata.missing`: a warning naming a defect that is not there, on a
 * chargeback. That is the exact signal this file exists to stop producing, so
 * the promise is kept for the events not handled yet, not only for the ones that
 * are.
 *
 * The one still ignored is `charge.dispute.updated`: evidence churn on an open
 * dispute. It moves no money and settles nothing, so it is logged by name rather
 * than mislabelled.
 */
export function isDisputeEvent(type: string): boolean {
  return type.startsWith('charge.dispute.');
}

/** The four acted on. The rest of the family is logged and ignored. */
export function isHandledDisputeEvent(type: string): boolean {
  return (
    (DISPUTE_EVENT_TYPES as readonly string[]).includes(type) ||
    (DISPUTE_FUNDS_EVENT_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Which way the balance moved, or `null` for a lifecycle event. Derived from the
 * EVENT TYPE and never from the Dispute payload: the payload's `status` is the
 * lifecycle field and says nothing about whether the money has moved.
 */
type FundsState = 'withdrawn' | 'reinstated';

/**
 * The evidence deadline, in epoch MILLISECONDS, or `null` for "there is none".
 *
 * This is the time-critical fact of the whole feature: a chargeback you fail to
 * answer by this moment is lost by default, so a `needs_response` banner that
 * cannot name the date cannot do its job.
 *
 * **Zero is a real value and it does not mean midnight, 1 January 1970.** The
 * pinned SDK says so in as many words at `Disputes.d.ts:210`: "Date by which
 * evidence must be submitted in order to successfully challenge dispute. Will
 * be 0 if the customer's bank or credit card company doesn't allow a response
 * for this particular dispute." Storing that 0, or a `?? 0` fallback for an
 * absent one, would date the deadline to the epoch and render a chargeback
 * fifty-five years overdue, which is the loudest possible way to be wrong about
 * something a countdown is supposed to be right about. It maps to `null`,
 * alongside an absent `evidence_details`, a null `due_by` (`due_by: number |
 * null`, Disputes.d.ts:212) and anything non-finite. Absent is absent, the same
 * promise `amountResolved` makes about the disputed amount.
 *
 * Seconds go in and milliseconds come out, matching `lastEventCreatedMs` and
 * every other epoch number this handler stores. No formatting happens here: a
 * date rendered in the backend is a date rendered in the SERVER'S locale and
 * timezone, and the operator reading it is not there.
 */
function evidenceDueByMsOf(dispute: DisputeObject): number | null {
  const dueBy = dispute.evidence_details?.due_by;
  if (typeof dueBy !== 'number' || !Number.isFinite(dueBy) || dueBy <= 0) return null;
  return dueBy * 1000;
}

/**
 * HAS THE OPERATOR ALREADY ANSWERED? The three facts that separate two disputes
 * a countdown alone renders identically.
 *
 * Until these existed, an operator who filed evidence a week ago and one who has
 * sent nothing at all saw the same banner and the same "4 days left". Those are
 * opposite situations: the first is waiting on Stripe and should be left alone,
 * the second is four days from losing the money by default. `evidenceDueByMs`
 * cannot tell them apart because it is the same date for both.
 *
 * `null` on any field means WE WERE NOT TOLD, and it is not the same as the
 * value being false or zero.
 *
 *  - **`submissionCount` is the one that says "sent".** `submission_count:
 *    number` (Disputes.d.ts:225), "The number of times evidence has been
 *    submitted. Typically, you may only submit evidence once." A count of 0 is
 *    a MEASUREMENT (Stripe counted, and there were none), so it is stored as
 *    0, which is the exact opposite of what `due_by` does with its zero. There,
 *    0 is Stripe's sentinel for "no deadline exists" and storing it would print
 *    an epoch date. Here, 0 is the fact that drives the loudest banner in the
 *    feature, and nulling it would throw away the reason the feature exists.
 *    Only a non-integer, a negative, or an absent field reads as unknown.
 *  - **`hasEvidence` says STAGED, not sent.** `has_evidence: boolean`
 *    (Disputes.d.ts:217), "Whether evidence has been staged for this dispute."
 *    Staging is saving a draft on the dispute; submitting is the act that
 *    starts the clock on Stripe's side and increments `submission_count`. So
 *    `hasEvidence: true` with `submissionCount: 0` is a half-finished draft
 *    that has NOT been filed, and a screen treating it as "answered" would tell
 *    an operator to stand down four days before they lose the money. The two
 *    are mirrored separately so nothing downstream has to conflate them.
 *  - **`pastDue` does NOT mean "the deadline has passed".** `past_due: boolean`
 *    (Disputes.d.ts:221), "Whether the last evidence submission was submitted
 *    past the due date. Defaults to `false` if no evidence submissions have
 *    occurred. If `true`, then delivery of the latest evidence is *not*
 *    guaranteed." It is a fact about a SUBMISSION, not about the clock, and by
 *    Stripe's own documented default it stays `false` forever for the operator
 *    who never sent anything, which is precisely the operator most in need of
 *    an overdue warning. It therefore does not replace comparing `due_by` against
 *    the clock; it adds a state that comparison could never produce, namely
 *    "you did answer, and you answered late, so do not assume it landed."
 *
 * All three come off the wire loose for the reason the whole interface is
 * loose: the SDK declares them required and a replayed or hand-crafted payload
 * still omits them. A wrong-typed value is unknown, never coerced.
 */
interface EvidenceState {
  hasEvidence: boolean | null;
  pastDue: boolean | null;
  submissionCount: number | null;
}

const EVIDENCE_STATE_UNKNOWN: EvidenceState = {
  hasEvidence: null,
  pastDue: null,
  submissionCount: null,
};

function evidenceStateOf(dispute: DisputeObject): EvidenceState {
  const details = dispute.evidence_details;
  if (!details || typeof details !== 'object') return EVIDENCE_STATE_UNKNOWN;
  const count = details.submission_count;
  return {
    hasEvidence: typeof details.has_evidence === 'boolean' ? details.has_evidence : null,
    pastDue: typeof details.past_due === 'boolean' ? details.past_due : null,
    // `>= 0`, not `> 0`: zero submissions is the answer, not the absence of one.
    submissionCount: typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null,
  };
}

function fundsStateOf(type: string): FundsState | null {
  if (type === 'charge.dispute.funds_withdrawn') return 'withdrawn';
  if (type === 'charge.dispute.funds_reinstated') return 'reinstated';
  return null;
}

/**
 * Where the household/invoice attribution came from. Stored, never guessed.
 *
 * `charge-metadata` is the LAST of the three routes for a reason worth stating:
 * it rests on Stripe copying a PaymentIntent's metadata onto its Charge, and the
 * pinned SDK's type definitions do not say anywhere that it does. The routes
 * ahead of it rest on fields the SDK does declare, so nothing depends on that
 * assumption holding. If it does not, this route simply answers nothing and the
 * dispute records as `unresolved`, which is the honest outcome.
 */
type SubjectSource = 'payment-claim' | 'payment-intent-metadata' | 'charge-metadata' | 'unresolved';

interface DisputeSubject {
  familyId: string | null;
  invoiceId: string | null;
  source: SubjectSource;
  /**
   * The PaymentIntent id in play, INCLUDING one discovered off the Charge when
   * the Dispute payload carried none. Recorded so an operator reading the
   * dispute record does not have to go back to Stripe to find it again.
   */
  paymentIntentId: string | null;
}

function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

/** Reads `familyId`/`invoiceId` out of a Stripe object's metadata bag. */
function metadataSubject(
  source: unknown,
): { familyId: string; invoiceId: string } | null {
  const metadata = (source as { metadata?: Record<string, string> | null } | null | undefined)
    ?.metadata ?? {};
  const familyId = metadata['familyId'] ?? metadata['kinfolkId'] ?? null;
  const invoiceId = metadata['invoiceId'] ?? null;
  return familyId && invoiceId ? { familyId, invoiceId } : null;
}

/**
 * Routes 1 and 2, for one PaymentIntent id. `null` means neither answered.
 *
 * 1. `stripePayments/{paymentIntentId}`, the per-PaymentIntent claim the paid
 *    path writes. It already carries `familyId` and `invoiceId`, it is local,
 *    and it is the SAME record that decided which event applied the payment —
 *    so a dispute attributes to exactly the invoice the money was applied to,
 *    with no second source to drift.
 * 2. The PaymentIntent's own metadata, one Stripe retrieve. This is the route
 *    for a payment taken before the claim existed, and for one whose claim was
 *    written by a code path that predates it.
 */
async function resolveFromPaymentIntent(paymentIntentId: string): Promise<DisputeSubject | null> {
  const claimSnap = await db().doc(`stripePayments/${paymentIntentId}`).get();
  const claim = claimSnap.data() as { familyId?: unknown; invoiceId?: unknown } | undefined;
  if (typeof claim?.familyId === 'string' && typeof claim?.invoiceId === 'string') {
    return {
      familyId: claim.familyId,
      invoiceId: claim.invoiceId,
      source: 'payment-claim',
      paymentIntentId,
    };
  }

  try {
    const stripe = await getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const found = metadataSubject(pi);
    if (found) return { ...found, source: 'payment-intent-metadata', paymentIntentId };
  } catch {
    // Network hiccup, bad id, Stripe outage. Falls through, and the caller
    // records whatever it can. The dispute record still lands.
  }

  return null;
}

/**
 * Household + invoice for a dispute, in three routes plus an honest failure.
 *
 * 1-2. The PaymentIntent the Dispute names: claim doc, then PI metadata.
 * 3.   The CHARGE. `Dispute.payment_intent` is `string | PaymentIntent | null`
 *      in the SDK and null is a delivered shape, while the charge id is on every
 *      Dispute. One `charges.retrieve` then gives two chances: the Charge's
 *      `payment_intent` field (declared in the SDK at Charges.d.ts:161), which
 *      feeds routes 1-2 with an id the Dispute did not carry; and failing that,
 *      the Charge's own metadata. The metadata half rests on Stripe copying a
 *      PaymentIntent's metadata onto its Charge, behaviour this repo asserts in
 *      `stripeWebhook.ts` but which the pinned SDK's types nowhere state, so it
 *      is tried LAST and nothing breaks if it never happens.
 * 4.   Nothing. Recorded as `unresolved` with the ids that ARE known, never
 *      attributed to a plausible-looking household.
 */
async function resolveDisputeSubject(
  paymentIntentId: string | null,
  chargeId: string | null,
): Promise<DisputeSubject> {
  if (paymentIntentId) {
    const viaPaymentIntent = await resolveFromPaymentIntent(paymentIntentId);
    if (viaPaymentIntent) return viaPaymentIntent;
  }

  if (chargeId) {
    try {
      const stripe = await getStripe();
      const charge = await stripe.charges.retrieve(chargeId);
      const chargePaymentIntentId = idOf((charge as { payment_intent?: unknown } | null)?.payment_intent);
      if (chargePaymentIntentId && chargePaymentIntentId !== paymentIntentId) {
        const viaCharge = await resolveFromPaymentIntent(chargePaymentIntentId);
        if (viaCharge) return viaCharge;
      }
      const found = metadataSubject(charge);
      if (found) {
        return {
          ...found,
          source: 'charge-metadata',
          paymentIntentId: chargePaymentIntentId ?? paymentIntentId,
        };
      }
      if (chargePaymentIntentId) {
        // The charge named a PaymentIntent that answered nothing. The id is
        // still worth returning: it is more than the Dispute carried.
        return {
          familyId: null,
          invoiceId: null,
          source: 'unresolved',
          paymentIntentId: chargePaymentIntentId,
        };
      }
    } catch (err) {
      // A lost attribution route, not a lost dispute. Named so an operator
      // looking at an `unresolved` record can tell "Stripe would not answer"
      // apart from "Stripe answered and had nothing".
      logEvent({
        severity: 'warn',
        function: 'stripeWebhook',
        event: 'stripe.dispute.chargeLookupFailed',
        extra: { chargeId, err: (err as Error)?.message },
      });
    }
  }

  return { familyId: null, invoiceId: null, source: 'unresolved', paymentIntentId };
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
    // A sibling in the family: `updated`, evidence churn on an open dispute.
    // Routed here only so it does not reach the metadata gate and get labelled a
    // missing-metadata defect. Named in the log so an operator who subscribes it
    // sees it arriving and ignored, rather than seeing nothing.
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

  const fundsState = fundsStateOf(event.type);
  const opened = event.type === 'charge.dispute.created';
  const eventPaymentIntentId = idOf(dispute.payment_intent);
  const chargeId = idOf(dispute.charge);
  const subject = await resolveDisputeSubject(eventPaymentIntentId, chargeId);
  const paymentIntentId = subject.paymentIntentId ?? eventPaymentIntentId;
  // The LIFECYCLE status, read only on the lifecycle events. A funds event's
  // payload carries one too and it is deliberately not read: the balance moving
  // is not a lifecycle transition, and a late funds event writing `status` would
  // put a settled dispute back into `needs_response`.
  const disputeStatus = fundsState === null && typeof dispute.status === 'string' ? dispute.status : null;

  // The disputed amount, integer minor units, exactly as Stripe sends it. A
  // non-numeric value is recorded as absent and flagged, never as 0: a
  // `amountCents: 0` would claim the bank pulled nothing back.
  const amountCents = typeof dispute.amount === 'number' ? dispute.amount : null;

  // The two facts a banner needs and could not previously get. Both are read
  // and written on the LIFECYCLE lane only, exactly like `status`, and for the
  // same reason: a funds event carries the whole Dispute object, the funds lane
  // orders independently of the lifecycle lane, and a late `funds_withdrawn`
  // writing these would put a stale deadline and a stale reason back onto a
  // dispute that has already closed.
  const evidenceDueByMs = fundsState === null ? evidenceDueByMsOf(dispute) : null;
  const reason = fundsState === null && typeof dispute.reason === 'string' ? dispute.reason : null;
  // And the third: whether the operator has already answered. Same lane and the
  // same reason. A funds event's payload carries an evidence state too, and a
  // late `funds_withdrawn` writing it could tell an operator who has sent
  // nothing that they already responded, on the one screen whose job is to say
  // otherwise while there is still time to act.
  const evidence = fundsState === null ? evidenceStateOf(dispute) : EVIDENCE_STATE_UNKNOWN;

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
    const prior = priorSnap.data() as
      | { lastEventCreatedMs?: number; lastFundsEventCreatedMs?: number }
      | undefined;

    if (fundsState) {
      // ── the funds lane ────────────────────────────────────────────────────
      // Its own ordering stamp, `lastFundsEventCreatedMs`, and that separation
      // is the load-bearing part. Sharing the lifecycle's `lastEventCreatedMs`
      // would mean a `closed` arriving before the `funds_withdrawn` that
      // preceded it made the withdrawal look out of order and DROP it: money
      // leaving the balance, recorded nowhere, which is the exact hole this
      // handler exists to close. The two lanes order independently because they
      // describe two different things.
      const priorFundsMs = prior?.lastFundsEventCreatedMs ?? 0;
      if (eventCreatedMs > 0 && eventCreatedMs < priorFundsMs) {
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
        appliedOutcome: fundsState === 'withdrawn' ? 'DISPUTE_FUNDS_WITHDRAWN' : 'DISPUTE_FUNDS_REINSTATED',
      });

      tx.set(
        disputeRef,
        {
          disputeId,
          // Identity and attribution are written only when this event actually
          // resolved them. A funds event whose lookup came back empty must not
          // blank a `created` event's good attribution with nulls.
          ...(paymentIntentId ? { paymentIntentId } : {}),
          ...(chargeId ? { chargeId } : {}),
          ...(subject.source !== 'unresolved'
            ? {
                familyId: subject.familyId,
                invoiceId: subject.invoiceId,
                subjectSource: subject.source,
              }
            : {}),
          ...(amountCents !== null ? { amountCents, amountResolved: true } : {}),
          ...(typeof dispute.currency === 'string' ? { currency: dispute.currency } : {}),
          // The accounting fact. NOT `status`. See the header.
          fundsState,
          lastFundsEventId: event.id,
          lastFundsEventType: event.type,
          lastFundsEventCreatedMs: eventCreatedMs,
          updatedAt: FieldValue.serverTimestamp(),
          ...(fundsState === 'withdrawn'
            ? { fundsWithdrawnAt: FieldValue.serverTimestamp() }
            : { fundsReinstatedAt: FieldValue.serverTimestamp() }),
        },
        { merge: true },
      );

      if (invoiceRef) {
        // Same flag-and-nothing-else rule as the lifecycle lane: no `status`,
        // no `amountDue`, no state stamp. And no `disputeStatus` either: the
        // balance moving says nothing about where the contest stands.
        tx.set(
          invoiceRef,
          {
            disputeFundsState: fundsState,
            disputeId,
            ...(amountCents !== null ? { disputeAmountCents: amountCents } : {}),
            disputeFundsUpdatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      return true;
    }

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
        reason,
        // Epoch ms, or null for "no deadline exists". See `evidenceDueByMsOf`:
        // null covers both an issuer that allows no response at all and a
        // payload that carried no deadline, and in neither case is there a date
        // to count down to.
        evidenceDueByMs,
        // Has the operator answered, and was the answer late? See
        // `evidenceStateOf`: `submissionCount: 0` is a counted zero and stays 0,
        // `hasEvidence` is staged rather than sent, `evidencePastDue` is about
        // a submission rather than about the clock, and null on any of them
        // means the payload did not say.
        hasEvidence: evidence.hasEvidence,
        evidencePastDue: evidence.pastDue,
        evidenceSubmissionCount: evidence.submissionCount,
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
          // Still a flag and nothing else, just a flag a screen can now read
          // WHY off and BY WHEN. `disputeStatus` alone can say the operator
          // must respond; without these two it cannot say to what, or by when,
          // and the deadline is the part that costs money to miss.
          disputeReason: reason,
          disputeEvidenceDueByMs: evidenceDueByMs,
          // And WHETHER THEY ALREADY ANSWERED, which the deadline cannot say.
          // Two disputes with the same date on them are the same banner today,
          // and one of them is waiting on Stripe while the other is days from
          // losing by default. Null means the payload did not say, which is not
          // the same as nothing having been sent.
          disputeHasEvidence: evidence.hasEvidence,
          disputeEvidencePastDue: evidence.pastDue,
          disputeEvidenceSubmissionCount: evidence.submissionCount,
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

  if (fundsState) {
    const withdrawn = fundsState === 'withdrawn';
    // The withdrawal is the moment the money is actually gone, so it goes to the
    // error stream like the opening does. The reinstatement is the one good
    // outcome in this file and is logged as such.
    logEvent({
      severity: withdrawn ? 'error' : 'info',
      function: 'stripeWebhook',
      event: withdrawn ? 'stripe.dispute.fundsWithdrawn' : 'stripe.dispute.fundsReinstated',
      ...(subject.familyId ? { familyId: subject.familyId } : {}),
      extra: {
        disputeId,
        paymentIntentId,
        chargeId,
        invoiceId: subject.invoiceId,
        subjectSource: subject.source,
        fundsState,
        amountCents,
        eventId: event.id,
      },
    });

    await writeAuditEntry({
      // The balance is down: that is the failure half of the money event. A
      // reinstatement puts it back, which is the success half.
      status: withdrawn ? 'FAILURE' : 'SUCCESS',
      event: withdrawn
        ? AUDIT_EVENTS.BILLING_PAYMENT_DISPUTE_FUNDS_WITHDRAWN
        : AUDIT_EVENTS.BILLING_PAYMENT_DISPUTE_FUNDS_REINSTATED,
      severity: withdrawn ? 'critical' : 'info',
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
        fundsState,
        // The DISPUTED amount, not the debit: Stripe's dispute fee comes out of
        // the balance on top of this and is not on the Dispute object.
        amountCents,
      },
    });

    // No notification. See the header: the operator was pinged when the dispute
    // opened and will be again when it closes, and this event asks nothing new.
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
      reason,
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
      reason,
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
        disputeReason: reason ?? 'not stated',
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
