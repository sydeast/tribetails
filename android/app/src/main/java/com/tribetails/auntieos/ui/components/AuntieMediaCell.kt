package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AuntieMediaCell. The Den's square media thumbnail tile.
 *
 * Two shapes, one component:
 *
 *   1. Media tile (default). Renders a square preview of a [MediaFile].
 *        - IMAGE / VIDEO  load the thumbnail via coil3 AsyncImage. VIDEO overlays a
 *          centered play glyph and (when known) a duration badge in the corner.
 *        - DOCUMENT / AUDIO  show a tinted glyph plus the original file name, since
 *          there is no visual frame to preview.
 *        A broken thumbnail URL falls back to the file-type glyph rather than leaving
 *        an empty hole, so a dead asset still reads as media (fail-visible).
 *
 *   2. Add tile ([isAddTile] = true). A dashed, glassy "add media" affordance that picks
 *        up the brand gold on hover. Wire [onAdd] to open your picker.
 *
 * Visual treatment follows the Den aesthetic: warm-dark glass surface, RoundedCornerShape,
 * hairline border that warms to brand gold on hover, and a subtle hover lift driven by a
 * MutableInteractionSource. Captions use the Fraunces title scale; meta labels use the
 * Spline mono / uppercase label scale.
 *
 * All glyphs are caller-supplied [ImageVector] params (via [glyphs]) so this stays icon-set
 * agnostic and never hardcodes a specific icon. Missing glyphs degrade gracefully.
 */
@Composable
fun AuntieMediaCell(
    media: MediaFile,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
    showCaption: Boolean = false,
    isAddTile: Boolean = false,
    onAdd: (() -> Unit)? = null,
    glyphs: MediaCellGlyphs = MediaCellGlyphs(),
) {
    if (isAddTile) {
        AddTile(modifier = modifier, onAdd = onAdd, glyph = glyphs.add)
        return
    }

    val c = AuntieTheme.colors
    val shape = RoundedCornerShape(12.dp)

    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value
    val interactive = onClick != null

    val borderColor = animateColorAsState(
        if (hovered && interactive) c.primary else c.border,
        label = "mediaCellBorder",
    ).value
    // Subtle hover lift. Tiles only lift when they are actually clickable.
    val lift by animateFloatAsState(
        targetValue = if (hovered && interactive) 1.03f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label = "mediaCellLift",
    )

    val kind = mediaKindOf(media.fileType.name)
    val previewUrl = media.thumbnailUrl.ifBlank { media.storageUrl }.takeIf { it.isNotBlank() }
    // A broken thumbnail reveals the glyph fallback underneath rather than a blank box.
    var imageFailed by remember(previewUrl) { mutableStateOf(false) }
    val canShowImage = (kind == MediaKind.IMAGE || kind == MediaKind.VIDEO) &&
        previewUrl != null && !imageFailed

    Column(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .liftScale(lift)
                .clip(shape)
                .background(c.surface2)
                .border(AuntieTheme.dims.borderHairline, borderColor, shape)
                .then(
                    if (interactive) Modifier.clickable(
                        interactionSource = interaction,
                        indication = null,
                        onClick = onClick!!,
                    ) else Modifier,
                ),
        ) {
            // ---- preview / glyph body ----
            if (canShowImage && previewUrl != null) {
                AsyncImage(
                    model = previewUrl,
                    contentDescription = media.description.ifBlank { media.originalFileName.ifBlank { "Media" } },
                    contentScale = ContentScale.Crop,
                    onState = { state ->
                        if (state is AsyncImagePainter.State.Error) imageFailed = true
                    },
                    modifier = Modifier.fillMaxSize().clip(shape),
                )
                if (kind == MediaKind.VIDEO) {
                    // Darkening scrim keeps the play glyph legible over bright frames.
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.22f)),
                    )
                    PlayBadge(glyph = glyphs.play)
                    DurationBadge(media.metadata.duration ?: 0)
                }
            } else {
                GlyphBody(
                    kind = kind,
                    media = media,
                    glyphs = glyphs,
                    imageFailed = imageFailed && previewUrl != null,
                )
            }

            // ---- delete affordance (reveals on hover when wired) ----
            if (onDelete != null && (hovered || !interactive)) {
                DeleteBadge(
                    glyph = glyphs.delete,
                    onDelete = onDelete,
                    modifier = Modifier.align(Alignment.TopEnd).padding(6.dp),
                )
            }
        }

        if (showCaption) {
            val caption = media.description.ifBlank { media.originalFileName }
            if (caption.isNotBlank()) {
                Text(
                    text = caption,
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                )
            }
        }
    }
}

// ---- supporting type --------------------------------------------------------

/**
 * Caller-supplied vector glyphs for [AuntieMediaCell]. Kept as a small bundle so a screen
 * can pass its icon set once. Every glyph is optional: when a glyph is null the cell simply
 * omits that bit of chrome (for example, no play triangle, or a plain document tile) rather
 * than substituting some hardcoded icon.
 */
data class MediaCellGlyphs(
    val play: ImageVector? = null,
    val document: ImageVector? = null,
    val audio: ImageVector? = null,
    val broken: ImageVector? = null,
    val delete: ImageVector? = null,
    val add: ImageVector? = null,
)

private enum class MediaKind { IMAGE, VIDEO, DOCUMENT, AUDIO, OTHER }

private fun mediaKindOf(fileType: String): MediaKind = when (fileType.uppercase()) {
    "IMAGE" -> MediaKind.IMAGE
    "VIDEO" -> MediaKind.VIDEO
    "DOCUMENT" -> MediaKind.DOCUMENT
    "AUDIO" -> MediaKind.AUDIO
    else -> MediaKind.OTHER
}

