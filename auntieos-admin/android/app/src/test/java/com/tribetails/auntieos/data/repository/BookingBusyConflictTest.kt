package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.TimeSlotSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * The Kotlin twin of `mytribe/functions/test/bookingBusyConflict.test.ts`.
 * Same cases, same names in spirit: exact edges, contained, spanning,
 * disjoint, timezone-agnostic instant math, plus the decode edge cases
 * (midnight rollover, malformed rows).
 */
class BookingBusyConflictTest {

    private fun slot(
        id: String,
        date: String,
        start: String,
        end: String,
        source: TimeSlotSource = TimeSlotSource.GOOGLE_BUSY_IMPORT,
    ) = BookingTimeSlot(id = id, date = date, startTime = start, endTime = end, source = source)

    // ── decodeGoogleBusySlot ─────────────────────────────────────────────────

    @Test
    fun `decodes a same-day slot to real UTC instants`() {
        val d = decodeGoogleBusySlot(slot("s1", "2026-08-07", "14:00", "15:30"))
        assertEquals(Instant.parse("2026-08-07T14:00:00Z"), d!!.startInstant)
        assertEquals(Instant.parse("2026-08-07T15:30:00Z"), d.endInstant)
    }

    @Test
    fun `rolls the end to the next UTC day when endTime is less than or equal to startTime`() {
        val d = decodeGoogleBusySlot(slot("s1", "2026-08-07", "22:00", "02:00"))
        assertEquals(Instant.parse("2026-08-07T22:00:00Z"), d!!.startInstant)
        assertEquals(Instant.parse("2026-08-08T02:00:00Z"), d.endInstant)
    }

    @Test
    fun `treats an exactly-equal start and end as a 24h block rather than zero-length`() {
        val d = decodeGoogleBusySlot(slot("s1", "2026-08-07", "09:00", "09:00"))
        assertEquals(24 * 3600_000L, d!!.endInstant.toEpochMilli() - d.startInstant.toEpochMilli())
    }

    @Test
    fun `#1160 prefers startMs and endMs over a business wall clock`() {
        val d = decodeGoogleBusySlot(
            slot("s1", "2026-10-05", "14:00", "15:00").copy(
                startMs = Instant.parse("2026-10-05T19:00:00Z").toEpochMilli(),
                endMs = Instant.parse("2026-10-05T20:00:00Z").toEpochMilli(),
            ),
        )
        assertEquals(Instant.parse("2026-10-05T19:00:00Z"), d!!.startInstant)
        assertEquals(Instant.parse("2026-10-05T20:00:00Z"), d.endInstant)
    }
    @Test
    fun `#1160 a row without usable instants is read as legacy UTC`() {
        for (row in listOf(
            slot("s1", "2026-10-05", "19:00", "20:00"),
            slot("s1", "2026-10-05", "19:00", "20:00").copy(startMs = 200L, endMs = 100L),
        )) {
            assertEquals(Instant.parse("2026-10-05T19:00:00Z"), decodeGoogleBusySlot(row)!!.startInstant)
        }
    }
    @Test
    fun `returns null for a non-GOOGLE_BUSY_IMPORT row`() {
        assertNull(decodeGoogleBusySlot(slot("s1", "2026-08-07", "09:00", "10:00", TimeSlotSource.INTERNAL_MANUAL)))
    }

    @Test
    fun `returns null for a malformed date or time rather than throwing`() {
        assertNull(decodeGoogleBusySlot(slot("s1", "not-a-date", "09:00", "10:00")))
        assertNull(decodeGoogleBusySlot(slot("s1", "2026-08-07", "xx", "10:00")))
        assertNull(decodeGoogleBusySlot(slot("s1", "2026-08-07", "09:00", "")))
    }

    // ── findBusyConflicts (timezone-agnostic instant math) ──────────────────

