package com.tribetails.auntieos.web.data

/**
 * §A.8 time-block resolver. Maps a session [startTime] onto the first active
 * [TimeBlockDefinition] whose window contains it (start inclusive, end exclusive).
 *
 * Pure + platform-agnostic so Auntie Time / Bookings cards / create chips can label
 * a visit "Evening block" off the Business-Settings blocks, never a hardcoded string.
 * Returns null when the time is blank/unparseable or falls in a gap between windows.
 */
fun resolveTimeBlock(startTime: String, blocks: List<TimeBlockDefinition>): TimeBlockDefinition? {
    val minutes = parseMinutesOfDay(startTime) ?: return null
    return blocks.firstOrNull { block ->
        if (!block.isActive) return@firstOrNull false
        val start = parseMinutesOfDay(block.startTime) ?: return@firstOrNull false
        val end = parseMinutesOfDay(block.endTime) ?: return@firstOrNull false
        minutes in start until end
    }
}

/**
 * Extracts minutes-since-midnight from a time-bearing string. Accepts a bare
 * "HH:mm"/"HH:mm:ss" or an ISO datetime ("...THH:mm..."), we take the first
 * HH:mm after an optional date+'T'. Returns null if no valid HH:mm is found.
 */
internal fun parseMinutesOfDay(raw: String): Int? {
    if (raw.isBlank()) return null
    val timePart = if (raw.contains('T')) raw.substringAfter('T') else raw
    val match = Regex("""(\d{1,2}):(\d{2})""").find(timePart) ?: return null
    val hh = match.groupValues[1].toIntOrNull() ?: return null
    val mm = match.groupValues[2].toIntOrNull() ?: return null
    if (hh !in 0..23 || mm !in 0..59) return null
    return hh * 60 + mm
}
