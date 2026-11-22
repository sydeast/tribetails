package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/** #1599: a KinTale row from another year says which year. */
class KinTaleShortDateTimeTest {
    @Test
    fun thisYearIsMonthDayAndTime() {
        assertEquals("Nov 5, 2026 14:02", kinTaleShortDateTime("2026-11-05T14:02:00Z", 2026, java.time.ZoneOffset.UTC))
    }

    @Test
    fun anotherYearCarriesTheYear() {
        assertEquals("Sep 3, 2025 14:02", kinTaleShortDateTime("2025-09-03T14:02:00Z", 2026, java.time.ZoneOffset.UTC))
    }

    @Test
    fun freeTextIsEchoed() {
        assertEquals("Sep 3", kinTaleShortDateTime("Sep 3", 2026))
    }
}
/** #1599: the free text the May 2026 migration wrote reads as a date, on the row and in the sort. */
class KinTaleSortDateTest {
    private fun report(id: String, createdAt: String, sentAt: String? = null, visitDate: String = "") =
        com.tribetails.auntieos.data.model.KinCareReport(id = id, createdAt = createdAt, sentAt = sentAt, visitDate = visitDate)
    private fun ids(rows: List<com.tribetails.auntieos.data.model.KinCareReport>) = rows.map { it.id }
    @Test
    fun freeTextRowShowsItsDateAndTime() {
        assertEquals("Sep 3, 2025 14:02", kinTaleShortDateTime("September 3, 2025 2:02pm", 2026))
        assertEquals("Apr 10, 2026 09:00", kinTaleShortDateTime("April 10, 2026 9am", 2026))
    }
    @Test
    fun parsesIsoAndFreeTextToTheSameInstantScale() {
        assertEquals(kinTaleSortMillis("2025-09-03T14:02:00Z"), kinTaleSortMillis("September 3, 2025 2:02pm"))
        assertEquals(kinTaleSortMillis("2025-09-03T14:02:00Z"), kinTaleSortMillis("2025-09-03T09:02:00-05:00"))
        assertEquals(0L, kinTaleSortMillis("1970-01-01T00:00:00Z"))
    }
    @Test
    fun refusesWhatIsNotADate() {
        assertEquals(null, kinTaleSortMillis(""))
        assertEquals(null, kinTaleSortMillis(null))
        assertEquals(null, kinTaleSortMillis("last Tuesday-ish"))
        assertEquals(null, kinTaleSortMillis("February 30, 2026 1:00pm"))
        assertEquals(null, kinTaleSortMillis("September 3, 2025 13:02pm"))
    }
    @Test
    fun newestSortsByDateNotAlphabeticallyByMonthName() {
        val rows = listOf(
            report("sep", "September 3, 2025 2:02pm"),
            report("mar", "March 9, 2026 10:15am"),
            report("aug", "August 6, 2025 8:00am"),
            report("apr", "April 10, 2026 4:30pm"),
        )
        assertEquals(listOf("apr", "mar", "sep", "aug"), ids(sortReports(rows, ReportSort.Newest)))
        assertEquals(listOf("aug", "sep", "mar", "apr"), ids(sortReports(rows, ReportSort.Oldest)))
    }
    @Test
    fun mixedIsoAndFreeTextInterleaveByDate() {
        val rows = listOf(
            report("legacy-old", "August 6, 2025 8:00am"),
            report("iso-new", "2026-07-16T12:00:00Z"),
            report("legacy-mid", "April 10, 2026 4:30pm"),
            report("iso-old", "2025-09-01T12:00:00Z"),
        )
        assertEquals(listOf("iso-new", "legacy-mid", "iso-old", "legacy-old"), ids(sortReports(rows, ReportSort.Newest)))
    }
    @Test
    fun unparseableDatesSortLastInBothDirectionsAndAreKept() {
        val rows = listOf(
            report("junk", "last Tuesday-ish"),
            report("iso", "2026-07-16T12:00:00Z"),
            report("blank", ""),
            report("legacy", "April 10, 2026 4:30pm"),
        )
        assertEquals(listOf("iso", "legacy", "junk", "blank"), ids(sortReports(rows, ReportSort.Newest)))
        assertEquals(listOf("legacy", "iso", "junk", "blank"), ids(sortReports(rows, ReportSort.Oldest)))
    }
    @Test
    fun sentAtWinsOverCreatedAtWhenPresent() {
        val rows = listOf(
            report("a", createdAt = "2026-01-01T00:00:00Z", sentAt = "2026-09-01T00:00:00Z"),
            report("b", createdAt = "2026-05-01T00:00:00Z"),
        )
        assertEquals(listOf("a", "b"), ids(sortReports(rows, ReportSort.Newest)))
    }

    /**
     * #1856: the row's label reads visitDate first. A migrated report's sentAt
     * and createdAt can be the day it was copied over, so sorting on them put
     * the 2025 visits oldest first with a 2026 visit among them.
     */
    @Test
    fun theVisitDateTheLabelShowsIsTheDateItSortsOn() {
        val rows = listOf(
            report("aug06", createdAt = "2026-04-05T10:00:02Z", sentAt = "2026-04-05T10:00:02Z", visitDate = "2025-08-06T18:38:00Z"),
            report("aug29", createdAt = "2026-04-05T10:00:01Z", sentAt = "2026-04-05T10:00:01Z", visitDate = "2025-08-29T09:00:00Z"),
            report("apr04", createdAt = "2026-04-05T10:00:00Z", sentAt = "2026-04-05T10:00:00Z", visitDate = "2026-04-04T16:09:00Z"),
            report("nov11", createdAt = "2026-11-11T09:00:00Z", sentAt = "2026-11-11T09:00:00Z", visitDate = "2026-11-11T08:00:00Z"),
        )
        assertEquals(listOf("nov11", "apr04", "aug29", "aug06"), ids(sortReports(rows, ReportSort.Newest)))
        assertEquals(listOf("aug06", "aug29", "apr04", "nov11"), ids(sortReports(rows, ReportSort.Oldest)))
    }
}
