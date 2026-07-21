package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import coil3.compose.AsyncImagePainter
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageContent
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Overlapping cluster of circular avatars, Den style. Each circle reads from an
 * [AvatarSpec] (image URL or initials). When the list runs past [max], the final
 * slot becomes a "+N" overflow badge instead of another face.
 *
 * Circles are drawn back-to-front so the earlier avatars sit on top of later ones
 * (the natural "stack" read). Each carries a ring in the surrounding background
 * color so neighbors stay visually separated where they overlap.
 *
 * Uses [AvatarSpec] from AuntieTones.kt. Do not redefine it here.
 *
 * @param avatars   ordered specs; first ones win the visible slots.
 * @param max       how many face circles to show before collapsing to "+N".
 * @param avatarSize diameter of each circle.
 * @param overlap   how far each circle slides under its left neighbor.
 * @param ringColor color of the separating ring; defaults to the page background.
 */
@Composable
fun AuntieAvatarStack(
    avatars: List<AvatarSpec>,
    modifier: Modifier = Modifier,
    max: Int = 4,
    avatarSize: Dp = 34.dp,
    overlap: Dp = 12.dp,
    ringColor: androidx.compose.ui.graphics.Color = AuntieTheme.colors.background,
) {
    if (avatars.isEmpty()) return

    val safeMax = if (max < 1) 1 else max
    val overflowCount = avatars.size - safeMax
    val hasOverflow = overflowCount > 0

    // When overflowing, reserve the last visible slot for the "+N" badge.
    val faceCount = if (hasOverflow) safeMax - 1 else minOf(avatars.size, safeMax)
    val faces = avatars.take(faceCount)
    // +N counts every avatar not shown as a face (including the one displaced by the badge).
    val remaining = avatars.size - faceCount

    // Each circle after the first slides left by (size - overlap) into its neighbor.
    val step: Dp = avatarSize - overlap
    val totalSlots = faces.size + if (hasOverflow) 1 else 0

    Box(modifier = modifier) {
        // Back-to-front: draw later slots first (lowest zIndex), earlier slots on top.
        // The "+N" badge, when present, lives in the final slot.
        if (hasOverflow) {
            OverflowBadge(
                count = remaining,
                size = avatarSize,
                ringColor = ringColor,
                modifier = Modifier
                    .offset(x = step * (totalSlots - 1))
                    .zIndex(0f),
            )
        }
        for (index in faces.indices.reversed()) {
            // Higher index -> further right, lower zIndex (sits under earlier circles).
            AvatarCircle(
                spec = faces[index],
                size = avatarSize,
                ringColor = ringColor,
                modifier = Modifier
                    .offset(x = step * index)
                    .zIndex((totalSlots - index).toFloat()),
            )
        }
    }
}

@Composable
private fun AvatarCircle(
    spec: AvatarSpec,
    size: Dp,
    ringColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value
    val ring = animateColorAsState(
        if (hovered) c.primary else ringColor,
        label = "avatarRing",
    ).value

    val circle = RoundedCornerShape(percent = 50)
    val initials = spec.initials?.trim().orEmpty()
    val url = spec.imageUrl?.trim().orEmpty()

    Box(
        modifier = modifier
            .size(size)
            .clip(circle)
            .border(AuntieTheme.dims.borderEmphasis, ring, circle)
            .background(c.surface2, circle),
        contentAlignment = Alignment.Center,
    ) {
        if (url.isNotBlank()) {
            SubcomposeAsyncImage(
                model = url,
                contentDescription = if (initials.isNotBlank()) initials else "Avatar",
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(circle),
            ) {
                when (painter.state) {
                    is AsyncImagePainter.State.Loading,
                    is AsyncImagePainter.State.Error -> InitialsFace(initials, size)
                    else -> SubcomposeAsyncImageContent()
                }
            }
        } else {
            InitialsFace(initials, size)
        }
    }
}

@Composable
private fun InitialsFace(initials: String, size: Dp) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(size)
            .background(
                brush = Brush.linearGradient(c.tealToPurpleColors),
                shape = RoundedCornerShape(percent = 50),
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (initials.isNotBlank()) {
            Text(
                text = initials.take(2).uppercase(),
                style = if (size >= 40.dp) AuntieTheme.typography.labelLarge else AuntieTheme.typography.labelSmall,
                color = c.background,
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
    }
}

@Composable
private fun OverflowBadge(
    count: Int,
    size: Dp,
    ringColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val circle = RoundedCornerShape(percent = 50)
    Box(
        modifier = modifier
            .size(size)
            .clip(circle)
            .border(AuntieTheme.dims.borderEmphasis, ringColor, circle)
            .background(c.surface, circle),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "+$count",
            style = if (size >= 40.dp) AuntieTheme.typography.labelLarge else AuntieTheme.typography.labelSmall,
            color = c.textDim,
            maxLines = 1,
            overflow = TextOverflow.Clip,
        )
    }
}
