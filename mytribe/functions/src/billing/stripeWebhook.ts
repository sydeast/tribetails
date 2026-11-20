import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { verifyStripeWebhook, getStripe } from '../lib/stripe';
import { TIP_BASIS_FIELD, dollarsToCents } from '../lib/paymentMoney';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { invoiceCancelled, invoiceMarkedPaid, type InvoicePaidDoc } from '../lib/invoicePaidGate';
import { isWrittenOff, type WriteOffDoc } from '../lib/invoiceArchive';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
// #1005: money notices go to a member with billing access, not the last-synced account.
import { resolveBillingRecipientUid } from '../lib/resolveBillingRecipientUid';
import { enqueueNotificationDetailed, type UnresolvedResolver } from '../notifications/dispatcher';
import { isNoRecipientsError } from '../notifications/recipientErrors';
import {
  centsToDollars,
  formatUsdCents,
  invoiceTotalCentsOf,
  paidCentsFromPayments,
  type PaymentAmount,
} from '../lib/invoiceMath';
import { stageApply } from '../lib/paymentApply';
import {
  CARD_APPLY_FALLBACK_FIELD,
  CARD_PAYMENT_METHOD,
  CARD_PAYMENT_RECORDED_BY,
  PAID_EVENT_TYPES,
  RECOVERED_FROM_FIELD,
  SKIPPED_OUT_OF_ORDER,
  cardHoldReason,
  cardPaymentRowId,
  decideCardApply,
  fallbackNeedsOwnerLine,
  heldAsDuplicate,
} from '../lib/cardPaymentApply';
import type { InvoiceDoc } from '../admin/markInvoicePaid';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { PAYMENT_APPLIED_OWNER_FIELD, paymentAppliedOwner } from '../lib/paymentAppliedOwner';
import { FULL_CPU } from '../lib/runtimeOptions';
import { handleStripeDisputeEvent, isDisputeEvent } from './stripeDispute';
import { handleSetupSessionCompleted, isSetupSessionEvent } from './stripeSetupSession';
import {
  // ORPHANED since docket Q5 (2026-09-27): the duplicate-checkout branch no
  // longer credits the household balance, so nothing here reads it. Left in
  // place, not deleted (payment code is reported, never removed).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ACCOUNT_BALANCE_FIELD,
  CHECKOUT_ROUND_FIELD,
  CHECKOUT_ROUND_METADATA_KEY,
  SETTLED_INTENT_FIELD,
  checkoutRoundOf,
  duplicateCheckoutReason,
  roundFromMetadata,
  type DuplicateCheckoutReason,
  unappliedReasonLabel,
} from '../lib/invoiceCheckoutDedupe';

/**
 * Refund events, ignored BY POLICY rather than by omission. See the branch
 * that reads this set for the ruling and why the branch exists at all.
 */
const IGNORED_REFUND_EVENTS: ReadonlySet<string> = new Set([
  'charge.refunded',
  'refund.created',
  'refund.updated',
]);

/**
 * #866: THE FOLLOW-UP LEDGER on `stripeEvents/{id}`, for an event that applied
 * (PAID) or recorded a failed charge (FAILED).
 *
 *   followupTracked      written with the event record, in the transaction. Only
 *                        an event carrying it is ever recovered on a retry. An
 *                        event recorded before this deploy has no stamps at all,
 *                        and reading that as "unfinished" would send a second
 *                        notice and a second audit entry for a payment that was
 *                        handled in full (a Stripe retry, or a dashboard Resend).
 *   auditWrittenAt       the audit entry is written.
 *   noticeSentAt         the household notice is enqueued.
 *   noticeSkippedReason  the notice could not reach anyone and never will; see
 *                        `isFinalNoticeFailure`. Counts as done.
 */
export const FOLLOWUP_TRACKED_FIELD = 'followupTracked';
export const AUDIT_WRITTEN_FIELD = 'auditWrittenAt';
export const NOTICE_SENT_FIELD = 'noticeSentAt';
export const NOTICE_SKIPPED_FIELD = 'noticeSkippedReason';

// #2344: the skipped-event outcome, the recovery stamp and the paid event
// types live in `lib/cardPaymentApply.ts`, beside the rest of what the card
// backfill script shares with this handler.
export { PAID_EVENT_TYPES, RECOVERED_FROM_FIELD, SKIPPED_OUT_OF_ORDER };

/**
 * How long the dispatcher ledger remembers this webhook's notice for one event.
 * Stripe retries a failed delivery for up to three days; a day more is margin.
 * One event id is one payment, so a window this long can never merge two.
 */
