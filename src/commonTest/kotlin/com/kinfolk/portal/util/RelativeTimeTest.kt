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
