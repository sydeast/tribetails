package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AuntieIconTile. A rounded-square tile holding a single glyph over a tinted or
 * gradient backdrop. The Den standard leading element on list rows, stat cards,
 * and section headers.
 *
 * The tile derives its look from an [AuntieStatusTone] (see AuntieTones.kt): the
 * glyph takes the tone color and the backdrop is a soft wash of that same color,
 * so every tile in a list resolves to the SAME brand palette. Pass [background]
 * to override the wash with a brand gradient (for example
 * `Brush.linearGradient(c.orangeToPinkColors)`); the glyph then renders in a
 * legible on-gradient color rather than the tone tint.
 *
 * Glyphs are drawn with foundation [Image] + [rememberVectorPainter] + a tint
 * [ColorFilter] rather than the Material3 Icon, keeping the tile inside the
 * Den component kit. Icons are caller-supplied [ImageVector]s; none are
 * hardcoded here.
 */
@Composable
fun AuntieIconTile(
    icon: ImageVector,
    modifier: Modifier = Modifier,
    size: Dp = 42.dp,
    tone: AuntieStatusTone = AuntieStatusTone.Neutral,
    background: Brush? = null,
    contentDescription: String? = null,
) {
    val c = AuntieTheme.colors
    val toneColor = tone.color(c)

    // Backdrop: explicit brand gradient when supplied, otherwise a soft wash of
    // the tone color sitting on the glass surface so it reads on any background.
    val washAlpha = if (c.isDark) 0.20f else 0.14f
    val tileBrush = background ?: Brush.linearGradient(
        listOf(
            toneColor.copy(alpha = washAlpha),
            toneColor.copy(alpha = washAlpha * 0.55f),
        ),
    )

    // Glyph color: on a tinted wash the tone color stays legible; on a full
    // brand gradient we switch to the cream/navy on-color for contrast.
    val glyphColor = if (background != null) {
        if (c.isDark) c.textPrimary else c.background
    } else {
        toneColor
    }

    // Hairline border echoes the tone on a wash, or stays neutral over a gradient.
    val borderColor = if (background != null) {
        c.border.copy(alpha = 0.6f)
    } else {
        toneColor.copy(alpha = 0.35f)
    }

    // Glyph occupies roughly 52% of the tile, matching the Den glyph-in-tile ratio.
    val glyphSize = size * 0.52f
    val corner = (size * 0.28f).coerceAtMost(14.dp)
    val shape = RoundedCornerShape(corner)

    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(tileBrush)
            .border(AuntieTheme.dims.borderHairline, borderColor, shape),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = rememberVectorPainter(icon),
            contentDescription = contentDescription,
            colorFilter = ColorFilter.tint(glyphColor),
            modifier = Modifier.size(glyphSize),
        )
    }
}
