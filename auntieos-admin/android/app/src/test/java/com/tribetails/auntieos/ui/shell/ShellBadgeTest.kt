package com.tribetails.auntieos.ui.shell

import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellBadgeTest {
    private fun entry(status: String) = NotificationEntry(id = status, status = status)

    @Test fun unreadCount_countsPendingOnly() {
        val list = listOf(entry("pending"), entry("dispatched"), entry("PENDING"), entry("dispatched"))
        assertEquals(2, unreadNotificationCount(list))
    }

    @Test fun unreadCount_zeroWhenNonePending() {
        assertEquals(0, unreadNotificationCount(listOf(entry("dispatched"), entry("dispatched"))))
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
