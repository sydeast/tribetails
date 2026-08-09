package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Front-facing Google Calendar id setup. Contract: business_settings doc, field
 * `calendarSyncId` (matches web + the syncGoogleCalendarBusyEvents Cloud Function
 * which reads this field first, secret fallback second). The field must default
 * empty and survive a copy() round-trip, because the save path edits it with
 * `copy(calendarSyncId = ...)` and then diffs that copy against the document it
 * loaded (`BusinessSettingsDiff.kt`) - a value that did not survive the copy
 * would read as unchanged and never be written at all.
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
        // The stamps are written by the repository, never round-tripped from the
        // model, so a copy carrying them must still leave calendarSyncId alone.
        val saved = BusinessSettings()
            .copy(calendarSyncId = "cal-2@group.calendar.google.com")
            .copy(updatedAt = "2026-06-05T00:00:00Z", updatedBy = "admin")
        assertEquals("cal-2@group.calendar.google.com", saved.calendarSyncId)
        assertEquals("admin", saved.updatedBy)
    }

    /**
     * The one that matters for the save: setting the id diffs to that ONE field.
     * The Scheduling screen's calendar panel and the React admin's Calendar
     * section write the same document, and the phone used to send all ~46 fields.
     */
    @Test
    fun `setting the calendar id diffs to that field alone`() {
        val loaded = BusinessSettings(
            calendarSyncId = "",
            venmoHandle = "@old-venmo",
            businessName = "Tribe Tails",
        )
        val changes = businessSettingsFieldChanges(
            loaded,
            loaded.copy(calendarSyncId = "cal-3@group.calendar.google.com"),
        )
        assertEquals(
            mapOf<String, Any?>("calendarSyncId" to "cal-3@group.calendar.google.com"),
            changes,
        )
    }
}
