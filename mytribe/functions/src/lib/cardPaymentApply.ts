/**
 * #2276: WHERE A CARD PAYMENT LANDS ON ITS INVOICE. Pure: no Firestore, no
 * Stripe. `billing/stripeWebhook.ts` reads the invoice and its payment rows in
 * its transaction and asks this; the backfill script
 * (`mytribe/scripts/backfillCardInvoicePayments.ts`) uses the same row id.
 *
 * THE DEFECT. The webhook marked the invoice paid with nothing owed and kept
 * the card money in the root `payments` ledger only. The invoice's own
 * `payments` rows are what every other money path sums (`markInvoicePaid`,
 * `recordPayment`'s apply, `updateInvoice`, the repair pass), so an invoice
 * part paid by hand and then paid off by card had rows adding up to less than
 * its total while it read paid. `recordPayment` and `markInvoicePaid` then
 * accepted the card-paid part a second time, the repair pass would reopen it,
 * and an edit recomputed the balance without the card money.
 *
 * THE FIX. A card payment writes one `invoices/{id}/payments` row, in the same
 * transaction as the invoice update, through the same `planApply`/`stageApply`
 * every admin payment uses. The row's id is made from the card payment itself
 * (`cardPaymentRowId`), so the two events one charge delivers, and any retry,
 * can write it once only.
 *
 * WHAT IS APPLIED. The card is already charged when the webhook hears of it,
 * and there are no refunds, so nothing here refuses. The applied part stops at
 * what the invoice's payment rows leave owing; anything over that is tip
 * (operator ruling 2026-09-27: an overpayment is all tip, and the processor
 * fee comes out of the tip). The tip is stored gross with the fee beside it.
 * Account credit is never given here.
 *
 * THREE LANDINGS:
 *
 *   planned    the ordinary one. `planApply` accepted it; `stageApply` writes
 *              the row and derives the invoice from the sum of its rows. It
 *              settles, or, when the card was less than both what the rows
 *              leave owing and the balance the invoice states, it leaves the
 *              rest owing.
 *   fallback   the plan cannot describe this invoice, or would leave owing an
 *              invoice whose household paid everything it was shown.
 *              `payInvoice` charges the STATED balance. When that is lower than
 *              what the rows leave (an earlier card payment from before this
 *              fix has no row, or a migrated part payment never had one), a
 *              plan would reopen the invoice for money the household was never
 *              asked for. So the invoice is marked paid as it always was, the
 *              card row is still written, and the reason is stamped on the
 *              invoice and the ledger row and logged, for the backfill report.
 *              #2345: a card that paid less than the stated balance does not
 *              mark the invoice paid on this landing either: the rest stays
 *              owing, as on the planned one. And for every reason but
 *              `STATED_BELOW_RECORDED` (nothing is wrong there) the owner gets
 *              an Activity Log line saying the invoice was not in a state to
 *              take the payment (`fallbackNeedsOwnerLine`). Since the lead
 *              ruling of 2026-11-17 the webhook HOLDS every such payment for
 *              the owner instead (`cardHoldReason`, below), so only
 *              `STATED_BELOW_RECORDED` is applied on this landing.
 *   no-amount  neither Stripe nor the invoice gave a figure. No row: a row
 *              with no amount is not a payment. The invoice is marked paid and
 *              the ledger row is flagged, as before. Only an invoice with
 *              something owed on its total gets here: `cardHoldReason` holds
 *              the rest, figure or no figure.
 */
import type { InvoiceDoc } from '../admin/markInvoicePaid';
import { amountDueCentsOf } from './amountDueRule';
import { heldReasonForCardFallback, type DuplicateCheckoutReason } from './invoiceCheckoutDedupe';
import { invoiceStateOf } from './invoiceEditPolicy';
import { invoiceTotalCentsOf, paidCentsFromPayments, settleInvoice, type PaymentAmount } from './invoiceMath';
import { planApply, type ApplyStep } from './paymentApply';

/** The `method` on a card payment's invoice row. The root ledger row has always said the same. */
export const CARD_PAYMENT_METHOD = 'stripe';

/**
 * `recordedBy` / `paidBy` for a payment no admin recorded. Not a uid: the
 * clients resolve these against staff accounts and show nothing for one that
 * matches none.
 */
export const CARD_PAYMENT_RECORDED_BY = 'system:stripe';

/** Stamped on the invoice and the ledger row when the fallback landing was used. Defined beside the paid rule that reads it. */
export { CARD_APPLY_FALLBACK_FIELD } from './invoicePaidGate';

/**
 * #2344. `appliedOutcome` on `stripeEvents/{id}` for an event skipped as older
 * than the last one applied to its invoice. The webhook now writes it for a
 * FAILED charge only (`billing/stripeDispute.ts` writes the same word for its
 * own two lanes). A record carrying it with one of `PAID_EVENT_TYPES` is from
 * before #2344: a card payment that was charged and written nowhere. The
 * webhook decides such an event afresh when Stripe sends it again, and
 * `scripts/backfillCardInvoicePayments.ts` lists them.
 */
