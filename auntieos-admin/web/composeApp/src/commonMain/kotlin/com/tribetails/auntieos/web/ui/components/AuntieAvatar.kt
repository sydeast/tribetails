package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import com.tribetails.auntieos.web.theme.AuntieColors
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieAvatar. The Den's single avatar primitive.
 *
 * Resolution order (first non-blank wins):
 *   1. [imageUrl]  loaded via coil3 AsyncImage. On a load error it falls back to the next
 *                  available representation instead of leaving a blank hole (fail-visible).
 *   2. [initials]  one or two letters drawn on a deterministic brand gradient keyed off [gradientSeed].
 *   3. [glyph]     a tinted vector icon centered on the gradient.
 *   4. [emoji]     an emoji glyph centered on the gradient.
 *   5. (none)      gradient-only tile, still on-brand, never empty.
 *
 * The gradient is derived deterministically from [gradientSeed], so the same person or pet
 * always reads with the same color signature across the app.
 *
 * Visual treatment follows the Den aesthetic: warm-dark palette, rounded shape (circle by
 * default), optional hairline ring in the seeded accent color.
 */
@Composable
fun AuntieAvatar(
    modifier: Modifier = Modifier,
    imageUrl: String? = null,
    initials: String? = null,
    glyph: ImageVector? = null,
    emoji: String? = null,
    size: Dp = 42.dp,
    shape: Shape = CircleShape,
    ring: Boolean = true,
    gradientSeed: Any? = initials,
) {
    val c = AuntieTheme.colors

    // Deterministic two-stop gradient + ring accent, keyed off the seed.
    val palette = remember(gradientSeed, c.isDark) { avatarPaletteFor(gradientSeed, c) }
    val gradient = Brush.linearGradient(listOf(palette.first, palette.second))
    val ringColor = palette.second
    val onGradient = onGradientText(c)

    val cleanUrl = imageUrl?.takeIf { it.isNotBlank() }
    val cleanInitials = initials?.takeIf { it.isNotBlank() }?.let { normalizeInitials(it) }
    val cleanEmoji = emoji?.takeIf { it.isNotBlank() }

    // Track the photo load so a broken URL gracefully reveals the gradient fallback
    // underneath rather than rendering an empty box.
    var imageFailed by remember(cleanUrl) { mutableStateOf(false) }
    val showImage = cleanUrl != null && !imageFailed

    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            // The gradient always sits underneath; it shows through whenever the photo
            // is absent or fails. When a photo is loading/loaded we still want a neutral
            // base behind it, so layer surface2 on top of the gradient for that case.
            .background(gradient)
            .then(if (showImage) Modifier.background(c.surface2) else Modifier)
            .then(
                if (ring) Modifier.border(AuntieTheme.dims.borderHairline, ringColor.copy(alpha = 0.55f), shape)
                else Modifier
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (showImage && cleanUrl != null) {
            AsyncImage(
                model = cleanUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                onState = { state ->
                    if (state is AsyncImagePainter.State.Error) imageFailed = true
                },
                modifier = Modifier.fillMaxSize().clip(shape),
            )
        } else {
            when {
                cleanInitials != null -> {
                    Text(
                        text = cleanInitials,
                        // Scale the monogram to the avatar so initials read at any size.
                        style = AuntieTheme.typography.titleSmall.copy(fontSize = (size.value * 0.40f).sp),
                        color = onGradient,
                    )
                }
                glyph != null -> {
                    val vp = rememberVectorPainter(glyph)
                    Box(
                        modifier = Modifier
                            .size(size * 0.52f)
                            .glyphTint(vp, onGradient),
                    )
                }
                cleanEmoji != null -> {
                    Text(
                        text = cleanEmoji,
                        style = AuntieTheme.typography.titleMedium.copy(fontSize = (size.value * 0.50f).sp),
                    )
                }
                // else: gradient-only tile (intentional, on-brand, never blank).
            }
        }
    }
}

// ---- internals -------------------------------------------------------------

/**
 * Draws a vector painter as a flat tinted silhouette so we never depend on the M3 Icon
 * composable. Pure foundation drawing keeps this inside the no-M3-visuals rule.
 */
private fun Modifier.glyphTint(painter: Painter, tint: Color): Modifier = drawWithContent {
    with(painter) {
        draw(size = this@drawWithContent.size, colorFilter = ColorFilter.tint(tint))
    }
}

/** Best-contrast text/glyph color on top of a brand gradient. */
private fun onGradientText(c: AuntieColors): Color =
    // Cream reads cleanly over all brand stops in both themes.
    if (c.isDark) c.textPrimary else Color(0xFFFBFBF9)

/** Trim to a tidy one-or-two-character monogram, uppercased. */
private fun normalizeInitials(raw: String): String {
    val letters = raw.trim().filter { !it.isWhitespace() }
    return when {
        letters.isEmpty() -> ""
        letters.length <= 2 -> letters.uppercase()
        else -> letters.take(2).uppercase()
    }
}

/**
 * Maps an arbitrary seed to a stable two-stop brand gradient using the signature Den
 * pairings (orange-pink, teal-purple, pink-purple, orange-teal, purple-pink).
 */
private fun avatarPaletteFor(seed: Any?, c: AuntieColors): Pair<Color, Color> {
    val pairs = listOf(
        c.primary to c.secondary,   // orange to pink
        c.accent to c.tertiary,     // teal to purple
        c.secondary to c.tertiary,  // pink to purple
        c.primary to c.accent,      // orange to teal
        c.tertiary to c.secondary,  // purple to pink
    )
    val key = seed?.toString().orEmpty()
    if (key.isEmpty()) return pairs.first()
    // Simple deterministic hash (avoids any platform variance in String.hashCode).
    var h = 0
    for (ch in key) h = (h * 31 + ch.code) and 0x7FFFFFFF
    return pairs[h % pairs.size]
}
