package com.tribetails.auntieos.ui.theme

import com.tribetails.auntieos.data.model.UserProfile
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 0A, Android parity for the shared per-operator theme contract (UserProfile.themeMode).
 * Mirrors the web SettingsPersistence helpers so a theme set on one platform resolves the
 * same way here.
 */
class ThemePrefsTest {

    @Test fun parseThemeMode_reads_canonical_values() {
        assertEquals(ThemeMode.LIGHT, parseThemeMode("LIGHT"))
        assertEquals(ThemeMode.DARK, parseThemeMode("DARK"))
        assertEquals(ThemeMode.SYSTEM, parseThemeMode("SYSTEM"))
    }

    @Test fun parseThemeMode_is_case_insensitive() {
        assertEquals(ThemeMode.LIGHT, parseThemeMode("light"))
    }

    @Test fun parseThemeMode_falls_back_to_default_for_blank_or_garbage() {
        assertEquals(DEFAULT_THEME_MODE, parseThemeMode(""))
        assertEquals(DEFAULT_THEME_MODE, parseThemeMode("purple"))
    }

    @Test fun stored_round_trips() {
        for (mode in ThemeMode.entries) {
            assertEquals(mode, parseThemeMode(mode.stored))
        }
    }

    @Test fun hydratedTheme_uses_fallback_when_no_saved_theme() {
        assertEquals(ThemeMode.LIGHT, hydratedTheme(UserProfile(uid = "u1"), ThemeMode.LIGHT))
    }

    @Test fun hydratedTheme_reads_saved_theme() {
        assertEquals(ThemeMode.LIGHT, hydratedTheme(UserProfile(uid = "u1", themeMode = "LIGHT"), ThemeMode.DARK))
    }

    @Test fun withTheme_stamps_stored_and_preserves_other_fields() {
        val updated = UserProfile(uid = "u1", firstName = "B").withTheme(ThemeMode.DARK)
        assertEquals("DARK", updated.themeMode)
        assertEquals("u1", updated.uid)
        assertEquals("B", updated.firstName)
    }

    @Test fun userProfile_defaults_themeMode_blank() {
        assertEquals("", UserProfile().themeMode)
    }
}
