package com.kinfolk.portal.portal
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.screens.schedule.formatClock12
import com.kinfolk.portal.screens.schedule.formatClockRange12
import com.kinfolk.portal.util.bookingBlockText
import com.kinfolk.portal.util.bookingWhenLabel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1301: a visit booked into a window is shown as the window, in a 12-hour
 * clock, never as the window's anchor time. Mirrors the web
 * `visitBlockText` / `formatClock12` tests.
 */
class BlockVisitDisplayTest {
    private val now = 1_786_000_000_000L
    private val chicago = kotlinx.datetime.TimeZone.of("America/Chicago")
    /** Decoded through the real wire path, so the test also pins the new fields' names. */
    private suspend fun visit(label: String?, start: String?, end: String?): Booking {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "v1")
                    put("kinfolkId", "fam-1")
                    put("status", "confirmed")
                    put("batchId", "batch-1")
                    put("startTimeMs", now + 2 * 86_400_000L)
                    put("timeBlockLabel", label)
                    put("timeBlockStartTime", start)
                    put("timeBlockEndTime", end)
                })
            })
            put("recent", buildJsonArray {})
        })
        return PortalApi(fake).getMyBookings("fam-1").upcoming.single()
    }
    @Test
    fun `reads a 12 hour clock and drops the zero minutes`() {
        assertEquals("11 AM", formatClock12("11:00"))
        assertEquals("3:30 PM", formatClock12("15:30"))
        assertEquals("12 AM", formatClock12("00:00"))
        assertEquals("12 PM", formatClock12("12:00"))
        assertEquals("12 AM", formatClock12("24:00"))
        assertEquals("11 AM to 3 PM", formatClockRange12("11:00", "15:00"))
    }
    @Test
    fun `hands back what it cannot read`() {
        assertEquals("soon", formatClock12("soon"))
        assertEquals("25:00", formatClock12("25:00"))
    }
    @Test
    fun `names the window with its hours`() = runTest {
        assertEquals("Midday (11 AM to 3 PM)", bookingBlockText(visit("Midday", "11:00", "15:00")))
    }
    @Test
    fun `falls back to the stored label when the window is gone, and is null for a clock visit`() = runTest {
        assertEquals("Midday", bookingBlockText(visit("Midday", null, null)))
        assertNull(bookingBlockText(visit(null, null, null)))
    }
    @Test
    fun `the row label names the weekday and the window in Time Blocks mode and the clock in Exact times mode`() = runTest {
        // #1863: the same "Sat, Midday (11 AM to 3 PM)" the web row prints. A
        // relative "in 45m" would count down to the clock time the office set.
        assertEquals("Sat, Midday (11 AM to 3 PM)", bookingWhenLabel(visit("Midday", "11:00", "15:00"), chicago))
        val soon = visit("Midday", "11:00", "15:00").copy(startTimeMs = now + 45 * 60_000L)
        assertEquals("Thu, Midday (11 AM to 3 PM)", bookingWhenLabel(soon, chicago))
        // Exact times mode (no window from the server): the clock the household
        // picked, "Sat, 2:06 AM", as the web row and the mocks print it.
        assertEquals("Sat, 2:06 AM", bookingWhenLabel(visit(null, null, null), chicago))
    }
    @Test
    fun `a line with no date badge beside it carries the month and day, and the year when it is not this one`() = runTest {
        val block = visit("Midday", "11:00", "15:00")
        assertEquals("Sat, Aug 8, Midday (11 AM to 3 PM)", bookingWhenLabel(block, chicago, withDate = true, nowMillis = now))
        assertEquals("Sat, Aug 8, 2:06 AM", bookingWhenLabel(visit(null, null, null), chicago, withDate = true, nowMillis = now))
        val aYearLater = now + 2 * 86_400_000L + 365L * 86_400_000L
        assertEquals("Sat, Aug 8, 2026, 2:06 AM", bookingWhenLabel(visit(null, null, null), chicago, withDate = true, nowMillis = aYearLater))
    }
}
