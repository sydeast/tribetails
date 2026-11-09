package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric compose UI test for the Special Hours add editor (spec 29 item
 * 15.5). Renders the real [SpecialHoursEditor] and asserts, on the server's
 * rules (#1593), that a refused value shows its sentence under the field with
 * Add off, that an empty field says why only once Add is pressed, and that the
 * Add callback fires only when nothing is wrong.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SpecialHoursEditorUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val today = "2026-11-09"

    private fun render(date: String, hours: String, onAdd: () -> Unit = {}) {
        composeRule.setContent {
            AuntieOSTheme {
                var d by remember { mutableStateOf(date) }
                var h by remember { mutableStateOf(hours) }
                SpecialHoursEditor(
                    date = d,
                    onDate = { d = it },
                    hours = h,
                    onHours = { h = it },
                    todayIso = today,
                    onAdd = onAdd,
                )
            }
        }
    }

    @Test
    fun `add enabled on a real future date and hours`() {
        render("2026-12-24", "08:00-12:00")
        composeRule.onNodeWithText("Add Special Hours").assertIsEnabled()
    }

    @Test
    fun `a date that does not exist says so and turns Add off`() {
        render("2026-13-45", "08:00-12:00")
        composeRule.onNodeWithText(DATE_INVALID).assertIsDisplayed()
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
    }

    @Test
    fun `a past date says so and turns Add off`() {
        render("2026-11-01", "08:00-12:00")
        composeRule.onNodeWithText(DATE_PAST).assertIsDisplayed()
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
    }

    @Test
    fun `hours that do not read say so and turn Add off`() {
        render("2026-12-24", "zz-99")
        composeRule.onNodeWithText(HOURS_RANGE_INVALID).assertIsDisplayed()
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
    }

    @Test
    fun `blank hours say why only when Add is pressed, and nothing is added`() {
        var added = 0
        render("2026-12-24", "", onAdd = { added++ })
        composeRule.onNodeWithText("Add Special Hours").assertIsEnabled()
        composeRule.onNodeWithText("Add Special Hours").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(HOURS_RANGE_INVALID).assertIsDisplayed()
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
        assertEquals(0, added)
    }

    @Test
    fun `add click fires when nothing is wrong`() {
        var added = 0
        render("2026-12-24", "08:00-12:00", onAdd = { added++ })
        composeRule.onNodeWithText("Add Special Hours").performClick()
        composeRule.waitForIdle()
        assertEquals(1, added)
    }
}
