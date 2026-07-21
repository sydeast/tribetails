package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.ui.theme.DarkAuntieColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for the TagChip decision logic, pinned against the React
 * reference (auntieos-admin src/components/TagChip.tsx + lib/tags/model.ts).
 * The two Kotlin trees share no code, so these assertions are written from the
 * React source rather than from the commonMain twin.
 */
class TagChipTest {

    private fun def(name: String, token: String, css: String, icon: String) =
        TagDef(name = name, color = TagColor(token = token, css = css), icon = icon)

    private val vocab = listOf(
        def("VIP", "gold", "var(--color-warning)", "⭐"),
        def("On meds", "coral", "var(--color-coral)", "💊"),
        def("Quiet", "teal", "var(--color-accent)", ""),
    )

    // ----- resolution -----

    @Test
    fun `hit returns the vocab canonical name, icon and token`() {
        val s = tagChipState("VIP", vocab)
        assertEquals("VIP", s.label)
        assertEquals("⭐", s.icon)
        assertEquals("gold", s.token)
        assertFalse(s.neutral)
    }

    @Test
    fun `resolution is case-insensitive and prefers the vocab casing`() {
        // React resolveTag returns hit.name, not the passed casing (model.ts:91).
        assertEquals("VIP", tagChipState("vip", vocab).label)
        assertEquals("On meds", tagChipState("  ON   MEDS ", vocab).label)
    }

    @Test
    fun `a miss renders a neutral chip with the passed name unchanged`() {
        // A free-form tag, or one whose vocab entry was removed, must never error.
        val s = tagChipState("Runner", vocab)
        assertEquals("Runner", s.label)
        assertNull(s.icon)
        assertNull(s.token)
        assertTrue(s.neutral)
    }

    @Test
    fun `an empty icon collapses to no icon`() {
        // React draws the icon only when it is neither null nor "" (TagChip.tsx:34).
        val s = tagChipState("Quiet", vocab)
        assertNull(s.icon)
        assertFalse(s.neutral)
        assertEquals("teal", s.token)
    }

    @Test
    fun `remove label uses the resolved name`() {
        assertEquals("Remove VIP tag", tagChipState("vip", vocab).removeLabel)
        assertEquals("Remove Runner tag", tagChipState("Runner", vocab).removeLabel)
    }

    @Test
    fun `an empty vocabulary resolves everything neutral`() {
        val s = tagChipState("VIP", emptyList())
        assertTrue(s.neutral)
        assertEquals("VIP", s.label)
    }

    // ----- token to brand role -----

    @Test
    fun `every palette token maps to its brand role`() {
        assertEquals(TagToneRole.Teal, tagToneRole("teal"))
        assertEquals(TagToneRole.Orange, tagToneRole("orange"))
        assertEquals(TagToneRole.Pink, tagToneRole("pink"))
        assertEquals(TagToneRole.Purple, tagToneRole("purple"))
        assertEquals(TagToneRole.Coral, tagToneRole("coral"))
        assertEquals(TagToneRole.Gold, tagToneRole("gold"))
        assertEquals(TagToneRole.Green, tagToneRole("green"))
    }

    @Test
    fun `a null token is the neutral role`() {
        assertEquals(TagToneRole.Neutral, tagToneRole(null))
    }

    @Test
    fun `token lookup is case-sensitive and falls back to the default color`() {
        // React paletteColor matches the token exactly (model.ts:71) and falls
        // back to DEFAULT_TAG_COLOR (teal), never throwing. "GREEN" is therefore
        // an unknown token, not the green entry.
        assertEquals(TagToneRole.Teal, tagToneRole("GREEN"))
        assertEquals(TagToneRole.Teal, tagToneRole("chartreuse"))
        assertEquals(TagToneRole.Teal, tagToneRole(""))
    }

    @Test
    fun `roles resolve onto the brand palette, neutral to the dim text color`() {
        val c = DarkAuntieColors
        assertEquals(c.accent, TagToneRole.Teal.color(c))
        assertEquals(c.primary, TagToneRole.Orange.color(c))
        assertEquals(c.secondary, TagToneRole.Pink.color(c))
        assertEquals(c.tertiary, TagToneRole.Purple.color(c))
        assertEquals(c.coral, TagToneRole.Coral.color(c))
        assertEquals(c.warning, TagToneRole.Gold.color(c))
        assertEquals(c.success, TagToneRole.Green.color(c))
        assertEquals(c.textDim, TagToneRole.Neutral.color(c))
    }
}
