package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.resolveTag
import com.tribetails.auntieos.ui.theme.AuntieColors
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * A single tag chip: the resolved emoji + name, tinted to the tag's palette
 * color. Ported from the React admin (auntieos-admin src/components/TagChip.tsx);
 * the two Kotlin trees share no code, so this is an independent port written
 * from that source and TagChipTest.kt pins the behaviour.
 *
 * A name with no vocabulary entry (a free-form tag, or one whose definition was
 * removed) resolves to a NEUTRAL chip rather than an error, matching
 * [resolveTag]: a tag never "breaks" when its definition changes.
 *
 * React paints from the stored `color.css` string ("var(--color-accent)").
 * Android has no CSS variables, so it paints by TOKEN from the Den brand
 * palette instead and leaves the stored css string strictly alone. Nothing in
 * this file writes to a doc, so the round-trip stays intact.
 */

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Which brand role a palette token paints with. Follows the AuntieTones
 * convention (an enum plus a resolver taking [AuntieColors]) so a chip never
 * hardcodes a color and a token edit reaches every surface.
 *
 * [Neutral] is not a palette token: it is the "no vocabulary entry" chip.
 */
enum class TagToneRole { Teal, Orange, Pink, Purple, Coral, Gold, Green, Neutral }

/** Resolve a tone role onto the live theme. Neutral reads as quiet body text. */
fun TagToneRole.color(c: AuntieColors): Color = when (this) {
    TagToneRole.Teal    -> c.accent
    TagToneRole.Orange  -> c.primary
    TagToneRole.Pink    -> c.secondary
    TagToneRole.Purple  -> c.tertiary
    TagToneRole.Coral   -> c.coral
    TagToneRole.Gold    -> c.warning
    TagToneRole.Green   -> c.success
    TagToneRole.Neutral -> c.textDim
}

/**
 * Map a stored palette token onto a brand role. The lookup is EXACT and
 * case-SENSITIVE (the token is a stable identifier, not user copy), mirroring
 * React's `paletteColor`: an unknown token falls back to the default entry
 * (teal) rather than throwing, so a hand-edited doc still renders.
 *
 * A null token means the name had no vocabulary entry at all, which is the
 * neutral chip and a different thing from an unrecognised token.
 */
fun tagToneRole(token: String?): TagToneRole = when (token) {
    null      -> TagToneRole.Neutral
    "teal"    -> TagToneRole.Teal
    "orange"  -> TagToneRole.Orange
    "pink"    -> TagToneRole.Pink
    "purple"  -> TagToneRole.Purple
    "coral"   -> TagToneRole.Coral
    "gold"    -> TagToneRole.Gold
    "green"   -> TagToneRole.Green
    else      -> TagToneRole.Teal // unknown token -> DEFAULT_TAG_COLOR, never an error
}

/** Everything a chip draws, derived from an assigned NAME plus a vocabulary. */
data class TagChipState(
    /** The vocabulary's canonical casing on a hit; the passed name on a miss. */
    val label: String,
    /** The emoji to draw, or null when there is none (a miss, or an "" icon). */
    val icon: String?,
    /** The palette token to paint with, or null on a neutral chip. */
    val token: String?,
    /** True when the name has no vocabulary entry. */
    val neutral: Boolean,
    /** The accessibility label on the remove affordance. */
    val removeLabel: String,
)

/**
 * Resolve an assigned tag NAME against a vocabulary into what the chip draws.
 * Never throws: an unknown name is a neutral chip, not an error state.
 */
fun tagChipState(name: String, vocab: List<TagDef>): TagChipState {
    val resolved = resolveTag(name, vocab)
    return TagChipState(
        label = resolved.name,
        // React draws the icon only when it is neither null nor "" (a vocab
        // entry with "No emoji" set), so both collapse to null here.
        icon = resolved.icon?.takeIf { it.isNotEmpty() },
        token = resolved.color?.token,
        neutral = resolved.color == null,
        removeLabel = "Remove ${resolved.name} tag",
    )
}

// ── composable ───────────────────────────────────────────────────────────────

/**
 * The chip itself: a pill of the tone washed over the surface, with a hairline
 * border in the same tone. When [onRemove] is supplied the chip grows a small
 * × (the assign field's remove affordance); omit it for a read-only chip.
 *
 * @param name    The tag NAME as stored on the assignment.
 * @param vocab   The relevant vocabulary (household or pet) for color/icon.
 * @param onRemove Optional. Shows the × and fires on tap.
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
    val state = remember(name, vocab) { tagChipState(name, vocab) }
    val tone = tagToneRole(state.token).color(c)

    val shape = RoundedCornerShape(999.dp)
    // Wash strength matches AuntieBanner: a touch stronger in dark for legibility.
    val fillAlpha = if (c.isDark) 0.16f else 0.10f

    Row(
        modifier = modifier
            .clip(shape)
            .background(tone.copy(alpha = fillAlpha))
            .border(dims.borderHairline, SolidColor(tone.copy(alpha = 0.45f)), shape)
            .padding(
                start = 10.dp,
                end = if (onRemove != null) 2.dp else 10.dp,
                top = 4.dp,
                bottom = 4.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (state.icon != null) {
            Text(text = state.icon, style = AuntieTheme.typography.bodySmall)
        }
        Text(
            text = state.label,
            style = AuntieTheme.typography.labelMedium,
            color = if (state.neutral) c.textDim else c.textPrimary,
        )
        if (onRemove != null) {
            AuntieIconButton(
                icon = Lucide.X,
                contentDescription = state.removeLabel,
                onClick = onRemove,
                size = 28.dp,
                destructive = true,
            )
        }
    }
}
