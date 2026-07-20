package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Full-width dashed-border add affordance. Reads as an open "drop a new one here"
 * slot rather than a committed solid action, so it pairs naturally with a list of
 * cards (for example an add-a-Time-Block row beneath existing blocks).
 *
 * Den treatment: translucent glass fill, a rounded dashed outline drawn with
 * foundation Canvas (PathEffect.dashPathEffect), and a hover lift where the
 * dashes + label + optional leading glyph warm toward the brand orange. The
 * optional [leadingIcon] is rendered with foundation Image + a tinted vector
 * painter (no Material3 Icon), matching the rest of the Den kit.
 */
@Composable
fun AuntieDashedAddButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: ImageVector? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val shape = RoundedCornerShape(12.dp)

    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value

    val strokeColor = animateColorAsState(
        targetValue   = if (hovered) c.primary else c.border,
        animationSpec = spring(stiffness = Spring.StiffnessLow),
        label         = "dashedStroke",
    ).value
    val fillColor = animateColorAsState(
        targetValue   = if (hovered) c.surface2 else c.surfaceGlass,
        animationSpec = spring(stiffness = Spring.StiffnessLow),
        label         = "dashedFill",
    ).value
    val contentColor = animateColorAsState(
        targetValue   = if (hovered) c.primary else c.textDim,
        animationSpec = spring(stiffness = Spring.StiffnessLow),
        label         = "dashedContent",
    ).value

    Box(
        modifier = modifier
            .defaultMinSize(minHeight = 52.dp)
            .clip(shape)
            .background(fillColor, shape)
            .drawBehind {
                val strokePx = dims.borderHairline.toPx().coerceAtLeast(1f)
                val cornerPx = 12.dp.toPx()
                val inset = strokePx / 2f
                val dash = PathEffect.dashPathEffect(
                    intervals = floatArrayOf(6.dp.toPx(), 5.dp.toPx()),
                    phase     = 0f,
                )
                drawRoundRect(
                    brush       = SolidColor(strokeColor),
                    topLeft     = androidx.compose.ui.geometry.Offset(inset, inset),
                    size        = androidx.compose.ui.geometry.Size(
                        size.width - strokePx,
                        size.height - strokePx,
                    ),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(cornerPx, cornerPx),
                    style        = Stroke(width = strokePx, pathEffect = dash),
                )
            }
            .clickable(
                interactionSource = interaction,
                indication        = null,
                role              = Role.Button,
                onClick           = onClick,
            )
            // Merge the label (and glyph) into this clickable node so it reads as a
            // single button to a11y + UI tests (onNodeWithText finds the actionable node).
            .semantics(mergeDescendants = true) {}
            .padding(horizontal = dims.space4, vertical = dims.space3),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space2),
        ) {
            if (leadingIcon != null) {
                Image(
                    painter            = rememberVectorPainter(leadingIcon),
                    contentDescription = null,
                    colorFilter        = ColorFilter.tint(contentColor),
                    modifier           = Modifier.size(18.dp),
                )
            }
            Text(
                text  = text,
                style = AuntieTheme.typography.labelLarge,
                color = contentColor,
            )
        }
    }
}
