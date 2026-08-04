package com.tribetails.auntieos.ui.shell

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.ui.admin.isNotificationUnread

/**
 * Shell notification-bell badge derivations, Android parity with the web
 * `com.tribetails.auntieos.web.ui.shell.ShellBadge`.
 *
 * UNREAD IS NOW THE REAL SIGNAL, not a proxy. This counted dispatches still
 * stamped `status == "pending"`, and its own comment justified that as "an
 * honest proxy: NotificationEntry has no per-recipient read flag". That stopped
 * being true when `readAt` landed. The Notifications screen has read
 * `isNotificationUnread` for some time, so the bell and the screen it opens have
 * been counting two different things, and the bell was counting the delivery
 * pipeline rather than the operator. A notification the operator has read but
 * whose SMS never went out still lit the bell; one that was delivered and never
 * opened did not.
 *
 * Operator ruling R5 removed `status` from the notification document outright,
 * which forced the issue: this now shares the one definition with the screen.
 */
fun unreadNotificationCount(entries: List<NotificationEntry>): Int =
    entries.count { isNotificationUnread(it) }

/** Whether the shell bell shows its unread "ping" dot. */
fun bellShowsPing(unreadCount: Int): Boolean = unreadCount > 0

/** Compact badge label, capped at "99+"; null when nothing is unread (draw no badge). */
fun bellBadgeLabel(unreadCount: Int): String? = when {
    unreadCount <= 0 -> null
    unreadCount > 99 -> "99+"
    else -> unreadCount.toString()
}
