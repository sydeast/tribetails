package com.kinfolk.portal.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkTheme

/**
 * Primary gradient button with spring-based press feedback.
 * Background: orange → pink gradient (KinfolkGradients.orangeToPink).
 * Aesthetic: "Sunlit Heritage" — warm, tactile, organic.
 */
@Composable
fun KinButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue   = if (pressed && enabled) 0.96f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessHigh),
        label         = "pressScale",
    )

    val disabledText = c.navyMuted
    val bg = if (enabled) KinfolkGradients.orangeToPink else SolidColor(c.navyHairline)

    Box(
        modifier = modifier
            .scale(scale)
            .clip(KinfolkShapes.pill)
            .background(bg)
            .clickable(interactionSource = source, indication = null, enabled = enabled) { onClick() }
            .padding(horizontal = 24.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = type.sansButton.copy(color = if (enabled) Color.White else disabledText),
        )
    }
}

/**
 * Ghost (outline) button with spring-based press feedback.
 * Border and label use the primary orange; no fill.
 */
@Composable
fun KinGhostButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue   = if (pressed && enabled) 0.96f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessHigh),
        label         = "pressScale",
    )

    val primaryColor = c.primary
    val disabledText = c.navyMuted

    Box(
        modifier = modifier
            .scale(scale)
            .clip(KinfolkShapes.pill)
            .border(1.dp, primaryColor, KinfolkShapes.pill)
            .clickable(interactionSource = source, indication = null, enabled = enabled) { onClick() }
            .padding(horizontal = 24.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = type.sansButton.copy(color = if (enabled) primaryColor else disabledText),
        )
    }
}

/**
 * Selectable chip with animated background/text color and spring press feedback.
 * Selected state: filled primary; unselected: glass surface with border.
 * [trailingIcon] renders a small inline icon after the label (e.g. the
 * check/lock markers on notification channel chips), tinted like the text.
 */
@Composable
fun KinChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    trailingIcon: ImageVector? = null,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue   = if (pressed) 0.96f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessHigh),
        label         = "chipScale",
    )
    val bgColor by animateColorAsState(
        targetValue   = if (selected) c.primary else c.glassSurface,
        animationSpec = tween(200),
        label         = "chipColor",
    )
    val textColor by animateColorAsState(
        targetValue   = if (selected) Color.White else c.navy,
        animationSpec = tween(200),
        label         = "chipTextColor",
    )

    val primaryColor = c.primary
    val borderColor = c.glassBorder

    Box(
        modifier = modifier
            .scale(scale)
            .clip(KinfolkShapes.pill)
            .background(bgColor)
            .border(1.dp, if (selected) primaryColor else borderColor, KinfolkShapes.pill)
            .clickable(interactionSource = source, indication = null) { onClick() }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(label, style = type.sansLabel.copy(color = textColor))
            if (trailingIcon != null) {
                Icon(
                    imageVector = trailingIcon,
                    contentDescription = null,
                    tint = textColor,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}
