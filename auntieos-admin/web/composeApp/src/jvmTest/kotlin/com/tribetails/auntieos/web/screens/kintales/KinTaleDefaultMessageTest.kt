package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import com.tribetails.auntieos.web.data.FieldResponse
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleTemplate
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2050 on the desktop console: a KinTale template's "Default message to
 * kinfolk" opens a new tale's message, once. It used to appear only in the
 * live preview, which previewed words that were never sent.
 *
 * A new tale that holds only that message has nothing of the Auntie's in it,
 * so a save she did not ask for writes no draft.
 */
@OptIn(ExperimentalTestApi::class)
class KinTaleDefaultMessageTest {
    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val message = "Thanks for having us today!"
    private val session = KinCareSession(
        _id = "s1",
        kinfolkId = "kf1",
        kinfolkName = "The Whitfields",
        kinIds = listOf("k1", "k2"),
        serviceType = "Dog Walk",
        startTime = "2026-11-10T15:00:00.000Z",
        status = "DEPARTED",
    )
    private val walks = KinTaleTemplate(_id = "tpl_walk", name = "Dog Walk recap", defaultEmailMessage = message)

    @Test
    fun aNewTaleOpensWithTheTemplatesDefaultMessage() {
        val tale = scaffoldReport(session, walks)
        assertEquals(message, tale.bodyCopy)
        assertEquals("", tale.title)
        assertEquals("tpl_walk", tale.templateId)
        assertEquals("DRAFT", tale.status)
        assertEquals("", tale._id)
    }

    @Test
    fun noMessageABlankOneAndTheBuiltInAllOpenAnEmptyNote() {
        assertEquals("", scaffoldReport(session, walks.copy(defaultEmailMessage = "")).bodyCopy)
        assertEquals("", scaffoldReport(session, walks.copy(defaultEmailMessage = "  \n ")).bodyCopy)
        assertEquals("", scaffoldReport(session, DefaultKinTaleTemplate.template).bodyCopy)
    }

    @Test
    fun theMessageIsKeptAsTyped() {
        val markup = "Hi <img src=x onerror=alert(1)> <b>there</b>\nSee you Thursday."
        assertEquals(markup, walks.copy(defaultEmailMessage = markup).defaultMessageForNewTale())
    }

    @Test
    fun aTaleHoldingOnlyItsDefaultMessageIsUntouched() {
        val started = scaffoldReport(session, walks)
        assertTrue(isUntouchedNewTale(started, started))
        assertTrue(isUntouchedNewTale(started.copy(), started))
    }

    @Test
    fun anythingTheAuntieAddsOrChangesMakesItHers() {
        val started = scaffoldReport(session, walks)
        assertFalse(isUntouchedNewTale(started.copy(title = "Park day"), started))
        assertFalse(isUntouchedNewTale(started.copy(bodyCopy = "Biscuit found a stick."), started))
        assertFalse(isUntouchedNewTale(started.copy(bodyCopy = ""), started))
        assertFalse(
            isUntouchedNewTale(
                started.copy(fieldResponses = mapOf("k1|fed" to FieldResponse(fieldKey = "fed", kinId = "k1", boolValue = true))),
                started,
            ),
        )
    }

