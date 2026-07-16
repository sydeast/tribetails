package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals

class KinfolkProfileFeedsTest {

    @Test
    fun upcoming_keepsFutureScheduledForKinfolk_sortedAsc() {
        val sessions = listOf(
            KinCareSession(_id = "a", kinfolkId = "k1", status = "SCHEDULED", startTime = "2026-06-10T09:00:00Z"),
            KinCareSession(_id = "b", kinfolkId = "k1", status = "SCHEDULED", startTime = "2026-06-08T09:00:00Z"),
            KinCareSession(_id = "past", kinfolkId = "k1", status = "SCHEDULED", startTime = "2026-06-01T09:00:00Z"),
            KinCareSession(_id = "other", kinfolkId = "k2", status = "SCHEDULED", startTime = "2026-06-09T09:00:00Z"),
            KinCareSession(_id = "done", kinfolkId = "k1", status = "COMPLETED", startTime = "2026-06-12T09:00:00Z"),
            KinCareSession(_id = "noTime", kinfolkId = "k1", status = "SCHEDULED", startTime = ""),
        )
        val out = upcomingVisitsFor(sessions, "k1", nowIso = "2026-06-07T00:00:00Z")
        assertEquals(listOf("b", "a"), out.map { it._id })
    }

    @Test
    fun upcoming_emptyWhenNoneMatch() {
        assertEquals(emptyList(), upcomingVisitsFor(emptyList(), "k1", "2026-06-07T00:00:00Z"))
    }

    @Test
    fun recentTales_sentOnlyForKinfolk_newestFirst_withVisitDateFallback() {
        val reports = listOf(
            KinCareReport(_id = "r1", kinfolkId = "k1", status = "SENT", sentAt = "2026-06-05T10:00:00Z"),
            KinCareReport(_id = "r2", kinfolkId = "k1", status = "SENT", sentAt = "2026-06-06T10:00:00Z"),
            KinCareReport(_id = "draft", kinfolkId = "k1", status = "DRAFT", sentAt = ""),
            KinCareReport(_id = "other", kinfolkId = "k2", status = "SENT", sentAt = "2026-06-07T10:00:00Z"),
            KinCareReport(_id = "r3", kinfolkId = "k1", status = "SENT", sentAt = "", visitDate = "2026-06-04"),
        )
        assertEquals(listOf("r2", "r1", "r3"), recentTalesFor(reports, "k1").map { it._id })
    }

    @Test
    fun invoices_forKinfolk_newestFirst() {
        val invs = listOf(
            Invoice(_id = "i1", kinfolkId = "k1", date = "2026-05-01"),
            Invoice(_id = "i2", kinfolkId = "k1", date = "2026-06-01"),
            Invoice(_id = "other", kinfolkId = "k2", date = "2026-07-01"),
        )
        assertEquals(listOf("i2", "i1"), invoicesForKinfolk(invs, "k1").map { it._id })
    }

    @Test
    fun invoices_limitRespected() {
        val many = (1..10).map { Invoice(_id = "i$it", kinfolkId = "k1", date = "2026-06-${it.toString().padStart(2, '0')}") }
        assertEquals(5, invoicesForKinfolk(many, "k1", limit = 5).size)
    }
}