    private val busyStart = Instant.ofEpochMilli(1_800_000_000_000)
    private val busyEnd = Instant.ofEpochMilli(1_800_003_600_000) // 1h window
    private fun busy() = DecodedBusySlot("b1", busyStart, busyEnd)

    @Test
    fun `exact edges do not conflict (half-open interval)`() {
        assertTrue(findBusyConflicts(BusyConflictWindow(busyStart.minusSeconds(3600), busyStart), listOf(busy())).isEmpty())
        assertTrue(findBusyConflicts(BusyConflictWindow(busyEnd, busyEnd.plusSeconds(3600)), listOf(busy())).isEmpty())
    }

    @Test
    fun `a visit starting exactly when the busy block starts DOES conflict`() {
        val r = findBusyConflicts(BusyConflictWindow(busyStart, busyStart.plusSeconds(60)), listOf(busy()))
        assertEquals(1, r.size)
    }

    @Test
    fun `a visit entirely contained inside the busy block conflicts`() {
        val r = findBusyConflicts(
            BusyConflictWindow(busyStart.plusSeconds(600), busyStart.plusSeconds(900)),
            listOf(busy()),
        )
        assertEquals(1, r.size)
        assertEquals("b1", r[0].docId)
    }

    @Test
    fun `a visit that contains the whole busy block conflicts`() {
        val r = findBusyConflicts(
            BusyConflictWindow(busyStart.minusSeconds(60), busyEnd.plusSeconds(60)),
            listOf(busy()),
        )
        assertEquals(1, r.size)
    }

    @Test
    fun `a visit spanning only the busy block's start edge conflicts`() {
        val r = findBusyConflicts(
            BusyConflictWindow(busyStart.minusSeconds(60), busyStart.plusSeconds(60)),
            listOf(busy()),
        )
        assertEquals(1, r.size)
    }

    @Test
    fun `a visit spanning only the busy block's end edge conflicts`() {
        val r = findBusyConflicts(
            BusyConflictWindow(busyEnd.minusSeconds(60), busyEnd.plusSeconds(60)),
            listOf(busy()),
        )
        assertEquals(1, r.size)
    }

    @Test
    fun `a disjoint visit does not conflict`() {
        val r = findBusyConflicts(
            BusyConflictWindow(busyStart.minusSeconds(7200), busyStart.minusSeconds(3600)),
            listOf(busy()),
        )
        assertTrue(r.isEmpty())
    }

    @Test
    fun `is pure instant math, independent of any timezone`() {
        val farStart = Instant.ofEpochMilli(4_102_444_800_001)
        val farEnd = Instant.ofEpochMilli(4_102_448_400_001)
        val r = findBusyConflicts(
            BusyConflictWindow(Instant.ofEpochMilli(4_102_446_000_000), Instant.ofEpochMilli(4_102_447_000_000)),
            listOf(DecodedBusySlot("far", farStart, farEnd)),
        )
        assertEquals(1, r.size)
    }

    // ── resolveVisitWindow (business wall-clock anchoring) ─────────────────────

    @Test
    fun `resolves a bare ISO_LOCAL_DATE_TIME visit anchored to the given zone`() {
        val zone = ZoneId.of("America/New_York")
        val w = resolveVisitWindow("2026-08-07T14:00:00", "2026-08-07T15:00:00", zone)
        assertEquals(
            java.time.LocalDateTime.parse("2026-08-07T14:00:00").atZone(zone).toInstant(),
            w!!.startInstant,
        )
    }

    @Test
    fun `resolves a genuine zoned instant string without reinterpreting it as local`() {
        val w = resolveVisitWindow("2026-08-07T14:00:00Z", "2026-08-07T15:00:00Z", ZoneId.of("America/New_York"))
        assertEquals(Instant.parse("2026-08-07T14:00:00Z"), w!!.startInstant)
    }

    @Test
    fun `a missing end is expanded to a one-millisecond point at the start instant`() {
        val w = resolveVisitWindow("2026-08-07T14:00:00Z", "", ZoneOffset.UTC)
        assertEquals(1L, w!!.endInstant.toEpochMilli() - w.startInstant.toEpochMilli())
    }

