package com.tribetails.auntieos.web.screens.settings

import androidx.compose.ui.graphics.Color
import com.tribetails.auntieos.web.data.TAG_PALETTE
import com.tribetails.auntieos.web.data.TagColor
import com.tribetails.auntieos.web.data.TagDef
import com.tribetails.auntieos.web.theme.DarkAuntieColors
import com.tribetails.auntieos.web.theme.LightAuntieColors
import com.tribetails.auntieos.web.ui.components.color
import com.tribetails.auntieos.web.ui.components.tagPaintRole
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure helpers behind the Business-settings Tags panel (the vocabulary editor).
 *
 * The panel is a thin Compose shell over these; everything decidable without a
 * composition lives here so it can be pinned. The tag RULES (normalize, dedupe,
 * cap, edit) are not retested here: they belong to TagModels.kt and are covered
 * by TagModelsTest. What is left is what a port gets wrong: painting by TOKEN
 * rather than by parsing the React `css` string, the pickers' copy, and a dirty
 * check that treats `css` as real data instead of decoration.
 */
class TagVocabularyPanelTest {

    // ── Painting ──────────────────────────────────────────────────────────────
    // The picker paints through the shared tagPaintRole resolver (TagChip.kt), so
    // the swatch the operator picks is the color the chip gets. What is worth
    // pinning here is the composition the picker relies on, not the resolver itself.

    @Test fun `every palette swatch is visually distinct, in both themes`() {
        // A palette entry whose token has no role would fall through to the default
        // and two swatches would look identical: still clickable, but no longer
        // telling the operator which one they picked.
        listOf(DarkAuntieColors, LightAuntieColors).forEach { c ->
            val painted = TAG_PALETTE.map { tagPaintRole(it).color(c) }
            assertEquals(TAG_PALETTE.size, painted.toSet().size, "two palette swatches paint alike")
        }
    }

    @Test fun `the dark swatches match the React dark tokens`() {
        // React resolves these tokens in its own theme (tokens.css); Kotlin paints
        // from its brand roles and never reads that file. They agree today, and this
        // pins it, so a swatch in one admin is the same swatch in the other.
        val c = DarkAuntieColors
        fun paint(token: String) = tagPaintRole(TagColor(token, "")).color(c)
        assertEquals(Color(0xFF1FA0B0), paint("teal"))   // --color-accent
        assertEquals(Color(0xFFF09446), paint("orange")) // --color-primary
        assertEquals(Color(0xFFE07499), paint("pink"))   // --color-secondary
        assertEquals(Color(0xFF8E6BA6), paint("purple")) // --color-tertiary
        assertEquals(Color(0xFFE76E75), paint("coral"))  // --color-coral
        assertEquals(Color(0xFFFFB458), paint("gold"))   // --color-warning
        assertEquals(Color(0xFF4CAF7D), paint("green"))  // --color-success
    }

    // ── Swatch labels ─────────────────────────────────────────────────────────

    @Test fun `swatch labels cover the seven tokens`() {
        assertEquals("Teal",   tagColorLabel("teal"))
        assertEquals("Orange", tagColorLabel("orange"))
        assertEquals("Pink",   tagColorLabel("pink"))
        assertEquals("Purple", tagColorLabel("purple"))
        assertEquals("Coral",  tagColorLabel("coral"))
        assertEquals("Gold",   tagColorLabel("gold"))
        assertEquals("Green",  tagColorLabel("green"))
    }

    @Test fun `an unknown token labels itself rather than going blank`() {
        assertEquals("chartreuse", tagColorLabel("chartreuse"))
        assertEquals("TEAL", tagColorLabel("TEAL"))
    }

    // ── Curated emoji ─────────────────────────────────────────────────────────

    @Test fun `the curated emoji set matches the authoring surface, in order`() {
        assertEquals(
            listOf("⭐", "🐾", "❤️", "🔥", "🦴", "🏠", "🚩", "💊", "🍗", "⚠️", "✅", "💤", "🌙", "📌"),
            CURATED_TAG_EMOJI,
        )
    }

    @Test fun `a typed icon is capped, not rejected`() {
        assertEquals("🐾", clampTagIcon("🐾"))
        assertEquals("", clampTagIcon(""))
        assertEquals("abcdefgh", clampTagIcon("abcdefghij"))
        assertEquals(MAX_TAG_ICON_LENGTH, clampTagIcon("xxxxxxxxxxxxxx").length)
    }

    // ── Dirty check ───────────────────────────────────────────────────────────

    private val vip = TagDef(name = "VIP", color = TagColor("gold", "var(--color-warning)"), icon = "⭐")
    private val reactive = TagDef(name = "Reactive", color = TagColor("coral", "var(--color-coral)"), icon = "⚠️")

    @Test fun `an untouched vocabulary is not dirty`() {
        assertFalse(
            tagVocabularyDirty(
                baseHousehold = listOf(vip), basePet = listOf(reactive),
                household = listOf(vip), pet = listOf(reactive),
            ),
        )
    }

    @Test fun `editing either list marks the panel dirty`() {
        assertTrue(
            tagVocabularyDirty(
                baseHousehold = listOf(vip), basePet = listOf(reactive),
                household = listOf(vip, TagDef(name = "Slow pay")), pet = listOf(reactive),
            ),
        )
        assertTrue(
            tagVocabularyDirty(
                baseHousehold = listOf(vip), basePet = listOf(reactive),
                household = listOf(vip), pet = emptyList(),
            ),
        )
    }

    @Test fun `a css-only difference counts as a real change`() {
        // `css` is React's paint value and this tree round-trips it untouched. If the
        // dirty check ignored it, a Kotlin save could quietly drop or stale it.
        assertTrue(
            tagVocabularyDirty(
                baseHousehold = listOf(vip),
                basePet = emptyList(),
                household = listOf(vip.copy(color = TagColor("gold", "var(--color-gold)"))),
                pet = emptyList(),
            ),
        )
    }
}
