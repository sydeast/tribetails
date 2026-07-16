package com.tribetails.auntieos.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.R

@Immutable
data class AuntieTypography(
    val displayLarge:   TextStyle,
    val displayMedium:  TextStyle,
    val headlineLarge:  TextStyle,
    val headlineMedium: TextStyle,
    val headlineSmall:  TextStyle,
    val titleLarge:     TextStyle,
    val titleMedium:    TextStyle,
    val titleSmall:     TextStyle,
    val bodyLarge:      TextStyle,
    val bodyMedium:     TextStyle,
    val bodySmall:      TextStyle,
    val labelLarge:     TextStyle,
    val labelMedium:    TextStyle,
    val labelSmall:     TextStyle,
    val mono:           TextStyle,
)

// Den redesign type families, bundled as static TTFs in res/font. Mirrors the
// web wiring (theme/AuntieFonts.kt) so both apps render identical faces.
//  - Fraunces        : editorial serif for display / headline / large titles
//  - Hanken Grotesk  : UI + body text, smaller titles, most labels
//  - Spline Sans Mono: monospace + the uppercase tracked kicker labels
private val Fraunces = FontFamily(
    Font(R.font.fraunces_light,    FontWeight.Light),
    Font(R.font.fraunces_regular,  FontWeight.Normal),
    Font(R.font.fraunces_medium,   FontWeight.Medium),
    Font(R.font.fraunces_semibold, FontWeight.SemiBold),
)
private val Hanken = FontFamily(
    Font(R.font.hanken_light,    FontWeight.Light),
    Font(R.font.hanken_regular,  FontWeight.Normal),
    Font(R.font.hanken_medium,   FontWeight.Medium),
    Font(R.font.hanken_semibold, FontWeight.SemiBold),
    Font(R.font.hanken_bold,     FontWeight.Bold),
)
private val SplineMono = FontFamily(
    Font(R.font.spline_mono_regular,  FontWeight.Normal),
    Font(R.font.spline_mono_medium,   FontWeight.Medium),
    Font(R.font.spline_mono_semibold, FontWeight.SemiBold),
)

// Fraunces reads best at lighter editorial weights than the default sans bolds,
// so the display / headline tier is eased down to Normal / Medium.
val DefaultAuntieTypography = AuntieTypography(
    displayLarge   = TextStyle(fontFamily = Fraunces, fontWeight = FontWeight.Normal,   fontSize = 34.sp, letterSpacing = (-0.5).sp),
    displayMedium  = TextStyle(fontFamily = Fraunces, fontWeight = FontWeight.Normal,   fontSize = 30.sp, letterSpacing = (-0.4).sp),
    headlineLarge  = TextStyle(fontFamily = Fraunces, fontWeight = FontWeight.Normal,   fontSize = 26.sp, letterSpacing = (-0.3).sp),
    headlineMedium = TextStyle(fontFamily = Fraunces, fontWeight = FontWeight.Medium,   fontSize = 20.sp),
    headlineSmall  = TextStyle(fontFamily = Fraunces, fontWeight = FontWeight.Medium,   fontSize = 18.sp),
    titleLarge     = TextStyle(fontFamily = Fraunces, fontWeight = FontWeight.Medium,   fontSize = 17.sp),
    titleMedium    = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.SemiBold, fontSize = 15.sp),
    titleSmall     = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.SemiBold, fontSize = 13.sp),
    bodyLarge      = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.Normal,   fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium     = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.Normal,   fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall      = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.Normal,   fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge     = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 0.4.sp),
    labelMedium    = TextStyle(fontFamily = Hanken,   fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 0.5.sp),
    labelSmall     = TextStyle(fontFamily = SplineMono, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.6.sp),
    mono           = TextStyle(fontFamily = SplineMono, fontWeight = FontWeight.Normal, fontSize = 13.sp),
)
