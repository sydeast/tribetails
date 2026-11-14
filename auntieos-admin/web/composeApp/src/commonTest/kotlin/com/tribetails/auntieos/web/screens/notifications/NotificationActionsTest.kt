package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure logic for the notification quick actions (Stage 2 Step 4): the archived
 * filter, the read/unread state off readAt, and which actions apply per target.
 */
class NotificationActionsTest {

    @Test
    fun activeFiltersOutArchived() {
        val all = listOf(
            NotificationEntry(_id = "a", archivedAt = ""),
            NotificationEntry(_id = "b", archivedAt = "2026-06-05T10:00:00Z"),
            NotificationEntry(_id = "c", archivedAt = ""),
        )
        assertEquals(listOf("a", "c"), activeNotifications(all).map { it._id })
    }

    @Test
    fun readStateDrivenByReadAt() {
        assertFalse(notificationIsRead(NotificationEntry(readAt = "")))
        assertTrue(notificationIsRead(NotificationEntry(readAt = "2026-06-05T10:00:00Z")))
    }

    @Test
    fun unreadOffersMarkReadNotMarkUnread() {
        val actions = applicableActions(NotificationEntry(readAt = ""))
        assertTrue(NotificationAction.MarkRead in actions)
        assertFalse(NotificationAction.MarkUnread in actions)
    }

    @Test
    fun readOffersMarkUnreadNotMarkRead() {
        val actions = applicableActions(NotificationEntry(readAt = "2026-06-05T10:00:00Z"))
        assertTrue(NotificationAction.MarkUnread in actions)
        assertFalse(NotificationAction.MarkRead in actions)
    }

    @Test
    fun archiveAlwaysAvailable() {
        assertTrue(NotificationAction.Archive in applicableActions(NotificationEntry()))
    }

    /**
     * #1592: the stat strip counts rows waiting on a decision, the same rows
     * [applicableActions] offers Approve/Deny on, instead of "Dispatched".
     */
    @Test
    fun needsDecisionCountsOnlyTheRowsOfferedApproveAndDeny() {
        val household = kotlinx.serialization.json.buildJsonObject {
            put("kinfolkId", kotlinx.serialization.json.JsonPrimitive("kf1"))
        }
        val waiting = NotificationEntry(_id = "w", key = "kincare.requested", targetType = "booking", targetId = "bk1", data = household)
        val confirmation = NotificationEntry(_id = "c", key = "kincare.booking.confirm", targetType = "booking", targetId = "bk2", data = household)
        val dispatched = NotificationEntry(_id = "d", key = "invoice.new", status = "dispatched")
        assertEquals(1, needsDecisionCount(listOf(waiting, confirmation, dispatched), setOf("kf1/bk1")))
        assertEquals(0, needsDecisionCount(emptyList(), setOf("kf1/bk1")))
        // #2069: while the queue is unknown, nothing is counted as waiting.
        assertEquals(0, needsDecisionCount(listOf(waiting), null))
    }
    @Test
    fun bookingTargetOffersApproveDenyAndOpen() {
        val actions = applicableActions(
            NotificationEntry(key = "kincare.requested", targetType = "booking", targetId = "bk1", data = kotlinx.serialization.json.buildJsonObject { put("kinfolkId", kotlinx.serialization.json.JsonPrimitive("kf1")) }),
            setOf("kf1/bk1"),
        )
        assertTrue(NotificationAction.ApproveBooking in actions)
        assertTrue(NotificationAction.DenyBooking in actions)
        assertTrue(NotificationAction.OpenTarget in actions)
    }

    @Test
    fun invoiceTargetOffersOpenButNotApproveDeny() {
        val actions = applicableActions(
            NotificationEntry(targetType = "invoice", targetId = "inv1"),
        )
        assertTrue(NotificationAction.OpenTarget in actions)
        assertFalse(NotificationAction.ApproveBooking in actions)
        assertFalse(NotificationAction.DenyBooking in actions)
    }

    @Test
    fun kinfolkTargetOffersCreateQuote() {
        val kf = applicableActions(NotificationEntry(targetType = "kinfolk", targetId = "kf1"))
        assertTrue(NotificationAction.CreateQuote in kf)
        // non-kinfolk target + blank id never offer CreateQuote (no kinfolk to seed)
        assertFalse(NotificationAction.CreateQuote in applicableActions(NotificationEntry(targetType = "invoice", targetId = "inv1")))
        assertFalse(NotificationAction.CreateQuote in applicableActions(NotificationEntry(targetType = "kinfolk", targetId = "")))
    }