export const SKIPPED_OUT_OF_ORDER = 'SKIPPED_OUT_OF_ORDER';

/** Stamped on the event record when a paid event skipped before #2344 is decided on a later delivery. */
export const RECOVERED_FROM_FIELD = 'recoveredFromOutcome';

/** The Stripe event types that mean money was collected. */
export const PAID_EVENT_TYPES: readonly string[] = [
  'invoice.paid',
  'payment_intent.succeeded',
  'checkout.session.completed',
];

/** The fallback reason for a stated balance lower than the payment rows leave owing. */
export const STATED_BELOW_RECORDED = 'stated_balance_below_recorded_payments';
/**
 * #2345: whether the owner is told about a card payment that took the fallback
 * landing. Every reason means the invoice was not in a state to be paid,
 * except `STATED_BELOW_RECORDED`: an invoice brought over part paid and then
 * paid off by card, where nothing is wrong and nothing needs saying.
 */
export function fallbackNeedsOwnerLine(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason !== '' && reason !== STATED_BELOW_RECORDED;
}

/**
 * The id of a card payment's `invoices/{id}/payments` row. One PaymentIntent
 * is one charge, so it is the key; the event id stands in only when Stripe
 * named no PaymentIntent, and then that event's own dedupe record is what
 * keeps the row single.
 */
export function cardPaymentRowId(paymentIntentId: string | null, eventId: string): string {
  return `stripe_${paymentIntentId !== null && paymentIntentId !== '' ? paymentIntentId : eventId}`;
}

export type CardApplyDecision =
  | {
      kind: 'planned';
      step: ApplyStep;
      appliedCents: number;
      /** GROSS. What the card paid over the balance. */
      tipCents: number;
    }
  | {
      kind: 'fallback';
      reason: string;
      /** False only when there is no invoice document to hang a row on. */
      writeRow: boolean;
      appliedCents: number;
      tipCents: number;
      /** The invoice's rows after this one, for the invoice's `paidCents` and its state stamp. */
      paidCents: number;
      /**
       * #2345: what the stated balance still asks for after this card. 0 when
       * the card covered it (or the invoice stated none), and only then is the
       * invoice marked paid.
       */
      leftOwingCents: number;
    }
  | { kind: 'no-amount' };

export function decideCardApply(input: {
  invoiceId: string;
  /** Null when the invoice document does not exist. */
  doc: InvoiceDoc | null;
  existingPayments: readonly PaymentAmount[];
  /** What the card was charged, in cents. Null when nothing resolved one. */
  cardCents: number | null;
  /** The household on the checkout. */
  kinfolkId: string;
}): CardApplyDecision {
  const { doc, existingPayments } = input;
  const cardCents = input.cardCents;
  if (cardCents === null || !Number.isFinite(cardCents) || cardCents <= 0) return { kind: 'no-amount' };

  const existingPaidCents = paidCentsFromPayments(existingPayments);
  if (doc === null) {
    return {
      kind: 'fallback',
      reason: 'apply_invoice_not_found',
      writeRow: false,
      appliedCents: 0,
      tipCents: 0,
      paidCents: existingPaidCents,
      leftOwingCents: 0,
    };
  }

  // What the payment rows leave owing: the figure every admin payment settles
  // against. And what the invoice states it is owed: the figure `payInvoice`
  // charged (`amountDueCentsOf` is the rule it reads the balance by).
  const recordedDueCents = settleInvoice(invoiceTotalCentsOf(doc), existingPaidCents).amountDueCents;
  const statedDueCents = Math.max(0, amountDueCentsOf(doc, existingPaidCents));

  const fallback = (reason: string): CardApplyDecision => {
    // The stated balance is all there is to measure against here. What the
    // card paid over it is tip; with no stated balance it all goes on the bill.
    // #2345: a card short of the stated balance leaves the rest owing.
    const appliedCents = statedDueCents > 0 ? Math.min(cardCents, statedDueCents) : cardCents;
    return {
      kind: 'fallback',
      reason,
      writeRow: true,
      appliedCents,
      tipCents: cardCents - appliedCents,
      paidCents: existingPaidCents + appliedCents,
      leftOwingCents: statedDueCents > 0 ? statedDueCents - appliedCents : 0,
    };
  };

  if (recordedDueCents <= 0) return fallback('no_recorded_balance');

  const appliedCents = Math.min(cardCents, recordedDueCents);
  const plan = planApply({
    invoice: { invoiceId: input.invoiceId, doc, existingPayments },
    appliedCents,
    kinfolkId: input.kinfolkId,
    // The whole charge. The tip is what is left of it after the apply, so it
    // is never set aside first.
    spendableCents: cardCents,
  });
  if (!plan.ok) return fallback(plan.refusal.code);

  const settles = plan.step.after.state === 'settled' || plan.step.after.state === 'overpaid';
  if (!settles && cardCents >= statedDueCents) {
    // The household paid everything the invoice said it owed, and the rows
    // say more is owed than that. Paid, as shown; never reopened from here.
    return {
      kind: 'fallback',
      reason: STATED_BELOW_RECORDED,
      writeRow: true,
      appliedCents: cardCents,
      tipCents: 0,
      paidCents: existingPaidCents + cardCents,
      leftOwingCents: 0,
    };
  }
  return { kind: 'planned', step: plan.step, appliedCents, tipCents: cardCents - appliedCents };
}

