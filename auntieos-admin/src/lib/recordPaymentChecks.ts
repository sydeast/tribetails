import { formatUsd } from './invoiceFormat';

/**
 * #1975: THE TWO RECORD PAYMENT FIGURES THAT ARE QUESTIONED BEFORE SAVE.
 * The same rules and words ship on admin Android and the desktop console.
 *
 *   - A PROCESSOR FEE LARGER THAN THE PAYMENT is refused. The fee is what the
 *     processor kept out of what was paid, so it cannot be more than that. The
 *     server refuses it too (`fee_exceeds_amount`). A fee larger than the tip
 *     is ordinary (a card payment of exactly the balance, no tip) and is not.
 *   - A TIP LARGER THAN THE INVOICE'S TOTAL is asked about, not refused: an
 *     overpayment is all tip (ruling 2026-09-27), so a large tip can be real.
 *     It is also what a slip in the amount looks like (1000 typed for 100, or
 *     seven 9s). Record waits until she ticks that the tip is right.
 */
export function feeOverPaymentError(feeCents: number, paidCents: number): string | null {
  if (feeCents <= paidCents) return null;
  return `A fee of ${formatUsd(feeCents / 100)} is more than the ${formatUsd(paidCents / 100)} payment it came out of. Check the fee.`;
}

/** True when the tip is larger than the invoice's total and has to be confirmed. */
export function tipNeedsConfirming(tipCents: number, invoiceTotalCents: number | null): boolean {
  return invoiceTotalCents !== null && invoiceTotalCents >= 0 && tipCents > invoiceTotalCents;
}

/** The tick box beside a tip larger than the invoice. */
export function bigTipConfirmLabel(tipCents: number, invoiceTotalCents: number): string {
  return `The ${formatUsd(tipCents / 100)} tip is right. It is more than this invoice's ${formatUsd(invoiceTotalCents / 100)} total.`;
}

/** What Record says when the tip has not been confirmed. */
export const BIG_TIP_UNCONFIRMED =
  'The tip is more than this invoice\'s total. Check the amounts, or tick the box to say the tip is right.';

/**
 * The fee clause in the "where this payment goes" line. The fee comes out of
 * the tip (ruling 2026-09-27); a fee larger than the tip cannot, so the line
 * says it comes out of the payment instead of claiming the tip covers it.
 */
export function feeClause(feeCents: number, tipCents: number): string {
  if (feeCents <= 0) return '';
  return feeCents <= tipCents
    ? ` (the ${formatUsd(feeCents / 100)} fee comes out of it)`
    : ` (the ${formatUsd(feeCents / 100)} fee comes out of the payment)`;
}

/**
 * #1975: with Payment amount blank, account credit is added on top of the
 * amount collected, and the line says so: 100 collected and 500 credit is a
 * $600.00 payment, which used to read as "$600.00 paid" under a box holding
 * 100 with no word about where the other $500.00 came from.
 */
export function creditOnTopNote(creditCents: number, collectedCents: number, totalTyped: boolean): string {
  if (totalTyped || creditCents <= 0) return '';
  return ` The ${formatUsd(creditCents / 100)} credit is on top of the ${formatUsd(collectedCents / 100)} collected. If the household paid less, enter what they paid under Payment amount.`;
}
