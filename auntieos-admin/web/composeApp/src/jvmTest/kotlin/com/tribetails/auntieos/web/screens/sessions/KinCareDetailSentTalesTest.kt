package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.FIRST_ANSWER_TIMEOUT_MS
import com.tribetails.auntieos.web.ui.components.answersWithin
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2265 on the console: the visit's "KinTales sent" panel lists SENT KinTales
 * only, says plainly when its read failed with Try again, and a read that never
 * answers stops waiting at 20 s.
 */
@OptIn(ExperimentalTestApi::class)
class KinCareDetailSentTalesTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun has(text: String, test: androidx.compose.ui.test.ComposeUiTest) =
        test.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun onlyThisVisitsSentTalesAreListedNewestFirst() {
        val rows = listOf(
            KinCareReport(_id = "a", sessionId = "s1", status = "SENT", sentAt = "2026-08-19T15:00:00Z"),
            KinCareReport(_id = "b", sessionId = "s1", status = "DRAFT", createdAt = "2026-08-20T15:00:00Z"),
            KinCareReport(_id = "c", sessionId = "s1", status = "FAILED", createdAt = "2026-08-21T15:00:00Z"),
            KinCareReport(_id = "d", sessionId = "s2", status = "SENT", sentAt = "2026-08-22T15:00:00Z"),
            KinCareReport(_id = "e", sessionId = "s1", status = "sent", sentAt = "2026-08-23T15:00:00Z"),
        )
        assertEquals(listOf("e", "a"), visitSentTales(rows, "s1").map { it._id })
    }

    @Test
    fun aReadThatNeverAnswersEndsOnTheFailureAt20Seconds() = runTest {
        val never = flow<FirestoreResult<List<Int>>> {
            emit(FirestoreResult.Loading)
            awaitCancellation()
        }
        val out = never.answersWithin("Could not load.").toList()
        assertEquals(listOf(FirestoreResult.Loading, FirestoreResult.Error("Could not load.")), out)
        assertEquals(FIRST_ANSWER_TIMEOUT_MS, testScheduler.currentTime)
    }

    @Test
    fun anAnswerInTimePassesThroughUnchanged() = runTest {
        val out = flowOf<FirestoreResult<List<Int>>>(FirestoreResult.Data(listOf(1)), FirestoreResult.Data(listOf(1, 2)))
            .answersWithin("Could not load.").toList()
        // Loading first, so a Try again clears the failure line while it reads.
        assertEquals(listOf(FirestoreResult.Loading, FirestoreResult.Data(listOf(1)), FirestoreResult.Data(listOf(1, 2))), out)
    }

    @Test
    fun thePanelShowsTheSentTaleWithAReadableTimeAndNoDraft() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s1", kinfolkName = "The Wrens"))
        JvmFirestoreFixtures.reports = listOf(
            KinCareReport(_id = "a", sessionId = "s1", status = "SENT", bodyCopy = "Biscuit had a grand walk", sentAt = "2026-08-19T15:00:00Z"),
            KinCareReport(_id = "b", sessionId = "s1", status = "DRAFT", bodyCopy = "Half-written draft"),
        )
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { KinCareDetailScreen(kinCareId = "s1", onBack = {}) } }
        waitUntil(timeoutMillis = 10_000) { has("Biscuit had a grand walk", this) }
        assertTrue(!has("Half-written draft", this), "a draft is not a sent KinTale")
        assertTrue(!has("2026-08-19T15:00:00Z", this), "the stored ISO text never reaches the screen")
        assertTrue(has("Aug 19", this))
    }

    @Test
    fun aFailedReadSaysSoAndTryAgainReadsAgain() = runDesktopComposeUiTest {
        // The visit is on file; the KinTales read has no fixture and nobody is
        // signed in, so it fails at its token check.
        JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s1", kinfolkName = "The Wrens"))
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { KinCareDetailScreen(kinCareId = "s1", onBack = {}) } }
        waitUntil(timeoutMillis = 10_000) { has(VISIT_TALES_FAILED, this) }
        assertTrue(!has("No KinTales sent yet during this KinCare.", this), "a failed read must not read as none sent")
        // Plain words: the panel draws only VISIT_TALES_FAILED. (Other panels on
        // this screen fail at the same token check and keep their own copy.)
        assertEquals(1, onAllNodesWithText(VISIT_TALES_FAILED, useUnmergedTree = true).fetchSemanticsNodes().size)

        JvmFirestoreFixtures.reports = listOf(
            KinCareReport(_id = "a", sessionId = "s1", status = "SENT", bodyCopy = "Second read landed"),
        )
        onNodeWithTag(VISIT_TALES_RETRY_TAG, useUnmergedTree = true).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { has("Second read landed", this) }
        assertTrue(!has(VISIT_TALES_FAILED, this))
    }
}
