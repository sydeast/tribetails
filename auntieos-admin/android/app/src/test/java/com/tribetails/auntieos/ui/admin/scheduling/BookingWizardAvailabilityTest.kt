package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.repository.NewBookingVisit
import com.tribetails.auntieos.ui.admin.parseClosureEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/** D1: how the Dates step reads a day, and which visits earn a warning. */
class BookingWizardAvailabilityTest {

    private val zone: ZoneId = ZoneId.of("America/New_York")
    private val monday = LocalDate.of(2027, 8, 2)
    private val tuesday = LocalDate.of(2027, 8, 3)
    private val independenceDay = LocalDate.of(2027, 7, 4)

    private fun slot(date: String, start: String, end: String) = BookingTimeSlot(
        id = "slot-$date-$start",
        date = date,
        startTime = start,
        endTime = end,
        isAvailable = false,
    )

    private fun visitAt(date: LocalDate, hour: Int, minute: Int = 0) = NewBookingVisit(
        startTimeMs = date.atTime(hour, minute).atZone(zone).toInstant().toEpochMilli(),
        serviceName = "Dog Walking",
    )

    private val weekdayHours = (1..7).map {
        BusinessHours(id = "$it", dayOfWeek = it, isOpen = it <= 5, openTime = "09:00", closeTime = "17:00")
    }

    // -----------------------------------------------------------------------
    // Closures
    // -----------------------------------------------------------------------

    @Test
    fun `a once closure closes only its own day`() {
        val availability = BookingAvailability(
            closures = listOf(parseClosureEntry("2027-08-02|Founders Day")),
        )
        assertEquals("Founders Day", availability.closedDayName(monday))
        assertNull(availability.closedDayName(tuesday))
    }

    @Test
    fun `a yearly closure closes its day in whatever year is asked about`() {
        val availability = BookingAvailability(
            closures = listOf(parseClosureEntry("yearly:07-04|Independence Day")),
        )
        assertEquals("Independence Day", availability.closedDayName(independenceDay))
        assertEquals("Independence Day", availability.closedDayName(independenceDay.plusYears(3)))
        assertNull(availability.closedDayName(independenceDay.plusDays(1)))
    }

    @Test
    fun `a closure with a blank name still closes, under the generic name`() {
        val availability = BookingAvailability(closures = listOf(parseClosureEntry("2027-08-02|")))
        assertEquals("a company holiday", availability.closedDayName(monday))
    }

    @Test
    fun `no closures configured closes nothing`() {
        assertNull(BookingAvailability().closedDayName(monday))
    }

    // -----------------------------------------------------------------------
    // Day badges
    // -----------------------------------------------------------------------

    @Test
    fun `a closed day is unpickable and a busy day is not`() {
        val availability = BookingAvailability(
            closures = listOf(parseClosureEntry("2027-08-02|Founders Day")),
            blockedByDate = mapOf("2027-08-03" to listOf(slot("2027-08-03", "08:00", "12:00"))),
        )
        val closed = availability.dayAvailability(monday, today = LocalDate.of(2027, 1, 1))
        assertEquals(BookingDayBadge.CLOSED, closed.badge)
        assertFalse("the server refuses a closure with no override", closed.pickable)
        assertEquals("Aug 2, closed for Founders Day, not available", closed.description)

        val busy = availability.dayAvailability(tuesday, today = LocalDate.of(2027, 1, 1))
        assertEquals(BookingDayBadge.BLOCKED, busy.badge)
        assertTrue("a busy block is overridable, so the operator may still pick it", busy.pickable)
        assertEquals(listOf("8:00 AM to 12:00 PM"), busy.blockedWindows)
    }

    @Test
    fun `a past day is unpickable and outranks every other badge`() {
        val availability = BookingAvailability(
            closures = listOf(parseClosureEntry("2027-08-02|Founders Day")),
        )
        val past = availability.dayAvailability(monday, today = monday.plusDays(1))
        assertEquals(BookingDayBadge.PAST, past.badge)
        assertFalse(past.pickable)
    }

    @Test
    fun `today itself is still pickable`() {
        val today = BookingAvailability().dayAvailability(monday, today = monday)
        assertEquals(BookingDayBadge.NONE, today.badge)
        assertTrue(today.pickable)
    }

    // -----------------------------------------------------------------------
    // Warnings, per visit
    // -----------------------------------------------------------------------

