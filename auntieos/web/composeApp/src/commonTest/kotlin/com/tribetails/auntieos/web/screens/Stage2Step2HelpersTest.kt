package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

/**
 * Pure-helper coverage for the Stage-2 Step-2 features promoted from dark feature
 * flags to always-on: lastVisitByKinfolk, isNewKinfolk, kinAvatarsForSession,
 * weeklyRevenue, and rescheduleArgsForDrop (the drag->reschedule arg mapping).
 */
class Stage2Step2HelpersTest {

    // ── lastVisitByKinfolk ─────────────────────────────────────────────────────

    @Test fun `lastVisit picks the most recent COMPLETED session per kinfolk`() {
        val sessions = listOf(
            KinCareSession(_id = "a", kinfolkId = "kf-1", status = "COMPLETED", completedAt = "2026-05-10T09:00:00Z"),
            KinCareSession(_id = "b", kinfolkId = "kf-1", status = "COMPLETED", completedAt = "2026-05-25T09:00:00Z"),
            KinCareSession(_id = "c", kinfolkId = "kf-2", status = "COMPLETED", completedAt = "2026-04-01T09:00:00Z"),
        )
        val map = lastVisitByKinfolk(sessions)
        assertEquals("2026-05-25", map["kf-1"])
        assertEquals("2026-04-01", map["kf-2"])
    }

    @Test fun `lastVisit ignores non-completed sessions`() {
        val sessions = listOf(
            KinCareSession(_id = "a", kinfolkId = "kf-1", status = "SCHEDULED", startTime = "2026-06-01T09:00:00Z"),
            KinCareSession(_id = "b", kinfolkId = "kf-1", status = "CANCELLED", startTime = "2026-06-02T09:00:00Z"),
        )
        assertTrue(lastVisitByKinfolk(sessions).isEmpty())
    }

    @Test fun `lastVisit falls back to startTime when completedAt is blank`() {
        val sessions = listOf(
            KinCareSession(_id = "a", kinfolkId = "kf-1", status = "COMPLETED", startTime = "2026-05-20T08:00:00Z", completedAt = ""),
        )
        assertEquals("2026-05-20", lastVisitByKinfolk(sessions)["kf-1"])
    }

    @Test fun `lastVisit skips sessions with no parseable date and blank kinfolk`() {
        val sessions = listOf(
            KinCareSession(_id = "a", kinfolkId = "kf-1", status = "COMPLETED", completedAt = "not-a-date"),
            KinCareSession(_id = "b", kinfolkId = "", status = "COMPLETED", completedAt = "2026-05-01T09:00:00Z"),
        )
        assertTrue(lastVisitByKinfolk(sessions).isEmpty())
    }

    // ── isNewKinfolk ───────────────────────────────────────────────────────────

    @Test fun `isNew when zero kintales regardless of join date`() {
        val kf = Kinfolk(_id = "kf-1", joinDate = "2020-01-01")
        assertTrue(isNewKinfolk(kf, kintaleCount = 0, nowIso = "2026-06-05"))
    }

    @Test fun `isNew when created within 14 days`() {
        val kf = Kinfolk(_id = "kf-1", joinDate = "2026-06-01")
        assertTrue(isNewKinfolk(kf, kintaleCount = 5, nowIso = "2026-06-05"))
    }

    @Test fun `not new when older than 14 days and has kintales`() {
        val kf = Kinfolk(_id = "kf-1", joinDate = "2026-05-01")
        assertFalse(isNewKinfolk(kf, kintaleCount = 3, nowIso = "2026-06-05"))
    }

    @Test fun `not new when join date is exactly 15 days ago with kintales`() {
        val kf = Kinfolk(_id = "kf-1", joinDate = "2026-05-21")
        assertFalse(isNewKinfolk(kf, kintaleCount = 1, nowIso = "2026-06-05"))
    }

    @Test fun `new when join date is exactly 14 days ago boundary with kintales`() {
        val kf = Kinfolk(_id = "kf-1", joinDate = "2026-05-22")
        assertTrue(isNewKinfolk(kf, kintaleCount = 1, nowIso = "2026-06-05"))
    }

    @Test fun `not new when join date unparseable and has kintales`() {
        val kf = Kinfolk(_id = "kf-1", joinDate = "")
        assertFalse(isNewKinfolk(kf, kintaleCount = 2, nowIso = "2026-06-05"))
    }

    // ── kinAvatarsForSession ────────────────────────────────────────────────────

    private val kinA = Kin(_id = "kin-a", name = "Biscuit", profilePictureUrl = "https://img/a.jpg")
    private val kinB = Kin(_id = "kin-b", name = "Gravy", profilePictureUrl = "")
    private val kinById = mapOf("kin-a" to kinA, "kin-b" to kinB)

    @Test fun `avatars resolve from kinIds in order`() {
        val sess = KinCareSession(_id = "s", kinIds = listOf("kin-b", "kin-a"))
        val avatars = kinAvatarsForSession(sess, kinById)
        assertEquals(listOf("Gravy", "Biscuit"), avatars.map { it.initials })
        assertEquals("https://img/a.jpg", avatars[1].imageUrl)
    }

