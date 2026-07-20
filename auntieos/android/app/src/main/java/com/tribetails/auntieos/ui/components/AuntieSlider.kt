package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.DraggableState
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlin.math.roundToInt

// ─── AuntieSlider ─────────────────────────────────────────────────────────────
// Single-thumb gradient-track slider. No M3 dependency.
// Thumb has spring bounce on release + scale-up on drag.
@Composable
fun AuntieSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    trackHeight: Dp = 4.dp,
    thumbRadius: Dp = 10.dp,
    trackBrush: Brush? = null,
    enabled: Boolean = true,
    label: String? = null,
    valueLabel: ((Float) -> String)? = null,
) {
    val c = AuntieTheme.colors
    val effectiveBrush = trackBrush ?: Brush.linearGradient(c.orangeToPinkColors)
    val density = LocalDensity.current
    var trackWidthPx by remember { mutableFloatStateOf(0f) }
    val thumbRadiusPx = with(density) { thumbRadius.toPx() }

    fun norm(v: Float) =
        ((v - valueRange.start) / (valueRange.endInclusive - valueRange.start)).coerceIn(0f, 1f)

    fun denorm(n: Float) =
        valueRange.start + n * (valueRange.endInclusive - valueRange.start)

    var dragging by remember { mutableStateOf(false) }
    val thumbScale by animateFloatAsState(
        targetValue   = if (dragging) 1.2f else 1f,
        animationSpec = spring(
            stiffness    = Spring.StiffnessMediumLow,
            dampingRatio = Spring.DampingRatioMediumBouncy,
        ),
        label = "thumbScale",
    )

    val draggableState = rememberDraggableState { delta ->
        if (trackWidthPx > 0f && enabled) {
            val newNorm = (norm(value) + delta / trackWidthPx).coerceIn(0f, 1f)
            val raw = denorm(newNorm)
            val snapped = if (steps > 0) {
                val stepSize = (valueRange.endInclusive - valueRange.start) / steps
                (raw / stepSize).roundToInt() * stepSize
            } else raw
            onValueChange(snapped.coerceIn(valueRange.start, valueRange.endInclusive))
        }
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (label != null || valueLabel != null) {
            Row(
                modifier            = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                if (label != null) {
                    Text(
                        text  = label.uppercase(),
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                    )
                }
                if (valueLabel != null) {
                    Text(
                        text       = valueLabel(value),
                        style      = AuntieTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color      = c.primary,
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(thumbRadius * 2)
                .onSizeChanged { trackWidthPx = it.width.toFloat() - thumbRadiusPx * 2 }
                .draggable(
                    state         = draggableState,
                    orientation   = Orientation.Horizontal,
                    enabled       = enabled,
                    onDragStarted = { dragging = true },
                    onDragStopped = { dragging = false },
                ),
            contentAlignment = Alignment.CenterStart,
        ) {
            val normalised = norm(value)

            Canvas(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(trackHeight)
                    .align(Alignment.Center),
            ) {
                val trackStart = thumbRadiusPx
                val trackEnd   = size.width - thumbRadiusPx
                val trackW     = trackEnd - trackStart
                val cr         = CornerRadius(size.height / 2)

                drawRoundRect(
                    color        = c.surface2,
                    topLeft      = Offset(trackStart, 0f),
                    size         = Size(trackW, size.height),
                    cornerRadius = cr,
                )

                val filledW = (trackW * normalised).coerceAtLeast(0f)
                if (filledW > 0f) {
                    drawRoundRect(
                        brush        = effectiveBrush,
                        topLeft      = Offset(trackStart, 0f),
                        size         = Size(filledW, size.height),
                        cornerRadius = cr,
                    )
                }

                if (steps > 0) {
                    for (i in 0..steps) {
                        val tx = trackStart + trackW * (i.toFloat() / steps)
                        drawCircle(
                            color  = c.border,
                            radius = 2.dp.toPx(),
                            center = Offset(tx, size.height / 2),
                        )
                    }
                }
            }

            val thumbOffsetDp = with(density) {
                (thumbRadiusPx + trackWidthPx * normalised).toDp()
            }
            Box(
                modifier = Modifier
                    .offset(x = thumbOffsetDp - thumbRadius)
                    .size(thumbRadius * 2)
                    .scale(thumbScale)
                    .clip(CircleShape)
                    .background(c.background)
                    .drawBehind {
                        drawCircle(
                            brush = effectiveBrush,
                            style = Stroke(width = 2.dp.toPx()),
                        )
                    },
            )
        }
    }
}

// ─── AuntieRangeSlider ────────────────────────────────────────────────────────
// Two-thumb range slider for price ranges, date windows, etc.
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
    trackBrush: Brush? = null,
    enabled: Boolean = true,
    label: String? = null,
    valueLabel: ((Float, Float) -> String)? = null,
) {
    val c = AuntieTheme.colors
    val effectiveBrush = trackBrush ?: Brush.linearGradient(c.orangeToPinkColors)
    val density = LocalDensity.current
    var trackWidthPx by remember { mutableFloatStateOf(0f) }
    val thumbRadiusPx = with(density) { thumbRadius.toPx() }

    fun norm(v: Float) =
        ((v - valueRange.start) / (valueRange.endInclusive - valueRange.start)).coerceIn(0f, 1f)

    fun denorm(n: Float) =
        valueRange.start + n * (valueRange.endInclusive - valueRange.start)

    var draggingLow  by remember { mutableStateOf(false) }
    var draggingHigh by remember { mutableStateOf(false) }

    val lowThumbScale by animateFloatAsState(
        targetValue   = if (draggingLow) 1.2f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label         = "lowScale",
    )
    val highThumbScale by animateFloatAsState(
        targetValue   = if (draggingHigh) 1.2f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label         = "highScale",
    )

    val lowDragState = rememberDraggableState { delta ->
        if (trackWidthPx > 0f && enabled) {
            val newNorm = (norm(lowValue) + delta / trackWidthPx)
                .coerceIn(0f, norm(highValue) - 0.01f)
            onLowChange(denorm(newNorm))
        }
    }
    val highDragState = rememberDraggableState { delta ->
        if (trackWidthPx > 0f && enabled) {
            val newNorm = (norm(highValue) + delta / trackWidthPx)
                .coerceIn(norm(lowValue) + 0.01f, 1f)
            onHighChange(denorm(newNorm))
        }
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (label != null || valueLabel != null) {
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                if (label != null) {
                    Text(
                        text  = label.uppercase(),
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textDim,
                    )
                }
                if (valueLabel != null) {
                    Text(
                        text       = valueLabel(lowValue, highValue),
                        style      = AuntieTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color      = c.primary,
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(thumbRadius * 2)
                .onSizeChanged { trackWidthPx = it.width.toFloat() - thumbRadiusPx * 2 },
            contentAlignment = Alignment.CenterStart,
        ) {
            val normLow  = norm(lowValue)
            val normHigh = norm(highValue)

            Canvas(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(trackHeight)
                    .align(Alignment.Center),
            ) {
                val ts = thumbRadiusPx
                val te = size.width - thumbRadiusPx
                val tw = te - ts
                val cr = CornerRadius(size.height / 2)

                drawRoundRect(
                    color        = c.surface2,
                    topLeft      = Offset(ts, 0f),
                    size         = Size(tw, size.height),
                    cornerRadius = cr,
                )

                val filledStart = ts + tw * normLow
                val filledEnd   = ts + tw * normHigh
                if (filledEnd > filledStart) {
                    drawRoundRect(
                        brush        = effectiveBrush,
                        topLeft      = Offset(filledStart, 0f),
                        size         = Size(filledEnd - filledStart, size.height),
                        cornerRadius = cr,
                    )
                }
            }

            @Composable
            fun thumbModifier(
                thumbNorm: Float,
                scale: Float,
                dragState: DraggableState,
                onStart: () -> Unit,
                onStop: () -> Unit,
            ): Modifier {
                val offsetDp = with(density) { (thumbRadiusPx + trackWidthPx * thumbNorm).toDp() }
                return Modifier
                    .offset(x = offsetDp - thumbRadius)
                    .size(thumbRadius * 2)
                    .scale(scale)
                    .clip(CircleShape)
                    .background(c.background)
                    .draggable(
                        state         = dragState,
                        orientation   = Orientation.Horizontal,
                        enabled       = enabled,
                        onDragStarted = { onStart() },
                        onDragStopped = { onStop() },
                    )
                    .drawBehind {
                        drawCircle(
                            brush = effectiveBrush,
                            style = Stroke(width = 2.dp.toPx()),
                        )
                    }
            }

            Box(
                modifier = thumbModifier(
                    thumbNorm = normLow,
                    scale     = lowThumbScale,
                    dragState = lowDragState,
                    onStart   = { draggingLow = true },
                    onStop    = { draggingLow = false },
                ),
            )
            Box(
                modifier = thumbModifier(
                    thumbNorm = normHigh,
                    scale     = highThumbScale,
                    dragState = highDragState,
                    onStart   = { draggingHigh = true },
                    onStop    = { draggingHigh = false },
                ),
            )
        }
    }
}
