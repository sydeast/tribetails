package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * OPERATOR ISSUE #17, the Android half, plus #702 (a SCHEDULED visit past its
 * slot must stay visible, not vanish). Mirrors the web suite in
 * `src/lib/sessionFormat.test.ts` case for case, so the two platforms cannot
 * drift on what "Recent" means, when a year shows, or when a visit is Overdue.
 */
class AuntieTimeWindowTest {

    private val today = "2026-07-16"

    private fun session(
        id: String = "s",
        startTime: String = "2026-07-16T14:00:00Z",
        status: String = "SCHEDULED",
        completedAt: String? = null,
    ) = KinCareSession(id = id, startTime = startTime, status = status, completedAt = completedAt)

    // ── the window ──────────────────────────────────────────────────────────

    @Test
    fun `an in-flight visit is visible whatever its date, so a stale clock-in is never lost`() {
        for (status in listOf("ON_MY_WAY", "ARRIVED", "DEPARTED")) {
            // JUnit's assertTrue takes the message FIRST.
            assertTrue(
                "$status should stay visible",
                isVisibleOnAuntieTime(session(startTime = "2026-06-01T09:00:00Z", status = status), today),
            )
        }
    }

    // #703: Recent is today or yesterday, the mock's own bound. It was a week
    // under #17; the mock is the ruling and it is narrower. Web's twin case is
    // "keeps a wrap from yesterday, and drops one from the day before".
    @Test
    fun `a wrap from yesterday is Recent, and one from the day before is not`() {
        assertTrue(
            isVisibleOnAuntieTime(
                session(status = "COMPLETED", startTime = "2026-07-15T09:00:00Z", completedAt = "2026-07-15T14:00:00Z"),
                today,
            ),
        )
        assertFalse(
            isVisibleOnAuntieTime(
                session(status = "COMPLETED", startTime = "2026-07-14T09:00:00Z", completedAt = "2026-07-14T14:00:00Z"),
                today,
            ),
        )
    }

    @Test
    fun `a wrap from today is Recent, which is the group the board is mostly about`() {
        assertTrue(
            isVisibleOnAuntieTime(
                session(status = "COMPLETED", startTime = "2026-07-16T09:00:00Z", completedAt = "2026-07-16T10:00:00Z"),
                today,
            ),
        )
    }

    @Test
    fun `a wrap from thirty days ago is out of the default window`() {
        assertFalse(
            isVisibleOnAuntieTime(
                session(status = "COMPLETED", startTime = "2026-06-16T09:00:00Z", completedAt = "2026-06-16T14:00:00Z"),
                today,
            ),
        )
    }

