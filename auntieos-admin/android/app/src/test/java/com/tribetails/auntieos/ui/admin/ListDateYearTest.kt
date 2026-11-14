package com.tribetails.auntieos.ui.admin
import com.tribetails.auntieos.domain.formatReminderTime
import com.tribetails.auntieos.ui.calls.formatTimestamp
import com.tribetails.auntieos.ui.communicate.humanizeDate
import java.time.Instant
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Test
/**
 * #1599: admin Android lists that span more than a year name the year when a
 * row is not from the current one, read in the operator's zone
 * (America/Chicago), so New Year's Eve evening is not filed under the next year.
 */
class ListDateYearTest {
    private val chicago = TimeZone.getTimeZone("America/Chicago")
    private val now2026 = Instant.parse("2026-12-31T18:00:00Z").toEpochMilli()
    // 2027-01-01 05:30 UTC is 2026-12-31 23:30 in Chicago; 06:30 UTC is 00:30 on Jan 1.
    private val newYearsEve = Instant.parse("2027-01-01T05:30:00Z").toEpochMilli()
    private val newYear = Instant.parse("2027-01-01T06:30:00Z").toEpochMilli()
    @Test
    fun reminderTimeOmitsThisYearAndNamesAnother() {
        assertEquals("Sep 14, 3:05 PM", formatReminderTime(Instant.parse("2026-09-14T20:05:00Z").toEpochMilli(), chicago, now2026))
        assertEquals("Sep 14, 2025, 3:05 PM", formatReminderTime(Instant.parse("2025-09-14T20:05:00Z").toEpochMilli(), chicago, now2026))
    }
    @Test
    fun reminderTimeReadsTheYearBoundaryInChicago() {
        assertEquals("Dec 31, 11:30 PM", formatReminderTime(newYearsEve, chicago, now2026))
        assertEquals("Jan 1, 2027, 12:30 AM", formatReminderTime(newYear, chicago, now2026))
    }
    @Test
    fun callTimestampNamesTheYearOnlyOutsideThisOne() {
        val saved = TimeZone.getDefault()
        TimeZone.setDefault(chicago)
        try {
            assertEquals("Jul 2, 3:00 PM", formatTimestamp(Instant.parse("2026-07-02T20:00:00Z").toEpochMilli(), now2026))
            assertEquals("Jul 2, 2025, 3:00 PM", formatTimestamp(Instant.parse("2025-07-02T20:00:00Z").toEpochMilli(), now2026))
            assertEquals("Dec 31, 11:30 PM", formatTimestamp(newYearsEve, now2026))
            assertEquals("Jan 1, 2027, 12:30 AM", formatTimestamp(newYear, now2026))
        } finally {
            TimeZone.setDefault(saved)
        }
    }
    @Test
    fun communicateDateNamesTheYearOutsideThisOne() {
        assertEquals("Jul 2", humanizeDate("2026-07-02T14:00:00Z", 2026))
        assertEquals("Jul 2, 2025", humanizeDate("2025-07-02T14:00:00Z", 2026))
    }
    @Test
    fun communicateDateShowsUnreadableTextAsStored() {
        assertEquals("sometime in July", humanizeDate("sometime in July", 2026))
    }

    @Test
    fun inboxAndVisitRowsNameTheYearOutsideThisOne() {
        assertEquals("Jul 2 · 14:02", com.tribetails.auntieos.ui.inbox.shortDateTime("2026-07-02T14:02:00Z", 2026))
        assertEquals("Jul 2, 2025 · 14:02", com.tribetails.auntieos.ui.inbox.shortDateTime("2025-07-02T14:02:00Z", 2026))
        assertEquals("Jul 2, 2025 · 14:02", shortIso("2025-07-02T14:02:00Z", 2026, java.time.ZoneOffset.UTC))
        assertEquals("soon", shortIso("soon", 2026))
    }

    @Test
    fun visitDetailTimesReadOnTheBusinessClock() {
        // #2095: 11:30 PM Chicago on Nov 11 is 05:30 UTC on Nov 12.
        val chicago = java.time.ZoneId.of("America/Chicago")
        assertEquals("Nov 11 · 23:30", shortIso("2026-11-12T05:30:00.000Z", 2026, chicago))
        assertEquals("Nov 11 · 23:30", shortIso("2026-11-11T23:30:00", 2026, chicago))
        // The night clocks go back: 23:30 CST Nov 1 is 05:30 UTC Nov 2.
        assertEquals("Nov 1 · 23:30", shortIso("2026-11-02T05:30:00Z", 2026, chicago))
    }
    @Test
    fun activityDayHeadingsNameTheYearOnlyForAnotherYear() {
        assertEquals("Today · Nov 9", relativeDayLabel("2026-11-09", "2026-11-09", "2026-11-08"))
        assertEquals("May 24", relativeDayLabel("2026-05-24", "2026-11-09", "2026-11-08"))
        assertEquals("May 24, 2025", relativeDayLabel("2025-05-24", "2026-11-09", "2026-11-08"))
        assertEquals("Yesterday · Dec 31", relativeDayLabel("2026-12-31", "2027-01-01", "2026-12-31"))
    }
}
