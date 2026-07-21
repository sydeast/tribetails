package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper coverage for the six Stage-2 Step-2 features that were promoted from
 * dark flags to always-on. Mirrors the web Stage2Step2Helpers behavior.
 */
class Stage2Step2HelpersTest {

    // ── directory.lastVisit ───────────────────────────────────────────────────

    @Test fun lastVisit_keepsMostRecentCompletedPerKinfolk() {
        val sessions = listOf(
            KinCareSession(id = "s1", kinfolkId = "k1", status = "COMPLETED", completedAt = "2026-05-01T10:00:00"),
            KinCareSession(id = "s2", kinfolkId = "k1", status = "COMPLETED", completedAt = "2026-06-02T10:00:00"),
            KinCareSession(id = "s3", kinfolkId = "k2", status = "COMPLETED", completedAt = "2026-04-15T10:00:00"),
        )
        val map = lastVisitByKinfolk(sessions)
        assertEquals("2026-06-02", map["k1"])
        assertEquals("2026-04-15", map["k2"])
    }

    @Test fun lastVisit_ignoresNonCompletedAndBlankKinfolk() {
        val sessions = listOf(
            KinCareSession(id = "s1", kinfolkId = "k1", status = "SCHEDULED", startTime = "2026-06-01T10:00:00"),
            KinCareSession(id = "s2", kinfolkId = "", status = "COMPLETED", completedAt = "2026-06-02T10:00:00"),
            KinCareSession(id = "s3", kinfolkId = "k1", status = "CANCELLED", completedAt = "2026-06-03T10:00:00"),
        )
        assertTrue(lastVisitByKinfolk(sessions).isEmpty())
    }

    @Test fun lastVisit_fallsBackToStartTimeWhenCompletedAtBlank() {
        val sessions = listOf(
            KinCareSession(id = "s1", kinfolkId = "k1", status = "COMPLETED", completedAt = "", startTime = "2026-06-01T09:00:00"),
        )
        assertEquals("2026-06-01", lastVisitByKinfolk(sessions)["k1"])
    }

    // ── directory.newBadge ────────────────────────────────────────────────────

    @Test fun newBadge_trueWhenZeroKintales() {
        val kf = Kinfolk(id = "k1", joinDate = "2000-01-01")
        assertTrue(isNewKinfolk(kf, kintaleCount = 0, nowIso = "2026-06-05"))
    }

    @Test fun newBadge_trueWhenRecentlyJoined() {
        val kf = Kinfolk(id = "k1", joinDate = "2026-05-30")
        assertTrue(isNewKinfolk(kf, kintaleCount = 5, nowIso = "2026-06-05")) // 6 days
    }

    @Test fun newBadge_falseWhenOldAndHasKintales() {
        val kf = Kinfolk(id = "k1", joinDate = "2026-01-01")
        assertFalse(isNewKinfolk(kf, kintaleCount = 5, nowIso = "2026-06-05"))
    }

    @Test fun newBadge_boundaryExactly14Days() {
        val kf = Kinfolk(id = "k1", joinDate = "2026-05-22")
        assertTrue(isNewKinfolk(kf, kintaleCount = 1, nowIso = "2026-06-05")) // 14 days
        val kf15 = Kinfolk(id = "k2", joinDate = "2026-05-21")
        assertFalse(isNewKinfolk(kf15, kintaleCount = 1, nowIso = "2026-06-05")) // 15 days
    }

    @Test fun newBadge_blankJoinDateRestsOnKintaleSignalOnly() {
        val kf = Kinfolk(id = "k1", joinDate = "")
        // has kintales + no provable created date -> not new
        assertFalse(isNewKinfolk(kf, kintaleCount = 3, nowIso = "2026-06-05"))
    }

    // ── auntieTime.multiPetAvatars ────────────────────────────────────────────

    @Test fun kinAvatars_joinsKinIdsInOrderAndDropsUnknown() {
        val kinById = mapOf(
            "a" to Kin(id = "a", name = "Rex", profilePictureUrl = "url-a"),
            "b" to Kin(id = "b", name = "Otis"),
        )
        val s = KinCareSession(id = "s1", kinIds = listOf("a", "b", "ghost"))
        val avatars = kinAvatarsForSession(s, kinById)
        assertEquals(listOf("Rex", "Otis"), avatars.map { it.initials })
        assertEquals("url-a", avatars[0].imageUrl)
        assertEquals("a", avatars[0].seed)
    }

