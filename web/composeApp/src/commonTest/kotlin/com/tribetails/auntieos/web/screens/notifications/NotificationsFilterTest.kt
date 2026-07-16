package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Notifications filter: All / Unread (real readAt-driven) / category (spec 21
 * item 2). Stage 2 Step 4: unread is now driven by the real `readAt` field, not
 * the pending-dispatch proxy.
 */
class NotificationsFilterTest {

    private val all = listOf(
        // n1 unread (blank readAt), n2 read, n3 unread.
        NotificationEntry(_id = "n1", category = "booking", readAt = ""),
        NotificationEntry(_id = "n2", category = "payment", readAt = "2026-06-05T10:00:00Z"),
        NotificationEntry(_id = "n3", category = "booking", readAt = ""),
    )

    @Test
    fun nullFilterReturnsAll() =
        assertEquals(listOf("n1", "n2", "n3"), notificationsForFilter(all, null).map { it._id })

    @Test
    fun unreadFilterUsesReadAt() =
        assertEquals(listOf("n1", "n3"), notificationsForFilter(all, NOTIF_UNREAD_FILTER).map { it._id })

    @Test
    fun categoryFilterMatchesCategory() =
        assertEquals(listOf("n1", "n3"), notificationsForFilter(all, "booking").map { it._id })
}
