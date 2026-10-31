package com.tribetails.auntieos.ui.admin
import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Test
/**
 * The invoice list tabs against one fixture set. The desktop console's
 * `InvoiceFilterTest` and the web's `Invoices.test.tsx` carry the same fixture
 * and the same expectations, so the three clients stay aligned.
 */
class InvoiceFilterTest {
    private val today = "2026-10-23"
    private val past = "2000-01-01"
    private val future = "2999-01-01"
    private val fixture = listOf(
        Invoice(id = "Q", status = "quote", dueDate = past),
        Invoice(id = "D", status = "draft", dueDate = past),
        Invoice(id = "X", status = "cancelled", dueDate = past),
        Invoice(id = "CR", status = "credit"),
        Invoice(id = "RD", status = "redeemed"),
        Invoice(id = "P", status = "paid", dueDate = past),
        Invoice(id = "Z", status = "zero"),
        Invoice(id = "O", status = "open", dueDate = future),
        Invoice(id = "OD", status = "open", dueDate = past),
        Invoice(id = "U", status = "sent"),
    )
    private fun members(filter: InvoiceFilter) =
        fixture.filter { matchesFilter(it, filter, today) }.map { it.id }
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
        val inv = Invoice(id = "T", status = "open", dueDate = today)
        assertEquals(false, matchesFilter(inv, InvoiceFilter.Overdue, today))
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
    fun statusIsReadCaseInsensitively() {
        assertEquals(true, matchesFilter(Invoice(id = "a", status = "QUOTE"), InvoiceFilter.Quote, today))
        assertEquals(true, matchesFilter(Invoice(id = "b", status = " Credit "), InvoiceFilter.Credit, today))
    }
}
