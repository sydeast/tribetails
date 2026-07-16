package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.ui.theme.AuntieTheme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*

@Composable
fun GlassSurface(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
    content: @Composable () -> Unit,
) {
    Box(
        modifier
            .clip(RoundedCornerShape(cornerRadius))
            .background(AuntieTheme.colors.surfaceGlass)
            .border(1.dp, AuntieTheme.colors.border, RoundedCornerShape(cornerRadius)),
        content = { content() },
    )
}
