package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.KinCareReport
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1856: the Sent list ran its 2025 rows oldest first with a 2026 row among
 * them. Each row's label reads visitDate first; the sort read sentAt, then
 * updatedAt, and a migrated report's sentAt is the day it was copied over.
 */
class KinTaleSortMatchesLabelTest {
    private fun report(id: String, visitDate: String, copiedAt: String) =
        KinCareReport(_id = id, status = "SENT", visitDate = visitDate, sentAt = copiedAt, updatedAt = copiedAt, createdAt = copiedAt)

    private val rows = listOf(
        report("aug06", visitDate = "2025-08-06T18:38:00Z", copiedAt = "2026-04-05T10:00:02Z"),
        report("aug29", visitDate = "2025-08-29T09:00:00Z", copiedAt = "2026-04-05T10:00:01Z"),
        report("apr04", visitDate = "2026-04-04T16:09:00Z", copiedAt = "2026-04-05T10:00:00Z"),
        report("nov11", visitDate = "2026-11-11T08:00:00Z", copiedAt = "2026-11-11T09:00:00Z"),
    )

    @Test
    fun newestFirstRunsByTheDateTheLabelShows() {
        assertEquals(listOf("nov11", "apr04", "aug29", "aug06"), sortReports(rows, ReportSort.Newest).map { it._id })
        assertEquals(listOf("aug06", "aug29", "apr04", "nov11"), sortReports(rows, ReportSort.Oldest).map { it._id })
    }

    @Test
    fun noVisitDateFallsBackInTheLabelsOrder() {
        val sentOnly = KinCareReport(_id = "s", sentAt = "2026-09-01T00:00:00Z", createdAt = "2026-01-01T00:00:00Z")
        val createdOnly = KinCareReport(_id = "c", createdAt = "2026-05-01T00:00:00Z")
        assertEquals(listOf("s", "c"), sortReports(listOf(createdOnly, sentOnly), ReportSort.Newest).map { it._id })
    }
}
