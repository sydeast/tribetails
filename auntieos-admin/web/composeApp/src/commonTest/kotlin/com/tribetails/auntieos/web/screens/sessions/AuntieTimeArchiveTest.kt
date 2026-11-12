package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.ExperimentalTime
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.minus
import kotlinx.datetime.toInstant

/**
 * ISSUE #2036, the console half. Mirrors the web suite in
 * `src/lib/sessionArchive.test.ts` and Android's `AuntieTimeArchiveTest`: FROM
 * and TO are whole business days, a visit from ten days ago is reachable, and
 * a clock change day is one day. Every case passes the zone, so none depends
 * on the zone of the machine running it.
 */
@OptIn(ExperimentalTime::class)
class AuntieTimeArchiveTest {

    private val chicago = TimeZone.of("America/Chicago")

    /** A business wall clock as the UTC instant string a server writer stamps. */
    private fun instant(day: String, hhmm: String, zone: TimeZone = chicago): String =
        LocalDateTime.parse("${day}T$hhmm:00").toInstant(zone).toString()

    private fun session(
        id: String = "s",
        startTime: String,
        status: String = "COMPLETED",
        completedAt: String = "",
        endTime: String = "",
    ) = KinCareSession(_id = id, startTime = startTime, endTime = endTime, status = status, completedAt = completedAt)

    private fun range(from: String, to: String) = ArchiveRange(LocalDate.parse(from), LocalDate.parse(to))

    // ── FROM and TO are whole business days ─────────────────────────────────

    @Test
    fun `a 23-30 visit on the TO day is in, stored as an instant`() {
        val start = instant("2026-11-11", "23:30")
        // 23:30 in Chicago is 05:30 UTC the next day, which a UTC-day cut loses.
        assertEquals("2026-11-12T05:30:00Z", start)
        assertTrue(isInArchiveRange(start, range("2026-11-10", "2026-11-11"), chicago))
    }

    @Test
    fun `a 00-15 visit on the day after TO is out`() {
        assertFalse(isInArchiveRange(instant("2026-11-12", "00:15"), range("2026-11-10", "2026-11-11"), chicago))
    }

    @Test
    fun `the first minute of the FROM day is in and the evening before is out`() {
        val r = range("2026-11-10", "2026-11-11")
        assertTrue(isInArchiveRange(instant("2026-11-10", "00:00"), r, chicago))
        // 22:32 on Nov 9 is 04:32 UTC on Nov 10: a UTC-day cut took it.
        assertFalse(isInArchiveRange(instant("2026-11-09", "22:32"), r, chicago))
        assertFalse(isInArchiveRange(instant("2026-11-09", "23:59"), r, chicago))
    }

    @Test
    fun `a zone-less start is read as the business wall clock it is`() {
        val r = range("2026-11-10", "2026-11-11")
        assertTrue(isInArchiveRange("2026-11-11T23:30:00", r, chicago))
        assertTrue(isInArchiveRange("2026-11-11T23:30", r, chicago))
        assertFalse(isInArchiveRange("2026-11-12T00:15:00", r, chicago))
        assertFalse(isInArchiveRange("2026-11-09T23:59:00", r, chicago))
    }

    @Test
    fun `one day picked twice holds that whole day and nothing beside it`() {
        val day = range("2026-11-11", "2026-11-11")
        assertTrue(isInArchiveRange(instant("2026-11-11", "00:00"), day, chicago))
        assertTrue(isInArchiveRange(instant("2026-11-11", "23:59"), day, chicago))
        assertFalse(isInArchiveRange(instant("2026-11-10", "23:59"), day, chicago))
        assertFalse(isInArchiveRange(instant("2026-11-12", "00:00"), day, chicago))
    }

    @Test
    fun `a start that does not read is never in a range`() {
        assertFalse(isInArchiveRange("", range("2026-11-10", "2026-11-11"), chicago))
        assertFalse(isInArchiveRange("nope", range("2026-11-10", "2026-11-11"), chicago))
    }

    // ── clock change days ───────────────────────────────────────────────────

