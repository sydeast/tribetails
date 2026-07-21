package com.tribetails.auntieos.web.ui.components

import com.tribetails.auntieos.web.data.DEFAULT_TAG_COLOR
import com.tribetails.auntieos.web.data.TagDef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Pins the profile Tags panel's pure state machine against the React admin
 * (auntieos-admin `src/components/ProfileTagsSection.tsx`).
 *
 * The behavior worth a test file of its own is the OPTIMISTIC SAVE. The chip
 * appears immediately, the write goes out, and a failure has to put the chip
 * back AND say so. A revert on its own is the exact failure mode the fail-loud
 * policy forbids: the operator taps a tag, watches it appear, watches it vanish,
 * and is told nothing. Every failure path below asserts BOTH halves, the
 * restored list and the visible message.
 *
 * The one deliberate exception is [beginPromoteVocab] rejecting a name: that is
 * not a failure, it is "this name is already in your vocabulary", and the
 * assignment it accompanies still goes through. See the test for it.
 */
class ProfileTagsSectionTest {

    private fun def(name: String) = TagDef(name = name, color = DEFAULT_TAG_COLOR, icon = "")

    private val vocab = listOf(def("VIP"), def("Reactive"))

    private fun state(
        tags: List<String> = listOf("VIP"),
        vocab: List<TagDef> = this.vocab,
    ) = ProfileTagsState(tags = tags, vocab = vocab)

    // ---- scope: wire values and copy ----

    @Test
    fun scope_wireValuesAreTheLowercaseReactLiterals() {
        // These are persisted / compared against React-authored data, so the
        // casing is load-bearing, not cosmetic.
        assertEquals("household", TagScope.HOUSEHOLD.wire)
        assertEquals("pet", TagScope.PET.wire)
    }

    @Test
    fun scope_copyMatchesTheReactPanel() {
        assertEquals(
            "Labels on this household. Broadcasts and KinTale rules can target them.",
            tagScopeSubtitle(TagScope.HOUSEHOLD),
        )
        assertEquals("Labels on this pet, e.g. Reactive or On meds.", tagScopeSubtitle(TagScope.PET))
        assertEquals("Add a household tag", tagScopeInputLabel(TagScope.HOUSEHOLD))
        assertEquals("Add a pet tag", tagScopeInputLabel(TagScope.PET))
    }

    // ---- error copy ----

    @Test
    fun errorCopy_matchesTheReactMessages() {
        assertEquals("Couldn't save tags: permission denied", tagSaveErrorMessage("permission denied"))
        assertEquals(
            "Couldn't load tag suggestions: offline",
            tagVocabLoadErrorMessage("offline"),
        )
        assertEquals(
            "Couldn't add that tag to your list: quota exceeded",
            tagVocabPromoteErrorMessage("quota exceeded"),
        )
    }

    @Test
    fun errorCopy_fallsBackWhenTheCauseHasNoMessage() {
        // React's `err instanceof Error ? err.message : 'Save failed'`. A blank
        // message must never produce a dangling "Couldn't save tags: ".
        assertEquals("Couldn't save tags: Save failed", tagSaveErrorMessage(null))
        assertEquals("Couldn't save tags: Save failed", tagSaveErrorMessage("   "))
        assertEquals("Couldn't load tag suggestions: Load failed", tagVocabLoadErrorMessage(""))
        assertEquals("Couldn't add that tag to your list: Save failed", tagVocabPromoteErrorMessage(null))
    }

    // ---- the optimistic save ----

    @Test
    fun beginSave_showsTheNewListImmediatelyAndRemembersHowToUndoIt() {
        val next = state().beginSave(listOf("VIP", "Reactive"))
        assertEquals(listOf("VIP", "Reactive"), next.tags)
        assertTrue(next.saving)
        assertEquals(listOf("VIP"), next.revertTags)
    }

    @Test
    fun beginSave_clearsAStaleErrorSoTheBannerTracksThisAttempt() {
        val stale = state().copy(saveError = "Couldn't save tags: boom")
        assertNull(stale.beginSave(listOf("VIP", "Reactive")).saveError)
    }

    @Test
    fun saveSucceeded_settlesAndDropsTheUndoSnapshot() {
        val next = state().beginSave(listOf("VIP", "Reactive")).saveSucceeded()
        assertEquals(listOf("VIP", "Reactive"), next.tags)
        assertFalse(next.saving)
        assertNull(next.revertTags)
        assertNull(next.saveError)
    }

    @Test
    fun saveFailed_revertsTheListAND_surfacesTheError() {
        // The whole point of this file. Both halves, every time.
        val next = state().beginSave(listOf("VIP", "Reactive")).saveFailed("permission denied")
        assertEquals(listOf("VIP"), next.tags)
        assertEquals("Couldn't save tags: permission denied", next.saveError)
        assertFalse(next.saving)
        assertNull(next.revertTags)
    }

    @Test
    fun saveFailed_neverRevertsSilently() {
        // Guards the specific regression: someone "simplifies" saveFailed down to
        // a revert and drops the message.
        val next = state().beginSave(listOf("VIP", "Reactive")).saveFailed(null)
        assertEquals(listOf("VIP"), next.tags)
        assertNotNull(next.saveError)
        assertTrue(next.saveError!!.isNotBlank())
    }

