package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * One segment in a breadcrumb trail.
 *
 *  - [label]     the visible text for this crumb (rendered in the Spline-mono style).
 *  - [isCurrent] marks the trailing "you are here" crumb. The current crumb is bold,
 *                full-strength text, and is never treated as clickable (no hover, no
 *                pointer affordance) even when [onCrumbClick] is supplied.
 *  - [icon]      optional leading glyph (e.g. a home/root marker for the first crumb).
 *                Tinted to the same color as the crumb label.
 */
data class Crumb(
    val label: String,
    val isCurrent: Boolean = false,
    val icon: ImageVector? = null,
)

/**
 * Mono breadcrumb trail for the Den kit.
 *
 * Ancestor crumbs render in the dim Spline-mono style and become clickable when
 * [onCrumbClick] is provided: hovering an ancestor animates its color up to the brand
 * primary so the navigable path reads as alive. The trailing [Crumb.isCurrent] crumb is
 * bold, full-strength textPrimary, and inert (it is where you already are).
 *
 * Segments are separated by a faint mono chevron (the slash glyph), keeping the whole
 * row in the uppercase Spline-mono treatment used across Den labels.
 *
 * Read-mostly by design: when [onCrumbClick] is null the trail is a static path label.
 */
@Composable
fun AuntieBreadcrumbs(
    crumbs: List<Crumb>,
    modifier: Modifier = Modifier,
    onCrumbClick: ((Crumb) -> Unit)? = null,
) {
    if (crumbs.isEmpty()) return
    val c = AuntieTheme.colors

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space2),
    ) {
        crumbs.forEachIndexed { index, crumb ->
            if (index > 0) {
                CrumbSeparator()
            }
            CrumbSegment(
                crumb = crumb,
                // Only ancestor crumbs are clickable. The current crumb is the
                // destination, so it never offers a navigation affordance.
                onClick = if (!crumb.isCurrent && onCrumbClick != null) {
                    { onCrumbClick(crumb) }
                } else {
                    null
                },
            )
        }
    }
}

/**
 * A single crumb. Clickable ancestors hover up to the brand primary; the current crumb
 * is bold and inert. Both share the uppercase Spline-mono treatment.
 */
@Composable
private fun CrumbSegment(
    crumb: Crumb,
    onClick: (() -> Unit)?,
) {
    val c = AuntieTheme.colors

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val clickable = onClick != null

    val targetColor = when {
        crumb.isCurrent       -> c.textPrimary
        clickable && hovered  -> c.primary
        else                  -> c.textDim
    }
    val contentColor = animateColorAsState(targetColor, label = "crumbColor").value

    val baseStyle = AuntieTheme.typography.mono.copy(letterSpacing = 0.6.sp)
    val labelStyle = if (crumb.isCurrent) {
        baseStyle.copy(fontWeight = FontWeight.Bold)
    } else {
        baseStyle
    }

    val rowModifier = if (onClick != null) {
        Modifier.clickable(
            interactionSource = interaction,
            indication = null,
            onClick = onClick,
        )
    } else {
        Modifier
    }

    Row(
        modifier = rowModifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space1),
    ) {
        if (crumb.icon != null) {
            // Foundation Image + vector painter (no M3 Icon), tinted to the crumb color.
            Image(
                painter = rememberVectorPainter(crumb.icon),
                contentDescription = null,
                colorFilter = ColorFilter.tint(contentColor),
                modifier = Modifier.size(14.dp),
            )
        }
        Text(
            text = crumb.label.uppercase(),
            style = labelStyle,
            color = contentColor,
        )
    }
}

/** Faint mono chevron between crumbs. Uses the slash glyph to stay inside the Den mono look. */
@Composable
private fun CrumbSeparator() {
    val c = AuntieTheme.colors
    Text(
        text = "/",
        style = AuntieTheme.typography.mono.copy(letterSpacing = 0.6.sp),
        color = c.textFaint,
    )
}
