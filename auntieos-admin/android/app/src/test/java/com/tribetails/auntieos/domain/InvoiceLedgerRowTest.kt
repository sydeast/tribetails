package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The reading rules for a ledger row, pinned on their own.
 *
 * The web twin these mirror is `auntieos-admin/src/lib/invoiceLedger.ts`, tested
 * in `invoiceLedger.test.ts`. Same split, same reason: a rule about money is
 * easier to be sure of when nothing has to be composed to read it.
 */
class InvoiceLedgerRowTest {

    // The date cell is formatted for the operator's locale, so the expected
    // spelling below is pinned rather than inherited from whatever machine runs
    // the suite. Restored afterwards so nothing else in the JVM inherits it.
    private val hostLocale = Locale.getDefault()

    @Before fun pinLocale() = Locale.setDefault(Locale.US)

    @After fun restoreLocale() = Locale.setDefault(hostLocale)

    private fun row(
        amountCents: Long = 13750L,
        amountResolved: Boolean = true,
        tipCents: Long = 0L,
        feeCents: Long = 0L,
        tipBasis: String = "gross",
        reconciles: Boolean = true,
        appliedCents: Long = 0L,
        unappliedCents: Long = 0L,
        autoApply: Boolean = false,
        appliedInvoiceId: String = "",
        appliedInvoiceNumber: String = "",
        method: String = "Venmo",
        date: String = "2026-07-20",
    ) = GetInvoiceLedgerResultLedgerPayment(
        paymentId = "p1",
        amountCents = amountCents,
        amountResolved = amountResolved,
        tipCents = tipCents,
        feeCents = feeCents,
        tipBasis = tipBasis,
        reconciles = reconciles,
        appliedCents = appliedCents,
        unappliedCents = unappliedCents,
        proceedsCents = amountCents - feeCents,
        autoApply = autoApply,
        appliedInvoiceId = appliedInvoiceId,
        appliedInvoiceNumber = appliedInvoiceNumber,
        method = method,
        reference = "",
        date = date,
        notes = "",
        recordedBy = null,
    )

    // ── Balance ───────────────────────────────────────────────────────────────

    @Test
    fun `the balance is the server's unapplied figure, not arithmetic redone here`() {
        assertEquals(2500L, ledgerRowBalanceCents(row(unappliedCents = 2500L)))
    }

    @Test
    fun `an over-applied row keeps its negative balance instead of being clamped`() {
        // The one condition that must not be hidden: more was applied to
        // invoices than the payment covers. Clamping it at zero would render
        // the broken row as a settled one.
        assertEquals(-1000L, ledgerRowBalanceCents(row(unappliedCents = -1000L)))
    }

    // ── Applied to ────────────────────────────────────────────────────────────

    @Test
    fun `the applied cell names the invoice number when there is one`() {
        assertEquals("#1029", ledgerRowAppliedLabel(row(appliedInvoiceNumber = "1029")))
    }

    @Test
    fun `it falls back to the id, because an unnumbered invoice is still an invoice`() {
        assertEquals("inv_7", ledgerRowAppliedLabel(row(appliedInvoiceId = "inv_7")))
    }

    @Test
    fun `a payment that touched no balance says nothing rather than zero`() {
        assertEquals("", ledgerRowAppliedLabel(row()))
    }

    // ── Transaction date ──────────────────────────────────────────────────────
    //
    // The field is FREE TEXT and the server says so: getInvoiceLedger.ts calls it
    // "FREE TEXT on this collection, like every legacy billing date. Not parsed."
    // These pin both halves of the rule: read it when it can be read, and print
    // what is stored the rest of the time. Never a prefix of it.

    @Test
    fun `an operator-typed date survives whole rather than becoming a different one`() {
        // The shape the repo's fixtures hold. `take(10)` made this "February 1",
        // which is a real date and is not this payment's.
        assertEquals("February 17, 2026", ledgerRowDateLabel(row(date = "February 17, 2026")))
    }

