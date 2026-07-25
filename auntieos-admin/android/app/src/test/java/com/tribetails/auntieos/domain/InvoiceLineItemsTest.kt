package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.InvoiceLineItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Read-only invoice line items and the archive flag (Task 5.1).
 *
 * Android renders what the web wrote and never writes lines itself, so what
 * matters here is that it DECODES honestly: a malformed document must not take
 * down the surface, and an un-itemized invoice must not read as one billing
 * nothing.
 */
class InvoiceLineItemsTest {

    private fun line(
        description: String = "Dog walk",
        qty: Double = 3.0,
        unitCents: Long = 2500L,
        discountCents: Long = 0L,
    ) = InvoiceLineItem(description, qty, unitCents, discountCents)

    // ------------------------------------------------------------ archive flag

    @Test
    fun `an invoice with no archivedAt is not archived`() {
        assertFalse(invoiceIsArchived(Invoice(id = "i1")))
    }

    @Test
    fun `an explicit null archivedAt reads as not archived`() {
        // unarchiveInvoice writes null rather than deleting the field, so a
        // restored invoice must read exactly like one that was never archived.
        assertFalse(invoiceIsArchived(Invoice(id = "i1", archivedAt = null)))
    }

    @Test
    fun `a present archivedAt reads as archived`() {
        assertTrue(invoiceIsArchived(Invoice(id = "i1", archivedAt = "2026-07-25T00:00:00Z")))
    }

    // ---------------------------------------------------------------- decoding

    @Test
    fun `an absent lineItems field decodes to NULL, not an empty list`() {
        // Null means nobody itemized this invoice, which is every invoice created
        // before 5.1. An empty list means somebody itemized it as billing
        // nothing. The detail screen says two different things about them.
        assertNull(decodeInvoiceLineItems(null))
    }

    @Test
    fun `a lineItems field that is not a list at all decodes to null rather than throwing`() {
        assertNull(decodeInvoiceLineItems("two dog walks"))
        assertNull(decodeInvoiceLineItems(42))
    }

    @Test
    fun `an empty list decodes to an empty list, keeping it distinct from absent`() {
        assertEquals(emptyList<InvoiceLineItem>(), decodeInvoiceLineItems(emptyList<Any>()))
    }

    @Test
    fun `decodes a well formed row`() {
        val decoded = decodeInvoiceLineItems(
            listOf(mapOf("description" to "Dog walk", "qty" to 3.0, "unitCents" to 2500L, "discountCents" to 100L)),
        )
        assertEquals(listOf(line(discountCents = 100L)), decoded)
    }

    @Test
    fun `DROPS a malformed row instead of failing the whole invoice`() {
        // firestore.rules grants `allow update: if isAuntie()` over the whole
        // collection and postInvoiceEvent merges an arbitrary payload, so these
        // are reachable documents. Throwing here would blank the invoice screen.
        val decoded = decodeInvoiceLineItems(
            listOf(
                mapOf("description" to "Good", "qty" to 1.0, "unitCents" to 100L),
                mapOf("description" to "No qty", "unitCents" to 100L),
                mapOf("description" to "String price", "qty" to 1.0, "unitCents" to "100"),
                "not a row",
                null,
            ),
        )
        assertEquals(listOf("Good"), decoded!!.map { it.description })
    }

    @Test
    fun `treats a missing discountCents as zero rather than as a broken row`() {
        val decoded = decodeInvoiceLineItems(listOf(mapOf("qty" to 1.0, "unitCents" to 2500L)))
        assertEquals(1, decoded!!.size)
        assertEquals(0L, decoded[0].discountCents)
    }

    @Test
    fun `accepts an integer qty, which is how Firestore returns a whole number`() {
        val decoded = decodeInvoiceLineItems(listOf(mapOf("description" to "x", "qty" to 3, "unitCents" to 2500)))
        assertEquals(3.0, decoded!![0].qty, 0.0)
        assertEquals(2500L, decoded[0].unitCents)
    }

    // ------------------------------------------------------------------- money

