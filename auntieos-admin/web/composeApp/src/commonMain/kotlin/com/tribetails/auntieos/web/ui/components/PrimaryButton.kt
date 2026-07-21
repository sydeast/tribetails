package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Glass-feel primary action button. 1px border that picks up the brand gold on hover/press.
 * Honors enabled + loading. While loading, swaps label for a brand-tinted spinner - never
 * shows nothing while an action is in flight.
 */
@Composable
fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed = interaction.collectIsPressedAsState().value
    val hovered = interaction.collectIsHoveredAsState().value

    val targetBg = when {
        !enabled -> c.primary.copy(alpha = 0.18f).compositeOver(c.surface)
        pressed  -> c.primaryDim
        hovered  -> c.primary.copy(alpha = 0.92f).compositeOver(c.background)
        else     -> c.primary
    }
    val bg = animateColorAsState(targetBg, label = "primaryBg").value
    // #9: a gradient accent paints the button with the brand gradient brush.
    val brush = c.accentBrush

    Box(
        modifier = modifier
            .height(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(if (brush != null && enabled) Modifier.background(brush) else Modifier.background(bg))
            .border(
                BorderStroke(AuntieTheme.dims.borderHairline, SolidColor(c.primary)),
                RoundedCornerShape(8.dp),
            )
            .clickable(
                enabled = enabled && !loading,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = c.background,
            )
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                leading?.invoke()
                Text(
                    text  = label,
                    style = AuntieTheme.typography.labelLarge,
                    color = if (enabled) c.background else c.textDim,
                )
            }
        }
    }
}
