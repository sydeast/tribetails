package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BookingCancellationPortalApiTest {

    private fun bookingsWith(cancelRequested: Boolean?) = buildJsonObject {
        put("liveVisit", JsonNull)
        put("upcoming", buildJsonArray {
            add(buildJsonObject {
                put("id", "v1")
                put("kinfolkId", "3")
                put("status", "confirmed")
                put("batchId", "batch-1")
                cancelRequested?.let { put("cancelRequested", it) }
            })
        })
        put("recent", buildJsonArray {})
    }

    @Test
    fun `getMyBookings decodes cancelRequested true`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", bookingsWith(cancelRequested = true))
        val res = PortalApi(fake).getMyBookings()
        assertTrue(res.upcoming.single().cancelRequested)
    }

    @Test
    fun `getMyBookings defaults cancelRequested to false when absent`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", bookingsWith(cancelRequested = null))
        val res = PortalApi(fake).getMyBookings()
        assertFalse(res.upcoming.single().cancelRequested)
    }

    @Test
    fun `requestBookingCancellation sends ids and trimmed reason`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingCancellation", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("alreadyPending", false)
        })
        val res = PortalApi(fake).requestBookingCancellation(
            batchId = "batch-1",
            visitId = "v1",
            reason = "  plans changed  ",
            kinfolkId = "3",
        )
        assertTrue(res.ok)
        assertEquals("v1", res.visitId)
        assertFalse(res.alreadyPending)

        val (name, payload) = fake.calls.single()
        assertEquals("requestBookingCancellation", name)
        assertEquals("batch-1", payload!!["batchId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("v1", payload["visitId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("3", payload["kinfolkId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("plans changed", payload["reason"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun `requestBookingCancellation omits blank reason`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingCancellation", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("alreadyPending", false)
        })
        PortalApi(fake).requestBookingCancellation(batchId = "batch-1", visitId = "v1", reason = "   ")
        val payload = fake.calls.single().second
        assertNull(payload!!["reason"])
    }

    @Test
    fun `requestBookingCancellation surfaces alreadyPending`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingCancellation", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("alreadyPending", true)
        })
        val res = PortalApi(fake).requestBookingCancellation(batchId = "batch-1", visitId = "v1")
        assertTrue(res.ok)
        assertTrue(res.alreadyPending)
    }

    @Test
    fun `requestBookingCancellation rethrows server errors`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("requestBookingCancellation", IllegalStateException("visit already started"))
        assertFailsWith<IllegalStateException> {
            PortalApi(fake).requestBookingCancellation(batchId = "batch-1", visitId = "v1")
        }
    }

    // -- pure helpers --

    private fun booking(status: BookingStatus, cancelRequested: Boolean = false) = Booking(
        id = "v1",
        kinfolkId = "3",
        status = status,
        serviceType = null,
        title = null,
        startTimeMs = null,
        endTimeMs = null,
        kinIds = emptyList(),
        kinNames = emptyList(),
        auntieDisplayName = null,
        auntieAvatarUrl = null,
        notes = null,
        createdAtMs = null,
        visitProgress = null,
        cancelRequested = cancelRequested,
    )

    @Test
    fun `canRequestCancellation true only for upcoming visits without a pending ask`() {
        assertTrue(booking(BookingStatus.Requested).canRequestCancellation())
        assertTrue(booking(BookingStatus.Confirmed).canRequestCancellation())
        assertFalse(booking(BookingStatus.Requested, cancelRequested = true).canRequestCancellation())
        assertFalse(booking(BookingStatus.Confirmed, cancelRequested = true).canRequestCancellation())
        assertFalse(booking(BookingStatus.Active).canRequestCancellation())
        assertFalse(booking(BookingStatus.EnRoute).canRequestCancellation())
        assertFalse(booking(BookingStatus.Completed).canRequestCancellation())
        assertFalse(booking(BookingStatus.Cancelled).canRequestCancellation())
    }

    @Test
    fun `isAwaitingVisit tracks requested and confirmed only`() {
        assertTrue(booking(BookingStatus.Requested).isAwaitingVisit())
        assertTrue(booking(BookingStatus.Confirmed).isAwaitingVisit())
        assertFalse(booking(BookingStatus.Active).isAwaitingVisit())
        assertFalse(booking(BookingStatus.Completed).isAwaitingVisit())
        assertFalse(booking(BookingStatus.Cancelled).isAwaitingVisit())
    }
}
