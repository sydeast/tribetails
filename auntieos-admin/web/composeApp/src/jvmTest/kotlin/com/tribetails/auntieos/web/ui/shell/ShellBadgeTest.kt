package com.tribetails.auntieos.web.ui.shell

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ShellBadgeTest {
    private fun entry(status: String) = NotificationEntry(_id = status, status = status)

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
