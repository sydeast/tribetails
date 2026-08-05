package com.tribetails.auntieos.domain

/**
 * WHAT A PAYMENT IS MADE OF, on Android, and the marker that says whether its
 * tip can be trusted.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * The operator is paid through Venmo and PayPal, records each payment by hand,
 * and is charged a processor fee she takes out of the tip. Her previous system
 * had a Fees field; this one had no fee at any layer, so the fee was dropped on
 * the way in. Invoice #1029 is the live example:
 *
 *     Amount   $137.50
 *     Applied  $127.50
 *     Tip        $7.29
 *     Balance    $0.00
 *
 * $2.71 is missing and nothing on the record says where it went. The true
 * arithmetic was `amount = applied + tipGross(10.00)`, with the $2.71 fee taken
 * out of that gross tip, leaving the $7.29 net the old system stored.
 *
 * ── THE OPERATOR'S RULING, 2026-08-04 ─────────────────────────────────────
 *
 *   "store both, and display the latter. itll help with taxes."
 *
 * The gross tip is income; the processor fee is a deductible expense. A system
 * that remembers only the net has thrown away one line of her return and
 * understated the other. So the tip stored is the GROSS, the fee sits beside
 * it, and the net is derived.
 *
 * ── THIS IS THE ANDROID TWIN ──────────────────────────────────────────────
 *
 * The server's `mytribe/functions/src/lib/paymentMoney.ts` is the authority and
 * carries the full reasoning. This mirrors its arithmetic so the record-payment
 * dialog can show an Unapplied Balance as the operator types, before anything is
 * sent. It is duplicated across the tree boundary the same way the invoice
 * classifier is: Android cannot import from `mytribe/functions`, and these four
 * rules are the contract between them.
 *
 * NOTHING HERE DECIDES ANYTHING. Every figure a screen displays after a payment
 * lands comes back from the server (ADR-0002). These functions exist so the
 * dialog can preview the arithmetic, not so the client can perform it.
 */

/** Which convention a stored `tip` follows. Mirrors `TipBasis` on the server. */
enum class TipBasis { GROSS, NET, UNKNOWN }

/**
 * Reads a stored `tipBasis`. Absent, blank, and unrecognized all read as
 * [TipBasis.UNKNOWN].
 *
 * ABSENT IS NOT NET, and that is the deliberate difference from
 * `createdAtSource`, which defaults to `live`. There, absence was evidence: one
 * import had ever run and it stamped every row it touched. Here it is not. The
 * root `payments` collection was written by a legacy migration (net tips), by
 * the Stripe webhook (no tip at all) and by this client before the fee existed,
 * so defaulting them all to net would state a fact nobody checked, on the exact
 * field whose last unchecked assumption is the bug being fixed.
 */
fun readTipBasis(raw: String?): TipBasis = when (raw?.trim()) {
    "gross" -> TipBasis.GROSS
    "net" -> TipBasis.NET
    else -> TipBasis.UNKNOWN
}

/** Dollars-as-double to integer cents, rounded ONCE, floored at zero. */
fun dollarsToCents(dollars: Double): Long =
    if (dollars.isFinite()) maxOf(0L, Math.round(dollars * 100)) else 0L

/**
 * THE UNAPPLIED BALANCE: `payment - applied - tipGross`, in integer cents.
 *
 * The figure the operator watches before saving, because it is how a mis-keyed
 * amount is caught while it is still a typo rather than a payment.
 *
 * SIGNED, never clamped. A negative means more was applied than came in, which
 * the server refuses outright; showing it as zero would hide the one condition
 * she has to see.
 *
 * THE FEE IS NOT IN IT. A processor fee is a deduction from what the business
 * receives, not from what the client paid, so it does not move this number.
 * That is the same reason the fee is absent from the reconciliation identity.
 */
fun unappliedCents(paymentCents: Long, appliedCents: Long, tipGrossCents: Long): Long =
    paymentCents - appliedCents - tipGrossCents

/** What the business banks: the collection less the processor fee. Integer cents. */
fun proceedsCents(paymentCents: Long, feeCents: Long): Long = paymentCents - feeCents

/**
 * What she keeps of the tip once the fee is out of it, or `null` when the basis
 * is not [TipBasis.GROSS].
 *
 * Null rather than a number, deliberately. Subtracting a fee from a NET tip
 * charges it twice, and subtracting it from an UNKNOWN one is arithmetic on a
 * guess. Both would put a figure that was never collected onto a tax return.
 */
fun tipNetCents(tipGrossCents: Long, feeCents: Long, basis: TipBasis): Long? =
    if (basis == TipBasis.GROSS) tipGrossCents - feeCents else null

/**
 * Can `amount = applied + tipGross + unapplied` be CHECKED on this row?
 *
 * False on a row carrying a tip whose convention was never recorded: every
 * migrated row with a tip. Those must be marked rather than displayed as though
 * they balanced, and NO GROSS IS BACK-COMPUTED for them: the gross cannot be
 * recovered from a net tip whose deduction is unknown.
 *
 * A row with NO TIP reconciles whatever its basis says. There is no convention
 * to be wrong about when the number is zero, and a caveat on every Stripe row
 * is the noise that trains an operator to stop reading caveats.
 */
fun paymentReconciles(tipCents: Long, basis: TipBasis): Boolean =
    tipCents == 0L || basis == TipBasis.GROSS

/**
 * The dialog's own validation of a money box that may be left blank.
 *
 * Returns the dollars, or `null` for something typed that is not money. A BLANK
 * BOX IS 0.0 (no tip was entered), but "abc" in the tip box is a keystroke she
 * meant, and reading it as zero would silently drop a tip she believes she
 * recorded. Negative is refused: a negative fee is not a fee.
 */
fun parseOptionalMoney(raw: String): Double? {
    val trimmed = raw.trim().removePrefix("$")
    if (trimmed.isEmpty()) return 0.0
    val parsed = trimmed.toDoubleOrNull() ?: return null
    return if (parsed.isFinite() && parsed >= 0.0) parsed else null
}