    @Test fun `avatars fall back to single kinId when kinIds empty`() {
        val sess = KinCareSession(_id = "s", kinId = "kin-a")
        val avatars = kinAvatarsForSession(sess, kinById)
        assertEquals(1, avatars.size)
        assertEquals("Biscuit", avatars[0].initials)
    }

    @Test fun `avatars drop unknown ids without fabricating a face`() {
        val sess = KinCareSession(_id = "s", kinIds = listOf("kin-a", "ghost"))
        val avatars = kinAvatarsForSession(sess, kinById)
        assertEquals(listOf("kin-a"), avatars.map { it.seed })
    }

    @Test fun `avatars empty when no kin references`() {
        val sess = KinCareSession(_id = "s")
        assertTrue(kinAvatarsForSession(sess, kinById).isEmpty())
    }

    // ── weeklyRevenue ───────────────────────────────────────────────────────────

    @Test fun `weeklyRevenue sums paid invoices in the week window`() {
        val invoices = listOf(
            Invoice(_id = "1", status = "paid", amountDue = 0.0, total = 100.0, date = "2026-06-02"),
            Invoice(_id = "2", status = "paid", amountDue = 0.0, total = 50.0, date = "2026-06-05"),
            // outstanding: excluded
            Invoice(_id = "3", status = "outstanding", amountDue = 80.0, total = 80.0, date = "2026-06-03"),
            // paid but dated before the week start: excluded
            Invoice(_id = "4", status = "paid", amountDue = 0.0, total = 999.0, date = "2026-05-30"),
        )
        assertEquals(150.0, weeklyRevenue(invoices, weekStartIso = "2026-06-01", nowIso = "2026-06-07"))
    }

    @Test fun `weeklyRevenue includes the window boundary dates`() {
        val invoices = listOf(
            Invoice(_id = "a", status = "paid", amountDue = 0.0, total = 10.0, date = "2026-06-01"),
            Invoice(_id = "b", status = "paid", amountDue = 0.0, total = 20.0, date = "2026-06-07"),
        )
        assertEquals(30.0, weeklyRevenue(invoices, "2026-06-01", "2026-06-07"))
    }

    @Test fun `weeklyRevenue skips invoices with unparseable dates`() {
        val invoices = listOf(
            Invoice(_id = "a", status = "paid", amountDue = 0.0, total = 40.0, date = "garbage"),
        )
        assertEquals(0.0, weeklyRevenue(invoices, "2026-06-01", "2026-06-07"))
    }

    // ── rescheduleArgsForDrop ───────────────────────────────────────────────────

    @Test fun `reschedule maps drop minute to ISO start, preserving duration`() {
        val sess = KinCareSession(_id = "s-1", serviceDurationMinutes = 60, startTime = "2026-06-01T09:00:00Z")
        // drop at 10:07 -> snapped to 15-min -> 10:00
        val args = rescheduleArgsForDrop(sess, targetDateIso = "2026-06-03", dropMinuteOfDay = 607)
        assertEquals("s-1", args?.sessionId)
        assertEquals("2026-06-03T10:00:00", args?.startTime)
        assertEquals("2026-06-03T11:00:00", args?.endTime)
    }

    @Test fun `reschedule derives duration from start-end span when field absent`() {
        // 30-minute original span, no serviceDurationMinutes
        val sess = KinCareSession(_id = "s-2", startTime = "2026-06-01T09:00:00", endTime = "2026-06-01T09:30:00")
        val args = rescheduleArgsForDrop(sess, "2026-06-04", dropMinuteOfDay = 480) // 08:00
        assertEquals("2026-06-04T08:00:00", args?.startTime)
        assertEquals("2026-06-04T08:30:00", args?.endTime)
    }

    @Test fun `reschedule returns null for blank session id`() {
        val sess = KinCareSession(_id = "", serviceDurationMinutes = 30)
        assertNull(rescheduleArgsForDrop(sess, "2026-06-04", 480))
    }

    @Test fun `reschedule returns null for out-of-range drop minute`() {
        val sess = KinCareSession(_id = "s-3", serviceDurationMinutes = 30)
        assertNull(rescheduleArgsForDrop(sess, "2026-06-04", dropMinuteOfDay = 2000))
    }

    @Test fun `reschedule returns null for unparseable target date`() {
        val sess = KinCareSession(_id = "s-4", serviceDurationMinutes = 30)
        assertNull(rescheduleArgsForDrop(sess, targetDateIso = "nope", dropMinuteOfDay = 480))
    }

    @Test fun `reschedule snaps to custom granularity`() {
        val sess = KinCareSession(_id = "s-5", serviceDurationMinutes = 15)
        // 09:23 snapped to 30-min -> 09:00
        val args = rescheduleArgsForDrop(sess, "2026-06-04", dropMinuteOfDay = 563, snapMinutes = 30)
        assertEquals("2026-06-04T09:00:00", args?.startTime)
        assertEquals("2026-06-04T09:15:00", args?.endTime)
    }
}
