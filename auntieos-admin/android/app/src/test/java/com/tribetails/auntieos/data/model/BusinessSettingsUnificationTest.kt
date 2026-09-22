package com.tribetails.auntieos.data.model

import com.tribetails.auntieos.domain.resolveTimeBlock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Settings unification (2026-06-05): the former AdminSettings doc was collapsed
 * into the unified BusinessSettings model on business_settings/business_settings.
 * These pure-JVM tests prove the full union round-trips through copy(), that the
 * canonical defaults match the design doc, and that the scheduling time-block
 * resolver reads timeBlocks from BusinessSettings (not the old AdminSettings doc).
 *
 * See docs/2026-06-05-settings-unification-design.md.
 */
class BusinessSettingsUnificationTest {

    @Test
    fun `canonical defaults match the design doc`() {
        val s = BusinessSettings()

        // Business profile.
        assertEquals("", s.businessName)
        assertEquals("", s.businessEmail)
        assertEquals("", s.businessPhone)
        assertEquals("", s.businessAddress)
        assertEquals("America/New_York", s.timeZone)
        assertTrue(s.serviceRates.isEmpty())
        assertTrue(s.businessHours.isEmpty())

        // Booking / scheduling config (migrated from admin_settings).
        assertEquals("SPECIFIC_TIME", s.defaultBookingMode)
        assertEquals("MONTH", s.defaultCalendarView)
        assertTrue(s.allowTimeBlockBooking)
        assertTrue(s.allowSpecificTimeBooking)
        assertTrue(s.enableConflictDetection)
        // ISSUE #519 flipped this from false. `kincareReminderCron` has always
        // enqueued the 24-hour reminder for every confirmed booking, so `false`
        // never described the shipped behavior; the cron reads the field now and
        // treats an absent key as ON. The design doc's `false` is the stale side.
        assertTrue(s.enableAutoReminder24h)
        assertFalse(s.observeUsHolidays)
        assertEquals(4, s.defaultTimeBlockDurationHours)
        assertEquals(30, s.travelBufferMinutes)

        // timeBlocks: midday 11:00-15:00 active.
        assertEquals(1, s.timeBlocks.size)
        assertEquals("midday", s.timeBlocks.first().id)
        assertEquals("11:00", s.timeBlocks.first().startTime)
        assertEquals("15:00", s.timeBlocks.first().endTime)
        assertTrue(s.timeBlocks.first().isActive)

        // GPS / tracking.
        assertTrue(s.enableGPSTrackingForAllVisits)
        assertEquals(TrackingAccuracy.HIGH, s.trackingAccuracy)
        assertEquals(90, s.saveRoutesForDays)

        // Visit ETA / drafts.
        assertEquals(15, s.defaultEtaMinutes)
        assertEquals(listOf(5, 10, 15, 20, 30, 45, 60), s.etaMinuteOptions)
        assertEquals(30, s.draftRetentionDays)

        // Calendar + meta.
        assertEquals("", s.calendarSyncId)

        // Notification schedule. The shipped state is OFF and UNSCHEDULED, by
        // operator ruling 2026-09-22: no job runs until it is switched on from
        // the settings screen, and the cadence is decided then. A default of 9
        // here would start the invoice crons at an hour nobody picked.
        assertFalse(s.householdNotificationsLive)
        assertNull(s.householdNotificationHour)
        assertNull(s.scheduleDigestHour)
    }

    @Test
    fun `full union round-trips through copy`() {
        val original = BusinessSettings(
            businessName = "Tribe Tails Pet Care",
            businessEmail = "hello@tribetails.com",
            businessPhone = "555-0100",
            businessAddress = "1 Bark Lane",
            timeZone = "America/Chicago",
            serviceRates = mapOf("dog_walk" to "25"),
            businessHours = mapOf("monday" to "09:00-17:00"),
            enableGPSTrackingForAllVisits = false,
            trackingAccuracy = TrackingAccuracy.LOW,
            saveRoutesForDays = 120,
            defaultEtaMinutes = 20,
            draftRetentionDays = 60,
            observedUsHolidays = listOf("new_years"),
            companyHolidays = listOf("2026-07-04|Founder's Day"),
            specialHours = listOf("2026-12-24|09:00-12:00"),
            observeUsHolidays = true,
            defaultBookingMode = "TIME_BLOCK",
            defaultCalendarView = "WEEK",
            allowTimeBlockBooking = false,
            allowSpecificTimeBooking = false,
            enableConflictDetection = false,
            enableAutoReminder24h = true,
            defaultTimeBlockDurationHours = 6,
            travelBufferMinutes = 45,
            timeBlocks = listOf(
                TimeBlockDefinition(id = "morning", label = "Morning", startTime = "08:00", endTime = "11:00", isActive = true),
                TimeBlockDefinition(id = "evening", label = "Evening", startTime = "17:00", endTime = "21:00", isActive = false),
            ),
            calendarSyncId = "team-cal@group.calendar.google.com",
        )

        // copy() preserves every field of the union (no field dropped on edit).
        val copied = original.copy(defaultEtaMinutes = 99)

        assertEquals("Tribe Tails Pet Care", copied.businessName)
        assertEquals("America/Chicago", copied.timeZone)
        assertEquals(mapOf("dog_walk" to "25"), copied.serviceRates)
        assertEquals(mapOf("monday" to "09:00-17:00"), copied.businessHours)
        assertEquals("TIME_BLOCK", copied.defaultBookingMode)
        assertEquals("WEEK", copied.defaultCalendarView)
        assertFalse(copied.allowTimeBlockBooking)
        assertTrue(copied.enableAutoReminder24h)
        assertTrue(copied.observeUsHolidays)
        assertEquals(6, copied.defaultTimeBlockDurationHours)
        assertEquals(45, copied.travelBufferMinutes)
        assertEquals(2, copied.timeBlocks.size)
        assertEquals(listOf("2026-12-24|09:00-12:00"), copied.specialHours)
        assertEquals("team-cal@group.calendar.google.com", copied.calendarSyncId)
        assertEquals(TrackingAccuracy.LOW, copied.trackingAccuracy)
        assertEquals(99, copied.defaultEtaMinutes)
    }

    @Test
    fun `defaultBookingMode wire string maps to and from BookingMode`() {
        assertEquals(BookingMode.SPECIFIC_TIME, BusinessSettings().defaultBookingModeEnum)
        assertEquals(
            BookingMode.TIME_BLOCK,
            BusinessSettings(defaultBookingMode = "TIME_BLOCK").defaultBookingModeEnum,
        )
        // withBookingMode writes the enum name as the wire string.
        assertEquals("TIME_BLOCK", BusinessSettings().withBookingMode(BookingMode.TIME_BLOCK).defaultBookingMode)
        // Unknown wire strings fall back to SPECIFIC_TIME, never throw.
        assertEquals(
            BookingMode.SPECIFIC_TIME,
            BusinessSettings(defaultBookingMode = "garbage").defaultBookingModeEnum,
        )
    }

    @Test
    fun `scheduling resolver reads time blocks from BusinessSettings`() {
        val settings = BusinessSettings(
            timeBlocks = listOf(
                TimeBlockDefinition(id = "morning", label = "Morning", startTime = "08:00", endTime = "11:00"),
                TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00"),
            ),
        )

        // The booking-core resolver now sources its blocks from the unified
        // BusinessSettings.timeBlocks (was AdminSettings.timeBlocks pre-unify).
        assertEquals("Morning", resolveTimeBlock("09:30", settings.timeBlocks)?.label)
        assertEquals("Midday", resolveTimeBlock("11:00", settings.timeBlocks)?.label)
    }
}
