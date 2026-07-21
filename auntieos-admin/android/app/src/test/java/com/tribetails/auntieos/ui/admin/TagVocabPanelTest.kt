package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.encodeTagDefs
import com.tribetails.auntieos.data.model.paletteColor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for the Den admin Tags vocabulary panel, ported from the
 * React admin's TagsEditor screen (auntieos-admin src/screens/TagsEditor.tsx).
 *
 * The panel is the AUTHORING surface for the two vocabularies, so the copy and
 * the palette/emoji sets are pinned literally here: an operator who names a tag
 * in the Den and an operator who names it in the React admin must hit the same
 * caps and read the same error. The add-error strings especially are user-facing
 * copy, not internal messages.
 */
class TagVocabPanelTest {

    private fun vocab(): List<TagDef> = listOf(
        TagDef(name = "VIP", color = paletteColor("gold"), icon = "⭐"),
        TagDef(name = "Slow pay", color = paletteColor("coral"), icon = ""),
    )

    // ── Scope plumbing: which settings field a scope reads and writes ────────

    @Test
    fun `reads the vocabulary for each scope off business settings`() {
        val settings = BusinessSettings(
            householdTags = encodeTagDefs(vocab()),
            petTags = encodeTagDefs(listOf(TagDef(name = "Reactive", color = paletteColor("coral"), icon = "⚠️"))),
        )
        assertEquals(listOf("VIP", "Slow pay"), tagVocabFor(settings, TagScope.HOUSEHOLD).map { it.name })
        assertEquals(listOf("Reactive"), tagVocabFor(settings, TagScope.PET).map { it.name })
    }

    @Test
    fun `an absent vocabulary reads as empty, never an error`() {
        val settings = BusinessSettings()
        assertEquals(emptyList<TagDef>(), tagVocabFor(settings, TagScope.HOUSEHOLD))
        assertEquals(emptyList<TagDef>(), tagVocabFor(settings, TagScope.PET))
    }

    @Test
    fun `writing one scope leaves the other scope untouched`() {
        val base = BusinessSettings(petTags = encodeTagDefs(vocab()))
        val next = settingsWithTagVocab(base, TagScope.HOUSEHOLD, listOf(vocab()[0]))
        assertEquals(listOf("VIP"), tagVocabFor(next, TagScope.HOUSEHOLD).map { it.name })
        assertEquals(listOf("VIP", "Slow pay"), tagVocabFor(next, TagScope.PET).map { it.name })
    }

    @Test
    fun `a written vocabulary round-trips the color css string unchanged`() {
        // The drift guard that matters: React paints its chips from `color.css`,
        // so a Den save that dropped or rewrote it would blank the React admin.
        val next = settingsWithTagVocab(BusinessSettings(), TagScope.PET, vocab())
        assertEquals(
            listOf("var(--color-warning)", "var(--color-coral)"),
            tagVocabFor(next, TagScope.PET).map { it.color.css },
        )
    }

    // ── Add gating + the verbatim error copy ────────────────────────────────

    @Test
    fun `a valid new name has no add error`() {
        assertNull(tagVocabAddError(vocab(), "Puppy"))
    }

    @Test
    fun `a blank name reports the required-name copy`() {
        assertEquals("A tag name is required.", tagVocabAddError(vocab(), "   "))
    }

    @Test
    fun `a name over forty characters reports the length copy`() {
        // 40 matches the React authoring cap, deliberately tighter than the
        // backend's 60, so a Den-authored name can never trip a backend validator.
        assertEquals(
            "A tag name must be 40 characters or fewer.",
            tagVocabAddError(vocab(), "x".repeat(41)),
        )
        assertNull(tagVocabAddError(vocab(), "x".repeat(40)))
    }

    @Test
    fun `a duplicate name is rejected case-insensitively with the normalized name quoted`() {
        assertEquals("A \"vip\" tag already exists.", tagVocabAddError(vocab(), "  vip  "))
        // The quoted name is the NORMALIZED one, so the internal run collapses.
        assertEquals("A \"Slow pay\" tag already exists.", tagVocabAddError(vocab(), " Slow  pay "))
    }

    @Test
    fun `the length check runs before the duplicate check`() {
        // A blank name can never also be over the cap, so ordering is proved by a
        // duplicate that is ALSO over the cap: the length copy wins.
        val long = List(2) { TagDef(name = "y".repeat(41), color = paletteColor("teal"), icon = "") }
        assertEquals(
            "A tag name must be 40 characters or fewer.",
            tagVocabAddError(long, "y".repeat(41)),
        )
    }

    @Test
    fun `the add button is enabled only for a non-blank normalized name`() {
        assertTrue(tagVocabAddEnabled("VIP"))
        assertFalse(tagVocabAddEnabled(""))
        assertFalse(tagVocabAddEnabled("   \t "))
    }

    // ── Dirty tracking: the Save button only lights on a real change ─────────

    @Test
    fun `an untouched vocabulary is not dirty`() {
        assertFalse(tagVocabDirty(vocab(), vocab()))
    }

    @Test
    fun `a recolored entry is dirty even though the name list is identical`() {
        val recolored = listOf(vocab()[0].copy(color = paletteColor("green")), vocab()[1])
        assertTrue(tagVocabDirty(vocab(), recolored))
    }

    @Test
    fun `a reordered vocabulary is dirty`() {
        assertTrue(tagVocabDirty(vocab(), vocab().reversed()))
    }

    // ── Copy + picker sets, pinned against the React authoring surface ───────

    @Test
    fun `color swatch labels match the React accessible labels`() {
        assertEquals("Teal", tagColorLabel("teal"))
        assertEquals("Orange", tagColorLabel("orange"))
        assertEquals("Pink", tagColorLabel("pink"))
        assertEquals("Purple", tagColorLabel("purple"))
        assertEquals("Coral", tagColorLabel("coral"))
        assertEquals("Gold", tagColorLabel("gold"))
        assertEquals("Green", tagColorLabel("green"))
    }

    @Test
    fun `an unknown color token falls back to the raw token, never a crash`() {
        assertEquals("chartreuse", tagColorLabel("chartreuse"))
        assertEquals("", tagColorLabel(""))
    }

    @Test
    fun `the curated emoji set is the fourteen React offers, in order`() {
        assertEquals(
            listOf("⭐", "🐾", "❤️", "🔥", "🦴", "🏠", "🚩", "💊", "🍗", "⚠️", "✅", "💤", "🌙", "📌"),
            CURATED_TAG_EMOJI,
        )
    }

    @Test
    fun `the custom emoji field caps at eight characters`() {
        assertEquals(8, MAX_TAG_EMOJI_LENGTH)
        assertEquals("12345678", clampTagEmoji("1234567890"))
        assertEquals("⭐", clampTagEmoji("⭐"))
        assertEquals("", clampTagEmoji(""))
    }

    @Test
    fun `the empty-vocabulary hint names the scope`() {
        assertEquals("No household tags yet. Add one below.", emptyTagVocabHint("household"))
        assertEquals("No pet tags yet. Add one below.", emptyTagVocabHint("pet"))
    }
}
