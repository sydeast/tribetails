package com.tribetails.auntieos.web.screens.settings

import java.time.LocalDate
import java.time.YearMonth

/**
 * DESKTOP CONSOLE PORT of the read half of `ClosureRecurrence.kt` (Android,
 * `auntieos-admin/android/.../ui/admin/`), itself a port of
 * `mytribe/functions/src/lib/closureRecurrence.ts`. Same wire grammar, same
 * date math, same leap-day policy. Only what this console's Time Off panel
 * reads is here: decode a `companyHolidays` entry, describe it, find its next
 * date, and the preset catalog the holiday switches take their names from.
 * Any change to the recurrence rules or a preset name has to land in every
 * copy.
 *
 * Wire grammar (`business_settings.companyHolidays: List<String>`):
 *
 *   ONCE:                 `YYYY-MM-DD|Name`
 *   YEARLY_FIXED:         `yearly:MM-DD|Name`            e.g. `yearly:07-04|Independence Day`
 *   YEARLY_NTH_WEEKDAY:   `yearly-nth:MM-W-N|Name`       e.g. `yearly-nth:11-4-4|Thanksgiving`
 *   YEARLY_LAST_WEEKDAY:  `yearly-last:MM-W|Name`        e.g. `yearly-last:05-1|Memorial Day`
 *
 * `W` is an ISO weekday, 1 (Monday) through 7 (Sunday). `N` is 1-4.
 */
internal enum class ClosureRecurrenceKind(val wireId: String) {
    ONCE("once"),
    YEARLY_FIXED("yearly-fixed"),
    YEARLY_NTH_WEEKDAY("yearly-nth-weekday"),
    YEARLY_LAST_WEEKDAY("yearly-last-weekday"),
}

/**
 * A decoded `companyHolidays` entry. The OUTPUT of [parseClosureEntry],
 * always fully populated: fields that do not apply to a given [recurrence]
 * are zeroed/blanked rather than left null, so a caller can read [month]
 * without first branching on [recurrence].
 */
internal data class ClosureEntry(
    val recurrence: ClosureRecurrenceKind,
    val name: String,
    /** `YYYY-MM-DD`. `ONCE` only; `""` for every other kind. */
    val date: String = "",
    /** 1-12. Every kind but `ONCE` (`0`). */
    val month: Int = 0,
    /** 1-31. `YEARLY_FIXED` only (`0` otherwise). */
    val day: Int = 0,
    /** ISO weekday, 1 (Monday) - 7 (Sunday). `YEARLY_NTH_WEEKDAY` / `YEARLY_LAST_WEEKDAY` only (`0` otherwise). */
    val weekday: Int = 0,
    /** 1-4. `YEARLY_NTH_WEEKDAY` only (`0` otherwise). */
    val nth: Int = 0,
)

private val ONCE_RE = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val YEARLY_FIXED_RE = Regex("""^yearly:(\d{2})-(\d{2})$""")
private val YEARLY_NTH_RE = Regex("""^yearly-nth:(\d{2})-([1-7])-([1-4])$""")
private val YEARLY_LAST_RE = Regex("""^yearly-last:(\d{2})-([1-7])$""")

/** Any leap year, used only to validate that a `YEARLY_FIXED` day (e.g. Feb 29) is a real calendar day IN SOME year. */
private const val LEAP_REFERENCE_YEAR = 2028

private fun daysInMonth(year: Int, month: Int): Int = YearMonth.of(year, month).lengthOfMonth()

/**
 * The shape-and-range gate every decoded entry passes through before it is
 * trusted, so a hand-edited or corrupted Firestore array element (an
 * out-of-range month, a day that does not exist in its month) cannot
 * silently become a wrong closure date. Mirrors the zod `superRefine` in the
 * TS copies field-for-field, since Kotlin has no zod to reach for.
 */
private fun isValid(candidate: ClosureEntry): Boolean {
    if (candidate.recurrence == ClosureRecurrenceKind.ONCE) return ONCE_RE.matches(candidate.date)
    if (candidate.month < 1 || candidate.month > 12) return false
    if (candidate.recurrence == ClosureRecurrenceKind.YEARLY_FIXED) {
        val maxDay = daysInMonth(LEAP_REFERENCE_YEAR, candidate.month)
        return candidate.day in 1..maxDay
    }
    if (candidate.weekday < 1 || candidate.weekday > 7) return false
    if (candidate.recurrence == ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY) {
        return candidate.nth in 1..4
    }
    return true // YEARLY_LAST_WEEKDAY: month + weekday already checked above.
}

