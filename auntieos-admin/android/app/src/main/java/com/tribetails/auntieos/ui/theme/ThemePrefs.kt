package com.tribetails.auntieos.ui.theme

import com.tribetails.auntieos.data.model.UserProfile

/**
 * 0A, Android parity for the shared per-operator theme contract. Mirrors the web
 * `SettingsPersistence` helpers so a theme written on users/{uid} by any platform
 * resolves identically here. DataStore stays the boot cache; UserProfile.themeMode is
 * the durable cross-device source reconciled on login + written on change.
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
)

/** Profile copies carrying each chosen knob, ready for saveUserProfile. */
fun UserProfile.withAccent(accent: AccentChoice): UserProfile = copy(accentColor = accent.key)
fun UserProfile.withDensity(density: DensityChoice): UserProfile = copy(density = density.key)
fun UserProfile.withFontScale(scale: FontScaleChoice): UserProfile = copy(fontScale = scale.key)
