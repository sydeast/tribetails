package com.tribetails.auntieos.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isUnspecified

/**
 * Phase 17.1 theme basics: the three per-operator personalization knobs beyond
 * dark/light mode. Mirror of the AuntieOS web ThemePersonalization so both apps
 * read identical keys from users/{uid}. Each is a small closed set (not a free
 * slider) so every combination stays legible, and each persists to users/{uid}
 * like ThemeMode. All three are applied at the activity root by [AuntieOSTheme].
 */

/** Accent color choice. Overrides [AuntieColors.accent] with a brand-palette hue,
 *  brightened for dark mode. */
enum class AccentChoice(
    val key: String,
    val label: String,
    val light: Color,
    val dark: Color,
    // #9: gradient accent. Non-null -> brand GRADIENT (Brush on primary buttons + swatch);
    // null -> a solid hue. Mirrors web.
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
        fun parse(stored: String?): AccentChoice =
            entries.firstOrNull { it.key.equals(stored?.trim(), ignoreCase = true) } ?: DEFAULT
    }
}

/** Spacing density. Scales the space tokens (not structural widths). */
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

/** The three knobs bundled, so the activity root + Settings thread one value. */
@Immutable
data class ThemePersonalization(
    val accent: AccentChoice = AccentChoice.DEFAULT,
    val density: DensityChoice = DensityChoice.DEFAULT,
    val fontScale: FontScaleChoice = FontScaleChoice.DEFAULT,
)

/**
 * A copy of these colors with [choice] applied (mode-correct via isDark). #9: the chosen
 * hue drives the visible brand PRIMARY (buttons, selected states) as well as the accent
 * emphasis, so picking a color actually changes the look. With the ORANGE default an
 * unset profile keeps the shipped brand primary unchanged.
 */
fun AuntieColors.withAccent(choice: AccentChoice): AuntieColors {
    val grad = choice.gradientColors(this)
    return if (grad != null) {
        // Gradient accent: drive primary + accent from the gradient's lead hue so EVERY accent
        // surface shifts (headers, selected states, icons), not only the brush-aware
        // PrimaryButton. The brush is still exposed for components that render it. Before this,
        // a gradient choice only repainted the primary buttons and the rest of the UI kept the
        // base hue, so picking Ocean/Sunset/Tribe looked "stuck on orange".
        val lead = grad.firstOrNull() ?: choice.colorFor(isDark)
        copy(primary = lead, accent = lead, accentBrush = Brush.horizontalGradient(grad))
    } else {
        copy(primary = choice.colorFor(isDark), accent = choice.colorFor(isDark), accentBrush = null)
    }
}

/** A copy of these dimensions with the spacing tokens scaled by [choice]. The
 *  structural maxContentWidth / bottomDockHeight are intentionally left fixed. */
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

/** A copy of this typography with every style's font size + line height scaled. */
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