/**
 * #2345 (lead ruling 2026-11-17): WHY A CARD PAYMENT IS HELD FOR THE OWNER AND
 * NOT APPLIED, or null when it is applied. Pure. The card is already charged
 * and there are no refunds, so a payment the invoice cannot take is recorded
 * whole as an unapplied payment (the gross charge with the fee beside it),
 * nothing goes on the invoice, no credit is given, and the household is sent
 * nothing. The owner decides what it becomes (`resolveUnappliedPayment`), as
 * for a second charge on a paid invoice (docket Q5) or one on a cancelled
 * invoice (#2358).
 *
 * ASKED IN THIS ORDER, so the owner is given the reason that matters:
 *
 *   1. the invoice does not exist. Nothing to compare the payment against.
 *   2. the invoice is another household's (`planApply`'s rule: both name a
 *      household and they differ). Asked ahead of everything the invoice says
 *      about itself: the payment is held for the household on the checkout,
 *      and that invoice is not written at all.
 *   3. cancelled or written off (`duplicateCheckoutReason`'s own first two).
 *   4. a draft or a quote: not a bill yet. A credit, by its label or by a
 *      negative balance or total (`invoiceStateOf`): money owed TO the
 *      household. Ahead of the paid checks, which read a credit's balance as
 *      "nothing owed" and would say it had already been paid.
 *   5. the rest of `duplicateCheckoutReason`: a closed round, or nothing owed.
 *   6. what the landing could not describe (`heldReasonForCardFallback`):
 *      nothing owed on the invoice's total.
 *
 * None of 1 to 4 reads the amount, so a payment Stripe gave no figure for is
 * held on those invoices too. So is one on an invoice with nothing owed on its
 * total (6), which is asked without the landing when there is no figure.
 */
export function cardHoldReason(input: {
  /** Null when the invoice document does not exist. */
  doc: InvoiceDoc | null;
  existingPayments: readonly PaymentAmount[];
  /** The household on the checkout. */
  kinfolkId: string;
  /** `duplicateCheckoutReason`'s answer for this event. */
  duplicate: DuplicateCheckoutReason;
  /** `decideCardApply`'s answer for this event. */
  landing: CardApplyDecision | null;
}): DuplicateCheckoutReason {
  const { doc } = input;
  if (doc === null) return 'invoice-not-found';
  if (invoiceOfAnotherHousehold(doc, input.kinfolkId)) return 'invoice-other-household';
  if (input.duplicate === 'invoice-cancelled' || input.duplicate === 'invoice-written-off') return input.duplicate;
  const paidCents = paidCentsFromPayments(input.existingPayments);
  const state = invoiceStateOf(doc, paidCents);
  if (state === 'draft' || state === 'quote') return 'invoice-not-sent';
  if (state === 'credit' || state === 'redeemed') return 'invoice-credit';
  if (input.duplicate !== null) return input.duplicate;
  if (input.landing?.kind === 'fallback') return heldReasonForCardFallback(input.landing.reason);
  // A payment with no figure has no landing to read, so the total is asked
  // here by the fallback's own rule (`no_recorded_balance`): nothing owed on
  // it is held with or without an amount.
  if (input.landing?.kind === 'no-amount' && settleInvoice(invoiceTotalCentsOf(doc), paidCents).amountDueCents <= 0) {
    return 'invoice-no-balance';
  }
  return null;
}

/**
 * Whether the invoice is another household's than the one on the checkout:
 * both name a household and they differ (`planApply`'s rule). One that names
 * none, on either side, is not another household's. Read by the held check
 * above and by the webhook's decline check, so the two cannot disagree.
 */
export function invoiceOfAnotherHousehold(
  doc: { kinfolkId?: unknown } | null | undefined,
  checkoutKinfolkId: string,
): boolean {
  const invoiceKin = typeof doc?.kinfolkId === 'string' ? doc.kinfolkId : '';
  return checkoutKinfolkId !== '' && invoiceKin !== '' && invoiceKin !== checkoutKinfolkId;
}

/**
 * The held reasons that are `duplicateCheckoutReason`'s own: a second attempt
 * at a payment the invoice already took, or one on a cancelled or written-off
 * invoice. Only these name the payment that settled the invoice on the held
 * row (`duplicateOfPaymentIntentId`); the others are not a duplicate of it.
 */
export function heldAsDuplicate(reason: DuplicateCheckoutReason): boolean {
  return (
    reason === 'stale-round' ||
    reason === 'settled-by-other-intent' ||
    reason === 'invoice-not-owed' ||
    reason === 'invoice-marked-paid' ||
    reason === 'invoice-cancelled' ||
    reason === 'invoice-written-off'
  );
}