    @Test fun kinAvatars_fallsBackToSingleKinId() {
        val kinById = mapOf("a" to Kin(id = "a", name = "Rex"))
        val s = KinCareSession(id = "s1", kinId = "a", kinIds = emptyList())
        assertEquals(listOf("Rex"), kinAvatarsForSession(s, kinById).map { it.initials })
    }

    @Test fun kinAvatars_emptyWhenNoKin() {
        val s = KinCareSession(id = "s1", kinId = "", kinIds = emptyList())
        assertTrue(kinAvatarsForSession(s, emptyMap()).isEmpty())
    }

    // ── home.weeklyRevenueStat ────────────────────────────────────────────────

    @Test fun weeklyRevenue_sumsPaidInvoicesInWindow() {
        val invoices = listOf(
            Invoice(id = "i1", status = "paid", total = 100.0, amountDue = 0.0, date = "2026-06-02"),
            Invoice(id = "i2", status = "paid", total = 50.0, amountDue = 0.0, date = "2026-06-05"),
            Invoice(id = "i3", status = "paid", total = 999.0, amountDue = 0.0, date = "2026-05-25"), // before window
            Invoice(id = "i4", status = "unpaid", total = 200.0, amountDue = 200.0, date = "2026-06-03"), // not paid
            Invoice(id = "i5", status = "draft", total = 300.0, amountDue = 0.0, date = "2026-06-03"), // draft excluded
        )
        assertEquals(150.0, weeklyRevenue(invoices, "2026-06-01", "2026-06-05"), 0.0)
    }

    @Test fun weeklyRevenue_skipsUnparseableDate() {
        val invoices = listOf(
            Invoice(id = "i1", status = "paid", total = 100.0, amountDue = 0.0, date = ""),
        )
        assertEquals(0.0, weeklyRevenue(invoices, "2026-06-01", "2026-06-05"), 0.0)
    }

    @Test fun weeklyRevenue_windowEdgesInclusive_outsideDropped() {
        val invoices = listOf(
            Invoice(id = "mon", status = "paid", total = 10.0, amountDue = 0.0, date = "2026-06-01"), // Monday edge
            Invoice(id = "today", status = "paid", total = 20.0, amountDue = 0.0, date = "2026-06-05"), // today edge
            Invoice(id = "sun", status = "paid", total = 99.0, amountDue = 0.0, date = "2026-05-31"), // day before Monday
            Invoice(id = "next", status = "paid", total = 99.0, amountDue = 0.0, date = "2026-06-06"), // after today
        )
        assertEquals(30.0, weeklyRevenue(invoices, "2026-06-01", "2026-06-05"), 0.0)
    }

    // ── schedule.dragReschedule (arg mapping) ─────────────────────────────────

    @Test fun rescheduleArgs_snapsAndPreservesDuration() {
        val s = KinCareSession(id = "s1", serviceDurationMinutes = 60)
        val args = rescheduleArgsForDrop(s, "2026-06-10", dropMinuteOfDay = 9 * 60 + 7, snapMinutes = 15)!!
        assertEquals("s1", args.sessionId)
        assertEquals("2026-06-10T09:00:00", args.startTime) // 547 -> snapped to 540 (09:00)
        assertEquals("2026-06-10T10:00:00", args.endTime)
    }

    @Test fun rescheduleArgs_derivesDurationFromStartEndSpan() {
        val s = KinCareSession(id = "s1", startTime = "2026-06-01T08:00:00", endTime = "2026-06-01T08:45:00")
        val args = rescheduleArgsForDrop(s, "2026-06-10", dropMinuteOfDay = 600, snapMinutes = 15)!!
        assertEquals("2026-06-10T10:00:00", args.startTime)
        assertEquals("2026-06-10T10:45:00", args.endTime) // 45-min span preserved
    }

    @Test fun rescheduleArgs_failsLoudOnJunk() {
        assertEquals(null, rescheduleArgsForDrop(KinCareSession(id = ""), "2026-06-10", 600))
        assertEquals(null, rescheduleArgsForDrop(KinCareSession(id = "s1"), "2026-06-10", 1440))
        assertEquals(null, rescheduleArgsForDrop(KinCareSession(id = "s1"), "bad-date", 600))
    }
}
