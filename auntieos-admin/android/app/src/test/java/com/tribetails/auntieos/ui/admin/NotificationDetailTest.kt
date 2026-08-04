package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationDetail
import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The display half of the R5 card detail, Android side.
 *
 * Operator ruling R5, 2026-08-03, verbatim: "I see the A KinCare visit was
 * assigned and the CTAs for the workflow but I do not see the KinCare/Booking
 * details. Who requested, For which kinfolk, what date, what time, wheres the
 * notes." One assertion per question, because that list is the acceptance
 * criterion.
 *
 * The RESOLUTION half is server-side
 * (mytribe/functions/src/notifications/buildNotificationDetail.ts) and has its
 * own tests. Nothing here resolves anything, which is as much the property under
 * test as any assertion below: an admin can read the `families/{id}/bookings` subtree and
 * a recipient kinfolk cannot, so a client-side resolution would make the two
 * surfaces disagree about the same notification.
 */
class NotificationDetailTest {

    private fun entry(detail: NotificationDetail?) =
        NotificationEntry(id = "n1", key = "assignment.assigned", detail = detail)

    private val full = NotificationDetail(
        requestedBy = "Dana Ruiz",
        kinfolkName = "The Rivera Home",
        kinName = "Rex",
        serviceType = "Drop-in visit",
        bookingDate = "Mon, Jun 15",
        bookingTime = "2:30 PM",
        notes = "Gate code is 4417.",
    )

    @Test
    fun rowsAnswerTheOperatorsQuestionsInTheOperatorsOrder() {
        val rows = notificationDetailRows(entry(full))
        // Field ORDER is the assertion, not just membership: the card reads as an
        // answer to "who, for whom, what, when" and a shuffled order is a dump.
        assertEquals(
            listOf("Requested by", "Household", "Kin", "Service", "Date", "Time", "Notes"),
            rows.map { it.first },
        )
        assertEquals(
            listOf(
                "Dana Ruiz",
                "The Rivera Home",
                "Rex",
                "Drop-in visit",
                "Mon, Jun 15",
                "2:30 PM",
                "Gate code is 4417.",
            ),
            rows.map { it.second },
        )
    }

    @Test
    fun rowsRenderInvoiceFiguresForAnInvoiceClassNotification() {
        val rows = notificationDetailRows(
            entry(NotificationDetail(invoiceNumber = "TT-1001", amount = "$120.00", dueDate = "Jul 5, 2026")),
        )
        assertEquals(listOf("Invoice", "Amount", "Due"), rows.map { it.first })
    }

    @Test
    fun rowsDropBlankFieldsRatherThanPrintingALabelledBlank() {
        val rows = notificationDetailRows(
            entry(NotificationDetail(kinName = "Rex", bookingDate = "", notes = "   ")),
        )
        assertEquals(listOf("Kin"), rows.map { it.first })
    }

    /**
     * A card with no rows shows no disclosure control at all: a control that
     * opens onto an empty box is worse than no control, the same rule
     * `applicableNotificationActions` applies to the Open CTA.
     */
    @Test
    fun rowsAreEmptyWhenTheServerResolvedNothing() {
        assertTrue(notificationDetailRows(entry(null)).isEmpty())
        assertTrue(notificationDetailRows(entry(NotificationDetail())).isEmpty())
    }

    @Test
    fun summaryIsKinDateTime() {
        assertEquals("Rex · Mon, Jun 15 · 2:30 PM", notificationDetailSummary(entry(full)))
    }

    /**
     * The household is deliberately absent from the summary: the row already
     * prints it as its own accent-coloured context line, and repeating it would
     * push the distinguishing values off the end of a one-line summary.
     */
    @Test
    fun summaryLeavesTheHouseholdOutBecauseTheRowAlreadyShowsIt() {
        assertEquals(
            "Rex",
            notificationDetailSummary(
                entry(NotificationDetail(kinfolkName = "The Rivera Home", kinName = "Rex")),
            ),
        )
    }

    @Test
    fun summaryJoinsOnlyWhatResolvedWithNoDanglingSeparators() {
        assertEquals(
            "Rex · 2:30 PM",
            notificationDetailSummary(entry(NotificationDetail(kinName = "Rex", bookingTime = "2:30 PM"))),
        )
        assertEquals(
            "Mon, Jun 15",
            notificationDetailSummary(entry(NotificationDetail(bookingDate = "Mon, Jun 15"))),
        )
    }

    @Test
    fun summaryIsEmptyWhenThereIsNothingWorthSummarising() {
        assertEquals("", notificationDetailSummary(entry(null)))
        assertEquals("", notificationDetailSummary(entry(NotificationDetail(requestedBy = "Dana Ruiz"))))
    }

    /**
     * PARITY WITH WEB. `lib/notificationDetail.ts` builds the same rows in the
     * same order from the same fields; two clients disagreeing about what a
     * notification says would be a worse bug than the one R5 fixed, because it
     * would only show up when someone compared a phone to a browser.
     */
    @Test
    fun labelsMatchTheWebBuildExactly() {
        val everyField = NotificationDetail(
            requestedBy = "a", kinfolkName = "b", kinName = "c", serviceType = "d",
            bookingDate = "e", bookingTime = "f", invoiceNumber = "g", amount = "h",
            dueDate = "i", notes = "j",
        )
        assertEquals(
            listOf(
                "Requested by", "Household", "Kin", "Service", "Date", "Time",
                "Invoice", "Amount", "Due", "Notes",
            ),
            notificationDetailRows(entry(everyField)).map { it.first },
        )
    }
}
