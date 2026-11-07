package com.tribetails.auntieos.web.screens.invoices
import com.tribetails.auntieos.web.data.Invoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/**
 * #1570: the walk's #1018 was OPEN with `dueDate = "July 14, 2026"` and never
 * read as overdue. Same fixtures as the server, web and Android readers.
 */
class InvoiceUnreadableDueDateTest {
    private val walkDay = "2026-11-05"
    private fun open(dueDate: String, name: String = "Loretta") = Invoice(
        _id = "i-$dueDate",
        invoiceNumber = "1018",
        kinfolkName = name,
        status = "open",
        total = 40.0,
        amountDue = 40.0,
        date = "2026-06-14",
        dueDate = dueDate,
    )
    @Test
    fun `reads a day, an instant and the imported month-name form`() {
        assertEquals("2026-07-14", invoiceDayOrNull("2026-07-14"))
        assertEquals("2026-07-14", invoiceDayOrNull(" 2026-07-14T23:59:00.000Z "))
        assertEquals("2026-07-14", invoiceDayOrNull("July 14, 2026"))
        assertEquals("2026-07-14", invoiceDayOrNull("Jul 14 2026"))
        assertEquals("2026-07-04", invoiceDayOrNull("jul 4, 2026"))
        // The backfill script refuses the dotted short form, so the readers do too.
        assertEquals(null, invoiceDayOrNull("Jul. 4, 2026"))
        assertEquals("2025-09-01", invoiceDayOrNull("September 1, 2025"))
        assertEquals("2024-02-29", invoiceDayOrNull("Feb 29, 2024"))
    }
    @Test
    fun `refuses impossible, ambiguous and non-date text`() {
        for (raw in listOf("February 30, 2026", "Feb 29, 2026", "Jun 31, 2026", "07/14/2026", "Net 14", "Ju 14, 2026", "")) {
            assertNull(invoiceDayOrNull(raw), raw)
        }
    }
    @Test
    fun `the walk invoice is overdue and its row says how long`() {
        assertTrue(invoiceIsOverdue(open("July 14, 2026"), walkDay))
        assertEquals("114 days overdue", invoiceRowDateLine(open("July 14, 2026"), walkDay))
        assertEquals("Jul 14", humanizeDate("July 14, 2026"))
    }
    @Test
    fun `an unreadable due date is flagged on the row and counted on the Overdue card`() {
        assertTrue(isUnreadableDueDate("07/14/2026"))
        assertFalse(isUnreadableDueDate("  "))
        assertEquals("due date cannot be read: \"07/14/2026\"", invoiceRowDateLine(open("07/14/2026"), walkDay))
        assertEquals("all clear", overdueCaptionFor(listOf(open("2026-12-01")), walkDay))
        assertEquals("1 open invoice has a due date that cannot be read", overdueCaptionFor(listOf(open("Net 14")), walkDay))
        assertEquals(
            "Loretta, 114 days past. 2 open invoices have due dates that cannot be read",
            overdueCaptionFor(listOf(open("July 14, 2026"), open("Net 14", "A"), open("07/14/2026", "B")), walkDay),
        )
        assertEquals(0, unreadableDueOpenCount(listOf(open("Net 14").copy(status = "paid", amountDue = 0.0))))
    }
}
