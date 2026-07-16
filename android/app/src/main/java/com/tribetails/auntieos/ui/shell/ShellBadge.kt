package com.tribetails.auntieos.ui.shell

import com.tribetails.auntieos.data.admin.NotificationEntry

/**
 * Shell notification-bell badge derivations, Android parity with the web
 * `com.tribetails.auntieos.web.ui.shell.ShellBadge`.
 *
 * Unread is an honest proxy: [NotificationEntry] has no per-recipient read flag, so a
 * still-`pending` dispatch is the closest available signal (same proxy the Notifications
 * screen uses).
 */
fun unreadNotificationCount(entries: List<NotificationEntry>): Int =
    entries.count { it.status.equals("pending", ignoreCase = true) }

/** Whether the shell bell shows its unread "ping" dot. */
fun bellShowsPing(unreadCount: Int): Boolean = unreadCount > 0

/** Compact badge label, capped at "99+"; null when nothing is unread (draw no badge). */
fun bellBadgeLabel(unreadCount: Int): String? = when {
    unreadCount <= 0 -> null
    unreadCount > 99 -> "99+"
    else -> unreadCount.toString()
}