    @Test
    fun `a cancellation is dated by its start, since it never gets a completedAt`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "CANCELLED", startTime = "2026-07-15T09:00:00Z"), today))
        assertFalse(isVisibleOnAuntieTime(session(status = "CANCELLED", startTime = "2026-06-01T09:00:00Z"), today))
    }

    @Test
    fun `a scheduled visit yesterday that never got clocked stays visible`() {
        assertTrue(isVisibleOnAuntieTime(session(startTime = "2026-07-15T09:00:00Z"), today))
    }

    // ── issue #702: a SCHEDULED visit whose slot passed must stay visible ────

    @Test
    fun `a scheduled visit ten days overdue is still visible, not dropped`() {
        assertTrue(isVisibleOnAuntieTime(session(startTime = "2026-07-06T09:00:00Z"), today))
    }

    @Test
    fun `overdue visibility reaches back thirty days, and stops just past it`() {
        assertTrue(isVisibleOnAuntieTime(session(startTime = "2026-06-16T09:00:00Z"), today))
        assertFalse(isVisibleOnAuntieTime(session(startTime = "2026-06-15T09:00:00Z"), today))
    }

    @Test
    fun `isOverdueScheduled is true two days late and false exactly one day late`() {
        assertTrue(isOverdueScheduled(session(startTime = "2026-07-14T09:00:00Z"), today))
        assertFalse(isOverdueScheduled(session(startTime = "2026-07-15T09:00:00Z"), today))
    }

    @Test
    fun `isOverdueScheduled is false for active and wrapped statuses, whatever their date`() {
        assertFalse(isOverdueScheduled(session(status = "ARRIVED", startTime = "2026-06-01T09:00:00Z"), today))
        assertFalse(
            isOverdueScheduled(
                session(status = "COMPLETED", startTime = "2026-07-01T09:00:00Z", completedAt = "2026-07-01T14:00:00Z"),
                today,
            ),
        )
    }

    @Test
    fun `upcoming stops at the fourteen-day horizon`() {
        assertTrue(isVisibleOnAuntieTime(session(startTime = "2026-07-30T09:00:00Z"), today))
        assertFalse(isVisibleOnAuntieTime(session(startTime = "2026-07-31T09:00:00Z"), today))
    }

    @Test
    fun `the booking-queue states the Bookings screen owns stay hidden`() {
        for (status in listOf("DRAFT", "PENDING", "REJECTED")) {
            assertFalse(
                "$status should stay hidden",
                isVisibleOnAuntieTime(session(startTime = "2026-07-17T09:00:00Z", status = status), today),
            )
            assertTrue(isBookingQueueStatus(status))
        }
        assertFalse(isBookingQueueStatus("SCHEDULED"))
        assertFalse(isBookingQueueStatus("some_new_code"))
    }

    @Test
    fun `an unrecognized status is placed by its date rather than swallowed`() {
        assertTrue(isVisibleOnAuntieTime(session(startTime = "2026-07-17T09:00:00Z", status = "some_new_code"), today))
    }

    @Test
    fun `a session with no parseable start is not fabricated into the window`() {
        assertFalse(isVisibleOnAuntieTime(session(startTime = ""), today))
    }

    // ── sort ────────────────────────────────────────────────────────────────

    @Test
    fun `soonest first is ascending by start time`() {
        val rows = listOf(
            session(id = "late", startTime = "2026-07-16T15:00:00Z"),
            session(id = "early", startTime = "2026-07-16T09:00:00Z"),
        )
        assertEquals(listOf("early", "late"), sortSessions(rows, AuntieTimeSort.Soonest).map { it.id })
    }

    @Test
    fun `latest first is the exact mirror of soonest first`() {
        val rows = listOf(
            session(id = "a", startTime = "2026-07-16T09:00:00Z"),
            session(id = "b", startTime = "2026-07-16T15:00:00Z"),
            session(id = "c", startTime = "2026-07-17T09:00:00Z"),
        )
        val soonest = sortSessions(rows, AuntieTimeSort.Soonest).map { it.id }
        val latest = sortSessions(rows, AuntieTimeSort.Latest).map { it.id }
        assertEquals(listOf("a", "b", "c"), soonest)
        assertEquals(soonest.reversed(), latest)
    }

    // ── year display ────────────────────────────────────────────────────────

    @Test
    fun `the year shows once the visit is not in the current year`() {
        assertEquals("Jan 16, 2025 · 14:00", auntieTimeDate("2025-01-16T14:00:00Z", today))
        assertEquals("Mar 2, 2027 · 09:30", auntieTimeDate("2027-03-02T09:30:00Z", today))
    }

    @Test
    fun `the year is omitted in the current year, so the common case stays short`() {
        assertEquals("Jul 16 · 14:00", auntieTimeDate("2026-07-16T14:00:00Z", today))
    }

    @Test
    fun `an unparseable timestamp is returned verbatim, never a fabricated date`() {
        assertEquals("nope", auntieTimeDate("nope", today))
    }

    @Test
    fun `the session window carries the year through to the row label`() {
        val s = session(startTime = "2025-01-16T14:00:00Z").apply { endTime = "2025-01-16T15:30:00Z" }
        assertEquals("Jan 16, 2025 · 14:00 to 15:30", sessionWindow(s, today))
    }

    @Test
    fun `Time TBD only when both ends are unusable`() {
        val s = session(startTime = "").apply { endTime = "" }
        assertEquals("Time TBD", sessionWindow(s, today))
    }

    // ── date arithmetic ─────────────────────────────────────────────────────

    @Test
    fun `dateAddDays rolls over a year boundary in both directions`() {
        assertEquals("2026-01-01", dateAddDays("2025-12-31", 1))
        assertEquals("2025-12-31", dateAddDays("2026-01-01", -1))
        assertEquals("2026-07-15", dateAddDays("2026-07-16", -RECENT_WINDOW_DAYS))
        assertEquals("2026-07-30", dateAddDays("2026-07-16", UPCOMING_WINDOW_DAYS))
    }
}
