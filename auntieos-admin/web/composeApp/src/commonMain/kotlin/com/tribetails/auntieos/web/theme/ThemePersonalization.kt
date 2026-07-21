package com.tribetails.auntieos.web.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isUnspecified

/**
 * Phase 17.1 theme basics: the three per-operator personalization knobs beyond
 * dark/light mode. Each is a small closed set (not a free slider) so every
 * combination stays legible and layout-safe, and each persists to users/{uid}
 * exactly like [ThemeMode] (see SettingsPersistence + UserProfile). All three are
 * applied at the app root by [AuntieAppTheme].
 */

/** Accent color choice. Overrides [AuntieColors.accent] (teal-to-purple gradients,
 *  accent emphasis) with a brand-palette hue, brightened for dark mode. */
enum class AccentChoice(
    val key: String,
    val label: String,
    val light: Color,
    val dark: Color,
    // #9: gradient accent. Non-null -> this choice is a brand GRADIENT, rendered as a
    // Brush on the primary buttons + the picker swatch; null -> a solid hue. The lambda
    // pulls the brand gradient color list off the live [AuntieColors] (mode-correct).
    val gradient: ((AuntieColors) -> List<Color>)? = null,
) {
    TEAL("TEAL", "Teal", KinTeal, Color(0xFF1FA0B0)),
    ORANGE("ORANGE", "Orange", KinfolkOrange, Color(0xFFF09446)),
    PINK("PINK", "Pink", PackPink, Color(0xFFE07499)),
    PURPLE("PURPLE", "Purple", FamilyPurple, Color(0xFF8E6BA6)),
    CORAL("CORAL", "Coral", SnuggleCoral, Color(0xFFE76E75)),
    // Brand gradients (the signature element) as accent options.
    TRIBE("TRIBE", "Tribe", KinfolkOrange, Color(0xFFF09446), gradient = { it.tribeGradientColors }),
    SUNSET("SUNSET", "Sunset", KinfolkOrange, Color(0xFFF09446), gradient = { it.sunsetGlowColors }),
    OCEAN("OCEAN", "Ocean", KinTeal, Color(0xFF1FA0B0), gradient = { it.tealToPurpleColors });

    fun colorFor(isDark: Boolean): Color = if (isDark) dark else light

    /** Brand gradient colors for this choice (null for a solid hue). */
    fun gradientColors(colors: AuntieColors): List<Color>? = gradient?.invoke(colors)

    companion object {
        // #9: default is ORANGE = the shipped brand primary, so an unset profile keeps
        // the current look once the accent drives `primary` (see withAccent).
        val DEFAULT = ORANGE

        /** Parse a stored key, fail-safe to [DEFAULT] (matches parseThemeMode). */
        fun parse(stored: String?): AccentChoice =
            entries.firstOrNull { it.key.equals(stored?.trim(), ignoreCase = true) } ?: DEFAULT
    }
}

/** Spacing density. Scales the space tokens (not the structural rail/dock widths,
 *  which must stay fixed for layout). */
enum class DensityChoice(val key: String, val label: String, val scale: Float) {
    COMPACT("COMPACT", "Compact", 0.85f),
    NORMAL("NORMAL", "Normal", 1.0f),
    ROOMY("ROOMY", "Roomy", 1.15f);

    companion object {
        val DEFAULT = NORMAL
        fun parse(stored: String?): DensityChoice =
            entries.firstOrNull { it.key.equals(stored?.trim(), ignoreCase = true) } ?: DEFAULT
    }
}

/** Text scaling. Multiplies every type-style font size + line height. */
enum class FontScaleChoice(val key: String, val label: String, val scale: Float) {
    SMALL("SMALL", "Small", 0.9f),
    MEDIUM("MEDIUM", "Default", 1.0f),
    LARGE("LARGE", "Large", 1.15f);

    companion object {
        val DEFAULT = MEDIUM
        fun parse(stored: String?): FontScaleChoice =
            entries.firstOrNull { it.key.equals(stored?.trim(), ignoreCase = true) } ?: DEFAULT
    }
}

/** The personalization knobs bundled, so the app root + Settings thread one value.
 *  [themePreset] is the named staff-UI theme (see [AuntieThemePreset]); it sets the
 *  base color set, then [accent] overlays on top. DEFAULT preset = today's base. */
@Immutable
data class ThemePersonalization(
    val accent: AccentChoice = AccentChoice.DEFAULT,
    val density: DensityChoice = DensityChoice.DEFAULT,
    val fontScale: FontScaleChoice = FontScaleChoice.DEFAULT,
    val themePreset: AuntieThemePreset = AuntieThemePreset.DEFAULT_PRESET,
)

/**
 * A copy of these colors with [choice] applied (mode-correct via [AuntieColors.isDark]).
 * #9: the chosen hue drives the visible brand PRIMARY (buttons, links, selected states)
 * as well as the accent emphasis, so picking a color actually changes the look. With the
 * ORANGE default an unset profile keeps the shipped brand primary unchanged.
 */