/**
 * Parses one `companyHolidays` wire string. NEVER THROWS: a string this
 * cannot make sense of decodes to `ClosureEntry(ONCE, date = "", name = <the
 * whole raw string>)`, the exact fallback the web `parseDatedEntry` already
 * gives a malformed entry, so a corrupt or legacy-oddball row still renders
 * as SOMETHING instead of vanishing or crashing the settings read.
 *
 * A string with no `|` at all is that same fallback unconditionally: only
 * once a pipe splits the string into a date-part and a name is the date-part
 * tested against the three recognized yearly shapes (or the legacy bare-date
 * shape).
 */
internal fun parseClosureEntry(raw: String): ClosureEntry {
    val sep = raw.indexOf('|')
    if (sep == -1) return ClosureEntry(ClosureRecurrenceKind.ONCE, name = raw)

    val datePart = raw.substring(0, sep)
    val name = raw.substring(sep + 1)

    if (ONCE_RE.matches(datePart)) {
        val candidate = ClosureEntry(ClosureRecurrenceKind.ONCE, name = name, date = datePart)
        return if (isValid(candidate)) candidate else ClosureEntry(ClosureRecurrenceKind.ONCE, name = raw)
    }
    YEARLY_FIXED_RE.matchEntire(datePart)?.let { m ->
        val (month, day) = m.destructured
        val candidate = ClosureEntry(
            ClosureRecurrenceKind.YEARLY_FIXED,
            name = name,
            month = month.toInt(),
            day = day.toInt(),
        )
        return if (isValid(candidate)) candidate else ClosureEntry(ClosureRecurrenceKind.ONCE, name = raw)
    }
    YEARLY_NTH_RE.matchEntire(datePart)?.let { m ->
        val (month, weekday, nth) = m.destructured
        val candidate = ClosureEntry(
            ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY,
            name = name,
            month = month.toInt(),
            weekday = weekday.toInt(),
            nth = nth.toInt(),
        )
        return if (isValid(candidate)) candidate else ClosureEntry(ClosureRecurrenceKind.ONCE, name = raw)
    }
    YEARLY_LAST_RE.matchEntire(datePart)?.let { m ->
        val (month, weekday) = m.destructured
        val candidate = ClosureEntry(
            ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY,
            name = name,
            month = month.toInt(),
            weekday = weekday.toInt(),
        )
        return if (isValid(candidate)) candidate else ClosureEntry(ClosureRecurrenceKind.ONCE, name = raw)
    }
    // No recognized date-part shape. Same fallback as the no-pipe case above:
    // whole raw string as the name, blank date.
    return ClosureEntry(ClosureRecurrenceKind.ONCE, name = raw)
}

// Full month names, spelled as the Android and web admin descriptions spell them.
private val MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

/** Index 0 = ISO weekday 1 (Monday). */
private val WEEKDAY_NAMES =
    listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
private val NTH_WORDS = listOf("", "1st", "2nd", "3rd", "4th")

/** "Every year, Jul 4" / "Every year, 4th Thursday of November" / "Every year, last Monday of May", or the bare `YYYY-MM-DD` for a `ONCE` entry. */
internal fun describeClosureRecurrence(entry: ClosureEntry): String = when (entry.recurrence) {
    ClosureRecurrenceKind.ONCE -> entry.date
    ClosureRecurrenceKind.YEARLY_FIXED ->
        "Every year, ${MONTH_NAMES.getOrElse(entry.month - 1) { "?" }} ${entry.day}"
    ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY ->
        "Every year, ${NTH_WORDS.getOrElse(entry.nth) { "?" }} " +
            "${WEEKDAY_NAMES.getOrElse(entry.weekday - 1) { "?" }} of ${MONTH_NAMES.getOrElse(entry.month - 1) { "?" }}"
    ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY ->
        "Every year, last ${WEEKDAY_NAMES.getOrElse(entry.weekday - 1) { "?" }} of ${MONTH_NAMES.getOrElse(entry.month - 1) { "?" }}"
}

