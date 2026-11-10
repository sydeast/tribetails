package com.tribetails.auntieos.web.data

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1799: the desktop console completes a DEPARTED visit once its KinTale is
 * sent, on Android's rule (`HomeViewModel.kt` sweep, `HomeScreen.kt` Complete
 * button): status DEPARTED and `autoCompleteEligible`. The cases mirror admin
 * web's `completeVisitAfterKinTale` tests (#1793).
 */
class VisitCompletionAfterKinTaleTest {

    // ── The rule ─────────────────────────────────────────────────────────────

    @Test
    fun ruleHoldsOnlyForADepartedVisitTheSendFlagged() {
        assertTrue(completesAfterKinTale("DEPARTED", true))
        // The stored status is read trimmed and in any case.
        assertTrue(completesAfterKinTale(" departed ", true))
        assertTrue(completesAfterKinTale(KinCareSession(status = "DEPARTED", autoCompleteEligible = true)))
    }

    @Test
    fun ruleIsFalseForADepartedVisitWithNoSentTale() {
        assertFalse(completesAfterKinTale("DEPARTED", false))
        assertFalse(completesAfterKinTale(KinCareSession(status = "DEPARTED")))
    }

    @Test
    fun ruleIsFalseInEveryOtherStateFlagOrNot() {
        for (status in listOf("SCHEDULED", "ON_MY_WAY", "ARRIVED", "COMPLETED", "CANCELLED", "DRAFT", "SOMETHING_NEW", "")) {
            assertFalse(completesAfterKinTale(status, true), status)
        }
    }

    // ── After a send ─────────────────────────────────────────────────────────

    private class Recorder(private val answer: WriteResult<Unit> = WriteResult.Ok(Unit)) {
        val calls = mutableListOf<Pair<String, String>>()
        suspend fun complete(id: String, at: String): WriteResult<Unit> {
            calls += id to at
            return answer
        }
    }

    private suspend fun run(
        fields: SessionCompletionFields?,
        recorder: Recorder = Recorder(),
        readFails: Throwable? = null,
    ): VisitCompletionAfterSend = runVisitCompletionAfterKinTale(
        sessionId = "s1",
        read = { id ->
            assertEquals("s1", id)
            readFails?.let { throw it }
            fields
        },
        complete = recorder::complete,
        now = { "2026-11-10T18:00:00Z" },
    )

    @Test
    fun completesADepartedVisitTheSendFlaggedThroughTheCompleteCall() = runTest {
        val r = Recorder()
        assertEquals(VisitCompletionAfterSend.Completed, run(SessionCompletionFields("DEPARTED", true), r))
        assertEquals(listOf("s1" to "2026-11-10T18:00:00Z"), r.calls)
    }

    @Test
    fun leavesAnArrivedVisitOpenThoughTheServerWouldAcceptComplete() = runTest {
        val r = Recorder()
        assertEquals(VisitCompletionAfterSend.LeftOpen("ARRIVED"), run(SessionCompletionFields("ARRIVED", true), r))
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun leavesADepartedVisitOpenWhenTheFreshReadCarriesNoFlag() = runTest {
        val r = Recorder()
        assertEquals(VisitCompletionAfterSend.LeftOpen("DEPARTED"), run(SessionCompletionFields("DEPARTED", false), r))
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun leavesACompletedVisitAloneAndAMissingOne() = runTest {
        val r = Recorder()
        assertEquals(VisitCompletionAfterSend.LeftOpen("COMPLETED"), run(SessionCompletionFields("COMPLETED", true), r))
        assertEquals(VisitCompletionAfterSend.LeftOpen(""), run(null, r))
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun returnsTheServerRefusalWordForWordRatherThanThrowing() = runTest {
        val refusal = "The arrival was recorded 900 m from the household."
        val r = Recorder(WriteResult.Err(refusal))
        assertEquals(VisitCompletionAfterSend.NotCompleted(refusal), run(SessionCompletionFields("DEPARTED", true), r))
        assertEquals(1, r.calls.size)
    }

    @Test
    fun returnsAFailedReadAsNotCompletedNeverAsAThrow() = runTest {
        val r = Recorder()
        assertEquals(
            VisitCompletionAfterSend.NotCompleted("Not signed in"),
            run(null, r, readFails = IllegalStateException("Not signed in")),
        )
        assertTrue(r.calls.isEmpty())
    }

    @Test
    fun aReasonlessFailureStillSaysSomething() = runTest {
        assertEquals(
            VisitCompletionAfterSend.NotCompleted("Unknown error."),
            run(null, readFails = IllegalStateException()),
        )
        assertEquals(
            VisitCompletionAfterSend.NotCompleted("Unknown error."),
            run(SessionCompletionFields("DEPARTED", true), Recorder(WriteResult.Err(" "))),
        )
    }

    // ── What the console says ────────────────────────────────────────────────

    @Test
    fun sentMessagesMatchAdminWeb() {
        assertEquals(
            "KinTale sent and the visit is marked Completed. Kinfolk will hear from you soon.",
            kinTaleSentMessage(VisitCompletionAfterSend.Completed),
        )
        assertEquals(
            "KinTale sent. Kinfolk will hear from you soon.",
            kinTaleSentMessage(VisitCompletionAfterSend.LeftOpen("ARRIVED")),
        )
        assertEquals(
            sentButNotCompletedNotice("Too far from the household."),
            kinTaleSentMessage(VisitCompletionAfterSend.NotCompleted("Too far from the household.")),
        )
    }

    @Test
    fun theRefusalGetsItsOwnSentenceWhateverShapeItArrivesIn() {
        assertEquals(
            "KinTale sent. Kinfolk will hear from you soon. The visit could not be marked Completed. Not signed in. You can mark it Completed from Auntie Time.",
            sentButNotCompletedNotice("Not signed in"),
        )
        assertEquals(
            "KinTale sent. Kinfolk will hear from you soon. The visit could not be marked Completed. Too far from the household. You can mark it Completed from Auntie Time.",
            sentButNotCompletedNotice("Too far from the household."),
        )
        assertEquals(
            "KinTale sent. Kinfolk will hear from you soon. The visit could not be marked Completed. You can mark it Completed from Auntie Time.",
            sentButNotCompletedNotice("  "),
        )
    }

    @Test
    fun noNoticeEverReadsAsAFailedSend() {
        val notice = sentButNotCompletedNotice("unavailable")
        assertFalse(notice.contains("Couldn't send", ignoreCase = true))
        assertFalse(notice.contains("failed", ignoreCase = true))
        assertTrue(notice.startsWith("KinTale sent."))
    }
}