    @Test
    fun blankTargetIdOffersNoOpen() {
        val actions = applicableActions(
            NotificationEntry(targetType = "invoice", targetId = ""),
        )
        assertFalse(NotificationAction.OpenTarget in actions)
    }

    @Test
    fun unknownTargetTypeOffersNoOpen() {
        val actions = applicableActions(
            NotificationEntry(targetType = "spaceship", targetId = "x1"),
        )
        assertFalse(NotificationAction.OpenTarget in actions)
        assertFalse(NotificationAction.ApproveBooking in actions)
    }

    @Test
    fun bookingTargetTypeIsCaseInsensitive() {
        val actions = applicableActions(
            NotificationEntry(key = "kincare.requested", targetType = "Booking", targetId = "bk1", data = kotlinx.serialization.json.buildJsonObject { put("kinfolkId", kotlinx.serialization.json.JsonPrimitive("kf1")) }),
            setOf("kf1/bk1"),
        )
        assertTrue(NotificationAction.ApproveBooking in actions)
    }

    // #706 on this build: a booking row that is not a waiting request (a
    // confirmation, a reschedule or cancellation ask) offers no Approve/Deny.
    @Test
    fun onlyAPendingRequestOffersApproveDeny() {
        for (key in listOf(
            "kincare.booking.confirm",
            "kincare.booking.cancel",
            "kincare.request.declined",
            "kincare.reschedule.requested",
            "kincare.cancel.requested",
            "",
        )) {
            val actions = applicableActions(NotificationEntry(key = key, targetType = "booking", targetId = "bk1"))
            assertFalse(NotificationAction.ApproveBooking in actions, "Approve on $key")
            assertFalse(NotificationAction.DenyBooking in actions, "Deny on $key")
            assertTrue(NotificationAction.OpenTarget in actions, "Open on $key")
        }
    }

    // #1647: a request booked or declined anywhere stops offering a decision and
    // names its outcome.
    @Test
    fun answeredRequestOffersNoApproveDenyAndNamesItsOutcome() {
        for ((stamp, label) in listOf(
            "booked" to "Booked",
            "declined" to "Declined",
            "cancelled" to "Cancelled",
            "BOOKED" to "Booked",
            "something-new" to "Answered",
        )) {
            val entry = NotificationEntry(
                key = "kincare.requested",
                targetType = "booking",
                targetId = "req_1",
                requestResolution = stamp,
            )
            val actions = applicableActions(entry)
            assertFalse(NotificationAction.ApproveBooking in actions, "Approve on $stamp")
            assertFalse(NotificationAction.DenyBooking in actions, "Deny on $stamp")
            assertEquals(label, requestOutcomeLabel(entry))
        }
    }

    @Test
    fun waitingRequestHasNoOutcome() {
        val waiting = NotificationEntry(key = "kincare.requested", targetType = "booking", targetId = "req_1", data = kotlinx.serialization.json.buildJsonObject { put("kinfolkId", kotlinx.serialization.json.JsonPrimitive("kf1")) })
        assertNull(requestOutcomeLabel(waiting))
        assertNull(requestOutcomeLabel(waiting.copy(requestResolution = "  ")))
        assertTrue(NotificationAction.ApproveBooking in applicableActions(waiting.copy(requestResolution = "  "), setOf("kf1/req_1")))
        // The stamp means nothing on another key.
        assertNull(requestOutcomeLabel(waiting.copy(key = "kincare.booking.confirm", requestResolution = "booked")))
    }

    // #1675: Approve/Deny answer the request by household and request id, so a
    // request row that names no household offers neither.
    @Test
    fun waitingRequestWithNoHouseholdOffersNoApproveDeny() {
        val anonymous = NotificationEntry(key = "kincare.requested", targetType = "booking", targetId = "req_1")
        assertEquals("", notificationRequestKinfolkId(anonymous))
        assertFalse(NotificationAction.ApproveBooking in applicableActions(anonymous))
        assertFalse(NotificationAction.DenyBooking in applicableActions(anonymous))
    }
    @Test
    fun theHouseholdComesOffTheRowData() {
        assertEquals("kf1", notificationRequestKinfolkId(NotificationEntry(data = kotlinx.serialization.json.buildJsonObject { put("kinfolkId", kotlinx.serialization.json.JsonPrimitive("kf1")) })))
        val legacy = NotificationEntry(
            data = kotlinx.serialization.json.buildJsonObject { put("familyId", kotlinx.serialization.json.JsonPrimitive("fam9")) },
        )
        assertEquals("fam9", notificationRequestKinfolkId(legacy))
    }
}
