package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.theme.AccentChoice
import com.tribetails.auntieos.web.theme.AuntieThemePreset
import com.tribetails.auntieos.web.theme.DensityChoice
import com.tribetails.auntieos.web.theme.FontScaleChoice
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization

/**
 * 0A, pure persistence helpers for Settings.
 *
 * Theme: [parseThemeMode] / [ThemeMode.stored] / [hydratedTheme] / [withTheme] move the
 * operator's theme between the [UserProfile.themeMode] string and the [ThemeMode] enum so
 * the chosen theme is written on change and rehydrated on load (survives refresh).
 *
 * Business settings: [businessSettingsDirty] / [editedBusinessSettings] back the dedicated
 * Save bar on the Business-hours panel so those edits reach saveBusinessSettings instead
 * of being silently lost on refresh. (The old coarse Email/SMS/Push notification box was
 * removed; the per-notification gate matrix persists itself, so this is hours-only now.)
 */

/** Shipped default when no theme is stored (preserves prior hardcoded behavior). */
val DEFAULT_THEME_MODE: ThemeMode = ThemeMode.DARK

/** Parse a stored theme string to the enum, fail-safe to [DEFAULT_THEME_MODE]. */
fun parseThemeMode(stored: String): ThemeMode =
    ThemeMode.entries.firstOrNull { it.name.equals(stored.trim(), ignoreCase = true) }
        ?: DEFAULT_THEME_MODE

/** Canonical stored string for a theme mode (round-trips with [parseThemeMode]). */
val ThemeMode.stored: String get() = name

/** Effective theme at load: the profile's saved theme, else [fallback]. */
fun hydratedTheme(profile: UserProfile?, fallback: ThemeMode = DEFAULT_THEME_MODE): ThemeMode {
    val saved = profile?.themeMode?.takeIf { it.isNotBlank() } ?: return fallback
    return parseThemeMode(saved)
}

/** Profile copy carrying the chosen theme, ready for saveUserProfile. */
fun UserProfile.withTheme(mode: ThemeMode): UserProfile = copy(themeMode = mode.stored)

// ---- 17.1 personalization (accent / density / font scale) ----

/** The saved personalization at load: each field parsed fail-safe to its default. */
fun hydratedPersonalization(profile: UserProfile?): ThemePersonalization = ThemePersonalization(
    accent = AccentChoice.parse(profile?.accentColor),
    density = DensityChoice.parse(profile?.density),
    fontScale = FontScaleChoice.parse(profile?.fontScale),
    themePreset = AuntieThemePreset.parse(profile?.themePreset),
)

/** Profile copies carrying each chosen knob, ready for saveUserProfile. */
fun UserProfile.withAccent(accent: AccentChoice): UserProfile = copy(accentColor = accent.key)
fun UserProfile.withDensity(density: DensityChoice): UserProfile = copy(density = density.key)
fun UserProfile.withFontScale(scale: FontScaleChoice): UserProfile = copy(fontScale = scale.key)
fun UserProfile.withThemePreset(preset: AuntieThemePreset): UserProfile = copy(themePreset = preset.key)

/** True when the business-hours edits differ from the loaded settings (Save-bar enablement). */
fun businessSettingsDirty(
    loaded: BusinessSettings,
    hours: Map<String, String>,
): Boolean =
    loaded.businessHours != hours

/** The settings doc the Save bar persists: loaded with the business-hours edits overlaid. */
fun editedBusinessSettings(
    loaded: BusinessSettings,
    hours: Map<String, String>,
): BusinessSettings = loaded.copy(
    businessHours = hours,
)
