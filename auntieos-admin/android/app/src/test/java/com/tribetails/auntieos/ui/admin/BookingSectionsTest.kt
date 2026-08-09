package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.EnhancedBooking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Android half of the Bookings status sections (spec 15 items 1 to 4, and
 * the mock's `Pending approval` / `Scheduled` / `History` headings, each with a
 * live count).
 *
 * The screen rendered these three blocks before this test existed; what did not
 * exist was anything pinning WHICH bucket a status lands in. That classification
 * was four `remember { filter { ... } }` expressions inside a composable, so the
 * only way to catch a booking falling between them was to look at a phone. It is
 * one pure function now, and this is what holds it: the twin of
 * `groupBookingsByStatus` in `src/screens/Bookings.test.tsx`, asserting the same
 * contract so the two platforms cannot answer the question differently.
 */
class BookingSectionsTest {

    private fun booking(
        id: String,
        status: BookingStatus,
        start: String = "2026-08-01T09:00:00",
    ) = EnhancedBooking(id = id, status = status, startDateTime = start)

    @Test fun `orders sections pending, scheduled, history regardless of input order`() {
        val sections = groupBookingsByStatus(
            listOf(
                booking("c", BookingStatus.COMPLETED),
                booking("d", BookingStatus.DRAFT),
                booking("a", BookingStatus.ACCEPTED),
                booking("r", BookingStatus.REJECTED),
            )
        )
        assertEquals(
            listOf(BookingSectionKey.PENDING, BookingSectionKey.SCHEDULED, BookingSectionKey.HISTORY),
            sections.map { it.key },
        )
        assertEquals(listOf("d"), sections.section(BookingSectionKey.PENDING).rows.map { it.id })
        assertEquals(listOf("a"), sections.section(BookingSectionKey.SCHEDULED).rows.map { it.id })
    }

    @Test fun `keeps an empty section so the screen can say nothing is waiting`() {
        val sections = groupBookingsByStatus(listOf(booking("c", BookingStatus.COMPLETED)))
        val pending = sections.section(BookingSectionKey.PENDING)
        assertEquals("Pending approval", pending.label)
        assertEquals(emptyList<EnhancedBooking>(), pending.rows)
    }

    @Test fun `an empty input still returns all three headings`() {
        val sections = groupBookingsByStatus(emptyList())
        assertEquals(3, sections.size)
        assertEquals(listOf("Pending approval", "Scheduled", "History"), sections.map { it.label })
        assertEquals(0, sections.sumOf { it.rows.size })
    }

    @Test fun `completed and cancelled share the one History section`() {
        val sections = groupBookingsByStatus(
            listOf(
                booking("done", BookingStatus.COMPLETED, "2026-08-01T09:00:00"),
                booking("called-off", BookingStatus.REJECTED, "2026-08-03T09:00:00"),
            )
        )
        // Most recent first: History is a record, so the newest outcome reads first.
        assertEquals(
            listOf("called-off", "done"),
            sections.section(BookingSectionKey.HISTORY).rows.map { it.id },
        )
    }

    @Test fun `Scheduled reads soonest first, because it is a to-do list`() {
        val sections = groupBookingsByStatus(
            listOf(
                booking("later", BookingStatus.ACCEPTED, "2026-08-09T09:00:00"),
                booking("sooner", BookingStatus.ACCEPTED, "2026-08-02T09:00:00"),
            )
        )
        assertEquals(
            listOf("sooner", "later"),
            sections.section(BookingSectionKey.SCHEDULED).rows.map { it.id },
        )
    }

    @Test fun `every status lands in exactly one section, so no booking can vanish`() {
        // The guarantee the four inline filters never stated. If a fifth
        // BookingStatus is ever added and not named in groupBookingsByStatus,
        // this fails rather than letting those bookings render nowhere.
        val all = BookingStatus.entries.mapIndexed { i, s -> booking("b$i", s) }
        val sections = groupBookingsByStatus(all)
        assertEquals(all.size, sections.sumOf { it.rows.size })
        assertEquals(
            all.map { it.id }.toSet(),
            sections.flatMap { section -> section.rows.map { it.id } }.toSet(),
        )
    }

    @Test fun `the section counts are the numbers the stat cards report`() {
        val sections = groupBookingsByStatus(
            listOf(
                booking("d1", BookingStatus.DRAFT),
                booking("a1", BookingStatus.ACCEPTED),
                booking("a2", BookingStatus.ACCEPTED),
                booking("c1", BookingStatus.COMPLETED),
                booking("r1", BookingStatus.REJECTED),
                booking("r2", BookingStatus.REJECTED),
            )
        )
        assertEquals(1, sections.section(BookingSectionKey.PENDING).rows.size)
        assertEquals(2, sections.section(BookingSectionKey.SCHEDULED).rows.size)
        assertEquals(3, sections.section(BookingSectionKey.HISTORY).rows.size)
    }
}
