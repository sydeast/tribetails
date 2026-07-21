package com.tribetails.auntieos.web.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Immutable
data class AuntieDimensions(
    val borderHairline: Dp = 1.dp,
    val borderEmphasis: Dp = 1.5.dp,
    val space1:  Dp = 4.dp,
    val space2:  Dp = 8.dp,
    val space3:  Dp = 12.dp,
    val space4:  Dp = 16.dp,
    val space5:  Dp = 20.dp,
    val space6:  Dp = 24.dp,
    val space8:  Dp = 32.dp,
    val space10: Dp = 40.dp,
    val space12: Dp = 48.dp,
    val sideRailWidth: Dp = 240.dp,
    val bottomDockHeight: Dp = 72.dp,
    val maxContentWidth: Dp = 1280.dp,
)

val DefaultAuntieDimensions = AuntieDimensions()
