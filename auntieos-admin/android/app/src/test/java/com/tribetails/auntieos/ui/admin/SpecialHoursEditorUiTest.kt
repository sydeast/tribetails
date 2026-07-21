package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
 * Slice 9 Robolectric compose UI test for the Special Hours add editor (spec 29
 * item 15.5). Renders the real [SpecialHoursEditor] (real AuntieField + the "Add
 * Special Hours" PrimaryButton gated by specialHoursAddEnabled) and asserts the Add
 * affordance enables only on a valid YYYY-MM-DD date + non-blank, pipe-free hours,
 * and that the Add callback fires only when enabled. Happy / sad / negative /
 * interaction.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SpecialHoursEditorUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun render(date: String, hours: String, onAdd: () -> Unit = {}) {
        composeRule.setContent {
            AuntieOSTheme {
                var d by remember { mutableStateOf(date) }
                var h by remember { mutableStateOf(hours) }
                SpecialHoursEditor(date = d, onDate = { d = it }, hours = h, onHours = { h = it }, onAdd = onAdd)
            }
        }
    }

    @Test
    fun `add enabled on valid date and hours`() {
        render("2026-07-03", "08:00-12:00")
        composeRule.onNodeWithText("Add Special Hours").assertIsEnabled()
    }

    @Test
    fun `add disabled on bad date`() {
        render("7/3/26", "08:00-12:00")
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
    }

    @Test
    fun `add disabled on blank hours`() {
        render("2026-07-03", "")
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
    }

    @Test
    fun `add disabled when hours contain pipe`() {
        render("2026-07-03", "08:00|12:00")
        composeRule.onNodeWithText("Add Special Hours").assertIsNotEnabled()
    }

    @Test
    fun `add click fires when enabled`() {
        var added = 0
        render("2026-07-03", "08:00-12:00", onAdd = { added++ })
        composeRule.onNodeWithText("Add Special Hours").performClick()
        composeRule.waitForIdle()
        assertEquals(1, added)
    }
}
