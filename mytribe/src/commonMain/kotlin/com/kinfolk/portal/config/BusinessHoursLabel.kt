package com.kinfolk.portal.config

/**
 * How one day of the public business card's hours reads (#1411).
 *
 * The card carries each day as "HH:MM-HH:MM" (24-hour, the settings editor's
 * shape) or "" for a closed day. A household reads "9:00 AM to 5:00 PM" or
 * "Closed", the same 12-hour convention `util/RelativeTime.kt` uses for visit
 * times.
 *
 * A value this cannot parse is shown as the operator typed it, never dropped:
 * the operator's settings are the record, and a row that silently went blank
 * would read as a closed day. The web twin is `lib/businessHours.ts`; keep the
 * two in step.
 */
const val HOURS_CLOSED = "Closed"

private val HOURS_RANGE = Regex("""^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$""")

private fun clock(hours: Int, minutes: Int): String? {
    if (hours > 23 || minutes > 59) return null
    val amPm = if (hours >= 12) "PM" else "AM"
    val h12 = when (val h = hours % 12) {
        0 -> 12
        else -> h
    }
    return "$h12:${minutes.toString().padStart(2, '0')} $amPm"
}

fun hoursLabel(range: String): String {
    val trimmed = range.trim()
    if (trimmed.isEmpty()) return HOURS_CLOSED
    val m = HOURS_RANGE.matchEntire(trimmed) ?: return trimmed
    val (openH, openM, closeH, closeM) = m.destructured
    val open = clock(openH.toInt(), openM.toInt()) ?: return trimmed
    val close = clock(closeH.toInt(), closeM.toInt()) ?: return trimmed
    return "$open to $close"
}
