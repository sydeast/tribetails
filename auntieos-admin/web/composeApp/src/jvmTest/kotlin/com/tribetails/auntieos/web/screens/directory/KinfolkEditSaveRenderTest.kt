package com.tribetails.auntieos.web.screens.directory

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
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

/**
 * #829 review, through the real screen: editing one field on Edit Kinfolk and
 * pressing Save sends a merge whose mask names ONLY that field. The loaded record
 * has a non-default balance, status and tags, and none of them is in the mask.
 */
@OptIn(ExperimentalTestApi::class)
class KinfolkEditSaveRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun editingTheGateCodeSavesOnlyTheGateCode() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolk = listOf(
            Kinfolk(
                _id = "kf1",
                firstName = "Dana",
                lastName = "Mercer",
                phoneNumber = "8055550100",
                email = "dana@example.com",
                // Under 3 characters so the address field does not start a lookup.
                serviceAddress = "12",
                status = "prospect",
                outstandingBalance = "42.50",
                tags = listOf("VIP"),
                gateCode = "1234",
                emergencyContacts = buildJsonArray {
                    add(buildJsonObject { put("name", "Rae Park"); put("phone", "8055550199") })
                },
            ),
        )
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
}
