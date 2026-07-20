package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieStatTile: a summary / KPI tile for the Den dashboards and detail panes.
 *
 * Anatomy (top to bottom):
 *  - a mono, uppercase, tracked kicker [label] (Spline mono via labelSmall),
 *  - a large editorial [value] (Fraunces via the display tier),
 *  - an optional smaller [caption] beneath the value.
 *
 * The tile color-keys off an [AuntieStatusTone] (resolved through
 * AuntieStatusTone.color in AuntieTones.kt) so a row of tiles resolves to the
 * SAME brand palette. By default the tone tints only the kicker label and a
 * hairline accent; set [emphasized] to promote the tile to a hero KPI: a soft
 * tone wash fills the surface, a left accent bar appears, and the value itself
 * takes the tone color.
 *
 * Hover behaves like the rest of the Den kit: the border lifts to the tone
 * color, the fill warms a touch, and the whole tile rises a couple of pixels via
 * a vertical offset (a "lift"). When [onClick] is supplied the tile becomes a
 * click target (no Material ripple, matching the Den no-indication convention);
 * when it is null the hover is purely cosmetic.
 *
 * Layout is leading-aligned by default; pass [alignEnd] for the trailing-aligned
 * variant used when a tile sits at the right edge of a stat strip.
 *
 * Visuals are built from Box / Column / Text only (plus the foundation
 * background / border / clickable modifiers). The single Material3 dependency is
 * androidx.compose.material3.Text, per the Den kit rules.
 */
/**
 * 0E, trend tone driven by the SIGN of a computed delta, never a literal.
 * Positive renders teal, negative coral, flat neutral. The home revenue card
 * (and any KPI delta) feeds this the sign of real data so the +/- color is never
 * a hardcoded "+12%".
 */
fun trendTone(delta: Double): AuntieStatusTone = when {
    delta > 0.0 -> AuntieStatusTone.Teal
    delta < 0.0 -> AuntieStatusTone.Error
    else        -> AuntieStatusTone.Neutral
}

@Composable
fun AuntieStatTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    caption: String? = null,
    tone: AuntieStatusTone = AuntieStatusTone.Neutral,
    emphasized: Boolean = false,
    alignEnd: Boolean = false,
    onClick: (() -> Unit)? = null,
    // 0E: a computed trend. [trendLabel] is caller-formatted from real data
    // (never authored here); [trendDelta]'s sign drives the teal/coral tint.
    trendLabel: String? = null,
    trendDelta: Double? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val toneColor = tone.color(c)

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()

    val shape = RoundedCornerShape(16.dp)

    // Surface fill. Emphasized tiles carry a soft tone wash; plain tiles sit on
    // the glass surface. Hover warms each a notch.
    val washAlpha = if (c.isDark) 0.16f else 0.10f
    val washHoverAlpha = if (c.isDark) 0.22f else 0.14f
    val fillColor by animateColorAsState(
        targetValue = when {
            emphasized && hovered -> toneColor.copy(alpha = washHoverAlpha)
            emphasized            -> toneColor.copy(alpha = washAlpha)
            hovered               -> c.surface2
            else                  -> c.surfaceGlass
        },
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "statTileFill",
    )

    // Hairline border. Tone-tinted on emphasized / hover, neutral at rest.
    val borderColor by animateColorAsState(
        targetValue = when {
            hovered    -> toneColor.copy(alpha = 0.55f)
            emphasized -> toneColor.copy(alpha = 0.32f)
            else       -> c.border
        },
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "statTileBorder",
    )

    // The lift: a small upward translation on hover. Only lifts when the tile is
    // interactive (clickable) so a static read-only tile does not bob unexpectedly.
    val liftTarget = if (hovered && onClick != null) (-3).dp else 0.dp
    val lift by animateDpAsState(
        targetValue = liftTarget,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label = "statTileLift",
    )

    // Value color: tone for the hero variant, primary text otherwise.
    val valueColor by animateColorAsState(
        targetValue = if (emphasized) toneColor else c.textPrimary,
        label = "statTileValue",
    )

    val horizontalAlignment = if (alignEnd) Alignment.End else Alignment.Start
    val textAlign = if (alignEnd) TextAlign.End else TextAlign.Start

    var tile = modifier
        .offset(y = lift)
        .clip(shape)
        .background(fillColor)
        .border(BorderStroke(dims.borderHairline, SolidColor(borderColor)), shape)

    tile = if (onClick != null) {
        tile.clickable(
            interactionSource = interaction,
            indication = null,
            onClick = onClick,
        )
    } else {
        // Cosmetic hover only: register pointer enter / exit without a click
        // target, matching the read-only convention used by AuntieStatusPill.
        tile.hoverable(interaction)
    }

    // Row lets the emphasized accent bar stretch to the content's intrinsic
    // height. height(IntrinsicSize.Min) gives the fillMaxHeight bar a height to
    // match. The content Column carries the weight so the bar stays a hairline.
    // The bar and the content are inlined here (not local composables) so that
    // RowScope.weight resolves correctly.
    Row(
        modifier = tile.height(IntrinsicSize.Min).fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (emphasized && !alignEnd) {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(999.dp))
                    .background(toneColor),
            )
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = dims.space4, vertical = dims.space4),
            horizontalAlignment = horizontalAlignment,
            verticalArrangement = Arrangement.spacedBy(dims.space2),
        ) {
            Text(
                text = label.uppercase(),
                style = AuntieTheme.typography.labelSmall.copy(letterSpacing = 1.2.sp),
                color = if (emphasized) toneColor else c.textDim,
                textAlign = textAlign,
            )
            Text(
                text = value,
                style = AuntieTheme.typography.displayMedium,
                color = valueColor,
                textAlign = textAlign,
            )
            if (caption != null) {
                Text(
                    text = caption,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textFaint,
                    textAlign = textAlign,
                )
            }
            if (trendLabel != null) {
                Text(
                    text = trendLabel,
                    style = AuntieTheme.typography.labelSmall,
                    color = trendTone(trendDelta ?: 0.0).color(c),
                    textAlign = textAlign,
                )
            }
        }

        if (emphasized && alignEnd) {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(999.dp))
                    .background(toneColor),
            )
        }
    }
}
