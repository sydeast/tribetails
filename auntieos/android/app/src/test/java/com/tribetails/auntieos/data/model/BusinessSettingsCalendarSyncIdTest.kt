package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Front-facing Google Calendar id setup. Contract: business_settings doc, field
 * `calendarSyncId` (matches web + the syncGoogleCalendarBusyEvents Cloud Function
 * which reads this field first, secret fallback second). The field must default
 * empty and survive a copy() round-trip so it persists through the AuntieRepository
 * save path (saveBusinessSettings copies on top, then set()s the doc).
 */
class BusinessSettingsCalendarSyncIdTest {

    @Test
    fun `default calendarSyncId is empty`() {
        assertEquals("", BusinessSettings().calendarSyncId)
    }

    @Test
    fun `copy with calendarSyncId round-trips the value`() {
        val id = "team@group.calendar.google.com"
        val s = BusinessSettings().copy(calendarSyncId = id)
        assertEquals(id, s.calendarSyncId)
    }

    @Test
    fun `copy with calendarSyncId does not disturb other fields`() {
        val s = BusinessSettings().copy(calendarSyncId = "cal-1@group.calendar.google.com")
        assertTrue("enableGPSTrackingForAllVisits untouched", s.enableGPSTrackingForAllVisits)
        assertEquals("specialHours untouched", emptyList<String>(), s.specialHours)
    }

    @Test
    fun `save-path copy preserves calendarSyncId alongside audit stamps`() {
        // Mirrors AuntieRepository.saveBusinessSettings: it copies updatedAt/updatedBy
        // on top of the caller's settings, so calendarSyncId must survive that copy.
        val saved = BusinessSettings()
            .copy(calendarSyncId = "cal-2@group.calendar.google.com")
            .copy(updatedAt = "2026-06-05T00:00:00Z", updatedBy = "admin")
        assertEquals("cal-2@group.calendar.google.com", saved.calendarSyncId)
        assertEquals("admin", saved.updatedBy)
    }
}
