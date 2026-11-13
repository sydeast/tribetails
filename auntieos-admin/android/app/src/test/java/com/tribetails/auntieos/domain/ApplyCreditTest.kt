package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1872: the amount box for applying account credit to an invoice. The server
 * makes every one of these checks again; these are the words she reads under
 * the field before the round trip, the same words as the web admin.
 */
class ApplyCreditTest {

    private fun parse(text: String, available: Long = 12000L, due: Long? = 10000L) =
        parseApplyCreditAmount(text, available, due)

    private fun refusal(text: String, available: Long = 12000L, due: Long? = 10000L): String =
        (parse(text, available, due) as ApplyCreditForm.Invalid).message

    @Test
    fun `accepts an amount within both limits`() {
        assertEquals(ApplyCreditForm.Ready(2500L), parse("25.00"))
        assertEquals(ApplyCreditForm.Ready(2500L), parse("25"))
    }

    @Test
    fun `accepts exactly what the invoice owes and exactly what the household holds`() {
        assertEquals(ApplyCreditForm.Ready(10000L), parse("100.00"))
        assertEquals(ApplyCreditForm.Ready(5000L), parse("50.00", available = 5000L))
    }

    @Test
    fun `refuses a blank box, text and more than two decimals`() {
        for (raw in listOf("", "   ", "abc", "12.345", "1e3")) {
            assertEquals(raw, "Enter an amount in dollars, like 25.00.", refusal(raw))
        }
    }

    @Test
    fun `refuses zero`() {
        assertEquals("Enter an amount above \$0.00.", refusal("0"))
        assertEquals("Enter an amount above \$0.00.", refusal("0.00"))
    }

    @Test
    fun `refuses a negative amount`() {
        assertTrue(parse("-5") is ApplyCreditForm.Invalid)
    }

    @Test
    fun `refuses more than the household holds and says how much that is`() {
        assertEquals(
            "This household has \$20.00 of account credit. Enter that much or less.",
            refusal("20.01", available = 2000L),
        )
    }

    @Test
    fun `refuses more than the invoice owes and says how much that is`() {
        assertEquals("This invoice has \$100.00 left to pay. Enter that much or less.", refusal("100.01"))
    }

    @Test
    fun `leaves the invoice limit to the server when the balance could not be read`() {
        assertEquals(ApplyCreditForm.Ready(11000L), parse("110.00", due = null))
    }

    @Test
    fun `names the invoice by its number, never by a stored id`() {
        assertEquals("invoice 1026", applyCreditInvoiceWords("1026"))
        assertEquals("this invoice", applyCreditInvoiceWords(""))
        assertEquals("this invoice", applyCreditInvoiceWords("  "))
        assertEquals("this invoice", applyCreditInvoiceWords(null))
    }

    @Test
    fun `the confirmation states the amount, the invoice and both balances afterwards`() {
        assertEquals(
            "Apply \$25.00 of account credit to invoice 1026? The invoice will have \$75.00 left to pay. " +
                "The household keeps \$95.00 of credit.",
            applyCreditConfirmText(2500L, "1026", 12000L, 10000L),
        )
    }

    @Test
    fun `the confirmation says the invoice will be paid when the amount covers it`() {
        assertEquals(
            "Apply \$100.00 of account credit to invoice 1026? The invoice will be paid. " +
                "The household keeps \$20.00 of credit.",
            applyCreditConfirmText(10000L, "1026", 12000L, 10000L),
        )
    }

    @Test
    fun `the confirmation makes no claim about a balance it could not read`() {
        assertEquals(
            "Apply \$25.00 of account credit to this invoice? The household keeps \$95.00 of credit.",
            applyCreditConfirmText(2500L, "", 12000L, null),
        )
    }

    @Test
    fun `the notice afterwards repeats the server figures`() {
        assertEquals(
            "Applied \$25.00 of account credit to invoice 1026. \$75.00 is left to pay. " +
                "The household has \$95.00 of credit left.",
            creditAppliedText(2500L, 7500L, 9500L, "1026"),
        )
        assertEquals(
            "Applied \$100.00 of account credit to invoice 1026. The invoice is paid. " +
                "The household has \$20.00 of credit left.",
            creditAppliedText(10000L, 0L, 2000L, "1026"),
        )
    }

    @Test
    fun `says what is available, or that there is none`() {
        assertEquals("\$12.00 available", availableCreditLine(1200L))
        assertEquals("This household has no account credit.", availableCreditLine(0L))
    }

    // ── Where the box is offered ────────────────────────────────────────────────

    @Test
    fun `an open invoice offers the box`() {
        assertTrue(applyCreditOffered(Invoice(status = "open", amountDue = 40.0)))
    }

    @Test
    fun `a draft, a quote, a paid invoice and a cancelled one do not`() {
        for (status in listOf("draft", "quote", "paid", "cancelled", "credit", "")) {
            assertFalse(status, applyCreditOffered(Invoice(status = status, amountDue = 40.0)))
        }
    }

    @Test
    fun `an archived invoice does not, even while it is open and owed`() {
        assertFalse(applyCreditOffered(Invoice(status = "open", amountDue = 40.0, archivedAt = "2026-11-06")))
    }

    @Test
    fun `the amount owed comes from the ledger first, then the invoice, and is null when neither says`() {
        assertEquals(2750L, applyCreditDueCents(2750L, Invoice(amountDueCents = 10000L)))
        assertEquals(10000L, applyCreditDueCents(null, Invoice(amountDueCents = 10000L)))
        assertNull(applyCreditDueCents(null, Invoice()))
    }
}
