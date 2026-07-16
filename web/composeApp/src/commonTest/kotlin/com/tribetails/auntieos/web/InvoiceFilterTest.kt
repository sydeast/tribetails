package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.screens.invoices.formatMoney
import com.tribetails.auntieos.web.screens.invoices.invoiceIsOutstanding
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class InvoiceFilterTest {

    @Test
    fun invoiceIsOutstanding_trueWhenAmountDuePositive() {
        val invoice = Invoice(amountDue = 50.0)
        assertTrue(invoiceIsOutstanding(invoice))
    }

    @Test
    fun invoiceIsOutstanding_falseWhenAmountDueZero() {
        val invoice = Invoice(amountDue = 0.0)
        assertFalse(invoiceIsOutstanding(invoice))
    }

    @Test
    fun invoiceIsOutstanding_falseWhenAmountDueNegative() {
        val invoice = Invoice(amountDue = -1.0)
        assertFalse(invoiceIsOutstanding(invoice))
    }

    // H1: status field must be respected regardless of amountDue

    @Test
    fun invoiceIsOutstanding_falseWhenStatusPaidLowercase() {
        // status="paid" (lowercase) overrides amountDue - a paid invoice is not outstanding
        val invoice = Invoice(amountDue = 120.0, status = "paid")
        assertFalse(invoiceIsOutstanding(invoice))
    }

    @Test
    fun invoiceIsOutstanding_falseWhenStatusPaidUppercase() {
        val invoice = Invoice(amountDue = 120.0, status = "PAID")
        assertFalse(invoiceIsOutstanding(invoice))
    }

    @Test
    fun invoiceIsOutstanding_falseWhenStatusPaidTitleCase() {
        val invoice = Invoice(amountDue = 120.0, status = "Paid")
        assertFalse(invoiceIsOutstanding(invoice))
    }

    @Test
    fun invoiceIsOutstanding_trueWhenStatusOutstanding() {
        val invoice = Invoice(amountDue = 120.0, status = "OUTSTANDING")
        assertTrue(invoiceIsOutstanding(invoice))
    }

    // H2: formatMoney negative amount produces "-$X.XX"

    @Test
    fun formatMoney_negative_exactFormat() {
        assertEquals("-\$10.00", formatMoney(-10.0))
    }

    // H3: formatMoney zero

    @Test
    fun formatMoney_zero_exactFormat() {
        assertEquals("\$0.00", formatMoney(0.0))
    }

    @Test
    fun formatMoney_wholeNumber() {
        assertEquals("\$100.00", formatMoney(100.0))
    }

    @Test
    fun formatMoney_fractional() {
        assertEquals("\$12.34", formatMoney(12.34))
    }

    @Test
    fun formatMoney_zero() {
        assertEquals("\$0.00", formatMoney(0.0))
    }

    @Test
    fun formatMoney_negative() {
        assertEquals("-\$5.50", formatMoney(-5.5))
    }

    @Test
    fun formatMoney_singleDigitCents() {
        assertEquals("\$1.05", formatMoney(1.05))
    }
}
