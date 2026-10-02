package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.model.businessZone
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.TimeZone

/**
 * #1150: the wizard books the BUSINESS's wall clock, whatever zone the phone is in.
 *
 * The phone here is in Los Angeles and the business in Chicago, two hours ahead.
 * The server reads every visit instant in the business zone, so picking 9:00 has
 * to send 9:00 Chicago, and the wizard's own warnings have to read that instant
 * back as the 9:00 the operator typed.
 */
class BookingWizardBusinessZoneTest {

    private val chicago: ZoneId = ZoneId.of("America/Chicago")
    private val losAngeles: ZoneId = ZoneId.of("America/Los_Angeles")
    private val monday = LocalDate.of(2027, 8, 2)
    private lateinit var original: TimeZone

    @Before
    fun phoneInLosAngeles() {
        original = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone(losAngeles))
    }

    @After
    fun restoreZone() {
        TimeZone.setDefault(original)
    }

    private fun ms(date: LocalDate, hour: Int, zone: ZoneId): Long =
        ZonedDateTime.of(date.atTime(hour, 0), zone).toInstant().toEpochMilli()

    private fun state(zone: ZoneId = chicago): BookingWizardState =
        BookingWizardState(kinfolkId = "kf1", zone = zone).withServiceName("Dog Walking")

    @Test
    fun `a wizard with no settings yet is in America Chicago, never the phone zone`() {
        assertEquals(chicago, BookingWizardState().zone)
        assertEquals(chicago, businessZone(""))
    }

    @Test
    fun `picking 9 00 sends the epoch of 9 00 Chicago`() {
        val visit = buildVisits(state().toggleDate(monday)).single()
        assertEquals(ms(monday, 9, chicago), visit.startTimeMs)
        assertNotEquals(ms(monday, 9, losAngeles), visit.startTimeMs)
    }

    @Test
    fun `a weekly recurrence sends 9 00 Chicago on every occurrence`() {
        val weekly = state().copy(mode = BookingWizardMode.WEEKLY, startDate = monday, weeks = 2)
            .toggleWeekday(1)
        assertEquals(
            listOf(ms(monday, 9, chicago), ms(monday.plusWeeks(1), 9, chicago)),
            buildVisits(weekly).map { it.startTimeMs },
        )
    }

    @Test
    fun `follows the zone Settings names`() {
        val newYork = ZoneId.of("America/New_York")
        val visit = buildVisits(state(newYork).toggleDate(monday)).single()
        assertEquals(ms(monday, 9, newYork), visit.startTimeMs)
    }

    @Test
    fun `the warnings read back the clock the operator typed`() {
        // Open 8:00 to 17:00. Read in the phone's zone, the 9:00 visit would be
        // 7:00 and warned as outside hours; the business's 18:00 would be 16:00
        // and pass. Read in the business zone, only the 18:00 one is outside.
        val hours = (1..5).map { BusinessHours(dayOfWeek = it, openTime = "08:00", closeTime = "17:00", isOpen = true) }
        var s = state().toggleDate(monday).addDayVisit(monday)
        val second = s.plans.single().visits[1]
        s = s.updateDayVisit(monday, second.id) { it.copy(hour = 18, minute = 0) }
        val warnings = bookingSelectionWarnings(buildVisits(s), BookingAvailability(businessHours = hours), s.zone)
        assertEquals(listOf("Aug 2 at 6:00 PM: outside business hours (8:00 AM to 5:00 PM)."), warnings)
    }
}
