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

@Composable
fun KinSpinner(
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
) {
    val c = KinfolkTheme.colors
    val primary = c.primary
    val transition = rememberInfiniteTransition(label = "spinner")
    val rotation by transition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing)),
        label         = "rotation",
    )
    val sweep by transition.animateFloat(
        initialValue  = 30f,
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
