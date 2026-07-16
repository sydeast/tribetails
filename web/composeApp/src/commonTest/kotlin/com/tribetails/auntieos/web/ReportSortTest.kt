package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.screens.kintales.ReportSort
import com.tribetails.auntieos.web.screens.kintales.sortReports
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * KT1: the KinTales (Sent) list was an ever-growing pile sorted only newest-first.
 * sortReports adds operator-chosen ordering (newest/oldest/kinfolk/service) so the
 * Sent bucket can be organized, not just scrolled.
 */
class ReportSortTest {

    private fun r(id: String, kin: String, svc: String, sentAt: String) =
        KinCareReport(_id = id, kinfolkName = kin, serviceType = svc, sentAt = sentAt)

    private val reports = listOf(
        r("a", "Zoe", "Walk", "2026-04-01T10:00:00Z"),
        r("b", "Amy", "Daycare", "2026-04-03T10:00:00Z"),
        r("c", "Nova", "Walk", "2026-04-02T10:00:00Z"),
    )

    @Test
    fun `newest first by sent date`() {
        assertEquals(listOf("b", "c", "a"), sortReports(reports, ReportSort.Newest).map { it._id })
    }

    @Test
    fun `oldest first by sent date`() {
        assertEquals(listOf("a", "c", "b"), sortReports(reports, ReportSort.Oldest).map { it._id })
    }

    @Test
    fun `by kinfolk name alphabetical`() {
        // Amy(b), Nova(c), Zoe(a)
        assertEquals(listOf("b", "c", "a"), sortReports(reports, ReportSort.Kinfolk).map { it._id })
    }

    @Test
    fun `by service type alphabetical then newest within a type`() {
        // Daycare(b) first; then Walk group newest-first: c (04-02) before a (04-01)
        assertEquals(listOf("b", "c", "a"), sortReports(reports, ReportSort.Service).map { it._id })
    }
}