    @Test
    fun aSavedTaleAndAReopenedDraftAreNeverUntouched() {
        val started = scaffoldReport(session, walks)
        // Saved once: it has an id, and every later save is a real update.
        assertFalse(isUntouchedNewTale(started.copy(_id = "r1"), started))
        // Reopened (#2040): there is no starting point to compare to.
        assertFalse(isUntouchedNewTale(started, null))
    }
    // ── rendered ─────────────────────────────────────────────────────────────
    private val walksForDogWalk = walks.copy(serviceTypeKeys = listOf("Dog Walk"), isActive = true)
    private fun ComposeUiTest.show(templates: List<KinTaleTemplate>?, reports: List<KinCareReport> = emptyList()) {
        JvmFirestoreFixtures.sessions = listOf(session)
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1"))
        JvmFirestoreFixtures.allKin = emptyList()
        JvmFirestoreFixtures.reports = reports
        JvmFirestoreFixtures.kinTaleTemplates = templates
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { KinTaleComposeScreen(sessionId = "s1", onClose = {}) } }
    }
    private fun ComposeUiTest.waitForText(text: String) =
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun ComposeUiTest.count(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size
    @Test
    fun aNewTaleOpensWithTheDefaultMessageInTheNote() = runDesktopComposeUiTest {
        show(listOf(walksForDogWalk))
        waitForText("Send to The Whitfields")
        waitForText(message)
    }
    @Test
    fun aTemplateWithNoDefaultMessageOpensAnEmptyNote() = runDesktopComposeUiTest {
        show(listOf(walksForDogWalk.copy(defaultEmailMessage = "")))
        waitForText("Send to The Whitfields")
        assertEquals(0, count(message))
    }
    @Test
    fun aSavedDraftReopensWithItsOwnWordsNeverTheDefaultMessage() = runDesktopComposeUiTest {
        val saved = KinCareReport(
            _id = "r-draft",
            sessionId = "s1",
            kinfolkId = "kf1",
            kinfolkName = "The Whitfields",
            templateId = "tpl_walk",
            title = "Park day",
            bodyCopy = "Biscuit found a stick.",
            status = "DRAFT",
            createdAt = "2026-11-10T15:00:00Z",
            updatedAt = "2026-11-10T15:05:00Z",
        )
        show(listOf(walksForDogWalk), listOf(saved))
        waitForText("Biscuit found a stick.")
        assertEquals(0, count(message))
    }
    @Test
    fun aTemplateReadThatFailsStillOpensTheComposerOnAnEmptyNote() = runDesktopComposeUiTest {
        // No templates fixture: the read fails at the token check, as a real outage would.
        show(null)
        waitForText("Send to The Whitfields")
        assertEquals(0, count(message))
    }
    @Test
    fun openingANewTaleWritesNoDraftAndSaveNotesSavesTheDefaultMessage() = runDesktopComposeUiTest {
        val created = mutableListOf<KinCareReport>()
        JvmFirestoreFixtures.createdKinTaleReports = created
        show(listOf(walksForDogWalk))
        waitForText("Send to The Whitfields")
        waitForText(message)
        waitForIdle()
        assertEquals(0, created.size, "opening the composer wrote a draft nobody asked for")
        // "Save notes" is a save the Auntie pressed herself.
        onNodeWithText("Save notes", useUnmergedTree = true).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { created.size == 1 }
        assertEquals(message, created.single().bodyCopy)
        assertEquals("DRAFT", created.single().status)
    }
    @Test
    fun aTemplateThatLandsAfterAFailedReadNeverReplacesWhatTheAuntieTyped() = runDesktopComposeUiTest {
        // The read polls: a first answer that failed is followed by one that works.
        val templates = MutableStateFlow<FirestoreResult<List<KinTaleTemplate>>>(FirestoreResult.Error("offline"))
        JvmFirestoreFixtures.sessions = listOf(session)
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1"))
        JvmFirestoreFixtures.allKin = emptyList()
        JvmFirestoreFixtures.reports = emptyList()
        JvmFirestoreFixtures.kinTaleTemplatesFlow = templates
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { KinTaleComposeScreen(sessionId = "s1", onClose = {}) } }
        waitForText("Send to The Whitfields")
        val typed = "Biscuit found a stick."
        onNode(
            hasSetTextAction() and hasAnyDescendant(hasText("Tell the tale", substring = true)),
            useUnmergedTree = true,
        ).performScrollTo().performTextInput(typed)
        waitForText(typed)
        templates.value = FirestoreResult.Data(listOf(walksForDogWalk))
        waitForIdle()
        mainClock.advanceTimeBy(1_000)
        waitForIdle()
        assertTrue(count(typed) > 0, "the words the Auntie typed were replaced when the template landed")
        assertEquals(0, count(message), "the template's default message was put over the Auntie's words")
    }
}
