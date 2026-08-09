package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment

/**
 * HOW TO SAY A LEDGER ROW OUT LOUD, on Android.
 *
 * The twin of `auntieos-admin/src/lib/invoiceLedger.ts`, duplicated across the
 * tree boundary for the same reason `PaymentMoney.kt` is: Android cannot import
 * from the web app, and these rules are the contract between the two surfaces.
 *
 * NOTHING HERE COMPUTES MONEY. Every cents figure arrives already computed by
 * the server (ADR-0002); these functions only decide how to SAY it, and each one
 * exists because the alternative is a screen stating something nobody checked.
 *
 * ── WHY ANY OF THIS IS ON ANDROID AT ALL ──────────────────────────────────
 *
 * The web ledger has rendered Amount, Applied to, Tip, Fee and Balance since the
 * fee landed. Android decoded all five and printed the first. Invoice #1029 is
 * why that gap mattered:
 *
 *     Amount $137.50 = Applied $127.50 + Tip $10.00 + Balance $0.00
 *                                       (Fee $2.71 taken out of the tip)
 *
 * A row reads across or it does not, and one number on its own cannot be read
 * across anything.
 */

/**
 * The "Balance" column: what is left of the payment after the bill and the tip.
 *
 * A pass-through, on purpose. The server signs this figure and never clamps it,
 * and re-deriving it here would put a second opinion about money on the phone.
 */
fun ledgerRowBalanceCents(row: GetInvoiceLedgerResultLedgerPayment): Long = row.unappliedCents

/**
 * The "Applied to #n" cell: the invoice number, the id behind it, or the honest
 * absence.
 *
 * `""` means the payment touched no balance at all, which is a DIFFERENT FACT
 * from applying nothing to one, hence a caller that says "not applied" rather
 * than printing a zero.
 */
fun ledgerRowAppliedLabel(row: GetInvoiceLedgerResultLedgerPayment): String {
    val number = row.appliedInvoiceNumber.trim()
    if (number.isNotEmpty()) return "#$number"
    val id = row.appliedInvoiceId.trim()
    if (id.isNotEmpty()) return id
    return ""
}

/**
 * The "Fee" cell, where THREE STATES have to stay apart and only two are
 * numbers.
 *
 *  - a fee was charged: the figure.
 *  - no fee was charged, on a row whose basis WAS recorded: a real `$0.00`.
 *  - the fee was never recorded, on a migrated row: `not recorded`.
 *
 * The third is the defect itself. A zero there is the claim that made #1029
 * unreadable; suppressing the second would trade that lie for its opposite.
 */
fun ledgerRowFeeLabel(row: GetInvoiceLedgerResultLedgerPayment): String = when {
    row.feeCents > 0L -> formatCentsUsd(row.feeCents)
    row.reconciles -> formatCentsUsd(0L)
    else -> "not recorded"
}

/**
 * The caveat a row carries when its figures CANNOT be checked, or `""` when they
 * can.
 *
 * THE ORDER IS LOAD-BEARING and matches the web twin. An unreadable amount is
 * tested FIRST: such a row can carry `reconciles = true` and a zero balance
 * perfectly happily, so it would fall through both branches below and get no
 * caveat at all. And "the fee was dropped" is the wrong sentence for it anyway,
 * because it invites the operator to trust the amount beside it, which is the
 * one figure on that row nobody can vouch for.
 *
 * NO BACK-COMPUTED GROSS. A gross tip cannot be recovered from a net tip whose
 * deduction is unknown, and a plausible guess here would put a number that was
 * never collected onto a tax return.
 */
fun ledgerRowCaveat(row: GetInvoiceLedgerResultLedgerPayment): String = when {
    !row.amountResolved ->
        "The amount on this row could not be read: either no figure was ever resolved for the " +
            "payment, or what was stored is not a usable number. Nothing is shown in its place, " +
            "and the balance is left blank too, because it was worked out from that same figure."
    !row.reconciles ->
        "This row was migrated without its processor fee, so whether the tip shown is before or " +
            "after that fee was never recorded. It cannot be reconciled, and no gross tip has " +
            "been guessed for it."
    // An over-application cannot be created any more, but a row already carrying
    // one must not render as though it balanced.
    row.unappliedCents < 0L ->
        "More was applied to invoices than this payment covers, so this row does not balance."
    else -> ""
}

/**
 * Every caveat the rows on screen carry, said once each and in the order they
 * first appear.
 *
 * Deduplicated because a household with six migrated payments has one problem,
 * not six, and six copies of the same paragraph is the noise that trains an
 * operator to stop reading paragraphs.
 */
fun ledgerCaveats(rows: List<GetInvoiceLedgerResultLedgerPayment>): List<String> =
    rows.map { ledgerRowCaveat(it) }.filter { it.isNotEmpty() }.distinct()
