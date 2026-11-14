package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.LOAD_ERROR_RETRY_TAG
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #2040 on the desktop console: Auntie Time's "Send the KinTale" opens the
 * composer on the visit, and a visit that already has a saved draft reopens it,
 * the newest if there are two. A failed look for it shows its error and Retry,
 * never a blank tale that would become a second draft.
 */
@OptIn(ExperimentalTestApi::class)
class KinTaleDraftResumeRenderTest {

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val draft = KinCareReport(
        _id = "r-draft",
        sessionId = "s1",
        kinfolkId = "kf1",
        kinfolkName = "The Whitfields",
        title = "Park day",
        bodyCopy = "Biscuit found a stick.",
        status = "DRAFT",
        createdAt = "2026-07-16T15:00:00Z",
        updatedAt = "2026-07-16T15:05:00Z",
    )

    private fun ComposeUiTest.show(reports: List<KinCareReport>?) {
        JvmFirestoreFixtures.sessions = listOf(
            KinCareSession(_id = "s1", kinfolkId = "kf1", kinfolkName = "The Whitfields", status = "DEPARTED"),
        )
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1"))
        JvmFirestoreFixtures.allKin = emptyList()
        JvmFirestoreFixtures.reports = reports
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { KinTaleComposeScreen(sessionId = "s1", onClose = {}) } }
    }

    private fun ComposeUiTest.waitForText(text: String) =
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun ComposeUiTest.count(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size

    // ── the pure pick ────────────────────────────────────────────────────────

    @Test
    fun newestSavedDraftFindsThisVisitsDraft() {
        val other = draft.copy(_id = "elsewhere", sessionId = "s2")
        assertEquals("r-draft", newestSavedDraft(listOf(other, draft), "s1")?._id)
    }

    @Test
    fun newestSavedDraftIgnoresASentTaleASendStampAndAnUnknownStatus() {
        val rows = listOf(
            draft.copy(_id = "sent", status = "SENT", sentAt = "2026-07-16T16:00:00Z"),
            draft.copy(_id = "stamped", sentAt = "2026-07-16T16:00:00Z"),
            draft.copy(_id = "failed", status = "FAILED"),
            draft.copy(_id = "blank", status = ""),
        )
        assertNull(newestSavedDraft(rows, "s1"))
    }

    @Test
    fun newestSavedDraftPicksTheNewestByUpdatedAtThenCreatedAtThenId() {
        val older = draft.copy(_id = "a", updatedAt = "2026-07-16T15:00:00Z", createdAt = "2026-07-16T15:00:00Z")
        val newer = draft.copy(_id = "b", updatedAt = "2026-07-16T17:00:00Z", createdAt = "2026-07-16T14:00:00Z")
        assertEquals("b", newestSavedDraft(listOf(newer, older), "s1")?._id)
        val tieA = draft.copy(_id = "a", updatedAt = "", createdAt = "2026-07-16T15:00:00Z")
        val tieB = draft.copy(_id = "b", updatedAt = "", createdAt = "2026-07-16T13:00:00Z")
        assertEquals("a", newestSavedDraft(listOf(tieB, tieA), "s1")?._id)
        val sameA = draft.copy(_id = "a", updatedAt = "x", createdAt = "x")
        val sameB = draft.copy(_id = "b", updatedAt = "x", createdAt = "x")
        assertEquals("b", newestSavedDraft(listOf(sameA, sameB), "s1")?._id)
    }

    @Test
    fun newestSavedDraftMatchesNothingForABlankVisit() {
        assertNull(newestSavedDraft(listOf(draft.copy(sessionId = "")), ""))
    }

    // ── rendered ─────────────────────────────────────────────────────────────

    @Test
    fun aVisitWithASavedDraftOpensThatDraft() = runDesktopComposeUiTest {
        show(listOf(draft))
        waitForText("Park day")
        waitForText("Biscuit found a stick.")
    }

    @Test
    fun aVisitWithTwoSavedDraftsOpensTheNewest() = runDesktopComposeUiTest {
        show(
            listOf(
                draft.copy(_id = "old", title = "First go", updatedAt = "2026-07-16T15:00:00Z"),
                draft.copy(_id = "new", title = "Second go", updatedAt = "2026-07-16T16:30:00Z"),
            ),
        )
        waitForText("Second go")
        assertEquals(0, count("First go"))
    }

    @Test
    fun aVisitWhoseOnlyTaleIsSentStartsANewOne() = runDesktopComposeUiTest {
        show(listOf(draft.copy(_id = "sent", status = "SENT", sentAt = "2026-07-16T16:00:00Z")))
        waitForText("Send to The Whitfields")
        assertEquals(0, count("Park day"))
    }

    @Test
    fun aFailedLookShowsItsErrorAndRetryFindsTheDraft() = runDesktopComposeUiTest {
        // No reports fixture: the read fails at the token check, as a real outage would.
        show(null)
        waitForText("Couldn't check this visit for a saved draft")
        assertEquals(0, count("Send to The Whitfields"))

        JvmFirestoreFixtures.reports = listOf(draft)
        onNodeWithTag(LOAD_ERROR_RETRY_TAG, useUnmergedTree = true).performClick()
        waitForText("Park day")
    }
}
