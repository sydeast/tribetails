package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Thin horizontal progress bar with the Tribe Gradient fill.
 *
 * Two modes:
 *   - Determinate   ([progress] != null): fills 0f..1f of the track, animated.
 *   - Indeterminate ([progress] == null): a gradient sweep glides left-to-right
 *     on a loop. Use this when you cannot estimate completion. Never a spinner.
 *
 * The empty track uses surface2; the fill defaults to the brand gradient
 * (orange to pink to teal). Pass [brush] to override (e.g. orangeToPink for
 * service cards, tealToPurple for calm sections).
 */
@Composable
fun AuntieProgressBar(
    modifier: Modifier = Modifier,
    progress: Float? = null,
    height: Dp = 6.dp,
    brush: Brush? = null,
) {
    val c = AuntieTheme.colors
    val fillBrush = brush ?: Brush.linearGradient(c.tribeGradientColors)

    if (progress == null) {
        // Indeterminate: a gradient segment that loops across the track.
        val transition = rememberInfiniteTransition(label = "indeterminateProgress")
        // Sweep travels from off-screen-left (-0.5) to off-screen-right (1.5) of
        // the track width, so leading and trailing edges glide fully out of view.
        val sweep by transition.animateFloat(
            initialValue  = -0.5f,
            targetValue   = 1.5f,
            animationSpec = infiniteRepeatable(
                animation  = tween(durationMillis = 1200, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "indeterminateSweep",
        )

        Box(
            modifier
                .fillMaxWidth()
                .height(height)
                .clip(RoundedCornerShape(height))
                .drawBehind {
                    drawRoundRect(
                        color        = c.surface2,
                        cornerRadius = CornerRadius(size.height / 2f),
                    )
                    val segmentWidth = size.width * 0.35f
                    drawRoundRect(
                        brush        = fillBrush,
                        topLeft      = Offset(sweep * size.width, 0f),
                        size         = Size(segmentWidth, size.height),
                        cornerRadius = CornerRadius(size.height / 2f),
                    )
                },
        )
    } else {
        // Determinate: fill animates toward the target fraction.
        val animatedFraction by animateFloatAsState(
            targetValue   = progress.coerceIn(0f, 1f),
            animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
            label         = "progressFraction",
        )

        Box(
            modifier
                .fillMaxWidth()
                .height(height)
                .clip(RoundedCornerShape(height))
                .drawBehind {
                    drawRoundRect(
                        color        = c.surface2,
                        cornerRadius = CornerRadius(size.height / 2f),
                    )
                    val filledWidth = size.width * animatedFraction
                    if (filledWidth > 0f) {
                        drawRoundRect(
                            brush        = fillBrush,
                            size         = Size(filledWidth, size.height),
                            cornerRadius = CornerRadius(size.height / 2f),
                        )
                    }
                },
        )
    }
}
