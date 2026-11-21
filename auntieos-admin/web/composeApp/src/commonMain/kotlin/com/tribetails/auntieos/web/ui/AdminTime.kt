package com.tribetails.auntieos.web.ui

import kotlinx.datetime.LocalDateTime

/**
 * THE ADMIN DATE AND TIME SHAPE (#1828, owner ruling 2026-11-12): "auntieOS in
 * 24hr & alphanumeric date". Every admin screen writes a day as "Nov 10, 2026"
 * and a moment as "Nov 10, 2026 22:32". The walk found one visit written five
 * ways ("11-10 22:32", "2026-11-10 22:32", "Nov 10 · 10:32 PM", "10:32p", a raw
 * UTC stamp). This is the one place the console spells that shape.
 *
 * Mirrors `lib/time.ts` in the React admin and `domain/AdminTime.kt` on
 * Android. Admin only: MyTribe and anything sent to a household stays on a
 * 12-hour clock, and Time Block names ("Midday (11 AM to 3 PM)") are names, not
 * clock readings, so neither comes through here.
 */
object AdminTime {
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** "Nov 10, 2026" from a year, a 1-based month and a day. */
    fun date(year: Int, month: Int, day: Int): String =
        "${MONTHS.getOrElse(month - 1) { month.toString().padStart(2, '0') }} $day, $year"

    /** "22:32" from an hour (0-23) and a minute. */
    fun clock(hour: Int, minute: Int): String =
        "${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}"

    /** "Nov 10, 2026 22:32". */
    fun dateTime(year: Int, month: Int, day: Int, hour: Int, minute: Int): String =
        "${date(year, month, day)} ${clock(hour, minute)}"

    /** "Nov 10, 2026 22:32" for a wall-clock reading. */
    fun dateTime(at: LocalDateTime): String =
        dateTime(at.year, at.monthNumber, at.dayOfMonth, at.hour, at.minute)

    /**
     * A stored `yyyy-MM-ddTHH:mm...` wall-clock string as "Nov 10, 2026 22:32",
     * read positionally (no zone conversion), or null when it is not that shape.
     */
    fun dateTimeOfWallClock(iso: String): String? {
        val m = WALL_CLOCK.find(iso.trim()) ?: return null
        val (y, mo, d, h, mi) = m.destructured
        return dateTime(y.toInt(), mo.toInt(), d.toInt(), h.toInt(), mi.toInt())
    }

    /** A `yyyy-MM-dd` day key as "Nov 10, 2026"; anything else comes back as it was. */
    fun dayKeyLabel(key: String): String {
        val m = DAY_KEY.matchEntire(key) ?: return key
        val (y, mo, d) = m.destructured
        return date(y.toInt(), mo.toInt(), d.toInt())
    }

    private val WALL_CLOCK = Regex("""^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})""")
    private val DAY_KEY = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")
}
