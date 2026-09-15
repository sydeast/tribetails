package com.tribetails.auntieos.web.screens.directory

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #890, through the real Add Kinfolk screen: a household created without its
 * Emergency Contact outlives the screen, and opening Add again continues it
 * instead of creating a second household.
 *
 * Every callable the screen reaches is answered by a fixture (or failed by one),
 * so no test here touches the network.
 */
@OptIn(ExperimentalTestApi::class)
class KinfolkAddPendingRenderTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
        PendingAddKinfolk.clearAll()
    }

    private fun answers(vararg extra: Pair<String, String>) {
        JvmFirestoreFixtures.kinfolk = emptyList()
        JvmFirestoreFixtures.callableResponses = mapOf("listFormSchemas" to """{"schemas":[]}""") + extra
    }

    private fun ComposeUiTest.type(label: String, text: String) {
        onNode(hasContentDescription(label) and hasSetTextAction()).performScrollTo().performTextInput(text)
    }

    private fun ComposeUiTest.fillAdd() {
        type("First name *", "Dana")
        type("Last name *", "Mercer")
        type("Phone *", "8055550100")
        type("Email *", "dana@example.com")
        // Under 3 characters so the address field does not start a Mapbox lookup.
        type("Service address", "12")
        type("Name", "Rae Park")
        type("Phone", "8055550199")
        waitForIdle()
    }

    @Test
    fun aFailedContactSaveKeepsTheHouseholdAndReopeningAddContinuesIt() = runDesktopComposeUiTest {
        answers("createKinfolk" to """{"kinfolkId":"kf-890","duplicateOf":null}""")
        JvmFirestoreFixtures.callableErrors = mapOf("saveEmergencyContacts" to "offline")
        var open by mutableStateOf(true)
        var saved: String? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                if (open) KinfolkEditScreen(kinfolkId = null, onBack = {}, onSaved = { saved = it }, onArchived = {})
            }
        }
        waitForIdle()
        fillAdd()
        onNodeWithText("Create Kinfolk").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Save Emergency Contact").fetchSemanticsNodes().isNotEmpty() }
        assertEquals("kf-890", PendingAddKinfolk.get(null)?.kinfolkId)

        // The operator leaves Add, then opens it again. A second create would now
        // answer a different id, so the save below also proves none was made.
        open = false
        waitForIdle()
        answers("createKinfolk" to """{"kinfolkId":"kf-second","duplicateOf":null}""", "saveEmergencyContacts" to """{"contacts":[]}""")
        JvmFirestoreFixtures.callableErrors = emptyMap()
        open = true
        waitForIdle()

        assertTrue(onAllNodesWithText("Create Kinfolk").fetchSemanticsNodes().isEmpty(), "Add asks before showing a blank form")
        onNodeWithText("Discard").assertExists()
        onNodeWithText("Continue adding the Emergency Contact for Dana Mercer").performClick()
        waitForIdle()
        onNodeWithText("Save Emergency Contact").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { saved != null }

        assertEquals("kf-890", saved)
        assertTrue(JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("\"kinfolkId\":\"kf-890\""))
        assertNull(PendingAddKinfolk.get(null))
    }

    @Test
    fun discardStartsABlankAddAndWritesNothing() = runDesktopComposeUiTest {
        answers()
        PendingAddKinfolk.keep(
            null,
            PendingKinfolk("kf-left", Kinfolk(firstName = "Dana", lastName = "Mercer"), listOf(EmergencyContactDraft("Rae Park", "8055550199"))),
        )
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = null, onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitForIdle()
        onNodeWithText("Discard").performClick()
        waitForIdle()

        onNodeWithText("Create Kinfolk").assertExists()
        assertTrue(onAllNodesWithText("Save Emergency Contact").fetchSemanticsNodes().isEmpty())
        assertNull(PendingAddKinfolk.get(null))
        assertTrue(JvmFirestoreFixtures.lastCallableName in setOf(null, "listFormSchemas"), "Discard called ${JvmFirestoreFixtures.lastCallableName}")
        assertNull(JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun aDuplicateOfAnswerIsNeverASuccessAndHandsTheTypingToThatHousehold() = runDesktopComposeUiTest {
        answers(
            "createKinfolk" to """{"kinfolkId":"kf-existing","duplicateOf":"kf-existing"}""",
            "saveEmergencyContacts" to """{"contacts":[]}""",
        )
        var saved: String? = null
        var duplicate: String? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(
                    kinfolkId = null, onBack = {}, onSaved = { saved = it }, onArchived = {},
                    onDuplicate = { duplicate = it },
                )
            }
        }
        waitForIdle()
        fillAdd()
        onNodeWithText("Create Kinfolk").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { duplicate != null }
        waitForIdle()

        // #907 review item 1(b): never reported as added, and nothing is saved onto it.
        assertEquals("kf-existing", duplicate)
        assertNull(saved, "a duplicateOf answer was reported as a saved household")
        assertTrue(onAllNodesWithText("Kinfolk added.").fetchSemanticsNodes().isEmpty())
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "saveEmergencyContacts" }, "the contact was saved onto the existing household")
        assertNull(PendingAddKinfolk.get(null))
        assertEquals("Mercer", PendingAddKinfolk.duplicateFor(null, "kf-existing")?.household?.lastName)
        assertEquals("Rae Park", PendingAddKinfolk.duplicateFor(null, "kf-existing")?.contacts?.firstOrNull()?.name)
    }
}
