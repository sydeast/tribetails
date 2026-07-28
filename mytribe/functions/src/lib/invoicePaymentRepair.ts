/**
 * Finds, and repairs, invoices wrecked by the pre-2026-07-25 partial-payment
 * write. PURE LOGIC ONLY: nothing here reads or writes Firestore. The callable
 * (`admin/repairInvoicePayments.ts`) does the I/O and hands each candidate to
 * these functions, so the entire decision, "is this doc corrupt, and what should
 * it read instead", is unit-testable against fixtures rather than against a live
 * collection.
 *
 * THE DAMAGE. `markInvoicePaid` used to write
 *
 *     { status: 'paid', amountDue: 0 }
 *
 * unconditionally, with no reference to how much had been collected. So a $20
 * payment against a $40 invoice produced a doc that READS settled while its own
 * `payments` subcollection records only half the money. The invoice left
 * Outstanding, nobody chased the rest, and the callable then refused the second
 * payment because the doc said paid. The $20 was not lost from the record, it is
 * still in the subcollection; what was lost is the invoice's knowledge that it
 * is owed.
 *
 * WHICH MEANS THE SUBCOLLECTION IS THE REPAIR SOURCE. The balance is
 * reconstructed as total minus the sum of the recorded payments, exactly as the
 * fixed callable now computes it. Nothing is invented and no money is assumed.
 *
 * TWO PROPERTIES THIS MODULE GUARANTEES, both tested:
 *
 *   IDEMPOTENT. A repaired doc no longer matches the corrupt shape, because its
 *   `amountDue` now agrees with the subcollection. Running the pass twice
 *   changes nothing the second time, and a healthy invoice is never a candidate
 *   in the first place. The pass is safe to run repeatedly, which matters
 *   because an operator running it against production will run it more than
 *   once.
 *
 *   IT NEVER LOWERS A BALANCE. `repairPlanFor` returns null unless the
 *   reconstructed balance is strictly GREATER than what the doc currently
 *   claims. This is the guard that makes the pass safe to point at a collection
 *   nobody has audited: the worst it can do is fail to fix something. It can
 *   never reduce what a household owes, never turn a real balance into zero, and
 *   never convert an invoice into a credit. If the arithmetic ever disagrees
 *   with the doc in the other direction, that is a different problem and this
 *   pass declines to touch it rather than guessing.
 */
import {
  paidCentsFromPayments,
  invoiceTotalCentsOf,
  settleInvoice,
  centsToDollars,
  type PaymentAmount,
} from './invoiceMath';
import { invoiceStateStampOf } from './invoiceStateStamp';

/** The fields the detector reads off a raw `invoices/{id}` doc. All optional: real docs are missing keys. */
export interface RepairInvoiceDoc {
  status?: unknown;
  paymentStatus?: unknown;
  amountDue?: unknown;
  amountDueCents?: unknown;
  total?: unknown;
  totalCents?: unknown;
  invoiceNumber?: unknown;
  kinfolkId?: unknown;
}

/** Why a scanned invoice was left alone. Reported, so a detect run is never a silent "nothing here". */
export type RepairSkipReason =
  | 'no_payments'
  | 'payments_cover_total'
  | 'no_total'
  | 'balance_already_correct'
  | 'would_lower_balance';

export interface RepairFinding {
  invoiceId: string;
  invoiceNumber: string | null;
  kinfolkId: string | null;
  totalCents: number;
  /** Summed from the `payments` subcollection. */
  paidCents: number;
  /** What the doc currently claims is owed, in cents. */
  claimedAmountDueCents: number;
  /** What the recorded payments say is owed. */
  correctAmountDueCents: number;
  /** correctAmountDueCents - claimedAmountDueCents. Always positive on a finding. */
  understatedCents: number;
  /** The doc's current status, verbatim. */
  status: string;
}

export interface RepairPlan {
  finding: RepairFinding;
  /** The exact field/value set to merge onto the invoice doc. */
  update: Record<string, unknown>;
}

