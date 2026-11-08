package com.tribetails.auntieos.ui.admin
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.domain.invoiceDayOrNull
import com.tribetails.auntieos.domain.invoiceIsOverdue
import com.tribetails.auntieos.domain.isUnreadableDueDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
/**
 * #1570: the walk's #1018 was OPEN with `dueDate = "July 14, 2026"` and never
 * read as overdue. The reader's fixtures match the server's
 * (mytribe/functions/test/invoiceDayOf.test.ts) and the web's
 * (src/lib/invoiceFormat.test.ts).
 */
class InvoiceUnreadableDueDateTest {
    private val walkDay = "2026-11-05"
    private fun open(dueDate: String, name: String = "Loretta") =
        Invoice(id = "i-$dueDate", status = "open", kinfolkName = name, date = "2026-06-14", dueDate = dueDate, amountDue = 40.0, total = 40.0)
    @Test
    fun readsADayAnInstantAndTheImportedMonthNameForm() {
        assertEquals("2026-07-14", invoiceDayOrNull("2026-07-14"))
        assertEquals("2026-07-14", invoiceDayOrNull(" 2026-07-14T23:59:00.000Z "))
        assertEquals("2026-07-14", invoiceDayOrNull("July 14, 2026"))
        assertEquals("2026-07-14", invoiceDayOrNull("Jul 14 2026"))
        assertEquals("2026-07-04", invoiceDayOrNull("jul 4, 2026"))
        // The backfill script refuses the dotted short form, so the readers do too.
        assertEquals(null, invoiceDayOrNull("Jul. 4, 2026"))
        assertEquals("2025-09-01", invoiceDayOrNull("September 1, 2025"))
        assertEquals("2025-09-01", invoiceDayOrNull("Sep 1, 2025"))
    }
    @Test
    fun refusesImpossibleAmbiguousAndNonDateText() {
        for (raw in listOf("February 30, 2026", "Jun 31, 2026", "07/14/2026", "14/07/2026", "Net 14", "Ju 14, 2026", "")) {
            assertNull(raw, invoiceDayOrNull(raw))
        }
    }
    @Test
    fun theWalkInvoiceIsOverdueAndItsRowSaysHowLong() {
        assertTrue(invoiceIsOverdue(open("July 14, 2026"), walkDay))
        assertEquals("114 days overdue", invoiceRowDateLine(open("July 14, 2026"), walkDay))
    }
    @Test
    fun anUnreadableDueDateIsFlaggedOnTheRowQuoted() {
        assertTrue(isUnreadableDueDate("07/14/2026"))
        assertFalse(isUnreadableDueDate("  "))
        assertEquals("due date cannot be read: \"07/14/2026\"", invoiceRowDateLine(open("07/14/2026"), walkDay))
        assertFalse(invoiceIsOverdue(open("07/14/2026"), walkDay))
    }
    @Test
    fun theOverdueCardCountsUnreadableDueDatesInsteadOfAllClear() {
        assertEquals("all clear", overdueCaptionFor(listOf(open("2026-12-01")), walkDay))
        assertEquals(
            "1 open invoice has a due date that cannot be read",
            overdueCaptionFor(listOf(open("Net 14")), walkDay),
        )
        assertEquals(
            "Loretta, 114 days past. 2 open invoices have due dates that cannot be read",
            overdueCaptionFor(listOf(open("July 14, 2026"), open("Net 14", "A"), open("07/14/2026", "B")), walkDay),
        )
        // A paid invoice with odd text is not a chase problem and is not counted.
        val paid = open("Net 14").copy(status = "paid", amountDue = 0.0)
        assertEquals(0, unreadableDueOpenCount(listOf(paid)))
    }
}
