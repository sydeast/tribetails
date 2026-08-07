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

/**
 * "2:02 PM" in the CALLER's own local time zone, from a stored ISO-8601
 * instant string. Null on a missing or unparseable instant — never a
 * fabricated time (task-25, P4's fail-loud rule).
 *
 * Mirrors the web client's `weekdayTime`/`isoTime`
 * (mytribe/web/src/lib/portalFormat.ts) so the same visit-time concept reads
 * the same on both clients. This is the FIRST clock-time formatter on this
 * platform — `ScheduleScreen.kt`'s own visit-replay line renders the raw ISO
 * string with no formatting at all; that is a pre-existing rough edge in a
 * secondary panel, not a convention to extend into a new feature that the
 * brief requires to show local time.
 */
fun clockTime(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    val instant = try {
        Instant.parse(iso)
    } catch (_: Exception) {
        return null
    }
    val local = instant.toLocalDateTime(TimeZone.currentSystemDefault())
    val hour12 = when (val h = local.hour % 12) {
        0 -> 12
        else -> h
    }
    val minute = local.minute.toString().padStart(2, '0')
    val amPm = if (local.hour >= 12) "PM" else "AM"
    return "$hour12:$minute $amPm"
}
