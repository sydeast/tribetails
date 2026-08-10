package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import com.tribetails.auntieos.util.formatJoinDate

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
 * The "Transaction date" cell: the day the record actually names, never ten
 * characters of it.
 *
 * THE FIELD IS FREE TEXT AND THE SERVER SAYS SO. `getInvoiceLedger.ts` documents
 * it as "FREE TEXT on this collection, like every legacy billing date. Not
 * parsed." The row used to print `date.take(10)`, which is a bet on `YYYY-MM-DD`
 * that the contract explicitly declines to make. On the shape this collection
 * really holds (`February 17, 2026`, in the repo's own fixtures) ten characters
 * is `February 1`: not a shortened date but a DIFFERENT one, plausible enough
 * that nothing on the invoice screen looks wrong. That is the defect this
 * exists to stop.
 *
 * SO WHY PARSE AT ALL, rather than print the string and be done? Because the
 * truncation was reaching for something real: an ISO instant rendered raw is
 * machine text, and the operator is reading a bill. When the stored value IS a
 * day this app can read, it is formatted for her locale; when it is anything
 * else it passes through exactly as stored.
 *
 * [formatJoinDate] already solves precisely this and is reused rather than
 * re-derived: it reads the LITERAL characters of the day and never shifts a
 * zone, so the day on screen is always the day in the record, only re-spelled.
 * It refuses `07/24/2026` and friends on purpose, because month-first and
 * day-first are indistinguishable for the first twelve days of any month, and
 * those pass through untouched too.
 *
 * `""` says so in words, matching the web ledger's `no date recorded`. The old
 * `-` sat in the same place a real date would and left the operator to work out
 * which kind of nothing it meant.
 */
fun ledgerRowDateLabel(row: GetInvoiceLedgerResultLedgerPayment): String {
    val stored = row.date.trim()
    if (stored.isEmpty()) return "no date recorded"
    return formatJoinDate(stored)
}

/**
 * The "Method" cell: how the money arrived, or the plain fact that nobody wrote
 * it down.
 *
 * The twin of the web's `paymentMethodLabel`, down to the string. This row used
 * to say `payment` for a blank method, which reads as a method CALLED "payment"
 * sitting in the slot where "Venmo" goes: an absence dressed as a reading.
 *
 * The words are the web's own rather than the bare `not recorded` this screen
 * uses inside [ledgerRowFeeLabel], because that cell has a "FEE" label beside it
 * to supply the noun and this one is an unlabelled line under the amount. It is
 * the same voice, not a third one.
 */
fun ledgerRowMethodLabel(row: GetInvoiceLedgerResultLedgerPayment): String {
    val method = row.method.trim()
    return if (method.isEmpty()) "no method recorded" else method
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
