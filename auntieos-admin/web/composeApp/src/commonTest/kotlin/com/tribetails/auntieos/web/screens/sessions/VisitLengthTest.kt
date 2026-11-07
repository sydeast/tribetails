package com.tribetails.auntieos.web.screens.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** #1581: a 20:00 to 20:30 visit stored with length 0 is a 30-minute visit. */
class VisitLengthTest {
    @Test
    fun aStoredZeroFallsBackToTheWindow() {
        assertEquals(30, shownVisitLengthMinutes(0, "2026-11-06T02:00:00Z", "2026-11-06T02:30:00Z"))
        assertEquals(30, shownVisitLengthMinutes(0, "2026-11-05T20:00:00", "2026-11-05T20:30:00"))
    }

    @Test
    fun aRealStoredLengthWins() {
        assertEquals(45, shownVisitLengthMinutes(45, "2026-11-06T02:00:00Z", "2026-11-06T02:30:00Z"))
    }

    @Test
    fun nothingReadableIsNullNotAGuess() {
        assertNull(shownVisitLengthMinutes(0, "", ""))
        assertNull(shownVisitLengthMinutes(0, "2026-11-06T02:30:00Z", "2026-11-06T02:00:00Z"))
    }
}
