package com.tribetails.auntieos.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * Mirrors the web `src/lib/joinDate.test.ts`, case for case. Both surfaces edit
 * the same field in the same collection, so a divergence here is a divergence in
 * what gets written.
 */
class JoinDateTest {

    @Test fun isIsoDate_acceptsRealCalendarDays() {
        assertTrue(isIsoDate("2026-07-24"))
        assertTrue(isIsoDate("2024-02-29"))
    }

    @Test fun isIsoDate_rejectsAnythingElse() {
        assertFalse(isIsoDate(""))
        assertFalse(isIsoDate("07/24/2026"))
        assertFalse(isIsoDate("2026-7-4"))
        assertFalse(isIsoDate("2026-07-24T12:00:00.000Z"))
    }

    @Test fun isIsoDate_rejectsWellShapedDaysThatDoNotExist() {
        assertFalse(isIsoDate("2026-02-30"))
        assertFalse(isIsoDate("2026-13-01"))
    }

    @Test fun forEdit_passesAnIsoDayThrough() {
        assertEquals(JoinDateForEdit("2026-07-24", null), joinDateForEdit("2026-07-24"))
    }

    @Test fun forEdit_treatsBlankAsBlank() {
        assertEquals(JoinDateForEdit("", null), joinDateForEdit(""))
        assertEquals(JoinDateForEdit("", null), joinDateForEdit("   "))
    }

    @Test fun forEdit_readsTheDayOutOfAStoredTimestampAndSaysSo() {
        val got = joinDateForEdit("2026-07-24T12:34:56.789Z")
        assertEquals("2026-07-24", got.value)
        assertTrue(got.note!!.contains("2026-07-24T12:34:56.789Z"))
    }

    @Test fun forEdit_refusesToGuessAtAnAmbiguousLegacyFormat() {
        val got = joinDateForEdit("07/24/2026")
        assertEquals("", got.value)
        assertTrue(got.note!!.contains("07/24/2026"))
    }

    @Test fun format_rendersAnIsoDayInTheMediumStyle() {
        val previous = Locale.getDefault()
        Locale.setDefault(Locale.US)
        try {
            assertEquals("Jul 24, 2026", formatJoinDate("2026-07-24"))
            assertEquals("Jul 24, 2026", formatJoinDate("2026-07-24T12:34:56.789Z"))
            assertEquals("Jan 1, 2026", formatJoinDate("2026-01-01"))
        } finally {
            Locale.setDefault(previous)
        }
    }

    @Test fun format_passesLegacyValuesThroughUntouched() {
        assertEquals("07/24/2026", formatJoinDate("07/24/2026"))
        assertEquals("sometime in the spring", formatJoinDate("sometime in the spring"))
        assertEquals("2026-02-30", formatJoinDate("2026-02-30"))
        assertEquals("", formatJoinDate(""))
    }

    @Test fun format_neverThrowsOnJunk() {
        assertEquals("!!!", formatJoinDate("!!!"))
        assertNull(joinDateForEdit("2026-07-24").note)
    }
}
