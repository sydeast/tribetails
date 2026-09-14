package com.tribetails.auntieos.web.screens.directory

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
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

    /** The loaded record has a non-default balance, status and tags; none of them is in the mask. */
    @Test
    fun editingTheGateCodeSavesOnlyTheGateCode() = runDesktopComposeUiTest {
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
}