/** A non-numeric or non-finite money field reads as "no evidence" (0), never as NaN. */
function money(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * What the doc CURRENTLY claims is still owed, in cents.
 *
 * Prefers the integer `amountDueCents` when present and falls back to rounding
 * the float dollar `amountDue`, matching how every reader of these docs resolves
 * the same question. A corrupt doc claims 0 here while its payments say
 * otherwise, which is precisely the disagreement the detector looks for.
 */
export function claimedAmountDueCentsOf(doc: RepairInvoiceDoc): number {
  if (typeof doc.amountDueCents === 'number' && Number.isInteger(doc.amountDueCents)) {
    return doc.amountDueCents;
  }
  return Math.round(money(doc.amountDue) * 100);
}

/**
 * The repair for one invoice, or a reason it was skipped.
 *
 * DETECTION IS BY ARITHMETIC, NOT BY LABEL. It deliberately does NOT require
 * `status === 'paid'`. Status casing is unenforced across this collection (a doc
 * may read `Paid`, `PAID` or carry no status at all), and `paymentStatus` is a
 * second, independently-written spelling of the same claim. Matching on either
 * would silently skip real casualties. The condition that actually matters is
 * the disagreement itself: money is recorded against this invoice, it does not
 * cover the total, and the doc nonetheless claims less is owed than the payments
 * say. Every doc in the reported corrupt shape satisfies that, and so does one
 * whose status was later hand-edited.
 */
export function repairPlanFor(
  invoiceId: string,
  doc: RepairInvoiceDoc,
  payments: readonly PaymentAmount[],
): RepairPlan | { skipped: RepairSkipReason } {
  // No money recorded means nothing to reconstruct FROM. An invoice reading paid
  // with an empty subcollection is the Stripe path (`stripeWebhook.ts` records
  // into the ROOT `payments` collection, not this one) or a hand-flipped status,
  // and re-opening it would invent a debt the household may not owe. Left alone,
  // deliberately.
  if (payments.length === 0) return { skipped: 'no_payments' };

  const paidCents = paidCentsFromPayments(payments);
  if (paidCents <= 0) return { skipped: 'no_payments' };

  const totalCents = invoiceTotalCentsOf(doc);
  // Without a total there is nothing to measure the payments against. Reporting
  // it rather than assuming a total keeps the pass from fabricating a balance.
  if (totalCents <= 0) return { skipped: 'no_total' };

  const settlement = settleInvoice(totalCents, paidCents);
  if (settlement.state === 'settled' || settlement.state === 'overpaid') {
    // Genuinely paid off. Reading `paid` is correct.
    return { skipped: 'payments_cover_total' };
  }

  const claimedAmountDueCents = claimedAmountDueCentsOf(doc);
  const correctAmountDueCents = settlement.amountDueCents;

  if (claimedAmountDueCents === correctAmountDueCents) {
    // Already agrees with the payments. This is what a repaired doc looks like
    // on the second run, and it is why the pass is idempotent.
    return { skipped: 'balance_already_correct' };
  }
  // THE NEVER-LOWER GUARD. Only an UNDERSTATED balance is repaired here.
  if (correctAmountDueCents < claimedAmountDueCents) {
    return { skipped: 'would_lower_balance' };
  }

  const status = typeof doc.status === 'string' ? doc.status : '';

  const update: Record<string, unknown> = {
    // Back to open, with a real balance, so it returns to Outstanding and
    // someone chases the rest.
    status: 'open',
    paymentStatus: 'PARTIAL',
    totalCents: settlement.totalCents,
    paidCents: settlement.paidCents,
    amountDueCents: settlement.amountDueCents,
    overpaidCents: 0,
    amountDue: centsToDollars(settlement.amountDueCents),
    // `paidAt`/`paidBy` are deliberately NOT cleared. They record that someone
    // pressed Mark paid at a particular moment, which did happen; the claim
    // that was false was the balance, and that is what this rewrites. Deleting
    // a true historical stamp to tidy up a false derived one would destroy
    // evidence of how the invoice got into this state.
    partialPaymentRepairedAt: new Date().toISOString(),
  };
  // The state stamp (ADR-0002), part of the same repair update. Every plan
  // this function returns is by construction a part-paid open invoice, so the
  // stamp reads open/all; derived through the shared helper anyway so the two
  // can never drift.
  Object.assign(update, invoiceStateStampOf({ ...doc, ...update }, settlement.paidCents));

  return {
    finding: {
      invoiceId,
      invoiceNumber: typeof doc.invoiceNumber === 'string' ? doc.invoiceNumber : null,
      kinfolkId: typeof doc.kinfolkId === 'string' ? doc.kinfolkId : null,
      totalCents: settlement.totalCents,
      paidCents: settlement.paidCents,
      claimedAmountDueCents,
      correctAmountDueCents,
      understatedCents: correctAmountDueCents - claimedAmountDueCents,
      status,
    },
    update,
  };
}

/** Narrowing helper, so callers do not re-test the shape of the union by hand. */
export function isRepairPlan(r: RepairPlan | { skipped: RepairSkipReason }): r is RepairPlan {
  return (r as RepairPlan).finding !== undefined;
}
