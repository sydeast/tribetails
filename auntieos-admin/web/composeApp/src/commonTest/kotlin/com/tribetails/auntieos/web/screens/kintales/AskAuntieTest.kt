package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.AUNTIE_TIMEOUT_MESSAGE
import com.tribetails.auntieos.web.data.ChecklistItem
import com.tribetails.auntieos.web.data.FieldResponse
import com.tribetails.auntieos.web.data.GenerateCareTask
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleTemplate
import com.tribetails.auntieos.web.data.responseKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * #2052 / #2079: Ask Auntie on the desktop composer. The draft is offered
 * beside the note, the typed notes can be put back, asking again never feeds a
 * draft back in as notes, and a failure is said in plain words.
 */
class AskAuntieTest {

    private val notes = "all ate, water topped up, quick play"
    private val draft = "Everyone ate. I was running late and locked up on the way out."

    // ── the notes are restorable ────────────────────────────────────────────

    @Test
    fun askingWorksFromTheNotesWhileTheNoteStillHoldsTheDraftAsWritten() {
        val kept = KeptNotes(notes = notes, draftBody = draft)
        assertEquals(notes, notesForAuntie(draft, kept))
    }

    @Test
    fun aNoteSheHasChangedIsHerWordsAgain() {
        val kept = KeptNotes(notes = notes, draftBody = draft)
        assertEquals("$draft And a walk.", notesForAuntie("$draft And a walk.", kept))
    }

    @Test
    fun withNothingKeptTheNoteIsTheNotes() {
        assertEquals(notes, notesForAuntie(notes, null))
    }

    @Test
    fun takingASecondDraftOverTheFirstStillKeepsWhatSheTyped() {
        // What the composer does on "Use this draft", twice over.
        val first = KeptNotes(notes = notesForAuntie(notes, null), draftBody = draft)
        val second = KeptNotes(notes = notesForAuntie(draft, first), draftBody = "Second draft.")
        assertEquals(notes, second.notes)
    }

    // ── the composer's own state: offered, taken, restored ──────────────────
    @Test
    fun aDraftOnOfferIsNotTheNoteAndKeepsNothing() {
        val state = AskAuntieState().offer(draft)
        assertEquals(draft, state.offered)
        assertNull(state.kept)
    }
    @Test
    fun takingTheDraftPutsItInTheNoteAndKeepsWhatSheTyped() {
        val (state, body) = assertNotNull(AskAuntieState().offer(draft).take(notes))
        assertEquals(draft, body)
        assertNull(state.offered)
        assertEquals(KeptNotes(notes = notes, draftBody = draft), state.kept)
    }
    @Test
    fun theNotesComeBackAndNothingIsKeptAfter() {
        val (taken, _) = assertNotNull(AskAuntieState().offer(draft).take(notes))
        val (restored, body) = assertNotNull(taken.restore())
        assertEquals(notes, body)
        assertEquals(AskAuntieState(), restored)
    }
    @Test
    fun theNotesComeBackEvenAfterSheEditedTheDraft() {
        val (taken, _) = assertNotNull(AskAuntieState().offer(draft).take(notes))
        // Editing the note changes the composer's text, never this state.
        assertEquals(notes, assertNotNull(taken.restore()).second)
    }
    @Test
    fun settingTheDraftAsideKeepsNothingAndOffersNothing() {
        assertEquals(AskAuntieState(), AskAuntieState().offer(draft).dismiss())
    }
    @Test
    fun aSecondDraftTakenOverTheFirstStillRestoresWhatSheTyped() {
        val (first, body1) = assertNotNull(AskAuntieState().offer(draft).take(notes))
        val (second, _) = assertNotNull(first.offer("Second draft.").take(body1))
        assertEquals(notes, assertNotNull(second.restore()).second)
    }
    @Test
    fun thereIsNothingToTakeOrRestoreWhenNothingIsHeld() {
        assertNull(AskAuntieState().take(notes))
        assertNull(AskAuntieState().restore())
    }
    // ── the button says what it is doing ────────────────────────────────────

    @Test
    fun theButtonSaysItIsWritingWhileItWaits() {
        assertEquals("Ask Auntie", askAuntieLabel(isGenerating = false, hasAskedBefore = false))
        assertEquals("Ask Auntie again", askAuntieLabel(isGenerating = false, hasAskedBefore = true))
        assertEquals("Auntie is writing…", askAuntieLabel(isGenerating = true, hasAskedBefore = false))
        assertEquals("Auntie is writing…", askAuntieLabel(isGenerating = true, hasAskedBefore = true))
    }

    // ── the ticked care tasks ───────────────────────────────────────────────

