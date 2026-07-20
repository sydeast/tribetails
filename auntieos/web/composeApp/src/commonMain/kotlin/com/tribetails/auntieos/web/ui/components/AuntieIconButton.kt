package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Icon-only Den button. Back, edit, close, reorder, delete handles, etc.
 *
 * A rounded glass tile that tints its border, background, and icon on hover.
 * The [destructive] variant resolves to the brand error color so delete and
 * remove actions read as dangerous. Set [revealOnHover] for affordances that
 * should stay faint until the surrounding row is hovered (drag handles, inline
 * remove buttons in lists); the icon fades in rather than appearing abruptly.
 *
 * Visual is built entirely from Box + foundation Image (vector painter) so it
 * carries no Material3 component dependency. The [icon] is a caller-supplied
 * [ImageVector]; this component never hardcodes a glyph.
 */
@Composable
fun AuntieIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 38.dp,
    destructive: Boolean = false,
    revealOnHover: Boolean = false,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val active = (hovered || pressed) && enabled

    // The brand accent this button leans into on hover. Delete and remove
    // actions glow with the error color so they read as dangerous.
    val accent = if (destructive) c.error else c.primary

    val iconColor by animateColorAsState(
        when {
            !enabled -> c.textFaint
            active   -> accent
            else     -> if (destructive) c.error else c.textDim
        },
        animationSpec = tween(160),
        label = "iconColor",
    )
    val bgColor by animateColorAsState(
        if (active) accent.copy(alpha = 0.12f) else Color.Transparent,
        animationSpec = tween(160),
        label = "iconButtonBg",
    )
    val borderColor by animateColorAsState(
        when {
            active   -> accent.copy(alpha = 0.5f)
            else     -> Color.Transparent
        },
        animationSpec = tween(160),
        label = "iconButtonBorder",
    )

    // Reveal-on-hover handles sit nearly invisible until the row is hovered,
    // then fade up. Disabled always dims regardless of reveal mode.
    val contentAlpha by animateFloatAsState(
        targetValue = when {
            !enabled                  -> 0.4f
            revealOnHover && !active  -> 0.32f
            else                      -> 1f
        },
        animationSpec = tween(180),
        label = "iconButtonAlpha",
    )

    val shape = RoundedCornerShape(10.dp)
    val painter = rememberVectorPainter(icon)
    // Glyph sits at a comfortable ratio inside the tile; clamp so very small
    // or very large tiles still render a sensible icon.
    val glyph = (size.value * 0.5f).dp.coerceIn(14.dp, 28.dp)

    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(bgColor)
            .border(dims.borderHairline, SolidColor(borderColor), shape)
            .clickable(
                enabled = enabled,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painter,
            contentDescription = null,
            colorFilter = ColorFilter.tint(iconColor),
            modifier = Modifier
                .requiredSize(glyph)
                .alpha(contentAlpha),
        )
    }
}
