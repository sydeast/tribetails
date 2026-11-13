package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.util.rescheduleAskWhen
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1863: the time a household asked to move a visit to reads the way the
 * business's mode says: its window in Time Blocks mode, the clock in Exact
 * times mode. Mirrors the web `rescheduleAskWhen`.
 */
class RescheduleAskWhenTest {
    private val zone = TimeZone.of("America/Chicago")
    /** Tue Nov 17 2026, 16:00 in Chicago. */
    private val askedMs = LocalDateTime(2026, 11, 17, 16, 0).toInstant(zone).toEpochMilliseconds()
    /** Decoded through the real wire path, so the test also pins the new fields' names. */
    private suspend fun visit(label: String?, start: String?, end: String?, asked: Long? = askedMs): Booking {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "v1")
                    put("kinfolkId", "fam-1")
                    put("status", "confirmed")
                    put("batchId", "batch-1")
                    put("startTimeMs", askedMs + 86_400_000L)
                    put("rescheduleRequestStatus", "pending")
                    put("rescheduleRequestedStartTimeMs", asked)
                    put("rescheduleRequestedTimeBlockLabel", label)
                    put("rescheduleRequestedTimeBlockStartTime", start)
                    put("rescheduleRequestedTimeBlockEndTime", end)
                })
            })
            put("recent", buildJsonArray {})
        })
        return PortalApi(fake).getMyBookings("fam-1").upcoming.single()
    }
    @Test
    fun `reads the three asked-for block fields off the wire`() = runTest {
        val v = visit("Evening", "16:00", "19:00")
        assertEquals("Evening", v.rescheduleRequestedTimeBlockLabel)
        assertEquals("16:00", v.rescheduleRequestedTimeBlockStartTime)
        assertEquals("19:00", v.rescheduleRequestedTimeBlockEndTime)
        val clock = visit(null, null, null)
        assertNull(clock.rescheduleRequestedTimeBlockLabel)
    }
    @Test
    fun `Time Blocks mode names the window, never a clock`() = runTest {
        assertEquals("Tue, Evening (4 PM to 7 PM)", rescheduleAskWhen(visit("Evening", "16:00", "19:00"), zone))
    }
    @Test
    fun `Exact times mode names the clock`() = runTest {
        assertEquals("Tue, 4:00 PM", rescheduleAskWhen(visit(null, null, null), zone))
    }
    @Test
    fun `no ask on file reads as nothing`() = runTest {
        assertEquals("", rescheduleAskWhen(visit(null, null, null, asked = null), zone))
    }
}
