package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Frosted glass container - translucent surface + 1px border + optional backdrop blur.
 * Wrap nav rails, modal cards, and floating dock with this.
 */
@Composable
fun GlassSurface(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
    backdropBlur: Dp = 0.dp,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    Box(
        modifier
            .clip(RoundedCornerShape(cornerRadius))
            .then(if (backdropBlur > 0.dp) Modifier.blur(backdropBlur) else Modifier)
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(cornerRadius)),
        content = { content() },
    )
}
