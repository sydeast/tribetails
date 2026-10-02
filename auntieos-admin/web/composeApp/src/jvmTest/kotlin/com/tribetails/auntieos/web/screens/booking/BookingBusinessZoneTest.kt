package com.tribetails.auntieos.web.screens.booking

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * #1150: the desktop New booking form books the BUSINESS's wall clock, whatever
 * zone the machine is in. The machine here is in Los Angeles and the business in
 * Chicago, two hours ahead; picking 9:00 has to send 9:00 Chicago, because the
 * server reads every visit instant in the business zone.
 *
 * JVM-only because moving the machine's zone is `java.util.TimeZone.setDefault`,
 * which is also what kotlinx `TimeZone.currentSystemDefault()` reads here.
 */
class BookingBusinessZoneTest {

    private lateinit var original: java.util.TimeZone

    @BeforeTest
    fun machineInLosAngeles() {
        original = java.util.TimeZone.getDefault()
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"))
    }

    @AfterTest
    fun restoreZone() {
        java.util.TimeZone.setDefault(original)
    }

    private fun nine(date: String, zone: String): Long =
        ZonedDateTime.of(LocalDate.parse(date).atTime(9, 0), ZoneId.of(zone)).toInstant().toEpochMilli()

    @Test
    fun picking_9_00_sends_the_epoch_of_9_00_chicago() {
        val zone = NewBookingMath.businessTimeZone("America/Chicago")
        val ms = buildStartTimesMs(BookingRepeat.MULTI, "2027-08-02", listOf("2027-08-04"), "09:00", emptySet(), 4, zone)
        assertEquals(listOf(nine("2027-08-02", "America/Chicago"), nine("2027-08-04", "America/Chicago")), ms)
        assertNotEquals(nine("2027-08-02", "America/Los_Angeles"), ms.first())
    }

    @Test
    fun a_weekly_recurrence_sends_9_00_chicago_on_every_occurrence() {
        val zone = NewBookingMath.businessTimeZone("America/Chicago")
        val ms = buildStartTimesMs(BookingRepeat.WEEKLY, "2027-08-02", emptyList(), "09:00", setOf(1), 2, zone)
        assertEquals(listOf(nine("2027-08-02", "America/Chicago"), nine("2027-08-09", "America/Chicago")), ms)
    }

    @Test
    fun a_blank_or_unusable_zone_is_america_chicago_never_the_machine() {
        assertEquals("America/Chicago", NewBookingMath.businessTimeZone("").id)
        assertEquals("America/Chicago", NewBookingMath.businessTimeZone(null).id)
        assertEquals("America/Chicago", NewBookingMath.businessTimeZone("Mars/Olympus_Mons").id)
        assertEquals("America/New_York", NewBookingMath.businessTimeZone("America/New_York").id)
    }
}
