package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BookingTimeSlot

// Week-grid geometry for busy-block placement. Mirrors the web Schedule grid
// (8a to 6p, exclusive bottom edge). Kept here as a pure, testable contract so the
// Android per-day Busy bands place identically to web `busyPlacement`.
internal const val GRID_START_HOUR = 8
internal const val GRID_END_HOUR = 18 // 6p, exclusive bottom edge

/**
 * Pure helper: filter a raw booking_time_slots list down to the BLOCKED slots
 * (`isAvailable == false`, the canonical Google-busy signal) and group them by
 * their `date` (local YYYY-MM-DD on the doc). Slots with a blank date are dropped
 * (they can't be placed on a day). Within each day the blocks are sorted by start
 * time for a stable draw order. Mirrors the web `blockedSlotsByDate` byte-for-byte.
 */
internal fun blockedSlotsByDate(slots: List<BookingTimeSlot>): Map<String, List<BookingTimeSlot>> =
    slots
        .filter { !it.isAvailable && it.date.isNotBlank() }
        .groupBy { it.date }
        .mapValues { (_, daySlots) -> daySlots.sortedBy { it.startTime } }

/** Vertical placement (in minutes from the grid window top) for a busy block. */
internal data class BusyPlacement(val topMinutes: Int, val heightMinutes: Int)

/**
 * Pure helper: resolve where a busy block sits in the 8a to 6p grid window from its
 * "HH:mm" start/end. Returns null when the start is unparseable or falls outside the
 * window (no fabricated edge position). A missing/zero-length end is given a small
 * visible minimum, clamped so the block never overruns the window bottom. Mirrors the
 * web `busyPlacement` off-window/min-height handling.
 */
internal fun busyPlacement(startHHmm: String, endHHmm: String): BusyPlacement? {
    val windowStart = GRID_START_HOUR * 60
    val windowEnd = GRID_END_HOUR * 60
    val startMin = hhmmToMinutes(startHHmm) ?: return null
    if (startMin < windowStart || startMin >= windowEnd) return null

    val roomToBottom = windowEnd - startMin
    val minVisible = minOf(20, roomToBottom)
    val endMin = hhmmToMinutes(endHHmm)
    val rawDuration = if (endMin != null && endMin > startMin) endMin - startMin else minVisible
    val duration = rawDuration.coerceIn(minVisible, roomToBottom)
    return BusyPlacement(topMinutes = startMin - windowStart, heightMinutes = duration)
}

/** "HH:mm" to minutes-from-midnight, or null if unparseable. Mirrors web `hhmmToMinutes`. */
internal fun hhmmToMinutes(hhmm: String): Int? = runCatching {
    if (hhmm.length < 4 || hhmm[2] != ':') return@runCatching null
    val hour = hhmm.substring(0, 2).toInt()
    val minute = hhmm.substring(3, 5).toInt()
    if (hour !in 0..23 || minute !in 0..59) return@runCatching null
    hour * 60 + minute
}.getOrNull()
