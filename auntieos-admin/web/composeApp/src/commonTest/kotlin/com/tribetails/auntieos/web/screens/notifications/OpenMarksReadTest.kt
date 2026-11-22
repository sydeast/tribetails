package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1829: Open on an unread notice went to the right place and left it unread,
 * so the Unread tile, which counts notices not opened yet, never moved.
 */
class OpenMarksReadTest {

    private fun run(entry: NotificationEntry): List<String> {
        val calls = mutableListOf<String>()
        openNotification(entry, markRead = { calls += "read:$it" }, open = { calls += "open:${it._id}" })
        return calls
    }

    @Test
    fun unreadNoticeIsMarkedReadAndOpened() {
        assertEquals(listOf("read:n1", "open:n1"), run(NotificationEntry(_id = "n1")))
    }

    @Test
    fun readNoticeOpensWithoutAWrite() {
        assertEquals(listOf("open:n1"), run(NotificationEntry(_id = "n1", readAt = "2026-11-10T22:44:00Z")))
    }

    @Test
    fun noticeWithNoIdOpensWithoutAWrite() {
        assertEquals(listOf("open: "), run(NotificationEntry(_id = " ")))
    }
}
