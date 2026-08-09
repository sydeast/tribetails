package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reading rules for a ledger row, pinned on their own.
 *
 * The web twin these mirror is `auntieos-admin/src/lib/invoiceLedger.ts`, tested
 * in `invoiceLedger.test.ts`. Same split, same reason: a rule about money is
 * easier to be sure of when nothing has to be composed to read it.
 */
class InvoiceLedgerRowTest {

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
        method = "Venmo",
        reference = "",
        date = "2026-07-20",
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
