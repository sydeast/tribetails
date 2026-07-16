package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Notifications filter: All / Unread (real readAt-based read state, Step 4) /
 * category (spec 21 item 2).
 */
class NotificationsFilterTest {

    private val all = listOf(
        // n1 unread (no readAt), n2 read (readAt set), n3 unread (blank readAt).
        NotificationEntry(id = "n1", category = "booking", status = "dispatched", readAt = null),
        NotificationEntry(id = "n2", category = "payment", status = "dispatched", readAt = "2026-06-05T10:00:00Z"),
        NotificationEntry(id = "n3", category = "booking", status = "dispatched", readAt = ""),
    )

    @Test
    fun nullFilterReturnsAll() =
        assertEquals(listOf("n1", "n2", "n3"), notificationsForFilter(all, null).map { it.id })

    @Test
    fun unreadFilterUsesReadAtMarker() =
        assertEquals(listOf("n1", "n3"), notificationsForFilter(all, NOTIF_UNREAD_FILTER).map { it.id })

    @Test
    fun categoryFilterMatchesCategory() =
        assertEquals(listOf("n1", "n3"), notificationsForFilter(all, "booking").map { it.id })
}