    @Test
    fun `spring forward, the 23 hour day is one whole day`() {
        val day = range("2026-03-08", "2026-03-08")
        assertTrue(isInArchiveRange(instant("2026-03-08", "00:15"), day, chicago))
        assertTrue(isInArchiveRange(instant("2026-03-08", "23:30"), day, chicago))
        assertFalse(isInArchiveRange(instant("2026-03-09", "00:15"), day, chicago))
        assertFalse(isInArchiveRange(instant("2026-03-07", "23:30"), day, chicago))
    }

    @Test
    fun `fall back, the 25 hour day is one whole day`() {
        val day = range("2026-11-01", "2026-11-01")
        // 23:30 CST is 05:30 UTC on Nov 2; 24 hours from the day's start stops at 05:00.
        assertEquals("2026-11-02T05:30:00Z", instant("2026-11-01", "23:30"))
        assertTrue(isInArchiveRange(instant("2026-11-01", "00:15"), day, chicago))
        assertTrue(isInArchiveRange(instant("2026-11-01", "23:30"), day, chicago))
        assertFalse(isInArchiveRange(instant("2026-11-02", "00:15"), day, chicago))
        assertFalse(isInArchiveRange(instant("2026-10-31", "23:30"), day, chicago))
    }

    // ── the opening range and the gap it closes ─────────────────────────────

    @Test
    fun `the Archive opens on the 30 days that end where Recent stops`() {
        assertEquals(range("2026-10-12", "2026-11-10"), archiveDefaultRange(LocalDate.parse("2026-11-12")))
    }

    @Test
    fun `a visit from 10 days ago is in the Archive without touching the dates`() {
        val today = LocalDate.parse("2026-11-12")
        val tenDaysAgo = today.minus(10, DateTimeUnit.DAY).toString()
        val visit = session(
            id = "ten",
            startTime = instant(tenDaysAgo, "18:30"),
            completedAt = instant(tenDaysAgo, "19:05"),
        )
        // Not on the board, which is why it needs the Archive.
        assertFalse(isVisibleOnAuntieTime(visit, today.toString(), chicago))
        val days = archiveDays(listOf(visit), archiveDefaultRange(today), chicago)
        assertEquals(listOf(tenDaysAgo), days.map { it.day })
        assertEquals(listOf("ten"), days.single().sessions.map { it._id })
    }

    @Test
    fun `no wrapped visit sits between Recent and the Archive, and none sits in both`() {
        val today = LocalDate.parse("2026-11-12")
        val opening = archiveDefaultRange(today)
        for (age in 0..31) {
            val day = today.minus(age, DateTimeUnit.DAY).toString()
            for (hhmm in listOf("00:15", "12:00", "23:30")) {
                val at = instant(day, hhmm)
                val visit = session(startTime = at, completedAt = at)
                val onBoard = isVisibleOnAuntieTime(visit, today.toString(), chicago)
                val inArchive = isInArchiveRange(visit.startTime, opening, chicago)
                assertTrue(onBoard != inArchive, "$age days back at $hhmm: board=$onBoard archive=$inArchive")
            }
        }
    }

    @Test
    fun `a visit older than the opening range is reached by moving FROM`() {
        val today = LocalDate.parse("2026-11-12")
        val longAgo = today.minus(40, DateTimeUnit.DAY)
        val old = instant(longAgo.toString(), "23:30")
        assertFalse(isInArchiveRange(old, archiveDefaultRange(today), chicago))
        assertTrue(isInArchiveRange(old, archiveDefaultRange(today).withFrom(longAgo), chicago))
    }

    // ── the list ────────────────────────────────────────────────────────────

    @Test
    fun `visits are filed under the business day they start on, in time order`() {
        val days = archiveDays(
            listOf(
                session(id = "late", startTime = instant("2026-11-11", "23:30")),
                session(id = "noon", startTime = instant("2026-11-11", "13:10")),
                session(id = "bare", startTime = "2026-11-11T21:00:00"),
                session(id = "prior", startTime = instant("2026-11-10", "22:32")),
                session(id = "eve", startTime = instant("2026-11-09", "22:32")),
                session(id = "next", startTime = instant("2026-11-12", "00:15")),
            ),
            range("2026-11-10", "2026-11-11"),
            chicago,
        )
        assertEquals(
            listOf("2026-11-10" to listOf("prior"), "2026-11-11" to listOf("noon", "bare", "late")),
            days.map { d -> d.day to d.sessions.map { it._id } },
        )
    }

