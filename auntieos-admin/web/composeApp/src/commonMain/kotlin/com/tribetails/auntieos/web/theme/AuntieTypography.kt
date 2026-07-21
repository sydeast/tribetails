package com.tribetails.auntieos.web.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

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

val DefaultAuntieTypography = AuntieTypography(
    displayLarge   = TextStyle(fontWeight = FontWeight.Bold,     fontSize = 34.sp, letterSpacing = (-0.5).sp),
    displayMedium  = TextStyle(fontWeight = FontWeight.Bold,     fontSize = 30.sp, letterSpacing = (-0.4).sp),
    headlineLarge  = TextStyle(fontWeight = FontWeight.Bold,     fontSize = 26.sp, letterSpacing = (-0.3).sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    headlineSmall  = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleLarge     = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
    titleMedium    = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp),
    titleSmall     = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 13.sp),
    bodyLarge      = TextStyle(fontWeight = FontWeight.Normal,   fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium     = TextStyle(fontWeight = FontWeight.Normal,   fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall      = TextStyle(fontWeight = FontWeight.Normal,   fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge     = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 0.4.sp),
    labelMedium    = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 0.5.sp),
    labelSmall     = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.6.sp),
    mono           = TextStyle(fontWeight = FontWeight.Normal,   fontSize = 13.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
)
