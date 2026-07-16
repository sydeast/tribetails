package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure logic for the notification quick actions (Stage 2 Step 4): the archived
 * filter, the read/unread state off readAt, and which actions apply per target.
 */
class NotificationActionsTest {

    @Test
    fun activeFiltersOutArchived() {
        val all = listOf(
            NotificationEntry(_id = "a", archivedAt = ""),
            NotificationEntry(_id = "b", archivedAt = "2026-06-05T10:00:00Z"),
            NotificationEntry(_id = "c", archivedAt = ""),
        )
        assertEquals(listOf("a", "c"), activeNotifications(all).map { it._id })
    }

    @Test
    fun readStateDrivenByReadAt() {
        assertFalse(notificationIsRead(NotificationEntry(readAt = "")))
        assertTrue(notificationIsRead(NotificationEntry(readAt = "2026-06-05T10:00:00Z")))
    }

    @Test
    fun unreadOffersMarkReadNotMarkUnread() {
        val actions = applicableActions(NotificationEntry(readAt = ""))
        assertTrue(NotificationAction.MarkRead in actions)
        assertFalse(NotificationAction.MarkUnread in actions)
    }

    @Test
    fun readOffersMarkUnreadNotMarkRead() {
        val actions = applicableActions(NotificationEntry(readAt = "2026-06-05T10:00:00Z"))
        assertTrue(NotificationAction.MarkUnread in actions)
        assertFalse(NotificationAction.MarkRead in actions)
    }

    @Test
    fun archiveAlwaysAvailable() {
        assertTrue(NotificationAction.Archive in applicableActions(NotificationEntry()))
    }

    @Test
    fun bookingTargetOffersApproveDenyAndOpen() {
        val actions = applicableActions(
            NotificationEntry(targetType = "booking", targetId = "bk1"),
        )
        assertTrue(NotificationAction.ApproveBooking in actions)
        assertTrue(NotificationAction.DenyBooking in actions)
        assertTrue(NotificationAction.OpenTarget in actions)
    }

    @Test
    fun invoiceTargetOffersOpenButNotApproveDeny() {
        val actions = applicableActions(
            NotificationEntry(targetType = "invoice", targetId = "inv1"),
        )
        assertTrue(NotificationAction.OpenTarget in actions)
        assertFalse(NotificationAction.ApproveBooking in actions)
        assertFalse(NotificationAction.DenyBooking in actions)
    }

    @Test
    fun kinfolkTargetOffersCreateQuote() {
        val kf = applicableActions(NotificationEntry(targetType = "kinfolk", targetId = "kf1"))
        assertTrue(NotificationAction.CreateQuote in kf)
        // non-kinfolk target + blank id never offer CreateQuote (no kinfolk to seed)
        assertFalse(NotificationAction.CreateQuote in applicableActions(NotificationEntry(targetType = "invoice", targetId = "inv1")))
        assertFalse(NotificationAction.CreateQuote in applicableActions(NotificationEntry(targetType = "kinfolk", targetId = "")))
    }

    @Test
    fun blankTargetIdOffersNoOpen() {
        val actions = applicableActions(
            NotificationEntry(targetType = "invoice", targetId = ""),
        )
        assertFalse(NotificationAction.OpenTarget in actions)
    }

    @Test
    fun unknownTargetTypeOffersNoOpen() {
        val actions = applicableActions(
            NotificationEntry(targetType = "spaceship", targetId = "x1"),
        )
        assertFalse(NotificationAction.OpenTarget in actions)
        assertFalse(NotificationAction.ApproveBooking in actions)
    }

    @Test
    fun bookingTargetTypeIsCaseInsensitive() {
        val actions = applicableActions(
            NotificationEntry(targetType = "Booking", targetId = "bk1"),
        )
        assertTrue(NotificationAction.ApproveBooking in actions)
    }
}