/**
 * LEAP-DAY POLICY for a `YEARLY_FIXED` Feb 29 entry: in a non-leap year it
 * resolves to Feb 28, not Mar 1 and not "no occurrence that year".
 *
 * The alternative of skipping the year entirely would make a real company
 * closure vanish three years out of four with nothing on screen explaining
 * why the day looks open. Rolling forward to Mar 1 crosses into a different
 * month for what the operator entered as a February closure. Landing one day
 * earlier, still inside February, is the smallest possible surprise, and it
 * is the same rule generalized: `clampedDay = min(day, daysInMonth(year,
 * month))`, so Feb 29 is simply the one real-world case where the clamp ever
 * does anything (every other `YEARLY_FIXED` day this module accepts is valid
 * in every year by construction, per [isValid] above).
 */
private fun yearlyFixedDate(year: Int, month: Int, day: Int): LocalDate {
    val clampedDay = minOf(day, daysInMonth(year, month))
    return LocalDate.of(year, month, clampedDay)
}

/** The Nth weekday of `month`/`year`, or `null` if that Nth does not exist (e.g. a "5th Monday" most months do not have). */
private fun nthWeekdayDate(year: Int, month: Int, weekday: Int, nth: Int): LocalDate? {
    val first = LocalDate.of(year, month, 1)
    val firstOccurrence = 1 + (weekday - first.dayOfWeek.value + 7) % 7
    val day = firstOccurrence + (nth - 1) * 7
    if (day > daysInMonth(year, month)) return null
    return LocalDate.of(year, month, day)
}

/** The LAST weekday of `month`/`year` (e.g. the last Monday of May). Always exists, unlike an Nth. */
private fun lastWeekdayDate(year: Int, month: Int, weekday: Int): LocalDate {
    val lastDay = daysInMonth(year, month)
    val last = LocalDate.of(year, month, lastDay)
    return last.minusDays(((last.dayOfWeek.value - weekday + 7) % 7).toLong())
}

/**
 * The single date [entry] falls on in [year], as an ISO `YYYY-MM-DD` string.
 * `null` for a `ONCE` entry (year-agnostic: it already has its own fixed
 * date, see [ClosureEntry.date]) or for an Nth-weekday that does not exist in
 * that particular year/month.
 */
internal fun closureDateInYear(entry: ClosureEntry, year: Int): String? = when (entry.recurrence) {
    ClosureRecurrenceKind.ONCE -> null
    ClosureRecurrenceKind.YEARLY_FIXED -> yearlyFixedDate(year, entry.month, entry.day).toString()
    ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY -> nthWeekdayDate(year, entry.month, entry.weekday, entry.nth)?.toString()
    ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY -> lastWeekdayDate(year, entry.month, entry.weekday).toString()
}

/**
 * The next date [entry] falls on that is `>= onOrAfterIso`, or `null` (a
 * `ONCE` entry already in the past, or an Nth-weekday so rare it does not
 * recur within the lookahead). Six years of lookahead comfortably covers
 * every rule this module resolves.
 */
internal fun nextClosureOccurrence(entry: ClosureEntry, onOrAfterIso: String): String? {
    if (entry.recurrence == ClosureRecurrenceKind.ONCE) {
        return if (entry.date.isNotEmpty() && entry.date >= onOrAfterIso) entry.date else null
    }

    val startYear = onOrAfterIso.take(4).toIntOrNull() ?: return null
    for (year in startYear..(startYear + 6)) {
        val occurrence = closureDateInYear(entry, year)
        if (occurrence != null && occurrence >= onOrAfterIso) return occurrence
    }
    return null
}

/** One US national holiday the closures editor can add in a single click. */
internal data class ClosurePreset(
    val id: String,
    val name: String,
    val recurrence: ClosureRecurrenceKind,
    val month: Int,
    val day: Int = 0,
    val weekday: Int = 0,
    val nth: Int = 0,
)

/**
 * The one-click US national holiday catalog (2026-07-31 operator ruling), as
 * the Android and web admins offer it. This console has no one-click row; it
 * keeps the catalog so its holiday switches carry the same names (#1947).
 * A name here is also written into every `companyHolidays` entry the other
 * admins' chips add, so it must match theirs exactly.
 */