    @Test
    fun `a line amount is derived, rounding half up exactly once`() {
        assertEquals(7500L, lineAmountCents(line()))
        // 2.5 x 3333 = 8332.5, rounds up.
        assertEquals(8333L, lineAmountCents(line(qty = 2.5, unitCents = 3333L)))
    }

    @Test
    fun `a per line discount comes off the line amount`() {
        assertEquals(7500L, lineAmountCents(line(qty = 1.0, unitCents = 8000L, discountCents = 500L)))
    }

    @Test
    fun `the subtotal is exact integer addition`() {
        val lines = listOf(line(), line(qty = 1.0, unitCents = 8000L, discountCents = 500L))
        assertEquals(15000L, invoiceSubtotalCents(lines))
    }

    @Test
    fun `an invoice discount comes off the total but not the subtotal`() {
        val lines = listOf(line())
        assertEquals(7500L, invoiceSubtotalCents(lines))
        assertEquals(6500L, invoiceDerivedTotalCents(lines, 1000L))
    }

    @Test
    fun `a discount larger than the subtotal goes NEGATIVE rather than clamping to zero`() {
        // Matches the server. Flooring it would replace a visible operator error
        // with a plausible-looking $0.00.
        assertEquals(-2500L, invoiceDerivedTotalCents(listOf(line()), 10000L))
    }

    // ----------------------------------------------------------- disagreement

    @Test
    fun `an un-itemized invoice reports NO disagreement`() {
        // It has nothing to disagree with, and its stored total is the only
        // assertion anyone has made about it. Flagging it would put an error on
        // every invoice in the collection.
        assertNull(invoiceTotalDisagreement(Invoice(id = "i1", total = 40.0)))
    }

    @Test
    fun `agreement between the lines and totalCents reports nothing`() {
        val inv = Invoice(
            id = "i1",
            total = 75.0,
            totalCents = 7500L,
            lineItems = listOf(mapOf("description" to "Dog walk", "qty" to 3.0, "unitCents" to 2500L)),
        )
        assertNull(invoiceTotalDisagreement(inv))
    }

    @Test
    fun `a drifted stored total reports BOTH figures`() {
        val inv = Invoice(
            id = "i1",
            total = 40.0,
            totalCents = 4000L,
            lineItems = listOf(mapOf("description" to "Dog walk", "qty" to 3.0, "unitCents" to 2500L)),
        )
        val drift = invoiceTotalDisagreement(inv)
        assertNotNull(drift)
        assertEquals(7500L, drift!!.derivedCents)
        assertEquals(4000L, drift.storedCents)
    }

    @Test
    fun `falls back to the dollar total when totalCents is absent`() {
        // The case most worth catching: an invoice edited outside the callables
        // can carry a changed `total` and no `totalCents` at all.
        val inv = Invoice(
            id = "i1",
            total = 40.0,
            lineItems = listOf(mapOf("description" to "Dog walk", "qty" to 3.0, "unitCents" to 2500L)),
        )
        assertEquals(4000L, invoiceTotalDisagreement(inv)!!.storedCents)
    }

    @Test
    fun `compares in integers so a float artifact is not mistaken for drift`() {
        val inv = Invoice(
            id = "i1",
            total = 30.3,
            lineItems = listOf(mapOf("description" to "x", "qty" to 3.0, "unitCents" to 1010L)),
        )
        assertNull(invoiceTotalDisagreement(inv))
    }

    @Test
    fun `an empty itemization beside a non-zero total IS a disagreement`() {
        val inv = Invoice(id = "i1", total = 40.0, lineItems = emptyList<Any>())
        assertEquals(0L, invoiceTotalDisagreement(inv)!!.derivedCents)
        assertEquals(4000L, invoiceTotalDisagreement(inv)!!.storedCents)
    }

    // -------------------------------------------------------------- formatting

    @Test
    fun `formats integer cents as dollars`() {
        assertEquals("$0.00", formatCents(0L))
        assertEquals("$75.00", formatCents(7500L))
        assertEquals("-$12.50", formatCents(-1250L))
    }

    @Test
    fun `does not dress a whole quantity up as money`() {
        assertEquals("3", formatQty(3.0))
        assertEquals("2.5", formatQty(2.5))
        assertEquals("0", formatQty(Double.NaN))
    }
}
