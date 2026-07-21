package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlin.math.roundToInt

@Composable
fun AuntieSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    trackHeight: Dp = 4.dp,
    thumbRadius: Dp = 10.dp,
    trackBrush: Brush = Brush.linearGradient(AuntieTheme.colors.orangeToPinkColors),
    enabled: Boolean = true,
    label: String? = null,
    valueLabel: String? = null,
) {
    val c = AuntieTheme.colors
    var trackWidthPx by remember { mutableFloatStateOf(0f) }
    val thumbRadiusPx = with(androidx.compose.ui.platform.LocalDensity.current) { thumbRadius.toPx() }
    val trackHeightPx = with(androidx.compose.ui.platform.LocalDensity.current) { trackHeight.toPx() }

    fun norm(v: Float) = ((v - valueRange.start) / (valueRange.endInclusive - valueRange.start)).coerceIn(0f, 1f)
    fun denorm(n: Float) = valueRange.start + n * (valueRange.endInclusive - valueRange.start)

    var isDragging by remember { mutableStateOf(false) }
    val thumbScale by animateFloatAsState(
        targetValue   = if (isDragging) 1.25f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label         = "thumbScale",
    )

    val draggableState = rememberDraggableState { delta ->
        if (trackWidthPx > 0f) {
            val newNorm = (norm(value) + delta / trackWidthPx).coerceIn(0f, 1f)
            val snapped = if (steps > 0) {
                val step = 1f / steps
                (newNorm / step).roundToInt() * step
            } else newNorm
            onValueChange(denorm(snapped))
        }
    }

    Column(modifier = modifier) {
        if (label != null || valueLabel != null) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                if (label != null) Text(label, style = AuntieTheme.typography.labelSmall, color = c.textDim)
                if (valueLabel != null) Text(valueLabel, style = AuntieTheme.typography.labelSmall, color = c.primary)
            }
            Spacer(Modifier.height(8.dp))
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(thumbRadius * 2)
                .onSizeChanged { trackWidthPx = it.width.toFloat() },
            contentAlignment = Alignment.CenterStart,
        ) {
            // Track
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(trackHeight)
                    .align(Alignment.Center)
                    .clip(RoundedCornerShape(trackHeight))
                    .drawBehind {
                        // Empty track
                        drawRoundRect(
                            color        = c.surface2,
                            cornerRadius = CornerRadius(size.height / 2),
                        )
                        // Filled portion
                        val filledWidth = size.width * norm(value)
                        if (filledWidth > 0f) {
                            drawRoundRect(
                                brush        = trackBrush,
                                size         = Size(filledWidth, size.height),
                                cornerRadius = CornerRadius(size.height / 2),
                            )
                        }
                        // Step ticks
                        if (steps > 0) {
                            repeat(steps - 1) { i ->
                                val x = size.width * ((i + 1).toFloat() / steps)
                                drawCircle(
                                    color  = c.background.copy(alpha = 0.7f),
                                    radius = trackHeightPx / 2f,
                                    center = Offset(x, size.height / 2f),
                                )
                            }
                        }
                    },
            )

            // Thumb
            val thumbOffsetPx = (trackWidthPx * norm(value)).roundToInt()
            Box(
                modifier = Modifier
                    .offset { IntOffset(x = thumbOffsetPx - thumbRadius.roundToPx(), y = 0) }
                    .size(thumbRadius * 2)
                    .drawBehind {
                        val r = size.minDimension / 2f
                        drawCircle(color = c.background, radius = r)
                        drawCircle(
                            brush  = trackBrush,
                            radius = r,
                            style  = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.5.dp.toPx()),
                        )
                    }
                    .then(
                        Modifier.draggable(
                            state       = draggableState,
                            orientation = Orientation.Horizontal,
                            enabled     = enabled,
                            onDragStarted = { isDragging = true },
                            onDragStopped = { isDragging = false },
                        )
                    ),
            )
        }
    }
}

@Composable
fun AuntieRangeSlider(
    lowValue: Float,
    highValue: Float,
    onLowChange: (Float) -> Unit,
    onHighChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    trackHeight: Dp = 4.dp,
    thumbRadius: Dp = 10.dp,
    trackBrush: Brush = Brush.linearGradient(AuntieTheme.colors.orangeToPinkColors),
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    var trackWidthPx by remember { mutableFloatStateOf(0f) }

    fun norm(v: Float) = ((v - valueRange.start) / (valueRange.endInclusive - valueRange.start)).coerceIn(0f, 1f)
    fun denorm(n: Float) = valueRange.start + n * (valueRange.endInclusive - valueRange.start)

    var lowDragging  by remember { mutableStateOf(false) }
    var highDragging by remember { mutableStateOf(false) }

    val lowThumbScale by animateFloatAsState(if (lowDragging) 1.25f else 1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy), label = "lowScale")
    val highThumbScale by animateFloatAsState(if (highDragging) 1.25f else 1f, spring(dampingRatio = Spring.DampingRatioMediumBouncy), label = "highScale")

    val lowDrag = rememberDraggableState { delta ->
        if (trackWidthPx > 0f) {
            val n = (norm(lowValue) + delta / trackWidthPx).coerceIn(0f, norm(highValue) - 0.01f)
            onLowChange(denorm(n))
        }
    }
    val highDrag = rememberDraggableState { delta ->
        if (trackWidthPx > 0f) {
            val n = (norm(highValue) + delta / trackWidthPx).coerceIn(norm(lowValue) + 0.01f, 1f)
            onHighChange(denorm(n))
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(thumbRadius * 2)
            .onSizeChanged { trackWidthPx = it.width.toFloat() },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(trackHeight)
                .align(Alignment.Center)
                .clip(RoundedCornerShape(trackHeight))
                .drawBehind {
                    drawRoundRect(color = c.surface2, cornerRadius = CornerRadius(size.height / 2))
                    val lx = size.width * norm(lowValue)
                    val hx = size.width * norm(highValue)
                    drawRoundRect(
                        brush        = trackBrush,
                        topLeft      = Offset(lx, 0f),
                        size         = Size(hx - lx, size.height),
                        cornerRadius = CornerRadius(size.height / 2),
                    )
                },
        )
        // Low thumb
        val lowOffsetPx  = (trackWidthPx * norm(lowValue)).roundToInt()
        val highOffsetPx = (trackWidthPx * norm(highValue)).roundToInt()

        Box(
            modifier = Modifier
                .offset { IntOffset(x = lowOffsetPx - thumbRadius.roundToPx(), y = 0) }
                .size(thumbRadius * 2)
                .drawBehind {
                    drawCircle(color = c.background, radius = size.minDimension / 2f)
                    drawCircle(brush = trackBrush, radius = size.minDimension / 2f, style = androidx.compose.ui.graphics.drawscope.Stroke(2.5.dp.toPx()))
                }
                .draggable(state = lowDrag, orientation = Orientation.Horizontal, enabled = enabled, onDragStarted = { lowDragging = true }, onDragStopped = { lowDragging = false }),
        )
        Box(
            modifier = Modifier
                .offset { IntOffset(x = highOffsetPx - thumbRadius.roundToPx(), y = 0) }
                .size(thumbRadius * 2)
                .drawBehind {
                    drawCircle(color = c.background, radius = size.minDimension / 2f)
                    drawCircle(brush = trackBrush, radius = size.minDimension / 2f, style = androidx.compose.ui.graphics.drawscope.Stroke(2.5.dp.toPx()))
                }
                .draggable(state = highDrag, orientation = Orientation.Horizontal, enabled = enabled, onDragStarted = { highDragging = true }, onDragStopped = { highDragging = false }),
        )
    }
}
