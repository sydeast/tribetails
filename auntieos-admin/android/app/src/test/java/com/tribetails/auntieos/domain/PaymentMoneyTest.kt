package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android twin of the server's payment arithmetic.
 *
 * INVOICE #1029 IS THE ANCHOR CASE, the same one the server tests use: Amount
 * $137.50, Applied $127.50, Tip $7.29, Balance $0.00, and $2.71 that nothing on
 * the record could account for. It was a processor fee, taken out of a $10.00
 * gross tip that the migration replaced with its $7.29 net.
 */
class PaymentMoneyTest {

    // ── The identity that could not be checked ────────────────────────────

    @Test
    fun `invoice 1029 closes once the gross tip is stored`() {
        val payment = 13750L
        val applied = 12750L
        val tipGross = 1000L
        assertEquals(0L, unappliedCents(payment, applied, tipGross))
        // amount = applied + tipGross + unapplied
        assertEquals(payment, applied + tipGross + unappliedCents(payment, applied, tipGross))
    }

    @Test
    fun `the net tip the legacy system stored is derived, not stored`() {
        assertEquals(729L, tipNetCents(1000L, 271L, TipBasis.GROSS))
    }

    @Test
    fun `proceeds are what the business banks, the collection less the fee`() {
        assertEquals(13479L, proceedsCents(13750L, 271L))
    }

    @Test
    fun `the fee does not move the unapplied balance`() {
        // A processor fee is a deduction from what the business receives, not
        // from what the client paid, so it is absent from the identity.
        val withoutFee = unappliedCents(30000L, 18000L, 0L)
        assertEquals(12000L, withoutFee)
        assertEquals(13729L, proceedsCents(30000L, 16271L))
        // Same leftover whatever the fee is: the fee never enters it.
        assertEquals(withoutFee, unappliedCents(30000L, 18000L, 0L))
    }

    // ── The unapplied balance ─────────────────────────────────────────────

    @Test
    fun `the leftover is what is over after the bill and the tip`() {
        // $300 handed over, $180 on the bill, $20 tip: $100 stays.
        assertEquals(10000L, unappliedCents(30000L, 18000L, 2000L))
    }

    @Test
    fun `the whole payment is unapplied when nothing goes on a bill`() {
        assertEquals(4000L, unappliedCents(4000L, 0L, 0L))
    }

    @Test
    fun `an over-application reads negative rather than being floored at zero`() {
        // The mis-key the dialog refuses. Flooring it would hide the one
        // condition the operator has to see before saving.
        assertEquals(-3000L, unappliedCents(5000L, 8000L, 0L))
    }

    @Test
    fun `a tip larger than the payment reads negative too`() {
        assertEquals(-500L, unappliedCents(1000L, 0L, 1500L))
    }

    // ── The net tip is derived only where it can be ───────────────────────

    @Test
    fun `no net tip is derived from an unknown basis`() {
        // Subtracting a fee from a guess is a guess.
        assertNull(tipNetCents(729L, 271L, TipBasis.UNKNOWN))
    }

    @Test
    fun `no net tip is derived from a net one, because the fee is already out`() {
        // Charging it twice would report a $4.58 tip on a $7.29 one.
        assertNull(tipNetCents(729L, 271L, TipBasis.NET))
    }

    @Test
    fun `a fee bigger than a small tip reads negative, because she is out of pocket`() {
        assertEquals(-221L, tipNetCents(50L, 271L, TipBasis.GROSS))
    }

    // ── The basis marker ──────────────────────────────────────────────────

    @Test
    fun `the value this system writes reads as gross`() {
        assertEquals(TipBasis.GROSS, readTipBasis("gross"))
    }

    @Test
    fun `a proven net basis reads as net`() {
        assertEquals(TipBasis.NET, readTipBasis("net"))
    }

    @Test
    fun `an ABSENT marker reads as unknown, never as net`() {
        // The deliberate difference from createdAtSource, which defaults to
        // 'live'. There absence was evidence; here it is not. This collection
        // was written by a legacy migration, by the Stripe webhook and by this
        // client before the fee existed.
        assertEquals(TipBasis.UNKNOWN, readTipBasis(null))
        assertEquals(TipBasis.UNKNOWN, readTipBasis(""))
        assertEquals(TipBasis.UNKNOWN, readTipBasis("  "))
    }

    @Test
    fun `an unrecognized marker reads as unknown rather than throwing`() {
        // This runs inside list rendering. One malformed document must not blank
        // an operator's payment history.
        assertEquals(TipBasis.UNKNOWN, readTipBasis("GROSS"))
        assertEquals(TipBasis.UNKNOWN, readTipBasis("net-ish"))
    }

    // ── Which rows can be checked ─────────────────────────────────────────

    @Test
    fun `a row this system wrote reconciles`() {
        assertTrue(paymentReconciles(1000L, TipBasis.GROSS))
    }

    @Test
    fun `a migrated tip of unrecorded basis does NOT reconcile`() {
        assertFalse(paymentReconciles(729L, TipBasis.UNKNOWN))
        assertFalse(paymentReconciles(729L, TipBasis.NET))
    }

    @Test
    fun `a row with no tip reconciles whatever its basis says`() {
        // Every Stripe row and every payment nobody tipped on. A caveat on all
        // of them is the noise that trains an operator to stop reading caveats.
        assertTrue(paymentReconciles(0L, TipBasis.UNKNOWN))
        assertTrue(paymentReconciles(0L, TipBasis.NET))
    }

    // ── Units ─────────────────────────────────────────────────────────────

    @Test
    fun `dollars round to cents exactly once`() {
        assertEquals(13750L, dollarsToCents(137.5))
        assertEquals(271L, dollarsToCents(2.71))
        // The classic float: 0.1 + 0.2 is 0.30000000000000004 in dollars.
        assertEquals(30L, dollarsToCents(0.1 + 0.2))
    }

    @Test
    fun `a negative dollar amount floors at zero rather than storing a negative fee`() {
        assertEquals(0L, dollarsToCents(-5.0))
    }

    @Test
    fun `a broken number reads as no evidence, never as NaN`() {
        assertEquals(0L, dollarsToCents(Double.NaN))
        assertEquals(0L, dollarsToCents(Double.POSITIVE_INFINITY))
    }

    // ── The dialog's own money parsing ────────────────────────────────────

    @Test
    fun `a blank box is zero, because no tip was entered`() {
        assertEquals(0.0, parseOptionalMoney("")!!, 0.0001)
        assertEquals(0.0, parseOptionalMoney("   ")!!, 0.0001)
    }

    @Test
    fun `a typed amount parses, with or without the dollar sign`() {
        assertEquals(2.71, parseOptionalMoney("2.71")!!, 0.0001)
        assertEquals(2.71, parseOptionalMoney(" $2.71 ")!!, 0.0001)
    }

    @Test
    fun `something typed that is not money is NULL, not zero`() {
        // Reading "abc" as $0 would silently drop a tip she believes she entered.
        assertNull(parseOptionalMoney("abc"))
        assertNull(parseOptionalMoney("2.71.3"))
    }

    @Test
    fun `a negative is refused, because a negative fee is not a fee`() {
        assertNull(parseOptionalMoney("-2.71"))
    }
}
