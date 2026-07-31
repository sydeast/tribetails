package com.tribetails.auntieos.ui.admin

import java.time.LocalDate
import java.time.YearMonth

/**
 * ANDROID PORT of `mytribe/functions/src/lib/closureRecurrence.ts` (canonical)
 * and its web mirror `auntieos-admin/src/lib/closureRecurrence.ts`. Ported
 * verbatim (same wire grammar, same date math, same leap-day policy) rather
 * than shared, because there is no cross-platform module in this repo --
 * android is a separate Gradle module with no dependency on either npm
 * project, and this codebase's own convention for cross-platform logic is
 * documented duplication (see `US_HOLIDAYS` a few lines below in
 * `AdminSettingsScreen.kt`, "Ported verbatim", and this file's own weekday
 * convention, which matches `ui/home/DashboardInsights.kt#usPetCareHolidays`
 * -- an UNRELATED feature that happens to need the same nth/last-weekday
 * math, confirming ISO weekday numbering is already this codebase's
 * convention rather than a new one invented here). Any change to the
 * recurrence rules, wire grammar, or leap-day policy has to land in all
 * three copies.
 *
 * Recurrence for a `business_settings.companyHolidays` closure entry.
 *
 * OPERATOR RULING (2026-07-31): a US national holiday like Independence Day
 * recurs every year. Before this, the closures editor demanded a full
 * `YYYY-MM-DD` for EVERY entry, so observing July 4th meant re-entering a new
 * dated row every January forever. `ONCE` is the exact pre-existing behavior
 * (a single dated closure); the three `YEARLY_*` kinds are new.
 *
 * WHY A FLOATING-DATE KIND IS SEPARATE FROM A FIXED ONE. Memorial Day is not
 * "May 25", it is the LAST MONDAY of May, and May 25 is only sometimes that
 * Monday (2026: yes; 2027: no, it is May 31). Storing it as a fixed May 25
 * would silently stop being Memorial Day the next year the dates disagree.
 * `YEARLY_FIXED` is for a date genuinely the same every year (Jul 4, Dec 25);
 * `YEARLY_NTH_WEEKDAY` / `YEARLY_LAST_WEEKDAY` are for a date defined BY a
 * weekday rule, computed fresh for whichever year is being asked about.
 *
 * WHY THIS STAYS `companyHolidays: List<String>`, NOT A NEW SHAPE. The doc is
 * a direct client Firestore write (`firestore.rules`: `allow write: if
 * isAuntie()`), read by three platforms. Changing the array's ELEMENT TYPE
 * from string to object would require migrating every existing operator's
 * doc before any client could safely read it, and there is no callable in
 * front of this write to gate that migration through. Instead the wire
 * format stays a string, and its grammar grows a recurrence TAG in the date
 * half:
 *
 *   ONCE:                `YYYY-MM-DD|Name`              (unchanged, zero new syntax)
 *   YEARLY_FIXED:         `yearly:MM-DD|Name`            e.g. `yearly:07-04|Independence Day`
 *   YEARLY_NTH_WEEKDAY:   `yearly-nth:MM-W-N|Name`       e.g. `yearly-nth:11-4-4|Thanksgiving`
 *   YEARLY_LAST_WEEKDAY:  `yearly-last:MM-W|Name`        e.g. `yearly-last:05-1|Memorial Day`
 *
 * `W` is an ISO weekday, 1 (Monday) through 7 (Sunday) -- `LocalDate.dayOfWeek.value`'s
 * own numbering, so no conversion is needed on this platform at all. `N` is
 * 1-4 ("4th Thursday"); "last" is its own kind rather than a magic `N=5`,
 * because a month can have four or five Mondays and "5th" would silently mean
 * different things in different years.
 *
 * None of the three tags (`yearly:`, `yearly-nth:`, `yearly-last:`) can ever
 * match `^\d{4}-\d{2}-\d{2}$`, so [parseClosureEntry] tells old and new
 * entries apart by shape alone, with no migration pass: an operator's
 * existing dated entries decode exactly as they did before this shipped
 * (`ClosureRecurrenceKind.ONCE`), untouched in Firestore, forever, unless the
 * operator edits them.
 *
 * CONSUMERS TODAY: as of this writing, nothing on Android reads
 * `companyHolidays` to decide whether a day is bookable (verified: zero hits
 * for `companyHolidays`/`specialHours` outside `AdminSettingsScreen.kt`,
 * `LocationModels.kt`, and this file's own tests, across
 * `ui/admin/scheduling/BookingConflictHelpers.kt` and `ui/admin/ScheduleViewScreen.kt`).
 * `TimeOffPanel` (in `AdminSettingsScreen.kt`) IS this module's first
 * consumer: it needs a sensible date to show for a rule with no single stored
 * date.
 */
