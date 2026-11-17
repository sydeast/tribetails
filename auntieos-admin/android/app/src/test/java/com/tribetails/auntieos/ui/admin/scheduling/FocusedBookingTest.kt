package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.KinCareSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2367: what Bookings shows for a whole booking a notice's Open names.
 * Waiting, open card, booked (its visits), gone, lookup failed.
 */
class FocusedBookingTest {

    private fun session(id: String, kinfolkId: String, batchId: String?, start: String = "2026-12-03T15:00:00Z") =
        KinCareSession(id = id, kinfolkId = kinfolkId, kinCareBatchId = batchId, startTime = start)

    private fun stage(
        kinfolkId: String? = "kf1",
        batchId: String? = "b7",
        live: Boolean = true,
        queue: Set<String> = emptySet(),
        lookup: FocusedBookingLookup? = null,
    ) = focusedBookingStage(kinfolkId, batchId, live, queue, lookup)

    // ---- sessionsOfBooking ----

    @Test
    fun `the booking's visits are the household's visits carrying its batch id, oldest first`() {
        val all = listOf(
            session("vis_2", "kf1", "b7", start = "2026-12-05T15:00:00Z"),
            session("vis_1", "kf1", "b7", start = "2026-12-04T15:00:00Z"),
            session("vis_other", "kf1", "b8"),
            session("vis_none", "kf1", null),
        )
        assertEquals(listOf("vis_1", "vis_2"), sessionsOfBooking(all, "kf1", "b7").map { it.id })
    }

    @Test
    fun `another household's visit with the same batch id does not match`() {
        val all = listOf(session("vis_theirs", "kf2", "b7"))
        assertTrue(sessionsOfBooking(all, "kf1", "b7").isEmpty())
    }

    @Test
    fun `blank ids match nothing`() {
        val all = listOf(session("vis_1", "", ""), session("vis_2", "kf1", "b7"))
        assertTrue(sessionsOfBooking(all, "", "b7").isEmpty())
        assertTrue(sessionsOfBooking(all, "kf1", " ").isEmpty())
    }

    // ---- focusedBookingStage ----

    @Test
    fun `nothing focused is nothing to show`() {
        assertEquals(FocusedBookingStage.None, stage(kinfolkId = null))
        assertEquals(FocusedBookingStage.None, stage(batchId = ""))
    }

    @Test
    fun `while the queue is not live it waits, as before`() {
        assertEquals(FocusedBookingStage.Waiting, stage(live = false))
        assertEquals(
            "a lookup result is not shown off a queue that is not current",
            FocusedBookingStage.Waiting,
            stage(live = false, lookup = FocusedBookingLookup.Found(emptyList())),
        )
    }

    @Test
    fun `a request the queue holds opens its card`() {
        assertEquals(FocusedBookingStage.OpenCard, stage(queue = setOf("kf1/b7")))
        assertEquals(
            "the queue wins over an earlier lookup",
            FocusedBookingStage.OpenCard,
            stage(queue = setOf("kf1/b7"), lookup = FocusedBookingLookup.Found(emptyList())),
        )
    }

    @Test
    fun `another household's request with the same batch id is not this one`() {
        assertEquals(FocusedBookingStage.LookingUp, stage(queue = setOf("kf2/b7")))
    }

    @Test
    fun `out of the queue it looks the booking up`() {
        assertEquals(FocusedBookingStage.LookingUp, stage())
        assertEquals(FocusedBookingStage.LookingUp, stage(lookup = FocusedBookingLookup.Loading))
    }

    @Test
    fun `found visits are the booked stage, none found is gone`() {
        val visits = listOf(session("vis_1", "kf1", "b7"))
        assertEquals(FocusedBookingStage.Booked(visits), stage(lookup = FocusedBookingLookup.Found(visits)))
        assertEquals(FocusedBookingStage.Gone, stage(lookup = FocusedBookingLookup.Found(emptyList())))
    }

    @Test
    fun `a failed lookup carries its words`() {
        assertEquals(
            FocusedBookingStage.LookupFailed("You're offline."),
            stage(lookup = FocusedBookingLookup.Failed("You're offline.")),
        )
    }

    @Test
    fun `the lookup starts only once, at stage 3`() {
        assertTrue(focusedBookingNeedsLookup(FocusedBookingStage.LookingUp, null))
        assertFalse("already running", focusedBookingNeedsLookup(FocusedBookingStage.LookingUp, FocusedBookingLookup.Loading))
        assertFalse(focusedBookingNeedsLookup(FocusedBookingStage.Waiting, null))
        assertFalse(focusedBookingNeedsLookup(FocusedBookingStage.OpenCard, null))
        assertFalse(focusedBookingNeedsLookup(FocusedBookingStage.None, null))
    }

    // ---- copy ----

    @Test
    fun `the banner counts the visits`() {
        assertEquals("Its visit is highlighted below.", focusedBookingBody(1))
        assertEquals("Its 3 visits are highlighted below.", focusedBookingBody(3))
    }

    @Test
    fun `the copy carries no em dash`() {
        for (s in listOf(
            FOCUSED_BOOKING_LOOKING_UP, FOCUSED_BOOKING_TITLE, FOCUSED_BOOKING_GONE_TITLE,
            FOCUSED_BOOKING_GONE_BODY, FOCUSED_BOOKING_FAILED_TITLE, focusedBookingBody(1), focusedBookingBody(2),
        )) {
            assertFalse(s, s.contains('—'))
        }
    }
}
