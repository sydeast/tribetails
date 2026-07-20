package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for the TagAssignField decision logic, pinned against the
 * React reference (auntieos-admin src/components/TagAssignField.tsx and
 * src/lib/tags/assign.ts). Written from the React source: the android tree
 * shares no code with commonMain, so this is an independent port.
 */
class TagAssignFieldTest {

    private fun def(name: String, icon: String = "") =
        TagDef(name = name, color = TagColor(token = "teal", css = "var(--color-accent)"), icon = icon)

    private val vocab = listOf(def("VIP", "⭐"), def("On meds", "💊"), def("Vet visit"), def("Quiet"))

    private fun names(list: List<TagDef>) = list.map { it.name }

    // ----- suggestions -----

    @Test
    fun `a blank query offers the whole unassigned pool in vocab order`() {
        val s = tagAssignState(draft = "   ", vocab = vocab, value = listOf("Quiet"), allowCreate = true)
        assertEquals(listOf("VIP", "On meds", "Vet visit"), names(s.suggestions))
    }

    @Test
    fun `prefix matches rank before substring matches`() {
        // "vi" prefixes "Vet visit"? No: it prefixes nothing, but "VIP" starts
        // with "vi" case-insensitively, and "Vet visit" only contains it.
        val s = tagAssignState(draft = "vi", vocab = vocab, value = emptyList(), allowCreate = true)
        assertEquals(listOf("VIP", "Vet visit"), names(s.suggestions))
    }

    @Test
    fun `a prefix match never also appears in the contains list`() {
        val s = tagAssignState(draft = "v", vocab = vocab, value = emptyList(), allowCreate = true)
        assertEquals(listOf("VIP", "Vet visit"), names(s.suggestions))
    }

    @Test
    fun `already assigned tags are excluded case-insensitively`() {
        val s = tagAssignState(draft = "", vocab = vocab, value = listOf("vip", "ON MEDS"), allowCreate = true)
        assertEquals(listOf("Vet visit", "Quiet"), names(s.suggestions))
    }

    // ----- the typed draft -----

    @Test
    fun `the draft is normalized, not lowercased`() {
        val s = tagAssignState(draft = "  Big   Dog  ", vocab = vocab, value = emptyList(), allowCreate = true)
        assertEquals("Big Dog", s.trimmed)
    }

    // ----- the create affordance -----

    @Test
    fun `a new name can be promoted to the vocabulary`() {
        val s = tagAssignState(draft = "Grooming", vocab = vocab, value = emptyList(), allowCreate = true)
        assertTrue(s.canCreate)
        assertEquals("Add \"Grooming\" to your tags", s.createLabel)
    }

    @Test
    fun `a name already in the vocabulary is not offered for creation`() {
        // Case-insensitive, like every other name comparison in the tag layer.
        assertFalse(tagAssignState("vip", vocab, emptyList(), allowCreate = true).canCreate)
        assertFalse(tagAssignState("  On   Meds ", vocab, emptyList(), allowCreate = true).canCreate)
    }

    @Test
    fun `a blank draft is never creatable`() {
        assertFalse(tagAssignState("", vocab, emptyList(), allowCreate = true).canCreate)
        assertFalse(tagAssignState("   ", vocab, emptyList(), allowCreate = true).canCreate)
    }

    @Test
    fun `creation is off when the caller does not accept new vocabulary`() {
        assertFalse(tagAssignState("Grooming", vocab, emptyList(), allowCreate = false).canCreate)
    }

    // ----- list visibility -----

    @Test
    fun `the suggestion list shows only while focused and non-empty`() {
        val withSuggestions = tagAssignState("v", vocab, emptyList(), allowCreate = false)
        assertTrue(shouldShowSuggestionList(focused = true, state = withSuggestions))
        assertFalse(shouldShowSuggestionList(focused = false, state = withSuggestions))
    }

    @Test
    fun `the create affordance alone is enough to show the list`() {
        val onlyCreate = tagAssignState("Grooming", vocab, listOf("VIP", "On meds", "Vet visit", "Quiet"), true)
        assertTrue(onlyCreate.suggestions.isEmpty())
        assertTrue(shouldShowSuggestionList(focused = true, state = onlyCreate))
    }

    @Test
    fun `nothing to offer keeps the list closed`() {
        val nothing = tagAssignState("zzz", vocab, emptyList(), allowCreate = false)
        assertTrue(nothing.suggestions.isEmpty())
        assertFalse(shouldShowSuggestionList(focused = true, state = nothing))
    }

    // ----- assignment -----

    @Test
    fun `assigning prefers the vocabulary canonical casing`() {
        assertEquals(listOf("VIP"), tagAssignAdd(emptyList(), vocab, "vip"))
        assertEquals(listOf("On meds"), tagAssignAdd(emptyList(), vocab, "  on   MEDS "))
    }

    @Test
    fun `assigning a free-form name stores it as typed, normalized`() {
        assertEquals(listOf("Big Dog"), tagAssignAdd(emptyList(), vocab, "  Big   Dog "))
    }

    @Test
    fun `assigning appends at the end and dedupes case-insensitively`() {
        assertEquals(listOf("Quiet", "VIP"), tagAssignAdd(listOf("Quiet"), vocab, "vip"))
        assertEquals(listOf("VIP"), tagAssignAdd(listOf("VIP"), vocab, "vip"))
    }

    @Test
    fun `assigning a blank name is a no-op`() {
        assertEquals(listOf("VIP"), tagAssignAdd(listOf("VIP"), vocab, "   "))
    }
}
