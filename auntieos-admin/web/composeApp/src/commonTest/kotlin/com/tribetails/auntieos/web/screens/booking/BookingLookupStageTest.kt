package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinCareVisit
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2367: Bookings, opened on a whole booking a notice names. While the request
 * queue loads it waits; when the queue holds the request it opens the request;
 * once the queue has loaded without it, the household's visits say whether it
 * was booked (its visits are highlighted), is gone, or could not be read.
 */
class BookingLookupStageTest {

    private fun session(id: String, kinfolkId: String, batchId: String?, start: String) =
        KinCareSession(_id = id, kinfolkId = kinfolkId, kinCareBatchId = batchId, startTime = start, status = "SCHEDULED")

    private val waitingRequest = groupIncomingBySeries(
        listOf(KinCareVisit(_id = "v1", path = "families/kf1/bookings/b_waiting/kinCares/v1", status = "requested")),
    )

    @Test
    fun theFocusWaitsForTheQueueThenOpensAWaitingRequest() {
        assertEquals(FocusRequestOutcome.Waiting, focusRequestOutcome("kf1/b1", FirestoreResult.Loading, emptyList()))
        assertEquals(
            FocusRequestOutcome.Open,
            focusRequestOutcome("kf1/b_waiting", FirestoreResult.Data(emptyList<KinCareVisit>()), waitingRequest),
        )
        assertEquals(
            FocusRequestOutcome.LookUpBooking,
            focusRequestOutcome("kf1/b1", FirestoreResult.Data(emptyList<KinCareVisit>()), waitingRequest),
        )
    }

    @Test
    fun aBookedBookingHighlightsItsOwnVisitsEarliestFirst() {
        val read = FirestoreResult.Data(
            listOf(
                session("vis_2", "kf1", "b1", "2026-11-21T17:00:00Z"),
                session("vis_1", "kf1", " b1 ", "2026-11-19T17:00:00Z"),
                // Another household's booking with the same request id is not this one.
                session("vis_other_home", "kf2", "b1", "2026-11-18T17:00:00Z"),
                // Another booking of the same household is not this one.
                session("vis_other_booking", "kf1", "b9", "2026-11-18T17:00:00Z"),
                session("vis_direct", "kf1", null, "2026-11-18T17:00:00Z"),
            ),
        )
        assertEquals(BookingLookupStage.Booked(listOf("vis_1", "vis_2")), bookingLookupStage("kf1", "b1", read))
    }

    @Test
    fun aBookingOfAnotherHouseholdOnlyIsGone() {
        val read = FirestoreResult.Data(listOf(session("vis_other_home", "kf2", "b1", "2026-11-18T17:00:00Z")))
        assertEquals(BookingLookupStage.Gone, bookingLookupStage("kf1", "b1", read))
        assertEquals(BookingLookupStage.Gone, bookingLookupStage("kf1", "b1", FirestoreResult.Data(emptyList())))
    }

    @Test
    fun aBlankIdMatchesNothing() {
        val read = FirestoreResult.Data(listOf(session("vis_blank", "", "", "2026-11-18T17:00:00Z")))
        assertEquals(BookingLookupStage.Gone, bookingLookupStage("", "", read))
    }

    @Test
    fun theLookupLoadsThenFailsInItsOwnWords() {
        assertEquals(BookingLookupStage.LookingUp, bookingLookupStage("kf1", "b1", FirestoreResult.Loading))
        assertEquals(BookingLookupStage.Failed("offline"), bookingLookupStage("kf1", "b1", FirestoreResult.Error("offline")))
    }

    @Test
    fun theBannerCountsTheVisits() {
        assertEquals("Its visit is highlighted below.", bookingFoundBody(1))
        assertEquals("Its 3 visits are highlighted below.", bookingFoundBody(3))
        assertEquals("This booking", BOOKING_FOUND_TITLE)
        assertEquals("This booking is no longer available", BOOKING_GONE_TITLE)
        assertEquals("It was turned down, withdrawn or removed, so there is nothing to open.", BOOKING_GONE_BODY)
        assertEquals("Looking this booking up…", BOOKING_LOOKUP_LOADING)
        assertEquals("Couldn't look this booking up", BOOKING_LOOKUP_FAILED_TITLE)
    }
}
