package com.tribetails.auntieos.web
import com.tribetails.auntieos.web.data.VisitInternalNote
import com.tribetails.auntieos.web.screens.activity.relativeDayLabel
import com.tribetails.auntieos.web.screens.inbox.shortDateTime
import com.tribetails.auntieos.web.screens.schedule.visitNoteByline
import com.tribetails.auntieos.web.screens.sessions.shortIso
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
/**
 * #1599: desktop lists that span more than a year name the year when a row is
 * not from the current one. The year-boundary cases use the business zone's own
 * wall clock, not UTC, so New Year's Eve evening stays in the old year.
 */
class ListDateYearTest {
    @Test
    fun `inbox and visit rows omit this year and name another`() {
        assertEquals("Jul 2 · 14:02", shortDateTime("2026-07-02T14:02:00Z", 2026))
        assertEquals("Jul 2, 2025 · 14:02", shortDateTime("2025-07-02T14:02:00Z", 2026))
        assertEquals("Jul 2 · 14:02", shortIso("2026-07-02T14:02:00Z", 2026))
        assertEquals("Jul 2, 2025 · 14:02", shortIso("2025-07-02T14:02:00Z", 2026))
    }
    @Test
    fun `an unreadable stamp is shown as stored`() {
        assertEquals("soon", shortDateTime("soon", 2026))
        assertEquals("soon", shortIso("soon", 2026))
    }
    @Test
    fun `activity day headings name the year only for another year`() {
        assertEquals("Today · Nov 9", relativeDayLabel("2026-11-09", "2026-11-09", "2026-11-08"))
        assertEquals("Yesterday · Nov 8", relativeDayLabel("2026-11-08", "2026-11-09", "2026-11-08"))
        assertEquals("May 24", relativeDayLabel("2026-05-24", "2026-11-09", "2026-11-08"))
        assertEquals("May 24, 2025", relativeDayLabel("2025-05-24", "2026-11-09", "2026-11-08"))
        // New Year: Dec 31 is "Yesterday" on Jan 1, and says so without a year.
        assertEquals("Yesterday · Dec 31", relativeDayLabel("2026-12-31", "2027-01-01", "2026-12-31"))
    }
    @Test
    fun `visit note stamps read the year in the business zone`() {
        val chicago = TimeZone.of("America/Chicago")
        // 2027-01-01 05:30 UTC is 2026-12-31 23:30 in Chicago; 06:30 UTC is 00:30 on Jan 1.
        val newYearsEve = note(1_798_781_400_000L)
        val newYear = note(1_798_785_000_000L)
        assertEquals("Staff · Dec 31, 11:30 PM", visitNoteByline(newYearsEve, chicago, 2026))
        assertEquals("Staff · Jan 1, 2027, 12:30 AM", visitNoteByline(newYear, chicago, 2026))
    }
    private fun note(ms: Long) = VisitInternalNote("n", "x", "unknown", null, ms, "shared", "thread")
}
