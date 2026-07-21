package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun AuntieSpinner(
    modifier: Modifier = Modifier,
    color: Color = AuntieTheme.colors.primary,
    strokeWidth: Dp = 2.5.dp,
) {
    val transition = rememberInfiniteTransition(label = "spinner")
    val angle by transition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(
            animation  = tween(800, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "spinAngle",
    )
    Canvas(modifier = modifier) {
        val sw = strokeWidth.toPx()
        val r  = (size.minDimension - sw) / 2f
        val cx = size.width / 2f
        val cy = size.height / 2f
        // Track
        drawArc(
            color       = color.copy(alpha = 0.2f),
            startAngle  = 0f,
            sweepAngle  = 360f,
            useCenter   = false,
            topLeft     = Offset(cx - r, cy - r),
            size        = Size(r * 2, r * 2),
            style       = Stroke(width = sw, cap = StrokeCap.Round),
        )
        // Arc
        drawArc(
            color       = color,
            startAngle  = angle,
            sweepAngle  = 240f,
            useCenter   = false,
            topLeft     = Offset(cx - r, cy - r),
            size        = Size(r * 2, r * 2),
            style       = Stroke(width = sw, cap = StrokeCap.Round),
        )
    }
}
