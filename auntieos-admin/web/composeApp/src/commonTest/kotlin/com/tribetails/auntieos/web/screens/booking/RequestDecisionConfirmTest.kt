package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareVisit
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1875: the confirm step for answering a request names the household (its
 * title), the day and time, and who will be told, before anything is sent.
 * #2028: a request a notification opened shows its card once the live queue
 * holds it, and says so when it is no longer waiting.
 */
class RequestDecisionConfirmTest {

    private val chicago = TimeZone.of("America/Chicago")

    private fun visit(batch: String, id: String, start: String) = KinCareVisit(
        _id = id,
        path = "families/kf1/bookings/$batch/kinCares/$id",
        kinfolkName = "The Rowans",
        startTime = start,
        status = "requested",
    )

    private val one = groupIncomingBySeries(listOf(visit("b1", "v1", "2026-11-19T17:00:00Z"))).single()
    private val three = groupIncomingBySeries(
        listOf(
            visit("b2", "v1", "2026-11-19T17:00:00Z"),
            visit("b2", "v2", "2026-11-20T17:00:00Z"),
            visit("b2", "v3", "2026-11-21T17:00:00Z"),
        ),
    ).single()

    @Test
    fun aDeclineNamesTheDayAndSaysTheHouseholdWillBeTold() {
        assertEquals("Turn down this request from The Rowans", one.declineConfirmTitle())
        assertEquals("Thu, Nov 19 at 11:00 AM will not be booked. The household will be told.", one.decisionLine(decline = true, chicago))
    }

    @Test
    fun anApprovalNamesTheDayAndWhereItGoes() {
        assertEquals("Book this request for The Rowans", one.approveConfirmTitle())
        assertEquals(
            "Thu, Nov 19 at 11:00 AM will go on the schedule and on the household's portal.",
            one.decisionLine(decline = false, chicago),
        )
    }

    @Test
    fun aSeriesNamesItsFirstAndLastVisit() {
        assertEquals(
            "The 3 visits from Thu, Nov 19 at 11:00 AM to Sat, Nov 21 at 11:00 AM will not be booked. The household will be told.",
            three.decisionLine(decline = true, chicago),
        )
    }

    @Test
    fun aFocusedRequestWaitsForTheQueueThenOpens() {
        assertEquals(FocusRequestOutcome.Waiting, focusRequestOutcome("kf1/b1", FirestoreResult.Loading, emptyList()))
        assertEquals(FocusRequestOutcome.Open, focusRequestOutcome("kf1/b1", FirestoreResult.Data(emptyList<KinCareVisit>()), listOf(one)))
    }

    @Test
    fun aFocusedRequestTheQueueDoesNotHoldIsNotWaiting() {
        assertEquals(FocusRequestOutcome.NotWaiting, focusRequestOutcome("kf1/gone", FirestoreResult.Data(emptyList<KinCareVisit>()), listOf(one)))
    }

    @Test
    fun noFocusOrAFailedQueueOpensNothing() {
        assertEquals(FocusRequestOutcome.None, focusRequestOutcome(null, FirestoreResult.Loading, emptyList()))
        // A failed queue already paints its own error on the Visit requests panel.
        assertEquals(FocusRequestOutcome.None, focusRequestOutcome("kf1/b1", FirestoreResult.Error("denied"), emptyList()))
    }
}