    @Test
    fun `an unparseable start resolves to null rather than throwing`() {
        assertNull(resolveVisitWindow("not-a-date", "2026-08-07T15:00:00Z", ZoneOffset.UTC))
        assertNull(resolveVisitWindow("", "", ZoneOffset.UTC))
    }

    // ── utcDateRangeFor ───────────────────────────────────────────────────────

    @Test
    fun `pads the visit's day by one on each side`() {
        val (from, to) = utcDateRangeFor(
            BusyConflictWindow(Instant.parse("2026-08-07T14:00:00Z"), Instant.parse("2026-08-07T15:00:00Z")),
        )
        assertEquals("2026-08-06", from)
        assertEquals("2026-08-08", to)
    }

    // ── #1164: the refusal is worded in the business zone ───────────────────
    private val chicago = ZoneId.of("America/Chicago")
    // October: Chicago is CDT (UTC-5), so 19:00Z is 2:00 PM on the schedule.
    private fun at(iso: String) = Instant.parse(iso)
    @Test
    fun `#1164 words a same-day same-meridiem window in the business zone`() {
        assertEquals("Oct 5, 2:00-3:00 PM", formatBusyWindow(at("2026-10-05T19:00:00Z"), at("2026-10-05T20:00:00Z"), chicago))
    }
    @Test
    fun `#1164 keeps both meridiems when the window crosses noon`() {
        assertEquals("Oct 5, 11:00 AM-1:30 PM", formatBusyWindow(at("2026-10-05T16:00:00Z"), at("2026-10-05T18:30:00Z"), chicago))
    }
    @Test
    fun `#1164 names both days when the window crosses business midnight`() {
        // 03:00Z Oct 6 is 10:00 PM Oct 5 in Chicago.
        assertEquals(
            "Oct 5, 10:00 PM to Oct 6, 2:00 AM",
            formatBusyWindow(at("2026-10-06T03:00:00Z"), at("2026-10-06T07:00:00Z"), chicago),
        )
    }
    @Test
    fun `#1164 follows the zone it is given`() {
        assertEquals(
            "Oct 5, 3:00-4:00 PM",
            formatBusyWindow(at("2026-10-05T19:00:00Z"), at("2026-10-05T20:00:00Z"), ZoneId.of("America/New_York")),
        )
    }
    @Test
    fun `#1164 refusal text names the busy block at its business-zone clock, never UTC or a dash character`() {
        val d = decodeGoogleBusySlot(
            BookingTimeSlot(
                id = "gbi-1",
                date = "2026-10-05",
                startTime = "14:00",
                endTime = "15:00",
                source = TimeSlotSource.GOOGLE_BUSY_IMPORT,
                startMs = at("2026-10-05T19:00:00Z").toEpochMilli(),
                endMs = at("2026-10-05T20:00:00Z").toEpochMilli(),
            ),
        )!!
        val msg = busyConflictMessage(listOf(d), chicago)
        assertEquals("This time is not available: conflicts with a Google Calendar busy block (Oct 5, 2:00-3:00 PM).", msg)
        assertTrue(!msg.contains("UTC") && !msg.contains('\u2014') && !msg.contains('\u2013'))
    }
    @Test
    fun `#1164 joins every conflicting window`() {
        val a = DecodedBusySlot("a", at("2026-10-05T19:00:00Z"), at("2026-10-05T20:00:00Z"))
        val b = DecodedBusySlot("b", at("2026-10-06T14:00:00Z"), at("2026-10-06T15:30:00Z"))
        assertEquals(
            "This time is not available: conflicts with a Google Calendar busy block (Oct 5, 2:00-3:00 PM; Oct 6, 9:00-10:30 AM).",
            busyConflictMessage(listOf(a, b), chicago),
        )
    }
}
