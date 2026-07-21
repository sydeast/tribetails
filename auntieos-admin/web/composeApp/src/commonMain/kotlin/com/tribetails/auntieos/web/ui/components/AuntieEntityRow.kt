package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieEntityRow is the Den row used for identity lists: directory entries,
 * Kinfolk and Kin pickers, search results, and anywhere a person, pet, or
 * record needs a tappable line item.
 *
 * Layout, left to right:
 *   - optional [leading] slot (an [AuntieAvatar], [AuntieIconTile], or any small
 *     visual the caller supplies),
 *   - an optional leading status dot resolved from [leadingDotTone] (see
 *     AuntieTones.kt) for at-a-glance state, drawn just before the title,
 *   - a text column with the [title] in the Fraunces title style plus an
 *     optional [subtitle] in dim body text,
 *   - the optional [trailing] slot (chevron, status pill, chip, ghost button).
 *
 * When [onClick] is non-null the whole row is tappable. Hover lifts the
 * background to a faint glass wash via [MutableInteractionSource] +
 * [collectIsHoveredAsState] + [animateColorAsState], matching the other Den
 * interactive rows. [selected] paints a persistent tinted wash plus a left
 * accent edge so the active entity reads clearly inside a list. A hairline
 * divider is drawn at the bottom when [showDivider] is true so a column of rows
 * reads as one grouped surface without per-row borders.
 *
 * All colors, spacing, and text styles come from [AuntieTheme]; the leading and
 * trailing visuals are caller-supplied composables so no icons are hardcoded.
 */
@Composable
fun AuntieEntityRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    leadingDotTone: AuntieStatusTone? = null,
    selected: Boolean = false,
    showDivider: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    // Persistent selected wash beats a transient hover wash; an unselected row
    // only lifts on hover (and only when it is actually tappable).
    val targetBackground = when {
        selected             -> c.primary.copy(alpha = 0.10f)
        hovered && onClick != null -> c.surfaceGlass
        else                 -> c.background.copy(alpha = 0f)
    }
    val rowBackground by animateColorAsState(
        targetValue   = targetBackground,
        animationSpec = tween(150),
        label         = "entityRowBg",
    )

    // Left accent edge color for the selected state, animated so toggling
    // selection in a list feels intentional rather than snapping.
    val edgeColor by animateColorAsState(
        targetValue   = if (selected) c.primary else c.primary.copy(alpha = 0f),
        animationSpec = tween(150),
        label         = "entityRowEdge",
    )

    val dotColor = leadingDotTone?.color(c)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .hoverable(interaction)
            .background(rowBackground)
            .then(
                if (onClick != null) {
                    Modifier.clickable(
                        interactionSource = interaction,
                        indication = null,
                        onClick = onClick,
                    )
                } else {
                    Modifier
                }
            )
            .drawBehind {
                // Left accent edge (selected state).
                if (edgeColor.alpha > 0f) {
                    val w = dims.borderEmphasis.toPx()
                    drawRect(
                        brush   = SolidColor(edgeColor),
                        topLeft = Offset(0f, 0f),
                        size    = androidx.compose.ui.geometry.Size(w, size.height),
                    )
                }
                // Bottom hairline divider.
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
            .padding(horizontal = dims.space3, vertical = dims.space3),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            if (leading != null) {
                leading()
            }

            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                if (dotColor != null) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .background(dotColor),
                    )
                }

                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text  = title,
                        style = AuntieTheme.typography.titleMedium,
                        color = if (selected) c.primary else c.textPrimary,
                    )
                    if (subtitle != null) {
                        Text(
                            text  = subtitle,
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
            }

            if (trailing != null) {
                Box(
                    modifier = Modifier.widthIn(min = 0.dp),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    trailing()
                }
            }
        }
    }
}