    @Test
    fun `an unfinished old visit is listed, and a request that was never approved is not`() {
        val days = archiveDays(
            listOf(
                session(id = "open", startTime = instant("2026-11-10", "09:00"), status = "SCHEDULED"),
                session(id = "cancelled", startTime = instant("2026-11-10", "10:00"), status = "CANCELLED"),
                session(id = "pending", startTime = instant("2026-11-10", "11:00"), status = "PENDING"),
                session(id = "draft", startTime = instant("2026-11-10", "12:00"), status = "DRAFT"),
            ),
            range("2026-11-10", "2026-11-10"),
            chicago,
        )
        assertEquals(listOf("open", "cancelled"), days.single().sessions.map { it._id })
    }

    @Test
    fun `setting one box past the other moves the other, so the range is never inside out`() {
        val r = range("2026-11-01", "2026-11-10")
        assertEquals(range("2026-11-15", "2026-11-15"), r.withFrom(LocalDate.parse("2026-11-15")))
        assertEquals(range("2026-10-20", "2026-10-20"), r.withTo(LocalDate.parse("2026-10-20")))
        assertEquals(range("2026-11-05", "2026-11-10"), r.withFrom(LocalDate.parse("2026-11-05")))
        assertEquals(range("2026-11-01", "2026-11-12"), r.withTo(LocalDate.parse("2026-11-12")))
    }

    @Test
    fun `day headings read as the web Archive's do`() {
        val today = LocalDate.parse("2026-11-12")
        assertEquals("Today", archiveDayLabel("2026-11-12", today))
        assertEquals("Yesterday", archiveDayLabel("2026-11-11", today))
        assertEquals("Tue, Nov 10", archiveDayLabel("2026-11-10", today))
        assertEquals("Thu, Jan 16, 2025", archiveDayLabel("2025-01-16", today))
        assertEquals("Nov 11, 2026", archiveBoxLabel(LocalDate.parse("2026-11-11")))
    }

    // ── the board reads the same business day ───────────────────────────────

    @Test
    fun `a 23-30 visit tonight is filed under today, not under tomorrow`() {
        val at = instant("2026-11-11", "23:30")
        assertEquals("2026-11-11", businessDayOf(at, chicago))
        assertEquals("2026-11-11", businessDayOf("2026-11-11T23:30:00", chicago))
        assertEquals("2026-11-11", businessDayOf("2026-11-11", chicago))
        assertEquals("", businessDayOf("", chicago))
        val wrapped = session(startTime = at, completedAt = at)
        assertTrue(isVisibleOnAuntieTime(wrapped, "2026-11-12", chicago))
        // Two days on it has left Recent, where the UTC day kept it one day longer.
        assertFalse(isVisibleOnAuntieTime(wrapped, "2026-11-13", chicago))
    }

    @Test
    fun `a 23-30 visit yesterday is still on today's run sheet and overdue the day after`() {
        val visit = session(startTime = instant("2026-11-10", "23:30"), status = "SCHEDULED")
        assertFalse(isOverdueScheduled(visit, "2026-11-11", chicago))
        assertTrue(isOverdueScheduled(visit, "2026-11-12", chicago))
    }

    @Test
    fun `the card prints the business's day and clock for an instant`() {
        val visit = session(
            startTime = instant("2026-11-11", "23:30"),
            endTime = instant("2026-11-12", "00:15"),
        )
        assertEquals("Nov 11 · 23:30 to 00:15", sessionWindow(visit, chicago))
        assertEquals("Mar 8 · 23:30", businessShortDateTime(instant("2026-03-08", "23:30"), chicago))
        assertEquals("Time TBD", sessionWindow(session(startTime = ""), chicago))
    }
}
