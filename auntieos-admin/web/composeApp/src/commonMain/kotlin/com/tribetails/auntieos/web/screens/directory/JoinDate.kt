package com.tribetails.auntieos.web.screens.directory

import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.todayIn
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * #1584. Operator ruling, 2026-11-05 docket: join dates run "from the year the
 * business started, 2025, up to today". Earlier and future dates are refused.
 * Same rule and words as the admin web (`src/lib/joinDate.ts`), Android
 * (`util/JoinDate.kt`) and `joinDateInRange` in `mytribe/firestore.rules`.
 *
 * The household `joinDate` is stored as `YYYY-MM-DD`; older records can hold
 * other text. The console never edited it before #1584, so a stored value it
 * cannot read is left exactly as it is unless the operator picks or clears.
 */
const val JOIN_DATE_FIRST_DAY = "2025-01-01"
const val JOIN_DATE_RANGE_MESSAGE = "Pick a join date from 2025 through today."

private val ISO_DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

/** The day a `YYYY-MM-DD` string names, or null when it is not one (or not real). */
fun isoDayOrNull(raw: String): LocalDate? =
    if (ISO_DAY.matches(raw)) runCatching { LocalDate.parse(raw) }.getOrNull() else null

/** True for an ISO day from 2025-01-01 through [today] inclusive. */
fun isJoinDateInRange(iso: String, today: LocalDate): Boolean {
    val day = isoDayOrNull(iso) ?: return false
    return day >= LocalDate.parse(JOIN_DATE_FIRST_DAY) && day <= today
}

/**
 * What to say beside the field, or null when it may be saved. Blank may be
 * saved, and so may a value still exactly as stored when it is not a day at
 * all (legacy text the console cannot read), so an untouched old record never
 * blocks an unrelated save. A real day outside the range is always refused.
 */
fun joinDateRangeError(value: String, stored: String, today: LocalDate): String? {
    val v = value.trim()
    if (v.isEmpty()) return null
    if (isoDayOrNull(v) == null) return if (v == stored.trim()) null else JOIN_DATE_RANGE_MESSAGE
    return if (isJoinDateInRange(v, today)) null else JOIN_DATE_RANGE_MESSAGE
}

/** Today in the machine's own time zone. */
@OptIn(ExperimentalTime::class)
fun localToday(): LocalDate = Clock.System.todayIn(TimeZone.currentSystemDefault())

private val MONTH_ABBR = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** #1602: the profile's line for a join date it cannot stand behind. Same words as the admin web. */
const val JOIN_DATE_NEEDS_FIXING = "Join date needs fixing: pick it in Edit"

/**
 * #1602: a sound join date in the admin web's medium style ("Jun 1, 2026"),
 * or null when the stored value is blank, unreadable or outside 2025 through
 * [today]. The console used to print the stored string raw, so profiles read
 * "since 2026-06-01" on one household and "since March 5" on another. Pure.
 */
fun profileJoinDateLabel(raw: String, today: LocalDate): String? {
    val head = raw.trim().take(10)
    val day = isoDayOrNull(head) ?: return null
    if (!isJoinDateInRange(head, today)) return null
    return "${MONTH_ABBR[day.month.ordinal]} ${day.day}, ${day.year}"
}
