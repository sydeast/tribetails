package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for booking note-edit cutoff. Mirrors web BookingDetailModal
 * NOTE_CUTOFF_MS = 3hr. Locks the kinfolk-facing notes field 3 hours before
 * visit startTime so admins/auntie can rely on the note state at arrival.
 */
class BookingNoteCutoffTest {

    private val threeHrMs: Long = 3L * 60L * 60L * 1000L

    @Test
    fun `isNoteEditLocked false when start far in future`() {
        val nowMs   = 1_000_000_000L
        val startMs = nowMs + threeHrMs + 60_000L   // 3hr + 1min from now
        assertFalse(isNoteEditLocked(nowMs, startMs))
    }

    @Test
    fun `isNoteEditLocked true at exactly 3hr cutoff`() {
        val nowMs   = 1_000_000_000L
        val startMs = nowMs + threeHrMs
        assertTrue(isNoteEditLocked(nowMs, startMs))
    }

    @Test
    fun `isNoteEditLocked true inside 3hr window`() {
        val nowMs   = 1_000_000_000L
        val startMs = nowMs + threeHrMs - 60_000L   // 2hr 59min from now
        assertTrue(isNoteEditLocked(nowMs, startMs))
    }

    @Test
    fun `isNoteEditLocked true after visit started`() {
        val nowMs   = 1_000_000_000L
        val startMs = nowMs - 60_000L   // started 1min ago
        assertTrue(isNoteEditLocked(nowMs, startMs))
    }

    @Test
    fun `isNoteEditLocked false when startMs is null (DRAFT bookings have no start yet)`() {
        assertFalse(isNoteEditLocked(nowMs = 1_000_000_000L, startMs = null))
    }

    @Test
    fun `noteCutoffWarning returns null when not locked`() {
        assertEquals(null, noteCutoffWarning(locked = false))
    }

    @Test
    fun `noteCutoffWarning returns user-facing message when locked`() {
        val msg = noteCutoffWarning(locked = true)
        assertTrue("must contain '3 hours' or equivalent", msg!!.contains("3"))
    }

    /**
     * The copy must say WHY, not just that something is off, and it must read
     * the same on both surfaces. Two hand-written strings ("Notes locked -
     * visit is within 3 hours" here, "Notes locked - visit starts in <3hr." in
     * KinCareDetailScreen) is how the same rule came to be explained two
     * different ways, one of them in error red rather than warning.
     */
    @Test
    fun `noteCutoffWarning names the lock and the window in full words`() {
        val msg = noteCutoffWarning(locked = true)!!
        assertTrue("must say it is locked", msg.contains("locked", ignoreCase = true))
        assertTrue("must spell out the window", msg.contains("3 hours"))
        assertFalse("no em dashes in operator copy", msg.contains("—"))
    }
}
