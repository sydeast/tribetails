package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #1581: a 20:00 to 20:30 visit stored with length 0 is a 30-minute visit. */
class VisitLengthTest {
    @Test
    fun `a stored zero falls back to the window`() {
        assertEquals(30, shownVisitLengthMinutes(0, "2026-11-06T02:00:00Z", "2026-11-06T02:30:00Z"))
        assertEquals(30, shownVisitLengthMinutes(0, "2026-11-05T20:00:00", "2026-11-05T20:30:00"))
    }

    @Test
    fun `a real stored length wins`() {
        assertEquals(45, shownVisitLengthMinutes(45, "2026-11-06T02:00:00Z", "2026-11-06T02:30:00Z"))
    }

    @Test
    fun `nothing readable is null, not a guess`() {
        assertNull(shownVisitLengthMinutes(0, "", ""))
        assertNull(shownVisitLengthMinutes(0, "2026-11-06T02:30:00Z", "2026-11-06T02:00:00Z"))
    }
}
