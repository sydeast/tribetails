package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.ui.theme.AuntieTheme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*

/**
 * The panel surface, and the Android twin of `.den-panel` in the web kit.
 *
 * A GRADIENT, not a tint (#751, operator ruling 2026-09-11). Every mock under
 * `auntieos-admin/ui-ideas/` draws a panel as one navy falling to a lighter navy
 * at half alpha, running top left to bottom right, over a hairline. The flat
 * `surfaceGlass` fill this used to take is what made a panel read as a card laid
 * on the screen rather than as glass cut out of it, and it is also what hid the
 * mesh ground behind it: a nearly opaque fill over a mesh is just a rectangle.
 *
 * The two stops are the existing `surface` and `surface2` roles rather than new
 * colour fields, so both schemes get the gradient with nothing further to keep
 * in step, and the alpha on the lower stop is what lets the mesh through.
 */
@Composable
fun GlassSurface(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    Box(
        modifier
            .clip(RoundedCornerShape(cornerRadius))
            .background(
                Brush.linearGradient(
                    colors = listOf(c.surface, c.surface2.copy(alpha = 0.5f)),
                    start = Offset.Zero,
                    end = Offset.Infinite,
                ),
            )
            .border(1.dp, c.border, RoundedCornerShape(cornerRadius)),
        content = { content() },
    )
}