    @Test
    fun saveFailed_revertingARemovalPutsTheChipBack() {
        // Removal is the direction where a silent revert is most confusing: the
        // chip disappears, then reappears, with no explanation.
        val next = state(tags = listOf("VIP", "Reactive"))
            .beginSave(listOf("VIP"))
            .saveFailed("network")
        assertEquals(listOf("VIP", "Reactive"), next.tags)
        assertEquals("Couldn't save tags: network", next.saveError)
    }

    @Test
    fun saveFailed_withNoSaveInFlightLeavesTheListAloneButStillSpeaksUp() {
        // Defensive: a late failure with no snapshot must not blank the list.
        val next = state().saveFailed("late")
        assertEquals(listOf("VIP"), next.tags)
        assertEquals("Couldn't save tags: late", next.saveError)
    }

    @Test
    fun dismissSaveError_clearsOnlyTheBanner() {
        val failed = state().beginSave(listOf("VIP", "Reactive")).saveFailed("boom")
        val dismissed = failed.dismissSaveError()
        assertNull(dismissed.saveError)
        assertEquals(failed.tags, dismissed.tags)
    }

    // ---- vocabulary load ----

    @Test
    fun vocabLoaded_replacesTheSuggestionPoolAndClearsAnyLoadWarning() {
        val loaded = state(vocab = emptyList())
            .vocabLoadFailed("offline")
            .vocabLoaded(vocab)
        assertEquals(listOf("VIP", "Reactive"), loaded.vocab.map { it.name })
        assertNull(loaded.vocabError)
    }

    @Test
    fun vocabLoadFailed_warnsButLeavesTheFieldUsable() {
        // React keeps the field working on a vocabulary miss: you can still type a
        // free-form tag, you just get no suggestions and a warning banner.
        val next = state().vocabLoadFailed("offline")
        assertEquals("Couldn't load tag suggestions: offline", next.vocabError)
        assertEquals(listOf("VIP"), next.tags)
        assertNull(next.saveError)
    }

    // ---- inline vocabulary promotion ----

    @Test
    fun beginPromoteVocab_appendsADefaultColoredEntryAndMarksTheWritePending() {
        val next = state().beginPromoteVocab("On meds")
        assertEquals(listOf("VIP", "Reactive", "On meds"), next.vocab.map { it.name })
        val added = next.vocab.last()
        assertEquals(DEFAULT_TAG_COLOR, added.color)
        assertEquals("", added.icon)
        // revertVocab doubles as the "a vocabulary write is owed" signal.
        assertEquals(listOf("VIP", "Reactive"), next.revertVocab?.map { it.name })
    }

    @Test
    fun beginPromoteVocab_isAnUntouchedNoOpWhenTheNameIsAlreadyThere() {
        // The ONE intentional swallow, ported deliberately (React catches and
        // returns): the name is already a suggestion, so there is nothing to
        // persist, and the assignment itself is handled by the field's onChange.
        // Nothing failed, so nothing is reported.
        val before = state()
        val next = before.beginPromoteVocab("vip")
        assertSame(before, next)
        assertNull(next.revertVocab)
        assertNull(next.saveError)
    }

    @Test
    fun beginPromoteVocab_isANoOpForABlankOrOverlongName() {
        val before = state()
        assertSame(before, before.beginPromoteVocab("   "))
        assertSame(before, before.beginPromoteVocab("x".repeat(41)))
    }

    @Test
    fun beginPromoteVocab_acceptsANameExactlyAtTheCap() {
        val name = "x".repeat(40)
        assertEquals(name, state().beginPromoteVocab(name).vocab.last().name)
    }

    @Test
    fun promoteVocabSucceeded_settlesWithTheNewSuggestionKept() {
        val next = state().beginPromoteVocab("On meds").promoteVocabSucceeded()
        assertEquals(listOf("VIP", "Reactive", "On meds"), next.vocab.map { it.name })
        assertNull(next.revertVocab)
        assertNull(next.saveError)
    }

    @Test
    fun promoteVocabFailed_revertsTheVocabularyAND_surfacesTheError() {
        val next = state().beginPromoteVocab("On meds").promoteVocabFailed("quota exceeded")
        assertEquals(listOf("VIP", "Reactive"), next.vocab.map { it.name })
        assertEquals("Couldn't add that tag to your list: quota exceeded", next.saveError)
        assertNull(next.revertVocab)
    }

    @Test
    fun promoteVocabFailed_doesNotDisturbTheAssignedTags() {
        // The assignment and the vocabulary growth are two separate writes. A
        // failed vocabulary write must not yank the chip the operator just added.
        val next = state(tags = listOf("VIP", "On meds")).beginPromoteVocab("On meds")
            .promoteVocabFailed("quota exceeded")
        assertEquals(listOf("VIP", "On meds"), next.tags)
    }

    // ---- the two in-flight writes stay independent ----

    @Test
    fun aFailedTagSaveDoesNotRollBackAPendingVocabularyPromotion() {
        val next = state()
            .beginPromoteVocab("On meds")
            .beginSave(listOf("VIP", "On meds"))
            .saveFailed("network")
        assertEquals(listOf("VIP"), next.tags)
        assertEquals(listOf("VIP", "Reactive", "On meds"), next.vocab.map { it.name })
        assertEquals("Couldn't save tags: network", next.saveError)
    }
}