enum class ClosureRecurrenceKind(val wireId: String) {
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
data class ClosureEntry(
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
fun parseClosureEntry(raw: String): ClosureEntry {
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

private fun pad2(n: Int): String = n.toString().padStart(2, '0')

/**
 * The inverse of [parseClosureEntry]: builds the wire string to append to
 * `companyHolidays`. Only the fields the given [ClosureEntry.recurrence]
 * actually uses are read.
 */
fun formatClosureEntry(entry: ClosureEntry): String = when (entry.recurrence) {
    ClosureRecurrenceKind.ONCE -> "${entry.date}|${entry.name}"
    ClosureRecurrenceKind.YEARLY_FIXED -> "yearly:${pad2(entry.month)}-${pad2(entry.day)}|${entry.name}"
    ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY ->
        "yearly-nth:${pad2(entry.month)}-${entry.weekday}-${entry.nth}|${entry.name}"
    ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY ->
        "yearly-last:${pad2(entry.month)}-${entry.weekday}|${entry.name}"
}

// Full names, not abbreviations: the panel's own Month picker in AdminSettingsScreen.kt
// spells the month out (e.g. "November"), so the description sitting right below
// the just-made pick echoes the same word rather than shortening it to "Nov".
private val MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

/** Index 0 = ISO weekday 1 (Monday). */
private val WEEKDAY_NAMES =
    listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
private val NTH_WORDS = listOf("", "1st", "2nd", "3rd", "4th")

/** "Every year, Jul 4" / "Every year, 4th Thursday of November" / "Every year, last Monday of May", or the bare `YYYY-MM-DD` for a `ONCE` entry. */
fun describeClosureRecurrence(entry: ClosureEntry): String = when (entry.recurrence) {
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
fun closureDateInYear(entry: ClosureEntry, year: Int): String? = when (entry.recurrence) {
    ClosureRecurrenceKind.ONCE -> null
    ClosureRecurrenceKind.YEARLY_FIXED -> yearlyFixedDate(year, entry.month, entry.day).toString()
    ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY -> nthWeekdayDate(year, entry.month, entry.weekday, entry.nth)?.toString()
    ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY -> lastWeekdayDate(year, entry.month, entry.weekday).toString()
}

/**
 * Every date [entry] falls on within `[startIso, endIso]` (inclusive),
 * expanding a yearly recurrence across EVERY year the range touches -- a
 * range crossing a year boundary (Dec into Jan) needs both years checked from
 * a single stored entry.
 */
fun closureOccurrencesInRange(entry: ClosureEntry, startIso: String, endIso: String): List<String> {
    if (startIso > endIso) return emptyList()
    if (entry.recurrence == ClosureRecurrenceKind.ONCE) {
        if (entry.date.isEmpty()) return emptyList()
        return if (entry.date in startIso..endIso) listOf(entry.date) else emptyList()
    }
    val startYear = startIso.take(4).toIntOrNull() ?: return emptyList()
    val endYear = endIso.take(4).toIntOrNull() ?: return emptyList()
    val out = mutableListOf<String>()
    for (year in startYear..endYear) {
        val occurrence = closureDateInYear(entry, year)
        if (occurrence != null && occurrence in startIso..endIso) out.add(occurrence)
    }
    return out
}

/**
 * The next date [entry] falls on that is `>= onOrAfterIso`, or `null` (a
 * `ONCE` entry already in the past, or an Nth-weekday so rare it does not
 * recur within the lookahead). Six years of lookahead comfortably covers
 * every rule this module resolves.
 */
fun nextClosureOccurrence(entry: ClosureEntry, onOrAfterIso: String): String? {
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
data class ClosurePreset(
    val id: String,
    val name: String,
    val recurrence: ClosureRecurrenceKind,
    val month: Int,
    val day: Int = 0,
    val weekday: Int = 0,
    val nth: Int = 0,
)

/**
 * The one-click US national holiday catalog for the closures editor, per the
 * 2026-07-31 operator ruling. Every entry uses the REAL recurrence rule,
 * never a fixed date standing in for a floating one -- Memorial Day is
 * `YEARLY_LAST_WEEKDAY`, not a hardcoded "May 25".
 *
 * Ids are independent of `US_HOLIDAYS` in `AdminSettingsScreen.kt` (the older
 * observed/not-observed checklist, a boolean per holiday with no date
 * anywhere in its storage). That list and this one serve different fields --
 * `observedUsHolidays` vs. a dated `companyHolidays` entry.
 */
val US_HOLIDAY_PRESETS: List<ClosurePreset> = listOf(
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

/** A preset, decoded to the same [ClosureEntry] shape [parseClosureEntry] produces, ready for [formatClosureEntry] to encode onto `companyHolidays`. */
fun closureEntryFromPreset(preset: ClosurePreset): ClosureEntry = ClosureEntry(
    recurrence = preset.recurrence,
    name = preset.name,
    month = preset.month,
    day = preset.day,
    weekday = preset.weekday,
    nth = preset.nth,
)

/**
 * The Add-company-holiday gate in [AdminSettingsScreen.kt]'s `TimeOffPanel`,
 * branched on recurrence. `ONCE` is the exact pre-existing rule (a 10-char
 * date string plus a clean name). Every `YEARLY_*` kind needs its
 * date-defining fields ACTUALLY picked (not left `null`) instead of a date
 * string, because there is no date to type -- that is what "no year input"
 * means. Mirrors the web `holidayAddEnabled` in `TimeOffEditor.tsx`; the
 * `null`s below are that side's `0` "Pick a ..." sentinel, expressed as
 * Kotlin's native "not yet picked".
 *
 * Pure and exposed at file scope (not `private`) so it is directly
 * unit-testable, the same convention `specialHoursAddEnabled` already uses
 * for the sibling special-hours gate.
 */
fun companyHolidayAddEnabled(
    recurrence: ClosureRecurrenceKind,
    name: String,
    date: String,
    month: Int?,
    day: Int?,
    weekday: Int?,
    nth: Int?,
): Boolean {
    if (name.isBlank() || name.contains('|')) return false
    return when (recurrence) {
        ClosureRecurrenceKind.ONCE -> date.length == 10
        ClosureRecurrenceKind.YEARLY_FIXED -> month != null && day != null
        ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY -> month != null && weekday != null && nth != null
        ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY -> month != null && weekday != null
    }
}
