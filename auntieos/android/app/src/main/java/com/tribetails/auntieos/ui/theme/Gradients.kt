package com.tribetails.auntieos.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush

object TribeGradients {
    @Composable @ReadOnlyComposable
    fun tribe(): Brush = Brush.linearGradient(
        colors = AuntieTheme.colors.tribeGradientColors,
        start  = Offset(0f, 0f),
        end    = Offset(1000f, 1000f),
    )

    @Composable @ReadOnlyComposable
    fun orangeToPink(): Brush = Brush.linearGradient(
        colors = AuntieTheme.colors.orangeToPinkColors,
        start  = Offset(0f, 0f),
        end    = Offset(1000f, 1000f),
    )

    @Composable @ReadOnlyComposable
    fun tealToPurple(): Brush = Brush.linearGradient(
        colors = AuntieTheme.colors.tealToPurpleColors,
        start  = Offset(0f, 0f),
        end    = Offset(1000f, 1000f),
    )

    @Composable @ReadOnlyComposable
    fun rainbowAccent(): Brush = Brush.horizontalGradient(
        colors = AuntieTheme.colors.tribeGradientColors,
    )
}
