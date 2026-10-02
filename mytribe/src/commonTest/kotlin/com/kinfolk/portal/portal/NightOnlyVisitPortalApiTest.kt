package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.util.bookingCalendarBadge
import com.kinfolk.portal.util.bookingWhenLabel
import com.kinfolk.portal.util.CalendarBadge
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1098: an overnight flagged in `startTimeServiceIds` is asked for by night,
 * and the Auntie sets its start time on approval. The portal client is not
 * generated, so this pins its hand-written half of the contract:
 * `requestBooking` gets `date` and no `startTimeMs` key, and `getMyBookings`'s
 * `startTimePending` / `requestedDate` decode, with an older server's silence
 * reading as a timed visit.
 */
class NightOnlyVisitPortalApiTest {

    private fun stubBookings(fake: FakeFunctionsClient, visit: JsonObject) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray { add(visit) })
            put("recent", buildJsonArray {})
        })
    }

    private fun pendingNight(date: String? = "2026-10-09") = buildJsonObject {
        put("id", "v1")
        put("kinfolkId", "fam-1")
        put("status", "requested")
        put("batchId", "batch-1")
        put("serviceType", "Overnight")
        put("startTimeMs", JsonNull)
        put("startTimePending", true)
        if (date != null) put("requestedDate", date) else put("requestedDate", JsonNull)
    }

    @Test
    fun `decodes a night waiting on its start time`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, pendingNight())
        val b = PortalApi(fake).getMyBookings("fam-1").upcoming.single()
        assertTrue(b.startTimePending)
        assertEquals("2026-10-09", b.requestedDate)
        assertNull(b.startTimeMs)
    }

    @Test
    fun `an older server without the fields decodes as a timed visit`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, buildJsonObject {
            put("id", "v1")
            put("kinfolkId", "fam-1")
            put("status", "confirmed")
            put("batchId", "batch-1")
            put("startTimeMs", 1_786_980_600_000L)
        })
        val b = PortalApi(fake).getMyBookings("fam-1").upcoming.single()
        assertFalse(b.startTimePending)
        assertNull(b.requestedDate)
        assertTrue(b.canRequestReschedule())
        assertFalse(b.awaitingStartTime())
    }

    @Test
    fun `a night waiting on its start cannot be rescheduled, but can still be cancelled`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, pendingNight())
        val b = PortalApi(fake).getMyBookings("fam-1").upcoming.single()
        assertFalse(b.canRequestReschedule())
        assertTrue(b.awaitingStartTime())
        assertTrue(b.canRequestCancellation())
    }

    @Test
    fun `lists a night on its own date with who sets the start, never midnight`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, pendingNight())
        val b = PortalApi(fake).getMyBookings("fam-1").upcoming.single()
        assertEquals("Fri night · Start time set by your Auntie", bookingWhenLabel(b))
        assertEquals(CalendarBadge("OCT", "09"), bookingCalendarBadge(b))
    }

    @Test
    fun `still says who sets the start when the night is missing or unreadable`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, pendingNight(date = null))
        val b = PortalApi(fake).getMyBookings("fam-1").upcoming.single()
        assertEquals("Start time set by your Auntie", bookingWhenLabel(b))
        assertNull(bookingCalendarBadge(b))
        assertEquals("Start time set by your Auntie", bookingWhenLabel(b.copy(requestedDate = "not-a-date")))
    }

    @Test
    fun `sends a night as its date, with no startTimeMs key at all`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("batchId", "req_1") })
        PortalApi(fake).requestBookingMultiVisit(
            kinfolkId = "fam-1",
            visits = listOf(
                BookingVisit(1_900_000_000_000, null, "s1", "Walk", 1000, timeBlockId = "midday"),
                BookingVisit(null, null, "Overnight", "Overnight", 15000, date = "2026-10-09"),
            ),
        )
        val visits = fake.calls.single().second!!["visits"]!!.jsonArray.map { it.jsonObject }
        assertEquals(1_900_000_000_000, visits[0]["startTimeMs"]!!.jsonPrimitive.content.toLong())
        assertFalse(visits[0].containsKey("date"))
        val night = visits[1]
        assertEquals("2026-10-09", night["date"]!!.jsonPrimitive.content)
        assertFalse(night.containsKey("startTimeMs"), "a night must not carry startTimeMs: $night")
        assertFalse(night.containsKey("timeBlockId"))
        assertFalse(night.containsKey("endTimeMs"))
    }
}
