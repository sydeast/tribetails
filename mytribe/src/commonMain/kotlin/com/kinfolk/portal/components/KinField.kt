package com.kinfolk.portal.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkTheme

/**
 * Warm animated text field — Foundation-only, no M3 TextField.
 *
 * - Bottom border that glows orange on focus.
 * - Animated label colour (muted → primary on focus, coral on error).
 * - All @Composable color/float values are captured in `val` before
 *   passing into drawBehind{} to satisfy the @ReadOnlyComposable contract.
 */
@Composable
fun KinField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    isError: Boolean = false,
    /**
     * Tag on the editable field itself. [label] is a sibling Text rather than
     * part of the field's own semantics, so a test that wants to type into one
     * of several fields on a screen has no way to name it otherwise. Null
     * leaves the field untagged, which is every caller that does not need it.
     */
    fieldTestTag: String? = null,
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()

    // Capture before drawBehind — @Composable values not accessible inside DrawScope
    val primary      = c.primary
    val coralColor   = c.coral
    val navyHairline = c.navyHairline
    val navyColor    = c.navy
    val navyMuted    = c.navyMuted

    val lineColor by animateColorAsState(
        targetValue   = when {
            isError -> coralColor
            focused -> primary
            else    -> navyHairline
        },
        animationSpec = tween(200),
        label         = "fieldLine",
    )
    val labelColor by animateColorAsState(
        targetValue   = when {
            isError -> coralColor
            focused -> primary
            else    -> navyMuted
        },
        animationSpec = tween(200),
        label         = "labelColor",
    )
    val glowAlpha by animateFloatAsState(
        targetValue   = if (focused && !isError) 0.18f else 0f,
        animationSpec = tween(250),
        label         = "fieldGlow",
    )
    val lineWidthDp by animateFloatAsState(
        targetValue   = if (focused || isError) 1.5f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label         = "lineWidth",
    )

    Column(modifier = modifier) {
        Text(
            text  = label,
            style = type.sansMeta.copy(color = labelColor),
        )
        Spacer(Modifier.height(4.dp))
        BasicTextField(
            value             = value,
            onValueChange     = onValueChange,
            enabled           = enabled,
            singleLine        = singleLine,
            cursorBrush       = SolidColor(primary),
            textStyle         = type.sansBody.copy(color = navyColor),
            interactionSource = source,
            modifier          = Modifier
                .then(if (fieldTestTag != null) Modifier.testTag(fieldTestTag) else Modifier)
                .fillMaxWidth()
                .drawBehind {
                    val lw = lineWidthDp.dp.toPx()
                    // glow behind the bottom line when focused
                    if (glowAlpha > 0f) {
                        drawRoundRect(
                            color        = primary.copy(alpha = glowAlpha),
                            topLeft      = Offset(0f, size.height - lw - 4.dp.toPx()),
                            size         = Size(size.width, lw + 8.dp.toPx()),
                            cornerRadius = CornerRadius(4.dp.toPx()),
                        )
                    }
                    // bottom border line
                    drawLine(
                        color       = lineColor,
                        start       = Offset(0f, size.height),
                        end         = Offset(size.width, size.height),
                        strokeWidth = lw,
                    )
                }
                .padding(bottom = 6.dp),
        )
    }
}
