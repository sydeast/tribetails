package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1829: Open on an unread notice went to the right place and left it unread,
 * so the Unread tile, which counts notices not opened yet, never moved.
 */
class NotificationOpenMarksReadTest {

    private fun run(entry: NotificationEntry): List<String> {
        val calls = mutableListOf<String>()
        openNotification(entry, markRead = { calls += "read:$it" }) { calls += "open:${it.id}" }
        return calls
    }

    @Test fun `an unread notice is marked read, then opened`() {
        assertEquals(listOf("read:n1", "open:n1"), run(NotificationEntry(id = "n1")))
    }

    @Test fun `a read notice opens with no write`() {
        assertEquals(listOf("open:n1"), run(NotificationEntry(id = "n1", readAt = "2026-11-10T22:44:00Z")))
    }

    @Test fun `a notice with no id opens with no write`() {
        assertEquals(listOf("open: "), run(NotificationEntry(id = " ")))
    }
}
