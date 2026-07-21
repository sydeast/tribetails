package com.tribetails.auntieos.web.ui.components

import com.tribetails.auntieos.web.data.DEFAULT_TAG_COLOR
import com.tribetails.auntieos.web.data.TAG_PALETTE
import com.tribetails.auntieos.web.data.TagColor
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.data.resolveTag
import com.tribetails.auntieos.web.theme.DarkAuntieColors
import com.tribetails.auntieos.web.theme.LightAuntieColors
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pins the tag chip's pure paint decisions against the React admin
 * (auntieos-admin `src/components/TagChip.tsx`).
 *
 * React paints a chip straight from `color.css`, a literal CSS var reference.
 * Kotlin has no CSS variables, so it paints from the brand palette by TOKEN
 * instead. That substitution is the whole reason this file exists: the mapping
 * has to be exhaustive over the seven palette tokens, and it has to keep the two
 * "no color" cases apart, because they mean different things.
 *
 *   - A resolve MISS (color == null, an unknown / free-form / de-vocabularied
 *     name) is the NEUTRAL chip. React's `tag-chip--neutral`. The tag still
 *     renders, degraded but visible, never dropped.
 *   - A resolved color carrying an UNKNOWN token is NOT neutral. It falls back
 *     to the palette default (teal), matching `paletteColor`, so a vocabulary
 *     written by a newer build still paints instead of going grey.
 */
class TagChipTest {

    // ---- token -> brand role ----

    @Test
    fun paintRole_mapsEverySevenPaletteTokens() {
        val roles = TAG_PALETTE.map { tagPaintRole(it) }
        assertEquals(
            listOf(
                TagPaintRole.Teal,
                TagPaintRole.Orange,
                TagPaintRole.Pink,
                TagPaintRole.Purple,
                TagPaintRole.Coral,
                TagPaintRole.Gold,
                TagPaintRole.Green,
            ),
            roles,
        )
    }

    @Test
    fun paintRole_nullColorIsNeutral() {
        // The resolve MISS: a name with no vocabulary entry behind it.
        assertEquals(TagPaintRole.Neutral, tagPaintRole(null))
    }

    @Test
    fun paintRole_unknownTokenFallsBackToTheDefaultNotNeutral() {
        // Mirrors paletteColor: an unknown token is a forward-compatibility case,
        // not a miss, so it paints the default (teal) rather than going grey.
        assertEquals(TagPaintRole.Teal, tagPaintRole(TagColor(token = "chartreuse", css = "var(--x)")))
        assertEquals(TagPaintRole.Teal, tagPaintRole(TagColor(token = "", css = "")))
    }

    @Test
    fun paintRole_tokenMatchIsCaseSensitive() {
        // Unlike names, tokens compare exactly (React: `c.token === token`), so an
        // uppercased token is unknown and takes the default, not the teal branch
        // by accident.
        assertEquals(TagPaintRole.Teal, tagPaintRole(TagColor(token = "TEAL", css = "var(--color-accent)")))
        // A genuinely different token that differs only in case must not resolve.
        assertEquals(TagPaintRole.Teal, tagPaintRole(TagColor(token = "GREEN", css = "var(--color-success)")))
    }

    // ---- brand role -> swatch ----

    @Test
    fun paintRole_resolvesToTheBrandSwatchOnBothSchemes() {
        for (c in listOf(DarkAuntieColors, LightAuntieColors)) {
            assertEquals(c.accent, TagPaintRole.Teal.color(c))
            assertEquals(c.primary, TagPaintRole.Orange.color(c))
            assertEquals(c.secondary, TagPaintRole.Pink.color(c))
            assertEquals(c.tertiary, TagPaintRole.Purple.color(c))
            assertEquals(c.coral, TagPaintRole.Coral.color(c))
            assertEquals(c.warning, TagPaintRole.Gold.color(c))
            assertEquals(c.success, TagPaintRole.Green.color(c))
            assertEquals(c.textDim, TagPaintRole.Neutral.color(c))
        }
    }

    @Test
    fun paintRole_everyRoleResolvesToADistinctSwatch() {
        // Two tokens painting the same color would make them indistinguishable on
        // a chip, which defeats the point of a seven-color palette.
        val swatches = TagPaintRole.entries.map { it.color(DarkAuntieColors) }
        assertEquals(swatches.size, swatches.toSet().size)
    }

    // ---- icon visibility ----

    @Test
    fun showsIcon_onlyForANonEmptyEmoji() {
        // React: `resolved.icon !== null && resolved.icon !== ''`.
        assertTrue(tagChipShowsIcon("⭐"))
        assertFalse(tagChipShowsIcon(""))
        assertFalse(tagChipShowsIcon(null))
    }

    @Test
    fun showsIcon_treatsAWhitespaceIconAsPresent() {
        // React compares against '' exactly, it does not trim. A whitespace icon is
        // a data problem, not something this helper silently normalizes away.
        assertTrue(tagChipShowsIcon(" "))
    }

    // ---- remove affordance copy ----

    @Test
    fun removeLabel_matchesTheReactAriaLabel() {
        assertEquals("Remove VIP tag", tagChipRemoveLabel("VIP"))
    }

    @Test
    fun removeLabel_usesTheResolvedCanonicalName() {
        // The chip labels itself with the name resolveTag hands back, so a tag
        // assigned as "vip" announces as the vocabulary's "VIP".
        val vocab = listOf(TagDef(name = "VIP", color = DEFAULT_TAG_COLOR, icon = ""))
        assertEquals("Remove VIP tag", tagChipRemoveLabel(resolveTag("vip", vocab).name))
    }

    // ---- the degraded chip still renders ----

    @Test
    fun unresolvedName_stillCarriesItsNameAndPaintsNeutral() {
        // The rule that keeps a removed vocabulary entry from erasing a tag: the
        // name survives, only the decoration is lost.
        val resolved = resolveTag("Left over", vocab = emptyList())
        assertEquals("Left over", resolved.name)
        assertEquals(TagPaintRole.Neutral, tagPaintRole(resolved.color))
        assertFalse(tagChipShowsIcon(resolved.icon))
    }

    @Test
    fun resolvedName_paintsItsVocabularyColorAndIcon() {
        val vocab = listOf(
            TagDef(name = "Reactive", color = TagColor("coral", "var(--color-coral)"), icon = "⚠️"),
        )
        val resolved = resolveTag("reactive", vocab)
        assertEquals("Reactive", resolved.name)
        assertEquals(TagPaintRole.Coral, tagPaintRole(resolved.color))
        assertTrue(tagChipShowsIcon(resolved.icon))
    }
}
