package com.tribetails.auntieos.ui.theme

import com.tribetails.auntieos.ui.theme.AuntieTheme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * Tribe Tails brand palette. Mirror of web AuntieColors - single source of truth
 * for any color used in app UI. Do not pull from MaterialTheme.colorScheme directly
 * inside screens; use AuntieTheme.colors.X instead so light/dark + future re-skin
 * happens in one place.
 */
@Immutable
data class AuntieColors(
    val background:     Color,
    val surface:        Color,
    val surface2:       Color,
    val surfaceGlass:   Color,
    val border:         Color,
    val borderSoft:     Color,
    val primary:        Color,
    val primaryDim:     Color,
    val secondary:      Color,
    val accent:         Color,
    val tertiary:       Color,
    val coral:          Color,
    val textPrimary:    Color,
    val textDim:        Color,
    val textFaint:      Color,
    val success:        Color,
    val warning:        Color,
    val error:          Color,
    val errorContainer: Color,
    val isDark:         Boolean,
    // #9: optional gradient accent (a brand gradient brush). Null = solid accent (default);
    // set by withAccent when the operator picks a gradient accent. Mirrors web.
    val accentBrush:    Brush? = null,
) {
    val tribeGradientColors: List<Color> get() = listOf(primary, secondary, accent)
    val orangeToPinkColors:  List<Color> get() = listOf(primary, secondary)
    val tealToPurpleColors:  List<Color> get() = listOf(accent, tertiary)
    val sunsetGlowColors:    List<Color> get() = listOf(primary, secondary, tertiary)

    // Brand-named accessors - prefer these in screens. Theme-aware (light/dark
    // brightness automatically resolved via the current AuntieColors instance).
    val kinfolkOrange: Color get() = primary
    val packPink:      Color get() = secondary
    val kinTeal:       Color get() = accent
    val familyPurple:  Color get() = tertiary
    val snuggleCoral:  Color get() = coral
}

// ── Brand constants (shared across light/dark - matches web) ──
val KinfolkOrange = Color(0xFFDF8431)
val PackPink      = Color(0xFFD55C87)
val KinTeal       = Color(0xFF0A8595)
val FamilyPurple  = Color(0xFF74538A)
val SnuggleCoral  = Color(0xFFD5535A)
val BrandCream    = Color(0xFFFBFBF9)
val BrandNavy     = Color(0xFF11131F)

val LightAuntieColors = AuntieColors(
    background     = BrandCream,
    surface        = Color(0xFFF4F2EC),
    surface2       = Color(0xFFEAE6DC),
    surfaceGlass   = Color(0xCCF8F6F0),
    border         = Color(0xFFD8D1C2),
    borderSoft     = Color(0xFFE7E2D5),
    primary        = KinfolkOrange,
    primaryDim     = Color(0xFFB36724),
    secondary      = PackPink,
    accent         = KinTeal,
    tertiary       = FamilyPurple,
    coral          = SnuggleCoral,
    textPrimary    = BrandNavy,
    textDim        = Color(0xFF5A5860),
    textFaint      = Color(0xFF9A98A2),
    success        = Color(0xFF2E7D52),
    warning        = Color(0xFFC77D1A),
    error          = SnuggleCoral,
    errorContainer = Color(0x33D5535A),
    isDark         = false,
)

val DarkAuntieColors = AuntieColors(
    background     = BrandNavy,
    surface        = Color(0xFF1B1D2B),
    surface2       = Color(0xFF252736),
    surfaceGlass   = Color(0x991B1D2B),
    border         = Color(0xFF353748),
    borderSoft     = Color(0xFF2A2C3C),
    primary        = Color(0xFFF09446),
    primaryDim     = KinfolkOrange,
    secondary      = Color(0xFFE07499),
    accent         = Color(0xFF1FA0B0),
    tertiary       = Color(0xFF8E6BA6),
    coral          = Color(0xFFE76E75),
    textPrimary    = BrandCream,
    textDim        = Color(0xFFA8A4B2),
    textFaint      = Color(0xFF65626E),
    success        = Color(0xFF4CAF7D),
    warning        = Color(0xFFFFB458),
    error          = Color(0xFFE76E75),
    errorContainer = Color(0x33E76E75),
    isDark         = true,
)

// Legacy single-name aliases (Gold/Secondary/Background/Surface/...) removed
// PM-15. Brand constants above (KinfolkOrange/PackPink/etc.) and theme-aware
// accessors AuntieTheme.colors.kinfolkOrange/packPink/kinTeal/familyPurple/
// snuggleCoral are the only sanctioned color references in screens.

// Static brand-list helpers (use AuntieTheme.colors.tribeGradientColors etc.
// for theme-aware versions).
val TribeGradientColors get() = listOf(KinfolkOrange, PackPink, KinTeal)
val OrangeToPinkColors  get() = listOf(KinfolkOrange, PackPink)
val TealToPurpleColors  get() = listOf(KinTeal, FamilyPurple)
val SunsetGlowColors    get() = listOf(KinfolkOrange, PackPink, FamilyPurple)
