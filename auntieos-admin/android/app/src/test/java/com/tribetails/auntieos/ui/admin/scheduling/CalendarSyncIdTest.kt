package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The calendar-id rule and the last-run receipt, the two halves of
 * CalendarSyncId.kt.
 *
 * The `calendarIdProblem` cases here are the SAME five the other two copies of
 * this rule assert: `mytribe/functions/test/callableContract.test.ts` (the
 * enforcing copy) and `auntieos-admin/src/lib/calendarSyncId.test.ts`. If one
 * moves, all three move in the same change. See CALLABLE_CONTRACT.md.
 */
class CalendarSyncIdTest {

    @Test
    fun `accepts the two shapes Google actually issues`() {
        assertNull(calendarIdProblem("abc123@group.calendar.google.com"))
        assertNull(calendarIdProblem("auntie@tribetails.com"))
    }

    @Test
    fun `trims before judging, so a pasted id with stray spaces is not rejected`() {
        assertNull(calendarIdProblem("  abc@group.calendar.google.com  "))
    }

    @Test
    fun `refuses primary, the one wrong value that is a legal calendar id`() {
        // It names the sync service account's OWN calendar, which is permanently
        // empty, so it would sync successfully forever and import nothing.
        assertTrue(calendarIdProblem("primary")!!.contains("always empty"))
        assertNotNull(calendarIdProblem("PRIMARY"))
    }

    @Test
    fun `refuses anything not address-shaped and shows what a real one looks like`() {
        for (bad in listOf("team calendar", "team-cal@group", "group.calendar.google.com", "a@b")) {
            val msg = calendarIdProblem(bad)
            assertNotNull("$bad must be refused", msg)
            assertTrue(msg!!.contains(CALENDAR_ID_EXAMPLE))
        }
    }

    @Test
    fun `says why a typo matters, that it would read as an empty calendar`() {
        assertTrue(calendarIdProblem("team-cal")!!.contains("import nothing"))
    }

    @Test
    fun `refuses blank as not entered yet, not as a typo`() {
        assertTrue(calendarIdProblem("")!!.contains("Enter the shared"))
        assertTrue(calendarIdProblem("   ")!!.contains("Enter the shared"))
    }

    @Test
    fun `does not try to be a spell checker`() {
        // Whether the service account can actually SEE the calendar is Google's
        // answer to give, and the sync reports it as notFound. A field guessing
        // at domains would refuse legitimate ids.
        assertNull(calendarIdProblem("teem@group.calendar.googl"))
    }

    @Test
    fun `names the service account the callable itself names`() {
        assertEquals(
            "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com",
            CALENDAR_SYNC_SA_EMAIL
        )
    }

    // ── receipt ──────────────────────────────────────────────────────────────

    @Test
    fun `no stamp means no run, which is not the same as a zero-import run`() {
        assertNull(calendarSyncRunFrom(null, null, null, null))
        assertNull(calendarSyncRunFrom("  ", "ok", 3, ""))
        assertNull(calendarSyncRunLabel(null))
    }

    @Test
    fun `reads a successful run off the stamped fields`() {
        val run = calendarSyncRunFrom("2026-07-25T14:30:00.000Z", "ok", 4, "")
        assertEquals(CalendarSyncRun("2026-07-25T14:30:00.000Z", true, 4, ""), run)
        assertTrue(calendarSyncRunLabel(run)!!.contains("Imported 4 busy blocks."))
    }

    @Test
    fun `reads a failed run with its cause and never quotes a count for it`() {
        val run = calendarSyncRunFrom("2026-07-25T14:30:00.000Z", "error", 0, "calendar_not_shared: x")
        assertEquals("calendar_not_shared: x", run!!.error)
        val label = calendarSyncRunLabel(run)!!
        assertTrue(label.contains("it failed"))
        assertTrue(!label.contains("Imported"))
    }

    @Test
    fun `an unrecognized status reads as a failure, never as a quiet success`() {
        val run = calendarSyncRunFrom("2026-07-25T14:30:00.000Z", "weird", 9, "")
        assertTrue(!run!!.succeeded)
        assertEquals(0, run.imported)
    }

    @Test
    fun `an empty window says nothing was blocked out rather than Imported 0`() {
        val run = calendarSyncRunFrom("2026-07-25T14:30:00.000Z", "ok", 0, "")
        assertTrue(calendarSyncRunLabel(run)!!.contains("nothing was blocked out"))
    }

    @Test
    fun `singularizes one block`() {
        val run = calendarSyncRunFrom("2026-07-25T14:30:00.000Z", "ok", 1, "")
        assertTrue(calendarSyncRunLabel(run)!!.contains("Imported 1 busy block."))
    }

    @Test
    fun `still reports the outcome when the timestamp is unreadable`() {
        val run = calendarSyncRunFrom("not-a-date", "error", 0, "x")
        val label = calendarSyncRunLabel(run)!!
        assertTrue(label.contains("unreadable time"))
        assertTrue(label.contains("it failed"))
    }
}
