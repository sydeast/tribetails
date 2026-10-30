package com.tribetails.auntieos.web.screens.invoices
import com.tribetails.auntieos.web.data.Invoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/**
 * The invoice list tabs against one fixture set. Android's `InvoiceFilterTest`
 * and the web's `Invoices.test.tsx` carry the same fixture and the same
 * expectations, so the three clients stay aligned.
 */
class InvoiceFilterTest {
    private val today = "2026-10-23"
    private val past = "2000-01-01"
    private val future = "2999-01-01"
    private val fixture = listOf(
        Invoice(_id = "Q", status = "quote", dueDate = past),
        Invoice(_id = "D", status = "draft", dueDate = past),
        Invoice(_id = "X", status = "cancelled", dueDate = past),
        Invoice(_id = "CR", status = "credit"),
        Invoice(_id = "RD", status = "redeemed"),
        Invoice(_id = "P", status = "paid", dueDate = past),
        Invoice(_id = "Z", status = "zero"),
        Invoice(_id = "O", status = "open", dueDate = future),
        Invoice(_id = "OD", status = "open", dueDate = past),
        Invoice(_id = "U", status = "sent"),
    )
    private fun members(filter: InvoiceFilter) =
        fixture.filter { invoiceMatchesFilter(it, filter, today) }.map { it._id }
    @Test
    fun tabsAreTheWebSetInOrder() {
        assertEquals(
            listOf("All", "Open", "Overdue", "Paid", "Draft", "Quote", "Credit"),
            InvoiceFilter.entries.map { it.label },
        )
    }
    @Test
    fun allShowsEveryRowIncludingUnstamped() =
        assertEquals(listOf("Q", "D", "X", "CR", "RD", "P", "Z", "O", "OD", "U"), members(InvoiceFilter.All))
    @Test
    fun openIsStoredOpenOnly() = assertEquals(listOf("O", "OD"), members(InvoiceFilter.Open))
    @Test
    fun overdueIsOpenWithPastDueDateOnly() = assertEquals(listOf("OD"), members(InvoiceFilter.Overdue))
    @Test
    fun dueTodayIsNotOverdue() {
        val inv = Invoice(_id = "T", status = "open", dueDate = today)
        assertFalse(invoiceMatchesFilter(inv, InvoiceFilter.Overdue, today))
    }
    @Test
    fun paidIsStoredPaidOnly() = assertEquals(listOf("P"), members(InvoiceFilter.Paid))
    @Test
    fun draftIsStoredDraftOnly() = assertEquals(listOf("D"), members(InvoiceFilter.Draft))
    @Test
    fun quoteIsStoredQuoteOnly() = assertEquals(listOf("Q"), members(InvoiceFilter.Quote))
    @Test
    fun creditTakesCreditAndRedeemed() = assertEquals(listOf("CR", "RD"), members(InvoiceFilter.Credit))
    @Test
    fun amountDueDoesNotDecideMembership() {
        // The old desktop Unpaid/Paid tabs read amountDue; the stored state decides now.
        val openZeroBalance = Invoice(_id = "a", status = "open", amountDue = 0.0)
        val paidWithBalance = Invoice(_id = "b", status = "paid", amountDue = 25.0)
        assertTrue(invoiceMatchesFilter(openZeroBalance, InvoiceFilter.Open, today))
        assertFalse(invoiceMatchesFilter(paidWithBalance, InvoiceFilter.Open, today))
        assertTrue(invoiceMatchesFilter(paidWithBalance, InvoiceFilter.Paid, today))
    }
}
