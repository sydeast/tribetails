package com.kinfolk.portal.util

import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.math.abs

/**
 * Cross-platform relative time formatter.
 * Past:    "Just now", "5m ago", "3h ago", "2d ago", "Mar 14".
 * Future:  "Just now", "in 5m", "in 3h", "in 2d", "Mar 14".
 */
fun relativeTime(epochMillis: Long?, nowMillis: Long = Clock.System.now().toEpochMilliseconds()): String {
    if (epochMillis == null) return ""
    val deltaMs = nowMillis - epochMillis
    if (abs(deltaMs) < 60_000L) return "Just now"
    val isPast = deltaMs >= 0
    val absMs = abs(deltaMs)
    val minutes = absMs / 60_000L
    if (minutes < 60) return if (isPast) "${minutes}m ago" else "in ${minutes}m"
    val hours = minutes / 60L
    if (hours < 24) return if (isPast) "${hours}h ago" else "in ${hours}h"
    val days = hours / 24L
    if (days < 7) return if (isPast) "${days}d ago" else "in ${days}d"
    val ldt: LocalDateTime = Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(TimeZone.currentSystemDefault())
    val month = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")[ldt.month.ordinal]
    return "$month ${ldt.day}"
}
