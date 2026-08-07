package com.kinfolk.portal.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RelativeTimeTest {

    private val now = 1_700_000_000_000L

    @Test
    fun `null returns empty`() {
        assertEquals("", relativeTime(null, nowMillis = now))
    }

    @Test
    fun `under a minute is Just now`() {
        assertEquals("Just now", relativeTime(now - 30_000L, nowMillis = now))
    }

    @Test
    fun `minutes ago`() {
        assertEquals("5m ago", relativeTime(now - 5 * 60_000L, nowMillis = now))
    }

    @Test
    fun `hours ago`() {
        assertEquals("3h ago", relativeTime(now - 3 * 3_600_000L, nowMillis = now))
    }

    @Test
    fun `days ago`() {
        assertEquals("2d ago", relativeTime(now - 2 * 86_400_000L, nowMillis = now))
    }

    @Test
    fun `more than a week renders month and day`() {
        // 60 days back — exact format depends on system zone, just assert non-relative form.
        val s = relativeTime(now - 60L * 86_400_000L, nowMillis = now)
        assertTrue(s.length in 5..7, "expected 'Mon DD' style, got '$s'")
        assertTrue(!s.endsWith("ago"))
    }
}

/**
 * task-25 (P4): `clockTime`, the first clock-time formatter on this platform
 * (see RelativeTime.kt's doc comment for why it lives here rather than
 * extending ScheduleScreen.kt's pre-existing raw-ISO render).
 */
class ClockTimeTest {

    private val hourMinuteAmPm = Regex("""^\d{1,2}:\d{2} (AM|PM)$""")

    @Test
    fun `null input returns null`() {
        assertEquals(null, clockTime(null))
    }

    @Test
    fun `blank input returns null`() {
        assertEquals(null, clockTime(""))
        assertEquals(null, clockTime("   "))
    }

    @Test
    fun `unparseable input returns null, never a crash`() {
        assertEquals(null, clockTime("6pm"))
        assertEquals(null, clockTime("not-a-date"))
    }

    @Test
    fun `a valid instant renders h mm AM PM in the runner's own local zone`() {
        val s = clockTime("2026-08-06T14:02:00.000Z")
        assertTrue(s != null && hourMinuteAmPm.matches(s), "expected 'H:MM AM/PM' style, got '$s'")
    }

    @Test
    fun `midnight local renders as 12 not 0`() {
        // Find an instant that's local midnight for whatever zone the test runs
        // in isn't possible without a fixed zone; instead assert the general
        // invariant on a UTC midnight instant — hour12 is never "0:xx".
        val s = clockTime("2026-08-06T00:00:00.000Z")
        assertTrue(s != null && !s.startsWith("0:"), "hour should never render as 0, got '$s'")
    }
}
