package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.data.repository.IncomingKinCare
import com.tribetails.auntieos.ui.admin.scheduling.groupIncomingBySeries
import com.tribetails.auntieos.ui.admin.scheduling.incomingRequestKey
import com.tribetails.auntieos.ui.admin.scheduling.requestKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2069 (regression of #1647): request notifications from August still offered
 * Approve and Deny on requests long answered, and "Needs a decision" counted 19
 * while Bookings had 5 waiting. #1694 read "no answer stamp" as "still waiting";
 * rows written before the stamp existed were never stamped, and rows from
 * before #532 name a visit, not the request. Waiting now needs the live request
 * queue to hold the row's household and request.
 */
class NotificationLiveRequestQueueTest {

    private fun request(
        targetId: String = "req_1",
        kinfolkId: String = "kf1",
        stamp: String = "",
    ) = NotificationEntry(
        id = "n-$targetId-$kinfolkId",
        key = "kincare.requested",
        targetType = "booking",
        targetId = targetId,
        requestResolution = stamp,
        data = mapOf("kinfolkId" to kinfolkId),
    )

    @Test fun `a request the live queue holds offers Approve, Deny and Create quote`() {
        val a = applicableNotificationActions(request(), setOf("kf1/req_1"))
        assertTrue(a.canApproveDeny)
        assertTrue(a.canCreateQuote)
        assertTrue(a.canOpen)
        assertNull(a.outcome)
    }

    @Test fun `an unstamped request the queue no longer holds reads Answered and offers no answer`() {
        val a = applicableNotificationActions(request(), setOf("kf1/req_other"))
        assertFalse(a.canApproveDeny)
        assertFalse(a.canCreateQuote)
        assertEquals("Answered", a.outcome)
        assertTrue("Open stays", a.canOpen)
    }

    @Test fun `an August row that names a visit, not a request, offers no answer`() {
        // Pre-#532 rows carry the visit id; the queue is keyed by the request.
        val a = applicableNotificationActions(request(targetId = "visit_aug21"), setOf("kf1/req_1"))
        assertFalse(a.canApproveDeny)
        assertEquals("Answered", a.outcome)
    }

    @Test fun `while the queue is unknown or failed, Open only, and no pill`() {
        val a = applicableNotificationActions(request(), null)
        assertFalse(a.canApproveDeny)
        assertFalse(a.canCreateQuote)
        assertNull(a.outcome)
        assertTrue(a.canOpen)
    }

    @Test fun `the same request id in another household is not this request`() {
        val a = applicableNotificationActions(request(kinfolkId = "kf2"), setOf("kf1/req_1"))
        assertFalse(a.canApproveDeny)
    }

    @Test fun `a stamped answer wins over the queue`() {
        val a = applicableNotificationActions(request(stamp = "declined"), setOf("kf1/req_1"))
        assertFalse(a.canApproveDeny)
        assertEquals("Declined", a.outcome)
    }

    @Test fun `Needs a decision counts what Bookings has waiting, not every unstamped row`() {
        // The walk: 19 unstamped request rows, 5 requests waiting.
        val rows = (1..19).map { request(targetId = "req_$it") }
        val waiting = (1..5).map { incomingRequestKey("kf1", "req_$it") }.toSet()
        assertEquals(5, rows.count { applicableNotificationActions(it, waiting).canApproveDeny })
        assertEquals(0, rows.count { applicableNotificationActions(it, null).canApproveDeny })
    }

    @Test fun `waitingRequestOf names the household and request only while it waits`() {
        assertEquals("kf1" to "req_1", waitingRequestOf(request(), setOf("kf1/req_1")))
        assertNull(waitingRequestOf(request(), emptySet()))
        assertNull(waitingRequestOf(request(), null))
    }

    @Test fun `a series key matches the notification key for the same request`() {
        val series = groupIncomingBySeries(
            listOf(
                IncomingKinCare(
                    familyId = "kf1", batchId = "req_1", visitId = "v1", kinfolkId = "kf1",
                    startTime = "2026-12-03T15:00:00Z", status = "requested",
                ),
            ),
        ).single()
        assertEquals(incomingRequestKey("kf1", "req_1"), series.requestKey)
        assertTrue(applicableNotificationActions(request(), setOf(series.requestKey)).canApproveDeny)
    }
}
