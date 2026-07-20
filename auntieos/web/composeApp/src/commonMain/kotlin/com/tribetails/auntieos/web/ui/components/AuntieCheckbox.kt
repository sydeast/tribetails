package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieCheckbox. Branded square check toggle in the Den aesthetic.
 *
 * Warm-dark glass surface, rounded corners, hover-lit border, and a checkmark
 * stroked on a Canvas so it draws-in (animated progress) using the brand
 * orange-to-pink gradient. Optional inline [label] sits to the right of the box.
 *
 * No Material3 Checkbox is used. Visuals are Box + drawBehind + Canvas stroke.
 *
 * @param checked         current checked state.
 * @param onCheckedChange invoked with the toggled value on click (no-op when disabled).
 * @param modifier        outer modifier for the whole control (box plus label row).
 * @param label           optional inline label. Null hides it (box only).
 * @param enabled         when false the control dims and ignores clicks.
 */
@Composable
fun AuntieCheckbox(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value

    val boxSize: Dp = 20.dp
    val corner = RoundedCornerShape(6.dp)

    // Border lights up on hover (and stays accented while checked).
    val borderColor by animateColorAsState(
        when {
            !enabled            -> c.borderSoft
            checked             -> c.primary
            hovered             -> c.primary
            else                -> c.border
        },
        label = "checkBorder",
    )

    // Subtle fill: transparent glass when unchecked, warm tint when checked.
    val fillColor by animateColorAsState(
        when {
            !enabled && checked -> c.primary.copy(alpha = 0.18f)
            checked             -> c.primary.copy(alpha = 0.16f)
            hovered             -> c.surface2
            else                -> c.surfaceGlass
        },
        label = "checkFill",
    )

    // Checkmark draw-in progress: 0 = hidden, 1 = fully stroked.
    val checkProgress by animateFloatAsState(
        targetValue   = if (checked) 1f else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label         = "checkProgress",
    )

    val labelColor by animateColorAsState(
        when {
            !enabled -> c.textFaint
            hovered  -> c.textPrimary
            else     -> c.textDim
        },
        label = "checkLabel",
    )

    val checkBrush: Brush = Brush.linearGradient(c.orangeToPinkColors)
    val disabledStrokeColor = c.textFaint

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(
                enabled           = enabled,
                interactionSource = interaction,
                indication        = null,
                onClick           = { onCheckedChange(!checked) },
            ),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
    ) {
        Box(
            modifier = Modifier
                .size(boxSize)
                .clip(corner)
                .background(fillColor)
                .border(AuntieTheme.dims.borderHairline, borderColor, corner)
                .drawBehind {
                    if (checkProgress <= 0f) return@drawBehind

                    // Three-point checkmark inside the box padding.
                    val pad = size.minDimension * 0.26f
                    val w = size.width
                    val h = size.height
                    val p0 = Offset(pad, h * 0.52f)
                    val p1 = Offset(w * 0.42f, h - pad)
                    val p2 = Offset(w - pad, pad)

                    val strokeW = size.minDimension * 0.13f
                    val drawColor = if (enabled) null else disabledStrokeColor

                    // Total path length split across the two legs so the tick
                    // draws in from the corner. Leg lengths approximate the
                    // visual proportions (short down-leg, long up-leg).
                    val leg0 = distance(p0, p1)
                    val leg1 = distance(p1, p2)
                    val total = leg0 + leg1
                    val drawn = total * checkProgress

                    if (drawn <= leg0) {
                        val t = if (leg0 == 0f) 0f else drawn / leg0
                        val mid = lerp(p0, p1, t)
                        if (drawColor != null) {
                            drawLine(color = drawColor, start = p0, end = mid, strokeWidth = strokeW, cap = StrokeCap.Round)
                        } else {
                            drawLine(brush = checkBrush, start = p0, end = mid, strokeWidth = strokeW, cap = StrokeCap.Round)
                        }
                    } else {
                        val t = if (leg1 == 0f) 1f else ((drawn - leg0) / leg1).coerceIn(0f, 1f)
                        val mid = lerp(p1, p2, t)
                        if (drawColor != null) {
                            drawLine(color = drawColor, start = p0, end = p1, strokeWidth = strokeW, cap = StrokeCap.Round)
                            drawLine(color = drawColor, start = p1, end = mid, strokeWidth = strokeW, cap = StrokeCap.Round)
                        } else {
                            drawLine(brush = checkBrush, start = p0, end = p1, strokeWidth = strokeW, cap = StrokeCap.Round)
                            drawLine(brush = checkBrush, start = p1, end = mid, strokeWidth = strokeW, cap = StrokeCap.Round)
                        }
                    }
                },
        )

        if (label != null) {
            Text(
                text  = label,
                style = AuntieTheme.typography.bodyMedium,
                color = labelColor,
            )
        }
    }
}

// ---- small local geometry helpers (file-private) ----

private fun distance(a: Offset, b: Offset): Float {
    val dx = b.x - a.x
    val dy = b.y - a.y
    return kotlin.math.sqrt(dx * dx + dy * dy)
}

private fun lerp(a: Offset, b: Offset, t: Float): Offset =
    Offset(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
