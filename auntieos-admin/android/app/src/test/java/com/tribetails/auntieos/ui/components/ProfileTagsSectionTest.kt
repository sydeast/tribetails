package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

/**
 * Pure-JVM coverage for the ProfileTagsSection decision logic, pinned against
 * the React reference (auntieos-admin src/components/ProfileTagsSection.tsx).
 *
 * The load-bearing rule here is fail-loud: an optimistic save that fails must
 * revert the chips AND surface a message. A silent revert would leave the
 * operator believing a tag came off when it never did.
 */
class ProfileTagsSectionTest {

    private fun def(name: String) =
        TagDef(name = name, color = TagColor(token = "gold", css = "var(--color-warning)"), icon = "⭐")

    // ----- panel copy -----

    @Test
    fun `household copy matches the React panel`() {
        val copy = profileTagsCopy(TagScope.HOUSEHOLD)
        assertEquals(
            "Labels on this household. Broadcasts and KinTale rules can target them.",
            copy.subtitle,
        )
        assertEquals("Add a household tag", copy.inputLabel)
    }

    @Test
    fun `pet copy matches the React panel`() {
        val copy = profileTagsCopy(TagScope.PET)
        assertEquals("Labels on this pet, e.g. Reactive or On meds.", copy.subtitle)
        assertEquals("Add a pet tag", copy.inputLabel)
    }

    // ----- error copy -----

    @Test
    fun `a save failure carries the underlying message`() {
        assertEquals(
            "Couldn't save tags: PERMISSION_DENIED",
            tagSaveErrorMessage(IOException("PERMISSION_DENIED")),
        )
    }

    @Test
    fun `a save failure with no message still says something`() {
        assertEquals("Couldn't save tags: Save failed", tagSaveErrorMessage(IOException()))
        assertEquals("Couldn't save tags: Save failed", tagSaveErrorMessage(IOException("   ")))
        assertEquals("Couldn't save tags: Save failed", tagSaveErrorMessage(null))
    }

    @Test
    fun `a vocabulary load failure is a warning, not a blank field`() {
        assertEquals(
            "Couldn't load tag suggestions: offline",
            tagVocabLoadErrorMessage(IOException("offline")),
        )
        assertEquals("Couldn't load tag suggestions: Load failed", tagVocabLoadErrorMessage(IOException()))
    }

    @Test
    fun `a vocabulary promotion failure names what did not happen`() {
        assertEquals(
            "Couldn't add that tag to your list: nope",
            tagVocabAddErrorMessage(IOException("nope")),
        )
        assertEquals("Couldn't add that tag to your list: Save failed", tagVocabAddErrorMessage(null))
    }

    // ----- optimistic save outcome -----

    @Test
    fun `a successful save keeps the optimistic list and clears the error`() {
        val out = tagSaveOutcome(previous = listOf("VIP"), attempted = listOf("VIP", "Quiet"), error = null)
        assertEquals(listOf("VIP", "Quiet"), out.tags)
        assertNull(out.error)
    }

    @Test
    fun `a failed save reverts AND surfaces, never one without the other`() {
        val out = tagSaveOutcome(
            previous = listOf("VIP"),
            attempted = listOf("VIP", "Quiet"),
            error = IOException("PERMISSION_DENIED"),
        )
        assertEquals(listOf("VIP"), out.tags)
        assertEquals("Couldn't save tags: PERMISSION_DENIED", out.error)
    }

    @Test
    fun `a failed removal puts the tag back and says why`() {
        val out = tagSaveOutcome(
            previous = listOf("VIP", "Quiet"),
            attempted = listOf("VIP"),
            error = IOException("offline"),
        )
        assertEquals(listOf("VIP", "Quiet"), out.tags)
        assertNotNull(out.error)
    }

    // ----- vocabulary promotion outcome -----

    @Test
    fun `a successful promotion keeps the grown vocabulary`() {
        val next = listOf(def("VIP"), def("Grooming"))
        val out = tagVocabOutcome(previous = listOf(def("VIP")), attempted = next, error = null)
        assertEquals(listOf("VIP", "Grooming"), out.vocab.map { it.name })
        assertNull(out.error)
    }

    @Test
    fun `a failed promotion reverts the vocabulary and surfaces`() {
        val out = tagVocabOutcome(
            previous = listOf(def("VIP")),
            attempted = listOf(def("VIP"), def("Grooming")),
            error = IOException("nope"),
        )
        assertEquals(listOf("VIP"), out.vocab.map { it.name })
        assertEquals("Couldn't add that tag to your list: nope", out.error)
    }

    // ----- inline promotion -----

    @Test
    fun `promoting a new name appends a default-colored entry with no icon`() {
        val next = promoteTagToVocab(listOf(def("VIP")), "Grooming")
        assertNotNull(next)
        assertEquals(listOf("VIP", "Grooming"), next!!.map { it.name })
        val added = next.last()
        // The React default for an inline promotion is TEAL, and the css string
        // must be the literal React paints with (ProfileTagsSection.tsx:85).
        assertEquals("teal", added.color.token)
        assertEquals("var(--color-accent)", added.color.css)
        assertEquals("", added.icon)
    }

    @Test
    fun `promoting a name already in the vocabulary is the one intentional no-op`() {
        // React catches addTag and returns: the assignment itself is handled by
        // the field's onChange, so there is nothing to persist and nothing broke.
        assertNull(promoteTagToVocab(listOf(def("VIP")), "vip"))
        assertNull(promoteTagToVocab(listOf(def("VIP")), "  VIP "))
    }

    @Test
    fun `promoting a blank name is a no-op`() {
        assertNull(promoteTagToVocab(listOf(def("VIP")), "   "))
    }

    @Test
    fun `promoting an over-long name is a no-op, not a crash`() {
        // 40 is the authoring cap (React MAX_TAG_NAME_LENGTH).
        assertNull(promoteTagToVocab(emptyList(), "x".repeat(41)))
        assertNotNull(promoteTagToVocab(emptyList(), "x".repeat(40)))
    }

    @Test
    fun `promotion normalizes the stored name but keeps its casing`() {
        val next = promoteTagToVocab(emptyList(), "  Big   DOG ")
        assertEquals("Big DOG", next!!.single().name)
    }
}
