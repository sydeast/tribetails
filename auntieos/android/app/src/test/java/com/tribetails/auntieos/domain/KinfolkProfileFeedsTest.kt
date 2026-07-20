package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import org.junit.Assert.assertEquals
import org.junit.Test

/** Android mirror of web KinfolkProfileFeedsTest. */
class KinfolkProfileFeedsTest {

    @Test
    fun upcoming_keepsFutureScheduledForKinfolk_sortedAsc() {
        val sessions = listOf(
            KinCareSession(id = "a", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-10T09:00:00Z"),
            KinCareSession(id = "b", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-08T09:00:00Z"),
            KinCareSession(id = "past", kinfolkId = "k1", status = "scheduled", startTime = "2026-06-01T09:00:00Z"),
            KinCareSession(id = "other", kinfolkId = "k2", status = "scheduled", startTime = "2026-06-09T09:00:00Z"),
            KinCareSession(id = "done", kinfolkId = "k1", status = "completed", startTime = "2026-06-12T09:00:00Z"),
        )
        val out = upcomingVisitsFor(sessions, "k1", nowIso = "2026-06-07T00:00:00Z")
        assertEquals(listOf("b", "a"), out.map { it.id })
    }

    @Test
    fun recentTales_sentOnlyForKinfolk_newestFirst() {
        val reports = listOf(
            KinCareReport(id = "r1", kinfolkId = "k1", status = "SENT", sentAt = "2026-06-05T10:00:00Z"),
            KinCareReport(id = "r2", kinfolkId = "k1", status = "SENT", sentAt = "2026-06-06T10:00:00Z"),
            KinCareReport(id = "draft", kinfolkId = "k1", status = "DRAFT"),
            KinCareReport(id = "other", kinfolkId = "k2", status = "SENT", sentAt = "2026-06-07T10:00:00Z"),
        )
        assertEquals(listOf("r2", "r1"), recentTalesFor(reports, "k1").map { it.id })
    }

    @Test
    fun invoices_forKinfolk_newestFirst() {
        val invs = listOf(
            Invoice(id = "i1", kinfolkId = "k1", date = "2026-05-01"),
            Invoice(id = "i2", kinfolkId = "k1", date = "2026-06-01"),
            Invoice(id = "other", kinfolkId = "k2", date = "2026-07-01"),
        )
        assertEquals(listOf("i2", "i1"), invoicesForKinfolk(invs, "k1").map { it.id })
    }
}
