package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.InvoiceLineItem
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.domain.resolveDueDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #1593 on the Android New invoice composer, pure: a typed due date before the
 * invoice date, the blank path's typed total, and where a money refusal is
 * shown. The sentences are the server's and the other two clients', word for
 * word.
 */
class InvoiceDueDateCheckTest {

    private val priced = ComposerMoney(
        lines = listOf(InvoiceLineItem("Dog walk", 1.0, 2500L)),
        invoiceDiscountCents = 0L,
        totalCents = 2500L,
        error = null,
    )

    private fun blocked(
        path: InvoiceCreatePath = InvoiceCreatePath.WORK,
        termsCode: InvoiceTermsCode = InvoiceTermsCode.CUSTOM,
        date: String = "2026-11-05",
        customDueDate: String = "",
        money: ComposerMoney? = priced,
        totalText: String = "",
    ) = composerBlockedReason(
        kinfolkId = "kf1",
        path = path,
        termsCode = termsCode,
        due = resolveDueDate(termsCode, date, listOf("2026-11-01"), "2026-11-05"),
        date = date,
        customDueDate = customDueDate,
        selectedCount = 1,
        draftCount = 0,
        money = money,
        totalText = totalText,
    )

    // ── the rule itself ───────────────────────────────────────────────────────

    @Test
    fun `the sentence is the server's, word for word`() {
        assertEquals("The due date has to be on or after the invoice date.", DUE_BEFORE_INVOICE_DATE)
    }

    @Test
    fun `a due date on or after the invoice date passes`() {
        assertNull(dueDateOrderProblem("2026-11-05", "2026-11-05", "custom"))
        assertNull(dueDateOrderProblem("2026-11-05", "2026-12-01", null))
    }

    @Test
    fun `a typed due date before the invoice date is refused, with no code or custom`() {
        assertEquals(DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem("2026-11-05", "2026-11-04", "custom"))
        assertEquals(DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem("2026-11-05", "2026-11-04", null))
        assertEquals(DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem("2026-11-05", "2026-11-04", ""))
    }

    @Test
    fun `structured terms, a blank and a free-text date are not judged`() {
        assertNull(dueDateOrderProblem("2026-11-05", "2026-11-04", "net_14"))
        assertNull(dueDateOrderProblem("2026-11-05", "", "custom"))
        assertNull(dueDateOrderProblem("", "2026-11-04", "custom"))
        assertNull(dueDateOrderProblem("2026-11-05", "Nov 4", "custom"))
    }

    // ── the create button ─────────────────────────────────────────────────────

    @Test
    fun `a custom due date before the invoice date holds Create back on the work path`() {
        assertEquals(DUE_BEFORE_INVOICE_DATE, blocked(customDueDate = "2026-11-04"))
    }

    @Test
    fun `and on the blank path, even with a good total`() {
        assertEquals(
            DUE_BEFORE_INVOICE_DATE,
            blocked(path = InvoiceCreatePath.BLANK, money = null, totalText = "40", customDueDate = "2026-11-01"),
        )
    }

    @Test
    fun `a custom due date on the invoice date lets Create run`() {
        assertNull(blocked(customDueDate = "2026-11-05"))
        assertNull(blocked(customDueDate = "2026-11-30"))
    }

    @Test
    fun `a stale custom date is not judged once structured terms are picked`() {
        assertNull(blocked(termsCode = InvoiceTermsCode.DUE_ON_RECEIPT, customDueDate = "2026-01-01"))
    }

    // ── the blank path total ──────────────────────────────────────────────────

    @Test
    fun `the blank total sentence matches web and the desktop console`() {
        assertEquals("Enter the total as dollars, zero or more, like 120.00.", BLANK_TOTAL_PROBLEM)
    }

    @Test
    fun `letters, a negative and a blank total are refused`() {
        assertEquals(BLANK_TOTAL_PROBLEM, blankTotalProblem("abc"))
        assertEquals(BLANK_TOTAL_PROBLEM, blankTotalProblem("-5"))
        assertEquals(BLANK_TOTAL_PROBLEM, blankTotalProblem(""))
        assertEquals(
            BLANK_TOTAL_PROBLEM,
            blocked(path = InvoiceCreatePath.BLANK, termsCode = InvoiceTermsCode.DUE_ON_RECEIPT, money = null, totalText = "12x"),
        )
    }

    @Test
    fun `a total in dollars, zero included, passes`() {
        assertNull(blankTotalProblem("120.00"))
        assertNull(blankTotalProblem("0"))
        assertNull(blocked(path = InvoiceCreatePath.BLANK, termsCode = InvoiceTermsCode.DUE_ON_RECEIPT, money = null, totalText = "120.00"))
    }

    // ── where a money refusal is shown ────────────────────────────────────────

    @Test
    fun `a discount larger than the subtotal is refused, and belongs under the whole-invoice discount`() {
        val money = composerMoney(
            sessions = emptyList(),
            selected = emptySet(),
            prices = emptyMap(),
            drafts = listOf(ComposerDraftLine("Mileage", "1", "25.00")),
            invoiceDiscountText = "77",
        )
        assertNull(money.lines)
        assertEquals("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", money.error)
        assertEquals(money.error, invoiceDiscountProblemOf(money.error))
        assertNull(lineDiscountProblemOf(money.error, "Mileage"))
    }

    @Test
    fun `letters in the discount belong under the whole-invoice discount too`() {
        val money = composerMoney(emptyList(), emptySet(), emptyMap(), listOf(ComposerDraftLine("Mileage", "1", "25")), "ten")
        assertEquals("Invoice discount needs a dollar amount, or leave it empty.", invoiceDiscountProblemOf(money.error))
    }

    @Test
    fun `a line discount larger than its line belongs under that line`() {
        val money = composerMoney(
            emptyList(),
            emptySet(),
            emptyMap(),
            listOf(ComposerDraftLine("Mileage", "1", "25"), ComposerDraftLine("Bath", "1", "10")),
            "",
        )
        assertNull(money.error)
        val bad = composerMoney(emptyList(), emptySet(), emptyMap(), listOf(ComposerDraftLine("Mileage", "1", "25", "30")), "")
        assertEquals("Discount for \"Mileage\" (\$30.00) is larger than the line itself (\$25.00).", bad.error)
        assertEquals(bad.error, lineDiscountProblemOf(bad.error, "Mileage"))
        assertNull(lineDiscountProblemOf(bad.error, "Bath"))
        assertNull(invoiceDiscountProblemOf(bad.error))
    }

    @Test
    fun `a sound discount is no refusal anywhere`() {
        val money = composerMoney(emptyList(), emptySet(), emptyMap(), listOf(ComposerDraftLine("Mileage", "1", "25")), "5")
        assertNull(money.error)
        assertEquals(2000L, money.totalCents)
        assertNull(invoiceDiscountProblemOf(money.error))
        assertNull(lineDiscountProblemOf(money.error, "Mileage"))
    }
}
