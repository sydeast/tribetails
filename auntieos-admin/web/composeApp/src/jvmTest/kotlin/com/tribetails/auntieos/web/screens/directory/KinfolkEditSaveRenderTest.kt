package com.tribetails.auntieos.web.screens.directory

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import com.tribetails.auntieos.web.ui.components.AUNTIE_INFO_TIP_TAG
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
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
 * #829 review, through the real Edit Kinfolk screen: a save sends a merge whose
 * mask names ONLY the fields the form changed.
 */
@OptIn(ExperimentalTestApi::class)
class KinfolkEditSaveRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun household(firstName: String = "Dana", gateCode: String = "1234") = Kinfolk(
        _id = "kf1",
        firstName = firstName,
        lastName = "Mercer",
        phoneNumber = "8055550100",
        email = "dana@example.com",
        // Under 3 characters so the address field does not start a lookup.
        serviceAddress = "12",
        status = "prospect",
        outstandingBalance = "42.50",
        tags = listOf("VIP"),
        gateCode = gateCode,
        emergencyContacts = buildJsonArray {
            add(buildJsonObject { put("name", "Rae Park"); put("phone", "8055550199") })
        },
    )

    /**
     * The screen loads custom-field schemas through the `listFormSchemas` callable on
     * open. A callable with no fixture goes to the live Cloud Functions endpoint, so
     * every test here answers it: no test may reach the network.
     */
    private fun noCustomFields() {
        JvmFirestoreFixtures.callableResponses = mapOf("listFormSchemas" to """{"schemas":[]}""")
    }

    /** The loaded record has a non-default balance, status and tags; none of them is in the mask. */
    @Test
    fun editingTheGateCodeSavesOnlyTheGateCode() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.kinfolk = listOf(household())
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitForIdle()
        onNode(hasSetTextAction() and hasText("1234")).performScrollTo().performTextReplacement("9999")
        waitForIdle()
        onNodeWithText("Save changes").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { JvmFirestoreFixtures.lastWrite?.op == "MERGE" }

        val w = JvmFirestoreFixtures.lastWrite
        assertEquals("kinfolk", w?.collection)
        assertEquals("kf1", w?.id)
        assertEquals(setOf("gateCode"), w?.fields)
    }

    /**
     * #829 review: stored values with a trailing space are not edits. The unsaved
     * indicator stays off when the screen opens, and Save with no edits writes
     * nothing.
     */
    @Test
    fun strayWhitespaceOnFileIsNotAnEdit() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.kinfolk = listOf(household(firstName = "Dana ", gateCode = "1234 "))
        var saved: String? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = { saved = it }, onArchived = {})
            }
        }
        waitForIdle()
        // AuntieSaveBar renders its dirty/saved label uppercased.
        assertTrue(onAllNodesWithText("UNSAVED CHANGES").fetchSemanticsNodes().isEmpty(), "the unsaved indicator is on at open")
        onNodeWithText("ALL CHANGES SAVED").assertExists()

        onNodeWithText("Save changes").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { saved != null }
        assertEquals("kf1", saved)
        assertNull(JvmFirestoreFixtures.lastWrite, "a save with no edits wrote ${JvmFirestoreFixtures.lastWrite}")
    }

    /**
     * #829 review: the unsaved indicator tracks custom fields (formValues) through
     * the same diff the save uses. Editing only a custom field turns it on;
     * changing the field back to the stored value turns it off.
     */
    @Test
    fun editingOnlyACustomFieldTurnsTheIndicatorOnAndBackOff() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listFormSchemas" to """{"schemas":[{"id":"household-extra","name":"Household extras","appliesTo":"KINFOLK","version":1}]}""",
            "getFormSchema" to """{"schema":{"id":"household-extra","name":"Household extras","appliesTo":"KINFOLK","version":1,"sections":[{"title":"Extras","fields":[{"key":"petName","label":"Favourite treat","type":"text"}]}]}}""",
        )
        JvmFirestoreFixtures.kinfolk = listOf(household().copy(formValues = mapOf("petName" to "Biscuit")))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        val customField = hasSetTextAction() and hasText("Biscuit")
        waitUntil(timeoutMillis = 5_000) { onAllNodes(customField).fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("ALL CHANGES SAVED").assertExists()

        onNode(customField).performScrollTo().performTextReplacement("Pepper")
        waitForIdle()
        onNodeWithText("UNSAVED CHANGES").assertExists()
        assertTrue(onAllNodesWithText("ALL CHANGES SAVED").fetchSemanticsNodes().isEmpty(), "the indicator did not turn on for a custom field edit")

        onNode(hasSetTextAction() and hasText("Pepper")).performScrollTo().performTextReplacement("Biscuit")
        waitForIdle()
        onNodeWithText("ALL CHANGES SAVED").assertExists()
        assertTrue(onAllNodesWithText("UNSAVED CHANGES").fetchSemanticsNodes().isEmpty(), "the indicator stayed on after the custom field went back to the stored value")
        assertNull(JvmFirestoreFixtures.lastWrite, "no save was pressed, so nothing may be written")
    }

    /**
     * #829 review item 14 (operator ruling: the flag never blocks other edits).
     * A half-filled contact on Edit no longer stops the save: the household write
     * goes out carrying only the changed field, the callable is never called for
     * the bad contact, and the screen stays open.
     *
     * The write fails after it is recorded here (no signed-in token in a test), so
     * what the screen shows once a save SUCCEEDS with a contact problem is proven
     * on the pure decision instead (KinfolkContactGateTest).
     */
    @Test
    fun aHalfFilledContactDoesNotBlockTheHouseholdSave() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.kinfolk = listOf(household())
        var saved: String? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = { saved = it }, onArchived = {})
            }
        }
        waitForIdle()
        onNode(hasSetTextAction() and hasText("1234")).performScrollTo().performTextReplacement("9999")
        onNode(hasSetTextAction() and hasText("8055550199")).performScrollTo().performTextReplacement("")
        waitForIdle()
        onNodeWithText("Save changes").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { JvmFirestoreFixtures.lastWrite?.op == "MERGE" }

        assertEquals(setOf("gateCode"), JvmFirestoreFixtures.lastWrite?.fields)
        waitForIdle()
        assertTrue(JvmFirestoreFixtures.lastCallableName != "saveEmergencyContacts", "a contact that failed the pre-check reached the callable")
        assertNull(saved, "the screen closed while the contact still needs fixing")
    }

    /** #829 review item 14: the who-gets-called tip sits beside the section title, once. */
    @Test
    fun theEmergencyContactsTitleCarriesOneTip() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.kinfolk = listOf(household())
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitForIdle()
        // AuntieFieldLabel renders its text uppercased.
        onNodeWithText("EMERGENCY CONTACTS").assertExists()
        assertEquals(1, onAllNodesWithTag(AUNTIE_INFO_TIP_TAG).fetchSemanticsNodes().size)
    }
}
