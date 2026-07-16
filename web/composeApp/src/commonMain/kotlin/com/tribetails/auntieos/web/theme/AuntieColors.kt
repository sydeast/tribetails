package com.tribetails.auntieos.web.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * Tribe Tails brand palette.
 *
 *   Kinfolk Orange  #DF8431  PRIMARY - the anchor; CTAs, headers, brand emphasis
 *   Pack Pink       #D55C87  Secondary - playful highlight
 *   Kin Teal        #0A8595  Secondary/Accent - calming, trust elements
 *   Family Purple   #74538A  Tertiary - community / creative
 *   Snuggle Coral   #D5535A  Accent - comforting warmth
 *   Brand Cream     #FBFBF9  Background - clean, neutral
 *   Brand Navy      #11131F  Text - grounding
 *
 * Gradients are a signature element. See [tribeGradientColors] / [orangeToPinkColors]
 * etc. - never substitute solid fills where a brand gradient is called for.
 */
@Immutable
data class AuntieColors(
    val background:   Color,
    val surface:      Color,
    val surface2:     Color,
    val surfaceGlass: Color,
    val border:       Color,
    val borderSoft:   Color,
    // Brand
    val primary:      Color,   // Kinfolk Orange
    val primaryDim:   Color,
    val secondary:    Color,   // Pack Pink
    val accent:       Color,   // Kin Teal
    val tertiary:     Color,   // Family Purple
    val coral:        Color,   // Snuggle Coral
    // Text
    val textPrimary:  Color,   // Brand Navy on light, Cream on dark
    val textDim:      Color,
    val textFaint:    Color,
    // System
    val success:        Color,
    val warning:        Color,
    val error:          Color,
    val errorContainer: Color,
    val isDark:         Boolean,
    // #9: optional gradient accent (a brand gradient brush). Null = solid accent (the
    // default); set by withAccent when the operator picks a gradient accent choice.
    val accentBrush:    Brush? = null,
) {
    /** The Tribe Gradient - primary brand gradient (orange → pink → teal). */
    val tribeGradientColors: List<Color> get() = listOf(primary, secondary, accent)
    /** Orange → Pink: warm, playful. Service cards, hover states. */
    val orangeToPinkColors:  List<Color> get() = listOf(primary, secondary)
    /** Teal → Purple: calm, soulful. Section dividers, testimonials. */
    val tealToPurpleColors:  List<Color> get() = listOf(accent, tertiary)
    /** Sunset Glow: emotional, soulful. Heartfelt content. */
    val sunsetGlowColors:    List<Color> get() = listOf(primary, secondary, tertiary)
}

// ---- Brand constants ----
val KinfolkOrange = Color(0xFFDF8431)
val PackPink      = Color(0xFFD55C87)
val KinTeal       = Color(0xFF0A8595)
val FamilyPurple  = Color(0xFF74538A)
val SnuggleCoral  = Color(0xFFD5535A)
val BrandCream    = Color(0xFFFBFBF9)
val BrandNavy     = Color(0xFF11131F)

// ---- Light (default - cream + navy, playful and welcoming) ----
val LightAuntieColors = AuntieColors(
    background   = BrandCream,
    surface      = Color(0xFFF4F2EC),
    surface2     = Color(0xFFEAE6DC),
    surfaceGlass = Color(0xCCF8F6F0),
    border       = Color(0xFFD8D1C2),
    borderSoft   = Color(0xFFE7E2D5),
    primary      = KinfolkOrange,
    primaryDim   = Color(0xFFB36724),
    secondary    = PackPink,
    accent       = KinTeal,
    tertiary     = FamilyPurple,
    coral        = SnuggleCoral,
    textPrimary  = BrandNavy,
    textDim      = Color(0xFF5A5860),
    textFaint    = Color(0xFF9A98A2),
    success        = Color(0xFF2E7D52),
    warning        = Color(0xFFC77D1A),
    error          = SnuggleCoral,
    errorContainer = Color(0x33D5535A),
    isDark         = false,
)

// ---- Dark (deep-navy base, NOT pure black; cream text) ----
val DarkAuntieColors = AuntieColors(
    background   = BrandNavy,
    surface      = Color(0xFF1B1D2B),
    surface2     = Color(0xFF252736),
    surfaceGlass = Color(0x991B1D2B),
    border       = Color(0xFF353748),
    borderSoft   = Color(0xFF2A2C3C),
    primary      = Color(0xFFF09446),     // brighter orange for dark contrast
    primaryDim   = KinfolkOrange,
    secondary    = Color(0xFFE07499),     // brighter pink
    accent       = Color(0xFF1FA0B0),     // brighter teal
    tertiary     = Color(0xFF8E6BA6),     // brighter purple
    coral        = Color(0xFFE76E75),
    textPrimary  = BrandCream,
    textDim      = Color(0xFFA8A4B2),
    textFaint    = Color(0xFF65626E),
    success        = Color(0xFF4CAF7D),
    warning        = Color(0xFFFFB458),
    error          = Color(0xFFE76E75),
    errorContainer = Color(0x33E76E75),
    isDark         = true,
)
