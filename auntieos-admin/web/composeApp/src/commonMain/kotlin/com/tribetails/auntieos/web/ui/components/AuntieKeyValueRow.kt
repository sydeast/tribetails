package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Style variants for the value side of an [AuntieKeyValueRow].
 *
 *   Default       value reads in the standard primary text color.
 *   Muted         value reads dimmed, for de-emphasized or secondary detail.
 *   AccentSuccess value tinted with the brand success green.
 *   AccentError   value tinted with the brand error coral.
 *   AccentPrimary value tinted with Kinfolk Orange (the brand anchor).
 *   Total         value rendered in the Fraunces title style at full weight,
 *                 for summary rows (grand total, balance due).
 */
enum class KeyValueStyle { Default, Muted, AccentSuccess, AccentError, AccentPrimary, Total }

/**
 * AuntieKeyValueRow is the Den read-only detail row: a [label] pinned left in
 * the Spline mono uppercase label style, with the [value] aligned right.
 *
 * The value can render in any [KeyValueStyle] variant (see above) and, when
 * [valueMono] is true, switches to the Spline mono face for ids, tokens, and
 * monetary figures that benefit from tabular alignment. Supplying
 * [onValueClick] turns the value into a link: it picks up Kinfolk Orange, an
 * underline, and a hover wash on the whole row, matching the other interactive
 * Den rows ([MutableInteractionSource] + [collectIsHoveredAsState] +
 * [animateColorAsState]). A [trailing] slot sits at the far right for a copy
 * button, status pill, or chip.
 *
 * A hairline divider is drawn at the bottom when [showDivider] is true, so a
 * column of rows reads as one grouped surface without per-row borders.
 *
 * Either [value] or [trailing] (or both) may be supplied. When neither is
 * present the right side simply stays empty rather than failing, which keeps
 * the row safe to drive from optional data.
 */
@Composable
fun AuntieKeyValueRow(
    label: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    valueStyle: KeyValueStyle = KeyValueStyle.Default,
    valueMono: Boolean = false,
    onValueClick: (() -> Unit)? = null,
    showDivider: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val isLink = onValueClick != null && value != null
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    // Hover lift only matters when the value is an actionable link.
    val rowBackground by animateColorAsState(
        targetValue   = if (hovered && isLink) c.surfaceGlass else c.background.copy(alpha = 0f),
        animationSpec = tween(150),
        label         = "kvRowBg",
    )

    // Resolve the value color from the style variant. Links override toward the
    // brand primary, lifting further on hover.
    val baseValueColor = when (valueStyle) {
        KeyValueStyle.Default       -> c.textPrimary
        KeyValueStyle.Muted         -> c.textDim
        KeyValueStyle.AccentSuccess -> c.success
        KeyValueStyle.AccentError   -> c.error
        KeyValueStyle.AccentPrimary -> c.primary
        KeyValueStyle.Total         -> c.textPrimary
    }
    val valueColor by animateColorAsState(
        targetValue = when {
            isLink && hovered -> c.primary
            isLink            -> c.primaryDim
            else              -> baseValueColor
        },
        animationSpec = tween(150),
        label = "kvValueColor",
    )

    val valueTextStyle: TextStyle = when {
        valueMono                       -> AuntieTheme.typography.mono
        valueStyle == KeyValueStyle.Total -> AuntieTheme.typography.titleMedium
        else                            -> AuntieTheme.typography.bodyMedium
    }.let { base ->
        when {
            valueStyle == KeyValueStyle.Total -> base.copy(fontWeight = FontWeight.SemiBold)
            isLink                            -> base.copy(textDecoration = TextDecoration.Underline)
            else                              -> base
        }
    }

    val rowModifier = modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(10.dp))
        .then(if (isLink) Modifier.hoverable(interaction) else Modifier)
        .background(rowBackground)
        .drawBehind {
            if (showDivider) {
                val y = size.height - (dims.borderHairline.toPx() / 2f)
                drawLine(
                    color       = c.borderSoft,
                    start       = Offset(0f, y),
                    end         = Offset(size.width, y),
                    strokeWidth = dims.borderHairline.toPx(),
                )
            }
        }
        .padding(horizontal = dims.space3, vertical = dims.space3)

    Box(modifier = rowModifier) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 28.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space4),
        ) {
            // Label, left. Spline mono uppercase label face, dimmed.
            Text(
                text  = label.uppercase(),
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim,
                modifier = Modifier.widthIn(min = 0.dp),
            )

            // Value + trailing, right.
            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space2, Alignment.End),
            ) {
                if (value != null) {
                    val valueModifier = if (isLink) {
                        Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(
                                interactionSource = interaction,
                                indication = null,
                                onClick = { onValueClick?.invoke() },
                            )
                    } else {
                        Modifier
                    }
                    Box(modifier = valueModifier) {
                        Text(
                            text  = value,
                            style = valueTextStyle,
                            color = valueColor,
                        )
                    }
                }
                trailing?.invoke()
            }
        }
    }
}
