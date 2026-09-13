package com.kinfolk.portal.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkTheme

/**
 * REDUCED MOTION SLOWS THIS RING. IT DOES NOT STOP IT.
 *
 * `animationsEnabled()` is false when the user has turned Animator duration
 * scale off, or switched on "Remove animations" -- Android's answer to the
 * web's `prefers-reduced-motion: reduce`. That setting asks for no large,
 * vestibular or distracting motion. A 36dp ring turning once every 2.4 seconds
 * is none of those, and an indicator that has stopped indicating is the worse
 * outcome, because a frozen ring cannot be told apart from a hung screen --
 * which is the exact reading the 2026-09-12 ruling exists to prevent.
 *
 * The sweep is narrowed rather than slowed as well: two animations at once read
 * as a pulse, and one moving part is enough to say "still working". The same
 * correction was made on the web side of both apps, where a global
 * `animation: none !important` had been freezing every spinner outright.
 */
private const val SPIN_MS = 900
private const val SPIN_MS_REDUCED = 2400

@Composable
fun KinSpinner(
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
) {
    val c = KinfolkTheme.colors
    val primary = c.primary
    val full = animationsEnabled()
    val transition = rememberInfiniteTransition(label = "spinner")
    val rotation by transition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(
            tween(if (full) SPIN_MS else SPIN_MS_REDUCED, easing = LinearEasing),
        ),
        label         = "rotation",
    )
    val sweep by transition.animateFloat(
        initialValue  = if (full) 30f else 200f,
        targetValue   = 270f,
        animationSpec = infiniteRepeatable(tween(700, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label         = "sweep",
    )

    Canvas(modifier = modifier.size(size)) {
        val stroke = Stroke(width = this.size.width * 0.08f, cap = StrokeCap.Round)
        val inset  = stroke.width / 2f
        val arcSize = Size(this.size.width - stroke.width, this.size.height - stroke.width)
        // background track
        drawArc(
            color       = primary.copy(alpha = 0.15f),
            startAngle  = 0f,
            sweepAngle  = 360f,
            useCenter   = false,
            topLeft     = Offset(inset, inset),
            size        = arcSize,
            style       = Stroke(width = stroke.width * 0.5f),
        )
        // sweeping arc
        drawArc(
            color       = primary,
            startAngle  = rotation,
            sweepAngle  = sweep,
            useCenter   = false,
            topLeft     = Offset(inset, inset),
            size        = arcSize,
            style       = stroke,
        )
    }
}
