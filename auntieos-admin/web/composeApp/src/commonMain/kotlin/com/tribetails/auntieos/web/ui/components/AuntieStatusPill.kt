package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Read-only status / badge pill for the Den kit.
 *
 * Color-keyed by [tone] (resolved via [AuntieStatusTone.color]); the tone tints the
 * label, the leading LED dot, the soft fill, and the hairline border so every state
 * reads as one coherent swatch.
 *
 *  - [showDot]   prepends a small LED dot in the tone color.
 *  - [dotOnly]   renders JUST the LED (no chip chrome, no label text). Useful inline
 *                beside a row label where space is tight. Implies a dot regardless of
 *                [showDot].
 *  - [mono]      renders the label in the Spline-mono style, uppercased, for
 *                SCREAMING_SNAKE status codes (e.g. IN_PROGRESS, AWAITING_VET).
 *  - [glow]      marks a LIVE indicator. The dot gains a soft pulsing halo and the
 *                pill border lifts to the tone color so it reads as active.
 *
 * Read-only by design: no onClick. Pills report state, they do not mutate it.
 */
@Composable
fun AuntieStatusPill(
    label: String,
    modifier: Modifier = Modifier,
    tone: AuntieStatusTone = AuntieStatusTone.Neutral,
    showDot: Boolean = false,
    dotOnly: Boolean = false,
    mono: Boolean = false,
    glow: Boolean = false,
    leadingIcon: ImageVector? = null,
) {
    val c = AuntieTheme.colors
    val toneColor = tone.color(c)

    // Hover is cosmetic only (no click target): a subtle lift so the pill feels alive
    // when a pointer passes over it, matching the rest of the Den kit.
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    // Live "glow" pulse: a slow breathing alpha for the halo + dot core.
    val pulse: Float = if (glow) {
        val transition = rememberInfiniteTransition(label = "statusPillGlow")
        transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1100),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "statusPillPulse",
        ).value
    } else {
        1f
    }

    // ----- Dot-only mode: just the LED, no chip chrome -----
    if (dotOnly) {
        StatusLed(
            color = toneColor,
            glow = glow,
            pulse = pulse,
            modifier = modifier,
        )
        return
    }

    val showLed = showDot || glow

    val fillBase = toneColor.copy(alpha = if (c.isDark) 0.14f else 0.10f)
    val fillColor = if (hovered) {
        toneColor.copy(alpha = if (c.isDark) 0.22f else 0.16f)
    } else {
        fillBase
    }
    val borderColor = when {
        glow -> toneColor.copy(alpha = 0.55f)
        hovered -> toneColor.copy(alpha = 0.45f)
        else -> toneColor.copy(alpha = 0.28f)
    }

    val labelStyle = if (mono) {
        AuntieTheme.typography.mono.copy(letterSpacing = 0.6.sp)
    } else {
        AuntieTheme.typography.labelSmall
    }
    val labelText = if (mono) label.uppercase() else label

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(fillColor)
            .border(
                BorderStroke(AuntieTheme.dims.borderHairline, SolidColor(borderColor)),
                RoundedCornerShape(999.dp),
            )
            // Hover-only interaction source: no indication, no onClick (read-only).
            .hoverable(interaction)
            .padding(horizontal = AuntieTheme.dims.space3, vertical = AuntieTheme.dims.space1),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
        ) {
            if (showLed) {
                StatusLed(color = toneColor, glow = glow, pulse = pulse)
            }
            if (leadingIcon != null) {
                // Foundation Image + vector painter (no M3 Icon), tone-tinted.
                Image(
                    painter = rememberVectorPainter(leadingIcon),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(toneColor),
                    modifier = Modifier.size(14.dp),
                )
            }
            // A pill is one line. Wrapping inside a fixed-height card (the
            // Directory card is 196dp) pushed content past the clip (#829 review).
            Text(
                text = labelText,
                style = labelStyle,
                color = toneColor,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The LED itself: a filled tone dot with an optional pulsing halo when [glow] is set.
 * Drawn with Canvas so the halo can spill outside the core without affecting layout.
 */
@Composable
private fun StatusLed(
    color: Color,
    glow: Boolean,
    pulse: Float,
    modifier: Modifier = Modifier,
) {
    // Halo needs room to breathe; core sits centered inside.
    val boxSize = if (glow) 16.dp else 8.dp
    Box(
        modifier = modifier.size(boxSize),
        contentAlignment = Alignment.Center,
    ) {
        if (glow) {
            Canvas(modifier = Modifier.size(16.dp)) {
                val center = Offset(size.width / 2f, size.height / 2f)
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            color.copy(alpha = 0.45f * pulse),
                            Color.Transparent,
                        ),
                        center = center,
                        radius = size.minDimension / 2f,
                    ),
                    radius = size.minDimension / 2f,
                    center = center,
                )
            }
        }
        // Solid core dot.
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(color),
        )
        // Subtle highlight ring on the core for the live state.
        if (glow) {
            Canvas(modifier = Modifier.size(8.dp)) {
                drawCircle(
                    color = color.copy(alpha = 0.6f * pulse),
                    style = Stroke(width = 1.dp.toPx()),
                )
            }
        }
    }
}