    @Test
    fun `a visit inside an imported busy window is warned about`() {
        val availability = BookingAvailability(
            blockedByDate = mapOf("2027-08-02" to listOf(slot("2027-08-02", "08:00", "12:00"))),
        )
        assertEquals(
            listOf("Aug 2 at 10:00 AM: blocked time from 8:00 AM to 12:00 PM."),
            bookingSelectionWarnings(listOf(visitAt(monday, 10)), availability, zone),
        )
    }

    @Test
    fun `a visit just past the end of a busy window is not warned about`() {
        val availability = BookingAvailability(
            blockedByDate = mapOf("2027-08-02" to listOf(slot("2027-08-02", "08:00", "12:00"))),
        )
        // The window is half-open, so noon is clear.
        assertEquals(emptyList<String>(), bookingSelectionWarnings(listOf(visitAt(monday, 12)), availability, zone))
    }

    @Test
    fun `warnings never name a day-and-time pair that is not a real visit`() {
        // Aug 2 at 10:00 (fine) and Aug 3 at 19:00 (after hours). Web computes the
        // cross product of every day against every distinct time and tells the
        // operator "Aug 2: 19:00 is outside business hours" for a visit that does
        // not exist. Per-visit reasoning cannot produce that line.
        val availability = BookingAvailability(businessHours = weekdayHours)
        val warnings = bookingSelectionWarnings(
            listOf(visitAt(monday, 10), visitAt(tuesday, 19)),
            availability,
            zone,
        )
        assertEquals(listOf("Aug 3 at 7:00 PM: outside business hours (9:00 AM to 5:00 PM)."), warnings)
        assertTrue(warnings.none { it.startsWith("Aug 2") })
    }

    @Test
    fun `a visit on a day the business does not open is warned about`() {
        val saturday = LocalDate.of(2027, 8, 7)
        val warnings = bookingSelectionWarnings(
            listOf(visitAt(saturday, 10)),
            BookingAvailability(businessHours = weekdayHours),
            zone,
        )
        assertEquals(listOf("Aug 7: the business is closed that day."), warnings)
    }

    @Test
    fun `a day the business_hours rows say nothing about earns no warning`() {
        assertEquals(
            emptyList<String>(),
            bookingSelectionWarnings(listOf(visitAt(monday, 22)), BookingAvailability(), zone),
        )
    }

    @Test
    fun `an unparseable busy window stays silent rather than fabricating a clash`() {
        val availability = BookingAvailability(
            blockedByDate = mapOf("2027-08-02" to listOf(slot("2027-08-02", "oops", ""))),
        )
        assertEquals(emptyList<String>(), bookingSelectionWarnings(listOf(visitAt(monday, 10)), availability, zone))
    }

    @Test
    fun `duplicate warnings collapse and a long list is capped with a count`() {
        val availability = BookingAvailability(businessHours = weekdayHours)
        // Two visits at the same after-hours minute on the same day: one line.
        assertEquals(
            1,
            bookingSelectionWarnings(listOf(visitAt(monday, 19), visitAt(monday, 19)), availability, zone).size,
        )

        // Eight distinct after-hours days: six lines plus the tail.
        val many = (0..7).map { visitAt(monday.plusDays(it.toLong()), 19) }
        val warnings = bookingSelectionWarnings(many, availability, zone)
        assertEquals(7, warnings.size)
        assertTrue(warnings.last().endsWith("more."))
    }

    @Test
    fun `no visits means no warnings`() {
        assertEquals(
            emptyList<String>(),
            bookingSelectionWarnings(emptyList(), BookingAvailability(businessHours = weekdayHours), zone),
        )
    }

    // -----------------------------------------------------------------------
    // Formatting
    // -----------------------------------------------------------------------

    @Test
    fun `clock formatting handles both midnights and both noons`() {
        assertEquals("12:00 AM", formatClock(0, 0))
        assertEquals("12:30 PM", formatClock(12, 30))
        assertEquals("1:05 PM", formatClock(13, 5))
        assertEquals("11:59 PM", formatClock(23, 59))
    }

    @Test
    fun `a window with an unparseable end falls back to the raw strings`() {
        assertEquals("08:00 to whenever", formatWindow("08:00", "whenever"))
    }

    @Test
    fun `date formatting is locale-stable`() {
        assertEquals("Aug 2", formatShortDate(monday))
        assertEquals("Mon, Aug 2", formatDayAndDate(monday))
    }
}
