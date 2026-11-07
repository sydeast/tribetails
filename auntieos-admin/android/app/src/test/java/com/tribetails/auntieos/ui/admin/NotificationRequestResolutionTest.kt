package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.data.admin.notificationEntryFromMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1647: a household's visit request booked from Bookings > Review kept
 * offering Approve and Deny on its Notifications row, and "Needs a decision"
 * kept counting it. The server now stamps `requestResolution` on the request's
 * `kincare.requested` rows once it is booked or declined; an answered row offers
 * no decision and names its outcome instead.
 */
class NotificationRequestResolutionTest {

    private fun request(resolution: String = "", data: Map<String, Any?> = emptyMap()) = NotificationEntry(
        id = "n1",
        key = "kincare.requested",
        targetType = "booking",
        targetId = "req_1",
        requestResolution = resolution,
        data = data,
    )

    @Test fun `a waiting request offers Approve and Deny and no outcome`() {
        val a = applicableNotificationActions(request())
        assertTrue(a.canApproveDeny)
        assertNull(a.outcome)
    }

    @Test fun `an answered request offers no Approve or Deny and names its outcome`() {
        for ((stamp, label) in listOf(
            "booked" to "Booked",
            "declined" to "Declined",
            "cancelled" to "Cancelled",
            "BOOKED" to "Booked",
            "something-new" to "Answered",
        )) {
            val a = applicableNotificationActions(request(stamp))
            assertFalse("Approve/Deny on a $stamp request", a.canApproveDeny)
            assertEquals(label, a.outcome)
        }
    }

    @Test fun `a blank stamp is still waiting`() {
        assertTrue(applicableNotificationActions(request("  ")).canApproveDeny)
    }

    @Test fun `an answered request no longer offers Create quote`() {
        val waiting = applicableNotificationActions(request(data = mapOf("kinfolkId" to "k9")))
        val booked = applicableNotificationActions(request("booked", mapOf("kinfolkId" to "k9")))
        assertTrue(waiting.canCreateQuote)
        assertFalse(booked.canCreateQuote)
    }

    @Test fun `the stamp means nothing on any other key`() {
        val confirm = request("booked").copy(key = "kincare.booking.confirm")
        assertNull(requestOutcomeLabel(confirm))
        assertNull(applicableNotificationActions(confirm).outcome)
    }

    @Test fun `Needs a decision counts only requests still waiting`() {
        // The walk: requests waiting, one booked from Bookings, count unchanged.
        val rows = listOf(request(), request("booked"), request("declined"))
        assertEquals(1, rows.count { applicableNotificationActions(it).canApproveDeny })
    }

    @Test fun `the decoder reads the server stamp`() {
        val e = notificationEntryFromMap(
            "n1",
            mapOf(
                "key" to "kincare.requested",
                "targetType" to "booking",
                "targetId" to "req_1",
                "requestResolution" to "booked",
            ),
        )
        assertEquals("booked", e.requestResolution)
        assertFalse(applicableNotificationActions(e).canApproveDeny)
    }

    @Test fun `the decoder leaves an unstamped row waiting`() {
        val e = notificationEntryFromMap("n1", mapOf("key" to "kincare.requested"))
        assertEquals("", e.requestResolution)
    }
}
