package com.tribetails.auntieos.ui.shell

import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shell bell's unread count.
 *
 * THESE TESTS USED TO PIN THE WRONG THING. The count was `status == "pending"`,
 * and this file asserted exactly that (`unreadCount_countsPendingOnly`, with
 * every fixture built as `entry("pending")`). It was defensible when written:
 * `NotificationEntry` had no read flag and the source comment called it "an
 * honest proxy". But it stopped being true when `readAt` landed. From then on
 * the bell counted the DELIVERY PIPELINE while the screen it opens counted the
 * OPERATOR: a notification read and acted on but whose SMS never went out still
 * lit the bell, and one delivered and never opened did not.
 *
 * Operator ruling R5 removed `status` from the notification document, which
 * forced the correction. The bell and the Notifications screen now share one
 * definition (`isNotificationUnread`).
 */
class ShellBadgeTest {
    private fun unread(id: String) = NotificationEntry(id = id)
    private fun read(id: String) = NotificationEntry(id = id, readAt = "2026-08-03T10:00:00Z")

    @Test fun unreadCount_countsRowsWithNoReadMarker() {
        val list = listOf(unread("a"), read("b"), unread("c"), read("d"))
        assertEquals(2, unreadNotificationCount(list))
    }

    /**
     * `markNotificationUnread` clears `readAt`, and "cleared" reaches a client as
     * a blank string as well as an absent field. Both must read as unread, or a
     * row the operator deliberately un-read silently stops lighting the bell.
     */
    @Test fun unreadCount_treatsABlankReadMarkerAsUnread() {
        assertEquals(1, unreadNotificationCount(listOf(NotificationEntry(id = "a", readAt = ""))))
    }

    @Test fun unreadCount_zeroWhenEverythingIsRead() {
        assertEquals(0, unreadNotificationCount(listOf(read("a"), read("b"))))
    }

    @Test fun unreadCount_zeroOnAnEmptyFeed() {
        assertEquals(0, unreadNotificationCount(emptyList()))
    }

    @Test fun ping_offAtZero_onAboveZero() {
        assertFalse(bellShowsPing(0))
        assertTrue(bellShowsPing(1))
    }

    @Test fun badgeLabel_nullAtZero() {
        assertNull(bellBadgeLabel(0))
    }

    @Test fun badgeLabel_plainCountThenCapsAt99Plus() {
        assertEquals("5", bellBadgeLabel(5))
        assertEquals("99+", bellBadgeLabel(150))
    }
}
