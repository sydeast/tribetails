package com.tribetails.auntieos.web.screens.directory

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #907 review items 1(a), 1(b), 2 and 4, through the real Kinfolk edit screen.
 * Every callable is answered or failed by a fixture, so nothing reaches the network.
 */
@OptIn(ExperimentalTestApi::class)
class KinfolkAddReviewRenderTest {

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
        type("Service address", "12")
        type("Name", "Rae Park")
        type("Phone", "8055550199")
        waitForIdle()
    }

    private fun pending(id: String) =
        PendingKinfolk(id, Kinfolk(firstName = "Dana", lastName = "Mercer"), listOf(EmergencyContactDraft("Rae Park", "8055550199")))

    /** 1(a): Discard says the next Add is a new household. */
    @Test
    fun afterDiscardTheNextCreateNamesTheDiscardedHouseholdOnce() = runDesktopComposeUiTest {
        answers(
            "createKinfolk" to """{"kinfolkId":"kf-new","duplicateOf":null}""",
            "saveEmergencyContacts" to """{"contacts":[]}""",
        )
        PendingAddKinfolk.keep(null, pending("kf-left"))
        var saved: String? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = null, onBack = {}, onSaved = { saved = it }, onArchived = {})
            }
        }
        waitForIdle()
        onNodeWithText("Discard").performClick()
        waitForIdle()
        assertEquals("kf-left", PendingAddKinfolk.discardedFor(null))

        fillAdd()
        onNodeWithText("Create Kinfolk").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { saved != null }

        val create = JvmFirestoreFixtures.callablePayloads.single { it.first == "createKinfolk" }.second
        assertTrue(create.contains("\"ignoreDuplicateOf\":\"kf-left\""), create)
        assertNull(PendingAddKinfolk.discardedFor(null))
    }

    /** 2: a pending household deleted under the operator is dropped, not retried forever. */
    @Test
    fun aDeletedPendingHouseholdIsDroppedWithThatHouseholdNoLongerExists() = runDesktopComposeUiTest {
        answers()
        JvmFirestoreFixtures.callableErrors = mapOf("saveEmergencyContacts" to HOUSEHOLD_NO_LONGER_EXISTS)
        PendingAddKinfolk.keep(null, pending("kf-gone"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = null, onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitForIdle()
        onNodeWithText("Continue adding the Emergency Contact for Dana Mercer").performClick()
        waitForIdle()
        onNodeWithText("Save Emergency Contact").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { PendingAddKinfolk.get(null) == null }
        waitForIdle()

        assertTrue(onAllNodesWithText(HOUSEHOLD_NO_LONGER_EXISTS).fetchSemanticsNodes().isNotEmpty(), "no message said the household is gone")
        // The form is open for a fresh Add, not stuck retrying.
        onNodeWithText("Create Kinfolk").assertExists()
        assertTrue(onAllNodesWithText("Save Emergency Contact").fetchSemanticsNodes().isEmpty())
    }

    /** 4: with a real signed-in operator, the pending household under their uid is offered. */
    @Test
    fun aRealOperatorUidIsOfferedTheirPendingHousehold() = runDesktopComposeUiTest {
        answers()
        PendingAddKinfolk.keep("op-1", pending("kf-890"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(
                    kinfolkId = null, onBack = {}, onSaved = {}, onArchived = {},
                    authState = MutableStateFlow(AuthUser("op-1", "auntie@tribetails.test")),
                )
            }
        }
        waitForIdle()
        onNodeWithText("Continue adding the Emergency Contact for Dana Mercer").assertExists()
        assertTrue(onAllNodesWithText("Create Kinfolk").fetchSemanticsNodes().isEmpty(), "the blank form showed before the prompt")
    }

    /** 4: before the auth state answers, Add chooses neither the prompt nor the form. */
    @Test
    fun addShowsNeitherThePromptNorTheFormUntilTheOperatorIsKnown() = runDesktopComposeUiTest {
        answers()
        PendingAddKinfolk.keep("op-1", pending("kf-890"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(
                    kinfolkId = null, onBack = {}, onSaved = {}, onArchived = {},
                    authState = flow { awaitCancellation() },
                )
            }
        }
        waitForIdle()
        assertTrue(onAllNodesWithText("Create Kinfolk").fetchSemanticsNodes().isEmpty(), "the form showed before the operator was known")
        assertTrue(onAllNodesWithText("Discard").fetchSemanticsNodes().isEmpty(), "the prompt showed before the operator was known")
    }

    /** 1(b): the household's edit screen fills in what the duplicate Add typed that differs, unsaved. */
    @Test
    fun theEditScreenFillsInTheDuplicateAddAsUnsavedChangesAndSavesOnlyThose() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf("listFormSchemas" to """{"schemas":[]}""")
        JvmFirestoreFixtures.kinfolk = listOf(
            Kinfolk(
                _id = "kf1", firstName = "Dana", lastName = "Mercer", phoneNumber = "8055550100",
                email = "dana@example.com", serviceAddress = "12", status = "active",
                emergencyContacts = buildJsonArray { add(buildJsonObject { put("name", "Rae Park"); put("phone", "8055550199") }) },
            ),
        )
        PendingAddKinfolk.keepDuplicate(
            null,
            PendingKinfolk(
                "kf1",
                Kinfolk(firstName = "Dana", lastName = "Mercer-Park", phoneNumber = "", email = "dana@example.com", serviceAddress = "12", status = "active"),
                listOf(EmergencyContactDraft("Rae Park", "8055550199")),
            ),
        )
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitUntil(timeoutMillis = 5_000) {
            onAllNodesWithText("Dana Mercer was already added a few minutes ago.", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNode(hasSetTextAction() and hasText("Mercer-Park")).assertExists()
        // A blank typed phone is "not typed", never "clear it".
        onNode(hasSetTextAction() and hasText("8055550100")).assertExists()
        onNodeWithText("UNSAVED CHANGES").assertExists()
        assertNull(PendingAddKinfolk.duplicateFor(null, "kf1"), "the typing was not let go once filled in")
        assertNull(JvmFirestoreFixtures.lastWrite)

        onNodeWithText("Save changes").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { JvmFirestoreFixtures.lastWrite?.op == "MERGE" }
        assertEquals(setOf("lastName"), JvmFirestoreFixtures.lastWrite?.fields)
    }
}