export const STRIPE_NOTICE_DEDUPE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * The activity_log document id for one event's audit entry. Deterministic, so
 * a retry that finds the entry already written (its stamp lost) writes nothing
 * (`writeAuditEntry`'s `docId`).
 */
export function stripeAuditDocId(eventId: string, kind: FollowupKind): string {
  return `stripe_${eventId}_${kind}`;
}

/**
 * Which follow-up an event owes.
 *
 * `unapplied` (docket Q5, 2026-09-27): a card charge that landed on an invoice
 * already paid, or on a stale checkout round. It is recorded as an unapplied
 * payment and needs the ADMIN: a `critical` audit entry and the business-only
 * `invoice.payment.unapplied` notice. Tracked by the same stamps as the other
 * two so a crash between the commit and the notice is finished on Stripe's
 * retry instead of being lost.
 */
export type FollowupKind = 'paid' | 'failed' | 'unapplied' | 'declinedAfterPayment';

/**
 * #2344: `appliedOutcome` for a declined charge on an invoice that was already
 * paid, or whose payment from the same checkout had already landed. The
 * household is sent NO `invoice.charge.failed` for it (they owe nothing by
 * that card, and the notice asks them to pay). The owner gets one Activity Log
 * line in plain words instead, and the invoice is not written at all.
 */
export const DECLINED_AFTER_PAYMENT = 'FAILED_AFTER_PAYMENT';
/** Stored on the event record with `DECLINED_AFTER_PAYMENT`: which of the two it was, and the invoice's number for the line. */
export const DECLINE_REASON_FIELD = 'declineAfterPaymentReason';
export const DECLINE_INVOICE_NUMBER_FIELD = 'declineInvoiceNumber';
/** `noticeSkippedReason` for a decline that is deliberately not told to anyone. */
export const NOTICE_SKIPPED_AFTER_PAYMENT = 'declined-after-payment';

/**
 * Why a decline is not worth telling the household about. #2361: a cancelled
 * or written-off invoice asks nothing of the household either, so a decline
 * on a checkout page opened before the cancel or the write-off is the same
 * owner-only line.
 */
export type DeclineAfterPaymentReason = 'invoice-paid' | 'payment-landed' | 'invoice-cancelled' | 'invoice-written-off';
/** The stored reason read back on a retry. Anything unknown reads as the original `invoice-paid`. */
export function declineReasonOf(raw: unknown): DeclineAfterPaymentReason {
  return raw === 'payment-landed' || raw === 'invoice-cancelled' || raw === 'invoice-written-off' ? raw : 'invoice-paid';
}
export interface DeclineAfterPaymentDetail {
  reason: DeclineAfterPaymentReason;
  invoiceNumber: string;
}

/**
 * PURE. Whether a declined charge has been overtaken by a payment: the
 * PaymentIntent it names has its claim (`stripePayments/{id}`, written in the
 * same commit as the money, so the checkout's own payment landed), or the
 * invoice reads paid, cancelled or written off (#2361). Null when the decline
 * still matters to the household.
 */
export function declineAfterPayment(
  invoice: Record<string, unknown> | undefined | null,
  paymentLanded: boolean,
): DeclineAfterPaymentDetail | null {
  // A payment from this same checkout that has landed is said first, as
  // before: on a cancelled invoice it is held, and the owner already has the
  // line saying why. Otherwise cancelled and written off are asked ahead of
  // paid, the order `duplicateCheckoutReason` asks them in.
  const paid = invoiceMarkedPaid(invoice ?? null);
  const reason: DeclineAfterPaymentReason | null = paymentLanded
    ? paid
      ? 'invoice-paid'
      : 'payment-landed'
    : invoiceCancelled(invoice as InvoicePaidDoc | null)
      ? 'invoice-cancelled'
      : isWrittenOff(invoice as WriteOffDoc | null)
        ? 'invoice-written-off'
        : paid
          ? 'invoice-paid'
          : null;
  if (reason === null) return null;
  const number = invoice?.['invoiceNumber'];
  return { reason, invoiceNumber: typeof number === 'string' ? number : '' };
}

/**
 * #2345: a card payment put on an invoice that was not in a state to be paid
 * (the fallback landing, for any reason `fallbackNeedsOwnerLine` accepts). The
 * paid line in the Activity Log says so instead of reading as an ordinary
 * payment. On a retry it is read back off the `payments/{eventId}` ledger row,
 * written in the same commit as the money.
 *
 * Since the lead ruling of 2026-11-17 no new payment lands this way: it is
 * held for the owner (`cardHoldReason`) and gets the unapplied line and notice
 * instead. This detail is what a retry reads for a payment an earlier build
 * did put on such an invoice, when its Activity Log line was never written.
 */
export interface NotPayableDetail {
  reason: string;
  invoiceNumber: string;
  amountCents: number;
}
/** PURE. The detail off the ledger row the paid event wrote, or null when it took no such landing. */
export function notPayableDetailOf(row: Record<string, unknown> | undefined | null): NotPayableDetail | null {
  const reason = row?.[CARD_APPLY_FALLBACK_FIELD];
  if (typeof reason !== 'string' || !fallbackNeedsOwnerLine(reason)) return null;
  const n = row?.['appliedInvoiceNumber'];
  const cents = row?.['amountCents'];
  return {
    reason,
    invoiceNumber: typeof n === 'string' ? n : '',
    amountCents: typeof cents === 'number' && Number.isFinite(cents) ? cents : 0,
  };
}
/** What the `unapplied` follow-up says about the charge. Stored on the event record for a retry. */
export interface UnappliedDetail {
  paymentIntentId: string | null;
  duplicateReason: string | null;
  unappliedCents: number;
}

/** The business-only notice the admin gets for an unapplied charge. */
export const UNAPPLIED_NOTICE_KEY = 'invoice.payment.unapplied';

/**
 * A notice that can never reach anyone: no household account and no office
 * roster. The dispatcher throws `NoRecipientsError` (code 'no-recipients') only
 * when every resolver is empty BY DEFINITION; a failed roster read is rethrown
 * as itself and stays retryable. Retrying a genuine "nobody" for Stripe's three
 * days changes nothing, so only that code is final.
 */
export function isFinalNoticeFailure(err: unknown): boolean {
  return isNoRecipientsError(err);
}

/**
 * The follow-up to an event that has committed: the audit entry, then the
 * notice (#866: this webhook is the only sender of both keys), each stamped on
 * `stripeEvents/{eventId}` once done. Skips a step already stamped. THROWS on
 * any failure of a step, so the caller answers 500 and Stripe retries, except a
 * notice that can reach nobody, which is logged, stamped as skipped and final.
 *
 * A failed STAMP does not throw. The step it records did happen, and after a 200
 * Stripe does not retry. If a later step throws and a retry comes, the audit
 * entry's deterministic id and the notice's ledger identity stop a repeat.
 */
async function finishEventFollowup(input: {
  kind: FollowupKind;
  familyId: string;
  invoiceId: string;
  eventId: string;
  auditDone: boolean;
  noticeDone: boolean;
  /** Set for `unapplied` only. */
  unapplied?: UnappliedDetail;
  /** Set for `declinedAfterPayment` only. */
  declined?: DeclineAfterPaymentDetail;
  /** #2345: set for `paid` only, when the invoice was not in a state to be paid. */
  notPayable?: NotPayableDetail | null;
  /**
   * Who started the checkout: `payInvoice` stamps the caller's uid into the
   * session metadata. Since D-2026-09-28-BILLING-ACCESS-PAYS that can be a
   * SECONDARY with billing access, so the paid audit entry names them rather
   * than leaving "the household" to be read as the primary. Absent on a
   * session minted before the stamp existed.
   */
  paidByUid?: string | null;
}): Promise<void> {
  const eventRef = db().doc(`stripeEvents/${input.eventId}`);
  const stamp = async (fields: Record<string, unknown>) => {
    await eventRef.set(fields, { merge: true }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'stripeWebhook',
        event: 'stripe.followup.stamp.failed',
        extra: { eventId: input.eventId, fields: Object.keys(fields), err: (err as Error)?.message },
      });
    });
  };
  const paid = input.kind === 'paid';
  const unapplied = input.kind === 'unapplied';
  const detail: UnappliedDetail = input.unapplied ?? { paymentIntentId: null, duplicateReason: null, unappliedCents: 0 };
  if (input.kind === 'declinedAfterPayment') {
    // #2344: THE OWNER'S LINE, AND NO NOTICE TO ANYONE. `info`: no money moved
    // and nothing is asked of the owner. The notice is stamped as skipped in
    // the same breath, so no retry of this event ever sends one.
    const declined: DeclineAfterPaymentDetail = input.declined ?? { reason: 'invoice-paid', invoiceNumber: '' };
    if (!input.auditDone) {
      // Loaded here, on the one path that needs it, to keep the sentences out
      // of every function's cold start (test/coldStartImportGraph.test.ts).
      const { cardDeclinedAfterPaymentWords } = await import('../lib/activityWords.js');
      await writeAuditEntry({
        status: 'FAILURE',
        event: AUDIT_EVENTS.BILLING_CARD_DECLINED_AFTER_PAYMENT,
        severity: 'info',
        actorRole: 'SYSTEM',
        familyId: input.familyId,
        // No target: the Activity Log row would end with the invoice's document
        // id. The line names the invoice by its number; the id is in the payload.
        description: cardDeclinedAfterPaymentWords(declined.invoiceNumber, declined.reason),
        payload: { invoiceId: input.invoiceId, stripeEventId: input.eventId, reason: declined.reason },
        docId: stripeAuditDocId(input.eventId, input.kind),
      });
    }
    await stamp({
      ...(input.auditDone ? {} : { [AUDIT_WRITTEN_FIELD]: FieldValue.serverTimestamp() }),
      ...(input.noticeDone ? {} : { [NOTICE_SKIPPED_FIELD]: NOTICE_SKIPPED_AFTER_PAYMENT }),
    });
    return;
  }
  const notPayable = paid ? (input.notPayable ?? null) : null;
  // Loaded only on the rare path that needs it (test/coldStartImportGraph.test.ts).
  const notPayableWords =
    notPayable !== null && !input.auditDone ? (await import('../lib/activityWords.js')).cardPaymentNotPayableWords : null;
  if (!input.auditDone) {
    await writeAuditEntry({
      status: paid ? 'SUCCESS' : 'FAILURE',
      event: paid
        ? AUDIT_EVENTS.BILLING_INVOICE_PAID
        : unapplied
          ? AUDIT_EVENTS.BILLING_PAYMENT_UNAPPLIED
          : AUDIT_EVENTS.BILLING_INVOICE_FAILED,
      // #2345: `warn`, and its own sentence, for a payment the invoice was not
      // in a state to take. The owner should look at that invoice.
      severity: paid ? (notPayable !== null ? 'warn' : 'info') : 'critical',
      actorRole: 'SYSTEM',
      familyId: input.familyId,
      ...(notPayable !== null && notPayableWords !== null
        ? { description: notPayableWords(notPayable.invoiceNumber, notPayable.reason, notPayable.amountCents) }
        : {}),
      payload: unapplied
        ? {
            invoiceId: input.invoiceId,
            stripeEventId: input.eventId,
            paymentIntentId: detail.paymentIntentId,
            duplicateReason: detail.duplicateReason,
            unappliedCents: detail.unappliedCents,
            // The root `payments/{eventId}` row that holds the money.
            paymentId: input.eventId,
          }
        : {
            invoiceId: input.invoiceId,
            stripeEventId: input.eventId,
            ...(paid && input.paidByUid ? { paidByUid: input.paidByUid } : {}),
            ...(notPayable !== null ? { cardApplyFallback: notPayable.reason } : {}),
          },
      docId: stripeAuditDocId(input.eventId, input.kind),
    });
    await stamp({ [AUDIT_WRITTEN_FIELD]: FieldValue.serverTimestamp() });
  }
  if (!input.noticeDone) {
    const key = paid ? 'invoice.payment.applied' : unapplied ? UNAPPLIED_NOTICE_KEY : 'invoice.charge.failed';
    // The unapplied notice is BUSINESS-ONLY: the household is told nothing
    // until the admin has decided what the money becomes.
    const recipientUid = unapplied ? null : await resolveBillingRecipientUid(input.familyId);
    let unresolved: UnresolvedResolver[];
    try {
      const outcome = await enqueueNotificationDetailed({
        key,
        // '' for a household with no portal account: the office copy still goes out.
        recipientUid: recipientUid ?? '',
        data: unapplied
          ? {
              kinfolkId: input.familyId,
              invoiceId: input.invoiceId,
              stripeEventId: input.eventId,
              unappliedAmount: formatUsdCents(detail.unappliedCents),
              unappliedReason: unappliedReasonLabel(detail.duplicateReason),
            }
          : { kinfolkId: input.familyId, invoiceId: input.invoiceId, stripeEventId: input.eventId },
        dedupeWindowMs: STRIPE_NOTICE_DEDUPE_WINDOW_MS,
      });
      unresolved = outcome.unresolved ?? [];
    } catch (err) {
      if (!isFinalNoticeFailure(err)) throw err;
      logEvent({
        severity: 'error',
        function: 'stripeWebhook',
        event: 'stripe.notice.unreachable',
        extra: { familyId: input.familyId, invoiceId: input.invoiceId, eventId: input.eventId, key, err: (err as Error)?.message },
      });
      await stamp({ [NOTICE_SKIPPED_FIELD]: 'no-recipients' });
      return;
    }
    if (unresolved.length > 0) {
      // #866: the household copy went out but an audience's lookup FAILED (the
      // office roster read). The notice is not done: no stamp, and the throw
      // answers 500 so Stripe retries. On that retry the dispatcher ledger
      // (per-recipient, STRIPE_NOTICE_DEDUPE_WINDOW_MS) stops the household copy
      // repeating while the office copy goes out.
      throw new Error(
        `stripeWebhook: ${key} for ${input.eventId} reached some recipients but ${unresolved
          .map((u) => u.resolver)
          .join(', ')} could not be resolved (${unresolved.map((u) => u.error).join('; ')}); retrying for the rest`,
      );
    }
    await stamp({ [NOTICE_SENT_FIELD]: FieldValue.serverTimestamp() });
  }
}

