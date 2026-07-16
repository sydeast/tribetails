package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessHours

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper layer for BusinessHoursSection. Keeps decision logic JVM-testable
// (no Compose runtime dependency). UI binds to these helpers.
// ─────────────────────────────────────────────────────────────────────────────

private val TIME_REGEX = Regex("""^([01]\d|2[0-3]):([0-5]\d)$""")

internal fun parseTimeOrNull(s: String): Pair<Int, Int>? {
    val m = TIME_REGEX.matchEntire(s) ?: return null
    return m.groupValues[1].toInt() to m.groupValues[2].toInt()
}

internal fun isValidTimeRange(openTime: String, closeTime: String): Boolean {
    val o = parseTimeOrNull(openTime) ?: return false
    val c = parseTimeOrNull(closeTime) ?: return false
    val openMin  = o.first * 60 + o.second
    val closeMin = c.first * 60 + c.second
    return openMin < closeMin
}

internal fun formatHoursDisplay(h: BusinessHours): String =
    if (h.isOpen) "${h.openTime}-${h.closeTime}" else "Closed"

/**
 * Pads the given list to exactly 7 days (Monday=1..Sunday=7). Missing days are
 * filled with the same defaults ServiceRepository uses on first read (Mon-Fri
 * open 09:00-17:00, Sat-Sun closed).
 */
internal fun ensureSevenDays(hours: List<BusinessHours>): List<BusinessHours> {
    val byDay = hours.associateBy { it.dayOfWeek }
    return (1..7).map { dow ->
        byDay[dow] ?: BusinessHours(
            dayOfWeek = dow,
            isOpen    = dow <= 5,
            openTime  = "09:00",
            closeTime = "17:00",
        )
    }
}
