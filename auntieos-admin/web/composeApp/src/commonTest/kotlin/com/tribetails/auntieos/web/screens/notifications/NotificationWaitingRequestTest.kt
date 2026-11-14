package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.KinCareVisit
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.screens.booking.groupIncomingBySeries
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2069 on the desktop console: request notifications from August, never
 * stamped by #1647's trigger, still offered Approve and Deny on requests long
 * booked or declined, and "Needs a decision" counted them. #1694 read "no
 * stamp" as "still waiting". The rule now: a decision only while the live
 * incoming-requests queue holds the request; Open otherwise.
 *
 * #2028: Open on a request row opens the request, by household and request id,
 * instead of routing to Bookings with nothing to show.
 */
class NotificationWaitingRequestTest {

    private fun row(id: String, batchId: String, kinfolkId: String = "kf1", stamp: String = "") = NotificationEntry(
        _id = id,
        key = "kincare.requested",
        targetType = "booking",
        targetId = batchId,
        requestResolution = stamp,
        data = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) },
    )

    private fun visit(kinfolkId: String, batchId: String, visitId: String) = KinCareVisit(
        _id = visitId,
        path = "families/$kinfolkId/bookings/$batchId/kinCares/$visitId",
        status = "requested",
        startTime = "2026-11-19T17:00:00Z",
    )

    /** The live queue as Bookings reads it: one request waiting for kf1. */
    private val queue = pendingRequestKeys(groupIncomingBySeries(listOf(visit("kf1", "req_new", "v1"), visit("kf1", "req_new", "v2"))))

    @Test
    fun theQueueKeysEachRequestByHouseholdAndRequestId() {
        assertEquals(setOf("kf1/req_new"), queue)
    }

    @Test
    fun aRowWhoseRequestIsWaitingOffersApproveAndDeny() {
        val actions = applicableActions(row("n1", "req_new"), queue)
        assertTrue(NotificationAction.ApproveBooking in actions)
        assertTrue(NotificationAction.DenyBooking in actions)
        assertNull(requestOutcomeLabel(row("n1", "req_new"), queue))
    }

    @Test
    fun anUnstampedOldRowTheQueueDoesNotHoldOffersOpenOnlyAndReadsAnswered() {
        // The walk's August rows: no stamp, request long answered.
        val old = row("n2", "req_august")
        val actions = applicableActions(old, queue)
        assertFalse(NotificationAction.ApproveBooking in actions)
        assertFalse(NotificationAction.DenyBooking in actions)
        assertTrue(NotificationAction.OpenTarget in actions)
        assertEquals("Answered", requestOutcomeLabel(old, queue))
    }

    @Test
    fun aPreEnvelopeRowCarryingAVisitIdIsNotWaiting() {
        // Rows from before #532 name a visit id, which no request in the queue has.
        assertFalse(NotificationAction.ApproveBooking in applicableActions(row("n3", "v1"), queue))
    }

    @Test
    fun theSameRequestIdForAnotherHouseholdIsNotWaiting() {
        assertFalse(NotificationAction.ApproveBooking in applicableActions(row("n4", "req_new", kinfolkId = "kf2"), queue))
    }

    @Test
    fun aStampStillNamesTheOutcome() {
        assertEquals("Booked", requestOutcomeLabel(row("n5", "req_done", stamp = "booked"), queue))
        assertEquals("Declined", requestOutcomeLabel(row("n5", "req_done", stamp = "declined"), null))
    }

    @Test
    fun whileTheQueueIsUnknownNothingIsOfferedADecisionAndNoOutcomeIsGuessed() {
        val waiting = row("n1", "req_new")
        assertFalse(NotificationAction.ApproveBooking in applicableActions(waiting, null))
        assertTrue(NotificationAction.OpenTarget in applicableActions(waiting, null))
        assertNull(requestOutcomeLabel(waiting, null))
    }

    @Test
    fun needsADecisionCountsOnlyRequestsTheQueueHolds() {
        // The walk: 19 on the tile, 5 waiting on Bookings.
        val rows = listOf(row("a", "req_new"), row("b", "req_august"), row("c", "req_july"), row("d", "v9"))
        assertEquals(1, needsDecisionCount(rows, queue))
        assertEquals(0, needsDecisionCount(rows, emptySet()))
    }

    @Test
    fun openOnARequestRowOpensTheRequestByHouseholdAndRequestId() {
        assertEquals(NotificationOpenRoute.VisitRequest("kf1", "req_new"), notificationOpenRoute(row("n1", "req_new")))
        // Answered or not, the row opens its request; Bookings says what came of it.
        assertEquals(NotificationOpenRoute.VisitRequest("kf1", "req_august"), notificationOpenRoute(row("n2", "req_august")))
    }

    @Test
    fun aRequestRowWithNoHouseholdKeepsTheTargetRoute() {
        val anonymous = NotificationEntry(key = "kincare.requested", targetType = "booking", targetId = "req_1")
        assertEquals(NotificationOpenRoute.Target("booking", "req_1"), notificationOpenRoute(anonymous))
    }

    @Test
    fun otherBookingKeysKeepTheTargetRoute() {
        val confirm = NotificationEntry(key = "kincare.booking.confirm", targetType = "booking", targetId = "req_1")
        assertEquals(NotificationOpenRoute.Target("booking", "req_1"), notificationOpenRoute(confirm))
    }
}