fun AuntieColors.withAccent(choice: AccentChoice): AuntieColors {
    val grad = choice.gradientColors(this)
    return if (grad != null) {
        // Gradient accent: drive primary + accent from the gradient's lead hue so EVERY accent
        // surface shifts (headers, links, selected states, icons), not only the brush-aware
        // PrimaryButton. The brush is still exposed for components that render it. Before this,
        // a gradient choice only repainted the primary buttons and the rest of the UI kept the
        // base hue, so picking Ocean/Sunset/Tribe looked "stuck on orange".
        val lead = grad.firstOrNull() ?: choice.colorFor(isDark)
        copy(primary = lead, accent = lead, accentBrush = Brush.horizontalGradient(grad))
    } else {
        copy(primary = choice.colorFor(isDark), accent = choice.colorFor(isDark), accentBrush = null)
    }
}

/** A copy of these dimensions with the spacing tokens scaled by [choice]. Structural
 *  widths (side rail, bottom dock, max content) are intentionally left fixed. */
fun AuntieDimensions.scaled(choice: DensityChoice): AuntieDimensions {
    if (choice == DensityChoice.NORMAL) return this
    val s = choice.scale
    return copy(
        space1 = (space1.value * s).dp,
        space2 = (space2.value * s).dp,
        space3 = (space3.value * s).dp,
        space4 = (space4.value * s).dp,
        space5 = (space5.value * s).dp,
        space6 = (space6.value * s).dp,
        space8 = (space8.value * s).dp,
        space10 = (space10.value * s).dp,
        space12 = (space12.value * s).dp,
    )
}

/** A copy of this typography with every style's font size + line height scaled by [choice]. */
fun AuntieTypography.scaled(choice: FontScaleChoice): AuntieTypography {
    if (choice == FontScaleChoice.MEDIUM) return this
    val s = choice.scale
    fun TextStyle.x(): TextStyle = copy(
        fontSize = if (fontSize.isUnspecified) fontSize else fontSize * s,
        lineHeight = if (lineHeight.isUnspecified) lineHeight else lineHeight * s,
    )
    return copy(
        displayLarge = displayLarge.x(),
        displayMedium = displayMedium.x(),
        headlineLarge = headlineLarge.x(),
        headlineMedium = headlineMedium.x(),
        headlineSmall = headlineSmall.x(),
        titleLarge = titleLarge.x(),
        titleMedium = titleMedium.x(),
        titleSmall = titleSmall.x(),
        bodyLarge = bodyLarge.x(),
        bodyMedium = bodyMedium.x(),
        bodySmall = bodySmall.x(),
        labelLarge = labelLarge.x(),
        labelMedium = labelMedium.x(),
        labelSmall = labelSmall.x(),
        mono = mono.x(),
    )
}

// -----------------------------------------------------------------------------
// Theme warm-start cache (FOUC fix, 2026-06-09)
// -----------------------------------------------------------------------------
// The app paints before the Firestore users/{uid} profile (the authoritative theme
// source) loads, so a returning operator briefly saw the DEFAULT theme before their
// saved theme applied. We cache the resolved theme in a synchronous platform store
// (browser localStorage / JVM prefs) and seed the initial theme from it on boot, then
// reconcile with Firestore once it arrives. Firestore stays the source of truth.

/** Theme mode + personalization as one value, for the warm-start cache. */
data class CachedTheme(val mode: ThemeMode, val personalization: ThemePersonalization)

/** Serialize to a compact, parser-stable string: "MODE|ACCENT|DENSITY|FONT|PRESET".
 *  The trailing PRESET token is appended (not inserted) so an older 4-token cache still
 *  decodes — its missing preset just fails safe to the default. */
fun encodeThemeCache(mode: ThemeMode, p: ThemePersonalization): String =
    listOf(mode.name, p.accent.key, p.density.key, p.fontScale.key, p.themePreset.key).joinToString("|")

/** Parse the cache string. Returns null for blank/malformed/unknown-mode input (the
 *  caller falls back to defaults); unknown accent/density/font/preset tokens fail-safe to
 *  each enum's DEFAULT via its own parse(). A 4-token (pre-preset) cache decodes fine. */
fun decodeThemeCache(raw: String?): CachedTheme? {
    val parts = raw?.split("|") ?: return null
    if (parts.size < 4) return null
    val mode = ThemeMode.entries.firstOrNull { it.name.equals(parts[0].trim(), ignoreCase = true) }
        ?: return null
    return CachedTheme(
        mode = mode,
        personalization = ThemePersonalization(
            accent = AccentChoice.parse(parts[1]),
            density = DensityChoice.parse(parts[2]),
            fontScale = FontScaleChoice.parse(parts[3]),
            themePreset = AuntieThemePreset.parse(parts.getOrNull(4)),
        ),
    )
}

/** Synchronous platform-local store for the warm-start cache (localStorage on web,
 *  java.util.prefs on JVM/desktop). Never throws; returns null when absent. */
internal expect fun readThemeCache(): String?
internal expect fun writeThemeCache(value: String)