    private val session = KinCareSession(_id = "s1", serviceType = "Dog Walk")
    private val biscuit = Kin(_id = "k1", name = "Biscuit", species = "Dog")
    private val mochi = Kin(_id = "k2", name = "Mochi", species = "Cat")
    private val template = KinTaleTemplate(
        checklistEnabled = true,
        checklistItems = listOf(
            ChecklistItem(key = "fed", text = "Fed", scope = "PER_PET", order = 0),
            ChecklistItem(key = "gate", text = "Gate locked", scope = "PER_VISIT", order = 1),
            ChecklistItem(key = "meds", text = "Medications given", scope = "per_pet", order = 2),
        ),
    )

    private fun ticks(vararg pairs: Pair<String, String>, value: Boolean = true): Map<String, FieldResponse> =
        pairs.associate { (key, kinId) ->
            responseKey(key, kinId) to FieldResponse(fieldKey = key, kinId = kinId, boolValue = value)
        }

    @Test
    fun eachTickedTaskIsListedWithTheKinItWasFor() {
        val out = tickedCareTasks(
            template, session, listOf(biscuit, mochi), null,
            ticks("fed" to "k2", "gate" to "", "meds" to "k1"),
        )
        assertEquals(
            listOf(
                GenerateCareTask(text = "Gate locked", kin_name = ""),
                GenerateCareTask(text = "Medications given", kin_name = "Biscuit"),
                GenerateCareTask(text = "Fed", kin_name = "Mochi"),
            ),
            out,
        )
    }

    @Test
    fun anUntickedTaskIsNotReportedAsDone() {
        val out = tickedCareTasks(template, session, listOf(biscuit), null, ticks("fed" to "k1", value = false))
        assertEquals(emptyList(), out)
    }

    @Test
    fun aTickForAKinNotOnThisVisitIsNotReported() {
        val out = tickedCareTasks(template, session, listOf(biscuit), null, ticks("fed" to "k-not-here"))
        assertEquals(emptyList(), out)
    }

    @Test
    fun aChecklistThatIsSwitchedOffReportsNothing() {
        val off = template.copy(checklistEnabled = false)
        assertEquals(emptyList(), tickedCareTasks(off, session, listOf(biscuit), null, ticks("gate" to "")))
    }

    // ── failures are plain ──────────────────────────────────────────────────

    @Test
    fun thePlainSentenceTheGeneratorSendsIsShownAsSent() {
        val copy = "Auntie's draft kept bringing up Kiwi, who is not on this visit, so it was thrown away."
        assertEquals(copy, AskAuntieCopy.plain(copy))
    }

    @Test
    fun aStoredCodeIsNeverShown() {
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain("anthropic_api_key_not_configured"))
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain("generate_failed"))
        assertEquals(AskAuntieCopy.DAILY_LIMIT, AskAuntieCopy.plain("generate_rate_limit_exceeded"))
    }

    @Test
    fun anOlderGeneratorsIdsAndProviderErrorsAreNeverShown() {
        for (leak in listOf(
            "No Kinfolk with id \"kf_8f2a91\"",
            "Claude API error: 529 overloaded_error request_id=req_011",
            "Voice source file not found at /workspace/voice/01_Voice_Bible.md",
        )) {
            assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain(leak), leak)
        }
    }

    @Test
    fun aSignInTheGeneratorIsClosedToIsToldSoNotToldToTryAgain() {
        assertEquals(AskAuntieCopy.OWNER_ONLY, AskAuntieCopy.plain("admin_required"))
    }
    @Test
    fun aReplyWithNoMessageStillSaysSomethingPlain() {
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain(null))
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain("   "))
    }

    @Test
    fun aThrownFailureNeverShowsTheTransportsOwnWords() {
        val raw = IllegalStateException("generate failed (502): {\"error\":\"Claude API error: overloaded\"}")
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.forFailure(raw))
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.forFailure(RuntimeException("Connection reset by peer")))
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.forFailure(RuntimeException()))
    }

    @Test
    fun theAppsOwnPlainFailuresPassThrough() {
        assertEquals(AUNTIE_TIMEOUT_MESSAGE, AskAuntieCopy.forFailure(IllegalStateException(AUNTIE_TIMEOUT_MESSAGE)))
        assertEquals(AskAuntieCopy.SIGN_IN, AskAuntieCopy.forFailure(IllegalStateException(AskAuntieCopy.SIGN_IN)))
    }

    @Test
    fun noFailureCopyCarriesACodeADashOrDeveloperWording() {
        for (copy in listOf(
            AskAuntieCopy.FAILED, AskAuntieCopy.DAILY_LIMIT, AskAuntieCopy.SIGN_IN,
            AskAuntieCopy.NEEDS_NOTES, AskAuntieCopy.NO_KINFOLK, AskAuntieCopy.OWNER_ONLY,
        )) {
            assertFalse(Regex("[_—–]|\\b(id|error|generate|model)\\b").containsMatchIn(copy), copy)
        }
    }
}
