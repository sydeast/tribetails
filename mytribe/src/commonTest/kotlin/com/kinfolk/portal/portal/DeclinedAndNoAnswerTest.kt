package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2029: a request the office declined read Cancelled. The server's
 * `requestDeclinedAtMs` tells a decline apart from a cancellation, and every
 * pill and the Status row read it through [stage]. The web portal's
 * `portalFormat.declined.test.ts` pins the same answers.
 *
 * #1919: a send that got no answer is checked against a fresh read before the
 * household is told anything. The web's `bookingsCache.noAnswer.test.ts` is
 * the mirror.
 */
class DeclinedAndNoAnswerTest {
    private fun booking(status: BookingStatus, declinedAt: Long? = null) = Booking(
        id = "v1", kinfolkId = "fam-1", status = status, serviceType = null, title = null,
        startTimeMs = null, endTimeMs = null, kinIds = emptyList(), kinNames = emptyList(),
        auntieDisplayName = null, auntieAvatarUrl = null, notes = null, createdAtMs = null,
        visitProgress = null, requestDeclinedAtMs = declinedAt,
    )

    @Test
    fun `a declined request reads DECLINED and is finished`() {
        val declined = booking(BookingStatus.Cancelled, declinedAt = 1_763_000_000_000L)
        assertEquals(VisitStage.Declined, declined.stage())
        assertEquals("DECLINED", declined.stage().label())
        assertTrue(declined.isFinished())
    }

    @Test
    fun `a cancelled visit with no decline stamp still reads CANCELLED`() {
        assertEquals("CANCELLED", booking(BookingStatus.Cancelled).stage().label())
    }

    @Test
    fun `a stamp on a visit that is no longer cancelled is not read`() {
        assertEquals(VisitStage.Confirmed, booking(BookingStatus.Confirmed, declinedAt = 1L).stage())
    }

    private fun visitJson(extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = buildJsonObject {
        put("liveVisit", JsonNull)
        put("upcoming", buildJsonArray {})
        put("recent", buildJsonArray {
            add(buildJsonObject {
                put("id", "v1"); put("kinfolkId", "fam-1"); put("batchId", "b1")
                extra()
            })
        })
    }

    @Test
    fun `the decline stamp is decoded, and an older answer without it decodes as before`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", visitJson { put("status", "cancelled"); put("requestDeclinedAtMs", 1_763_000_000_000L) })
        val declined = PortalApi(fake).getMyBookings("fam-1").findBooking("v1")
        assertEquals(1_763_000_000_000L, declined?.requestDeclinedAtMs)
        assertEquals(VisitStage.Declined, declined?.stage())

        fake.stub("getMyBookings", visitJson { put("status", "cancelled") })
        val older = PortalApi(fake).getMyBookings("fam-1").findBooking("v1")
        assertNull(older?.requestDeclinedAtMs)
        assertEquals(VisitStage.Cancelled, older?.stage())
    }

    @Test
    fun `a call that ran out of time is told apart from a refusal`() {
        assertTrue(isNoAnswerError(IllegalStateException("DEADLINE_EXCEEDED")))
        assertTrue(isNoAnswerError(RuntimeException("wrapped", IllegalStateException("functions/deadline-exceeded"))))
        assertFalse(isNoAnswerError(IllegalStateException("A new time is already waiting on your Auntie for this visit.")))
        assertFalse(isNoAnswerError(CancellationException("left the screen")))
    }

    @Test
    fun `the no answer sentence names no function and no business`() {
        val text = noAnswerMessage()
        assertEquals("No answer came back within 70 seconds, so it may still have gone through. Check before trying again.", text)
        assertFalse("request" in text || "Tribe Tails" in text)
    }

    @Test
    fun `the check hands back the visit only when it shows that ask`() = runTest {
        val fake = FakeFunctionsClient()
        val api = PortalApi(fake)
        fake.stub("getMyBookings", visitJson {
            put("status", "confirmed"); put("rescheduleRequestStatus", "pending"); put("rescheduleRequestedStartTimeMs", 42L)
        })
        val same = api.visitAfterNoAnswer("fam-1", "v1") { it.rescheduleRequestedStartTimeMs == 42L }
        assertEquals("v1", same?.second?.id)
        assertNull(api.visitAfterNoAnswer("fam-1", "v1") { it.rescheduleRequestedStartTimeMs == 7L })

        fake.stubError("getMyBookings", IllegalStateException("offline"))
        assertNull(api.visitAfterNoAnswer("fam-1", "v1") { true })
    }
}
