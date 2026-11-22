package com.tribetails.auntieos.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * THE ADMIN DATE AND TIME SHAPE (#1828, owner ruling 2026-11-12): "auntieOS in
 * 24hr & alphanumeric date". Every admin screen writes a day as "Nov 10, 2026"
 * and a moment as "Nov 10, 2026 22:32". The walk found one visit written five
 * ways ("11-10 22:32", "2026-11-10 22:32", "Nov 10 · 10:32 PM", "10:32p", a raw
 * UTC stamp). This is the one place the shape is spelled; a screen that needs a
 * date reaches for it rather than building its own pattern.
 *
 * Mirrors `lib/time.ts` in the React admin and `AdminTime.kt` in the desktop
 * console. Admin only: MyTribe and anything sent to a household stays on a
 * 12-hour clock, and Time Block names ("Midday (11 AM to 3 PM)") are names, not
 * clock readings, so neither comes through here.
 */
object AdminTime {
    /** "Nov 10, 2026". */
    const val DATE_PATTERN = "MMM d, yyyy"

    /** "22:32". */
    const val CLOCK_PATTERN = "HH:mm"

    /** "Nov 10, 2026 22:32". */
    const val DATE_TIME_PATTERN = "$DATE_PATTERN $CLOCK_PATTERN"

    val DATE: DateTimeFormatter = DateTimeFormatter.ofPattern(DATE_PATTERN, Locale.US)
    val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern(CLOCK_PATTERN, Locale.US)
    val DATE_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern(DATE_TIME_PATTERN, Locale.US)

    /** "22:32" from an hour (0-23) and a minute. */
    fun clock(hour: Int, minute: Int): String = "%02d:%02d".format(Locale.US, hour, minute)

    /** "Nov 10, 2026 22:32" for an instant read in [zone]. */
    fun dateTime(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        DATE_TIME.format(Instant.ofEpochMilli(ms).atZone(zone))

    /** "Nov 10, 2026 22:32" from a wall-clock year, 1-based month, day, hour and minute. */
    fun dateTime(year: Int, month: Int, day: Int, hour: Int, minute: Int): String =
        "${date(LocalDate.of(year, month, day))} ${clock(hour, minute)}"

    /** "Nov 10, 2026" for a calendar day. */
    fun date(day: LocalDate): String = DATE.format(day)

    /**
     * A stored stamp as "Nov 10, 2026 22:32" on the business [zone]: an instant is
     * converted, a zone-less value already is that clock. Null when it is neither.
     * Printing a UTC instant's own characters moved a 22:30 Chicago visit to the
     * next day.
     */
    fun storedDateTime(raw: String, zone: ZoneId): String? =
        storedBusinessLocal(raw, zone)?.let { DATE_TIME.format(it) }

    /** A `yyyy-MM-dd` day key as "Nov 10, 2026"; anything else comes back as it was. */
    fun dayKeyLabel(key: String): String =
        runCatching { date(LocalDate.parse(key)) }.getOrDefault(key)
}
