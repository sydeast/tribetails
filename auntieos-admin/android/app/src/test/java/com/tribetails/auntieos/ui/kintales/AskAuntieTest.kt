package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.FieldResponse
import com.tribetails.auntieos.data.model.GenerateCareTask
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.KinTaleTemplate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.net.UnknownHostException

/**
 * #2052 / #2079: Ask Auntie on the Android composer, the rules with no screen
 * in them. The typed notes can be put back, asking again never feeds a draft
 * back in as notes, the ticked care tasks are reported as shown, and a failure
 * is said in plain words.
 */
class AskAuntieTest {

    private val notes = "all ate, water topped up, quick play"
    private val draft = "Everyone ate. I was running late and locked up on the way out."

    @Test
    fun `asking works from the notes while the narrative still holds the draft as written`() {
        assertEquals(notes, notesForAuntie(draft, KeptNotes(notes = notes, draftBody = draft)))
    }

    @Test
    fun `a narrative she has changed is her words again`() {
        val kept = KeptNotes(notes = notes, draftBody = draft)
        assertEquals("$draft And a walk.", notesForAuntie("$draft And a walk.", kept))
    }

    @Test
    fun `with nothing kept the narrative is the notes`() {
        assertEquals(notes, notesForAuntie(notes, null))
    }

    @Test
    fun `the button says it is writing while it waits`() {
        assertEquals("Ask Auntie", askAuntieLabel(isGenerating = false, hasAskedBefore = false))
        assertEquals("Ask Auntie again", askAuntieLabel(isGenerating = false, hasAskedBefore = true))
        assertEquals("Auntie is writing…", askAuntieLabel(isGenerating = true, hasAskedBefore = true))
    }

    // ── the ticked care tasks ───────────────────────────────────────────────

    private val session = KinCareSession(id = "s1", serviceType = "Dog Walk")
    private val biscuit = Kin(id = "k1", name = "Biscuit", species = "Dog")
    private val mochi = Kin(id = "k2", name = "Mochi", species = "Cat")
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
            (if (kinId.isBlank()) key else "$kinId|$key") to
                FieldResponse(fieldKey = key, kinId = kinId, boolValue = value)
        }

    @Test
    fun `each ticked task is listed with the Kin it was for`() {
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
    fun `an unticked task is not reported as done`() {
        val out = tickedCareTasks(template, session, listOf(biscuit), null, ticks("fed" to "k1", value = false))
        assertEquals(emptyList<GenerateCareTask>(), out)
    }

    @Test
    fun `a tick for a Kin not on this visit is not reported`() {
        val out = tickedCareTasks(template, session, listOf(biscuit), null, ticks("fed" to "k-not-here"))
        assertEquals(emptyList<GenerateCareTask>(), out)
    }

    @Test
    fun `no visit or a checklist that is switched off reports nothing`() {
        val all = ticks("gate" to "")
        assertEquals(emptyList<GenerateCareTask>(), tickedCareTasks(template, null, listOf(biscuit), null, all))
        assertEquals(
            emptyList<GenerateCareTask>(),
            tickedCareTasks(template.copy(checklistEnabled = false), session, listOf(biscuit), null, all),
        )
    }

    // ── failures are plain ──────────────────────────────────────────────────

    @Test
    fun `the plain sentence the generator sends is shown as sent`() {
        val copy = "Auntie's draft kept bringing up Kiwi, who is not on this visit, so it was thrown away."
        assertEquals(copy, AskAuntieCopy.plain(copy, 422))
    }

    @Test
    fun `a stored code is never shown`() {
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain("anthropic_api_key_not_configured", 500))
        assertEquals(AskAuntieCopy.DAILY_LIMIT, AskAuntieCopy.plain("generate_rate_limit_exceeded", 429))
        assertEquals(AskAuntieCopy.DAILY_LIMIT, AskAuntieCopy.plain(null, 429))
    }

    @Test
    fun `an older generator's ids and provider errors are never shown`() {
        for (leak in listOf(
            "No Kinfolk with id \"kf_8f2a91\"",
            "Claude API error: 529 overloaded_error request_id=req_011",
            "Voice source file not found at /workspace/voice/01_Voice_Bible.md",
        )) {
            assertEquals(leak, AskAuntieCopy.FAILED, AskAuntieCopy.plain(leak, 502))
        }
    }

    @Test
    fun `a sign-in the generator is closed to is told so, not told to try again`() {
        assertEquals(AskAuntieCopy.OWNER_ONLY, AskAuntieCopy.plain("admin_required", 403))
    }
    @Test
    fun `a reply with no message still says something plain`() {
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain(null, 500))
        assertEquals(AskAuntieCopy.FAILED, AskAuntieCopy.plain("  "))
    }

    @Test
    fun `a thrown failure never shows the device's or the provider's own words`() {
        assertEquals(
            AskAuntieCopy.FAILED,
            AskAuntieCopy.forFailure(IllegalStateException("generate failed with code 502: {\"error\":\"overloaded\"}")),
        )
        assertEquals(
            AskAuntieCopy.UNREACHABLE,
            AskAuntieCopy.forFailure(UnknownHostException("Unable to resolve host auntieos-ttpc.web.app")),
        )
        assertEquals("Plain words.", AskAuntieCopy.forFailure(GenerateFailure("Plain words.")))
    }

    @Test
    fun `no failure copy carries a code, a dash or developer wording`() {
        for (copy in listOf(
            AskAuntieCopy.FAILED, AskAuntieCopy.UNREACHABLE, AskAuntieCopy.DAILY_LIMIT,
            AskAuntieCopy.SIGN_IN, AskAuntieCopy.NEEDS_NOTES, AskAuntieCopy.NO_KINFOLK, AskAuntieCopy.OWNER_ONLY,
        )) {
            assertFalse(copy, Regex("[_—–]|\\b(id|error|generate|model)\\b").containsMatchIn(copy))
        }
    }
}
