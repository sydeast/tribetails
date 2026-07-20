package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Slice 2: pure validation for the Android New-invoice composer. */
class NewInvoiceValidationTest {

    private fun validate(
        kinfolkId: String = "kf1",
        invoiceNumber: String = "INV-1",
        total: String = "100",
        amountDue: String = "100",
        date: String = "",
        dueDate: String = "",
    ) = validateNewInvoice(kinfolkId, invoiceNumber, total, amountDue, date, dueDate)

    @Test
    fun happyPathPasses() {
        assertNull(validate(date = "2026-06-04", dueDate = "2026-07-04"))
    }

    @Test
    fun blankHouseholdFails() {
        assertEquals("Pick a household for this invoice", validate(kinfolkId = ""))
    }

    @Test
    fun blankInvoiceNumberFails() {
        assertEquals("Invoice number is required", validate(invoiceNumber = "   "))
    }

    @Test
    fun negativeTotalFails() {
        assertEquals("Total must be zero or greater", validate(total = "-5"))
    }

    @Test
    fun nonNumericTotalFails() {
        assertEquals("Total must be zero or greater", validate(total = "abc"))
    }

    @Test
    fun negativeAmountDueFails() {
        assertEquals("Amount due must be zero or greater", validate(amountDue = "-0.01"))
    }

    @Test
    fun zeroAmountsArePermitted() {
        assertNull(validate(total = "0", amountDue = "0"))
    }

    @Test
    fun badDateFails() {
        assertEquals("Date must be a real YYYY-MM-DD date", validate(date = "2026-13-01"))
    }

    @Test
    fun badDueDateFails() {
        assertEquals("Due date must be a real YYYY-MM-DD date", validate(dueDate = "2026-02-30"))
    }

    @Test
    fun blankDatesAreAllowed() {
        assertNull(validate(date = "", dueDate = ""))
    }

    @Test
    fun isoDateValidatorRejectsGarbage() {
        assertFalse(isValidNewInvoiceIsoDate("nope"))
        assertFalse(isValidNewInvoiceIsoDate("2026-00-10"))
        assertTrue(isValidNewInvoiceIsoDate("2026-06-04"))
    }
}
