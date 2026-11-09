package com.tribetails.auntieos.web
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.screens.kintales.ReportSort
import com.tribetails.auntieos.web.screens.kintales.kinTaleShortDateTime
import com.tribetails.auntieos.web.screens.kintales.kinTaleSortMillis
import com.tribetails.auntieos.web.screens.kintales.sortReports
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1599: the KinTales list sorts on a parsed date. The 83 rows the May 2026
 * migration wrote hold "September 3, 2025 2:02pm" in createdAt; as strings they
 * sort above every ISO row and alphabetically by month name.
 */
class KinTaleSortDateTest {
    private fun r(id: String, createdAt: String, sentAt: String = "") =
        KinCareReport(_id = id, createdAt = createdAt, sentAt = sentAt)
    private fun ids(rows: List<KinCareReport>) = rows.map { it._id }
    @Test
    fun `free text row shows its date and time`() {
        assertEquals("Sep 3, 2025 · 14:02", kinTaleShortDateTime("September 3, 2025 2:02pm", 2026))
        assertEquals("Apr 10 · 09:00", kinTaleShortDateTime("April 10, 2026 9am", 2026))
    }
    @Test
    fun `ISO and free text parse to the same instant scale`() {
        assertEquals(kinTaleSortMillis("2025-09-03T14:02:00Z"), kinTaleSortMillis("September 3, 2025 2:02pm"))
        assertEquals(kinTaleSortMillis("2025-09-03T14:02:00Z"), kinTaleSortMillis("2025-09-03T09:02:00-05:00"))
        assertEquals(0L, kinTaleSortMillis("1970-01-01T00:00:00Z"))
    }
    @Test
    fun `text that is not a date has no millis`() {
        assertNull(kinTaleSortMillis(""))
        assertNull(kinTaleSortMillis("last Tuesday-ish"))
        assertNull(kinTaleSortMillis("February 30, 2026 1:00pm"))
        assertNull(kinTaleSortMillis("September 3, 2025 13:02pm"))
    }
    @Test
    fun `newest sorts by date, not alphabetically by month name`() {
        val rows = listOf(
            r("sep", "September 3, 2025 2:02pm"),
            r("mar", "March 9, 2026 10:15am"),
            r("aug", "August 6, 2025 8:00am"),
            r("apr", "April 10, 2026 4:30pm"),
        )
        assertEquals(listOf("apr", "mar", "sep", "aug"), ids(sortReports(rows, ReportSort.Newest)))
        assertEquals(listOf("aug", "sep", "mar", "apr"), ids(sortReports(rows, ReportSort.Oldest)))
    }
    @Test
    fun `mixed ISO and free text interleave by date`() {
        val rows = listOf(
            r("legacy-old", "August 6, 2025 8:00am"),
            r("iso-new", "2026-07-16T12:00:00Z"),
            r("legacy-mid", "April 10, 2026 4:30pm"),
            r("iso-old", "2025-09-01T12:00:00Z"),
        )
        assertEquals(listOf("iso-new", "legacy-mid", "iso-old", "legacy-old"), ids(sortReports(rows, ReportSort.Newest)))
    }
    @Test
    fun `unparseable dates sort last in both directions and are kept`() {
        val rows = listOf(
            r("junk", "last Tuesday-ish"),
            r("iso", "2026-07-16T12:00:00Z"),
            r("blank", ""),
            r("legacy", "April 10, 2026 4:30pm"),
        )
        assertEquals(listOf("iso", "legacy", "junk", "blank"), ids(sortReports(rows, ReportSort.Newest)))
        assertEquals(listOf("legacy", "iso", "junk", "blank"), ids(sortReports(rows, ReportSort.Oldest)))
    }
}