    @Test
    fun `an ISO day is spelled out for the operator instead of left as machine text`() {
        assertEquals("Jul 20, 2026", ledgerRowDateLabel(row(date = "2026-07-20")))
    }

    @Test
    fun `an ISO instant keeps its stored day and loses only the clock`() {
        // The literal characters of the day, never a zone conversion: a payment
        // stored as the 20th is shown as the 20th wherever the phone is.
        assertEquals("Jul 20, 2026", ledgerRowDateLabel(row(date = "2026-07-20T23:32:00Z")))
    }

    @Test
    fun `an ambiguous slash date is not guessed at`() {
        // 07/24 is unreadable as written: month-first and day-first cannot be
        // told apart, so it prints as stored rather than being decided for her.
        assertEquals("07/24/2026", ledgerRowDateLabel(row(date = "07/24/2026")))
    }

    @Test
    fun `a day that does not exist is shown as stored, not rolled into the next month`() {
        assertEquals("2026-02-30", ledgerRowDateLabel(row(date = "2026-02-30")))
    }

    @Test
    fun `no date at all is said in words`() {
        assertEquals("no date recorded", ledgerRowDateLabel(row(date = "")))
        assertEquals("no date recorded", ledgerRowDateLabel(row(date = "   ")))
    }

    // ── Method ────────────────────────────────────────────────────────────────

    @Test
    fun `a recorded method is the method`() {
        assertEquals("Venmo", ledgerRowMethodLabel(row(method = "Venmo")))
    }

    @Test
    fun `a blank method is an absence, not a method called payment`() {
        assertEquals("no method recorded", ledgerRowMethodLabel(row(method = "")))
        assertEquals("no method recorded", ledgerRowMethodLabel(row(method = "  ")))
    }

    // ── Fee ───────────────────────────────────────────────────────────────────

    @Test
    fun `a recorded fee renders as the figure it is`() {
        assertEquals("$2.71", ledgerRowFeeLabel(row(feeCents = 271L)))
    }

    @Test
    fun `a reconcilable row with no fee renders a real zero`() {
        // A row whose tip basis IS recorded and whose fee is zero was charged
        // nothing. That is a reading, and suppressing it would trade one lie
        // for another.
        assertEquals("$0.00", ledgerRowFeeLabel(row(feeCents = 0L, reconciles = true)))
    }

    @Test
    fun `a migrated row's missing fee is not a zero`() {
        // The whole defect. The migration dropped the fee; zero here would be a
        // claim nobody checked.
        assertEquals(
            "not recorded",
            ledgerRowFeeLabel(row(feeCents = 0L, reconciles = false, tipBasis = "unknown", tipCents = 729L)),
        )
    }

    // ── Caveat ────────────────────────────────────────────────────────────────

    @Test
    fun `a row that reads cleanly carries no caveat`() {
        assertEquals("", ledgerRowCaveat(row()))
    }

    @Test
    fun `the unreadable amount is named first, before the dropped fee`() {
        // Order is load-bearing (see the web twin): such a row can carry
        // reconciles = true and a zero balance, so it produced no caveat at all
        // if this branch went last, and "the fee was dropped" is the wrong
        // sentence for it anyway.
        val caveat = ledgerRowCaveat(row(amountResolved = false, reconciles = false, tipCents = 729L))
        assertTrue(caveat, caveat.contains("amount on this row could not be read"))
    }

    @Test
    fun `a migrated row says its fee was never recorded`() {
        val caveat = ledgerRowCaveat(row(reconciles = false, tipBasis = "unknown", tipCents = 729L))
        assertTrue(caveat, caveat.contains("without its processor fee"))
    }

    @Test
    fun `an over-applied row says it does not balance`() {
        val caveat = ledgerRowCaveat(row(unappliedCents = -1000L))
        assertTrue(caveat, caveat.contains("does not balance"))
    }
}
