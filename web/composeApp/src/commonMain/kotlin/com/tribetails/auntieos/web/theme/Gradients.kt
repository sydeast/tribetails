package com.tribetails.auntieos.web.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush

/**
 * Brand-signature gradient brushes. Use these on hero areas, primary CTAs, and
 * decorative borders - never as a default screen background (per brand:
 * "Don't place gradients behind long paragraphs").
 */
object TribeGradients {

    /** 135° diagonal - Kinfolk Orange → Pack Pink → Kin Teal. The primary mark. */
    @Composable @ReadOnlyComposable
    fun tribe(): Brush = Brush.linearGradient(
        colors = AuntieTheme.colors.tribeGradientColors,
        start  = Offset(0f, 0f),
        end    = Offset(1000f, 1000f),
    )

    /** Bottom-right diagonal - orange → pink. Card hovers, service tiles. */
    @Composable @ReadOnlyComposable
    fun orangeToPink(): Brush = Brush.linearGradient(
        colors = AuntieTheme.colors.orangeToPinkColors,
        start  = Offset(0f, 0f),
        end    = Offset(1000f, 1000f),
    )

    /** Bottom-right diagonal - teal → purple. Section dividers, testimonials. */
    @Composable @ReadOnlyComposable
    fun tealToPurple(): Brush = Brush.linearGradient(
        colors = AuntieTheme.colors.tealToPurpleColors,
        start  = Offset(0f, 0f),
        end    = Offset(1000f, 1000f),
    )

    /** 90° horizontal rainbow - celebration, decorative borders. */
    @Composable @ReadOnlyComposable
    fun rainbowAccent(): Brush = Brush.horizontalGradient(
        colors = AuntieTheme.colors.tribeGradientColors,
    )
}
