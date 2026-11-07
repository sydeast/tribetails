package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Invoices list order.
 *
 * There was no test here before, and the sort was written as an inline lambda
 * inside the `@Composable` so there could not be one. It read
 * `isoDatePrefixOrNull(it.date) ?: isoDatePrefixOrNull(it.dueDate) ?: ""`, over a
 * helper that took the first ten characters and accepted them if positions 4 and
 * 7 were dashes, checking nothing else. That is the Android half of the same
 * root cause as the web admin's "Last 30 days" window returning six-month-old
 * invoices: a `date` field that is unvalidated free text, compared as a string.
 */
class InvoiceSortTest {

    private fun inv(id: String, date: String = "", dueDate: String = "") =
        Invoice(id = id, date = date, dueDate = dueDate)

    @Test
    fun ordersRealDatesNewestFirst() {
        val out = invoicesByDateDesc(
            listOf(inv("old", "2026-02-12"), inv("new", "2026-08-01"), inv("mid", "2026-07-30")),
        )
        assertEquals(listOf("new", "mid", "old"), out.map { it.id })
    }

    /**
     * #1570: a month-name date is placed by the day it names, the same grammar
     * the backfill (mytribe/scripts/backfillInvoiceDateIso.ts) rewrites, because
     * the current import produces it. A numeric date names two different days,
     * so it stays unplaceable and sorts last.
     */
    @Test
    fun aMonthNameDateIsPlacedByTheDayItNames() {
        assertEquals(true, invoiceSortDayOrNull(inv("legacy", "Feb 12, 2026")) != null)
        val out = invoicesByDateDesc(listOf(inv("dated", "2026-01-01"), inv("legacy", "Feb 12, 2026")))
        assertEquals(listOf("legacy", "dated"), out.map { it.id })
        assertNull(invoiceSortDayOrNull(inv("numeric", "02/12/2026")))
        val withNumeric = invoicesByDateDesc(listOf(inv("numeric", "02/12/2026"), inv("dated", "2026-01-01")))
        assertEquals(listOf("dated", "numeric"), withNumeric.map { it.id })
    }
    /**
     * THE OTHER HALF OF THE BUG, and the one that actually reordered the list.
     * The old shape test never checked that the eight non-dash characters were
     * digits, so a string of letters passed, and letters outrank digits in a
     * string comparison, so it landed at the TOP of a descending sort.
     */
    @Test
    fun lettersInDatePositionsNoLongerOutrankEveryRealDate() {
        val out = invoicesByDateDesc(
            listOf(inv("garbage", "abcd-ef-ghij"), inv("real", "2026-08-01")),
        )
        assertEquals("real", out.first().id)
        assertNull(invoiceSortDayOrNull(inv("x", "abcd-ef-ghij")))
    }

    @Test
    fun refusesAnImpossibleDayRatherThanRollingItIntoTheNextMonth() {
        assertNull(invoiceSortDayOrNull(inv("x", "2026-02-30")))
        assertNull(invoiceSortDayOrNull(inv("x", "2026-13-01")))
    }

    @Test
    fun fallsBackToDueDateWhenTheInvoiceDateIsUnusable() {
        assertEquals(
            java.time.LocalDate.parse("2026-08-01").toEpochDay(),
            invoiceSortDayOrNull(inv("x", date = "Net 14", dueDate = "2026-08-01")),
        )
    }

    @Test
    fun readsAnIsoInstantByItsDay() {
        assertEquals(
            java.time.LocalDate.parse("2026-06-07").toEpochDay(),
            invoiceSortDayOrNull(inv("x", "2026-06-07T12:00:00Z")),
        )
    }

    @Test
    fun undatedRowsSortLastAndKeepTheOrderTheyArrivedIn() {
        val out = invoicesByDateDesc(
            listOf(inv("a"), inv("b"), inv("dated", "2026-01-01"), inv("c")),
        )
        assertEquals(listOf("dated", "a", "b", "c"), out.map { it.id })
    }
}
