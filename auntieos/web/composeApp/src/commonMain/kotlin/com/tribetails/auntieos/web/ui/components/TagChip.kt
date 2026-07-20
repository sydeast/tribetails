package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.TagColor
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.paletteColor
import com.tribetails.auntieos.web.data.resolveTag
import com.tribetails.auntieos.web.theme.AuntieColors
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * TagChip: one assigned tag, rendered as the resolved emoji + name tinted to the
 * tag's palette color. A port of the React admin `src/components/TagChip.tsx`.
 *
 * The chip takes a tag NAME (that is all an assignment stores) and resolves it
 * against the relevant vocabulary for its color and icon. A name with no
 * vocabulary entry behind it, a free-form tag or one whose definition was
 * removed, still renders: neutral and undecorated, but present and readable.
 * Dropping it would silently erase data the operator can see in Firestore.
 *
 * WHY THIS DOES NOT REUSE [AuntieChip]: the tag palette is seven brand tokens
 * wide (teal, orange, pink, purple, coral, gold, green) and [AuntieChipTone]
 * carries five, with no pink, coral, or green. Routing tags through it would
 * collapse three tokens onto the wrong swatch, so the pill is drawn here from the
 * same foundation primitives and the same [AuntieTheme] swatches AuntieChip uses.
 * Material3 contributes only [Text], per the kit rule.
 *
 * COLOR PORTING NOTE: React paints from `color.css`, a literal CSS var reference
 * ("var(--color-accent)"). Kotlin has no CSS variables, so it maps the stable
 * `color.token` onto the brand palette instead and never reads `css` at all. The
 * `css` string is still persisted untouched by the model layer so React keeps
 * painting; see TagModels.kt.
 */

/** The brand swatch a tag chip paints with, one per palette token plus the neutral miss. */
enum class TagPaintRole { Teal, Orange, Pink, Purple, Coral, Gold, Green, Neutral }

/**
 * Resolve a [TagColor] to the brand swatch that paints it.
 *
 * Two different "no color" cases, kept deliberately apart:
 *  - `null` means the NAME did not resolve against the vocabulary (a miss), which
 *    is the neutral chip.
 *  - A color whose token this build does not know is NOT a miss. It takes the
 *    palette default, matching [paletteColor], so a vocabulary written by a newer
 *    build still paints instead of turning grey.
 *
 * Token matching is exact and case-sensitive (the React rule), so "TEAL" is an
 * unknown token, not teal.
 */
fun tagPaintRole(color: TagColor?): TagPaintRole {
    if (color == null) return TagPaintRole.Neutral
    return when (paletteColor(color.token).token) {
        "orange" -> TagPaintRole.Orange
        "pink"   -> TagPaintRole.Pink
        "purple" -> TagPaintRole.Purple
        "coral"  -> TagPaintRole.Coral
        "gold"   -> TagPaintRole.Gold
        "green"  -> TagPaintRole.Green
        // "teal" and every unknown token, which paletteColor already folded onto
        // the default (teal).
        else     -> TagPaintRole.Teal
    }
}

/**
 * The swatch for a role, resolved through [AuntieColors] so a tag chip lands on
 * the same brand palette as the rest of the Den. Mirrors the resolver convention
 * in AuntieTones.kt.
 */
fun TagPaintRole.color(c: AuntieColors): Color = when (this) {
    TagPaintRole.Teal    -> c.accent
    TagPaintRole.Orange  -> c.primary
    TagPaintRole.Pink    -> c.secondary
    TagPaintRole.Purple  -> c.tertiary
    TagPaintRole.Coral   -> c.coral
    TagPaintRole.Gold    -> c.warning
    TagPaintRole.Green   -> c.success
    TagPaintRole.Neutral -> c.textDim
}

/** True when a resolved icon is worth rendering. Null (a miss) and "" (no emoji) are not. */
fun tagChipShowsIcon(icon: String?): Boolean = icon != null && icon != ""

/** Screen-reader label for the chip's remove affordance. */
fun tagChipRemoveLabel(name: String): String = "Remove $name tag"

/**
 * @param name     the tag NAME as stored on the assignment, resolved against [vocab].
 * @param vocab    the relevant vocabulary (household or pet). A name absent from it renders neutral.
 * @param onRemove when supplied, the chip shows an "x" that calls this.
 */
@Composable
fun TagChip(
    name: String,
    vocab: List<TagDef>,
    modifier: Modifier = Modifier,
    onRemove: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val resolved = resolveTag(name, vocab)
    val role = tagPaintRole(resolved.color)
    val tone = role.color(c)
    val neutral = role == TagPaintRole.Neutral

    // A neutral chip reads as glass with a plain border, so an unresolved tag is
    // visibly undecorated rather than looking like it owns a color.
    val fill = if (neutral) c.surfaceGlass else tone.copy(alpha = if (c.isDark) 0.18f else 0.12f).compositeOver(c.surface)
    val borderColor = if (neutral) c.border else tone.copy(alpha = 0.45f)
    val labelColor = if (neutral) c.textDim else c.textPrimary

    val shape = RoundedCornerShape(999.dp)

    Row(
        modifier = modifier
            .clip(shape)
            .background(fill)
            .border(BorderStroke(dims.borderHairline, SolidColor(borderColor)), shape)
            .padding(
                start = dims.space3,
                end = if (onRemove != null) dims.space2 else dims.space3,
                top = dims.space2,
                bottom = dims.space2,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        if (tagChipShowsIcon(resolved.icon)) {
            Text(text = resolved.icon.orEmpty(), style = AuntieTheme.typography.labelLarge)
        }
        Text(
            // The resolved name, so a tag assigned as "vip" renders the
            // vocabulary's "VIP".
            text = resolved.name,
            style = AuntieTheme.typography.labelLarge,
            color = labelColor,
        )
        if (onRemove != null) {
            TagChipRemove(
                tint = labelColor,
                label = tagChipRemoveLabel(resolved.name),
                onRemove = onRemove,
            )
        }
    }
}

/**
 * The clearable "x". Drawn with Canvas (no Material3 Icon), with its own hit
 * target and hover state, matching the AuntieChip token-chip affordance.
 */
@Composable
private fun TagChipRemove(
    tint: Color,
    label: String,
    onRemove: () -> Unit,
) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val bg by animateColorAsState(
        if (hovered) c.error.copy(alpha = 0.18f) else Color.Transparent,
        label = "tagChipRemoveBg",
    )
    val glyph by animateColorAsState(
        if (hovered) c.error else tint,
        label = "tagChipRemoveGlyph",
    )
    Box(
        modifier = Modifier
            .size(18.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onRemove,
            )
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(8.dp)) {
            val s = size.width
            val strokeWidth = s * 0.18f
            drawLine(color = glyph, start = Offset(0f, 0f), end = Offset(s, s), strokeWidth = strokeWidth)
            drawLine(color = glyph, start = Offset(s, 0f), end = Offset(0f, s), strokeWidth = strokeWidth)
        }
    }
}
