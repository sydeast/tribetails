package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 0A, Settings persistence pure helpers: theme persistence (UserProfile.themeMode)
 * and the Business-hours / Notifications dirty + save plumbing. These are the
 * logic units the Compose panels call; the UI wiring is thin over them.
 */
class SettingsPersistenceTest {

    // ---- parseThemeMode (stored string -> enum, fail-safe to default) ----

    @Test fun `parseThemeMode reads each canonical value`() {
        assertEquals(ThemeMode.LIGHT,  parseThemeMode("LIGHT"))
        assertEquals(ThemeMode.DARK,   parseThemeMode("DARK"))
        assertEquals(ThemeMode.SYSTEM, parseThemeMode("SYSTEM"))
    }

    @Test fun `parseThemeMode is case-insensitive`() {
        assertEquals(ThemeMode.LIGHT, parseThemeMode("light"))
        assertEquals(ThemeMode.SYSTEM, parseThemeMode("System"))
    }

    @Test fun `parseThemeMode falls back to default for blank`() {
        // Legacy docs have no themeMode field; preserve the shipped default (DARK).
        assertEquals(ThemeMode.DARK, parseThemeMode(""))
    }

    @Test fun `parseThemeMode falls back to default for garbage`() {
        assertEquals(ThemeMode.DARK, parseThemeMode("purple"))
    }

    // ---- ThemeMode.stored (enum -> string round-trip) ----

    @Test fun `stored round-trips through parseThemeMode`() {
        for (mode in ThemeMode.entries) {
            assertEquals(mode, parseThemeMode(mode.stored))
        }
    }

    // ---- hydratedTheme (profile -> effective theme at load) ----

    @Test fun `hydratedTheme uses fallback when profile is null`() {
        assertEquals(ThemeMode.LIGHT, hydratedTheme(null, fallback = ThemeMode.LIGHT))
    }

    @Test fun `hydratedTheme uses fallback when profile has no saved theme`() {
        val profile = UserProfile(uid = "u1")
        assertEquals(ThemeMode.DARK, hydratedTheme(profile, fallback = ThemeMode.DARK))
    }

    @Test fun `hydratedTheme reads the saved theme when present`() {
        val profile = UserProfile(uid = "u1", themeMode = "LIGHT")
        assertEquals(ThemeMode.LIGHT, hydratedTheme(profile, fallback = ThemeMode.DARK))
    }

    // ---- withTheme (write the chosen theme onto the profile to save) ----

    @Test fun `withTheme stamps the stored string and preserves other fields`() {
        val profile = UserProfile(uid = "u1", firstName = "B", themeMode = "DARK")
        val updated = profile.withTheme(ThemeMode.LIGHT)
        assertEquals("LIGHT", updated.themeMode)
        assertEquals("u1", updated.uid)
        assertEquals("B", updated.firstName)
    }

    // ---- businessSettingsDirty (Save-bar enablement for business hours) ----

    private val loaded = BusinessSettings(
        _id = "biz",
        businessHours = mapOf("monday" to "08:00-17:00"),
        notificationEmail = true,
        notificationSms = true,
        notificationPush = true,
    )

    @Test fun `not dirty when edits equal loaded`() {
        assertFalse(
            businessSettingsDirty(loaded, hours = mapOf("monday" to "08:00-17:00"))
        )
    }

    @Test fun `dirty when business hours change`() {
        assertTrue(
            businessSettingsDirty(loaded, hours = mapOf("monday" to "09:00-17:00"))
        )
    }

    // ---- editedBusinessSettings (the doc the Save bar persists) ----

    @Test fun `editedBusinessSettings overlays the hours edit and preserves untouched fields`() {
        val base = loaded.copy(businessName = "TribeTails", serviceRates = mapOf("Walk" to "25"))
        val edited = editedBusinessSettings(base, hours = mapOf("tuesday" to "10:00-14:00"))
        assertEquals(mapOf("tuesday" to "10:00-14:00"), edited.businessHours)
        // The coarse notification fields are no longer edited here; copy() preserves them.
        assertTrue(edited.notificationEmail)
        assertEquals("TribeTails", edited.businessName)
        assertEquals(mapOf("Walk" to "25"), edited.serviceRates)
    }

    @Test fun `editedBusinessSettings result is not dirty against itself`() {
        val edited = editedBusinessSettings(loaded, hours = mapOf("wednesday" to "07:00-12:00"))
        assertFalse(businessSettingsDirty(edited, edited.businessHours))
    }

    // ---- calendarSyncIdDirty (Save-bar enablement for the Google Calendar id) ----

    @Test fun `calendarSyncIdDirty is false when edited equals loaded`() {
        val s = BusinessSettings(calendarSyncId = "cal@group.calendar.google.com")
        assertFalse(calendarSyncIdDirty(s, "cal@group.calendar.google.com"))
    }

    @Test fun `calendarSyncIdDirty ignores surrounding whitespace`() {
        val s = BusinessSettings(calendarSyncId = "cal@group.calendar.google.com")
        assertFalse(calendarSyncIdDirty(s, "  cal@group.calendar.google.com  "))
    }

    @Test fun `calendarSyncIdDirty is true when edited differs`() {
        val s = BusinessSettings(calendarSyncId = "old@group.calendar.google.com")
        assertTrue(calendarSyncIdDirty(s, "new@group.calendar.google.com"))
    }

    @Test fun `calendarSyncIdDirty treats null doc as empty stored id`() {
        assertFalse(calendarSyncIdDirty(null, ""))
        assertTrue(calendarSyncIdDirty(null, "cal@group.calendar.google.com"))
    }
}
