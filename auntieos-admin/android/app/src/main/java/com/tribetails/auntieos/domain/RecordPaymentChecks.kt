package com.tribetails.auntieos.domain

/**
 * #1975: THE TWO RECORD PAYMENT FIGURES THAT ARE QUESTIONED BEFORE SAVE.
 * The same rules and words as admin web (`lib/recordPaymentChecks.ts`) and the
 * desktop console.
 *
 *   - A PROCESSOR FEE LARGER THAN THE PAYMENT is refused. The fee is what the
 *     processor kept out of what was paid, so it cannot be more than that. The
 *     server refuses it too (`fee_exceeds_amount`). A fee larger than the tip
 *     is ordinary (a card payment of exactly the balance, no tip) and is not.
 *   - A TIP LARGER THAN THE INVOICE'S TOTAL is asked about, not refused: an
 *     overpayment is all tip (ruling 2026-09-27), so a large tip can be real.
 *     It is also what a slip in the amount looks like. Record waits until she
 *     ticks that the tip is right.
 */
fun feeOverPaymentError(feeCents: Long, paidCents: Long): String? =
    if (feeCents <= paidCents) null
    else "A fee of ${formatCentsUsd(feeCents)} is more than the ${formatCentsUsd(paidCents)} payment it came out of. Check the fee."

/** True when the tip is larger than the invoice's total and has to be confirmed. */
fun tipNeedsConfirming(tipCents: Long, invoiceTotalCents: Long?): Boolean =
    invoiceTotalCents != null && invoiceTotalCents >= 0L && tipCents > invoiceTotalCents

/** The tick box beside a tip larger than the invoice. */
fun bigTipConfirmLabel(tipCents: Long, invoiceTotalCents: Long): String =
    "The ${formatCentsUsd(tipCents)} tip is right. It is more than this invoice's ${formatCentsUsd(invoiceTotalCents)} total."

/**
 * The fee clause in the "where this payment goes" line. The fee comes out of
 * the tip; a fee larger than the tip cannot, so the line says it comes out of
 * the payment instead.
 */
fun recordPaymentFeeClause(feeCents: Long?, tipCents: Long): String = when {
    feeCents == null || feeCents <= 0L -> ""
    feeCents <= tipCents -> " (the ${formatCentsUsd(feeCents)} fee comes out of it)"
    else -> " (the ${formatCentsUsd(feeCents)} fee comes out of the payment)"
}

/**
 * #1975: with Payment amount blank, account credit is added on top of the
 * Amount box, and the line says so.
 */
fun creditOnTopNote(creditCents: Long, collectedCents: Long, totalTyped: Boolean): String =
    if (totalTyped || creditCents <= 0L) ""
    else " The ${formatCentsUsd(creditCents)} credit is on top of the ${formatCentsUsd(collectedCents)} amount. " +
        "If the household paid less, enter what they paid under Payment amount."