// ---- internals --------------------------------------------------------------

@Composable
private fun GlyphBody(
    kind: MediaKind,
    media: MediaFile,
    glyphs: MediaCellGlyphs,
    imageFailed: Boolean,
) {
    val c = AuntieTheme.colors
    // A failed image preview gets the "broken" glyph so the dead asset stays visible.
    val glyph: ImageVector? = when {
        imageFailed -> glyphs.broken
        kind == MediaKind.DOCUMENT -> glyphs.document
        kind == MediaKind.AUDIO -> glyphs.audio
        else -> glyphs.broken
    }
    val showName = (kind == MediaKind.DOCUMENT || kind == MediaKind.AUDIO || imageFailed)

    Column(
        modifier = Modifier.fillMaxSize().padding(10.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (glyph != null) {
            val painter = rememberVectorPainter(glyph)
            Box(modifier = Modifier.size(30.dp).glyphTint(painter, c.primary))
        }
        val name = media.originalFileName.ifBlank { media.description }
        if (showName && name.isNotBlank()) {
            Text(
                text = name,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
        }
        if (imageFailed) {
            Text(
                text = "Preview unavailable",
                style = AuntieTheme.typography.labelSmall,
                color = c.error,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            )
        }
    }
}

@Composable
private fun PlayBadge(glyph: ImageVector?) {
    if (glyph == null) return
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(c.background.copy(alpha = 0.62f))
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp)),
            contentAlignment = Alignment.Center,
        ) {
            val painter = rememberVectorPainter(glyph)
            Box(modifier = Modifier.size(18.dp).glyphTint(painter, c.primary))
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.DurationBadge(durationSeconds: Int) {
    if (durationSeconds <= 0) return
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .align(Alignment.BottomEnd)
            .padding(6.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(c.background.copy(alpha = 0.72f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(
            text = formatDuration(durationSeconds),
            style = AuntieTheme.typography.labelSmall,
            color = c.textPrimary,
        )
    }
}

@Composable
private fun DeleteBadge(
    glyph: ImageVector?,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (glyph == null) return
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value
    val bg = animateColorAsState(
        if (hovered) c.errorContainer else c.background.copy(alpha = 0.78f),
        label = "deleteBadgeBg",
    ).value
    Box(
        modifier = modifier
            .size(24.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp))
            .clickable(interactionSource = interaction, indication = null, onClick = onDelete),
        contentAlignment = Alignment.Center,
    ) {
        val painter = rememberVectorPainter(glyph)
        Box(modifier = Modifier.size(13.dp).glyphTint(painter, c.error))
    }
}

@Composable
private fun AddTile(
    modifier: Modifier,
    onAdd: (() -> Unit)?,
    glyph: ImageVector?,
) {
    val c = AuntieTheme.colors
    val shape = RoundedCornerShape(12.dp)
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value

    val strokeColor = animateColorAsState(
        if (hovered) c.primary else c.border,
        label = "addTileStroke",
    ).value
    val tint = animateColorAsState(
        if (hovered) c.primary else c.textDim,
        label = "addTileTint",
    ).value
    val lift by animateFloatAsState(
        targetValue = if (hovered) 1.03f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label = "addTileLift",
    )

    Box(
        modifier = modifier
            .aspectRatio(1f)
            .liftScale(lift)
            .clip(shape)
            .background(c.surfaceGlass)
            .dashedBorder(strokeColor, cornerRadius = 12.dp)
            .then(
                if (onAdd != null) Modifier.clickable(
                    interactionSource = interaction,
                    indication = null,
                    onClick = onAdd,
                ) else Modifier,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (glyph != null) {
                val painter = rememberVectorPainter(glyph)
                Box(modifier = Modifier.size(26.dp).glyphTint(painter, tint))
            }
            Text(
                text = "ADD MEDIA",
                style = AuntieTheme.typography.labelSmall,
                color = tint,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

/**
 * Draws a vector painter as a flat tinted silhouette so we never depend on the M3 Icon
 * composable. Pure foundation drawing keeps this inside the no-M3-visuals rule.
 */
private fun Modifier.glyphTint(painter: Painter, tint: Color): Modifier = drawWithContent {
    with(painter) {
        draw(size = this@drawWithContent.size, colorFilter = ColorFilter.tint(tint))
    }
}

/** Hover-lift scale applied around the tile's center via graphicsLayer. */
private fun Modifier.liftScale(scale: Float): Modifier =
    graphicsLayer(scaleX = scale, scaleY = scale)

/** Brand-dashed rounded border for the add-tile, drawn with foundation Canvas APIs. */
private fun Modifier.dashedBorder(color: Color, cornerRadius: androidx.compose.ui.unit.Dp): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        val dash = PathEffect.dashPathEffect(floatArrayOf(8.dp.toPx(), 6.dp.toPx()), 0f)
        val inset = stroke / 2f
        drawRoundRect(
            color = color,
            topLeft = Offset(inset, inset),
            size = Size(size.width - stroke, size.height - stroke),
            cornerRadius = CornerRadius(cornerRadius.toPx(), cornerRadius.toPx()),
            style = Stroke(width = stroke, pathEffect = dash),
        )
    }

/** mm:ss / h:mm:ss duration label for the video badge. */
private fun formatDuration(totalSeconds: Int): String {
    val s = totalSeconds % 60
    val m = (totalSeconds / 60) % 60
    val h = totalSeconds / 3600
    fun pad(n: Int): String = if (n < 10) "0$n" else "$n"
    return if (h > 0) "$h:${pad(m)}:${pad(s)}" else "$m:${pad(s)}"
}
