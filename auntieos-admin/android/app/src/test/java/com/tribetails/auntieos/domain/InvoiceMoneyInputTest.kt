package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The one place typed dollars become stored cents on Android.
 *
 * EVERY CASE HERE IS ABOUT THE DIFFERENCE BETWEEN null AND 0. The composer this
 * replaced read money as `toDoubleOrNull() ?: 0.0`, which turned a typo into a
 * free service that looked entirely deliberate on the finished bill. Mirrors
 * `auntieos-admin/src/lib/invoiceMoneyInput.ts`.
 */
class InvoiceMoneyInputTest {

    @Test
    fun `plain dollar amounts become cents`() {
        assertEquals(1250L, parseDollarsToCents("12.50"))
        assertEquals(1200L, parseDollarsToCents("12"))
        assertEquals(0L, parseDollarsToCents("0"))
        assertEquals(1255L, parseDollarsToCents("12.55"))
        assertEquals(5L, parseDollarsToCents("0.05"))
    }

    @Test
    fun `figures pasted out of other documents are read rather than refused`() {
        assertEquals(125000L, parseDollarsToCents("$1,250.00"))
        assertEquals(1250L, parseDollarsToCents("  12.50  "))
    }

    @Test
    fun `an unreadable figure is null, never zero`() {
        assertNull(parseDollarsToCents(""))
        assertNull(parseDollarsToCents("   "))
        assertNull(parseDollarsToCents("abc"))
        assertNull(parseDollarsToCents("-5"))
        assertNull(parseDollarsToCents("12."))
        assertNull(parseDollarsToCents("1e3"))
    }

    @Test
    fun `a third decimal place is a typo and is refused rather than rounded`() {
        // Silently deciding whether "12.345" meant $12.34 or $12.35 is not this
        // function's call to make.
        assertNull(parseDollarsToCents("12.345"))
    }

    @Test
    fun `cents seed an input with both decimals`() {
        // "12" in a price field invites an operator to append a digit and bill $125.
        assertEquals("12.50", centsToInputDollars(1250L))
        assertEquals("12.00", centsToInputDollars(1200L))
        assertEquals("0.05", centsToInputDollars(5L))
    }

    @Test
    fun `cents project to the dollars the invoices collection stores`() {
        assertEquals(12.5, centsToDollars(1250L), 0.0001)
        assertEquals(0.0, centsToDollars(0L), 0.0001)
        assertEquals(36.0, centsToDollars(3600L), 0.0001)
    }

    @Test
    fun `quantities may be fractional but never zero or negative`() {
        assertEquals(2.5, parseQty("2.5")!!, 0.0001)
        assertEquals(3.0, parseQty("3")!!, 0.0001)
        assertNull(parseQty("0"))
        assertNull(parseQty("-1"))
        assertNull(parseQty(""))
        assertNull(parseQty("two"))
    }

    @Test
    fun `the schema bounds are the server's, stated once`() {
        assertEquals(10_000_000L, MAX_UNIT_CENTS)
        assertEquals(999.0, MAX_QTY, 0.0001)
    }
}