internal val US_HOLIDAY_PRESETS: List<ClosurePreset> = listOf(
    ClosurePreset(id = "new_years", name = "New Year's Day", recurrence = ClosureRecurrenceKind.YEARLY_FIXED, month = 1, day = 1),
    ClosurePreset(id = "mlk", name = "Martin Luther King Jr. Day", recurrence = ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, month = 1, weekday = 1, nth = 3),
    ClosurePreset(id = "presidents", name = "Presidents' Day", recurrence = ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, month = 2, weekday = 1, nth = 3),
    ClosurePreset(id = "memorial", name = "Memorial Day", recurrence = ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, month = 5, weekday = 1),
    ClosurePreset(id = "juneteenth", name = "Juneteenth", recurrence = ClosureRecurrenceKind.YEARLY_FIXED, month = 6, day = 19),
    ClosurePreset(id = "independence", name = "Independence Day", recurrence = ClosureRecurrenceKind.YEARLY_FIXED, month = 7, day = 4),
    ClosurePreset(id = "labor", name = "Labor Day", recurrence = ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, month = 9, weekday = 1, nth = 1),
    ClosurePreset(id = "indigenous_columbus", name = "Indigenous Peoples' Day (Columbus Day)", recurrence = ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, month = 10, weekday = 1, nth = 2),
    ClosurePreset(id = "veterans", name = "Veterans Day", recurrence = ClosureRecurrenceKind.YEARLY_FIXED, month = 11, day = 11),
    ClosurePreset(id = "thanksgiving", name = "Thanksgiving", recurrence = ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, month = 11, weekday = 4, nth = 4),
    ClosurePreset(id = "christmas", name = "Christmas Day", recurrence = ClosureRecurrenceKind.YEARLY_FIXED, month = 12, day = 25),
)

/**
 * The observed-holiday switch ids, each paired with the preset that names it.
 * The ids are the stored `observedUsHolidays` keys and stay as they are: only
 * `columbus` differs from its preset id.
 */
private val OBSERVED_HOLIDAY_PRESET_IDS = listOf(
    "new_years" to "new_years",
    "mlk" to "mlk",
    "presidents" to "presidents",
    "memorial" to "memorial",
    "juneteenth" to "juneteenth",
    "independence" to "independence",
    "labor" to "labor",
    "columbus" to "indigenous_columbus",
    "veterans" to "veterans",
    "thanksgiving" to "thanksgiving",
    "christmas" to "christmas",
)

/**
 * The eleven US holiday switches on the Time Off panel, id to name, in
 * calendar order. Each name is read off its preset, so a holiday has one name
 * on every admin surface (#1947).
 */
internal val US_OBSERVED_HOLIDAYS: List<Pair<String, String>> = OBSERVED_HOLIDAY_PRESET_IDS.map { (id, presetId) ->
    id to (US_HOLIDAY_PRESETS.firstOrNull { it.id == presetId }?.name ?: id)
}

/** One company holiday row as the Time Off list shows it. */
internal data class CompanyHolidayRow(
    /** The stored wire string, unchanged. */
    val entry: String,
    /** Its position in the stored `companyHolidays` list, so Remove takes out this entry and no other. */
    val index: Int,
    val closure: ClosureEntry,
    /** The next date it falls on, today or later; `null` for a one-time date that has passed or a row that cannot be read. */
    val next: String?,
)

/**
 * Company holidays in the order the Time Off list shows them (#1979): the
 * next closure first, by the date each row next falls on. After the upcoming
 * rows come one-time closures that have passed, oldest first, then any row
 * that cannot be read. Same date: by name, then stored position. Display
 * only: the stored list keeps its order, and each row carries its stored
 * [CompanyHolidayRow.index].
 */
internal fun companyHolidayRows(entries: List<String>, todayIso: String): List<CompanyHolidayRow> {
    fun group(r: CompanyHolidayRow) = when {
        r.next != null -> 0
        r.closure.date.isNotEmpty() -> 1
        else -> 2
    }
    return entries
        .mapIndexed { index, entry ->
            val closure = parseClosureEntry(entry)
            CompanyHolidayRow(entry, index, closure, nextClosureOccurrence(closure, todayIso))
        }
        .sortedWith(
            compareBy<CompanyHolidayRow>({ group(it) }, { it.next ?: it.closure.date }, { it.closure.name }, { it.index }),
        )
}
