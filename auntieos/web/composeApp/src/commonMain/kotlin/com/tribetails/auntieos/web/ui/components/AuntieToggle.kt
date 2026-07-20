package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieToggle. Den on/off pill switch (track + sliding knob, Kin Teal when on).
 *
 * Replaces the M3 Switch. Built entirely from foundation primitives (Box + Canvas
 * via drawBehind), so it follows the warm-dark Den palette and never pulls in an
 * M3 visual component.
 *
 * Three interaction states:
 *  - normal: click flips [checked] through [onCheckedChange].
 *  - disabled ([enabled] = false): dimmed, no callback.
 *  - locked ([locked] = true): forced-on read-only. The track renders teal, a small
 *    lock glyph is drawn on the knob, and clicks are swallowed. Use this for settings
 *    that are mandatory and cannot be turned off by the operator (the lock is the
 *    visible disclosure that the value is fixed, per fail-loud policy).
 *
 * The knob offset is animated (spring), the track color cross-fades, and a hover
 * ring brightens the border on pointer-over.
 *
 * @param compact renders a smaller pill (good for inline rows / dense tables).
 */
@Composable
fun AuntieToggle(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    locked: Boolean = false,
    compact: Boolean = false,
) {
    val c = AuntieTheme.colors

    // Locked means forced-on, read-only: render as "on" regardless of [checked].
    val visualOn = checked || locked
    val clickable = enabled && !locked

    val dims = if (compact) ToggleDims.Compact else ToggleDims.Default

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    val trackColor by animateColorAsState(
        targetValue = if (visualOn) c.accent else c.surface2,
        animationSpec = tween(180),
        label = "toggleTrack",
    )
    val borderColor by animateColorAsState(
        targetValue = when {
            visualOn          -> c.accent
            hovered && clickable -> c.accent.copy(alpha = 0.6f)
            else              -> c.border
        },
        animationSpec = tween(180),
        label = "toggleBorder",
    )
    // Knob slides from the left inset to the right inset.
    val knobOffset by animateDpAsState(
        targetValue = if (visualOn) dims.travel else dims.inset,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "toggleKnob",
    )
    // Knob brightens from a calm cream to pure white when on.
    val knobColor by animateColorAsState(
        targetValue = if (visualOn) Color.White else c.textDim,
        animationSpec = tween(180),
        label = "toggleKnobColor",
    )
    val lockAlpha by animateFloatAsState(
        targetValue = if (locked) 1f else 0f,
        animationSpec = tween(200),
        label = "toggleLock",
    )

    val trackAlpha = if (enabled) 1f else 0.4f

    Box(
        modifier = modifier
            .alpha(trackAlpha)
            .semantics { role = Role.Switch }
            .width(dims.width)
            .height(dims.height)
            .clip(RoundedCornerShape(999.dp))
            .background(trackColor)
            .border(
                width = AuntieTheme.dims.borderHairline,
                color = borderColor,
                shape = RoundedCornerShape(999.dp),
            )
            .clickable(
                enabled = clickable,
                interactionSource = interaction,
                indication = null,
                onClick = { onCheckedChange(!checked) },
            ),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .offset(x = knobOffset)
                .size(dims.knob)
                .clip(CircleShape)
                .background(knobColor)
                .drawBehind {
                    if (lockAlpha > 0f) drawLockGlyph(c.accent, lockAlpha)
                },
        )
    }
}

/** Sizing presets so the default and [compact] pills share one source of truth. */
private data class ToggleDims(
    val width: Dp,
    val height: Dp,
    val knob: Dp,
    val inset: Dp,
) {
    /** Distance the knob travels from the left inset to the right inset. */
    val travel: Dp get() = width - knob - inset

    companion object {
        val Default = ToggleDims(width = 46.dp, height = 26.dp, knob = 20.dp, inset = 3.dp)
        val Compact = ToggleDims(width = 36.dp, height = 20.dp, knob = 15.dp, inset = 2.5.dp)
    }
}

/**
 * Draws a tiny padlock centered on the knob: a rounded shackle arc above a body
 * rectangle. Tinted with [tint] (the on-state teal) so it reads as "fixed on".
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawLockGlyph(
    tint: Color,
    alpha: Float,
) {
    val w = size.width
    val h = size.height
    val stroke = (w * 0.085f).coerceAtLeast(1f)

    // Lock body: a small rounded rectangle in the lower-middle of the knob.
    val bodyW = w * 0.42f
    val bodyH = h * 0.30f
    val bodyLeft = (w - bodyW) / 2f
    val bodyTop = h * 0.50f
    drawRoundRect(
        color = tint,
        topLeft = Offset(bodyLeft, bodyTop),
        size = Size(bodyW, bodyH),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(stroke, stroke),
        alpha = alpha,
    )

    // Shackle: an open arc sitting on top of the body.
    val arcW = bodyW * 0.66f
    val arcLeft = (w - arcW) / 2f
    val arcTop = h * 0.30f
    drawArc(
        color = tint,
        startAngle = 180f,
        sweepAngle = 180f,
        useCenter = false,
        topLeft = Offset(arcLeft, arcTop),
        size = Size(arcW, bodyTop - arcTop),
        style = Stroke(width = stroke),
        alpha = alpha,
    )
}
