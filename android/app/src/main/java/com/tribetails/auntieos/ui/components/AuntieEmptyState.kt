package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AuntieEmptyState - the Den kit's centered empty / no-data block.
 *
 * Surfaces a "nothing here yet" moment without faking content (per the fail-loud
 * policy: an honest empty state, never fabricated rows). Anatomy, top to bottom:
 *  - An optional [icon] in a soft brand-washed glyph tile. The caller supplies the
 *    [ImageVector]; none are hardcoded. Drawn with foundation Image +
 *    rememberVectorPainter + a tint ColorFilter, never the Material3 Icon.
 *  - A [title] in the Fraunces display face (headlineMedium), the editorial heading
 *    for the block.
 *  - Optional dim [message] copy in bodyMedium, centered under the title.
 *  - An optional [action] slot the caller fills with a CTA (for example a
 *    GhostButton). Copy authoring stays with the caller.
 *
 * Set [compact] for a tight text-only variant: the glyph tile is suppressed, the
 * heading drops to titleMedium, and vertical padding shrinks. Use it inside cards,
 * list sections, or popovers where the full hero treatment is too heavy.
 */
@Composable
fun AuntieEmptyState(
    title: String,
    modifier: Modifier = Modifier,
    message: String? = null,
    icon: ImageVector? = null,
    compact: Boolean = false,
    action: (@Composable () -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val verticalPad = if (compact) dims.space5 else dims.space10
    val blockSpacing = if (compact) dims.space2 else dims.space3

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = dims.space4, vertical = verticalPad),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(blockSpacing),
    ) {
        // The glyph tile only appears in the full (non-compact) treatment.
        if (icon != null && !compact) {
            EmptyStateGlyphTile(icon = icon)
        }

        Text(
            text = title,
            style = if (compact) AuntieTheme.typography.titleMedium else AuntieTheme.typography.headlineMedium,
            color = c.textPrimary,
            textAlign = TextAlign.Center,
        )

        if (message != null) {
            Text(
                text = message,
                style = if (compact) AuntieTheme.typography.bodySmall else AuntieTheme.typography.bodyMedium,
                color = c.textDim,
                textAlign = TextAlign.Center,
                // Keep the copy to a comfortable measure so long messages wrap
                // into a readable column rather than a single wide line.
                modifier = Modifier.widthIn(max = if (compact) 320.dp else 420.dp),
            )
        }

        if (action != null) {
            Box(modifier = Modifier.padding(top = if (compact) dims.space1 else dims.space2)) {
                action()
            }
        }
    }
}

/**
 * The hero glyph tile: a soft brand-washed rounded square holding the caller's icon,
 * drawn with foundation Image + vector painter + tint (no Material3 Icon). The wash
 * leans on the orange-to-pink brand gradient so the empty state still feels warm
 * rather than dead.
 */
@Composable
private fun EmptyStateGlyphTile(icon: ImageVector) {
    val c = AuntieTheme.colors
    val tileSize = 64.dp
    val shape = RoundedCornerShape(18.dp)
    val washAlpha = if (c.isDark) 0.18f else 0.12f
    val washBrush = Brush.linearGradient(
        c.orangeToPinkColors.map { it.copy(alpha = washAlpha) },
    )
    Box(
        modifier = Modifier
            .size(tileSize)
            .clip(shape)
            .background(washBrush),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = rememberVectorPainter(icon),
            contentDescription = null,
            colorFilter = ColorFilter.tint(c.primary),
            modifier = Modifier.size(tileSize * 0.44f),
        )
    }
}