/**
 * A plain sentence for the admin notice, off `duplicateCheckoutReason`'s code.
 * Lives in `lib/invoiceCheckoutDedupe.ts` since #1003 (the admin's list of
 * payments waiting for a decision prints the same sentence); re-exported here
 * for the callers and the test that import it from this module.
 */
export { unappliedReasonLabel };

/**
 * NOTE-57: what the card was charged, in cents. Stripe's own figure, else the
 * invoice's stated balance, else its total (the flat doc's legacy dollar
 * floats, converted once). Null when none of them is positive. #2345: one
 * rule, read by the held check and by the apply, so the two cannot disagree.
 */
function cardChargeCents(eventAmountCents: number | null, invoiceData: unknown): number | null {
  if (eventAmountCents !== null) return eventAmountCents;
  const d = invoiceData as { amountDue?: number; total?: number } | undefined;
  const local =
    typeof d?.amountDue === 'number' && d.amountDue > 0
      ? d.amountDue
      : typeof d?.total === 'number' && d.total > 0
        ? d.total
        : null;
  return local !== null ? dollarsToCents(local) : null;
}

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
  // ── Branches that must sit AHEAD of the metadata gate ────────────────────
  // The gate below resolves the household from `event.data.object.metadata`,
  // which `payInvoice` stamps on the Checkout Session and the PaymentIntent.
  // Disputes carry a DIFFERENT object whose `metadata` is the dispute's own and
  // is always empty, so behind the gate every chargeback would 202 with a
  // `stripe.metadata.missing` warn: a signal naming the wrong problem.
  //
  // Refunds are ahead of the gate for a different reason, and the distinction
  // matters because the obvious one is wrong. `refund.created`/`refund.updated`
  // do carry the Refund's own empty metadata, but Stripe copies a PaymentIntent's
  // metadata onto its Charge at creation, and since the card-rail fix
  // `payInvoice` sets `payment_intent_data.metadata` — so a real
  // `charge.refunded` WOULD pass the gate, and would then hit the unhandled-type
  // 202 with no log at all. Refunds sit here to be ignored VISIBLY, not because
  // the gate would mislabel them.

  if (isDisputeEvent(event.type)) {
    // A chargeback. Not a refund, and not covered by the no-refunds ruling:
    // the cardholder's bank imposes it. See `billing/stripeDispute.ts`.
    const code = await handleStripeDisputeEvent(event);
    res.status(code).json({ ok: true, dispute: true });
    return;
  }

  if (IGNORED_REFUND_EVENTS.has(event.type)) {
    // DELIBERATE, not missing. Standing operator ruling: no refunds, ever —
    // an account balance credit is the only destination for money owed back
    // (`portal/redeemCredit.ts` records the removal of the Stripe refund leg,
    // and the mockup carrying the ruling is
    // `mytribe/ui-ideas/mytribe-invoice-detail-2026-05-31-NoRefundtoOP-onlyAccountCredit.html`).
    // These types are therefore never subscribed and would never arrive; this
    // branch exists so that if one ever does, the ignore is legibly a decision
    // rather than the unhandled-type fall-through it is otherwise
    // indistinguishable from. "Refund handling is missing" has been filed as a
    // bug three times.
    logEvent({
      severity: 'info',
      function: 'stripeWebhook',
      event: 'stripe.refund.ignored',
      extra: { type: event.type, eventId: event.id },
    });
    res.status(202).json({ ok: true, ignored: true, reason: 'no-refunds-policy' });
    return;
  }

  if (isSetupSessionEvent(event)) {
    // The household saved a card (issue #399, item 3). A setup-mode Checkout
    // Session carries no `invoiceId`, so behind the metadata gate below it
    // would 202 as `stripe.metadata.missing` and the card would never reach
    // `clients/{uid}`.
    //
    // This is the BACKSTOP, not the primary path: the portal calls
    // `syncMyPaymentMethod` the moment the browser returns from Checkout, so
    // the card is normally already stored by the time this event arrives and
    // the sync is a no-op. It exists for the household that closes the tab on
    // Stripe's confirmation page instead of coming back.
    const code = await handleSetupSessionCompleted(event);
    res.status(code).json({ ok: true, setup: true });
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

  // A Checkout Session the household abandoned. Stripe expires one ~24h after
  // creation, and until now nothing cleared the `pendingCheckoutSessionId` /
  // `pendingAt` pair `payInvoice` writes (`payInvoice.ts`, the set after the
  // session create). Nothing reads them yet either, so today this is tidying —
  // but the first screen to render "payment in progress" off that field would
  // otherwise render it forever, for a session Stripe closed a year ago.
  //
  // CONDITIONAL on the stored id matching this session, which is the whole
  // correctness argument and the idempotency argument at once. A household that
  // abandons one checkout and starts another has a NEWER pending id on the
  // invoice by the time the older session expires; an unconditional clear would
  // wipe the live one. Comparing first makes a duplicate delivery a no-op for
  // free, so this branch needs no ledger entry of its own: it moves no money
  // and fires no audit or notification that a retry could double.
  if (event.type === 'checkout.session.expired') {
    const sessionId = typeof eventObject.id === 'string' ? eventObject.id : null;
    const cleared = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const pending = (snap.data() as { pendingCheckoutSessionId?: unknown } | undefined)
        ?.pendingCheckoutSessionId;
      if (!sessionId || pending !== sessionId) return false;
      tx.set(
        ref,
        { pendingCheckoutSessionId: FieldValue.delete(), pendingAt: FieldValue.delete() },
        { merge: true },
      );
      return true;
    });
    logEvent({
      severity: 'info',
      function: 'stripeWebhook',
      event: 'stripe.session.expired',
      extra: { invoiceId, familyId, sessionId, eventId: event.id, cleared },
    });
    res.status(200).json({ ok: true, cleared });
    return;
  }

  // Idempotency: Stripe retries failed deliveries. Without a dedupe ledger
  // the same event re-fires audits + notifications. The transaction atomically
  // (a) reserves the event id, (b) reads the current invoice state, and (c) for
  // a FAILED event only, checks it is not older than the last event applied to
  // the invoice. A replay is skipped; so is a failed event that arrives late.
  //
  // #2344: A PAID EVENT IS NEVER SKIPPED FOR ITS DATE. The card is already
  // charged when Stripe says so. Until #2344 step (c) ran for every event, and
  // a declined charge stamps the invoice with its own time, so a payment whose
  // first delivery failed and whose retry arrived after a later decline on a
  // newer checkout was answered 200 and written nowhere. Its event id was
  // reserved by the skip, so no further retry could land it. What stops a paid
  // event being applied twice is the per-payment claim and the per-invoice
  // settlement check below, neither of which reads a date.
  const eventCreatedMs = ((event.created ?? 0) as number) * 1000;
  // `checkout.session.completed` is the canonical event for a `mode: 'payment'`
  // Checkout integration, which is what `payInvoice` creates. It was missing
  // here, so it fell through to the unhandled-type 202 below.
  const isPaidEvent = PAID_EVENT_TYPES.includes(event.type);
  const isFailedEvent = event.type === 'invoice.payment_failed' || event.type === 'payment_intent.payment_failed';
  if (!isPaidEvent && !isFailedEvent) {
    res.status(202).json({ ok: true, ignored: true });
    return;
  }

  // A Checkout Session can complete WITHOUT the money having been collected —
  // `payment_status: 'unpaid'` is how a delayed/async method reports "session
  // finished, funds pending". Unreachable while `payInvoice` allows only card,
  // Klarna and Affirm (`allowed_payment_method_types`, issue #1192), which all
  // settle at completion, and this is the guard that keeps it unreachable
  // rather than trusting that list never grows an async rail. Marking an
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
  // and they must agree. Deliberately NOT `referenceNumber`, though NOT because
  // the two would disagree today: trace it and they do not. On a Session it
  // reads `payment_intent`, and on a PaymentIntent event it falls through to
  // `eventObject.id`, which IS the PaymentIntent id, so both land on the same
  // `pi_...` in every reachable case.
  //
  // The reason is what the two values are FOR. `referenceNumber` is a display
  // label with a fallback chain, and a chain that always ends in something
  // non-empty is the wrong shape for an identity: when its preferred source is
  // missing it degrades to a plausible-looking different key rather than to
  // nothing. A claim key has to be a strict identity or explicitly absent, so
  // that a failure to establish identity is visible instead of being papered
  // over with the event id.
  const paymentIntentId =
    (typeof eventObject.payment_intent === 'string' && eventObject.payment_intent) ||
    (event.type.startsWith('payment_intent') && typeof eventObject.id === 'string' && eventObject.id) ||
    null;

  // Exactly-once per PAYMENT, where the ledger above is exactly-once per EVENT.
  // One successful card payment now delivers TWO events that both mean paid —
  // `checkout.session.completed` and `payment_intent.succeeded` — carrying two
  // different `event.id`s, so `stripeEvents/{event.id}` cannot dedupe them
  // against each other, and no date check stands between a paid event and the
  // invoice (#2344). Unguarded, the second event writes a SECOND
  // `payments/{eventId}` mirror doc — double-counting real money in the root
  // ledger — plus a second BILLING_INVOICE_PAID audit entry and a second
  // `invoice.payment.applied` notification to the household.
  //
  // Paid events only, deliberately. A `payment_intent.payment_failed` must not
  // claim the id: a declined card the household then retries successfully has
  // to be able to apply.
  const paymentClaimRef =
    isPaidEvent && paymentIntentId ? db().doc(`stripePayments/${paymentIntentId}`) : null;
  if (isPaidEvent && !paymentIntentId) {
    // Unreachable today: a paid card Session always carries `payment_intent` as
    // a string, and a PaymentIntent event always has its own id. Said out loud
    // anyway, because this is the ONE way the claim above degrades, and it
    // degrades to no protection at all. Without this the only trace would be
    // `stripe.fee.unresolved` below, which names a different problem and would
    // send whoever reads it looking in the wrong place.
    logEvent({
      severity: 'error',
      function: 'stripeWebhook',
      event: 'stripe.paymentIntentId.unresolved',
      extra: { eventId: event.id, eventType: event.type },
    });
  }

  // WHICH SETTLEMENT ROUND THE SESSION BEHIND THIS EVENT WAS MINTED IN
  // (issue #826). `payInvoice` stamps it on the Session AND the PaymentIntent,
  // so it reaches here on either of the two events one card payment produces.
  // `null` when the session predates the stamp, which is a different state from
  // round 0 — see `roundFromMetadata`.
  const eventRound = roundFromMetadata(metadata?.[CHECKOUT_ROUND_METADATA_KEY]);

  // THE AUTHORITATIVE AMOUNT, off the event itself (NOTE-57). Hoisted out of
  // the transaction because BOTH outcomes need it now: the apply below records
  // it against the invoice, and the duplicate branch credits it to the
  // household's account balance. Deriving it twice is how the two would come to
  // disagree about how much money arrived.
  const eventAmountCents =
    typeof eventObject.amount_paid === 'number' && eventObject.amount_paid > 0
      ? eventObject.amount_paid
      : typeof eventObject.amount_received === 'number' && eventObject.amount_received > 0
        ? eventObject.amount_received
        : typeof eventObject.amount_total === 'number' && eventObject.amount_total > 0
          ? eventObject.amount_total
          : null;

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
  // What the invoice-level dedupe decided, read back after the txn commits so
  // the loud log and the audit entry sit outside it. Same pattern and same
  // reason as `unresolvedAmount`: reset on every attempt's write path, because
  // a Firestore transaction re-runs its callback on contention.
  let duplicateReason: DuplicateCheckoutReason = null;
  let unappliedCents = 0;
  // #2276: why the card payment took the fallback landing, when it did. Read
  // back after the commit for the warn line, like the two above.
  let cardFallbackReason: string | null = null;
  // #2345: the owner's line for a card payment on an invoice that was not in a
  // state to be paid. Read back after the commit, like the reason above.
  let notPayableDetail: NotPayableDetail | null = null;
  // #2344: this delivery is deciding a paid event an earlier build skipped.
  let recoveredSkip = false;
  // #2344: a decline the household is not told about, and why. Read back after
  // the commit for the Activity Log line.
  let declinedDetail: DeclineAfterPaymentDetail | null = null;
  // The claim of the PaymentIntent a FAILED event names. Read, never written:
  // a decline must not claim the id (see `paymentClaimRef`).
  const declinedClaimRef =
    isFailedEvent && paymentIntentId ? db().doc(`stripePayments/${paymentIntentId}`) : null;
  const decision = await db().runTransaction(async (tx) => {
    unresolvedAmount = false;
    recoveredSkip = false;
    declinedDetail = null;
    duplicateReason = null;
    unappliedCents = 0;
    cardFallbackReason = null;
    notPayableDetail = null;
    const dedupeSnap = await tx.get(dedupeRef);
    const storedEvent = dedupeSnap.exists ? ((dedupeSnap.data() ?? {}) as Record<string, unknown>) : null;
    // #2344: A PAID EVENT THE OLD ORDER CHECK SKIPPED is not a replay of
    // anything: nothing was written for it but this record. When Stripe sends
    // it again (its own retry, or Resend in the dashboard) it is decided afresh
    // below, like a first delivery, and this record is rewritten with what was
    // decided. A skipped FAILED event stays skipped.
    const recovering = isPaidEvent && storedEvent?.['appliedOutcome'] === SKIPPED_OUT_OF_ORDER;
    recoveredSkip = recovering;
    /** Writes this event's record: created on a first delivery, rewritten when recovering a skipped one. */
    const reserveEvent = (data: Record<string, unknown>) => {
      if (recovering) tx.set(dedupeRef, { ...data, [RECOVERED_FROM_FIELD]: SKIPPED_OUT_OF_ORDER });
      else tx.create(dedupeRef, data);
    };
    if (storedEvent !== null && !recovering) {
      // #866: what the first delivery recorded, so a retry can finish a paid
      // event whose audit entry or household notice never went out.
      const stored = storedEvent;
      return {
        proceed: false,
        reason: 'replay' as const,
        appliedOutcome: typeof stored['appliedOutcome'] === 'string' ? stored['appliedOutcome'] : '',
        followupTracked: stored[FOLLOWUP_TRACKED_FIELD] === true,
        auditDone: stored[AUDIT_WRITTEN_FIELD] != null,
        noticeDone: stored[NOTICE_SENT_FIELD] != null || stored[NOTICE_SKIPPED_FIELD] != null,
        declined: {
          reason: declineReasonOf(stored[DECLINE_REASON_FIELD]),
          invoiceNumber:
            typeof stored[DECLINE_INVOICE_NUMBER_FIELD] === 'string' ? stored[DECLINE_INVOICE_NUMBER_FIELD] : '',
        } as DeclineAfterPaymentDetail,
        unapplied: {
          paymentIntentId: typeof stored['paymentIntentId'] === 'string' ? stored['paymentIntentId'] : null,
          duplicateReason: typeof stored['duplicateReason'] === 'string' ? stored['duplicateReason'] : null,
          unappliedCents: typeof stored['unappliedCents'] === 'number' ? stored['unappliedCents'] : 0,
        } as UnappliedDetail,
      };
    }
    // Every read before the first write: a Firestore transaction refuses reads
    // after writes, so this sits with the other gets, not with its branch.
    const claimSnap = paymentClaimRef ? await tx.get(paymentClaimRef) : null;
    const declinedClaimSnap = declinedClaimRef ? await tx.get(declinedClaimRef) : null;
    const invoiceSnap = await tx.get(ref);
    const invoice = invoiceSnap.data() as
      | {
          lastStripeEventAtMs?: number;
          amountDue?: unknown;
          amountDueCents?: unknown;
          [CHECKOUT_ROUND_FIELD]?: unknown;
          [SETTLED_INTENT_FIELD]?: unknown;
          status?: unknown;
          paymentStatus?: unknown;
          invoiceStatus?: unknown;
          writtenOffAt?: unknown;
        }
      | undefined;
    // The invoice's own `payments` rows: what has been collected on it, and
    // (#2276) what the card payment is applied against. Read now, before the
    // first write: a Firestore transaction refuses reads after writes.
    const subPaymentsSnap = isPaidEvent ? await tx.get(ref.collection('payments')) : null;
    const lastEventMs =
      typeof invoice?.lastStripeEventAtMs === 'number' && Number.isFinite(invoice.lastStripeEventAtMs)
        ? invoice.lastStripeEventAtMs
        : 0;
    if (claimSnap?.exists) {
      // The other event describing this same PaymentIntent already applied.
      // Reserve THIS event id so its own Stripe retries short-circuit at the
      // replay branch above, and mutate nothing else.
      reserveEvent({
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        familyId,
        invoiceId,
        appliedOutcome: 'SKIPPED_DUPLICATE_PAYMENT',
      });
      return { proceed: false, reason: 'duplicate-payment' as const };
    }

    // ── EXACTLY-ONCE PER INVOICE SETTLEMENT (issue #826) ──────────────────
    //
    // The third ledger, and the only one that looks at the INVOICE. The two
    // above are per event and per PaymentIntent, and `payInvoice` mints a new
    // Checkout Session — hence a new PaymentIntent, hence new event ids — on
    // every call, so two completed sessions for one bill sail past both. Two
    // real charges, and until this branch the server stopped neither.
    //
    // IT RUNS AFTER THE PAYMENT CLAIM, AND THE ORDER IS NOT COSMETIC. One card
    // payment delivers TWO paid events (`checkout.session.completed` and
    // `payment_intent.succeeded`). Ahead of the claim check, the second of them
    // would read as a cross-session duplicate and this branch would credit an
    // account for money that had just been applied correctly — a worse bug than
    // the one being fixed. The claim answers "is this the same payment?" first;
    // only then does this ask "is this a second payment for a settled bill?".
    //
    // `lib/invoiceCheckoutDedupe.ts` holds the decision and the reasoning,
    // including why a key of `invoiceId` alone would refuse a household's real
    // second payment.
    const duplicate = isPaidEvent
      ? duplicateCheckoutReason({
          invoice: {
            round: invoice?.[CHECKOUT_ROUND_FIELD],
            settledPaymentIntentId: invoice?.[SETTLED_INTENT_FIELD],
            amountDueCents: invoice?.amountDueCents,
            amountDue: invoice?.amountDue,
            status: invoice?.status,
            paymentStatus: invoice?.paymentStatus,
            // #2358: a cancelled invoice takes no payment; the charge is held.
            invoiceStatus: invoice?.invoiceStatus,
            // #2363: a written-off invoice is held with its own reason.
            writtenOffAt: invoice?.writtenOffAt,
          },
          paymentIntentId,
          eventRound,
        })
      : null;
    // #2345 (lead ruling 2026-11-17): WHETHER THE INVOICE CAN TAKE THIS PAYMENT
    // AT ALL, decided here, ahead of the held branch. One that cannot (it does
    // not exist, it is another household's, a draft or a quote, a credit, or
    // nothing is owed on its total) HOLDS the payment for the owner, exactly
    // as a cancelled one does, and nothing is applied. `cardHoldReason` has
    // the cases and the order they are asked in. The apply further down uses
    // the same landing, decided once on the same reads.
    const invoiceDoc = invoiceSnap.exists ? ((invoiceSnap.data() ?? {}) as InvoiceDoc) : null;
    const rowsRead = (subPaymentsSnap?.docs ?? []).map((d) => d.data() as PaymentAmount);
    const cardLanding = isPaidEvent
      ? decideCardApply({
          invoiceId,
          doc: invoiceDoc,
          existingPayments: rowsRead,
          cardCents: cardChargeCents(eventAmountCents, invoiceSnap.data()),
          kinfolkId: familyId,
        })
      : null;
    duplicateReason = isPaidEvent
      ? cardHoldReason({ doc: invoiceDoc, existingPayments: rowsRead, kinfolkId: familyId, duplicate, landing: cardLanding })
      : null;
    if (duplicateReason !== null) {
      // THE MONEY IS ALREADY GONE FROM THE CARD. Stripe collected it before it
      // told us, so "refuse" cannot mean "reverse", and there are no refunds,
      // ever (operator ruling, 2026-08-06).
      //
      // AND IT IS NOT CREDITED EITHER (operator ruling 2026-09-27, docket Q5:
      // a paid invoice takes no payment; account credit only when the admin
      // enters an amount, #988). Until that ruling this branch added the whole
      // charge to `families/{id}.accountBalanceCents` on its own. Now the charge
      // is recorded as an UNAPPLIED payment linked to the invoice, the admin is
      // flagged (critical audit entry + business-only `invoice.payment.unapplied`
      // notice, sent after the commit), and the admin decides what it becomes.
      // `scripts/reportDuplicateCheckoutCredits.ts` lists the charges the old
      // branch credited.
      //
      // Every reason is treated the same, `stale-round` included: a stale
      // session charges a balance that has since moved, and deciding what the
      // difference becomes is the same admin decision.
      //
      // #2358: `invoice-cancelled` too. A checkout page opened before the
      // invoice was cancelled can still be paid on. The invoice stays
      // cancelled, exactly as stored: no row on it, no balance moved.
      //
      // #2345: and an invoice that could not take the payment at all (a draft
      // or a quote, a credit, nothing owed on its total, another household's,
      // or no invoice). Nothing is applied and nothing is credited.
      //
      // NOT DONE HERE, all deliberate: no second `status: 'paid'` stamp, no
      // BILLING_INVOICE_PAID audit, and no `invoice.payment.applied` to the
      // household. The invoice was not paid again.
      //
      // ONLY the amount Stripe itself reports. The local-invoice fallback the
      // apply path uses is meaningless here: this invoice's balance is zero (or
      // the round is stale), which is why we are in this branch. No amount means
      // a flagged row with no figure, never a guess.
      const chargeCents = eventAmountCents ?? 0;
      unappliedCents = chargeCents;
      reserveEvent({
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        familyId,
        invoiceId,
        appliedOutcome: 'SKIPPED_DUPLICATE_INVOICE',
        duplicateReason,
        // What the follow-up needs on a retry (see `finishEventFollowup`).
        paymentIntentId,
        unappliedCents: chargeCents,
        [FOLLOWUP_TRACKED_FIELD]: true,
      });
      if (paymentClaimRef) {
        // Claim the PaymentIntent even though nothing was applied. This
        // duplicate payment has its OWN sibling event coming, and without the
        // claim that sibling would arrive at this same branch and record the
        // charge a second time.
        tx.create(paymentClaimRef, {
          appliedEventId: event.id,
          appliedEventType: event.type,
          receivedAt: FieldValue.serverTimestamp(),
          familyId,
          invoiceId,
          appliedOutcome: 'DUPLICATE_INVOICE_CHECKOUT',
        });
      }
      tx.set(db().collection('payments').doc(event.id), {
        kinfolkId: familyId,
        invoiceId,
        amount: chargeCents > 0 ? chargeCents / 100 : null,
        amountCents: chargeCents > 0 ? chargeCents : null,
        amountResolved: chargeCents > 0,
        amountSource: chargeCents > 0 ? 'stripe-event' : 'unresolved',
        paymentMethod: 'stripe',
        referenceNumber,
        date: FieldValue.serverTimestamp(),
        stripeEventId: event.id,
        ...(feeResolved ? { feeCents } : {}),
        feeResolved,
        // What makes this row readable as what it is. The root `payments`
        // collection is a DISPLAY ledger counted in no settlement arithmetic
        // (`getInvoiceLedger` says so in as many words), so the row naming this
        // invoice cannot double-count it. The admin ledger shows it as "not
        // applied" (no `appliedInvoiceId`), which is exactly what it is.
        appliedToInvoice: false,
        appliedTo: 'unapplied',
        needsAdminDecision: true,
        creditedToAccountCents: 0,
        duplicateCheckoutReason: duplicateReason,
        // #2345: a payment held because the invoice could not take it is not a
        // duplicate of the last payment the invoice took.
        duplicateOfPaymentIntentId:
          heldAsDuplicate(duplicateReason) && typeof invoice?.[SETTLED_INTENT_FIELD] === 'string'
            ? invoice[SETTLED_INTENT_FIELD]
            : null,
        // #2345: the number of the invoice the checkout named, when it is not
        // one of this household's. The owner's list of payments waiting for a
        // decision looks numbers up among the household's own invoices, and
        // would otherwise have only the document id to show.
        ...(duplicateReason === 'invoice-other-household' && typeof invoiceDoc?.invoiceNumber === 'string'
          ? { invoiceNumber: invoiceDoc.invoiceNumber }
          : {}),
      });
      // The invoice records that it happened and nothing else: no money field,
      // no status, no state stamp. An admin looking at the bill can see the
      // second charge from here rather than having to find it in a collection.
      //
      // #2345: NOT when there is no invoice document (a merge would create a
      // stub invoice out of nothing), and NOT on another household's invoice:
      // the payment is held for the household on the checkout, the row above
      // carries that household, and the invoice is left exactly as stored.
      if (invoiceDoc !== null && duplicateReason !== 'invoice-other-household') {
        tx.set(
          ref,
          {
            duplicateCheckoutPaymentIntentIds: paymentIntentId
              ? FieldValue.arrayUnion(paymentIntentId)
              : FieldValue.arrayUnion(event.id),
            lastDuplicateCheckoutAt: FieldValue.serverTimestamp(),
            unappliedPaymentIds: FieldValue.arrayUnion(event.id),
          },
          { merge: true },
        );
      }
      return { proceed: false, reason: 'duplicate-invoice-checkout' as const };
    }

    // #2344: A DECLINE OVERTAKEN BY A PAYMENT. The invoice reads paid, or the
    // payment from this same checkout has landed. Telling the household their
    // charge failed would ask them to pay a bill they have paid. So: no notice,
    // one Activity Log line for the owner (after the commit), and NOTHING
    // written to the invoice, not even the order stamp. Ahead of the date
    // check on purpose: it holds whatever the decline's date.
    const overtaken = isFailedEvent
      ? declineAfterPayment(invoiceSnap.data() as Record<string, unknown> | undefined, declinedClaimSnap?.exists === true)
      : null;
    if (overtaken !== null) {
      declinedDetail = overtaken;
      tx.create(dedupeRef, {
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        familyId,
        invoiceId,
        appliedOutcome: DECLINED_AFTER_PAYMENT,
        [DECLINE_REASON_FIELD]: overtaken.reason,
        [DECLINE_INVOICE_NUMBER_FIELD]: overtaken.invoiceNumber,
        [FOLLOWUP_TRACKED_FIELD]: true,
        [NOTICE_SKIPPED_FIELD]: NOTICE_SKIPPED_AFTER_PAYMENT,
      });
      return { proceed: true, reason: 'declined-after-payment' as const };
    }

    if (isFailedEvent && eventCreatedMs > 0 && eventCreatedMs < lastEventMs) {
      // A FAILED charge dated before the last event applied to this invoice:
      // a late delivery of a decline the household has already got past.
      // Reserve the id and write nothing else, so they are not told of it now.
      //
      // FAILED EVENTS ONLY (#2344). A paid event is money already taken, and
      // is applied or held for the owner whatever its date.
      tx.create(dedupeRef, {
        type: event.type,
        receivedAt: FieldValue.serverTimestamp(),
        eventCreatedMs,
        familyId,
        invoiceId,
        appliedOutcome: SKIPPED_OUT_OF_ORDER,
      });
      return { proceed: false, reason: 'out-of-order' as const };
    }
    reserveEvent({
      type: event.type,
      receivedAt: FieldValue.serverTimestamp(),
      eventCreatedMs,
      familyId,
      invoiceId,
      appliedOutcome: isPaidEvent ? 'PAID' : 'FAILED',
      // #866: this event's audit entry and notice are tracked by the stamps
      // below, so a retry may finish them. Events recorded before this field
      // existed are never recovered (see FOLLOWUP_TRACKED_FIELD).
      [FOLLOWUP_TRACKED_FIELD]: true,
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
    // ── THE MONEY ─────────────────────────────────────────────────────────
    // The order stamp only ever moves forward (#2344): a paid event dated
    // before it is still applied, and must not wind it back for the failed
    // events that are measured against it.
    const patch: Record<string, unknown> =
      eventCreatedMs >= lastEventMs ? { lastStripeEventAtMs: eventCreatedMs, lastStripeEventId: event.id } : {};
    if (!isPaidEvent) {
      // A failed charge changes nothing the invoice's money or state reads.
      tx.set(ref, patch, { merge: true });
      return { proceed: true, reason: 'applied' as const };
    }
    // NOTE-57: THE AUTHORITATIVE AMOUNT is the one on the Stripe event
    // (`amount_paid` / `amount_received` / `amount_total`, integer cents,
    // computed once above the transaction). Only when the event carries none
    // is the invoice's own figure used, and only when neither yields a
    // positive amount is the row recorded with none, flagged
    // `amountResolved: false` and warned about. The fallback reads the stated
    // balance first: on a part-paid invoice that is what the card was charged.
    const invoiceForAmount = invoiceSnap.data() as { amountDue?: number; total?: number } | undefined;
    const eventAmount = eventAmountCents;
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
    // The event amount is already integer cents and passes through unchanged.
    // The local-invoice fallback is the flat doc's legacy dollar float and is
    // converted once, here, same as `recordPayment` does.
    const amountCents = cardChargeCents(eventAmount, invoiceSnap.data());
    // #2276: WHERE THE CARD MONEY LANDS ON THE INVOICE, decided from the
    // invoice and the payment rows this transaction read. Every other path
    // that puts money on an invoice reads and writes the same invoice doc in
    // its own transaction, so they commit one after the other and this
    // decision re-runs against whatever landed first. `lib/cardPaymentApply.ts`
    // has the three landings and why none of them refuses.
    const existingPayments = (subPaymentsSnap?.docs ?? []).map((d) => d.data() as PaymentAmount);
    // #2345: the decision the held check above already made, on the same reads.
    const landing = cardLanding ?? decideCardApply({
      invoiceId,
      doc: invoiceSnap.exists ? ((invoiceSnap.data() ?? {}) as InvoiceDoc) : null,
      existingPayments,
      cardCents: amountCents,
      kinfolkId: familyId,
    });
    cardFallbackReason = landing.kind === 'fallback' ? landing.reason : null;
    // The webhook's own bookkeeping on the invoice, written by every landing
    // in the same write as the money.
    //
    // The pending pair: a session that PAID is just as finished as one that
    // expired (the `checkout.session.expired` branch above). Not cleared on a
    // failed charge: a declined card does not close the Checkout Session.
    patch.pendingCheckoutSessionId = FieldValue.delete();
    patch.pendingAt = FieldValue.delete();
    // CLOSE THIS SETTLEMENT ROUND (issue #826), in the same write as the money.
    //
    //   the round     moves past every Checkout Session already minted for
    //                 this balance, so any of them that settles later arrives
    //                 STALE. `payInvoice` reads it back when it mints the
    //                 next one, so a bill whose balance genuinely comes back
    //                 (a line item added, a partial recorded elsewhere) can
    //                 still be paid a second time.
    //   the intent    names WHICH payment settled it, which is what lets the
    //                 next paid event tell "the other half of my own charge"
    //                 from "somebody else's charge on my bill" — and is the
    //                 only one of the two that works on a session minted
    //                 before this stamp existed.
    patch[CHECKOUT_ROUND_FIELD] = checkoutRoundOf(invoice?.[CHECKOUT_ROUND_FIELD]) + 1;
    if (paymentIntentId) patch[SETTLED_INTENT_FIELD] = paymentIntentId;
    const paymentRef = db().collection('payments').doc(event.id);
    const invoiceRowId = cardPaymentRowId(paymentIntentId, event.id);
    const rowExtras = {
      stripeEventId: event.id,
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    };
    // What the ledger row says about the invoice. Absent on a row with no
    // invoice row behind it (no amount, or no invoice document).
    let ledgerApply: Record<string, unknown> = {};
    const ledgerApplyOf = (appliedCents: number, tipCents: number, invoiceNumber: string) => ({
      // The same fields `recordPayment` writes for a payment it applied, so
      // the admin ledgers read a card payment as applied to its invoice.
      appliedInvoiceId: invoiceId,
      appliedInvoiceNumber: invoiceNumber,
      appliedCents,
      // GROSS, and only ever the part of the charge over the balance (ruling
      // 2026-09-27: an overpayment is all tip; the fee comes out of the tip).
      // `feeCents` sits beside it; the net is derived by the readers.
      tipCents,
      [TIP_BASIS_FIELD]: 'gross',
      unappliedCents: 0,
      // What the business receives. Absent while the fee is unresolved: a
      // figure here would claim Stripe charged nothing.
      ...(feeResolved && feeCents !== null ? { proceedsCents: appliedCents + tipCents - feeCents } : {}),
      creditedToAccountCents: 0,
      invoicePaymentId: invoiceRowId,
    });
    if (landing.kind === 'planned') {
      // THE ORDINARY LANDING: the row and the invoice update `recordPayment`'s
      // apply writes, from the same helper. The invoice's status, balance and
      // state stamp are derived from the sum of its payment rows.
      const staged = stageApply(db(), tx, {
        step: landing.step,
        sourcePaymentId: event.id,
        method: CARD_PAYMENT_METHOD,
        reference: referenceNumber,
        paidAtIso: new Date(eventCreatedMs > 0 ? eventCreatedMs : Date.now()).toISOString(),
        uid: CARD_PAYMENT_RECORDED_BY,
        // #866: this webhook sends the household's `invoice.payment.applied`
        // below, so it names itself as the sender in the write that pays the
        // bill, and `onInvoicesWrite` stands down for that write.
        noticeOwner: paymentAppliedOwner('stripe', event.id),
        paymentRowId: invoiceRowId,
        rowExtras,
        invoiceExtras: patch,
      });
      ledgerApply = {
        ...ledgerApplyOf(landing.appliedCents, landing.tipCents, staged.invoiceNumber),
        application: staged,
        settlesInvoice: staged.state === 'settled' || staged.state === 'overpaid',
      };
    } else {
      // THE FALLBACK AND THE NO-AMOUNT LANDINGS mark the invoice paid with
      // nothing owed, which is what this webhook did for every payment before
      // #2276: free-text `status` plus both balance fields (the portal renders
      // the stored status, the reminders cron reads `amountDue <= 0`, and
      // `payInvoice` and `getMyInvoices` prefer `amountDueCents`).
      //
      // #2345 (lead ruling 2026-11-17): every fallback reason but
      // `stated_balance_below_recorded_payments` is held above and never
      // reaches here, and that one always covers the stated balance. So no
      // new payment takes the short-card branch or sets the owner's line
      // below. They are kept as the guard under the hold (payment code is
      // never deleted). The line itself is still written on a retry of a
      // payment an earlier build applied this way (`notPayableDetailOf`).
      //
      // #2345: EXCEPT A FALLBACK CARD SHORT OF THE STATED BALANCE. It leaves
      // the rest owing, as the planned landing does: the balance fields carry
      // what is left, the label says part paid, and no paid stamp is written.
      // The status comes from the state stamp below, so a draft or a quote
      // keeps its lifecycle.
      const leftOwingCents = landing.kind === 'fallback' ? landing.leftOwingCents : 0;
      if (leftOwingCents > 0) {
        patch.paymentStatus = 'PARTIAL';
        patch.amountDueCents = leftOwingCents;
        patch.amountDue = centsToDollars(leftOwingCents);
      } else {
        patch.status = 'paid';
        patch.paymentStatus = 'PAID';
        patch.amountDue = 0;
        patch.amountDueCents = 0;
        patch.paidAt = FieldValue.serverTimestamp();
      }
      patch[PAYMENT_APPLIED_OWNER_FIELD] = paymentAppliedOwner('stripe', event.id);
      const paidCents =
        landing.kind === 'fallback' ? landing.paidCents : paidCentsFromPayments(existingPayments);
      if (landing.kind === 'fallback') {
        // On the invoice only when it is marked paid: the field is what keeps a
        // fallback invoice settled whatever its rows add up to
        // (`paidByCardFallback`), and one still owing is not settled.
        if (leftOwingCents === 0) patch[CARD_APPLY_FALLBACK_FIELD] = landing.reason;
        if (fallbackNeedsOwnerLine(landing.reason)) {
          const n = (invoiceSnap.data() as { invoiceNumber?: unknown } | undefined)?.invoiceNumber;
          notPayableDetail = {
            reason: landing.reason,
            invoiceNumber: typeof n === 'string' ? n : '',
            amountCents: amountCents ?? 0,
          };
        }
        if (landing.writeRow) {
          // The card money still goes on the invoice's own rows, so every sum
          // of them counts it.
          patch.paidCents = paidCents;
          patch.paymentMethod = CARD_PAYMENT_METHOD;
          patch.paymentReference = referenceNumber;
          patch.lastPaymentAt = FieldValue.serverTimestamp();
          tx.set(ref.collection('payments').doc(invoiceRowId), {
            amount: centsToDollars(landing.appliedCents),
            amountCents: landing.appliedCents,
            method: CARD_PAYMENT_METHOD,
            reference: referenceNumber,
            paidAt: new Date(eventCreatedMs > 0 ? eventCreatedMs : Date.now()).toISOString(),
            recordedBy: CARD_PAYMENT_RECORDED_BY,
            sourcePaymentId: event.id,
            createdAt: FieldValue.serverTimestamp(),
            ...rowExtras,
          });
          const invoiceNumber = (invoiceSnap.data() as { invoiceNumber?: unknown } | undefined)?.invoiceNumber;
          ledgerApply = {
            ...ledgerApplyOf(
              landing.appliedCents,
              landing.tipCents,
              typeof invoiceNumber === 'string' ? invoiceNumber : '',
            ),
            settlesInvoice: leftOwingCents === 0,
            [CARD_APPLY_FALLBACK_FIELD]: landing.reason,
          };
        } else {
          ledgerApply = { [CARD_APPLY_FALLBACK_FIELD]: landing.reason };
        }
      }
      // The state stamp (ADR-0002), in the same transactional write as the
      // flip it describes, from the doc as this write leaves it. The sentinels
      // on the pending pair never reach the classifier: it reads
      // `status`/`amountDue`/`total`/`creditRedeemedAt`.
      const stampable = { ...patch };
      delete stampable.pendingCheckoutSessionId;
      delete stampable.pendingAt;
      //
      // A fallback invoice is stamped as paid in full, so it freezes like any
      // other paid invoice. Stamped from its rows it would read paid and part
      // paid, which stays editable, and an edit works the balance out from the
      // rows and would bring back money the household was never shown.
      const stampDoc = { ...(invoiceSnap.data() ?? {}), ...stampable };
      // #2345: one still owing is stamped from its rows, like any part-paid bill.
      const stampPaidCents =
        landing.kind === 'fallback' && leftOwingCents === 0
          ? Math.max(paidCents, invoiceTotalCentsOf(stampDoc))
          : paidCents;
      Object.assign(patch, invoiceStateStampOf(stampDoc, stampPaidCents));
      tx.set(ref, patch, { merge: true });
    }
    // The flat `payments/{eventId}` ledger row, keyed by the event id so a
    // Stripe retry cannot duplicate it. `amount` keeps the unit `amountSource`
    // names (cents off a Stripe event); `amountCents` is what every sum reads.
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
      // `getInvoiceLedger` already renders. Present ONLY when resolved: the
      // Admin SDK rejects a literal `undefined`, and an absent field reads
      // correctly as "unknown", never as zero.
      ...(feeResolved ? { feeCents } : {}),
      feeResolved,
      ...ledgerApply,
    });
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

  if (recoveredSkip) {
    // #2344: money that was charged and not recorded has now been decided.
    // Loud, so the owner's check of the invoices it happened to has a trace.
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.outOfOrder.recovered',
      extra: { invoiceId, familyId, eventId: event.id, type: event.type, paymentIntentId, reason: decision.reason },
    });
  }

  if (decision.proceed && cardFallbackReason !== null) {
    // #2276: the payment is recorded and the invoice reads paid, but not
    // through the ordinary plan. Named here so the owner's report
    // (`scripts/backfillCardInvoicePayments.ts`) is not the only trace.
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.cardApply.fallback',
      extra: { invoiceId, familyId, eventId: event.id, type: event.type, reason: cardFallbackReason },
    });
  }
  // Gated on `decision.proceed`: a replay or out-of-order skip wrote nothing,
  // so an unresolved fee on THAT attempt is not news — only warn when a
  // payment doc actually landed without one. #2370: a payment held for the
  // owner lands one too, with no fee on it, and is warned about the same way.
  if (isPaidEvent && (decision.proceed || decision.reason === 'duplicate-invoice-checkout') && !feeResolved) {
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.fee.unresolved',
      extra: { invoiceId, familyId, eventId: event.id, type: event.type },
    });
  }

  if (decision.reason === 'duplicate-invoice-checkout') {
    // A CARD CHARGE THE INVOICE WAS NOT OWED. Loud, and at `error`: real money
    // arrived that nobody meant to send, no refund is possible, and nothing
    // has been done with it yet. The admin decides (docket Q5).
    const unappliedDetail: UnappliedDetail = {
      paymentIntentId,
      duplicateReason,
      unappliedCents,
    };
    logEvent({
      severity: 'error',
      function: 'stripeWebhook',
      event: 'stripe.invoice.duplicateCheckout',
      extra: {
        invoiceId,
        familyId,
        eventId: event.id,
        type: event.type,
        paymentIntentId,
        duplicateReason,
        eventRound,
        unappliedCents,
        creditedCents: 0,
      },
    });
    // The audit entry and the admin notice, tracked by the same stamps as a
    // paid event: a throw answers 500, Stripe retries, and the replay branch
    // below finishes whichever step is not stamped done.
    try {
      await finishEventFollowup({
        kind: 'unapplied',
        familyId,
        invoiceId,
        eventId: event.id,
        auditDone: false,
        noticeDone: false,
        unapplied: unappliedDetail,
      });
    } catch (err) {
      logEvent({
        severity: 'error',
        function: 'stripeWebhook',
        event: 'stripe.followup.failed',
        extra: { kind: 'unapplied', familyId, invoiceId, eventId: event.id, err: (err as Error)?.message },
      });
      res.status(500).json({ error: 'followup-pending' });
      return;
    }
    res.status(200).json({ ok: true, dedup: true, reason: decision.reason });
    return;
  }

  // #866: A RETRY OF AN EVENT WHOSE FOLLOW-UP NEVER FINISHED. The money (or the
  // failed-charge record) committed on an earlier delivery; its audit entry or
  // its notice did not (a throw or a crash between the commit and the stamps).
  // Only an event this code recorded, `followupTracked`, is ever finished here:
  // one recorded before it has no stamps and was followed up in full at the
  // time. Stripe retries for up to three days, so the stamps are what stop a
  // repeat, not the dispatcher's default window; the audit entry's
  // deterministic id and the notice's ledger identity cover a step that
  // committed without its stamp.
  const storedKind: FollowupKind | null =
    decision.reason !== 'replay' || !decision.followupTracked || (decision.auditDone && decision.noticeDone)
      ? null
      : isPaidEvent && decision.appliedOutcome === 'PAID'
        ? 'paid'
        : isFailedEvent && decision.appliedOutcome === 'FAILED'
          ? 'failed'
          : isFailedEvent && decision.appliedOutcome === DECLINED_AFTER_PAYMENT
            ? 'declinedAfterPayment'
            : isPaidEvent && decision.appliedOutcome === 'SKIPPED_DUPLICATE_INVOICE'
              ? 'unapplied'
              : null;
  let recoverKind = storedKind;
  let recoverDeclined: DeclineAfterPaymentDetail | null =
    decision.reason === 'replay' && storedKind === 'declinedAfterPayment' ? decision.declined : null;
  // Whether the audit entry of the kind being finished is written. A decline
  // that changes kind below owes the new kind's line whatever the old one did.
  let recoverAuditDone = decision.reason === 'replay' ? decision.auditDone : false;
  if (decision.reason === 'replay' && storedKind === 'failed' && !decision.noticeDone) {
    // #2344: A DECLINE WHOSE NOTICE NEVER WENT OUT, RETRIED AFTER THE INVOICE
    // WAS PAID. The first delivery recorded the decline and its notice threw;
    // a payment has landed since. Sending `invoice.charge.failed` now would
    // tell a household that has paid to pay. The invoice is read as it stands
    // (the event's own transaction returned before reading it): overtaken, the
    // notice is closed as skipped and the owner gets the line instead. A read
    // that throws answers 500 below, and Stripe tries again.
    try {
      const [invoiceNow, claimNow] = await Promise.all([
        ref.get(),
        declinedClaimRef ? declinedClaimRef.get() : Promise.resolve(null),
      ]);
      const overtakenNow = declineAfterPayment(
        invoiceNow.data() as Record<string, unknown> | undefined,
        claimNow?.exists === true,
      );
      if (overtakenNow !== null) {
        recoverKind = 'declinedAfterPayment';
        recoverDeclined = overtakenNow;
        recoverAuditDone = false;
      }
    } catch (err) {
      logEvent({
        severity: 'error',
        function: 'stripeWebhook',
        event: 'stripe.followup.failed',
        extra: { kind: 'failed', familyId, invoiceId, eventId: event.id, replay: true, err: (err as Error)?.message },
      });
      res.status(500).json({ error: 'followup-pending' });
      return;
    }
  }
  if (recoverKind !== null && decision.reason === 'replay') {
    try {
      // #2345: a paid line not yet written finds out from the event's own
      // ledger row whether it is the ordinary line or the not-payable one.
      const recoverNotPayable =
        recoverKind === 'paid' && !recoverAuditDone
          ? notPayableDetailOf(
              (await db().collection('payments').doc(event.id).get()).data() as Record<string, unknown> | undefined,
            )
          : null;
      await finishEventFollowup({
        kind: recoverKind,
        familyId,
        invoiceId,
        eventId: event.id,
        auditDone: recoverAuditDone,
        noticeDone: decision.noticeDone,
        ...(recoverKind === 'unapplied' ? { unapplied: decision.unapplied } : {}),
        ...(recoverKind === 'declinedAfterPayment' && recoverDeclined ? { declined: recoverDeclined } : {}),
        notPayable: recoverNotPayable,
        paidByUid: metadata?.uid ?? null,
      });
    } catch (err) {
      logEvent({
        severity: 'error',
        function: 'stripeWebhook',
        event: 'stripe.followup.failed',
        extra: { kind: recoverKind, familyId, invoiceId, eventId: event.id, replay: true, err: (err as Error)?.message },
      });
      res.status(500).json({ error: 'followup-pending' });
      return;
    }
    logEvent({
      severity: 'warn',
      function: 'stripeWebhook',
      event: 'stripe.followup.recovered',
      extra: {
        kind: recoverKind,
        familyId,
        invoiceId,
        eventId: event.id,
        auditDone: decision.auditDone,
        noticeDone: decision.noticeDone,
      },
    });
    res.status(200).json({ ok: true, dedup: true, reason: decision.reason, recovered: true });
    return;
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

  // #866: THE AUDIT AND THE NOTICE MUST SURVIVE A CRASH AFTER THE COMMIT. For a
  // paid event the invoice write above stamped this webhook as the notice's only
  // sender, so `onInvoicesWrite` no longer backstops it. Any failure from here on
  // answers 500, Stripe retries, and the retry's replay branch (above) finishes
  // whichever of the two steps `stripeEvents/{id}` does not record as done.
  //
  // THE SAME FOLLOW-UP FOR BOTH OUTCOMES. A failed charge's audit entry and
  // `invoice.charge.failed` ran after the commit with no guard, so a throw drew a
  // Stripe retry that stopped at the replay check and lost the notice for good.
  // Now either outcome answers 500 until its follow-up is stamped done.
  const overtakenDecline: DeclineAfterPaymentDetail | null =
    // The cast undoes TypeScript's narrowing: the value is set inside the
    // transaction callback, which the compiler does not follow.
    decision.reason === 'declined-after-payment' ? (declinedDetail as DeclineAfterPaymentDetail | null) : null;
  const followupKind: FollowupKind = isPaidEvent ? 'paid' : overtakenDecline !== null ? 'declinedAfterPayment' : 'failed';
  if (overtakenDecline !== null) {
    logEvent({
      severity: 'info',
      function: 'stripeWebhook',
      event: 'stripe.decline.afterPayment',
      extra: { invoiceId, familyId, eventId: event.id, type: event.type, reason: overtakenDecline.reason },
    });
  }
  try {
    await finishEventFollowup({
      kind: followupKind,
      familyId,
      invoiceId,
      eventId: event.id,
      auditDone: false,
      // The decline's event record already says its notice is skipped.
      noticeDone: overtakenDecline !== null,
      ...(overtakenDecline !== null ? { declined: overtakenDecline } : {}),
      // The cast undoes the same narrowing as `declinedDetail` above.
      notPayable: notPayableDetail as NotPayableDetail | null,
      paidByUid: metadata?.uid ?? null,
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'stripeWebhook',
      event: 'stripe.followup.failed',
      extra: { kind: followupKind, familyId, invoiceId, eventId: event.id, err: (err as Error)?.message },
    });
    res.status(500).json({ error: 'followup-pending' });
    return;
  }
  res.status(200).json({ ok: true });
}

export const stripeWebhook = onRequest(
  // Stripe retries on any non-2xx, so shedding here turns into repeated
  // delivery of payment events. A full vCPU keeps 80-way concurrency.
  {
    region: 'us-central1',
    // AUNTIE_OPERATOR_UIDS is the self-heal fallback in `lib/businessAdmins.ts`
    // when `businessSettings/admins.uids` is empty. It is a Secret Manager
    // value, so a function that does not BIND it sees `undefined` and the
    // roster read throws instead. Every business-stream notification this
    // function emits depends on that roster: the new `invoice.payment.disputed`
    // (whose only resolver is `businessAdmins` — no roster, no operator ping at
    // all) and the business copies of `invoice.payment.applied` and
    // `invoice.charge.failed`, which have quietly been resolving to nobody on
    // this function for want of this one line.
    secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    ...FULL_CPU,
  },
  wrapHttp('stripeWebhook', stripeWebhookHandler),
);
