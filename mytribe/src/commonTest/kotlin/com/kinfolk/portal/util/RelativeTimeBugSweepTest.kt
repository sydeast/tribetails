package com.kinfolk.portal.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RelativeTimeBugSweepTest {

    private val now = 1_700_000_000_000L

    @Test
    fun future_timestamp_does_not_render_negative_minutes() {
        val s = relativeTime(now + 5 * 60_000L, nowMillis = now)
        assertTrue(!s.startsWith("-"), "future time produced negative ago: '$s'")
    }

    @Test
    fun future_under_a_minute_is_just_now() {
        val s = relativeTime(now + 30_000L, nowMillis = now)
        assertEquals("Just now", s)
    }

    @Test
    fun future_hours_render_as_in_form() {
        val s = relativeTime(now + 3 * 3_600_000L, nowMillis = now)
        // Acceptable forms: "in 3h", "Just now" (if collapsed), or fall-through to month/day
        assertTrue(!s.contains("-"), "negative h leak: '$s'")
        assertTrue(s != "3h ago", "future formatted as past: '$s'")
    }
}
