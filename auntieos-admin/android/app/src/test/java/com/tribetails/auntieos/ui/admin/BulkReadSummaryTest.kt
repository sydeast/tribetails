package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stage 2 tail: the bulk mark-read summary + unread determination that drive the
 * Notifications multi-select. The summary must never imply every selection succeeded
 * when the server marked fewer (stale ids), and unread is keyed off the readAt marker.
 */
class BulkReadSummaryTest {

    @Test fun `all marked reads as a clean count`() {
        assertEquals("Marked 3 read.", bulkReadSummary(requested = 3, marked = 3))
    }

    @Test fun `partial marks name both numbers`() {
        assertEquals("Marked 2 of 3 read.", bulkReadSummary(requested = 3, marked = 2))
    }

    @Test fun `zero marked of many explains why`() {
        assertEquals(
            "Marked 0 of 2 read (already read or no longer available).",
            bulkReadSummary(requested = 2, marked = 0),
        )
    }

    @Test fun `nothing selected is honest`() {
        assertEquals("Nothing selected.", bulkReadSummary(requested = 0, marked = 0))
    }

    @Test fun `unread is keyed off readAt marker, not dispatch status`() {
        assertTrue(isNotificationUnread(NotificationEntry(id = "n1", status = "dispatched", readAt = null)))
        assertTrue(isNotificationUnread(NotificationEntry(id = "n2", status = "pending", readAt = "")))
        assertFalse(isNotificationUnread(NotificationEntry(id = "n3", status = "dispatched", readAt = "2026-06-05T10:00:00Z")))
    }

    // ── bulk archive summary (Step 4) ────────────────────────────────────────────

    @Test fun `all archived reads as a clean count`() {
        assertEquals("Dismissed 3.", bulkArchiveSummary(requested = 3, archived = 3))
    }

    @Test fun `partial archives name both numbers`() {
        assertEquals("Dismissed 2 of 3.", bulkArchiveSummary(requested = 3, archived = 2))
    }

    @Test fun `zero archived of many explains why`() {
        assertEquals(
            "Dismissed 0 of 2 (already archived or no longer available).",
            bulkArchiveSummary(requested = 2, archived = 0),
        )
    }

    @Test fun `nothing selected to archive is honest`() {
        assertEquals("Nothing selected.", bulkArchiveSummary(requested = 0, archived = 0))
    }
}
