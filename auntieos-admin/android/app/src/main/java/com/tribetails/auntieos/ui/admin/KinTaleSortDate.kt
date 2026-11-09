package com.tribetails.auntieos.ui.admin
/**
 * The date the KinTales list sorts on (#1599).
 *
 * `kin_care_reports` dates come in two shapes. Rows written since the May 2026
 * migration learned to parse hold an ISO instant. The 83 rows that run wrote
 * before that hold the legacy free text "September 3, 2025 2:02pm". Compared as
 * strings the free text sorts above every ISO value (a letter is above a digit)
 * and, among itself, alphabetically by month name, so the list was out of date
 * order. This parses both into epoch milliseconds so the sort means a date.
 *
 * Migrated rows keep their ORIGINAL dates: nothing here reads the migration
 * time. The legacy text records no zone, so it is read as UTC, the convention
 * `migrate_visit_logs_to_kin_care_reports.py` writes; every legacy row shifts by
 * the same offset, so their order among themselves is exact.
 *
 * Pure Kotlin on purpose (no java.time): the same file lives on desktop, where
 * the code is common to the JVM and JS targets.
 */
internal data class KinTaleStamp(
    val year: Int,
    val month: Int,
    val day: Int,
    val hour: Int,
    val minute: Int,
)
private val MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
private val LEGACY_STAMP = Regex(
    "^(" + MONTH_NAMES.joinToString("|") + """) (\d{1,2}), (\d{4}) (\d{1,2})(?::(\d{2}))?(am|pm)$""",
)
private val ISO_STAMP = Regex(
    """^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$""",
)
/** "September 3, 2025 2:02pm" as its wall-clock parts, or null for anything else (including an impossible date). */
internal fun parseLegacyKinTaleStamp(raw: String?): KinTaleStamp? {
    val m = LEGACY_STAMP.matchEntire(raw?.trim().orEmpty()) ?: return null
    val month = MONTH_NAMES.indexOf(m.groupValues[1]) + 1
    val day = m.groupValues[2].toInt()
    val year = m.groupValues[3].toInt()
    val rawHour = m.groupValues[4].toInt()
    val minute = m.groupValues[5].ifEmpty { "0" }.toInt()
    if (rawHour !in 1..12 || minute > 59 || day !in 1..daysInMonth(year, month)) return null
    val hour = (rawHour % 12) + if (m.groupValues[6] == "pm") 12 else 0
    return KinTaleStamp(year, month, day, hour, minute)
}
/**
 * Epoch milliseconds for an ISO instant or date, or for the legacy free text;
 * null when the text is neither (blank, "last Tuesday-ish", February 30).
 */
internal fun kinTaleSortMillis(raw: String?): Long? {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty()) return null
    parseLegacyKinTaleStamp(text)?.let { return epochMillis(it.year, it.month, it.day, it.hour, it.minute, 0, 0) }
    val m = ISO_STAMP.matchEntire(text) ?: return null
    val year = m.groupValues[1].toInt()
    val month = m.groupValues[2].toInt()
    val day = m.groupValues[3].toInt()
    val hour = m.groupValues[4].ifEmpty { "0" }.toInt()
    val minute = m.groupValues[5].ifEmpty { "0" }.toInt()
    val second = m.groupValues[6].ifEmpty { "0" }.toInt()
    if (month !in 1..12 || day !in 1..daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return null
    val zone = m.groupValues[7]
    val offsetMinutes = when {
        zone.isEmpty() || zone == "Z" -> 0
        else -> {
            val digits = zone.drop(1).replace(":", "")
            val total = digits.substring(0, 2).toInt() * 60 + digits.substring(2, 4).toInt()
            if (zone[0] == '-') -total else total
        }
    }
    return epochMillis(year, month, day, hour, minute, second, offsetMinutes)
}
private fun daysInMonth(year: Int, month: Int): Int = when (month) {
    1, 3, 5, 7, 8, 10, 12 -> 31
    4, 6, 9, 11 -> 30
    2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
    else -> 0
}
/** Days from 1970-01-01 to a proleptic Gregorian civil date (Howard Hinnant's algorithm). */
private fun epochDay(year: Int, month: Int, day: Int): Long {
    val y = (if (month <= 2) year - 1 else year).toLong()
    val era = (if (y >= 0) y else y - 399) / 400
    val yoe = y - era * 400
    val mp = (month + 9) % 12
    val doy = (153 * mp + 2) / 5 + day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}
private fun epochMillis(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int, offsetMinutes: Int): Long =
    ((epochDay(year, month, day) * 24 + hour) * 60 + minute - offsetMinutes) * 60_000L + second * 1_000L
/**
 * The comparator behind "Newest" and "Oldest": by parsed date, a row with no
 * readable date LAST in either direction (it is unknown, not oldest or newest),
 * ties in the order they arrived.
 */
internal fun <T> kinTaleDateComparator(newestFirst: Boolean, millis: (T) -> Long?): Comparator<T> =
    Comparator { a, b ->
        val x = millis(a)
        val y = millis(b)
        when {
            x == null && y == null -> 0
            x == null -> 1
            y == null -> -1
            newestFirst -> y.compareTo(x)
            else -> x.compareTo(y)
        }
    }
