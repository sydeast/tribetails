package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieSettingRow is the Den row used in settings and permission lists.
 *
 * Layout, left to right:
 *   - optional leading [AuntieIconTile] (only when [leadingIcon] is supplied),
 *   - a text column with the [title] in the Fraunces title style plus an
 *     optional [description] in body text and an optional [code] line in the
 *     Spline mono style (for keys, tokens, ids, default values),
 *   - the [trailing] control slot (toggle, chip, ghost button, status pill).
 *
 * A hairline divider is drawn at the bottom when [showDivider] is true, so a
 * column of rows reads as one grouped surface without per-row borders. Hover
 * lifts the background to a faint glass wash via [MutableInteractionSource] and
 * [animateColorAsState], matching the other Den interactive rows.
 *
 * The leading glyph tone follows [iconTone] (see AuntieTones.kt) so every tile
 * in a list resolves to the same brand palette. Icons are caller-supplied
 * [ImageVector]s; none are hardcoded here.
 */
@Composable
fun AuntieSettingRow(
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    code: String? = null,
    leadingIcon: ImageVector? = null,
    iconTone: AuntieStatusTone = AuntieStatusTone.Neutral,
    showDivider: Boolean = true,
    trailing: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    val rowBackground by animateColorAsState(
        targetValue   = if (hovered) c.surfaceGlass else c.background.copy(alpha = 0f),
        animationSpec = tween(150),
        label         = "settingRowBg",
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .hoverable(interaction)
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
            .padding(horizontal = dims.space3, vertical = dims.space3),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            if (leadingIcon != null) {
                AuntieIconTile(
                    icon = leadingIcon,
                    tone = iconTone,
                    size = 40.dp,
                )
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text  = title,
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                if (description != null) {
                    Text(
                        text  = description,
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                if (code != null) {
                    Box(
                        modifier = Modifier
                            .padding(top = 2.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(c.surface2)
                            .padding(horizontal = dims.space2, vertical = dims.space1),
                    ) {
                        Text(
                            text  = code,
                            style = AuntieTheme.typography.mono,
                            color = c.textDim,
                        )
                    }
                }
            }

            Box(
                modifier = Modifier.widthIn(min = 0.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                trailing()
            }
        }
    }
}
